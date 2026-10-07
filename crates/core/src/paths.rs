//! Où trouver les captures d'écran et les logs du jeu.
//!
//! Tarkov peut être installé via le launcher BSG ou via Steam, dans n'importe quel dossier, et les logs
//! sont soit dans `<install>\Logs`, soit dans `<install>\build\Logs`. On essaie donc plusieurs sources.
//! Les parties spécifiques à Windows (registre, lettres de lecteur) sont minuscules ; tout le reste est
//! de la logique pure, testée.

use std::path::{Path, PathBuf};

/// `Documents/Escape From Tarkov/Screenshots` (créé par le jeu à la première capture).
pub fn default_screenshots_dir() -> Option<PathBuf> {
    dirs::document_dir().map(|d| d.join("Escape From Tarkov").join("Screenshots"))
}

/// Les deux emplacements possibles du dossier de logs dans une installation.
pub fn logs_under(install: &Path) -> [PathBuf; 2] {
    [install.join("Logs"), install.join("build").join("Logs")]
}

/// Extrait les bibliothèques Steam d'un `libraryfolders.vdf` (lignes `"path"  "D:\\SteamLibrary"`).
pub fn parse_library_paths(vdf: &str) -> Vec<PathBuf> {
    let mut out = Vec::new();
    for line in vdf.lines() {
        let Some(rest) = line.trim().strip_prefix("\"path\"") else { continue };
        let rest = rest.trim();
        if rest.len() >= 2 && rest.starts_with('"') && rest.ends_with('"') {
            out.push(PathBuf::from(rest[1..rest.len() - 1].replace("\\\\", "\\")));
        }
    }
    out
}

/// Dossiers de jeu Tarkov dans une bibliothèque Steam : `steamapps/common/*tarkov*`.
fn steam_game_dirs(library: &Path) -> Vec<PathBuf> {
    let Ok(rd) = std::fs::read_dir(library.join("steamapps").join("common")) else { return vec![] };
    rd.filter_map(Result::ok)
        .filter(|e| e.file_name().to_string_lossy().to_ascii_lowercase().contains("tarkov"))
        .map(|e| e.path())
        .collect()
}

/// Tous les emplacements plausibles du dossier `Logs`, du plus probable au moins probable.
///
/// * `installs` : dossiers d'installation connus (registre)
/// * `steam_roots` : dossiers d'installation de Steam
/// * `drives` : lettres de lecteurs présents (pour les emplacements par défaut du launcher)
pub fn candidate_log_dirs(installs: &[PathBuf], steam_roots: &[PathBuf], drives: &[char]) -> Vec<PathBuf> {
    let mut roots: Vec<PathBuf> = installs.to_vec();
    for steam in steam_roots {
        let mut libs = vec![steam.clone()];
        if let Ok(text) = std::fs::read_to_string(steam.join("steamapps").join("libraryfolders.vdf")) {
            libs.extend(parse_library_paths(&text));
        }
        for lib in libs {
            roots.extend(steam_game_dirs(&lib));
        }
    }
    for d in drives {
        for tail in ["Battlestate Games\\EFT", "Games\\Battlestate Games\\EFT"] {
            roots.push(PathBuf::from(format!("{d}:\\{tail}")));
        }
    }
    let mut out: Vec<PathBuf> = Vec::new();
    for r in roots {
        for p in logs_under(&r) {
            if !out.contains(&p) {
                out.push(p);
            }
        }
    }
    out
}

pub fn has_sessions(dir: &Path) -> bool {
    std::fs::read_dir(dir)
        .map(|rd| rd.filter_map(Result::ok).any(|e| e.file_name().to_string_lossy().starts_with("log_")))
        .unwrap_or(false)
}

/// Premier candidat qui contient réellement des sessions de logs ; à défaut, premier dossier existant.
pub fn pick_log_dir(candidates: &[PathBuf]) -> Option<PathBuf> {
    candidates
        .iter()
        .find(|p| p.is_dir() && has_sessions(p))
        .or_else(|| candidates.iter().find(|p| p.is_dir()))
        .cloned()
}

#[cfg(windows)]
fn sources() -> (Vec<PathBuf>, Vec<PathBuf>, Vec<char>) {
    use winreg::enums::{HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE};
    use winreg::RegKey;

    // Launcher BSG, puis Steam (App 3932890).
    const UNINSTALL: [&str; 4] = [
        r"SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\EscapeFromTarkov",
        r"SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\EscapeFromTarkov",
        r"SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\Steam App 3932890",
        r"SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\Steam App 3932890",
    ];
    const STEAM: [&str; 2] = [r"SOFTWARE\Valve\Steam", r"SOFTWARE\WOW6432Node\Valve\Steam"];

    let mut installs = Vec::new();
    let mut steam = Vec::new();
    for hive in [HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE] {
        let root = RegKey::predef(hive);
        for key in UNINSTALL {
            if let Ok(k) = root.open_subkey(key) {
                if let Ok(loc) = k.get_value::<String, _>("InstallLocation") {
                    if !loc.trim().is_empty() {
                        installs.push(PathBuf::from(loc));
                    }
                }
            }
        }
        for key in STEAM {
            if let Ok(k) = root.open_subkey(key) {
                for name in ["SteamPath", "InstallPath"] {
                    if let Ok(p) = k.get_value::<String, _>(name) {
                        if !p.trim().is_empty() {
                            steam.push(PathBuf::from(p));
                        }
                    }
                }
            }
        }
    }
    let drives: Vec<char> = ('C'..='Z').filter(|d| Path::new(&format!("{d}:\\")).exists()).collect();
    (installs, steam, drives)
}

#[cfg(not(windows))]
fn sources() -> (Vec<PathBuf>, Vec<PathBuf>, Vec<char>) {
    (vec![], vec![], vec![])
}

/// Tous les emplacements essayés (pour le diagnostic).
pub fn log_dir_candidates() -> Vec<PathBuf> {
    let (installs, steam, drives) = sources();
    candidate_log_dirs(&installs, &steam, &drives)
}

/// Dossier `Logs` du jeu, `None` si introuvable : l'utilisateur peut alors le renseigner à la main.
pub fn detect_logs_dir() -> Option<PathBuf> {
    pick_log_dir(&log_dir_candidates())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("tarkov-paths-{}-{}", name, std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn vdf_bibliotheques() {
        let vdf = "\"libraryfolders\"\n{\n\t\"0\"\n\t{\n\t\t\"path\"\t\t\"C:\\\\Program Files (x86)\\\\Steam\"\n\t\t\"label\"\t\t\"\"\n\t}\n\t\"1\"\n\t{\n\t\t\"path\"\t\t\"D:\\\\SteamLibrary\"\n\t}\n}\n";
        let p = parse_library_paths(vdf);
        assert_eq!(p, vec![PathBuf::from("C:\\Program Files (x86)\\Steam"), PathBuf::from("D:\\SteamLibrary")]);
    }

    #[test]
    fn logs_dans_logs_ou_build_logs() {
        let [a, b] = logs_under(Path::new("X"));
        assert_eq!(a, Path::new("X").join("Logs"));
        assert_eq!(b, Path::new("X").join("build").join("Logs"));
    }

    #[test]
    fn candidats_launcher_et_lecteurs() {
        let c = candidate_log_dirs(&[PathBuf::from("E:\\Jeux\\EFT")], &[], &['C', 'D']);
        assert_eq!(c[0], Path::new("E:\\Jeux\\EFT").join("Logs"));
        assert!(c.contains(&PathBuf::from("C:\\Battlestate Games\\EFT").join("Logs")));
        assert!(c.contains(&PathBuf::from("D:\\Games\\Battlestate Games\\EFT").join("build").join("Logs")));
        // pas de doublons
        let n = c.len();
        let mut u = c.clone();
        u.dedup();
        assert_eq!(u.len(), n);
    }

    #[test]
    fn installation_steam_dans_une_autre_bibliotheque() {
        let root = tmp("steam");
        let steam = root.join("Steam");
        let lib2 = root.join("SteamLibrary");
        std::fs::create_dir_all(steam.join("steamapps")).unwrap();
        let game = lib2.join("steamapps").join("common").join("Escape from Tarkov");
        std::fs::create_dir_all(game.join("build").join("Logs").join("log_2026.10.04_10-00-00_1.0")).unwrap();
        std::fs::create_dir_all(lib2.join("steamapps").join("common").join("Autre Jeu")).unwrap();
        let vdf = format!("\"libraryfolders\"\n{{\n \"1\"\n {{\n  \"path\"  \"{}\"\n }}\n}}\n", lib2.to_string_lossy().replace('\\', "\\\\"));
        std::fs::write(steam.join("steamapps").join("libraryfolders.vdf"), vdf).unwrap();

        let c = candidate_log_dirs(&[], &[steam], &[]);
        assert!(c.contains(&game.join("build").join("Logs")), "candidats : {c:?}");
        assert_eq!(pick_log_dir(&c), Some(game.join("build").join("Logs")));
    }

    #[test]
    fn prefere_le_dossier_qui_contient_des_sessions() {
        let root = tmp("pick");
        let vide = root.join("a").join("Logs");
        let plein = root.join("b").join("Logs");
        std::fs::create_dir_all(&vide).unwrap();
        std::fs::create_dir_all(plein.join("log_2026.01.01_00-00-00_1")).unwrap();
        assert_eq!(pick_log_dir(&[vide.clone(), plein.clone()]), Some(plein));
        assert_eq!(pick_log_dir(&[vide.clone()]), Some(vide));
        assert_eq!(pick_log_dir(&[root.join("inexistant")]), None);
    }
}
