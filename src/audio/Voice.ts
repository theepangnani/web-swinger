import { CONFIG } from '../core/Config';
import type { HeroId } from '../game/Heroes';
import { VoiceClips } from './VoiceClips';
import { STORY_LINES } from '../game/Story';

/**
 * Contextual barks.
 *
 * Two delivery paths, tried in order:
 *
 * 1. **Recorded clips.** If `public/voice/manifest.json` exists, lines are
 *    played from real audio files. This is the only way to get genuinely
 *    non-synthetic voices, and it is the path to use with anything like
 *    ElevenLabs — render the lines to files, drop them in, done. See
 *    `public/voice/README.md`.
 *
 * 2. **Speech synthesis.** The offline fallback, and what runs out of the box.
 *
 * The synthesiser's biggest tell is that every character sounds like the same
 * person, because every utterance uses the browser's one default voice. So the
 * pool of installed English voices is divided up and each speaker is assigned a
 * *different* one where the platform has enough of them, on top of per-speaker
 * pitch and rate profiles. It is still a synthesiser, but Venom and Black Cat
 * are no longer the same synthesiser.
 *
 * If speech is unavailable or muted, lines still surface as on-screen
 * subtitles, so the system degrades cleanly instead of going silent.
 */
export type VoiceEvent =
  | 'swing_start'
  | 'swing_chain'
  | 'high_speed'
  | 'big_fall'
  | 'hard_landing'
  | 'wall_crawl'
  | 'strike_hit'
  | 'combo'
  | 'villain_down'
  | 'hurt'
  | 'low_health'
  | 'ability'
  | 'swap'
  | 'all_clear'
  | 'idle'
  | 'ally_join'
  | 'ally_engage'
  | 'ally_downed'
  | 'ally_revived'
  | 'ally_kill'
  | 'ally_banter'
  | 'ally_ability';

type Bank = Record<VoiceEvent, readonly string[]>;

/** Peter: older, dry, tired, self-deprecating. */
const PETER: Bank = {
  swing_start: ['Okay. Back to work.', 'Line looks good.', 'Here we go again.'],
  swing_chain: ['Rhythm. Keep the rhythm.', 'There it is.', 'Smooth. Mostly.'],
  high_speed: ['Beats the subway.', 'Try getting a cab at this hour.', 'Now we are moving.'],
  big_fall: ['Nope. Nope. Nope.', 'This is fine. Everything is fine.', 'Web. Web. Any web.'],
  hard_landing: ['I felt that in my knees.', 'Stuck the landing. Barely.', 'Getting too old for that.'],
  wall_crawl: ['Just hanging around.', 'Nothing to see here.', 'Ignore the guy on the wall.'],
  strike_hit: ['Sorry! Not sorry.', 'That is going to leave a mark.', 'Sit down.'],
  combo: ['Still got it.', 'Okay, now I am showing off.', 'Do not get used to this.'],
  villain_down: ['Stay down. Please.', 'One less problem tonight.', 'That is the easy part done.'],
  hurt: ['Ow. Noted.', 'That one hurt my feelings too.', 'Bad idea. Understood.'],
  low_health: ['Running on fumes.', 'Regroup, Parker.', 'Not great. Not great at all.'],
  ability: ['Suit is running hot.', 'Everything I have got.', 'Let us end this quickly.'],
  swap: ['Your turn, kid.', 'Try not to break anything.', 'All yours.'],
  all_clear: ['City is quiet. For now.', 'That is all of them. Finally.', 'Go home, everybody.'],
  idle: ['Suspiciously quiet tonight.', 'I should be asleep.', 'Anyone need a hand? Anyone?'],
  ally_join: ['I heard. I came.', 'You are not doing this one alone.', 'Right behind you, kid.'],
  ally_engage: ['I have got this side.', 'Left is mine.', 'Go. I will hold them.'],
  ally_downed: ['Down. Give me a second.', 'I am up. I am up. Almost.', 'Do not wait for me.'],
  ally_revived: ['Back on my feet.', 'Told you. Second wind.', 'Right. Where were we.'],
  ally_kill: ['That is one.', 'Handled.', 'Next.'],
  ally_banter: [
    'You are getting good at this, you know.',
    'Aunt May would like this rooftop.',
    'Remind me to teach you the landing.',
  ],
  ally_ability: ['Hold still.', 'Pulling it down!', 'Not today.'],
};

/** Miles: younger, louder, more openly delighted by all of it. */
const MILES: Bank = {
  swing_start: ['Alright, alright!', 'Let us go!', 'Say less.'],
  swing_chain: ['Yes! Keep it going!', 'That is the one!', 'Locked in.'],
  high_speed: ['This never gets old!', 'Woooo!', 'Fastest kid in the city!'],
  big_fall: ['Not like this, not like this!', 'Somebody catch me!', 'Okay that is very far down!'],
  hard_landing: ['I am fine! I am fine.', 'Walked that one off.', 'Ow. Worth it.'],
  wall_crawl: ['Nobody look up.', 'Just chilling.', 'Wall guy. That is me.'],
  strike_hit: ['Got him!', 'That is what I am talking about!', 'Boom!'],
  combo: ['You seeing this?', 'Too easy!', 'I am cooking!'],
  villain_down: ['Down. Next.', 'That is one!', 'Told you.'],
  hurt: ['Okay, my bad!', 'That was on me.', 'Ow! Rude!'],
  low_health: ['I need a second.', 'Not good, not good.', 'Give me a minute here.'],
  ability: ['Charged up!', 'Everybody back up!', 'Watch this!'],
  swap: ['I got it from here.', 'Go rest, old man.', 'My turn!'],
  all_clear: ['We did it!', 'City is safe. For real this time.', 'That was all of them!'],
  idle: ['I should be doing homework.', 'Slow night, huh?', 'Somebody has to be up here.'],
  ally_join: ['You called, I came!', 'Two Spider-Men. Deal with it.', 'Okay, now it is a fight.'],
  ally_engage: ['I got these!', 'Mine! Mine!', 'Go, I am on it!'],
  ally_downed: ['Ah — down! Down!', 'Give me a sec, give me a sec!', 'I am okay! I am not okay.'],
  ally_revived: ['Back up!', 'That is not happening twice.', 'Okay. Round two.'],
  ally_kill: ['Got one!', 'Sit down!', 'That is mine!'],
  ally_banter: [
    'You ever think about how weird this all is?',
    'We should get a team name.',
    'Race you to the bridge after?',
  ],
  ally_ability: ['Venom blast!', 'Everybody down!', 'Lighting it up!'],
};

/**
 * Villain taunts, keyed by the enemy kind string.
 *
 * Symbiote Peter gets Peter's cadence with the warmth taken out — the line
 * reads as Peter until you notice what it says, which is the whole point of
 * that fight.
 */
const TAUNTS: Record<string, readonly string[]> = {
  VENOM: ['We see you.', 'Come closer.', 'You cannot outrun us.', 'We have been so hungry.'],
  'BLACK CAT': ['Try to keep up.', 'Too slow.', 'Catch me if you can.', 'You are fun. Briefly.'],
  ELECTRO: ['Feel that?', 'Light it up.', 'The whole grid is mine.', 'Everything is a conductor.'],
  'GREEN GOBLIN': ['Look up!', 'Catch this one.', 'Higher. Come on, higher.', 'Wonderful. Do it again.'],
  SANDMAN: [
    'I just keep coming back.',
    'You cannot hit what you cannot hold.',
    'Should have stayed home.',
    'I have got all night.',
  ],
  'SYMBIOTE PETER': [
    'I taught you this.',
    'You are pulling your punches. I am not.',
    'He is still in here. He is just quiet.',
    'Do not look at me like that, kid.',
  ],
};

/**
 * Every spoken line in the game, keyed by speaker then event.
 *
 * Exported so the offline clip renderer (`scripts/make-voices.mjs`) works from
 * exactly this data. The manifest it writes has to match these speaker keys,
 * these event keys and this line *ordering* — `VoiceClips.play` indexes the
 * recording by the line index the subtitle already chose, so a second copy of
 * the script kept in the tool would silently desynchronise voice from text the
 * first time a line was edited.
 *
 * Villains have taunts only, which all live under the `idle` event.
 */
export const VOICE_LINES: Record<string, Record<string, readonly string[]>> = withStory({
  PETER,
  MILES,
  ...Object.fromEntries(Object.entries(TAUNTS).map(([kind, lines]) => [kind, { idle: lines }])),
});

/**
 * Folds scripted story dialogue in as a `story` event on each speaker.
 *
 * The renderer walks speakers then events, so this is all it takes for a clip
 * pack to cover the campaign's written scenes as well as its barks — and the
 * ordering inside `STORY_LINES` is the same ordering `Voice.line` indexes by,
 * which is the property that keeps a recording matched to its subtitle.
 * Speakers who only ever appear in the story (Watanabe, Jameson, May) arrive
 * here with no bark bank at all, so the entry is created for them.
 */
function withStory(
  banks: Record<string, Record<string, readonly string[]>>,
): Record<string, Record<string, readonly string[]>> {
  for (const [speaker, lines] of Object.entries(STORY_LINES)) {
    banks[speaker] = { ...(banks[speaker] ?? {}), story: lines };
  }
  return banks;
}

/** Per-event cooldowns in seconds — chatty lines are throttled harder. */
const COOLDOWNS: Record<VoiceEvent, number> = {
  swing_start: 9,
  swing_chain: 14,
  high_speed: 16,
  big_fall: 10,
  hard_landing: 8,
  wall_crawl: 20,
  strike_hit: 3.5,
  combo: 7,
  villain_down: 1,
  hurt: 5,
  low_health: 14,
  ability: 1,
  swap: 1,
  all_clear: 1,
  idle: 45,
  ally_join: 1,
  ally_engage: 12,
  ally_downed: 1,
  ally_revived: 1,
  ally_kill: 6,
  ally_banter: 20,
  ally_ability: 5,
};

/**
 * Delivery profile per speaker.
 *
 * `prefer` is matched against installed voice names in order, so a platform
 * with a rich set gets a genuinely different voice per character and a
 * platform with one voice still works — it just falls back to pitch and rate
 * doing the separating.
 */
interface Profile {
  pitch: number;
  rate: number;
  /** Multiplies the master voice volume. */
  gain: number;
  prefer: readonly RegExp[];
  /** Variance applied per line, so delivery is not identical every time. */
  spread?: number;
}

const DEFAULT_PROFILE: Profile = { pitch: 1, rate: 1, gain: 1, prefer: [] };

const PROFILES: Record<string, Profile> = {
  PETER: { pitch: 0.92, rate: 1.0, gain: 1, prefer: [/guy|david|ryan|christopher|eric/i, /male/i] },
  MILES: { pitch: 1.22, rate: 1.08, gain: 1, prefer: [/mark|brandon|liam|alloy/i, /male/i] },
  VENOM: { pitch: 0.3, rate: 0.78, gain: 1, prefer: [/george|richard|davis|male/i], spread: 0.08 },
  'BLACK CAT': { pitch: 1.05, rate: 1.02, gain: 0.95, prefer: [/aria|jenny|zira|female|samantha/i] },
  ELECTRO: { pitch: 0.72, rate: 1.16, gain: 1, prefer: [/tony|jason|male/i], spread: 0.2 },
  'GREEN GOBLIN': { pitch: 1.35, rate: 1.1, gain: 1, prefer: [/steffan|roger|male/i], spread: 0.22 },
  SANDMAN: { pitch: 0.5, rate: 0.82, gain: 1, prefer: [/davis|guy|george|male/i], spread: 0.06 },
  // Peter's own profile, dropped a fifth and slowed. Same person, wrong.
  'SYMBIOTE PETER': { pitch: 0.62, rate: 0.9, gain: 1, prefer: [/guy|david|ryan|male/i], spread: 0.1 },

  // Story speakers. Nobody here throws a punch, so the shaping is about
  // separating a police radio from a podcast from a shouting newspaperman —
  // all three of which would otherwise arrive in the same default voice.
  MJ: { pitch: 1.0, rate: 1.04, gain: 1, prefer: [/michelle|eva|libby|female/i], spread: 0.1 },
  MAY: { pitch: 0.98, rate: 0.9, gain: 1, prefer: [/susan|hazel|catherine|female/i], spread: 0.07 },
  YURI: { pitch: 0.95, rate: 1.1, gain: 0.95, prefer: [/clara|nova|female/i], spread: 0.06 },
  JAMESON: { pitch: 0.8, rate: 1.22, gain: 1, prefer: [/george|guy|male/i], spread: 0.24 },
  GANKE: { pitch: 1.18, rate: 1.12, gain: 0.95, prefer: [/liam|brandon|male/i], spread: 0.14 },
  RIO: { pitch: 1.02, rate: 0.96, gain: 1, prefer: [/paloma|isabela|female/i], spread: 0.08 },
  DANIKA: { pitch: 1.12, rate: 1.14, gain: 0.9, prefer: [/aria|jenny|female/i], spread: 0.12 },
};

/**
 * The numeric half of each profile, for the offline renderer.
 *
 * `prefer` is a list of regular expressions matched against browser voices and
 * means nothing to a file-based synthesiser, but pitch and rate are exactly
 * the shaping a rendered clip should carry so the pack sounds like the game
 * rather than like eight readings of the same voice.
 */
export const VOICE_SHAPE: Record<string, { pitch: number; rate: number }> = Object.fromEntries(
  Object.entries(PROFILES).map(([speaker, p]) => [speaker, { pitch: p.pitch, rate: p.rate }]),
);

export class Voice {
  // Explicitly typed: CONFIG is `as const`, so the initialiser would otherwise
  // pin this field to the literal type `true`.
  enabled: boolean = CONFIG.voice.enabled;
  readonly supported: boolean;
  /** Overridden from the settings screen. */
  volume: number = CONFIG.voice.volume;

  /** Fires for every line, spoken or not, so the HUD can show a subtitle. */
  onSubtitle: ((speaker: string, text: string) => void) | null = null;
  /**
   * Fires when a line starts, so the caller can layer a procedural bed under
   * it — a sub-bass growl beneath Venom, a crackle beneath Electro. That
   * layering does more for "this is a monster talking" than any pitch shift.
   */
  onLine: ((speaker: string) => void) | null = null;

  private readonly clips = new VoiceClips();
  private hero: HeroId = 'PETER';
  private clock = 0;
  private globalReadyAt = 0;
  /**
   * Barks are suppressed until this time. A scripted scene is the one thing
   * that outranks everything else being said — a boss taunt landing in the
   * middle of a chapter's closing exchange reads as a bug, not as texture —
   * and the `force` flag deliberately does not get past it.
   */
  private holdUntil = 0;
  private readonly readyAt = new Map<string, number>();
  private lastText = '';
  /** Resolved SpeechSynthesisVoice per speaker, rebuilt when the list loads. */
  private readonly voiceFor = new Map<string, SpeechSynthesisVoice>();
  private readonly onVoicesChanged = (): void => this.assignVoices();

  constructor() {
    this.supported = typeof window !== 'undefined' && 'speechSynthesis' in window;
    if (!this.supported) return;
    // getVoices() is frequently empty until the engine finishes loading.
    this.assignVoices();
    window.speechSynthesis.addEventListener('voiceschanged', this.onVoicesChanged);
  }

  /** Starts the optional recorded-clip pack. Safe to call when absent. */
  async loadClips(): Promise<boolean> {
    return this.clips.load();
  }

  /** True once a recorded clip pack has been found and loaded. */
  get usingClips(): boolean {
    return this.clips.ready;
  }

  setHero(hero: HeroId): void {
    this.hero = hero;
  }

  update(dt: number): void {
    this.clock += dt;
  }

  /** Speaks a hero line if its cooldown has elapsed. Returns true if it fired. */
  say(event: VoiceEvent, force = false): boolean {
    return this.sayAs(this.hero, event, force);
  }

  /** Speaks as a specific hero — used for the ally's own lines. */
  sayAs(hero: HeroId, event: VoiceEvent, force = false): boolean {
    const bank = hero === 'MILES' ? MILES : PETER;
    return this.emit(`${hero}:${event}`, bank[event], COOLDOWNS[event], hero, event, force);
  }

  /** Speaks a villain taunt in that villain's own voice. */
  taunt(kind: string): boolean {
    const lines = TAUNTS[kind];
    if (!lines) return false;
    return this.emit(`villain:${kind}`, lines, 11, kind, 'idle', false);
  }

  /**
   * Speaks one scripted story line, as anybody.
   *
   * Unlike a bark this is never dropped: it is authored dialogue at an exact
   * point in the campaign, so it ignores cooldowns and instead pushes the bark
   * cooldown out ahead of itself. The subtitle is left to the caller, which
   * knows the speaker's display name and colour; `onLine` still fires so the
   * procedural voice bed layers under villains here too.
   *
   * `clip` is the line's index inside its speaker's story bank, so a recorded
   * pack plays the recording of *this* line rather than a different one.
   */
  line(
    speaker: string,
    text: string,
    clip: number,
    seconds: number,
    onDuration?: (seconds: number) => void,
  ): void {
    this.lastText = text;
    this.hold(seconds);
    if (!this.enabled) return;
    this.onLine?.(speaker);
    const profile = PROFILES[speaker] ?? DEFAULT_PROFILE;
    // The fallback is passed in as well as checked, because a clip can fail
    // asynchronously — the synchronous answer is only "a clip was dispatched".
    const speak = this.fallbackFor(text, speaker);
    // Whatever the recording actually runs for also becomes the bark hold, or
    // a bark fires over the tail of a line the estimate thought had finished.
    const learned = (actual: number): void => {
      this.hold(actual);
      onDuration?.(actual);
    };
    const played =
      clip >= 0 &&
      this.clips.play(speaker, 'story', clip, this.volume * profile.gain, speak, learned);
    if (!played) speak();
  }

  /** Suppresses barks for `seconds`. Scripted scenes hold the floor. */
  hold(seconds: number): void {
    const until = this.clock + seconds;
    if (until > this.holdUntil) this.holdUntil = until;
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    if (!enabled) this.stop();
  }

  toggle(): boolean {
    this.setEnabled(!this.enabled);
    return this.enabled;
  }

  stop(): void {
    if (this.supported) window.speechSynthesis.cancel();
    this.clips.stop();
    // Abandons any line still in flight. A clip that fails after this point
    // would otherwise reach its fallback and start speaking into a game that
    // has just been paused or muted; the fallback checks this against the line
    // it was created for, and no line is ever the empty string.
    this.lastText = '';
  }

  dispose(): void {
    this.clips.dispose();
    if (!this.supported) return;
    window.speechSynthesis.removeEventListener('voiceschanged', this.onVoicesChanged);
    this.stop();
  }

  // ---------------------------------------------------------------- private

  private emit(
    key: string,
    lines: readonly string[],
    cooldown: number,
    speaker: string,
    event: VoiceEvent,
    force: boolean,
  ): boolean {
    if (lines.length === 0) return false;
    // Checked before `force`, on purpose: nothing interrupts written dialogue.
    if (this.clock < this.holdUntil) return false;
    if (!force && this.clock < this.globalReadyAt) return false;
    if (!force && this.clock < (this.readyAt.get(key) ?? 0)) return false;

    const index = this.chooseIndex(lines);
    const text = lines[index]!;
    this.lastText = text;
    this.readyAt.set(key, this.clock + cooldown);
    this.globalReadyAt = this.clock + CONFIG.voice.globalCooldown;

    this.onSubtitle?.(speaker, text);
    if (this.enabled) {
      this.onLine?.(speaker);
      // A recorded clip always wins; synthesis is the fallback, not a layer.
      const profile = PROFILES[speaker] ?? DEFAULT_PROFILE;
      const speak = this.fallbackFor(text, speaker);
      const played = this.clips.play(speaker, event, index, this.volume * profile.gain, speak);
      if (!played) speak();
    }
    return true;
  }

  /**
   * The synthesis fallback for one line.
   *
   * Two things it has to get right, both of which only matter because a clip
   * can fail *after* the call that dispatched it has returned:
   *
   *  - Stop the clip channel first. Falling back does not otherwise silence a
   *    clip that is still playing, and the synthesiser would talk over it.
   *  - Say nothing if this line has been overtaken. `speak` cancels whatever
   *    the synthesiser is doing, so a late failure from an abandoned line
   *    would cut off the line that replaced it and read out the old one.
   */
  private fallbackFor(text: string, speaker: string): () => void {
    return () => {
      if (this.lastText !== text) return;
      this.clips.stop();
      if (this.supported) this.speak(text, speaker);
    };
  }

  /** Avoids repeating the line that played most recently. */
  private chooseIndex(lines: readonly string[]): number {
    if (lines.length === 1) return 0;
    for (let attempt = 0; attempt < 4; attempt++) {
      const candidate = Math.floor(Math.random() * lines.length);
      if (lines[candidate] !== this.lastText) return candidate;
    }
    return 0;
  }

  private speak(text: string, speaker: string): void {
    const profile = PROFILES[speaker] ?? DEFAULT_PROFILE;
    const utterance = new SpeechSynthesisUtterance(text);
    const voice = this.voiceFor.get(speaker);
    if (voice) utterance.voice = voice;
    utterance.volume = clampVolume(this.volume * profile.gain);

    // Flat, identical delivery every line is most of what makes synthesised
    // speech sound robotic. Small per-line variance in pitch and pace helps a
    // lot, even though it is still a synthesiser underneath.
    const spread = profile.spread ?? 0.13;
    const jitter = (): number => 1 + (Math.random() - 0.5) * spread;
    // Browsers clamp pitch to 0..2 and rate to 0.1..10; clamp here so an
    // aggressive profile plus jitter can never land outside and get ignored.
    utterance.pitch = clamp(profile.pitch * jitter(), 0.1, 2);
    utterance.rate = clamp(CONFIG.voice.rate * profile.rate * jitter(), 0.4, 3);

    // Barks are short and frequent; never let a queue build up.
    window.speechSynthesis.cancel();
    window.speechSynthesis.speak(utterance);
  }

  /**
   * Hands every speaker its own installed voice where possible.
   *
   * Each speaker takes the first match for its preference patterns that no
   * earlier speaker has claimed. Once the pool is exhausted, later speakers
   * share — with different pitch and rate, which is still a real separation.
   */
  private assignVoices(): void {
    if (!this.supported) return;
    const all = window.speechSynthesis.getVoices().filter((v) => v.lang.startsWith('en'));
    if (all.length === 0) return;

    this.voiceFor.clear();
    const claimed = new Set<SpeechSynthesisVoice>();

    // Prefer the higher-quality network/neural voices the platform exposes —
    // they are markedly less flat than the default local ones.
    const quality = (v: SpeechSynthesisVoice): number =>
      /natural|neural|online/i.test(v.name) ? 0 : v.localService ? 1 : 2;
    const pool = [...all].sort((a, b) => quality(a) - quality(b));

    for (const [speaker, profile] of Object.entries(PROFILES)) {
      let picked: SpeechSynthesisVoice | undefined;
      for (const pattern of profile.prefer) {
        picked = pool.find((v) => !claimed.has(v) && pattern.test(v.name));
        if (picked) break;
      }
      picked ??= pool.find((v) => !claimed.has(v)) ?? pool[0];
      if (!picked) continue;
      claimed.add(picked);
      this.voiceFor.set(speaker, picked);
    }
  }
}

function clampVolume(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}
