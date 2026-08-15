import type * as THREE from 'three';

/**
 * The minimum surface every damageable thing exposes, so gadgets, finishers
 * and the strike system can operate on villains and street thugs uniformly
 * without either module importing the other.
 */
export interface CombatTarget {
  readonly name: string;
  readonly pos: THREE.Vector3;
  alive: boolean;
  hp: number;
  readonly maxHp: number;
  /** Flash intensity, 0..1, driven by recent damage. */
  hitFlash: number;
  /** Seconds of cocooned/stunned time remaining. */
  webbed: number;
  /**
   * Body radius, for range checks. `pos` is a single point at the target's
   * origin, which is fine for anything roughly person-sized and useless for
   * something the size of a building — Sandman's head is ten metres from his
   * origin, so a point-to-point melee check made it unreachable. Range tests
   * subtract this. Absent or 0 means "treat as a point", which is every
   * ordinary enemy.
   */
  readonly hitRadius?: number;
}

/**
 * Distance from a point to a target's *surface* rather than its origin.
 *
 * Every range check in the game should go through this. Comparing against
 * `pos` alone silently assumes everything is person-sized, which stopped being
 * true the moment a villain got built at the scale of a city block.
 */
export function reachTo(target: CombatTarget, from: THREE.Vector3): number {
  return Math.max(0, target.pos.distanceTo(from) - (target.hitRadius ?? 0));
}

/** A system that owns a pool of combat targets. */
export interface TargetProvider {
  readonly combatTargets: readonly CombatTarget[];
  /**
   * Applies damage and effects. `from` is the impact origin, used for
   * knockback direction.
   */
  damageTarget(target: CombatTarget, amount: number, from?: THREE.Vector3): void;
}
