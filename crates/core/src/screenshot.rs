use serde::Serialize;

/// Position et orientation du joueur extraites du nom d'un screenshot.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Position {
    /// Coordonnées jeu (Unity) : x, y (hauteur), z.
    pub x: f64,
    pub y: f64,
    pub z: f64,
    /// Direction du regard à plat, dans le repère jeu (composantes x et z).
    pub fx: f64,
    pub fz: f64,
    /// Cap en degrés, 0 = +Z jeu, positif vers +X jeu.
    pub yaw_deg: f64,
    /// Nom du fichier d'origine.
    pub file: String,
}

/// Parse un nom de screenshot Tarkov.
///
/// Forme attendue (à confirmer sur une vraie capture, voir README) :
/// `2024-01-15[21-04]_x, y, z_qx, qy, qz, qw_vitesse (0).png`
///
/// Le parseur est volontairement tolérant : il ignore la date, découpe le reste
/// sur `_` et `,`, puis lit les 7 premiers nombres (x y z qx qy qz qw).
pub fn parse_screenshot_name(name: &str) -> Option<Position> {
    let lower = name.to_ascii_lowercase();
    if !lower.ends_with(".png") {
        return None;
    }
    let stem = &name[..name.len() - 4];

    // Après "[HH-MM]" : on saute la date.
    let rest = &stem[stem.find(']')? + 1..];

    // Retire le suffixe " (n)" ajouté par le jeu.
    let rest = match rest.rfind(" (") {
        Some(i) if rest.ends_with(')') => &rest[..i],
        _ => rest,
    };

    let nums: Vec<f64> = rest
        .split(|c| c == '_' || c == ',')
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .filter_map(|s| s.parse::<f64>().ok())
        .collect();

    if nums.len() < 7 {
        return None;
    }
    let (x, y, z) = (nums[0], nums[1], nums[2]);
    let (qx, qy, qz, qw) = (nums[3], nums[4], nums[5], nums[6]);
    if ![x, y, z, qx, qy, qz, qw].iter().all(|v| v.is_finite()) {
        return None;
    }

    // Vecteur "avant" (0,0,1) tourné par le quaternion (convention Unity).
    let fx = 2.0 * (qx * qz + qw * qy);
    let fz = 1.0 - 2.0 * (qx * qx + qy * qy);
    let norm = (fx * fx + fz * fz).sqrt();
    let (fx, fz) = if norm > 1e-6 { (fx / norm, fz / norm) } else { (0.0, 1.0) };
    let yaw_deg = fx.atan2(fz).to_degrees();

    Some(Position { x, y, z, fx, fz, yaw_deg, file: name.to_string() })
}

#[cfg(test)]
mod tests {
    use super::*;

    // Noms synthétiques construits d'après le format décrit ; à remplacer par
    // de vrais noms de fichiers dès qu'on en a un sous la main.
    #[test]
    fn parse_nom_complet() {
        let p = parse_screenshot_name(
            "2024-01-15[21-04]_-141.45, 23.33, 57.23_0.0, 0.70711, 0.0, 0.70711_8.4 (0).png",
        )
        .unwrap();
        assert_eq!((p.x, p.y, p.z), (-141.45, 23.33, 57.23));
        // Rotation de 90° autour de Y => regard vers +X.
        assert!((p.yaw_deg - 90.0).abs() < 0.01, "yaw = {}", p.yaw_deg);
        assert!((p.fx - 1.0).abs() < 1e-3 && p.fz.abs() < 1e-3);
    }

    #[test]
    fn regard_vers_z_positif() {
        let p = parse_screenshot_name("2024-01-15[21-04]_1.00, 2.00, 3.00_0, 0, 0, 1_0.0 (0).png").unwrap();
        assert!(p.yaw_deg.abs() < 1e-6);
        assert!((p.fz - 1.0).abs() < 1e-9);
    }

    #[test]
    fn sans_underscore_entre_z_et_rotation() {
        // TarkovMonitor tolère un `_` optionnel à cet endroit ; nous aussi.
        let p = parse_screenshot_name("2024-01-15[21-04]_1.00, 2.00, 3.00, 0, 0, 0, 1 (0).png").unwrap();
        assert_eq!((p.x, p.y, p.z), (1.0, 2.0, 3.0));
    }

    #[test]
    fn rejette_les_autres_fichiers() {
        assert!(parse_screenshot_name("capture.png").is_none());
        assert!(parse_screenshot_name("2024-01-15[21-04]_1, 2, 3 (0).png").is_none());
        assert!(parse_screenshot_name("2024-01-15[21-04]_1.00, 2.00, 3.00_0, 0, 0, 1_0.0 (0).jpg").is_none());
        assert!(parse_screenshot_name("").is_none());
    }

    #[test]
    fn extension_majuscule() {
        assert!(parse_screenshot_name("2024-01-15[21-04]_1.00, 2.00, 3.00_0, 0, 0, 1_0.0 (0).PNG").is_some());
    }
}
