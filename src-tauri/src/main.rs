#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod data;
mod priority;

use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::sync::Mutex;
use tarkov_core::{self as core, paths, Config, Event, MapInfo, Position};
use tauri::{AppHandle, Emitter, Manager, State};

#[derive(Serialize, Deserialize, Clone, Default)]
struct Settings {
    screenshots_dir: Option<String>,
    logs_dir: Option<String>,
    #[serde(default)]
    delete_screenshots: bool,
}

#[derive(Default)]
struct AppState {
    settings: Mutex<Settings>,
    watchers: Mutex<Option<core::Handle>>,
    map: Mutex<Option<MapInfo>>,
    position: Mutex<Option<Position>>,
    warnings: Mutex<Vec<String>>,
}

/// Ce que l'interface reçoit au démarrage et après chaque changement de réglages.
#[derive(Serialize)]
struct StateDto {
    screenshots_dir: String,
    logs_dir: Option<String>,
    delete_screenshots: bool,
    map: Option<MapInfo>,
    position: Option<Position>,
    warnings: Vec<String>,
}

fn effective_config(s: &Settings) -> Config {
    let screenshots_dir = s
        .screenshots_dir
        .as_deref()
        .filter(|p| !p.trim().is_empty())
        .map(PathBuf::from)
        .or_else(paths::default_screenshots_dir)
        .unwrap_or_default();
    let logs_dir = s
        .logs_dir
        .as_deref()
        .filter(|p| !p.trim().is_empty())
        .map(PathBuf::from)
        .or_else(paths::detect_logs_dir);
    Config { screenshots_dir, logs_dir, delete_screenshots: s.delete_screenshots }
}

fn dispatch(app: &AppHandle, ev: Event) {
    let st = app.state::<AppState>();
    match ev {
        Event::Position(p) => {
            *st.position.lock().unwrap() = Some(p.clone());
            let _ = app.emit("position", &p);
        }
        Event::Map(m) => {
            *st.map.lock().unwrap() = Some(m.clone());
            let _ = app.emit("map", &m);
        }
        Event::Task(t) => {
            let _ = app.emit("task", &t);
        }
        Event::Warning(w) => {
            st.warnings.lock().unwrap().push(w.clone());
            let _ = app.emit("warning", &w);
        }
    }
}

fn start_watchers(app: &AppHandle) {
    let st = app.state::<AppState>();
    // On arrête les anciens watchers AVANT d'en démarrer de nouveaux.
    st.watchers.lock().unwrap().take();
    st.warnings.lock().unwrap().clear();
    let cfg = effective_config(&st.settings.lock().unwrap());
    let a = app.clone();
    let handle = core::start(cfg, move |ev| dispatch(&a, ev));
    *st.watchers.lock().unwrap() = Some(handle);
}

fn snapshot(st: &AppState) -> StateDto {
    let cfg = effective_config(&st.settings.lock().unwrap());
    StateDto {
        screenshots_dir: cfg.screenshots_dir.display().to_string(),
        logs_dir: cfg.logs_dir.map(|p| p.display().to_string()),
        delete_screenshots: cfg.delete_screenshots,
        map: st.map.lock().unwrap().clone(),
        position: st.position.lock().unwrap().clone(),
        warnings: st.warnings.lock().unwrap().clone(),
    }
}

fn settings_file(app: &AppHandle) -> Option<PathBuf> {
    app.path().app_config_dir().ok().map(|d| d.join("settings.json"))
}

/// Explique pourquoi la map ou les quêtes ne sont pas détectées (réglages manuels uniquement : la
/// détection automatique est relancée à l'intérieur).
#[tauri::command]
fn diagnose(state: State<AppState>) -> core::diag::Diagnostics {
    let s = state.settings.lock().unwrap().clone();
    let cfg = effective_config(&s);
    let manual = s.logs_dir.as_deref().filter(|p| !p.trim().is_empty()).map(PathBuf::from);
    core::diag::diagnose(manual.as_deref(), &cfg.screenshots_dir)
}

/// Relit tous les logs de notifications et renvoie l'historique des quêtes (resynchronisation manuelle).
#[tauri::command]
async fn rescan_quests(state: State<'_, AppState>) -> Result<core::logs::ScanReport, String> {
    let cfg = effective_config(&state.settings.lock().unwrap());
    let dir = cfg.logs_dir.ok_or("Dossier des logs introuvable : renseigne-le dans Réglages.")?;
    tauri::async_runtime::spawn_blocking(move || core::logs::scan_task_history_report(&dir)).await.map_err(|e| e.to_string())
}

#[tauri::command]
fn get_state(state: State<AppState>) -> StateDto {
    snapshot(&state)
}

#[tauri::command]
fn apply_settings(app: AppHandle, state: State<AppState>, settings: Settings) -> Result<StateDto, String> {
    if let Some(file) = settings_file(&app) {
        if let Some(dir) = file.parent() {
            std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
        }
        let json = serde_json::to_string_pretty(&settings).map_err(|e| e.to_string())?;
        std::fs::write(file, json).map_err(|e| e.to_string())?;
    }
    *state.settings.lock().unwrap() = settings;
    start_watchers(&app);
    Ok(snapshot(&state))
}

fn main() {
    priority::lower();

    tauri::Builder::default()
        .manage(AppState::default())
        .setup(|app| {
            let handle = app.handle().clone();
            if let Some(file) = settings_file(&handle) {
                if let Ok(txt) = std::fs::read_to_string(file) {
                    if let Ok(s) = serde_json::from_str::<Settings>(&txt) {
                        *handle.state::<AppState>().settings.lock().unwrap() = s;
                    }
                }
            }
            start_watchers(&handle);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_state,
            diagnose,
            rescan_quests,
            apply_settings,
            data::load_cache,
            data::refresh_data,
            data::load_progress,
            data::save_progress
        ])
        .run(tauri::generate_context!())
        .expect("erreur au lancement de Tarkov Tracker");
}
