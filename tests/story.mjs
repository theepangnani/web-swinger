/**
 * The narrative layer: does every chapter have dialogue, and can every line
 * actually reach the player?
 *
 * Story beats are keyed by chapter *title* rather than by index, which buys
 * immunity to chapters being reordered and costs a hard dependency on those
 * titles being unique and stable. Both halves of that bargain are checked
 * here, along with the quieter failure this file exists for: a beat written
 * for a villain the chapter never fields, or for a partner the chapter never
 * gives you, is silently never spoken. Nothing crashes. The scene simply does
 * not happen, and only a test notices.
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { bundle, ROOT } from './_bundle.mjs';

const {
  BOOKS,
  requiredHeroFor,
  VOICE_LINES,
  CHAPTER_BEATS,
  AMBIENT,
  DISPATCH,
  CRIME_LOST,
  CRIME_KINDS,
  TURN,
  PRESSURE,
  DEFEAT,
  FALL,
  RESCUE,
  PROLOGUE,
  BACKPACK_MEMORIES,
  BOOK_ENDINGS,
  SIEGE,
  THREADS,
  STORY_LINES,
  StoryDirector,
  speakerColor,
  speakerName,
} = await bundle(
  [
    ['{ BOOKS, requiredHeroFor }', 'src/game/GameMode'],
    ['{ CRIME_KINDS }', 'src/enemies/ThugSystem'],
    ['{ VOICE_LINES }', 'src/audio/Voice'],
    [
      '{ CHAPTER_BEATS, AMBIENT, DISPATCH, CRIME_LOST, TURN, PRESSURE, DEFEAT, FALL, RESCUE, PROLOGUE, BACKPACK_MEMORIES, BOOK_ENDINGS, SIEGE, THREADS, STORY_LINES, StoryDirector, speakerColor, speakerName }',
      'src/game/Story',
    ],
  ],
  'story',
);

const VILLAINS = ['BLACK CAT', 'ELECTRO', 'SANDMAN', 'VENOM', 'GREEN GOBLIN', 'SYMBIOTE PETER'];
/** Book Six is the first book that guarantees you are playing Miles. */
const MILES_BOOK = 5;

/** Whether a script puts words in Miles' mouth, or in the mouth of his family. */
function mentionsMiles(script) {
  return script.some(([who, text]) => who === 'MILES' || who === 'RIO' || /\bMiles\b/.test(text));
}

const HERO_LOCKED = new Set(['SYMBIOTE PETER']);

let problems = 0;
const fail = (msg) => {
  problems++;
  console.log('  FAIL ' + msg);
};
const ok = (msg) => console.log('  ok — ' + msg);

const CHAPTERS = BOOKS.flatMap((book, b) => book.chapters.map((c) => ({ ...c, book: b })));
const KNOWN_SPEAKERS = new Set([
  'PETER',
  'MILES',
  'MJ',
  'MAY',
  'YURI',
  'JAMESON',
  'GANKE',
  'RIO',
  'DANIKA',
  'HERO',
  'PARTNER',
  'BLACK CAT',
  'ELECTRO',
  'SANDMAN',
  'VENOM',
  'GREEN GOBLIN',
  'SYMBIOTE PETER',
]);

/** Every script in a chapter's beats, tagged with where it came from. */
function scriptsOf(beats) {
  const out = [];
  for (const key of ['open', 'mid', 'close', 'banter']) if (beats[key]) out.push([key, beats[key]]);
  for (const key of ['meet', 'turn', 'down']) {
    for (const [villain, script] of Object.entries(beats[key] ?? {})) out.push([`${key}.${villain}`, script]);
  }
  return out;
}

// --- 1. the keying assumption --------------------------------------------
console.log('[1] chapter titles are unique');
{
  const seen = new Map();
  for (const c of CHAPTERS) seen.set(c.title, (seen.get(c.title) ?? 0) + 1);
  const dupes = [...seen].filter(([, n]) => n > 1);
  for (const [title, n] of dupes) fail(`"${title}" is the title of ${n} chapters — beats key by title`);
  if (!dupes.length) ok(`${CHAPTERS.length} chapters, ${seen.size} distinct titles`);
}

// --- 2. no orphaned beats -------------------------------------------------
console.log('[2] every beat belongs to a chapter');
{
  const titles = new Set(CHAPTERS.map((c) => c.title));
  let orphans = 0;
  for (const title of Object.keys(CHAPTER_BEATS)) {
    if (!titles.has(title)) {
      fail(`beats written for "${title}", which is not a chapter — they can never play`);
      orphans++;
    }
  }
  if (!orphans) ok(`${Object.keys(CHAPTER_BEATS).length} beat sets, all matched to a chapter`);
}

// --- 3. coverage ----------------------------------------------------------
console.log('[3] every chapter has dialogue');
{
  let bare = 0;
  for (const c of CHAPTERS) {
    const beats = CHAPTER_BEATS[c.title];
    if (!beats) {
      fail(`"${c.title}" has no beats at all`);
      bare++;
      continue;
    }
    if (!beats.open) fail(`"${c.title}" has no opening line`);
    // A boss chapter without a closing line ends on a health bar emptying.
    if (!beats.close) fail(`"${c.title}" has no closing line`);
  }
  if (!bare) ok('all chapters open and close on written dialogue');
}

// --- 4. beats point at villains the chapter actually fields ---------------
console.log('[4] boss beats match the chapter roster');
{
  let mismatched = 0;
  for (const c of CHAPTERS) {
    const beats = CHAPTER_BEATS[c.title] ?? {};
    const roster = new Set(c.villains);
    for (const key of ['meet', 'turn', 'down']) {
      for (const villain of Object.keys(beats[key] ?? {})) {
        if (!roster.has(villain)) {
          fail(`"${c.title}" has a ${key} beat for ${villain}, who never appears in it`);
          mismatched++;
        }
      }
    }
    // Cross-talk needs two villains to talk to, and everyone in it has to be
    // on the roof: a banter line from an absent villain is a scene with a
    // speaker who is not in it.
    if (beats.banter) {
      if (c.villains.length < 2) {
        fail(`"${c.title}" has villain cross-talk but fields ${c.villains.length} villain(s)`);
        mismatched++;
      }
      for (const [who] of beats.banter) {
        if (who !== 'HERO' && who !== 'PARTNER' && !roster.has(who)) {
          fail(`"${c.title}" cross-talk has ${who}, who is not in the fight`);
          mismatched++;
        }
      }
    }
    for (const villain of roster) {
      if (!beats.meet?.[villain]) fail(`"${c.title}" fields ${villain} with no arrival line`);
      if (!beats.down?.[villain]) fail(`"${c.title}" fields ${villain} with no defeat line`);
    }
  }
  if (!mismatched) ok('every boss arrives and falls on a written line, and none is written for a no-show');
}

// --- 5. HERO and PARTNER resolve -----------------------------------------
console.log('[5] speaker tokens resolve');
{
  let bad = 0;
  for (const c of CHAPTERS) {
    const beats = CHAPTER_BEATS[c.title] ?? {};
    for (const [where, script] of scriptsOf(beats)) {
      for (const [who, text] of script) {
        if (!KNOWN_SPEAKERS.has(who)) {
          fail(`"${c.title}" ${where}: unknown speaker ${who}`);
          bad++;
        }
        // The partner only exists in chapters that summon one. Elsewhere the
        // line is spoken by somebody who is not in the scene.
        if (who === 'PARTNER' && !c.ally) {
          fail(`"${c.title}" ${where} has a PARTNER line, but the chapter has no partner`);
          bad++;
        }
        if (!text || !text.trim()) {
          fail(`"${c.title}" ${where}: empty line`);
          bad++;
        }
      }
    }
  }
  if (!bad) ok('every line has a speaker who is in the scene');
}

// --- 6. the halfway line has somewhere to land ---------------------------
console.log('[6] mid-chapter beats');
{
  let bad = 0;
  for (const c of CHAPTERS) {
    const beats = CHAPTER_BEATS[c.title] ?? {};
    // Game.playMidBeat refuses to fire below two crimes: with one, the halfway
    // line and the closing line would arrive back to back.
    if (beats.mid && c.crimes < 2) {
      fail(`"${c.title}" has a mid beat but only ${c.crimes} crime(s) — it can never fire`);
      bad++;
    }
    if (!beats.mid && c.crimes >= 2) {
      fail(`"${c.title}" asks for ${c.crimes} crimes with nothing said in between`);
      bad++;
    }
  }
  if (!bad) ok('every street chapter has a halfway line, and no boss chapter has an unreachable one');
}

// --- 7. clip indices ------------------------------------------------------
console.log('[7] recorded-clip indices');
{
  // Every line must be findable in its speaker bank, or a clip pack would play
  // a different recording than the subtitle shows.
  let missing = 0;
  const check = (speaker, text, where) => {
    const bank = STORY_LINES[speaker];
    if (!bank || bank.indexOf(text) < 0) {
      fail(`${where}: "${text.slice(0, 40)}..." is not in the ${speaker} bank`);
      missing++;
    }
  };
  const checkScript = (script, where) => {
    for (const [who, text] of script) {
      // HERO and PARTNER can each be either hero, so both banks must carry it.
      if (who === 'HERO' || who === 'PARTNER') {
        check('PETER', text, where);
        check('MILES', text, where);
      } else {
        check(who, text, where);
      }
    }
  };
  for (const c of CHAPTERS) {
    for (const [where, script] of scriptsOf(CHAPTER_BEATS[c.title] ?? {})) {
      checkScript(script, `${c.title} ${where}`);
    }
  }
  // Every bank that is not hung off a chapter. Missing one here is the exact
  // failure this section exists for: the lines play, the subtitles are right,
  // and a recorded clip pack plays somebody else's line underneath them.
  for (const [villain, script] of Object.entries(TURN)) checkScript(script, `TURN.${villain}`);
  for (const [villain, script] of Object.entries(PRESSURE)) checkScript(script, `PRESSURE.${villain}`);
  for (const [book, script] of Object.entries(BOOK_ENDINGS)) checkScript(script, `ending.${book}`);
  SIEGE.forEach((script, i) => checkScript(script, `siege.${i}`));
  for (const thread of THREADS) {
    thread.beats.forEach((script, i) => checkScript(script, `${thread.title}.${i}`));
  }
  for (const [villain, script] of Object.entries(DEFEAT)) checkScript(script, `DEFEAT.${villain}`);
  checkScript(FALL, 'FALL');
  for (const [who, script] of Object.entries(RESCUE)) checkScript(script, `RESCUE.${who}`);
  BACKPACK_MEMORIES.forEach((script, i) => checkScript(script, `backpack.${i}`));
  PROLOGUE.forEach((scene, i) => checkScript(scene.script, `prologue.${i}`));
  for (const entry of AMBIENT) checkScript(entry.script, 'ambient');
  for (const [kind, scripts] of Object.entries(DISPATCH)) {
    scripts.forEach((script, i) => checkScript(script, `dispatch.${kind}.${i}`));
  }
  CRIME_LOST.forEach((script, i) => checkScript(script, `crime-lost.${i}`));
  for (const speaker of Object.keys(STORY_LINES)) {
    const bank = STORY_LINES[speaker];
    if (new Set(bank).size !== bank.length) fail(`${speaker} bank has duplicate lines — indices are ambiguous`);
  }
  const total = Object.values(STORY_LINES).reduce((n, b) => n + b.length, 0);
  if (!missing) ok(`${total} lines across ${Object.keys(STORY_LINES).length} speakers, every index resolves`);
}

// --- 8. radio and dispatch ------------------------------------------------
console.log('[8] radio and dispatch');
{
  let bad = 0;
  const books = BOOKS.length;
  for (const entry of AMBIENT) {
    if (entry.book < 0 || entry.book >= books) {
      fail(`ambient segment gated on book ${entry.book}, which does not exist`);
      bad++;
    }
    for (const [who] of entry.script) {
      if (!KNOWN_SPEAKERS.has(who)) {
        fail(`ambient segment has unknown speaker ${who}`);
        bad++;
      }
    }
  }
  // Book zero has to have something, or the radio is silent for the first
  // book of the game — which is exactly when the player is deciding whether
  // this city has anyone living in it.
  if (!AMBIENT.some((e) => e.book === 0)) fail('nothing on the radio in Book One');
  // Dispatch is keyed by what is actually happening, so a kind with no calls
  // is a crime the radio cannot describe — and the fallback is silence, which
  // reads as the radio being broken rather than as that crime being quiet.
  let calls = 0;
  for (const kind of CRIME_KINDS) {
    const scripts = DISPATCH[kind];
    if (!scripts || scripts.length === 0) {
      fail(`no dispatch call for a ${kind} — the radio cannot announce it`);
      bad++;
      continue;
    }
    calls += scripts.length;
    for (const script of scripts) {
      for (const [who] of script) {
        if (!KNOWN_SPEAKERS.has(who)) {
          fail(`dispatch for ${kind} has unknown speaker ${who}`);
          bad++;
        }
      }
    }
  }
  for (const kind of Object.keys(DISPATCH)) {
    if (!CRIME_KINDS.includes(kind)) {
      fail(`dispatch written for "${kind}", which is not a crime kind`);
      bad++;
    }
  }
  if (CRIME_LOST.length < 2) fail('losing a crime has almost nothing to say about it');
  if (!bad) {
    ok(
      `${AMBIENT.length} radio segments across ${books} books, ` +
        `${calls} dispatch calls over ${CRIME_KINDS.length} crime kinds`,
    );
  }
}

// --- 9. house style -------------------------------------------------------
console.log('[9] house style');
{
  // Every bark bank in Voice.ts is written without contractions, because a
  // speech synthesiser handles "do not" far more reliably than "don't". Story
  // lines go through the same synthesiser.
  let contractions = 0;
  for (const [speaker, bank] of Object.entries(STORY_LINES)) {
    for (const text of bank) {
      if (/['’]/.test(text)) {
        fail(`${speaker}: "${text.slice(0, 50)}" uses an apostrophe — banks are contraction-free`);
        contractions++;
      }
    }
  }
  if (!contractions) ok('no contractions anywhere — every line survives a synthesiser');
}

// --- 10. presentation -----------------------------------------------------
console.log('[10] subtitle presentation');
{
  let bad = 0;
  for (const speaker of Object.keys(STORY_LINES)) {
    if (!/^#[0-9a-f]{6}$/i.test(speakerColor(speaker))) {
      fail(`${speaker} has no subtitle colour`);
      bad++;
    }
    if (!speakerName(speaker)) {
      fail(`${speaker} has no display name`);
      bad++;
    }
  }
  // Villains must not be coloured as friends — that is the one distinction the
  // colour is carrying.
  if (speakerColor('VENOM') === speakerColor('MJ')) fail('villains and allies share a subtitle colour');
  if (!bad) ok('every speaker has a colour and a display name');
}

// --- 11. mid-fight, book endings, siege and threads ----------------------
console.log('[11] the rest of the story');
{
  let bad = 0;

  // Every villain must have both, or the fight goes quiet for whoever is
  // missing — and these are the banks that cover free roam and the siege,
  // where there is no chapter to fall back on.
  for (const villain of VILLAINS) {
    if (!TURN[villain]) {
      fail(`${villain} has nothing to say when the fight turns`);
      bad++;
    }
    if (!PRESSURE[villain]) {
      fail(`${villain} has nothing to say when the player is nearly down`);
      bad++;
    }
  }

  // Going down used to be silent, which is how a player loses a fight without
  // noticing. Whoever did it has to have a line.
  for (const villain of VILLAINS) {
    if (!DEFEAT[villain]) {
      fail(`${villain} says nothing when they put the player down`);
      bad++;
    }
  }
  if (!FALL || FALL.length === 0) fail('falling out of the world says nothing');

  // One ending per book, and no ending for a book that does not exist.
  const bookTitles = new Set(BOOKS.map((b) => b.title));
  for (const book of BOOKS) {
    if (!BOOK_ENDINGS[book.title]) {
      fail(`${book.title} ends without a word`);
      bad++;
    }
  }
  for (const title of Object.keys(BOOK_ENDINGS)) {
    if (!bookTitles.has(title)) {
      fail(`there is an ending for "${title}", which is not a book`);
      bad++;
    }
  }

  if (SIEGE.length < 4) {
    fail('the post-game has almost nothing to say');
    bad++;
  }

  // Threads are keyed by title in the save, so duplicates would share progress.
  const seen = new Set();
  for (const thread of THREADS) {
    if (seen.has(thread.title)) {
      fail(`two threads are called "${thread.title}" — they would share saved progress`);
      bad++;
    }
    seen.add(thread.title);
    if (thread.book < 0 || thread.book >= BOOKS.length) {
      fail(`thread "${thread.title}" is gated on book ${thread.book}, which does not exist`);
      bad++;
    }
    if (thread.beats.length < 2) {
      fail(`thread "${thread.title}" is not an arc, it is one line`);
      bad++;
    }
    for (const beat of thread.beats) {
      if (!beat.length) {
        fail(`thread "${thread.title}" has an empty beat`);
        bad++;
      }
    }
  }

  const threadBeats = THREADS.reduce((n, t) => n + t.beats.length, 0);
  if (!bad) {
    ok(
      `${VILLAINS.length} villains talk mid-fight, under pressure and over a body, ` +
        `${BOOKS.length} book endings, ${SIEGE.length} siege segments, ` +
        `${THREADS.length} threads over ${threadBeats} beats`,
    );
  }
}

// --- 12. lines cannot be put in the wrong hero's mouth -------------------
console.log('[12] Miles-specific dialogue is gated');
{
  // Book Six is the first book that forces Miles. Anything that addresses him
  // by name, or that comes from his mother, is wrong on a night the player
  // chose to be Peter — and the failure is silent: the line simply plays to
  // the wrong person.
  let bad = 0;

  for (const c of CHAPTERS) {
    for (const [where, script] of scriptsOf(CHAPTER_BEATS[c.title] ?? {})) {
      if (mentionsMiles(script) && c.forceHero !== 'MILES') {
        fail(`"${c.title}" ${where} names Miles, but the chapter does not force him`);
        bad++;
      }
    }
  }

  for (const entry of AMBIENT) {
    if (mentionsMiles(entry.script) && entry.book < MILES_BOOK) {
      fail(`a radio segment names Miles but unlocks in book ${entry.book}`);
      bad++;
    }
  }

  for (const thread of THREADS) {
    if (thread.beats.some(mentionsMiles) && thread.book < MILES_BOOK) {
      fail(`thread "${thread.title}" names Miles but unlocks in book ${thread.book}`);
      bad++;
    }
  }

  // A book ending plays immediately after that book's last chapter, so the
  // hero is whoever that chapter forced.
  for (const book of BOOKS) {
    const ending = BOOK_ENDINGS[book.title];
    if (!ending || !mentionsMiles(ending)) continue;
    const last = book.chapters[book.chapters.length - 1];
    if (last.forceHero !== 'MILES') {
      fail(`${book.title} ends on a line naming Miles, but "${last.title}" does not force him`);
      bad++;
    }
  }

  // The global banks have no chapter behind them. A Miles line in one is only
  // safe if the villain it belongs to forces Miles wherever they appear.
  for (const [villain, script] of Object.entries({ ...TURN, ...PRESSURE })) {
    if (mentionsMiles(script) && requiredHeroFor(villain) !== 'MILES') {
      fail(`${villain} has a Miles line but does not force Miles into the fight`);
      bad++;
    }
  }

  // RESCUE is the deliberate exception, and worth stating rather than quietly
  // skipping: it is keyed by *who arrives*, so Miles only ever speaks in the
  // entry used when Miles is the one who came. The check is that the keying
  // holds — a Miles line under the PETER key would be exactly the bug.
  for (const [arriving, script] of Object.entries(RESCUE)) {
    for (const [who] of script) {
      if (who !== 'HERO' && who !== arriving) {
        fail(`RESCUE.${arriving} has a line from ${who}, who is not the one arriving`);
        bad++;
      }
    }
  }

  // The prologue is a flashback to nights Miles was not present for, and is
  // delivered as Peter whoever the player picked. A MILES line in it would be
  // a line from somebody who is not in the scene — and unlike everywhere else
  // in this file, no book gating can make it true.
  PROLOGUE.forEach((scene, i) => {
    for (const [who] of scene.script) {
      if (who === 'MILES' || who === 'RIO' || who === 'GANKE' || who === 'PARTNER') {
        fail(`prologue scene ${i} ("${scene.title}") has a line from ${who}, who was not there`);
        bad++;
      }
    }
  });

  // Backpacks are found by whoever is wearing the mask, in any book.
  for (const script of BACKPACK_MEMORIES) {
    if (mentionsMiles(script)) {
      fail('a backpack memory names Miles, but they are found in every book');
      bad++;
    }
  }

  if (!bad) ok('nothing addresses Miles on a night the player could be Peter');
}

// --- 12b. the prologue ----------------------------------------------------
console.log('[12b] the prologue');
{
  let bad = 0;
  if (PROLOGUE.length < 2) fail('the prologue is not an opening, it is a line');
  const seen = new Set();
  for (const scene of PROLOGUE) {
    if (!scene.label || !scene.title) {
      fail('a prologue scene has no card');
      bad++;
    }
    if (seen.has(scene.title)) {
      fail(`two prologue scenes are called "${scene.title}"`);
      bad++;
    }
    seen.add(scene.title);
    if (!scene.script.length) {
      fail(`prologue scene "${scene.title}" is empty`);
      bad++;
    }
    for (const [who] of scene.script) {
      if (!KNOWN_SPEAKERS.has(who)) {
        fail(`prologue "${scene.title}": unknown speaker ${who}`);
        bad++;
      }
    }
  }
  // Each scene is a card plus a script, and they are all queued at once ahead
  // of the first chapter card — so the queue has to be able to hold the lot.
  const entries = PROLOGUE.length * 2 + 3;
  const d = new StoryDirector();
  let accepted = 0;
  for (const scene of PROLOGUE) {
    if (d.playCard(scene.label, scene.title)) accepted++;
    if (d.playAs('PETER', scene.script)) accepted++;
  }
  if (accepted !== PROLOGUE.length * 2) {
    fail(`the queue dropped ${PROLOGUE.length * 2 - accepted} of the prologue`);
    bad++;
  }

  // playAs must not leave the director pointed at the wrong hero afterwards.
  const e = new StoryDirector();
  e.setHero('MILES');
  e.playAs('PETER', [['HERO', 'Flashback.']]);
  const said = [];
  e.onLine = (line) => said.push(line.speaker);
  e.play([['HERO', 'Now.']]);
  for (let i = 0; i < 60 && e.busy; i++) e.update(0.5);
  if (said[0] !== 'PETER') fail(`the flashback was spoken by ${said[0]}, not Peter`);
  else if (said[1] !== 'MILES') fail(`after the flashback the hero is ${said[1]}, not Miles again`);
  else if (!bad) ok(`${PROLOGUE.length} scenes, ${entries} queue entries, hero restored after`);
}

// --- 13. the director -----------------------------------------------------
console.log('[13] director');
{
  const drain = (d, steps = 400) => {
    const said = [];
    d.onLine = (line) => said.push(`${line.speaker}: ${line.text}`);
    for (let i = 0; i < steps && d.busy; i++) d.update(0.5);
    return said;
  };

  // Lines come out in order, one at a time.
  {
    const d = new StoryDirector();
    d.setHero('MILES');
    d.play([
      ['HERO', 'One.'],
      ['PARTNER', 'Two.'],
      ['VENOM', 'Three.'],
    ]);
    const said = drain(d);
    if (said.join(' | ') !== 'MILES: One. | PETER: Two. | VENOM: Three.') {
      fail(`director reordered or dropped lines: ${said.join(' | ')}`);
    } else {
      ok('lines play in order, with HERO and PARTNER resolved');
    }
  }

  // A line takes real time — the whole scene must not land on one frame.
  {
    const d = new StoryDirector();
    d.play([
      ['YURI', 'One.'],
      ['YURI', 'Two.'],
    ]);
    let count = 0;
    d.onLine = () => count++;
    d.update(0.016);
    if (count !== 1) fail(`director emitted ${count} lines on the first frame, expected 1`);
    d.update(0.016);
    if (count !== 1) fail('director did not pace lines apart');
    else ok('lines are paced, not dumped');
  }

  // Scenes queue rather than interrupt: a boss falling, the chapter closing
  // and the next chapter opening all arrive at once, and all three must play.
  {
    const d = new StoryDirector();
    d.play([['VENOM', 'Down.']]);
    d.play([['MJ', 'Close.']]);
    d.play([['YURI', 'Open.']]);
    const said = drain(d);
    if (said.length !== 3) fail(`queued scenes lost lines: ${said.join(' | ')}`);
    else ok('stacked scenes queue instead of overwriting each other');
  }

  // Ambient radio is texture and is dropped whenever anything else is waiting.
  {
    const d = new StoryDirector();
    d.play([['MJ', 'Story.']]);
    if (d.play([['JAMESON', 'Radio.']], 'AMBIENT') !== false) fail('ambient radio talked over a story scene');
    else ok('ambient radio yields to written scenes');
  }

  // A backlog is a bug, not a story: the queue is capped. But the cap must
  // clear the worst *legitimate* burst, which is the one below.
  {
    const d = new StoryDirector();
    let accepted = 0;
    for (let i = 0; i < 200; i++) if (d.play([['YURI', `Line ${i}.`]])) accepted++;
    if (accepted >= 200) fail('the queue cap is not holding at all');
    else if (accepted < 8) fail(`queue caps at ${accepted} scenes, below the worst legitimate burst of 7`);
    else ok(`queue capped at ${accepted} pending scenes, clear of the 7-scene burst`);
  }

  // The regression this cap was sized for. A final boss falling issues seven
  // scenes in one synchronous callback, and at a cap of four the last two —
  // the next chapter's opening exchange and the new boss's entrance — were
  // silently thrown away at the single most important moment in the game.
  {
    const d = new StoryDirector();
    d.setHero('MILES');
    const burst = [
      ['defeat line', () => d.play(CHAPTER_BEATS['Two Against'].down['SYMBIOTE PETER'])],
      ['closing exchange', () => d.play(CHAPTER_BEATS['Two Against'].close)],
      ['chapter card', () => d.playCard('BOOK SEVEN - CH 1/6', 'The Cat Comes Back')],
      ['hero-change card', () => d.playCard('STORY', 'MILES MORALES takes this one.')],
      ['opening exchange', () => d.play(CHAPTER_BEATS['The Cat Comes Back'].open)],
      ['boss entrance', () => d.play(CHAPTER_BEATS['The Cat Comes Back'].meet['BLACK CAT'])],
      ['second entrance', () => d.play(CHAPTER_BEATS['Bought And Paid For'].meet['GREEN GOBLIN'])],
    ];
    const dropped = burst.filter(([, queue]) => !queue()).map(([what]) => what);
    if (dropped.length) fail(`chapter-transition burst dropped: ${dropped.join(', ')}`);
    else ok('a full 7-scene chapter transition queues without dropping anything');
  }

  // Each line publishes the duration the director will hold it for, so the
  // subtitle can last exactly as long as the voice reading it.
  {
    const d = new StoryDirector();
    const seen = [];
    d.onLine = (line) => seen.push(line);
    d.onCard = (card) => seen.push(card);
    d.play([
      ['YURI', 'Go.'],
      ['MJ', 'Serial numbers ground off, but the casing polymer is proprietary. One manufacturer makes it.'],
    ]);
    d.playCard('BOOK ONE', 'Shift Change');
    for (let i = 0; i < 200 && d.busy; i++) d.update(0.25);
    if (seen.length !== 3) fail(`expected 3 entries, got ${seen.length}`);
    else if (!seen.every((e) => e.seconds > 0)) fail('an entry published no duration');
    else if (!(seen[1].seconds > seen[0].seconds)) fail('a long line is not held longer than a short one');
    else ok(`durations published: ${seen.map((e) => e.seconds.toFixed(1)).join('s, ')}s`);
  }

  // Idle fires once, and only after everything has been said.
  {
    const d = new StoryDirector();
    let idles = 0;
    d.onIdle = () => idles++;
    d.play([['YURI', 'One.']]);
    for (let i = 0; i < 50; i++) d.update(0.5);
    if (idles !== 1) fail(`onIdle fired ${idles} times, expected exactly 1`);
    else ok('onIdle fires exactly once when the queue drains');
  }

  // clear() abandons everything, for a save load or a mode restart.
  {
    const d = new StoryDirector();
    d.play([['YURI', 'One.']]);
    d.clear();
    if (d.busy) fail('clear() left the director busy');
    else ok('clear() empties the queue');
  }

  // The chapter card must sit between the old chapter closing and the new one
  // opening. Shown straight to the HUD it was painted over one frame later,
  // and the player never learned which chapter they were on.
  {
    const d = new StoryDirector();
    const order = [];
    d.onLine = (line) => order.push(`line:${line.text}`);
    d.onCard = (card) => order.push(`card:${card.title}`);
    d.play([['MJ', 'Closing.']]);
    d.playCard('BOOK TWO - CH 1/5', 'Flicker');
    d.play([['YURI', 'Opening.']]);
    for (let i = 0; i < 200 && d.busy; i++) d.update(0.5);
    const expected = 'line:Closing. | card:Flicker | line:Opening.';
    if (order.join(' | ') !== expected) fail(`card landed out of order: ${order.join(' | ')}`);
    else ok('the chapter card lands between the closing and opening exchanges');
  }
}

// --- 14. the recorded voice pack ------------------------------------------
console.log('[14] recorded voice pack');
{
  // The pack is optional — the game falls back to speech synthesis without it
  // — so its absence is not a failure. Its *presence* is what needs checking,
  // because every way this can be wrong is silent. A manifest entry pointing
  // at a file that is not there, or a bank the manifest has never heard of,
  // does not throw: that line quietly goes back to sounding synthesised while
  // the ones around it do not, which is far more jarring than a pack that was
  // never installed.
  const manifestPath = join(ROOT, 'public', 'voice', 'manifest.json');
  if (!existsSync(manifestPath)) {
    console.log('  skipped — no pack installed (the game falls back to synthesis)');
  } else {
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    // Entries may be a bare path (a pack assembled by hand) or a path with the
    // duration measured off the file (a generated one).
    const pathOf = (e) => (typeof e === 'string' ? e : e.path);
    const secondsOf = (e) => (typeof e === 'string' ? 0 : (e.seconds ?? 0));
    let missing = 0;
    let untimed = 0;
    let stale = 0;
    let empty = 0;
    let clips = 0;
    let bytes = 0;
    const uncovered = [];

    for (const [speaker, events] of Object.entries(VOICE_LINES)) {
      for (const [event, lines] of Object.entries(events)) {
        const paths = manifest[speaker]?.[event];
        if (!paths) {
          uncovered.push(`${speaker}.${event}`);
          continue;
        }
        // Indexed by position, so a short list does not mean "some lines have
        // no recording" — it means every line past the end plays the wrong
        // recording, because VoiceClips wraps with a modulo.
        if (paths.length !== lines.length) {
          fail(`${speaker}.${event}: ${paths.length} clips for ${lines.length} lines — indices will wrap`);
        }
        for (const entry of paths) {
          const relative = pathOf(entry);
          const file = join(ROOT, 'public', 'voice', relative);
          if (!existsSync(file)) {
            if (missing < 5) fail(`${speaker}.${event}: ${relative} is in the manifest but not on disk`);
            missing++;
            continue;
          }
          const size = statSync(file).size;

          // The duration is what stops a line being cut off mid-sentence.
          // Without it the game falls back to guessing from word count, which
          // measured 9% of this pack short — so a zero here is a silent
          // regression to the exact bug this replaced.
          const stated = secondsOf(entry);
          if (stated <= 0) {
            if (untimed < 3) fail(`${relative} has no duration — that line will be cut off`);
            untimed++;
          } else {
            // 48 kbit CBR, so the file size is the duration. A mismatch means
            // the manifest describes a clip that has since been re-rendered.
            const measured = (size * 8) / 48000;
            if (Math.abs(measured - stated) > 0.35) {
              if (stale < 3) {
                fail(`${relative}: manifest says ${stated}s, the file is ${measured.toFixed(2)}s`);
              }
              stale++;
            }
          }
          // A few hundred bytes is a header and nothing else — the shape an
          // interrupted or refused render leaves behind.
          if (size < 1024) {
            if (empty < 5) fail(`${relative} is only ${size} bytes`);
            empty++;
          }
          clips++;
          bytes += size;
        }
      }
    }

    // Filenames are built from the line text, truncated. Two lines that agree
    // for the first forty characters would collide, and the loser would play
    // the winner's recording under its own subtitle — right voice, right
    // moment, wrong words, and nothing anywhere would report it.
    const owner = new Map();
    for (const [speaker, events] of Object.entries(manifest)) {
      for (const [event, entries] of Object.entries(events)) {
        entries.forEach((entry, i) => {
          const relative = pathOf(entry);
          const at = `${speaker}.${event}[${i}]`;
          if (owner.has(relative)) fail(`${at} and ${owner.get(relative)} are the same file: ${relative}`);
          else owner.set(relative, at);
        });
      }
    }
    if (untimed > 3) fail(`...and ${untimed - 3} more clips with no duration`);
    if (stale > 3) fail(`...and ${stale - 3} more stale durations`);

    if (missing > 5) fail(`...and ${missing - 5} more missing clips`);
    if (empty > 5) fail(`...and ${empty - 5} more truncated clips`);
    // A partial pack is a legitimate state to be in mid-render, but it should
    // be said out loud rather than discovered while playing.
    if (uncovered.length) {
      console.log(`  note — ${uncovered.length} bank(s) not in the manifest: ${uncovered.slice(0, 3).join(', ')}`);
    }
    if (!missing && !empty && !untimed && !stale) {
      ok(
        `${clips} clips, ${(bytes / 1024 / 1024).toFixed(1)} MB, every entry resolves ` +
          `and states a duration matching its file`,
      );
    }
  }
}

// --- 15. hero-locked chapters --------------------------------------------
console.log('[15] hero-locked chapters');
{
  // A chapter fielding a villain who *is* one of the heroes forces the other
  // one and cancels the partner. Dialogue written against HERO resolves to
  // whoever is holding the mask, so a PARTNER line in one of these chapters is
  // addressed to somebody who has been sent home.
  let bad = 0;
  for (const c of CHAPTERS) {
    const locks = c.villains.some((v) => HERO_LOCKED.has(v));
    if (!locks) continue;
    if (c.ally) {
      fail(`"${c.title}" fields a hero-locking villain but still has a partner`);
      bad++;
    }
    if (!c.forceHero) {
      fail(`"${c.title}" fields a hero-locking villain without forcing a hero`);
      bad++;
    }
  }
  // Book Six is Miles' book start to finish: the chapters about watching Peter
  // deteriorate cannot be played as Peter.
  const bookSix = BOOKS[5];
  for (const c of bookSix.chapters) {
    if (c.forceHero !== 'MILES') {
      fail(`Book Six "${c.title}" does not force Miles`);
      bad++;
    }
  }
  if (!bad) ok(`hero locks hold; all ${bookSix.chapters.length} chapters of Book Six are Miles`);
}

console.log('');
console.log(problems === 0 ? 'ALL CHECKS PASSED' : `${problems} PROBLEM(S) FOUND`);
process.exit(problems === 0 ? 0 : 1);
