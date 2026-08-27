import * as THREE from 'three';
import { CONFIG } from '../core/Config';
import { mulberry32 } from '../core/MathUtils';
import type { City } from '../world/City';
import { BACKPACK_MEMORIES, type Script } from './Story';

/**
 * Old backpacks, stashed on rooftops and forgotten.
 *
 * The city was a very good playground with nothing in it. Every rooftop was
 * identical in the only sense that matters — there was never a reason to go to
 * *that* one — so traversal, which is the best thing this game does, existed
 * purely to get you to the next fight.
 *
 * Each backpack is somewhere you have to work to reach and holds one thing
 * Peter left behind years ago, which is the only reason a collectible is worth
 * collecting: it is not a number going up, it is the city having a past. They
 * are read aloud through the same director as the campaign, so finding one
 * plays like a scene rather than a pickup.
 *
 * Placement is seeded off the city seed, so the same city always hides them in
 * the same places — a route you learn is a route that stays learned, and two
 * players of the same seed are looking at the same map.
 */

export interface Backpack {
  readonly id: number;
  readonly position: THREE.Vector3;
  /** What is inside, and who says so. */
  readonly memory: Script;
  collected: boolean;
}


/** Backpacks, their placement, and the meshes that show them. */
export class Backpacks {
  readonly group = new THREE.Group();
  readonly packs: Backpack[] = [];

  private readonly meshes: THREE.Mesh[] = [];
  private readonly disposables: Array<{ dispose(): void }> = [];
  private clock = 0;

  constructor(city: City) {
    const rng = mulberry32(CONFIG.city.seed ^ 0x0bacc4a8);
    const geometry = this.buildGeometry();
    const material = new THREE.MeshStandardMaterial({
      color: 0x8c2f39,
      roughness: 0.75,
      metalness: 0.05,
      emissive: 0x3a0d12,
      emissiveIntensity: 0.6,
    });
    this.disposables.push(geometry, material);

    // Spread around the map rather than clustered: the ring the angle walks
    // means consecutive packs are never neighbours, so collecting them is a
    // tour of the city instead of a lap of one district.
    const wanted = Math.min(CONFIG.backpacks.count, BACKPACK_MEMORIES.length);
    const span = CONFIG.city.grid * CONFIG.city.blockPitch * 0.42;
    for (let i = 0; i < wanted; i++) {
      const angle = (i / wanted) * Math.PI * 2 + rng() * 0.6;
      const radius = span * (0.25 + 0.7 * rng());
      const roof = city.roofNear(
        rng,
        Math.cos(angle) * radius,
        Math.sin(angle) * radius,
        0,
        CONFIG.backpacks.searchRadius,
        CONFIG.backpacks.minRoofWidth,
        CONFIG.backpacks.minRoofHeight,
      );
      if (!roof) continue;

      const position = new THREE.Vector3(roof.roof.x, roof.roof.y + 0.9, roof.roof.z);
      const pack: Backpack = {
        id: this.packs.length,
        position,
        memory: BACKPACK_MEMORIES[this.packs.length % BACKPACK_MEMORIES.length]!,
        collected: false,
      };
      this.packs.push(pack);

      const mesh = new THREE.Mesh(geometry, material);
      mesh.position.copy(position);
      mesh.castShadow = false;
      this.group.add(mesh);
      this.meshes.push(mesh);
    }
  }

  get total(): number {
    return this.packs.length;
  }

  get found(): number {
    return this.packs.reduce((n, p) => n + (p.collected ? 1 : 0), 0);
  }

  /** Ids of everything collected, for the save. */
  serialise(): number[] {
    return this.packs.filter((p) => p.collected).map((p) => p.id);
  }

  restore(ids: readonly number[]): void {
    const found = new Set(ids);
    for (const pack of this.packs) {
      pack.collected = found.has(pack.id);
      const mesh = this.meshes[pack.id];
      if (mesh) mesh.visible = !pack.collected;
    }
  }

  /** The nearest uncollected pack, for the objective marker. */
  nearest(to: THREE.Vector3): Backpack | null {
    let best: Backpack | null = null;
    let bestSq = Infinity;
    for (const pack of this.packs) {
      if (pack.collected) continue;
      const d = pack.position.distanceToSquared(to);
      if (d < bestSq) {
        best = pack;
        bestSq = d;
      }
    }
    return best;
  }

  /**
   * Bobs the uncollected packs, and hands back one the player has reached.
   *
   * Collection is proximity rather than a keypress on purpose: a prompt would
   * be one more verb in a game that already has twenty, and there is no reason
   * to ever decline.
   */
  update(dt: number, player: THREE.Vector3): Backpack | null {
    this.clock += dt;
    const reachSq = CONFIG.backpacks.reach * CONFIG.backpacks.reach;
    let picked: Backpack | null = null;

    for (const pack of this.packs) {
      const mesh = this.meshes[pack.id];
      if (!mesh || pack.collected) continue;
      mesh.rotation.y += dt * 0.8;
      mesh.position.y = pack.position.y + Math.sin(this.clock * 1.6 + pack.id) * 0.18;

      // Only the first one per frame: two collected on the same step would
      // queue two scenes, and the second would be read over the first.
      if (!picked && pack.position.distanceToSquared(player) < reachSq) picked = pack;
    }

    if (picked) {
      picked.collected = true;
      const mesh = this.meshes[picked.id];
      if (mesh) mesh.visible = false;
    }
    return picked;
  }

  dispose(): void {
    for (const d of this.disposables) d.dispose();
    this.group.clear();
  }

  /**
   * A backpack, from three boxes.
   *
   * Merged into one geometry shared by every instance: they are static, small
   * and numerous enough that a mesh each with its own geometry would be pure
   * waste, and nothing about them ever needs to differ.
   */
  private buildGeometry(): THREE.BufferGeometry {
    const body = new THREE.BoxGeometry(0.62, 0.78, 0.34);
    const lid = new THREE.BoxGeometry(0.66, 0.24, 0.38);
    lid.translate(0, 0.34, 0.02);
    const strap = new THREE.BoxGeometry(0.12, 0.66, 0.1);
    strap.translate(0, -0.06, -0.2);

    const merged = mergeBoxes([body, lid, strap]);
    body.dispose();
    lid.dispose();
    strap.dispose();
    return merged;
  }
}

/**
 * Concatenates a few box geometries into one.
 *
 * Three's own merge helper lives in an examples module this project does not
 * pull in, and three boxes with identical attributes is not worth the
 * dependency — they all have position, normal and uv, in the same order.
 */
function mergeBoxes(parts: readonly THREE.BufferGeometry[]): THREE.BufferGeometry {
  const out = new THREE.BufferGeometry();
  const names = ['position', 'normal', 'uv'] as const;

  for (const name of names) {
    const arrays: number[] = [];
    for (const part of parts) {
      const attribute = part.getAttribute(name);
      for (let i = 0; i < attribute.array.length; i++) arrays.push(attribute.array[i] as number);
    }
    const size = parts[0]!.getAttribute(name).itemSize;
    out.setAttribute(name, new THREE.Float32BufferAttribute(arrays, size));
  }

  const indices: number[] = [];
  let offset = 0;
  for (const part of parts) {
    const index = part.getIndex();
    if (index) for (let i = 0; i < index.count; i++) indices.push(index.getX(i) + offset);
    offset += part.getAttribute('position').count;
  }
  out.setIndex(indices);
  out.computeBoundingSphere();
  return out;
}
