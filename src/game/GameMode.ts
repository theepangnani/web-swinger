import type { VillainKind } from '../enemies/EnemySystem';
import type { HeroId } from './Heroes';
import type { TimeOfDay } from '../world/DayNight';

export type GameModeId = 'STORY' | 'FREE_ROAM';

export interface Chapter {
  readonly title: string;
  readonly desc: string;
  /** Crimes that must be cleared to complete this chapter, or 0. */
  readonly crimes: number;
  /**
   * Villains that must be defeated. More than one means a team-up: they are
   * all brought into play at once and all of them have to go down.
   */
  readonly villains: readonly VillainKind[];
  /** The other Spider-Man fights alongside you for this chapter. */
  readonly ally?: boolean;
  /**
   * Forces a specific hero. Only used where the story genuinely requires it —
   * you cannot play Peter in the chapters where Peter is the enemy.
   */
  readonly forceHero?: HeroId;
  /** Pins the clock, so a scene written for the dark happens in the dark. */
  readonly time?: TimeOfDay;
}

export interface Book {
  readonly title: string;
  readonly subtitle: string;
  readonly chapters: readonly Chapter[];
}

/**
 * Story mode, structured as seven books.
 *
 * One villain per book. A book is *about* somebody — Black Cat's book, then
 * Electro's, then Marko's — and it alternates street-level work with that
 * villain so the boss arrives earned rather than handed over. Reusing a face
 * inside somebody else's book blurs whose story it is, so the only place two
 * villains share a chapter is a book's final fight, where the second one
 * showing up on the same rooftop *is* the escalation.
 *
 * Book Seven is the exception and the exam: no street work at all, one boss
 * per chapter, the whole roster back to back, and both of them at the end.
 */
/**
 * Villains who *are* one of the heroes, and the hero you must therefore play.
 *
 * Symbiote Peter is Peter. You cannot fight him as Peter, and Peter obviously
 * cannot be your partner in that fight — he is the thing on the other side of
 * it. Both of those are consequences of the villain being in play, not
 * properties of a particular chapter, so they are derived here rather than
 * hand-written on each chapter and hoped for.
 */
const HERO_LOCK: Partial<Record<VillainKind, HeroId>> = {
  'SYMBIOTE PETER': 'MILES',
};

/** The hero a villain forces you to play, or null if it does not care. */
export function requiredHeroFor(kind: VillainKind): HeroId | null {
  return HERO_LOCK[kind] ?? null;
}

/**
 * Applies the hero lock to an authored chapter.
 *
 * A chapter that fields a hero-locking villain always forces that hero and
 * never has a partner, whatever the author wrote.
 */
function resolveChapter(chapter: Chapter): Chapter {
  let locked: HeroId | null = null;
  for (const kind of chapter.villains) {
    locked = requiredHeroFor(kind) ?? locked;
  }
  if (!locked) return chapter;
  return { ...chapter, forceHero: locked, ally: false };
}

const AUTHORED: readonly Book[] = [
  {
    title: 'Book One',
    subtitle: 'Nine Lives',
    chapters: [
      {
        title: 'Shift Change',
        desc: 'Get a feel for the skyline. Break up two crimes and let the city know you are out.',
        crimes: 2,
        villains: [],
        time: 'DUSK',
      },
      {
        title: 'Light Fingers',
        desc: 'Thefts all over the district, and nothing forced. Clear two more and follow the pattern.',
        crimes: 2,
        villains: [],
        time: 'NIGHT',
      },
      {
        title: 'Rooftop Pursuit',
        desc: 'There she is. Black Cat runs the skyline for sport — build swing speed and run her down.',
        crimes: 0,
        villains: ['BLACK CAT'],
        time: 'NIGHT',
      },
      {
        title: 'What She Left',
        desc: 'She dropped something on her way out. Work the streets while you figure out what.',
        crimes: 3,
        villains: [],
        time: 'DAWN',
      },
      {
        title: 'Second Story',
        desc: 'She came back for it, and she brought a route out. You are not doing this one alone.',
        crimes: 0,
        villains: ['BLACK CAT'],
        ally: true,
        time: 'NIGHT',
      },
    ],
  },
  {
    title: 'Book Two',
    subtitle: 'Brownout',
    chapters: [
      {
        title: 'Flicker',
        desc: 'Power failing block by block, and the crews are using the dark. Clear three.',
        crimes: 3,
        villains: [],
        time: 'NIGHT',
      },
      {
        title: 'Load Bearing',
        desc: 'The substations are being drained deliberately. Two more, and stay off the wires.',
        crimes: 2,
        villains: [],
        time: 'NIGHT',
      },
      {
        title: 'Live Wire',
        desc: 'Electro is holding the grid hostage from above. He does not land — you will have to go up.',
        crimes: 0,
        villains: ['ELECTRO'],
        time: 'NIGHT',
      },
      {
        title: 'Cold Start',
        desc: 'The lights are back. Help the city find its feet again.',
        crimes: 2,
        villains: [],
        time: 'DAWN',
      },
      {
        title: 'Ground Fault',
        desc: 'He got out, and he has been charging ever since. Both of you, this time.',
        crimes: 0,
        villains: ['ELECTRO'],
        ally: true,
        time: 'DUSK',
      },
    ],
  },
  {
    title: 'Book Three',
    subtitle: 'Something In The Dark',
    chapters: [
      {
        title: 'Bad Nights',
        desc: 'People are being pulled off the street and left in pieces. Clear three and listen.',
        crimes: 3,
        villains: [],
        time: 'NIGHT',
      },
      {
        title: 'It Knows You',
        desc: 'Whatever it is, it has been following you. Two more crimes and it will show itself.',
        crimes: 2,
        villains: [],
        time: 'NIGHT',
      },
      {
        title: 'Teeth',
        desc: 'Venom. Bigger and faster than anything you have fought. Stand your ground.',
        crimes: 0,
        villains: ['VENOM'],
        time: 'NIGHT',
      },
      {
        title: 'Quiet Streets',
        desc: 'It is over, for now. Take the calm while it lasts.',
        crimes: 2,
        villains: [],
        time: 'DAWN',
      },
      {
        title: 'Feeding',
        desc: 'It came back hungrier, and it went looking for the other one of you first.',
        crimes: 0,
        villains: ['VENOM'],
        ally: true,
        time: 'NIGHT',
      },
    ],
  },
  {
    title: 'Book Four',
    subtitle: 'Something In The Sky',
    chapters: [
      {
        title: 'Ordnance',
        desc: 'Explosives turning up in ordinary robberies. Somebody is arming the street. Clear three.',
        crimes: 3,
        villains: [],
        time: 'DUSK',
      },
      {
        title: 'Flight Path',
        desc: 'Reports of a glider over the rooftops at night. Two more, then look up.',
        crimes: 2,
        villains: [],
        time: 'NIGHT',
      },
      {
        title: 'Trick Or Treat',
        desc: 'The Green Goblin, and he does not come down either. Bombs and a bladed glider.',
        crimes: 0,
        villains: ['GREEN GOBLIN'],
        time: 'NIGHT',
      },
      {
        title: 'Fallout',
        desc: 'Half a district to put back together, and he is still up there. Clear three.',
        crimes: 3,
        villains: [],
        time: 'DAY',
      },
      {
        title: 'Bought And Paid For',
        desc: 'She was buying time for somebody. This is who — and she is still working for him. One roof, both of them.',
        crimes: 0,
        villains: ['GREEN GOBLIN', 'BLACK CAT'],
        ally: true,
        time: 'DUSK',
      },
    ],
  },
  {
    title: 'Book Five',
    subtitle: 'Ground Truth',
    chapters: [
      {
        title: 'Foundations',
        desc: 'Three sites hit in a week, and nothing taken but the ground itself. Clear three crimes.',
        crimes: 3,
        villains: [],
        time: 'DAY',
      },
      {
        title: 'Aggregate',
        desc: 'Whatever came through those walls did not use the doors. Two more.',
        crimes: 2,
        villains: [],
        time: 'DAY',
      },
      {
        title: 'Quarry',
        desc: 'Flint Marko. He does not chase and he does not tire — he just keeps walking at you.',
        crimes: 0,
        villains: ['SANDMAN'],
        time: 'DAY',
      },
      {
        title: 'Settling',
        desc: 'Half the block is under a foot of sand. Dig the city out.',
        crimes: 2,
        villains: [],
        time: 'DAY',
      },
      {
        title: 'Clear Ground',
        desc: 'Quiet, for a change. Keep it that way for two more — and watch the drains.',
        crimes: 2,
        villains: [],
        time: 'DAY',
      },
      {
        title: 'Sinkhole',
        desc: 'He reformed under the reservoir the size of the block, and the Goblin is overhead directing him. Hit Marko in the head — nothing lower holds together.',
        crimes: 0,
        villains: ['SANDMAN', 'GREEN GOBLIN'],
        ally: true,
        time: 'DUSK',
      },
    ],
  },
  /**
   * Miles' book, start to finish. The first three chapters used to let you
   * play either hero, which put Peter on screen watching himself deteriorate
   * — the one reading of those chapters that cannot be true.
   */
  {
    title: 'Book Six',
    subtitle: 'The Poison',
    chapters: [
      {
        title: 'Something Is Wrong',
        desc: 'Peter has been swinging harder and landing heavier for a week. Clear three and keep an eye on him.',
        crimes: 3,
        villains: [],
        forceHero: 'MILES',
        time: 'DUSK',
      },
      {
        title: 'Hairline',
        desc: 'He put a man through a wall for a stolen phone. Two more, and talk to him after.',
        crimes: 2,
        villains: [],
        forceHero: 'MILES',
        time: 'NIGHT',
      },
      {
        title: 'The Bite',
        desc: 'You get there and the alley is empty except for the black. Two more crimes, and no sign of Peter anywhere.',
        crimes: 2,
        villains: [],
        forceHero: 'MILES',
        time: 'NIGHT',
      },
      {
        title: 'Wrong Hands',
        desc: 'He has gone quiet and the city has got louder. Clear two while you look for him.',
        crimes: 2,
        villains: [],
        forceHero: 'MILES',
        time: 'NIGHT',
      },
      {
        title: 'Not Him',
        desc: 'He is wearing Peter and using everything Peter knows. He knows how you fight, Miles.',
        crimes: 0,
        villains: ['SYMBIOTE PETER'],
        forceHero: 'MILES',
        time: 'NIGHT',
      },
      {
        title: 'Bring Him Back',
        desc: 'Second round, and he has stopped pretending to be Peter at all.',
        crimes: 0,
        villains: ['SYMBIOTE PETER'],
        forceHero: 'MILES',
        time: 'DAWN',
      },
      {
        title: 'Two Against',
        desc: 'The thing that took him did not come alone. Same rooftop, both of them, one of you.',
        crimes: 0,
        villains: ['SYMBIOTE PETER', 'VENOM'],
        forceHero: 'MILES',
        time: 'NIGHT',
      },
    ],
  },
  /**
   * The last book before the post-game, and the only one with no street work
   * in it at all: every chapter is a boss, and no two are the same. It is the
   * victory lap and the exam at once — you fight the whole roster back to
   * back, then the two of them together.
   */
  {
    title: 'Book Seven',
    subtitle: 'All Of Them At Once',
    chapters: [
      {
        title: 'The Cat Comes Back',
        desc: 'She is not stealing this time — she is buying time for someone else. Catch her and find out who.',
        crimes: 0,
        villains: ['BLACK CAT'],
        ally: true,
        time: 'DUSK',
      },
      {
        title: 'Full Charge',
        desc: 'Whoever she was buying it for lit the grid to announce it. Dillon, on the substation roof.',
        crimes: 0,
        villains: ['ELECTRO'],
        ally: true,
        time: 'NIGHT',
      },
      {
        title: 'Feeding Again',
        desc: 'It found another host and it is not being careful about it. Take it apart.',
        crimes: 0,
        villains: ['VENOM'],
        ally: true,
        time: 'NIGHT',
      },
      {
        title: 'The Whole Sky',
        desc: 'The Goblin, above a city that has nothing left to give. This is what all of it was for.',
        crimes: 0,
        villains: ['GREEN GOBLIN'],
        ally: true,
        time: 'DUSK',
      },
      {
        title: 'Immovable',
        desc: 'Marko in the middle of the avenue, refusing to be anywhere else. Go over him.',
        crimes: 0,
        villains: ['SANDMAN'],
        ally: true,
        time: 'DAWN',
      },
      {
        title: 'Everything',
        desc: 'It has Peter again, and the Goblin is above the whole thing where he has been the entire time. One roof. Finish it, Miles.',
        crimes: 0,
        villains: ['SYMBIOTE PETER', 'GREEN GOBLIN'],
        forceHero: 'MILES',
        time: 'NIGHT',
      },
    ],
  },
];

/** The books as the rest of the game sees them, with the hero lock applied. */
export const BOOKS: readonly Book[] = AUTHORED.map((book) => ({
  ...book,
  chapters: book.chapters.map(resolveChapter),
}));

/**
 * The two things a chapter can ask for, recorded in the order they happened.
 *
 * Progress is a replay of this log rather than a pair of running totals, and
 * that distinction is the whole point: a total cannot say *when* something was
 * done, so crimes cleared during a boss fight got banked and silently paid for
 * the next street chapter. Chapters were completing before the player had seen
 * them, which read as the campaign skipping to the next boss.
 */
export const CRIME = 'CRIME';
export type StoryEvent = typeof CRIME | VillainKind;

/** Flattened chapter list with its book index, built once. */
interface FlatChapter {
  chapter: Chapter;
  book: number;
  indexInBook: number;
}

const FLAT: readonly FlatChapter[] = BOOKS.flatMap((book, bookIndex) =>
  book.chapters.map((chapter, indexInBook) => ({ chapter, book: bookIndex, indexInBook })),
);

/** Total chapters, for the title screen. */
export const CHAPTER_COUNT = FLAT.length;

const CLEARED: Chapter = {
  title: 'The City Is Yours',
  desc: 'Every book closed. Crime never stops, so neither do you.',
  crimes: 0,
  villains: [],
};

const FREE_ROAM_BLURB: Chapter = {
  title: 'Free Roam',
  desc: 'No script. Every villain is loose, crime never stops. Go set a speed record.',
  crimes: 0,
  villains: [],
};

/**
 * Tracks progress through the books.
 *
 * Progress is recomputed by replaying the whole event log from the start, so
 * it is a pure function of what the player has done: idempotent, safe to call
 * on every crime, and identical whether it ran live or rebuilt from a save.
 *
 * Credit is scoped to the chapter that was current when the event happened.
 * Anything the current chapter is not asking for falls on the floor — crimes
 * cleared mid-boss do not carry into the next chapter, and a villain beaten
 * twice over does not pay for their rematch four chapters later.
 */
export class Campaign {
  readonly mode: GameModeId;
  private index = 0;
  /** Crimes credited to the current chapter, capped at what it asked for. */
  private crimesHere = 0;
  /** Villains beaten during the current chapter, likewise capped. */
  private readonly killsHere = new Map<string, number>();

  constructor(mode: GameModeId) {
    this.mode = mode;
  }

  get isStory(): boolean {
    return this.mode === 'STORY';
  }

  get current(): Chapter {
    if (!this.isStory) return FREE_ROAM_BLURB;
    return FLAT[this.index]?.chapter ?? CLEARED;
  }

  get complete(): boolean {
    return this.isStory && this.index >= FLAT.length;
  }

  /** "BOOK TWO · CH 3/5" */
  get progressLabel(): string {
    if (!this.isStory) return 'FREE ROAM';
    const entry = FLAT[this.index];
    if (!entry) return 'STORY COMPLETE';
    const book = BOOKS[entry.book]!;
    return `${book.title.toUpperCase()} · CH ${entry.indexInBook + 1}/${book.chapters.length}`;
  }

  /** "Nine Lives" — the current book's subtitle, for the tracker header. */
  get bookSubtitle(): string {
    if (!this.isStory) return 'Open city';
    const entry = FLAT[this.index];
    return entry ? BOOKS[entry.book]!.subtitle : 'Complete';
  }

  /** 0-based index of the current book, or -1 when finished. */
  get bookIndex(): number {
    return FLAT[this.index]?.book ?? -1;
  }

  /** Chapters finished so far, for the save summary. */
  get chaptersDone(): number {
    return this.isStory ? this.index : 0;
  }

  /** Crimes cleared toward the current chapter's requirement. */
  crimesIntoChapter(): number {
    return this.isStory ? this.crimesHere : 0;
  }

  /**
   * Villains the current chapter still needs beaten.
   *
   * This is what decides who to bring into play, and it counts kills made
   * during this chapter rather than asking "is this villain alive". In a
   * team-up, beating one of the pair leaves the other standing, so the chapter
   * does not advance — and a naive "spawn anyone this chapter names who is not
   * currently live" check would immediately resurrect the one you just beat.
   */
  pending(): VillainKind[] {
    if (!this.isStory) return [];
    const seen = new Map<string, number>();
    const outstanding: VillainKind[] = [];
    for (const kind of this.current.villains) {
      const nth = seen.get(kind) ?? 0;
      if ((this.killsHere.get(kind) ?? 0) <= nth) outstanding.push(kind);
      seen.set(kind, nth + 1);
    }
    return outstanding;
  }

  /**
   * Recomputes progress by replaying the log from the first event. Idempotent,
   * so it can be called on every crime and every defeat. Returns whether the
   * current chapter changed.
   */
  replay(log: readonly StoryEvent[]): boolean {
    if (!this.isStory) return false;

    const before = this.index;
    this.index = 0;
    this.crimesHere = 0;
    this.killsHere.clear();

    for (const event of log) {
      if (this.index >= FLAT.length) break;
      this.credit(event);
      // A chapter that asks for nothing would otherwise need an event of its
      // own to be stepped over, so drain rather than advancing once.
      while (this.index < FLAT.length && this.satisfied()) {
        this.index++;
        this.crimesHere = 0;
        this.killsHere.clear();
      }
    }

    return this.index !== before;
  }

  /** Applies one event to the current chapter, ignoring what it did not ask for. */
  private credit(event: StoryEvent): void {
    const chapter = FLAT[this.index]!.chapter;
    if (event === CRIME) {
      if (this.crimesHere < chapter.crimes) this.crimesHere++;
      return;
    }
    // Capped at the number the chapter wants, so beating a villain three times
    // in a chapter that names them once cannot spill over into the next.
    let wanted = 0;
    for (const kind of chapter.villains) if (kind === event) wanted++;
    const have = this.killsHere.get(event) ?? 0;
    if (have < wanted) this.killsHere.set(event, have + 1);
  }

  private satisfied(): boolean {
    const chapter = FLAT[this.index]?.chapter;
    if (!chapter) return false;
    if (this.crimesHere < chapter.crimes) return false;
    const seen = new Map<string, number>();
    for (const kind of chapter.villains) {
      const nth = (seen.get(kind) ?? 0) + 1;
      seen.set(kind, nth);
      if ((this.killsHere.get(kind) ?? 0) < nth) return false;
    }
    return true;
  }
}

/**
 * Rebuilds an event log for a save written before the log existed.
 *
 * The old totals cannot say when anything happened, so the most they can
 * honestly support is "which chapter did the old rule think you were on".
 * That is recomputed with the old rule and then re-emitted as the exact events
 * those chapters asked for, which replays to the same chapter under the new
 * one. Progress is preserved; the surplus that caused the skipping is not.
 */
export function migrateLog(crimesCleared: number, defeated: readonly string[]): StoryEvent[] {
  const defeats = new Map<string, number>();
  for (const kind of defeated) defeats.set(kind, (defeats.get(kind) ?? 0) + 1);

  const log: StoryEvent[] = [];
  const used = new Map<string, number>();
  let budget = crimesCleared;

  outer: for (const { chapter } of FLAT) {
    if (budget < chapter.crimes) break;
    for (const kind of chapter.villains) {
      const spent = used.get(kind) ?? 0;
      if ((defeats.get(kind) ?? 0) <= spent) break outer;
      used.set(kind, spent + 1);
    }
    budget -= chapter.crimes;
    for (let i = 0; i < chapter.crimes; i++) log.push(CRIME);
    log.push(...chapter.villains);
  }
  return log;
}
