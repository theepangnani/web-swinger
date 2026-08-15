import * as THREE from 'three';
import { CONFIG } from '../core/Config';
import { clamp } from '../core/MathUtils';
import type { City } from '../world/City';
import { reachTo } from '../enemies/CombatTarget';
import type { CombatTarget, TargetProvider } from '../enemies/CombatTarget';

export type GadgetId =
  | 'IMPACT_WEB'
  | 'WEB_BOMB'
  | 'TRIP_MINE'
  | 'CONCUSSIVE'
  | 'ELECTRIC_WEB'
  | 'GRABBER';

export interface GadgetDef {
  readonly id: GadgetId;
  readonly name: string;
  readonly color: number;
  /** Skill that must be unlocked, or null if available from the start. */
  readonly skill: string | null;
  readonly blurb: string;
}

export const GADGETS: readonly GadgetDef[] = [
  {
    id: 'IMPACT_WEB',
    name: 'Impact Web',
    color: 0xf2f6ff,
    skill: null,
    blurb: 'Fast single shot that cocoons what it hits.',
  },
  {
    id: 'WEB_BOMB',
    name: 'Web Bomb',
    color: 0x8fd0ff,
    skill: 'gadget_bomb',
    blurb: 'Area burst — cocoons a whole group.',
  },
  {
    id: 'TRIP_MINE',
    name: 'Trip Mine',
    color: 0xffb703,
    skill: 'gadget_mine',
    blurb: 'Heavy single-target damage, no cocoon.',
  },
  {
    id: 'CONCUSSIVE',
    name: 'Concussive Blast',
    color: 0xff7043,
    skill: 'gadget_concussive',
    blurb: 'Shockwave that throws everything off the roof.',
  },
  {
    id: 'ELECTRIC_WEB',
    name: 'Electric Web',
    color: 0x66e0ff,
    skill: 'gadget_electric',
    blurb: 'Arcs through a group and stuns them for far longer.',
  },
  {
    id: 'GRABBER',
    name: 'Web Grabber',
    color: 0xb388ff,
    skill: 'gadget_grabber',
    blurb: 'Yanks everything nearby into a single pile.',
  },
];

interface Projectile {
  mesh: THREE.Mesh;
  material: THREE.MeshBasicMaterial;
  velocity: THREE.Vector3;
  kind: GadgetId;
  life: number;
  active: boolean;
}

interface Burst {
  mesh: THREE.Mesh;
  material: THREE.MeshBasicMaterial;
  life: number;
  maxLife: number;
  size: number;
}

const _dir = new THREE.Vector3();
const _step = new THREE.Vector3();
const _tmp = new THREE.Vector3();
const _impact = new THREE.Vector3();
const _closest = new THREE.Vector3();

/**
 * Three throwable gadgets with a shared projectile pool.
 *
 * Projectiles are simple ballistic points swept against the city with the
 * existing analytic raycast, so nothing here needs a physics engine.
 */
export class Gadgets {
  readonly group = new THREE.Group();

  /** Remaining ammo per gadget. */
  readonly ammo = new Map<GadgetId, number>();
  private readonly cooldowns = new Map<GadgetId, number>();

  selected: GadgetId = 'IMPACT_WEB';

  /** Raised when a gadget lands, so the Game can award focus/XP and bark. */
  onHit: ((kind: GadgetId, targets: number) => void) | null = null;

  private readonly projectiles: Projectile[] = [];
  private readonly bursts: Burst[] = [];
  private readonly disposables: Array<{ dispose(): void }> = [];
  private readonly city: City;

  private damageMultiplier = 1;
  private ammoMultiplier = 1;

  constructor(city: City) {
    this.city = city;
    this.group.name = 'Gadgets';

    for (let i = 0; i < 14; i++) this.projectiles.push(this.createProjectile());
    for (let i = 0; i < 8; i++) this.bursts.push(this.createBurst());
    this.refillAll();
  }

  /** Applies skill-derived modifiers; call whenever the skill tree changes. */
  applyModifiers(damageMultiplier: number, ammoMultiplier: number): void {
    this.damageMultiplier = damageMultiplier;
    if (ammoMultiplier !== this.ammoMultiplier) {
      this.ammoMultiplier = ammoMultiplier;
      this.refillAll();
    }
  }

  capacity(kind: GadgetId): number {
    return Math.round(this.baseAmmo(kind) * this.ammoMultiplier);
  }

  cooldownRemaining(kind: GadgetId): number {
    return this.cooldowns.get(kind) ?? 0;
  }

  refillAll(): void {
    for (const def of GADGETS) this.ammo.set(def.id, this.capacity(def.id));
  }

  /** Cycles to the next gadget the player has actually unlocked. */
  cycle(hasSkill: (id: string) => boolean, direction = 1): GadgetId {
    const available = GADGETS.filter((g) => g.skill === null || hasSkill(g.skill));
    if (available.length === 0) return this.selected;
    const current = available.findIndex((g) => g.id === this.selected);
    const next = (((current + direction) % available.length) + available.length) % available.length;
    this.selected = available[next]!.id;
    return this.selected;
  }

  select(kind: GadgetId, hasSkill: (id: string) => boolean): boolean {
    const def = GADGETS.find((g) => g.id === kind);
    if (!def) return false;
    if (def.skill !== null && !hasSkill(def.skill)) return false;
    this.selected = kind;
    return true;
  }

  /** Fires the selected gadget. Returns false if on cooldown or out of ammo. */
  fire(origin: THREE.Vector3, direction: THREE.Vector3): boolean {
    const kind = this.selected;
    if ((this.cooldowns.get(kind) ?? 0) > 0) return false;
    const remaining = this.ammo.get(kind) ?? 0;
    if (remaining <= 0) return false;

    const projectile = this.projectiles.find((p) => !p.active);
    if (!projectile) return false;

    const def = GADGETS.find((g) => g.id === kind)!;
    this.ammo.set(kind, remaining - 1);
    this.cooldowns.set(kind, this.cooldownFor(kind));

    projectile.kind = kind;
    projectile.active = true;
    projectile.life = 4;
    projectile.mesh.visible = true;
    projectile.mesh.position.copy(origin).addScaledVector(direction, 1.2);
    projectile.velocity.copy(direction).multiplyScalar(this.speedFor(kind));
    projectile.material.color.setHex(def.color);
    projectile.mesh.scale.setScalar(kind === 'WEB_BOMB' ? 1.5 : 1);
    return true;
  }

  update(dt: number, providers: readonly TargetProvider[]): void {
    for (const [kind, remaining] of this.cooldowns) {
      if (remaining > 0) this.cooldowns.set(kind, Math.max(0, remaining - dt));
    }

    for (const p of this.projectiles) {
      if (!p.active) continue;

      p.life -= dt;
      p.velocity.y -= CONFIG.physics.gravity * 0.35 * dt;

      _step.copy(p.velocity).multiplyScalar(dt);
      const distance = _step.length();

      // `_impact` is a dedicated scratch, never a reference to a target's live
      // position: detonate() displaces targets, and aliasing the blast origin
      // to one of them made the origin drift mid-explosion.
      let hasImpact = false;
      if (distance > 1e-5) {
        _dir.copy(_step).divideScalar(distance);
        const hit = this.city.raycast(p.mesh.position, _dir, distance);
        if (hit) {
          _impact.copy(hit.point);
          hasImpact = true;
        }
      }

      // Direct hit on a target takes priority over the surface behind it.
      // Tested against the swept segment, not just the start point, or a fast
      // gadget tunnels straight through anything it should have hit.
      const direct = this.findTargetOnSegment(p.mesh.position, _step, 2.4, providers);
      if (direct) {
        _impact.copy(direct.pos);
        hasImpact = true;
      }

      if (!hasImpact) {
        p.mesh.position.add(_step);
        if (p.mesh.position.y < 0.2 || p.life <= 0) {
          _impact.copy(p.mesh.position);
          this.detonate(p, _impact, providers);
        }
        continue;
      }

      this.detonate(p, _impact, providers);
    }

    for (const burst of this.bursts) {
      if (burst.life <= 0) continue;
      burst.life -= dt;
      if (burst.life <= 0) {
        burst.mesh.visible = false;
        continue;
      }
      const t = 1 - burst.life / burst.maxLife;
      burst.mesh.scale.setScalar(0.4 + t * burst.size);
      burst.material.opacity = (1 - t) * 0.7;
    }
  }

  dispose(): void {
    for (const d of this.disposables) d.dispose();
    this.disposables.length = 0;
    this.group.clear();
  }

  // ---------------------------------------------------------------- private

  private detonate(
    projectile: Projectile,
    at: THREE.Vector3,
    providers: readonly TargetProvider[],
  ): void {
    projectile.active = false;
    projectile.mesh.visible = false;

    const kind = projectile.kind;
    const radius = this.radiusFor(kind);
    const damage = this.damageFor(kind) * this.damageMultiplier;
    const def = GADGETS.find((g) => g.id === kind)!;

    let hits = 0;
    for (const provider of providers) {
      for (const target of provider.combatTargets) {
        if (!target.alive) continue;
        const distance = reachTo(target, at);
        if (distance > radius) continue;

        provider.damageTarget(target, damage, at);
        hits++;

        switch (kind) {
          case 'TRIP_MINE':
            // Pure damage, no crowd control.
            break;
          case 'ELECTRIC_WEB':
            // Long stun is the whole point of this one.
            target.webbed = Math.max(target.webbed, CONFIG.gadgets.electricWeb.stun);
            break;
          case 'CONCUSSIVE': {
            // Launch outward and up rather than cocooning.
            _tmp.copy(target.pos).sub(at);
            if (_tmp.lengthSq() < 1e-6) _tmp.set(0, 1, 0);
            const falloff = 1 - clamp(distance / radius, 0, 1);
            _tmp.normalize().multiplyScalar(CONFIG.gadgets.concussive.knockback * falloff);
            _tmp.y = Math.abs(_tmp.y) + 10 * falloff;
            target.pos.addScaledVector(_tmp, 0.06);
            break;
          }
          case 'GRABBER': {
            // Drag everything toward the impact point to stack them up.
            _tmp.copy(at).sub(target.pos);
            const pullDistance = _tmp.length();
            if (pullDistance > 0.5) {
              _tmp.divideScalar(pullDistance).multiplyScalar(Math.min(pullDistance, CONFIG.gadgets.grabber.pull));
              target.pos.addScaledVector(_tmp, 0.5);
            }
            target.webbed = Math.max(target.webbed, CONFIG.gadgets.webbedDuration);
            break;
          }
          default:
            target.webbed = Math.max(target.webbed, CONFIG.gadgets.webbedDuration);
            break;
        }
      }
    }

    this.spawnBurst(at, def.color, radius);
    if (hits > 0) this.onHit?.(kind, hits);
  }

  /**
   * Nearest target to the segment `from` → `from + step`. Sweeping rather than
   * point-testing matters: at 84 m/s a trip mine covers 1.4 m per frame at
   * 60 Hz and several metres on a slow frame, so a point test at the old
   * position misses anything it passes through.
   */
  private findTargetOnSegment(
    from: THREE.Vector3,
    step: THREE.Vector3,
    radius: number,
    providers: readonly TargetProvider[],
  ): CombatTarget | null {
    let best: CombatTarget | null = null;
    let bestDist = radius;
    const lengthSq = step.lengthSq();

    for (const provider of providers) {
      for (const target of provider.combatTargets) {
        if (!target.alive) continue;

        // Closest point on the segment to the target, clamped to [0, 1].
        _closest.copy(target.pos).sub(from);
        const t = lengthSq > 1e-8 ? clamp(_closest.dot(step) / lengthSq, 0, 1) : 0;
        _closest.copy(from).addScaledVector(step, t);

        const d = reachTo(target, _closest);
        if (d < bestDist) {
          bestDist = d;
          best = target;
        }
      }
    }
    return best;
  }

  private baseAmmo(kind: GadgetId): number {
    switch (kind) {
      case 'WEB_BOMB':
        return CONFIG.gadgets.webBomb.ammo;
      case 'TRIP_MINE':
        return CONFIG.gadgets.tripMine.ammo;
      case 'CONCUSSIVE':
        return CONFIG.gadgets.concussive.ammo;
      case 'ELECTRIC_WEB':
        return CONFIG.gadgets.electricWeb.ammo;
      case 'GRABBER':
        return CONFIG.gadgets.grabber.ammo;
      default:
        return CONFIG.gadgets.impactWeb.ammo;
    }
  }

  private cooldownFor(kind: GadgetId): number {
    switch (kind) {
      case 'WEB_BOMB':
        return CONFIG.gadgets.webBomb.cooldown;
      case 'TRIP_MINE':
        return CONFIG.gadgets.tripMine.cooldown;
      case 'CONCUSSIVE':
        return CONFIG.gadgets.concussive.cooldown;
      case 'ELECTRIC_WEB':
        return CONFIG.gadgets.electricWeb.cooldown;
      case 'GRABBER':
        return CONFIG.gadgets.grabber.cooldown;
      default:
        return CONFIG.gadgets.impactWeb.cooldown;
    }
  }

  private speedFor(kind: GadgetId): number {
    switch (kind) {
      case 'WEB_BOMB':
        return CONFIG.gadgets.webBomb.speed;
      case 'TRIP_MINE':
        return CONFIG.gadgets.tripMine.speed;
      case 'CONCUSSIVE':
        return CONFIG.gadgets.concussive.speed;
      case 'ELECTRIC_WEB':
        return CONFIG.gadgets.electricWeb.speed;
      case 'GRABBER':
        return CONFIG.gadgets.grabber.speed;
      default:
        return CONFIG.gadgets.impactWeb.speed;
    }
  }

  private damageFor(kind: GadgetId): number {
    switch (kind) {
      case 'WEB_BOMB':
        return CONFIG.gadgets.webBomb.damage;
      case 'TRIP_MINE':
        return CONFIG.gadgets.tripMine.damage;
      case 'CONCUSSIVE':
        return CONFIG.gadgets.concussive.damage;
      case 'ELECTRIC_WEB':
        return CONFIG.gadgets.electricWeb.damage;
      case 'GRABBER':
        return CONFIG.gadgets.grabber.damage;
      default:
        return CONFIG.gadgets.impactWeb.damage;
    }
  }

  /** Blast radius, in metres. */
  private radiusFor(kind: GadgetId): number {
    switch (kind) {
      case 'WEB_BOMB':
        return CONFIG.gadgets.webBomb.radius;
      case 'CONCUSSIVE':
        return CONFIG.gadgets.concussive.radius;
      case 'ELECTRIC_WEB':
        return CONFIG.gadgets.electricWeb.radius;
      case 'GRABBER':
        return CONFIG.gadgets.grabber.radius;
      default:
        return 3.2;
    }
  }

  private createProjectile(): Projectile {
    const geometry = new THREE.SphereGeometry(0.28, 8, 6);
    const material = new THREE.MeshBasicMaterial({ color: 0xffffff, toneMapped: false });
    const mesh = new THREE.Mesh(geometry, material);
    mesh.visible = false;
    mesh.frustumCulled = false;
    this.group.add(mesh);
    this.disposables.push(geometry, material);
    return {
      mesh,
      material,
      velocity: new THREE.Vector3(),
      kind: 'IMPACT_WEB',
      life: 0,
      active: false,
    };
  }

  private createBurst(): Burst {
    const geometry = new THREE.SphereGeometry(1, 12, 10);
    const material = new THREE.MeshBasicMaterial({
      color: 0xffffff,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      toneMapped: false,
    });
    const mesh = new THREE.Mesh(geometry, material);
    mesh.visible = false;
    this.group.add(mesh);
    this.disposables.push(geometry, material);
    return { mesh, material, life: 0, maxLife: 0.42, size: 4 };
  }

  private spawnBurst(at: THREE.Vector3, color: number, size: number): void {
    const burst = this.bursts.find((b) => b.life <= 0) ?? this.bursts[0]!;
    burst.mesh.position.copy(at);
    burst.material.color.setHex(color);
    burst.life = burst.maxLife;
    burst.size = clamp(size, 2, 16);
    burst.mesh.visible = true;
    burst.mesh.scale.setScalar(0.4);
    _tmp.set(0, 0, 0); // keep the scratch referenced for future use
  }
}
