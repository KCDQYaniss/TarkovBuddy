#!/usr/bin/env python3
"""Prépare les cartes pour l'app.

- télécharge maps.json (calibration) depuis the-hideout/tarkov-dev (MIT)
- télécharge les SVG depuis the-hideout/tarkov-dev-svg-maps (CC BY-NC-SA 4.0)
- retire les étages secondaires de chaque SVG (sinon ils s'empilent à l'écran)
- écrit ui/maps.json (compact) et ui/maps/<slug>.svg

Usage : python3 tools/prepare_maps.py
"""
import json, re, sys, urllib.request
import xml.etree.ElementTree as ET
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "ui"
RAW_DEV = "https://raw.githubusercontent.com/the-hideout/tarkov-dev/main/src/data/maps.json"
RAW_SVG = "https://raw.githubusercontent.com/the-hideout/tarkov-dev-svg-maps/main/"

NAMES = {
    "customs": "Customs", "factory": "Factory", "woods": "Woods", "shoreline": "Shoreline",
    "interchange": "Interchange", "reserve": "Reserve", "lighthouse": "Lighthouse",
    "streets-of-tarkov": "Streets of Tarkov", "ground-zero": "Ground Zero",
    "terminal": "Terminal", "the-lab": "The Lab", "the-labyrinth": "The Labyrinth",
    "icebreaker": "Icebreaker",
}

def get(url: str) -> bytes:
    with urllib.request.urlopen(url, timeout=60) as r:
        return r.read()

def strip_floors(svg_bytes: bytes, base: str, other_layers: set) -> str:
    ET.register_namespace("", "http://www.w3.org/2000/svg")
    ET.register_namespace("xlink", "http://www.w3.org/1999/xlink")
    root = ET.fromstring(svg_bytes)
    for child in list(root):
        cid = child.get("id")
        if cid in other_layers and cid != base:
            root.remove(child)
    return ET.tostring(root, encoding="unicode")

def main():
    groups = json.loads(get(RAW_DEV))
    out, report = [], []
    (OUT / "maps").mkdir(parents=True, exist_ok=True)
    for g in groups:
        slug = g["normalizedName"]
        if slug not in NAMES:
            continue
        m = next((x for x in g["maps"] if x.get("projection") == "interactive"), None)
        if not m:
            continue
        entry = {
            "slug": slug, "name": NAMES[slug],
            "transform": m["transform"], "rotation": m.get("coordinateRotation", 0),
            "bounds": m["bounds"], "svgBounds": m.get("svgBounds"),
            "minZoom": m.get("minZoom", 1), "maxZoom": m.get("maxZoom", 6),
        }
        svg_path = m.get("svgPath", "")
        if svg_path.endswith(".svg"):
            fname = svg_path.rsplit("/", 1)[1]
            base = m.get("svgLayer")
            others = {l.get("svgLayer") for l in m.get("layers", []) if l.get("svgLayer")}
            try:
                svg = strip_floors(get(RAW_SVG + fname), base, others)
                (OUT / "maps" / f"{slug}.svg").write_text(svg, encoding="utf-8")
                entry["image"] = f"maps/{slug}.svg"
                report.append(f"{slug}: svg ok ({len(svg)//1024} Ko, base={base}, étages retirés={sorted(others - {base})})")
            except Exception as e:
                report.append(f"{slug}: ÉCHEC svg ({e})")
        else:
            # Cartes en tuiles PNG (Icebreaker, Lab, Labyrinth) : pas de SVG, tuiles distantes.
            tiles = m.get("tilePath", "")
            if not tiles:
                report.append(f"{slug}: IGNORÉE (ni SVG ni tuiles)")
                continue
            entry["tiles"] = tiles
            entry["tileSize"] = m.get("tileSize", 256)
            report.append(f"{slug}: tuiles distantes ({tiles})")
        out.append(entry)
    (OUT / "maps.json").write_text(json.dumps(out, separators=(",", ":")), encoding="utf-8")
    print("\n".join(report))

if __name__ == "__main__":
    sys.exit(main())
