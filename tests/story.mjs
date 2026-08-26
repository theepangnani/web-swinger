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
import { bundle } from './_bundle.mjs';

const { BOOKS, CHAPTER_BEATS, AMBIENT, DISPATCH, STORY_LINES, StoryDirector, speakerColor, speakerName } =
  await bundle(
    [
      ['{ BOOKS }', 'src/game/GameMode'],
      [
        '{ CHAPTER_BEATS, AMBIENT, DISPATCH, STORY_LINES, StoryDirector, speakerColor, speakerName }',
        'src/game/Story',
      ],
    ],
    'story',
  );

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
  for (const key of ['open', 'mid', 'close']) if (beats[key]) out.push([key, beats[key]]);
  for (const key of ['meet', 'down']) {
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
    for (const key of ['meet', 'down']) {
      for (const villain of Object.keys(beats[key] ?? {})) {
        if (!roster.has(villain)) {
          fail(`"${c.title}" has a ${key} beat for ${villain}, who never appears in it`);
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
  for (const c of CHAPTERS) {
    for (const [where, script] of scriptsOf(CHAPTER_BEATS[c.title] ?? {})) {
      for (const [who, text] of script) {
        // HERO and PARTNER can each be either hero, so both banks must carry it.
        if (who === 'HERO' || who === 'PARTNER') {
          check('PETER', text, `${c.title} ${where}`);
          check('MILES', text, `${c.title} ${where}`);
        } else {
          check(who, text, `${c.title} ${where}`);
        }
      }
    }
  }
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
  if (DISPATCH.length < 4) fail('too few dispatch callouts — they will repeat immediately');
  if (!bad) ok(`${AMBIENT.length} radio segments across ${books} books, ${DISPATCH.length} dispatch callouts`);
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

// --- 11. the director -----------------------------------------------------
console.log('[11] director');
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

// --- 12. hero-locked chapters --------------------------------------------
console.log('[12] hero-locked chapters');
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
