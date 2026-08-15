import * as THREE from 'three';
import { applyRimLight } from '../game/RimLight';
import { damp } from '../core/MathUtils';

/**
 * Street thug bodies.
 *
 * These were a capsule with a sphere balanced on it — which is, precisely, a
 * chess pawn, and they are the enemy the player sees far more than any boss.
 * A villain can carry detail because there is one of it; a thug has to carry
 * it in the silhouette, because there are eight and they are usually in
 * motion. So: real limbs on a real skeleton, three visibly different builds,
 * and a walk cycle, because a shape that slides along the ground reads as
 * scenery no matter how many polygons it has.
 *
 * Geometry and materials are created once by the factory and shared by every
 * thug. Each body is about a dozen small meshes over shared buffers, which is
 * cheap enough at the ten-or-so concurrent thugs the crime system spawns.
 */

export type ThugBuild = 'ENFORCER' | 'BRUTE' | 'GUNNER';

/** Everything the pose function needs to drive. */
export interface ThugRig {
  readonly root: THREE.Group;
  readonly torso: THREE.Group;
  readonly head: THREE.Group;
  readonly shoulderL: THREE.Group;
  readonly shoulderR: THREE.Group;
  readonly elbowL: THREE.Group;
  readonly elbowR: THREE.Group;
  readonly hipL: THREE.Group;
  readonly hipR: THREE.Group;
  readonly kneeL: THREE.Group;
  readonly kneeR: THREE.Group;
  /** Walk cycle position, advanced by `poseThug`. */
  phase: number;
}

interface Build {
  /** Overall body scale. */
  scale: number;
  /** Shoulder width multiplier — the main read between the three. */
  shoulders: number;
  /** Torso thickness. */
  bulk: number;
  /** Leg length multiplier. */
  legs: number;
  /** Forward hunch, radians. */
  hunch: number;
}

const BUILDS: Record<ThugBuild, Build> = {
  // Mid-weight, squared off, hands up.
  ENFORCER: { scale: 1, shoulders: 1, bulk: 1, legs: 1, hunch: 0.06 },
  // Wide, short-legged, heavy through the chest and arms. Overall size is
  // already handled by `thugs.brute.sizeScale` on the outer root, so this
  // only changes the *shape* — stacking a second scale here made them 2.6 m
  // tall, which reads as a different species rather than a big man.
  BRUTE: { scale: 1, shoulders: 1.34, bulk: 1.3, legs: 0.88, hunch: 0.17 },
  // Lean and upright, because they stand off and shoot.
  GUNNER: { scale: 0.96, shoulders: 0.86, bulk: 0.84, legs: 1.1, hunch: -0.02 },
};

/** Jacket colour per build. Trousers, boots and mask are shared. */
const JACKET: Record<ThugBuild, number> = {
  ENFORCER: 0x4a5568,
  BRUTE: 0x6b3f2e,
  GUNNER: 0x3d5a4a,
};

export class ThugFactory {
  private readonly disposables: Array<{ dispose(): void }>;

  private readonly torsoGeo: THREE.CapsuleGeometry;
  private readonly chestGeo: THREE.SphereGeometry;
  private readonly pelvisGeo: THREE.SphereGeometry;
  private readonly neckGeo: THREE.CylinderGeometry;
  private readonly headGeo: THREE.SphereGeometry;
  private readonly browGeo: THREE.BoxGeometry;
  private readonly upperArmGeo: THREE.CapsuleGeometry;
  private readonly foreArmGeo: THREE.CapsuleGeometry;
  private readonly handGeo: THREE.SphereGeometry;
  private readonly thighGeo: THREE.CapsuleGeometry;
  private readonly shinGeo: THREE.CapsuleGeometry;
  private readonly bootGeo: THREE.BoxGeometry;

  private readonly jackets = new Map<ThugBuild, THREE.MeshStandardMaterial>();
  private readonly dark: THREE.MeshStandardMaterial;
  private readonly mask: THREE.MeshStandardMaterial;
  private readonly visor: THREE.MeshBasicMaterial;

  constructor(disposables: Array<{ dispose(): void }>) {
    this.disposables = disposables;

    this.torsoGeo = new THREE.CapsuleGeometry(0.23, 0.42, 4, 10);
    this.chestGeo = new THREE.SphereGeometry(0.19, 10, 8);
    this.pelvisGeo = new THREE.SphereGeometry(0.18, 10, 8);
    this.neckGeo = new THREE.CylinderGeometry(0.075, 0.09, 0.1, 8);
    this.headGeo = new THREE.SphereGeometry(0.155, 12, 10);
    this.browGeo = new THREE.BoxGeometry(0.26, 0.062, 0.04);
    this.upperArmGeo = new THREE.CapsuleGeometry(0.068, 0.24, 3, 8);
    this.foreArmGeo = new THREE.CapsuleGeometry(0.058, 0.22, 3, 8);
    this.handGeo = new THREE.SphereGeometry(0.062, 8, 6);
    this.thighGeo = new THREE.CapsuleGeometry(0.087, 0.3, 3, 8);
    this.shinGeo = new THREE.CapsuleGeometry(0.072, 0.28, 3, 8);
    this.bootGeo = new THREE.BoxGeometry(0.15, 0.09, 0.24);

    this.dark = new THREE.MeshStandardMaterial({ color: 0x1e2430, roughness: 0.9, metalness: 0.08 });
    this.mask = new THREE.MeshStandardMaterial({ color: 0x14181f, roughness: 0.95, metalness: 0 });
    // Unlit so the eye band stays readable at night, which is when most of
    // the crime happens.
    this.visor = new THREE.MeshBasicMaterial({ color: 0xff8a5c, toneMapped: false });

    for (const build of ['ENFORCER', 'BRUTE', 'GUNNER'] as const) {
      const material = new THREE.MeshStandardMaterial({
        color: JACKET[build],
        roughness: 0.78,
        metalness: 0.12,
      });
      // The rim is what keeps a dark figure legible against a dark street.
      applyRimLight(material, 0xbfd4ff, 0.4, 2.8);
      this.jackets.set(build, material);
      this.disposables.push(material);
    }

    this.disposables.push(
      this.torsoGeo, this.chestGeo, this.pelvisGeo, this.neckGeo, this.headGeo,
      this.browGeo, this.upperArmGeo, this.foreArmGeo, this.handGeo,
      this.thighGeo, this.shinGeo, this.bootGeo,
      this.dark, this.mask, this.visor,
    );
  }

  /** The material a hit flash should tint. */
  jacketFor(build: ThugBuild): THREE.MeshStandardMaterial {
    return this.jackets.get(build)!;
  }

  create(build: ThugBuild): ThugRig {
    const spec = BUILDS[build];
    const jacket = this.jackets.get(build)!;

    const root = new THREE.Group();
    const torso = new THREE.Group();
    const head = new THREE.Group();
    const shoulderL = new THREE.Group();
    const shoulderR = new THREE.Group();
    const elbowL = new THREE.Group();
    const elbowR = new THREE.Group();
    const hipL = new THREE.Group();
    const hipR = new THREE.Group();
    const kneeL = new THREE.Group();
    const kneeR = new THREE.Group();

    root.scale.setScalar(spec.scale);

    // --- torso, hung from the hips so the walk cycle can bob it ------------
    // 0.79 puts the soles within a couple of centimetres of the root origin,
    // which is where ThugSystem.settle plants them on the ground.
    const hipHeight = 0.79 * spec.legs;
    torso.position.y = hipHeight;
    torso.rotation.x = spec.hunch;
    root.add(torso);

    const trunk = new THREE.Mesh(this.torsoGeo, jacket);
    trunk.position.y = 0.24;
    trunk.scale.set(spec.shoulders * 0.95, 1, spec.bulk);
    trunk.castShadow = true;
    torso.add(trunk);

    // Chest mass proud of the trunk, so the shoulders have somewhere to sit.
    for (const side of [-1, 1]) {
      const pec = new THREE.Mesh(this.chestGeo, jacket);
      pec.position.set(side * 0.1 * spec.shoulders, 0.4, 0.07 * spec.bulk);
      pec.scale.set(1.05 * spec.shoulders, 0.72, 0.66 * spec.bulk);
      torso.add(pec);
    }

    const pelvis = new THREE.Mesh(this.pelvisGeo, this.dark);
    pelvis.position.y = 0.02;
    pelvis.scale.set(1.05, 0.78, 0.86 * spec.bulk);
    torso.add(pelvis);

    // --- head, in a balaclava with an eye band ----------------------------
    head.position.y = 0.58;
    torso.add(head);

    const neck = new THREE.Mesh(this.neckGeo, this.mask);
    neck.position.y = -0.04;
    head.add(neck);

    const skull = new THREE.Mesh(this.headGeo, this.mask);
    skull.position.y = 0.1;
    skull.scale.set(0.96, 1.1, 1.02);
    skull.castShadow = true;
    head.add(skull);

    const band = new THREE.Mesh(this.browGeo, this.visor);
    band.position.set(0, 0.115, 0.13);
    head.add(band);

    // --- arms -------------------------------------------------------------
    const armY = 0.42;
    const armX = 0.2 * spec.shoulders;
    for (const [shoulder, elbow, side] of [
      [shoulderL, elbowL, 1],
      [shoulderR, elbowR, -1],
    ] as const) {
      shoulder.position.set(side * armX, armY, 0);
      torso.add(shoulder);

      const upper = new THREE.Mesh(this.upperArmGeo, jacket);
      upper.position.y = -0.14;
      upper.scale.setScalar(spec.bulk);
      upper.castShadow = true;
      shoulder.add(upper);

      elbow.position.y = -0.3;
      shoulder.add(elbow);

      const fore = new THREE.Mesh(this.foreArmGeo, this.dark);
      fore.position.y = -0.13;
      fore.scale.setScalar(spec.bulk);
      elbow.add(fore);

      const hand = new THREE.Mesh(this.handGeo, this.dark);
      hand.position.y = -0.28;
      elbow.add(hand);
    }

    // --- legs -------------------------------------------------------------
    for (const [hip, knee, side] of [
      [hipL, kneeL, 1],
      [hipR, kneeR, -1],
    ] as const) {
      hip.position.set(side * 0.11, 0, 0);
      torso.add(hip);

      const thigh = new THREE.Mesh(this.thighGeo, this.dark);
      thigh.position.y = -0.18 * spec.legs;
      thigh.scale.set(1, spec.legs, 1);
      thigh.castShadow = true;
      hip.add(thigh);

      knee.position.y = -0.38 * spec.legs;
      hip.add(knee);

      const shin = new THREE.Mesh(this.shinGeo, this.dark);
      shin.position.y = -0.17 * spec.legs;
      shin.scale.set(1, spec.legs, 1);
      knee.add(shin);

      const boot = new THREE.Mesh(this.bootGeo, this.mask);
      boot.position.set(0, -0.34 * spec.legs, 0.04);
      knee.add(boot);
    }

    return { root, torso, head, shoulderL, shoulderR, elbowL, elbowR, hipL, hipR, kneeL, kneeR, phase: 0 };
  }
}

/**
 * Drives the rig.
 *
 * `telegraph` and `swing` are 0..1 progress through the wind-up and the swing
 * respectively; both zero means "just moving". They are layered over the walk
 * rather than replacing it, so a thug closing on you while winding up still
 * has legs that work.
 */
export function poseThug(
  rig: ThugRig,
  dt: number,
  speed: number,
  telegraph: number,
  swing: number,
): void {
  // Stride rate rises with speed, but never stops entirely — a completely
  // frozen idle looks like a dropped frame.
  const gait = 1.4 + speed * 0.55;
  rig.phase += dt * gait;
  const stride = Math.min(1, speed / 4.5);
  const cycle = Math.sin(rig.phase);
  const counter = Math.cos(rig.phase);

  // Legs alternate; knees only ever bend one way.
  const swingAmount = 0.75 * stride;
  rig.hipL.rotation.x = damp(rig.hipL.rotation.x, cycle * swingAmount, 20, dt);
  rig.hipR.rotation.x = damp(rig.hipR.rotation.x, -cycle * swingAmount, 20, dt);
  rig.kneeL.rotation.x = damp(rig.kneeL.rotation.x, Math.max(0, -cycle) * 1.05 * stride, 20, dt);
  rig.kneeR.rotation.x = damp(rig.kneeR.rotation.x, Math.max(0, cycle) * 1.05 * stride, 20, dt);

  // Torso rolls against the arms on each stride.
  rig.torso.rotation.y = damp(rig.torso.rotation.y, counter * 0.12 * stride, 12, dt);

  if (telegraph > 0) {
    // Wind-up: fist cocked back over the shoulder, weight loaded onto the
    // back foot, body turned away. This is the readable tell the dodge window
    // is scored against, so it is deliberately large.
    const t = telegraph;
    rig.shoulderR.rotation.x = damp(rig.shoulderR.rotation.x, -0.5 - t * 1.9, 18, dt);
    rig.shoulderR.rotation.z = damp(rig.shoulderR.rotation.z, -0.3 - t * 0.5, 18, dt);
    rig.elbowR.rotation.x = damp(rig.elbowR.rotation.x, -1.5 - t * 0.6, 18, dt);
    rig.shoulderL.rotation.x = damp(rig.shoulderL.rotation.x, -0.7, 14, dt);
    rig.shoulderL.rotation.z = damp(rig.shoulderL.rotation.z, 0.55, 14, dt);
    rig.elbowL.rotation.x = damp(rig.elbowL.rotation.x, -1.4, 14, dt);
    rig.torso.rotation.y = damp(rig.torso.rotation.y, 0.55 * t, 16, dt);
    rig.head.rotation.x = damp(rig.head.rotation.x, -0.12, 12, dt);
    return;
  }

  if (swing > 0) {
    // The swing itself: fast out, and the torso comes round with it.
    const punch = swing < 0.4 ? swing / 0.4 : 1 - (swing - 0.4) / 0.6;
    rig.shoulderR.rotation.x = -0.6 - punch * 1.6;
    rig.shoulderR.rotation.z = -0.25 + punch * 0.2;
    rig.elbowR.rotation.x = -1.6 + punch * 1.5;
    rig.torso.rotation.y = 0.5 - punch * 1.1;
    rig.shoulderL.rotation.x = -0.5 + punch * 0.4;
    rig.head.rotation.x = 0;
    return;
  }

  // Guard: hands up, arms swinging opposite the legs.
  const armSwing = cycle * 0.5 * stride;
  rig.shoulderL.rotation.x = damp(rig.shoulderL.rotation.x, -0.35 - armSwing, 12, dt);
  rig.shoulderR.rotation.x = damp(rig.shoulderR.rotation.x, -0.35 + armSwing, 12, dt);
  rig.shoulderL.rotation.z = damp(rig.shoulderL.rotation.z, 0.3, 10, dt);
  rig.shoulderR.rotation.z = damp(rig.shoulderR.rotation.z, -0.3, 10, dt);
  rig.elbowL.rotation.x = damp(rig.elbowL.rotation.x, -0.85, 10, dt);
  rig.elbowR.rotation.x = damp(rig.elbowR.rotation.x, -0.85, 10, dt);
  rig.head.rotation.x = damp(rig.head.rotation.x, 0, 10, dt);
}
