/// Convertit l'identifiant de map utilisé par le jeu dans ses logs
/// (`Location: bigmap,`) vers le slug utilisé par tarkov.dev / notre `maps.json`.
///
/// Les identifiants marqués (?) n'ont pas été vérifiés sur de vrais logs.
pub fn slug_from_location(raw: &str) -> Option<&'static str> {
    let s = raw.trim().to_ascii_lowercase();
    Some(match s.as_str() {
        "bigmap" => "customs",
        "factory4_day" | "factory4_night" => "factory",
        "woods" => "woods",
        "shoreline" => "shoreline",
        "interchange" => "interchange",
        "rezervbase" => "reserve",
        "laboratory" => "the-lab",
        "lighthouse" => "lighthouse",
        "tarkovstreets" => "streets-of-tarkov",
        "sandbox" | "sandbox_high" => "ground-zero",
        "labyrinth" => "the-labyrinth", // (?)
        "terminal" => "terminal",       // (?)
        "icebreaker" => "icebreaker",   // (?)
        _ => return None,
    })
}

/// Convertit le nom du bundle de scène (`maps/bigmap_preset.bundle` -> `bigmap_preset`) en slug.
/// Moins sûr que `Location:` : utilisé en secours quand la ligne `NetworkGameCreate` est absente.
pub fn slug_from_scene(stem: &str) -> Option<&'static str> {
    let s = stem.to_ascii_lowercase();
    let s = s.trim_end_matches("_preset");
    const RULES: [(&str, &str); 13] = [
        ("bigmap", "customs"),
        ("factory4", "factory"),
        ("woods", "woods"),
        ("shoreline", "shoreline"),
        ("interchange", "interchange"),
        ("rezerv", "reserve"),
        ("laboratory", "the-lab"),
        ("lighthouse", "lighthouse"),
        ("tarkovstreets", "streets-of-tarkov"),
        ("city", "streets-of-tarkov"),
        ("sandbox", "ground-zero"),
        ("labyrinth", "the-labyrinth"),
        ("terminal", "terminal"),
    ];
    RULES.iter().find(|(p, _)| s.starts_with(p)).map(|(_, slug)| *slug).or_else(|| s.starts_with("icebreaker").then_some("icebreaker"))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn connus() {
        assert_eq!(slug_from_location("bigmap"), Some("customs"));
        assert_eq!(slug_from_location("Sandbox_high"), Some("ground-zero"));
        assert_eq!(slug_from_location(" TarkovStreets "), Some("streets-of-tarkov"));
    }
    #[test]
    fn scenes() {
        assert_eq!(slug_from_scene("bigmap_preset"), Some("customs"));
        assert_eq!(slug_from_scene("Factory4_Day_preset"), Some("factory"));
        assert_eq!(slug_from_scene("rezervbase_preset"), Some("reserve"));
        assert_eq!(slug_from_scene("xyz"), None);
    }
    #[test]
    fn inconnu() {
        assert_eq!(slug_from_location("nimportequoi"), None);
    }
}
