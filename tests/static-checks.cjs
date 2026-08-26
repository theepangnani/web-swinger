/* Repeatable verification sweep for web-swinger. */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const files = [];
(function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p);
    else if (e.name.endsWith('.ts')) files.push(p);
  }
})(path.join(ROOT, 'src'));

const read = (f) => fs.readFileSync(f, 'utf8');
const rel = (f) => path.relative(ROOT, f).replace(/\\/g, '/');
let problems = 0;
const fail = (msg) => { problems++; console.log('  FAIL ' + msg); };

// --- 1. DOM ids -----------------------------------------------------------
console.log('[1] DOM ids');
const html = read(path.join(ROOT, 'index.html'));
const ids = new Set([...html.matchAll(/id="([^"]+)"/g)].map((m) => m[1]));
let dangling = 0;
for (const f of files) {
  for (const m of read(f).matchAll(/(?:\bel|getElementById)\(\s*'([^']+)'/g)) {
    if (!ids.has(m[1])) { fail(`${rel(f)} looks up missing #${m[1]}`); dangling++; }
  }
}
if (!dangling) console.log(`  ok — ${ids.size} ids defined, every lookup resolves`);

// classes the HUD queries at runtime
for (const c of ['boss-row', 'boss-hp', 'boss-dist']) {
  if (!html.includes(c)) fail(`class .${c} queried by HUD but never styled/created in index.html`);
}

// --- 2. CONFIG paths ------------------------------------------------------
console.log('[2] CONFIG paths');
const cfgSrc = read(path.join(ROOT, 'src/core/Config.ts'));
const CONFIG = eval('(' + cfgSrc.replace(/^export const CONFIG = /m, '').replace(/ as const;?\s*$/m, '').replace(/export type Config[\s\S]*$/, '').trim().replace(/;$/, '') + ')');
let badCfg = 0;
for (const f of files) {
  if (rel(f) === 'src/core/Config.ts') continue;
  for (const m of read(f).matchAll(/CONFIG((?:\.[A-Za-z_$][\w$]*)+)/g)) {
    const parts = m[1].slice(1).split('.');
    let node = CONFIG;
    for (const part of parts) {
      if (node === undefined || node === null || !(part in node)) { node = undefined; break; }
      node = node[part];
    }
    if (node === undefined) { fail(`${rel(f)}: CONFIG${m[1]} does not exist`); badCfg++; }
  }
}
if (!badCfg) console.log('  ok — every CONFIG path resolves');

// --- 3. imports resolve ---------------------------------------------------
console.log('[3] imports');
let badImp = 0;
for (const f of files) {
  for (const m of read(f).matchAll(/from\s+'(\.[^']+)'/g)) {
    const target = path.resolve(path.dirname(f), m[1]);
    const ok = ['', '.ts', '.js', '/index.ts'].some((ext) => fs.existsSync(target + ext));
    if (!ok) { fail(`${rel(f)} imports missing ${m[1]}`); badImp++; }
  }
}
if (!badImp) console.log(`  ok — ${files.length} modules, every relative import resolves`);

// --- 4. encoding ----------------------------------------------------------
console.log('[4] encoding');
let mojibake = 0;
for (const f of files.concat([path.join(ROOT, 'index.html')])) {
  const s = read(f);
  const m = s.match(/[\u00c2\u00c3\u00e2][\u0080-\u00bf]/);
  if (m) { fail(`${rel(f)} contains mojibake near "${s.slice(Math.max(0, s.indexOf(m[0]) - 30), s.indexOf(m[0]) + 30)}"`); mojibake++; }
}
if (!mojibake) console.log('  ok — no double-encoded UTF-8 anywhere');

// --- 5. module-level scratch aliasing ------------------------------------
// Flags a function that passes the same module scratch vector as two args, or
// writes one it also reads through an alias in the same statement.
console.log('[5] scratch-vector aliasing');
let aliasHits = 0;
for (const f of files) {
  const s = read(f);
  const scratch = [...s.matchAll(/^const (_[A-Za-z]\w*) = new THREE\.(Vector3|Vector2|Quaternion|Matrix4|Color)\(/gm)].map((m) => m[1]);
  if (!scratch.length) continue;
  const lines = s.split('\n');
  for (let i = 0; i < lines.length; i++) {
    for (const v of scratch) {
      const uses = (lines[i].match(new RegExp('\\b' + v + '\\b', 'g')) || []).length;
      if (uses >= 2 && /\(/.test(lines[i]) && !/^\s*(\/\/|\*)/.test(lines[i])) {
        console.log(`  note ${rel(f)}:${i + 1} ${v} used ${uses}x — ${lines[i].trim().slice(0, 90)}`);
        aliasHits++;
      }
    }
  }
}
console.log(`  ${aliasHits} line(s) flagged for manual read (chained calls on one scratch are fine)`);

// --- 6. villain wiring ----------------------------------------------------
console.log('[6] villain roster coverage');
const enemy = read(path.join(ROOT, 'src/enemies/EnemySystem.ts'));
const kinds = [...enemy.matchAll(/^\s{2}\| '([A-Z ]+)'$/gm)].map((m) => m[1]);
const kindLine = enemy.match(/export type VillainKind =\s*([\s\S]*?);/);
const allKinds = kindLine ? [...kindLine[1].matchAll(/'([A-Z ]+)'/g)].map((m) => m[1]) : [];
const roster = enemy.match(/VILLAIN_KINDS[^=]*=\s*\[([\s\S]*?)\]/);
const inRoster = roster ? [...roster[1].matchAll(/'([A-Z ]+)'/g)].map((m) => m[1]) : [];
for (const k of allKinds) {
  if (!inRoster.includes(k)) fail(`${k} is a VillainKind but is not in VILLAIN_KINDS (never spawns)`);
  if (!new RegExp(`case '${k}':`).test(enemy)) fail(`${k} has no case in the update switch (never acts)`);
}
const voice = read(path.join(ROOT, 'src/audio/Voice.ts'));
for (const k of allKinds) {
  if (!voice.includes(`'${k}'`) && !voice.includes(`  ${k}:`)) fail(`${k} has no taunt bank`);
  if (!/PROFILES/.test(voice)) fail('voice PROFILES table missing');
}
const profiles = voice.match(/const PROFILES[^=]*=\s*\{([\s\S]*?)\n\};/);
for (const k of allKinds) {
  if (profiles && !new RegExp(`['"]?${k}['"]?:`).test(profiles[1])) fail(`${k} has no voice profile`);
}
console.log(`  ${allKinds.length} villains: ${allKinds.join(', ')}`);

// --- 7. story data --------------------------------------------------------
console.log('[7] story data');
const mode = read(path.join(ROOT, 'src/game/GameMode.ts'));
const chapterVillains = [...mode.matchAll(/villains: \[([^\]]*)\]/g)]
  .flatMap((m) => [...m[1].matchAll(/'([A-Z ]+)'/g)].map((x) => x[1]));
for (const k of new Set(chapterVillains)) {
  if (!allKinds.includes(k)) fail(`story references unknown villain '${k}'`);
}
// Bound the count to the authored book list: the file also declares a
// post-game entry and a free-roam entry that are chapters in shape but not
// part of any book, and counting those made this disagree with the runtime
// campaign harness by two.
const authored = mode.slice(mode.indexOf('const AUTHORED'), mode.indexOf('export const BOOKS'));
const chapters = (authored.match(/\btitle: '/g) || []).length - (authored.match(/\btitle: 'Book/g) || []).length;
const books = (authored.match(/\btitle: 'Book/g) || []).length;
const allyChapters = (authored.match(/ally: true/g) || []).length;
const teamUps = [...mode.matchAll(/villains: \[([^\]]*)\]/g)].filter((m) => (m[1].match(/'/g) || []).length >= 4).length;
console.log(`  ${books} books, ${chapters} chapters, ${allyChapters} with a partner, ${teamUps} team-ups`);
if (chapters < 35) fail('chapter count regressed below 35');

// every villain should appear at least once in the story
for (const k of allKinds) {
  if (!chapterVillains.includes(k)) fail(`${k} never appears in any chapter`);
}

console.log('');


// --- 8. villain limbs -----------------------------------------------------
// Geometry added after b.limb() belongs to that limb until endLimb(). A
// builder that forgets to close parents whatever follows — usually the legs —
// to an elbow, which is only visible as a body that folds when an arm swings.
console.log('[8] villain limbs');
const enemies = read(path.join(ROOT, 'src/enemies/EnemySystem.ts'));
const builders = [...enemies.matchAll(/private (build\w+)\(parent: THREE\.Group\)[\s\S]*?return b\.commit\(\);/g)];
let limbCount = 0;
let jointed = 0;
for (const m of builders) {
  const body = m[0];
  const opens = (body.match(/b\.limb\(/g) || []).length;
  if (opens === 0) continue;
  limbCount += opens;
  jointed++;
  if (body.lastIndexOf('b.endLimb()') < body.lastIndexOf('b.limb(')) {
    fail(m[1] + ' opens a limb it never closes with endLimb()');
  }
  // A child limb's third argument must name a limb opened in the same builder.
  for (const ref of body.matchAll(/b\.limb\([^,]+,[^,]+,\s*'(\w+)'/g)) {
    if (!body.includes("b.limb('" + ref[1] + "'")) {
      fail(m[1] + " names an undeclared parent limb '" + ref[1] + "'");
    }
  }
}
console.log('  ' + jointed + ' of ' + builders.length + ' builders articulated, ' + limbCount + ' limbs, all closed');

// Every kind must have a pose profile, or poseLimbs throws on it.
const kindList = enemies.match(/VILLAIN_KINDS[^=]*=\s*\[([\s\S]*?)\]/);
const poseProfiles = enemies.match(/const POSE_PROFILES[^=]*=\s*\{([\s\S]*?)\n\};/);
if (!poseProfiles) fail('POSE_PROFILES table missing');
if (kindList && poseProfiles) {
  for (const k of [...kindList[1].matchAll(/'([A-Z ]+)'/g)].map((x) => x[1])) {
    if (!poseProfiles[1].includes("'" + k + "'") && !poseProfiles[1].includes('\n  ' + k + ':')) {
      fail(k + ' has no pose profile');
    }
  }
}

// --- 9. campaign credit is scoped, and the clock is not nailed down -------
// Two regressions that a typecheck cannot see. Progress used to be computed
// from lifetime totals, so crimes cleared during a boss fight paid for the
// street chapter after it and the story skipped ahead; and the day/night pin
// was a permanent hold on a clock that every chapter pins, so the cycle ran
// once and froze.
console.log('[9] campaign credit and clock release');
const gameSrc = read(path.join(ROOT, 'src/Game.ts'));
const modeSrc = read(path.join(ROOT, 'src/game/GameMode.ts'));

if (/campaign\.update\(/.test(gameSrc)) {
  fail('Game.ts still calls campaign.update() — progress is back on lifetime totals');
}
if (/crimesIntoChapter\(\s*this\./.test(gameSrc)) {
  fail('crimesIntoChapter is being passed a lifetime total again');
}
if (/campaign\.pending\(\s*\w/.test(gameSrc)) {
  fail('pending() is being passed a defeat map again');
}
if (!/campaign\.replay\(this\.storyLog\)/.test(gameSrc)) {
  fail('Game.ts does not drive the campaign from the event log');
}
// Both things a chapter can ask for must reach the log, or that requirement
// can never be met.
if (!/logStoryEvent\(CRIME\)/.test(gameSrc)) fail('cleared crimes are not logged');
if (!/logStoryEvent\(kind as StoryEvent\)/.test(gameSrc)) fail('villain defeats are not logged');
// And the log has to survive a save, or reloading resets the chapter.
if (!/storyLog: \[\.\.\.this\.storyLog\]/.test(gameSrc)) fail('the event log is not written to the save');
if (!/migrateLog\(/.test(gameSrc)) fail('saves written before the log have no migration path');

// Credit must be capped at what the current chapter asked for. Without the
// caps, surplus spills forward again by another route.
if (!/if \(this\.crimesHere < chapter\.crimes\) this\.crimesHere\+\+/.test(modeSrc)) {
  fail('crime credit is no longer capped at the chapter requirement');
}
if (!/if \(have < wanted\)/.test(modeSrc)) {
  fail('villain credit is no longer capped at the chapter requirement');
}

const dayNight = read(path.join(ROOT, 'src/world/DayNight.ts'));
if (!/pinArrival/.test(dayNight) || !/this\.pinned = null;/.test(dayNight.split('update(')[1] ?? '')) {
  fail('the chapter pin has no release path — the clock will freeze after one cycle');
}
console.log('  progress replays the event log; the chapter pin releases on arrival');

// --- 10. story wiring -----------------------------------------------------
// Every one of these is a bug that was actually shipped into the working tree
// and found by reading, not by a crash. They share a shape: the game keeps
// running, and a line simply never reaches the player.
console.log('[10] story wiring');
{
  const story = read(path.join(ROOT, 'src/game/Story.ts'));
  const hud = read(path.join(ROOT, 'src/ui/HUD.ts'));

  // The queue cap must clear a full chapter transition. At four it dropped the
  // incoming boss's entrance and often the whole opening exchange.
  const cap = story.match(/MAX_QUEUED = (\d+)/);
  if (!cap) fail('the director has no queue cap');
  else if (Number(cap[1]) < 8) fail(`director queue cap is ${cap[1]}; a chapter transition needs 7`);

  // Subtitles have to be able to outlast a bark, or long lines lose their text
  // partway through being read aloud.
  if (!/showSubtitle\([^)]*seconds\?: number/s.test(hud)) {
    fail('HUD.showSubtitle takes no duration — long story lines will be cut short');
  }

  // A bark posted before a written line is overwritten a frame later.
  if (/say\('villain_down', true\);\s*\n\s*this\.playBeat/.test(gameSrc)) {
    fail('the villain-down bark is fired before the written line again');
  }
  if (!/if \(!this\.story\.busy\) this\.voice\.say\('villain_down', true\)/.test(gameSrc)) {
    fail('the villain-down bark no longer stands aside for written dialogue');
  }

  // The clear-city line must latch on the line going out, not on the attempt.
  if (!/if \(this\.voice\.say\('all_clear', true\)\) \{/.test(gameSrc)) {
    fail('all_clear is latched on the attempt again — suppressed once means lost forever');
  }

  // Three things the director owns that must not be written straight to the
  // HUD, because a queued line will paint over them.
  for (const [label, pattern] of [
    ['the chapter card', /showSubtitle\(this\.campaign\.progressLabel[\s\S]{0,80}\)/g],
    ['the siege tier', /showSubtitle\(\s*`SIEGE/g],
  ]) {
    const hits = (gameSrc.match(pattern) || []).length;
    // The chapter card has exactly one legitimate direct write: restoring a
    // save, where nothing is queued and nothing is owed.
    const allowed = label === 'the chapter card' ? 1 : 0;
    if (hits > allowed) fail(`${label} is written straight to the HUD (${hits} site(s), ${allowed} allowed)`);
  }

  // Both the director and the bark system have to be told who the hero is.
  const setHero = (gameSrc.match(/this\.voice\.setHero\(/g) || []).length;
  const setStory = (gameSrc.match(/this\.story\.setHero\(/g) || []).length;
  if (setStory < setHero) {
    fail(`voice.setHero is called ${setHero}x but story.setHero only ${setStory}x — HERO will resolve to the wrong hero`);
  }

  // Ambient chatter gated on "any villain alive" starves free roam, which
  // brings the whole roster out at once.
  if (/this\.enemies\.remaining > 0\) \{\s*\n\s*this\.ambientTimer/.test(gameSrc)) {
    fail('ambient radio is gated on the whole roster again — free roam will never hear it');
  }

  // Side threads must stand aside for the main story rather than queue behind it.
  if (!/thread\.beats\[done\]!, 'AMBIENT'/.test(gameSrc)) {
    fail('side-thread beats no longer yield to written chapter dialogue');
  }

  // Reloading in the siege must not be worth a free tier.
  if (!/resumeTier/.test(gameSrc)) fail('the siege escalates on reload again');

  // Latching a scene on the attempt rather than the result throws it away
  // whenever the queue is busy, which for these two is almost always.
  if (!/if \(this\.story\.play\(banter, 'AMBIENT'\)\) this\.banterPlayed = true/.test(gameSrc)) {
    fail('villain cross-talk is latched on the attempt — it will be dropped and never retried');
  }
  if (!/if \(this\.story\.play\(PRESSURE\[villain\.kind\]\)\) this\.pressureSaid = true/.test(gameSrc)) {
    fail('the pressure taunt is latched on the attempt');
  }

  console.log('  ok — director owns the cards, barks stand aside, nothing latches on a refused scene');
}

console.log('');

console.log(problems === 0 ? 'ALL CHECKS PASSED' : `${problems} PROBLEM(S) FOUND`);
process.exit(problems === 0 ? 0 : 1);
