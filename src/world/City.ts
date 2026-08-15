import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { CONFIG } from '../core/Config';
import type { Rng } from '../core/MathUtils';
import { clamp, lerp, mulberry32, randRange, smoothstep } from '../core/MathUtils';
import { TextureFactory } from './Textures';
import { districtAtWorld, districtForBlock, nearestPlace, type District } from './Districts';
import type { OsmCityData } from './OsmData';

/** Latitude degrees are a constant length; longitude is scaled by cos(lat). */
const METRES_PER_DEG_LAT = 111_320;

/** Template for an imported district; the name is filled in per neighbourhood. */
const IMPORTED_DISTRICT: District = {
  id: 'imported',
  name: 'NEW YORK',
  heightScale: 1,
  variants: [0],
  plazaChance: 0,
  treeDensity: 0,
  tint: '#8fd0ff',
};

/** Widest span covered by imported footprints, in metres. */
function osmSpan(osm: OsmCityData): number {
  let maxAbs = 0;
  for (const b of osm.buildings) {
    maxAbs = Math.max(maxAbs, Math.abs(b.x) + b.w / 2, Math.abs(b.z) + b.d / 2);
  }
  return maxAbs * 2;
}

export interface Building {
  readonly min: THREE.Vector3;
  readonly max: THREE.Vector3;
  readonly height: number;
  /** Centre of the roof slab — handy for spawning and pathing. */
  readonly roof: THREE.Vector3;
}

export interface RayHit {
  point: THREE.Vector3;
  normal: THREE.Vector3;
  distance: number;
  building: Building;
}

export interface Contact {
  normal: THREE.Vector3;
  depth: number;
}

const TILE_W = CONFIG.city.windowsPerTileX * CONFIG.city.windowSpacingX;
const TILE_H = CONFIG.city.windowsPerTileY * CONFIG.city.floorHeight;

/**
 * Blocks per side of a render chunk. Smaller chunks cull better but multiply
 * draw calls: at a 28-block grid, 4-block chunks give 49 chunks x ~5 material
 * groups each, which is far too many submissions. 7 keeps it near 16 chunks
 * while each is still small enough (~430 m) for the frustum test to matter.
 */
const CHUNK_BLOCKS = 7;

/**
 * The procedural city: geometry, plus the broadphase everything else queries.
 *
 * Geometry is merged **per spatial chunk** rather than globally. One merged
 * mesh for the whole city would have a bounding sphere covering everything, so
 * the frustum test could never reject it and all 400+ towers would be
 * submitted every frame. Chunking restores culling at the cost of a few more
 * draw calls, which is overwhelmingly the better trade.
 *
 * All buildings are axis-aligned boxes, which lets the whole world be collided
 * and raycast against analytically — no BVH, no `THREE.Raycaster`, and no
 * per-frame allocation.
 */
export class City {
  readonly group = new THREE.Group();
  readonly buildings: Building[] = [];

  /** Half the width of the city footprint, in metres. */
  readonly extent: number;
  /** Tallest roof in the city. */
  maxHeight = 0;

  private readonly cellSize: number;
  private readonly cellsPerSide: number;
  /** Render-chunk grid, in metres. See chunkIndexWorld. */
  private readonly chunkSize: number;
  private readonly chunksPerSide: number;
  private readonly cells: number[][];
  private readonly visitStamp: Int32Array;
  /** Reused by roofNear so a spawn query never allocates. */
  private readonly roofScratch: Building[] = [];
  /** randomRoof's height-filtered pools, built once each. */
  private readonly tallPools = new Map<number, Building[]>();
  private stamp = 0;

  private readonly textures: TextureFactory;
  private readonly disposables: Array<{ dispose(): void }> = [];

  // Scratch objects, reused so the hot paths never allocate.
  private readonly tmpA = new THREE.Vector3();

  /** Set when the skyline came from imported OpenStreetMap footprints. */
  readonly attribution: string | null;
  /** Import origin, for projecting world metres back to lat/lon. */
  private readonly osmOrigin: { lat: number; lon: number } | null;
  private readonly placeCache = new Map<string, District>();

  constructor(textures: TextureFactory, osm: OsmCityData | null = null) {
    this.textures = textures;
    this.group.name = 'City';
    this.attribution = osm?.attribution ?? null;
    this.osmOrigin = osm?.origin ?? null;

    // An imported city sizes itself to the data; a procedural one to the grid.
    const span = osm
      ? Math.max(600, osmSpan(osm) + CONFIG.city.blockPitch * 2)
      : CONFIG.city.grid * CONFIG.city.blockPitch;
    this.extent = span / 2;
    // Chunk size in metres, so it is independent of which city this is. The
    // floor keeps the procedural map's chunking exactly as it was; the
    // span-derived term stops a multi-kilometre import from producing hundreds
    // of chunks and hundreds of draw calls.
    this.chunkSize = Math.max(CONFIG.city.blockPitch * CHUNK_BLOCKS, span / 10);
    this.chunksPerSide = Math.max(1, Math.ceil(span / this.chunkSize));
    // Broadphase resolution follows building density. A procedural block is
    // one tower per 62 m, but imported Manhattan packs dozens into that same
    // cell, and every raycast would then test all of them.
    this.cellSize = osm ? 28 : CONFIG.city.blockPitch;
    this.cellsPerSide = Math.ceil(span / this.cellSize) + 2;
    this.cells = Array.from({ length: this.cellsPerSide * this.cellsPerSide }, () => [] as number[]);
    this.visitStamp = new Int32Array(0);

    if (osm) this.generateFromOsm(osm);
    else this.generate();

    // Sized once the building count is known.
    this.visitStamp = new Int32Array(this.buildings.length);
  }

  /**
   * Builds the city from imported OpenStreetMap footprints.
   *
   * Each footprint is already reduced to an axis-aligned box by the importer,
   * which is exactly what the collision and raycast paths expect — so real
   * geometry drops straight into the same pipeline as the procedural skyline.
   */
  private generateFromOsm(osm: OsmCityData): void {
    const rng = mulberry32(CONFIG.city.seed);
    const variantCount = Math.min(CONFIG.city.facadeVariants, this.textures.variantCount);

    const facadeByChunk = new Map<string, THREE.BufferGeometry[]>();
    const roofByChunk = new Map<number, THREE.BufferGeometry[]>();
    const propByChunk = new Map<number, THREE.BufferGeometry[]>();

    const push = <K>(map: Map<K, THREE.BufferGeometry[]>, key: K, geo: THREE.BufferGeometry): void => {
      let list = map.get(key);
      if (!list) {
        list = [];
        map.set(key, list);
      }
      list.push(geo);
    };

    const scale = CONFIG.city.osm;

    for (const b of osm.buildings) {
      const chunk = this.chunkIndexWorld(b.x, b.z);

      // Stretch the surveyed height into something swingable. The jitter on
      // the floor matters: without it every house in the borough lands on
      // exactly `minHeight` and the low-rise becomes one flat slab.
      const floor = scale.minHeight * randRange(rng, 1 - scale.minHeightJitter, 1 + scale.minHeightJitter);
      const h = clamp(Math.max(floor, b.h * scale.heightScale), 8, scale.maxHeight);
      const w = Math.max(scale.minFootprint, b.w * scale.footprintScale);
      const d = Math.max(scale.minFootprint, b.d * scale.footprintScale);

      // Taller buildings lean toward the glassier facade variants.
      const variant = h > 90 ? 2 % variantCount : Math.floor(rng() * variantCount);
      const tint = randRange(rng, 0.85, 1.1);

      push(facadeByChunk, `${chunk}:${variant}`, makeFacadeGeometry(b.x, b.z, w, h, d, tint));
      push(roofByChunk, chunk, makeRoofGeometry(b.x, b.z, w, h, d, tint));
      this.registerBuilding(b.x, b.z, w, h, d);

      // Rooftop clutter only on the larger roofs, to keep the count sane.
      if (w > 18 && d > 18 && rng() < 0.4) {
        const props: THREE.BufferGeometry[] = [];
        addRoofProps(props, rng, b.x, b.z, w, h, d);
        for (const geo of props) push(propByChunk, chunk, geo);
      }
    }

    this.buildChunkedMeshes(
      rng,
      variantCount,
      facadeByChunk,
      roofByChunk,
      propByChunk,
      new Map(),
      new Map(),
    );
    this.buildGround(rng);

    // Trees only ever existed in the procedural generator's park blocks, so
    // moving to a real street layout silently removed every one of them.
    const trunks: THREE.Matrix4[] = [];
    const canopies: THREE.Matrix4[] = [];
    this.scatterStreetTrees(rng, trunks, canopies);
    this.buildTrees(trunks, canopies);
  }

  /**
   * Plants trees along the imported streets.
   *
   * Candidates are gathered over the whole map first and thinned afterwards.
   * Stopping at the cap mid-scan would be far cheaper and completely wrong —
   * the scan runs in raster order, so the budget would be spent entirely on
   * the south-west corner and the rest of the borough would have none.
   */
  private scatterStreetTrees(
    rng: Rng,
    trunks: THREE.Matrix4[],
    canopies: THREE.Matrix4[],
  ): void {
    const cfg = CONFIG.city.osm;
    const jitter = cfg.treePitch * 0.4;
    /** Flat triples of x, z, scale. */
    const sites: number[] = [];

    for (let x = -this.extent; x <= this.extent; x += cfg.treePitch) {
      for (let z = -this.extent; z <= this.extent; z += cfg.treePitch) {
        if (rng() > cfg.treeChance) continue;
        const px = x + randRange(rng, -jitter, jitter);
        const pz = z + randRange(rng, -jitter, jitter);
        // Non-zero ground means we are standing inside a footprint.
        if (this.groundHeightAt(px, pz) > 0.5) continue;
        // Sidewalks, not the middle of a field.
        if (!this.roofNear(rng, px, pz, 0, cfg.treeNearBuilding)) continue;
        sites.push(px, pz, randRange(rng, 0.8, 1.6));
      }
    }

    const total = sites.length / 3;
    const stride = Math.max(1, Math.ceil(total / cfg.maxTrees));

    const position = new THREE.Vector3();
    const quat = new THREE.Quaternion();
    const scale = new THREE.Vector3();

    for (let i = 0; i < total; i += stride) {
      const x = sites[i * 3]!;
      const z = sites[i * 3 + 1]!;
      const s = sites[i * 3 + 2]!;
      quat.setFromAxisAngle(UP, rng() * Math.PI * 2);

      position.set(x, 1.6 * s, z);
      scale.set(s, s, s);
      trunks.push(new THREE.Matrix4().compose(position, quat, scale));

      position.set(x, 4.4 * s, z);
      scale.set(s * randRange(rng, 0.9, 1.2), s * randRange(rng, 0.9, 1.3), s);
      canopies.push(new THREE.Matrix4().compose(position, quat, scale));
    }
  }

  // ---------------------------------------------------------------- queries

  /** District at a world position, for the HUD readout. */
  districtAt(x: number, z: number): District {
    // The procedural district map describes the procedural layout and says
    // nothing about imported footprints — so for an imported city, project
    // back to latitude/longitude and name the real neighbourhood instead.
    if (this.osmOrigin) {
      const lat = this.osmOrigin.lat + z / METRES_PER_DEG_LAT;
      const lon =
        this.osmOrigin.lon +
        x / (METRES_PER_DEG_LAT * Math.cos((this.osmOrigin.lat * Math.PI) / 180));
      const place = nearestPlace(lat, lon);
      // Cached: this runs every frame for the HUD, and a fresh object per
      // frame would be pure garbage.
      let district = this.placeCache.get(place.name);
      if (!district) {
        district = { ...IMPORTED_DISTRICT, id: place.name, name: place.name };
        this.placeCache.set(place.name, district);
      }
      return district;
    }
    return districtAtWorld(x, z, CONFIG.city.grid, CONFIG.city.blockPitch);
  }

  /**
   * Ray vs. city. Returns the nearest facade/roof hit, or null.
   * Candidates are gathered from the broadphase cells the segment overlaps.
   */
  raycast(origin: THREE.Vector3, dir: THREE.Vector3, maxDist: number): RayHit | null {
    const endX = origin.x + dir.x * maxDist;
    const endY = origin.y + dir.y * maxDist;
    const endZ = origin.z + dir.z * maxDist;

    const minX = Math.min(origin.x, endX);
    const maxX = Math.max(origin.x, endX);
    const minZ = Math.min(origin.z, endZ);
    const maxZ = Math.max(origin.z, endZ);

    // A ray entirely above the skyline can't hit anything.
    if (Math.min(origin.y, endY) > this.maxHeight) return null;

    let best: number = maxDist;
    let bestBuilding: Building | null = null;
    let bestAxis = 0;
    let bestSign = 1;

    this.stamp++;
    const c0 = this.cellCoord(minX);
    const c1 = this.cellCoord(maxX);
    const d0 = this.cellCoord(minZ);
    const d1 = this.cellCoord(maxZ);

    for (let cx = c0; cx <= c1; cx++) {
      for (let cz = d0; cz <= d1; cz++) {
        const bucket = this.cells[cx * this.cellsPerSide + cz];
        if (!bucket) continue;
        for (const index of bucket) {
          if (this.visitStamp[index] === this.stamp) continue;
          this.visitStamp[index] = this.stamp;

          const b = this.buildings[index]!;
          const hit = slabIntersect(origin, dir, b.min, b.max, best);
          if (hit) {
            best = hit.t;
            bestBuilding = b;
            bestAxis = hit.axis;
            bestSign = hit.sign;
          }
        }
      }
    }

    if (!bestBuilding) return null;

    const point = new THREE.Vector3(
      origin.x + dir.x * best,
      origin.y + dir.y * best,
      origin.z + dir.z * best,
    );
    const normal = new THREE.Vector3();
    normal.setComponent(bestAxis, bestSign);
    return { point, normal, distance: best, building: bestBuilding };
  }

  /**
   * Height of the first solid surface below (x, z). Cheaper than a full
   * raycast: walks only the one broadphase cell the column sits in.
   */
  groundHeightAt(x: number, z: number): number {
    let best = 0;
    const cx = this.cellCoord(x);
    const cz = this.cellCoord(z);
    const bucket = this.cells[cx * this.cellsPerSide + cz];
    if (!bucket) return 0;

    for (const index of bucket) {
      const b = this.buildings[index]!;
      if (x < b.min.x || x > b.max.x || z < b.min.z || z > b.max.z) continue;
      if (b.max.y > best) best = b.max.y;
    }
    return best;
  }

  /**
   * Sphere vs. city. Appends every overlapping contact to `out` and returns
   * how many were written. `out` is reused by the caller between frames.
   */
  collideSphere(center: THREE.Vector3, radius: number, out: Contact[]): number {
    let count = 0;
    this.stamp++;

    const c0 = this.cellCoord(center.x - radius);
    const c1 = this.cellCoord(center.x + radius);
    const d0 = this.cellCoord(center.z - radius);
    const d1 = this.cellCoord(center.z + radius);

    for (let cx = c0; cx <= c1; cx++) {
      for (let cz = d0; cz <= d1; cz++) {
        const bucket = this.cells[cx * this.cellsPerSide + cz];
        if (!bucket) continue;
        for (const index of bucket) {
          if (this.visitStamp[index] === this.stamp) continue;
          this.visitStamp[index] = this.stamp;

          const b = this.buildings[index]!;
          if (
            center.x + radius < b.min.x ||
            center.x - radius > b.max.x ||
            center.y + radius < b.min.y ||
            center.y - radius > b.max.y ||
            center.z + radius < b.min.z ||
            center.z - radius > b.max.z
          ) {
            continue;
          }

          // Contacts are pooled in `out` and reused across frames.
          let contact = out[count];
          if (!contact) {
            contact = { normal: new THREE.Vector3(), depth: 0 };
            out[count] = contact;
          }
          if (resolveSphereBox(center, radius, b.min, b.max, contact)) count++;
        }
      }
    }
    return count;
  }

  /** True if nothing solid sits between the two points. */
  hasLineOfSight(from: THREE.Vector3, to: THREE.Vector3): boolean {
    const dir = this.tmpA.copy(to).sub(from);
    const dist = dir.length();
    if (dist < 1e-4) return true;
    dir.multiplyScalar(1 / dist);
    return this.raycast(from, dir, dist - 0.5) === null;
  }

  /**
   * A random rooftop, optionally restricted to buildings above `minHeight`.
   *
   * The filtered pool is cached per height: this is called in loops, and on an
   * eleven-thousand-building import each uncached call swept the whole list.
   * Callers that want a rooftop *near* somewhere want `roofNear` instead —
   * this one is uniform over the entire map.
   */
  randomRoof(rng: Rng, minHeight = 0): Building {
    let list = this.tallPools.get(minHeight);
    if (!list) {
      const pool = minHeight > 0 ? this.buildings.filter((b) => b.height >= minHeight) : this.buildings;
      list = pool.length > 0 ? pool : this.buildings;
      this.tallPools.set(minHeight, list);
    }
    return list[Math.min(list.length - 1, Math.floor(rng() * list.length))]!;
  }

  /**
   * A random rooftop inside an annulus around a point.
   *
   * The alternative — sample `randomRoof` and reject anything outside the ring
   * — is uniform over the *whole map*, so its hit rate collapses as the map
   * grows. On a 27 km² import a 130–340 m ring is about 1% of the city, so
   * forty samples found something roughly a third of the time, and the extra
   * width requirement pushed that down to almost never. This walks only the
   * broadphase cells the ring actually covers, so it succeeds whenever a
   * qualifying roof exists and costs the same on any size of map.
   */
  roofNear(
    rng: Rng,
    x: number,
    z: number,
    minRadius: number,
    maxRadius: number,
    minWidth = 0,
    minHeight = 0,
  ): Building | null {
    const found = this.roofScratch;
    found.length = 0;

    const x0 = this.cellCoord(x - maxRadius);
    const x1 = this.cellCoord(x + maxRadius);
    const z0 = this.cellCoord(z - maxRadius);
    const z1 = this.cellCoord(z + maxRadius);
    const minSq = minRadius * minRadius;
    const maxSq = maxRadius * maxRadius;

    this.stamp++;
    for (let cx = x0; cx <= x1; cx++) {
      for (let cz = z0; cz <= z1; cz++) {
        const bucket = this.cells[cx * this.cellsPerSide + cz];
        if (!bucket) continue;
        for (const index of bucket) {
          // A building spans several cells; the stamp stops it being tested
          // once per cell it touches.
          if (this.visitStamp[index] === this.stamp) continue;
          this.visitStamp[index] = this.stamp;

          const b = this.buildings[index]!;
          const dx = b.roof.x - x;
          const dz = b.roof.z - z;
          const distSq = dx * dx + dz * dz;
          if (distSq < minSq || distSq > maxSq) continue;
          if (minHeight > 0 && b.height < minHeight) continue;
          if (minWidth > 0) {
            const width = Math.min(b.max.x - b.min.x, b.max.z - b.min.z);
            if (width < minWidth) continue;
          }
          found.push(b);
        }
      }
    }

    if (found.length === 0) return null;
    return found[Math.min(found.length - 1, Math.floor(rng() * found.length))] ?? null;
  }

  /**
   * The rooftop that best gets `from` away from `awayFrom` — used by Black Cat
   * to pick an escape route.
   */
  escapeRoof(from: THREE.Vector3, awayFrom: THREE.Vector3, searchRadius: number): Building | null {
    let best: Building | null = null;
    let bestScore = -Infinity;
    const fleeDir = this.tmpA.copy(from).sub(awayFrom).setY(0);
    if (fleeDir.lengthSq() < 1e-6) fleeDir.set(1, 0, 0);
    fleeDir.normalize();

    for (const b of this.buildings) {
      const dx = b.roof.x - from.x;
      const dz = b.roof.z - from.z;
      const dist = Math.hypot(dx, dz);
      if (dist < 12 || dist > searchRadius) continue;
      const align = (dx * fleeDir.x + dz * fleeDir.z) / dist;
      const playerDist = Math.hypot(b.roof.x - awayFrom.x, b.roof.z - awayFrom.z);
      const score = align * 45 + playerDist * 0.5 + b.height * 0.08;
      if (score > bestScore) {
        bestScore = score;
        best = b;
      }
    }
    return best;
  }

  dispose(): void {
    for (const d of this.disposables) d.dispose();
    this.disposables.length = 0;
    this.group.clear();
  }

  // ------------------------------------------------------------- generation

  private generate(): void {
    const rng = mulberry32(CONFIG.city.seed);
    const { grid, blockPitch, streetWidth, splitChance } = CONFIG.city;
    const half = (grid - 1) / 2;
    const maxFootprint = blockPitch - streetWidth;

    const variantCount = Math.min(CONFIG.city.facadeVariants, this.textures.variantCount);

    // Geometry buckets, keyed by chunk so each merge stays spatially local.
    const facadeByChunk = new Map<string, THREE.BufferGeometry[]>();
    const roofByChunk = new Map<number, THREE.BufferGeometry[]>();
    const propByChunk = new Map<number, THREE.BufferGeometry[]>();
    const groundByChunk = new Map<number, THREE.BufferGeometry[]>();
    const markingByChunk = new Map<number, THREE.BufferGeometry[]>();
    const treeTrunks: THREE.Matrix4[] = [];
    const treeCanopies: THREE.Matrix4[] = [];

    const push = <K>(map: Map<K, THREE.BufferGeometry[]>, key: K, geo: THREE.BufferGeometry): void => {
      let list = map.get(key);
      if (!list) {
        list = [];
        map.set(key, list);
      }
      list.push(geo);
    };

    for (let gx = 0; gx < grid; gx++) {
      for (let gz = 0; gz < grid; gz++) {
        const bx = (gx - half) * blockPitch;
        const bz = (gz - half) * blockPitch;
        const chunk = this.chunkIndex(gx, gz);
        const district = districtForBlock(gx, gz, grid);

        push(groundByChunk, chunk, makeQuadXZ(bx, bz, maxFootprint + 10, maxFootprint + 10, 0.02, 2.2));

        // Parks and plazas get trees instead of a tower.
        const isPlaza = district.heightScale <= 0 || rng() < district.plazaChance;
        if (isPlaza) {
          this.scatterTrees(rng, bx, bz, maxFootprint, district.treeDensity, treeTrunks, treeCanopies);
          continue;
        }

        const distNorm = Math.min(1, Math.hypot(gx - half, gz - half) / (half * 1.15));
        const core = Math.pow(1 - distNorm, 1.7);

        const lots = rng() < splitChance ? 2 : 1;
        const splitAlongX = rng() < 0.5;

        for (let lot = 0; lot < lots; lot++) {
          let w: number;
          let d: number;
          let ox = 0;
          let oz = 0;

          if (lots === 1) {
            w = randRange(rng, maxFootprint * 0.68, maxFootprint);
            d = randRange(rng, maxFootprint * 0.68, maxFootprint);
            ox = randRange(rng, -3, 3);
            oz = randRange(rng, -3, 3);
          } else {
            const long = maxFootprint;
            const short = (maxFootprint - 5) / 2;
            const sign = lot === 0 ? -1 : 1;
            if (splitAlongX) {
              w = short;
              d = long;
              ox = sign * (short / 2 + 2.5);
            } else {
              w = long;
              d = short;
              oz = sign * (short / 2 + 2.5);
            }
          }

          const heightMix = clamp(core * randRange(rng, 0.5, 1.3), 0.02, 1);
          let height =
            lerp(CONFIG.city.minHeight, CONFIG.city.maxHeight, heightMix) * district.heightScale;
          if (rng() < 0.05) height *= randRange(rng, 1.15, 1.5);
          height = clamp(height, CONFIG.city.minHeight * 0.5, CONFIG.city.maxHeight * 1.1);

          const cx = bx + ox;
          const cz = bz + oz;
          const variant =
            district.variants[Math.floor(rng() * district.variants.length)]! % variantCount;
          const tint = randRange(rng, 0.82, 1.12);

          push(facadeByChunk, `${chunk}:${variant}`, makeFacadeGeometry(cx, cz, w, height, d, tint));
          push(roofByChunk, chunk, makeRoofGeometry(cx, cz, w, height, d, tint));

          this.registerBuilding(cx, cz, w, height, d);

          const props: THREE.BufferGeometry[] = [];
          addRoofProps(props, rng, cx, cz, w, height, d);
          for (const geo of props) push(propByChunk, chunk, geo);
        }
      }
    }

    // Street lane markings, bucketed into the chunk they fall in.
    const streetCoord = (i: number): number => (i - half - 0.5) * blockPitch;
    const dashLength = 5;
    const dashGap = 7;
    for (let i = 1; i < grid; i++) {
      const line = streetCoord(i);
      for (let t = -this.extent; t < this.extent; t += dashLength + dashGap) {
        const centre = t + dashLength / 2;
        push(
          markingByChunk,
          this.chunkIndexWorld(line, centre),
          makeQuadXZ(line, centre, 0.55, dashLength, 0.04, 1),
        );
        push(
          markingByChunk,
          this.chunkIndexWorld(centre, line),
          makeQuadXZ(centre, line, dashLength, 0.55, 0.04, 1),
        );
      }
    }

    this.buildChunkedMeshes(rng, variantCount, facadeByChunk, roofByChunk, propByChunk, groundByChunk, markingByChunk);
    this.buildGround(rng);
    this.buildTrees(treeTrunks, treeCanopies);
    this.buildStreetlamps(grid, half, blockPitch);
  }

  /** Index of the render chunk a procedural block belongs to. */
  private chunkIndex(gx: number, gz: number): number {
    const half = (CONFIG.city.grid - 1) / 2;
    return this.chunkIndexWorld(
      (gx - half) * CONFIG.city.blockPitch,
      (gz - half) * CONFIG.city.blockPitch,
    );
  }

  /**
   * Render chunk for a world position, in metres.
   *
   * This used to convert to *procedural grid* coordinates and clamp to them,
   * which silently capped the chunk grid at the procedural city's footprint
   * (28 blocks, about 1.7 km). An imported city several kilometres across then
   * had every outlying building clamped into the handful of edge chunks, and a
   * merged mesh whose bounding sphere covers half the map is never culled —
   * which is the entire reason chunking exists. Deriving it from the real
   * extent keeps chunks the same size whatever the map is.
   */
  private chunkIndexWorld(x: number, z: number): number {
    const cx = clamp(Math.floor((x + this.extent) / this.chunkSize), 0, this.chunksPerSide - 1);
    const cz = clamp(Math.floor((z + this.extent) / this.chunkSize), 0, this.chunksPerSide - 1);
    return cz * this.chunksPerSide + cx;
  }

  private scatterTrees(
    rng: Rng,
    bx: number,
    bz: number,
    footprint: number,
    count: number,
    trunks: THREE.Matrix4[],
    canopies: THREE.Matrix4[],
  ): void {
    const span = footprint / 2 - 2;
    const position = new THREE.Vector3();
    const quat = new THREE.Quaternion();
    const scale = new THREE.Vector3();

    for (let i = 0; i < count; i++) {
      const x = bx + randRange(rng, -span, span);
      const z = bz + randRange(rng, -span, span);
      const s = randRange(rng, 0.75, 1.5);
      quat.setFromAxisAngle(UP, rng() * Math.PI * 2);

      position.set(x, 1.6 * s, z);
      scale.set(s, s, s);
      trunks.push(new THREE.Matrix4().compose(position, quat, scale));

      position.set(x, 4.4 * s, z);
      scale.set(s * randRange(rng, 0.9, 1.2), s * randRange(rng, 0.9, 1.3), s);
      canopies.push(new THREE.Matrix4().compose(position, quat, scale));
    }
  }

  private registerBuilding(cx: number, cz: number, w: number, h: number, d: number): void {
    const min = new THREE.Vector3(cx - w / 2, 0, cz - d / 2);
    const max = new THREE.Vector3(cx + w / 2, h, cz + d / 2);
    const building: Building = { min, max, height: h, roof: new THREE.Vector3(cx, h, cz) };
    const index = this.buildings.length;
    this.buildings.push(building);
    this.maxHeight = Math.max(this.maxHeight, h);

    const c0 = this.cellCoord(min.x);
    const c1 = this.cellCoord(max.x);
    const d0 = this.cellCoord(min.z);
    const d1 = this.cellCoord(max.z);
    for (let x = c0; x <= c1; x++) {
      for (let z = d0; z <= d1; z++) {
        this.cells[x * this.cellsPerSide + z]!.push(index);
      }
    }
  }

  private buildChunkedMeshes(
    rng: Rng,
    variantCount: number,
    facadeByChunk: Map<string, THREE.BufferGeometry[]>,
    roofByChunk: Map<number, THREE.BufferGeometry[]>,
    propByChunk: Map<number, THREE.BufferGeometry[]>,
    groundByChunk: Map<number, THREE.BufferGeometry[]>,
    markingByChunk: Map<number, THREE.BufferGeometry[]>,
  ): void {
    // Materials are shared across chunks; only the geometry is split.
    const facadeMats: THREE.MeshStandardMaterial[] = [];
    for (let variant = 0; variant < variantCount; variant++) {
      const { map, emissive } = this.textures.facade(rng, variant);
      const material = new THREE.MeshStandardMaterial({
        map,
        emissiveMap: emissive,
        emissive: new THREE.Color(0xffffff),
        emissiveIntensity: 1.15,
        vertexColors: true,
        roughness: 0.88,
        metalness: 0.08,
      });
      facadeMats.push(material);
      this.disposables.push(material);
    }

    const roofMat = new THREE.MeshStandardMaterial({
      map: this.textures.roof(rng),
      vertexColors: true,
      roughness: 0.96,
      metalness: 0.02,
    });
    const propMat = new THREE.MeshStandardMaterial({
      color: 0x35383f,
      roughness: 0.72,
      metalness: 0.45,
    });
    const walkMat = new THREE.MeshStandardMaterial({
      map: this.textures.concrete(rng),
      roughness: 0.95,
      metalness: 0,
    });
    const markMat = new THREE.MeshBasicMaterial({ color: 0xb8b06a, toneMapped: false });
    this.disposables.push(roofMat, propMat, walkMat, markMat);

    for (const [key, geos] of facadeByChunk) {
      const variant = Number(key.split(':')[1]);
      this.addMesh(mergeAll(geos), facadeMats[variant]!, `Facade_${key}`, true, true);
    }
    for (const [chunk, geos] of roofByChunk) {
      this.addMesh(mergeAll(geos), roofMat, `Roof_${chunk}`, true, true);
    }
    for (const [chunk, geos] of propByChunk) {
      // Props are small and numerous — they receive shadow but don't cast,
      // which keeps them out of the shadow pass entirely.
      this.addMesh(mergeAll(geos), propMat, `Props_${chunk}`, false, true);
    }
    for (const [chunk, geos] of groundByChunk) {
      this.addMesh(mergeAll(geos), walkMat, `Walk_${chunk}`, false, true);
    }
    for (const [chunk, geos] of markingByChunk) {
      this.addMesh(mergeAll(geos), markMat, `Marks_${chunk}`, false, false);
    }
  }

  private buildTrees(trunks: THREE.Matrix4[], canopies: THREE.Matrix4[]): void {
    if (trunks.length === 0) return;

    const trunkGeo = new THREE.CylinderGeometry(0.26, 0.4, 3.2, 6);
    const trunkMat = new THREE.MeshStandardMaterial({ color: 0x4a3728, roughness: 0.95 });
    const canopyGeo = new THREE.IcosahedronGeometry(2.6, 0);
    const canopyMat = new THREE.MeshStandardMaterial({ color: 0x2f6b32, roughness: 0.9, flatShading: true });
    this.disposables.push(trunkGeo, trunkMat, canopyGeo, canopyMat);

    const trunkMesh = new THREE.InstancedMesh(trunkGeo, trunkMat, trunks.length);
    const canopyMesh = new THREE.InstancedMesh(canopyGeo, canopyMat, canopies.length);
    trunkMesh.name = 'TreeTrunks';
    canopyMesh.name = 'TreeCanopies';
    // Instanced meshes render *every* instance in the shadow pass — there is
    // no per-instance culling — so ~900 canopies would cost more than they
    // are worth. They still receive the sun.
    canopyMesh.castShadow = false;
    canopyMesh.receiveShadow = true;
    trunkMesh.receiveShadow = true;

    for (let i = 0; i < trunks.length; i++) trunkMesh.setMatrixAt(i, trunks[i]!);
    for (let i = 0; i < canopies.length; i++) canopyMesh.setMatrixAt(i, canopies[i]!);
    trunkMesh.instanceMatrix.needsUpdate = true;
    canopyMesh.instanceMatrix.needsUpdate = true;

    this.group.add(trunkMesh, canopyMesh);
  }

  private buildGround(rng: Rng): void {
    const span = this.extent * 2 + CONFIG.city.blockPitch * 2;
    const geo = new THREE.PlaneGeometry(span, span, 1, 1);
    geo.rotateX(-Math.PI / 2);
    const tex = this.textures.asphalt(rng);
    tex.repeat.set(span / 10, span / 10);
    const material = new THREE.MeshStandardMaterial({ map: tex, roughness: 1, metalness: 0 });
    this.addMesh(geo, material, 'Ground', false, true);
  }

  private buildStreetlamps(grid: number, half: number, pitch: number): void {
    const positions: THREE.Vector3[] = [];
    const rotations: number[] = [];

    // One lamp per street corner rather than four — a quarter of the instances
    // for a near-identical read at gameplay distance.
    for (let i = 1; i < grid; i++) {
      const line = (i - half - 0.5) * pitch;
      for (let j = 0; j < grid; j++) {
        const along = (j - half) * pitch;
        positions.push(new THREE.Vector3(line - 7, 0, along));
        rotations.push(0);
        positions.push(new THREE.Vector3(along, 0, line - 7));
        rotations.push(Math.PI / 2);
      }
    }

    const pole = new THREE.CylinderGeometry(0.16, 0.22, 8, 6);
    pole.translate(0, 4, 0);
    const arm = new THREE.BoxGeometry(1.9, 0.16, 0.16);
    arm.translate(0.95, 7.9, 0);
    const lampGeo = mergeGeometries([pole, arm], false);
    pole.dispose();
    arm.dispose();
    if (!lampGeo) return;

    const lampMat = new THREE.MeshStandardMaterial({ color: 0x2a2d33, roughness: 0.6, metalness: 0.7 });
    const lamps = new THREE.InstancedMesh(lampGeo, lampMat, positions.length);
    lamps.name = 'Streetlamps';

    const bulbGeo = new THREE.SphereGeometry(0.36, 6, 5);
    const bulbMat = new THREE.MeshBasicMaterial({ color: 0xffdca8, toneMapped: false });
    const bulbs = new THREE.InstancedMesh(bulbGeo, bulbMat, positions.length);
    bulbs.name = 'StreetlampBulbs';

    const matrix = new THREE.Matrix4();
    const quat = new THREE.Quaternion();
    const scale = new THREE.Vector3(1, 1, 1);
    const bulbOffset = new THREE.Vector3();

    for (let i = 0; i < positions.length; i++) {
      const p = positions[i]!;
      quat.setFromAxisAngle(UP, rotations[i]!);
      matrix.compose(p, quat, scale);
      lamps.setMatrixAt(i, matrix);

      bulbOffset.set(1.75, 7.8, 0).applyQuaternion(quat).add(p);
      matrix.compose(bulbOffset, quat, scale);
      bulbs.setMatrixAt(i, matrix);
    }
    lamps.instanceMatrix.needsUpdate = true;
    bulbs.instanceMatrix.needsUpdate = true;

    this.group.add(lamps, bulbs);
    this.disposables.push(lampGeo, lampMat, bulbGeo, bulbMat);
  }

  private addMesh(
    geometry: THREE.BufferGeometry | null,
    material: THREE.Material,
    name: string,
    castShadow: boolean,
    receiveShadow: boolean,
  ): void {
    if (!geometry) return;
    const mesh = new THREE.Mesh(geometry, material);
    mesh.name = name;
    mesh.castShadow = castShadow;
    mesh.receiveShadow = receiveShadow;
    // Everything is static and pre-transformed into world space.
    mesh.matrixAutoUpdate = false;
    mesh.updateMatrix();
    // A tight bounding sphere is what makes the frustum test worth doing.
    geometry.computeBoundingSphere();
    this.group.add(mesh);
    this.disposables.push(geometry);
  }

  private cellCoord(world: number): number {
    const c = Math.floor((world + this.extent + this.cellSize) / this.cellSize);
    return clamp(c, 0, this.cellsPerSide - 1);
  }
}

// ------------------------------------------------------------------ helpers

const UP = new THREE.Vector3(0, 1, 0);

function mergeAll(geos: THREE.BufferGeometry[]): THREE.BufferGeometry | null {
  if (geos.length === 0) return null;
  const merged = mergeGeometries(geos, false);
  for (const g of geos) g.dispose();
  return merged ?? null;
}

/**
 * Four wall quads with per-building UV repeats, so window density stays
 * constant in world space no matter how the tower is proportioned.
 */
function makeFacadeGeometry(
  cx: number,
  cz: number,
  w: number,
  h: number,
  d: number,
  tint: number,
): THREE.BufferGeometry {
  const hw = w / 2;
  const hd = d / 2;
  const repW = Math.max(1, Math.round(w / TILE_W));
  const repD = Math.max(1, Math.round(d / TILE_W));
  const repH = Math.max(1, Math.round(h / TILE_H));

  const pos: number[] = [];
  const nor: number[] = [];
  const uv: number[] = [];
  const col: number[] = [];
  const idx: number[] = [];

  const shadeSpan = Math.min(h, 45);
  const shade = (y: number): number => (0.34 + 0.66 * smoothstep(0, shadeSpan, y)) * tint;

  const quad = (
    ax: number, ay: number, az: number,
    bx: number, by: number, bz: number,
    cxx: number, cyy: number, czz: number,
    dx: number, dy: number, dz: number,
    nx: number, ny: number, nz: number,
    ru: number, rv: number,
  ): void => {
    const base = pos.length / 3;
    pos.push(ax, ay, az, bx, by, bz, cxx, cyy, czz, dx, dy, dz);
    for (let i = 0; i < 4; i++) nor.push(nx, ny, nz);
    uv.push(0, 0, ru, 0, ru, rv, 0, rv);
    for (const y of [ay, by, cyy, dy]) {
      const s = shade(y);
      col.push(s, s, s);
    }
    idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
  };

  quad(-hw, 0, hd, hw, 0, hd, hw, h, hd, -hw, h, hd, 0, 0, 1, repW, repH);
  quad(hw, 0, -hd, -hw, 0, -hd, -hw, h, -hd, hw, h, -hd, 0, 0, -1, repW, repH);
  quad(hw, 0, hd, hw, 0, -hd, hw, h, -hd, hw, h, hd, 1, 0, 0, repD, repH);
  quad(-hw, 0, -hd, -hw, 0, hd, -hw, h, hd, -hw, h, -hd, -1, 0, 0, repD, repH);

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  geo.setIndex(idx);
  geo.translate(cx, 0, cz);
  return geo;
}

function makeRoofGeometry(
  cx: number,
  cz: number,
  w: number,
  h: number,
  d: number,
  tint: number,
): THREE.BufferGeometry {
  const hw = w / 2;
  const hd = d / 2;
  const geo = new THREE.BufferGeometry();
  const s = 1.0 * tint;
  geo.setAttribute(
    'position',
    new THREE.Float32BufferAttribute([-hw, h, hd, hw, h, hd, hw, h, -hd, -hw, h, -hd], 3),
  );
  geo.setAttribute('normal', new THREE.Float32BufferAttribute([0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0], 3));
  geo.setAttribute(
    'uv',
    new THREE.Float32BufferAttribute([0, 0, w / 12, 0, w / 12, d / 12, 0, d / 12], 2),
  );
  geo.setAttribute('color', new THREE.Float32BufferAttribute([s, s, s, s, s, s, s, s, s, s, s, s], 3));
  geo.setIndex([0, 1, 2, 0, 2, 3]);
  geo.translate(cx, 0, cz);
  return geo;
}

/** A flat, upward-facing quad — sidewalks, plazas and lane markings. */
function makeQuadXZ(
  cx: number,
  cz: number,
  w: number,
  d: number,
  y: number,
  uvRepeat: number,
): THREE.BufferGeometry {
  const geo = new THREE.PlaneGeometry(w, d, 1, 1);
  geo.rotateX(-Math.PI / 2);
  geo.translate(cx, y, cz);
  const uvAttr = geo.getAttribute('uv') as THREE.BufferAttribute;
  for (let i = 0; i < uvAttr.count; i++) {
    uvAttr.setXY(i, uvAttr.getX(i) * uvRepeat, uvAttr.getY(i) * uvRepeat);
  }
  uvAttr.needsUpdate = true;
  return geo;
}

/** Water towers, AC plant and antennae, so rooftops aren't bare planes. */
function addRoofProps(
  out: THREE.BufferGeometry[],
  rng: Rng,
  cx: number,
  cz: number,
  w: number,
  h: number,
  d: number,
): void {
  const inset = 3;
  const spanX = Math.max(2, w / 2 - inset);
  const spanZ = Math.max(2, d / 2 - inset);

  if (rng() < 0.45) {
    const r = randRange(rng, 1.8, 2.8);
    const body = new THREE.CylinderGeometry(r, r, r * 2.1, 8);
    const px = cx + randRange(rng, -spanX, spanX);
    const pz = cz + randRange(rng, -spanZ, spanZ);
    body.translate(px, h + r * 1.05 + 2.6, pz);
    const cap = new THREE.ConeGeometry(r * 1.12, r * 0.9, 8);
    cap.translate(px, h + r * 2.1 + 3.05, pz);
    const legs = new THREE.BoxGeometry(r * 1.5, 2.6, r * 1.5);
    legs.translate(px, h + 1.3, pz);
    out.push(body, cap, legs);
  }

  const units = Math.floor(randRange(rng, 1, 3.99));
  for (let i = 0; i < units; i++) {
    const bw = randRange(rng, 2, 5);
    const bh = randRange(rng, 1.2, 2.6);
    const bd = randRange(rng, 2, 5);
    const box = new THREE.BoxGeometry(bw, bh, bd);
    box.translate(cx + randRange(rng, -spanX, spanX), h + bh / 2, cz + randRange(rng, -spanZ, spanZ));
    out.push(box);
  }

  if (h > 120 && rng() < 0.6) {
    const mastHeight = randRange(rng, 10, 28);
    const mast = new THREE.CylinderGeometry(0.22, 0.4, mastHeight, 5);
    mast.translate(cx, h + mastHeight / 2, cz);
    out.push(mast);
  }
}

/** Slab method. Returns the near hit only when it is in front of the origin. */
function slabIntersect(
  origin: THREE.Vector3,
  dir: THREE.Vector3,
  min: THREE.Vector3,
  max: THREE.Vector3,
  maxT: number,
): { t: number; axis: number; sign: number } | null {
  let tMin = 0;
  let tMax = maxT;
  let axis = 0;
  let sign = 1;

  for (let a = 0; a < 3; a++) {
    const o = origin.getComponent(a);
    const dd = dir.getComponent(a);
    const lo = min.getComponent(a);
    const hi = max.getComponent(a);

    if (Math.abs(dd) < 1e-8) {
      if (o < lo || o > hi) return null;
      continue;
    }

    const inv = 1 / dd;
    let t1 = (lo - o) * inv;
    let t2 = (hi - o) * inv;
    let faceSign = -1;
    if (t1 > t2) {
      const swap = t1;
      t1 = t2;
      t2 = swap;
      faceSign = 1;
    }
    if (t1 > tMin) {
      tMin = t1;
      axis = a;
      sign = faceSign;
    }
    if (t2 < tMax) tMax = t2;
    if (tMin > tMax) return null;
  }

  if (tMin <= 1e-5 || tMin >= maxT) return null;
  return { t: tMin, axis, sign };
}

/** Closest-point push-out of a sphere from an AABB. */
function resolveSphereBox(
  center: THREE.Vector3,
  radius: number,
  min: THREE.Vector3,
  max: THREE.Vector3,
  out: Contact,
): boolean {
  const px = clamp(center.x, min.x, max.x);
  const py = clamp(center.y, min.y, max.y);
  const pz = clamp(center.z, min.z, max.z);

  const dx = center.x - px;
  const dy = center.y - py;
  const dz = center.z - pz;
  const distSq = dx * dx + dy * dy + dz * dz;

  if (distSq > radius * radius) return false;

  if (distSq > 1e-8) {
    const dist = Math.sqrt(distSq);
    out.normal.set(dx / dist, dy / dist, dz / dist);
    out.depth = radius - dist;
    return true;
  }

  // Centre is inside the box: escape along the shallowest face.
  const toMinX = center.x - min.x;
  const toMaxX = max.x - center.x;
  const toMinY = center.y - min.y;
  const toMaxY = max.y - center.y;
  const toMinZ = center.z - min.z;
  const toMaxZ = max.z - center.z;

  let bestDepth = toMinX;
  out.normal.set(-1, 0, 0);
  if (toMaxX < bestDepth) {
    bestDepth = toMaxX;
    out.normal.set(1, 0, 0);
  }
  if (toMinY < bestDepth) {
    bestDepth = toMinY;
    out.normal.set(0, -1, 0);
  }
  if (toMaxY < bestDepth) {
    bestDepth = toMaxY;
    out.normal.set(0, 1, 0);
  }
  if (toMinZ < bestDepth) {
    bestDepth = toMinZ;
    out.normal.set(0, 0, -1);
  }
  if (toMaxZ < bestDepth) {
    bestDepth = toMaxZ;
    out.normal.set(0, 0, 1);
  }
  out.depth = bestDepth + radius;
  return true;
}
