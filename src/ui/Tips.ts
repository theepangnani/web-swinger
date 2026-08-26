/**
 * First-time prompts, shown once each and then never again.
 *
 * The game has around twenty verbs — swing, reel, zip, glide, wall-run, charge
 * jump, sprint, punch, dodge, finisher, gadget, heal, surge, swap — and its
 * entire explanation of them was a static panel in the corner plus a hidden
 * second panel behind `L`. A player who does not read the corner never learns
 * that dodging exists, and nothing in the game ever brings it up. That is not a
 * difficulty problem, it is a discoverability one: those verbs are the game.
 *
 * So each one is introduced at the first moment it becomes the useful thing to
 * do, and only then. A tip fires when the situation it answers actually
 * arrives — the first villain, the first time health gets low, the first
 * unspent skill point — which is the difference between a manual and a
 * teacher.
 *
 * Seen tips live in their own localStorage key rather than in the campaign
 * save, because they record what the *player* has learned, not what the
 * character has done. Starting a new game should not re-explain the controls
 * to somebody who has been playing for an hour.
 */

const STORAGE_KEY = 'web-swinger.tips.v1';

export interface Tip {
  readonly id: string;
  /** Shown as the card's label. */
  readonly label: string;
  readonly text: string;
}

/**
 * Every prompt, and the key it teaches.
 *
 * Keys are written the way the on-screen legend writes them, so the two never
 * disagree with each other in front of the player.
 */
export const TIPS: Readonly<Record<string, Tip>> = {
  swing: {
    id: 'swing',
    label: 'SWINGING',
    text: 'Hold Space for a web line. Reel in with W, out with S, and let go at the bottom of the arc for speed.',
  },
  crime: {
    id: 'crime',
    label: 'A CALL',
    text: 'Follow the marker. Most crimes are on a clock once you arrive, and the clock is in the tracker.',
  },
  villain: {
    id: 'villain',
    label: 'SPIDER-SENSE',
    text: 'Villains hit far harder than the street does. Dodge on Right-Click the moment your spider-sense flashes.',
  },
  hurt: {
    id: 'hurt',
    label: 'LOW',
    text: 'Press H to spend focus on health. Focus is built by landing hits, so healing is something you earn.',
  },
  skills: {
    id: 'skills',
    label: 'SKILL POINT',
    text: 'You have a point to spend. Press K for skills and suits.',
  },
  gadget: {
    id: 'gadget',
    label: 'GADGETS',
    text: 'G throws the selected gadget, Shift+G cycles. Web-bombs settle a crowd faster than fists do.',
  },
  down: {
    id: 'down',
    label: 'GOING DOWN',
    text: 'Falling costs you: anyone still standing gets some health back, and the call you were on is lost.',
  },
};

export class Tips {
  private readonly seen = new Set<string>();

  constructor() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) for (const id of JSON.parse(raw) as string[]) this.seen.add(id);
    } catch {
      // Private browsing, disabled storage, or something that is not JSON.
      // Re-showing a tip is a far smaller problem than failing to boot.
    }
  }

  /**
   * Returns a tip the first time it is asked for, and null every time after.
   *
   * Claiming and marking are one operation on purpose: two calls would let a
   * caller show a tip and forget to record it, which is exactly the bug that
   * makes a tutorial repeat itself.
   */
  claim(id: string): Tip | null {
    const tip = TIPS[id];
    if (!tip || this.seen.has(id)) return null;
    this.seen.add(id);
    this.persist();
    return tip;
  }

  /** Whether a tip has already been shown. */
  hasSeen(id: string): boolean {
    return this.seen.has(id);
  }

  /** Forgets everything, so the prompts come back. Used by "erase save". */
  reset(): void {
    this.seen.clear();
    this.persist();
  }

  private persist(): void {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify([...this.seen]));
    } catch {
      // Nothing to do — the tips simply show again next session.
    }
  }
}
