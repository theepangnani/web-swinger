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

/**
 * A clip, and how long it runs.
 *
 * A bare string is still accepted, because a hand-assembled pack should not
 * have to state durations it does not know — but a generated one always does,
 * and that is what stops a line being cut off. Without it the only source of
 * truth is a word-count guess, which measured 9% of the pack short.
 */
type Entry = string | { readonly path: string; readonly seconds?: number };

type Manifest = Record<string, Record<string, readonly Entry[]>>;

function entryPath(entry: Entry): string {
  return typeof entry === 'string' ? entry : entry.path;
}

function entrySeconds(entry: Entry): number {
  return typeof entry === 'string' ? 0 : (entry.seconds ?? 0);
}

export class VoiceClips {
  /** True once a manifest has been found and at least one clip registered. */
  ready = false;

  private manifest: Manifest | null = null;
  private readonly cache = new Map<string, HTMLAudioElement>();
  private current: HTMLAudioElement | null = null;
  private attempted = false;
  /**
   * Clips that have failed to play once and will not be tried again.
   *
   * A file that is missing, truncated or in a codec this browser will not
   * decode fails the same way every time, and retrying it on every line adds a
   * failed network round trip in front of every fallback.
   */
  private readonly broken = new Set<string>();

  /**
   * How many decoded clips to keep.
   *
   * The pack is 584 lines. Caching every one that has ever played means, by
   * the end of a long session, 584 media elements each holding decoded audio —
   * megabytes of PCM sitting behind a game that is already the largest thing
   * on the GPU. Sixty-four is far more than the working set of any one scene,
   * so in practice nothing is ever re-fetched, and the ceiling is bounded.
   */
  private static readonly CACHE_LIMIT = 64;

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
   *
   * Returning true means "a clip was dispatched", which is not the same as
   * "a clip was heard": `play()` on a media element is asynchronous and can
   * reject long after this returns. The caller uses the return value to decide
   * whether to fall back to synthesis, so a rejection has to reach it somehow
   * — hence `onFailure`, which fires when the dispatch turns out to have
   * failed. Without it, one unplayable file meant that line was simply silent,
   * with the fallback sitting right there unused.
   */
  play(
    speaker: string,
    event: string,
    index: number,
    volume: number,
    onFailure?: () => void,
    onDuration?: (seconds: number) => void,
  ): boolean {
    if (!this.ready || !this.manifest) return false;
    const paths = this.manifest[speaker]?.[event];
    if (!paths || paths.length === 0) return false;

    const entry = paths[index % paths.length]!;
    const path = entryPath(entry);
    // Known bad: say so now, so the caller synthesises immediately rather than
    // after a round trip that is going to fail again.
    if (this.broken.has(path)) return false;

    let audio = this.cache.get(path);
    if (audio) {
      // Re-insert so Map iteration order stays least-recently-used first.
      this.cache.delete(path);
    } else {
      audio = new Audio(CLIP_BASE + path);
      audio.preload = 'auto';
      this.evictIfFull();
    }
    this.cache.set(path, audio);

    // Barks are short and frequent; never let two overlap.
    this.stop();
    audio.volume = volume < 0 ? 0 : volume > 1 ? 1 : volume;
    audio.currentTime = 0;
    this.current = audio;
    // The manifest's own figure first, because it is exact and available now.
    // Failing that, the element's, as soon as it knows — a pack assembled by
    // hand has no durations in it, and guessing from word count is what put
    // 9% of the generated pack's lines on screen for less time than they took
    // to say.
    const stated = entrySeconds(entry);
    if (stated > 0) {
      onDuration?.(stated);
    } else if (onDuration) {
      const report = (): void => {
        if (Number.isFinite(audio.duration) && audio.duration > 0) onDuration(audio.duration);
      };
      // Guarded because this is a side errand: the line is already playing, and
      // an exception raised while asking how long it runs would abandon it.
      try {
        if (audio.readyState >= 1) report();
        else audio.addEventListener('loadedmetadata', report, { once: true });
      } catch {
        // No duration available. The estimate stands.
      }
    }

    const dispatched = audio;
    void audio.play().catch(() => {
      // Only stand down if nothing else has started in the meantime; a bark
      // that arrived while this one was failing owns the channel now, and
      // clearing `current` would leak it past the next stop().
      if (this.current === dispatched) this.current = null;
      this.broken.add(path);
      console.warn(`[voice] clip failed, falling back to synthesis: ${path}`);
      onFailure?.();
    });
    return true;
  }

  /**
   * Drops the least recently used clips until there is room for one more.
   *
   * Never evicts what is currently playing: releasing its source mid-line is
   * the one eviction the player would actually hear.
   */
  private evictIfFull(): void {
    if (this.cache.size < VoiceClips.CACHE_LIMIT) return;
    for (const [key, element] of this.cache) {
      if (element === this.current) continue;
      element.pause();
      // Detaching the source is what actually lets the decoded audio go; a
      // dropped reference alone leaves the element alive until collection.
      element.removeAttribute('src');
      element.load();
      this.cache.delete(key);
      if (this.cache.size < VoiceClips.CACHE_LIMIT) return;
    }
  }

  stop(): void {
    if (!this.current) return;
    this.current.pause();
    this.current.currentTime = 0;
    this.current = null;
  }

  dispose(): void {
    this.stop();
    this.broken.clear();
    this.cache.clear();
    this.manifest = null;
    this.ready = false;
  }
}
