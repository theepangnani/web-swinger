import * as THREE from 'three';
import { CONFIG } from '../core/Config';
import { clamp } from '../core/MathUtils';
import type { City, RayHit } from '../world/City';
import { WebRibbon } from './WebRibbon';

/**
 * Minimal contract the constraint solver needs. `Player` satisfies this
 * structurally, which keeps this module free of a circular import.
 */
export interface SwingBody {
  pos: THREE.Vector3;
  prevPos: THREE.Vector3;
}

/** Ceiling on constraint acceleration, so a degenerate frame can't explode. */
const MAX_TENSION_ACCEL = 700;

const _d = new THREE.Vector3();
const _n = new THREE.Vector3();
const _vel = new THREE.Vector3();
const _tan = new THREE.Vector3();
const _tmp = new THREE.Vector3();
const _axis = new THREE.Vector3();
const _right = new THREE.Vector3();
const _up = new THREE.Vector3();
const _base = new THREE.Vector3();
const _corner = new THREE.Vector3();
const WORLD_UP = new THREE.Vector3(0, 1, 0);

/**
 * Web line: anchor acquisition, pendulum constraint, and the rope visual.
 *
 * The pendulum is solved as a *positional* constraint. Pulling the position
 * back onto the sphere of radius `restLength` implicitly cancels the radial
 * component of the Verlet velocity while leaving the tangential component
 * untouched — which is exactly angular-momentum conservation, and is far more
 * stable than integrating a stiff spring force.
 *
 * The analytic tension from the design spec,
 *     T = m * g * cos(theta) + m * v_tangential^2 / restLength
 * is applied as a real centripetal acceleration before that projection (so it
 * does the physical work), and is also reported to the HUD in newtons.
 */
export class WebSystem {
  readonly object3D = new THREE.Group();

  attached = false;
  readonly anchor = new THREE.Vector3();
  restLength = 0;
  tension = 0;
  /** Set for one frame when a shot fails, so the HUD can react. */
  lastShotFailed = false;

  private readonly ropePoints: THREE.Vector3[] = [];
  private readonly ropePrev: THREE.Vector3[] = [];
  /** Billboard ribbons carrying the criss-cross web pattern. */
  private readonly ribbons: WebRibbon[] = [];
  private readonly disposables: Array<{ dispose(): void }> = [];

  constructor() {
    this.object3D.name = 'WebLine';
    this.object3D.visible = false;

    const segments = CONFIG.web.ropeSegments;
    for (let i = 0; i <= segments; i++) {
      this.ropePoints.push(new THREE.Vector3());
      this.ropePrev.push(new THREE.Vector3());
    }

    // Two billboarded ribbons: a soft halo behind, the patterned strand in
    // front. Both carry the criss-cross silk texture, so the line silhouettes
    // as webbing at any distance instead of as a smooth cylinder.
    const halo = new WebRibbon(
      segments,
      CONFIG.web.ribbonWidth * 1.9,
      0.2,
      CONFIG.web.ribbonTilesPerMetre * 0.5,
    );
    const strand = new WebRibbon(
      segments,
      CONFIG.web.ribbonWidth,
      1,
      CONFIG.web.ribbonTilesPerMetre,
    );
    this.ribbons.push(halo, strand);

    for (const ribbon of this.ribbons) {
      this.object3D.add(ribbon.mesh);
      this.disposables.push(ribbon);
    }
  }

  // ------------------------------------------------------------- attachment

  /**
   * Casts a fan of upward-biased rays and latches onto the best facade hit,
   * snapping to a roof corner when one is close by.
   */
  tryAttach(
    city: City,
    playerPos: THREE.Vector3,
    forward: THREE.Vector3,
    currentWall: THREE.Vector3 | null = null,
  ): boolean {
    this.lastShotFailed = false;
    // Rays start from the body centre, not the hand: a hand momentarily inside
    // a wall would make every cast fail.
    const hit = this.findAnchor(city, playerPos, playerPos, forward, currentWall);

    if (!hit) {
      if (CONFIG.web.allowSkyAnchor) {
        // Fallback: an invisible point up and ahead, so a shot never whiffs.
        _base.copy(forward).setY(0);
        if (_base.lengthSq() < 1e-6) _base.set(0, 0, -1);
        _base.normalize();
        this.anchor
          .copy(playerPos)
          .addScaledVector(_base, CONFIG.web.castDistance * 0.45)
          .setY(playerPos.y + CONFIG.web.castDistance * 0.5);
        this.finalizeAttach(playerPos);
        return true;
      }
      this.lastShotFailed = true;
      return false;
    }

    this.anchor.copy(hit);
    this.finalizeAttach(playerPos);
    return true;
  }

  release(): void {
    this.attached = false;
    this.tension = 0;
    this.object3D.visible = false;
  }

  /** `amount` > 0 reels in, < 0 pays line out. */
  reel(amount: number): void {
    if (!this.attached) return;
    this.restLength = clamp(this.restLength - amount, CONFIG.web.minLength, CONFIG.web.maxLength);
  }

  // ------------------------------------------------------------------ solve

  /** Called once per fixed substep, after integration. */
  solve(body: SwingBody, dt: number): void {
    if (!this.attached) {
      this.tension = 0;
      return;
    }

    _d.copy(this.anchor).sub(body.pos);
    const length = _d.length();
    if (length < 1e-4) return;
    _n.copy(_d).divideScalar(length); // unit vector, player -> anchor

    if (length < this.restLength) {
      // Line is slack: it applies no force at all.
      this.tension = 0;
      return;
    }

    // Implied Verlet velocity, split into radial and tangential parts.
    _vel.copy(body.pos).sub(body.prevPos).divideScalar(dt);
    const radialSpeed = _vel.dot(_n);
    _tan.copy(_vel).addScaledVector(_n, -radialSpeed);

    // theta is measured from straight-down; n.y is exactly cos(theta) because
    // n points from the player up towards the anchor.
    const cosTheta = Math.max(0, _n.y);
    const m = CONFIG.physics.mass;
    const effectiveLength = Math.max(CONFIG.web.minLength, this.restLength);
    this.tension = m * CONFIG.physics.gravity * cosTheta + (m * _tan.lengthSq()) / effectiveLength;

    // Apply as acceleration toward the anchor (Verlet: x += a * dt^2).
    const accel = Math.min(this.tension / m, MAX_TENSION_ACCEL);
    body.pos.addScaledVector(_n, accel * dt * dt);

    // Positional relaxation removes any residual radial drift. The per-step
    // clamp keeps a large accumulated violation from being resolved in one
    // go, which would read as being flung.
    for (let i = 0; i < CONFIG.web.iterations; i++) {
      _tmp.copy(this.anchor).sub(body.pos);
      const l = _tmp.length();
      if (l <= this.restLength || l < 1e-5) break;
      _tmp.divideScalar(l);
      const correction = Math.min(
        (l - this.restLength) * CONFIG.web.stiffness,
        CONFIG.web.maxCorrectionPerStep,
      );
      body.pos.addScaledVector(_tmp, correction);
    }
  }

  // ----------------------------------------------------------------- visual

  /**
   * Simulates the rope as a pinned Verlet chain so a slack line visibly sags.
   * Cheap: 17 points, a handful of relaxation passes.
   */
  updateVisual(dt: number, handPos: THREE.Vector3, cameraPos: THREE.Vector3): void {
    if (!this.attached) return;
    this.object3D.visible = true;

    const n = this.ropePoints.length;
    const last = n - 1;
    const step = Math.min(dt, 1 / 60);

    const distance = handPos.distanceTo(this.anchor);
    const slack = clamp((this.restLength - distance) / Math.max(1, distance), 0, 1);

    // Under tension the line is a straight rod between hand and anchor, with
    // no simulation at all.
    //
    // Damping a Verlet chain only ever *reduces* wobble -- it never removes
    // it, so the line always read as rubbery no matter how the constants were
    // tuned. A loaded web carries the player's whole weight; it should be
    // perfectly straight, and the cheapest way to guarantee that is to not
    // simulate it.
    if (slack < CONFIG.web.slackThreshold) {
      for (let i = 0; i <= last; i++) {
        this.ropePoints[i]!.lerpVectors(handPos, this.anchor, i / last);
        this.ropePrev[i]!.copy(this.ropePoints[i]!);
      }
      for (const ribbon of this.ribbons) ribbon.update(this.ropePoints, cameraPos);
      return;
    }

    // Genuinely slack: let it hang.
    const spanPerSegment = distance / last;
    const restPerSegment = Math.max(spanPerSegment, this.restLength / last);
    const sag = CONFIG.web.ropeSag * slack;

    // Damping scales with tension: a loaded line should not oscillate at all,
    // which is most of what made it look rubbery.
    const damping = 0.96 - 0.5 * (1 - slack);
    for (let i = 1; i < last; i++) {
      const p = this.ropePoints[i]!;
      const prev = this.ropePrev[i]!;
      const vx = (p.x - prev.x) * damping;
      const vy = (p.y - prev.y) * damping;
      const vz = (p.z - prev.z) * damping;
      prev.copy(p);
      p.set(p.x + vx, p.y + vy - sag * step * step, p.z + vz);
    }

    this.ropePoints[0]!.copy(handPos);
    this.ropePoints[last]!.copy(this.anchor);

    for (let iter = 0; iter < CONFIG.web.ropeIterations; iter++) {
      for (let i = 0; i < last; i++) {
        const a = this.ropePoints[i]!;
        const b = this.ropePoints[i + 1]!;
        _tmp.copy(b).sub(a);
        const l = _tmp.length();
        if (l < 1e-6) continue;
        const diff = (l - restPerSegment) / l;
        const wa = i === 0 ? 0 : 0.5;
        const wb = i + 1 === last ? 0 : 0.5;
        const scale = wa + wb > 0 ? 1 / (wa + wb) : 0;
        a.addScaledVector(_tmp, diff * wa * scale);
        b.addScaledVector(_tmp, -diff * wb * scale);
      }
      this.ropePoints[0]!.copy(handPos);
      this.ropePoints[last]!.copy(this.anchor);
    }

    for (const ribbon of this.ribbons) ribbon.update(this.ropePoints, cameraPos);
  }

  dispose(): void {
    for (const d of this.disposables) d.dispose();
    this.disposables.length = 0;
  }

  // ---------------------------------------------------------------- private

  private finalizeAttach(playerPos: THREE.Vector3): void {
    this.attached = true;
    this.object3D.visible = true;
    // Rest length is the true distance at the moment of attachment, so the
    // constraint starts satisfied and the swing eases in instead of snapping.
    this.restLength = clamp(
      playerPos.distanceTo(this.anchor),
      CONFIG.web.minLength,
      CONFIG.web.maxLength,
    );
    // Seed the rope straight so it doesn't whip on the first frame.
    const last = this.ropePoints.length - 1;
    for (let i = 0; i <= last; i++) {
      this.ropePoints[i]!.lerpVectors(playerPos, this.anchor, i / last);
      this.ropePrev[i]!.copy(this.ropePoints[i]!);
    }
  }

  /**
   * Scores a cone of candidate rays. Rays closer to where the player is
   * actually aiming score higher, but a slightly off-axis ray that finds a
   * high, near anchor will win — that is the aim assist.
   */
  /**
   * `coarse` trims the aim fan for the HUD reticle, which re-runs several
   * times a second. The full fan is 33 raycasts; on a dense imported city
   * that is far more work than a preview needs.
   */
  findAnchor(
    city: City,
    playerPos: THREE.Vector3,
    origin: THREE.Vector3,
    forward: THREE.Vector3,
    currentWall: THREE.Vector3 | null = null,
    coarse = false,
  ): THREE.Vector3 | null {
    // Tilt the aim upward so a level camera still finds rooftops.
    _base.copy(forward).normalize();
    _axis.crossVectors(_base, WORLD_UP);
    if (_axis.lengthSq() < 1e-6) _axis.set(1, 0, 0);
    _axis.normalize();
    _base.applyAxisAngle(_axis, CONFIG.web.aimUpBias).normalize();

    _right.crossVectors(_base, WORLD_UP);
    if (_right.lengthSq() < 1e-6) _right.set(1, 0, 0);
    _right.normalize();
    _up.crossVectors(_right, _base).normalize();

    let best: RayHit | null = null;
    let bestScore = -Infinity;
    let bestRing = 0;

    const rings = coarse ? 1 : CONFIG.web.aimRings;
    const perRing = coarse ? 4 : CONFIG.web.aimSamplesPerRing;
    const dir = new THREE.Vector3();

    for (let ring = 0; ring <= rings; ring++) {
      const count = ring === 0 ? 1 : perRing;
      const spread = (CONFIG.web.aimSpread * ring) / rings;

      for (let k = 0; k < count; k++) {
        dir.copy(_base);
        if (ring > 0) {
          const angle = (k / count) * Math.PI * 2 + ring * 0.4;
          _tmp
            .copy(_right)
            .multiplyScalar(Math.cos(angle))
            .addScaledVector(_up, Math.sin(angle))
            .normalize();
          dir.applyAxisAngle(_tmp, spread).normalize();
        }

        const hit = city.raycast(origin, dir, CONFIG.web.castDistance);
        if (!hit) continue;

        const rise = hit.point.y - playerPos.y;
        if (rise < CONFIG.web.minAnchorRise) continue;

        const range = playerPos.distanceTo(hit.point);
        // Reject anything beyond the line's own reach. Attaching further out
        // than maxLength would clamp restLength below the true distance and
        // yank the player hard on the very first substep.
        if (range > CONFIG.web.maxLength) continue;
        // ...and anything so close it is effectively the surface you are on.
        if (range < CONFIG.web.minAnchorDistance) continue;
        // Explicitly refuse the facade currently being clung to: same outward
        // normal means it is the same wall, however far along it we hit.
        if (currentWall && hit.normal.dot(currentWall) > 0.9) continue;

        // Prefer near, high anchors found by rays close to the aim axis.
        // Anchors below the player are legal but scored down hard, so they are
        // a fallback when there is genuinely nothing overhead.
        const riseScore = rise >= 0 ? rise * CONFIG.web.riseBonus : rise * 2.4;
        const score = riseScore - hit.distance * 0.42 - ring * 6;
        if (score > bestScore) {
          bestScore = score;
          best = hit;
          bestRing = ring;
        }
      }
    }

    if (!best) return null;

    const result = new THREE.Vector3().copy(best.point);
    this.snapToCorner(best, result, playerPos);
    // Lift off the surface so the rope doesn't z-fight the facade.
    result.addScaledVector(best.normal, 0.2);
    return result;
  }

  /** Latches onto a roof corner when the raw hit lands near one. */
  private snapToCorner(hit: RayHit, out: THREE.Vector3, playerPos: THREE.Vector3): void {
    const b = hit.building;
    let bestDistSq = CONFIG.web.cornerSnapRadius * CONFIG.web.cornerSnapRadius;
    let found = false;

    for (const cx of [b.min.x, b.max.x]) {
      for (const cz of [b.min.z, b.max.z]) {
        _corner.set(cx, b.max.y, cz);
        // Corner snapping should only ever pull the anchor *up*, never down.
        if (_corner.y < hit.point.y - 1) continue;
        const dSq = _corner.distanceToSquared(hit.point);
        if (dSq < bestDistSq) {
          bestDistSq = dSq;
          out.copy(_corner);
          found = true;
        }
      }
    }

    if (found) {
      // Nudge the corner outward and up a touch so the line clears the edge.
      out.y += 0.35;
    }
  }
}

/**
 * A tube whose vertices are rewritten in place every frame. The index buffer
 * and attribute arrays are allocated once, so the rope costs no GC churn.
 */
class TubeStrip {
  readonly mesh: THREE.Mesh;

  private readonly geometry: THREE.BufferGeometry;
  private readonly positions: Float32Array;
  private readonly normals: Float32Array;
  private readonly radialSegments: number;
  private readonly radius: number;

  private readonly tangent = new THREE.Vector3();
  private readonly carryUp = new THREE.Vector3(0, 1, 0);
  private readonly binormal = new THREE.Vector3();
  private readonly normal = new THREE.Vector3();
  private readonly offset = new THREE.Vector3();

  /** Distance this strand is offset from the centreline, 0 for the core. */
  private readonly helixRadius: number;
  private readonly helixPhase: number;
  /** Full turns the strand makes over the line's length. */
  private readonly twists: number;
  private readonly helixOffset = new THREE.Vector3();

  constructor(
    segments: number,
    radialSegments: number,
    radius: number,
    material: THREE.Material,
    helixRadius = 0,
    helixPhase = 0,
    twists = 0,
  ) {
    this.radialSegments = radialSegments;
    this.radius = radius;
    this.helixRadius = helixRadius;
    this.helixPhase = helixPhase;
    this.twists = twists;

    const rings = segments + 1;
    const vertexCount = rings * radialSegments;
    this.positions = new Float32Array(vertexCount * 3);
    this.normals = new Float32Array(vertexCount * 3);

    const indices: number[] = [];
    for (let i = 0; i < segments; i++) {
      for (let j = 0; j < radialSegments; j++) {
        const a = i * radialSegments + j;
        const b = i * radialSegments + ((j + 1) % radialSegments);
        const c = (i + 1) * radialSegments + ((j + 1) % radialSegments);
        const d = (i + 1) * radialSegments + j;
        indices.push(a, b, c, a, c, d);
      }
    }

    this.geometry = new THREE.BufferGeometry();
    this.geometry.setAttribute('position', new THREE.BufferAttribute(this.positions, 3));
    this.geometry.setAttribute('normal', new THREE.BufferAttribute(this.normals, 3));
    this.geometry.setIndex(indices);

    this.mesh = new THREE.Mesh(this.geometry, material);
    // The rope spans arbitrary distances; culling it by a stale bounding
    // sphere would make it flicker out.
    this.mesh.frustumCulled = false;
    this.mesh.matrixAutoUpdate = false;
  }

  update(points: THREE.Vector3[]): void {
    const rings = points.length;
    this.carryUp.set(0, 1, 0);

    for (let i = 0; i < rings; i++) {
      const p = points[i]!;
      const a = points[Math.max(0, i - 1)]!;
      const b = points[Math.min(rings - 1, i + 1)]!;
      this.tangent.copy(b).sub(a);
      if (this.tangent.lengthSq() < 1e-10) this.tangent.set(0, 1, 0);
      this.tangent.normalize();

      if (Math.abs(this.tangent.dot(this.carryUp)) > 0.995) this.carryUp.set(1, 0, 0);
      this.binormal.crossVectors(this.tangent, this.carryUp).normalize();
      this.normal.crossVectors(this.binormal, this.tangent).normalize();
      this.carryUp.copy(this.normal);

      const t = rings > 1 ? i / (rings - 1) : 0;

      // Spiral this strand around the centreline.
      this.helixOffset.set(0, 0, 0);
      if (this.helixRadius > 0) {
        const spin = this.helixPhase + t * this.twists * Math.PI * 2;
        // Strands converge at the hand so the bundle looks anchored.
        const spread = this.helixRadius * Math.min(1, t * 4);
        this.helixOffset
          .copy(this.binormal)
          .multiplyScalar(Math.cos(spin) * spread)
          .addScaledVector(this.normal, Math.sin(spin) * spread);
      }

      // Silk tapers: thin where it leaves the hand, thicker at the anchor.
      const radius = this.radius * (0.55 + 0.75 * t);

      for (let j = 0; j < this.radialSegments; j++) {
        const angle = (j / this.radialSegments) * Math.PI * 2;
        this.offset
          .copy(this.binormal)
          .multiplyScalar(Math.cos(angle))
          .addScaledVector(this.normal, Math.sin(angle));

        const base = (i * this.radialSegments + j) * 3;
        this.normals[base] = this.offset.x;
        this.normals[base + 1] = this.offset.y;
        this.normals[base + 2] = this.offset.z;
        this.positions[base] = p.x + this.helixOffset.x + this.offset.x * radius;
        this.positions[base + 1] = p.y + this.helixOffset.y + this.offset.y * radius;
        this.positions[base + 2] = p.z + this.helixOffset.z + this.offset.z * radius;
      }
    }

    (this.geometry.getAttribute('position') as THREE.BufferAttribute).needsUpdate = true;
    (this.geometry.getAttribute('normal') as THREE.BufferAttribute).needsUpdate = true;
  }

  dispose(): void {
    this.geometry.dispose();
  }
}
