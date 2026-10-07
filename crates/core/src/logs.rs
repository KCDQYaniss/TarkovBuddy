use crate::maps;
use serde::Serialize;
use std::collections::HashMap;
use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};

/// Extrait l'identifiant de map (`bigmap`, `Woods`, ...) d'une ligne de
/// `application.log`. La ligne apparaît juste après la fin du matching.
pub fn parse_map_line(line: &str) -> Option<String> {
    if !line.contains("application|TRACE-NetworkGameCreate profileStatus") {
        return None;
    }
    let i = line.find("Location: ")? + "Location: ".len();
    let raw = line[i..].split(',').next()?.trim();
    if raw.is_empty() {
        None
    } else {
        Some(raw.to_string())
    }
}

/// Map détectée dans une ligne de log.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct MapHit {
    /// Identifiant brut (`bigmap`, `Woods`, ou nom de scène `bigmap_preset`).
    pub raw: String,
    /// Slug de la carte (`customs`...), `None` si inconnue.
    pub slug: Option<&'static str>,
    /// `true` si détectée via la scène chargée (moins précis que `Location:`).
    pub from_scene: bool,
}

/// Cherche une map dans une ligne : `Location:` (précis) en priorité, sinon la scène chargée.
pub fn parse_map_any(line: &str) -> Option<MapHit> {
    if let Some(raw) = parse_map_line(line) {
        let slug = maps::slug_from_location(&raw);
        return Some(MapHit { raw, slug, from_scene: false });
    }
    let stem = parse_scene_line(line)?;
    let slug = maps::slug_from_scene(&stem);
    Some(MapHit { raw: stem, slug, from_scene: true })
}

/// Nom du bundle de scène (`bigmap_preset`) dans une ligne `scene preset path:maps/bigmap_preset.bundle`.
pub fn parse_scene_line(line: &str) -> Option<String> {
    if !line.contains("application|scene preset path:") {
        return None;
    }
    let rest = &line[line.find("maps/")? + 5..];
    let stem = &rest[..rest.find(".bundle")?];
    (!stem.is_empty() && stem.chars().all(|c| c.is_ascii_alphanumeric() || c == '_')).then(|| stem.to_string())
}

/// Masque les valeurs sensibles (identifiants, adresses) avant d'afficher une ligne de log dans le diagnostic.
pub fn redact(line: &str) -> String {
    let mut out = line.to_string();
    for key in ["ProfileId: ", "Ip: ", "Sid: ", "AccountId: ", "Port: ", "shortId: "] {
        let mut from = 0;
        while let Some(i) = out[from..].find(key) {
            let start = from + i + key.len();
            let end = out[start..].find(|c| c == ',' || c == '\'' || c == ' ').map_or(out.len(), |e| start + e);
            out.replace_range(start..end, "***");
            from = start + 3;
        }
    }
    out.chars().take(300).collect()
}

/// Nom du fichier sans `.log` ni suffixe de rotation : `2026.10.04_21-04-11_1.0 notifications_000.log` -> `... notifications`.
fn log_stem(path: &Path) -> Option<&str> {
    let name = path.file_name()?.to_str()?.strip_suffix(".log")?;
    match name.rfind('_') {
        Some(i) if i + 1 < name.len() && name[i + 1..].bytes().all(|b| b.is_ascii_digit()) => Some(&name[..i]),
        _ => Some(name),
    }
}

/// `application.log`, `application_000.log`, `application_001.log`...
pub fn is_application_log(path: &Path) -> bool {
    log_stem(path).map_or(false, |s| s.ends_with("application"))
}

/// `notifications.log`, `notifications_000.log`, `push-notifications.log`... (le jeu ajoute un suffixe de rotation).
pub fn is_notifications_log(path: &Path) -> bool {
    log_stem(path).map_or(false, |s| s.ends_with("notifications"))
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum TaskStatus {
    Started,
    Failed,
    Finished,
}

/// Changement d'état d'une quête, tel que le jeu l'annonce dans `notifications.log`.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct TaskEvent {
    pub id: String,
    pub status: TaskStatus,
    /// Horodatage de l'évènement dans le log (ms depuis 1970), 0 si illisible.
    pub at: i64,
}

/// Jours depuis 1970-01-01 pour une date civile (algorithme de Howard Hinnant).
fn days_from_civil(y: i64, m: i64, d: i64) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400;
    let doy = (153 * (if m > 2 { m - 3 } else { m + 9 }) + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

/// Lit `2024-01-15 21:04:11.123 +01:00|...` et renvoie des millisecondes depuis 1970 (UTC).
pub fn header_epoch_ms(line: &str) -> Option<i64> {
    let head = line.split('|').next()?;
    let mut it = head.split_whitespace();
    let (date, time) = (it.next()?, it.next()?);
    let mut d = date.split('-').map(|x| x.parse::<i64>().ok());
    let (y, mo, da) = (d.next()??, d.next()??, d.next()??);
    let (hms, ms) = time.split_once('.').unwrap_or((time, "0"));
    let mut t = hms.split(':').map(|x| x.parse::<i64>().ok());
    let (h, mi, se) = (t.next()??, t.next()??, t.next()??);
    let ms: i64 = format!("{:0<3}", ms)[..3].parse().ok()?;
    let off_min = match it.next() {
        Some(o) if o.len() >= 5 && (o.starts_with('+') || o.starts_with('-')) => {
            let sign = if o.starts_with('-') { -1 } else { 1 };
            let (oh, om) = o[1..].split_once(':')?;
            sign * (oh.parse::<i64>().ok()? * 60 + om.parse::<i64>().ok()?)
        }
        _ => 0,
    };
    if !(1..=12).contains(&mo) || !(1..=31).contains(&da) || h > 23 || mi > 59 || se > 60 {
        return None;
    }
    Some(((days_from_civil(y, mo, da) * 24 + h) * 60 + mi - off_min) * 60_000 + se * 1000 + ms)
}

fn is_header(line: &str) -> bool {
    // "2024-01-15 21:04:11.123 +01:00|..."
    let b = line.as_bytes();
    b.len() > 11
        && b[..4].iter().all(u8::is_ascii_digit)
        && b[4] == b'-'
        && b[5..7].iter().all(u8::is_ascii_digit)
        && b[7] == b'-'
        && b[8..10].iter().all(u8::is_ascii_digit)
        && b[10] == b' '
}

/// Lit un bloc JSON `ChatMessageReceived` et en tire un changement d'état de quête.
/// Types de message du jeu : 10 = démarrée, 11 = échouée, 12 = terminée.
/// L'identifiant de quête est le premier mot de `templateId`.
pub fn parse_task_json(json: &str, at: i64) -> Option<TaskEvent> {
    let v: serde_json::Value = serde_json::from_str(json).ok()?;
    let msg = v.get("message")?;
    let status = match msg.get("type")?.as_i64()? {
        10 => TaskStatus::Started,
        11 => TaskStatus::Failed,
        12 => TaskStatus::Finished,
        _ => return None,
    };
    let id = msg.get("templateId")?.as_str()?.split_whitespace().next()?;
    if id.len() != 24 || !id.bytes().all(|c| c.is_ascii_hexdigit()) {
        return None;
    }
    Some(TaskEvent { id: id.to_ascii_lowercase(), status, at })
}

/// Reconstitue les entrées multi-lignes de `notifications.log` :
/// une ligne d'en-tête datée, suivie d'un bloc JSON qui se ferme sur une ligne `}`.
#[derive(Default)]
pub struct NotifParser {
    collecting: bool,
    buf: String,
    at: i64,
}

impl NotifParser {
    pub fn push(&mut self, line: &str) -> Option<TaskEvent> {
        if self.collecting {
            if is_header(line) {
                // Entrée tronquée : on repart sur la nouvelle en-tête.
                self.collecting = false;
                self.buf.clear();
            } else {
                self.buf.push_str(line);
                self.buf.push('\n');
                if line.trim_end() == "}" {
                    self.collecting = false;
                    let json = std::mem::take(&mut self.buf);
                    return parse_task_json(&json, self.at);
                }
                return None;
            }
        }
        if is_header(line) && line.contains("Got notification | ChatMessageReceived") {
            self.collecting = true;
            self.at = header_epoch_ms(line).unwrap_or(0);
            self.buf.clear();
        }
        None
    }
}

/// Résultat d'une relecture complète des logs.
#[derive(Debug, Default, Serialize)]
pub struct ScanReport {
    /// Évènements de quête, triés du plus ancien au plus récent.
    pub events: Vec<TaskEvent>,
    /// Nombre de fichiers de notifications lus.
    pub files: usize,
    /// Nombre de sessions (dossiers `log_...`) parcourues.
    pub sessions: usize,
}

/// Rejoue tous les fichiers de notifications existants pour reconstituer l'historique des quêtes.
/// Le jeu ne garde qu'un nombre limité de sessions : l'historique est donc partiel pour un compte ancien.
pub fn scan_task_history_report(logs_dir: &Path) -> ScanReport {
    let mut dirs: Vec<_> = std::fs::read_dir(logs_dir)
        .into_iter()
        .flatten()
        .filter_map(Result::ok)
        .filter(|e| e.file_name().to_string_lossy().starts_with("log_"))
        .filter_map(|e| {
            let m = e.metadata().ok()?;
            m.is_dir().then(|| (m.modified().ok(), e.path()))
        })
        .collect();
    dirs.sort_by_key(|(m, _)| *m);

    let mut rep = ScanReport { sessions: dirs.len(), ..Default::default() };
    for (_, dir) in dirs {
        let Ok(rd) = std::fs::read_dir(&dir) else { continue };
        let mut files: Vec<PathBuf> = rd.filter_map(Result::ok).map(|e| e.path()).filter(|p| is_notifications_log(p)).collect();
        files.sort();
        for p in files {
            let Ok(file) = File::open(&p) else { continue };
            rep.files += 1;
            let mut parser = NotifParser::default();
            for raw in std::io::BufRead::split(std::io::BufReader::new(file), b'\n').filter_map(Result::ok) {
                let line = String::from_utf8_lossy(&raw);
                if let Some(ev) = parser.push(line.trim_end_matches('\r')) {
                    rep.events.push(ev);
                }
            }
        }
    }
    // Les horodatages font foi (plusieurs fichiers par session, sessions dans un ordre quelconque).
    rep.events.sort_by_key(|e| e.at);
    rep
}

pub fn scan_task_history(logs_dir: &Path) -> Vec<TaskEvent> {
    scan_task_history_report(logs_dir).events
}

/// Le dossier `log_<date>_<version>` le plus récemment modifié.
/// (On n'utilise pas le nom : l'heure n'est pas zéro-paddée, le tri texte serait faux.)
pub fn latest_log_dir(logs_dir: &Path) -> Option<PathBuf> {
    std::fs::read_dir(logs_dir)
        .ok()?
        .filter_map(Result::ok)
        .filter(|e| e.file_name().to_string_lossy().starts_with("log_"))
        .filter_map(|e| {
            let meta = e.metadata().ok()?;
            meta.is_dir().then(|| (meta.modified().ok(), e.path()))
        })
        .max_by_key(|(m, _)| *m)
        .map(|(_, p)| p)
}

/// Dernière map vue dans les `tail_bytes` derniers octets d'un fichier.
pub fn last_map_in_file(path: &Path, tail_bytes: u64) -> Option<MapHit> {
    let mut f = File::open(path).ok()?;
    let len = f.metadata().ok()?.len();
    f.seek(SeekFrom::Start(len.saturating_sub(tail_bytes))).ok()?;
    let mut buf = Vec::new();
    f.read_to_end(&mut buf).ok()?;
    String::from_utf8_lossy(&buf).lines().filter_map(parse_map_any).last()
}

/// Lecture incrémentale : on ne relit jamais un fichier depuis le début.
#[derive(Default)]
pub struct Tail {
    offsets: HashMap<PathBuf, u64>,
    pending: HashMap<PathBuf, String>,
}

impl Tail {
    pub fn skip_to_end(&mut self, path: &Path) {
        if let Ok(m) = std::fs::metadata(path) {
            self.offsets.insert(path.to_path_buf(), m.len());
        }
    }

    /// Retourne les nouvelles lignes complètes depuis le dernier appel.
    pub fn read_new(&mut self, path: &Path) -> Vec<String> {
        let Ok(mut f) = File::open(path) else { return vec![] };
        let Ok(meta) = f.metadata() else { return vec![] };
        let off = self.offsets.entry(path.to_path_buf()).or_insert(0);
        if meta.len() < *off {
            // Fichier tronqué ou recréé.
            *off = 0;
            self.pending.remove(path);
        }
        if meta.len() == *off || f.seek(SeekFrom::Start(*off)).is_err() {
            return vec![];
        }
        let mut buf = Vec::new();
        let Ok(n) = f.read_to_end(&mut buf) else { return vec![] };
        *off += n as u64;

        let mut text = self.pending.remove(path).unwrap_or_default();
        text.push_str(&String::from_utf8_lossy(&buf));

        let mut lines: Vec<String> = text.split('\n').map(|l| l.trim_end_matches('\r').to_string()).collect();
        // Le dernier morceau est soit vide (le texte finissait par \n), soit une ligne incomplète.
        let last = lines.pop().unwrap_or_default();
        if !last.is_empty() {
            self.pending.insert(path.to_path_buf(), last);
        }
        lines
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    const LIGNE: &str = "2024-01-15 21:04:11.123 +01:00|0.15.0.0.12345|Info|application|TRACE-NetworkGameCreate profileStatus: 'ProfileId: abc, Status: MatchWait, RaidMode: Online, Ip: 1.2.3.4, Port: 17000, Location: bigmap, Sid: x, GameMode: deathmatch, shortId: AB12CD'";

    fn tmp(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("tarkov-core-{}-{}", name, std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn detecte_la_map() {
        assert_eq!(parse_map_line(LIGNE).as_deref(), Some("bigmap"));
        assert_eq!(parse_map_line("2024-01-15 application|autre chose Location: bigmap,"), None);
    }

    #[test]
    fn scene_et_masquage() {
        let l = "2026-10-04 10:00:00.000 +02:00|1.0|Info|application|scene preset path:maps/bigmap_preset.bundle";
        assert_eq!(parse_scene_line(l).as_deref(), Some("bigmap_preset"));
        assert_eq!(parse_scene_line("2026|x|application|autre"), None);
        let r = redact(LIGNE);
        assert!(!r.contains("1.2.3.4") && !r.contains("ProfileId: abc") && !r.contains("AB12CD"), "{r}");
        assert!(r.contains("Location: bigmap"), "la map doit rester lisible : {r}");
    }

    #[test]
    fn scene_en_secours_et_priorite_a_location() {
        let scene = "2026-10-04 10:00:00.000 +02:00|1.0|Info|application|scene preset path:maps/woods_preset.bundle";
        let h = parse_map_any(scene).unwrap();
        assert_eq!((h.slug, h.from_scene), (Some("woods"), true));
        let h = parse_map_any(LIGNE).unwrap();
        assert_eq!((h.slug, h.from_scene), (Some("customs"), false));
        let d = tmp("scene");
        let p = d.join("application.log");
        std::fs::write(&p, format!("{scene}\n{LIGNE}\nbruit\n")).unwrap();
        assert_eq!(last_map_in_file(&p, 1 << 20).unwrap().slug, Some("customs"));
    }

    #[test]
    fn nom_de_fichier_log() {
        assert!(is_application_log(Path::new("/x/2024.01.15_21-04-11_0.15 application.log")));
        assert!(is_notifications_log(Path::new("/x/notifications.log")));
        assert!(!is_application_log(Path::new("/x/notifications.log")));
    }

    #[test]
    fn noms_de_fichier_avec_suffixe_de_rotation() {
        // Les versions récentes du jeu écrivent `..._000.log` : c'est ce qui empêchait la synchro des quêtes.
        for n in ["2026.10.04_21-04-11_1.0.0.0.42157 notifications_000.log", "x push-notifications_001.log", "x notifications.log", "x push-notifications.log"] {
            assert!(is_notifications_log(Path::new(n)), "{n}");
            assert!(!is_application_log(Path::new(n)), "{n}");
        }
        for n in ["2026.10.04_21-04-11_1.0.0.0.42157 application_000.log", "x application.log", "x application_012.log"] {
            assert!(is_application_log(Path::new(n)), "{n}");
            assert!(!is_notifications_log(Path::new(n)), "{n}");
        }
        for n in ["x network-connection_000.log", "x backend_000.log", "notifications.txt", "x errors.log"] {
            assert!(!is_notifications_log(Path::new(n)) && !is_application_log(Path::new(n)), "{n}");
        }
    }

    #[test]
    fn horodatage_des_entetes() {
        // 2024-01-15 21:04:11.123 +01:00  =  2024-01-15 20:04:11.123 UTC
        assert_eq!(header_epoch_ms("2024-01-15 21:04:11.123 +01:00|0.15|Info|x"), Some(1_705_349_051_123));
        assert_eq!(header_epoch_ms("1970-01-01 00:00:00.000 +00:00|x"), Some(0));
        assert_eq!(header_epoch_ms("2024-03-10 04:00:00.500 -05:00|x"), Some(1_710_061_200_500));
        assert_eq!(header_epoch_ms("2024-01-15 21:04:11 +01:00|x"), Some(1_705_349_051_000), "sans millisecondes");
        assert_eq!(header_epoch_ms("pas une date|x"), None);
        assert_eq!(header_epoch_ms("2024-13-15 21:04:11.123 +01:00|x"), None);
    }

    #[test]
    fn lecture_incrementale_et_ligne_coupee() {
        let d = tmp("tail");
        let p = d.join("application.log");
        let mut f = File::create(&p).unwrap();
        let mut t = Tail::default();

        write!(f, "ligne1\nlig").unwrap();
        f.flush().unwrap();
        assert_eq!(t.read_new(&p), vec!["ligne1"]);
        write!(f, "ne2\r\nligne3\n").unwrap();
        f.flush().unwrap();
        assert_eq!(t.read_new(&p), vec!["ligne2", "ligne3"]);
        assert!(t.read_new(&p).is_empty());

        // Troncature => on repart du début.
        File::create(&p).unwrap().write_all(b"neuf\n").unwrap();
        assert_eq!(t.read_new(&p), vec!["neuf"]);
    }

    const NOTIF: &str = "2024-01-15 21:04:11.123 +01:00|0.15|Info|push-notifications|Got notification | ChatMessageReceived
{
    \"type\": \"new_message\",
    \"dialogId\": \"54cb50c76803fa8b248b4571\",
    \"message\": {
        \"_id\": \"65a5\",
        \"type\": 12,
        \"templateId\": \"5936D90786F7742B1420BA5B successMessageText 0\",
        \"items\": {
            \"stash\": \"x\"
        }
    }
}
";

    fn feed(p: &mut NotifParser, text: &str) -> Vec<TaskEvent> {
        text.lines().filter_map(|l| p.push(l)).collect()
    }

    #[test]
    fn quete_terminee() {
        let ev = feed(&mut NotifParser::default(), NOTIF);
        assert_eq!(ev, vec![TaskEvent { id: "5936d90786f7742b1420ba5b".into(), status: TaskStatus::Finished, at: 1_705_349_051_123 }]);
    }

    #[test]
    fn quete_demarree_et_echouee() {
        let s = NOTIF.replace("\"type\": 12", "\"type\": 10");
        assert_eq!(feed(&mut NotifParser::default(), &s)[0].status, TaskStatus::Started);
        let f = NOTIF.replace("\"type\": 12", "\"type\": 11");
        assert_eq!(feed(&mut NotifParser::default(), &f)[0].status, TaskStatus::Failed);
    }

    #[test]
    fn messages_non_quete_ignores() {
        let flea = NOTIF.replace("\"type\": 12", "\"type\": 4");
        assert!(feed(&mut NotifParser::default(), &flea).is_empty());
        let pas_un_id = NOTIF.replace("5936D90786F7742B1420BA5B", "pas-un-id");
        assert!(feed(&mut NotifParser::default(), &pas_un_id).is_empty());
        let autre = NOTIF.replace("ChatMessageReceived", "GroupMatchInviteAccept");
        assert!(feed(&mut NotifParser::default(), &autre).is_empty());
    }

    #[test]
    fn entree_tronquee_puis_valide() {
        let tronquee = "2024-01-15 21:00:00.000 +01:00|0.15|Info|push-notifications|Got notification | ChatMessageReceived\n{\n    \"type\": \"new_mess\n";
        let ev = feed(&mut NotifParser::default(), &format!("{tronquee}{NOTIF}"));
        assert_eq!(ev.len(), 1);
    }

    #[test]
    fn historique_sur_plusieurs_sessions() {
        let d = tmp("history");
        for (i, status) in [(1, 10), (2, 12)] {
            let dir = d.join(format!("log_2024.01.1{i}_10-00-00_0.15"));
            std::fs::create_dir_all(&dir).unwrap();
            std::fs::write(
                dir.join(format!("2024.01.1{i}_10-00-00_0.15 notifications.log")),
                NOTIF.replace("\"type\": 12", &format!("\"type\": {status}")),
            )
            .unwrap();
            std::thread::sleep(std::time::Duration::from_millis(30));
        }
        let ev = scan_task_history(&d);
        assert_eq!(ev.iter().map(|e| e.status).collect::<Vec<_>>(), vec![TaskStatus::Started, TaskStatus::Finished]);
    }

    #[test]
    fn rapport_de_scan_avec_fichiers_000_tries_par_date() {
        let d = tmp("report");
        let dir = d.join("log_2026.10.04_21-04-11_1.0");
        std::fs::create_dir_all(&dir).unwrap();
        let tard = NOTIF.replace("2024-01-15 21:04:11.123", "2024-01-16 10:00:00.000");
        // Le fichier le plus récent porte le nom qui vient en premier : seuls les horodatages doivent décider.
        std::fs::write(dir.join("2026.10.04_21-04-11_1.0 a notifications_000.log"), tard.replace("\"type\": 12", "\"type\": 11")).unwrap();
        std::fs::write(dir.join("2026.10.04_21-04-11_1.0 b notifications_001.log"), NOTIF).unwrap();
        std::fs::write(dir.join("2026.10.04_21-04-11_1.0 application_000.log"), "bruit\n").unwrap();
        let r = scan_task_history_report(&d);
        assert_eq!((r.sessions, r.files, r.events.len()), (1, 2, 2));
        assert_eq!(r.events[0].status, TaskStatus::Finished, "plus ancien d'abord");
        assert_eq!(r.events[1].status, TaskStatus::Failed);
        assert!(r.events[0].at < r.events[1].at);
    }

    #[test]
    fn derniere_map_dans_la_queue() {
        let d = tmp("lastmap");
        let p = d.join("application.log");
        let autre = LIGNE.replace("bigmap", "Woods");
        std::fs::write(&p, format!("{LIGNE}\nbruit\n{autre}\nbruit\n")).unwrap();
        assert_eq!(last_map_in_file(&p, 1 << 20).map(|h| h.raw).as_deref(), Some("Woods"));
    }
}
