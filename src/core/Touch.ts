/**
 * On-screen controls, for the machines that have no keyboard.
 *
 * The game was keyboard and mouse only, which on a phone does not mean "harder"
 * — it means the page loads, shows a city, and cannot be played at all. Worse,
 * it did not even say so: the pause overlay is driven by pointer lock, which a
 * touchscreen never grants, so a phone sat on "Paused — pointer released. Click
 * anywhere to dive back in." forever while clicking did nothing.
 *
 * Twenty verbs do not fit under two thumbs, so this is not a transcription of
 * the keyboard. It is the subset the game is actually about — move, look,
 * swing, hit, dodge — with the rest on a secondary row, and two verbs folded
 * into gestures that already meant them:
 *
 *  - **Sprint and glide** are the stick pushed to its edge. On the keyboard
 *    both are Shift, and which one you get already depends on whether your
 *    feet are on something, so one gesture covering both is not a compromise.
 *  - **Reeling in and out** is a vertical drag on the swing button while a
 *    line is attached, which is the same thumb already holding it.
 *
 * Pointer events rather than touch events, so a stylus and a touchscreen
 * laptop work without a second code path, and multi-touch is just a pointerId
 * per control — the thing that makes "move while looking while swinging"
 * possible, and the thing a naive touch implementation always gets wrong.
 */

export interface TouchActions {
  moveX: number;
  moveY: number;
  lookX: number;
  lookY: number;
  reel: number;
  web: boolean;
  strike: boolean;
  dodge: boolean;
  zip: boolean;
  sprint: boolean;
  glide: boolean;
  gadget: boolean;
  heal: boolean;
  ability: boolean;
  swap: boolean;
  finisher: boolean;
  skillMenu: boolean;
  settings: boolean;
}

const NONE: TouchActions = {
  moveX: 0,
  moveY: 0,
  lookX: 0,
  lookY: 0,
  reel: 0,
  web: false,
  strike: false,
  dodge: false,
  zip: false,
  sprint: false,
  glide: false,
  gadget: false,
  heal: false,
  ability: false,
  swap: false,
  finisher: false,
  skillMenu: false,
  settings: false,
};

/** Buttons that report a single press rather than being held. */
type EdgeButton = 'strike' | 'dodge' | 'zip' | 'gadget' | 'heal' | 'ability' | 'swap' | 'finisher' | 'skillMenu' | 'settings';

interface Button {
  readonly id: EdgeButton | 'web';
  readonly label: string;
  readonly hint: string;
  readonly cls: string;
}

/**
 * The layout, in the order it is built.
 *
 * `web` is first and largest because it is the only one held rather than
 * tapped, and it is the verb the whole game is built on: a player who can only
 * find one button should find that one.
 */
const BUTTONS: readonly Button[] = [
  { id: 'web', label: 'SWING', hint: 'hold · drag up/down to reel', cls: 'tc-web' },
  { id: 'strike', label: 'HIT', hint: 'attack', cls: 'tc-hit' },
  { id: 'dodge', label: 'DODGE', hint: 'dodge', cls: 'tc-dodge' },
  { id: 'zip', label: 'ZIP', hint: 'zip to point', cls: 'tc-small tc-zip' },
  { id: 'gadget', label: 'GADGET', hint: 'throw gadget', cls: 'tc-small tc-gadget' },
  { id: 'heal', label: 'HEAL', hint: 'spend focus on health', cls: 'tc-small tc-heal' },
  { id: 'ability', label: 'POWER', hint: 'signature ability', cls: 'tc-small tc-ability' },
  { id: 'finisher', label: 'FINISH', hint: 'finisher', cls: 'tc-small tc-finisher' },
  { id: 'swap', label: 'SWAP', hint: 'swap hero', cls: 'tc-tiny tc-swap' },
  { id: 'skillMenu', label: 'SKILLS', hint: 'skills and suits', cls: 'tc-tiny tc-skills' },
  { id: 'settings', label: 'SET', hint: 'settings', cls: 'tc-tiny tc-settings' },
];

/** Stick deflection past which the player is sprinting (or gliding, in air). */
const SPRINT_AT = 0.86;
/** Pixels of vertical drag on the swing button that equals full reel. */
const REEL_RANGE = 90;

export class TouchControls {
  /** True when this device wants on-screen controls at all. */
  readonly active: boolean;

  readonly root: HTMLElement | null = null;

  private readonly held = new Set<string>();
  private readonly edges = new Set<string>();
  /** pointerId -> which control that finger is currently driving. */
  private readonly owners = new Map<number, string>();

  private stickId: number | null = null;
  private stickOrigin = { x: 0, y: 0 };
  private stickX = 0;
  private stickY = 0;

  private lookId: number | null = null;
  private lookLast = { x: 0, y: 0 };
  private lookDX = 0;
  private lookDY = 0;

  private webStartY = 0;
  private reel = 0;

  private readonly disposers: Array<() => void> = [];

  constructor(container: HTMLElement) {
    this.active = TouchControls.wanted();
    if (!this.active) return;

    const root = document.createElement('div');
    root.className = 'touch-controls';
    root.innerHTML = '<div class="tc-look" aria-hidden="true"></div><div class="tc-stick"><i></i></div>';

    const pad = document.createElement('div');
    pad.className = 'tc-pad';
    for (const button of BUTTONS) {
      const el = document.createElement('button');
      el.className = `tc-btn ${button.cls}`;
      el.type = 'button';
      el.dataset.action = button.id;
      el.textContent = button.label;
      // Real buttons with real labels, so a screen reader has something to say
      // and the control is not a mystery rectangle.
      el.setAttribute('aria-label', `${button.label} — ${button.hint}`);
      pad.appendChild(el);
    }
    root.appendChild(pad);
    container.appendChild(root);
    this.root = root;

    const down = (e: PointerEvent): void => this.onDown(e);
    const move = (e: PointerEvent): void => this.onMove(e);
    const up = (e: PointerEvent): void => this.onUp(e);

    root.addEventListener('pointerdown', down);
    // Bound to the window rather than the control: a thumb that slides off a
    // button still has to release it, and a look drag that leaves the pad has
    // to keep steering.
    window.addEventListener('pointermove', move, { passive: false });
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
    this.disposers.push(
      () => root.removeEventListener('pointerdown', down),
      () => window.removeEventListener('pointermove', move),
      () => window.removeEventListener('pointerup', up),
      () => window.removeEventListener('pointercancel', up),
    );
  }

  /**
   * Whether to show them.
   *
   * A coarse primary pointer is the honest test — it is true on phones and
   * tablets and false on a laptop with a trackpad, which is exactly the split.
   * A touchscreen laptop reports a fine primary pointer and gets the keyboard
   * game, which is right: it has a keyboard.
   */
  static wanted(): boolean {
    try {
      if (typeof window === 'undefined' || !window.matchMedia) return false;
      return window.matchMedia('(pointer: coarse)').matches;
    } catch {
      return false;
    }
  }

  /** Everything the frame needs, in the same shape the gamepad reports. */
  poll(): TouchActions {
    if (!this.active) return NONE;

    const magnitude = Math.hypot(this.stickX, this.stickY);
    const pushed = magnitude > SPRINT_AT;
    return {
      moveX: this.stickX,
      moveY: this.stickY,
      lookX: this.lookDX,
      lookY: this.lookDY,
      reel: this.reel,
      web: this.held.has('web'),
      strike: this.edges.has('strike'),
      dodge: this.edges.has('dodge'),
      zip: this.edges.has('zip'),
      // One gesture for both, because the keyboard already uses one key for
      // both and picks by whether you are airborne.
      sprint: pushed,
      glide: pushed,
      gadget: this.edges.has('gadget'),
      heal: this.edges.has('heal'),
      ability: this.edges.has('ability'),
      swap: this.edges.has('swap'),
      finisher: this.edges.has('finisher'),
      skillMenu: this.edges.has('skillMenu'),
      settings: this.edges.has('settings'),
    };
  }

  /** Clears one-frame presses and the accumulated look delta. */
  endFrame(): void {
    this.edges.clear();
    this.lookDX = 0;
    this.lookDY = 0;
  }

  dispose(): void {
    for (const off of this.disposers) off();
    this.root?.remove();
  }

  // ---------------------------------------------------------------- private

  private onDown(event: PointerEvent): void {
    const target = event.target as HTMLElement | null;
    const action = target?.dataset?.action;

    if (action) {
      event.preventDefault();
      this.owners.set(event.pointerId, action);
      this.held.add(action);
      // Held buttons report continuously; the rest fire once on the way down,
      // which is what a keyboard edge means.
      if (action !== 'web') this.edges.add(action);
      else this.webStartY = event.clientY;
      return;
    }

    if (target?.classList.contains('tc-stick') || this.inStickZone(event)) {
      event.preventDefault();
      this.stickId = event.pointerId;
      this.owners.set(event.pointerId, 'stick');
      this.stickOrigin = { x: event.clientX, y: event.clientY };
      return;
    }

    // Anything else on the control layer is camera drag.
    event.preventDefault();
    this.lookId = event.pointerId;
    this.owners.set(event.pointerId, 'look');
    this.lookLast = { x: event.clientX, y: event.clientY };
  }

  private onMove(event: PointerEvent): void {
    const owner = this.owners.get(event.pointerId);
    if (!owner) return;
    event.preventDefault();

    if (owner === 'stick') {
      const dx = event.clientX - this.stickOrigin.x;
      const dy = event.clientY - this.stickOrigin.y;
      const radius = 58;
      const length = Math.hypot(dx, dy);
      const scale = length > radius ? radius / length : 1;
      this.stickX = (dx * scale) / radius;
      // Screen down is forward-negative: pushing the stick up walks forward.
      this.stickY = (-dy * scale) / radius;
      const knob = this.root?.querySelector<HTMLElement>('.tc-stick i');
      if (knob) knob.style.transform = `translate(${dx * scale}px, ${dy * scale}px)`;
      return;
    }

    if (owner === 'look') {
      this.lookDX += event.clientX - this.lookLast.x;
      this.lookDY += event.clientY - this.lookLast.y;
      this.lookLast = { x: event.clientX, y: event.clientY };
      return;
    }

    if (owner === 'web') {
      // Same thumb, second axis: drag up to reel in, down to pay out.
      const drag = this.webStartY - event.clientY;
      this.reel = Math.max(-1, Math.min(1, drag / REEL_RANGE));
    }
  }

  private onUp(event: PointerEvent): void {
    const owner = this.owners.get(event.pointerId);
    if (!owner) return;
    this.owners.delete(event.pointerId);

    if (owner === 'stick') {
      this.stickId = null;
      this.stickX = 0;
      this.stickY = 0;
      const knob = this.root?.querySelector<HTMLElement>('.tc-stick i');
      if (knob) knob.style.transform = '';
      return;
    }
    if (owner === 'look') {
      this.lookId = null;
      return;
    }
    this.held.delete(owner);
    if (owner === 'web') this.reel = 0;
  }

  /** The lower-left quadrant doubles as the stick, so the thumb need not aim. */
  private inStickZone(event: PointerEvent): boolean {
    if (this.stickId !== null) return false;
    return event.clientX < window.innerWidth * 0.45 && event.clientY > window.innerHeight * 0.4;
  }
}
