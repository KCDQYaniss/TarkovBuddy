use crate::logs::{self, MapHit, NotifParser, Tail, TaskEvent};
use crate::screenshot::{parse_screenshot_name, Position};
use notify::event::ModifyKind;
use notify::{EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use serde::Serialize;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

/// Délai du filet de sécurité qui relit les logs (voir `start`).
const LOG_TICK: Duration = Duration::from_millis(1500);

#[derive(Debug, Clone, Serialize)]
pub struct MapInfo {
    /// Identifiant brut du jeu (`bigmap`...).
    pub raw: String,
    /// Slug tarkov.dev (`customs`...), `None` si inconnu.
    pub slug: Option<String>,
    /// `true` si déduite du nom de la scène chargée plutôt que de `Location:`.
    pub from_scene: bool,
}

impl From<MapHit> for MapInfo {
    fn from(h: MapHit) -> Self {
        MapInfo { raw: h.raw, slug: h.slug.map(str::to_string), from_scene: h.from_scene }
    }
}

#[derive(Debug, Clone)]
pub enum Event {
    Position(Position),
    Map(MapInfo),
    /// Changement d'état d'une quête annoncé en direct par le jeu.
    Task(TaskEvent),
    /// Problème non bloquant (dossier introuvable, erreur du watcher...).
    Warning(String),
}

#[derive(Debug, Clone)]
pub struct Config {
    pub screenshots_dir: PathBuf,
    pub logs_dir: Option<PathBuf>,
    /// Supprime le screenshot une fois la position lue (évite de remplir le disque).
    pub delete_screenshots: bool,
}

/// Garder ce handle en vie : le laisser tomber arrête la surveillance.
pub struct Handle {
    _watchers: Vec<RecommendedWatcher>,
    stop: Arc<AtomicBool>,
}

impl Drop for Handle {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Relaxed);
    }
}

type Sink = Arc<dyn Fn(Event) + Send + Sync>;

/// État partagé entre le watcher du système de fichiers et le filet de sécurité.
struct LogState {
    tail: Tail,
    parsers: HashMap<PathBuf, NotifParser>,
}

fn process_log(state: &Mutex<LogState>, path: &Path, sink: &Sink) {
    let is_app = logs::is_application_log(path);
    let is_notif = logs::is_notifications_log(path);
    if !is_app && !is_notif {
        return;
    }
    let mut guard = state.lock().unwrap();
    let LogState { tail, parsers } = &mut *guard;
    let lines = tail.read_new(path);
    if is_app {
        // Plusieurs changements de map d'un coup : seul le dernier compte, mais on émet dans l'ordre.
        for hit in lines.iter().filter_map(|l| logs::parse_map_any(l)) {
            sink(Event::Map(hit.into()));
        }
    } else {
        let parser = parsers.entry(path.to_path_buf()).or_default();
        for l in &lines {
            if let Some(t) = parser.push(l) {
                sink(Event::Task(t));
            }
        }
    }
}

fn session_logs(logs_dir: &Path) -> Vec<PathBuf> {
    let Some(latest) = logs::latest_log_dir(logs_dir) else { return vec![] };
    std::fs::read_dir(latest)
        .into_iter()
        .flatten()
        .filter_map(Result::ok)
        .map(|e| e.path())
        .filter(|p| logs::is_application_log(p) || logs::is_notifications_log(p))
        .collect()
}

pub fn start<F>(cfg: Config, sink: F) -> Handle
where
    F: Fn(Event) + Send + Sync + 'static,
{
    let sink: Sink = Arc::new(sink);
    let stop = Arc::new(AtomicBool::new(false));
    let mut watchers = Vec::new();

    // --- Screenshots : on ne lit que le NOM des fichiers créés. ---
    if cfg.screenshots_dir.is_dir() {
        let s = sink.clone();
        let last = Mutex::new(String::new());
        let delete = cfg.delete_screenshots;
        let handler = move |res: notify::Result<notify::Event>| {
            let Ok(ev) = res else { return };
            if !matches!(ev.kind, EventKind::Create(_) | EventKind::Modify(ModifyKind::Name(_))) {
                return;
            }
            for path in ev.paths {
                let Some(name) = path.file_name().and_then(|n| n.to_str()) else { continue };
                let Some(pos) = parse_screenshot_name(name) else { continue };
                {
                    let mut l = last.lock().unwrap();
                    if *l == name {
                        continue; // Create + Rename pour le même fichier
                    }
                    *l = name.to_string();
                }
                s(Event::Position(pos));
                if delete {
                    std::thread::spawn(move || {
                        // Le jeu peut encore tenir le fichier ouvert : on réessaie un peu.
                        for _ in 0..10 {
                            std::thread::sleep(Duration::from_millis(500));
                            if std::fs::remove_file(&path).is_ok() || !path.exists() {
                                break;
                            }
                        }
                    });
                }
            }
        };
        match notify::recommended_watcher(handler) {
            Ok(mut w) => match w.watch(&cfg.screenshots_dir, RecursiveMode::NonRecursive) {
                Ok(()) => watchers.push(w),
                Err(e) => sink(Event::Warning(format!("Surveillance des screenshots impossible : {e}"))),
            },
            Err(e) => sink(Event::Warning(format!("Watcher screenshots : {e}"))),
        }
    } else {
        sink(Event::Warning(format!(
            "Dossier de screenshots introuvable : {} (il est créé par le jeu à la première capture)",
            cfg.screenshots_dir.display()
        )));
    }

    // --- Logs : détection de la map et des quêtes. ---
    match cfg.logs_dir.as_ref().filter(|d| d.is_dir()) {
        Some(dir) => {
            let mut tail = Tail::default();

            // État initial : si un raid est déjà en cours, on récupère sa map.
            let current = session_logs(dir);
            for p in &current {
                if logs::is_application_log(p) {
                    if let Some(hit) = logs::last_map_in_file(p, 2 * 1024 * 1024) {
                        sink(Event::Map(hit.into()));
                    }
                }
                tail.skip_to_end(p);
            }

            let state = Arc::new(Mutex::new(LogState { tail, parsers: HashMap::new() }));

            // 1) Notifications du système de fichiers (instantanées quand Windows les envoie).
            let (s, st) = (sink.clone(), state.clone());
            let handler = move |res: notify::Result<notify::Event>| {
                let Ok(ev) = res else { return };
                if !matches!(ev.kind, EventKind::Create(_) | EventKind::Modify(_)) {
                    return;
                }
                for path in ev.paths {
                    process_log(&st, &path, &s);
                }
            };
            match notify::recommended_watcher(handler) {
                Ok(mut w) => match w.watch(dir, RecursiveMode::Recursive) {
                    Ok(()) => watchers.push(w),
                    Err(e) => sink(Event::Warning(format!("Surveillance des logs impossible : {e}"))),
                },
                Err(e) => sink(Event::Warning(format!("Watcher logs : {e}"))),
            }

            // 2) Filet de sécurité : Windows ne prévient pas toujours quand un autre processus ajoute
            //    des lignes à un fichier qu'il garde ouvert (le jeu écrit ses logs ainsi). On relit donc
            //    les fichiers de la session en cours toutes les 1,5 s : deux appels système par fichier,
            //    sans lire le contenu tant que la taille n'a pas changé.
            {
                let (s, st, dir, stop) = (sink.clone(), state.clone(), dir.clone(), stop.clone());
                std::thread::spawn(move || {
                    while !stop.load(Ordering::Relaxed) {
                        std::thread::sleep(LOG_TICK);
                        for p in session_logs(&dir) {
                            process_log(&st, &p, &s);
                        }
                    }
                });
            }
        }
        None => sink(Event::Warning(
            "Dossier de logs introuvable : renseigne-le dans Réglages (le diagnostic t'indique où chercher).".into(),
        )),
    }

    Handle { _watchers: watchers, stop }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::mpsc;
    use std::time::Duration;

    fn tmp(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("tarkov-watch-{}-{}", name, std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    fn collect(cfg: Config) -> (Handle, mpsc::Receiver<Event>) {
        let (tx, rx) = mpsc::channel();
        let tx = Mutex::new(tx);
        let h = start(cfg, move |e| {
            let _ = tx.lock().unwrap().send(e);
        });
        (h, rx)
    }

    #[test]
    fn un_screenshot_cree_emet_une_position() {
        let shots = tmp("shots");
        let (_h, rx) = collect(Config { screenshots_dir: shots.clone(), logs_dir: None, delete_screenshots: false });
        assert!(matches!(rx.recv_timeout(Duration::from_secs(2)).unwrap(), Event::Warning(_)));
        std::fs::write(shots.join("2024-01-15[21-04]_10.00, 5.00, -20.00_0, 0, 0, 1_3.0 (0).png"), b"png").unwrap();
        match rx.recv_timeout(Duration::from_secs(3)).expect("pas d'évènement reçu") {
            Event::Position(p) => assert_eq!((p.x, p.z), (10.0, -20.0)),
            other => panic!("évènement inattendu : {other:?}"),
        }
    }

    const NET: &str = "2024-01-15 21:05:00.000 +01:00|0.15|Info|application|TRACE-NetworkGameCreate profileStatus: 'x, Location: Woods, Sid: y'";

    #[test]
    fn les_logs_emettent_la_map_en_direct() {
        let logs = tmp("logs2");
        let dir = logs.join("log_2024.01.15_21-04-11_0.15.0.0");
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("2024.01.15_21-04-11_0.15.0.0 application.log");
        std::fs::write(&file, "du bruit\n").unwrap();
        let (_h, rx) = collect(Config { screenshots_dir: tmp("shots2"), logs_dir: Some(logs), delete_screenshots: false });
        std::thread::sleep(Duration::from_millis(300));
        use std::io::Write;
        let mut f = std::fs::OpenOptions::new().append(true).open(&file).unwrap();
        writeln!(f, "{NET}").unwrap();
        f.flush().unwrap();
        let deadline = std::time::Instant::now() + Duration::from_secs(4);
        loop {
            let left = deadline.saturating_duration_since(std::time::Instant::now());
            match rx.recv_timeout(left).expect("pas d'évènement de map reçu") {
                Event::Map(m) => {
                    assert_eq!((m.raw.as_str(), m.slug.as_deref()), ("Woods", Some("woods")));
                    break;
                }
                _ => continue,
            }
        }
    }

    /// Le cas qui posait problème : un fichier agrandi par le jeu SANS notification du système de fichiers.
    /// On désactive les watchers en ne s'appuyant que sur le filet de sécurité (nouveau dossier de session créé
    /// après le démarrage, comme lors d'un redémarrage du jeu).
    #[test]
    fn nouvelle_session_apres_le_demarrage_est_trouvee_par_le_filet_de_securite() {
        let logs = tmp("logs-new");
        let old = logs.join("log_2024.01.15_20-00-00_0.15");
        std::fs::create_dir_all(&old).unwrap();
        std::fs::write(old.join("2024.01.15_20-00-00_0.15 application.log"), "ancien\n").unwrap();
        let (_h, rx) = collect(Config { screenshots_dir: tmp("shots-new"), logs_dir: Some(logs.clone()), delete_screenshots: false });
        std::thread::sleep(Duration::from_millis(600));
        // Le jeu redémarre : nouvelle session, fichier déjà rempli au moment où on le voit.
        let newd = logs.join("log_2024.01.15_21-00-00_0.15");
        std::fs::create_dir_all(&newd).unwrap();
        std::fs::write(newd.join("2024.01.15_21-00-00_0.15 application.log"), format!("{NET}\n")).unwrap();
        let deadline = std::time::Instant::now() + Duration::from_secs(6);
        loop {
            let left = deadline.saturating_duration_since(std::time::Instant::now());
            match rx.recv_timeout(left).expect("la nouvelle session n'a pas été détectée") {
                Event::Map(m) if m.slug.as_deref() == Some("woods") => break,
                _ => continue,
            }
        }
    }

    #[test]
    fn une_quete_terminee_dans_les_logs_est_emise() {
        use crate::logs::TaskStatus;
        let logs = tmp("logs3");
        let dir = logs.join("log_2024.01.15_21-04-11_0.15.0.0");
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("2024.01.15_21-04-11_0.15.0.0 notifications.log");
        std::fs::write(&file, "").unwrap();
        let (_h, rx) = collect(Config { screenshots_dir: tmp("shots3"), logs_dir: Some(logs), delete_screenshots: false });
        std::thread::sleep(Duration::from_millis(300));
        use std::io::Write;
        let mut f = std::fs::OpenOptions::new().append(true).open(&file).unwrap();
        write!(f, "2024-01-15 21:05:00.000 +01:00|0.15|Info|push-notifications|Got notification | ChatMessageReceived\n{{\n  \"message\": {{\n").unwrap();
        f.flush().unwrap();
        std::thread::sleep(Duration::from_millis(100));
        write!(f, "    \"type\": 12,\n    \"templateId\": \"5936d90786f7742b1420ba5b successMessageText 0\"\n  }}\n}}\n").unwrap();
        f.flush().unwrap();
        let deadline = std::time::Instant::now() + Duration::from_secs(4);
        loop {
            let left = deadline.saturating_duration_since(std::time::Instant::now());
            match rx.recv_timeout(left).expect("pas d'évènement de quête reçu") {
                Event::Task(t) => {
                    assert_eq!((t.id.as_str(), t.status), ("5936d90786f7742b1420ba5b", TaskStatus::Finished));
                    break;
                }
                _ => continue,
            }
        }
    }
}
