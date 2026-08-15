/**
 * Lets a test import the game's TypeScript directly from Node.
 *
 * There is no test runner and no build step for these: esbuild bundles a
 * generated entry point in a temp directory, and the test imports the result.
 * Three.js constructs geometry and materials perfectly well without a GL
 * context, so most of the game is reachable this way — anything that actually
 * needs WebGL gets a stub from the test.
 *
 * Paths are resolved from this file, never hardcoded, so a fresh clone works
 * on any machine.
 */
import { build } from 'esbuild';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/** The project root — the directory holding package.json. */
export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Bundle the named exports and return them as a module namespace.
 *
 * Each spec is `[whatToExport, module]`. A module starting with `src/` is
 * resolved inside the project; anything else is treated as a package name:
 *
 *   const { Campaign, THREE } = await bundle([
 *     ['{ Campaign }', 'src/game/GameMode'],
 *     ['* as THREE', 'three'],
 *   ]);
 */
export async function bundle(specs, tag = 'ws') {
  const dir = mkdtempSync(join(tmpdir(), `${tag}-`));
  const entry = join(dir, 'entry.ts');
  writeFileSync(
    entry,
    specs
      .map(([names, mod]) => {
        const from = mod.startsWith('src/') ? join(ROOT, mod).replace(/\\/g, '/') : mod;
        return `export ${names} from '${from}';`;
      })
      .join('\n'),
  );

  const out = join(dir, 'entry.mjs');
  await build({
    entryPoints: [entry],
    bundle: true,
    format: 'esm',
    outfile: out,
    logLevel: 'silent',
    // The generated entry lives outside the project, so both the game's own
    // imports and `three` have to resolve from the project root rather than
    // from the temp directory.
    absWorkingDir: ROOT,
    nodePaths: [join(ROOT, 'node_modules')],
  });

  return import(pathToFileURL(out).href);
}
