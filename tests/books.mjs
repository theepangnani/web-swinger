/**
 * Shape of the story itself: every book ends on a boss, difficulty climbs, and
 * the last book is the one that fields everybody.
 */
import { bundle } from './_bundle.mjs';

const { BOOKS, CONFIG } = await bundle(
  [
    ['{ BOOKS }', 'src/game/GameMode'],
    ['{ CONFIG }', 'src/core/Config'],
  ],
  'books',
);

/** Health of each villain, so "does the campaign escalate" is checkable. */
const HP = {
  'BLACK CAT': CONFIG.enemies.blackCat.hp,
  ELECTRO: CONFIG.enemies.electro.hp,
  VENOM: CONFIG.enemies.venom.hp,
  'GREEN GOBLIN': CONFIG.enemies.goblin.hp,
  // Sandman's stated health is fought through a 3.2x weak point, so the
  // number that matters for pacing is what it costs to kill him properly.
  SANDMAN: CONFIG.enemies.sandman.hp / CONFIG.enemies.sandman.headDamageScale,
  'SYMBIOTE PETER': CONFIG.enemies.symbiote.hp,
};
const weight = (chapter) => chapter.villains.reduce((n, k) => n + (HP[k] ?? 0), 0);

let bad = 0;
for (const book of BOOKS) {
  const kinds = new Set();
  for (const c of book.chapters) for (const k of c.villains) kinds.add(k);
  const finale = book.chapters[book.chapters.length - 1];
  const label = `${book.title} (${book.subtitle})`;
  const bossChapters = book.chapters.filter((c) => c.villains.length > 0).length;
  console.log(
    `${label}\n  villains: ${[...kinds].join(', ') || '(none)'}` +
      `\n  ${book.chapters.length} chapters, ${bossChapters} with a boss` +
      `\n  finale: "${finale.title}" [${finale.villains.join(' + ') || 'no boss'}]`,
  );
  if (finale.villains.length === 0) {
    console.log('  FAIL finale has no boss');
    bad++;
  }
  const isLastBook = book === BOOKS[BOOKS.length - 1];
  if (isLastBook) {
    if (book.chapters.some((c) => c.villains.length === 0)) {
      console.log('  FAIL last book has a chapter with no boss');
      bad++;
    }
    const singles = book.chapters.filter((c) => c.villains.length === 1).map((c) => c.villains[0]);
    if (new Set(singles).size !== singles.length) {
      console.log('  FAIL last book repeats a boss');
      bad++;
    }
  } else if (kinds.size > 2) {
    console.log('  FAIL more than one villain plus a finale partner');
    bad++;
  }
}
// --- escalation: each book's finale must be harder than the one before ----
console.log('\nfinale weight by book');
let previous = 0;
for (const book of BOOKS) {
  const finale = book.chapters[book.chapters.length - 1];
  const w = weight(finale);
  console.log(`  ${book.subtitle.padEnd(22)} ${Math.round(w)}`);
  if (w <= previous) {
    console.log(`  FAIL ${book.subtitle} is no harder than the book before it`);
    bad++;
  }
  previous = w;
}

// --- no two books may end on the same matchup ----------------------------
const finales = BOOKS.map((b) => [...b.chapters[b.chapters.length - 1].villains].sort().join('+'));
if (new Set(finales).size !== finales.length) {
  console.log('  FAIL two books end on the same fight');
  bad++;
}

// --- a duo finale may only pair with a villain already introduced ---------
const seen = new Set();
for (const book of BOOKS) {
  const finale = book.chapters[book.chapters.length - 1];
  for (const chapter of book.chapters.slice(0, -1)) {
    for (const k of chapter.villains) seen.add(k);
  }
  if (finale.villains.length > 1) {
    const stranger = finale.villains.find((k) => !seen.has(k));
    if (stranger) {
      console.log(`  FAIL ${book.subtitle} pairs its boss with ${stranger}, never met`);
      bad++;
    }
  }
  for (const k of finale.villains) seen.add(k);
}

console.log(bad === 0 ? '\nBOOK STRUCTURE OK' : `\n${bad} PROBLEM(S)`);
process.exit(bad === 0 ? 0 : 1);
