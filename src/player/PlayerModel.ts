import * as THREE from 'three';
import type { HeroDef } from '../game/Heroes';
import { createEmblemMesh } from '../game/SpiderEmblem';
import { getSuitMaps, tiled } from '../game/SuitTextures';
import { applyRimLight } from '../game/RimLight';
import type { SuitDef } from '../game/Suits';
import { clamp, damp, dampAngle, dampVec3 } from '../core/MathUtils';
import { CONFIG } from '../core/Config';
import { PlayerState } from './PlayerState';

// Scratch used to build the wall-aligned orientation.
const _up = new THREE.Vector3();
const _forward = new THREE.Vector3();
const _right = new THREE.Vector3();
const _basis = new THREE.Matrix4();
const _targetQuat = new THREE.Quaternion();
const WORLD_UP = new THREE.Vector3(0, 1, 0);

/**
 * Resting height of the rig inside the physics sphere.
 *
 * The body is a sphere of radius CONFIG.physics.playerRadius centred on
 * `root`. With the reference-matched proportions the feet sit at local
 * y ~ -0.74, so this offset lands them on the bottom of that sphere.
 */
const RIG_BASE_Y = 0.12;
/** Belt height in body-local units — where the chest pivots on the hips. */
const WAIST_Y = 0.44;

export interface PoseContext {
  state: PlayerState;
  velocity: THREE.Vector3;
  /** World-space point the web is anchored to, if any. */
  anchor: THREE.Vector3 | null;
  /** Surface normal while wall-crawling. */
  wallNormal: THREE.Vector3 | null;
  /** Fallback facing when the player is barely moving. */
  cameraYaw: number;
  surgeActive: boolean;
  /** Which hit of the melee combo is playing, 0..2. */
  attackIndex: number;
  /** 0..1 through the current melee swing. */
  attackProgress: number;
  /** Accumulated air-trick rotation, radians. */
  trickSpin: number;
  /** 0..1 recent landing impact, drives the touchdown crouch. */
  landImpact: number;
  /** Seconds remaining on the gadget throw, 0 when not throwing. */
  throwTimer: number;
}

/**
 * A stylised, fully procedural character  -  primitives only, no external
 * models. Limbs are posed per state with exponential smoothing so transitions
 * read as animation rather than snapping.
 */
export class PlayerModel {
  readonly root = new THREE.Group();

  private readonly body = new THREE.Group();
  /**
   * Waist pivot, and the torso hung beneath it.
   *
   * Everything above the belt used to be parented straight to `body`, which
   * meant the only way to twist the chest was to rotate the entire figure —
   * legs, pelvis and all. That is why the melee combo read as hand gestures
   * rather than as punches: an arm can swing, but nothing behind it could
   * move, and a punch that does not come from the hips is not a punch. The
   * two groups cancel out to zero net offset, so every child keeps the local
   * coordinates it already had; `waist` simply gives them a pivot at belt
   * height to rotate around.
   */
  private readonly waist = new THREE.Group();
  private readonly torso = new THREE.Group();
  private readonly shoulderL = new THREE.Group();
  private readonly shoulderR = new THREE.Group();
  private readonly hipL = new THREE.Group();
  private readonly hipR = new THREE.Group();
  private readonly elbowL = new THREE.Group();
  private readonly elbowR = new THREE.Group();
  private readonly kneeL = new THREE.Group();
  private readonly kneeR = new THREE.Group();
  private readonly handAnchor = new THREE.Object3D();

  private readonly primaryMat: THREE.MeshPhysicalMaterial;
  private readonly secondaryMat: THREE.MeshPhysicalMaterial;
  /** Gloves and boots  -  a separate zone from the smooth mid-body. */
  private readonly accentMat: THREE.MeshPhysicalMaterial;
  private readonly eyeMat: THREE.MeshBasicMaterial;
  private readonly lensMat: THREE.MeshPhysicalMaterial;
  private readonly emblemMats: THREE.MeshBasicMaterial[] = [];

  private readonly disposables: Array<{ dispose(): void }> = [];
  private readonly scratch = new THREE.Vector3();
  private readonly aimTarget = new THREE.Vector3();
  /** Low-pass filtered velocity, used only for animation. */
  private readonly smoothedVelocity = new THREE.Vector3();

  private runPhase = 0;
  private facing = 0;
  private lean = 0;
  private baseColor = new THREE.Color();
  /** Baseline emissive from the equipped suit, before the surge pulse. */
  private suitGlow = 0;

  constructor(hero: HeroDef) {
    this.root.name = 'Player';

    // Procedural webbing: one shared pattern, tinted per body part, with a
    // matching normal + roughness map so the strands catch the light.
    const maps = getSuitMaps();
    const bodyMap = tiled(maps.web, 3, 3);
    const bodyNormal = tiled(maps.webNormal, 3, 3);
    const bodyRough = tiled(maps.webRough, 3, 3);
    const limbMap = tiled(maps.web, 1.5, 3);
    const limbNormal = tiled(maps.webNormal, 1.5, 3);
    this.disposables.push(bodyMap, bodyNormal, bodyRough, limbMap, limbNormal);

    this.primaryMat = new THREE.MeshPhysicalMaterial({
      color: hero.primary,
      map: bodyMap,
      normalMap: bodyNormal,
      normalScale: new THREE.Vector2(0.75, 0.75),
      roughnessMap: bodyRough,
      roughness: 0.52,
      metalness: 0.06,
      // A spandex suit has a soft specular sheen rather than a hard highlight.
      clearcoat: 0.55,
      clearcoatRoughness: 0.4,
      sheen: 0.5,
      sheenRoughness: 0.6,
      sheenColor: new THREE.Color(0xffffff),
    });
    // The mid-body zone is *smooth*  -  on the reference suit the webbing is
    // confined to the red areas and the blue is plain fabric.
    this.secondaryMat = new THREE.MeshPhysicalMaterial({
      color: hero.secondary,
      roughness: 0.62,
      metalness: 0.05,
      clearcoat: 0.4,
      clearcoatRoughness: 0.5,
      sheen: 0.45,
      sheenRoughness: 0.65,
    });
    // Gloves and boots carry the webbing, like the rest of the red.
    this.accentMat = new THREE.MeshPhysicalMaterial({
      color: hero.accent,
      map: limbMap,
      normalMap: limbNormal,
      normalScale: new THREE.Vector2(0.65, 0.65),
      roughness: 0.5,
      metalness: 0.08,
      clearcoat: 0.6,
      clearcoatRoughness: 0.38,
      sheen: 0.45,
    });
    this.eyeMat = new THREE.MeshBasicMaterial({ color: hero.eye, toneMapped: false });
    // Glossy black lens frame around the eyes.
    this.lensMat = new THREE.MeshPhysicalMaterial({
      color: 0x0a0a10,
      roughness: 0.18,
      metalness: 0.3,
      clearcoat: 1,
      clearcoatRoughness: 0.08,
    });
    this.disposables.push(
      this.primaryMat, this.secondaryMat, this.accentMat, this.eyeMat, this.lensMat,
    );

    // A bright edge where the surface turns away is the cue that reads as
    // "solid form". Without it, primitives look like separate objects.
    applyRimLight(this.primaryMat, 0xbcd6ff, 0.5);
    applyRimLight(this.secondaryMat, 0x9fc0ff, 0.45);
    applyRimLight(this.accentMat, 0xbcd6ff, 0.5);

    // Proportions taken from the reference turnaround. The old rig read as
    // roughly 4.7 heads tall  -  a cartoon build. A heroic figure is 7.5-8, so
    // the head shrinks hard and the limbs lengthen.
    const torsoGeo = new THREE.CapsuleGeometry(0.25, 0.54, 8, 20);
    const headGeo = new THREE.SphereGeometry(0.135, 24, 20);
    const neckGeo = new THREE.CylinderGeometry(0.072, 0.095, 0.12, 12);
    const upperArmGeo = new THREE.CapsuleGeometry(0.08, 0.3, 7, 20);
    const foreArmGeo = new THREE.CapsuleGeometry(0.068, 0.3, 7, 20);
    const thighGeo = new THREE.CapsuleGeometry(0.1, 0.34, 7, 20);
    const shinGeo = new THREE.CapsuleGeometry(0.08, 0.32, 7, 20);
    const eyeGeo = new THREE.SphereGeometry(0.062, 16, 12);
    const handGeo = new THREE.SphereGeometry(0.075, 16, 13);
    const footGeo = new THREE.SphereGeometry(0.085, 16, 13);
    // Boot cuff and glove cuff, so the accent zone has a visible edge.
    const bootGeo = new THREE.CapsuleGeometry(0.088, 0.16, 5, 16);
    const cuffGeo = new THREE.CapsuleGeometry(0.074, 0.12, 5, 16);
    this.disposables.push(
      torsoGeo, headGeo, neckGeo, upperArmGeo, foreArmGeo,
      thighGeo, shinGeo, eyeGeo, handGeo, footGeo, bootGeo, cuffGeo,
    );

    // Waist pivot at belt height, with the torso hung back down by the same
    // amount: net zero offset, but now the chest can turn on the hips.
    this.waist.position.y = WAIST_Y;
    this.torso.position.y = -WAIST_Y;
    this.waist.add(this.torso);
    this.body.add(this.waist);

    // Torso: red chest over a smooth mid-body band. The taper is what sells a
    // heroic build - broad across the chest, narrow at the waist.
    const torso = new THREE.Mesh(torsoGeo, this.primaryMat);
    torso.position.y = 0.66;
    torso.scale.set(1.14, 1, 0.86);
    torso.castShadow = true;
    this.torso.add(torso);

    // Pectoral mass, sitting proud of the chest.
    const pecGeo = new THREE.SphereGeometry(0.14, 18, 14);
    for (const side of [-1, 1]) {
      const pec = new THREE.Mesh(pecGeo, this.primaryMat);
      pec.position.set(side * 0.11, 0.79, 0.14);
      pec.scale.set(1.1, 0.82, 0.7);
      this.torso.add(pec);
    }

    // Lat spread just under the arms, tapering into the waist.
    const latGeo = new THREE.SphereGeometry(0.17, 18, 14);
    for (const side of [-1, 1]) {
      const lat = new THREE.Mesh(latGeo, this.primaryMat);
      lat.position.set(side * 0.2, 0.68, -0.02);
      lat.scale.set(0.7, 1.15, 0.72);
      this.torso.add(lat);
    }

    const midriff = new THREE.Mesh(torsoGeo, this.secondaryMat);
    midriff.position.y = 0.42;
    midriff.scale.set(0.92, 0.42, 0.82);
    this.torso.add(midriff);

    // Hip block, so the legs read as attached to something.
    const hipGeo = new THREE.SphereGeometry(0.2, 18, 14);
    const pelvis = new THREE.Mesh(hipGeo, this.secondaryMat);
    pelvis.position.y = 0.29;
    pelvis.scale.set(1.05, 0.72, 0.82);
    this.body.add(pelvis);

    this.disposables.push(pecGeo, latGeo, hipGeo);

    const neck = new THREE.Mesh(neckGeo, this.primaryMat);
    neck.position.y = 0.955;
    this.torso.add(neck);

    const head = new THREE.Mesh(headGeo, this.primaryMat);
    head.position.y = 1.1;
    // Slightly ovoid, like a mask over a skull rather than a ball.
    head.scale.set(0.98, 1.12, 1.04);
    head.castShadow = true;
    this.torso.add(head);

    // Brow ridge and a tapered jaw, so the mask has structure in profile
    // rather than reading as a sphere.
    const browGeo = new THREE.SphereGeometry(0.115, 16, 13);
    const brow = new THREE.Mesh(browGeo, this.primaryMat);
    brow.position.set(0, 1.16, 0.05);
    brow.scale.set(1.05, 0.55, 1);
    this.torso.add(brow);

    const jawGeo = new THREE.SphereGeometry(0.105, 16, 13);
    const jaw = new THREE.Mesh(jawGeo, this.primaryMat);
    jaw.position.set(0, 1.02, 0.03);
    jaw.scale.set(0.95, 0.85, 1.05);
    this.torso.add(jaw);
    this.disposables.push(browGeo, jawGeo);

    for (const side of [-1, 1]) {
      // Black lens surround, then the bright lens inset into it  -  the
      // reference lenses read as white shapes outlined in black.
      const frame = new THREE.Mesh(eyeGeo, this.lensMat);
      frame.scale.set(1.55, 1.1, 0.6);
      frame.position.set(side * 0.058, 1.115, 0.105);
      frame.rotation.z = side * -0.3;
      this.torso.add(frame);

      const eye = new THREE.Mesh(eyeGeo, this.eyeMat);
      eye.scale.set(1.28, 0.86, 0.5);
      eye.position.set(side * 0.057, 1.115, 0.115);
      eye.rotation.z = side * -0.3;
      this.torso.add(eye);
    }

    // Spider emblem, front and back.
    const chest = createEmblemMesh(hero.emblem, 0.3);
    chest.position.set(0, 0.68, 0.248);
    this.torso.add(chest);
    const back = createEmblemMesh(hero.emblem, 0.27);
    back.position.set(0, 0.68, -0.248);
    back.rotation.y = Math.PI;
    this.torso.add(back);
    for (const mesh of [chest, back]) {
      const mat = mesh.material as THREE.MeshBasicMaterial;
      this.emblemMats.push(mat);
      this.disposables.push(mat, mesh.geometry);
    }

    // Arms: shoulder -> upper arm -> elbow -> forearm.
    const deltGeo = new THREE.SphereGeometry(0.115, 16, 13);
    const bicepGeo = new THREE.SphereGeometry(0.085, 14, 11);
    this.disposables.push(deltGeo, bicepGeo);

    const buildArm = (shoulder: THREE.Group, elbow: THREE.Group, side: number): void => {
      shoulder.position.set(side * 0.295, 0.88, 0);

      // Deltoid cap, parented to the shoulder so it swings with the arm.
      const delt = new THREE.Mesh(deltGeo, this.primaryMat);
      delt.position.y = -0.03;
      delt.scale.set(1, 0.95, 1);
      delt.castShadow = true;
      shoulder.add(delt);

      // Upper arm stays red/webbed.
      const upper = new THREE.Mesh(upperArmGeo, this.primaryMat);
      upper.position.y = -0.235;
      upper.castShadow = true;
      shoulder.add(upper);

      const bicep = new THREE.Mesh(bicepGeo, this.primaryMat);
      bicep.position.set(0, -0.19, 0.02);
      bicep.scale.set(1, 1.25, 1);
      shoulder.add(bicep);

      elbow.position.y = -0.47;
      // Forearm is the glove on the reference suit  -  accent, not mid-body.
      const fore = new THREE.Mesh(foreArmGeo, this.accentMat);
      fore.position.y = -0.235;
      fore.castShadow = true;
      elbow.add(fore);

      const cuff = new THREE.Mesh(cuffGeo, this.accentMat);
      cuff.position.y = -0.08;
      elbow.add(cuff);

      // Gloved hand  -  limbs previously just stopped in mid-air.
      const hand = new THREE.Mesh(handGeo, this.accentMat);
      hand.position.y = -0.47;
      hand.scale.set(0.85, 1.15, 0.62);
      elbow.add(hand);

      shoulder.add(elbow);
      this.torso.add(shoulder);
    };
    // The rig faces +Z with +Y up, so in a right-handed system the character's
    // own left is +X. Getting this backwards mirrors every pose and, more
    // importantly, fires the web from the wrong hand.
    buildArm(this.shoulderL, this.elbowL, 1);
    buildArm(this.shoulderR, this.elbowR, -1);

    // The web fires from the right hand.
    this.handAnchor.position.y = -0.46;
    this.elbowR.add(this.handAnchor);

    // Legs: hip -> thigh -> knee -> shin.
    const quadGeo = new THREE.SphereGeometry(0.115, 14, 11);
    const calfGeo = new THREE.SphereGeometry(0.092, 10, 8);
    this.disposables.push(quadGeo, calfGeo);

    const buildLeg = (hip: THREE.Group, knee: THREE.Group, side: number): void => {
      // Wide enough that the thighs (0.1 radius each) clear one another --
      // at 0.135 apart they overlapped and read as crossed legs.
      hip.position.set(side * 0.175, 0.3, 0);
      // Thigh and shin stay in the smooth mid-body colour.
      const thigh = new THREE.Mesh(thighGeo, this.secondaryMat);
      thigh.position.y = -0.25;
      thigh.castShadow = true;
      hip.add(thigh);

      // Quadriceps mass on the front of the thigh.
      const quad = new THREE.Mesh(quadGeo, this.secondaryMat);
      quad.position.set(0, -0.2, 0.03);
      quad.scale.set(1, 1.5, 0.95);
      hip.add(quad);

      knee.position.y = -0.48;
      const shin = new THREE.Mesh(shinGeo, this.secondaryMat);
      shin.position.y = -0.24;
      shin.castShadow = true;
      knee.add(shin);

      // Calf, biased to the back of the leg.
      const calf = new THREE.Mesh(calfGeo, this.secondaryMat);
      calf.position.set(0, -0.16, -0.03);
      calf.scale.set(1, 1.45, 1);
      knee.add(calf);

      // Boot: accent-coloured cuff over the lower shin, then the foot.
      const boot = new THREE.Mesh(bootGeo, this.accentMat);
      boot.position.y = -0.42;
      boot.castShadow = true;
      knee.add(boot);

      const foot = new THREE.Mesh(footGeo, this.accentMat);
      foot.position.set(0, -0.54, 0.055);
      foot.scale.set(0.88, 0.6, 1.55);
      knee.add(foot);

      hip.add(knee);
      this.body.add(hip);
    };
    buildLeg(this.hipL, this.kneeL, 1);
    buildLeg(this.hipR, this.kneeR, -1);

    // The physics body is a sphere of radius CONFIG.physics.playerRadius
    // centred on `root`. Offset the rig so the feet land on the sphere's
    // bottom rather than floating above or sinking into it. Feet now sit at
    // local y ~ -0.74 after the proportion change.
    this.body.position.y = RIG_BASE_Y;
    this.root.add(this.body);
    this.baseColor.setHex(hero.primary);
  }

  setHero(hero: HeroDef): void {
    this.applyLook(
      hero.primary, hero.secondary, hero.accent, hero.eye, hero.emblem,
      'web', 0.06, 0.55, 0,
    );
  }

  /** Applies a full suit definition: colours, pattern and surface response. */
  setSuit(suit: SuitDef): void {
    this.applyLook(
      suit.primary,
      suit.secondary,
      suit.accent,
      suit.eye,
      suit.emblem,
      suit.pattern,
      suit.metalness,
      suit.clearcoat,
      suit.glow,
    );
  }

  private applyLook(
    primary: number,
    secondary: number,
    accent: number,
    eye: number,
    emblem: number,
    pattern: 'web' | 'panel',
    metalness: number,
    clearcoat: number,
    glow: number,
  ): void {
    this.primaryMat.color.setHex(primary);
    this.secondaryMat.color.setHex(secondary);
    this.accentMat.color.setHex(accent);
    this.eyeMat.color.setHex(eye);
    for (const mat of this.emblemMats) mat.color.setHex(emblem);
    this.baseColor.setHex(primary);
    this.suitGlow = glow;

    const maps = getSuitMaps();
    const webbed = pattern === 'web';
    const albedo = webbed ? maps.web : maps.panel;
    const normal = webbed ? maps.webNormal : maps.panelNormal;

    // Only the webbed zones get the pattern; the mid-body stays smooth.
    for (const [material, u, v] of [
      [this.primaryMat, 3, 3] as const,
      [this.accentMat, 1.5, 3] as const,
    ]) {
      const nextMap = tiled(albedo, u, v);
      const nextNormal = tiled(normal, u, v);
      material.map?.dispose();
      material.normalMap?.dispose();
      material.map = nextMap;
      material.normalMap = nextNormal;
      material.metalness = metalness;
      material.clearcoat = clearcoat;
      material.needsUpdate = true;
      this.disposables.push(nextMap, nextNormal);
    }
    this.secondaryMat.metalness = metalness;
    this.secondaryMat.clearcoat = clearcoat * 0.75;
    this.secondaryMat.needsUpdate = true;
  }

  /** World position of the right hand  -  where the web line originates. */
  getHandPosition(out: THREE.Vector3): THREE.Vector3 {
    this.handAnchor.getWorldPosition(out);
    return out;
  }

  update(dt: number, ctx: PoseContext): void {
    // Animation reads a *smoothed* velocity. The raw value is recomputed every
    // substep from two positions, so collision push-out and the web constraint
    // inject high-frequency noise that shows up as facing and lean jitter.
    dampVec3(this.smoothedVelocity, ctx.velocity, 11, dt);
    const v = this.smoothedVelocity;
    const speed = v.length();
    const horizSpeed = Math.hypot(v.x, v.z);

    // Channels only some poses drive would otherwise keep a stale value —
    // hip roll from a wall crawl persisting into a run, for instance. Ease
    // them home first; any pose that cares overwrites immediately after.
    this.hipL.rotation.z = damp(this.hipL.rotation.z, 0, 8, dt);
    this.hipR.rotation.z = damp(this.hipR.rotation.z, 0, 8, dt);
    this.elbowL.rotation.z = damp(this.elbowL.rotation.z, 0, 8, dt);
    this.elbowR.rotation.z = damp(this.elbowR.rotation.z, 0, 8, dt);

    // On a wall the rig is built from the surface basis rather than from yaw
    // and pitch. Euler angles could never lay the chest flat against an
    // arbitrary facade, which is exactly why it read as floating.
    const onWall =
      (ctx.state === PlayerState.WallCrawl || ctx.state === PlayerState.WallRun) &&
      ctx.wallNormal !== null;

    if (onWall && ctx.wallNormal) {
      const n = ctx.wallNormal;

      // Character up: world up flattened onto the wall plane.
      _up.set(0, 1, 0).addScaledVector(n, -n.y);
      if (_up.lengthSq() < 1e-6) _up.set(0, 0, 1);
      _up.normalize();

      // Chest (+Z on this rig) faces into the wall.
      _forward.copy(n).multiplyScalar(-1);
      _right.crossVectors(_up, _forward).normalize();
      _basis.makeBasis(_right, _up, _forward);
      _targetQuat.setFromRotationMatrix(_basis);

      // Ease in so arriving from a swing does not snap.
      this.root.quaternion.slerp(_targetQuat, 1 - Math.exp(-14 * dt));
      this.facing = Math.atan2(-n.x, -n.z);

      // Press the body into the wall so the chest contacts it rather than
      // hovering a collision radius away.
      this.body.position.z = damp(this.body.position.z, 0.3, 12, dt);
      this.lean = damp(this.lean, 0, 12, dt);
      this.body.rotation.x = this.lean;
      this.body.rotation.y = damp(this.body.rotation.y, 0, 14, dt);
      this.settleWaist(dt);
    } else {
      // Facing: follow motion when moving, otherwise settle behind the camera.
      const targetFacing = horizSpeed > 1.2 ? Math.atan2(v.x, v.z) : ctx.cameraYaw;
      this.facing = dampAngle(this.facing, targetFacing, 9, dt);
      this.root.quaternion.setFromAxisAngle(WORLD_UP, this.facing);
      this.body.position.z = damp(this.body.position.z, 0, 10, dt);

      if (ctx.state === PlayerState.Attacking) {
        this.lean = damp(this.lean, 0.25, 18, dt);
      } else {
        const targetLean =
          ctx.state === PlayerState.Striking ? 1.15 : clamp(speed / 90, 0, 1) * 0.85;
        this.lean = damp(this.lean, targetLean, 7, dt);
      }
      this.body.rotation.x = this.lean;
      // Only the melee poses drive body yaw and the waist; everything else
      // keeps them centred.
      if (ctx.state !== PlayerState.Attacking) {
        this.body.rotation.y = damp(this.body.rotation.y, 0, 14, dt);
        this.settleWaist(dt);
      }
    }

    switch (ctx.state) {
      case PlayerState.Running:
        this.poseRun(dt, horizSpeed);
        break;
      case PlayerState.Swinging:
        this.poseSwing(dt, ctx);
        break;
      case PlayerState.WallCrawl:
      case PlayerState.WallRun:
        this.poseCrawl(dt);
        break;
      case PlayerState.Striking:
        this.poseStrike(dt);
        break;
      case PlayerState.Attacking:
        this.poseAttack(ctx.attackIndex, ctx.attackProgress);
        break;
      case PlayerState.Dodging:
        this.poseDodge(dt);
        break;
      case PlayerState.Airborne:
      default:
        this.poseAir(dt, speed);
        break;
    }

    // Overhand throw, layered over whatever pose is playing so a gadget can be
    // thrown while running or falling.
    if (ctx.throwTimer > 0) {
      const t = 1 - ctx.throwTimer / CONFIG.combat.throwDuration;
      const swing = Math.sin(clamp(t, 0, 1) * Math.PI);
      this.shoulderR.rotation.x = -2.7 + swing * 2.2;
      this.shoulderR.rotation.z = -0.25;
      this.elbowR.rotation.x = -1.5 + swing * 1.3;
    }

    // Touchdown crouch: absorb the landing by dropping and folding the knees.
    // Layered on top of whatever pose is playing rather than replacing it.
    if (ctx.landImpact > 0.01) {
      const squash = ctx.landImpact;
      this.body.position.y = RIG_BASE_Y - squash * 0.34;
      this.hipL.rotation.x -= squash * 0.75;
      this.hipR.rotation.x -= squash * 0.75;
      this.kneeL.rotation.x += squash * 1.35;
      this.kneeR.rotation.x += squash * 1.35;
      this.shoulderL.rotation.z += squash * 0.4;
      this.shoulderR.rotation.z -= squash * 0.4;
    } else if (ctx.state === PlayerState.Running || ctx.state === PlayerState.Sprinting) {
      // Idle breathing  -  a slow rise and fall when barely moving.
      const idle = 1 - clamp(speed / 6, 0, 1);
      const breath = Math.sin(performance.now() * 0.0021) * 0.014 * idle;
      this.body.position.y = damp(this.body.position.y, RIG_BASE_Y + breath, 10, dt);
    } else if (ctx.state !== PlayerState.Attacking) {
      // Attacking is excluded because poseAttack drives the body height
      // itself — dropping into a punch and into a kick are different amounts,
      // and damping back to the base every frame flattened both of them.
      this.body.position.y = damp(this.body.position.y, RIG_BASE_Y, 9, dt);
    }

    // Air tricks: spin the whole body around its forward axis.
    if (ctx.state === PlayerState.Trick) {
      this.body.rotation.z = ctx.trickSpin;
    } else {
      this.body.rotation.z = damp(this.body.rotation.z, 0, 12, dt);
    }

    // Surge tint over the suit's own baseline glow.
    const pulse = ctx.surgeActive ? 0.55 + Math.sin(performance.now() * 0.012) * 0.25 : 0;
    const level = Math.max(pulse, this.suitGlow);
    this.primaryMat.emissive.setRGB(level * 0.35, level * 0.08, level * 0.4);
    this.secondaryMat.emissive.setRGB(
      this.suitGlow * 0.5,
      this.suitGlow * 0.35,
      this.suitGlow * 0.15,
    );
  }

  dispose(): void {
    for (const d of this.disposables) d.dispose();
    this.disposables.length = 0;
  }

  // -------------------------------------------------------------- poses

  private poseRun(dt: number, speed: number): void {
    // Stride rate follows ground speed so the feet do not skate.
    this.runPhase += dt * clamp(speed * 0.9, 3, 22);
    const swing = Math.sin(this.runPhase) * 0.95;
    const counter = Math.sin(this.runPhase + Math.PI) * 0.7;

    this.hipL.rotation.x = damp(this.hipL.rotation.x, swing, 22, dt);
    this.hipR.rotation.x = damp(this.hipR.rotation.x, -swing, 22, dt);
    this.kneeL.rotation.x = damp(this.kneeL.rotation.x, Math.max(0, -swing) * 1.1, 22, dt);
    this.kneeR.rotation.x = damp(this.kneeR.rotation.x, Math.max(0, swing) * 1.1, 22, dt);

    this.shoulderL.rotation.x = damp(this.shoulderL.rotation.x, -swing * 0.8, 18, dt);
    this.shoulderR.rotation.x = damp(this.shoulderR.rotation.x, swing * 0.8, 18, dt);
    this.shoulderL.rotation.z = damp(this.shoulderL.rotation.z, 0.18, 12, dt);
    this.shoulderR.rotation.z = damp(this.shoulderR.rotation.z, -0.18, 12, dt);
    this.elbowL.rotation.x = damp(this.elbowL.rotation.x, -0.75 + counter * 0.2, 14, dt);
    this.elbowR.rotation.x = damp(this.elbowR.rotation.x, -0.75 - counter * 0.2, 14, dt);
  }

  private poseAir(dt: number, speed: number): void {
    const tuck = clamp(speed / 70, 0, 1);
    this.hipL.rotation.x = damp(this.hipL.rotation.x, -0.5 - tuck * 0.5, 8, dt);
    this.hipR.rotation.x = damp(this.hipR.rotation.x, -0.15, 8, dt);
    this.kneeL.rotation.x = damp(this.kneeL.rotation.x, 1.1 + tuck * 0.5, 8, dt);
    this.kneeR.rotation.x = damp(this.kneeR.rotation.x, 0.35, 8, dt);

    this.shoulderL.rotation.x = damp(this.shoulderL.rotation.x, 1.5, 8, dt);
    this.shoulderR.rotation.x = damp(this.shoulderR.rotation.x, 1.2, 8, dt);
    this.shoulderL.rotation.z = damp(this.shoulderL.rotation.z, 0.6, 8, dt);
    this.shoulderR.rotation.z = damp(this.shoulderR.rotation.z, -0.75, 8, dt);
    this.elbowL.rotation.x = damp(this.elbowL.rotation.x, -0.5, 8, dt);
    this.elbowR.rotation.x = damp(this.elbowR.rotation.x, -0.4, 8, dt);
  }

  private poseSwing(dt: number, ctx: PoseContext): void {
    // Right arm reaches for the anchor: convert the world direction into the
    // body's local frame and drive the shoulder from it.
    let pitch = -2.2;
    let roll = -0.35;
    if (ctx.anchor) {
      this.root.worldToLocal(this.aimTarget.copy(ctx.anchor));
      const dir = this.scratch.copy(this.aimTarget).normalize();
      pitch = -Math.PI + Math.atan2(dir.z, dir.y);
      roll = -clamp(dir.x, -1, 1) * 0.9;
      pitch = clamp(pitch, -2.9, -1.2);
    }

    this.shoulderR.rotation.x = damp(this.shoulderR.rotation.x, pitch, 12, dt);
    this.shoulderR.rotation.z = damp(this.shoulderR.rotation.z, roll, 12, dt);
    this.elbowR.rotation.x = damp(this.elbowR.rotation.x, -0.25, 12, dt);

    this.shoulderL.rotation.x = damp(this.shoulderL.rotation.x, 0.9, 9, dt);
    this.shoulderL.rotation.z = damp(this.shoulderL.rotation.z, 0.95, 9, dt);
    this.elbowL.rotation.x = damp(this.elbowL.rotation.x, -0.8, 9, dt);

    // Legs trail with a slight scissor.
    const scissor = Math.sin(performance.now() * 0.0022) * 0.25;
    this.hipL.rotation.x = damp(this.hipL.rotation.x, -0.85 + scissor, 7, dt);
    this.hipR.rotation.x = damp(this.hipR.rotation.x, -0.5 - scissor, 7, dt);
    this.kneeL.rotation.x = damp(this.kneeL.rotation.x, 1.25, 7, dt);
    this.kneeR.rotation.x = damp(this.kneeR.rotation.x, 0.5, 7, dt);
  }

  private poseCrawl(dt: number): void {
    this.runPhase += dt * 6;
    const cycle = Math.sin(this.runPhase);
    this.shoulderL.rotation.x = damp(this.shoulderL.rotation.x, -1.5 + cycle * 0.4, 10, dt);
    this.shoulderR.rotation.x = damp(this.shoulderR.rotation.x, -1.5 - cycle * 0.4, 10, dt);
    this.shoulderL.rotation.z = damp(this.shoulderL.rotation.z, 0.95, 10, dt);
    this.shoulderR.rotation.z = damp(this.shoulderR.rotation.z, -0.95, 10, dt);
    this.elbowL.rotation.x = damp(this.elbowL.rotation.x, -0.6, 10, dt);
    this.elbowR.rotation.x = damp(this.elbowR.rotation.x, -0.6, 10, dt);

    this.hipL.rotation.x = damp(this.hipL.rotation.x, 0.5 - cycle * 0.4, 10, dt);
    this.hipR.rotation.x = damp(this.hipR.rotation.x, 0.5 + cycle * 0.4, 10, dt);
    this.hipL.rotation.z = damp(this.hipL.rotation.z, 0.55, 10, dt);
    this.hipR.rotation.z = damp(this.hipR.rotation.z, -0.55, 10, dt);
    this.kneeL.rotation.x = damp(this.kneeL.rotation.x, -1.1, 10, dt);
    this.kneeR.rotation.x = damp(this.kneeR.rotation.x, -1.1, 10, dt);
  }

  /**
   * Three-hit melee combo. Driven directly by swing progress rather than
   * smoothed, so the hits read as sharp and land on the damage frame:
   * 0 = right jab, 1 = left cross, 2 = spinning right kick.
   */
  private poseAttack(index: number, progress: number): void {
    // Two curves, not one. `punch` is the fast-out/slow-back arc the limb
    // travels; `wind` is a small negative lobe just before it, which is the
    // cock-back — a strike with no anticipation reads as a twitch no matter
    // how far the arm travels.
    const t = progress < 0.45 ? progress / 0.45 : 1 - (progress - 0.45) / 0.55;
    const punch = t * t * (3 - 2 * t);
    const wind = progress < 0.28 ? Math.sin((progress / 0.28) * Math.PI) : 0;

    // Reset the limbs this pose does not drive.
    this.hipL.rotation.z = 0;
    this.hipR.rotation.z = 0;

    if (index === 2) {
      // --- spinning right kick ---------------------------------------------
      // The whole figure turns, because a spin kick is a spin. The chest leads
      // the hips into it and the body drops as the leg comes round.
      this.body.rotation.y = punch * 2.6 - wind * 0.5;
      this.waist.rotation.y = punch * 0.5;
      this.waist.rotation.x = punch * 0.34;
      this.body.position.y = RIG_BASE_Y - punch * 0.16;
      this.body.position.z = punch * 0.3;

      // Right leg whips out horizontally at the peak; support leg bends.
      this.hipR.rotation.x = wind * 0.6 - punch * 2.15;
      this.hipR.rotation.z = -punch * 0.55;
      this.kneeR.rotation.x = 1.5 - punch * 1.45;
      this.hipL.rotation.x = punch * 0.55;
      this.kneeL.rotation.x = 0.3 + punch * 0.55;

      // Arms counterbalance: one tucks in tight, the other trails.
      this.shoulderL.rotation.x = -0.6 - punch * 1.1;
      this.shoulderR.rotation.x = -0.4 + punch * 1.2;
      this.shoulderL.rotation.z = 0.9 - punch * 0.35;
      this.shoulderR.rotation.z = -0.9 + punch * 0.4;
      this.elbowL.rotation.x = -1.9 + punch * 0.5;
      this.elbowR.rotation.x = -1.1;
      return;
    }

    // --- straight punches ---------------------------------------------------
    const lead = index === 0 ? 1 : -1; // right jab, then left cross

    // The power comes from the floor up: hips turn, chest turns further, and
    // the whole body steps into it. The arm is the last thing to arrive.
    this.body.rotation.y = -lead * (punch * 0.55 - wind * 0.3);
    this.waist.rotation.y = -lead * (punch * 0.72 - wind * 0.45);
    this.waist.rotation.x = punch * 0.3 - wind * 0.16;
    this.body.position.z = punch * 0.26 - wind * 0.1;
    this.body.position.y = RIG_BASE_Y - punch * 0.07;

    const leadShoulder = lead > 0 ? this.shoulderR : this.shoulderL;
    const leadElbow = lead > 0 ? this.elbowR : this.elbowL;
    const offShoulder = lead > 0 ? this.shoulderL : this.shoulderR;
    const offElbow = lead > 0 ? this.elbowL : this.elbowR;

    // Lead arm: cocked back, then fully extended level with the shoulder.
    leadShoulder.rotation.x = -1.25 + wind * 0.75 - punch * 1.5;
    leadShoulder.rotation.z = -lead * (0.4 - punch * 0.38);
    leadElbow.rotation.x = -1.55 - wind * 0.5 + punch * 1.5;

    // Off arm stays cocked as a guard and pulls back as the lead goes out —
    // the counter-rotation is most of what makes the hit look like it lands.
    offShoulder.rotation.x = -0.85 + punch * 0.55;
    offShoulder.rotation.z = lead * (0.5 + punch * 0.2);
    offElbow.rotation.x = -1.5 - punch * 0.35;

    // Weight rolls onto the front foot and the back foot pivots out.
    this.hipL.rotation.x = -0.3 - punch * 0.34 * lead;
    this.hipR.rotation.x = -0.3 + punch * 0.34 * lead;
    this.kneeL.rotation.x = 0.4 + punch * 0.2;
    this.kneeR.rotation.x = 0.4 + punch * 0.2;
  }

  /** Unwinds the chest back to square. Only the melee poses ever twist it. */
  private settleWaist(dt: number): void {
    this.waist.rotation.y = damp(this.waist.rotation.y, 0, 14, dt);
    this.waist.rotation.x = damp(this.waist.rotation.x, 0, 14, dt);
  }

  private poseDodge(dt: number): void {
    this.shoulderL.rotation.x = damp(this.shoulderL.rotation.x, -0.4, 22, dt);
    this.shoulderR.rotation.x = damp(this.shoulderR.rotation.x, -0.4, 22, dt);
    this.shoulderL.rotation.z = damp(this.shoulderL.rotation.z, 1.25, 22, dt);
    this.shoulderR.rotation.z = damp(this.shoulderR.rotation.z, -1.25, 22, dt);
    this.elbowL.rotation.x = damp(this.elbowL.rotation.x, -1.4, 22, dt);
    this.elbowR.rotation.x = damp(this.elbowR.rotation.x, -1.4, 22, dt);
    this.hipL.rotation.x = damp(this.hipL.rotation.x, -0.8, 22, dt);
    this.hipR.rotation.x = damp(this.hipR.rotation.x, -0.5, 22, dt);
    this.kneeL.rotation.x = damp(this.kneeL.rotation.x, 1.4, 22, dt);
    this.kneeR.rotation.x = damp(this.kneeR.rotation.x, 1.0, 22, dt);
  }

  private poseStrike(dt: number): void {
    // Superman punch: both fists forward, legs streamlined.
    this.shoulderL.rotation.x = damp(this.shoulderL.rotation.x, -2.5, 18, dt);
    this.shoulderR.rotation.x = damp(this.shoulderR.rotation.x, -2.5, 18, dt);
    this.shoulderL.rotation.z = damp(this.shoulderL.rotation.z, 0.12, 18, dt);
    this.shoulderR.rotation.z = damp(this.shoulderR.rotation.z, -0.12, 18, dt);
    this.elbowL.rotation.x = damp(this.elbowL.rotation.x, -0.1, 18, dt);
    this.elbowR.rotation.x = damp(this.elbowR.rotation.x, -0.1, 18, dt);

    this.hipL.rotation.x = damp(this.hipL.rotation.x, -0.35, 14, dt);
    this.hipR.rotation.x = damp(this.hipR.rotation.x, -0.2, 14, dt);
    this.kneeL.rotation.x = damp(this.kneeL.rotation.x, 0.5, 14, dt);
    this.kneeR.rotation.x = damp(this.kneeR.rotation.x, 0.25, 14, dt);
  }
}

