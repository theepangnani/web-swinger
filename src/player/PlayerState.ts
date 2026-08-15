/** Mutually exclusive movement states. The HUD prints these verbatim. */
export enum PlayerState {
  Running = 'RUNNING',
  Sprinting = 'SPRINTING',
  Airborne = 'AIRBORNE',
  Swinging = 'SWINGING',
  WallCrawl = 'WALL-CRAWL',
  WallRun = 'WALL RUN',
  Zipping = 'WEB ZIP',
  Gliding = 'GLIDING',
  Striking = 'WEB STRIKE',
  Attacking = 'ATTACK',
  Dodging = 'DODGE',
  Charging = 'CHARGE JUMP',
  Trick = 'AIR TRICK',
}

/** States in which the player is not touching a surface. */
export const AIRBORNE_STATES: ReadonlySet<PlayerState> = new Set([
  PlayerState.Airborne,
  PlayerState.Swinging,
  PlayerState.Zipping,
  PlayerState.Gliding,
  PlayerState.Striking,
  PlayerState.Trick,
]);
