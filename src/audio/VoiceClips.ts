/**
 * Optional recorded voice lines.
 *
 * Speech synthesis is the offline fallback and always will be — it ships with
 * the browser and needs no assets. But no amount of pitch shaping makes it
 * stop sounding synthesised, so this is the escape hatch: drop real audio
 * files in `public/voice/` with a manifest, and every line that has a
 * recording plays the recording instead.
 *
 * The manifest is looked up once at boot. Absence is the normal case and fails
 * silently, so the game is unchanged for anyone who never adds one.
 *
 * Format — `public/voice/manifest.json`:
 *
 *     {
 *       "PETER":  { "swing_start": ["peter/swing-1.mp3", "peter/swing-2.mp3"] },
 *       "VENOM":  { "idle":        ["venom/taunt-1.mp3"] }
 *     }
 *
 * Speaker keys match the subtitle speaker exactly — `PETER`, `MILES`,
 * `VENOM`, `BLACK CAT`, `ELECTRO`, `GREEN GOBLIN`, `SANDMAN`,
 * `SYMBIOTE PETER`. Villain taunts all live under the `idle` event. Paths are
 * relative to `public/voice/`. Any line you do not record simply falls back to
 * synthesis, so a partial pack is fine.
 */

const MANIFEST_URL = './voice/manifest.json';
const CLIP_BASE = './voice/';

type Manifest = Record<string, Record<string, readonly string[]>>;

export class VoiceClips {
  /** True once a manifest has been found and at least one clip registered. */
  ready = false;

  private manifest: Manifest | null = null;
  private readonly cache = new Map<string, HTMLAudioElement>();
  private current: HTMLAudioElement | null = null;
  private attempted = false;

  /** Looks for a clip pack. Returns whether one was found. */
  async load(): Promise<boolean> {
    if (this.attempted) return this.ready;
    this.attempted = true;

    try {
      const response = await fetch(MANIFEST_URL, { cache: 'force-cache' });
      if (!response.ok) return false;
      const parsed = (await response.json()) as Manifest;
      if (!parsed || typeof parsed !== 'object') return false;
      this.manifest = parsed;
      this.ready = Object.keys(parsed).length > 0;
      return this.ready;
    } catch {
      // No pack, offline, or malformed JSON. Synthesis handles everything.
      return false;
    }
  }

  /**
   * Plays the clip for a line if one exists.
   *
   * `index` is the line index the caller already chose, so the recording
   * matches the subtitle rather than being picked independently.
   */
  play(speaker: string, event: string, index: number, volume: number): boolean {
    if (!this.ready || !this.manifest) return false;
    const paths = this.manifest[speaker]?.[event];
    if (!paths || paths.length === 0) return false;

    const path = paths[index % paths.length]!;
    let audio = this.cache.get(path);
    if (!audio) {
      audio = new Audio(CLIP_BASE + path);
      audio.preload = 'auto';
      this.cache.set(path, audio);
    }

    // Barks are short and frequent; never let two overlap.
    this.stop();
    audio.volume = volume < 0 ? 0 : volume > 1 ? 1 : volume;
    audio.currentTime = 0;
    this.current = audio;
    // A missing or unplayable file must not break the line — the subtitle has
    // already been shown either way.
    void audio.play().catch(() => {
      this.current = null;
    });
    return true;
  }

  stop(): void {
    if (!this.current) return;
    this.current.pause();
    this.current.currentTime = 0;
    this.current = null;
  }

  dispose(): void {
    this.stop();
    this.cache.clear();
    this.manifest = null;
    this.ready = false;
  }
}
