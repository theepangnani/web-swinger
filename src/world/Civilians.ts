import * as THREE from 'three';
import { CONFIG } from '../core/Config';
import { randRange, type Rng } from '../core/MathUtils';
import type { City } from './City';

interface Walker {
  /** Street-line coordinate the walker patrols along. */
  readonly line: number;
  /** True if the walker moves along X, false along Z. */
  readonly alongX: boolean;
  offset: number;
  speed: number;
  /** Sidewalk side, ±1. */
  readonly side: number;
  phase: number;
  ground: number;
}

const _matrix = new THREE.Matrix4();
const _pos = new THREE.Vector3();
const _quat = new THREE.Quaternion();
const _scale = new THREE.Vector3(1, 1, 1);
const UP = new THREE.Vector3(0, 1, 0);

const COATS = [0x39414f, 0x5a4632, 0x2f4858, 0x6b3f4a, 0x3d4d3a, 0x4a4a55];

/**
 * Street-level pedestrians.
 *
 * Purely decorative and deliberately cheap: two InstancedMeshes, no collision,
 * no pathfinding. Walkers patrol fixed sidewalk lines and are only stepped
 * when the player is close enough to see them, so a distant crowd costs almost
 * nothing.
 */
export class Civilians {
  readonly group = new THREE.Group();

  private readonly walkers: Walker[] = [];
  private readonly bodies: THREE.InstancedMesh;
  private readonly heads: THREE.InstancedMesh;
  private readonly disposables: Array<{ dispose(): void }> = [];
  private readonly halfSpan: number;

  /** Beyond this distance a walker is parked rather than simulated. */
  private static readonly ACTIVE_RANGE = 220;

  constructor(city: City, rng: Rng, count = 180) {
    this.group.name = 'Civilians';
    this.halfSpan = city.extent;

    const { grid, blockPitch } = CONFIG.city;
    const half = (grid - 1) / 2;

    for (let i = 0; i < count; i++) {
      const lineIndex = 1 + Math.floor(rng() * (grid - 1));
      const alongX = rng() < 0.5;
      const line = (lineIndex - half - 0.5) * blockPitch;
      const side = rng() < 0.5 ? -1 : 1;
      const offset = randRange(rng, -this.halfSpan, this.halfSpan);

      this.walkers.push({
        line,
        alongX,
        offset,
        speed: randRange(rng, 1.1, 2.1) * (rng() < 0.5 ? -1 : 1),
        side,
        phase: rng() * Math.PI * 2,
        ground: 0,
      });
    }

    const bodyGeo = new THREE.CapsuleGeometry(0.24, 0.72, 3, 6);
    const headGeo = new THREE.SphereGeometry(0.19, 8, 6);
    const bodyMat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.9, metalness: 0 });
    const headMat = new THREE.MeshStandardMaterial({ color: 0xc8a888, roughness: 0.85, metalness: 0 });
    this.disposables.push(bodyGeo, headGeo, bodyMat, headMat);

    this.bodies = new THREE.InstancedMesh(bodyGeo, bodyMat, count);
    this.heads = new THREE.InstancedMesh(headGeo, headMat, count);
    this.bodies.name = 'CivilianBodies';
    this.heads.name = 'CivilianHeads';
    // Instances move constantly; a stale bounding sphere would cull them out.
    this.bodies.frustumCulled = false;
    this.heads.frustumCulled = false;

    // Per-instance coat colour, so the crowd isn't uniform.
    const colors = new Float32Array(count * 3);
    const color = new THREE.Color();
    for (let i = 0; i < count; i++) {
      color.setHex(COATS[Math.floor(rng() * COATS.length)]!);
      colors[i * 3] = color.r;
      colors[i * 3 + 1] = color.g;
      colors[i * 3 + 2] = color.b;
    }
    this.bodies.instanceColor = new THREE.InstancedBufferAttribute(colors, 3);

    // Park everyone on their sidewalk once, up front.
    for (let i = 0; i < this.walkers.length; i++) {
      const walker = this.walkers[i]!;
      walker.ground = city.groundHeightAt(...this.worldXZ(walker));
      this.writeInstance(i, walker, 0);
    }
    this.bodies.instanceMatrix.needsUpdate = true;
    this.heads.instanceMatrix.needsUpdate = true;

    this.group.add(this.bodies, this.heads);
  }

  update(dt: number, viewer: THREE.Vector3, time: number): void {
    let touched = false;

    for (let i = 0; i < this.walkers.length; i++) {
      const walker = this.walkers[i]!;
      const [x, z] = this.worldXZ(walker);

      // Skip anyone the player can't plausibly see.
      const dx = x - viewer.x;
      const dz = z - viewer.z;
      if (dx * dx + dz * dz > Civilians.ACTIVE_RANGE * Civilians.ACTIVE_RANGE) continue;

      walker.offset += walker.speed * dt;
      if (walker.offset > this.halfSpan) walker.offset = -this.halfSpan;
      if (walker.offset < -this.halfSpan) walker.offset = this.halfSpan;

      this.writeInstance(i, walker, time);
      touched = true;
    }

    if (touched) {
      this.bodies.instanceMatrix.needsUpdate = true;
      this.heads.instanceMatrix.needsUpdate = true;
    }
  }

  dispose(): void {
    for (const d of this.disposables) d.dispose();
    this.disposables.length = 0;
    this.group.clear();
  }

  private worldXZ(walker: Walker): [number, number] {
    const lateral = walker.line + walker.side * 8;
    return walker.alongX ? [walker.offset, lateral] : [lateral, walker.offset];
  }

  private writeInstance(index: number, walker: Walker, time: number): void {
    const [x, z] = this.worldXZ(walker);
    // A gentle bob sells walking without any skeletal work.
    const bob = Math.sin(time * 6 + walker.phase) * 0.05;
    const facing = walker.alongX
      ? walker.speed > 0
        ? Math.PI / 2
        : -Math.PI / 2
      : walker.speed > 0
        ? 0
        : Math.PI;

    _quat.setFromAxisAngle(UP, facing);

    _pos.set(x, walker.ground + 0.85 + bob, z);
    _matrix.compose(_pos, _quat, _scale);
    this.bodies.setMatrixAt(index, _matrix);

    _pos.set(x, walker.ground + 1.52 + bob, z);
    _matrix.compose(_pos, _quat, _scale);
    this.heads.setMatrixAt(index, _matrix);
  }
}
