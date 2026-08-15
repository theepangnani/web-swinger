import { CONFIG } from '../core/Config';

export type SkillBranch = 'INNOVATOR' | 'DEFENDER' | 'WEBSLINGER';

export interface SkillDef {
  readonly id: string;
  readonly name: string;
  readonly branch: SkillBranch;
  readonly cost: number;
  /** Skill ids that must be unlocked first. */
  readonly requires: readonly string[];
  readonly desc: string;
}

/**
 * Three branches, mirroring the shape of the mainline games' skill screens.
 * Core traversal is free from the start — skills gate the *advanced* moves and
 * apply multipliers, so a fresh save is still fun to move around in.
 */
export const SKILLS: readonly SkillDef[] = [
  // --- Webslinger: traversal ------------------------------------------------
  {
    id: 'point_launch',
    name: 'Point Launch',
    branch: 'WEBSLINGER',
    cost: 1,
    requires: [],
    desc: 'Release the web at the top of an arc for a big upward launch.',
  },
  {
    id: 'zip_to_point',
    name: 'Web Zip',
    branch: 'WEBSLINGER',
    cost: 1,
    requires: [],
    desc: 'Zip straight to the point you are aiming at.',
  },
  {
    id: 'wall_run',
    name: 'Wall Run',
    branch: 'WEBSLINGER',
    cost: 1,
    requires: ['zip_to_point'],
    desc: 'Carry horizontal speed into a run straight up a facade.',
  },
  {
    id: 'air_tricks',
    name: 'Air Tricks',
    branch: 'WEBSLINGER',
    cost: 1,
    requires: ['point_launch'],
    desc: 'Spin during a long fall to build Focus.',
  },
  {
    id: 'web_wings',
    name: 'Web Wings',
    branch: 'WEBSLINGER',
    cost: 2,
    requires: ['air_tricks'],
    desc: 'Deploy wings and glide across the skyline.',
  },

  // --- Defender: survivability ---------------------------------------------
  {
    id: 'perfect_dodge',
    name: 'Perfect Dodge',
    branch: 'DEFENDER',
    cost: 1,
    requires: [],
    desc: 'Dodging at the last moment refunds extra Focus.',
  },
  {
    id: 'finisher',
    name: 'Finisher',
    branch: 'DEFENDER',
    cost: 1,
    requires: [],
    desc: 'Spend a full Focus bar on a devastating area attack.',
  },
  {
    id: 'focus_boost',
    name: 'Battle Focus',
    branch: 'DEFENDER',
    cost: 1,
    requires: ['perfect_dodge'],
    desc: 'Earn 50% more Focus from every source.',
  },
  {
    id: 'field_medic',
    name: 'Field Medic',
    branch: 'DEFENDER',
    cost: 2,
    requires: ['finisher'],
    desc: 'Healing with Focus restores substantially more health.',
  },

  // --- Innovator: gadgets ---------------------------------------------------
  {
    id: 'gadget_bomb',
    name: 'Web Bomb',
    branch: 'INNOVATOR',
    cost: 1,
    requires: [],
    desc: 'Unlocks the Web Bomb: an area burst that cocoons everything near it.',
  },
  {
    id: 'gadget_mine',
    name: 'Trip Mine',
    branch: 'INNOVATOR',
    cost: 1,
    requires: [],
    desc: 'Unlocks the Trip Mine: sticks to a surface and yanks a target into it.',
  },
  {
    id: 'ammo_capacity',
    name: 'Extra Capacity',
    branch: 'INNOVATOR',
    cost: 1,
    requires: ['gadget_bomb'],
    desc: 'Doubles the ammo capacity of every gadget.',
  },
  {
    id: 'concussive',
    name: 'Concussive Rounds',
    branch: 'INNOVATOR',
    cost: 2,
    requires: ['gadget_mine'],
    desc: 'Gadgets deal 60% more damage.',
  },
  {
    id: 'gadget_concussive',
    name: 'Concussive Blast',
    branch: 'INNOVATOR',
    cost: 1,
    requires: ['gadget_bomb'],
    desc: 'Unlocks the Concussive Blast: a shockwave that launches a whole group.',
  },
  {
    id: 'gadget_electric',
    name: 'Electric Web',
    branch: 'INNOVATOR',
    cost: 2,
    requires: ['gadget_concussive'],
    desc: 'Unlocks the Electric Web: arcs through a crowd and stuns for seven seconds.',
  },
  {
    id: 'gadget_grabber',
    name: 'Web Grabber',
    branch: 'INNOVATOR',
    cost: 2,
    requires: ['gadget_mine'],
    desc: 'Unlocks the Web Grabber: yanks everything nearby into one pile.',
  },
];

const SKILL_BY_ID = new Map(SKILLS.map((s) => [s.id, s]));

export interface ProgressionSave {
  level: number;
  xpIntoLevel: number;
  totalXp: number;
  skillPoints: number;
  unlocked: string[];
}

function clampInt(value: number, lo: number, hi: number): number {
  if (!Number.isFinite(value)) return lo;
  return Math.max(lo, Math.min(hi, Math.round(value)));
}

export interface XpAward {
  leveledUp: boolean;
  level: number;
  gained: number;
}

/**
 * XP, levels and the skill tree. Kept free of Three.js so it stays trivially
 * testable and serialisable.
 */
export class Progression {
  level = 1;
  /** XP accumulated inside the current level. */
  xpIntoLevel = 0;
  totalXp = 0;
  skillPoints = 2;

  private readonly unlocked = new Set<string>();

  /** XP required to advance from `level` to `level + 1`. */
  xpForLevel(level: number): number {
    return Math.round(CONFIG.progression.baseXp * Math.pow(CONFIG.progression.curve, level - 1));
  }

  get xpToNext(): number {
    return this.xpForLevel(this.level);
  }

  /** 0..1 progress through the current level. */
  get levelFraction(): number {
    if (this.level >= CONFIG.progression.maxLevel) return 1;
    return Math.min(1, this.xpIntoLevel / this.xpToNext);
  }

  addXp(amount: number): XpAward {
    if (amount <= 0 || this.level >= CONFIG.progression.maxLevel) {
      return { leveledUp: false, level: this.level, gained: 0 };
    }

    this.totalXp += amount;
    this.xpIntoLevel += amount;
    let leveledUp = false;

    while (this.level < CONFIG.progression.maxLevel && this.xpIntoLevel >= this.xpToNext) {
      this.xpIntoLevel -= this.xpToNext;
      this.level++;
      this.skillPoints += CONFIG.progression.skillPointsPerLevel;
      leveledUp = true;
    }

    if (this.level >= CONFIG.progression.maxLevel) this.xpIntoLevel = 0;
    return { leveledUp, level: this.level, gained: amount };
  }

  has(id: string): boolean {
    return this.unlocked.has(id);
  }

  /** True when the skill exists, is affordable, and its prerequisites are met. */
  canUnlock(id: string): boolean {
    const skill = SKILL_BY_ID.get(id);
    if (!skill || this.unlocked.has(id)) return false;
    if (this.skillPoints < skill.cost) return false;
    return skill.requires.every((req) => this.unlocked.has(req));
  }

  unlock(id: string): boolean {
    if (!this.canUnlock(id)) return false;
    const skill = SKILL_BY_ID.get(id)!;
    this.skillPoints -= skill.cost;
    this.unlocked.add(id);
    return true;
  }

  /** The next skill the player could afford — drives the "spend point" prompt. */
  nextAffordable(): SkillDef | null {
    return SKILLS.find((s) => this.canUnlock(s.id)) ?? null;
  }

  unlockedCount(): number {
    return this.unlocked.size;
  }

  /** Snapshot for the save file. */
  serialize(): ProgressionSave {
    return {
      level: this.level,
      xpIntoLevel: this.xpIntoLevel,
      totalXp: this.totalXp,
      skillPoints: this.skillPoints,
      unlocked: [...this.unlocked],
    };
  }

  /** Restores a snapshot, ignoring skill ids that no longer exist. */
  restore(data: ProgressionSave): void {
    this.level = clampInt(data.level, 1, CONFIG.progression.maxLevel);
    this.xpIntoLevel = Math.max(0, data.xpIntoLevel || 0);
    this.totalXp = Math.max(0, data.totalXp || 0);
    this.skillPoints = Math.max(0, data.skillPoints || 0);
    this.unlocked.clear();
    for (const id of data.unlocked ?? []) {
      if (SKILL_BY_ID.has(id)) this.unlocked.add(id);
    }
  }

  // --- derived gameplay modifiers -------------------------------------------

  get focusMultiplier(): number {
    return this.has('focus_boost') ? 1.5 : 1;
  }

  get healAmount(): number {
    return CONFIG.focus.healAmount * (this.has('field_medic') ? 1.85 : 1);
  }

  get gadgetDamageMultiplier(): number {
    return this.has('concussive') ? 1.6 : 1;
  }

  get ammoMultiplier(): number {
    return this.has('ammo_capacity') ? 2 : 1;
  }
}
