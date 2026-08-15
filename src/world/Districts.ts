/**
 * Named districts. Each one biases building height and facade palette, so the
 * skyline reads as a city with neighbourhoods rather than uniform noise.
 */
export interface District {
  readonly id: string;
  readonly name: string;
  /** Multiplier applied to the block's base height. */
  readonly heightScale: number;
  /** Facade variants this district prefers. */
  readonly variants: readonly number[];
  /** Chance a block is left open as a plaza. */
  readonly plazaChance: number;
  /** Trees per open block. */
  readonly treeDensity: number;
  readonly tint: string;
}

export const DISTRICTS: Record<string, District> = {
  financial: {
    id: 'financial',
    name: 'FINANCIAL DISTRICT',
    heightScale: 1.25,
    variants: [2, 0],
    plazaChance: 0.04,
    treeDensity: 2,
    tint: '#8fd0ff',
  },
  midtown: {
    id: 'midtown',
    name: 'MIDTOWN',
    heightScale: 1.0,
    variants: [0, 2, 3],
    plazaChance: 0.06,
    treeDensity: 3,
    tint: '#ffd9a0',
  },
  heights: {
    id: 'heights',
    name: 'THE HEIGHTS',
    heightScale: 0.62,
    variants: [1, 3],
    plazaChance: 0.12,
    treeDensity: 6,
    tint: '#ffbe63',
  },
  harbor: {
    id: 'harbor',
    name: 'HARBOR',
    heightScale: 0.5,
    variants: [3, 1],
    plazaChance: 0.18,
    treeDensity: 4,
    tint: '#9aa8c0',
  },
  park: {
    id: 'park',
    name: 'GREENWOOD PARK',
    heightScale: 0,
    variants: [1],
    plazaChance: 1,
    treeDensity: 26,
    tint: '#52fa7c',
  },
};

/** Park occupies a fixed rectangle of blocks, in grid coordinates. */
const PARK = { x0: 12, x1: 16, z0: 4, z1: 9 };

/**
 * Chooses a district for a block. `gx`/`gz` are grid indices, `half` is the
 * grid's centre index.
 */
export function districtForBlock(gx: number, gz: number, grid: number): District {
  if (gx >= PARK.x0 && gx <= PARK.x1 && gz >= PARK.z0 && gz <= PARK.z1) {
    return DISTRICTS.park!;
  }

  const half = (grid - 1) / 2;
  const dist = Math.hypot(gx - half, gz - half);

  if (dist < grid * 0.17) return DISTRICTS.financial!;
  if (dist < grid * 0.34) return DISTRICTS.midtown!;

  // The outer band splits into harbour on the map edges, heights otherwise.
  const edge = Math.min(gx, gz, grid - 1 - gx, grid - 1 - gz);
  return edge <= 2 ? DISTRICTS.harbor! : DISTRICTS.heights!;
}

/**
 * Real New York neighbourhoods, for the HUD readout on an imported map.
 *
 * The procedural district system describes the procedural layout and says
 * nothing about imported footprints, so an imported city used to read as one
 * flat label. Nearest-neighbour against real coordinates costs nothing and
 * covers every preset the importer can fetch — re-import Queens, Midtown or
 * Lower Manhattan and the readout follows.
 */
export interface Place {
  readonly name: string;
  readonly lat: number;
  readonly lon: number;
}

export const NYC_PLACES: readonly Place[] = [
  // Queens — western, which is what the `queens` preset covers.
  { name: 'LONG ISLAND CITY', lat: 40.7447, lon: -73.9485 },
  { name: 'HUNTERS POINT', lat: 40.7415, lon: -73.9585 },
  { name: 'QUEENSBRIDGE', lat: 40.7556, lon: -73.9452 },
  { name: 'DUTCH KILLS', lat: 40.7482, lon: -73.9382 },
  { name: 'RAVENSWOOD', lat: 40.7602, lon: -73.9374 },
  { name: 'ASTORIA', lat: 40.7644, lon: -73.9235 },
  { name: 'STEINWAY', lat: 40.7742, lon: -73.9043 },
  { name: 'SUNNYSIDE', lat: 40.7433, lon: -73.9196 },
  { name: 'WOODSIDE', lat: 40.7457, lon: -73.9057 },
  { name: 'BLISSVILLE', lat: 40.7351, lon: -73.9332 },
  { name: 'MASPETH', lat: 40.7255, lon: -73.9110 },
  { name: 'JACKSON HEIGHTS', lat: 40.7557, lon: -73.8831 },
  { name: 'ELMHURST', lat: 40.7370, lon: -73.8800 },
  { name: 'CORONA', lat: 40.7498, lon: -73.8600 },
  { name: 'FLUSHING', lat: 40.7674, lon: -73.8330 },
  // Manhattan, so the older presets still read correctly.
  { name: 'MIDTOWN', lat: 40.7549, lon: -73.9840 },
  { name: 'HELLS KITCHEN', lat: 40.7638, lon: -73.9918 },
  { name: 'MURRAY HILL', lat: 40.7478, lon: -73.9756 },
  { name: 'CHELSEA', lat: 40.7465, lon: -74.0014 },
  { name: 'UPPER EAST SIDE', lat: 40.7736, lon: -73.9566 },
  { name: 'UPPER WEST SIDE', lat: 40.7870, lon: -73.9754 },
  { name: 'FINANCIAL DISTRICT', lat: 40.7075, lon: -74.0113 },
  { name: 'TRIBECA', lat: 40.7163, lon: -74.0086 },
  { name: 'SOHO', lat: 40.7233, lon: -74.0030 },
  { name: 'EAST VILLAGE', lat: 40.7265, lon: -73.9815 },
  { name: 'ROOSEVELT ISLAND', lat: 40.7610, lon: -73.9500 },
];

/** Nearest named place to a latitude/longitude. */
export function nearestPlace(lat: number, lon: number): Place {
  let best = NYC_PLACES[0]!;
  let bestScore = Infinity;
  // Longitude degrees are shorter than latitude ones at this latitude; the
  // 0.76 factor is cos(40.75 degrees), which keeps the comparison in roughly
  // equal metres on both axes.
  for (const place of NYC_PLACES) {
    const dLat = lat - place.lat;
    const dLon = (lon - place.lon) * 0.76;
    const score = dLat * dLat + dLon * dLon;
    if (score < bestScore) {
      bestScore = score;
      best = place;
    }
  }
  return best;
}

/** District at a world position, for the HUD readout. */
export function districtAtWorld(x: number, z: number, grid: number, pitch: number): District {
  const half = (grid - 1) / 2;
  const gx = Math.round(x / pitch + half);
  const gz = Math.round(z / pitch + half);
  const cx = Math.max(0, Math.min(grid - 1, gx));
  const cz = Math.max(0, Math.min(grid - 1, gz));
  return districtForBlock(cx, cz, grid);
}
