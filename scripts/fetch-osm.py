"""Download real building footprints from OpenStreetMap and convert them into
the compact format the game loads.

OpenStreetMap data is open-licensed (ODbL), unlike Google Maps, so it can
legitimately ship inside a project. Attribution is required -- see the note
printed at the end and the `attribution` field in the output.

Usage:
    python scripts/fetch-osm.py                 # Midtown Manhattan default
    python scripts/fetch-osm.py --preset lower  # Lower Manhattan
    python scripts/fetch-osm.py --bbox S,W,N,E  # any custom box

Writes public/city/osm-city.json.
"""
from __future__ import annotations

import argparse
import json
import math
import os
import sys
import urllib.error
import urllib.parse
import urllib.request

OVERPASS_ENDPOINTS = [
    "https://overpass-api.de/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter",
]

# south, west, north, east
PRESETS = {
    "midtown": (40.7440, -73.9950, 40.7660, -73.9700),
    "lower": (40.7020, -74.0180, 40.7250, -73.9950),
    "central": (40.7640, -73.9820, 40.7860, -73.9560),
    # Queens: Long Island City, Astoria, Sunnyside, Woodside and the western
    # edge of Jackson Heights. About 5.6 x 4.9 km -- roughly five times the
    # area of the Midtown box, with LIC's towers on the waterfront and a long
    # low-rise sprawl behind them.
    "queens": (40.7280, -73.9640, 40.7720, -73.8980),
    # The whole of western Queens plus Flushing, for a genuinely huge map.
    "queens-wide": (40.7150, -73.9660, 40.7820, -73.8150),
}

# Fallback storey height when a building only reports levels, in metres.
METRES_PER_LEVEL = 3.6
DEFAULT_HEIGHT = 12.0


def build_query(bbox: tuple[float, float, float, float]) -> str:
    s, w, n, e = bbox
    return (
        f"[out:json][timeout:180];"
        f'way["building"]({s},{w},{n},{e});'
        f"out geom;"
    )


def fetch(bbox: tuple[float, float, float, float]) -> dict:
    payload = urllib.parse.urlencode({"data": build_query(bbox)}).encode()
    last_error: Exception | None = None

    for endpoint in OVERPASS_ENDPOINTS:
        print(f"  querying {endpoint} ...")
        request = urllib.request.Request(
            endpoint,
            data=payload,
            headers={
                # Overpass rejects requests without a descriptive agent.
                "User-Agent": "web-swinger-city-importer/1.0 (OSM building import)",
                "Content-Type": "application/x-www-form-urlencoded",
            },
        )
        try:
            with urllib.request.urlopen(request, timeout=300) as response:
                return json.load(response)
        except Exception as error:  # noqa: BLE001 - report and try the mirror
            last_error = error
            print(f"    failed: {error}")

    raise SystemExit(f"All Overpass endpoints failed. Last error: {last_error}")


def parse_height(tags: dict) -> float:
    """Metres, from an explicit height or a storey count."""
    raw = tags.get("height")
    if raw:
        try:
            return max(4.0, float(str(raw).replace("m", "").strip()))
        except ValueError:
            pass

    levels = tags.get("building:levels")
    if levels:
        try:
            return max(4.0, float(str(levels).strip()) * METRES_PER_LEVEL)
        except ValueError:
            pass

    return DEFAULT_HEIGHT


def budget(buildings: list[dict], limit: int) -> list[dict]:
    """Trim a footprint list to `limit` entries without gutting the streets.

    Sorting by height and keeping the top N produces a skyline of towers
    floating over empty ground, because every house gets deleted. So the
    landmarks are kept unconditionally and the remainder is thinned by an even
    stride -- the streets stay built up, just less densely.
    """
    if limit <= 0 or len(buildings) <= limit:
        return buildings

    def prominence(b: dict) -> float:
        return b["h"] * 2.0 + (b["w"] * b["d"]) ** 0.5

    ranked = sorted(buildings, key=prominence, reverse=True)
    landmarks = ranked[: limit // 2]
    rest = ranked[limit // 2 :]

    remaining = limit - len(landmarks)
    if remaining <= 0 or not rest:
        return landmarks
    stride = max(1, len(rest) // remaining)
    return landmarks + rest[::stride][:remaining]


def convert(
    data: dict,
    bbox: tuple[float, float, float, float],
    min_size: float = 4.0,
    limit: int = 0,
) -> dict:
    s, w, n, e = bbox
    lat0 = (s + n) / 2
    lon0 = (w + e) / 2

    # Equirectangular projection about the centre. Over a few kilometres the
    # distortion is far below the size of a building, and it keeps the output
    # in plain metres with no projection library needed.
    metres_per_deg_lat = 111_320.0
    metres_per_deg_lon = 111_320.0 * math.cos(math.radians(lat0))

    buildings = []
    skipped = 0

    for element in data.get("elements", []):
        geometry = element.get("geometry")
        if not geometry or len(geometry) < 3:
            skipped += 1
            continue

        xs = [(p["lon"] - lon0) * metres_per_deg_lon for p in geometry]
        zs = [(p["lat"] - lat0) * metres_per_deg_lat for p in geometry]

        min_x, max_x = min(xs), max(xs)
        min_z, max_z = min(zs), max(zs)
        width = max_x - min_x
        depth = max_z - min_z

        # The game collides against axis-aligned boxes, so each footprint
        # becomes its bounding box. Discard slivers and anything implausible.
        if width < min_size or depth < min_size or width > 400 or depth > 400:
            skipped += 1
            continue

        buildings.append(
            {
                "x": round((min_x + max_x) / 2, 2),
                "z": round((min_z + max_z) / 2, 2),
                "w": round(width, 2),
                "d": round(depth, 2),
                "h": round(parse_height(element.get("tags", {})), 1),
            }
        )

    kept = budget(buildings, limit)
    skipped += len(buildings) - len(kept)

    return {
        "attribution": "Building data (c) OpenStreetMap contributors, ODbL 1.0",
        "source": "https://www.openstreetmap.org/copyright",
        "origin": {"lat": lat0, "lon": lon0},
        "bbox": {"south": s, "west": w, "north": n, "east": e},
        "count": len(kept),
        "buildings": kept,
    }, skipped


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--preset", choices=sorted(PRESETS), default="midtown")
    parser.add_argument("--bbox", help="south,west,north,east")
    parser.add_argument("--out", default=os.path.join("public", "city", "osm-city.json"))
    parser.add_argument(
        "--min-size",
        type=float,
        default=4.0,
        help="discard footprints narrower than this, in metres (default 4)",
    )
    parser.add_argument(
        "--max-buildings",
        type=int,
        default=0,
        help="cap the output, keeping landmarks and thinning the rest (0 = no cap)",
    )
    args = parser.parse_args()

    if args.bbox:
        parts = [float(v) for v in args.bbox.split(",")]
        if len(parts) != 4:
            raise SystemExit("--bbox needs south,west,north,east")
        bbox = (parts[0], parts[1], parts[2], parts[3])
    else:
        bbox = PRESETS[args.preset]

    print(f"Fetching OSM buildings for bbox {bbox} ...")
    data = fetch(bbox)
    converted, skipped = convert(data, bbox, args.min_size, args.max_buildings)

    os.makedirs(os.path.dirname(args.out), exist_ok=True)
    with open(args.out, "w", encoding="utf-8") as handle:
        json.dump(converted, handle, separators=(",", ":"))

    size_kb = os.path.getsize(args.out) / 1024
    print(f"\nWrote {args.out}")
    print(f"  buildings: {converted['count']}  (skipped {skipped})")
    print(f"  size: {size_kb:.0f} KB")
    print("\nAttribution is required when you ship this:")
    print("  " + converted["attribution"])
    return 0


if __name__ == "__main__":
    sys.exit(main())
