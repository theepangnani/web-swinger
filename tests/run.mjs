/**
 * Runs every suite and reports which ones failed.
 *
 * Suites run as separate processes, in parallel — three of them bundle
 * Three.js, which dominates the wall clock. Their output is buffered and
 * printed in a fixed order so the log is stable regardless of finish order.
 *
 *   npm test              all suites
 *   npm test rematch      just the ones whose filename matches
 */
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

const SUITES = [
  ['static-checks.cjs', 'source-text invariants across every .ts file'],
  ['campaign.mjs', 'story progression: no chapter skipped, none unclearable'],
  ['books.mjs', 'story shape: every book ends on a boss, difficulty climbs'],
  ['story.mjs', 'chapter dialogue: every beat reaches the player, none is orphaned'],
  ['voice.mjs', 'recorded clips: a clip that fails still reaches the fallback'],
  ['rematch.mjs', 'a chapter can only ever field the villain it named'],
  ['numeric.mjs', 'day/night clock keeps running, and never goes pitch dark'],
  ['joints.mjs', 'villain limbs sit exactly where they were authored'],
  ['flight.mjs', 'the fliers stay out of the buildings they cross'],
  ['chase.mjs', 'a chased villain cannot heal, and cannot simply leave'],
];

const filters = process.argv.slice(2);
const picked = filters.length
  ? SUITES.filter(([file]) => filters.some((f) => file.includes(f)))
  : SUITES;

if (picked.length === 0) {
  console.log(`no suite matches ${filters.join(', ')}`);
  console.log(`available: ${SUITES.map(([f]) => f.replace(/\.(mjs|cjs)$/, '')).join(', ')}`);
  process.exit(1);
}

function run(file) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [join(HERE, file)], { cwd: HERE });
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (out += d));
    child.on('error', (err) => resolve({ file, code: 1, out: String(err) }));
    child.on('close', (code) => resolve({ file, code, out }));
  });
}

const started = Date.now();
const results = await Promise.all(picked.map(([file]) => run(file)));

for (const [file, blurb] of picked) {
  const r = results.find((x) => x.file === file);
  console.log(`\n${'='.repeat(70)}\n${file} - ${blurb}\n${'='.repeat(70)}`);
  console.log(r.out.trimEnd());
}

const failed = results.filter((r) => r.code !== 0);
const seconds = ((Date.now() - started) / 1000).toFixed(1);
console.log(`\n${'-'.repeat(70)}`);
if (failed.length === 0) {
  console.log(`ALL ${results.length} SUITES PASS (${seconds}s)`);
} else {
  console.log(`${failed.length} of ${results.length} SUITES FAILED (${seconds}s)`);
  for (const r of failed) console.log(`  - ${r.file}`);
}
process.exit(failed.length === 0 ? 0 : 1);
