import * as THREE from 'three';
import { CONFIG } from '../core/Config';
import { clamp, damp, randRange, type Rng } from '../core/MathUtils';
import type { Building, City } from '../world/City';
import type { Player } from '../player/Player';
import type { CombatTarget, TargetProvider } from './CombatTarget';
import { ThugFactory, poseThug, type ThugRig } from './ThugModel';

export type ThugKind = 'ENFORCER' | 'BRUTE' | 'GUNNER';

export interface Thug extends CombatTarget {
  kind: ThugKind;
  readonly root: THREE.Group;
  readonly vel: THREE.Vector3;
  phase: 'IDLE' | 'CHASE' | 'TELEGRAPH' | 'RECOVER' | 'STAGGER';
  timer: number;
  cooldown: number;
  crimeId: number;
  /** Winding up a swing — this is what spider-sense reads. */
  telegraphing: boolean;
  /** Jointed body, driven by poseThug each frame. */
  readonly rig: ThugRig;
}

export interface Crime {
  readonly id: number;
  readonly pos: THREE.Vector3;
  readonly thugs: Thug[];
  /** Player has come close enough to engage. */
  engaged: boolean;
  resolved: boolean;
  /** Counts up while the player is away from an engaged crime. */
  abandonTimer: number;
}

const _v1 = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const UP = new THREE.Vector3(0, 1, 0);

/**
 * Street-level crime: roving groups of thugs that spawn around the player,
 * fight, and resolve into XP. This is the moment-to-moment content between
 * villain encounters.
 */
export class ThugSystem implements TargetProvider {
  readonly group = new THREE.Group();
  readonly thugs: Thug[] = [];
  readonly crimes: Crime[] = [];

  onCrimeResolved: ((crime: Crime) => void) | null = null;
  onThugDefeated: ((thug: Thug) => void) | null = null;
  /** Raised the moment a thug starts winding up, for the spider-sense cue. */
  onTelegraph: (() => void) | null = null;

  private readonly city: City;
  private readonly rng: Rng;
  private readonly disposables: Array<{ dispose(): void }> = [];
  private readonly bodies: ThugFactory;
  private readonly webMaterial: THREE.MeshBasicMaterial;
  private readonly webGeo: THREE.SphereGeometry;

  private spawnTimer = 6;
  private nextCrimeId = 1;
  /** Something died or finished this frame; clear it once the loops are done. */
  private pendingReap = false;

  constructor(city: City, rng: Rng) {
    this.city = city;
    this.rng = rng;
    this.group.name = 'Crimes';

    this.webGeo = new THREE.SphereGeometry(0.85, 10, 8);
    this.webMaterial = new THREE.MeshBasicMaterial({
      color: 0xf2f6ff,
      transparent: true,
      opacity: 0.55,
      depthWrite: false,
      toneMapped: false,
    });
    this.disposables.push(this.webGeo, this.webMaterial);

    this.bodies = new ThugFactory(this.disposables);
  }

  // --------------------------------------------------------- TargetProvider

  get combatTargets(): readonly CombatTarget[] {
    return this.thugs;
  }

  damageTarget(target: CombatTarget, amount: number, from?: THREE.Vector3): void {
    const thug = target as Thug;
    if (!thug.alive) return;

    thug.hp = Math.max(0, thug.hp - amount);
    thug.hitFlash = 1;
    thug.phase = 'STAGGER';
    thug.timer = 0.45;
    thug.telegraphing = false;

    if (from) {
      _v1.copy(thug.pos).sub(from).setY(0);
      if (_v1.lengthSq() > 1e-6) {
        _v1.normalize().multiplyScalar(9);
        thug.vel.x += _v1.x;
        thug.vel.z += _v1.z;
        thug.vel.y += 4;
      }
    }

    if (thug.hp <= 0) {
      thug.alive = false;
      thug.root.visible = false;
      this.pendingReap = true;
      this.onThugDefeated?.(thug);
      this.checkCrimeResolved(thug.crimeId);
    }
  }

  // ------------------------------------------------------------------ update

  update(dt: number, player: Player): void {
    this.updateSpawning(dt, player);

    for (const thug of this.thugs) {
      if (!thug.alive) continue;
      this.updateThug(dt, thug, player);
    }

    for (const crime of this.crimes) {
      if (crime.resolved) continue;
      const distance = crime.pos.distanceTo(player.pos);

      if (!crime.engaged && distance < CONFIG.crimes.engageRadius) {
        crime.engaged = true;
        crime.abandonTimer = 0;
      } else if (crime.engaged && distance > CONFIG.crimes.engageRadius * 2.4) {
        crime.abandonTimer += dt;
        if (crime.abandonTimer > CONFIG.crimes.abandonTime) this.despawnCrime(crime);
      } else if (crime.engaged) {
        crime.abandonTimer = 0;
      }
    }

    // Deferred to here because both paths that finish a crime run inside a
    // loop over `thugs` — splicing from under an active iteration skips
    // whichever entry slid into the freed slot.
    if (this.pendingReap) this.reap();
  }

  /**
   * The most imminent incoming attack within sense range, if any. Drives both
   * the spider-sense indicator and the perfect-dodge window.
   */
  incomingAttack(playerPos: THREE.Vector3): { direction: THREE.Vector3; urgency: number } | null {
    let best: Thug | null = null;
    let bestTimer = Infinity;

    for (const thug of this.thugs) {
      if (!thug.alive || !thug.telegraphing) continue;
      if (thug.pos.distanceTo(playerPos) > CONFIG.dodge.senseRange) continue;
      if (thug.timer < bestTimer) {
        bestTimer = thug.timer;
        best = thug;
      }
    }

    if (!best) return null;
    const direction = new THREE.Vector3().copy(best.pos).sub(playerPos).setY(0).normalize();
    // 0 = just started winding up, 1 = about to connect.
    const urgency = clamp(1 - bestTimer / CONFIG.thugs.telegraph, 0, 1);
    return { direction, urgency };
  }

  /** Nearest unresolved crime, for the objective marker. */
  nearestCrime(from: THREE.Vector3): Crime | null {
    let best: Crime | null = null;
    let bestDist = Infinity;
    for (const crime of this.crimes) {
      if (crime.resolved) continue;
      const d = crime.pos.distanceTo(from);
      if (d < bestDist) {
        bestDist = d;
        best = crime;
      }
    }
    return best;
  }

  get activeCrimeCount(): number {
    return this.crimes.reduce((n, c) => n + (c.resolved ? 0 : 1), 0);
  }

  dispose(): void {
    for (const d of this.disposables) d.dispose();
    this.disposables.length = 0;
    this.group.clear();
  }

  // ---------------------------------------------------------------- private

  private updateSpawning(dt: number, player: Player): void {
    this.spawnTimer -= dt;
    if (this.spawnTimer > 0) return;
    if (this.activeCrimeCount >= CONFIG.crimes.maxActive) {
      this.spawnTimer = CONFIG.crimes.spawnInterval;
      return;
    }

    // Retry quickly if nowhere suitable was found. Resetting the full interval
    // on failure meant one bad roll cost twenty seconds of empty city, and
    // with a low success rate the player could go minutes with no objective
    // at all — which is exactly how it presented: "there is no crime".
    const spawned = this.spawnCrime(player.pos);
    this.spawnTimer = spawned ? CONFIG.crimes.spawnInterval : CONFIG.crimes.retryInterval;
  }

  /** Returns false if nowhere suitable was found. */
  private spawnCrime(near: THREE.Vector3): boolean {
    const site = this.pickSite(near);
    if (!site) return false;

    const crime: Crime = {
      id: this.nextCrimeId++,
      pos: site,
      thugs: [],
      engaged: false,
      resolved: false,
      abandonTimer: 0,
    };

    const count = Math.round(randRange(this.rng, CONFIG.crimes.minThugs, CONFIG.crimes.maxThugs));
    for (let i = 0; i < count; i++) {
      const roll = this.rng();
      const kind: ThugKind = roll < 0.18 ? 'BRUTE' : roll < 0.45 ? 'GUNNER' : 'ENFORCER';
      const angle = (i / count) * Math.PI * 2;
      const radius = randRange(this.rng, 3, 9);
      const thug = this.spawnThug(
        kind,
        crime.pos.x + Math.cos(angle) * radius,
        crime.pos.y,
        crime.pos.z + Math.sin(angle) * radius,
        crime.id,
      );
      crime.thugs.push(thug);
    }

    this.crimes.push(crime);
    return true;
  }

  /**
   * Somewhere to stage a crime, within the spawn ring around the player.
   *
   * Tries progressively less fussy options rather than giving up:
   *
   * 1. A wide rooftop — the best fight arena, and what this used to require
   *    unconditionally. Manhattan is full of them; Queens is mostly houses,
   *    so insisting on one meant almost every spawn attempt failed silently.
   * 2. Any rooftop at all.
   * 3. The street. A mugging at ground level is the most ordinary thing in the
   *    game, and it means a spawn can essentially always succeed.
   */
  private pickSite(near: THREE.Vector3): THREE.Vector3 | null {
    const { spawnRadiusMin, spawnRadiusMax } = CONFIG.crimes;

    for (const width of [CONFIG.crimes.preferredRoofWidth, 0]) {
      const roof = this.city.roofNear(
        this.rng,
        near.x,
        near.z,
        spawnRadiusMin,
        spawnRadiusMax,
        width,
      );
      if (roof) return new THREE.Vector3(roof.roof.x, roof.roof.y, roof.roof.z);
    }

    // Street level: sample the ring directly and take the first open column.
    for (let attempt = 0; attempt < 24; attempt++) {
      const angle = this.rng() * Math.PI * 2;
      const radius = randRange(this.rng, spawnRadiusMin, spawnRadiusMax);
      const x = near.x + Math.cos(angle) * radius;
      const z = near.z + Math.sin(angle) * radius;
      // groundHeightAt returns 0 on open street and the roof height inside a
      // building footprint, so a zero here is a genuine gap between blocks.
      if (this.city.groundHeightAt(x, z) > 0.5) continue;
      return new THREE.Vector3(x, 0, z);
    }
    return null;
  }

  private spawnThug(kind: ThugKind, x: number, y: number, z: number, crimeId: number): Thug {
    const cfg = CONFIG.thugs;
    const scale = kind === 'BRUTE' ? cfg.brute.sizeScale : 1;
    const hp =
      cfg.hp * (kind === 'BRUTE' ? cfg.brute.hpScale : kind === 'GUNNER' ? cfg.ranged.hpScale : 1);

    const root = new THREE.Group();
    root.position.set(x, y, z);
    root.scale.setScalar(scale);

    // A jointed body rather than the capsule-plus-sphere this used to be —
    // which was, exactly, a chess pawn, on the enemy the player sees most.
    const rig = this.bodies.create(kind);
    root.add(rig.root);

    // Cocoon shell, shown only while webbed.
    const cocoon = new THREE.Mesh(this.webGeo, this.webMaterial);
    cocoon.position.y = 1.0;
    cocoon.scale.set(1, 1.5, 1);
    cocoon.visible = false;
    cocoon.name = 'cocoon';
    root.add(cocoon);

    this.group.add(root);

    const thug: Thug = {
      name: kind,
      kind,
      pos: root.position,
      root,
      vel: new THREE.Vector3(),
      alive: true,
      hp,
      maxHp: hp,
      hitFlash: 0,
      webbed: 0,
      phase: 'IDLE',
      timer: 0,
      cooldown: randRange(this.rng, 0, 1.2),
      crimeId,
      telegraphing: false,
      rig,
    };
    this.thugs.push(thug);
    return thug;
  }

  private updateThug(dt: number, thug: Thug, player: Player): void {
    thug.hitFlash = Math.max(0, thug.hitFlash - dt * 3.5);
    thug.cooldown = Math.max(0, thug.cooldown - dt);

    const cocoon = thug.root.getObjectByName('cocoon');
    if (thug.webbed > 0) {
      thug.webbed = Math.max(0, thug.webbed - dt);
      thug.telegraphing = false;
      if (cocoon) cocoon.visible = true;
      this.settle(dt, thug);
      return;
    }
    if (cocoon) cocoon.visible = false;

    const cfg = CONFIG.thugs;
    const toPlayer = _v1.copy(player.pos).sub(thug.pos);
    const distance = toPlayer.length();

    switch (thug.phase) {
      case 'STAGGER':
        thug.timer -= dt;
        if (thug.timer <= 0) thug.phase = 'CHASE';
        break;

      case 'TELEGRAPH': {
        thug.timer -= dt;
        // Swell slightly as the swing lands. The readable part of the tell is
        // now the wind-up pose itself — see poseThug — so this is only the
        // extra emphasis on top of it.
        const t = 1 - clamp(thug.timer / cfg.telegraph, 0, 1);
        thug.root.scale.setScalar((thug.kind === 'BRUTE' ? cfg.brute.sizeScale : 1) * (1 + t * 0.08));
        if (thug.timer <= 0) {
          thug.telegraphing = false;
          thug.phase = 'RECOVER';
          thug.timer = 0.5;
          thug.cooldown = cfg.attackCooldown;
          thug.root.scale.setScalar(thug.kind === 'BRUTE' ? cfg.brute.sizeScale : 1);

          if (thug.kind === 'GUNNER') {
            if (distance < cfg.ranged.range && this.city.hasLineOfSight(thug.pos, player.pos)) {
              player.takeDamage(cfg.ranged.damage);
            }
          } else if (distance < cfg.attackRange * 1.6) {
            const damage = cfg.damage * (thug.kind === 'BRUTE' ? cfg.brute.damageScale : 1);
            _v2.copy(player.pos).sub(thug.pos).setY(0).normalize().multiplyScalar(14).addScaledVector(UP, 6);
            player.takeDamage(damage, _v2);
          }
        }
        break;
      }

      case 'RECOVER':
        thug.timer -= dt;
        if (thug.timer <= 0) thug.phase = 'CHASE';
        break;

      case 'IDLE':
        if (distance < cfg.aggroRange) thug.phase = 'CHASE';
        break;

      default: {
        // CHASE
        const wantRange = thug.kind === 'GUNNER' ? cfg.ranged.range * 0.6 : cfg.attackRange;
        const canAttack =
          thug.cooldown <= 0 &&
          (thug.kind === 'GUNNER'
            ? distance < cfg.ranged.range && this.city.hasLineOfSight(thug.pos, player.pos)
            : distance < cfg.attackRange * 1.3);

        if (canAttack) {
          thug.phase = 'TELEGRAPH';
          thug.timer = cfg.telegraph;
          thug.telegraphing = true;
          this.onTelegraph?.();
          break;
        }

        if (distance > wantRange) {
          const speed = cfg.speed * (thug.kind === 'BRUTE' ? cfg.brute.speedScale : 1);
          toPlayer.setY(0);
          if (toPlayer.lengthSq() > 1e-6) {
            toPlayer.normalize();
            thug.vel.x = damp(thug.vel.x, toPlayer.x * speed, 6, dt);
            thug.vel.z = damp(thug.vel.z, toPlayer.z * speed, 6, dt);
          }
        } else {
          thug.vel.x = damp(thug.vel.x, 0, 8, dt);
          thug.vel.z = damp(thug.vel.z, 0, 8, dt);
        }
        break;
      }
    }

    this.settle(dt, thug);

    // Face the player.
    if (Math.abs(toPlayer.x) + Math.abs(toPlayer.z) > 1e-4) {
      const desired = Math.atan2(player.pos.x - thug.pos.x, player.pos.z - thug.pos.z);
      let delta = (desired - thug.root.rotation.y) % (Math.PI * 2);
      if (delta > Math.PI) delta -= Math.PI * 2;
      if (delta < -Math.PI) delta += Math.PI * 2;
      thug.root.rotation.y += delta * (1 - Math.exp(-8 * dt));
    }

    // Drive the body. Progress through the wind-up and through the swing are
    // read from the same timers the damage uses, so what you see is exactly
    // what the dodge window is scored against.
    const telegraph =
      thug.phase === 'TELEGRAPH' ? 1 - clamp(thug.timer / cfg.telegraph, 0, 1) : 0;
    const swing = thug.phase === 'RECOVER' ? clamp(1 - thug.timer / 0.5, 0, 1) : 0;
    poseThug(thug.rig, dt, Math.hypot(thug.vel.x, thug.vel.z), telegraph, swing);
  }

  /**
   * Gravity, ground snap and horizontal drift for a thug.
   *
   * Ground height comes from the broadphase column lookup rather than a full
   * raycast — with up to 18 thugs alive this ran 18 raycasts *per frame*.
   */
  private settle(dt: number, thug: Thug): void {
    thug.vel.y -= CONFIG.physics.gravity * dt;
    thug.pos.addScaledVector(thug.vel, dt);

    const ground = this.city.groundHeightAt(thug.pos.x, thug.pos.z);

    if (thug.pos.y <= ground) {
      thug.pos.y = ground;
      thug.vel.y = 0;
      thug.vel.x *= Math.pow(0.02, dt);
      thug.vel.z *= Math.pow(0.02, dt);
    }
  }

  private checkCrimeResolved(crimeId: number): void {
    const crime = this.crimes.find((c) => c.id === crimeId);
    if (!crime || crime.resolved) return;
    if (crime.thugs.some((t) => t.alive)) return;

    crime.resolved = true;
    this.pendingReap = true;
    this.onCrimeResolved?.(crime);
  }

  /** Retires an abandoned crime; `reap` clears the bodies. */
  private despawnCrime(crime: Crime): void {
    crime.resolved = true;
    this.pendingReap = true;
    for (const thug of crime.thugs) thug.alive = false;
  }

  /**
   * Drops finished crimes and defeated thugs.
   *
   * Nothing used to be removed: a beaten thug was set invisible and left in
   * both the array and the scene graph, and a resolved crime stayed in
   * `crimes` for good. Every frame then walked the entire history of the
   * session — a few hundred corpses after an hour of free roam, each one
   * costing a matrix update and a pass in the spider-sense scan.
   *
   * Death is instant here (no ragdoll, no fade), so there is nothing to wait
   * for. `crime.thugs` keeps its own references, so a part-cleared crime can
   * still tell whether anyone is left standing.
   */
  private reap(): void {
    this.pendingReap = false;

    for (let i = this.thugs.length - 1; i >= 0; i--) {
      const thug = this.thugs[i]!;
      if (thug.alive) continue;
      this.group.remove(thug.root);
      this.thugs.splice(i, 1);
    }

    for (let i = this.crimes.length - 1; i >= 0; i--) {
      if (this.crimes[i]!.resolved) this.crimes.splice(i, 1);
    }
  }
}
