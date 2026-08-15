#!/usr/bin/env node
/**
 * Renders a recorded voice pack with Piper, offline and free.
 *
 * Why Piper: it is MIT-licensed, runs entirely on your own machine with no
 * account, no API key and no per-character billing, and it ships a large
 * catalogue of English voices that sound like people rather than like a
 * screen reader. The browser's own `speechSynthesis` stays as the fallback —
 * it needs no assets at all — but it will never stop sounding synthesised,
 * and "give the characters proper voices" is exactly the thing it cannot do.
 *
 * What this writes: one wav per line under `public/voice/<speaker>/`, plus
 * `public/voice/manifest.json`. `VoiceClips` picks the pack up automatically
 * at boot; if the folder is absent the game is unchanged.
 *
 *
 * SETUP (once)
 * ------------
 * 1. Piper binary — https://github.com/rhasspy/piper/releases
 *    Download the archive for your platform and unpack it to `tools/piper/`
 *    so that `tools/piper/piper.exe` (or `tools/piper/piper`) exists.
 *
 * 2. Voice models — https://huggingface.co/rhasspy/piper-voices
 *    Each voice is two files, `<name>.onnx` and `<name>.onnx.json`. Put them
 *    in `tools/piper/voices/`. The defaults this script wants are listed by
 *    `node scripts/make-voices.mjs --list`, and it tells you which are
 *    missing rather than failing halfway through.
 *
 * 3. ffmpeg (optional) — used to pitch-shift Venom, Sandman and the others
 *    down or up so they are not all the same person. Without it the clips are
 *    still rendered, just unshifted.
 *
 *
 * USE
 * ---
 *     node scripts/make-voices.mjs            # render everything missing
 *     node scripts/make-voices.mjs --force    # re-render even if present
 *     node scripts/make-voices.mjs --only VENOM,MILES
 *     node scripts/make-voices.mjs --list     # show the voice model mapping
 *
 * Re-running is cheap: a line whose wav already exists is skipped, so adding
 * one line to Voice.ts costs one render, not four hundred.
 */

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const PIPER_DIR = join(ROOT, 'tools', 'piper');
const VOICE_DIR = join(PIPER_DIR, 'voices');
const OUT_DIR = join(ROOT, 'public', 'voice');

/**
 * Which Piper voice plays whom.
 *
 * Chosen to be genuinely different speakers, not one speaker at eight pitches
 * — pitch shifting alone still reads as the same performance. The shaping in
 * `VOICE_SHAPE` is then layered on top of these.
 */
const VOICES = {
  PETER: 'en_US-ryan-high',
  MILES: 'en_US-joe-medium',
  VENOM: 'en_US-lessac-medium',
  'BLACK CAT': 'en_US-amy-medium',
  ELECTRO: 'en_US-kusal-medium',
  'GREEN GOBLIN': 'en_GB-alan-medium',
  SANDMAN: 'en_US-lessac-medium',
  'SYMBIOTE PETER': 'en_US-ryan-high',
};

/** A voice everyone falls back to if a specific model is not installed. */
const FALLBACK_VOICE = 'en_US-lessac-medium';

/**
 * Output rate of Piper's medium and high quality models. Only `low` models
 * differ (16 kHz), and none of the voices above are low.
 */
const PIPER_SAMPLE_RATE = 22050;

// ---------------------------------------------------------------- arguments

const argv = process.argv.slice(2);
const force = argv.includes('--force');
const listOnly = argv.includes('--list');
const onlyArg = argv[argv.indexOf('--only') + 1];
const only =
  argv.includes('--only') && onlyArg
    ? new Set(onlyArg.split(',').map((s) => s.trim().toUpperCase()))
    : null;

// ------------------------------------------------------------------ helpers

function run(command, args, stdin) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(command, args, { stdio: [stdin ? 'pipe' : 'ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', rejectRun);
    child.on('close', (code) => {
      if (code === 0) resolveRun();
      else rejectRun(new Error(`${command} exited ${code}\n${stderr.trim()}`));
    });
    if (stdin) {
      child.stdin.write(stdin);
      child.stdin.end();
    }
  });
}

async function has(command) {
  try {
    await run(command, ['-version']);
    return true;
  } catch {
    try {
      await run(command, ['--version']);
      return true;
    } catch {
      return false;
    }
  }
}

function piperBinary() {
  for (const name of ['piper.exe', 'piper']) {
    const local = join(PIPER_DIR, name);
    if (existsSync(local)) return local;
  }
  // Fall back to whatever is on PATH, so a system-wide install also works.
  return 'piper';
}

/**
 * ffmpeg's `atempo` only accepts 0.5–2.0 per instance, and Venom's shaping
 * asks for 3.3. Chain them: the factors multiply, so several legal steps land
 * anywhere. Passing the raw value silently produces a filter error and an
 * unwritten file, which is worse than the noise it saves.
 */
function atempoChain(factor) {
  const parts = [];
  let remaining = factor;
  while (remaining > 2) {
    parts.push('atempo=2.0');
    remaining /= 2;
  }
  while (remaining < 0.5) {
    parts.push('atempo=0.5');
    remaining /= 0.5;
  }
  parts.push(`atempo=${remaining.toFixed(4)}`);
  return parts.join(',');
}

/** Slug safe for a filename and stable across runs. */
function slug(text) {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40);
}

/**
 * Loads the line banks straight out of the game's own source.
 *
 * Transpiled through esbuild rather than duplicated here: the manifest indexes
 * recordings by line position, so any drift between this tool's copy of a
 * bank and the game's would play the wrong clip under the right subtitle.
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
    `export { VOICE_LINES, VOICE_SHAPE } from ${JSON.stringify(join(ROOT, 'src/audio/Voice').replace(/\\/g, '/'))};`,
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
  return loaded;
}

// --------------------------------------------------------------------- main

const { VOICE_LINES, VOICE_SHAPE } = await loadLines();

const installed = existsSync(VOICE_DIR)
  ? new Set(readdirSync(VOICE_DIR).filter((f) => f.endsWith('.onnx')).map((f) => f.slice(0, -5)))
  : new Set();

if (listOnly) {
  console.log(`voice models expected in ${VOICE_DIR}\n`);
  for (const [speaker, voice] of Object.entries(VOICES)) {
    const mark = installed.has(voice) ? 'ok     ' : 'MISSING';
    console.log(`  ${mark} ${speaker.padEnd(15)} ${voice}`);
  }
  console.log('\ndownload from https://huggingface.co/rhasspy/piper-voices');
  console.log('each voice is two files: <name>.onnx and <name>.onnx.json');
  process.exit(0);
}

const piper = piperBinary();
if (!existsSync(piper) && piper === 'piper' && !(await has('piper'))) {
  console.error(
    `Piper not found.\n\n` +
      `  Expected ${join(PIPER_DIR, 'piper.exe')} or 'piper' on PATH.\n` +
      `  Download: https://github.com/rhasspy/piper/releases\n\n` +
      `Nothing was written. The game keeps using browser speech synthesis.`,
  );
  process.exit(1);
}

if (installed.size === 0) {
  console.error(
    `No voice models in ${VOICE_DIR}.\n\n` +
      `  Run 'node scripts/make-voices.mjs --list' for the ones this pack wants.\n` +
      `  Download: https://huggingface.co/rhasspy/piper-voices`,
  );
  process.exit(1);
}

const canShift = await has('ffmpeg');
if (!canShift) {
  console.log('ffmpeg not found — clips will be rendered without pitch shaping.\n');
}

const manifest = {};
let rendered = 0;
let skipped = 0;

for (const [speaker, events] of Object.entries(VOICE_LINES)) {
  if (only && !only.has(speaker.toUpperCase())) continue;

  const wanted = VOICES[speaker] ?? FALLBACK_VOICE;
  const voice = installed.has(wanted) ? wanted : FALLBACK_VOICE;
  if (!installed.has(voice)) {
    console.log(`skipping ${speaker}: neither ${wanted} nor the fallback is installed`);
    continue;
  }
  if (voice !== wanted) console.log(`${speaker}: ${wanted} not installed, using ${voice}`);

  const model = join(VOICE_DIR, `${voice}.onnx`);
  const shape = VOICE_SHAPE[speaker] ?? { pitch: 1, rate: 1 };
  // Piper's length scale is duration, so it is the reciprocal of a rate.
  const lengthScale = (1 / Math.max(0.4, shape.rate)).toFixed(3);

  const speakerDir = join(OUT_DIR, slug(speaker));
  mkdirSync(speakerDir, { recursive: true });
  manifest[speaker] = {};

  for (const [event, lines] of Object.entries(events)) {
    const paths = [];
    for (let i = 0; i < lines.length; i++) {
      const name = `${slug(event)}-${i}-${slug(lines[i])}.wav`;
      const target = join(speakerDir, name);
      const relative = `${slug(speaker)}/${name}`;
      paths.push(relative);

      if (existsSync(target) && !force) {
        skipped++;
        continue;
      }

      const raw = canShift && shape.pitch !== 1 ? `${target}.raw.wav` : target;
      await run(
        piper,
        ['--model', model, '--output_file', raw, '--length_scale', lengthScale],
        lines[i],
      );

      if (raw !== target) {
        // asetrate moves pitch and speed together; the atempo chain puts the
        // speed back, which leaves the pitch shifted and the delivery intact.
        const shifted = Math.round(PIPER_SAMPLE_RATE * shape.pitch);
        await run('ffmpeg', [
          '-y',
          '-loglevel', 'error',
          '-i', raw,
          '-af',
          `asetrate=${shifted},aresample=${PIPER_SAMPLE_RATE},${atempoChain(1 / shape.pitch)}`,
          target,
        ]);
        rmSync(raw, { force: true });
      }

      rendered++;
      process.stdout.write(`\r  ${speaker} ${event} ${i + 1}/${lines.length}          `);
    }
    manifest[speaker][event] = paths;
  }
  process.stdout.write(`\r${speaker}: ${Object.keys(events).length} events              \n`);
}

mkdirSync(OUT_DIR, { recursive: true });
writeFileSync(join(OUT_DIR, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);

console.log(`\n${rendered} rendered, ${skipped} already present.`);
console.log(`manifest written to ${join(OUT_DIR, 'manifest.json')}`);
