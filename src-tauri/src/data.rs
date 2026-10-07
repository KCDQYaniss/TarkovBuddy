//! Téléchargement des données de jeu depuis json.tarkov.dev et cache disque.
//!
//! L'ancienne API GraphQL (api.tarkov.dev) est hors service ; le site tarkov.dev fonctionne désormais sur ces
//! fichiers JSON statiques : `<base>/<mode>/<jeu de données>` plus `<jeu de données>_<langue>` pour les textes.
//!
//! L'app fonctionne hors-ligne une fois les données en cache. Aucun appel réseau n'est fait pendant un raid,
//! sauf si tu cliques toi-même sur « Actualiser ». Les fichiers sont lus en flux (sans les charger en entier
//! en mémoire) puis réduits à ce dont l'app a besoin.

use serde::de::DeserializeOwned;
use serde_json::Value;
use std::collections::HashMap;
use std::path::PathBuf;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tarkov_core::dataset::{self, Envelope, ItemsDoc, Lax, MapsDoc, Quality, TasksDoc};
use tauri::{AppHandle, Emitter, Manager};

const BASE: &str = "https://json.tarkov.dev";
const MODE: &str = "regular";

fn dir(app: &AppHandle) -> Result<PathBuf, String> {
    let d = app.path().app_data_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&d).map_err(|e| e.to_string())?;
    Ok(d)
}

fn cache_file(app: &AppHandle, lang: &str) -> Result<PathBuf, String> {
    // `lang` vient de l'interface : on le restreint pour éviter tout chemin inattendu.
    if lang.is_empty() || !lang.chars().all(|c| c.is_ascii_lowercase()) || lang.len() > 3 {
        return Err("langue invalide".into());
    }
    Ok(dir(app)?.join(format!("data-v2-{lang}.json")))
}

/// Début lisible d'une réponse d'erreur (messages JSON si possible, sinon texte brut).
fn excerpt(text: &str) -> String {
    if let Ok(v) = serde_json::from_str::<Value>(text) {
        let msgs: Vec<String> = v
            .get("errors")
            .and_then(Value::as_array)
            .map(|a| a.iter().filter_map(|e| e.as_str().map(str::to_string).or_else(|| e.get("message").and_then(Value::as_str).map(str::to_string))).collect())
            .unwrap_or_default();
        if !msgs.is_empty() {
            return msgs.join(" ; ").chars().take(400).collect();
        }
    }
    let flat: String = text.split_whitespace().collect::<Vec<_>>().join(" ");
    if flat.is_empty() { "(réponse vide)".into() } else { flat.chars().take(300).collect() }
}

/// Télécharge et décode `<MODE>/<path>`. Réessaie en cas de panne réseau ou d'erreur serveur passagère.
fn get<T: DeserializeOwned>(agent: &ureq::Agent, path: &str) -> Result<T, String> {
    let url = format!("{BASE}/{MODE}/{path}");
    let mut delay = Duration::from_secs(2);
    for attempt in 0..3 {
        let res: Result<T, (u16, String)> = (|| {
            let mut resp = agent.get(&url).header("Accept", "application/json").call().map_err(|e| (0, format!("réseau : {e}")))?;
            let status = resp.status().as_u16();
            if !(200..300).contains(&status) {
                let text = resp.body_mut().read_to_string().unwrap_or_default();
                return Err((status, format!("HTTP {status} : {}", excerpt(&text))));
            }
            resp.body_mut().with_config().limit(512 * 1024 * 1024).read_json::<T>().map_err(|e| (status, format!("réponse illisible : {e}")))
        })();
        match res {
            Ok(v) => return Ok(v),
            Err((s, _)) if (s == 0 || s == 429 || s >= 500) && attempt < 2 => {
                std::thread::sleep(delay);
                delay *= 2;
            }
            Err((_, e)) => return Err(format!("{path} : {e}")),
        }
    }
    Err(format!("{path} : trop d'échecs"))
}

/// Table de traduction `<name>_<lang>` ; repli sur l'anglais si la langue n'existe pas.
fn translations(agent: &ureq::Agent, name: &str, lang: &str) -> Result<dataset::Table, String> {
    let first = get::<Envelope<HashMap<String, Lax>>>(agent, &format!("{name}_{lang}"));
    let doc = match first {
        Ok(d) => d,
        Err(e) if lang != "en" => get::<Envelope<HashMap<String, Lax>>>(agent, &format!("{name}_en")).map_err(|e2| format!("{e} ; repli sur l'anglais : {e2}"))?,
        Err(e) => return Err(e),
    };
    Ok(dataset::table_from(doc.data))
}

fn download(app: &AppHandle, lang: &str) -> Result<String, String> {
    let agent: ureq::Agent = ureq::Agent::config_builder()
        .http_status_as_error(false)
        .timeout_global(Some(Duration::from_secs(240)))
        .user_agent("TarkovTracker/0.4")
        .build()
        .into();

    let path = cache_file(app, lang)?;
    let previous: Option<Value> = std::fs::read_to_string(&path).ok().and_then(|t| serde_json::from_str(&t).ok());
    let old = |k: &str| previous.as_ref().and_then(|v| v.get(k)).cloned();
    let step = |label: &str| {
        let _ = app.emit("data-progress", format!("Téléchargement : {label}…"));
    };

    let mut q = Quality::default();
    let mut warnings: Vec<String> = Vec::new();
    let mut ok_count = 0;
    let mut keep = |what: &str, e: String, had_old: bool| {
        warnings.push(format!("{what} : {e}{}", if had_old { " (anciennes données conservées)" } else { "" }));
    };

    // 1) Objets (leurs noms servent aussi à nommer les conteneurs).
    step("objets");
    let items = (|| -> Result<dataset::ItemsOut, String> {
        let doc: Envelope<ItemsDoc> = get(&agent, "items")?;
        let t = translations(&agent, "items", lang)?;
        Ok(dataset::convert_items(&doc.data, &t, &mut q))
    })();
    let (items_val, item_names) = match items {
        Ok(o) => {
            ok_count += 1;
            (o.items, o.names)
        }
        Err(e) => {
            keep("objets", e, old("items").is_some());
            (old("items").unwrap_or_else(|| Value::Array(vec![])), HashMap::new())
        }
    };

    // 2) Marchands (facultatif : sans eux les quêtes s'affichent, mais sans regroupement par marchand).
    step("marchands");
    let traders = (|| -> Result<HashMap<String, Value>, String> {
        let doc: Envelope<Value> = get(&agent, "traders")?;
        let t = translations(&agent, "traders", lang)?;
        Ok(dataset::convert_traders(&doc.data, &t))
    })();
    let traders = match traders {
        Ok(t) => t,
        Err(e) => {
            keep("marchands", e, false);
            HashMap::new()
        }
    };

    // 3) Cartes.
    step("cartes");
    let maps = (|| -> Result<dataset::MapsOut, String> {
        let doc: Envelope<MapsDoc> = get(&agent, "maps")?;
        let t = translations(&agent, "maps", lang)?;
        Ok(dataset::convert_maps(&doc.data, &t, &item_names, &mut q))
    })();
    let (maps_val, slugs) = match maps {
        Ok(o) => {
            ok_count += 1;
            (o.maps, Some(o.slugs))
        }
        Err(e) => {
            keep("cartes", e, old("maps").is_some());
            (old("maps").unwrap_or_else(|| Value::Array(vec![])), None)
        }
    };

    // 4) Quêtes (ont besoin des identifiants de cartes pour placer leurs zones).
    step("quêtes");
    let tasks = match &slugs {
        None => Err("dépend des cartes, qui n'ont pas pu être téléchargées".to_string()),
        Some(slugs) => (|| -> Result<Value, String> {
            let doc: Envelope<TasksDoc> = get(&agent, "tasks")?;
            let t = translations(&agent, "tasks", lang)?;
            Ok(dataset::convert_tasks(&doc.data.tasks.0, slugs, &traders, &t, &mut q))
        })(),
    };
    let tasks_val = match tasks {
        Ok(v) => {
            ok_count += 1;
            v
        }
        Err(e) => {
            keep("quêtes", e, old("tasks").is_some());
            old("tasks").unwrap_or_else(|| Value::Array(vec![]))
        }
    };

    if ok_count == 0 {
        return Err(warnings.join("\n"));
    }

    let fetched_at = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
    let mut all = dataset::assemble(tasks_val, maps_val, items_val, lang, fetched_at, &q);

    // Écriture atomique : un téléchargement interrompu ne corrompt pas le cache.
    let text = serde_json::to_string(&all).map_err(|e| e.to_string())?;
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, &text).map_err(|e| format!("Écriture du cache : {e}"))?;
    std::fs::rename(&tmp, &path).map_err(|e| format!("Écriture du cache : {e}"))?;

    // Les avertissements sont renvoyés à l'interface mais pas stockés dans le cache.
    all["warnings"] = serde_json::json!(warnings);
    serde_json::to_string(&all).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn load_cache(app: AppHandle, lang: String) -> Result<Option<String>, String> {
    let path = cache_file(&app, &lang)?;
    match std::fs::read_to_string(path) {
        Ok(t) => Ok(Some(t)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

#[tauri::command]
pub async fn refresh_data(app: AppHandle, lang: String) -> Result<String, String> {
    cache_file(&app, &lang)?;
    tauri::async_runtime::spawn_blocking(move || download(&app, &lang))
        .await
        .map_err(|e| e.to_string())?
}

fn progress_file(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(dir(app)?.join("progress.json"))
}

#[tauri::command]
pub fn load_progress(app: AppHandle) -> Result<Option<String>, String> {
    match std::fs::read_to_string(progress_file(&app)?) {
        Ok(t) => Ok(Some(t)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

#[tauri::command]
pub fn save_progress(app: AppHandle, json: String) -> Result<(), String> {
    serde_json::from_str::<Value>(&json).map_err(|e| format!("JSON invalide : {e}"))?;
    let path = progress_file(&app)?;
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, json).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, &path).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn excerpt_messages_et_texte_brut() {
        assert_eq!(excerpt(r#"{"errors":[{"message":"boom"},"autre"]}"#), "boom ; autre");
        assert_eq!(excerpt("<html>\n  <body>404</body>\n</html>"), "<html> <body>404</body> </html>");
        assert_eq!(excerpt("  "), "(réponse vide)");
    }
}
