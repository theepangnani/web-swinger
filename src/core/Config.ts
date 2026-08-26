/**
 * Central tuning table. Everything gameplay-relevant lives here so the feel of
 * the game can be dialled in from one file.
 *
 * Units: metres, seconds, radians. Gravity is deliberately above real-world
 * 9.81 — at city scale a realistic constant reads as floaty.
 */
export const CONFIG = {
  city: {
    /**
     * 28 x 28 city blocks (~1.7 km across). Chunked frustum culling is what
     * makes a map this size affordable — see City.buildChunkedMeshes.
     */
    grid: 28,
    /** Block pitch: building footprint + surrounding street. */
    blockPitch: 62,
    streetWidth: 22,
    minHeight: 30,
    maxHeight: 240,
    /** Chance a block is left as an open plaza instead of a tower. */
    plazaChance: 0.06,
    /** Chance a block is split into two slimmer towers. */
    splitChance: 0.22,
    seed: 20260811,
    /** Facade texture tiling — one texture tile covers this many windows. */
    windowsPerTileX: 8,
    windowsPerTileY: 8,
    windowSpacingX: 4.2,
    floorHeight: 3.9,
    facadeVariants: 4,

    /**
     * Vertical exaggeration applied to imported OpenStreetMap buildings.
     *
     * Queens is genuinely low-rise: most of the import is two- and
     * three-storey houses, and at true scale there is simply nothing to swing
     * from — the traversal the whole game is built on stops working and the
     * city reads as a model village. These stretch the real footprints into a
     * skyline you can actually move through while keeping every street, block
     * and landmark exactly where it is.
     */
    osm: {
      /** Multiplier on the surveyed height. */
      heightScale: 2.1,
      /** Nothing shorter than this, before jitter — one swing-arc of facade. */
      minHeight: 26,
      /**
       * Randomised span around minHeight, so the low-rise is not a flat slab.
       * Kept modest: at 0.55 the bottom of the range fell to 12 m, which put
       * the floor back below anything worth swinging from and defeated the
       * point of having one.
       */
      minHeightJitter: 0.28,
      /** Absolute ceiling, so a mis-tagged spire does not become a space lift. */
      maxHeight: 320,
      /** Footprints grow a little too, so more roofs are worth landing on. */
      footprintScale: 1.16,
      minFootprint: 13,

      /**
       * Street trees. The procedural city planted these in its parks, but the
       * import had no equivalent pass, so switching to the real street layout
       * quietly stripped every tree out of the game.
       */
      treePitch: 26,
      treeChance: 0.45,
      /** Only plant within this of a building — sidewalks, not open ground. */
      treeNearBuilding: 26,
      /** Instanced, but still worth a ceiling on a 27 km² map. */
      maxTrees: 5200,
    },
  },

  /**
   * First-frame lighting only. DayNight overwrites every one of these values
   * on its first update, so they exist to stop the frame behind the boot
   * overlay flashing dark — which means they should stay roughly in step with
   * the dusk keyframe rather than drifting off on their own.
   */
  render: {
    skyColor: 0x2b3d5e,
    fogColor: 0x374a6a,
    /** Thinner than before so the expanded skyline actually reads as open. */
    fogDensity: 0.0006,
    sunColor: 0xffe6c4,
    sunIntensity: 1.8,
    hemiSky: 0x6f96cc,
    hemiGround: 0x262c3a,
    hemiIntensity: 1.36,
    /**
     * Shadow cost scales with map area *and* with how much geometry falls in
     * the frustum. A tighter radius keeps far towers out of the shadow pass
     * entirely, which matters far more than the map resolution.
     */
    shadowMapSize: 1024,
    /** Half-width of the sun's shadow frustum, which follows the player. */
    shadowRadius: 95,
    /**
     * 2x on a high-DPI display means 4x the fragments. The scene is
     * fragment-bound, so this is the single biggest performance dial.
     */
    maxPixelRatio: 1.5,
  },

  physics: {
    /** Fixed simulation step. Verlet + constraints need a constant dt. */
    fixedDt: 1 / 120,
    maxSubSteps: 8,
    gravity: 26,
    /** Kilograms — only used to report tension in newtons on the HUD. */
    mass: 80,
    /** Quadratic drag coefficient: a = -k * |v| * v. */
    airDrag: 0.0016,
    maxSpeed: 170,
    playerRadius: 0.62,
    /**
     * Tangential velocity retained per *second* of ground contact. Applied as
     * pow(f, dt) so the result is independent of the substep rate.
     */
    groundFriction: 0.35,
    restitution: 0.04,
    /** Solver passes for collision push-out each substep. */
    collisionIterations: 3,
  },

  move: {
    runSpeed: 13,
    runAccel: 85,
    jumpSpeed: 15.5,
    /** Lateral acceleration available while airborne. */
    airSteer: 26,
    /** Lateral acceleration available while swinging (arc steering). */
    swingSteer: 24,
    /** Extra forward push when holding into the swing on the downstroke. */
    swingPump: 9,
    /**
     * Vertical kick when you let go of a line.
     *
     * This was 2.5 — against a 15.5 jump speed, which meant letting go did
     * nothing at all and every swing ended in a drop. Releasing a line is
     * supposed to be a launch, so it now reads as a jump on its own and gains
     * more the faster the arc was travelling.
     */
    releaseBoost: 9,
    /** Extra lift per m/s of swing speed at the moment of release. */
    releaseBoostPerSpeed: 0.28,
    /** Ceiling on that bonus, so a very fast arc is strong, not silly. */
    releaseBoostMax: 11,
  },

  web: {
    minLength: 8,
    maxLength: 150,
    reelSpeed: 28,
    /** 1 = perfectly rigid line, < 1 = elastic. */
    stiffness: 0.9,
    /** Constraint relaxation passes per substep. */
    iterations: 2,
    /**
     * Hard ceiling on how far the constraint may move the player in one
     * substep, in metres.
     *
     * In Verlet a positional correction *is* a velocity change, so resolving a
     * large violation in a single step launches the player. Violations build
     * up whenever a state skips the solver (dodge, melee, a teleport), and
     * spreading the correction over several substeps removes that entire class
     * of bug rather than patching each cause.
     */
    maxCorrectionPerStep: 0.35,
    /**
     * How far the aim ray searches. Must not exceed maxLength, or the line
     * would attach already over-extended and snap the player violently.
     */
    castDistance: 148,
    /** Angular spread of the auto-aim fan, radians. Generous on purpose. */
    aimSpread: 0.5,
    /** Aim is tilted up by this much so a level camera still finds rooftops. */
    aimUpBias: 0.26,
    /**
     * How far *below* the player an anchor may sit and still be accepted.
     *
     * Requiring anchors to be strictly overhead sounds right but plays badly:
     * at rooftop height, or at the apex of an arc, there is often nothing
     * above you at all and the shot simply fails. Attaching slightly below
     * still works — you fall past the anchor and the line goes taut into a
     * swing, which is what actually happens on a real web line.
     */
    minAnchorRise: -20,
    /** Anchors above the player are still strongly preferred when scoring. */
    riseBonus: 1.35,
    /**
     * Anchors closer than this are rejected. Without it you can latch onto the
     * facade you are already clinging to, which does nothing useful and looks
     * broken.
     */
    minAnchorDistance: 9,
    /** Rings in the auto-aim fan, and samples per ring. */
    aimRings: 4,
    aimSamplesPerRing: 8,
    /** Hit points within this radius of a roof corner snap to that corner. */
    cornerSnapRadius: 7,
    /** If no facade is hit, anchor to an invisible sky point instead. */
    allowSkyAnchor: false,
    /** Verlet rope visual. */
    ropeSegments: 22,
    ropeRadius: 0.075,
    ropeGlowRadius: 0.24,
    /**
     * Width of the billboarded web ribbon, metres. Substantially thicker than
     * a rope: a thin line at 60 m reads as thread, which is what made it look
     * flimsy however the strands were arranged.
     */
    ribbonWidth: 0.85,
    /** Pattern repeats per metre, so the weave stays a constant size. */
    ribbonTilesPerMetre: 0.16,
    /**
     * Gravity on the rope's visual chain, m/s^2. Only meaningful while the
     * line is slack — a taut web is a structural member under load, and any
     * visible droop reads as string rather than silk.
     */
    ropeSag: 26,
    /** Relaxation passes for the slack case. */
    ropeIterations: 10,
    /**
     * Below this slack fraction the line is drawn dead straight with no
     * simulation. Most of swinging happens under tension, so this is the
     * common case.
     */
    slackThreshold: 0.06,
  },

  wall: {
    /** Surface normal must be this horizontal to be climbable (|n.y| below). */
    maxNormalY: 0.45,
    /** Distance a probe ray looks ahead for a climbable wall. */
    probeDistance: 1.6,
    stickAccel: 34,
    climbSpeed: 9.5,
    climbAccel: 90,
    /** Velocity added along the surface normal when jumping off a wall. */
    jumpOff: 13,
    /**
     * Speed *into* a wall required to grab it automatically. Prevents a
     * glancing brush mid-swing from snapping you onto the facade.
     */
    minApproachSpeed: 2.5,
    /**
     * Extra radius used only to *detect* a wall, never to push out of one.
     * Collision resolution leaves the sphere at exactly `playerRadius` from
     * the surface, so a plain re-test fails on float error and you fall off.
     */
    detectSkin: 0.12,
    /**
     * Grace period after losing wall contact before you actually let go.
     * Covers a substep where the probe misses across a corner or seam.
     */
    coyoteTime: 0.18,
  },

  camera: {
    distance: 12.5,
    minDistance: 3.2,
    height: 2.6,
    fovBase: 62,
    fovMax: 97,
    /** Speed (m/s) at which FOV reaches fovMax. */
    fovSpeedRef: 95,
    /** Exponential smoothing rates. */
    positionLambda: 8.5,
    lookLambda: 13,
    fovLambda: 4.5,
    /** Extra trailing distance proportional to speed. */
    speedPullback: 0.055,
    /** How far ahead of the player the camera looks, per m/s. */
    lookAhead: 0.16,
    /** Roll into the swing, radians at full lateral acceleration. */
    maxRoll: 0.16,
    pitchMin: -1.15,
    pitchMax: 1.0,
    mouseSensitivity: 0.0022,
    stickSensitivity: 2.6,
    near: 0.25,
    far: 3000,
  },

  combat: {
    /** Web-strike dash. */
    strikeRange: 48,
    /** Cosine of the half-angle the target must be inside to strike. */
    strikeConeCos: Math.cos(0.36),
    strikeSpeed: 78,
    strikeDamage: 34,
    strikeCooldown: 0.55,
    /** Ground melee: a three-hit combo. */
    meleeRange: 4.2,
    meleeDamage: 26,
    meleeDuration: 0.34,
    /** Fraction through the swing at which damage lands. */
    meleeHitAt: 0.45,
    /** Window after a hit in which the next attack continues the combo. */
    meleeChainWindow: 0.7,
    meleeLunge: 9,
    /** Distance the lunge stops short at, so you punch rather than barge. */
    meleeStandoff: 2.2,
    /** Gadget throw animation length. */
    throwDuration: 0.3,
    /** Distance at which the dash connects. */
    strikeHitRadius: 3.2,
    /** Safety timeout so a dash can never strand the player. */
    strikeMaxTime: 1.4,
    playerMaxHp: 100,
    /** Seconds of invulnerability after taking a hit. */
    invulnTime: 0.7,
    comboWindow: 3.5,
    /** Seconds without taking damage before health starts coming back. */
    regenDelay: 7,
    /** Health per second once regeneration kicks in. */
    regenRate: 5,
    /** Special meter, 0..100. */
    specialMax: 100,
    specialRegenPerSecond: 2.2,
    specialPerHit: 14,
    abilityDuration: 7,
  },

  enemies: {
    /**
     * Once a boss engages, it is confined to a sphere around where the fight
     * started, so a fleeing villain stays reachable instead of crossing the
     * whole map.
     */
    arena: {
      /**
       * Hard wall on the villain, measured from the arena centre.
       *
       * At 118 a ground boss could put most of a city block between you and
       * them and the fight became a commute. 75 is close enough that they are
       * always in sight and always closing.
       */
      radius: 75,
      /**
       * Fliers get a wider ring. Green Goblin's whole fight is an orbit, and
       * a 75 m tether would leave him permanently in your face with nowhere
       * to dive from.
       */
      flierRadius: 150,
      /** Distance at which a fight is considered joined. */
      engageDistance: 70,
      /** Fight ends and the arena clears if the player leaves this far. */
      disengageDistance: 190,
      /**
       * The player is confined too, not just the villain. A fight you can
       * simply swing away from is not a fight.
       */
      playerRadius: 132,
      /** How hard the boundary pushes back, m/s^2. */
      pushback: 90,
      /** Webs are disabled inside an active arena: stand and fight. */
      blockWebs: true,
    },
    /**
     * Poise: how a boss answers being stood next to and punched forever.
     *
     * Electro hovers on a fixed orbit around his rooftop and never reacts to
     * where the player is, so once you reached him you could hold the attack
     * button until he died. Venom and Sandman had the same hole between
     * attacks. Taking a burst of hits now triggers a telegraphed shove that
     * knocks the player off and relocates the boss, which turns "stand and
     * spam" into "hit, disengage, close again".
     */
    poise: {
      /** Hits inside `window` that trigger a retaliation. */
      hits: 3,
      window: 4,
      /** Wind-up before the shove, so it can be read and dodged. */
      telegraph: 0.42,
      /** Length of the relocation that follows. */
      recover: 1.1,
      knockback: 36,
      damage: 15,
      /** Damage taken while retaliating — resisted, not immune. */
      guardScale: 0.35,
      /** Minimum gap between retaliations. */
      cooldown: 3.2,
      /** How far from the player they relocate to. */
      repositionRange: 40,
      /**
       * Bosses also relocate on a timer, not only when punished.
       *
       * Poise alone is reactive: a player who lands three hits, backs off and
       * comes round the other side never triggers it, so a patient fight still
       * degenerated into standing in one place. This keeps them circling the
       * ring whatever the player does.
       */
      driftInterval: 7,
      driftIntervalJitter: 3,
    },
    /** Shared close-quarters attack used by every melee-capable villain. */
    melee: {
      range: 4.6,
      telegraph: 0.5,
      recover: 0.55,
      cooldown: 1.5,
      lunge: 7,
    },
    venom: {
      // Boss health was tuned against a player with no melee combo, no
      // gadgets and no finisher. All three exist now, so they fell over.
      // Raised again once allies, team-ups and a 40-chapter campaign meant a
      // late-game player arrives with most of the skill tree unlocked.
      hp: 1240,
      aggroRange: 40,
      /** Claw swipe damage at close range. */
      meleeDamage: 26,
      /** Ranged symbiote splat. */
      splatRange: 55,
      splatCooldown: 3.4,
      splatDamage: 15,
      splatSpeed: 42,
      /** Tendril lash — long reach, heavy pull. */
      whipRange: 18,
      whipDamage: 18,
      whipCooldown: 4,
      /** Wind-up before a leap. */
      windup: 0.55,
      leapSpeed: 40,
      leapCooldown: 2.8,
      contactRadius: 3.4,
      damage: 18,
      knockback: 26,
    },
    blackCat: {
      hp: 640,
      /** She turns and fights when cornered rather than only fleeing. */
      meleeDamage: 14,
      /** Below this distance she stops running and attacks. */
      engageRange: 9,
      fleeRange: 58,
      speed: 24,
      /**
       * She cannot sprint indefinitely.
       *
       * A pursuit against a target with unlimited stamina and a top speed near
       * the player's is not a chase, it is a treadmill — there is no state in
       * which closing is possible. Running her out of breath creates the
       * window the encounter is actually built around.
       */
      sprintDuration: 5.5,
      windedDuration: 3,
      /** Speed while winded — slow enough to be caught, not a full stop. */
      windedSpeed: 4,
      /** Stamina recovered per second while not fleeing. */
      recoveryRate: 0.75,
      /** Damage multiplier while she is doubled over. */
      windedDamageScale: 1.6,
      /** Tallest ledge she can step onto. Anything higher is a wall. */
      maxStepUp: 3.5,
      /** Hard cap on vertical speed, m/s. Stops any hint of wall-phasing. */
      maxClimbSpeed: 9,
      /** How close the player must get to land a tag. */
      tagRange: 8,
      /** Seconds between choosing a new rooftop to run to. */
      repathTime: 2.2,
      jumpArc: 14,
    },
    goblin: {
      hp: 1320,
      /** Height above the rooftops he is flying over that he cruises at. */
      hoverHeight: 28,
      /**
       * Hard ceiling above the player once engaged. Without it his altitude
       * keyed off the player's, so climbing toward him pushed him higher and
       * he could never be caught.
       */
      maxRise: 26,
      /**
       * Floor on that ceiling. Without it, a player in the street pulls his
       * target altitude below the rooftops he is flying over and he steers
       * into a tower.
       */
      minClearance: 10,
      /** Radius of the orbit he flies around the player. */
      orbitRadius: 36,
      speed: 20,
      engageRange: 120,
      bombCooldown: 2.4,
      bombDamage: 26,
      /** Launch speed of a lobbed pumpkin bomb. */
      bombSpeed: 30,
      /** Blast radius on detonation. */
      bombRadius: 10,
      bombLife: 6,
      /** Seconds between strafing dives. */
      diveCooldown: 7,
      diveSpeed: 46,
      diveDamage: 20,
      /** Glider blade swipe when the player closes on him. */
      meleeDamage: 18,
    },
    electro: {
      hp: 1080,
      zoneRange: 95,
      hoverHeight: 22,
      bobAmplitude: 1.6,
      boltCooldown: 1.7,
      boltDamage: 11,
      /** Bolt visual lifetime. */
      boltLife: 0.18,
      driftSpeed: 5,
      /** Close-range discharge when the player reaches him. */
      meleeDamage: 16,
      /** Chained arc that forks to nearby surfaces. */
      chainCooldown: 5,
      chainDamage: 20,
      chainRange: 32,
    },
    sandman: {
      hp: 2600,
      /**
       * He is a building that walks.
       *
       * At human scale he read as a lumpy man rather than as Sandman, and the
       * fight was the same stand-and-swing as everyone else's. Four and a bit
       * times human height makes him a piece of terrain: you fight the arms
       * because the arms are all that can reach you, and you have to climb or
       * swing to reach anything that matters.
       */
      baseScale: 4.3,
      /** Ponderous but relentless — he never stops walking toward you. */
      speed: 9,
      accel: 22,
      engageRange: 130,
      /** Oversized fist: the widest melee reach of any villain. */
      meleeDamage: 34,
      meleeRange: 22,

      /**
       * The head is the weak point, and everything below it is loose sand.
       *
       * This is what stops a giant from being a bigger punching bag: hitting
       * his legs achieves almost nothing, so the fight becomes getting *up* to
       * the head — which is the traversal the rest of the game teaches.
       *
       * `headHeight` is in model-local units, before `baseScale`.
       */
      headHeight: 3.05,
      headRadius: 1.15,
      headDamageScale: 3.2,
      /**
       * Not lower than this. Punching his legs *should* be the wrong answer,
       * but a player who cannot get up to the head yet still has to be able
       * to make progress — at 0.28 the body route was three hundred hits,
       * which is not a penalty, it is a wall.
       */
      bodyDamageScale: 0.45,
      /** Shotgun cone of hardened grit at mid range. */
      shardRange: 46,
      shardCooldown: 3,
      shardDamage: 9,
      shardSpeed: 55,
      /** Number of shards per burst. */
      shardCount: 5,
      shardSpread: 0.16,
      /**
       * Sand column: erupts from the ground under the player after a wind-up.
       * The wind-up is the whole counterplay — move and it misses.
       */
      pillarRange: 70,
      pillarCooldown: 6.5,
      pillarWindup: 1.1,
      pillarDamage: 30,
      pillarRadius: 6,
      /**
       * Below this HP fraction he collapses into a loose drift, taking half
       * damage until he reforms. Stops the fight being a pure damage race.
       */
      collapseAt: 0.4,
      collapseDuration: 3.5,
      collapseDamageScale: 0.5,
      /** Grows with each phase, so his silhouette tracks the fight. */
      maxScale: 1.45,
      /** Per-collapse growth factor, applied on top of `baseScale`. */
      reformGrowth: 1.16,
    },
    symbiote: {
      /** Peter, poisoned. He fights the way the player does, which is the point. */
      hp: 1560,
      speed: 17,
      accel: 60,
      engageRange: 150,
      meleeDamage: 24,
      /** Web-strike dash — his signature, lifted straight from the player. */
      dashRange: 52,
      dashSpeed: 62,
      dashCooldown: 4.5,
      dashDamage: 30,
      dashWindup: 0.55,
      /** Web pull: yanks the player into melee range. */
      pullRange: 40,
      pullCooldown: 5.5,
      pullDamage: 12,
      pullStrength: 34,
      /** Symbiote screech: a radial shockwave when cornered. */
      screechRange: 14,
      screechCooldown: 9,
      screechDamage: 26,
      /** He heals off the symbiote between exchanges. */
      regenPerSecond: 5,
      regenDelay: 6,
    },
  },

  /**
   * The other Spider-Man, fighting alongside you in the chapters that call
   * for it. Deliberately weaker than the player: an ally that out-damages you
   * turns your own boss fight into a spectator sport.
   */
  ally: {
    maxHp: 220,
    /** Where they try to sit relative to you when nothing is happening. */
    followDistance: 11,
    followHeight: 1.4,
    /** Movement is kinematic — they are a companion, not a physics body. */
    speed: 26,
    accel: 42,
    /**
     * They break off to engage anything inside this radius of themselves.
     *
     * Was 75 with a 120 leash, which sounds generous and was not: a boss
     * arena is anchored on a rooftop up to 130 m from where you engage it, so
     * the partner routinely could not legally see the fight you were in.
     */
    engageRange: 115,
    /** Leash: past this from the player they abandon the fight and catch up. */
    leashRange: 175,
    attackRange: 5.2,
    attackCooldown: 1.1,
    /** Telegraph before their swing lands. */
    attackTelegraph: 0.3,
    damage: 30,
    /** Chance per attack of a heavier finisher swing. */
    heavyChance: 0.22,
    heavyScale: 2.2,
    /** Downed rather than killed: they get back up on their own. */
    downedDuration: 12,
    /** Health per second while not recently hit. */
    regenPerSecond: 7,
    regenDelay: 5,
    /** Seconds between ally banter lines. */
    bantorCooldown: 18,

    /**
     * Web-swing traverse.
     *
     * Without this the partner can only walk, and walking cannot climb a
     * facade — so they never reached a single boss fight, because every boss
     * spawns on a roof. They arc to their destination instead, posed on a
     * line, which is both how they would actually get there and the only way
     * a companion keeps up with a player moving at 60 m/s.
     */
    travelSpeed: 52,
    /** Horizontal gap that triggers a swing rather than a run. */
    travelDistance: 26,
    /** Height difference that triggers one regardless of distance. */
    travelRise: 5,
    /** Apex height above the higher endpoint, metres. */
    travelArc: 16,
    travelMinTime: 0.45,
    travelMaxTime: 2.4,
    /** Gap between traverses, so they do not chain-swing on the spot. */
    travelCooldown: 0.35,
    /** Frames of being wall-blocked before they give up and swing over it. */
    blockedBeforeTravel: 0.5,

    /**
     * Signature ability, fired on their own judgement.
     *
     * A partner who only throws the same jab is scenery. This is the thing
     * that makes them read as Miles or as Peter rather than as a second body:
     * Miles discharges a venom blast that stuns everything around him, Peter
     * yanks a target off its feet and cocoons it. Both are worth roughly four
     * ordinary swings, which is enough to notice in a boss fight without
     * turning it into a spectator sport.
     */
    abilityCooldown: 9,
    /** They will not fire it from further out than this. */
    abilityRange: 24,
    abilityDamage: 105,
    /** Miles' blast catches everything inside this of the target. */
    abilityRadius: 13,
    /** Peter's cocoon, and Miles' stun, in seconds. */
    abilityStun: 2.4,
    /**
     * Bosses resist it. At full duration Peter's cocoon froze a boss for 3.6
     * of every 9 seconds — nearly half the fight spent watching a statue,
     * which is the opposite of the partner making the fight better.
     */
    abilityBossStunScale: 0.3,
    /** Wind-up, so it reads as a deliberate move rather than a damage tick. */
    abilityTelegraph: 0.45,
  },

  /**
   * Day/night cycle. Time is stored 0..1 where 0 is midnight, 0.5 is noon.
   *
   * The city's window textures are emissive, so the interesting work here is
   * balancing the sun against them: at noon the windows should be lost in the
   * glare, at night they should be the only thing lighting the streets.
   */
  dayNight: {
    enabled: true,
    /** Real seconds for one full 24-hour cycle. */
    cycleSeconds: 480,
    /** Story mode starts here (dusk) unless a chapter pins the time. */
    startTime: 0.78,
    /** Free roam starts at mid-morning. */
    freeRoamStart: 0.36,
    /** How fast the sky/fog/light lerp when a chapter pins a new time. */
    pinLambda: 0.35,
    /**
     * How close the eased clock has to get before the pin is released and the
     * cycle takes over. 0.004 of a day is about six minutes — near enough that
     * the snap is invisible, far enough that the ease actually terminates.
     */
    pinArrival: 0.004,
  },

  fx: {
    /** Speed at which speed lines reach full strength. */
    speedLineRef: 62,
    speedLineMax: 0.9,
  },

  input: {
    gamepadDeadzone: 0.18,
    gamepadTriggerThreshold: 0.4,
  },

  voice: {
    /** Barks start enabled; M toggles them at runtime. */
    enabled: true,
    /** Minimum gap between any two lines, seconds. */
    globalCooldown: 2.2,
    rate: 1.02,
    volume: 0.9,
    subtitleSeconds: 3.4,
    /** Speed (m/s) that triggers the high-speed bark. */
    highSpeedThreshold: 78,
    /** Downward speed (m/s) that counts as a scary fall. */
    bigFallSpeed: 52,
    /** Impact speed (m/s) above which a landing is "hard". */
    hardLandingSpeed: 34,
    /** Health fraction below which the low-health bark can fire. */
    lowHealthFraction: 0.3,
    /** Seconds of uneventful play before an idle line. */
    idleSeconds: 26,
    /** Consecutive swings that count as a chain. */
    chainLength: 4,
  },

  /**
   * Scripted dialogue. See `src/game/Story.ts`.
   *
   * The pacing numbers here exist to stop the story from becoming noise: the
   * radio only speaks into genuine calm, dispatch only calls in some of the
   * crimes, and every line buys a little silence after itself so a bark cannot
   * land on top of a written one.
   */
  story: {
    enabled: true,
    /** Seconds of uninterrupted calm before the radio says something. */
    ambientInterval: 95,
    /** Fraction of newly staged crimes that get a dispatch callout. */
    dispatchChance: 0.45,
    /** Minimum gap between two dispatch callouts, seconds. */
    dispatchCooldown: 40,
    /** Extra seconds a scripted line holds the bark channel after it ends. */
    lineTail: 0.6,
  },

  traversal: {
    /** Releasing the web within this window after the arc's apex launches. */
    pointLaunchWindow: 0.4,
    pointLaunchBoost: 19,
    /** Minimum upward velocity for a release to count as an apex launch. */
    pointLaunchMinRise: 2,

    zipSpeed: 64,
    zipMaxDistance: 95,
    zipArriveRadius: 3.4,

    wallRunSpeed: 19,
    wallRunAccel: 95,
    wallRunMaxTime: 2.3,
    /** Reduced gravity while running a wall, m/s^2. */
    wallRunGravity: 5,
    /** Minimum horizontal speed needed to start a wall run. */
    wallRunEntrySpeed: 9,
    /** Falling faster than this means you cling rather than run upward. */
    wallRunMaxFallSpeed: 26,

    chargeJumpTime: 0.9,
    chargeJumpSpeed: 36,

    glideForward: 30,
    glideLift: 15,
    glideDiveAccel: 34,
    glideMinHeight: 6,
    glideDrag: 0.0032,

    sprintSpeed: 22,
    sprintAccel: 110,

    /** Focus earned per second of airborne tricking. */
    trickFocusRate: 22,
    /** Must be at least this high above the ground to trick. */
    trickMinHeight: 16,
    trickSpinRate: 8,
  },

  focus: {
    max: 100,
    perHit: 9,
    perDodge: 7,
    perTrick: 1,
    /** Health restored by spending a full bar. */
    healAmount: 45,
    finisherDamage: 130,
    finisherRadius: 7,
  },

  dodge: {
    speed: 24,
    duration: 0.28,
    cooldown: 0.45,
    /** Invulnerability granted by any dodge. */
    iframes: 0.3,
    /** Dodging inside this window before impact is a "perfect" dodge. */
    perfectWindow: 0.25,
    /** Range at which spider-sense warns of an incoming attack. */
    senseRange: 26,
  },

  gadgets: {
    impactWeb: { damage: 20, cooldown: 1.6, ammo: 8, speed: 72, knockback: 34 },
    webBomb: { damage: 24, cooldown: 5.5, ammo: 4, speed: 52, radius: 13 },
    tripMine: { damage: 44, cooldown: 3.5, ammo: 5, speed: 84, tetherRange: 18 },
    concussive: { damage: 30, cooldown: 4, ammo: 5, speed: 60, radius: 10, knockback: 42 },
    electricWeb: { damage: 34, cooldown: 6.5, ammo: 3, speed: 62, radius: 11, stun: 7 },
    grabber: { damage: 12, cooldown: 5, ammo: 4, speed: 70, radius: 14, pull: 26 },
    /** Seconds an enemy stays webbed up. */
    webbedDuration: 4.5,
  },

  thugs: {
    hp: 46,
    speed: 7.5,
    accel: 34,
    attackRange: 2.8,
    attackCooldown: 1.9,
    damage: 7,
    /** Telegraph time before a swing lands — the dodge window. */
    telegraph: 0.55,
    aggroRange: 45,
    brute: { hpScale: 3.2, damageScale: 2.1, speedScale: 0.78, sizeScale: 1.35 },
    ranged: { hpScale: 0.8, range: 42, cooldown: 2.6, damage: 6, projectileSpeed: 58 },
  },

  crimes: {
    maxActive: 3,
    spawnInterval: 20,
    /** Gap before retrying after a spawn found nowhere suitable. */
    retryInterval: 2.5,
    /**
     * Narrow-side roof width that makes a good arena. Preferred, not required
     * — outside Manhattan most roofs are smaller than this, and demanding one
     * meant crimes stopped spawning at all.
     */
    preferredRoofWidth: 24,
    spawnRadiusMin: 130,
    spawnRadiusMax: 340,
    /** How close the player must be for a crime to activate. */
    engageRadius: 70,
    /** Crime fails if the player leaves for this long. */
    abandonTime: 30,
    minThugs: 3,
    maxThugs: 6,
    /** Crimes that must be cleared before the next villain surfaces. */
    crimesPerVillain: 2,
  },

  progression: {
    maxLevel: 30,
    /** XP needed for level 2; each level costs `curve` times the previous. */
    baseXp: 420,
    curve: 1.22,
    skillPointsPerLevel: 1,
    xp: {
      thug: 28,
      villain: 450,
      crime: 165,
      backpack: 70,
      trick: 4,
      finisher: 40,
    },
  },

  collectibles: {
    backpackCount: 26,
    pickupRadius: 4.5,
  },

  character: {
    /**
     * Optional glTF/GLB character. If a file exists here it replaces the
     * procedural rig entirely, with real skinned animation. Absent by
     * default — see public/models/README.md.
     */
    modelUrl: './models/player.glb',
  },

  markers: {
    /** Objective markers fade out past this distance. */
    maxDistance: 900,
    edgePadding: 54,
  },
} as const;

export type Config = typeof CONFIG;
