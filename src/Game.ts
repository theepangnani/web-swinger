import * as THREE from 'three';
import { CONFIG } from './core/Config';
import { Input } from './core/Input';
import { clamp, mulberry32 } from './core/MathUtils';
import { ChaseCamera } from './Camera';
import { City } from './world/City';
import { TextureFactory } from './world/Textures';
import { Player, healthFraction, specialFraction, focusFraction } from './player/Player';
import { PlayerState } from './player/PlayerState';
import { WebSystem } from './player/WebSystem';
import { Gadgets, GADGETS } from './player/Gadgets';
import { GltfCharacter } from './player/GltfCharacter';
import { EnemySystem, VILLAIN_KINDS, type Villain, type VillainKind } from './enemies/EnemySystem';
import { Ally } from './game/Ally';
import { DayNight } from './world/DayNight';
import { HEROES, nextHero, type HeroId } from './game/Heroes';
import { ThugSystem } from './enemies/ThugSystem';
import { Civilians } from './world/Civilians';
import { reachTo } from './enemies/CombatTarget';
import type { TargetProvider } from './enemies/CombatTarget';
import { Progression, SKILLS, type SkillBranch } from './game/Progression';
import type { ScreenMarker, VillainReadout } from './ui/HUD';
import type { OsmCityData } from './world/OsmData';
import { Settings, DIFFICULTIES } from './ui/Settings';
import { SettingsPanel } from './ui/SettingsPanel';
import {
  Campaign,
  CHAPTER_COUNT,
  CRIME,
  migrateLog,
  requiredHeroFor,
  type GameModeId,
  type StoryEvent,
} from './game/GameMode';
import { SaveGame } from './game/SaveGame';
import {
  AMBIENT,
  CHAPTER_BEATS,
  DISPATCH,
  StoryDirector,
  speakerColor,
  speakerName,
} from './game/Story';
import { SUITS as SUIT_CACHE, unlockedSuits } from './game/Suits';
import { SpeedLines } from './fx/SpeedLines';
import { Beacons, type BeaconKind } from './fx/Beacons';
import { HUD } from './ui/HUD';
import { Voice } from './audio/Voice';
import { Sfx } from './audio/Sfx';

const _aim = new THREE.Vector3();
const _impulse = new THREE.Vector3();
const _project = new THREE.Vector3();

/** Procedural texture layered under a spoken line, per speaker. */
const VOICE_BEDS: Record<string, 'bed_growl' | 'bed_crackle' | 'bed_grit' | 'bed_cackle'> = {
  VENOM: 'bed_growl',
  'SYMBIOTE PETER': 'bed_growl',
  ELECTRO: 'bed_crackle',
  SANDMAN: 'bed_grit',
  'GREEN GOBLIN': 'bed_cackle',
};

/**
 * Owns the render loop and wires every subsystem together.
 *
 * Simulation runs at a fixed 120 Hz regardless of display rate; rendering
 * interpolates between the last two physics states, so the game feels the same
 * on a 60 Hz laptop and a 165 Hz monitor.
 */
export class Game {
  private readonly container: HTMLElement;
  private readonly osm: OsmCityData | null;
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private readonly sun: THREE.DirectionalLight;
  private readonly dayNight: DayNight;

  private readonly textures: TextureFactory;
  private readonly city: City;
  private readonly player: Player;
  private readonly ally: Ally;
  private readonly web = new WebSystem();
  private readonly enemies: EnemySystem;
  private readonly thugs: ThugSystem;
  private readonly civilians: Civilians;
  private readonly beacons = new Beacons();
  private readonly beaconTargets: Array<{ position: THREE.Vector3; kind: BeaconKind }> = [];
  private readonly beaconPositions: THREE.Vector3[] = [];
  private readonly gadgets: Gadgets;
  private readonly progression = new Progression();
  private readonly targetProviders: TargetProvider[] = [];
  private readonly chase: ChaseCamera;
  private readonly speedLines: SpeedLines;
  private readonly hud = new HUD();
  private readonly settings = new Settings();
  private readonly input = new Input(this.settings);
  private readonly settingsPanel = new SettingsPanel(this.settings);
  private readonly voice = new Voice();
  private readonly sfx = new Sfx();
  /** Paces the campaign's written dialogue out through the voice and HUD. */
  private readonly story = new StoryDirector();
  private readonly villainRng = mulberry32(CONFIG.city.seed ^ 0x9e3779b9);

  private accumulator = 0;
  private lastTime = 0;
  private rafId = 0;
  private running = false;
  private started = false;
  private webRetryTimer = 0;
  private strikeCandidate: Villain | null = null;
  private wasPointerLocked = false;
  /** Reused every frame so the boss panel never allocates in the hot path. */
  private readonly villainReadouts: VillainReadout[] = [];

  // Bark trigger bookkeeping.
  private prevState: PlayerState = PlayerState.Airborne;
  private prevGrounded = false;
  private peakFallSpeed = 0;
  private swingChain = 0;
  private idleTimer = 0;
  private announcedClear = false;
  /** Crimes cleared since the last villain was drawn out. */
  private crimesSinceVillain = 0;
  /** How many villains have been brought into play so far. */
  private villainsSurfaced = 0;
  private crimesCleared = 0;
  private campaign = new Campaign('STORY');
  /** Seconds of calm remaining before the radio fills it. */
  private ambientTimer = CONFIG.story.ambientInterval;
  /** Rotates the radio rather than rolling dice, so nothing repeats early. */
  private ambientCursor = 0;
  private dispatchCursor = 0;
  private dispatchCooldown = 0;
  /** True once the current chapter's halfway line has played. */
  private midBeatPlayed = false;
  /**
   * How many times each villain has been beaten. A count, not a flag: Book
   * Five re-fights earlier villains, and a set would mark those chapters
   * complete the instant they started.
   */
  private readonly villainDefeats = new Map<string, number>();
  /** Append-only defeat log, in order. Serialised straight to the save. */
  private readonly defeatLog: string[] = [];
  /**
   * Every crime and every defeat, in the order they happened. The campaign is
   * a replay of this, so a chapter can only be paid for by things done while
   * it was the chapter you were on.
   */
  private storyLog: StoryEvent[] = [];
  /** Post-game wave number. 0 until every book is closed. */
  private postgameTier = 0;
  private playtime = 0;
  /** Throttles autosaves so a busy fight doesn't hammer localStorage. */
  private saveCooldown = 0;
  private saveDirty = false;

  private fpsAccum = 0;
  private fpsFrames = 0;
  private lowFpsStreak = 0;
  private qualityReduced = false;
  private speedLinesEnabled = true;
  /**
   * Frames are still drawn during hitstop, but the simulation is frozen. A few
   * dozen milliseconds of held frame is what makes a punch land.
   */
  private hitstopTimer = 0;
  private fps = 60;
  private lastFrameDt = 1 / 60;

  // Web aiming reticle.
  private readonly reticleAnchor = new THREE.Vector3();
  private reticleValid = false;
  private reticleTimer = 0;
  /**
   * True while an arena is suppressing the webs.
   *
   * Not the same as "an arena is active" — a chase or aerial boss bounds the
   * player without taking the webs away, and conflating the two is what made
   * Black Cat uncatchable.
   */
  private websBlocked = false;

  private readonly onResize = (): void => this.resize();
  private readonly onCanvasMouseDown = (): void => {
    // Escape releases the pointer natively; clicking the canvas takes it back.
    if (!this.input.pointerLocked) this.start();
  };
  private readonly onVisibility = (): void => {
    if (document.hidden) this.pause();
    else this.resume();
  };
  private readonly onContextLost = (event: Event): void => {
    event.preventDefault();
    this.pause();
    this.hud.showOverlay('Graphics context lost. Click to attempt recovery.', 'RESUME');
  };
  private readonly onContextRestored = (): void => {
    this.hud.hideOverlay();
    this.resume();
  };

  constructor(container: HTMLElement, osm: OsmCityData | null = null) {
    this.container = container;
    this.osm = osm;

    // MSAA is redundant once we're already supersampling via pixel ratio, and
    // it is expensive on integrated GPUs.
    const pixelRatio = Math.min(window.devicePixelRatio, CONFIG.render.maxPixelRatio);
    this.renderer = new THREE.WebGLRenderer({
      antialias: pixelRatio <= 1.25,
      powerPreference: 'high-performance',
      stencil: false,
      depth: true,
    });
    this.renderer.setPixelRatio(pixelRatio);
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.renderer.shadowMap.enabled = true;
    // PCF (not PCFSoft) — soft shadows take many more texture taps per pixel.
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    // Overwritten by DayNight every frame; this is only what the frame behind
    // the boot overlay is drawn with, so it tracks the dusk keyframe.
    this.renderer.toneMappingExposure = 1.37;
    container.appendChild(this.renderer.domElement);

    this.scene.background = new THREE.Color(CONFIG.render.skyColor);
    this.scene.fog = new THREE.FogExp2(CONFIG.render.fogColor, CONFIG.render.fogDensity);

    // --- lighting -------------------------------------------------------
    const hemi = new THREE.HemisphereLight(
      CONFIG.render.hemiSky,
      CONFIG.render.hemiGround,
      CONFIG.render.hemiIntensity,
    );
    this.scene.add(hemi);
    // Every value on these two lights is overwritten each frame by DayNight;
    // the constants above are only what the first frame is drawn with.

    this.sun = new THREE.DirectionalLight(CONFIG.render.sunColor, CONFIG.render.sunIntensity);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(CONFIG.render.shadowMapSize, CONFIG.render.shadowMapSize);
    const r = CONFIG.render.shadowRadius;
    this.sun.shadow.camera.left = -r;
    this.sun.shadow.camera.right = r;
    this.sun.shadow.camera.top = r;
    this.sun.shadow.camera.bottom = -r;
    this.sun.shadow.camera.near = 1;
    this.sun.shadow.camera.far = 620;
    this.sun.shadow.bias = -0.0006;
    this.sun.shadow.normalBias = 0.4;
    this.scene.add(this.sun);
    this.scene.add(this.sun.target);
    this.dayNight = new DayNight(this.scene, this.renderer, this.sun, hemi);

    // --- world ----------------------------------------------------------
    const maxAniso = this.renderer.capabilities.getMaxAnisotropy();
    this.textures = new TextureFactory(maxAniso);
    this.city = new City(this.textures, this.osm);
    this.scene.add(this.city.group);

    const rng = mulberry32(CONFIG.city.seed ^ 0x5f3759df);
    this.enemies = new EnemySystem(this.city, rng);
    this.scene.add(this.enemies.group);

    this.thugs = new ThugSystem(this.city, rng);
    this.scene.add(this.thugs.group);

    this.civilians = new Civilians(this.city, rng);
    this.scene.add(this.civilians.group);
    this.scene.add(this.beacons.group);

    this.gadgets = new Gadgets(this.city);
    this.scene.add(this.gadgets.group);

    // Gadgets and finishers hit villains and thugs alike.
    this.targetProviders.push(this.enemies, this.thugs);

    // --- player ---------------------------------------------------------
    const spawn = this.findSpawn();
    this.player = new Player(spawn);
    this.scene.add(this.player.rig.root);
    // If a character model has been supplied, swap it in once it loads.
    void this.tryLoadCharacter();
    this.scene.add(this.web.object3D);

    // --- partner ---------------------------------------------------------
    this.ally = new Ally(this.city);
    this.scene.add(this.ally.root);

    const aspect = window.innerWidth / Math.max(1, window.innerHeight);
    this.chase = new ChaseCamera(aspect);
    this.chase.reset(spawn);
    this.speedLines = new SpeedLines(aspect);

    // --- events ---------------------------------------------------------
    this.input.attach(this.renderer.domElement);
    this.renderer.domElement.addEventListener('mousedown', this.onCanvasMouseDown);
    window.addEventListener('resize', this.onResize);
    document.addEventListener('visibilitychange', this.onVisibility);
    this.renderer.domElement.addEventListener('webglcontextlost', this.onContextLost);
    this.renderer.domElement.addEventListener('webglcontextrestored', this.onContextRestored);

    // Barks surface as subtitles too, so they read even when muted.
    this.voice.setHero(this.player.heroId);
    this.voice.onSubtitle = (speaker, text): void => {
      const color = speaker === 'MILES' ? '#ffb703' : speaker === 'PETER' ? '#ff5a5a' : '#c084fc';
      this.hud.showSubtitle(speaker, text, color);
    };
    // Layer a procedural texture under villain lines. Synthesis alone always
    // sounds like a browser reading text; a sub-bass growl under it does not.
    this.voice.onLine = (speaker): void => {
      const bed = VOICE_BEDS[speaker];
      if (bed) this.sfx.play(bed, 0.9);
    };
    // Scripted dialogue goes out through the same subtitle and speech path as
    // a bark, but with the speaker's own name and colour, and it holds the
    // bark channel for as long as it is on screen.
    this.story.setHero(this.player.heroId);
    this.story.onLine = (line): void => {
      // The director already decided how long this line holds the floor, and
      // the subtitle has to match it: on the fixed bark window a long line
      // lost its text several seconds before the voice stopped reading it.
      const seconds = line.seconds + CONFIG.story.lineTail;
      this.hud.showSubtitle(speakerName(line.speaker), line.text, speakerColor(line.speaker), seconds);
      this.voice.line(line.speaker, line.text, line.clip, seconds);
    };
    // Chapter cards ride the same queue so they land between the chapter that
    // just closed and the one about to open, rather than being painted over.
    this.story.onCard = (card): void => {
      this.hud.showSubtitle(card.label, card.title, '#ffb703', card.seconds);
      this.sfx.play('alert', 0.35);
    };
    // Optional recorded-clip pack; absent by default. See public/voice/.
    void this.voice.loadClips().then((found) => {
      if (found) this.hud.showSubtitle('VOICE', 'Recorded voice pack loaded.', '#52fa7c');
    });
    this.enemies.onTaunt = (kind): void => {
      this.voice.taunt(kind);
    };
    this.enemies.onTelegraph = (): void => this.sfx.play('alert', 0.5);
    this.enemies.onAttackLanded = (): void => {
      this.sfx.play('heavy');
      this.chase.addShake(0.7);
    };
    this.enemies.onRangedAttack = (kind): void => {
      // Each villain's ranged attack gets its own cue — a sand burst playing
      // the wet symbiote splat was the sort of mismatch you hear immediately.
      switch (kind) {
        case 'ELECTRO':
          this.sfx.play('lightning');
          break;
        case 'SANDMAN':
          this.sfx.play('sand');
          break;
        case 'SYMBIOTE PETER':
          this.sfx.play('thwip', 0.7, 0.7);
          break;
        default:
          this.sfx.play('splat');
          break;
      }
    };
    this.enemies.onProjectileBurst = (kind): void => {
      this.sfx.play(kind === 'BOMB' ? 'explosion' : kind === 'SHARD' ? 'sand' : 'splat');
      this.chase.addShake(kind === 'BOMB' ? 0.8 : 0.3);
    };
    this.thugs.onTelegraph = (): void => this.sfx.play('alert', 0.35);
    this.enemies.onDefeated = (villain): void => {
      this.playBeat('down', villain.kind);
      this.awardXp(CONFIG.progression.xp.villain);
      this.recordDefeat(villain.kind);
      this.advanceCampaign();
      // The hero's own line only if nothing written claimed the moment. Said
      // first it was posted to the subtitle and then painted over by the
      // villain's defeat line one frame later, with its speech cut off.
      if (!this.story.busy) this.voice.say('villain_down', true);
      this.markDirty();
    };
    this.thugs.onThugDefeated = (): void => {
      this.awardXp(CONFIG.progression.xp.thug);
      this.player.addFocus(CONFIG.focus.perHit * this.progression.focusMultiplier);
    };
    this.thugs.onCrimeStarted = (): void => this.callInCrime();
    this.thugs.onCrimeResolved = (): void => {
      this.awardXp(CONFIG.progression.xp.crime);
      this.crimesCleared++;
      this.crimesSinceVillain++;
      this.logStoryEvent(CRIME);
      this.advanceCampaign();
      this.playMidBeat();
      if (!this.story.busy) this.voice.say('villain_down', true);
      this.markDirty();
    };
    // The partner speaks in their own hero's voice, not the player's.
    this.ally.onEvent = (event, heroId): void => {
      switch (event) {
        case 'join':
          this.hud.showSubtitle('TEAM-UP', `${HEROES[heroId].name} is with you.`, '#52fa7c');
          this.voice.sayAs(heroId, 'ally_join', true);
          break;
        case 'engage':
          this.voice.sayAs(heroId, 'ally_engage');
          break;
        case 'downed':
          this.hud.showSubtitle('PARTNER DOWN', `${this.ally.shortName} is out — finish it.`, '#e63946');
          this.voice.sayAs(heroId, 'ally_downed', true);
          this.sfx.play('alert', 0.6);
          break;
        case 'revived':
          this.voice.sayAs(heroId, 'ally_revived', true);
          break;
        case 'kill':
          this.voice.sayAs(heroId, 'ally_kill');
          break;
        case 'banter':
          this.voice.sayAs(heroId, 'ally_banter');
          break;
        case 'ability':
          this.voice.sayAs(heroId, 'ally_ability', true);
          break;
        default:
          break;
      }
    };
    this.ally.onHit = (_target, heavy): void => {
      this.sfx.play(heavy ? 'heavy' : 'punch', heavy ? 0.8 : 0.5, 1 + Math.random() * 0.2);
    };
    this.ally.onAbility = (heroId, at): void => {
      // Miles' blast is electric, Peter's yank is a heavy web pull.
      const venom = heroId === 'MILES';
      this.enemies.spawnImpactAt(at, venom ? 0xd8ff3c : 0xf2f6ff, 9);
      this.sfx.play(venom ? 'lightning' : 'heavy', 0.9, venom ? 1.1 : 0.85);
      this.chase.addShake(0.35);
    };

    this.gadgets.onHit = (_kind, hits): void => {
      this.player.registerHit();
      this.player.addFocus(CONFIG.focus.perHit * hits * this.progression.focusMultiplier);
      this.voice.say('strike_hit');
      this.impact(0.5 + Math.min(hits, 4) * 0.15);
    };
    this.syncSkillModifiers();

    // Settings: pause while the panel is open, swallow keys while rebinding.
    this.settings.onChange = (): void => this.applySettings();
    this.settingsPanel.onVisibilityChange = (open): void => {
      if (open) {
        this.voice.stop();
        if (document.pointerLockElement) document.exitPointerLock();
      }
    };
    this.settingsPanel.onCaptureChange = (capturing): void => {
      this.input.captureMode = capturing;
    };
    this.applySettings();

    this.hud.onModeSelect(
      (mode) => this.startMode(mode),
      () => this.continueSave(),
    );
    const existing = SaveGame.load();
    this.hud.setSaveSummary(existing ? SaveGame.summary(existing) : null);
    this.hud.onOverlayClick(() => {
      // Before a mode is picked, only the two buttons start play.
      if (this.started) this.start();
    });
    this.hud.showOverlay(
      `Verlet pendulum physics over a real New York street map. Six villains, ` +
        `${CHAPTER_COUNT} chapters across seven books, and a day that actually turns.<br>` +
        '<b>Story</b> earns its bosses chapter by chapter. <b>Free Roam</b> turns everything loose at once.',
      'CLICK TO PLAY',
    );
    this.hud.setModeSelectVisible(true);
    // ODbL requires attribution wherever the data is shown.
    if (this.city.attribution) this.hud.setAttribution(this.city.attribution);

    // Render one frame immediately so the city is visible behind the overlay.
    this.chase.update(0.016, this.player.pos, this.player.velocity, this.city);
    this.renderer.render(this.scene, this.chase.camera);
  }

  /** Enters play: locks the pointer and starts (or restarts) the loop. */
  start(): void {
    this.hud.hideOverlay();
    // An AudioContext can only start from a user gesture, and this is one.
    this.sfx.unlock();
    this.input.requestPointerLock();
    this.started = true;
    this.lastTime = performance.now();
    this.resume();
  }

  resume(): void {
    if (this.running || !this.started) return;
    this.running = true;
    this.lastTime = performance.now();
    this.rafId = requestAnimationFrame(this.frame);
  }

  pause(): void {
    if (!this.running) return;
    this.running = false;
    this.voice.stop();
    cancelAnimationFrame(this.rafId);
  }

  dispose(): void {
    this.pause();
    this.renderer.domElement.removeEventListener('mousedown', this.onCanvasMouseDown);
    window.removeEventListener('resize', this.onResize);
    document.removeEventListener('visibilitychange', this.onVisibility);
    this.renderer.domElement.removeEventListener('webglcontextlost', this.onContextLost);
    this.renderer.domElement.removeEventListener('webglcontextrestored', this.onContextRestored);

    this.settingsPanel.close();
    this.input.dispose();
    this.voice.dispose();
    this.sfx.dispose();
    this.web.dispose();
    this.player.dispose();
    this.enemies.dispose();
    this.thugs.dispose();
    this.civilians.dispose();
    this.ally.dispose();
    this.beacons.dispose();
    this.gadgets.dispose();
    this.city.dispose();
    this.textures.dispose();
    this.speedLines.dispose();
    this.renderer.dispose();
    if (this.renderer.domElement.parentElement === this.container) {
      this.container.removeChild(this.renderer.domElement);
    }
  }

  // ------------------------------------------------------------------ loop

  private readonly frame = (now: number): void => {
    if (!this.running) return;
    this.rafId = requestAnimationFrame(this.frame);

    // Clamp so a background tab or a stall can't spiral the accumulator.
    const dt = clamp((now - this.lastTime) / 1000, 0, 0.1);
    this.lastTime = now;

    // Smoothed so the readout is legible rather than flickering every frame.
    if (dt > 0) this.fps = this.fps * 0.92 + (1 / dt) * 0.08;

    this.tick(dt);
    this.trackPerformance(dt);
  };

  private tick(dt: number): void {
    this.lastFrameDt = dt;
    this.input.poll();

    // Menus swallow gameplay input rather than running underneath it.
    if (this.input.settingsPressed) this.settingsPanel.toggle();
    if (this.input.legendPressed) {
      const extra = document.getElementById('legend-extra');
      if (extra) extra.style.display = extra.style.display === 'none' ? 'block' : 'none';
    }
    if (this.settingsPanel.open) {
      this.renderer.render(this.scene, this.chase.camera);
      this.input.endFrame();
      return;
    }

    this.syncPointerLockOverlay();
    this.chase.applyLook(this.input.lookX, this.input.lookY);

    this.updateWebReticle();

    _aim.copy(this.chase.forward);
    this.strikeCandidate = this.enemies.findStrikeTarget(
      this.player.pos,
      _aim,
      CONFIG.combat.strikeRange,
      CONFIG.combat.strikeConeCos,
    );

    this.handleActions(dt);

    // Hitstop freezes the simulation while rendering continues.
    this.hitstopTimer = Math.max(0, this.hitstopTimer - dt);
    const simDt = this.hitstopTimer > 0 ? 0 : dt;

    // --- fixed-step simulation -----------------------------------------
    this.player.beginFrame(simDt, this.city);
    const context = {
      city: this.city,
      web: this.web,
      cameraYaw: this.chase.yaw,
      moveX: this.input.moveX,
      moveY: this.input.moveY,
      reelAxis: this.input.reelAxis,
      // Walls grab automatically; Ctrl is now the "let go" key.
      releaseWall: this.input.climbHeld,
      sprintHeld: this.input.sprintHeld,
      glideHeld: this.input.glideHeld,
      // Holding the web key while grounded winds up a charge jump.
      chargeHeld: this.input.webHeld && this.player.grounded,
      hasSkill: this.hasSkill,
    };

    this.accumulator += simDt;
    const fixed = CONFIG.physics.fixedDt;
    let steps = 0;
    while (this.accumulator >= fixed && steps < CONFIG.physics.maxSubSteps) {
      this.player.step(fixed, context);
      this.accumulator -= fixed;
      steps++;
    }
    // Drop any leftover backlog rather than fast-forwarding next frame.
    if (this.accumulator > fixed * CONFIG.physics.maxSubSteps) this.accumulator = 0;

    this.confinePlayerToArena(simDt);

    // --- presentation ---------------------------------------------------
    const alpha = this.accumulator / fixed;
    this.player.render(dt, alpha, this.chase.yaw, this.web.attached ? this.web.anchor : null);
    this.web.updateVisual(dt, this.player.getHandPosition(), this.chase.camera.position);

    // Resolve the melee contact frame the Player raised during its substeps.
    // This must run after the substep loop, not before it, or hits land a
    // whole frame late and read as unresponsive.
    if (this.player.meleeLandedThisFrame) this.resolveMeleeHit();
    if (this.player.landedHardThisFrame) {
      this.chase.addShake(0.3 + this.player.landImpact * 0.5);
      this.sfx.play('land', 0.6 + this.player.landImpact * 0.6);
      this.voice.say('hard_landing');
    }

    this.enemies.update(simDt, this.player);
    this.enemies.tryLandStrike(this.player);
    this.thugs.update(simDt, this.player);
    this.gadgets.update(simDt, this.targetProviders);
    this.civilians.update(simDt, this.player.pos, this.playtime);
    // The camera yaw is the player's facing for gameplay purposes — it is what
    // "behind you" means to someone holding the controls.
    this.ally.update(simDt, this.player.pos, this.chase.yaw, this.targetProviders);
    this.damageAlly(simDt);
    this.resolveThugStrike();
    this.checkRespawn();

    this.chase.update(dt, this.player.rig.root.position, this.player.velocity, this.city);
    this.speedLines.update(dt, this.player.speed);
    // Wind rises with speed, which is most of the sense of momentum.
    this.sfx.setWind(this.player.speed);
    if (this.player.damagedThisFrame) this.sfx.play('hurt');
    // Sun, sky, fog, ambient and exposure all come from the clock. Uses the
    // real frame dt, not simDt, so hitstop doesn't stall the sky.
    this.dayNight.update(dt, this.player.pos);
    this.voice.update(dt);
    this.story.update(dt);
    this.updateAmbient(dt);
    this.updateBarks(dt);
    this.updateBeacons(dt);
    this.updateMarkers();
    this.updateHud(dt);

    // Autosave: throttled so a busy fight doesn't hammer localStorage.
    this.playtime += dt;
    this.saveCooldown = Math.max(0, this.saveCooldown - dt);
    if (this.saveDirty && this.saveCooldown <= 0) this.writeSave();

    this.renderer.render(this.scene, this.chase.camera);
    if (this.speedLinesEnabled) this.speedLines.render(this.renderer);

    this.input.endFrame();
  }

  /**
   * Derives contextual barks from state transitions. Voice cooldowns do the
   * throttling, so this only has to detect that something notable happened.
   */
  private updateBarks(dt: number): void {
    const player = this.player;
    const cfg = CONFIG.voice;
    const state = player.state;
    let spoke = false;

    // Entering a swing; several in a row is a "chain".
    if (state === PlayerState.Swinging && this.prevState !== PlayerState.Swinging) {
      this.swingChain++;
      spoke = this.swingChain >= cfg.chainLength ? this.voice.say('swing_chain') : this.voice.say('swing_start');
    }
    if (state === PlayerState.Running) this.swingChain = 0;

    if (state === PlayerState.WallCrawl && this.prevState !== PlayerState.WallCrawl) {
      spoke = this.voice.say('wall_crawl') || spoke;
    }

    // Track the worst downward speed of this airborne stretch for the landing.
    if (!player.grounded) {
      this.peakFallSpeed = Math.max(this.peakFallSpeed, -player.velocity.y);
      if (state === PlayerState.Airborne && -player.velocity.y > cfg.bigFallSpeed) {
        spoke = this.voice.say('big_fall') || spoke;
      }
    } else {
      if (!this.prevGrounded && this.peakFallSpeed > cfg.hardLandingSpeed) {
        spoke = this.voice.say('hard_landing') || spoke;
      }
      this.peakFallSpeed = 0;
    }

    if (player.speed > cfg.highSpeedThreshold) spoke = this.voice.say('high_speed') || spoke;
    if (player.damagedThisFrame) spoke = this.voice.say('hurt') || spoke;
    if (player.hp / CONFIG.combat.playerMaxHp < cfg.lowHealthFraction && player.hp > 0) {
      spoke = this.voice.say('low_health') || spoke;
    }
    if (player.combo >= 3) spoke = this.voice.say('combo') || spoke;
    if (state === PlayerState.Trick) {
      this.awardXp(CONFIG.progression.xp.trick * dt);
    }

    // Only announce a clear city once a villain has actually surfaced and been
    // put down — at boot every villain is dormant, so `remaining` is already 0.
    if (
      this.enemies.remaining === 0 &&
      this.enemies.dormantCount === 0 &&
      this.villainsSurfaced > 0 &&
      !this.announcedClear
    ) {
      // Latched on the line actually going out, not on the attempt. Written
      // dialogue suppresses barks, and a chapter closing is exactly when the
      // city goes quiet — latching on the attempt lost this line for good.
      if (this.voice.say('all_clear', true)) {
        this.announcedClear = true;
        spoke = true;
      }
    }

    // Idle chatter only when genuinely uneventful.
    this.idleTimer = spoke ? 0 : this.idleTimer + dt;
    if (this.idleTimer > cfg.idleSeconds && player.speed < 8) {
      this.idleTimer = 0;
      this.voice.say('idle');
    }

    this.prevState = state;
    this.prevGrounded = player.grounded;
  }

  /** Escape drops pointer lock; surface that as a pause prompt. */
  private syncPointerLockOverlay(): void {
    const locked = this.input.pointerLocked;
    if (locked === this.wasPointerLocked) return;
    this.wasPointerLocked = locked;
    if (locked) this.hud.hideOverlay();
    else {
      this.hud.showOverlay('Paused — pointer released.<br>Click anywhere to dive back in.', 'RESUME');
      this.hud.setModeSelectVisible(false);
    }
  }

  // --------------------------------------------------------------- actions

  private handleActions(dt: number): void {
    const player = this.player;
    const input = this.input;

    // --- web: hold Space / R2 -------------------------------------------
    // On the ground the press only *starts* a charge; the jump fires on
    // release (see Player.driveGround). Queueing a jump here made it
    // impossible to ever wind one up.
    if (input.webPressed) {
      if (player.state === PlayerState.WallCrawl) {
        player.queueJump();
      } else if (!player.grounded) {
        this.shootWeb();
      }
    }
    if (input.webReleased && this.web.attached) {
      // Letting go of a line is a launch, not a drop.
      //
      // The base kick used to be 2.5 m/s against a 15.5 m/s jump, so releasing
      // did nothing you could feel and every arc ended in a fall. Now the
      // release is a jump in its own right, and it pays out more the faster
      // the arc was going — which is the thing that makes a swing chain read
      // as momentum you built rather than a ride you got off.
      const swingSpeed = Math.hypot(player.velocity.x, player.velocity.z);
      const momentum = Math.min(
        swingSpeed * CONFIG.move.releaseBoostPerSpeed,
        CONFIG.move.releaseBoostMax,
      );

      // Point launch: releasing near the top of the arc, while still rising,
      // converts swing momentum into a big vertical launch.
      const rising = player.velocity.y > CONFIG.traversal.pointLaunchMinRise;
      const launched = rising && this.hasSkill('point_launch');

      this.web.release();
      _impulse.set(
        0,
        launched ? CONFIG.traversal.pointLaunchBoost + momentum : CONFIG.move.releaseBoost + momentum,
        0,
      );
      player.addImpulse(_impulse);
      if (launched) this.voice.say('swing_chain');
    }

    // While the button stays down and nothing caught, keep trying.
    if (input.webHeld && !this.web.attached && !player.grounded) {
      this.webRetryTimer -= dt;
      if (this.webRetryTimer <= 0) {
        this.webRetryTimer = 0.15;
        this.shootWeb();
      }
    } else {
      this.webRetryTimer = 0;
    }

    // --- attack: left click or X ------------------------------------------
    // Attack ONLY. It used to fall through to firing a web when nothing was in
    // range, which meant the same button either punched or launched you across
    // the street depending on state you could not see. Webs are Space; this is
    // always a punch.
    if (input.strikePressed) {
      const melee = this.nearestMeleeTarget();
      if (melee) {
        player.beginMelee(melee, this.chase.yaw);
      } else if (this.strikeCandidate && !player.grounded) {
        if (player.beginStrike(this.strikeCandidate)) {
          this.web.release();
          this.voice.say('strike_hit');
        }
      } else {
        // Nothing in reach: still throw the punch. A swing at empty air is
        // honest feedback; silently doing something else is not.
        player.beginMelee(null, this.chase.yaw);
        this.sfx.play('punch', 0.35, 1.3);
      }
    }


    // --- special ability -------------------------------------------------
    if (input.abilityPressed && player.useAbility()) {
      if (player.heroId === 'MILES') {
        // Venom Blast: bio-electric discharge damaging everything nearby.
        this.enemies.blast(player.pos, 30, 42 * player.damageMultiplier, player);
      }
      // Peter's Symbiote Surge is a damage buff; `useAbility` already armed it.
      this.voice.say('ability', true);
    }

    if (input.swapPressed) {
      // Locked by the chapter, or by a villain who is one of the heroes —
      // the second case is what covers free roam, which has no chapter.
      let locked: HeroId | null = this.campaign.current.forceHero ?? null;
      for (const v of this.enemies.villains) {
        if (!v.alive || v.dormant) continue;
        locked = requiredHeroFor(v.kind) ?? locked;
      }
      if (locked) {
        // Refusing silently is what made every other ambiguous binding feel
        // broken. Say why.
        this.hud.showSubtitle(
          'LOCKED',
          `${HEROES[locked].name} only — the other one is on the wrong side.`,
          '#ffb703',
        );
      } else {
        const hero = player.swapHero();
        // Say the line in the outgoing hero's voice, then hand over.
        this.voice.say('swap', true);
        this.voice.setHero(hero.id);
        this.story.setHero(hero.id);
        // With a partner in play, swapping trades places: you take the one you
        // were not controlling and they pick up the one you dropped. Health
        // carries across, or tapping Tab would be a free heal.
        if (this.ally.active) this.ally.summon(nextHero(hero.id), player.pos, true);
      }
    }

    if (input.mutePressed) this.voice.toggle();

    // --- traversal extensions --------------------------------------------
    if (input.dodgePressed && player.beginDodge(this.playerContext())) {
      // A dodge is an evasive break, not something you do mid-swing: cut the
      // line rather than letting it snap you back when the dodge ends.
      if (this.web.attached) this.web.release();
      this.sfx.play('release', 0.4);
      this.player.addFocus(CONFIG.focus.perDodge * this.progression.focusMultiplier);
      // A dodge landed inside an incoming attack's window is "perfect".
      const threat = this.thugs.incomingAttack(player.pos);
      if (threat && threat.urgency > 1 - CONFIG.dodge.perfectWindow && this.hasSkill('perfect_dodge')) {
        this.player.addFocus(CONFIG.focus.perDodge * 2 * this.progression.focusMultiplier);
        this.voice.say('combo');
      }
    }

    if (input.zipPressed && this.hasSkill('zip_to_point')) {
      _aim.copy(this.chase.forward);
      const hit = this.city.raycast(player.pos, _aim, CONFIG.traversal.zipMaxDistance);
      if (hit) {
        _impulse.copy(hit.point).addScaledVector(hit.normal, 1.5);
        if (player.beginZip(_impulse)) this.web.release();
      }
    }

    // Web wings: hold to glide once airborne.
    player.setGliding(input.glideHeld && !player.grounded && this.hasSkill('web_wings'));

    // --- gadgets ----------------------------------------------------------
    if (input.gadgetCycle !== 0) this.gadgets.cycle(this.hasSkill, input.gadgetCycle);
    if (input.gadgetPressed) {
      _aim.copy(this.chase.forward);
      if (this.gadgets.fire(player.pos, _aim)) {
        this.sfx.play('gadget');
        // Play the throw so the action is visible, not just an ammo tick.
        player.beginThrow();
      } else {
        // Out of ammo or on cooldown: say so rather than doing nothing.
        const name = GADGETS.find((g) => g.id === this.gadgets.selected)?.name ?? 'Gadget';
        const empty = (this.gadgets.ammo.get(this.gadgets.selected) ?? 0) <= 0;
        this.hud.showSubtitle('GADGET', empty ? `${name}: out of ammo` : `${name}: recharging`, '#ffb703');
      }
    }

    // --- focus: two explicit keys -----------------------------------------
    // These used to share one key that chose for you based on your health, so
    // you could never deliberately trigger a finisher while hurt. Separate.
    if (input.healPressed) {
      if (player.focus < CONFIG.focus.max) {
        this.hud.showSubtitle('FOCUS', 'Need a full Focus bar to heal.', '#4ea8ff');
      } else {
        player.spendFocus();
        player.heal(this.progression.healAmount);
        this.sfx.play('levelup', 0.5);
        this.voice.say('ability', true);
      }
    }

    if (input.finisherPressed) {
      if (!this.hasSkill('finisher')) {
        this.hud.showSubtitle('FINISHER', 'Locked — unlock it in Skills (K).', '#ffb703');
      } else if (player.focus < CONFIG.focus.max) {
        this.hud.showSubtitle('FINISHER', 'Need a full Focus bar.', '#4ea8ff');
      } else {
        player.spendFocus();
        this.performFinisher();
      }
    }

    if (input.skillMenuPressed) {
      if (this.hud.toggleSkills()) this.refreshSkillScreen();
    }
  }

  /**
   * Spider-sense: which way the danger is, not just that there is danger.
   *
   * A ring at the centre of the screen told the player nothing actionable.
   * This projects the threat direction into camera space and returns a bearing
   * so the HUD can point at it — behind you, to your left, above.
   */
  private senseReadout(): { senseUrgency: number; senseAngle: number } {
    const fromThugs = this.thugs.incomingAttack(this.player.pos);
    const fromVillains = this.enemies.incomingAttack(this.player.pos);

    const threat =
      (fromThugs?.urgency ?? 0) >= (fromVillains?.urgency ?? 0) ? fromThugs : fromVillains;
    if (!threat || threat.urgency <= 0) return { senseUrgency: 0, senseAngle: 0 };

    // Bearing relative to where the camera is looking: 0 is dead ahead,
    // positive is clockwise on screen.
    _aim.copy(this.chase.forward).setY(0);
    if (_aim.lengthSq() < 1e-6) _aim.set(0, 0, -1);
    _aim.normalize();

    _project.copy(threat.direction).setY(0);
    if (_project.lengthSq() < 1e-6) return { senseUrgency: threat.urgency, senseAngle: 0 };
    _project.normalize();

    const forwardDot = _aim.dot(_project);
    // Y component of cross(forward, threat) gives the left/right sign.
    const sideDot = _aim.x * _project.z - _aim.z * _project.x;
    return { senseUrgency: threat.urgency, senseAngle: Math.atan2(sideDot, forwardDot) };
  }

  /** Closest living target inside melee reach, or null. */
  private nearestMeleeTarget(): THREE.Vector3 | null {
    let best: THREE.Vector3 | null = null;
    // Annotated: CONFIG is `as const`, so this would otherwise pin to `4.2`.
    let bestDist: number = CONFIG.combat.meleeRange;
    for (const provider of this.targetProviders) {
      for (const target of provider.combatTargets) {
        if (!target.alive) continue;
        const d = reachTo(target, this.player.pos);
        if (d < bestDist) {
          bestDist = d;
          best = target.pos;
        }
      }
    }
    return best;
  }

  /** Applies damage on the melee animation's contact frame. */
  private resolveMeleeHit(): void {
    let hits = 0;
    for (const provider of this.targetProviders) {
      for (const target of provider.combatTargets) {
        if (!target.alive) continue;
        if (reachTo(target, this.player.pos) > CONFIG.combat.meleeRange) continue;
        provider.damageTarget(
          target,
          CONFIG.combat.meleeDamage * this.player.damageMultiplier,
          this.player.pos,
        );
        hits++;
      }
    }
    if (hits > 0) {
      this.player.registerHit();
      this.player.addFocus(CONFIG.focus.perHit * this.progression.focusMultiplier);
      this.voice.say('strike_hit');
      // The third hit of the combo lands noticeably harder.
      const heavy = this.player.attackIndex === 2;
      this.sfx.play(heavy ? 'heavy' : 'punch', 1, heavy ? 0.9 : 1 + Math.random() * 0.2);
      this.impact(heavy ? 1 : 0.45);
    }
  }

  /**
   * Looks for a supplied character model and swaps it in if present.
   *
   * Absence is the normal case — the probe fails quietly and the procedural
   * rig stays. See public/models/README.md for how to add one.
   */
  private async tryLoadCharacter(): Promise<void> {
    const character = await GltfCharacter.load(CONFIG.character.modelUrl);
    if (!character) return;

    const previous = this.player.adoptRig(character);
    this.scene.remove(previous);
    this.scene.add(character.root);
    this.hud.showSubtitle('SUIT UP', 'Custom character model loaded.', '#52fa7c');
  }

  /** Rebuilds the context object the Player needs outside the fixed loop. */
  private playerContext(): Parameters<Player['step']>[1] {
    return {
      city: this.city,
      web: this.web,
      cameraYaw: this.chase.yaw,
      moveX: this.input.moveX,
      moveY: this.input.moveY,
      reelAxis: this.input.reelAxis,
      releaseWall: this.input.climbHeld,
      sprintHeld: this.input.sprintHeld,
      glideHeld: this.input.glideHeld,
      chargeHeld: this.input.webHeld && this.player.grounded,
      hasSkill: this.hasSkill,
    };
  }

  private readonly hasSkill = (id: string): boolean => this.progression.has(id);

  /** Focus finisher: a damaging burst centred on the player. */
  private performFinisher(): void {
    let hits = 0;
    for (const provider of this.targetProviders) {
      for (const target of provider.combatTargets) {
        if (!target.alive) continue;
        if (reachTo(target, this.player.pos) > CONFIG.focus.finisherRadius) continue;
        provider.damageTarget(target, CONFIG.focus.finisherDamage * this.player.damageMultiplier, this.player.pos);
        hits++;
      }
    }
    if (hits > 0) {
      this.player.registerHit();
      this.awardXp(CONFIG.progression.xp.finisher * hits);
    }
    this.impact(1.4);
    this.voice.say('ability', true);
  }

  /** Web strikes land on thugs too, not just the named villains. */
  private resolveThugStrike(): void {
    if (!this.player.isStriking) return;
    const radiusSq = CONFIG.combat.strikeHitRadius * CONFIG.combat.strikeHitRadius;
    for (const thug of this.thugs.thugs) {
      if (!thug.alive) continue;
      if (this.player.pos.distanceToSquared(thug.pos) > radiusSq) continue;
      this.thugs.damageTarget(thug, CONFIG.combat.strikeDamage * this.player.damageMultiplier, this.player.pos);
      this.player.registerHit();
      this.player.addFocus(CONFIG.focus.perHit * this.progression.focusMultiplier);
      _impulse.copy(this.player.pos).sub(thug.pos).normalize().multiplyScalar(14);
      _impulse.y += 9;
      this.player.endStrike();
      this.player.addImpulse(_impulse);
      this.impact(1);
      return;
    }
  }

  /**
   * Villains are drawn out by pressure on the street rather than handed over
   * up front. In story mode the chapter list decides when; in free roam it is
   * simply every N crimes.
   */
  /** Logs a villain defeat and bumps its count. */
  private recordDefeat(kind: string): void {
    this.defeatLog.push(kind);
    this.villainDefeats.set(kind, (this.villainDefeats.get(kind) ?? 0) + 1);
    this.logStoryEvent(kind as StoryEvent);
  }

  /**
   * Appends to the campaign log, but only while there is a campaign left to
   * advance. An endless siege would otherwise grow the log — and the save
   * written from it — without bound, for a replay whose answer stopped
   * changing at the last chapter.
   */
  private logStoryEvent(event: StoryEvent): void {
    if (!this.campaign.isStory || this.campaign.complete) return;
    this.storyLog.push(event);
  }

  private advanceCampaign(): void {
    // Captured before the replay, because the replay is what makes it the
    // *previous* chapter — and it is the previous chapter that gets the last
    // word. The director queues, so its closing lines are heard in full
    // before the next chapter's opening ones start.
    const leaving = this.campaign.isStory ? this.campaign.current.title : null;
    if (this.campaign.replay(this.storyLog)) {
      if (leaving) this.story.play(CHAPTER_BEATS[leaving]?.close);
      this.enterChapter();
    }

    // Every book closed: the city stops being a script and starts being a
    // siege. Waves of villains, each tier tougher than the last.
    if (this.campaign.complete) {
      this.updatePostgame();
      return;
    }

    if (!this.campaign.isStory) {
      // Free roam: a new villain every N crimes, one at a time.
      if (this.crimesSinceVillain < CONFIG.crimes.crimesPerVillain) return;
      if (this.enemies.remaining > 0) return;
      this.crimesSinceVillain = 0;
      const villain = this.enemies.activateNext(this.player.pos, this.villainRng);
      if (villain) this.announceVillain(villain);
      return;
    }

    // Story: bring out everyone the chapter still needs. `pending` is
    // defeat-aware, so beating one half of a team-up does not respawn them
    // while you finish the other half.
    for (const kind of this.campaign.pending()) {
      const live = this.enemies.villains.some((v) => v.kind === kind && v.alive && !v.dormant);
      if (live) continue;
      const villain = this.enemies.activateNext(this.player.pos, this.villainRng, kind);
      if (villain) this.announceVillain(villain);
    }
  }

  /**
   * The post-game: endless waves once every book is closed.
   *
   * Each wave raises the tier, which scales boss health and the damage they
   * deal, and adds another villain to the wave. By tier six the whole roster
   * is loose at once and hitting far harder than anything the story fielded.
   * Partners come along from tier two, because past that it stops being fair.
   */
  private updatePostgame(): void {
    // Only escalate once the current wave is actually finished.
    if (this.enemies.remaining > 0) return;

    this.postgameTier++;
    this.enemies.tier = this.postgameTier;

    const waveSize = Math.min(VILLAIN_KINDS.length, 1 + Math.floor(this.postgameTier / 2));
    // Rotate the roster so a wave is not the same faces in the same order.
    const start = (this.postgameTier * 2) % VILLAIN_KINDS.length;
    let summoned = 0;
    for (let i = 0; i < VILLAIN_KINDS.length && summoned < waveSize; i++) {
      const kind = VILLAIN_KINDS[(start + i) % VILLAIN_KINDS.length]!;
      const villain = this.enemies.activateNext(this.player.pos, this.villainRng, kind);
      if (villain) summoned++;
    }

    // A hero-locking villain in the wave decides who you play, and dismisses
    // the partner. Run the lock before deciding whether to summon one.
    this.enforceHeroLock();
    const locked = this.enemies.villains.some(
      (v) => v.alive && !v.dormant && requiredHeroFor(v.kind) !== null,
    );
    if (this.postgameTier >= 2 && !locked) {
      const partner = nextHero(this.player.heroId);
      if (!this.ally.active || this.ally.heroId !== partner) {
        this.ally.summon(partner, this.player.pos);
      }
    }

    this.hud.showSubtitle(
      `SIEGE · TIER ${this.postgameTier}`,
      `${summoned} on the streets, and they have got stronger.`,
      '#e63946',
    );
    this.sfx.play('alert', 0.8);
    this.markDirty();
  }

  private announceVillain(villain: Villain): void {
    this.announcedClear = false;
    this.villainsSurfaced++;
    // Sandman's weak point has to be stated. A boss where hitting the obvious
    // target does almost nothing is a puzzle, and an unsignposted puzzle in
    // the middle of a fight just reads as the damage being broken.
    const note =
      villain.kind === 'SANDMAN'
        ? ' He is the size of the block — hit the head, nothing lower holds together.'
        : '';
    this.hud.showSubtitle('ALERT', `${villain.name} has surfaced in the city.${note}`, '#9440bc');
    // A chapter that wrote this villain an entrance gets the entrance. Only
    // fall back to a generic taunt when it did not — which is every villain
    // in free roam and in the post-game siege.
    if (!this.playBeat('meet', villain.kind)) this.voice.taunt(villain.kind);
    // A villain who *is* one of the heroes decides who you play. Applied here
    // rather than only from chapter data, so it holds in free roam too.
    this.enforceHeroLock();
  }

  // ------------------------------------------------------------ story beats

  /**
   * Plays a chapter's written line for a villain arriving or going down.
   *
   * Returns whether this chapter had anything written for this villain, which
   * is what lets the caller fall back to a generic taunt in free roam and in
   * the post-game, where there is no chapter to have written one.
   */
  private playBeat(kind: 'meet' | 'down', villain: VillainKind): boolean {
    if (!CONFIG.story.enabled || !this.campaign.isStory) return false;
    const beats = CHAPTER_BEATS[this.campaign.current.title];
    return this.story.play(beats?.[kind]?.[villain]);
  }

  /**
   * The halfway line, once per chapter.
   *
   * Halfway is measured against what this chapter asked for rather than a
   * fixed count, so a two-crime chapter hears it after one and a three-crime
   * chapter after two. A chapter with no street work has nothing to be halfway
   * through, and a one-crime chapter would fire it and its closing line back
   * to back, so both are skipped.
   */
  private playMidBeat(): void {
    if (!CONFIG.story.enabled || this.midBeatPlayed || !this.campaign.isStory) return;
    const chapter = this.campaign.current;
    if (chapter.crimes < 2) return;
    if (this.campaign.crimesIntoChapter() < Math.ceil(chapter.crimes / 2)) return;
    this.midBeatPlayed = true;
    this.story.play(CHAPTER_BEATS[chapter.title]?.mid);
  }

  /**
   * Calls a newly staged crime in over the police radio.
   *
   * Deliberately not every crime. Clearing crimes is the one thing the player
   * is always doing, and narrating all of them would turn six lines into a
   * loop the player learns by heart inside ten minutes.
   */
  private callInCrime(): void {
    if (!CONFIG.story.enabled || this.dispatchCooldown > 0) return;
    if (this.story.busy || this.inVillainFight()) return;
    if (Math.random() > CONFIG.story.dispatchChance) return;
    this.dispatchCooldown = CONFIG.story.dispatchCooldown;
    this.story.play(DISPATCH[this.dispatchCursor % DISPATCH.length], 'AMBIENT');
    this.dispatchCursor++;
  }

  /**
   * Whether a live villain is close enough that this counts as a fight.
   *
   * Walks `villains` rather than the `engaged` getter, which filters into a
   * fresh array — correct once, but this is called every frame.
   */
  private inVillainFight(): boolean {
    const radius = CONFIG.story.calmRadius * CONFIG.story.calmRadius;
    for (const villain of this.enemies.villains) {
      if (!villain.alive || villain.dormant) continue;
      if (villain.pos.distanceToSquared(this.player.pos) < radius) return true;
    }
    return false;
  }

  /**
   * The radio, filling genuine calm.
   *
   * Only segments the current book has unlocked are eligible, so the city is
   * never overheard discussing something the player has not reached. The
   * cursor walks the list rather than rolling dice: with twenty entries, random
   * selection repeats itself far sooner than it feels like it ought to.
   */
  private updateAmbient(dt: number): void {
    this.dispatchCooldown = Math.max(0, this.dispatchCooldown - dt);
    if (!CONFIG.story.enabled) return;

    // Calm means calm — no scene running, and no fight the player is in.
    if (this.story.busy || this.inVillainFight()) {
      this.ambientTimer = CONFIG.story.ambientInterval;
      return;
    }
    this.ambientTimer -= dt;
    if (this.ambientTimer > 0) return;
    this.ambientTimer = CONFIG.story.ambientInterval;

    // Free roam and the post-game have no book to gate on, and by then the
    // player has seen everything, so the whole list is open.
    const book = this.campaign.isStory && this.campaign.bookIndex >= 0 ? this.campaign.bookIndex : AMBIENT.length;
    const eligible = AMBIENT.filter((entry) => entry.book <= book);
    if (eligible.length === 0) return;
    const entry = eligible[this.ambientCursor % eligible.length]!;
    this.ambientCursor++;
    this.story.play(entry.script, 'AMBIENT');
  }

  /**
   * Switches you to the hero a live villain demands, and sends the other one
   * home.
   *
   * Symbiote Peter is Peter. Fighting him as Peter makes no sense, and having
   * Peter fight at your side while you fight Peter makes less. The story
   * chapters already force Miles, but free roam has no chapter data, so the
   * rule lives with the villain instead of with the script.
   */
  private enforceHeroLock(): void {
    let required: HeroId | null = null;
    for (const v of this.enemies.villains) {
      if (!v.alive || v.dormant) continue;
      required = requiredHeroFor(v.kind) ?? required;
    }
    if (!required) return;

    // The counterpart is the villain, so they cannot also be the partner.
    if (this.ally.active && this.ally.heroId !== required) this.ally.dismiss();
    if (this.player.heroId === required) return;

    this.player.setHero(required);
    this.voice.setHero(required);
    this.story.setHero(required);
    this.story.playCard('SWITCH', `${HEROES[required].name} takes this one — that is not a partner any more.`);
  }

  /**
   * Applies everything a chapter changes: the clock, the forced hero and the
   * partner. Called on every chapter transition and once when a save loads.
   */
  private enterChapter(announce = true): void {
    const chapter = this.campaign.current;
    this.midBeatPlayed = false;

    // Pin the sky so a scene written for the dark happens in the dark, however
    // long the player took to get here. Free roam runs the clock freely.
    this.dayNight.pin(this.campaign.isStory ? (chapter.time ?? null) : null);

    // A chapter can require a specific hero — you cannot play Peter in the
    // chapters where Peter is the thing you are fighting. Settled *before* the
    // opening exchange is queued, because that exchange is written from the
    // point of view of whoever is holding the mask: queue it first and Book
    // Six opens with Peter delivering Miles' half of a conversation about
    // Peter.
    const swapped = Boolean(chapter.forceHero) && this.player.heroId !== chapter.forceHero;
    if (chapter.forceHero && swapped) {
      this.player.setHero(chapter.forceHero);
      this.voice.setHero(chapter.forceHero);
      this.story.setHero(chapter.forceHero);
    }

    if (announce) {
      // Card, then the reason the hero changed if it did, then the chapter's
      // opening exchange — all queued, so the outgoing chapter's closing lines
      // are heard before any of it.
      this.story.playCard(this.campaign.progressLabel, chapter.title);
      if (chapter.forceHero && swapped) {
        this.story.playCard('STORY', `${HEROES[chapter.forceHero].name} takes this one.`);
      }
      this.story.play(CHAPTER_BEATS[chapter.title]?.open);
    } else {
      // Restoring a save. Nothing is queued and nothing is owed: show the card
      // straight away, and skip the opening exchange for a chapter the player
      // has already been introduced to.
      this.hud.showSubtitle(this.campaign.progressLabel, chapter.title, '#ffb703');
    }

    // The partner is whichever hero you are not currently playing.
    if (chapter.ally) {
      const partner = nextHero(this.player.heroId);
      if (!this.ally.active || this.ally.heroId !== partner) {
        this.ally.summon(partner, this.player.pos);
      }
    } else {
      this.ally.dismiss();
    }
  }

  // ------------------------------------------------------------------ save

  /** Flags that state changed; the actual write is throttled in `tick`. */
  private markDirty(): void {
    this.saveDirty = true;
  }

  private writeSave(): void {
    this.saveDirty = false;
    this.saveCooldown = 5;
    SaveGame.save(
      {
        mode: this.campaign.mode,
        progression: this.progression.serialize(),
        heroId: this.player.heroId,
        suitByHero: this.player.suitChoices,
        crimesCleared: this.crimesCleared,
        villainsSurfaced: this.villainsSurfaced,
        defeatedVillains: [...this.defeatLog],
        storyLog: [...this.storyLog],
        playtime: this.playtime,
        timeOfDay: this.dayNight.time,
        postgameTier: this.postgameTier,
      },
      Date.now(),
    );
  }

  /** Restores a save and drops straight into play. */
  continueSave(): void {
    const data = SaveGame.load();
    if (!data) {
      this.startMode('STORY');
      return;
    }

    this.story.clear();
    this.campaign = new Campaign(data.mode);
    this.progression.restore(data.progression);
    this.player.restoreAppearance(data.heroId, data.suitByHero);
    this.voice.setHero(this.player.heroId);
    // Without this, a save loaded as Miles resolved every HERO line to Peter.
    this.story.setHero(this.player.heroId);
    this.crimesCleared = data.crimesCleared;
    this.villainsSurfaced = data.villainsSurfaced;
    this.playtime = data.playtime;
    this.dayNight.setTime(data.timeOfDay);
    // Restore the tier *before* anything spawns, so a revived boss comes back
    // at the strength it had rather than at tier zero.
    this.postgameTier = data.postgameTier;
    this.enemies.tier = data.postgameTier;
    // The save stores both logs in order, so every count rebuilds from them.
    // A save written before the event log existed only has totals, which are
    // migrated into the closest honest log they can support.
    this.defeatLog.length = 0;
    this.villainDefeats.clear();
    this.storyLog =
      (data.storyLog as StoryEvent[] | undefined) ??
      migrateLog(data.crimesCleared, data.defeatedVillains);
    for (const kind of data.defeatedVillains) {
      this.defeatLog.push(kind);
      this.villainDefeats.set(kind, (this.villainDefeats.get(kind) ?? 0) + 1);
    }

    // Retire everyone, then let the campaign decide who should be live now.
    // The later books revive earlier villains, so retiring by log is still
    // correct: advanceCampaign brings back whoever this chapter names.
    for (const kind of this.villainDefeats.keys()) {
      this.enemies.retire(kind as VillainKind);
    }
    this.campaign.replay(this.storyLog);
    if (!this.campaign.isStory) {
      for (let i = 0; i < this.enemies.villains.length; i++) {
        this.enemies.activateNext(this.player.pos, this.villainRng);
      }
    } else {
      // Re-apply the chapter's clock, forced hero and partner, then spawn it.
      this.enterChapter(false);
      this.advanceCampaign();
    }

    this.syncSkillModifiers();
    this.start();
  }

  /** Wipes the save and returns to the title screen. */
  eraseSave(): void {
    SaveGame.clear();
    this.saveDirty = false;
  }

  /** Chooses the mode and starts play. Called from the boot overlay buttons. */
  startMode(mode: GameModeId): void {
    SaveGame.clear();
    this.story.clear();
    this.campaign = new Campaign(mode);
    this.crimesCleared = 0;
    this.villainsSurfaced = 0;
    this.playtime = 0;
    this.villainDefeats.clear();
    this.defeatLog.length = 0;
    this.storyLog = [];
    this.postgameTier = 0;
    this.enemies.tier = 0;
    this.ally.dismiss();

    if (mode === 'FREE_ROAM') {
      // Everything is loose from the first second, and you get points to spend.
      // Count from the roster rather than a literal, so adding a villain does
      // not silently leave one dormant.
      this.dayNight.setTime(CONFIG.dayNight.freeRoamStart);
      for (let i = 0; i < this.enemies.villains.length; i++) {
        const villain = this.enemies.activateNext(this.player.pos, this.villainRng);
        if (villain) this.villainsSurfaced++;
      }
      this.progression.skillPoints += 6;
    } else {
      this.dayNight.setTime(CONFIG.dayNight.startTime);
      this.enterChapter();
    }
    this.markDirty();
    this.start();
  }

  /**
   * The universal "that connected" feedback: a brief simulation freeze plus
   * camera shake, scaled by how heavy the hit was.
   */
  private impact(weight: number): void {
    this.hitstopTimer = Math.max(this.hitstopTimer, 0.02 + weight * 0.055);
    this.chase.addShake(0.25 + weight * 0.5);
  }

  private awardXp(amount: number): void {
    const result = this.progression.addXp(amount);
    if (result.leveledUp) {
      this.sfx.play('levelup');
      this.voice.say('combo', true);
      this.syncSkillModifiers();
      this.markDirty();
      if (this.hud.skillsOpen) this.refreshSkillScreen();
    }
  }

  /** Pushes settings values into the systems that consume them. */
  private applySettings(): void {
    const data = this.settings.data;
    this.chase.baseFov = data.fov;
    this.voice.setEnabled(data.barks);
    this.voice.volume = data.barkVolume;
    this.sfx.setEnabled(data.sfx);
    this.sfx.setVolume(data.sfxVolume);
    this.speedLinesEnabled = data.speedLines;
    this.dayNight.brightness = clamp(data.brightness ?? 1, 0.8, 1.6);
    this.player.damageTakenScale = (DIFFICULTIES[data.difficulty] ?? DIFFICULTIES.NORMAL).damageTaken;
    this.renderer.shadowMap.enabled = data.shadows && !this.qualityReduced;
    // Materials must be told the shadow configuration changed.
    this.scene.traverse((object) => {
      if (object instanceof THREE.Mesh) {
        const material = object.material;
        if (Array.isArray(material)) material.forEach((m) => (m.needsUpdate = true));
        else if (material) material.needsUpdate = true;
      }
    });
  }

  private syncSkillModifiers(): void {
    this.gadgets.applyModifiers(
      this.progression.gadgetDamageMultiplier,
      this.progression.ammoMultiplier,
    );
  }

  private refreshSkillScreen(): void {
    const branchNames: SkillBranch[] = ['WEBSLINGER', 'DEFENDER', 'INNOVATOR'];
    const branches = branchNames.map((branch) => ({
      name: branch,
      skills: SKILLS.filter((s) => s.branch === branch).map((s) => ({
        id: s.id,
        name: s.name,
        desc: s.desc,
        cost: s.cost,
        owned: this.progression.has(s.id),
        available: this.progression.canUnlock(s.id),
      })),
    }));

    this.hud.renderSkills(branches, this.progression.skillPoints, (id) => {
      if (this.progression.unlock(id)) {
        this.syncSkillModifiers();
        this.markDirty();
        this.refreshSkillScreen();
      }
    });

    const hex = (value: number): string => `#${value.toString(16).padStart(6, '0')}`;
    const available = unlockedSuits(this.player.heroId, this.progression.level);
    const suits = SUIT_CACHE.filter((s) => s.hero === this.player.heroId).map((s) => ({
      id: s.id,
      name: s.name,
      blurb: s.blurb,
      color: hex(s.primary),
      accent: hex(s.secondary),
      unlockLevel: s.unlockLevel,
      owned: available.some((u) => u.id === s.id),
      equipped: this.player.suitId === s.id,
    }));

    this.hud.renderSuits(suits, (id) => {
      this.player.equipSuit(id);
      this.markDirty();
      this.refreshSkillScreen();
    });
  }

  /**
   * Marks the point a web would attach to, so aiming is not guesswork.
   *
   * Hidden while a line is attached and shown again the moment it is released,
   * which is what makes it read as "here is your next anchor".
   */
  private updateWebReticle(): void {
    if (this.web.attached || this.player.grounded) {
      this.hud.setWebReticle(null);
      return;
    }

    // Only re-search a few times a second; a full aim fan is 33 raycasts.
    this.reticleTimer -= this.lastFrameDt;
    if (this.reticleTimer > 0) {
      this.projectReticle();
      return;
    }
    this.reticleTimer = 0.08;

    _aim.copy(this.chase.forward);
    const anchor = this.web.findAnchor(
      this.city,
      this.player.pos,
      this.player.pos,
      _aim,
      this.player.wallNormal,
      true, // coarse: a preview does not need the full aim-assist fan
    );

    if (anchor) this.reticleAnchor.copy(anchor);
    this.reticleValid = anchor !== null;
    this.projectReticle();
  }

  /** Projects the cached anchor into screen space for the HUD. */
  private projectReticle(): void {
    if (!this.reticleValid) {
      this.hud.setWebReticle(null);
      return;
    }

    _project.copy(this.reticleAnchor).project(this.chase.camera);
    // Behind the camera: nothing to point at.
    if (_project.z > 1) {
      this.hud.setWebReticle(null);
      return;
    }

    const distance = this.reticleAnchor.distanceTo(this.player.pos);
    this.hud.setWebReticle({
      x: (_project.x * 0.5 + 0.5) * window.innerWidth,
      y: (-_project.y * 0.5 + 0.5) * window.innerHeight,
      // Nearer anchors draw a larger ring, so depth reads at a glance.
      scale: clamp(1.5 - distance / CONFIG.web.maxLength, 0.55, 1.4),
    });
  }

  /**
   * Plants world-space light columns on every live objective.
   *
   * Beacons sit on the ground beneath the objective, not at its altitude, so
   * a rooftop crime still reads as a place you can navigate toward from street
   * level rather than a dot floating in the sky.
   */
  private updateBeacons(dt: number): void {
    this.beaconTargets.length = 0;

    const crime = this.thugs.nearestCrime(this.player.pos);
    if (crime) {
      this.beaconTargets.push({
        position: this.groundUnder(crime.pos, this.beaconTargets.length),
        kind: 'crime',
      });
    }

    for (const villain of this.enemies.villains) {
      if (!villain.alive || villain.dormant) continue;
      this.beaconTargets.push({
        position: this.groundUnder(villain.pos, this.beaconTargets.length),
        kind: 'villain',
      });
    }

    this.beacons.set(this.beaconTargets);
    this.beacons.update(dt);
  }

  /**
   * Point directly below `from`, on whatever surface is under it.
   * Writes into a pooled vector — this runs for every objective every frame.
   */
  private groundUnder(from: THREE.Vector3, slot: number): THREE.Vector3 {
    let out = this.beaconPositions[slot];
    if (!out) {
      out = new THREE.Vector3();
      this.beaconPositions[slot] = out;
    }
    out.copy(from);
    out.y = this.city.groundHeightAt(from.x, from.z);
    return out;
  }

  /** Projects objective positions into screen space, clamped to the edges. */
  private updateMarkers(): void {
    const markers: ScreenMarker[] = [];
    const width = window.innerWidth;
    const height = window.innerHeight;
    const pad = CONFIG.markers.edgePadding;

    const push = (world: THREE.Vector3, label: string, kind: 'crime' | 'villain'): void => {
      const distance = world.distanceTo(this.player.pos);
      if (distance > CONFIG.markers.maxDistance) return;

      _project.copy(world).project(this.chase.camera);
      // Behind the camera: mirror so the arrow points the right way.
      const behind = _project.z > 1;
      if (behind) {
        _project.x = -_project.x;
        _project.y = -_project.y;
      }

      let x = (_project.x * 0.5 + 0.5) * width;
      let y = (-_project.y * 0.5 + 0.5) * height;
      if (behind) y = _project.y > 0 ? pad : height - pad;

      x = clamp(x, pad, width - pad);
      y = clamp(y, pad, height - pad);
      markers.push({ x, y, label: `${label} ${Math.round(distance)}m`, kind });
    };

    const crime = this.thugs.nearestCrime(this.player.pos);
    if (crime) push(crime.pos, 'CRIME', 'crime');

    for (const villain of this.enemies.villains) {
      // Dormant villains aren't in the world yet — don't point at them.
      if (villain.alive && !villain.dormant) push(villain.pos, villain.name, 'villain');
    }

    this.hud.setMarkers(markers);
  }

  /**
   * Holds the player inside an active boss arena.
   *
   * Confining only the villain left the fight trivially skippable — you could
   * swing off and it would simply disengage. Both sides are now bounded, and
   * the line is cut if you try to leave.
   */
  private confinePlayerToArena(dt: number): void {
    const arena = this.enemies.activeArena(this.player.pos);
    // Some bosses keep your webs; the bounds still apply either way.
    this.websBlocked = arena !== null && !arena.allowWebs;
    if (!arena || dt <= 0) return;

    const limit = CONFIG.enemies.arena.playerRadius;
    // Horizontal only. A spherical bound also has a floor, which pinned you at
    // rooftop altitude with no way down — see Player.confineToCylinder.
    const overshoot = Math.hypot(
      this.player.pos.x - arena.centre.x,
      this.player.pos.z - arena.centre.z,
    ) - limit;
    if (overshoot <= 0) return;

    // Player.confineToCylinder moves prevPos with pos, so this reads as
    // resistance rather than injecting velocity.
    this.player.confineToCylinder(arena.centre, limit, CONFIG.enemies.arena.pushback * dt);

    // Cut the line if it is what is dragging you out.
    //
    // Where the arena blocks webs there is nothing to weigh up. Where it does
    // not — a chase or an aerial boss — only an anchor *outside* the boundary
    // is a problem: the web solve would pull outward every substep while the
    // boundary pushes inward, and the two would fight to a standstill. An
    // anchor inside the arena is left alone, so swinging inside the fight
    // keeps working.
    if (this.web.attached) {
      const anchorOutside =
        Math.hypot(this.web.anchor.x - arena.centre.x, this.web.anchor.z - arena.centre.z) > limit;
      if (!arena.allowWebs || anchorOutside) this.web.release();
    }
    if (overshoot > 3) this.hud.showSubtitle('ARENA', 'Finish the fight.', '#9440bc');
  }

  private shootWeb(): void {
    // Inside a ground-boss arena the webs are off: this is a fight, not a
    // chase. Say so every time — silently ignoring the input reads as the
    // webs being broken, which is exactly how it was reported.
    if (this.websBlocked && CONFIG.enemies.arena.blockWebs) {
      this.sfx.play('release', 0.3);
      // Quote the real disengage distance rather than a hard-coded number that
      // stopped matching the config.
      this.hud.showSubtitle(
        'NO WEBS',
        `Boss fight — beat them, or get ${CONFIG.enemies.arena.disengageDistance}m clear.`,
        '#e63946',
      );
      return;
    }

    _aim.copy(this.chase.forward);
    this.sfx.play('thwip', 0.55, 0.9 + Math.random() * 0.25);
    if (this.web.tryAttach(this.city, this.player.pos, _aim, this.player.wallNormal)) {
      this.webRetryTimer = 0.15;
      this.sfx.play('attach', 0.5);
    }
  }

  private checkRespawn(): void {
    if (this.player.hp > 0 && this.player.pos.y > -40) return;
    this.web.release();
    const spawn = this.findSpawn();
    this.player.respawn(spawn);
    this.chase.reset(spawn);
  }

  // ----------------------------------------------------------------- world

  private findSpawn(): THREE.Vector3 {
    // Tallest building near the middle of the map makes for a good drop-in.
    let best = this.city.buildings[0];
    let bestScore = -Infinity;
    for (const b of this.city.buildings) {
      const distance = Math.hypot(b.roof.x, b.roof.z);
      if (distance > 220) continue;
      const score = b.height - distance * 0.35;
      if (score > bestScore) {
        bestScore = score;
        best = b;
      }
    }
    const roof = best ? best.roof : new THREE.Vector3(0, 80, 0);
    return new THREE.Vector3(roof.x, roof.y + 6, roof.z);
  }

  /**
   * Enemies that reach the partner hurt them.
   *
   * The villain and thug systems only know about the player, and threading a
   * second damageable body through both of them would mean every attack, lunge
   * and projectile growing a target parameter — a lot of surface area for a
   * companion that is only present in a handful of chapters. Instead the
   * pressure is applied here: standing inside an enemy's reach costs the ally
   * health on a timer. It is an abstraction, but it produces the behaviour that
   * matters — leave them in a brawl and they go down.
   */
  private damageAlly(dt: number): void {
    if (!this.ally.active || this.ally.downed > 0 || dt <= 0) return;

    let pressure = 0;
    for (const provider of this.targetProviders) {
      for (const target of provider.combatTargets) {
        if (!target.alive || target.webbed > 0) continue;
        const distance = reachTo(target, this.ally.position);
        if (distance > CONFIG.ally.attackRange * 1.6) continue;
        // Bosses hit far harder than street thugs; maxHp is a decent proxy.
        pressure += target.maxHp > 120 ? 11 : 4;
      }
    }
    if (pressure > 0) this.ally.takeDamage(pressure * dt);
  }

  /**
   * " — 1/2 cleared · nearest 240m" for a chapter that wants crimes.
   *
   * A chapter used to print its blurb and nothing else, so there was no way to
   * tell how many crimes were left, whether one was live, or where it was. If
   * a spawn had failed the city simply went quiet with no explanation — which
   * reads exactly like the objective is missing.
   */
  private crimeProgressLabel(): string {
    const needed = this.campaign.current.crimes;
    if (needed <= 0) return '';

    const done = this.campaign.crimesIntoChapter();
    const crime = this.thugs.nearestCrime(this.player.pos);
    const where = crime
      ? `nearest ${Math.round(crime.pos.distanceTo(this.player.pos))}m — follow the marker`
      : 'scanning for activity…';
    return ` (${done}/${needed} cleared · ${where})`;
  }

  private updateHud(dt: number): void {
    const player = this.player;
    // The tracker follows the campaign chapter, so it never points at a
    // villain that has not surfaced yet.
    const chapter = this.campaign.current;

    // One bar per live boss, nearest first. Rebuilt in place so a team-up
    // does not allocate a fresh array every frame.
    this.villainReadouts.length = 0;
    for (const v of this.enemies.villains) {
      if (!v.alive || v.dormant) continue;
      this.villainReadouts.push({
        name: v.name,
        health: v.hp / v.maxHp,
        distance: v.pos.distanceTo(player.pos),
      });
    }
    this.villainReadouts.sort((a, b) => a.distance - b.distance);
    // Free roam can have all six loose at once; three bars is already a lot of
    // screen, and the far ones are not what you are fighting.
    if (this.villainReadouts.length > 3) this.villainReadouts.length = 3;

    this.hud.update(
      {
        heroName: player.hero.name,
        heroColor: `#${player.hero.primary.toString(16).padStart(6, '0')}`,
        abilityName: player.hero.abilityName,
        health: healthFraction(player),
        special: specialFraction(player),
        speedKmh: player.speedKmh,
        movementState: player.state,
        webLength: this.web.attached ? this.web.restLength : null,
        tension: this.web.tension,
        combo: player.combo,
        gamepadConnected: this.input.gamepadConnected,
        villains: this.villainReadouts,
        ally: this.ally.active
          ? {
              name: this.ally.name,
              health: this.ally.healthFraction,
              status: this.ally.downed > 0
                ? `Down — back up in ${Math.ceil(this.ally.downed)}s`
                : 'Fighting alongside you',
              downed: this.ally.downed > 0,
            }
          : null,
        clock: this.dayNight.clockLabel,
        questTitle: this.postgameTier > 0
          ? `SIEGE · TIER ${this.postgameTier}`
          : `${this.campaign.progressLabel} · ${chapter.title}`,
        questDesc: this.postgameTier > 0
          ? `Every book closed. Waves keep coming and keep getting stronger — ` +
            `+${Math.round((this.enemies.tierHealthScale - 1) * 100)}% health this tier.`
          : `${this.campaign.bookSubtitle} — ${chapter.desc}${this.crimeProgressLabel()}`,
        speedIntensity: this.speedLines.strength,
        damaged: player.damagedThisFrame,
        hasStrikeTarget: this.strikeCandidate !== null,
        pointerLocked: this.input.pointerLocked,
        voiceEnabled: this.voice.enabled,
        voiceSupported: this.voice.supported,
        focus: focusFraction(player),
        xp: this.progression.levelFraction,
        level: this.progression.level,
        skillPoints: this.progression.skillPoints,
        gadgetName: GADGETS.find((g) => g.id === this.gadgets.selected)?.name ?? '--',
        gadgetAmmo: this.gadgets.ammo.get(this.gadgets.selected) ?? 0,
        ...this.senseReadout(),
        districtName: this.city.districtAt(player.pos.x, player.pos.z).name,
        fps: this.fps,
        arenaLabel: this.websBlocked ? 'Boss fight — webs disabled' : null,
      },
      dt,
    );
  }

  // ------------------------------------------------------------- lifecycle

  private resize(): void {
    const width = window.innerWidth;
    const height = Math.max(1, window.innerHeight);
    this.renderer.setSize(width, height);
    this.renderer.setPixelRatio(
      Math.min(window.devicePixelRatio, this.qualityReduced ? 1 : CONFIG.render.maxPixelRatio),
    );
    this.chase.setAspect(width / height);
    this.speedLines.setAspect(width / height);
  }

  /** Drops shadows and pixel ratio if the frame rate stays under budget. */
  private trackPerformance(dt: number): void {
    if (this.qualityReduced || dt <= 0) return;
    this.fpsAccum += dt;
    this.fpsFrames++;
    if (this.fpsAccum < 1) return;

    const fps = this.fpsFrames / this.fpsAccum;
    this.fpsAccum = 0;
    this.fpsFrames = 0;

    if (fps < 45) {
      this.lowFpsStreak++;
      if (this.lowFpsStreak >= 3) {
        this.qualityReduced = true;
        this.renderer.shadowMap.enabled = false;
        this.renderer.setPixelRatio(1);
        this.scene.traverse((object) => {
          if (object instanceof THREE.Mesh) object.castShadow = false;
        });
        console.info('[web-swinger] Reduced quality: shadows off, pixel ratio 1.');
      }
    } else {
      this.lowFpsStreak = 0;
    }
  }
}
