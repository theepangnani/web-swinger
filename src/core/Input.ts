import { CONFIG } from './Config';
import { clamp, deadzone } from './MathUtils';
import { ALWAYS_BOUND, type BindableAction, type Settings } from '../ui/Settings';

/**
 * Unified input layer. Keyboard + mouse and a Standard-mapping gamepad both
 * feed the same action set, so nothing downstream needs to know which device
 * produced a value.
 *
 * Held actions are booleans; one-shot actions are edges that are cleared by
 * `endFrame()` and must be consumed within the frame they fire.
 */
export class Input {
  /** Analog move: +y forward, +x right. Magnitude clamped to 1. */
  moveX = 0;
  moveY = 0;

  /** Accumulated look delta for this frame, already sensitivity-scaled. */
  lookX = 0;
  lookY = 0;

  /** Dedicated reel axis (arrow keys / d-pad): +1 reels in, -1 pays out. */
  reelAxis = 0;

  webHeld = false;
  webPressed = false;
  webReleased = false;

  strikePressed = false;
  abilityPressed = false;
  swapPressed = false;
  jumpPressed = false;
  climbHeld = false;
  pausePressed = false;
  mutePressed = false;
  /** Fixed keys that are deliberately not rebindable. */
  settingsPressed = false;
  legendPressed = false;

  // --- traversal / combat extensions ---------------------------------------
  sprintHeld = false;
  glideHeld = false;
  dodgePressed = false;
  zipPressed = false;
  gadgetPressed = false;
  /** -1 / +1 to cycle the selected gadget, 0 for no change. */
  gadgetCycle = 0;
  healPressed = false;
  finisherPressed = false;
  skillMenuPressed = false;

  pointerLocked = false;
  gamepadConnected = false;

  private readonly keys = new Set<string>();
  private readonly keyEdges = new Set<string>();
  private mouseDownEdge = false;
  private mouseHeld = false;
  private rightMouseEdge = false;
  private middleMouseEdge = false;
  private rawLookX = 0;
  private rawLookY = 0;
  private prevButtons: boolean[] = [];
  private gamepadIndex: number | null = null;
  private canvas: HTMLElement | null = null;
  private disposers: Array<() => void> = [];
  private readonly settings: Settings;

  /** While true, keyboard input is swallowed — used by the rebind prompt. */
  captureMode = false;

  constructor(settings: Settings) {
    this.settings = settings;
  }

  /** True if the key bound to `action` (or one of its aliases) is held. */
  private actionDown(action: BindableAction): boolean {
    const primary = this.settings.binding(action);
    if (primary && this.keys.has(primary)) return true;
    const aliases = ALWAYS_BOUND[action];
    return aliases ? aliases.some((code) => this.keys.has(code)) : false;
  }

  /** True on the frame the key bound to `action` was pressed. */
  private actionPressed(action: BindableAction): boolean {
    const primary = this.settings.binding(action);
    if (primary && this.keyEdges.has(primary)) return true;
    const aliases = ALWAYS_BOUND[action];
    return aliases ? aliases.some((code) => this.keyEdges.has(code)) : false;
  }

  attach(canvas: HTMLElement): void {
    this.canvas = canvas;

    const onKeyDown = (e: KeyboardEvent): void => {
      // Space, Tab and the arrow keys all have default browser behaviour.
      if (e.code === 'Space' || e.code === 'Tab' || e.code.startsWith('Arrow')) e.preventDefault();
      if (this.captureMode) return;
      if (!this.keys.has(e.code)) this.keyEdges.add(e.code);
      this.keys.add(e.code);
    };
    const onKeyUp = (e: KeyboardEvent): void => {
      this.keys.delete(e.code);
    };
    const onMouseDown = (e: MouseEvent): void => {
      if (!this.pointerLocked) {
        // A click that acquires pointer lock must not also fire a web.
        if (e.button === 0) this.mouseHeld = true;
        return;
      }
      if (e.button === 0) {
        this.mouseHeld = true;
        this.mouseDownEdge = true;
      } else if (e.button === 2) {
        this.rightMouseEdge = true;
      } else if (e.button === 1) {
        e.preventDefault();
        this.middleMouseEdge = true;
      }
    };
    const onMouseUp = (e: MouseEvent): void => {
      if (e.button === 0) this.mouseHeld = false;
    };
    const onMouseMove = (e: MouseEvent): void => {
      if (!this.pointerLocked) return;
      const sensitivity = CONFIG.camera.mouseSensitivity * this.settings.data.mouseSensitivity;
      const invert = this.settings.data.invertY ? -1 : 1;
      this.rawLookX += e.movementX * sensitivity;
      this.rawLookY += e.movementY * sensitivity * invert;
    };
    const onPointerLockChange = (): void => {
      this.pointerLocked = document.pointerLockElement === this.canvas;
      if (!this.pointerLocked) this.releaseAll();
    };
    const onBlur = (): void => this.releaseAll();
    const onContextMenu = (e: MouseEvent): void => e.preventDefault();
    const onGamepadConnected = (e: GamepadEvent): void => {
      this.gamepadIndex = e.gamepad.index;
      this.gamepadConnected = true;
    };
    const onGamepadDisconnected = (e: GamepadEvent): void => {
      if (this.gamepadIndex === e.gamepad.index) {
        this.gamepadIndex = null;
        this.gamepadConnected = false;
        this.prevButtons = [];
      }
    };

    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    window.addEventListener('mousedown', onMouseDown);
    window.addEventListener('mouseup', onMouseUp);
    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('blur', onBlur);
    window.addEventListener('gamepadconnected', onGamepadConnected);
    window.addEventListener('gamepaddisconnected', onGamepadDisconnected);
    document.addEventListener('pointerlockchange', onPointerLockChange);
    canvas.addEventListener('contextmenu', onContextMenu);

    this.disposers = [
      () => window.removeEventListener('keydown', onKeyDown),
      () => window.removeEventListener('keyup', onKeyUp),
      () => window.removeEventListener('mousedown', onMouseDown),
      () => window.removeEventListener('mouseup', onMouseUp),
      () => window.removeEventListener('mousemove', onMouseMove),
      () => window.removeEventListener('blur', onBlur),
      () => window.removeEventListener('gamepadconnected', onGamepadConnected),
      () => window.removeEventListener('gamepaddisconnected', onGamepadDisconnected),
      () => document.removeEventListener('pointerlockchange', onPointerLockChange),
      () => canvas.removeEventListener('contextmenu', onContextMenu),
    ];
  }

  requestPointerLock(): void {
    if (!this.canvas || this.pointerLocked) return;
    // Chrome returns a promise here; older browsers return void. Ignore either.
    void (this.canvas.requestPointerLock() as unknown as Promise<void> | void);
  }

  /** Rebuilds the action set for this frame. Call once, before the update. */
  poll(): void {
    const kb = this.pollKeyboard();
    const pad = this.pollGamepad();

    let mx = kb.moveX + pad.moveX;
    let my = kb.moveY + pad.moveY;
    const mag = Math.hypot(mx, my);
    if (mag > 1) {
      mx /= mag;
      my /= mag;
    }
    this.moveX = mx;
    this.moveY = my;

    this.lookX = this.rawLookX + pad.lookX;
    this.lookY = this.rawLookY + pad.lookY;
    this.reelAxis = clamp(kb.reel + pad.reel, -1, 1);

    const webHeldNow = kb.web || pad.web;
    this.webPressed = webHeldNow && !this.webHeld;
    this.webReleased = !webHeldNow && this.webHeld;
    this.webHeld = webHeldNow;

    this.strikePressed = this.mouseDownEdge || pad.strike;
    this.abilityPressed = kb.ability || pad.ability;
    this.swapPressed = kb.swap || pad.swap;
    this.jumpPressed = kb.jump || pad.jump;
    this.climbHeld = kb.climb || pad.climb;
    this.pausePressed = this.keyEdges.has('Escape') || pad.pause;
    this.mutePressed = kb.mute;
    this.settingsPressed = this.keyEdges.has('KeyO');
    this.legendPressed = this.keyEdges.has('KeyL');

    this.sprintHeld = kb.sprint || pad.sprint;
    this.glideHeld = kb.glide || pad.glide;
    this.dodgePressed = this.rightMouseEdge || kb.dodge || pad.dodge;
    this.zipPressed = this.middleMouseEdge || kb.zip || pad.zip;
    this.gadgetPressed = kb.gadget || pad.gadget;
    this.gadgetCycle = kb.gadgetCycle !== 0 ? kb.gadgetCycle : pad.gadgetCycle;
    this.healPressed = kb.heal;
    this.finisherPressed = kb.finisher;
    this.skillMenuPressed = kb.skillMenu;
  }

  /** Clears per-frame edges and accumulated deltas. */
  endFrame(): void {
    this.keyEdges.clear();
    this.mouseDownEdge = false;
    this.rightMouseEdge = false;
    this.middleMouseEdge = false;
    this.rawLookX = 0;
    this.rawLookY = 0;
  }

  isDown(code: string): boolean {
    return this.keys.has(code);
  }

  dispose(): void {
    for (const d of this.disposers) d();
    this.disposers = [];
  }

  private releaseAll(): void {
    this.keys.clear();
    this.keyEdges.clear();
    this.mouseHeld = false;
    this.mouseDownEdge = false;
    this.rightMouseEdge = false;
    this.middleMouseEdge = false;
    this.rawLookX = 0;
    this.rawLookY = 0;
  }

  private pollKeyboard(): KeyboardActions {
    // Arrow keys mirror WASD everywhere, including reeling while swinging.
    let moveX = 0;
    let moveY = 0;
    if (this.actionDown('moveForward')) moveY += 1;
    if (this.actionDown('moveBack')) moveY -= 1;
    if (this.actionDown('moveRight')) moveX += 1;
    if (this.actionDown('moveLeft')) moveX -= 1;

    const sprint = this.actionDown('sprint');

    return {
      moveX,
      moveY,
      // Reeling reuses the move axis, so there is nothing extra to learn:
      // forward/back adjust line length while a web is attached.
      reel: 0,
      web: this.actionDown('swing'),
      jump: this.actionPressed('swing'),
      ability: this.actionPressed('ability'),
      swap: this.actionPressed('swap'),
      climb: this.actionDown('climb'),
      mute: this.actionPressed('mute'),
      // One key, context-sensitive: sprint on the ground, glide in the air.
      sprint,
      glide: sprint,
      dodge: false, // right mouse button
      zip: false, // middle mouse button
      gadget: this.actionPressed('gadget'),
      // Holding sprint while throwing cycles to the next gadget instead.
      gadgetCycle: this.actionPressed('gadget') && sprint ? 1 : 0,
      // Two distinct Focus actions, so neither is chosen for you.
      heal: this.actionPressed('heal'),
      finisher: this.actionPressed('focus'),
      skillMenu: this.actionPressed('skills'),
    };
  }

  private pollGamepad(): GamepadActions {
    const empty: GamepadActions = {
      moveX: 0,
      moveY: 0,
      lookX: 0,
      lookY: 0,
      reel: 0,
      web: false,
      jump: false,
      strike: false,
      ability: false,
      swap: false,
      climb: false,
      pause: false,
      mute: false,
      sprint: false,
      glide: false,
      dodge: false,
      zip: false,
      gadget: false,
      gadgetCycle: 0,
      heal: false,
      finisher: false,
      skillMenu: false,
    };

    if (typeof navigator.getGamepads !== 'function') return empty;
    const pads = navigator.getGamepads();
    let pad: Gamepad | null = null;
    if (this.gamepadIndex !== null) pad = pads[this.gamepadIndex] ?? null;
    if (!pad) {
      for (const candidate of pads) {
        if (candidate && candidate.connected) {
          pad = candidate;
          this.gamepadIndex = candidate.index;
          break;
        }
      }
    }
    this.gamepadConnected = pad !== null;
    if (!pad) {
      this.prevButtons = [];
      return empty;
    }

    // Bind to a const: TypeScript will not narrow a mutable `let` inside the
    // closures below.
    const gp: Gamepad = pad;
    const dz = CONFIG.input.gamepadDeadzone;
    const axis = (i: number): number => deadzone(gp.axes[i] ?? 0, dz);
    const held = (i: number): boolean => {
      const b = gp.buttons[i];
      if (!b) return false;
      return b.pressed || b.value > CONFIG.input.gamepadTriggerThreshold;
    };
    const pressed = (i: number): boolean => held(i) && !this.prevButtons[i];

    const actions: GamepadActions = {
      moveX: axis(0),
      moveY: -axis(1),
      lookX: axis(2) * CONFIG.camera.stickSensitivity * 0.016,
      lookY: axis(3) * CONFIG.camera.stickSensitivity * 0.016,
      // D-pad up/down doubles as the reel axis.
      reel: (held(12) ? 1 : 0) + (held(13) ? -1 : 0),
      web: held(7), // R2
      jump: pressed(0),
      strike: pressed(0), // X / A — jump and strike are context-resolved
      ability: pressed(3), // Y / Triangle
      swap: pressed(8), // Select / Share
      climb: held(4), // L1
      pause: pressed(9), // Start
      mute: false, // keyboard only
      sprint: held(6), // L2
      glide: held(10), // L3
      dodge: pressed(1), // Circle / B
      zip: pressed(5), // R1
      gadget: pressed(2), // Square / X
      gadgetCycle: (pressed(15) ? 1 : 0) + (pressed(14) ? -1 : 0), // d-pad L/R
      heal: false, // keyboard only
      finisher: false, // keyboard only
      skillMenu: false, // keyboard only
    };

    const count = gp.buttons.length;
    const next: boolean[] = new Array<boolean>(count);
    for (let i = 0; i < count; i++) next[i] = held(i);
    this.prevButtons = next;

    return actions;
  }
}

interface KeyboardActions {
  moveX: number;
  moveY: number;
  reel: number;
  web: boolean;
  jump: boolean;
  ability: boolean;
  swap: boolean;
  climb: boolean;
  mute: boolean;
  sprint: boolean;
  glide: boolean;
  dodge: boolean;
  zip: boolean;
  gadget: boolean;
  gadgetCycle: number;
  heal: boolean;
  finisher: boolean;
  skillMenu: boolean;
}

interface GamepadActions extends KeyboardActions {
  lookX: number;
  lookY: number;
  strike: boolean;
  pause: boolean;
}
