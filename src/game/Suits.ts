import type { HeroId } from './Heroes';

export type SuitPattern = 'web' | 'panel';

export interface SuitDef {
  readonly id: string;
  readonly name: string;
  readonly hero: HeroId;
  /** Webbed zones: mask, chest, shoulders, upper arms. */
  readonly primary: number;
  /** Smooth zones: abdomen, thighs, shins. */
  readonly secondary: number;
  /** Gloves and boots — red on the classic suit, not blue. */
  readonly accent: number;
  readonly eye: number;
  readonly emblem: number;
  readonly pattern: SuitPattern;
  /** Surface response — lets a metal suit read differently from spandex. */
  readonly metalness: number;
  readonly clearcoat: number;
  /** Emissive tint strength for suits that glow. */
  readonly glow: number;
  readonly unlockLevel: number;
  readonly blurb: string;
}

/**
 * Unlockable skins. Every value here is a material parameter, so a suit is
 * purely data — no new geometry, no new textures.
 *
 * Colour zones follow the classic layout: webbed primary over mask, chest,
 * shoulders and upper arms; smooth secondary over abdomen and legs; accent on
 * gloves and boots.
 */
export const SUITS: readonly SuitDef[] = [
  // --- Peter ---------------------------------------------------------------
  {
    id: 'advanced',
    name: 'Advanced Suit',
    hero: 'PETER',
    primary: 0xd62828,
    secondary: 0x1b2b47,
    accent: 0xd62828,
    eye: 0xf2f7ff,
    emblem: 0x101014,
    pattern: 'web',
    metalness: 0.06,
    clearcoat: 0.55,
    glow: 0,
    unlockLevel: 1,
    blurb: 'The default. Red and navy, white lenses, red gloves and boots.',
  },
  {
    id: 'classic',
    name: 'Classic',
    hero: 'PETER',
    primary: 0xc31b1b,
    secondary: 0x1f3fa8,
    accent: 0xc31b1b,
    eye: 0xffffff,
    emblem: 0x101014,
    pattern: 'web',
    metalness: 0.02,
    clearcoat: 0.3,
    glow: 0,
    unlockLevel: 3,
    blurb: 'Brighter blue, matte weave, black spider.',
  },
  {
    id: 'noir',
    name: 'Noir',
    hero: 'PETER',
    primary: 0x1a1a1f,
    secondary: 0x2a2a30,
    accent: 0x121216,
    eye: 0xdcdcdc,
    emblem: 0x000000,
    pattern: 'panel',
    metalness: 0.15,
    clearcoat: 0.15,
    glow: 0,
    unlockLevel: 6,
    blurb: 'Monochrome and matte. Drinks the light.',
  },
  {
    id: 'symbiote',
    name: 'Symbiote',
    hero: 'PETER',
    primary: 0x0a0a12,
    secondary: 0x14141c,
    accent: 0x0a0a12,
    eye: 0xf5f5ff,
    emblem: 0xf5f5ff,
    pattern: 'web',
    metalness: 0.1,
    clearcoat: 1,
    glow: 0.25,
    unlockLevel: 10,
    blurb: 'Wet black, oversized emblem, faint violet bleed.',
  },
  {
    id: 'iron-spider',
    name: 'Iron Spider',
    hero: 'PETER',
    primary: 0xb01818,
    secondary: 0x8f1414,
    accent: 0xc9a227,
    eye: 0xffd76a,
    emblem: 0xc9a227,
    pattern: 'panel',
    metalness: 0.85,
    clearcoat: 1,
    glow: 0.1,
    unlockLevel: 15,
    blurb: 'Armour plate. Crimson with gold gauntlets and boots.',
  },
  {
    id: 'arc-reactor',
    name: 'Arc Weave',
    hero: 'PETER',
    primary: 0x14232b,
    secondary: 0x0e1a20,
    accent: 0x39d0d8,
    eye: 0x9ff5ff,
    emblem: 0x39d0d8,
    pattern: 'web',
    metalness: 0.55,
    clearcoat: 0.85,
    glow: 0.32,
    unlockLevel: 18,
    blurb: 'Teal filament woven through gunmetal. Hums slightly.',
  },
  {
    id: 'scarlet',
    name: 'Scarlet',
    hero: 'PETER',
    primary: 0x8f0f1a,
    secondary: 0xe8e8ee,
    accent: 0x8f0f1a,
    eye: 0x1a1a20,
    emblem: 0x1a1a20,
    pattern: 'web',
    metalness: 0.04,
    clearcoat: 0.35,
    glow: 0,
    unlockLevel: 22,
    blurb: 'Deep red over bone white. Dark lenses, no shine.',
  },

  // --- Miles ---------------------------------------------------------------
  // Same zone layout, black where Peter is red, red where Peter is blue.
  {
    id: 'miles-classic',
    name: 'Bodega Cat',
    hero: 'MILES',
    primary: 0x121216,
    secondary: 0x0d0d11,
    accent: 0xd62828,
    eye: 0xf2f7ff,
    emblem: 0xe01f26,
    pattern: 'web',
    metalness: 0.08,
    clearcoat: 0.35,
    glow: 0,
    unlockLevel: 1,
    blurb: 'Matte black with red gloves, boots and spider.',
  },
  {
    id: 'programmable',
    name: 'Programmable Matter',
    hero: 'MILES',
    primary: 0x1b2340,
    secondary: 0x141a30,
    accent: 0x3ad0ff,
    eye: 0x8ff0ff,
    emblem: 0x3ad0ff,
    pattern: 'panel',
    metalness: 0.6,
    clearcoat: 0.9,
    glow: 0.3,
    unlockLevel: 5,
    blurb: 'Shifting nanotech plate with a cyan charge.',
  },
  {
    id: 'crimson-cowl',
    name: 'Crimson Cowl',
    hero: 'MILES',
    primary: 0x7d1128,
    secondary: 0x1a1a20,
    accent: 0x7d1128,
    eye: 0xffd0d0,
    emblem: 0xf0f0f0,
    pattern: 'web',
    metalness: 0.12,
    clearcoat: 0.45,
    glow: 0,
    unlockLevel: 8,
    blurb: 'Deep crimson over black, white spider.',
  },
  {
    id: 'bio-electric',
    name: 'Bio-Electric',
    hero: 'MILES',
    primary: 0x0d0d14,
    secondary: 0x0a0a10,
    accent: 0xffb703,
    eye: 0xffe066,
    emblem: 0xffb703,
    pattern: 'panel',
    metalness: 0.3,
    clearcoat: 0.7,
    glow: 0.45,
    unlockLevel: 12,
    blurb: 'Venom-charged. Amber circuitry, always lit.',
  },
  {
    id: 'midnight',
    name: 'Midnight Patrol',
    hero: 'MILES',
    primary: 0x101a2e,
    secondary: 0x0b1220,
    accent: 0x7a8cff,
    eye: 0xc8d4ff,
    emblem: 0x7a8cff,
    pattern: 'panel',
    metalness: 0.2,
    clearcoat: 0.55,
    glow: 0.12,
    unlockLevel: 16,
    blurb: 'Deep navy with a cold indigo trim. Built for the small hours.',
  },
  {
    id: 'graffiti',
    name: 'Spray Paint',
    hero: 'MILES',
    primary: 0x22202a,
    secondary: 0x18171f,
    accent: 0x39d98a,
    eye: 0xa8ffd8,
    emblem: 0x39d98a,
    pattern: 'panel',
    metalness: 0.05,
    clearcoat: 0.2,
    glow: 0.08,
    unlockLevel: 20,
    blurb: 'Matte charcoal with a hit of neon green. Hand-finished.',
  },
];

export const DEFAULT_SUIT: Record<HeroId, string> = {
  PETER: 'advanced',
  MILES: 'miles-classic',
};

export function suitsFor(hero: HeroId): readonly SuitDef[] {
  return SUITS.filter((s) => s.hero === hero);
}

export function findSuit(id: string): SuitDef | undefined {
  return SUITS.find((s) => s.id === id);
}

/** Suits available at the given level, in unlock order. */
export function unlockedSuits(hero: HeroId, level: number): readonly SuitDef[] {
  return suitsFor(hero).filter((s) => s.unlockLevel <= level);
}
