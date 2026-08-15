// Exercises Campaign progression: does a 39-chapter, team-up, rematch-heavy
// story actually advance one chapter at a time and never skip or stall?
import { bundle } from './_bundle.mjs';

const { Campaign, BOOKS, CHAPTER_COUNT, requiredHeroFor, CRIME, migrateLog } = await bundle(
  [['{ Campaign, BOOKS, CHAPTER_COUNT, requiredHeroFor, CRIME, migrateLog }', 'src/game/GameMode']],
  'campaign',
);

let fails = 0;
const check = (cond, msg) => { if (!cond) { fails++; console.log('  FAIL ' + msg); } };

const flat = BOOKS.flatMap((b) => b.chapters);
console.log(`chapters: ${CHAPTER_COUNT} (flattened ${flat.length}) across ${BOOKS.length} books`);
check(CHAPTER_COUNT === flat.length, 'CHAPTER_COUNT disagrees with the book data');

// --- walk the whole campaign, satisfying exactly what each chapter asks ----
const c = new Campaign('STORY');
const log = [];
let steps = 0;

for (let i = 0; i < flat.length; i++) {
  const chapter = c.current;
  check(chapter.title === flat[i].title, `at step ${i}: expected "${flat[i].title}", got "${chapter.title}"`);

  // Pending should list exactly this chapter's outstanding villains.
  const pending = c.pending();
  check(
    pending.length === chapter.villains.length,
    `"${chapter.title}": pending ${JSON.stringify(pending)} != villains ${JSON.stringify(chapter.villains)}`,
  );

  for (let n = 0; n < chapter.crimes; n++) log.push(CRIME);
  // Beating only the first of a team-up must NOT advance the chapter.
  if (chapter.villains.length > 1) {
    log.push(chapter.villains[0]);
    check(
      c.replay(log) === false,
      `"${chapter.title}": advanced after beating only 1 of ${chapter.villains.length}`,
    );
    check(
      c.pending().length === chapter.villains.length - 1,
      `"${chapter.title}": half-cleared team-up still lists all villains as pending (would respawn the dead one)`,
    );
    for (const k of chapter.villains.slice(1)) log.push(k);
  } else {
    for (const k of chapter.villains) log.push(k);
  }

  check(c.replay(log), `"${chapter.title}": did not advance after meeting every requirement`);
  steps++;
}

check(c.complete, 'campaign did not report complete after clearing every chapter');
check(c.current.title === 'The City Is Yours', 'wrong post-campaign chapter: ' + c.current.title);
console.log(`walked ${steps} chapters to completion on a ${log.length}-event log`);

// --- idempotence: repeated replay() must not move the index ---------------
const before = c.progressLabel;
c.replay(log);
c.replay(log);
check(c.progressLabel === before, 'replay() is not idempotent');

// --- rebuild from a save: the same log must land on the same chapter ------
const prefix = [];
for (let i = 0; i < 20; i++) {
  for (let n = 0; n < flat[i].crimes; n++) prefix.push(CRIME);
  prefix.push(...flat[i].villains);
}
const mid = new Campaign('STORY');
mid.replay(prefix);
check(mid.current.title === flat[20].title, `save rebuild landed on "${mid.current.title}", expected "${flat[20].title}"`);
check(mid.chaptersDone === 20, `chaptersDone = ${mid.chaptersDone}, expected 20`);

// --- THE BUG: credit must be scoped to the chapter it was earned in -------
// Crimes cleared while a boss is up were being banked against a lifetime
// total, so they silently paid for the street chapter that followed. Two boss
// chapters in a row would then complete back to back with nothing in between,
// which is what "book two is a boss rush" looked like from the player's seat.
console.log('\nchapter-scoped credit:');
{
  // Book One: 2 crimes, 2 crimes, Black Cat, 3 crimes, Black Cat.
  const g = new Campaign('STORY');
  const l = [CRIME, CRIME, CRIME, CRIME];
  g.replay(l);
  check(g.current.title === 'Rooftop Pursuit', `expected the first boss, got "${g.current.title}"`);

  // Clear ten crimes during the boss fight, then beat the boss.
  for (let i = 0; i < 10; i++) l.push(CRIME);
  l.push('BLACK CAT');
  g.replay(l);
  check(
    g.current.title === 'What She Left',
    `ten crimes banked during a boss fight skipped ahead to "${g.current.title}"`,
  );
  check(
    g.crimesIntoChapter() === 0,
    `the new chapter opened with ${g.crimesIntoChapter()}/3 crimes already credited`,
  );
  console.log(`  10 surplus crimes during a boss fight advanced exactly 1 chapter, at 0/${g.current.crimes}`);

  // And the surplus must not have quietly survived to pay later either.
  for (let i = 0; i < 2; i++) l.push(CRIME);
  g.replay(l);
  check(g.current.title === 'What She Left', 'the chapter completed two crimes short');
  check(g.crimesIntoChapter() === 2, `crimesIntoChapter reported ${g.crimesIntoChapter()}, expected 2`);
  l.push(CRIME);
  g.replay(l);
  check(g.current.title === 'Second Story', `expected the rematch, got "${g.current.title}"`);
}
{
  // Killing the same villain twice in one chapter must not pre-pay a rematch.
  const g = new Campaign('STORY');
  const l = [CRIME, CRIME, CRIME, CRIME, 'BLACK CAT', 'BLACK CAT', 'BLACK CAT'];
  g.replay(l);
  check(g.current.title === 'What She Left', `overkill skipped to "${g.current.title}"`);
  console.log('  3 Black Cat defeats in her first chapter did not pre-pay her rematch');
}

// --- migrating a save written before the log existed ----------------------
console.log('\nlegacy save migration:');
{
  let crimes = 0;
  const defeated = [];
  for (let i = 0; i < 14; i++) {
    crimes += flat[i].crimes;
    defeated.push(...flat[i].villains);
  }
  const migrated = migrateLog(crimes, defeated);
  const m = new Campaign('STORY');
  m.replay(migrated);
  check(m.chaptersDone === 14, `migrated save landed on chapter ${m.chaptersDone}, expected 14`);
  console.log(`  ${crimes} crimes + ${defeated.length} defeats -> ${migrated.length} events -> chapter ${m.chaptersDone}`);

  // A legacy save with surplus crimes must not migrate the skip along with it.
  const generous = migrateLog(crimes + 40, defeated);
  const g = new Campaign('STORY');
  g.replay(generous);
  check(
    g.chaptersDone === 14,
    `40 surplus lifetime crimes migrated into ${g.chaptersDone - 14} skipped chapters`,
  );
  console.log('  40 surplus lifetime crimes migrated to the same chapter, not past it');

  check(migrateLog(0, []).length === 0, 'a fresh legacy save migrated to a non-empty log');
}

// --- rematches: a villain beaten in book one must not auto-clear book seven
const rematch = new Campaign('STORY');
const everyone = ['BLACK CAT', 'ELECTRO', 'VENOM', 'SANDMAN', 'GREEN GOBLIN', 'SYMBIOTE PETER'];
const flood = [];
for (let i = 0; i < 400; i++) flood.push(CRIME);
flood.push(...everyone);
rematch.replay(flood);
check(
  !rematch.complete,
  'one defeat each cleared the whole campaign — the counted-defeat rule has regressed to a flag',
);
console.log(`\nwith 1 defeat each + 400 crimes, progress stops at: ${rematch.progressLabel} · ${rematch.current.title}`);

// --- free roam never advances --------------------------------------------
const free = new Campaign('FREE_ROAM');
check(free.replay(flood) === false, 'free roam advanced a chapter');
check(free.pending().length === 0, 'free roam reported pending villains');
check(free.crimesIntoChapter() === 0, 'free roam reported chapter crime progress');

// --- every villain and every ally flag is reachable -----------------------
const kinds = new Set(flat.flatMap((ch) => ch.villains));
console.log(`villains used in story: ${[...kinds].join(', ')}`);
const forced = flat.filter((ch) => ch.forceHero);
const allies = flat.filter((ch) => ch.ally);
console.log(`${forced.length} forced-hero chapters, ${allies.length} partner chapters`);
for (const ch of flat) {
  check(!(ch.ally && ch.forceHero), `"${ch.title}" has both ally and forceHero — the partner would be the villain`);
  check(ch.crimes > 0 || ch.villains.length > 0, `"${ch.title}" has no completion condition and would stall the story`);
}

// --- hero lock: you can never fight yourself, or fight beside the villain --
console.log('\nhero lock:');
for (const ch of flat) {
  const locked = ch.villains.map((k) => requiredHeroFor(k)).find(Boolean) ?? null;
  if (!locked) continue;
  console.log(`  "${ch.title}" [${ch.villains.join(' + ')}] -> forceHero=${ch.forceHero}, ally=${!!ch.ally}`);
  check(ch.forceHero === locked, `"${ch.title}" fields ${ch.villains.join('+')} but does not force ${locked}`);
  check(!ch.ally, `"${ch.title}" fields ${ch.villains.join('+')} and still has a partner`);
}

const symbioteChapters = flat.filter((c) => c.villains.includes('SYMBIOTE PETER'));
check(symbioteChapters.length > 0, 'no Symbiote Peter chapters exist to verify');
check(
  symbioteChapters.every((c) => c.forceHero === 'MILES' && !c.ally),
  'a Symbiote Peter chapter escaped the hero lock',
);
console.log(`  ${symbioteChapters.length} Symbiote Peter chapters, all Miles-only with no partner`);
check(requiredHeroFor('SYMBIOTE PETER') === 'MILES', 'requiredHeroFor lost the Symbiote Peter rule');
check(requiredHeroFor('VENOM') === null, 'requiredHeroFor locks a hero it should not');

console.log('');
console.log(fails === 0 ? 'CAMPAIGN LOGIC OK' : `${fails} CAMPAIGN FAILURE(S)`);
process.exit(fails === 0 ? 0 : 1);
