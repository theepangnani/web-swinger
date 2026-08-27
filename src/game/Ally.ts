import * as THREE from 'three';
import { CONFIG } from '../core/Config';
import { clamp, damp } from '../core/MathUtils';
import { PlayerModel } from '../player/PlayerModel';
import { PlayerState } from '../player/PlayerState';
import { HEROES, type HeroId } from './Heroes';
import { DEFAULT_SUIT, findSuit } from './Suits';
import type { City } from '../world/City';
import { reachTo } from '../enemies/CombatTarget';
import type { CombatTarget, TargetProvider } from '../enemies/CombatTarget';

/**
 * The other Spider-Man, fighting alongside you.
 *
 * Deliberately *not* a second Player: no Verlet body, no web system, no
 * collision solver. A companion that shares the player's physics is a
 * companion that gets stuck on facades, falls off the map and doubles the
 * simulation cost, and none of that buys anything the player can see. This is
 * kinematic — it moves toward a goal, hugs the surface, and refuses to climb
 * anything taller than a step, which is the same rule the ground villains use.
 *
 * It reuses PlayerModel so the ally is animated by exactly the same rig as the
 * player, and it is tuned to be clearly weaker than you: an ally that
 * out-damages the player turns your own boss fight into a spectator sport.
 */

export type AllyEvent =
  | 'join'
  | 'engage'
  | 'hurt'
  | 'downed'
  | 'revived'
  | 'kill'
  | 'banter'
  | 'ability';

const _goal = new THREE.Vector3();
const _flat = new THREE.Vector3();
const _xAxis = new THREE.Vector3(1, 0, 0);
const _slump = new THREE.Quaternion();

export class Ally {
  readonly root = new THREE.Group();
  /** Counts down to a thrown web landing; see `CONFIG.ally.webRange`. */
  private webTimer = 0;
  private webCooldown = 0;
  /** Raised when they fire a web at something out of reach, for sound. */
  onWebShot: ((target: CombatTarget) => void) | null = null;

  /** Null until `summon` is called; the ally is absent for most chapters. */
  heroId: HeroId | null = null;
  active = false;

  hp: number = CONFIG.ally.maxHp;
  /** Seconds of downed time remaining, or 0 when up. */
  downed = 0;

  /** Raised for barks and HUD notices. */
  onEvent: ((event: AllyEvent, heroId: HeroId) => void) | null = null;
  /** Raised when a swing connects, so the caller can play the impact. */
  onHit: ((target: CombatTarget, heavy: boolean) => void) | null = null;
  /** Raised on the ability's contact frame, for the burst and the shake. */
  onAbility: ((heroId: HeroId, at: THREE.Vector3) => void) | null = null;

  private readonly city: City;
  private readonly model: PlayerModel;
  private readonly pos = new THREE.Vector3();
  private readonly velocity = new THREE.Vector3();
  private target: CombatTarget | null = null;
  private attackCooldown = 0;
  private attackTimer = 0;
  private attackIndex = 0;
  /** Signature ability: gap until it is available, and its wind-up. */
  private abilityCooldown = 0;
  private abilityTimer = 0;
  private sinceHit = 999;
  private banterTimer = 0;
  private state: PlayerState = PlayerState.Running;
  private bob = 0;

  // --- web-swing traverse -------------------------------------------------
  private travelTimer = 0;
  private travelDuration = 0;
  private travelCooldown = 0;
  private blockedFor = 0;
  private readonly travelFrom = new THREE.Vector3();
  private readonly travelTo = new THREE.Vector3();
  /** Synthetic anchor above the arc, so the rig reaches for a line. */
  private readonly travelAnchor = new THREE.Vector3();

  constructor(city: City) {
    this.city = city;
    this.root.name = 'Ally';
    // Built with Peter's palette and re-skinned on summon; the rig itself is
    // identical either way.
    this.model = new PlayerModel(HEROES.PETER);
    this.root.add(this.model.root);
    this.root.visible = false;
  }

  get position(): THREE.Vector3 {
    return this.pos;
  }

  get healthFraction(): number {
    return clamp(this.hp / CONFIG.ally.maxHp, 0, 1);
  }

  get name(): string {
    return this.heroId ? HEROES[this.heroId].name : '';
  }

  /** Short name for the HUD — "MILES" rather than "MILES MORALES". */
  get shortName(): string {
    return this.heroId === 'MILES' ? 'MILES' : 'PETER';
  }

  /**
   * Brings the ally into play next to the player.
   *
   * `keepHealth` is for the mid-fight hero trade: swapping puts the hero you
   * were controlling into the partner slot, and a full reset there would make
   * tapping Tab a free heal on tap.
   */
  summon(heroId: HeroId, near: THREE.Vector3, keepHealth = false): void {
    const carriedHp = this.active ? this.hp : CONFIG.ally.maxHp;
    const carriedDowned = this.active ? this.downed : 0;
    this.heroId = heroId;
    this.model.setHero(HEROES[heroId]);
    const suit = findSuit(DEFAULT_SUIT[heroId]);
    if (suit) this.model.setSuit(suit);

    // Land a little behind and to the side, on whatever surface is there.
    this.pos.set(near.x + 4, near.y, near.z + 4);
    this.pos.y = this.city.groundHeightAt(this.pos.x, this.pos.z) + CONFIG.physics.playerRadius;
    this.velocity.set(0, 0, 0);
    this.hp = keepHealth ? carriedHp : CONFIG.ally.maxHp;
    this.downed = keepHealth ? carriedDowned : 0;
    this.sinceHit = 999;
    this.travelTimer = 0;
    this.travelCooldown = 0;
    this.blockedFor = 0;
    this.target = null;
    this.attackCooldown = 0;
    this.attackTimer = 0;
    // Not zero: arriving and immediately discharging reads as a scripted
    // cutscene rather than as a decision they made.
    this.abilityCooldown = CONFIG.ally.abilityCooldown * 0.5;
    this.abilityTimer = 0;
    this.banterTimer = CONFIG.ally.bantorCooldown;
    this.active = true;
    this.root.visible = true;
    this.root.position.copy(this.pos);
    this.onEvent?.('join', heroId);
  }

  /** Removes the ally from play. Safe to call when already absent. */
  dismiss(): void {
    if (!this.active) return;
    this.active = false;
    this.root.visible = false;
    this.target = null;
  }

  /** Damage from an enemy. Returns true if this put them down. */
  takeDamage(amount: number): boolean {
    if (!this.active || this.downed > 0) return false;
    this.hp -= amount;
    this.sinceHit = 0;
    if (this.hp > 0) {
      this.onEvent?.('hurt', this.heroId!);
      return false;
    }
    this.hp = 0;
    this.downed = CONFIG.ally.downedDuration;
    this.onEvent?.('downed', this.heroId!);
    return true;
  }

  /**
   * @param playerHeading Yaw the player is facing, radians, where forward is
   *   (sin, 0, cos). Used to sit *behind* them: the follow point used to orbit
   *   on a timer, so the partner spent as much time in front of the player as
   *   behind, walking backwards through their line of fire.
   */
  update(
    dt: number,
    playerPos: THREE.Vector3,
    playerHeading: number,
    providers: readonly TargetProvider[],
  ): void {
    if (!this.active || dt <= 0) return;

    const cfg = CONFIG.ally;
    this.sinceHit += dt;
    this.attackCooldown = Math.max(0, this.attackCooldown - dt);
    this.webCooldown = Math.max(0, this.webCooldown - dt);
    this.travelCooldown = Math.max(0, this.travelCooldown - dt);
    this.abilityCooldown = Math.max(0, this.abilityCooldown - dt);

    // Mid-swing: nothing else runs. The arc is committed once it starts.
    if (this.travelTimer > 0) {
      this.stepTravel(dt);
      this.pose(dt, playerPos);
      return;
    }

    // --- downed: on one knee, out of the fight, back up on their own -------
    if (this.downed > 0) {
      this.downed -= dt;
      this.velocity.set(0, 0, 0);
      this.state = PlayerState.Attacking;
      if (this.downed <= 0) {
        this.hp = CONFIG.ally.maxHp * 0.5;
        this.onEvent?.('revived', this.heroId!);
        // Come back up next to the player rather than wherever they fell.
        this.pos.set(playerPos.x + 3, playerPos.y, playerPos.z + 3);
        this.pos.y = this.city.groundHeightAt(this.pos.x, this.pos.z) + CONFIG.physics.playerRadius;
      }
      this.pose(dt, playerPos);
      return;
    }

    if (this.sinceHit > cfg.regenDelay && this.hp < cfg.maxHp) {
      this.hp = Math.min(cfg.maxHp, this.hp + cfg.regenPerSecond * dt);
    }

    // --- pick a target -----------------------------------------------------
    const leashed = this.pos.distanceTo(playerPos) > cfg.leashRange;
    if (leashed) this.target = null;
    if (!this.target || !this.target.alive || reachTo(this.target, this.pos) > cfg.engageRange * 1.4) {
      const previous = this.target;
      this.target = leashed ? null : this.pickTarget(providers, playerPos);
      if (this.target && !previous) this.onEvent?.('engage', this.heroId!);
    }

    // --- signature ability: charged, then resolved on the contact frame -----
    if (this.abilityTimer > 0) {
      this.abilityTimer -= dt;
      this.state = PlayerState.Attacking;
      this.velocity.x = damp(this.velocity.x, 0, 12, dt);
      this.velocity.z = damp(this.velocity.z, 0, 12, dt);
      this.integrate(dt);
      if (this.abilityTimer <= 0) this.resolveAbility(providers);
      this.pose(dt, playerPos);
      return;
    }

    // --- mid-swing: hold position and resolve on the contact frame ---------
    if (this.attackTimer > 0) {
      this.attackTimer -= dt;
      this.state = PlayerState.Attacking;
      this.velocity.x = damp(this.velocity.x, 0, 10, dt);
      this.velocity.z = damp(this.velocity.z, 0, 10, dt);
      this.integrate(dt);
      if (this.attackTimer <= 0) this.resolveSwing(providers);
      this.pose(dt, playerPos);
      return;
    }

    // A web already on its way. Held apart from the swing so a target that
    // climbs out of melee reach mid-wind-up still gets hit by something.
    if (this.webTimer > 0) {
      this.webTimer -= dt;
      this.state = PlayerState.Attacking;
      this.integrate(dt);
      if (this.webTimer <= 0) this.resolveWeb(providers);
      this.pose(dt, playerPos);
      return;
    }

    // --- move --------------------------------------------------------------
    if (this.target) {
      _goal.copy(this.target.pos);
      // Stop short so they punch rather than stand inside the enemy. Measured
      // to the target's surface, so a villain the size of a building does not
      // pull them into its shins.
      _flat.copy(this.pos).sub(_goal).setY(0);
      const flatLength = _flat.length();
      const standOff = (this.target.hitRadius ?? 0) + cfg.attackRange * 0.6;
      if (flatLength > 1e-3) _goal.addScaledVector(_flat.divideScalar(flatLength), standOff);

      const gap = reachTo(this.target, this.pos);
      // The ability goes first when it is up: it out-damages four swings, so
      // opening with it is what a partner who was paying attention would do.
      if (gap < cfg.abilityRange && this.abilityCooldown <= 0) {
        this.abilityTimer = cfg.abilityTelegraph;
        this.abilityCooldown = cfg.abilityCooldown;
      } else if (gap < cfg.attackRange && this.attackCooldown <= 0) {
        this.attackTimer = cfg.attackTelegraph;
        this.attackIndex = (this.attackIndex + 1) % 3;
        this.attackCooldown = cfg.attackCooldown;
      } else if (gap < cfg.webRange && this.webCooldown <= 0) {
        // Out of arm's reach and staying there — which, for a partner who
        // cannot leave the ground, is every flier in the game.
        this.webTimer = cfg.webTelegraph;
        this.webCooldown = cfg.webCooldown;
      }
    } else {
      // Follow: a step behind and slightly to one side, in the player's own
      // frame. The sway is lateral only, so they never cut across in front.
      const lateral = Math.sin(this.bob * 0.7) * cfg.followDistance * 0.35;
      const forward = -cfg.followDistance;
      _goal.set(
        playerPos.x + Math.sin(playerHeading) * forward + Math.cos(playerHeading) * lateral,
        playerPos.y + cfg.followHeight,
        playerPos.z + Math.cos(playerHeading) * forward - Math.sin(playerHeading) * lateral,
      );
    }

    // Swing rather than run when the goal is far, above, or behind a facade.
    if (this.shouldTravel(_goal)) {
      this.beginTravel(_goal);
      this.stepTravel(dt);
      this.pose(dt, playerPos);
      return;
    }

    this.steer(dt, _goal);
    this.integrate(dt);
    this.pose(dt, playerPos);

    // Idle banter, only when nothing is happening.
    this.banterTimer -= dt;
    if (this.banterTimer <= 0) {
      this.banterTimer = cfg.bantorCooldown;
      if (!this.target) this.onEvent?.('banter', this.heroId!);
    }
  }

  dispose(): void {
    this.model.dispose();
  }

  // ---------------------------------------------------------------- private

  /**
   * The enemy worth breaking off for.
   *
   * Weighted toward the *player's* fight rather than the partner's own
   * convenience. The old scoring did the opposite — own distance counted
   * double the player's — so with a boss on a roof and a thug in the street
   * below, they reliably picked the thug and you fought the boss alone. A
   * boss also outranks anything else outright: they are the fight.
   */
  private pickTarget(providers: readonly TargetProvider[], playerPos: THREE.Vector3): CombatTarget | null {
    let best: CombatTarget | null = null;
    let bestScore = Infinity;
    for (const provider of providers) {
      for (const candidate of provider.combatTargets) {
        if (!candidate.alive) continue;
        const own = reachTo(candidate, this.pos);
        if (own > CONFIG.ally.engageRange) continue;
        // maxHp is a decent proxy for boss-vs-thug without this module needing
        // to know what a villain is.
        const bossBias = candidate.maxHp > 120 ? -220 : 0;
        const score = own * 0.4 + reachTo(candidate, playerPos) + bossBias;
        if (score < bestScore) {
          bestScore = score;
          best = candidate;
        }
      }
    }
    return best;
  }

  /**
   * The hero's signature move, on the contact frame of its wind-up.
   *
   * Miles discharges a venom blast: everything around the target takes the hit
   * and is stunned. Peter yanks one target off its feet and cocoons it. Both
   * bypass `attackRange` — the ability has its own, longer reach — so a
   * partner can contribute to a fight they have not closed on yet.
   */
  private resolveAbility(providers: readonly TargetProvider[]): void {
    const cfg = CONFIG.ally;
    const target = this.target;
    if (!target || !target.alive) return;
    if (reachTo(target, this.pos) > cfg.abilityRange * 1.4) return;

    // maxHp stands in for "is this a boss" without this module needing to know
    // what a villain is. Bosses take the damage but shrug off most of the hold.
    const holdFor = (t: CombatTarget, seconds: number): number =>
      t.maxHp > 120 ? seconds * cfg.abilityBossStunScale : seconds;

    const venom = this.heroId === 'MILES';
    for (const provider of providers) {
      if (!provider.combatTargets.includes(target)) continue;

      if (venom) {
        for (const candidate of provider.combatTargets) {
          if (!candidate.alive) continue;
          if (reachTo(candidate, target.pos) > cfg.abilityRadius) continue;
          provider.damageTarget(candidate, cfg.abilityDamage, this.pos);
          candidate.webbed = Math.max(candidate.webbed, holdFor(candidate, cfg.abilityStun));
        }
      } else {
        provider.damageTarget(target, cfg.abilityDamage * 1.25, this.pos);
        target.webbed = Math.max(target.webbed, holdFor(target, cfg.abilityStun * 1.5));
      }
      break;
    }

    this.onAbility?.(this.heroId!, target.pos);
    this.onEvent?.('ability', this.heroId!);
    if (!target.alive) {
      this.onEvent?.('kill', this.heroId!);
      this.target = null;
    }
  }

  /**
   * Should they swing to the goal instead of running to it?
   *
   * Three cases, and the last is the important one: running is fine for short
   * hops on the same level, but a goal on a rooftop is unreachable on foot,
   * and so is anything on the far side of a building. Without this the partner
   * spends the entire fight grinding along a facade at street level.
   */
  private shouldTravel(goal: THREE.Vector3): boolean {
    const cfg = CONFIG.ally;
    if (this.travelCooldown > 0) return false;

    const flat = Math.hypot(goal.x - this.pos.x, goal.z - this.pos.z);
    if (flat < 6) return false;
    if (flat > cfg.travelDistance) return true;
    if (Math.abs(goal.y - this.pos.y) > cfg.travelRise) return true;
    // Wedged against something they cannot step over.
    return this.blockedFor > cfg.blockedBeforeTravel;
  }

  /** Commits to an arc toward the goal, landing on whatever surface is there. */
  private beginTravel(goal: THREE.Vector3): void {
    const cfg = CONFIG.ally;
    this.travelFrom.copy(this.pos);
    this.travelTo.copy(goal);
    // Land on the surface under the goal, not at the goal's own altitude —
    // the follow point is an offset in mid-air, and dropping them onto a
    // rooftop is the whole objective.
    this.travelTo.y =
      this.city.groundHeightAt(goal.x, goal.z) + CONFIG.physics.playerRadius;

    const distance = this.travelFrom.distanceTo(this.travelTo);
    this.travelDuration = clamp(distance / cfg.travelSpeed, cfg.travelMinTime, cfg.travelMaxTime);
    this.travelTimer = this.travelDuration;
    this.blockedFor = 0;
    this.state = PlayerState.Swinging;
  }

  /** Advances the arc. Deliberately ignores collision — they are on a line. */
  private stepTravel(dt: number): void {
    this.travelTimer -= dt;
    const t = clamp(1 - this.travelTimer / Math.max(1e-3, this.travelDuration), 0, 1);

    const previousY = this.pos.y;
    this.pos.lerpVectors(this.travelFrom, this.travelTo, t);
    // Parabolic lift over the straight line, peaking mid-flight.
    const apex = CONFIG.ally.travelArc * Math.min(1, this.travelDuration / 1.2);
    this.pos.y += Math.sin(t * Math.PI) * apex;

    // Velocity drives the rig's lean and run cycle, so keep it honest.
    if (dt > 0) {
      this.velocity.set(
        (this.travelTo.x - this.travelFrom.x) / this.travelDuration,
        (this.pos.y - previousY) / dt,
        (this.travelTo.z - this.travelFrom.z) / this.travelDuration,
      );
    }

    // A line running up and ahead, for the swing pose to reach toward.
    this.travelAnchor.set(this.pos.x, this.pos.y + 18, this.pos.z);
    this.travelAnchor.lerp(this.travelTo, 0.25);
    this.travelAnchor.y = this.pos.y + 18;

    this.state = PlayerState.Swinging;
    this.root.position.copy(this.pos);

    if (this.travelTimer <= 0) {
      this.travelTimer = 0;
      this.travelCooldown = CONFIG.ally.travelCooldown;
      this.pos.copy(this.travelTo);
      this.velocity.set(0, 0, 0);
      this.root.position.copy(this.pos);
      this.state = PlayerState.Running;
    }
  }

  /** Accelerates toward a goal without ever climbing a wall. */
  private steer(dt: number, goal: THREE.Vector3): void {
    const cfg = CONFIG.ally;
    _flat.set(goal.x - this.pos.x, 0, goal.z - this.pos.z);
    const distance = _flat.length();

    if (distance > 1.2) {
      _flat.divideScalar(distance);
      // Sprint to catch up when badly out of position, so a leash break does
      // not leave them jogging half a block behind for the rest of the fight.
      const urgency = distance > cfg.leashRange * 0.6 ? 1.8 : 1;
      this.velocity.x = damp(this.velocity.x, _flat.x * cfg.speed * urgency, cfg.accel * 0.1, dt);
      this.velocity.z = damp(this.velocity.z, _flat.z * cfg.speed * urgency, cfg.accel * 0.1, dt);
      this.state = distance > 26 ? PlayerState.Sprinting : PlayerState.Running;
    } else {
      this.velocity.x = damp(this.velocity.x, 0, 9, dt);
      this.velocity.z = damp(this.velocity.z, 0, 9, dt);
      this.state = PlayerState.Running;
    }
  }

  /** Applies velocity and snaps to the surface, treating ledges as walls. */
  private integrate(dt: number): void {
    const prevX = this.pos.x;
    const prevZ = this.pos.z;
    this.pos.x += this.velocity.x * dt;
    this.pos.z += this.velocity.z * dt;

    const surface = this.city.groundHeightAt(this.pos.x, this.pos.z) + CONFIG.physics.playerRadius;
    const climb = surface - this.pos.y;

    if (climb > 4) {
      // A facade, not a step. Undo and slide along it — but count the time,
      // because sliding forever is exactly the failure this used to have.
      // Past a threshold `shouldTravel` gives up and swings over it instead.
      this.blockedFor += dt;
      this.pos.x = prevX;
      this.pos.z = prevZ;
      const slideX = -this.velocity.z;
      const slideZ = this.velocity.x;
      const length = Math.hypot(slideX, slideZ) || 1;
      this.velocity.x = (slideX / length) * CONFIG.ally.speed * 0.6;
      this.velocity.z = (slideZ / length) * CONFIG.ally.speed * 0.6;
    } else {
      this.blockedFor = 0;
      // Vertical rate is capped so even a legal step never looks like phasing.
      const maxRise = 14 * dt;
      const next = damp(this.pos.y, surface, 8, dt);
      this.pos.y = clamp(next, this.pos.y - maxRise * 3, this.pos.y + maxRise);
      if (climb > 0.4) this.state = PlayerState.Airborne;
    }

    this.root.position.copy(this.pos);
  }

  /** Damage on the swing's contact frame. */
  /**
   * A thrown web landing.
   *
   * Deliberately not gated on the target having stayed still: it is a web, it
   * was aimed, and a flier drifting two metres between the throw and the
   * landing should not make it miss. The generous range check is what stops it
   * hitting something that has genuinely left.
   */
  private resolveWeb(providers: readonly TargetProvider[]): void {
    const cfg = CONFIG.ally;
    const target = this.target;
    if (!target || !target.alive) return;
    if (reachTo(target, this.pos) > cfg.webRange * 1.25) return;

    for (const provider of providers) {
      if (!provider.combatTargets.includes(target)) continue;
      provider.damageTarget(target, cfg.webDamage, this.pos);
      break;
    }
    this.onWebShot?.(target);
    if (!target.alive) {
      this.onEvent?.('kill', this.heroId!);
      this.target = null;
    }
  }

  private resolveSwing(providers: readonly TargetProvider[]): void {
    const cfg = CONFIG.ally;
    const target = this.target;
    if (!target || !target.alive) return;
    if (reachTo(target, this.pos) > cfg.attackRange * 1.5) return;

    const heavy = Math.random() < cfg.heavyChance;
    const damage = cfg.damage * (heavy ? cfg.heavyScale : 1);
    for (const provider of providers) {
      if (!provider.combatTargets.includes(target)) continue;
      provider.damageTarget(target, damage, this.pos);
      break;
    }
    this.onHit?.(target, heavy);
    if (!target.alive) {
      this.onEvent?.('kill', this.heroId!);
      this.target = null;
    }
  }

  /** Drives the shared character rig. */
  private pose(dt: number, playerPos: THREE.Vector3): void {
    this.bob += dt;
    const facingTarget = this.target?.pos ?? playerPos;
    const yaw = Math.atan2(facingTarget.x - this.pos.x, facingTarget.z - this.pos.z);

    this.model.update(dt, {
      state: this.state,
      velocity: this.velocity,
      // Mid-traverse the rig reaches for a real line, so the arc reads as a
      // swing rather than a jump.
      anchor: this.travelTimer > 0 ? this.travelAnchor : null,
      wallNormal: null,
      // PlayerModel uses cameraYaw *directly* as the rig's facing angle when
      // barely moving, and the rig faces +Z — so this is atan2(dx, dz) with no
      // offset. Feeding it the bearing to whatever they care about makes them
      // turn to face their target when standing still.
      cameraYaw: yaw,
      surgeActive: false,
      attackIndex: this.attackIndex,
      attackProgress:
        this.attackTimer > 0 ? 1 - clamp(this.attackTimer / CONFIG.ally.attackTelegraph, 0, 1) : 0,
      trickSpin: 0,
      landImpact: 0,
      throwTimer: 0,
    });

    // Downed reads as a slump; the rig has no downed pose of its own.
    //
    // This has to go through the quaternion. PlayerModel sets the rig's facing
    // with `quaternion.setFromAxisAngle(WORLD_UP, facing)`, and three.js keeps
    // the Euler in sync by decomposing that quaternion in XYZ order — which,
    // for any yaw past ±90°, comes back as (π, π−yaw, π) rather than
    // (0, yaw, 0). Writing `rotation.x = 0` on top of that kept the π on Z and
    // left the partner walking around upside down for every heading in the
    // rear hemisphere. Post-multiplying pitches in the rig's own local frame
    // and never touches the Euler.
    if (this.downed > 0) {
      _slump.setFromAxisAngle(_xAxis, 1.2);
      this.model.root.quaternion.multiply(_slump);
      this.model.root.position.y = -0.35;
    } else {
      this.model.root.position.y = 0;
    }
  }
}
