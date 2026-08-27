/**
 * The recorded-clip layer, which fails silently in every direction.
 *
 * A pack that plays is invisible; a pack that half-plays is worse than none,
 * because one line goes quiet while the lines around it do not and nothing
 * anywhere says why. Every case here is one of those:
 *
 *  - `play()` answers synchronously but a media element rejects asynchronously,
 *    so "a clip was dispatched" was being read as "a clip was heard" and the
 *    synthesis fallback sat unused.
 *  - A clip that fails once fails every time, so retrying it puts a doomed
 *    network round trip in front of every fallback.
 *  - The element cache grew without bound: 584 lines, each holding decoded
 *    audio, behind a game that is already the biggest thing on the GPU.
 *
 * Runs against the real `VoiceClips` with `Audio` and `fetch` stubbed, because
 * the logic under test is entirely about what happens around those two.
 */
import { bundle } from './_bundle.mjs';

let problems = 0;
const fail = (msg) => {
  problems++;
  console.log('  FAIL ' + msg);
};
const ok = (msg) => console.log('  ok — ' + msg);

// --- stubs ----------------------------------------------------------------

/** Every element the code under test has created, in order. */
const built = [];
/** Paths whose play() should reject, standing in for a missing file. */
const rejects = new Set();

class FakeAudio {
  constructor(src) {
    this.src = src;
    this.volume = 1;
    this.currentTime = 0;
    this.preload = '';
    this.plays = 0;
    this.paused = true;
    this.ended = false;
    this.pauses = 0;
    this.loads = 0;
    built.push(this);
  }
  play() {
    this.plays++;
    this.paused = false;
    // The real element resolves or rejects a turn later; that gap is the whole
    // reason the fallback cannot be decided from the return value.
    return this.src && [...rejects].some((r) => this.src.endsWith(r))
      ? Promise.reject(new Error('NotSupportedError'))
      : Promise.resolve();
  }
  pause() {
    this.pauses++;
    this.paused = true;
  }
  load() {
    this.loads++;
  }
  removeAttribute(name) {
    if (name === 'src') this.src = '';
  }
  // Real media elements have these. The stub needs them because VoiceClips
  // asks an element for its duration when the manifest does not state one.
  addEventListener(type, handler) {
    if (type === 'loadedmetadata' && Number.isFinite(this.duration)) handler();
  }
  removeEventListener() {}
}

globalThis.Audio = FakeAudio;

const MANIFEST = {
  // Bare strings: a pack somebody assembled by hand, which states no durations.
  PETER: { story: ['peter/a.mp3', 'peter/b.mp3', 'peter/missing.mp3'] },
  VENOM: { idle: [] },
  MILES: { story: Array.from({ length: 200 }, (_, i) => `miles/line-${i}.mp3`) },
  // Path plus measured duration: what the renderer writes. This is the form
  // that stops a long line being cut off, because word count cannot know how
  // long a recording actually runs.
  YURI: {
    story: [
      { path: 'yuri/long.mp3', seconds: 7.4 },
      { path: 'yuri/short.mp3', seconds: 1.9 },
      { path: 'yuri/untimed.mp3' },
    ],
  },
};

globalThis.fetch = async () => ({
  ok: true,
  json: async () => MANIFEST,
});

const warnings = [];
const realWarn = console.warn;
console.warn = (msg) => warnings.push(String(msg));

const { VoiceClips } = await bundle([['{ VoiceClips }', 'src/audio/VoiceClips']], 'voice');

/** Lets the rejected play() promise and its .catch run. */
const settle = () => new Promise((r) => setTimeout(r, 0));

// --- 1. loading -----------------------------------------------------------
console.log('[1] manifest loading');
{
  const clips = new VoiceClips();
  const found = await clips.load();
  if (!found) fail('a valid manifest was not accepted');
  else if (!clips.ready) fail('loaded but not ready');
  else ok('manifest found and marked ready');

  // Absence is the normal case and must not throw or half-enable the pack.
  globalThis.fetch = async () => ({ ok: false });
  const absent = new VoiceClips();
  if (await absent.load()) fail('a 404 manifest was treated as a pack');
  else if (absent.ready) fail('a failed load left the pack marked ready');
  else ok('a missing pack is not an error');
  globalThis.fetch = async () => ({ ok: true, json: async () => MANIFEST });
}

// --- 2. dispatch ----------------------------------------------------------
console.log('[2] dispatch');
{
  const clips = new VoiceClips();
  await clips.load();
  built.length = 0;

  let fellBack = 0;
  const played = clips.play('PETER', 'story', 0, 0.5, () => fellBack++);
  if (!played) fail('a clip that exists was not dispatched');
  await settle();
  if (fellBack) fail('a clip that played fine still fell back to synthesis');
  else ok('an existing clip plays and does not fall back');

  // Unknown speaker, unknown event and an empty bank must all decline rather
  // than dispatch nothing and report success.
  if (clips.play('NOBODY', 'story', 0, 1)) fail('dispatched for an unknown speaker');
  if (clips.play('PETER', 'nothing', 0, 1)) fail('dispatched for an unknown event');
  if (clips.play('VENOM', 'idle', 0, 1)) fail('dispatched from an empty bank');
  else ok('unknown speaker, unknown event and empty bank all decline');

  // The index is the caller's, so the subtitle and the recording agree.
  built.length = 0;
  clips.play('PETER', 'story', 1, 1);
  if (!built[0]?.src.endsWith('peter/b.mp3')) fail(`index 1 played ${built[0]?.src}`);
  else ok('the caller’s line index selects the recording');

  // Out of range wraps rather than throwing, matching how banks are indexed.
  built.length = 0;
  clips.play('PETER', 'story', 4, 1);
  if (!built.length && !clips.play('PETER', 'story', 4, 1)) fail('an out-of-range index was refused');
  else ok('an out-of-range index wraps');
}

// --- 3. asynchronous failure ---------------------------------------------
console.log('[3] a clip that fails after dispatch');
{
  rejects.add('peter/missing.mp3');
  const clips = new VoiceClips();
  await clips.load();
  warnings.length = 0;

  let fellBack = 0;
  const dispatched = clips.play('PETER', 'story', 2, 1, () => fellBack++);
  if (!dispatched) fail('the failing clip was refused up front, which this test cannot then check');
  await settle();

  // This is the bug: before the fallback existed, the line was simply silent.
  if (fellBack !== 1) fail(`fallback fired ${fellBack} times, expected once`);
  else ok('a clip that fails after dispatch falls back to synthesis');

  if (!warnings.some((w) => w.includes('missing.mp3'))) fail('nothing was logged about the bad clip');
  else ok('the failure names the file');

  // Second time it must decline immediately rather than repeat the round trip.
  let again = 0;
  const retried = clips.play('PETER', 'story', 2, 1, () => again++);
  if (retried) fail('a known-bad clip was dispatched a second time');
  else ok('a known-bad clip declines up front on the next attempt');

  // A bad clip must not take the good ones with it.
  if (!clips.play('PETER', 'story', 0, 1)) fail('a working clip was refused after a sibling failed');
  else ok('one bad clip does not disable the rest');
  rejects.clear();
}

// --- 3b. durations ---------------------------------------------------------
console.log('[3b] clip durations');
{
  const clips = new VoiceClips();
  await clips.load();

  // Stated in the manifest: available immediately, before any audio has
  // loaded, which is the whole point — the director has to commit to a
  // duration at the moment it starts the line.
  let reported = null;
  clips.play('YURI', 'story', 0, 1, undefined, (s) => (reported = s));
  if (reported !== 7.4) fail(`stated duration reported as ${reported}, expected 7.4`);
  else ok('a stated duration is reported synchronously');

  // No duration in the manifest: fall back to asking the element, once it
  // knows. A hand-made pack has to keep working.
  reported = null;
  const built = [];
  const previous = globalThis.Audio;
  globalThis.Audio = class extends previous {
    constructor(src) {
      super(src);
      this.readyState = 1;
      this.duration = 3.75;
      built.push(this);
    }
  };
  const late = new VoiceClips();
  await late.load();
  late.play('YURI', 'story', 2, 1, undefined, (s) => (reported = s));
  globalThis.Audio = previous;
  if (reported !== 3.75) fail(`element duration reported as ${reported}, expected 3.75`);
  else ok('an untimed clip falls back to the element');

  // A bare-string pack must not break on the way through.
  let ok3 = true;
  try {
    clips.play('PETER', 'story', 0, 1, undefined, () => {});
  } catch (err) {
    ok3 = false;
    fail(`a bare-string manifest threw: ${err}`);
  }
  if (ok3) ok('a manifest of bare strings still plays');
}

// --- 3c. a bark must not cut into a line -----------------------------------
console.log('[3c] one voice at a time');
{
  // The symptom this exists for is "the voice changed halfway through the
  // sentence". `play()` begins by stopping whatever is running, which is right
  // for two barks and badly wrong across a line of dialogue: the recording is
  // replaced mid-word by a different character.
  const clips = new VoiceClips();
  await clips.load();
  built.length = 0;

  clips.play('YURI', 'story', 0, 1);
  const first = built[0];
  first.paused = false;
  first.ended = false;
  if (!clips.playing) fail('a dispatched clip does not report itself as playing');
  else ok('a playing clip reports itself');

  first.ended = true;
  if (clips.playing) fail('a finished clip still claims the channel');
  else ok('a finished clip releases the channel');

  clips.stop();
  if (clips.playing) fail('stop() left the channel claimed');
  else ok('stop() releases the channel');
}

// --- 4. the cache is bounded ---------------------------------------------
console.log('[4] cache bound');
{
  const clips = new VoiceClips();
  await clips.load();
  built.length = 0;

  for (let i = 0; i < 200; i++) clips.play('MILES', 'story', i, 1);

  // 200 distinct lines, and the ceiling has to hold. Read through the public
  // surface: every element built is either still cached or was detached.
  const detached = built.filter((a) => a.src === '').length;
  const live = built.length - detached;
  if (built.length !== 200) fail(`built ${built.length} elements for 200 lines`);
  if (live > 64) fail(`${live} elements still hold a source; the cache limit is 64`);
  else ok(`${built.length} lines played, ${live} elements retained, ${detached} released`);

  // Releasing the source is what actually frees the decoded audio; dropping
  // the reference alone leaves the element alive until collection.
  if (detached > 0 && !built.find((a) => a.src === '' && a.loads > 0)) {
    fail('evicted elements were dropped without detaching their source');
  } else if (detached > 0) {
    ok('evicted elements are paused and detached, not merely forgotten');
  }

  // Replaying a retained line must not build a second element for it.
  const before = built.length;
  clips.play('MILES', 'story', 199, 1);
  if (built.length !== before) fail('a cached clip was rebuilt instead of reused');
  else ok('a cached clip is reused');
}

// --- 5. never two at once -------------------------------------------------
console.log('[5] one clip at a time');
{
  const clips = new VoiceClips();
  await clips.load();
  built.length = 0;

  clips.play('PETER', 'story', 0, 1);
  const first = built[0];
  clips.play('PETER', 'story', 1, 1);
  if (first.pauses < 1) fail('starting a second clip did not stop the first');
  else ok('a new clip stops the one before it');

  clips.stop();
  clips.dispose();
  if (clips.ready) fail('dispose left the pack ready');
  else ok('dispose stands the pack down');
}

console.warn = realWarn;
console.log('');
console.log(problems === 0 ? 'ALL CHECKS PASSED' : `${problems} PROBLEM(S) FOUND`);
process.exit(problems === 0 ? 0 : 1);
