import type { EnemySystem, VillainKind } from '../enemies/EnemySystem';

export interface Quest {
  readonly title: string;
  readonly desc: string;
  /** Villain that must be defeated to clear this objective. */
  readonly target: VillainKind | null;
}

const QUESTS: readonly Quest[] = [
  {
    title: 'Symbiote Sighting',
    desc: 'Venom is perched downtown. Get inside 40m and he will leap — strike him out of the air.',
    target: 'VENOM',
  },
  {
    title: 'Rooftop Pursuit',
    desc: 'Black Cat is running the skyline. Build swing speed and tag her before she breaks away.',
    target: 'BLACK CAT',
  },
  {
    title: 'Grid Overload',
    desc: 'Electro is hovering over a tower, sniping anything that flies past. Close and take him down.',
    target: 'ELECTRO',
  },
];

const CLEARED: Quest = {
  title: 'City Secured',
  desc: 'All three are down. The skyline is yours — go set a speed record.',
  target: null,
};

/**
 * Drives the "FNSM App Request" panel. Objectives are derived from the actual
 * villains in play, so the tracker can never point at something that is not
 * in the world.
 */
export class QuestLog {
  private index = 0;

  get current(): Quest {
    return QUESTS[this.index] ?? CLEARED;
  }

  get complete(): boolean {
    return this.index >= QUESTS.length;
  }

  get progress(): string {
    return `${Math.min(this.index + 1, QUESTS.length)} / ${QUESTS.length}`;
  }

  /** Advances past any cleared objectives. True if the objective changed. */
  update(enemies: EnemySystem): boolean {
    const before = this.index;

    while (this.index < QUESTS.length) {
      const target = QUESTS[this.index]!.target;
      const villain = enemies.villains.find((v) => v.kind === target);
      // Skip objectives whose villain is already gone (or was never spawned).
      if (villain && villain.alive) break;
      this.index++;
    }

    return this.index !== before;
  }
}
