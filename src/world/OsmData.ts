/**
 * Real building footprints imported from OpenStreetMap.
 *
 * OSM data is open-licensed (ODbL), which is why this is possible at all —
 * Google Maps data is proprietary and cannot be redistributed in a project.
 * Attribution is mandatory and is surfaced on the boot overlay.
 *
 * Generate the file with:  python scripts/fetch-osm.py
 */

export interface OsmBuilding {
  /** Centre, in metres east of the import origin. */
  x: number;
  /** Centre, in metres north of the import origin. */
  z: number;
  /** Bounding-box footprint, metres. */
  w: number;
  d: number;
  /** Height in metres, from `height` or `building:levels`. */
  h: number;
}

export interface OsmCityData {
  attribution: string;
  source: string;
  origin: { lat: number; lon: number };
  bbox: { south: number; west: number; north: number; east: number };
  count: number;
  buildings: OsmBuilding[];
}

/**
 * Loads the imported city, or null if it hasn't been generated. Absence is the
 * normal case — the game falls back to the procedural skyline.
 */
export async function loadOsmCity(url: string): Promise<OsmCityData | null> {
  try {
    const response = await fetch(url);
    if (!response.ok) return null;

    const data = (await response.json()) as Partial<OsmCityData>;
    if (!Array.isArray(data.buildings) || data.buildings.length === 0) return null;

    // Guard against a truncated or hand-edited file.
    const buildings = data.buildings.filter(
      (b) =>
        Number.isFinite(b.x) &&
        Number.isFinite(b.z) &&
        Number.isFinite(b.h) &&
        b.w > 1 &&
        b.d > 1 &&
        b.h > 1,
    );
    if (buildings.length === 0) return null;

    console.info(
      `[web-swinger] Loaded ${buildings.length} OpenStreetMap buildings. ${data.attribution ?? ''}`,
    );

    return {
      attribution: data.attribution ?? 'Building data (c) OpenStreetMap contributors, ODbL 1.0',
      source: data.source ?? 'https://www.openstreetmap.org/copyright',
      origin: data.origin ?? { lat: 0, lon: 0 },
      bbox: data.bbox ?? { south: 0, west: 0, north: 0, east: 0 },
      count: buildings.length,
      buildings,
    };
  } catch (error) {
    console.warn('[web-swinger] Could not load OSM city data:', error);
    return null;
  }
}
