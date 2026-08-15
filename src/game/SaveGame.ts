import type { HeroId } from './Heroes';
import type { GameModeId } from './GameMode';
import type { ProgressionSave } from './Progression';

/**
 * Persistent campaign save, stored in localStorage alongside the settings.
 *
 * Deliberately plain data: no Three.js objects, no class instances, so the
 * whole thing round-trips through JSON without custom serialisers.
 */
export interface SaveData {
  /** Bumped when the shape changes; older saves are discarded. */
  version: number;
  mode: GameModeId;
  progression: ProgressionSave;
  heroId: HeroId;
  suitByHero: Record<string, string>;
  crimesCleared: number;
  villainsSurfaced: number;
  defeatedVillains: string[];
  /**
   * Every crime and defeat in order — what the campaign actually replays.
   * Optional because saves written before it existed are migrated on load.
   */
  storyLog?: string[];
  /** Seconds of wall-clock play, for the title screen. */
  playtime: number;
  /** Position on the day/night clock, 0..1, so the sky is where you left it. */
  timeOfDay: number;
  /** Post-game wave reached, 0 during the campaign. */
  postgameTier: number;
  savedAt: number;
}

const STORAGE_KEY = 'web-swinger.save.v1';
// v2: added timeOfDay, and the campaign was restructured into seven books, so
// a v1 chapter index no longer means the same thing. Older saves are dropped.
const CURRENT_VERSION = 2;

export class SaveGame {
  /** Reads the stored save, or null if absent, corrupt or outdated. */
  static load(): SaveData | null {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return null;
      const parsed = JSON.parse(raw) as Partial<SaveData>;
      if (parsed.version !== CURRENT_VERSION) return null;
      if (!parsed.progression || !parsed.mode) return null;

      return {
        version: CURRENT_VERSION,
        mode: parsed.mode,
        progression: parsed.progression,
        heroId: parsed.heroId === 'MILES' ? 'MILES' : 'PETER',
        suitByHero: parsed.suitByHero ?? {},
        crimesCleared: numberOr(parsed.crimesCleared, 0),
        villainsSurfaced: numberOr(parsed.villainsSurfaced, 0),
        defeatedVillains: Array.isArray(parsed.defeatedVillains) ? parsed.defeatedVillains : [],
        // Left undefined rather than defaulted to [], so the loader can tell
        // "an old save with no log" from "a new save with an empty one".
        storyLog: Array.isArray(parsed.storyLog) ? parsed.storyLog : undefined,
        playtime: numberOr(parsed.playtime, 0),
        timeOfDay: numberOr(parsed.timeOfDay, 0.78),
        postgameTier: numberOr(parsed.postgameTier, 0),
        savedAt: numberOr(parsed.savedAt, 0),
      };
    } catch {
      // Corrupt JSON or storage disabled — treat as no save.
      return null;
    }
  }

  static save(data: Omit<SaveData, 'version' | 'savedAt'>, now: number): boolean {
    try {
      const payload: SaveData = { ...data, version: CURRENT_VERSION, savedAt: now };
      localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
      return true;
    } catch {
      // Private browsing or quota exceeded: play on, just without persistence.
      return false;
    }
  }

  static clear(): void {
    try {
      localStorage.removeItem(STORAGE_KEY);
    } catch {
      // Nothing to do — storage is unavailable either way.
    }
  }

  static exists(): boolean {
    return SaveGame.load() !== null;
  }

  /** "Lv 7 · 2 villains down · 14m" for the Continue button. */
  static summary(data: SaveData): string {
    const minutes = Math.floor(data.playtime / 60);
    const time = minutes >= 60 ? `${Math.floor(minutes / 60)}h ${minutes % 60}m` : `${minutes}m`;
    const villains = data.defeatedVillains.length;
    const label =
      data.postgameTier > 0
        ? `Siege T${data.postgameTier}`
        : data.mode === 'STORY'
          ? 'Story'
          : 'Free Roam';
    return `${label} · Lv ${data.progression.level} · ${villains} villain${villains === 1 ? '' : 's'} down · ${time}`;
  }
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}
