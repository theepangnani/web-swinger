import * as THREE from 'three';
import { CONFIG } from '../core/Config';

/**
 * Day/night cycle.
 *
 * Time is a single number in 0..1 where 0 is midnight and 0.5 is noon, and
 * everything else — sun direction, sun colour, sky, fog, ambient and exposure —
 * is derived from it by interpolating a short keyframe table.
 *
 * The interesting balance is against the city's window textures, which are
 * baked emissive and therefore a fixed brightness. Night used to be made by
 * pulling ambient and exposure down until those windows were the brightest
 * thing on screen, which is atmospheric right up to the point where you cannot
 * see the enemy you are fighting. It is carried by hue and contrast instead
 * now — cold blue key, lifted ground bounce — so a night fight is legible at
 * the default trim on a dim monitor.
 */

export type TimeOfDay = 'DAWN' | 'DAY' | 'DUSK' | 'NIGHT';

/** Where each named time sits on the 0..1 clock. */
export const TIME_OF_DAY: Record<TimeOfDay, number> = {
  DAWN: 0.27,
  DAY: 0.5,
  DUSK: 0.78,
  NIGHT: 0.94,
};

interface SkyKey {
  /** Clock position, ascending. */
  t: number;
  sky: number;
  fog: number;
  fogDensity: number;
  sun: number;
  sunIntensity: number;
  hemiSky: number;
  hemiGround: number;
  hemiIntensity: number;
  /** Tone mapping exposure — the main dial for "is it dark out". */
  exposure: number;
}

/**
 * Keyframes, midnight to midnight. The table wraps, so the last entry must
 * describe the same conditions as the first.
 */
const KEYS: readonly SkyKey[] = [
  {
    t: 0, // midnight
    sky: 0x1d2c4a, fog: 0x243456, fogDensity: 0.00062,
    sun: 0xcadaf9, sunIntensity: 1.35,
    hemiSky: 0x5c7fb8, hemiGround: 0x2b3242, hemiIntensity: 1.35,
    exposure: 1.34,
  },
  {
    t: 0.21, // the hour before dawn — the coldest of it
    sky: 0x1f2f50, fog: 0x26375c, fogDensity: 0.00065,
    sun: 0xc2d4f5, sunIntensity: 1.3,
    hemiSky: 0x5d82bc, hemiGround: 0x2a3040, hemiIntensity: 1.32,
    exposure: 1.33,
  },
  {
    t: 0.28, // sunrise
    sky: 0x8a6f82, fog: 0xa07a76, fogDensity: 0.00082,
    sun: 0xffc89a, sunIntensity: 2.15,
    hemiSky: 0xb08ea6, hemiGround: 0x40343f, hemiIntensity: 1.32,
    exposure: 1.38,
  },
  {
    t: 0.36, // morning
    sky: 0x9dc0e8, fog: 0xbcd7ee, fogDensity: 0.00068,
    sun: 0xffecd4, sunIntensity: 2.9,
    hemiSky: 0xb2d2ee, hemiGround: 0x56503f, hemiIntensity: 1.4,
    exposure: 1.42,
  },
  {
    t: 0.5, // noon
    sky: 0xa8cff3, fog: 0xcbe1f5, fogDensity: 0.00054,
    sun: 0xfff8ec, sunIntensity: 3.35,
    hemiSky: 0xbcdef8, hemiGround: 0x5d5544, hemiIntensity: 1.5,
    exposure: 1.44,
  },
  {
    t: 0.66, // late afternoon
    sky: 0xa0c6ea, fog: 0xccdaea, fogDensity: 0.0006,
    sun: 0xffe8c8, sunIntensity: 3.1,
    hemiSky: 0xb2d1ef, hemiGround: 0x5a5040, hemiIntensity: 1.4,
    exposure: 1.42,
  },
  {
    t: 0.76, // golden hour — the game's best-looking window, so it is wide
    sky: 0xe8a875, fog: 0xe39d63, fogDensity: 0.00078,
    sun: 0xffb268, sunIntensity: 3.2,
    hemiSky: 0xdb9d7a, hemiGround: 0x4b3a2c, hemiIntensity: 1.3,
    exposure: 1.43,
  },
  {
    t: 0.82, // sunset
    sky: 0xa06a7c, fog: 0xb87671, fogDensity: 0.0008,
    sun: 0xff9366, sunIntensity: 2.4,
    hemiSky: 0xac7188, hemiGround: 0x362833, hemiIntensity: 1.28,
    exposure: 1.4,
  },
  {
    t: 0.88, // dusk — the default the game shipped with
    sky: 0x2b3d5e, fog: 0x374a6a, fogDensity: 0.0006,
    sun: 0xffe6c4, sunIntensity: 1.8,
    hemiSky: 0x6f96cc, hemiGround: 0x262c3a, hemiIntensity: 1.36,
    exposure: 1.37,
  },
  {
    t: 1, // wraps to midnight; must match the first entry
    sky: 0x1d2c4a, fog: 0x243456, fogDensity: 0.00062,
    sun: 0xcadaf9, sunIntensity: 1.35,
    hemiSky: 0x5c7fb8, hemiGround: 0x2b3242, hemiIntensity: 1.35,
    exposure: 1.34,
  },
];

/** Distance the sun/moon is placed from the player. */
const LIGHT_DISTANCE = 420;

const _a = new THREE.Color();
const _b = new THREE.Color();

export class DayNight {
  /** 0..1, midnight to midnight. */
  time: number = CONFIG.dayNight.startTime;
  /**
   * Player brightness trim, applied on top of the time of day.
   *
   * How dark "dark" reads varies enormously between monitors, and a night
   * cycle you cannot see the enemies in is not atmospheric, it is broken. The
   * table above is tuned so 1.0 is already comfortable; this is the trim.
   */
  brightness = 1;
  /** Set to ease toward a chapter's pinned time instead of running free. */
  private pinned: number | null = null;

  private readonly sun: THREE.DirectionalLight;
  private readonly hemi: THREE.HemisphereLight;
  private readonly scene: THREE.Scene;
  private readonly renderer: THREE.WebGLRenderer;
  private readonly skyColor = new THREE.Color();
  private readonly fogColor = new THREE.Color();
  private readonly offset = new THREE.Vector3();

  constructor(
    scene: THREE.Scene,
    renderer: THREE.WebGLRenderer,
    sun: THREE.DirectionalLight,
    hemi: THREE.HemisphereLight,
  ) {
    this.scene = scene;
    this.renderer = renderer;
    this.sun = sun;
    this.hemi = hemi;
  }

  /** Jumps straight to a time — used when a mode or save sets the clock. */
  setTime(t: number): void {
    this.time = wrap(t);
    this.pinned = null;
  }

  /**
   * Eases toward a named time, then hands the clock back to the cycle.
   *
   * Story chapters set the clock so a scene written for the dark starts in the
   * dark, however long the player took to get there. The pin is a *starting*
   * time, not a hold: every chapter names one, so a pin that persisted meant
   * the cycle ran exactly once — into the first chapter's sky — and then froze
   * for the rest of the game. Releasing on arrival keeps both properties: the
   * scene opens when it was written to, and time still passes.
   */
  pin(time: TimeOfDay | null): void {
    this.pinned = time === null ? null : TIME_OF_DAY[time];
  }

  get isNight(): boolean {
    return this.time < 0.25 || this.time > 0.83;
  }

  /** 24-hour clock, for the HUD. */
  get clockLabel(): string {
    const minutes = Math.floor(this.time * 24 * 60);
    const h = Math.floor(minutes / 60) % 24;
    const m = minutes % 60;
    return `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}`;
  }

  update(dt: number, focus: THREE.Vector3): void {
    if (this.pinned !== null) {
      // Take the short way round the clock, so pinning to night from early
      // morning runs backwards through the evening rather than fast-forwarding
      // through a whole day.
      let delta = this.pinned - this.time;
      if (delta > 0.5) delta -= 1;
      if (delta < -0.5) delta += 1;
      // Exponential easing never actually arrives, so it has to be cut off, or
      // the pin would hold forever by a rounding margin and the clock would
      // still be frozen. Snap and release inside a few in-game minutes.
      if (Math.abs(delta) <= CONFIG.dayNight.pinArrival) {
        this.time = wrap(this.pinned);
        this.pinned = null;
      } else {
        this.time = wrap(this.time + delta * (1 - Math.exp(-CONFIG.dayNight.pinLambda * dt)));
      }
    } else if (CONFIG.dayNight.enabled) {
      this.time = wrap(this.time + dt / CONFIG.dayNight.cycleSeconds);
    }

    this.apply(focus);
  }

  /** Recomputes every derived value from the current time. */
  private apply(focus: THREE.Vector3): void {
    const { lower, upper, mix } = bracket(this.time);

    _a.setHex(lower.sky);
    _b.setHex(upper.sky);
    this.skyColor.copy(_a).lerp(_b, mix);
    if (this.scene.background instanceof THREE.Color) this.scene.background.copy(this.skyColor);

    _a.setHex(lower.fog);
    _b.setHex(upper.fog);
    this.fogColor.copy(_a).lerp(_b, mix);
    if (this.scene.fog instanceof THREE.FogExp2) {
      this.scene.fog.color.copy(this.fogColor);
      this.scene.fog.density = lerp(lower.fogDensity, upper.fogDensity, mix);
    }

    _a.setHex(lower.sun);
    _b.setHex(upper.sun);
    this.sun.color.copy(_a).lerp(_b, mix);
    const gain = this.brightness;
    this.sun.intensity = lerp(lower.sunIntensity, upper.sunIntensity, mix) * gain;

    _a.setHex(lower.hemiSky);
    _b.setHex(upper.hemiSky);
    this.hemi.color.copy(_a).lerp(_b, mix);
    _a.setHex(lower.hemiGround);
    _b.setHex(upper.hemiGround);
    this.hemi.groundColor.copy(_a).lerp(_b, mix);
    this.hemi.intensity = lerp(lower.hemiIntensity, upper.hemiIntensity, mix) * gain;

    this.renderer.toneMappingExposure = lerp(lower.exposure, upper.exposure, mix) * gain;

    // --- sun position ------------------------------------------------------
    // Rises in the east (+X), sets in the west (-X), with a tilt north so the
    // shadows are never perfectly axis-aligned with the street grid.
    const angle = (this.time - 0.25) * Math.PI * 2;
    const elevation = Math.sin(angle);
    const east = Math.cos(angle);

    // Below the horizon the rig becomes the moon, so night still has a
    // shadow-casting key light instead of a flat, shadowless city.
    //
    // It only floors the height. Mirroring the whole direction (the obvious
    // way to do this) reverses `east` as it crosses the horizon, which snapped
    // the light — and every shadow in the city — from due west to due east in
    // a single frame, twice per cycle. Flooring keeps the arc continuous: the
    // light carries on sweeping west, across the north at night, and back
    // round to the east by dawn.
    this.offset.set(east * 0.75, Math.max(0.22, elevation), -0.35).normalize();
    this.sun.position.copy(focus).addScaledVector(this.offset, LIGHT_DISTANCE);
    this.sun.target.position.copy(focus);
    this.sun.target.updateMatrixWorld();
  }
}

function wrap(t: number): number {
  return ((t % 1) + 1) % 1;
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/** The two keyframes surrounding `t`, and how far between them it is. */
function bracket(t: number): { lower: SkyKey; upper: SkyKey; mix: number } {
  for (let i = 0; i < KEYS.length - 1; i++) {
    const lower = KEYS[i]!;
    const upper = KEYS[i + 1]!;
    if (t >= lower.t && t <= upper.t) {
      const span = upper.t - lower.t;
      return { lower, upper, mix: span > 1e-6 ? (t - lower.t) / span : 0 };
    }
  }
  // Only reachable for t outside 0..1, which wrap() prevents.
  return { lower: KEYS[0]!, upper: KEYS[0]!, mix: 0 };
}
