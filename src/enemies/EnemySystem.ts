import * as THREE from 'three';
import { CONFIG } from '../core/Config';
import { clamp, damp, type Rng } from '../core/MathUtils';
import type { Building, City } from '../world/City';
import type { Player } from '../player/Player';
import { createEmblemMesh } from '../game/SpiderEmblem';
import { applyRimLight } from '../game/RimLight';
import { poseVillain, type PoseIntent, type PoseProfile, type PoseState } from './VillainPose';
import { VillainBuilder } from './VillainParts';
import type { CombatTarget, TargetProvider } from './CombatTarget';

export type VillainKind =
  | 'VENOM'
  | 'BLACK CAT'
  | 'ELECTRO'
  | 'GREEN GOBLIN'
  | 'SANDMAN'
  | 'SYMBIOTE PETER';

/** Roster order, which is also the order free roam turns them loose in. */
export const VILLAIN_KINDS: readonly VillainKind[] = [
  'BLACK CAT',
  'ELECTRO',
  'SANDMAN',
  'VENOM',
  'GREEN GOBLIN',
  'SYMBIOTE PETER',
];

export interface Villain {
  readonly kind: VillainKind;
  readonly name: string;
  readonly color: number;
  hp: number;
  /** Mutable so the post-game tier can raise it on revival. */
  maxHp: number;
  /** Tier-0 health, so scaling is always applied to the original figure. */
  readonly baseHp: number;
  alive: boolean;
  readonly pos: THREE.Vector3;
  readonly vel: THREE.Vector3;
  readonly root: THREE.Group;
  home: Building;
  /** Behaviour-specific sub-state. */
  phase: string;
  timer: number;
  cooldown: number;
  /** Where this villain is currently trying to get to. */
  readonly target: THREE.Vector3;
  /** Scaled during wind-ups and hit reactions. */
  readonly bodyPivot: THREE.Group;
  hitFlash: number;
  /** Winding up an attack — this is what spider-sense reads. */
  telegraphing: boolean;
  /** Independent cooldown for a villain's ranged special. */
  specialCooldown: number;
  /** Centre of the arena this villain is confined to while engaged. */
  readonly arenaCentre: THREE.Vector3;
  arenaActive: boolean;
  /** Sprint reserve, 0..1. Only Black Cat uses it. */
  stamina: number;
  /** Seconds of cocooned/stunned time remaining. */
  webbed: number;
  /**
   * Incoming damage multiplier. Sandman drops this while collapsed into loose
   * sand, so the fight has a rhythm instead of being a flat damage race.
   */
  damageScale: number;
  /** Seconds since this villain last took a hit, for regenerating bosses. */
  sinceHit: number;
  /** Second wind-up timer, independent of `timer`. Used by Sandman's pillar. */
  chargeTimer: number;
  /** Hits taken recently. At the threshold the boss shoves you off. */
  poise: number;
  /** Time left on the current poise window; expiry resets `poise`. */
  poiseTimer: number;
  /** Gap enforced between retaliations. */
  poiseCooldown: number;
  /** Countdown to the next unprovoked reposition. See shouldDrift. */
  driftTimer: number;
  /**
   * Model scale this villain enters play at. 1 for everyone except Sandman,
   * who is deliberately the size of a building.
   */
  baseScale: number;
  /**
   * Named joints from the model builder: `shoulderL/R`, `elbowL/R`, and for
   * Sandman `hipL/R` and `kneeL/R`. Empty for a model with no articulation.
   */
  readonly joints: Map<string, THREE.Group>;
  /** Walk/idle cycle position for the limb animation. */
  readonly pose: PoseState;
  /** Counts down after a ranged attack, holding the arms out. */
  rangedHold: number;
  /** Body radius at scale 1. Multiplied by the live scale into `hitRadius`. */
  hitRadiusUnit: number;
  /** Current body radius; range checks subtract it. See CombatTarget. */
  hitRadius: number;
  /**
   * Squash and stretch the *behaviour* wants, before the hit flash.
   *
   * These used to be written straight onto `bodyPivot.scale`, and the update
   * loop then set that same scale from the hit flash on the very next line —
   * so Venom's crouch, Sandman's collapse, the symbiote's coil and the shove
   * wind-up were all silently overwritten within the same frame. Four
   * telegraphs that existed in the code and never appeared on screen.
   */
  readonly pivotScale: THREE.Vector3;
  /**
   * Distance from this villain's origin down to the soles of its feet,
   * measured from the built mesh.
   *
   * Every ground villain used to be pinned at a flat 1.6 m above the surface
   * regardless of how tall it actually was, which left all of them hovering —
   * Venom by better than a metre. Measuring it means a model change can never
   * silently reintroduce the float.
   */
  groundOffset: number;
  /** World point a charged area attack is aimed at. */
  readonly chargePoint: THREE.Vector3;
  /**
   * Spawned but not yet in play. Villains stay dormant until enough street
   * crime has been cleared to draw them out, so the city doesn't open with
   * all three bosses live at once.
   */
  dormant: boolean;
  /**
   * True once this fight has crossed the halfway mark.
   *
   * A latch, not a comparison: the point of it is to fire the villain's
   * mid-fight line exactly once, and health can cross the threshold more than
   * once where a boss guards, reforms or is revived.
   */
  turned: boolean;
}

const _v1 = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _v3 = new THREE.Vector3();
const _bounds = new THREE.Box3();
const UP = new THREE.Vector3(0, 1, 0);

/**
 * Bosses whose arena leaves your webs switched on.
 *
 * The block exists so a stand-and-fight boss is a fight rather than a chase.
 * That reasoning only applies to bosses who stand and fight:
 *
 * - Electro hovers and the Goblin flies. Grounding the player against an
 *   airborne boss leaves them no way to reach it at all.
 * - Black Cat's entire encounter *is* a rooftop chase. She runs at 24 m/s and
 *   the player runs at 13, so taking the webs away makes her mathematically
 *   uncatchable — which is exactly how it played.
 *
 * Venom, Sandman and Symbiote Peter come to you, so they keep the block.
 */
const KEEPS_WEBS: ReadonlySet<VillainKind> = new Set<VillainKind>([
  'ELECTRO',
  'GREEN GOBLIN',
  'BLACK CAT',
]);

/**
 * Villains whose fight needs room. Everyone else is tethered to a tight ring
 * so they cannot simply walk out of the encounter.
 */
const WIDE_ARENA: ReadonlySet<VillainKind> = new Set<VillainKind>(['GREEN GOBLIN']);

/**
 * Villains exempt from the idle reposition, because their own behaviour
 * already keeps them moving — or, for Sandman, because standing his ground is
 * the point.
 */
const NO_DRIFT: ReadonlySet<VillainKind> = new Set<VillainKind>([
  'BLACK CAT',
  'GREEN GOBLIN',
  'SANDMAN',
]);

/** How long a ranged attack keeps the arms out after it fires, in seconds. */
const RANGED_HOLD = 0.55;

/**
 * Limb proportions per villain. What differs between them is reach and speed,
 * not what a shoulder does — see VillainPose.
 */
const POSE_PROFILES: Record<VillainKind, PoseProfile> = {
  VENOM: { reach: 1.15, speed: 0.9, lead: -1, legs: false },
  'BLACK CAT': { reach: 0.9, speed: 1.5, lead: -1, legs: false },
  ELECTRO: { reach: 1, speed: 1.2, lead: -1, legs: false },
  'GREEN GOBLIN': { reach: 0.95, speed: 1.3, lead: -1, legs: false },
  // Enormous and slow. His arms are the only part of him that can reach you,
  // so they are the widest swing in the game and the most telegraphed.
  SANDMAN: { reach: 1.3, speed: 0.55, lead: -1, legs: true },
  'SYMBIOTE PETER': { reach: 1.05, speed: 1.4, lead: -1, legs: false },
};

/** Resting behaviour each villain falls back to between attacks. */
function startPhase(kind: VillainKind): string {
  switch (kind) {
    case 'BLACK CAT':
      return 'IDLE';
    case 'GREEN GOBLIN':
      return 'ORBIT';
    case 'SANDMAN':
    case 'SYMBIOTE PETER':
      return 'STALK';
    default:
      return 'PERCH';
  }
}

/**
 * Three hand-authored villains with distinct movement logic, plus the
 * projectile and impact effect pools they need.
 */
export class EnemySystem implements TargetProvider {
  readonly group = new THREE.Group();
  readonly villains: Villain[] = [];

  /** Raised when a villain does something worth a spoken taunt. */
  onTaunt: ((kind: VillainKind) => void) | null = null;
  /** Raised the moment a villain starts winding up, for the spider-sense cue. */
  onTelegraph: ((kind: VillainKind) => void) | null = null;
  /** Raised when a villain attack connects, for sound and camera shake. */
  onAttackLanded: ((kind: VillainKind) => void) | null = null;
  /** Raised when a villain fires a ranged attack, for sound. */
  onRangedAttack: ((kind: VillainKind) => void) | null = null;
  /** Raised when a lobbed projectile detonates, for sound. */
  onProjectileBurst: ((kind: ProjectileKind) => void) | null = null;
  /** Raised when a villain's health reaches zero. */
  onDefeated: ((villain: Villain) => void) | null = null;
  /**
   * Gives every live villain a share of their health back, and stands them
   * down out of their arena.
   *
   * Called when the player goes down. Without it a boss fight is an attrition
   * war the player cannot lose: death restored the player to full and left the
   * villain exactly as damaged as they were, so any boss could be ground down
   * across as many lives as it took.
   *
   * The half-health latch is released for anyone this pushes back above the
   * halfway mark, because their mid-fight line is about the fight turning and
   * the fight has just turned back.
   */
  relieve(fraction: number, near: THREE.Vector3, radius: number): number {
    let helped = 0;
    const radiusSq = radius * radius;
    for (const villain of this.villains) {
      if (!villain.alive || villain.dormant) continue;
      // Only the ones who were actually in it. Free roam has the whole roster
      // live at once, so relieving everybody meant dying to a street mugger
      // handed health back to six bosses across the city.
      const inTheFight = villain.arenaActive || villain.pos.distanceToSquared(near) < radiusSq;
      if (!inTheFight) continue;
      const before = villain.hp;
      villain.hp = Math.min(villain.maxHp, villain.hp + villain.maxHp * fraction);
      if (villain.hp > villain.maxHp * 0.5) villain.turned = false;
      // Disengaging as well: the player is about to reappear somewhere else,
      // and a boss still holding an arena around a corpse looks broken.
      villain.arenaActive = false;
      if (villain.hp > before) helped++;
    }
    return helped;
  }

  /**
   * Raised once per fight, the first time a villain drops below half health.
   *
   * The moment a boss fight turns is the one point in it with anything new to
   * say, and there was no way to know it had happened from outside.
   */
  onTurn: ((villain: Villain) => void) | null = null;

  private readonly activeTargets: CombatTarget[] = [];
  private readonly bolts: Bolt[] = [];
  private readonly bombs: Bomb[] = [];
  private readonly impacts: Impact[] = [];
  private readonly disposables: Array<{ dispose(): void }> = [];
  private readonly city: City;

  constructor(city: City, rng: Rng) {
    this.city = city;
    this.group.name = 'Villains';

    for (const kind of VILLAIN_KINDS) this.spawn(kind, city, rng);

    // Two villains can be live at once now, so the pools carry more.
    for (let i = 0; i < 10; i++) this.bolts.push(this.createBolt());
    for (let i = 0; i < 12; i++) this.impacts.push(this.createImpact());
    for (let i = 0; i < 14; i++) this.bombs.push(this.createBomb());
  }

  /** Every villain currently in play, for the HUD's multi-boss readout. */
  get engaged(): readonly Villain[] {
    return this.villains.filter((v) => v.alive && !v.dormant);
  }

  get remaining(): number {
    return this.villains.reduce((n, v) => n + (v.alive && !v.dormant ? 1 : 0), 0);
  }

  /**
   * Post-game escalation tier. 0 during the campaign.
   *
   * Scales boss health and outgoing damage together, so a tier-5 Venom is a
   * genuinely different fight rather than just a longer one.
   */
  tier = 0;

  private get tierDamageScale(): number {
    return 1 + this.tier * 0.22;
  }

  /** Health multiplier a boss is revived with at the current tier. */
  get tierHealthScale(): number {
    return 1 + this.tier * 0.45;
  }

  /**
   * Every point of damage a villain deals to the player passes through here.
   *
   * A single choke point is what makes the post-game tier possible without
   * threading a multiplier through a dozen attack implementations.
   */
  private hurtPlayer(player: Player, amount: number, knockback?: THREE.Vector3): boolean {
    return player.takeDamage(amount * this.tierDamageScale, knockback);
  }

  /** Villains still waiting to be drawn out by clearing crime. */
  get dormantCount(): number {
    return this.villains.reduce((n, v) => n + (v.alive && v.dormant ? 1 : 0), 0);
  }

  /**
   * Brings the next dormant villain into play, relocating it to a rooftop a
   * sensible distance from the player. Returns null when none are left.
   */
  activateNext(near: THREE.Vector3, rng: Rng, preferKind?: VillainKind): Villain | null {
    // A named villain is a requirement, not a preference.
    //
    // This used to read "the one you asked for, or failing that anyone still
    // dormant", which quietly turned a rematch into a boss marathon. Every
    // rematch chapter asks for somebody already beaten — so already not
    // dormant — and the fallback handed back whoever happened to be next in
    // the roster instead. That villain was not what the chapter wanted, so the
    // chapter stayed unfinished and asked again on the next crime, fielding
    // another wrong villain, and another, until the roster ran dry and the
    // revival below was finally reached. Book One's finale is the first
    // rematch in the game, which is where it showed.
    const villain = preferKind
      ? (this.villains.find((v) => v.alive && v.dormant && v.kind === preferKind) ??
        this.revive(preferKind))
      : this.villains.find((v) => v.alive && v.dormant);

    if (!villain) return null;

    // A team-up has to arrive as a team.
    //
    // Both halves used to be homed independently in a 160–420 m ring around
    // the player, so a "both at once" finale could open with half a kilometre
    // between them — two separate fights wearing one chapter's name. If one of
    // them is already out, the second lands on a neighbouring roof instead.
    const partner = this.villains.find(
      (other) => other !== villain && other.alive && !other.dormant,
    );
    if (partner && partner.pos.distanceTo(near) < 520) {
      const beside = this.city.roofNear(rng, partner.pos.x, partner.pos.z, 14, 52);
      if (beside) {
        villain.home = beside;
        return this.placeVillain(villain);
      }
    }

    // Re-home somewhere reachable but not on top of the player, and clear of
    // any villain already in play — a team-up that spawns stacked reads as one
    // enemy with a rendering glitch.
    // This used to reject-sample `randomRoof(rng, 80)`: uniform over every
    // building on the map, filtered to towers 80 m and up, forty tries. Fine
    // in Midtown. On the Queens import there are barely any 80 m towers and
    // the ring is ~2 % of the map, so nearly every spawn exhausted its
    // attempts and left the villain at whatever rooftop they were last homed
    // to — usually kilometres away. The alert fired and nobody turned up.
    //
    // `roofNear` walks only the ring, so it finds a roof whenever one exists.
    // A tall one is preferred as an arena; any roof beats not showing up.
    outer: for (const minHeight of [40, 0]) {
      for (let attempt = 0; attempt < 8; attempt++) {
        const candidate = this.city.roofNear(rng, near.x, near.z, 160, 420, 0, minHeight);
        if (!candidate) break;
        const crowded = this.villains.some(
          (other) => other !== villain && other.alive && !other.dormant && other.pos.distanceTo(candidate.roof) < 70,
        );
        if (crowded) continue;
        villain.home = candidate;
        break outer;
      }
    }

    return this.placeVillain(villain);
  }

  /**
   * Brings a beaten villain back for a rematch.
   *
   * The later books re-fight faces from earlier ones, so "already defeated" has
   * to mean "available again", not "unavailable". Only the flags that outlive a
   * death are cleared here; everything a fresh encounter needs — health, phase,
   * size, position — is `placeVillain`'s job, so a revival and a first meeting
   * enter the fight through exactly one definition of it.
   */
  private revive(kind: VillainKind): Villain | undefined {
    const fallen = this.villains.find((v) => v.kind === kind && !v.alive);
    if (!fallen) return undefined;
    fallen.alive = true;
    fallen.webbed = 0;
    fallen.hitFlash = 0;
    fallen.arenaActive = false;
    fallen.turned = false;
    return fallen;
  }

  /**
   * Puts a villain into play at whatever `home` it has been given, resetting
   * everything a fresh encounter should start clean. Split out of
   * `activateNext` so a team-up can choose a different rooftop and still share
   * one definition of "enters the fight".
   */
  private placeVillain(villain: Villain): Villain {
    villain.pos.set(
      villain.home.roof.x,
      this.startHeight(villain.kind, villain.home.roof.y, villain.groundOffset),
      villain.home.roof.z,
    );
    villain.target.copy(villain.home.roof);
    // Electro orbits `target`, so it has to carry his hover altitude or he
    // would settle at roof level instead of above it.
    if (villain.kind === 'ELECTRO') villain.target.y += CONFIG.enemies.electro.hoverHeight;
    villain.root.position.copy(villain.pos);
    villain.root.visible = true;
    villain.dormant = false;
    villain.phase = startPhase(villain.kind);
    villain.bodyPivot.rotation.set(0, 0, 0);
    villain.bodyPivot.scale.setScalar(1);
    villain.pivotScale.setScalar(1);
    // Sandman reforms larger as a fight goes on; a rematch starts him back at
    // his base size, and `stamina` is his one-collapse-per-fight flag.
    villain.root.scale.setScalar(villain.baseScale);
    villain.hitRadius = villain.hitRadiusUnit * villain.baseScale;
    villain.vel.set(0, 0, 0);
    villain.stamina = 1;
    villain.turned = false;
    villain.damageScale = 1;
    villain.chargeTimer = 0;
    villain.sinceHit = 0;
    villain.cooldown = 0;
    villain.specialCooldown = 0;
    villain.poise = 0;
    villain.poiseTimer = 0;
    villain.poiseCooldown = 0;
    villain.driftTimer = CONFIG.enemies.poise.driftInterval;
    // Health is set here, not at spawn, so a boss always enters play at the
    // tier that is current *now* — including a revival for a post-game wave.
    villain.maxHp = Math.round(villain.baseHp * this.tierHealthScale);
    villain.hp = villain.maxHp;
    this.refreshActiveTargets();
    return villain;
  }

  /** Resting altitude above a rooftop, which only the fliers deviate from. */
  private startHeight(kind: VillainKind, roofY: number, groundOffset: number): number {
    if (kind === 'ELECTRO') return roofY + CONFIG.enemies.electro.hoverHeight;
    if (kind === 'GREEN GOBLIN') return roofY + CONFIG.enemies.goblin.hoverHeight;
    return roofY + groundOffset;
  }

  /** Marks a villain as already beaten, used when restoring a save. */
  retire(kind: VillainKind): void {
    const villain = this.villains.find((v) => v.kind === kind);
    if (!villain) return;
    villain.alive = false;
    villain.dormant = false;
    villain.root.visible = false;
    this.refreshActiveTargets();
  }

  /**
   * The most imminent villain attack, for the spider-sense indicator: Venom
   * winding up a leap, or Electro lining up a bolt.
   */
  incomingAttack(playerPos: THREE.Vector3): { direction: THREE.Vector3; urgency: number } | null {
    let best: Villain | null = null;
    let bestUrgency = 0;

    for (const v of this.villains) {
      if (!v.alive || v.dormant) continue;
      const distance = v.pos.distanceTo(playerPos);
      let urgency = 0;

      if (v.kind === 'VENOM' && v.phase === 'WINDUP') {
        urgency = 1 - clamp(v.timer / CONFIG.enemies.venom.windup, 0, 1);
      } else if (
        v.kind === 'ELECTRO' &&
        distance < CONFIG.enemies.electro.zoneRange &&
        v.cooldown < 0.5
      ) {
        urgency = 1 - v.cooldown / 0.5;
      } else if (v.kind === 'GREEN GOBLIN' && v.phase === 'DIVE') {
        // A committed strafing run is the clearest telegraph he has.
        urgency = clamp(1 - distance / 40, 0, 1);
      } else if (v.kind === 'SANDMAN' && v.phase === 'PILLAR') {
        // The pillar is aimed at a point, so the warning is about that point
        // rather than about Sandman himself — move and it misses entirely.
        urgency = 1 - clamp(v.chargeTimer / CONFIG.enemies.sandman.pillarWindup, 0, 1);
      } else if (v.kind === 'SYMBIOTE PETER' && v.phase === 'DASH_WINDUP') {
        urgency = 1 - clamp(v.timer / CONFIG.enemies.symbiote.dashWindup, 0, 1);
      } else if (v.phase === 'REPEL') {
        // The poise shove is the one attack you provoke yourself, so it has to
        // be the most readable thing on screen.
        urgency = 1 - clamp(v.timer / CONFIG.enemies.poise.telegraph, 0, 1);
      }

      if (urgency > bestUrgency) {
        bestUrgency = urgency;
        best = v;
      }
    }

    if (!best || bestUrgency <= 0) return null;
    const direction = new THREE.Vector3().copy(best.pos).sub(playerPos).setY(0).normalize();
    return { direction, urgency: bestUrgency };
  }

  // ---------------------------------------------------------------- update

  update(dt: number, player: Player): void {
    for (const v of this.villains) {
      if (!v.alive || v.dormant) continue;

      v.cooldown = Math.max(0, v.cooldown - dt);
      v.specialCooldown = Math.max(0, v.specialCooldown - dt);
      v.hitFlash = Math.max(0, v.hitFlash - dt * 4);
      v.sinceHit += dt;
      v.poiseCooldown = Math.max(0, v.poiseCooldown - dt);
      if (v.poiseTimer > 0) {
        v.poiseTimer -= dt;
        // The window lapsed without reaching the threshold: they shrug it off.
        if (v.poiseTimer <= 0) v.poise = 0;
      }
      if (
        v.phase !== 'SWIPE' &&
        v.phase !== 'PILLAR' &&
        v.phase !== 'DASH_WINDUP' &&
        v.phase !== 'REPEL'
      ) {
        v.telegraphing = false;
      }

      // Cocooned by a gadget: frozen in place until it wears off. The limbs
      // still get posed — a villain that freezes mid-swing inside a cocoon
      // reads as the game hanging rather than as a stunned enemy.
      if (v.webbed > 0) {
        v.webbed = Math.max(0, v.webbed - dt);
        this.poseLimbs(dt, v);
        v.root.position.copy(v.pos);
        this.applyPivotScale(v);
        continue;
      }

      // A boss being stood next to and punched forever interrupts whatever it
      // was doing to shove the player off and relocate. Checked before the
      // per-kind behaviour so it can pre-empt any of them.
      if (v.phase === 'REPEL' || v.phase === 'REPEL_MOVE') {
        this.updateRepel(dt, v, player);
        this.poseLimbs(dt, v);
        v.root.position.copy(v.pos);
        this.applyPivotScale(v, 0.05);
        continue;
      }
      if (this.shouldRepel(v)) {
        this.beginRepel(v, player);
        continue;
      }
      v.driftTimer -= dt;
      if (this.shouldDrift(v)) {
        this.beginDrift(v, player);
        continue;
      }

      switch (v.kind) {
        case 'VENOM':
          this.updateVenom(dt, v, player);
          break;
        case 'BLACK CAT':
          this.updateBlackCat(dt, v, player);
          break;
        case 'ELECTRO':
          this.updateElectro(dt, v, player);
          break;
        case 'GREEN GOBLIN':
          this.updateGoblin(dt, v, player);
          break;
        case 'SANDMAN':
          this.updateSandman(dt, v, player);
          break;
        case 'SYMBIOTE PETER':
          this.updateSymbiote(dt, v, player);
          break;
      }

      this.confineToArena(v, player);
      this.poseLimbs(dt, v);
      v.root.position.copy(v.pos);
      this.applyPivotScale(v);
    }

    this.updateBolts(dt);
    this.updateImpacts(dt);
    this.updateBombs(dt, player);
  }

  /**
   * Has this boss taken enough punishment to answer it?
   *
   * Excluded phases are the ones where a shove would break the encounter's own
   * design: Black Cat's winded window and Sandman's collapse are *deliberate*
   * punish opportunities, and interrupting an in-flight leap or dash would eat
   * an attack the player is already reacting to.
   */
  private shouldRepel(v: Villain): boolean {
    if (v.poise < CONFIG.enemies.poise.hits || v.poiseCooldown > 0) return false;
    return (
      v.phase !== 'WINDED' &&
      v.phase !== 'COLLAPSE' &&
      v.phase !== 'LEAP' &&
      v.phase !== 'DASH' &&
      v.phase !== 'DIVE'
    );
  }

  /**
   * Is it time to move for the sake of moving?
   *
   * Poise only answers being punched, so a patient player who lands two hits,
   * steps back and comes round the other side never triggered it — the fight
   * still amounted to holding one button in one spot. This keeps the boss
   * circling whatever the player does.
   *
   * The exclusions are villains whose own movement already does this: Black
   * Cat runs by design, Goblin is permanently orbiting, and Sandman is meant
   * to be a slab of the skyline that walks — relocating him would undercut
   * the one thing that makes him feel enormous.
   */
  private shouldDrift(v: Villain): boolean {
    if (!v.arenaActive || v.driftTimer > 0 || v.telegraphing) return false;
    if (NO_DRIFT.has(v.kind)) return false;
    return (
      v.phase !== 'WINDED' &&
      v.phase !== 'COLLAPSE' &&
      v.phase !== 'LEAP' &&
      v.phase !== 'DASH' &&
      v.phase !== 'DIVE'
    );
  }

  /** A reposition with no shove attached — they simply relocate. */
  private beginDrift(v: Villain, player: Player): void {
    const cfg = CONFIG.enemies.poise;
    this.pickRepositionTarget(v, player);
    v.phase = 'REPEL_MOVE';
    v.timer = cfg.recover;
    v.driftTimer = cfg.driftInterval + Math.random() * cfg.driftIntervalJitter;
  }

  /** Winds up the shove and picks somewhere to go afterwards. */
  private beginRepel(v: Villain, player: Player): void {
    const cfg = CONFIG.enemies.poise;
    v.phase = 'REPEL';
    v.timer = cfg.telegraph;
    v.poise = 0;
    v.poiseTimer = 0;
    v.poiseCooldown = cfg.cooldown + cfg.telegraph + cfg.recover;
    v.damageScale = cfg.guardScale;
    v.telegraphing = true;
    this.onTelegraph?.(v.kind);
    this.onTaunt?.(v.kind);

    this.pickRepositionTarget(v, player);
  }

  /**
   * Somewhere else in the ring to stand, out from the player and inside the
   * wall. Shared by the punished shove and the idle drift.
   */
  private pickRepositionTarget(v: Villain, player: Player): void {
    const cfg = CONFIG.enemies.poise;

    // Roughly away from where the player currently is, with enough jitter that
    // it is not the same spot twice.
    const angle =
      Math.atan2(v.pos.z - player.pos.z, v.pos.x - player.pos.x) + (Math.random() - 0.5) * 2.4;
    v.target.set(
      player.pos.x + Math.cos(angle) * cfg.repositionRange,
      0,
      player.pos.z + Math.sin(angle) * cfg.repositionRange,
    );

    // Never relocate outside the arena — that is the one place the player
    // cannot follow.
    if (v.arenaActive) {
      _v1.set(v.target.x - v.arenaCentre.x, 0, v.target.z - v.arenaCentre.z);
      const limit = this.arenaRadius(v.kind) * 0.8;
      const distance = _v1.length();
      if (distance > limit) {
        _v1.multiplyScalar(limit / distance);
        v.target.set(v.arenaCentre.x + _v1.x, 0, v.arenaCentre.z + _v1.z);
      }
    }

    v.target.y = this.destinationHeight(v);
  }

  /** Altitude a villain should settle at over its target column. */
  private destinationHeight(v: Villain): number {
    const surface = this.surfaceHeight(v.target.x, v.target.z);
    if (v.kind === 'ELECTRO') return surface + CONFIG.enemies.electro.hoverHeight;
    if (v.kind === 'GREEN GOBLIN') return surface + CONFIG.enemies.goblin.hoverHeight;
    return surface + v.groundOffset;
  }

  /** Drives the shove and the relocation that follows it. */
  private updateRepel(dt: number, v: Villain, player: Player): void {
    const cfg = CONFIG.enemies.poise;
    v.timer -= dt;

    if (v.phase === 'REPEL') {
      v.telegraphing = true;
      this.faceTowards(v, player.pos, dt, 9);
      // Swell, then snap on the contact frame.
      const progress = 1 - clamp(v.timer / cfg.telegraph, 0, 1);
      v.pivotScale.setScalar(1 + progress * 0.26);

      if (v.timer <= 0) {
        v.pivotScale.setScalar(1);
        v.telegraphing = false;
        v.phase = 'REPEL_MOVE';
        v.timer = cfg.recover;

        // The shove itself: everything close gets thrown clear.
        this.spawnImpact(v.pos, v.color, 10);
        this.onProjectileBurst?.(v.kind === 'SANDMAN' ? 'SHARD' : 'SPLAT');
        if (v.pos.distanceTo(player.pos) < 13) {
          _v1.copy(player.pos).sub(v.pos);
          if (_v1.lengthSq() < 1e-4) _v1.set(0, 1, 0);
          _v1.normalize().multiplyScalar(cfg.knockback);
          _v1.y = Math.abs(_v1.y) + 14;
          if (this.hurtPlayer(player, cfg.damage, _v1)) this.onAttackLanded?.(v.kind);
        }
      }
      return;
    }

    // REPEL_MOVE: cross to the new position. Deliberately not a teleport —
    // you should be able to see where they went and chase them there.
    const rate = 1 - Math.exp(-4.5 * dt);
    v.pos.x += (v.target.x - v.pos.x) * rate;
    v.pos.z += (v.target.z - v.pos.z) * rate;
    v.pos.y += (v.target.y - v.pos.y) * rate;
    this.faceTowards(v, player.pos, dt, 5);
    v.pivotScale.setScalar(1);

    if (v.timer <= 0) {
      v.damageScale = 1;
      v.vel.set(0, 0, 0);
      v.phase = startPhase(v.kind);
      // Electro orbits `target`, so leaving it here is what makes him stay at
      // the new spot rather than drifting home again.
      if (v.kind !== 'ELECTRO') v.target.copy(v.pos);
    }
  }

  /**
   * Shared close-quarters attack. Any villain can interrupt whatever it was
   * doing to telegraph and swing when the player gets inside melee reach.
   *
   * Returns true if the villain is currently committed to a swipe, in which
   * case the caller should skip its own movement logic this frame.
   */
  private updateMelee(
    dt: number,
    v: Villain,
    player: Player,
    damage: number,
    // Annotated: CONFIG is `as const`, so the default would pin this to `4.6`
    // and reject Sandman's longer reach.
    reach: number = CONFIG.enemies.melee.range,
  ): boolean {
    const cfg = CONFIG.enemies.melee;
    const distance = v.pos.distanceTo(player.pos);

    if (v.phase === 'SWIPE') {
      v.timer -= dt;
      const progress = 1 - clamp(v.timer / cfg.telegraph, 0, 1);
      // Torso turn behind the swing. Was 1.5 radians and did the whole job on
      // its own — the entire body slewing round because an arm that could not
      // move had to be faked somehow. Now the arms swing (see poseLimbs), so
      // this is only the weight behind them.
      v.bodyPivot.rotation.y = Math.sin(progress * Math.PI) * 0.7;
      this.faceTowards(v, player.pos, dt, 12);

      if (v.timer <= 0) {
        v.bodyPivot.rotation.y = 0;
        v.phase = 'SWIPE_RECOVER';
        v.timer = cfg.recover;
        v.cooldown = cfg.cooldown;

        if (v.pos.distanceTo(player.pos) < reach * 1.4) {
          _v3.copy(player.pos).sub(v.pos).setY(0);
          if (_v3.lengthSq() < 1e-4) _v3.set(1, 0, 0);
          _v3.normalize().multiplyScalar(cfg.lunge * 2.4);
          _v3.y = 7;
          if (this.hurtPlayer(player, damage, _v3)) {
            this.spawnImpact(player.pos, v.color, 3);
            this.onAttackLanded?.(v.kind);
          }
        }
      }
      return true;
    }

    if (v.phase === 'SWIPE_RECOVER') {
      v.timer -= dt;
      this.faceTowards(v, player.pos, dt, 5);
      if (v.timer <= 0) v.phase = startPhase(v.kind);
      return true;
    }

    // Enter a swipe when in reach and off cooldown.
    if (distance < reach && v.cooldown <= 0) {
      v.phase = 'SWIPE';
      v.timer = cfg.telegraph;
      v.telegraphing = true;
      this.onTelegraph?.(v.kind);
      return true;
    }

    return false;
  }

  /**
   * Aerial harasser: orbits the player on a glider lobbing pumpkin bombs, and
   * periodically commits to a strafing dive.
   */
  private updateGoblin(dt: number, v: Villain, player: Player): void {
    const cfg = CONFIG.enemies.goblin;
    const distance = v.pos.distanceTo(player.pos);
    const t = performance.now() * 0.001;

    // Glider blade swipe when the player closes on him in the air.
    if (v.phase !== 'DIVE' && this.updateMelee(dt, v, player, cfg.meleeDamage)) return;

    if (v.phase === 'DIVE') {
      v.timer -= dt;
      _v1.copy(player.pos).sub(v.pos);
      const gap = _v1.length();
      if (gap > 0.001) {
        _v1.divideScalar(gap);
        v.pos.addScaledVector(_v1, cfg.diveSpeed * dt);
      }
      this.faceTowards(v, player.pos, dt, 9);
      // Banked hard over during the run.
      v.bodyPivot.rotation.z = damp(v.bodyPivot.rotation.z, 0.6, 8, dt);

      if (gap < 3.2) {
        _v2.set(_v1.x * 22, 10, _v1.z * 22);
        if (this.hurtPlayer(player, cfg.diveDamage, _v2)) this.spawnImpact(player.pos, v.color, 3);
        v.phase = 'ORBIT';
        v.cooldown = cfg.diveCooldown;
      } else if (v.timer <= 0) {
        v.phase = 'ORBIT';
        v.cooldown = cfg.diveCooldown;
      }
      return;
    }

    // Orbit: circle the player at altitude, keeping the glider level-ish.
    v.bodyPivot.rotation.z = damp(v.bodyPivot.rotation.z, Math.sin(t * 0.8) * 0.25, 4, dt);

    const engaged = distance < cfg.engageRange;
    const centre = engaged ? player.pos : v.home.roof;
    const orbit = t * 0.42;
    const targetX = centre.x + Math.cos(orbit) * cfg.orbitRadius;
    const targetZ = centre.z + Math.sin(orbit) * cfg.orbitRadius;
    // Altitude is measured from the rooftops he is flying over, never from the
    // player.
    //
    // It used to be `max(centre.y, floor) + hoverHeight`, and `centre` is the
    // player once engaged — so every metre the player climbed toward him
    // raised his target by the same metre. Swinging up to meet him pushed him
    // up, which pushed the ceiling up, and the chase never converged: he was
    // not fleeing, he was being levitated by the player's own altitude.
    const floor = this.surfaceHeight(v.pos.x, v.pos.z);
    let targetY = floor + cfg.hoverHeight + Math.sin(t * 1.1) * 2;
    if (engaged) {
      // A ceiling relative to the player, so he is always within a swing of
      // being reached — but never below the rooftops he is crossing, or a
      // player standing in the street would pull him down into a tower.
      targetY = Math.max(
        floor + cfg.minClearance,
        Math.min(targetY, player.pos.y + cfg.maxRise),
      );
    }

    v.pos.x = damp(v.pos.x, targetX, cfg.speed * 0.09, dt);
    v.pos.z = damp(v.pos.z, targetZ, cfg.speed * 0.09, dt);
    v.pos.y = damp(v.pos.y, targetY, 2.4, dt);
    this.faceTowards(v, player.pos, dt, 5);

    if (!engaged) return;

    // Reaching his altitude is meant to be rewarded, not stonewalled: get
    // level with him and he commits to a dive rather than drifting off.
    if (v.cooldown <= 0 && player.pos.y > v.pos.y - 6 && distance < cfg.orbitRadius * 2.2) {
      v.phase = 'DIVE';
      v.timer = 2.4;
      this.onTaunt?.(v.kind);
      return;
    }

    // Lob a bomb, or commit to a dive when the cooldown allows.
    if (v.cooldown <= 0) {
      if (distance < cfg.orbitRadius * 1.6 && Math.abs(Math.sin(t * 3)) > 0.94) {
        v.phase = 'DIVE';
        v.timer = 2.4;
        this.onTaunt?.(v.kind);
        return;
      }
      v.cooldown = cfg.bombCooldown;
      v.rangedHold = RANGED_HOLD;
      this.throwBomb(v.pos, player.pos, v.color);
    }
  }

  /** Lobs a pumpkin bomb on a ballistic arc toward `target`. */
  private throwBomb(from: THREE.Vector3, target: THREE.Vector3, color: number): void {
    this.throwProjectile(from, target, color, 'BOMB', CONFIG.enemies.goblin.bombSpeed);
  }

  /**
   * Launches a pooled projectile on a ballistic arc. Bombs tumble and burst
   * wide; symbiote splats fly flatter and hit a single target harder.
   */
  private throwProjectile(
    from: THREE.Vector3,
    target: THREE.Vector3,
    color: number,
    kind: ProjectileKind,
    speed: number,
  ): void {
    const bomb = this.bombs.find((b) => !b.active) ?? this.bombs[0]!;

    bomb.mesh.position.copy(from);
    bomb.mesh.visible = true;
    bomb.active = true;
    bomb.kind = kind;
    bomb.life = kind === 'BOMB' ? CONFIG.enemies.goblin.bombLife : 4;
    bomb.material.color.setHex(color);
    // Splats are smaller, wetter blobs than the bronze bombs; shards are
    // smaller again, since a whole burst of them is in the air at once.
    bomb.mesh.scale.setScalar(kind === 'SPLAT' ? 0.55 : kind === 'SHARD' ? 0.4 : 1);

    // Solve a lob: level the aim, then add the vertical component needed to
    // cover the drop over the flight time.
    _v1.copy(target).sub(from);
    const flat = Math.hypot(_v1.x, _v1.z);
    const flight = Math.max(0.35, flat / speed);
    bomb.velocity.set(
      _v1.x / flight,
      _v1.y / flight + 0.5 * CONFIG.physics.gravity * flight,
      _v1.z / flight,
    );
  }

  private updateBombs(dt: number, player: Player): void {
    const cfg = CONFIG.enemies.goblin;

    for (const bomb of this.bombs) {
      if (!bomb.active) continue;

      bomb.life -= dt;
      bomb.velocity.y -= CONFIG.physics.gravity * dt;
      bomb.mesh.position.addScaledVector(bomb.velocity, dt);
      bomb.mesh.rotation.x += dt * 5;
      bomb.mesh.rotation.y += dt * 3;

      const ground = this.city.groundHeightAt(bomb.mesh.position.x, bomb.mesh.position.z);
      const hitPlayer = bomb.mesh.position.distanceTo(player.pos) < 2.6;
      const landed = bomb.mesh.position.y <= ground + 0.3;

      if (!hitPlayer && !landed && bomb.life > 0) continue;

      // Detonate.
      const isBomb = bomb.kind === 'BOMB';
      const isShard = bomb.kind === 'SHARD';
      const radius = isBomb ? cfg.bombRadius : isShard ? 2.6 : 4;
      const damage = isBomb
        ? cfg.bombDamage
        : isShard
          ? CONFIG.enemies.sandman.shardDamage
          : CONFIG.enemies.venom.splatDamage;
      const burstColor = isBomb ? 0x8fff4a : isShard ? 0xc9a26a : 0x9440bc;

      bomb.active = false;
      bomb.mesh.visible = false;
      this.spawnImpact(bomb.mesh.position, burstColor, radius);
      // A whole shard burst detonating would fire five sounds on one frame.
      if (!isShard || Math.random() < 0.34) this.onProjectileBurst?.(bomb.kind);

      if (bomb.mesh.position.distanceTo(player.pos) < radius) {
        _v1.copy(player.pos).sub(bomb.mesh.position);
        if (_v1.lengthSq() < 1e-4) _v1.set(0, 1, 0);
        _v1.normalize().multiplyScalar(isBomb ? 26 : 12);
        _v1.y = Math.abs(_v1.y) + (isBomb ? 12 : 5);
        this.hurtPlayer(player, damage, _v1);
      }
    }
  }

  // ------------------------------------------------------------- behaviours

  /** Perches, winds up, then leaps at the player's position. */
  private updateVenom(dt: number, v: Villain, player: Player): void {
    const cfg = CONFIG.enemies.venom;
    const toPlayer = _v1.copy(player.pos).sub(v.pos);
    const dist = toPlayer.length();

    // Close quarters: claw swipe takes priority over everything else.
    if (v.phase !== 'LEAP' && this.updateMelee(dt, v, player, cfg.meleeDamage)) return;

    // Mid range: lash out with a tendril, which yanks the player in.
    if (
      v.phase === 'PERCH' &&
      dist < cfg.whipRange &&
      dist > CONFIG.enemies.melee.range &&
      v.specialCooldown <= 0
    ) {
      v.specialCooldown = cfg.whipCooldown;
      this.fireBolt(v.pos, player.pos, 0x9440bc);
      this.onRangedAttack?.(v.kind);
      v.rangedHold = RANGED_HOLD;
      _v3.copy(v.pos).sub(player.pos).setY(0).normalize().multiplyScalar(24);
      if (this.hurtPlayer(player, cfg.whipDamage, _v3)) this.spawnImpact(player.pos, v.color, 3);
      return;
    }

    // Long range: spit a symbiote splat on a flat arc.
    if (
      v.phase === 'PERCH' &&
      dist < cfg.splatRange &&
      dist > cfg.whipRange &&
      v.specialCooldown <= 0 &&
      this.city.hasLineOfSight(v.pos, player.pos)
    ) {
      v.specialCooldown = cfg.splatCooldown;
      this.throwProjectile(v.pos, player.pos, 0x9440bc, 'SPLAT', cfg.splatSpeed);
      this.onRangedAttack?.(v.kind);
      v.rangedHold = RANGED_HOLD;
      return;
    }

    switch (v.phase) {
      case 'PERCH': {
        v.pos.y = damp(v.pos.y, this.surfaceHeight(v.pos.x, v.pos.z) + v.groundOffset, 6, dt);
        this.faceTowards(v, player.pos, dt, 5);
        if (dist < cfg.aggroRange && v.cooldown <= 0 && this.city.hasLineOfSight(v.pos, player.pos)) {
          v.phase = 'WINDUP';
          v.timer = cfg.windup;
          this.onTaunt?.(v.kind);
        }
        break;
      }

      case 'WINDUP': {
        v.timer -= dt;
        this.faceTowards(v, player.pos, dt, 10);
        // Crouch, then explode upward.
        const crouch = 1 - clamp(v.timer / cfg.windup, 0, 1);
        v.pivotScale.set(1 + crouch * 0.25, 1 - crouch * 0.35, 1 + crouch * 0.25);
        if (v.timer <= 0) {
          v.pivotScale.setScalar(1);
          // Lead the target slightly, and arc upward.
          _v2.copy(player.pos).addScaledVector(player.velocity, 0.35).sub(v.pos);
          const flat = Math.hypot(_v2.x, _v2.z) || 1;
          v.vel.set((_v2.x / flat) * cfg.leapSpeed, 0, (_v2.z / flat) * cfg.leapSpeed);
          v.vel.y = clamp(_v2.y * 0.7 + 16, 8, 34);
          v.phase = 'LEAP';
          v.timer = 4;
        }
        break;
      }

      case 'LEAP': {
        v.timer -= dt;
        v.vel.y -= CONFIG.physics.gravity * dt;
        v.pos.addScaledVector(v.vel, dt);
        this.faceTowards(v, player.pos, dt, 4);

        if (dist < cfg.contactRadius) {
          _v3.copy(v.vel).normalize().multiplyScalar(cfg.knockback).addScaledVector(UP, 8);
          if (this.hurtPlayer(player, cfg.damage, _v3)) {
            this.spawnImpact(player.pos, 0x9440bc, 3.2);
          }
          v.phase = 'RECOVER';
          v.cooldown = cfg.leapCooldown;
          v.timer = 0.8;
          break;
        }

        const ground = this.surfaceHeight(v.pos.x, v.pos.z) + v.groundOffset;
        if (v.pos.y <= ground && v.vel.y < 0) {
          v.pos.y = ground;
          v.vel.set(0, 0, 0);
          this.spawnImpact(v.pos, 0x9440bc, 2.4);
          v.phase = 'RECOVER';
          v.cooldown = cfg.leapCooldown;
          v.timer = 0.8;
        } else if (v.timer <= 0) {
          // Safety net: never stay airborne forever.
          v.phase = 'RECOVER';
          v.cooldown = cfg.leapCooldown;
          v.timer = 0.8;
        }
        break;
      }

      default: {
        v.timer -= dt;
        v.pos.y = damp(v.pos.y, this.surfaceHeight(v.pos.x, v.pos.z) + v.groundOffset, 6, dt);
        if (v.timer <= 0) v.phase = 'PERCH';
        break;
      }
    }
  }

  /** Sprints across rooftops away from the player; must be run down and tagged. */
  private updateBlackCat(dt: number, v: Villain, player: Player): void {
    const cfg = CONFIG.enemies.blackCat;
    const dist = v.pos.distanceTo(player.pos);

    // Cornered: she stops running and fights back with kicks and claws.
    if (dist < cfg.engageRange && this.updateMelee(dt, v, player, cfg.meleeDamage)) return;

    if (v.phase === 'IDLE') {
      v.pos.y = damp(v.pos.y, this.surfaceHeight(v.pos.x, v.pos.z) + v.groundOffset, 5, dt);
      this.faceTowards(v, player.pos, dt, 4);
      v.stamina = Math.min(1, v.stamina + cfg.recoveryRate * dt);
      if (dist < cfg.fleeRange) {
        v.phase = 'FLEE';
        v.timer = 0;
        this.onTaunt?.(v.kind);
      }
      return;
    }

    // Winded: doubled over, barely moving, and taking extra damage. This is
    // the window the whole pursuit is built around.
    if (v.phase === 'WINDED') {
      v.timer -= dt;
      v.stamina = Math.min(1, v.stamina + (1 / cfg.windedDuration) * dt);
      v.bodyPivot.rotation.x = damp(v.bodyPivot.rotation.x, 0.7, 6, dt);
      v.vel.x = damp(v.vel.x, 0, 5, dt);
      v.vel.z = damp(v.vel.z, 0, 5, dt);
      v.pos.x += v.vel.x * dt;
      v.pos.z += v.vel.z * dt;
      v.pos.y = damp(v.pos.y, this.surfaceHeight(v.pos.x, v.pos.z) + v.groundOffset, 7, dt);

      if (dist < cfg.tagRange) {
        this.applyDamage(v, 26 * cfg.windedDamageScale * player.damageMultiplier, player);
        this.bounceAway(v, player);
      }
      if (v.timer <= 0) {
        v.phase = 'FLEE';
        v.bodyPivot.rotation.x = 0;
      }
      return;
    }

    // Sprinting costs stamina; running out forces the recovery window.
    v.stamina -= dt / cfg.sprintDuration;
    if (v.stamina <= 0) {
      v.stamina = 0;
      v.phase = 'WINDED';
      v.timer = cfg.windedDuration;
      this.onTelegraph?.(v.kind);
      return;
    }

    // Re-path periodically, or once the current rooftop is reached.
    v.timer -= dt;
    const reached = Math.hypot(v.target.x - v.pos.x, v.target.z - v.pos.z) < 6;
    if (v.timer <= 0 || reached) {
      // Search radius shrinks to the arena once engaged, so she picks escape
      // rooftops that are still inside the fight.
      const searchRadius = v.arenaActive ? this.arenaRadius(v.kind) * 0.8 : 260;
      const roof = this.city.escapeRoof(v.pos, player.pos, searchRadius);
      if (roof) {
        v.home = roof;
        v.target.copy(roof.roof);
      }
      v.timer = cfg.repathTime;
    }

    _v1.set(v.target.x - v.pos.x, 0, v.target.z - v.pos.z);
    const flat = _v1.length();
    if (flat > 0.001) {
      _v1.divideScalar(flat);
      // Speed falls off as she tires, so the gap visibly closes near the end
      // of a sprint rather than the chase being flat until she stops dead.
      const fatigue = clamp(v.stamina * 1.6, 0.45, 1);
      const speed = cfg.speed * fatigue;
      v.vel.x = damp(v.vel.x, _v1.x * speed, 6, dt);
      v.vel.z = damp(v.vel.z, _v1.z * speed, 6, dt);
      v.pos.x += v.vel.x * dt;
      v.pos.z += v.vel.z * dt;
      this.faceTowards(v, _v2.copy(v.pos).add(_v1), dt, 8);
    }

    // Rooftop-hugging height with an acrobatic hop, so gaps read as leaps.
    //
    // She has no collider, so walking into a tower used to make the ground
    // query jump to that tower's roof and the damp would rocket her straight
    // up the facade. Anything she cannot plausibly step onto is treated as a
    // wall: undo the move and pick a new route.
    const surface = this.surfaceHeight(v.pos.x, v.pos.z) + v.groundOffset;
    const climb = surface - v.pos.y;

    if (climb > CONFIG.enemies.blackCat.maxStepUp) {
      v.pos.x -= v.vel.x * dt;
      v.pos.z -= v.vel.z * dt;
      // Slide along the obstruction rather than stopping dead, otherwise she
      // repaths into the same wall every frame and stutters in place.
      const slideX = -v.vel.z;
      const slideZ = v.vel.x;
      const slideLen = Math.hypot(slideX, slideZ) || 1;
      v.vel.x = (slideX / slideLen) * cfg.speed * 0.5;
      v.vel.z = (slideZ / slideLen) * cfg.speed * 0.5;
      v.timer = 0; // and pick a fresh route next frame
    } else {
      const hop = Math.abs(Math.sin(performance.now() * 0.004)) * cfg.jumpArc * 0.12;
      const target = surface + hop;
      // Cap the vertical rate so even a legal step never looks like phasing.
      const maxRise = CONFIG.enemies.blackCat.maxClimbSpeed * dt;
      const next = damp(v.pos.y, target, 7, dt);
      v.pos.y = clamp(next, v.pos.y - maxRise * 2, v.pos.y + maxRise);
    }

    // Tagged: the player has caught up.
    if (dist < cfg.tagRange) {
      this.applyDamage(v, 26 * player.damageMultiplier, player);
      // Catching her also costs her breath, so a good chase compounds.
      v.stamina = Math.max(0, v.stamina - 0.3);
      this.bounceAway(v, player);
      v.timer = 0;
    }

    if (dist > cfg.fleeRange * 2.2) v.phase = 'IDLE';
  }

  /** Hovers above a rooftop and snipes the player with raycast lightning. */
  private updateElectro(dt: number, v: Villain, player: Player): void {
    const cfg = CONFIG.enemies.electro;
    const dist = v.pos.distanceTo(player.pos);
    const t = performance.now() * 0.001;

    // Lazy drift around his current anchor, plus a vertical bob.
    //
    // This orbits `v.target`, not `v.home.roof`. Anchoring him to the rooftop
    // he spawned on meant he never moved relative to the player at all, so
    // once you reached him you could hold the attack button until he died —
    // the poise shove relocates him by moving this anchor.
    const orbit = t * 0.25;
    const targetX = v.target.x + Math.cos(orbit) * 9;
    const targetZ = v.target.z + Math.sin(orbit) * 9;
    const targetY = v.target.y + Math.sin(t * 1.4) * cfg.bobAmplitude;

    v.pos.x = damp(v.pos.x, targetX, cfg.driftSpeed * 0.4, dt);
    v.pos.z = damp(v.pos.z, targetZ, cfg.driftSpeed * 0.4, dt);
    v.pos.y = damp(v.pos.y, targetY, 3, dt);
    v.root.rotation.y += dt * 1.4;

    // Close range: a discharge straight into whoever reached him.
    if (this.updateMelee(dt, v, player, cfg.meleeDamage)) return;

    // Chained arc: a heavier strike that forks off nearby geometry.
    if (
      dist < cfg.chainRange &&
      v.specialCooldown <= 0 &&
      this.city.hasLineOfSight(v.pos, player.pos)
    ) {
      v.specialCooldown = cfg.chainCooldown;
      this.onRangedAttack?.(v.kind);
      v.rangedHold = RANGED_HOLD;
      // Three forks so it reads as a chained discharge, not a single bolt.
      for (let i = 0; i < 3; i++) {
        _v3.copy(player.pos).add(
          _v2.set((Math.random() - 0.5) * 7, (Math.random() - 0.5) * 5, (Math.random() - 0.5) * 7),
        );
        this.fireBolt(v.pos, _v3);
      }
      if (this.hurtPlayer(player, cfg.chainDamage)) this.spawnImpact(player.pos, 0xd8ff3c, 4.5);
      return;
    }

    if (dist < cfg.zoneRange && v.cooldown <= 0 && this.city.hasLineOfSight(v.pos, player.pos)) {
      v.cooldown = cfg.boltCooldown;
      this.onTaunt?.(v.kind);
      this.onRangedAttack?.(v.kind);
      v.rangedHold = RANGED_HOLD;
      this.fireBolt(v.pos, player.pos);
      if (this.hurtPlayer(player, cfg.boltDamage)) {
        this.spawnImpact(player.pos, 0xd8ff3c, 2.6);
      }
    }
  }

  /**
   * Walks you down. No leaps, no flight, no fleeing — he simply closes, and
   * everything he does is slow enough to read and fast enough to hurt.
   *
   * Three tools at three ranges: a wide fist up close, a shotgun burst of
   * hardened grit at mid range, and a pillar that erupts from the ground under
   * wherever you were standing a second ago.
   */
  private updateSandman(dt: number, v: Villain, player: Player): void {
    const cfg = CONFIG.enemies.sandman;
    const dist = v.pos.distanceTo(player.pos);
    const t = performance.now() * 0.001;

    // --- collapse: below a health threshold he loses cohesion for a while ---
    if (v.phase === 'COLLAPSE') {
      v.timer -= dt;
      v.damageScale = cfg.collapseDamageScale;
      // Slumped and spread out, drifting toward the player at a crawl.
      const spread = Math.sin((1 - v.timer / cfg.collapseDuration) * Math.PI);
      v.pivotScale.set(1 + spread * 0.7, Math.max(0.25, 1 - spread * 0.75), 1 + spread * 0.7);
      this.stepToward(dt, v, player.pos, cfg.speed * 0.25, cfg.accel);
      if (v.timer <= 0) {
        v.phase = 'STALK';
        v.damageScale = 1;
        v.pivotScale.setScalar(1);
        // Reforms bigger each time, so the threat visibly escalates. The cap
        // is relative to his base size, not absolute — he starts at building
        // scale, so an absolute 1.45 would have *shrunk* him.
        const grown = Math.min(v.baseScale * cfg.maxScale, v.root.scale.x * cfg.reformGrowth);
        v.root.scale.setScalar(grown);
        v.hitRadius = v.hitRadiusUnit * grown;
        this.onTaunt?.(v.kind);
        this.spawnImpact(v.pos, v.color, 8);
      }
      return;
    }

    // --- pillar: charged area attack aimed at where the player is now -------
    if (v.phase === 'PILLAR') {
      v.chargeTimer -= dt;
      v.telegraphing = true;
      this.faceTowards(v, v.chargePoint, dt, 6);
      // Arms raised: the tell that something is about to come up out of the floor.
      v.bodyPivot.rotation.x = damp(v.bodyPivot.rotation.x, -0.35, 7, dt);

      if (v.chargeTimer <= 0) {
        v.bodyPivot.rotation.x = 0;
        v.phase = 'STALK';
        v.telegraphing = false;
        v.specialCooldown = cfg.pillarCooldown;
        this.eruptPillar(v, player);
      }
      return;
    }

    // Losing cohesion. Checked here rather than at the top of the function so
    // it never interrupts a pillar mid-wind-up, which would eat the telegraph
    // the player is already reacting to. `stamina` doubles as the
    // once-per-fight flag, so no extra field is needed.
    if (v.hp / v.maxHp < cfg.collapseAt && v.stamina > 0) {
      v.stamina = 0;
      v.phase = 'COLLAPSE';
      v.timer = cfg.collapseDuration;
      v.chargeTimer = 0;
      this.spawnImpact(v.pos, v.color, 7);
      this.onTelegraph?.(v.kind);
      return;
    }

    // Close quarters: the fist. Wider reach than any other villain's swipe.
    if (this.updateMelee(dt, v, player, cfg.meleeDamage, cfg.meleeRange)) return;

    if (dist < cfg.engageRange && v.specialCooldown <= 0) {
      if (dist < cfg.pillarRange && dist > CONFIG.enemies.melee.range * 1.5) {
        v.phase = 'PILLAR';
        v.chargeTimer = cfg.pillarWindup;
        v.chargePoint.copy(player.pos);
        v.chargePoint.y = this.surfaceHeight(player.pos.x, player.pos.z);
        this.onTelegraph?.(v.kind);
        this.onTaunt?.(v.kind);
        return;
      }
    }

    // Mid range: a burst of shards, on its own cooldown from the pillar.
    if (
      dist < cfg.shardRange &&
      dist > CONFIG.enemies.melee.range &&
      v.cooldown <= 0 &&
      this.city.hasLineOfSight(v.pos, player.pos)
    ) {
      v.cooldown = cfg.shardCooldown;
      this.onRangedAttack?.(v.kind);
      v.rangedHold = RANGED_HOLD;
      for (let i = 0; i < cfg.shardCount; i++) {
        _v3.copy(player.pos);
        _v3.x += (Math.random() - 0.5) * dist * cfg.shardSpread;
        _v3.y += (Math.random() - 0.5) * dist * cfg.shardSpread * 0.6;
        _v3.z += (Math.random() - 0.5) * dist * cfg.shardSpread;
        this.throwProjectile(v.pos, _v3, 0xc9a26a, 'SHARD', cfg.shardSpeed);
      }
    }

    // Otherwise: keep walking. Heavy, rolling gait.
    this.stepToward(dt, v, player.pos, cfg.speed, cfg.accel);
    this.faceTowards(v, player.pos, dt, 3.5);
    v.bodyPivot.rotation.z = Math.sin(t * 3.4) * 0.09;
    v.bodyPivot.rotation.x = damp(v.bodyPivot.rotation.x, 0, 6, dt);
  }

  /** Sand column erupting at a pre-announced point. */
  private eruptPillar(v: Villain, player: Player): void {
    const cfg = CONFIG.enemies.sandman;
    this.onProjectileBurst?.('SHARD');
    // Three stacked bursts so the column reads as vertical, not spherical.
    for (let i = 0; i < 3; i++) {
      _v1.copy(v.chargePoint);
      _v1.y += i * 4;
      this.spawnImpact(_v1, 0xc9a26a, cfg.pillarRadius * (1 - i * 0.2));
    }

    // Damage anyone standing in the column, floor to well above head height.
    const flat = Math.hypot(player.pos.x - v.chargePoint.x, player.pos.z - v.chargePoint.z);
    const rise = player.pos.y - v.chargePoint.y;
    if (flat < cfg.pillarRadius && rise > -2 && rise < 14) {
      _v1.set(0, 26, 0);
      if (this.hurtPlayer(player, cfg.pillarDamage, _v1)) {
        this.onAttackLanded?.(v.kind);
      }
    }
  }

  /**
   * Peter, poisoned by the symbiote and turned loose on Miles.
   *
   * He fights the way the player does — that is the entire idea. Web-strike
   * dashes, a web pull that drags you back into melee, and a screech that
   * punishes standing still next to him.
   */
  private updateSymbiote(dt: number, v: Villain, player: Player): void {
    const cfg = CONFIG.enemies.symbiote;
    const dist = v.pos.distanceTo(player.pos);

    // Bleeds back health between exchanges, so trading hits loses to combos.
    if (v.sinceHit > cfg.regenDelay && v.hp < v.maxHp) {
      v.hp = Math.min(v.maxHp, v.hp + cfg.regenPerSecond * dt);
    }

    if (v.phase === 'DASH_WINDUP') {
      v.timer -= dt;
      v.telegraphing = true;
      this.faceTowards(v, player.pos, dt, 12);
      // Coils down and back, exactly like the player's strike wind-up.
      const coil = 1 - clamp(v.timer / cfg.dashWindup, 0, 1);
      v.pivotScale.set(1 + coil * 0.18, 1 - coil * 0.28, 1 + coil * 0.18);
      if (v.timer <= 0) {
        v.pivotScale.setScalar(1);
        v.telegraphing = false;
        // Lead the target so a dash at a moving player still threatens.
        _v1.copy(player.pos).addScaledVector(player.velocity, 0.22).sub(v.pos);
        // Cap the climb. Dashing at a player who is 60 m up would otherwise
        // fire him near-vertically into open sky, and he then spends four
        // seconds drifting back down doing nothing.
        _v1.y = clamp(_v1.y, -0.9 * Math.hypot(_v1.x, _v1.z), 0.7 * Math.hypot(_v1.x, _v1.z));
        const length = _v1.length() || 1;
        v.vel.copy(_v1).divideScalar(length).multiplyScalar(cfg.dashSpeed);
        v.phase = 'DASH';
        v.timer = 1.3;
      }
      return;
    }

    if (v.phase === 'DASH') {
      v.timer -= dt;
      v.pos.addScaledVector(v.vel, dt);
      this.faceTowards(v, player.pos, dt, 6);

      if (dist < 3.6) {
        _v1.copy(v.vel).normalize().multiplyScalar(24).addScaledVector(UP, 9);
        if (this.hurtPlayer(player, cfg.dashDamage, _v1)) {
          this.spawnImpact(player.pos, v.color, 3.4);
          this.onAttackLanded?.(v.kind);
        }
        v.phase = 'STALK';
        v.specialCooldown = cfg.dashCooldown;
      } else if (v.timer <= 0) {
        v.phase = 'STALK';
        v.specialCooldown = cfg.dashCooldown;
      }
      // Never dash through the pavement.
      const floor = this.surfaceHeight(v.pos.x, v.pos.z) + v.groundOffset;
      if (v.pos.y < floor) v.pos.y = floor;
      return;
    }

    // Melee is the default; his cooldowns fill the gaps between exchanges.
    if (this.updateMelee(dt, v, player, cfg.meleeDamage)) return;

    // Cornered: a radial screech that makes camping his hitbox a bad idea.
    if (dist < cfg.screechRange && v.specialCooldown <= 0) {
      v.specialCooldown = cfg.screechCooldown;
      this.onRangedAttack?.(v.kind);
      v.rangedHold = RANGED_HOLD;
      this.spawnImpact(v.pos, 0x9440bc, 11);
      _v1.copy(player.pos).sub(v.pos);
      if (_v1.lengthSq() < 1e-4) _v1.set(0, 1, 0);
      _v1.normalize().multiplyScalar(30).addScaledVector(UP, 12);
      if (this.hurtPlayer(player, cfg.screechDamage, _v1)) this.onAttackLanded?.(v.kind);
      return;
    }

    // Mid range: the web pull, which denies the "just stay away" answer.
    if (dist < cfg.pullRange && dist > CONFIG.enemies.melee.range * 1.6 && v.cooldown <= 0) {
      v.cooldown = cfg.pullCooldown;
      this.fireBolt(v.pos, player.pos, 0xe8e8f5);
      this.onRangedAttack?.(v.kind);
      v.rangedHold = RANGED_HOLD;
      _v1.copy(v.pos).sub(player.pos);
      if (_v1.lengthSq() < 1e-4) _v1.set(1, 0, 0);
      _v1.normalize().multiplyScalar(cfg.pullStrength);
      _v1.y = Math.abs(_v1.y) + 6;
      if (this.hurtPlayer(player, cfg.pullDamage, _v1)) this.spawnImpact(player.pos, v.color, 2.6);
      return;
    }

    // Long range: close the gap with a dash.
    if (dist < cfg.dashRange && dist > 9 && v.specialCooldown <= 0) {
      v.phase = 'DASH_WINDUP';
      v.timer = cfg.dashWindup;
      this.onTelegraph?.(v.kind);
      this.onTaunt?.(v.kind);
      return;
    }

    this.stepToward(dt, v, player.pos, cfg.speed, cfg.accel);
    this.faceTowards(v, player.pos, dt, 7);
  }

  /**
   * Shared ground pursuit: accelerate toward a point, hug the surface, and
   * refuse to climb anything taller than a step.
   */
  private stepToward(
    dt: number,
    v: Villain,
    goal: THREE.Vector3,
    speed: number,
    accel: number,
  ): void {
    _v1.set(goal.x - v.pos.x, 0, goal.z - v.pos.z);
    const flat = _v1.length();
    if (flat > 1.5) {
      _v1.divideScalar(flat);
      v.vel.x = damp(v.vel.x, _v1.x * speed, accel * 0.1, dt);
      v.vel.z = damp(v.vel.z, _v1.z * speed, accel * 0.1, dt);
    } else {
      v.vel.x = damp(v.vel.x, 0, 8, dt);
      v.vel.z = damp(v.vel.z, 0, 8, dt);
    }

    const prevX = v.pos.x;
    const prevZ = v.pos.z;
    v.pos.x += v.vel.x * dt;
    v.pos.z += v.vel.z * dt;

    // Same wall rule Black Cat uses: anything you cannot step onto is a wall.
    // Without it the surface query snaps to a tower roof and the damp rockets
    // them up the facade.
    const surface = this.surfaceHeight(v.pos.x, v.pos.z) + v.groundOffset;
    if (surface - v.pos.y > CONFIG.enemies.blackCat.maxStepUp) {
      v.pos.x = prevX;
      v.pos.z = prevZ;
      // Slide along the obstruction rather than grinding into it.
      const slideX = -v.vel.z;
      const slideZ = v.vel.x;
      const length = Math.hypot(slideX, slideZ) || 1;
      v.vel.x = (slideX / length) * speed * 0.6;
      v.vel.z = (slideZ / length) * speed * 0.6;
      return;
    }

    const maxRise = CONFIG.enemies.blackCat.maxClimbSpeed * dt;
    const next = damp(v.pos.y, surface, 7, dt);
    v.pos.y = clamp(next, v.pos.y - maxRise * 2.5, v.pos.y + maxRise);
  }

  // ------------------------------------------------------------- interaction

  /**
   * Best villain inside the aim cone — the candidate for a web-strike dash.
   * `dir` must be normalised.
   */
  findStrikeTarget(origin: THREE.Vector3, dir: THREE.Vector3, range: number, coneCos: number): Villain | null {
    let best: Villain | null = null;
    let bestScore = -Infinity;

    for (const v of this.villains) {
      if (!v.alive || v.dormant) continue;
      _v1.copy(v.pos).sub(origin);
      const dist = _v1.length();
      if (dist > range || dist < 1e-3) continue;
      _v1.divideScalar(dist);
      const alignment = _v1.dot(dir);
      if (alignment < coneCos) continue;

      // Prefer the most centred target, then the closest.
      const score = alignment * 100 - dist * 0.5;
      if (score > bestScore) {
        bestScore = score;
        best = v;
      }
    }
    return best;
  }

  /** Applies a landed dash. Returns the villain that was hit, if any. */
  tryLandStrike(player: Player): Villain | null {
    if (!player.isStriking) return null;
    const radiusSq = CONFIG.combat.strikeHitRadius * CONFIG.combat.strikeHitRadius;

    for (const v of this.villains) {
      if (!v.alive || v.dormant) continue;
      if (player.pos.distanceToSquared(v.pos) > radiusSq) continue;

      this.applyDamage(v, CONFIG.combat.strikeDamage * player.damageMultiplier, player);
      // Bleed the dash into a rebound so the player doesn't stall inside them.
      _v1.copy(player.pos).sub(v.pos).normalize().multiplyScalar(16).addScaledVector(UP, 10);
      player.endStrike();
      player.addImpulse(_v1);
      return v;
    }
    return null;
  }

  /** Damages every living villain within `radius` — Miles' Venom Blast. */
  blast(center: THREE.Vector3, radius: number, amount: number, player: Player): number {
    let hits = 0;
    for (const v of this.villains) {
      if (!v.alive || v.dormant) continue;
      if (v.pos.distanceTo(center) > radius) continue;
      this.applyDamage(v, amount, player);
      this.fireBolt(center, v.pos, 0xffb703);
      hits++;
    }
    return hits;
  }

  /**
   * Locks an engaged villain inside a sphere around where the fight started.
   *
   * Without this a fleeing villain -- Black Cat especially -- simply leaves,
   * and the encounter becomes unwinnable rather than merely difficult.
   */
  /**
   * How far this villain may stray from the arena centre.
   *
   * A tight ring is the whole point — a boss that can walk out of the fight
   * turns every encounter into chasing them across the borough. Fliers are the
   * exception: their fight *is* the distance.
   */
  private arenaRadius(kind: VillainKind): number {
    const cfg = CONFIG.enemies.arena;
    return WIDE_ARENA.has(kind) ? cfg.flierRadius : cfg.radius;
  }

  /**
   * Turns the villain's current phase into an arm pose.
   *
   * Every phase name in the state machine maps to one of a handful of intents,
   * so a new phase gets a sensible pose for free and a renamed one falls back
   * to idle rather than freezing mid-swing. The timing values come from the
   * same timers the damage does, so the arm is through the target on exactly
   * the frame the hit registers — which is the entire point of animating this
   * rather than scaling the body.
   */
  private poseLimbs(dt: number, v: Villain): void {
    if (v.joints.size === 0) return;

    let intent: PoseIntent = 'IDLE';
    let progress = 0;

    if (v.webbed > 0) {
      intent = 'LIMP';
    } else {
      switch (v.phase) {
        case 'SWIPE': {
          // The damage lands at the end of the telegraph, so the wind-up owns
          // the first 60% and the swing has to peak exactly on the last frame.
          const p = 1 - clamp(v.timer / CONFIG.enemies.melee.telegraph, 0, 1);
          if (p < 0.6) {
            intent = 'WINDUP';
            progress = p / 0.6;
          } else {
            intent = 'SWING';
            progress = ((p - 0.6) / 0.4) * 0.35;
          }
          break;
        }
        case 'SWIPE_RECOVER':
          // Carries on from where the contact frame left the arm.
          intent = 'SWING';
          progress = 0.35 + 0.65 * (1 - clamp(v.timer / CONFIG.enemies.melee.recover, 0, 1));
          break;
        case 'REPEL':
          intent = 'RAISE';
          progress = 1 - clamp(v.timer / CONFIG.enemies.poise.telegraph, 0, 1);
          break;
        case 'PILLAR':
          intent = 'RAISE';
          progress = 1 - clamp(v.chargeTimer / CONFIG.enemies.sandman.pillarWindup, 0, 1);
          break;
        case 'DASH_WINDUP':
        case 'WINDUP':
          intent = 'WINDUP';
          progress = 1 - clamp(v.timer / 0.9, 0, 1);
          break;
        case 'DASH':
        case 'LEAP':
        case 'DIVE':
          intent = 'SWING';
          progress = 0.35;
          break;
        case 'COLLAPSE':
        case 'WINDED':
          intent = 'LIMP';
          break;
        default:
          // ORBIT, STALK, PERCH, FLEE, IDLE, RECOVER, REPEL_MOVE.
          intent = 'WALK';
          break;
      }
      // A ranged attack overrides the resting pose for as long as the cooldown
      // is fresh, so a volley reads as thrown rather than as teleported.
      if (intent === 'WALK' && v.rangedHold > 0) {
        intent = 'RANGED';
        progress = clamp(v.rangedHold / RANGED_HOLD, 0, 1);
      } else if (intent === 'WALK' && v.kind === 'ELECTRO') {
        // Electro's resting pose *is* arms-out — he is modelled mid-discharge
        // and his hands are the light source. An idle arm swing on him reads
        // as a man out for a stroll rather than as a live conductor.
        intent = 'RANGED';
        progress = 0.3;
      }
    }

    v.rangedHold = Math.max(0, v.rangedHold - dt);
    poseVillain(
      v.joints,
      v.pose,
      POSE_PROFILES[v.kind],
      intent,
      progress,
      dt,
      Math.hypot(v.vel.x, v.vel.z),
    );
  }

  /**
   * Composes the behaviour's squash with the hit flash onto the real pivot.
   *
   * One place, so a telegraph can never again be written and then wiped by the
   * flash on the following line.
   */
  private applyPivotScale(v: Villain, flash = 0.25): void {
    const f = 1 + v.hitFlash * flash;
    v.bodyPivot.scale.set(v.pivotScale.x * f, v.pivotScale.y * f, v.pivotScale.z * f);
  }

  private confineToArena(v: Villain, player: Player): void {
    const cfg = CONFIG.enemies.arena;
    const distanceToPlayer = v.pos.distanceTo(player.pos);

    if (!v.arenaActive) {
      if (distanceToPlayer < cfg.engageDistance) {
        v.arenaActive = true;
        // Anchor between the two of them so neither starts pinned to an edge.
        v.arenaCentre.copy(v.pos).add(player.pos).multiplyScalar(0.5);
      }
      return;
    }

    // The player walking away ends the encounter and frees the villain.
    if (distanceToPlayer > cfg.disengageDistance) {
      v.arenaActive = false;
      return;
    }

    // Horizontal only, matching the player's bound. A spherical bound snaps
    // the villain onto the sphere *surface*, so a ground villain that runs to
    // a low block far from a rooftop arena centre gets yanked into the sky.
    const radius = this.arenaRadius(v.kind);
    _v1.set(v.pos.x - v.arenaCentre.x, 0, v.pos.z - v.arenaCentre.z);
    const distance = _v1.length();
    if (distance <= radius) return;

    // Push back to the boundary and cancel outward velocity so they do not
    // grind along the wall. Height is left alone — their own movement code
    // owns that, and it is the only thing that keeps them on a surface.
    _v1.divideScalar(distance);
    v.pos.x = v.arenaCentre.x + _v1.x * radius;
    v.pos.z = v.arenaCentre.z + _v1.z * radius;
    const outward = v.vel.dot(_v1);
    if (outward > 0) v.vel.addScaledVector(_v1, -outward);
  }

  /**
   * The arena the player is actually standing in.
   *
   * Returns the *nearest* active one, not the first found: in free roam
   * several villains can be engaged at once, and confining the player to a
   * distant villain's arena would drag them across the map.
   */
  activeArena(
    near: THREE.Vector3,
  ): { centre: THREE.Vector3; radius: number; allowWebs: boolean } | null {
    let best: Villain | null = null;
    let bestDist = Infinity;
    // In a team-up this is deliberately "any", not "the nearest one": with a
    // flier and a ground boss in the same fight, tying the rule to whoever
    // happens to be closer means the webs cut out halfway through every
    // approach to the flier.
    let allowWebs = false;
    for (const v of this.villains) {
      if (!v.alive || v.dormant || !v.arenaActive) continue;
      if (KEEPS_WEBS.has(v.kind)) allowWebs = true;
      const d = v.arenaCentre.distanceTo(near);
      if (d < bestDist) {
        bestDist = d;
        best = v;
      }
    }
    if (!best) return null;
    return { centre: best.arenaCentre, radius: this.arenaRadius(best.kind), allowWebs };
  }

  /**
   * Shoves a villain clear of the player after a hit.
   *
   * A zero-length separation normalises to zero, which would leave her pinned
   * and re-tagged every frame until dead, so fall back to a fixed direction.
   */
  private bounceAway(v: Villain, player: Player): void {
    _v1.copy(v.pos).sub(player.pos).setY(0);
    if (_v1.lengthSq() < 1e-4) _v1.set(1, 0, 0);
    _v1.normalize();
    v.pos.addScaledVector(_v1, 8);
  }

  nearestTo(pos: THREE.Vector3): Villain | null {
    let best: Villain | null = null;
    let bestDist = Infinity;
    for (const v of this.villains) {
      if (!v.alive || v.dormant) continue;
      const d = v.pos.distanceTo(pos);
      if (d < bestDist) {
        bestDist = d;
        best = v;
      }
    }
    return best;
  }

  dispose(): void {
    for (const d of this.disposables) d.dispose();
    this.disposables.length = 0;
    this.group.clear();
  }

  // ---------------------------------------------------------------- private

  // --------------------------------------------------------- TargetProvider

  /**
   * Dormant villains are not in the world yet, so nothing can hit them.
   *
   * Cached rather than filtered per call: gadgets query this once per
   * projectile per frame, and returning a fresh array each time was pure GC
   * churn in the hot path.
   */
  get combatTargets(): readonly CombatTarget[] {
    return this.activeTargets;
  }

  /** Rebuilds the active-target cache. Called whenever dormancy changes. */
  private refreshActiveTargets(): void {
    this.activeTargets.length = 0;
    for (const v of this.villains) {
      if (!v.dormant) this.activeTargets.push(v);
    }
  }

  /** Damage from a source that isn't a player melee hit (gadgets, finishers). */
  damageTarget(target: CombatTarget, amount: number, from?: THREE.Vector3): void {
    this.dealDamage(target as Villain, amount, from);
  }

  private applyDamage(v: Villain, amount: number, player: Player): void {
    if (!v.alive) return;
    this.dealDamage(v, amount, player.pos);
    player.registerHit();
  }

  /**
   * Damage multiplier for *where* the hit landed.
   *
   * Only Sandman has a weak point, and it is the thing that makes fighting
   * something the size of a building interesting rather than tedious: he is
   * loose sand from the shoulders down, so hitting his legs barely registers
   * and the fight becomes getting up to his head. Returns 1 for everyone else
   * and for damage with no known origin, so nothing else changes.
   */
  private weakPointScale(v: Villain, from?: THREE.Vector3): number {
    if (v.kind !== 'SANDMAN' || !from) return 1;
    const cfg = CONFIG.enemies.sandman;
    const scale = v.root.scale.y;
    // pos.y sits `groundOffset` above his feet, and headHeight is measured in
    // model-local units from those same feet.
    const feetY = v.pos.y - v.groundOffset;
    const headY = feetY + cfg.headHeight * scale;
    return Math.abs(from.y - headY) <= cfg.headRadius * scale
      ? cfg.headDamageScale
      : cfg.bodyDamageScale;
  }

  private dealDamage(v: Villain, amount: number, from?: THREE.Vector3): void {
    if (!v.alive) return;
    // damageScale is how a boss can have a genuinely tougher phase without
    // needing every damage source to know about that phase.
    v.hp = Math.max(0, v.hp - amount * v.damageScale * this.weakPointScale(v, from));
    v.hitFlash = 1;
    v.sinceHit = 0;
    // Count the hit toward a retaliation. The window resets on every hit, so
    // it is sustained pressure that triggers it, not four pokes over a minute.
    v.poise++;
    v.poiseTimer = CONFIG.enemies.poise.window;
    this.spawnImpact(v.pos, v.color, 3);

    // The fight turning is worth saying out loud, and only the first time.
    if (!v.turned && v.hp > 0 && v.hp < v.maxHp * 0.5) {
      v.turned = true;
      this.onTurn?.(v);
    }

    if (v.hp <= 0) {
      v.alive = false;
      v.root.visible = false;
      this.spawnImpact(v.pos, v.color, 9);
      this.onDefeated?.(v);
    }
  }

  /**
   * Height of the first solid surface below (x, z). Streets return 0.
   * Uses the broadphase column lookup, not a raycast — this is called several
   * times per frame and a full ray sweep here was pure waste.
   */
  private surfaceHeight(x: number, z: number): number {
    return this.city.groundHeightAt(x, z);
  }

  private faceTowards(v: Villain, target: THREE.Vector3, dt: number, rate: number): void {
    const dx = target.x - v.pos.x;
    const dz = target.z - v.pos.z;
    if (Math.abs(dx) + Math.abs(dz) < 1e-4) return;
    const desired = Math.atan2(dx, dz);
    let delta = (desired - v.root.rotation.y) % (Math.PI * 2);
    if (delta > Math.PI) delta -= Math.PI * 2;
    if (delta < -Math.PI) delta += Math.PI * 2;
    v.root.rotation.y += delta * (1 - Math.exp(-rate * dt));
  }

  // ----------------------------------------------------------------- spawn

  private spawn(kind: VillainKind, city: City, rng: Rng): void {
    // Keep villains apart and off the very edge of the map.
    let home = city.randomRoof(rng, 90);
    for (let attempt = 0; attempt < 24; attempt++) {
      const candidate = city.randomRoof(rng, 90);
      const tooClose = this.villains.some((v) => v.home.roof.distanceTo(candidate.roof) < 220);
      if (!tooClose) {
        home = candidate;
        break;
      }
    }

    const root = new THREE.Group();
    const bodyPivot = new THREE.Group();
    root.add(bodyPivot);
    root.name = kind;

    let hp: number;
    let color: number;
    let joints: Map<string, THREE.Group>;
    switch (kind) {
      case 'VENOM':
        hp = CONFIG.enemies.venom.hp;
        color = 0x9440bc;
        joints = this.buildVenom(bodyPivot);
        break;
      case 'BLACK CAT':
        hp = CONFIG.enemies.blackCat.hp;
        color = 0xdfe6ef;
        joints = this.buildBlackCat(bodyPivot);
        break;
      case 'GREEN GOBLIN':
        hp = CONFIG.enemies.goblin.hp;
        color = 0x8fff4a;
        joints = this.buildGoblin(bodyPivot);
        break;
      case 'SANDMAN':
        hp = CONFIG.enemies.sandman.hp;
        color = 0xc9a26a;
        joints = this.buildSandman(bodyPivot);
        break;
      case 'SYMBIOTE PETER':
        hp = CONFIG.enemies.symbiote.hp;
        color = 0x6d4ba8;
        joints = this.buildSymbiote(bodyPivot);
        break;
      default:
        hp = CONFIG.enemies.electro.hp;
        color = 0xd8ff3c;
        joints = this.buildElectro(bodyPivot);
        break;
    }

    // Measure the finished mesh so the feet land on the surface. Done here,
    // once, rather than per frame — the geometry never changes after build.
    //
    // The measurement is taken unscaled and multiplied afterwards: Sandman is
    // built at human proportions and then blown up to building size, and an
    // offset measured before that scale would bury him to the knees.
    const baseScale = kind === 'SANDMAN' ? CONFIG.enemies.sandman.baseScale : 1;
    _bounds.setFromObject(bodyPivot);
    const groundOffset = (Number.isFinite(_bounds.min.y) ? -_bounds.min.y : 1.6) * baseScale;
    root.scale.setScalar(baseScale);

    // Body radius for range checks. Left at zero for anything person-sized —
    // treating an ordinary villain as a sphere would quietly widen every
    // melee, gadget and finisher check in the game.
    const modelHeight = Number.isFinite(_bounds.max.y) ? _bounds.max.y - _bounds.min.y : 0;
    const hitRadiusUnit = baseScale > 1.5 ? modelHeight * 0.45 : 0;

    const pos = new THREE.Vector3(
      home.roof.x,
      this.startHeight(kind, home.roof.y, groundOffset),
      home.roof.z,
    );
    root.position.copy(pos);

    const villain: Villain = {
      kind,
      name: kind,
      color,
      hp,
      maxHp: hp,
      baseHp: hp,
      alive: true,
      pos,
      vel: new THREE.Vector3(),
      root,
      home,
      phase: startPhase(kind),
      timer: 0,
      cooldown: 0,
      // Electro orbits `target`, so it carries his hover altitude.
      target: new THREE.Vector3(
        home.roof.x,
        home.roof.y + (kind === 'ELECTRO' ? CONFIG.enemies.electro.hoverHeight : 0),
        home.roof.z,
      ),
      bodyPivot,
      hitFlash: 0,
      telegraphing: false,
      specialCooldown: 0,
      arenaCentre: new THREE.Vector3().copy(pos),
      arenaActive: false,
      stamina: 1,
      webbed: 0,
      dormant: true,
      turned: false,
      damageScale: 1,
      sinceHit: 0,
      chargeTimer: 0,
      chargePoint: new THREE.Vector3(),
      groundOffset,
      baseScale,
      joints,
      pose: { phase: Math.random() * Math.PI * 2 },
      rangedHold: 0,
      hitRadiusUnit,
      hitRadius: hitRadiusUnit * baseScale,
      pivotScale: new THREE.Vector3(1, 1, 1),
      poise: 0,
      poiseTimer: 0,
      poiseCooldown: 0,
      driftTimer: CONFIG.enemies.poise.driftInterval,
    };

    root.visible = false;
    this.villains.push(villain);
    this.group.add(root);
  }

  private buildVenom(parent: THREE.Group): Map<string, THREE.Group> {
    // Symbiote: a wet, oil-slick surface — very low roughness under full
    // clearcoat, with a purple iridescent sheen picking out the edges.
    const skin = new THREE.MeshPhysicalMaterial({
      color: 0x08080e,
      roughness: 0.16,
      metalness: 0.1,
      clearcoat: 1,
      clearcoatRoughness: 0.06,
      sheen: 1,
      sheenRoughness: 0.25,
      sheenColor: new THREE.Color(0x7a3aa8),
      emissive: new THREE.Color(0x2a0f3d),
      emissiveIntensity: 0.55,
    });
    const teeth = new THREE.MeshBasicMaterial({ color: 0xf5f5ff, toneMapped: false });
    // Gum line and tongue: the only warm colour anywhere on him, which is what
    // makes the grin read as a mouth rather than a painted-on shape.
    const flesh = new THREE.MeshStandardMaterial({
      color: 0x5c1230,
      roughness: 0.35,
      metalness: 0,
      emissive: new THREE.Color(0x2a0616),
      emissiveIntensity: 0.6,
    });
    // Veins running under the surface, faintly lit from within.
    const vein = new THREE.MeshBasicMaterial({ color: 0x4a1d7a, toneMapped: false });
    this.disposables.push(skin, teeth, flesh, vein);
    // A violet edge on the symbiote, which sells the wet mass at a distance.
    applyRimLight(skin, 0xa855f7, 0.85, 2.2);

    const b = new VillainBuilder(parent, this.disposables);
    b.castsShadow(skin);

    // --- torso: wide shoulders tapering to a narrower waist ----------------
    b.capsule(skin, 0.92, 1.5, { y: 1.95, sx: 1.12, sz: 0.92 });
    b.chest(skin, 1.15, { y: 2.25, z: 0.28 }, 3);
    b.capsule(skin, 0.66, 0.4, { y: 1.16 });
    // Hip mass, so the waist doesn't pinch to nothing above the legs.
    b.sphere(skin, 0.7, { y: 0.98, sy: 0.7, sz: 0.85 }, 12);
    // Trapezius sweeping from neck to shoulder.
    for (const side of [-1, 1]) {
      b.sphere(skin, 0.44, { x: side * 0.5, y: 2.82, z: -0.06, sy: 0.62, sz: 1.1 }, 10);
      b.sphere(skin, 0.46, { x: side * 1.02, y: 2.5, sy: 0.9 }, 12);
      // Veins over the deltoids and up the neck.
      b.capsule(vein, 0.035, 0.6, { x: side * 0.88, y: 2.62, z: 0.4, rz: side * 0.6 });
      b.capsule(vein, 0.03, 0.44, { x: side * 0.2, y: 2.86, z: 0.3, rz: side * 0.3 });
    }

    // --- head: a skull with a jaw, not a ball -------------------------------
    b.cylinder(skin, 0.34, 0.42, 0.34, { y: 2.94 });
    b.head(skin, 0.56, { y: 3.14, sz: 1.1 }, { jaw: false, browDepth: 0.7 });
    // Cranial ridge over the crown.
    b.capsule(skin, 0.1, 0.5, { y: 3.5, z: -0.1, rx: 0.4 });

    // Eyes: long teardrops, the widest feature on his face.
    for (const side of [-1, 1]) {
      b.sphere(teeth, 0.24, { x: side * 0.26, y: 3.22, z: 0.5, sx: 1.55, sy: 0.85, sz: 0.4, rz: side * -0.42 }, 10);
      // A thin symbiote lid overhanging each lens.
      b.box(skin, 0.44, 0.09, 0.14, { x: side * 0.28, y: 3.4, z: 0.52, rz: side * -0.42 });
    }

    // --- the grin ----------------------------------------------------------
    // Hinged jaw dropped open, gums behind, then two interlocking rows of
    // fangs following the curve of the mouth.
    b.sphere(skin, 0.48, { y: 2.72, z: 0.34, sx: 1.05, sy: 0.62, sz: 0.95 }, 12);
    b.sphere(flesh, 0.4, { y: 2.86, z: 0.46, sx: 1.15, sy: 0.7, sz: 0.5 }, 10);
    // Tongue, lolling out and down.
    b.capsule(flesh, 0.09, 0.7, { y: 2.62, z: 0.78, rx: 1.15 });
    b.sphere(flesh, 0.1, { y: 2.3, z: 1.02, sy: 0.6 }, 8);

    const fangs = 9;
    for (let i = 0; i < fangs; i++) {
      // Spread across the mouth, longest at the canines.
      const t = i / (fangs - 1) - 0.5;
      const x = t * 0.86;
      const z = 0.62 - Math.abs(t) * 0.38;
      const length = 0.2 + (1 - Math.abs(t) * 1.4) * 0.16;
      // Upper row points down, lower row points up, offset so they interlock.
      b.cone(teeth, 0.055, length, { x, y: 2.98, z, rx: Math.PI }, 5);
      b.cone(teeth, 0.05, length * 0.85, { x: x + 0.05, y: 2.76, z }, 5);
    }

    // --- arms: long, heavy, clawed ------------------------------------------
    for (const side of [-1, 1]) {
      const tag = side > 0 ? 'L' : 'R';
      b.limb('shoulder' + tag, { x: side * 1.05, y: 2.5 });
      b.capsule(skin, 0.33, 1.35, { x: side * 1.12, y: 2.0, rz: side * 0.3 });
      // Bicep bulge.
      b.sphere(skin, 0.34, { x: side * 1.16, y: 2.2, z: 0.06, sy: 1.2 }, 10);
      // Elbow.
      b.sphere(skin, 0.28, { x: side * 1.28, y: 1.5 }, 8);
      b.limb('elbow' + tag, { x: side * 1.28, y: 1.5 }, 'shoulder' + tag);
      b.capsule(skin, 0.3, 0.9, { x: side * 1.34, y: 1.05, z: 0.05, rz: side * 0.16 });
      b.hand(skin, 0.62, side, { x: side * 1.44, y: 0.62, z: 0.06 }, {
        claw: teeth,
        clawLength: 0.36,
        curl: 0.4,
      });
      // Tendrils trailing off each forearm — the most symbiote-specific cue.
      for (let i = 0; i < 3; i++) {
        const drop = i * 0.22;
        b.capsule(skin, 0.05 - i * 0.008, 0.5, {
          x: side * (1.5 + i * 0.06),
          y: 1.4 - drop,
          z: -0.3 - i * 0.12,
          rx: 0.5 + i * 0.25,
          rz: side * 0.3,
        });
      }
      b.endLimb();
    }

    // --- legs ---------------------------------------------------------------
    for (const side of [-1, 1]) {
      b.capsule(skin, 0.42, 0.95, { x: side * 0.45, y: 0.92 });
      // Quadriceps and calf mass.
      b.sphere(skin, 0.38, { x: side * 0.45, y: 1.0, z: 0.12, sy: 1.3, sz: 0.8 }, 10);
      b.capsule(skin, 0.34, 0.8, { x: side * 0.45, y: 0.0, z: 0.02 });
      b.sphere(skin, 0.3, { x: side * 0.45, y: 0.2, z: -0.1, sy: 1.2 }, 8);
      // Knee.
      b.sphere(skin, 0.3, { x: side * 0.45, y: 0.46, z: 0.12 }, 8);
      b.foot(skin, 0.62, { x: side * 0.45, y: -0.5, z: 0.12 }, { claw: teeth, toes: 4 });
    }

    return b.commit();

    // The emblem is enormous on Venom — it spans the chest and the legs of the
    // spider run up over the shoulders rather than stopping at the pectorals.
    const emblem = createEmblemMesh(0xf5f5ff, 2.1);
    emblem.position.set(0, 2.1, 0.9);
    parent.add(emblem);
    const backEmblem = createEmblemMesh(0xf5f5ff, 1.7);
    backEmblem.position.set(0, 2.1, -0.86);
    backEmblem.rotation.y = Math.PI;
    parent.add(backEmblem);
    for (const mesh of [emblem, backEmblem]) {
      this.disposables.push(mesh.geometry, mesh.material as THREE.Material);
    }
  }

  /**
   * Black catsuit with cream fur cuffs at the wrists and boot tops, and a
   * silver bob. The earlier build had white chest panelling and a ponytail;
   * the reference has neither.
   */
  private buildBlackCat(parent: THREE.Group): Map<string, THREE.Group> {
    // Catsuit: tight leather, so a sharp clearcoat highlight over a dark base.
    const suit = new THREE.MeshPhysicalMaterial({
      color: 0x101116,
      roughness: 0.3,
      metalness: 0.2,
      clearcoat: 0.9,
      clearcoatRoughness: 0.16,
      sheen: 0.6,
      sheenColor: new THREE.Color(0x9aa8c0),
    });
    // Fur reads as fur only if it is completely matte - any gloss and it
    // looks like plastic next to the catsuit's clearcoat.
    const fur = new THREE.MeshStandardMaterial({
      color: 0xd8d2c4,
      roughness: 1,
      metalness: 0,
      flatShading: true,
    });
    const hair = new THREE.MeshPhysicalMaterial({
      color: 0xe8ebf0,
      roughness: 0.38,
      metalness: 0.05,
      sheen: 1,
      sheenRoughness: 0.3,
      sheenColor: new THREE.Color(0xffffff),
    });
    const visor = new THREE.MeshBasicMaterial({ color: 0x1a1d24, toneMapped: false });
    // Face: the one patch of skin on her, so it needs to not match the suit.
    const face = new THREE.MeshStandardMaterial({
      color: 0xe8c4a8,
      roughness: 0.62,
      metalness: 0,
    });
    const steel = new THREE.MeshStandardMaterial({
      color: 0xb9c2cf,
      roughness: 0.28,
      metalness: 0.9,
    });
    this.disposables.push(suit, fur, hair, visor, face, steel);
    // Cool highlight along the catsuit's edge; her whole read is silhouette.
    applyRimLight(suit, 0xc8d8ff, 0.7, 2.4);

    const b = new VillainBuilder(parent, this.disposables);
    b.castsShadow(suit);
    b.castsShadow(hair);

    // --- torso: an athletic build, not a tube -------------------------------
    b.capsule(suit, 0.3, 0.72, { y: 1.15 });
    b.chest(suit, 0.42, { y: 1.34, z: 0.1 }, 2);
    // Ribcage tapering into a narrow waist and back out at the hips.
    b.sphere(suit, 0.3, { y: 1.42, sx: 1.12, sy: 0.9, sz: 0.82 }, 12);
    b.sphere(suit, 0.24, { y: 1.0, sx: 1.0, sy: 0.8, sz: 0.8 }, 10);
    b.sphere(suit, 0.31, { y: 0.78, sx: 1.15, sy: 0.72, sz: 0.9 }, 12);
    // Utility belt with a buckle and thigh pouches.
    b.torus(steel, 0.3, 0.035, { y: 0.86, rx: Math.PI / 2 }, 14);
    b.box(steel, 0.12, 0.09, 0.06, { y: 0.86, z: 0.3 });
    for (const side of [-1, 1]) {
      b.box(suit, 0.14, 0.18, 0.1, { x: side * 0.24, y: 0.6, z: 0.06 });
    }

    // --- head ---------------------------------------------------------------
    b.cylinder(suit, 0.1, 0.12, 0.14, { y: 1.58 });
    b.head(face, 0.22, { y: 1.76 }, { brow: face, browDepth: 0.72 });
    // Domino mask over the eyes, with the goggle lenses set into it.
    b.box(visor, 0.42, 0.13, 0.08, { x: 0, y: 1.8, z: 0.2 });
    for (const side of [-1, 1]) {
      b.sphere(visor, 0.06, { x: side * 0.09, y: 1.8, z: 0.23, sx: 1.4, sz: 0.5 }, 8);
    }
    // Lips, so the lower face isn't blank.
    b.box(face, 0.1, 0.03, 0.04, { y: 1.63, z: 0.21 });

    // Silver bob: a rounded cap that flares just below the jaw, with a few
    // separated locks so it doesn't read as a helmet.
    b.sphere(hair, 0.27, { y: 1.79, z: -0.03, sy: 1.05, sz: 1.02 }, 14);
    b.cylinder(hair, 0.28, 0.24, 0.2, { y: 1.6, z: -0.05 }, 12);
    for (const side of [-1, 1]) {
      b.capsule(hair, 0.07, 0.24, { x: side * 0.22, y: 1.58, z: 0.04, rz: side * 0.2 });
      b.capsule(hair, 0.05, 0.18, { x: side * 0.1, y: 1.56, z: -0.2, rx: -0.3 });
    }

    // --- arms ---------------------------------------------------------------
    for (const side of [-1, 1]) {
      const tag = side > 0 ? 'L' : 'R';
      b.limb('shoulder' + tag, { x: side * 0.33, y: 1.44 });
      b.sphere(suit, 0.14, { x: side * 0.33, y: 1.42 }, 8);
      b.capsule(suit, 0.1, 0.44, { x: side * 0.4, y: 1.26, rz: side * 0.25 });
      b.sphere(suit, 0.09, { x: side * 0.48, y: 1.02 }, 8);
      b.limb('elbow' + tag, { x: side * 0.48, y: 1.02 }, 'shoulder' + tag);
      b.capsule(suit, 0.085, 0.34, { x: side * 0.5, y: 0.84, rz: side * 0.1 });
      // Cream fur cuff at the wrist — the most identifiable silhouette cue.
      b.sphere(fur, 0.2, { x: side * 0.53, y: 0.72, sy: 0.85 }, 12);
      // Gloved hand with claws, which is what she actually fights with.
      b.hand(suit, 0.24, side, { x: side * 0.54, y: 0.52 }, { claw: steel, clawLength: 0.16, curl: 0.5 });
      b.endLimb();
    }

    // --- legs ---------------------------------------------------------------
    for (const side of [-1, 1]) {
      b.capsule(suit, 0.13, 0.36, { x: side * 0.16, y: 0.56 });
      b.sphere(suit, 0.11, { x: side * 0.16, y: 0.36, z: 0.02 }, 8);
      b.capsule(suit, 0.1, 0.3, { x: side * 0.16, y: 0.2 });
      // Fur collar at the boot top, then a heeled boot with a defined foot.
      b.sphere(fur, 0.2, { x: side * 0.16, y: 0.42, sx: 1.05, sy: 0.7, sz: 1.05 }, 12);
      b.foot(suit, 0.3, { x: side * 0.16, y: -0.02, z: 0.02 });
      b.box(suit, 0.08, 0.12, 0.1, { x: side * 0.16, y: -0.1, z: -0.14 });
    }

    return b.commit();
  }

  /** Bald humanoid in dark green armour, wreathed in yellow-green arcs. */
  private buildElectro(parent: THREE.Group): Map<string, THREE.Group> {
    const arcMat = new THREE.MeshBasicMaterial({ color: 0xd8ff3c, toneMapped: false });
    const aura = new THREE.MeshBasicMaterial({
      color: 0xbdf13a,
      wireframe: true,
      transparent: true,
      opacity: 0.5,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      toneMapped: false,
    });
    const armour = new THREE.MeshStandardMaterial({
      color: 0x16261c,
      roughness: 0.42,
      metalness: 0.68,
      emissive: new THREE.Color(0x2f5a1e),
      emissiveIntensity: 0.9,
    });
    const skin = new THREE.MeshStandardMaterial({
      color: 0x6b4a35,
      roughness: 0.72,
      metalness: 0.04,
      emissive: new THREE.Color(0x9fd23a),
      emissiveIntensity: 0.22,
    });
    const trousers = new THREE.MeshStandardMaterial({
      color: 0x1c2118,
      roughness: 0.85,
      metalness: 0.05,
    });
    this.disposables.push(arcMat, aura, armour, skin, trousers);
    applyRimLight(armour, 0xd8ff3c, 0.75, 2.2);
    applyRimLight(trousers, 0x9fd23a, 0.4, 2.6);

    const b = new VillainBuilder(parent, this.disposables);
    b.castsShadow(armour);
    b.castsShadow(trousers);

    // --- torso: a utility vest over dark fatigues, not a floating orb -------
    b.capsule(armour, 0.34, 0.78, { y: 1.35 });
    b.chest(armour, 0.46, { y: 1.56, z: 0.1 }, 2);
    // Vest shell sitting proud of the torso, open down the front.
    b.capsule(armour, 0.37, 0.5, { y: 1.46, sx: 1.05, sz: 0.9 });
    for (const side of [-1, 1]) {
      b.box(armour, 0.16, 0.6, 0.08, { x: side * 0.2, y: 1.46, z: 0.32 });
      // Shoulder pads with a lit rim.
      b.sphere(armour, 0.19, { x: side * 0.44, y: 1.68, sy: 0.75 }, 10);
      b.torus(arcMat, 0.17, 0.022, { x: side * 0.44, y: 1.62, rx: Math.PI / 2 }, 12);
    }
    // Harness strap and the chest emitter it feeds.
    b.box(arcMat, 0.1, 0.72, 0.04, { x: 0.1, y: 1.46, z: 0.34, rz: -0.28 });
    b.torus(arcMat, 0.09, 0.03, { y: 1.56, z: 0.36 }, 12);
    b.sphere(arcMat, 0.06, { y: 1.56, z: 0.38 }, 8);
    b.torus(arcMat, 0.3, 0.07, { y: 1.76, rx: Math.PI / 2 }, 14);

    // --- head: bald, with the classic lightning-bolt mask over the eyes -----
    b.cylinder(skin, 0.11, 0.13, 0.16, { y: 1.82 });
    b.head(skin, 0.24, { y: 1.99, sy: 1.05 }, { brow: skin, browDepth: 0.74 });
    // Ears.
    for (const side of [-1, 1]) {
      b.sphere(skin, 0.07, { x: side * 0.24, y: 1.99, z: -0.02, sx: 0.5 }, 8);
      // Bolt mask: a horizontal band with a zig-zag flare at each temple.
      b.box(arcMat, 0.16, 0.07, 0.04, { x: side * 0.12, y: 2.02, z: 0.2 });
      b.box(arcMat, 0.12, 0.06, 0.04, { x: side * 0.28, y: 2.09, z: 0.1, rz: side * -0.7 });
      b.box(arcMat, 0.1, 0.05, 0.04, { x: side * 0.3, y: 1.93, z: 0.08, rz: side * 0.6 });
      b.sphere(arcMat, 0.05, { x: side * 0.1, y: 2.02, z: 0.22, sx: 1.4, sz: 0.5 }, 8);
    }

    // --- arms: held out, mid-discharge --------------------------------------
    for (const side of [-1, 1]) {
      const tag = side > 0 ? 'L' : 'R';
      b.limb('shoulder' + tag, { x: side * 0.4, y: 1.62 });
      b.capsule(armour, 0.13, 0.42, { x: side * 0.5, y: 1.5, rz: side * 0.75 });
      b.sphere(armour, 0.12, { x: side * 0.72, y: 1.32 }, 8);
      b.limb('elbow' + tag, { x: side * 0.72, y: 1.32 }, 'shoulder' + tag);
      b.capsule(armour, 0.115, 0.36, { x: side * 0.84, y: 1.18, rz: side * 0.5 });
      // The hands are pure light — the discharge points.
      b.hand(arcMat, 0.26, side, { x: side * 0.95, y: 1.0, z: 0.1 }, { curl: 0.25 });
      b.sphere(arcMat, 0.16, { x: side * 0.95, y: 1.0, z: 0.1 }, 8);
      b.endLimb();
    }

    // --- legs ---------------------------------------------------------------
    for (const side of [-1, 1]) {
      b.capsule(trousers, 0.15, 0.4, { x: side * 0.19, y: 0.62 });
      b.sphere(trousers, 0.12, { x: side * 0.19, y: 0.4 }, 8);
      b.capsule(trousers, 0.125, 0.34, { x: side * 0.19, y: 0.22 });
      b.foot(trousers, 0.3, { x: side * 0.19, y: -0.02, z: 0.02 });
      // Boot straps.
      b.torus(arcMat, 0.14, 0.02, { x: side * 0.19, y: 0.1, rx: Math.PI / 2 }, 10);
    }

    return b.commit();

    // Crackling shell + orbiting arc rings. These stay separate meshes: they
    // are additive and must not be merged into the shadow-casting batches.
    const auraGeo = new THREE.IcosahedronGeometry(1.65, 1);
    const auraMesh = new THREE.Mesh(auraGeo, aura);
    auraMesh.position.y = 1.35;
    parent.add(auraMesh);

    const ringGeo = new THREE.TorusGeometry(1.15, 0.045, 6, 20);
    for (let i = 0; i < 2; i++) {
      const ring = new THREE.Mesh(ringGeo, arcMat);
      ring.position.y = 1.35;
      ring.rotation.set(i === 0 ? Math.PI / 2 : 0.6, i * 0.9, 0);
      parent.add(ring);
    }

    const light = new THREE.PointLight(0xd8ff3c, 95, 65, 2);
    light.position.y = 1.5;
    parent.add(light);

    this.disposables.push(auraGeo, ringGeo);
  }

  // ------------------------------------------------------------- effects

  /**
   * Pumpkin bomb: a bronze ridged shell around a glowing green core, with
   * emitter studs set into the rim.
   */
  private createBomb(): Bomb {
    const group = new THREE.Group();

    const shellMat = new THREE.MeshStandardMaterial({
      color: 0x7a4a2a,
      roughness: 0.42,
      metalness: 0.85,
    });
    const coreMat = new THREE.MeshBasicMaterial({ color: 0x8fff4a, toneMapped: false });
    const studMat = new THREE.MeshStandardMaterial({
      color: 0x9fd23a,
      roughness: 0.3,
      metalness: 0.2,
      emissive: new THREE.Color(0x4a7a1a),
      emissiveIntensity: 0.8,
    });

    const shellGeo = new THREE.SphereGeometry(0.42, 14, 12);
    const shell = new THREE.Mesh(shellGeo, shellMat);
    shell.scale.set(1, 0.72, 1);
    group.add(shell);

    // Ridged rim.
    const rimGeo = new THREE.TorusGeometry(0.4, 0.07, 6, 18);
    const rim = new THREE.Mesh(rimGeo, shellMat);
    rim.rotation.x = Math.PI / 2;
    group.add(rim);

    const coreGeo = new THREE.SphereGeometry(0.26, 12, 10);
    const core = new THREE.Mesh(coreGeo, coreMat);
    core.scale.set(1, 0.68, 1);
    core.position.y = 0.09;
    group.add(core);

    const studGeo = new THREE.SphereGeometry(0.045, 6, 5);
    for (let i = 0; i < 8; i++) {
      const angle = (i / 8) * Math.PI * 2;
      const stud = new THREE.Mesh(studGeo, studMat);
      stud.position.set(Math.cos(angle) * 0.4, 0.02, Math.sin(angle) * 0.4);
      group.add(stud);
    }

    group.visible = false;
    this.group.add(group);
    this.disposables.push(shellGeo, rimGeo, coreGeo, studGeo, shellMat, coreMat, studMat);

    return {
      mesh: group,
      material: coreMat,
      velocity: new THREE.Vector3(),
      life: 0,
      active: false,
      kind: 'BOMB',
    };
  }

  /** Green plate armour with magenta accents, riding a bat-wing glider. */
  private buildGoblin(parent: THREE.Group): Map<string, THREE.Group> {
    const armour = new THREE.MeshPhysicalMaterial({
      color: 0x2f6b1f,
      roughness: 0.42,
      metalness: 0.55,
      clearcoat: 0.7,
      clearcoatRoughness: 0.3,
      emissive: new THREE.Color(0x143d0a),
      emissiveIntensity: 0.5,
    });
    const accent = new THREE.MeshPhysicalMaterial({
      color: 0x6b1f7a,
      roughness: 0.4,
      metalness: 0.6,
      clearcoat: 0.6,
      emissive: new THREE.Color(0x3a0a45),
      emissiveIntensity: 0.5,
    });
    const glow = new THREE.MeshBasicMaterial({ color: 0xc8ff5a, toneMapped: false });
    const metal = new THREE.MeshStandardMaterial({ color: 0x3a3f36, roughness: 0.4, metalness: 0.85 });
    // Green skin under the armour, several shades off the plate so the face
    // does not disappear into the helmet.
    const hide = new THREE.MeshStandardMaterial({
      color: 0x6fa03c,
      roughness: 0.68,
      metalness: 0.05,
    });
    const leather = new THREE.MeshStandardMaterial({ color: 0x3a2a14, roughness: 0.85, metalness: 0.05 });
    this.disposables.push(armour, accent, glow, metal, hide, leather);
    applyRimLight(armour, 0x8fff4a, 0.8, 2.2);
    applyRimLight(accent, 0xc86bff, 0.7, 2.3);

    const b = new VillainBuilder(parent, this.disposables);
    b.castsShadow(armour);
    b.castsShadow(metal);

    // --- torso ---------------------------------------------------------------
    b.capsule(armour, 0.36, 0.72, { y: 1.5 });
    b.chest(armour, 0.48, { y: 1.7, z: 0.12 }, 2);
    // Segmented plate over the chest with a ribbed abdomen below it.
    b.capsule(accent, 0.38, 0.34, { y: 1.66, sx: 1.04, sz: 0.85 });
    for (let i = 0; i < 3; i++) {
      b.box(accent, 0.5 - i * 0.05, 0.07, 0.24, { y: 1.4 - i * 0.13, z: 0.24 });
    }
    // Pauldrons and a satchel of bombs slung at his hip.
    for (const side of [-1, 1]) {
      b.sphere(accent, 0.2, { x: side * 0.44, y: 1.78, sy: 0.7 }, 10);
      b.cone(accent, 0.1, 0.2, { x: side * 0.52, y: 1.86, rz: side * -0.5 }, 6);
    }
    b.box(leather, 0.3, 0.28, 0.2, { x: 0.42, y: 1.12, z: -0.14, rz: 0.2 });
    b.box(leather, 0.08, 0.6, 0.06, { x: 0.24, y: 1.5, z: -0.06, rz: -0.3 });
    for (let i = 0; i < 3; i++) {
      b.sphere(glow, 0.06, { x: 0.36 + (i % 2) * 0.14, y: 1.22, z: -0.1 }, 6);
    }

    // --- head: a goblin face, not a helmet with eyes ------------------------
    b.cylinder(hide, 0.1, 0.13, 0.14, { y: 1.96 });
    b.head(hide, 0.25, { y: 2.12, sy: 1.05 }, { brow: hide, browDepth: 0.72 });
    // Heavy brow, hooked nose, jutting chin and a fanged underbite.
    b.box(hide, 0.34, 0.09, 0.16, { y: 2.24, z: 0.18, rx: -0.25 });
    b.cone(hide, 0.07, 0.26, { y: 2.1, z: 0.26, rx: 1.9 }, 6);
    b.sphere(hide, 0.09, { y: 1.9, z: 0.22, sz: 1.2 }, 8);
    for (const side of [-1, 1]) {
      b.cone(glow, 0.03, 0.09, { x: side * 0.07, y: 1.96, z: 0.2 }, 5);
      // Pointed ears, swept back.
      b.cone(hide, 0.06, 0.26, { x: side * 0.24, y: 2.18, z: -0.04, rz: side * -0.8, rx: -0.3 }, 6);
      // Glowing eyes set under the brow.
      b.sphere(glow, 0.07, { x: side * 0.1, y: 2.14, z: 0.21, sx: 1.4, sy: 0.8, sz: 0.5, rz: side * -0.3 }, 8);
    }
    // Pointed hood, with a ragged edge rather than a smooth cone.
    b.cone(armour, 0.3, 0.44, { y: 2.34, z: -0.06, rx: -0.35 }, 8);
    for (let i = 0; i < 6; i++) {
      const angle = (i / 6) * Math.PI * 2;
      b.cone(armour, 0.06, 0.16, {
        x: Math.cos(angle) * 0.28,
        y: 2.16,
        z: -0.06 + Math.sin(angle) * 0.24,
        rx: Math.PI,
      }, 5);
    }

    // --- arms ---------------------------------------------------------------
    for (const side of [-1, 1]) {
      const tag = side > 0 ? 'L' : 'R';
      b.limb('shoulder' + tag, { x: side * 0.38, y: 1.7 });
      b.capsule(armour, 0.12, 0.4, { x: side * 0.46, y: 1.56, z: 0.04, rz: side * 0.34 });
      b.sphere(armour, 0.11, { x: side * 0.58, y: 1.32 }, 8);
      b.limb('elbow' + tag, { x: side * 0.58, y: 1.32 }, 'shoulder' + tag);
      b.capsule(armour, 0.11, 0.32, { x: side * 0.62, y: 1.16, z: 0.06 });
      // Bracer with the bomb-release studs.
      b.cylinder(accent, 0.15, 0.15, 0.2, { x: side * 0.64, y: 1.06 }, 10);
      b.sphere(glow, 0.03, { x: side * 0.64, y: 1.06, z: 0.15 }, 6);
      b.hand(hide, 0.28, side, { x: side * 0.66, y: 0.9, z: 0.04 }, { claw: metal, clawLength: 0.14, curl: 0.6 });
      b.endLimb();
    }

    // --- legs: knees up, crouched on the glider -----------------------------
    for (const side of [-1, 1]) {
      b.capsule(armour, 0.13, 0.38, { x: side * 0.21, y: 0.86, z: 0.14, rx: 0.5 });
      b.sphere(accent, 0.12, { x: side * 0.21, y: 0.64, z: 0.3 }, 8);
      b.capsule(armour, 0.115, 0.3, { x: side * 0.21, y: 0.52, z: 0.36, rx: -0.2 });
      b.foot(accent, 0.32, { x: side * 0.21, y: 0.36, z: 0.4 });
      // Curled boot toe — the one flourish that reads as "goblin".
      b.cone(accent, 0.07, 0.18, { x: side * 0.21, y: 0.4, z: 0.74, rx: -0.9 }, 6);
    }

    // --- glider: a swept delta platform under his feet ----------------------
    b.cylinder(metal, 0.2, 0.34, 0.22, { y: 0.2, z: 0.18, rx: Math.PI / 2, sy: 3.4 }, 8);
    for (const side of [-1, 1]) {
      b.cone(metal, 0.34, 1.5, { x: side * 0.62, y: 0.2, z: -0.05, rx: Math.PI / 2, rz: side * -1.15, sz: 0.28 }, 4);
      // Blade along each wing's leading edge — this is the melee attack.
      b.box(metal, 0.04, 0.1, 1.1, { x: side * 0.78, y: 0.24, z: 0.1, rz: side * -0.3 });
      // Foot clamps.
      b.box(metal, 0.16, 0.08, 0.24, { x: side * 0.21, y: 0.3, z: 0.4 });
    }
    // Nose and thruster glow at the tail.
    b.cone(metal, 0.16, 0.5, { y: 0.2, z: 0.86, rx: Math.PI / 2 }, 8);
    b.cone(glow, 0.16, 0.5, { y: 0.2, z: -0.72, rx: -Math.PI / 2 }, 8);
    b.torus(glow, 0.13, 0.02, { y: 0.2, z: -0.5, rx: 0 }, 12);

    return b.commit();

    const light = new THREE.PointLight(0x8fff4a, 55, 40, 2);
    light.position.set(0, 0.6, 0);
    parent.add(light);
  }

  /**
   * Flint Marko: a heavy, granular mass in the shape of a man.
   *
   * Built out of faceted lumps rather than smooth capsules — the whole read is
   * "compacted grit", and a clean capsule silhouette fights that. Flat-shaded
   * so every facet catches the light separately.
   */
  /**
   * Flint Marko: a man made of sand, at the scale of a building.
   *
   * Two things this gets wrong if you build it the obvious way. Faceted
   * shading turns him into a pile of gravel rather than a person — sand is
   * fine-grained, so every surface here is smooth-shaded and subdivided, and
   * the roughness does the work the facets were doing badly. And a merged
   * body has no arms: his whole fight is reaching for you, so the shoulders,
   * elbows, hips and knees are real joints, committed as their own groups and
   * driven by `animateSandman`.
   *
   * Proportions are heroic rather than realistic — wide shoulders, heavy
   * forearms, short neck — because at four times human height read matters far
   * more than accuracy. Head centre sits at y = 3.05, which is what
   * `CONFIG.enemies.sandman.headHeight` measures the weak point from.
   */
  private buildSandman(parent: THREE.Group): Map<string, THREE.Group> {
    // Smooth, not faceted. Sand at this scale should look packed and drifted,
    // and flat shading made every limb read as a heap of rubble.
    const sand = new THREE.MeshStandardMaterial({
      color: 0xd2ab74,
      roughness: 0.94,
      metalness: 0,
    });
    // Damp, compacted sand in the recesses — reads as depth, not a second body.
    const packed = new THREE.MeshStandardMaterial({
      color: 0x9a7748,
      roughness: 0.99,
      metalness: 0,
    });
    // Dry surface grit, slightly paler, catching the light on the high forms.
    const dry = new THREE.MeshStandardMaterial({
      color: 0xe6c495,
      roughness: 0.88,
      metalness: 0,
    });
    // The striped shirt is the only thing left of the man he was.
    const shirt = new THREE.MeshStandardMaterial({ color: 0x4a6b52, roughness: 0.9, metalness: 0 });
    const stripe = new THREE.MeshStandardMaterial({ color: 0x2c3f33, roughness: 0.9, metalness: 0 });
    const trousers = new THREE.MeshStandardMaterial({ color: 0x3d3a30, roughness: 0.95, metalness: 0 });
    const eyeMat = new THREE.MeshBasicMaterial({ color: 0x1c1208, toneMapped: false });
    this.disposables.push(sand, packed, dry, shirt, stripe, trousers, eyeMat);
    applyRimLight(sand, 0xffd9a0, 0.45, 2.7);
    applyRimLight(dry, 0xfff0d0, 0.3, 3);

    const b = new VillainBuilder(parent, this.disposables);
    b.castsShadow(sand);
    b.castsShadow(shirt);
    b.castsShadow(trousers);

    // --- pelvis and torso ---------------------------------------------------
    b.blob(sand, 0.58, { y: 1.2, sx: 1.3, sy: 0.85, sz: 0.95 });
    b.capsule(sand, 0.52, 0.62, { y: 1.62, sx: 1.28, sz: 0.92 });
    b.capsule(sand, 0.6, 0.5, { y: 2.14, sx: 1.42, sz: 0.98 });
    b.chest(sand, 1.05, { y: 2.2, z: 0.38 }, 3);
    // Deltoid shelf, so the shoulders have somewhere to hang from.
    for (const side of [-1, 1]) {
      b.blob(sand, 0.42, { x: side * 0.62, y: 2.5, z: -0.02, sy: 0.72, sz: 1.05 });
      b.blob(packed, 0.3, { x: side * 0.3, y: 2.62, z: -0.16, sy: 0.6 });
    }

    // Torn green striped shirt across the chest and one shoulder.
    b.capsule(shirt, 0.62, 0.52, { y: 2.05, sx: 1.34, sz: 0.94 });
    for (let i = 0; i < 4; i++) {
      b.box(stripe, 1.78, 0.09, 1.42, { y: 2.32 - i * 0.26 });
    }
    // Ragged hem: torn tongues of fabric hanging off the bottom.
    for (let i = 0; i < 6; i++) {
      const angle = (i / 6) * Math.PI * 2;
      b.box(shirt, 0.24, 0.3, 0.1, {
        x: Math.cos(angle) * 0.88,
        y: 1.66,
        z: Math.sin(angle) * 0.72,
        ry: -angle,
        rz: (i % 2 ? 1 : -1) * 0.2,
      });
    }

    // --- head ---------------------------------------------------------------
    b.cylinder(sand, 0.3, 0.4, 0.28, { y: 2.78 }, 12);
    b.head(sand, 0.52, { y: 3.05, sx: 1.04, sz: 0.96 }, { brow: packed, browDepth: 0.74 });
    // Heavy squared-off jaw and a broken nose.
    b.blob(sand, 0.34, { y: 2.72, z: 0.16, sx: 1.05, sy: 0.68, sz: 0.9 });
    b.box(sand, 0.15, 0.2, 0.2, { y: 2.98, z: 0.5, rz: 0.13 });
    // Sunken eyes — dark hollows, no whites.
    for (const side of [-1, 1]) {
      b.sphere(eyeMat, 0.085, { x: side * 0.2, y: 3.04, z: 0.4, sz: 0.5 }, 10);
      b.blob(sand, 0.15, { x: side * 0.44, y: 3.02, z: 0.1, sx: 0.6 });
    }
    // Hair, swept back, more sand than hair.
    for (let i = 0; i < 7; i++) {
      const t = i / 6 - 0.5;
      b.blob(dry, 0.19, {
        x: t * 0.72,
        y: 3.42 - Math.abs(t) * 0.18,
        z: -0.14 - Math.abs(t) * 0.1,
        sy: 0.62,
      });
    }
    // Mouth: a hard line, set.
    b.box(packed, 0.3, 0.05, 0.08, { y: 2.68, z: 0.46 });

    // --- arms: real joints, because reaching for you is the whole fight -----
    for (const side of [-1, 1]) {
      const tag = side > 0 ? 'L' : 'R';

      b.limb('shoulder' + tag, { x: side * 0.92, y: 2.42 });
      // Upper arm, tapering from a heavy deltoid into the elbow.
      b.blob(sand, 0.34, { x: side * 0.96, y: 2.36, sx: 1.1, sy: 1.05 });
      b.capsule(sand, 0.27, 0.44, { x: side * 1.0, y: 2.02, rz: side * 0.06 });
      b.blob(sand, 0.26, { x: side * 1.02, y: 1.7 });
      // Sand sloughing off the tricep.
      b.blob(packed, 0.12, { x: side * 1.12, y: 2.1, z: -0.2, sy: 0.7 });

      b.limb('elbow' + tag, { x: side * 1.02, y: 1.66 }, 'shoulder' + tag);
      // Forearm — deliberately the heaviest part of him.
      b.capsule(sand, 0.29, 0.44, { x: side * 1.06, y: 1.3, rz: side * 0.04 });
      b.blob(sand, 0.3, { x: side * 1.08, y: 1.0, sx: 1.1 });
      // Oversized fist. The melee reach is genuinely longer than it looks.
      b.blob(sand, 0.42, { x: side * 1.1, y: 0.7, sx: 1.15, sz: 1.1 });
      b.hand(sand, 0.78, side, { x: side * 1.1, y: 0.72, z: 0.06 }, { fist: true });
      // Grains falling off the knuckles.
      for (let i = 0; i < 3; i++) {
        b.blob(packed, 0.09 - i * 0.02, {
          x: side * (1.16 + i * 0.04),
          y: 0.9 - i * 0.24,
          z: -0.22 - i * 0.06,
        });
      }
      b.endLimb();
    }

    // --- legs: tree trunks, half-formed at the ankles ------------------------
    for (const side of [-1, 1]) {
      const tag = side > 0 ? 'L' : 'R';

      b.limb('hip' + tag, { x: side * 0.44, y: 1.08 });
      b.capsule(trousers, 0.44, 0.52, { x: side * 0.46, y: 0.76 });
      b.blob(sand, 0.36, { x: side * 0.46, y: 0.44 });

      b.limb('knee' + tag, { x: side * 0.46, y: 0.4 }, 'hip' + tag);
      b.capsule(trousers, 0.38, 0.42, { x: side * 0.46, y: 0.12 });
      // Torn cuff, then a foot melting into a base of loose sand.
      b.box(trousers, 0.8, 0.16, 0.8, { x: side * 0.46, y: -0.16 });
      b.blob(sand, 0.44, { x: side * 0.46, y: -0.42, sy: 0.55, sz: 1.5 });
      for (let i = 0; i < 3; i++) {
        b.blob(packed, 0.16, { x: side * (0.3 + i * 0.16), y: -0.56, z: 0.3 - i * 0.2, sy: 0.38 });
      }
      b.endLimb();
    }

    return b.commit();
  }

  /**
   * Peter, with the symbiote fully in control.
   *
   * Deliberately built on the player's own proportions rather than Venom's:
   * he is meant to read as *you*, gone wrong. Same silhouette, same white
   * spider, wrong colours and a fraying, tendrilled edge.
   */
  private buildSymbiote(parent: THREE.Group): Map<string, THREE.Group> {
    const suit = new THREE.MeshPhysicalMaterial({
      color: 0x0b0a12,
      roughness: 0.22,
      metalness: 0.12,
      clearcoat: 0.9,
      clearcoatRoughness: 0.1,
      sheen: 0.9,
      sheenRoughness: 0.3,
      sheenColor: new THREE.Color(0x6d4ba8),
      emissive: new THREE.Color(0x1a0b2a),
      emissiveIntensity: 0.4,
    });
    // Slightly lighter panels where the symbiote is stretched thin.
    const panel = new THREE.MeshPhysicalMaterial({
      color: 0x1a1526,
      roughness: 0.3,
      metalness: 0.1,
      clearcoat: 0.7,
    });
    const lens = new THREE.MeshBasicMaterial({ color: 0xe8e8f5, toneMapped: false });
    const veins = new THREE.MeshBasicMaterial({ color: 0x8b5cf6, toneMapped: false });
    this.disposables.push(suit, panel, lens, veins);
    applyRimLight(suit, 0x8b5cf6, 0.9, 2.0);

    const b = new VillainBuilder(parent, this.disposables);
    b.castsShadow(suit);
    b.castsShadow(panel);

    // --- torso: athletic, human scale, not Venom's mass ---------------------
    b.capsule(suit, 0.34, 0.72, { y: 1.32 });
    b.chest(suit, 0.5, { y: 1.5, z: 0.1 }, 3);
    b.sphere(suit, 0.34, { y: 1.56, sx: 1.15, sy: 0.9, sz: 0.85 }, 12);
    b.sphere(panel, 0.28, { y: 1.06, sx: 1.02, sy: 0.85, sz: 0.85 }, 10);
    b.sphere(suit, 0.34, { y: 0.86, sx: 1.1, sy: 0.72, sz: 0.9 }, 12);
    for (const side of [-1, 1]) {
      b.sphere(suit, 0.2, { x: side * 0.42, y: 1.62, sy: 0.85 }, 10);
      // Veins crawling up over the shoulders toward the mask.
      b.capsule(veins, 0.02, 0.34, { x: side * 0.26, y: 1.76, z: 0.14, rz: side * 0.5 });
      b.capsule(veins, 0.015, 0.26, { x: side * 0.38, y: 1.5, z: 0.22, rz: side * 0.9 });
    }

    // --- head: the mask, with the lenses fraying at the edges ---------------
    b.cylinder(suit, 0.11, 0.14, 0.14, { y: 1.82 });
    b.head(suit, 0.24, { y: 1.98, sy: 1.05 }, { brow: suit, browDepth: 0.7 });
    for (const side of [-1, 1]) {
      // Big teardrop lenses, angled — the player's own mask shape.
      b.sphere(lens, 0.12, { x: side * 0.11, y: 2.0, z: 0.19, sx: 1.25, sy: 0.85, sz: 0.4, rz: side * -0.34 }, 10);
      b.box(suit, 0.22, 0.04, 0.06, { x: side * 0.12, y: 2.1, z: 0.2, rz: side * -0.34 });
      // Tendrils lifting off the back of the skull.
      for (let i = 0; i < 3; i++) {
        b.capsule(suit, 0.028, 0.3, {
          x: side * (0.1 + i * 0.06),
          y: 2.16 + i * 0.06,
          z: -0.2 - i * 0.05,
          rx: -0.7 - i * 0.2,
          rz: side * 0.3,
        });
      }
    }

    // --- arms ---------------------------------------------------------------
    for (const side of [-1, 1]) {
      const tag = side > 0 ? 'L' : 'R';
      b.limb('shoulder' + tag, { x: side * 0.36, y: 1.58 });
      b.capsule(suit, 0.115, 0.42, { x: side * 0.44, y: 1.42, rz: side * 0.3 });
      b.sphere(suit, 0.1, { x: side * 0.56, y: 1.18 }, 8);
      b.limb('elbow' + tag, { x: side * 0.56, y: 1.18 }, 'shoulder' + tag);
      b.capsule(suit, 0.105, 0.34, { x: side * 0.6, y: 1.02, rz: side * 0.12 });
      b.hand(panel, 0.26, side, { x: side * 0.62, y: 0.78 }, { curl: 0.35 });
      // A web shooter that is now part of him.
      b.torus(veins, 0.1, 0.018, { x: side * 0.62, y: 0.88, rx: Math.PI / 2 }, 10);
      for (let i = 0; i < 2; i++) {
        b.capsule(suit, 0.02, 0.24, {
          x: side * (0.66 + i * 0.04),
          y: 1.0,
          z: -0.16 - i * 0.06,
          rx: 0.6,
        });
      }
      b.endLimb();
    }

    // --- legs ---------------------------------------------------------------
    for (const side of [-1, 1]) {
      b.capsule(suit, 0.15, 0.42, { x: side * 0.18, y: 0.6 });
      b.sphere(suit, 0.12, { x: side * 0.18, y: 0.38 }, 8);
      b.capsule(panel, 0.125, 0.34, { x: side * 0.18, y: 0.2 });
      b.foot(suit, 0.32, { x: side * 0.18, y: -0.04, z: 0.02 });
    }

    return b.commit();

    // The white spider, oversized and spilling past the ribs.
    const emblem = createEmblemMesh(0xe8e8f5, 0.9);
    emblem.position.set(0, 1.44, 0.35);
    parent.add(emblem);
    const back = createEmblemMesh(0xe8e8f5, 0.75);
    back.position.set(0, 1.44, -0.35);
    back.rotation.y = Math.PI;
    parent.add(back);
    for (const mesh of [emblem, back]) {
      this.disposables.push(mesh.geometry, mesh.material as THREE.Material);
    }
  }

  private createBolt(): Bolt {
    const points = 14;
    const positions = new Float32Array(points * 3);
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    const material = new THREE.LineBasicMaterial({
      color: 0xd8ff3c,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      toneMapped: false,
    });
    const line = new THREE.Line(geometry, material);
    line.frustumCulled = false;
    line.visible = false;
    this.group.add(line);
    this.disposables.push(geometry, material);
    return { line, material, positions, life: 0 };
  }

  /** Draws a jagged arc between two points, used for lightning and blasts. */
  private fireBolt(from: THREE.Vector3, to: THREE.Vector3, color = 0xd8ff3c): void {
    const bolt = this.bolts.find((b) => b.life <= 0) ?? this.bolts[0]!;
    const count = bolt.positions.length / 3;

    for (let i = 0; i < count; i++) {
      const t = i / (count - 1);
      _v1.lerpVectors(from, to, t);
      // Displace the interior points; pin the ends.
      const jitter = Math.sin(t * Math.PI) * 2.6;
      _v1.x += (Math.random() - 0.5) * jitter;
      _v1.y += (Math.random() - 0.5) * jitter;
      _v1.z += (Math.random() - 0.5) * jitter;
      bolt.positions[i * 3] = _v1.x;
      bolt.positions[i * 3 + 1] = _v1.y;
      bolt.positions[i * 3 + 2] = _v1.z;
    }

    (bolt.line.geometry.getAttribute('position') as THREE.BufferAttribute).needsUpdate = true;
    bolt.material.color.setHex(color);
    bolt.life = CONFIG.enemies.electro.boltLife;
    bolt.line.visible = true;
  }

  private updateBolts(dt: number): void {
    for (const bolt of this.bolts) {
      if (bolt.life <= 0) continue;
      bolt.life -= dt;
      if (bolt.life <= 0) {
        bolt.line.visible = false;
      } else {
        bolt.material.opacity = clamp(bolt.life / CONFIG.enemies.electro.boltLife, 0, 1);
      }
    }
  }

  private createImpact(): Impact {
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
    return { mesh, material, life: 0, maxLife: 0.35, size: 1 };
  }

  /** Public hook so other systems can borrow the pooled impact burst. */
  spawnImpactAt(at: THREE.Vector3, color: number, size: number): void {
    this.spawnImpact(at, color, size);
  }

  private spawnImpact(at: THREE.Vector3, color: number, size: number): void {
    const impact = this.impacts.find((i) => i.life <= 0) ?? this.impacts[0]!;
    impact.mesh.position.copy(at);
    impact.material.color.setHex(color);
    impact.life = impact.maxLife;
    impact.size = size;
    impact.mesh.visible = true;
    impact.mesh.scale.setScalar(0.1);
  }

  private updateImpacts(dt: number): void {
    for (const impact of this.impacts) {
      if (impact.life <= 0) continue;
      impact.life -= dt;
      if (impact.life <= 0) {
        impact.mesh.visible = false;
        continue;
      }
      const t = 1 - impact.life / impact.maxLife;
      impact.mesh.scale.setScalar(0.2 + t * impact.size);
      impact.material.opacity = (1 - t) * 0.85;
    }
  }
}

interface Bolt {
  line: THREE.Line;
  material: THREE.LineBasicMaterial;
  positions: Float32Array;
  life: number;
}

/** A lobbed projectile in flight — pumpkin bomb, symbiote splat or sand shard. */
export type ProjectileKind = 'BOMB' | 'SPLAT' | 'SHARD';

interface Bomb {
  mesh: THREE.Group;
  material: THREE.MeshBasicMaterial;
  velocity: THREE.Vector3;
  life: number;
  active: boolean;
  kind: ProjectileKind;
}

interface Impact {
  mesh: THREE.Mesh;
  material: THREE.MeshBasicMaterial;
  life: number;
  maxLife: number;
  size: number;
}
