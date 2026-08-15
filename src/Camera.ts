import * as THREE from 'three';
import { CONFIG } from './core/Config';
import { clamp, damp, dampVec3, smoothstep } from './core/MathUtils';
import type { City } from './world/City';

const _desired = new THREE.Vector3();
const _focus = new THREE.Vector3();
const _dir = new THREE.Vector3();
const _flat = new THREE.Vector3();

/**
 * Third-person chase camera.
 *
 * Yaw convention (shared with `Player.computeWish`):
 *     forward = (-sin(yaw), 0, -cos(yaw))
 * so yaw = 0 looks down -Z, matching Three.js' default camera orientation.
 */
export class ChaseCamera {
  readonly camera: THREE.PerspectiveCamera;

  yaw = 0;
  pitch = 0.12;
  /** Resting field of view, overridable from the settings screen. */
  baseFov: number = CONFIG.camera.fovBase;

  private readonly position = new THREE.Vector3();
  private readonly lookAt = new THREE.Vector3();
  private readonly forwardVec = new THREE.Vector3(0, 0, -1);
  private readonly prevHeading = new THREE.Vector3(0, 0, -1);
  // Annotated so the `as const` config literal doesn't pin the field type.
  private fov: number = CONFIG.camera.fovBase;
  private roll = 0;
  private initialised = false;
  /** Current shake energy, 0..1.5, decaying every frame. */
  private shake = 0;
  private readonly shakeOffset = new THREE.Vector3();

  constructor(aspect: number) {
    this.camera = new THREE.PerspectiveCamera(
      CONFIG.camera.fovBase,
      aspect,
      CONFIG.camera.near,
      CONFIG.camera.far,
    );
  }

  /** Applies accumulated look input. Call once per frame, before `update`. */
  applyLook(lookX: number, lookY: number): void {
    // Mouse right is +x, which must turn the view right — i.e. decrease yaw.
    this.yaw -= lookX;
    this.pitch = clamp(this.pitch - lookY, CONFIG.camera.pitchMin, CONFIG.camera.pitchMax);
  }

  /**
   * Adds impact shake. Landing a hit without it reads as the enemy simply
   * losing health; with it, the hit feels like it connected.
   */
  addShake(amount: number): void {
    this.shake = Math.min(1.5, this.shake + amount);
  }

  /** Normalised direction the camera is looking. Used for aiming the web. */
  get forward(): THREE.Vector3 {
    const cp = Math.cos(this.pitch);
    return this.forwardVec.set(-Math.sin(this.yaw) * cp, Math.sin(this.pitch), -Math.cos(this.yaw) * cp);
  }

  update(dt: number, target: THREE.Vector3, velocity: THREE.Vector3, city: City): void {
    const cfg = CONFIG.camera;
    const speed = velocity.length();

    // Look slightly ahead of where the player is going.
    _focus.copy(target).addScaledVector(velocity, cfg.lookAhead).setY(target.y + cfg.height);

    // Trail further back the faster we move.
    const distance = cfg.distance + speed * cfg.speedPullback;
    _dir.copy(this.forward);
    _desired.copy(_focus).addScaledVector(_dir, -distance);

    if (!this.initialised) {
      this.position.copy(_desired);
      this.lookAt.copy(_focus);
      this.initialised = true;
    }

    dampVec3(this.position, _desired, cfg.positionLambda, dt);
    dampVec3(this.lookAt, _focus, cfg.lookLambda, dt);

    // Keep the camera out of buildings: cast from the focus point outward and
    // pull in to the first hit. Done after smoothing so it can never lag.
    this.avoidGeometry(_focus, city, distance);

    // FOV opens up with speed to sell momentum.
    const wideFov = this.baseFov + (cfg.fovMax - cfg.fovBase);
    const targetFov = this.baseFov + (wideFov - this.baseFov) * smoothstep(0, cfg.fovSpeedRef, speed);
    this.fov = damp(this.fov, targetFov, cfg.fovLambda, dt);
    if (Math.abs(this.camera.fov - this.fov) > 0.01) {
      this.camera.fov = this.fov;
      this.camera.updateProjectionMatrix();
    }

    this.updateRoll(dt, velocity, speed);

    this.camera.position.copy(this.position);

    // Shake is applied after smoothing so it never gets damped away.
    if (this.shake > 0.001) {
      this.shake = Math.max(0, this.shake - dt * 4.5);
      const magnitude = this.shake * this.shake * 0.6;
      this.shakeOffset.set(
        (Math.random() - 0.5) * magnitude,
        (Math.random() - 0.5) * magnitude,
        (Math.random() - 0.5) * magnitude,
      );
      this.camera.position.add(this.shakeOffset);
    }

    this.camera.lookAt(this.lookAt);
    if (Math.abs(this.roll) > 1e-4) this.camera.rotateZ(this.roll);
  }

  setAspect(aspect: number): void {
    this.camera.aspect = aspect;
    this.camera.updateProjectionMatrix();
  }

  /** Snaps the camera to the target with no interpolation (respawn, boot). */
  reset(target: THREE.Vector3): void {
    this.initialised = false;
    this.lookAt.copy(target);
    this.roll = 0;
  }

  private avoidGeometry(focus: THREE.Vector3, city: City, maxDistance: number): void {
    _dir.copy(this.position).sub(focus);
    const dist = _dir.length();
    if (dist < 1e-4) return;
    _dir.divideScalar(dist);

    const hit = city.raycast(focus, _dir, Math.min(dist, maxDistance) + 0.6);
    if (!hit) return;

    const pulled = Math.max(CONFIG.camera.minDistance, hit.distance - 0.6);
    this.position.copy(focus).addScaledVector(_dir, pulled);
  }

  /** Banks into turns, proportional to how fast the heading is rotating. */
  private updateRoll(dt: number, velocity: THREE.Vector3, speed: number): void {
    let targetRoll = 0;
    _flat.set(velocity.x, 0, velocity.z);
    const flatSpeed = _flat.length();

    if (flatSpeed > 6) {
      _flat.divideScalar(flatSpeed);
      // Y component of cross(previous, current): the signed turn this frame.
      const turn = this.prevHeading.x * _flat.z - this.prevHeading.z * _flat.x;
      const rate = turn / Math.max(dt, 1e-4);
      const intensity = smoothstep(6, CONFIG.camera.fovSpeedRef, speed);
      targetRoll = clamp(rate * 0.09, -CONFIG.camera.maxRoll, CONFIG.camera.maxRoll) * intensity;
      this.prevHeading.copy(_flat);
    }

    this.roll = damp(this.roll, targetRoll, 6, dt);
  }
}
