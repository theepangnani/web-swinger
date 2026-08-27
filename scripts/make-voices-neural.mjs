/**
 * Renders the whole voice pack with real neural voices.
 *
 * The game ships with browser speech synthesis, which works everywhere and
 * sounds like it. `Voice.ts` does what it can — a different installed voice per
 * character, per-speaker pitch and rate, per-line jitter, a procedural bed
 * under the monsters — but no amount of shaping stops a synthesiser sounding
 * synthesised. The only real fix is recordings, and `VoiceClips` has always
 * been able to play them. This is the thing that produces them.
 *
 *     node scripts/make-voices-neural.mjs                 # Microsoft neural, free
 *     node scripts/make-voices-neural.mjs --dry-run       # what it would cost
 *     node scripts/make-voices-neural.mjs --list          # the cast
 *     node scripts/make-voices-neural.mjs --only VENOM    # one character
 *     node scripts/make-voices-neural.mjs --prune         # drop orphaned clips
 *     node scripts/make-voices-neural.mjs --engine eleven # ElevenLabs
 *
 * Two engines, one cast list and one manifest:
 *
 *   **edge** (default) — Microsoft's neural voices through `edge-tts`. Free,
 *   unmetered, no account, and there are enough distinct English voices to
 *   cast fifteen speakers without anybody doubling up. This is what the
 *   committed pack was made with.
 *
 *   **eleven** — better still, and metered. Needs `ELEVENLABS_API_KEY` and a
 *   cast in `scripts/eleven-cast.json`; see `--engine eleven --dry-run` for
 *   the character count before committing any quota to it.
 *
 * Resumable by design: a clip already on disk is skipped, so an interrupted
 * run is finished by running it again, and adding a line to the game means
 * rendering one line rather than six hundred.
 */
import { spawn } from 'node:child_process';
import {
  existsSync,
  statSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = join(ROOT, 'public', 'voice');

/**
 * Constant bitrate per engine, in bits per second.
 *
 * Both engines are asked for CBR mp3, which makes duration exactly
 * `bytes * 8 / bitrate` — no decoder, no ffprobe, no dependency. The manifest
 * carries those durations because the alternative is the game guessing from
 * word count, and that guess cut 9% of the pack's lines off mid-sentence.
 */
const BITRATE = {
  edge: 48000, // edge-tts default: audio-24khz-48kbitrate-mono-mp3
  eleven: 64000, // mp3_44100_64
};

const args = process.argv.slice(2);
const has = (flag) => args.includes(flag);
const value = (flag) => {
  const at = args.indexOf(flag);
  return at >= 0 ? args[at + 1] : undefined;
};

const engine = value('--engine') ?? 'edge';
const dryRun = has('--dry-run');
const listOnly = has('--list');
const force = has('--force');
const prune = has('--prune');
const onlyArg = value('--only');
const only = onlyArg ? new Set(onlyArg.split(',').map((s) => s.trim().toUpperCase())) : null;

if (engine !== 'edge' && engine !== 'eleven') {
  console.error(`unknown engine "${engine}" — expected edge or eleven`);
  process.exit(2);
}

// ------------------------------------------------------------------- casting

/**
 * Who plays whom, on Microsoft's neural voices.
 *
 * Fifteen speakers and fifteen distinct voices, with one deliberate exception:
 * Symbiote Peter is cast as *Peter* and then dropped a long way and slowed,
 * because the whole point of that fight is that the line reads as Peter until
 * you notice what it is saying. Everyone else gets their own, because a cast
 * where two characters share a voice is the same problem the synthesiser had.
 *
 * `rate` and `pitch` are edge-tts's own percentage and hertz offsets. They are
 * doing character work here, not correction: Jameson is fast because Jameson
 * is fast, May is slow because she is not in a hurry.
 */
const EDGE_CAST = {
  // Heroes.
  PETER: { voice: 'en-US-AndrewNeural', rate: '-2%', pitch: '-8Hz' },
  MILES: { voice: 'en-US-BrianNeural', rate: '+6%', pitch: '+18Hz' },

  // The people on the other end of a phone.
  MJ: { voice: 'en-US-AvaMultilingualNeural', rate: '+2%', pitch: '+0Hz' },
  MAY: { voice: 'en-US-MichelleNeural', rate: '-8%', pitch: '-6Hz' },
  YURI: { voice: 'en-US-AriaNeural', rate: '+4%', pitch: '+0Hz' },
  JAMESON: { voice: 'en-US-RogerNeural', rate: '+16%', pitch: '-5Hz' },
  GANKE: { voice: 'en-US-EricNeural', rate: '+8%', pitch: '+10Hz' },
  RIO: { voice: 'en-US-EmmaNeural', rate: '-2%', pitch: '+0Hz' },
  DANIKA: { voice: 'en-US-JennyNeural', rate: '+12%', pitch: '+8Hz' },

  // The other side.
  'BLACK CAT': { voice: 'en-GB-SoniaNeural', rate: '+2%', pitch: '-2Hz' },
  ELECTRO: { voice: 'en-US-GuyNeural', rate: '+10%', pitch: '-18Hz' },
  SANDMAN: { voice: 'en-US-BrianMultilingualNeural', rate: '-14%', pitch: '-30Hz' },
  VENOM: { voice: 'en-US-ChristopherNeural', rate: '-14%', pitch: '-45Hz' },
  'GREEN GOBLIN': { voice: 'en-US-SteffanNeural', rate: '+10%', pitch: '+8Hz' },
  // Peter's own voice, dropped a fifth and slowed. Same person, wrong.
  'SYMBIOTE PETER': { voice: 'en-US-AndrewNeural', rate: '-10%', pitch: '-32Hz' },
};

const EDGE_FALLBACK = { voice: 'en-US-AndrewNeural', rate: '+0%', pitch: '+0Hz' };

/**
 * Casting preferences for ElevenLabs, as patterns rather than ids.
 *
 * Voice ids are per-account — the premade library is shared but anything
 * cloned or designed is not — so hardcoding them produces a script that fails
 * one 404 at a time on somebody else's account. Instead each speaker gets an
 * ordered list of name patterns and takes the first available voice no other
 * speaker has already claimed, which is exactly how `Voice.ts` divides up the
 * browser's installed voices. Casting is then whatever is actually on the
 * account, and the fallbacks are progressively less fussy.
 */
const ELEVEN_PREFERENCE = {
  PETER: [/^(brian|adam|antoni)$/i, /male/i],
  MILES: [/^(liam|ethan|josh)$/i, /male/i],
  MJ: [/^(sarah|rachel|jessica)$/i, /female/i],
  MAY: [/^(matilda|dorothy|grace)$/i, /female/i],
  YURI: [/^(alice|charlotte|serena)$/i, /female/i],
  JAMESON: [/^(bill|george|arnold)$/i, /male/i],
  GANKE: [/^(chris|sam|jeremy)$/i, /male/i],
  RIO: [/^(lily|freya|nicole)$/i, /female/i],
  DANIKA: [/^(gigi|glinda|domi)$/i, /female/i],
  'BLACK CAT': [/^(charlotte|lily|emily)$/i, /female/i],
  ELECTRO: [/^(callum|patrick|clyde)$/i, /male/i],
  SANDMAN: [/^(daniel|paul|thomas)$/i, /male/i],
  VENOM: [/^(clyde|arnold|patrick)$/i, /male/i],
  'GREEN GOBLIN': [/^(giovanni|michael|fin)$/i, /male/i],
  // Cast as Peter and then shifted, for the same reason as the edge cast:
  // the line has to read as Peter until you notice what it says.
  'SYMBIOTE PETER': [/^(brian|adam|antoni)$/i, /male/i],
};

/**
 * Per-speaker delivery. ElevenLabs exposes character through its own settings
 * rather than through pitch, so this is stability and style rather than hertz.
 * Low stability is more expressive and less predictable, which is right for
 * Jameson and wrong for Watanabe.
 */
const ELEVEN_SETTINGS = {
  PETER: { stability: 0.45, similarity_boost: 0.8 },
  MILES: { stability: 0.35, similarity_boost: 0.8, style: 0.35 },
  MJ: { stability: 0.5, similarity_boost: 0.8 },
  MAY: { stability: 0.65, similarity_boost: 0.85 },
  YURI: { stability: 0.7, similarity_boost: 0.8 },
  JAMESON: { stability: 0.2, similarity_boost: 0.75, style: 0.6 },
  GANKE: { stability: 0.4, similarity_boost: 0.8, style: 0.3 },
  RIO: { stability: 0.6, similarity_boost: 0.85 },
  DANIKA: { stability: 0.35, similarity_boost: 0.8, style: 0.4 },
  'BLACK CAT': { stability: 0.4, similarity_boost: 0.8, style: 0.3 },
  ELECTRO: { stability: 0.25, similarity_boost: 0.75, style: 0.5 },
  SANDMAN: { stability: 0.7, similarity_boost: 0.85 },
  VENOM: { stability: 0.6, similarity_boost: 0.9 },
  'GREEN GOBLIN': { stability: 0.2, similarity_boost: 0.75, style: 0.65 },
  'SYMBIOTE PETER': { stability: 0.55, similarity_boost: 0.85 },
};

/**
 * Builds the ElevenLabs cast from whatever the account actually has.
 *
 * A hand-written `scripts/eleven-cast.json` always wins, because an account
 * with a cloned voice for a particular character should not have it overruled
 * by a name match. Otherwise the account is asked what it has and the
 * preferences above divide it up. A key scoped to text-to-speech only cannot
 * list voices, which is not an error worth dying on — it is a very common way
 * to issue a key, and the fix is one sentence long.
 */
async function resolveElevenCast() {
  const path = join(ROOT, 'scripts', 'eleven-cast.json');
  if (existsSync(path)) {
    console.log(`cast read from ${path}`);
    return JSON.parse(readFileSync(path, 'utf8'));
  }

  const key = process.env.ELEVENLABS_API_KEY;
  if (!key) return null;

  const response = await fetch('https://api.elevenlabs.io/v1/voices', {
    headers: { 'xi-api-key': key },
  });
  if (!response.ok) {
    const detail = await response.text();
    if (detail.includes('voices_read')) {
      console.error('This API key cannot list voices (it is missing the voices_read permission).');
      console.error('Either reissue it with voices_read, or write scripts/eleven-cast.json by hand:');
      console.error('  { "PETER": { "voiceId": "..." }, "MILES": { "voiceId": "..." } }');
    } else {
      console.error(`could not list voices: ${detail.slice(0, 200)}`);
    }
    return null;
  }

  const { voices } = await response.json();
  const pool = voices ?? [];
  const claimed = new Set();
  const cast = {};

  for (const [speaker, patterns] of Object.entries(ELEVEN_PREFERENCE)) {
    let picked;
    for (const pattern of patterns) {
      picked = pool.find((v) => !claimed.has(v.voice_id) && pattern.test(v.name ?? ''));
      if (picked) break;
    }
    // Symbiote Peter is meant to share Peter's voice, so an exhausted pool is
    // only a problem for everybody else.
    picked ??= pool.find((v) => !claimed.has(v.voice_id)) ?? pool[0];
    if (!picked) continue;
    if (speaker !== 'SYMBIOTE PETER') claimed.add(picked.voice_id);
    cast[speaker] = {
      voiceId: picked.voice_id,
      name: picked.name,
      settings: ELEVEN_SETTINGS[speaker],
    };
  }
  if (Object.keys(cast).length) console.log(`cast ${Object.keys(cast).length} speakers from your account`);
  return cast;
}

// ----------------------------------------------------------------- the lines

/**
 * Loads the line banks straight out of the game's own source.
 *
 * Transpiled through esbuild rather than duplicated here: the manifest indexes
 * recordings by line position, so any drift between this tool's copy of a bank
 * and the game's would play the wrong clip under the right subtitle.
 */
async function loadLines() {
  const esbuild = await import(
    pathToFileURL(join(ROOT, 'node_modules', 'esbuild', 'lib', 'main.js')).href
  );
  const scratch = join(tmpdir(), `voicegen-${process.pid}`);
  mkdirSync(scratch, { recursive: true });
  const entry = join(scratch, 'entry.ts');
  writeFileSync(
    entry,
    `export { VOICE_LINES } from ${JSON.stringify(join(ROOT, 'src/audio/Voice').replace(/\\/g, '/'))};`,
  );
  const bundle = join(scratch, 'entry.mjs');
  await esbuild.build({
    entryPoints: [entry],
    bundle: true,
    format: 'esm',
    outfile: bundle,
    logLevel: 'silent',
  });
  const loaded = await import(pathToFileURL(bundle).href);
  rmSync(scratch, { recursive: true, force: true });
  return loaded.VOICE_LINES;
}

/** Filesystem-safe, stable, and readable in a directory listing. */
function slug(text) {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40);
}

// ---------------------------------------------------------------------- plan

const VOICE_LINES = await loadLines();

if (listOnly) {
  console.log(`cast for --engine ${engine}\n`);
  const cast = engine === 'edge' ? EDGE_CAST : ((await resolveElevenCast()) ?? {});
  for (const speaker of Object.keys(VOICE_LINES)) {
    const part = cast[speaker];
    const lines = Object.values(VOICE_LINES[speaker]).reduce((n, b) => n + b.length, 0);
    console.log(
      `  ${speaker.padEnd(15)} ${String(lines).padStart(4)} lines  ` +
        (part ? `${part.voice ?? part.voiceId}` : 'UNCAST'),
    );
  }
  process.exit(0);
}

/**
 * Every clip the pack should contain, and where it goes.
 *
 * Built for the whole pack regardless of what already exists, because the
 * manifest has to describe all of it — skipping is a decision about rendering,
 * not about what the game is allowed to play.
 */
const manifest = {};
const jobs = [];
let total = 0;
let characters = 0;
let present = 0;

const cast = engine === 'edge' ? EDGE_CAST : ((await resolveElevenCast()) ?? {});

for (const [speaker, events] of Object.entries(VOICE_LINES)) {
  const speakerDir = join(OUT_DIR, slug(speaker));
  manifest[speaker] = {};

  for (const [event, lines] of Object.entries(events)) {
    const paths = [];
    for (let i = 0; i < lines.length; i++) {
      const name = `${slug(event)}-${i}-${slug(lines[i])}.mp3`;
      const relative = `${slug(speaker)}/${name}`;
      // Filled in after rendering, from the file itself.
      paths.push({ path: relative, seconds: 0 });
      total++;
      characters += lines[i].length;

      if (only && !only.has(speaker.toUpperCase())) continue;
      const target = join(speakerDir, name);
      if (existsSync(target) && !force) {
        present++;
        continue;
      }
      const part = cast[speaker] ?? (engine === 'edge' ? EDGE_FALLBACK : null);
      if (!part) {
        console.error(`\nno ${engine} voice cast for ${speaker}.`);
        console.error('Add one to scripts/eleven-cast.json, or reissue the key with voices_read.');
        process.exit(1);
      }
      jobs.push({ speaker, text: lines[i], out: target, ...part });
    }
    manifest[speaker][event] = paths;
  }
}

console.log(`${total} lines, ${characters.toLocaleString()} characters across ${Object.keys(VOICE_LINES).length} speakers`);
console.log(`${present} already rendered, ${jobs.length} to do\n`);

if (dryRun) {
  if (engine === 'eleven') {
    // Priced off the whole pack, not the outstanding jobs: quota is what a
    // fresh render costs, and that is the number worth knowing before starting.
    console.log('ElevenLabs bills per character:');
    console.log(`  free tier    10,000/month  ->  ${(characters / 10000).toFixed(1)} months`);
    console.log(`  starter      30,000/month  ->  ${(characters / 30000).toFixed(1)} months`);
    console.log(`  creator     100,000/month  ->  ${(characters / 100000).toFixed(2)} months`);
  } else {
    console.log('Microsoft neural voices via edge-tts are free and unmetered.');
  }
  console.log('\nnothing rendered (--dry-run)');
  process.exit(0);
}

// -------------------------------------------------------------------- render

if (jobs.length > 0) {
  if (engine === 'edge') await renderEdge(jobs);
  else await renderEleven(jobs);
}

// Durations are measured after rendering rather than predicted before it, so
// they describe the file that actually exists. A clip that failed to render
// keeps a zero, and the game falls back to its estimate for that one line
// rather than believing a length nothing is behind.
const rate = BITRATE[engine];
let timed = 0;
for (const events of Object.values(manifest)) {
  for (const entries of Object.values(events)) {
    for (const entry of entries) {
      const file = join(OUT_DIR, entry.path);
      if (!existsSync(file)) continue;
      entry.seconds = Number(((statSync(file).size * 8) / rate).toFixed(2));
      timed++;
    }
  }
}

mkdirSync(OUT_DIR, { recursive: true });
writeFileSync(join(OUT_DIR, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`${timed} clip duration(s) measured into the manifest`);
console.log(`\nmanifest written to ${join(OUT_DIR, 'manifest.json')}`);

const onDisk = countClips();
console.log(`${onDisk} clips on disk, manifest describes ${total}`);
if (onDisk < total) {
  console.log('some clips are missing — run again to fill the gaps');
}

/**
 * Clips on disk that the manifest no longer refers to.
 *
 * Filenames are derived from the line text, so editing a line renders a new
 * clip and abandons the old one — the renderer can only ever grow the pack.
 * Left alone that is dead audio committed to the repository forever, and it is
 * invisible: nothing plays it and nothing complains about it. So it is always
 * counted, and removed when asked.
 */
const orphans = findOrphans();
if (orphans.length > 0) {
  if (prune) {
    for (const file of orphans) unlinkSync(file);
    console.log(`pruned ${orphans.length} clip(s) no longer in the manifest`);
  } else {
    console.log(`${orphans.length} clip(s) on disk are no longer used — re-run with --prune to remove them`);
  }
}

function countClips() {
  let n = 0;
  for (const speaker of Object.keys(VOICE_LINES)) {
    const dir = join(OUT_DIR, slug(speaker));
    if (existsSync(dir)) n += readdirSync(dir).filter((f) => f.endsWith('.mp3')).length;
  }
  return n;
}

function findOrphans() {
  const wanted = new Set();
  for (const events of Object.values(manifest)) {
    for (const entries of Object.values(events)) for (const e of entries) wanted.add(e.path);
  }
  const dead = [];
  for (const speaker of Object.keys(VOICE_LINES)) {
    const folder = slug(speaker);
    const dir = join(OUT_DIR, folder);
    if (!existsSync(dir)) continue;
    for (const name of readdirSync(dir)) {
      if (!name.endsWith('.mp3')) continue;
      if (!wanted.has(`${folder}/${name}`)) dead.push(join(dir, name));
    }
  }
  return dead;
}

/** Hands the batch to the Python half, which owns the edge-tts session. */
async function renderEdge(batch) {
  const scratch = join(tmpdir(), `voicejobs-${process.pid}.json`);
  writeFileSync(scratch, JSON.stringify(batch));
  const script = join(ROOT, 'scripts', 'edge-render.py');

  // Whichever Python is on PATH. The failure mode if none is worth being
  // explicit about, because "command not found" for `python` on Windows opens
  // the Microsoft Store and looks like a hang.
  const python = process.platform === 'win32' ? 'python' : 'python3';
  const code = await new Promise((done) => {
    const child = spawn(python, [script, scratch], { stdio: 'inherit' });
    child.on('error', () => {
      console.error(`\ncould not run ${python}. Install Python 3, then: pip install edge-tts`);
      done(1);
    });
    child.on('close', done);
  });
  rmSync(scratch, { force: true });
  if (code !== 0) {
    console.error('\nrendering failed — the manifest was not written');
    process.exit(1);
  }
}

/**
 * ElevenLabs, three at a time.
 *
 * Quota exhaustion is reported as a first-class outcome rather than as one
 * failure per remaining line: running out mid-pack is the expected way for
 * this to end on a small plan, and the useful thing to say is how far it got.
 */
async function renderEleven(batch) {
  const key = process.env.ELEVENLABS_API_KEY;
  if (!key) {
    console.error('ELEVENLABS_API_KEY is not set.');
    process.exit(1);
  }
  const model = process.env.ELEVENLABS_MODEL ?? 'eleven_turbo_v2_5';

  let done = 0;
  let failed = 0;
  let quotaHit = false;
  const queue = [...batch];

  const worker = async () => {
    while (queue.length && !quotaHit) {
      const job = queue.shift();
      const url =
        `https://api.elevenlabs.io/v1/text-to-speech/${job.voiceId}` +
        `?output_format=${process.env.ELEVENLABS_FORMAT ?? 'mp3_44100_64'}`;
      const body = {
        text: job.text,
        model_id: model,
        voice_settings: job.settings ?? { stability: 0.45, similarity_boost: 0.8 },
      };
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'xi-api-key': key, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });

      if (!response.ok) {
        const detail = await response.text();
        if (detail.includes('quota_exceeded')) {
          quotaHit = true;
          break;
        }
        failed++;
        if (failed <= 5) console.error(`\n  FAILED ${job.speaker}: ${detail.slice(0, 160)}`);
        continue;
      }

      mkdirSync(dirname(job.out), { recursive: true });
      const audio = Buffer.from(await response.arrayBuffer());
      // Same partial-then-move as the edge path: an interrupted run must not
      // leave a truncated clip that the next run skips as already rendered.
      writeFileSync(`${job.out}.part`, audio);
      renameSync(`${job.out}.part`, job.out);
      done++;
      process.stdout.write(`\r  ${done}/${batch.length} rendered`);
    }
  };

  await Promise.all([worker(), worker(), worker()]);
  console.log();
  if (quotaHit) {
    console.log(`\nElevenLabs quota exhausted after ${done} clips.`);
    console.log('Everything rendered so far is kept; run again after a reset to continue.');
  }
  if (failed) console.log(`${failed} line(s) failed.`);
}
