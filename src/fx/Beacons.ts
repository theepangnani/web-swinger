import * as THREE from 'three';

export type BeaconKind = 'crime' | 'villain';

interface Beacon {
  group: THREE.Group;
  pillar: THREE.Mesh;
  pillarMat: THREE.MeshBasicMaterial;
  ring: THREE.Mesh;
  ringMat: THREE.MeshBasicMaterial;
  active: boolean;
}

const PILLAR_HEIGHT = 260;
const PILLAR_RADIUS = 3.2;

const COLOURS: Record<BeaconKind, number> = {
  crime: 0xffb703,
  villain: 0x9440bc,
};

/**
 * World-space objective beacons: a column of light rising from the ground with
 * a pulsing ring at its base.
 *
 * Screen-edge markers tell you a bearing but never a *place* — you cannot see
 * where the objective actually is until you are on top of it. A pillar anchored
 * to the ground is visible over the skyline from anywhere in the city and
 * resolves to an exact spot as you approach.
 */
export class Beacons {
  readonly group = new THREE.Group();

  private readonly pool: Beacon[] = [];
  private readonly disposables: Array<{ dispose(): void }> = [];
  private readonly pillarGeo: THREE.CylinderGeometry;
  private readonly ringGeo: THREE.RingGeometry;
  private time = 0;

  constructor(capacity = 6) {
    this.group.name = 'Beacons';

    // Open-ended cylinder rendered from inside and out, so it reads as a
    // volume of light rather than a solid post.
    this.pillarGeo = new THREE.CylinderGeometry(
      PILLAR_RADIUS * 0.45,
      PILLAR_RADIUS,
      PILLAR_HEIGHT,
      12,
      1,
      true,
    );
    this.ringGeo = new THREE.RingGeometry(4.5, 6.5, 32);
    this.ringGeo.rotateX(-Math.PI / 2);
    this.disposables.push(this.pillarGeo, this.ringGeo);

    for (let i = 0; i < capacity; i++) this.pool.push(this.create());
  }

  /**
   * Positions beacons for this frame. Any not supplied are hidden, so callers
   * simply pass the current objective list every frame.
   */
  set(targets: ReadonlyArray<{ position: THREE.Vector3; kind: BeaconKind }>): void {
    for (let i = 0; i < this.pool.length; i++) {
      const beacon = this.pool[i]!;
      const target = targets[i];

      if (!target) {
        if (beacon.active) {
          beacon.active = false;
          beacon.group.visible = false;
        }
        continue;
      }

      beacon.active = true;
      beacon.group.visible = true;
      beacon.group.position.copy(target.position);

      const colour = COLOURS[target.kind];
      beacon.pillarMat.color.setHex(colour);
      beacon.ringMat.color.setHex(colour);
    }
  }

  update(dt: number): void {
    this.time += dt;

    for (const beacon of this.pool) {
      if (!beacon.active) continue;

      // Slow breathing pulse, plus a ring that expands and fades.
      const pulse = 0.32 + Math.sin(this.time * 2.2) * 0.12;
      beacon.pillarMat.opacity = pulse;

      const ringPhase = (this.time * 0.6) % 1;
      beacon.ring.scale.setScalar(0.6 + ringPhase * 1.8);
      beacon.ringMat.opacity = (1 - ringPhase) * 0.7;
    }
  }

  dispose(): void {
    for (const d of this.disposables) d.dispose();
    this.disposables.length = 0;
    this.group.clear();
  }

  private create(): Beacon {
    const group = new THREE.Group();
    group.visible = false;

    const pillarMat = new THREE.MeshBasicMaterial({
      color: 0xffffff,
      transparent: true,
      opacity: 0.3,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      side: THREE.DoubleSide,
      toneMapped: false,
    });
    const pillar = new THREE.Mesh(this.pillarGeo, pillarMat);
    pillar.position.y = PILLAR_HEIGHT / 2;
    // The column spans the skyline; a bounding-sphere test would pop it out.
    pillar.frustumCulled = false;
    group.add(pillar);

    const ringMat = new THREE.MeshBasicMaterial({
      color: 0xffffff,
      transparent: true,
      opacity: 0.6,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      side: THREE.DoubleSide,
      toneMapped: false,
    });
    const ring = new THREE.Mesh(this.ringGeo, ringMat);
    ring.position.y = 0.4;
    group.add(ring);

    this.group.add(group);
    this.disposables.push(pillarMat, ringMat);
    return { group, pillar, pillarMat, ring, ringMat, active: false };
  }
}
