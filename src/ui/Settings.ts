/**
 * Player-adjustable settings, persisted to localStorage.
 *
 * Keeps no Three.js or DOM references so it can be read from anywhere; the
 * panel that edits it lives in SettingsPanel.ts.
 */

export type BindableAction =
  | 'moveForward'
  | 'moveBack'
  | 'moveLeft'
  | 'moveRight'
  | 'swing'
  | 'sprint'
  | 'climb'
  | 'gadget'
  | 'focus'
  | 'heal'
  | 'ability'
  | 'swap'
  | 'skills'
  | 'mute';

export const ACTION_LABELS: Record<BindableAction, string> = {
  moveForward: 'Move forward / reel in',
  moveBack: 'Move back / pay out line',
  moveLeft: 'Move left',
  moveRight: 'Move right',
  swing: 'Web swing / jump',
  sprint: 'Sprint (ground) / glide (air)',
  climb: 'Let go of wall (walls grab automatically)',
  gadget: 'Throw gadget',
  focus: 'Finisher (full Focus bar)',
  heal: 'Heal (full Focus bar)',
  ability: 'Special ability',
  swap: 'Swap hero',
  skills: 'Skill screen',
  mute: 'Mute voice barks',
};

/** Secondary bindings that are always active alongside the primary ones. */
export const ALWAYS_BOUND: Partial<Record<BindableAction, readonly string[]>> = {
  moveForward: ['ArrowUp'],
  moveBack: ['ArrowDown'],
  moveLeft: ['ArrowLeft'],
  moveRight: ['ArrowRight'],
};

/**
 * Difficulty scales incoming damage only.
 *
 * Deliberately not enemy health: draining a boss's health bar to make a fight
 * easier just makes it shorter, and the complaint about bosses has always been
 * that they fall over too fast. What actually varies between players is how
 * much punishment they can absorb while learning a moveset.
 */
export type DifficultyId = 'FRIENDLY' | 'NORMAL' | 'BRUTAL';

export const DIFFICULTIES: Record<DifficultyId, { label: string; damageTaken: number; blurb: string }> = {
  FRIENDLY: { label: 'Friendly', damageTaken: 0.6, blurb: 'You take 40% less damage.' },
  NORMAL: { label: 'Normal', damageTaken: 1, blurb: 'As designed.' },
  BRUTAL: { label: 'Brutal', damageTaken: 1.6, blurb: 'You take 60% more damage.' },
};

export interface SettingsData {
  /** Multiplier applied to the base mouse sensitivity. */
  mouseSensitivity: number;
  /** Multiplier applied to gamepad stick look speed. */
  stickSensitivity: number;
  invertY: boolean;
  /** Base vertical field of view, degrees. */
  fov: number;
  /** Master switch for spoken barks. */
  barks: boolean;
  /** Speech volume, 0..1. */
  barkVolume: number;
  /** Procedural sound effects. */
  sfx: boolean;
  sfxVolume: number;
  shadows: boolean;
  /** Screen-space speed lines. */
  speedLines: boolean;
  /** Trim on the day/night lighting, 0.8..1.6. Monitors vary a lot. */
  brightness: number;
  difficulty: DifficultyId;
  bindings: Record<BindableAction, string>;
}

export const DEFAULT_BINDINGS: Record<BindableAction, string> = {
  moveForward: 'KeyW',
  moveBack: 'KeyS',
  moveLeft: 'KeyA',
  moveRight: 'KeyD',
  swing: 'Space',
  sprint: 'ShiftLeft',
  climb: 'ControlLeft',
  gadget: 'KeyG',
  focus: 'KeyF',
  heal: 'KeyH',
  ability: 'KeyQ',
  swap: 'Tab',
  skills: 'KeyK',
  mute: 'KeyM',
};

const DEFAULTS: SettingsData = {
  mouseSensitivity: 1,
  stickSensitivity: 1,
  invertY: false,
  fov: 62,
  barks: true,
  barkVolume: 0.9,
  sfx: true,
  sfxVolume: 0.7,
  shadows: true,
  speedLines: true,
  brightness: 1,
  difficulty: 'NORMAL',
  bindings: { ...DEFAULT_BINDINGS },
};

const STORAGE_KEY = 'web-swinger.settings.v1';

export class Settings {
  readonly data: SettingsData;
  /** Raised after any change, so systems can re-read what they care about. */
  onChange: (() => void) | null = null;

  constructor() {
    this.data = { ...DEFAULTS, bindings: { ...DEFAULT_BINDINGS } };
    this.load();
  }

  /** Human-readable name for a KeyboardEvent.code. */
  static keyLabel(code: string): string {
    if (!code) return '—';
    if (code.startsWith('Key')) return code.slice(3);
    if (code.startsWith('Digit')) return code.slice(5);
    if (code.startsWith('Arrow')) return code.slice(5) + ' Arrow';
    const named: Record<string, string> = {
      Space: 'Space',
      ShiftLeft: 'L Shift',
      ShiftRight: 'R Shift',
      ControlLeft: 'L Ctrl',
      ControlRight: 'R Ctrl',
      AltLeft: 'L Alt',
      AltRight: 'R Alt',
      Tab: 'Tab',
      Escape: 'Esc',
      Enter: 'Enter',
      Backquote: '`',
    };
    return named[code] ?? code;
  }

  binding(action: BindableAction): string {
    return this.data.bindings[action];
  }

  /**
   * Rebinds an action. Any other action already using that key is cleared, so
   * a key never drives two things at once.
   */
  rebind(action: BindableAction, code: string): void {
    for (const key of Object.keys(this.data.bindings) as BindableAction[]) {
      if (key !== action && this.data.bindings[key] === code) {
        this.data.bindings[key] = '';
      }
    }
    this.data.bindings[action] = code;
    this.commit();
  }

  set<K extends keyof SettingsData>(key: K, value: SettingsData[K]): void {
    this.data[key] = value;
    this.commit();
  }

  reset(): void {
    Object.assign(this.data, DEFAULTS, { bindings: { ...DEFAULT_BINDINGS } });
    this.commit();
  }

  commit(): void {
    this.save();
    this.onChange?.();
  }

  private load(): void {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw) as Partial<SettingsData>;
      Object.assign(this.data, parsed);
      // Merge bindings so a newly added action still gets its default.
      this.data.bindings = { ...DEFAULT_BINDINGS, ...(parsed.bindings ?? {}) };
    } catch {
      // Corrupt or unavailable storage: silently keep defaults.
    }
  }

  private save(): void {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(this.data));
    } catch {
      // Private browsing / quota: settings just won't persist.
    }
  }
}
