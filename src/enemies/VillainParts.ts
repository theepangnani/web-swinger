import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

/**
 * Geometry construction kit for the villain models.
 *
 * Two problems solved together:
 *
 * 1. **Detail.** A capsule torso with a sphere on top reads as a chess pawn at
 *    any distance. Real silhouette needs a neck, a jaw, a brow, shoulders that
 *    sit proud, hands with fingers, and feet — dozens of small primitives per
 *    character.
 *
 * 2. **Cost.** Dozens of primitives per character times six characters is
 *    hundreds of draw calls for things that are usually a few pixels tall.
 *
 * So every primitive is baked into a local matrix and accumulated per material,
 * and `commit()` merges each material's pile into exactly one mesh. A villain
 * ends up as three or four draw calls no matter how much anatomy it has, which
 * is what makes the detail affordable at all.
 */

export interface Disposable {
  dispose(): void;
}

/** Local placement for a primitive, in the villain's own space. */
export interface Placement {
  x?: number;
  y?: number;
  z?: number;
  rx?: number;
  ry?: number;
  rz?: number;
  /** Uniform scale, or per-axis via sx/sy/sz. */
  s?: number;
  sx?: number;
  sy?: number;
  sz?: number;
}

const _matrix = new THREE.Matrix4();
const _quat = new THREE.Quaternion();
const _euler = new THREE.Euler();
const _pos = new THREE.Vector3();
const _scale = new THREE.Vector3();
const _origin = new THREE.Vector3();

/** A joint under construction. */
interface Limb {
  readonly name: string;
  readonly parent: string | null;
  /** Pivot, in the parent limb's space (or the body's, for a root limb). */
  readonly origin: THREE.Vector3;
  readonly batches: Map<THREE.Material, THREE.BufferGeometry[]>;
}

export class VillainBuilder {
  private readonly batches = new Map<THREE.Material, THREE.BufferGeometry[]>();
  private readonly parent: THREE.Group;
  private readonly sink: Disposable[];
  /** Materials that should cast shadows once merged. */
  private readonly shadowCasters = new Set<THREE.Material>();

  /**
   * Joints, in declaration order.
   *
   * Merging everything into one mesh is what makes this much anatomy
   * affordable, and it is also why no villain could move: a merged body has
   * no parts. A limb is its own little merge — geometry added while it is
   * open is pre-translated so the joint sits at the origin, then committed as
   * a child group that can simply be rotated at runtime. Cost is one extra
   * draw call per limb per material, which for two arms is four.
   */
  private readonly limbs: Limb[] = [];
  private open: Limb | null = null;
  /** Committed joint groups, by name. Empty until `commit()`. */
  readonly joints = new Map<string, THREE.Group>();

  constructor(parent: THREE.Group, sink: Disposable[]) {
    this.parent = parent;
    this.sink = sink;
  }

  /**
   * Opens a joint. Everything added until the next `limb()` or `endLimb()`
   * belongs to it and rotates with it.
   *
   * Coordinates stay in the villain's own space throughout — the pivot offset
   * is subtracted at commit time — so a limb can be added to an existing
   * builder without recomputing a single position.
   */
  limb(name: string, origin: { x?: number; y?: number; z?: number }, parent: string | null = null): this {
    this.open = {
      name,
      parent,
      origin: new THREE.Vector3(origin.x ?? 0, origin.y ?? 0, origin.z ?? 0),
      batches: new Map(),
    };
    this.limbs.push(this.open);
    return this;
  }

  /** Closes the current joint; subsequent geometry is body-fixed again. */
  endLimb(): this {
    this.open = null;
    return this;
  }

  /**
   * Queues a primitive. The geometry is consumed — it is transformed into
   * place, added to its material's batch and disposed at commit time, so
   * callers can pass a freshly constructed geometry every call without
   * leaking.
   */
  add(geometry: THREE.BufferGeometry, material: THREE.Material, at: Placement = {}): this {
    _pos.set(at.x ?? 0, at.y ?? 0, at.z ?? 0);
    _euler.set(at.rx ?? 0, at.ry ?? 0, at.rz ?? 0);
    _quat.setFromEuler(_euler);
    const uniform = at.s ?? 1;
    _scale.set(at.sx ?? uniform, at.sy ?? uniform, at.sz ?? uniform);
    _matrix.compose(_pos, _quat, _scale);
    geometry.applyMatrix4(_matrix);

    // Polyhedra come out non-indexed and primitives come out indexed; merging
    // a mixed pile fails, so normalise everything to non-indexed.
    const normalised = geometry.index ? geometry.toNonIndexed() : geometry;
    if (normalised !== geometry) geometry.dispose();
    // Merging also requires an identical attribute set.
    for (const name of Object.keys(normalised.attributes)) {
      if (name !== 'position' && name !== 'normal' && name !== 'uv') {
        normalised.deleteAttribute(name);
      }
    }

    const target = this.open ? this.open.batches : this.batches;
    let batch = target.get(material);
    if (!batch) {
      batch = [];
      target.set(material, batch);
    }
    batch.push(normalised);
    return this;
  }

  /** Marks a material's merged mesh as a shadow caster. */
  castsShadow(material: THREE.Material): this {
    this.shadowCasters.add(material);
    return this;
  }

  // ------------------------------------------------------------- primitives

  // Segment counts are generous on purpose. Every primitive here is merged
  // into a handful of meshes, so the only cost of a rounder capsule is
  // vertices — a few thousand per character, against a city of eleven thousand
  // buildings. Low-poly limbs were reading as carved rather than as bodies.
  capsule(material: THREE.Material, radius: number, length: number, at: Placement = {}): this {
    return this.add(new THREE.CapsuleGeometry(radius, length, 10, 24), material, at);
  }

  sphere(material: THREE.Material, radius: number, at: Placement = {}, segments = 22): this {
    return this.add(new THREE.SphereGeometry(radius, segments, Math.round(segments * 0.8)), material, at);
  }

  /**
   * A box with its edges taken off.
   *
   * Everything on a body that used to be a plain `BoxGeometry` — a boot, a
   * bracer, a jaw plate, a glider fin — announced itself as a box the moment
   * light hit the edge, and twenty-three of them across the roster was most of
   * why the characters read as assembled rather than sculpted. Nothing on a
   * person has a perfectly sharp 90-degree edge.
   *
   * `radius` is clamped to a third of the smallest side, so a thin plate stays
   * a plate instead of collapsing into a lozenge.
   */
  box(
    material: THREE.Material,
    w: number,
    h: number,
    d: number,
    at: Placement = {},
    bevel = 0.3,
  ): this {
    return this.add(roundedBox(w, h, d, bevel), material, at);
  }

  cone(material: THREE.Material, radius: number, height: number, at: Placement = {}, segments = 18): this {
    return this.add(new THREE.ConeGeometry(radius, height, segments), material, at);
  }

  cylinder(
    material: THREE.Material,
    top: number,
    bottom: number,
    height: number,
    at: Placement = {},
    segments = 22,
  ): this {
    return this.add(new THREE.CylinderGeometry(top, bottom, height, segments), material, at);
  }

  torus(material: THREE.Material, radius: number, tube: number, at: Placement = {}, segments = 24): this {
    return this.add(new THREE.TorusGeometry(radius, tube, 12, segments), material, at);
  }

  /** Faceted lump — the workhorse for organic mass that shouldn't look moulded. */
  rock(material: THREE.Material, radius: number, at: Placement = {}, detail = 2): this {
    return this.add(new THREE.IcosahedronGeometry(radius, detail), material, at);
  }

  /**
   * Rounded mass. Same job as `rock` but subdivided far enough that smooth
   * shading reads as a limb rather than as gravel — which is the difference
   * between a man made of sand and a pile of it.
   */
  blob(material: THREE.Material, radius: number, at: Placement = {}): this {
    return this.add(new THREE.IcosahedronGeometry(radius, 3), material, at);
  }

  // --------------------------------------------------------------- anatomy

  /**
   * A skull rather than a ball: cranium, tapered jaw, brow ridge and cheeks.
   *
   * `forward` is +Z, matching the rest of the rigs. Everything is positioned
   * relative to `at`, so a caller only supplies the head's centre.
   */
  head(
    material: THREE.Material,
    radius: number,
    at: Placement,
    opts: { brow?: THREE.Material; jaw?: boolean; browDepth?: number } = {},
  ): this {
    const x = at.x ?? 0;
    const y = at.y ?? 0;
    const z = at.z ?? 0;
    const scale = at.s ?? 1;
    const r = radius * scale;

    // Cranium — taller than wide, slightly flattened front to back.
    this.sphere(material, r, { x, y, z, sx: 0.96, sy: 1.1, sz: 1.04 }, 14);
    // Occiput, so the back of the head isn't a perfect hemisphere.
    this.sphere(material, r * 0.72, { x, y: y - r * 0.16, z: z - r * 0.42 }, 10);

    if (opts.jaw !== false) {
      // Jaw: a wedge that tapers to the chin.
      this.sphere(material, r * 0.66, { x, y: y - r * 0.62, z: z + r * 0.2, sx: 0.9, sy: 0.72, sz: 1.05 }, 10);
      this.sphere(material, r * 0.34, { x, y: y - r * 0.86, z: z + r * 0.42, sy: 0.8 }, 8);
      // Cheekbones.
      for (const side of [-1, 1]) {
        this.sphere(material, r * 0.3, { x: x + side * r * 0.62, y: y - r * 0.16, z: z + r * 0.4, sz: 0.8 }, 8);
      }
    }

    // Brow ridge — the single biggest contributor to a face reading as a face.
    const brow = opts.brow ?? material;
    const depth = opts.browDepth ?? 0.78;
    this.box(brow, r * 1.5, r * 0.24, r * 0.3, { x, y: y + r * 0.24, z: z + r * depth, rx: -0.12 });
    // Nose bridge.
    this.box(material, r * 0.24, r * 0.5, r * 0.28, { x, y: y - r * 0.06, z: z + r * 0.86 });

    return this;
  }

  /**
   * Palm, four fingers and an opposed thumb. `side` is -1 for the character's
   * right (world -X) and +1 for their left, matching the rigs' +Z facing.
   */
  hand(
    material: THREE.Material,
    scale: number,
    side: number,
    at: Placement,
    opts: { claw?: THREE.Material; clawLength?: number; curl?: number; fist?: boolean } = {},
  ): this {
    const x = at.x ?? 0;
    const y = at.y ?? 0;
    const z = at.z ?? 0;
    const curl = opts.curl ?? 0;

    // Palm.
    this.box(material, scale * 0.62, scale * 0.78, scale * 0.34, { x, y, z, rz: side * 0.1 });
    this.sphere(material, scale * 0.34, { x, y: y + scale * 0.16, z, sz: 0.62 }, 8);

    if (opts.fist) {
      // Closed fist: knuckle row instead of extended fingers.
      for (let i = 0; i < 4; i++) {
        const offset = (i - 1.5) * scale * 0.19;
        this.sphere(material, scale * 0.15, { x: x + offset, y: y - scale * 0.34, z: z + scale * 0.06 }, 7);
      }
      this.box(material, scale * 0.62, scale * 0.3, scale * 0.4, { x, y: y - scale * 0.3, z });
    } else {
      // Four fingers, splayed slightly and curled by `curl` radians.
      for (let i = 0; i < 4; i++) {
        const offset = (i - 1.5) * scale * 0.19;
        const length = scale * (i === 0 || i === 3 ? 0.5 : 0.62);
        this.capsule(material, scale * 0.075, length, {
          x: x + offset,
          y: y - scale * 0.42 - length * 0.4,
          z: z + scale * 0.04,
          rx: curl,
          rz: offset * 0.5,
        });
        if (opts.claw) {
          this.cone(opts.claw, scale * 0.07, opts.clawLength ?? scale * 0.4, {
            x: x + offset,
            y: y - scale * 0.5 - length * 0.9,
            z: z + scale * 0.08,
            rx: Math.PI - curl * 0.6,
          }, 5);
        }
      }
      // Thumb, set back and rotated across the palm.
      this.capsule(material, scale * 0.085, scale * 0.4, {
        x: x + side * scale * 0.34,
        y: y - scale * 0.24,
        z: z + scale * 0.06,
        rz: side * 1.0,
      });
      if (opts.claw) {
        this.cone(opts.claw, scale * 0.07, opts.clawLength ?? scale * 0.4, {
          x: x + side * scale * 0.56,
          y: y - scale * 0.4,
          z: z + scale * 0.08,
          rz: side * 1.0,
          rx: Math.PI * 0.9,
        }, 5);
      }
    }
    return this;
  }

  /** Boot or bare foot: heel, arch and a toe box, not a squashed sphere. */
  foot(
    material: THREE.Material,
    scale: number,
    at: Placement,
    opts: { claw?: THREE.Material; toes?: number } = {},
  ): this {
    const x = at.x ?? 0;
    const y = at.y ?? 0;
    const z = at.z ?? 0;

    this.box(material, scale * 0.46, scale * 0.28, scale * 0.9, { x, y, z: z + scale * 0.14 });
    this.sphere(material, scale * 0.25, { x, y: y + scale * 0.06, z: z - scale * 0.22, sz: 0.9 }, 8);
    // Toe box, tilted up off the ground.
    this.box(material, scale * 0.42, scale * 0.22, scale * 0.3, { x, y: y - scale * 0.02, z: z + scale * 0.6, rx: -0.14 });

    if (opts.claw) {
      const toes = opts.toes ?? 3;
      for (let i = 0; i < toes; i++) {
        const offset = (i - (toes - 1) / 2) * scale * 0.2;
        this.cone(opts.claw, scale * 0.07, scale * 0.4, {
          x: x + offset,
          y: y - scale * 0.04,
          z: z + scale * 0.86,
          rx: -Math.PI * 0.46,
        }, 5);
      }
    }
    return this;
  }

  /**
   * Chest mass: pectorals, a segmented abdomen and lat flare. This is what
   * turns a smooth capsule into a body.
   */
  chest(material: THREE.Material, scale: number, at: Placement, abs = 3): this {
    const x = at.x ?? 0;
    const y = at.y ?? 0;
    const z = at.z ?? 0;

    for (const side of [-1, 1]) {
      // Pectoral.
      this.sphere(material, scale * 0.3, {
        x: x + side * scale * 0.26,
        y,
        z: z + scale * 0.3,
        sx: 1.1,
        sy: 0.8,
        sz: 0.55,
      }, 10);
      // Lat, sweeping down and back from the armpit.
      this.sphere(material, scale * 0.26, {
        x: x + side * scale * 0.44,
        y: y - scale * 0.34,
        z,
        sx: 0.7,
        sy: 1.3,
        sz: 0.9,
      }, 8);
    }

    // Sternum groove between the pectorals.
    this.box(material, scale * 0.08, scale * 0.5, scale * 0.16, { x, y, z: z + scale * 0.34 });

    // Abdominal segmentation.
    for (let i = 0; i < abs; i++) {
      const row = y - scale * (0.34 + i * 0.24);
      for (const side of [-1, 1]) {
        this.sphere(material, scale * 0.15, {
          x: x + side * scale * 0.14,
          y: row,
          z: z + scale * 0.3,
          sy: 0.7,
          sz: 0.55,
        }, 8);
      }
    }
    return this;
  }

  /**
   * Merges every batch into one mesh per material and parents them.
   *
   * Call exactly once per villain, after all `add` calls.
   */
  commit(): Map<string, THREE.Group> {
    if (this.open) {
      // Everything after the last limb() silently belonged to that limb, so a
      // missing endLimb() parents the legs to an elbow. Cheap to say, and
      // otherwise only visible as a body that folds up when an arm swings.
      console.warn(`[villain] limb '${this.open.name}' was never closed with endLimb()`);
    }
    this.open = null;
    this.mergeInto(this.parent, this.batches, _origin.set(0, 0, 0));
    this.batches.clear();

    // Limbs in declaration order, so a child is always created after the
    // parent it hangs from. Origins are authored in body space; a child's
    // group position is the difference from its parent's joint, and its
    // geometry is pulled back by the full body-space offset.
    const authored = new Map<string, THREE.Vector3>();
    for (const limb of this.limbs) {
      const host = limb.parent ? this.joints.get(limb.parent) : null;
      if (limb.parent && !host) {
        console.warn(`[villain] limb '${limb.name}' names an unknown parent '${limb.parent}'`);
      }
      const parentOrigin = limb.parent ? authored.get(limb.parent) : null;

      const group = new THREE.Group();
      group.name = limb.name;
      group.position.copy(limb.origin);
      if (parentOrigin) group.position.sub(parentOrigin);

      (host ?? this.parent).add(group);
      this.mergeInto(group, limb.batches, limb.origin);
      limb.batches.clear();
      this.joints.set(limb.name, group);
      authored.set(limb.name, limb.origin);
    }
    this.limbs.length = 0;
    return this.joints;
  }

  /**
   * Merges one pile of batches under `host`, shifted so `pivot` lands at the
   * host's origin.
   */
  private mergeInto(
    host: THREE.Group,
    batches: Map<THREE.Material, THREE.BufferGeometry[]>,
    pivot: THREE.Vector3,
  ): void {
    const shift = pivot.lengthSq() > 1e-12;
    for (const [material, geometries] of batches) {
      if (geometries.length === 0) continue;
      if (shift) {
        _matrix.makeTranslation(-pivot.x, -pivot.y, -pivot.z);
        for (const g of geometries) g.applyMatrix4(_matrix);
      }
      const merged = geometries.length === 1 ? geometries[0]! : mergeGeometries(geometries);
      if (geometries.length > 1) {
        for (const g of geometries) g.dispose();
      }
      if (!merged) {
        console.warn('[villain] geometry merge failed; skipping a material batch');
        continue;
      }
      merged.computeBoundingSphere();
      const mesh = new THREE.Mesh(merged, material);
      // Transparent/additive materials must not write shadows or they punch
      // black holes in whatever is behind them.
      mesh.castShadow = this.shadowCasters.has(material);
      mesh.receiveShadow = false;
      host.add(mesh);
      this.sink.push(merged);
    }
  }
}

/**
 * A box whose corners and edges are rounded, built by inflating a subdivided
 * cube onto a rounded-cube surface.
 *
 * Three's own `RoundedBoxGeometry` lives in the examples bundle, which this
 * project does not pull in — and the whole trick is four lines anyway: take
 * each vertex, clamp it into the inner box that the corner spheres sit on,
 * then push it back out to `radius` along the direction it was displaced.
 * Vertices on a flat face are already inside the inner box, so they do not
 * move; only the edges and corners round off, which is exactly the intent.
 *
 * Normals are recomputed afterwards, because the inflation is what makes the
 * bevel catch the light and the original box normals know nothing about it.
 */
export function roundedBox(
  width: number,
  height: number,
  depth: number,
  bevel: number,
  segments = 4,
): THREE.BufferGeometry {
  const smallest = Math.min(width, height, depth);
  // A third of the smallest side is the point past which a plate stops being
  // a plate. Clamped rather than trusted, because callers pass a ratio.
  const radius = Math.min(smallest * bevel, smallest / 3);

  const geometry = new THREE.BoxGeometry(width, height, depth, segments, segments, segments);
  const position = geometry.getAttribute('position');
  // Half-extents of the inner box the corner radius rolls around.
  const ix = Math.max(width / 2 - radius, 0);
  const iy = Math.max(height / 2 - radius, 0);
  const iz = Math.max(depth / 2 - radius, 0);

  const v = new THREE.Vector3();
  const inner = new THREE.Vector3();
  for (let i = 0; i < position.count; i++) {
    v.fromBufferAttribute(position, i);
    inner.set(
      THREE.MathUtils.clamp(v.x, -ix, ix),
      THREE.MathUtils.clamp(v.y, -iy, iy),
      THREE.MathUtils.clamp(v.z, -iz, iz),
    );
    // Direction from the inner box out to this vertex. Zero length means the
    // vertex is already on the inner box and belongs where it is.
    v.sub(inner);
    const length = v.length();
    if (length > 1e-6) v.multiplyScalar(radius / length);
    v.add(inner);
    position.setXYZ(i, v.x, v.y, v.z);
  }

  position.needsUpdate = true;
  geometry.computeVertexNormals();
  return geometry;
}
