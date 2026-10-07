//! Cœur de l'app : aucune dépendance à Tauri, entièrement testable.
//!
//! Principe : zéro polling. Tout passe par les notifications du système de
//! fichiers, et on ne lit jamais le contenu des screenshots (le nom de fichier
//! contient déjà la position et la rotation du joueur).

pub mod dataset;
pub mod diag;
pub mod logs;
pub mod maps;
pub mod paths;
pub mod screenshot;
pub mod watch;

pub use screenshot::Position;
pub use logs::{TaskEvent, TaskStatus};
pub use watch::{start, Config, Event, Handle, MapInfo};
