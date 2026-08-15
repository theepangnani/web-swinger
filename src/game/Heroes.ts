export type HeroId = 'PETER' | 'MILES';

export interface HeroDef {
  readonly id: HeroId;
  readonly name: string;
  /** Suit base colour. */
  readonly primary: number;
  /** Panel / accent colour. */
  readonly secondary: number;
  /** Gloves and boots. */
  readonly accent: number;
  readonly eye: number;
  /** Chest / back spider emblem. */
  readonly emblem: number;
  readonly abilityName: string;
  readonly abilityColor: number;
  readonly abilityDesc: string;
  /** Damage multiplier applied while the special ability is active. */
  readonly surgeDamageMultiplier: number;
}

export const HEROES: Record<HeroId, HeroDef> = {
  PETER: {
    id: 'PETER',
    name: 'PETER PARKER',
    // Advanced Suit: red torso and mask, deep navy limbs, white lenses.
    primary: 0xd62828,
    secondary: 0x1b2b47,
    accent: 0xd62828,
    eye: 0xf2f7ff,
    emblem: 0x101014,
    abilityName: 'SYMBIOTE SURGE',
    abilityColor: 0x111116,
    abilityDesc: 'Suit goes black. Strikes hit far harder for a short window.',
    surgeDamageMultiplier: 2.2,
  },
  MILES: {
    id: 'MILES',
    name: 'MILES MORALES',
    // Miles' suit: matte black with red accents and a red spider.
    primary: 0x121216,
    secondary: 0x0d0d11,
    accent: 0xd62828,
    eye: 0xf2f7ff,
    emblem: 0xe01f26,
    abilityName: 'VENOM BLAST',
    abilityColor: 0xffb703,
    abilityDesc: 'Discharge bio-electricity, damaging every villain nearby.',
    surgeDamageMultiplier: 1.0,
  },
};

export const HERO_ORDER: readonly HeroId[] = ['PETER', 'MILES'];

export function nextHero(current: HeroId): HeroId {
  const i = HERO_ORDER.indexOf(current);
  return HERO_ORDER[(i + 1) % HERO_ORDER.length]!;
}
