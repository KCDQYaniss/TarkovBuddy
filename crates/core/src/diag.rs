//! Diagnostic de la détection : dit précisément pourquoi la map ou les quêtes ne sont pas détectées.

use crate::{logs, paths};
use serde::Serialize;
use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::time::SystemTime;

#[derive(Debug, Serialize)]
pub struct FileInfo {
    pub name: String,
    pub bytes: u64,
    pub modified_secs_ago: Option<u64>,
}

#[derive(Debug, Serialize, Default)]
pub struct Diagnostics {
    pub logs_dir: Option<String>,
    pub logs_dir_source: String,
    /// Emplacements vérifiés automatiquement, avec « oui/non » selon qu'ils existent.
    pub tried: Vec<String>,
    pub sessions: usize,
    pub latest_session: Option<String>,
    pub files: Vec<FileInfo>,
    pub last_map_raw: Option<String>,
    pub last_map_slug: Option<String>,
    pub location_lines: usize,
    pub task_events_latest_session: usize,
    /// Dernières lignes du log de l'application (identifiants masqués) pour juger du format.
    pub recent_lines: Vec<String>,
    pub screenshots_dir: String,
    pub screenshots_dir_exists: bool,
    pub newest_screenshot: Option<String>,
    pub hints: Vec<String>,
}

fn ago(t: Option<SystemTime>) -> Option<u64> {
    SystemTime::now().duration_since(t?).ok().map(|d| d.as_secs())
}

fn read_tail(path: &Path, bytes: u64) -> String {
    let Ok(mut f) = File::open(path) else { return String::new() };
    let len = f.metadata().map(|m| m.len()).unwrap_or(0);
    let _ = f.seek(SeekFrom::Start(len.saturating_sub(bytes)));
    let mut buf = Vec::new();
    let _ = f.read_to_end(&mut buf);
    String::from_utf8_lossy(&buf).into_owned()
}

pub fn diagnose(manual_logs: Option<&Path>, screenshots: &Path) -> Diagnostics {
    let mut d = Diagnostics { screenshots_dir: screenshots.display().to_string(), screenshots_dir_exists: screenshots.is_dir(), ..Default::default() };

    // --- Où sont les logs ? ---
    let candidates = paths::log_dir_candidates();
    d.tried = candidates.iter().map(|p| format!("{} : {}", p.display(), if p.is_dir() { "existe" } else { "absent" })).collect();
    let logs: Option<PathBuf> = match manual_logs {
        Some(m) if m.is_dir() => {
            d.logs_dir_source = "réglage manuel".into();
            Some(m.to_path_buf())
        }
        Some(m) => {
            d.hints.push(format!("Le dossier de logs saisi dans Réglages n'existe pas : {}", m.display()));
            d.logs_dir_source = "réglage manuel (introuvable)".into();
            None
        }
        None => {
            d.logs_dir_source = "détection automatique".into();
            paths::pick_log_dir(&candidates)
        }
    };
    d.logs_dir = logs.as_ref().map(|p| p.display().to_string());

    let Some(logs) = logs else {
        if manual_logs.is_none() {
            d.hints.push("Dossier des logs introuvable automatiquement. Cherche un dossier « Logs » dans le dossier d'installation du jeu (avec Steam : …\\Escape from Tarkov\\build\\Logs) et colle son chemin dans Réglages.".into());
        }
        return finish(d, screenshots);
    };

    // --- Sessions et fichiers ---
    d.sessions = std::fs::read_dir(&logs)
        .map(|rd| rd.filter_map(Result::ok).filter(|e| e.file_name().to_string_lossy().starts_with("log_")).count())
        .unwrap_or(0);
    if d.sessions == 0 {
        d.hints.push("Ce dossier ne contient aucun sous-dossier « log_… » : ce n'est probablement pas le bon dossier de logs.".into());
        return finish(d, screenshots);
    }
    let Some(latest) = logs::latest_log_dir(&logs) else { return finish(d, screenshots) };
    d.latest_session = latest.file_name().map(|n| n.to_string_lossy().into_owned());

    let mut app_log: Option<(Option<SystemTime>, PathBuf)> = None;
    let mut notif_logs: Vec<PathBuf> = Vec::new();
    if let Ok(rd) = std::fs::read_dir(&latest) {
        for e in rd.filter_map(Result::ok) {
            let p = e.path();
            let Ok(m) = e.metadata() else { continue };
            if p.extension().map_or(false, |x| x == "log") && d.files.len() < 20 {
                d.files.push(FileInfo { name: e.file_name().to_string_lossy().into_owned(), bytes: m.len(), modified_secs_ago: ago(m.modified().ok()) });
            }
            // Plusieurs fichiers de rotation possibles : pour la map on prend le plus récent, pour les quêtes on les lit tous.
            if logs::is_application_log(&p) && app_log.as_ref().map_or(true, |(t, _)| m.modified().ok() >= *t) {
                app_log = Some((m.modified().ok(), p.clone()));
            }
            if logs::is_notifications_log(&p) {
                notif_logs.push(p);
            }
        }
    }
    d.files.sort_by(|a, b| a.name.cmp(&b.name));

    // --- Map ---
    match app_log {
        None => d.hints.push("Aucun fichier « application.log » dans la dernière session : le jeu a-t-il été lancé ?".into()),
        Some((_, p)) => {
            let text = read_tail(&p, 4 * 1024 * 1024);
            d.location_lines = text.lines().filter(|l| l.contains("Location: ")).count();
            if let Some(hit) = text.lines().filter_map(logs::parse_map_any).last() {
                d.last_map_raw = Some(hit.raw);
                d.last_map_slug = hit.slug.map(str::to_string);
            }
            d.recent_lines = text.lines().rev().filter(|l| !l.trim().is_empty()).take(4).map(logs::redact).collect::<Vec<_>>().into_iter().rev().collect();
            if d.last_map_raw.is_none() {
                d.hints.push("Le log est lisible mais ne contient aucune ligne de map : lance une partie (jusqu'au chargement du raid) puis relance le diagnostic.".into());
            } else if d.last_map_slug.is_none() {
                d.hints.push(format!("Map « {} » trouvée dans les logs mais pas reconnue : dis-le moi pour que je l'ajoute.", d.last_map_raw.as_deref().unwrap_or("")));
            }
        }
    }

    // --- Quêtes ---
    if notif_logs.is_empty() {
        d.hints.push("Aucun fichier de notifications (« notifications.log » ou « notifications_000.log ») dans la dernière session.".into());
    }
    for p in &notif_logs {
        let mut parser = logs::NotifParser::default();
        if let Ok(f) = File::open(p) {
            for raw in std::io::BufRead::split(std::io::BufReader::new(f), b'\n').filter_map(Result::ok) {
                if parser.push(String::from_utf8_lossy(&raw).trim_end_matches('\r')).is_some() {
                    d.task_events_latest_session += 1;
                }
            }
        }
    }
    finish(d, screenshots)
}

fn finish(mut d: Diagnostics, screenshots: &Path) -> Diagnostics {
    if !d.screenshots_dir_exists {
        d.hints.push("Le dossier de captures n'existe pas encore : il est créé par le jeu à la première capture d'écran.".into());
    } else {
        d.newest_screenshot = std::fs::read_dir(screenshots)
            .ok()
            .into_iter()
            .flatten()
            .filter_map(Result::ok)
            .filter_map(|e| Some((e.metadata().ok()?.modified().ok()?, e.file_name().to_string_lossy().into_owned())))
            .max_by_key(|(t, _)| *t)
            .map(|(_, n)| n);
    }
    if d.hints.is_empty() {
        d.hints.push("Tout semble en ordre côté logs.".into());
    }
    d
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("tarkov-diag-{}-{}", name, std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn dossier_manuel_inexistant() {
        let d = diagnose(Some(Path::new("Z:\\nulle part")), &tmp("s1"));
        assert!(d.logs_dir.is_none());
        assert!(d.hints.iter().any(|h| h.contains("n'existe pas")));
    }

    #[test]
    fn mauvais_dossier_sans_sessions() {
        let logs = tmp("l2");
        let d = diagnose(Some(&logs), &tmp("s2"));
        assert_eq!(d.sessions, 0);
        assert!(d.hints.iter().any(|h| h.contains("log_")));
    }

    #[test]
    fn map_et_quetes_detectees() {
        let logs = tmp("l3");
        let s = logs.join("log_2026.10.04_10-00-00_1.0");
        std::fs::create_dir_all(&s).unwrap();
        std::fs::write(s.join("x application.log"), "bruit\n2026-10-04 10:00:00.000 +02:00|1.0|Info|application|TRACE-NetworkGameCreate profileStatus: 'ProfileId: abc, Ip: 9.9.9.9, Location: bigmap, Sid: z'\n").unwrap();
        std::fs::write(s.join("x notifications.log"), "").unwrap();
        let d = diagnose(Some(&logs), &tmp("s3"));
        assert_eq!(d.last_map_slug.as_deref(), Some("customs"));
        assert_eq!(d.location_lines, 1);
        assert!(d.recent_lines.iter().all(|l| !l.contains("9.9.9.9") && !l.contains("abc")), "{:?}", d.recent_lines);
        assert_eq!(d.sessions, 1);
        assert_eq!(d.files.len(), 2);
    }

    #[test]
    fn quetes_comptees_dans_tous_les_fichiers_de_rotation() {
        let logs = tmp("l5");
        let s = logs.join("log_2026.10.04_10-00-00_1.0");
        std::fs::create_dir_all(&s).unwrap();
        let evt = |id: &str| format!("2026-10-04 10:00:00.000 +02:00|1.0|Info|push-notifications|Got notification | ChatMessageReceived\n{{\n \"message\": {{\n  \"type\": 12,\n  \"templateId\": \"{id} successMessageText 0\"\n }}\n}}\n");
        std::fs::write(s.join("x notifications_000.log"), evt("5936d90786f7742b1420ba5b")).unwrap();
        std::fs::write(s.join("x notifications_001.log"), evt("5a27b75b86f7742e97191958")).unwrap();
        let d = diagnose(Some(&logs), &tmp("s5"));
        assert_eq!(d.task_events_latest_session, 2);
        assert!(!d.hints.iter().any(|h| h.contains("Aucun fichier de notifications")));
    }

    #[test]
    fn log_sans_ligne_de_map() {
        let logs = tmp("l4");
        let s = logs.join("log_2026.10.04_10-00-00_1.0");
        std::fs::create_dir_all(&s).unwrap();
        std::fs::write(s.join("x application.log"), "rien d'utile\n").unwrap();
        let d = diagnose(Some(&logs), &tmp("s4"));
        assert!(d.last_map_raw.is_none());
        assert!(d.hints.iter().any(|h| h.contains("aucune ligne de map")));
    }
}
