/**
 * Proves a story chapter can only ever field the villain it named.
 *
 * `activateNext(pos, rng, kind)` used to fall back to "anyone still dormant"
 * when the named villain was not dormant. Every rematch chapter names somebody
 * already beaten, so the fallback fired on all of them: the wrong villain
 * arrived, the chapter stayed unfinished, and the next crime fielded another
 * wrong villain — a boss marathon, starting at Book One's finale.
 *
 * This drives the real EnemySystem against a stub city and replays that exact
 * sequence.
 */
import { bundle } from './_bundle.mjs';

const { EnemySystem, VILLAIN_KINDS, Campaign, BOOKS, CRIME, THREE } = await bundle(
  [
    ['{ EnemySystem, VILLAIN_KINDS }', 'src/enemies/EnemySystem'],
    ['{ Campaign, BOOKS, CRIME }', 'src/game/GameMode'],
    ['* as THREE', 'three'],
  ],
  'rematch',
);

let fails = 0;
const fail = (m) => {
  console.log('  FAIL ' + m);
  fails++;
};

// A stub city: EnemySystem only ever asks it for rooftops. Spread them widely
// so the "not on top of another villain" spacing rule has somewhere to go.
let roofSeed = 0;
function roof() {
  roofSeed++;
  const a = roofSeed * 2.399963;
  const r = 300 + ((roofSeed * 137) % 900);
  return {
    roof: new THREE.Vector3(Math.cos(a) * r, 40 + ((roofSeed * 17) % 60), Math.sin(a) * r),
    height: 40,
    width: 30,
    depth: 30,
  };
}
const city = {
  randomRoof: () => roof(),
  roofNear: () => roof(),
  groundHeightAt: () => 0,
  hasLineOfSight: () => true,
  escapeRoof: () => roof(),
};

let seed = 12345;
const rng = () => {
  seed = (seed * 1664525 + 1013904223) >>> 0;
  return seed / 4294967296;
};

const at = new THREE.Vector3(0, 60, 0);
/** Who is on the street in a given system. Takes the system: each block owns one. */
const live = (system) => system.villains.filter((v) => v.alive && !v.dormant).map((v) => v.kind);

console.log(`roster: ${VILLAIN_KINDS.join(', ')}`);

// --- 1. a named villain who has already been beaten comes back as himself --
console.log('\n[1] a rematch fields the villain the chapter named');
{
  const enemies = new EnemySystem(city, rng);
  // Beat Black Cat, exactly as Book One chapter three leaves things.
  const first = enemies.activateNext(at, rng, 'BLACK CAT');
  if (first?.kind !== 'BLACK CAT') fail(`first Black Cat request fielded ${first?.kind}`);
  const cat = enemies.villains.find((v) => v.kind === 'BLACK CAT');
  cat.alive = false;
  cat.dormant = false;
  enemies.refreshActiveTargets?.();

  // Now the finale asks for her again, with the whole rest of the roster still
  // dormant and therefore available to be handed back by mistake.
  const again = enemies.activateNext(at, rng, 'BLACK CAT');
  if (!again) fail('the rematch fielded nobody at all — the chapter would stall');
  if (again && again.kind !== 'BLACK CAT') {
    fail(`the rematch fielded ${again.kind} instead of BLACK CAT — the marathon is back`);
  }
  console.log(`  requested BLACK CAT after her defeat, got ${again?.kind}`);
  if (again) {
    if (again.hp !== again.maxHp) fail('the revived villain did not come back at full health');
    if (again.hp <= 0) fail('the revived villain came back dead');
    console.log(`  revived at ${again.hp}/${again.maxHp} hp, dormant=${again.dormant}`);
  }
  if (live(enemies).length !== 1) fail(`the rematch put ${live(enemies).length} villains on the street: ${live(enemies)}`);
}

// --- 2. never hand back somebody the chapter did not ask for --------------
console.log('\n[2] no request is ever answered with the wrong villain');
{
  const e = new EnemySystem(city, rng);
  let wrong = 0;
  for (const kind of VILLAIN_KINDS) {
    // Field them, beat them, then demand them back — twice over, so both the
    // dormant path and the revival path are exercised for every villain.
    for (let round = 0; round < 2; round++) {
      const got = e.activateNext(at, rng, kind);
      if (!got) {
        fail(`${kind} could not be fielded on round ${round + 1}`);
        continue;
      }
      if (got.kind !== kind) {
        wrong++;
        fail(`asked for ${kind} on round ${round + 1}, got ${got.kind}`);
      }
      got.alive = false;
      got.dormant = false;
    }
  }
  console.log(`  12 requests across ${VILLAIN_KINDS.length} villains, ${wrong} answered wrongly`);
}

// --- 3. replay Book One's finale the way the game actually drives it -------
// The loop in advanceCampaign: while the chapter still wants somebody who is
// not live, field them. Under the bug this fielded the entire roster.
console.log('\n[3] Book One, played through');
{
  const e = new EnemySystem(city, rng);
  const campaign = new Campaign('STORY');
  const log = [];
  const bookOne = BOOKS[0].chapters;
  const fielded = [];
  let guard = 0;

  for (let ch = 0; ch < bookOne.length; ch++) {
    const chapter = campaign.current;
    // Field whoever this chapter is waiting on, exactly as the game does.
    for (const kind of campaign.pending()) {
      if (e.villains.some((v) => v.kind === kind && v.alive && !v.dormant)) continue;
      const v = e.activateNext(at, rng, kind);
      if (!v) fail(`"${chapter.title}" asked for ${kind} and got nobody`);
      else fielded.push(`${chapter.title}: ${v.kind}`);
    }
    const onStreet = live(e);
    if (onStreet.length > chapter.villains.length) {
      fail(`"${chapter.title}" wants ${chapter.villains.length} boss(es) but ${onStreet.length} turned up: ${onStreet}`);
    }
    // Clear the chapter: its crimes, then its bosses.
    for (let i = 0; i < chapter.crimes; i++) log.push(CRIME);
    for (const kind of chapter.villains) {
      const v = e.villains.find((x) => x.kind === kind && x.alive && !x.dormant);
      if (!v) fail(`"${chapter.title}" named ${kind} but ${kind} is not on the street`);
      else {
        v.alive = false;
        v.dormant = false;
      }
      log.push(kind);
    }
    if (!campaign.replay(log)) fail(`"${chapter.title}" did not complete`);
    if (++guard > 20) break;
  }

  for (const line of fielded) console.log(`  ${line}`);
  const kinds = new Set(fielded.map((f) => f.split(': ')[1]));
  if (kinds.size !== 1 || !kinds.has('BLACK CAT')) {
    fail(`Book One fielded ${[...kinds].join(', ')} — it is Black Cat's book and hers alone`);
  }
  if (fielded.length !== 2) fail(`Book One fielded ${fielded.length} bosses, expected 2`);
  console.log(`  Book One fielded ${fielded.length} bosses, both Black Cat, and closed`);
  console.log(`  now on: ${campaign.progressLabel} · ${campaign.current.title}`);
}

console.log(fails === 0 ? '\nREMATCH LOGIC OK' : `\n${fails} PROBLEM(S)`);
process.exit(fails === 0 ? 0 : 1);
