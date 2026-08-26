import * as THREE from 'three';
import { CONFIG } from '../core/Config';
import { clamp, lerp } from '../core/MathUtils';
import type { City, Contact } from '../world/City';
import { HEROES, nextHero, type HeroDef, type HeroId } from '../game/Heroes';
import { DEFAULT_SUIT, findSuit, type SuitDef } from '../game/Suits';
import { PlayerModel } from './PlayerModel';
import type { CharacterRig } from './CharacterRig';
import { PlayerState } from './PlayerState';
import type { SwingBody, WebSystem } from './WebSystem';

export interface PlayerContext {
  city: City;
  web: WebSystem;
  /** Camera yaw, in the convention forward = (-sin y, 0, -cos y). */
  cameraYaw: number;
  /** Analog move input, already deadzoned. */
  moveX: number;
  moveY: number;
  /** +1 reels in, -1 pays line out. */
  reelAxis: number;
  /**
   * Walls are grabbed automatically on contact. This is the *opt out* — hold
   * it to let go and drop instead of sticking.
   */
  releaseWall: boolean;
  sprintHeld: boolean;
  glideHeld: boolean;
  /** Holding the jump key on the ground charges a super-jump. */
  chargeHeld: boolean;
  /** Skill-tree lookup, so movement can be gated on unlocks. */
  hasSkill: (id: string) => boolean;
}

/** Something the player can dash at. Kept structural to avoid a cycle. */
export interface StrikeTarget {
  pos: THREE.Vector3;
  alive: boolean;
}

const UP = new THREE.Vector3(0, 1, 0);

/**
 * The player: a Verlet point mass with a state machine on top.
 *
 * Integration is `x' = 2x - x_prev + a*dt^2`, run at a fixed 120 Hz. Velocity
 * is never stored as the source of truth — it is always derived from the two
 * positions, which is what lets the web constraint and collision solver alter
 * motion just by moving `pos`.
 */
export class Player implements SwingBody {
  readonly pos = new THREE.Vector3();
  readonly prevPos = new THREE.Vector3();
  readonly velocity = new THREE.Vector3();
  readonly model: PlayerModel;
  /**
   * Active rig. Starts as the procedural model and is swapped for a loaded
   * glTF character if one is supplied.
   */
  rig: CharacterRig;

  state: PlayerState = PlayerState.Airborne;
  grounded = false;
  wallNormal: THREE.Vector3 | null = null;

  // Annotated so the `as const` config literal doesn't pin the field type.
  hp: number = CONFIG.combat.playerMaxHp;
  special = 40;
  /** Focus: spent on healing or a finisher. */
  focus = 0;
  combo = 0;
  comboTimer = 0;
  heroId: HeroId = 'PETER';
  /** Equipped skin. Persists per hero across swaps. */
  suitId: string = DEFAULT_SUIT.PETER;
  /** Difficulty multiplier on incoming damage, set from Settings. */
  damageTakenScale = 1;
  surgeTimer = 0;
  invulnTimer = 0;
  strikeCooldown = 0;

  // --- traversal / defence state -------------------------------------------
  dodgeCooldown = 0;
  /** Set for one frame when a dodge begins, so the Game can score it. */
  dodgedThisFrame = false;
  wallRunTimer = 0;
  chargeTimer = 0;
  gliding = false;
  /** Accumulated spin, purely visual, while performing air tricks. */
  trickSpin = 0;
  /** Which hit of the melee combo is playing, 0..2. */
  attackIndex = 0;
  /** 0..1 progress through the current melee swing, for the animator. */
  attackProgress = 0;
  /** True on the single frame a melee swing should deal its damage. */
  meleeLandedThisFrame = false;
  /** 0..1 landing impact, decaying — drives the touchdown crouch. */
  landImpact = 0;
  /** Remaining time on the gadget throw animation. */
  throwTimer = 0;
  /** Set for one frame on a hard touchdown, so the Game can shake the camera. */
  landedHardThisFrame = false;
  /** Height above the surface directly below — drives tricks and gliding. */
  altitude = 0;

  /** Set for one frame when the player is hurt, so the HUD can flash. */
  damagedThisFrame = false;

  private readonly acc = new THREE.Vector3();
  private readonly wish = new THREE.Vector3();
  private readonly scratch = new THREE.Vector3();
  private readonly contacts: Contact[] = [];
  private readonly substepStart = new THREE.Vector3();
  private readonly handPos = new THREE.Vector3();
  private readonly wallStore = new THREE.Vector3();

  private pendingJump = false;
  private strikeTimer = 0;
  private strikeTarget: StrikeTarget | null = null;
  private readonly strikeDir = new THREE.Vector3();

  private dodgeTimer = 0;
  private readonly dodgeDir = new THREE.Vector3();
  private attackTimer = 0;
  private attackChainTimer = 0;
  private attackDealt = false;
  private readonly attackDir = new THREE.Vector3();
  /** Live target for the current swing, so the lunge can track it. */
  private attackTarget: THREE.Vector3 | null = null;
  private attackHasTarget = false;
  private zipTimer = 0;
  private readonly zipTarget = new THREE.Vector3();
  private readonly wallRunNormal = new THREE.Vector3();
  /** Velocity as of the start of collision resolution, before it was damped. */
  private readonly preContactVel = new THREE.Vector3();
  /** Speed into the wall we just touched, m/s. Drives the automatic grab. */
  private wallApproach = 0;
  /** Remaining grace period after losing wall contact. */
  private wallCoyote = 0;
  /** Seconds since the last hit taken, for out-of-combat regeneration. */
  private timeSinceHit = 999;
  /** Remembers each hero's last chosen skin so swapping back restores it. */
  private readonly lastSuitByHero: Record<HeroId, string> = {
    PETER: DEFAULT_SUIT.PETER,
    MILES: DEFAULT_SUIT.MILES,
  };

  constructor(spawn: THREE.Vector3) {
    this.pos.copy(spawn);
    this.prevPos.copy(spawn);
    this.model = new PlayerModel(HEROES[this.heroId]);
    this.model.root.position.copy(spawn);
    this.rig = this.model;
  }

  /**
   * Replaces the procedural rig with a loaded character. Returns the node that
   * should be removed from the scene, so the caller can swap them over.
   */
  adoptRig(rig: CharacterRig): THREE.Object3D {
    const outgoing = this.rig;
    const previous = outgoing.root;
    rig.root.position.copy(previous.position);
    this.rig = rig;
    // Release the rig we are replacing; nothing references it after the swap.
    if (outgoing !== rig) outgoing.dispose();
    return previous;
  }

  get hero(): HeroDef {
    return HEROES[this.heroId];
  }

  get speed(): number {
    return this.velocity.length();
  }

  get speedKmh(): number {
    return this.velocity.length() * 3.6;
  }

  get isStriking(): boolean {
    return this.strikeTimer > 0;
  }

  get surgeActive(): boolean {
    return this.surgeTimer > 0;
  }

  /** Damage multiplier currently in effect for web strikes. */
  get damageMultiplier(): number {
    return this.surgeActive ? this.hero.surgeDamageMultiplier : 1;
  }

  // ------------------------------------------------------------ per-frame

  /** Called once per rendered frame, before the fixed substeps. */
  /**
   * Per-frame bookkeeping. `city` is used for a single altitude probe — doing
   * it here rather than per substep saves ~120 raycasts a second.
   */
  beginFrame(dt: number, city?: City): void {
    if (city) this.altitude = this.measureAltitude(city);
    this.damagedThisFrame = false;
    this.dodgedThisFrame = false;
    this.invulnTimer = Math.max(0, this.invulnTimer - dt);
    this.strikeCooldown = Math.max(0, this.strikeCooldown - dt);
    this.surgeTimer = Math.max(0, this.surgeTimer - dt);
    this.dodgeCooldown = Math.max(0, this.dodgeCooldown - dt);
    this.attackChainTimer = Math.max(0, this.attackChainTimer - dt);
    this.meleeLandedThisFrame = false;
    this.landedHardThisFrame = false;
    this.landImpact = Math.max(0, this.landImpact - dt * 3.2);
    this.throwTimer = Math.max(0, this.throwTimer - dt);
    if (this.attackChainTimer <= 0 && this.attackTimer <= 0) this.attackIndex = 0;

    if (this.comboTimer > 0) {
      this.comboTimer -= dt;
      if (this.comboTimer <= 0) this.combo = 0;
    }
    this.special = Math.min(
      CONFIG.combat.specialMax,
      this.special + CONFIG.combat.specialRegenPerSecond * dt,
    );

    // Health recovers out of combat, so a bad fight is not a permanent tax on
    // a long free-roam session.
    this.timeSinceHit += dt;
    if (this.timeSinceHit > CONFIG.combat.regenDelay && this.hp > 0) {
      this.hp = Math.min(CONFIG.combat.playerMaxHp, this.hp + CONFIG.combat.regenRate * dt);
    }
  }

  queueJump(): void {
    this.pendingJump = true;
  }

  // -------------------------------------------------------------- physics

  /** One fixed-timestep substep. */
  step(dt: number, ctx: PlayerContext): void {
    this.substepStart.copy(this.pos);
    this.velocity.copy(this.pos).sub(this.prevPos).divideScalar(dt);

    if (this.strikeTimer > 0) {
      this.stepStrike(dt, ctx);
      return;
    }
    if (this.dodgeTimer > 0) {
      this.stepDodge(dt, ctx);
      return;
    }
    if (this.attackTimer > 0) {
      this.stepMelee(dt, ctx);
      return;
    }
    if (this.zipTimer > 0) {
      this.stepZip(dt, ctx);
      return;
    }

    this.acc.set(0, 0, 0);

    const crawling = this.state === PlayerState.WallCrawl;
    const wallRunning = this.state === PlayerState.WallRun;
    if (crawling) {
      // no gravity while stuck to a surface
    } else if (wallRunning) {
      this.acc.y -= CONFIG.traversal.wallRunGravity;
    } else {
      this.acc.y -= CONFIG.physics.gravity;
    }

    // Quadratic air drag gives a sane terminal velocity without a hard clamp.
    const speed = this.velocity.length();
    if (speed > 0.001) {
      this.acc.addScaledVector(this.velocity, -CONFIG.physics.airDrag * speed);
    }

    switch (this.state) {
      case PlayerState.Running:
      case PlayerState.Sprinting:
      case PlayerState.Charging:
        this.driveGround(dt, ctx);
        break;
      case PlayerState.Swinging:
        this.driveSwing(dt, ctx);
        break;
      case PlayerState.WallCrawl:
        this.driveWall(dt, ctx);
        break;
      case PlayerState.WallRun:
        this.driveWallRun(dt, ctx);
        break;
      case PlayerState.Gliding:
        this.driveGlide(dt, ctx);
        break;
      default:
        this.driveAir(dt, ctx);
        break;
    }

    this.integrate(dt);
    ctx.web.solve(this, dt);
    this.collide(dt, ctx.city);
    this.resolveState(ctx);
  }

  /** Rebuilds the visual transform between physics steps. */
  render(dt: number, alpha: number, cameraYaw: number, anchor: THREE.Vector3 | null): void {
    this.rig.root.position.lerpVectors(this.substepStart, this.pos, clamp(alpha, 0, 1));
    this.rig.update(dt, {
      state: this.state,
      velocity: this.velocity,
      anchor,
      wallNormal: this.wallNormal,
      cameraYaw,
      surgeActive: this.surgeActive,
      attackIndex: this.attackIndex,
      attackProgress: this.attackProgress,
      trickSpin: this.trickSpin,
      landImpact: this.landImpact,
      throwTimer: this.throwTimer,
    });
  }

  getHandPosition(): THREE.Vector3 {
    this.rig.getHandPosition(this.handPos);
    return this.handPos;
  }

  // --------------------------------------------------------------- combat

  /** Sideways evade. Returns false while on cooldown or already dodging. */
  beginDodge(ctx: PlayerContext): boolean {
    if (this.dodgeCooldown > 0 || this.dodgeTimer > 0 || this.strikeTimer > 0) return false;

    this.computeWish(ctx, true);
    if (this.wish.lengthSq() < 1e-4) {
      // No input: dodge backwards, away from the camera.
      this.wish.set(Math.sin(ctx.cameraYaw), 0, Math.cos(ctx.cameraYaw));
    }
    this.dodgeDir.copy(this.wish).normalize();
    this.dodgeTimer = CONFIG.dodge.duration;
    this.dodgeCooldown = CONFIG.dodge.cooldown;
    this.invulnTimer = Math.max(this.invulnTimer, CONFIG.dodge.iframes);
    this.dodgedThisFrame = true;
    this.state = PlayerState.Dodging;
    return true;
  }

  /**
   * Starts the next hit of the ground melee combo, lunging toward `target`.
   * Returns false if a swing is already playing.
   */
  beginMelee(target: THREE.Vector3 | null, cameraYaw: number): boolean {
    if (this.attackTimer > 0 || this.strikeTimer > 0 || this.dodgeTimer > 0) return false;

    // Hold the target so the lunge can keep tracking it. A fixed direction
    // means you slide straight past anything that moves while you swing.
    this.attackTarget = target;
    this.attackHasTarget = target !== null;

    if (target) {
      this.attackDir.copy(target).sub(this.pos).setY(0);
      if (this.attackDir.lengthSq() < 1e-6) this.attackDir.set(0, 0, 1);
      this.attackDir.normalize();
    } else {
      this.attackDir.set(-Math.sin(cameraYaw), 0, -Math.cos(cameraYaw));
    }

    // Chain into the next hit if the previous one landed recently.
    this.attackIndex = this.attackChainTimer > 0 ? (this.attackIndex + 1) % 3 : 0;
    this.attackTimer = CONFIG.combat.meleeDuration;
    this.attackProgress = 0;
    this.attackDealt = false;
    this.attackChainTimer = CONFIG.combat.meleeChainWindow;
    this.state = PlayerState.Attacking;
    return true;
  }

  /** Launches a straight-line zip toward `point`. */
  beginZip(point: THREE.Vector3): boolean {
    const distance = this.pos.distanceTo(point);
    if (distance < 3 || distance > CONFIG.traversal.zipMaxDistance) return false;
    this.zipTarget.copy(point);
    this.zipTimer = distance / CONFIG.traversal.zipSpeed + 0.25;
    this.state = PlayerState.Zipping;
    return true;
  }

  /** Plays a short overhand throw. Purely cosmetic; does not block movement. */
  beginThrow(): void {
    this.throwTimer = CONFIG.combat.throwDuration;
  }

  setGliding(on: boolean): void {
    this.gliding = on;
  }

  addFocus(amount: number): void {
    this.focus = clamp(this.focus + amount, 0, CONFIG.focus.max);
  }

  /** Spends a full bar. Returns false if the bar isn't full. */
  spendFocus(): boolean {
    if (this.focus < CONFIG.focus.max) return false;
    this.focus = 0;
    return true;
  }

  heal(amount: number): void {
    this.hp = clamp(this.hp + amount, 0, CONFIG.combat.playerMaxHp);
  }

  beginStrike(target: StrikeTarget): boolean {
    if (this.strikeCooldown > 0 || this.strikeTimer > 0) return false;
    this.strikeTarget = target;
    this.strikeTimer = CONFIG.combat.strikeMaxTime;
    this.strikeCooldown = CONFIG.combat.strikeCooldown;
    return true;
  }

  endStrike(): void {
    this.strikeTimer = 0;
    this.strikeTarget = null;
  }

  registerHit(): void {
    this.combo += 1;
    this.comboTimer = CONFIG.combat.comboWindow;
    this.special = Math.min(CONFIG.combat.specialMax, this.special + CONFIG.combat.specialPerHit);
  }

  takeDamage(amount: number, knockback?: THREE.Vector3): boolean {
    if (this.invulnTimer > 0) return false;
    this.hp = Math.max(0, this.hp - amount * this.damageTakenScale);
    this.invulnTimer = CONFIG.combat.invulnTime;
    this.damagedThisFrame = true;
    this.timeSinceHit = 0;
    this.combo = 0;
    this.comboTimer = 0;
    if (knockback) this.addImpulse(knockback);
    return true;
  }

  /** Consumes the special meter. Returns false if it wasn't full enough. */
  useAbility(): boolean {
    if (this.special < CONFIG.combat.specialMax) return false;
    this.special = 0;
    this.surgeTimer = CONFIG.combat.abilityDuration;
    return true;
  }

  swapHero(): HeroDef {
    return this.setHero(nextHero(this.heroId));
  }

  /**
   * Switches to a specific hero. Used by the story where a chapter requires
   * one of them — you cannot play Peter in the chapters where Peter is the
   * thing you are fighting.
   */
  setHero(heroId: HeroId): HeroDef {
    this.heroId = heroId;
    // Fall back to the incoming hero's default skin — suits are hero-specific.
    this.equipSuit(this.lastSuitByHero[this.heroId] ?? DEFAULT_SUIT[this.heroId]);
    return this.hero;
  }

  /** Per-hero skin choices, for the save file. */
  get suitChoices(): Record<HeroId, string> {
    return { ...this.lastSuitByHero };
  }

  /** Restores hero and skin choices from a save. */
  restoreAppearance(heroId: HeroId, suitByHero: Record<string, string>): void {
    this.heroId = heroId;
    for (const hero of ['PETER', 'MILES'] as HeroId[]) {
      const id = suitByHero[hero];
      if (id) this.lastSuitByHero[hero] = id;
    }
    this.equipSuit(this.lastSuitByHero[heroId] ?? DEFAULT_SUIT[heroId]);
  }

  /** Equips a skin by id. Unknown ids fall back to the hero's default. */
  equipSuit(id: string): SuitDef | null {
    const suit = findSuit(id) ?? findSuit(DEFAULT_SUIT[this.heroId]);
    if (!suit) return null;
    this.suitId = suit.id;
    this.lastSuitByHero[suit.hero] = suit.id;
    this.rig.setSuit(suit);
    return suit;
  }

  /**
   * Holds the player inside a vertical cylinder — bounded horizontally, free
   * to move up and down.
   *
   * This used to be a sphere, which meant the boundary had a *floor*. Engage a
   * boss on a two-hundred-metre roof and the arena centre is pinned up there,
   * so the street below is outside the sphere: every attempt to descend was
   * pushed back up onto the boundary, and with webs disabled in the same fight
   * there was no way down at all. A vertical bound was never the point — the
   * arena exists so the fight stays in one district, and going high is what
   * swinging *is*.
   *
   * This must translate `prevPos` alongside `pos`. In Verlet the two positions
   * *are* the velocity, so nudging `pos` alone is not a nudge — it is a
   * velocity injection, and at arena pushback rates it computes out to
   * hundreds of metres per second inward. Translating both is a pure move.
   */
  confineToCylinder(centre: THREE.Vector3, radius: number, maxPush: number): boolean {
    // Horizontal offset only, so nothing below cancels vertical velocity and
    // gravity always wins.
    this.scratch.set(this.pos.x - centre.x, 0, this.pos.z - centre.z);
    const distance = this.scratch.length();
    if (distance <= radius || distance < 1e-5) return false;

    this.scratch.divideScalar(distance);
    const push = Math.min(distance - radius, maxPush);
    this.pos.addScaledVector(this.scratch, -push);
    this.prevPos.addScaledVector(this.scratch, -push);

    // Cancel the outward component so you stop pressing against the boundary
    // instead of grinding along it.
    this.velocity.copy(this.pos).sub(this.prevPos).divideScalar(CONFIG.physics.fixedDt);
    const outward = this.velocity.dot(this.scratch);
    if (outward > 0) {
      this.velocity.addScaledVector(this.scratch, -outward);
      this.setVelocity(this.velocity, CONFIG.physics.fixedDt);
    }
    return true;
  }

  addImpulse(delta: THREE.Vector3): void {
    // In Verlet, an impulse is applied by displacing the previous position.
    this.prevPos.sub(this.scratch.copy(delta).multiplyScalar(CONFIG.physics.fixedDt));
  }

  respawn(position: THREE.Vector3): void {
    this.pos.copy(position);
    this.prevPos.copy(position);
    this.velocity.set(0, 0, 0);
    this.hp = CONFIG.combat.playerMaxHp;
    this.invulnTimer = CONFIG.combat.invulnTime * CONFIG.defeat.invulnScale;
    this.state = PlayerState.Airborne;
    this.endStrike();
  }

  dispose(): void {
    this.rig.dispose();
  }

  // -------------------------------------------------------------- internals

  private integrate(dt: number): void {
    const nx = this.pos.x * 2 - this.prevPos.x + this.acc.x * dt * dt;
    const ny = this.pos.y * 2 - this.prevPos.y + this.acc.y * dt * dt;
    const nz = this.pos.z * 2 - this.prevPos.z + this.acc.z * dt * dt;
    this.prevPos.copy(this.pos);
    this.pos.set(nx, ny, nz);

    // Hard speed ceiling, enforced by clamping the implied velocity.
    this.velocity.copy(this.pos).sub(this.prevPos).divideScalar(dt);
    const s = this.velocity.length();
    if (s > CONFIG.physics.maxSpeed) {
      this.velocity.multiplyScalar(CONFIG.physics.maxSpeed / s);
      this.setVelocity(this.velocity, dt);
    }
  }

  private setVelocity(v: THREE.Vector3, dt: number): void {
    this.prevPos.copy(this.pos).addScaledVector(v, -dt);
  }

  /** Camera-relative move basis. Writes into `this.wish` (y is always 0). */
  private computeWish(ctx: PlayerContext, useForward: boolean): void {
    const fx = -Math.sin(ctx.cameraYaw);
    const fz = -Math.cos(ctx.cameraYaw);
    const rx = Math.cos(ctx.cameraYaw);
    const rz = -Math.sin(ctx.cameraYaw);
    const forward = useForward ? ctx.moveY : 0;
    this.wish.set(rx * ctx.moveX + fx * forward, 0, rz * ctx.moveX + fz * forward);
    const len = this.wish.length();
    if (len > 1) this.wish.divideScalar(len);
  }

  private driveGround(dt: number, ctx: PlayerContext): void {
    this.computeWish(ctx, true);

    // Holding jump on the ground winds up a charge jump; releasing fires it.
    const charging = ctx.chargeHeld && !this.pendingJump;
    if (charging) {
      this.chargeTimer = Math.min(CONFIG.traversal.chargeJumpTime, this.chargeTimer + dt);
    }
    const releasedCharge = this.chargeTimer > 0 && !ctx.chargeHeld;

    const sprinting = ctx.sprintHeld && this.wish.lengthSq() > 0.1 && this.chargeTimer <= 0;
    const speed = sprinting ? CONFIG.traversal.sprintSpeed : CONFIG.move.runSpeed;
    const accel = sprinting ? CONFIG.traversal.sprintAccel : CONFIG.move.runAccel;
    // Winding up roots the player in place.
    const scale = charging ? 0.25 : 1;

    const targetX = this.wish.x * speed * scale;
    const targetZ = this.wish.z * speed * scale;
    const dvx = targetX - this.velocity.x;
    const dvz = targetZ - this.velocity.z;
    const mag = Math.hypot(dvx, dvz);
    if (mag > 1e-4) {
      // Never accelerate past the target within a single step.
      const a = Math.min(accel, mag / dt);
      this.acc.x += (dvx / mag) * a;
      this.acc.z += (dvz / mag) * a;
    }

    if (this.pendingJump || releasedCharge) {
      this.pendingJump = false;
      const chargeFraction = this.chargeTimer / CONFIG.traversal.chargeJumpTime;
      this.velocity.y = lerp(CONFIG.move.jumpSpeed, CONFIG.traversal.chargeJumpSpeed, chargeFraction);
      this.chargeTimer = 0;
      this.setVelocity(this.velocity, dt);
      this.grounded = false;
      this.state = PlayerState.Airborne;
    }
  }

  private driveAir(dt: number, ctx: PlayerContext): void {
    this.computeWish(ctx, true);
    this.acc.addScaledVector(this.wish, CONFIG.move.airSteer);
    this.pendingJump = false;

    // Air tricks: spin while falling well clear of the ground to build Focus.
    const tricking =
      ctx.hasSkill('air_tricks') &&
      this.altitude > CONFIG.traversal.trickMinHeight &&
      this.velocity.y < -6 &&
      !this.gliding;

    if (tricking) {
      this.trickSpin += CONFIG.traversal.trickSpinRate * dt;
      this.addFocus(CONFIG.traversal.trickFocusRate * dt);
    } else {
      this.trickSpin = 0;
    }
  }

  /** Runs straight up a facade, trading horizontal speed for height. */
  private driveWallRun(dt: number, ctx: PlayerContext): void {
    const n = this.wallNormal ?? this.wallRunNormal;
    this.wallRunTimer -= dt;

    // Climb up the wall plane; steer left/right along it.
    const tangentUp = this.scratch.copy(UP).addScaledVector(n, -UP.dot(n));
    if (tangentUp.lengthSq() < 1e-6) tangentUp.set(0, 1, 0);
    tangentUp.normalize();
    this.wish.crossVectors(tangentUp, n).normalize();

    const targetY = tangentUp.y * CONFIG.traversal.wallRunSpeed;
    const dvy = targetY - this.velocity.y;
    if (Math.abs(dvy) > 1e-4) {
      this.acc.y += Math.sign(dvy) * Math.min(CONFIG.traversal.wallRunAccel, Math.abs(dvy) / dt);
    }
    this.acc.addScaledVector(this.wish, ctx.moveX * CONFIG.move.airSteer);
    // Hold onto the surface.
    this.acc.addScaledVector(n, -CONFIG.wall.stickAccel * 0.6);

    if (this.pendingJump) {
      this.pendingJump = false;
      this.velocity
        .copy(n)
        .multiplyScalar(CONFIG.wall.jumpOff)
        .addScaledVector(UP, CONFIG.move.jumpSpeed);
      this.setVelocity(this.velocity, dt);
      this.wallRunTimer = 0;
      this.state = PlayerState.Airborne;
    }
  }

  /** Web wings: forward-biased flight that trades altitude for speed. */
  private driveGlide(dt: number, ctx: PlayerContext): void {
    this.computeWish(ctx, true);

    // Face where the camera looks; pitch controls dive versus climb.
    const fx = -Math.sin(ctx.cameraYaw);
    const fz = -Math.cos(ctx.cameraYaw);
    this.acc.x += fx * CONFIG.traversal.glideForward;
    this.acc.z += fz * CONFIG.traversal.glideForward;
    this.acc.addScaledVector(this.wish, CONFIG.move.airSteer * 0.6);

    // Lift scales with horizontal speed — dive to build it, then climb.
    const horizontal = Math.hypot(this.velocity.x, this.velocity.z);
    this.acc.y += Math.min(CONFIG.traversal.glideLift, horizontal * 0.45);
    if (ctx.moveY < -0.2) this.acc.y -= CONFIG.traversal.glideDiveAccel;

    this.pendingJump = false;
  }

  private stepDodge(dt: number, ctx: PlayerContext): void {
    this.dodgeTimer -= dt;
    this.velocity.copy(this.dodgeDir).multiplyScalar(CONFIG.dodge.speed);
    if (!this.grounded) this.velocity.y = Math.max(this.velocity.y, -2);
    this.setVelocity(this.velocity, dt);
    this.acc.set(0, 0, 0);
    this.integrate(dt);
    this.collide(dt, ctx.city);

    if (this.dodgeTimer <= 0) this.resolveState(ctx);
    else this.state = PlayerState.Dodging;
  }

  /** Drives one melee swing: a short lunge with a damage frame mid-animation. */
  private stepMelee(dt: number, ctx: PlayerContext): void {
    this.attackTimer -= dt;
    const total = CONFIG.combat.meleeDuration;
    this.attackProgress = clamp(1 - this.attackTimer / total, 0, 1);

    // Keep steering at the target while the swing plays, and stop short of it
    // rather than driving through — punching someone should not shove you
    // past them.
    if (this.attackTarget) {
      this.scratch.copy(this.attackTarget).sub(this.pos).setY(0);
      const gap = this.scratch.length();
      if (gap > 0.05) this.attackDir.copy(this.scratch).divideScalar(gap);
      if (gap < CONFIG.combat.meleeStandoff) {
        this.velocity.set(0, this.velocity.y, 0);
        this.setVelocity(this.velocity, dt);
        this.acc.set(0, 0, 0);
        this.integrate(dt);
        this.collide(dt, ctx.city);
        if (!this.attackDealt && this.attackProgress >= CONFIG.combat.meleeHitAt) {
          this.attackDealt = true;
          this.meleeLandedThisFrame = true;
        }
        if (this.attackTimer <= 0) this.resolveState(ctx);
        else this.state = PlayerState.Attacking;
        return;
      }
    }

    // Lunge forward, peaking at the middle of the swing. A swing at empty air
    // barely moves you; a committed one closes the gap.
    const reach = this.attackHasTarget ? CONFIG.combat.meleeLunge : CONFIG.combat.meleeLunge * 0.25;
    const lunge = Math.sin(this.attackProgress * Math.PI) * reach;
    this.velocity.copy(this.attackDir).multiplyScalar(lunge);
    if (!this.grounded) this.velocity.y = clamp(this.velocity.y - CONFIG.physics.gravity * dt, -25, 25);
    this.setVelocity(this.velocity, dt);

    this.acc.set(0, 0, 0);
    this.integrate(dt);
    this.collide(dt, ctx.city);

    // Single damage frame partway through, so hits land on contact not on press.
    if (!this.attackDealt && this.attackProgress >= CONFIG.combat.meleeHitAt) {
      this.attackDealt = true;
      this.meleeLandedThisFrame = true;
    }

    if (this.attackTimer <= 0) this.resolveState(ctx);
    else this.state = PlayerState.Attacking;
  }

  private stepZip(dt: number, ctx: PlayerContext): void {
    this.zipTimer -= dt;
    this.scratch.copy(this.zipTarget).sub(this.pos);
    const distance = this.scratch.length();

    if (distance < CONFIG.traversal.zipArriveRadius || this.zipTimer <= 0) {
      this.zipTimer = 0;
      // Preserve a little of the zip speed on arrival so it flows into a swing.
      this.velocity.multiplyScalar(0.45);
      this.setVelocity(this.velocity, dt);
      this.resolveState(ctx);
      return;
    }

    this.scratch.divideScalar(distance);
    this.velocity.copy(this.scratch).multiplyScalar(CONFIG.traversal.zipSpeed);
    this.setVelocity(this.velocity, dt);
    this.acc.set(0, 0, 0);
    this.integrate(dt);
    this.collide(dt, ctx.city);
    this.state = PlayerState.Zipping;
  }

  /** Distance to the first surface directly below the player. */
  private measureAltitude(city: City): number {
    this.scratch.set(0, -1, 0);
    const hit = city.raycast(this.pos, this.scratch, 400);
    return hit ? hit.distance : this.pos.y;
  }

  private driveSwing(dt: number, ctx: PlayerContext): void {
    // W/S are reel while swinging, so only A/D steer the arc.
    this.computeWish(ctx, false);
    this.acc.addScaledVector(this.wish, CONFIG.move.swingSteer);

    // Reel: dedicated axis (arrows / d-pad) plus W/S.
    const reel = clamp(ctx.reelAxis + ctx.moveY, -1, 1);
    if (reel !== 0) ctx.web.reel(reel * CONFIG.web.reelSpeed * dt);

    // A small pump on the downswing. Not strictly conservative — it is the
    // game-feel knob that keeps long swing chains from bleeding out.
    if (this.velocity.y < 0) {
      const horiz = this.scratch.set(this.velocity.x, 0, this.velocity.z);
      const len = horiz.length();
      if (len > 1) {
        this.acc.addScaledVector(horiz.divideScalar(len), CONFIG.move.swingPump);
      }
    }

    if (this.pendingJump) this.pendingJump = false;
  }

  private driveWall(dt: number, ctx: PlayerContext): void {
    const n = this.wallNormal;
    if (!n) {
      this.state = PlayerState.Airborne;
      return;
    }

    // Build a tangent frame on the wall: "up" is world-up flattened onto it.
    const tangentUp = this.scratch.copy(UP).addScaledVector(n, -UP.dot(n));
    if (tangentUp.lengthSq() < 1e-6) tangentUp.set(0, 0, 1);
    tangentUp.normalize();
    this.wish.crossVectors(tangentUp, n).normalize(); // tangent right

    const targetX = this.wish.x * ctx.moveX + tangentUp.x * ctx.moveY;
    const targetY = this.wish.y * ctx.moveX + tangentUp.y * ctx.moveY;
    const targetZ = this.wish.z * ctx.moveX + tangentUp.z * ctx.moveY;

    const speedScale = CONFIG.wall.climbSpeed;
    const dvx = targetX * speedScale - this.velocity.x;
    const dvy = targetY * speedScale - this.velocity.y;
    const dvz = targetZ * speedScale - this.velocity.z;
    const mag = Math.hypot(dvx, dvy, dvz);
    if (mag > 1e-4) {
      const a = Math.min(CONFIG.wall.climbAccel, mag / dt);
      this.acc.x += (dvx / mag) * a;
      this.acc.y += (dvy / mag) * a;
      this.acc.z += (dvz / mag) * a;
    }

    // Hold on to the surface.
    this.acc.addScaledVector(n, -CONFIG.wall.stickAccel);

    if (this.pendingJump) {
      this.pendingJump = false;
      this.velocity
        .copy(n)
        .multiplyScalar(CONFIG.wall.jumpOff)
        .addScaledVector(UP, CONFIG.move.jumpSpeed * 0.8);
      this.setVelocity(this.velocity, dt);
      this.wallNormal = null;
      this.state = PlayerState.Airborne;
    }
  }

  private stepStrike(dt: number, ctx: PlayerContext): void {
    this.strikeTimer -= dt;
    const target = this.strikeTarget;
    if (!target || !target.alive || this.strikeTimer <= 0) {
      this.endStrike();
      this.state = PlayerState.Airborne;
      return;
    }

    this.strikeDir.copy(target.pos).sub(this.pos);
    const dist = this.strikeDir.length();
    if (dist < 1e-3) {
      this.endStrike();
      return;
    }
    this.strikeDir.divideScalar(dist);

    // Kinematic dash: drive position directly, no gravity, no drag.
    this.velocity.copy(this.strikeDir).multiplyScalar(CONFIG.combat.strikeSpeed);
    this.setVelocity(this.velocity, dt);
    this.acc.set(0, 0, 0);
    this.integrate(dt);
    this.collide(dt, ctx.city);
    this.state = PlayerState.Striking;
  }

  private collide(dt: number, city: City): void {
    const wasGrounded = this.grounded;
    const fallSpeed = -this.velocity.y;
    // Snapshot the velocity *before* contact response cancels it. The wall
    // grab test needs the speed we arrived with, not the zero we leave with.
    this.preContactVel.copy(this.velocity);
    this.wallApproach = 0;
    this.grounded = false;
    let wall: THREE.Vector3 | null = null;
    const radius = CONFIG.physics.playerRadius;

    for (let iter = 0; iter < CONFIG.physics.collisionIterations; iter++) {
      const count = city.collideSphere(this.pos, radius, this.contacts);
      if (count === 0) break;

      for (let i = 0; i < count; i++) {
        const contact = this.contacts[i]!;
        if (contact.depth > 0) this.pos.addScaledVector(contact.normal, contact.depth);

        if (contact.normal.y > 0.6) this.grounded = true;
        else if (Math.abs(contact.normal.y) < CONFIG.wall.maxNormalY && !wall) {
          wall = this.wallStore.copy(contact.normal);
          // Normals point out of the surface, so moving into it is negative.
          this.wallApproach = -this.preContactVel.dot(contact.normal);
        }

        this.applyContactResponse(contact.normal, dt);
      }
    }

    // Wall detection pass. Resolution leaves us at exactly `radius` from the
    // surface, so the same query would miss on float error — probe slightly
    // wider, and only for detection.
    if (!wall) {
      const probe = radius + CONFIG.wall.detectSkin;
      const count = city.collideSphere(this.pos, probe, this.contacts);
      for (let i = 0; i < count; i++) {
        const contact = this.contacts[i]!;
        if (Math.abs(contact.normal.y) >= CONFIG.wall.maxNormalY) continue;
        wall = this.wallStore.copy(contact.normal);
        this.wallApproach = Math.max(this.wallApproach, -this.preContactVel.dot(contact.normal));
        break;
      }
    }

    // Street level.
    if (this.pos.y < radius) {
      this.pos.y = radius;
      this.grounded = true;
      this.applyContactResponse(UP, dt);
    }

    // Coyote time: hold onto the last wall briefly so a single missed probe
    // (a corner, a seam between merged boxes) does not drop you off.
    if (wall) {
      this.wallNormal = wall;
      this.wallCoyote = CONFIG.wall.coyoteTime;
    } else if (this.wallCoyote > 0) {
      this.wallCoyote -= dt;
      // Keep the remembered normal; wallNormal stays as it was.
    } else {
      this.wallNormal = null;
    }

    // Touchdown: record how hard, for the crouch pose and the camera.
    if (this.grounded && !wasGrounded && fallSpeed > 8) {
      const strength = clamp((fallSpeed - 8) / 38, 0, 1);
      this.landImpact = Math.max(this.landImpact, strength);
      if (strength > 0.35) this.landedHardThisFrame = true;
    }
  }

  /** Cancels velocity into a surface and bleeds tangential speed on contact. */
  private applyContactResponse(normal: THREE.Vector3, dt: number): void {
    this.velocity.copy(this.pos).sub(this.prevPos).divideScalar(dt);
    const vn = this.velocity.dot(normal);
    if (vn < 0) {
      this.velocity.addScaledVector(normal, -vn * (1 + CONFIG.physics.restitution));
    }
    if (normal.y > 0.6) {
      // Tangential retention is expressed per second, so the result is
      // independent of the substep rate.
      const retain = Math.pow(CONFIG.physics.groundFriction, dt);
      const along = this.velocity.dot(normal);
      this.scratch.copy(this.velocity).addScaledVector(normal, -along);
      this.velocity.copy(normal).multiplyScalar(along).addScaledVector(this.scratch, retain);
    }
    this.setVelocity(this.velocity, dt);
  }

  private resolveState(ctx: PlayerContext): void {
    if (this.strikeTimer > 0) {
      this.state = PlayerState.Striking;
      return;
    }
    if (this.dodgeTimer > 0) {
      this.state = PlayerState.Dodging;
      return;
    }
    if (this.attackTimer > 0) {
      this.state = PlayerState.Attacking;
      return;
    }
    if (this.zipTimer > 0) {
      this.state = PlayerState.Zipping;
      return;
    }
    if (ctx.web.attached) {
      this.state = PlayerState.Swinging;
      this.gliding = false;
      return;
    }

    // --- walls are automatic ---------------------------------------------
    // Touching a facade grabs it. Holding the release key drops you instead.
    //
    // The approach test matters: without it, merely *grazing* a tower while
    // arcing past would snap you onto it and kill the swing. You have to be
    // travelling into the surface, not sliding along it.
    const alreadyOnWall =
      this.state === PlayerState.WallCrawl || this.state === PlayerState.WallRun;
    const wallAvailable =
      this.wallNormal !== null &&
      !ctx.releaseWall &&
      (this.wallApproach > CONFIG.wall.minApproachSpeed || alreadyOnWall);
    // Wall-run entry uses the arrival speed too, for the same reason.
    const horizontalSpeed = alreadyOnWall
      ? Math.hypot(this.velocity.x, this.velocity.z)
      : Math.hypot(this.preContactVel.x, this.preContactVel.z);

    // Continue an in-progress wall run.
    if (this.wallRunTimer > 0 && wallAvailable && !this.grounded) {
      this.wallRunNormal.copy(this.wallNormal!);
      this.state = PlayerState.WallRun;
      return;
    }

    // Arriving at a wall with speed converts that speed into a run up it.
    if (
      wallAvailable &&
      horizontalSpeed > CONFIG.traversal.wallRunEntrySpeed &&
      this.preContactVel.y > -CONFIG.traversal.wallRunMaxFallSpeed
    ) {
      this.wallRunTimer = CONFIG.traversal.wallRunMaxTime;
      this.wallRunNormal.copy(this.wallNormal!);
      this.grounded = false;
      this.state = PlayerState.WallRun;
      return;
    }

    // Otherwise stick and crawl — but only in the air, so running alongside a
    // wall on a rooftop doesn't peel you off the floor.
    if (wallAvailable && !this.grounded) {
      this.state = PlayerState.WallCrawl;
      this.gliding = false;
      return;
    }

    if (this.grounded) {
      this.gliding = false;
      this.wallRunTimer = 0;
      if (this.chargeTimer > 0) {
        this.state = PlayerState.Charging;
      } else if (ctx.sprintHeld && Math.hypot(this.velocity.x, this.velocity.z) > 9) {
        this.state = PlayerState.Sprinting;
      } else {
        this.state = PlayerState.Running;
      }
      return;
    }

    // Airborne: gliding takes priority, then tricking, then plain freefall.
    if (
      this.gliding &&
      ctx.glideHeld &&
      ctx.hasSkill('web_wings') &&
      this.altitude > CONFIG.traversal.glideMinHeight
    ) {
      this.state = PlayerState.Gliding;
      return;
    }
    this.gliding = this.gliding && ctx.glideHeld;
    this.state = this.trickSpin > 0.4 ? PlayerState.Trick : PlayerState.Airborne;
  }
}

/** Convenience for callers that want a 0..1 health fraction. */
export function healthFraction(player: Player): number {
  return clamp(player.hp / CONFIG.combat.playerMaxHp, 0, 1);
}

/** Convenience for callers that want a 0..1 special-meter fraction. */
export function specialFraction(player: Player): number {
  return clamp(player.special / CONFIG.combat.specialMax, 0, 1);
}

/** Convenience for callers that want a 0..1 focus fraction. */
export function focusFraction(player: Player): number {
  return clamp(player.focus / CONFIG.focus.max, 0, 1);
}

export { PlayerState };
