/**
 * On-screen controls, against a stubbed DOM.
 *
 * Touch is easy to get subtly wrong in ways that only show up with a real
 * thumb on real glass, which is the worst possible place to find them. The
 * three that matter:
 *
 *  - **Multi-touch.** Move while looking while swinging is the whole game.
 *    An implementation that tracks "the touch" rather than a pointerId per
 *    control works perfectly until the second finger lands.
 *  - **Edges versus holds.** Swing is held; everything else fires once. A
 *    held dodge, or a swing that stops the moment the finger stops moving,
 *    are both unplayable in different directions.
 *  - **Which way is forward.** Screen Y grows downward and the game's does
 *    not, so a sign error walks the player backwards.
 */
import { bundle } from './_bundle.mjs';

// --- a DOM, in about forty lines ------------------------------------------

const listeners = new Map();
function record(target, type, fn) {
  const key = `${target}:${type}`;
  if (!listeners.has(key)) listeners.set(key, []);
  listeners.get(key).push(fn);
}
function fire(target, type, event) {
  for (const fn of listeners.get(`${target}:${type}`) ?? []) fn(event);
}

const created = [];
function element(tag) {
  const el = {
    tag,
    children: [],
    style: {},
    dataset: {},
    classList: {
      _set: new Set(),
      add(c) { this._set.add(c); },
      contains(c) { return this._set.has(c); },
    },
    set className(v) {
      this._cls = v;
      for (const c of String(v).split(/\s+/)) if (c) this.classList.add(c);
    },
    get className() { return this._cls ?? ''; },
    appendChild(child) { this.children.push(child); return child; },
    addEventListener(type, fn) { record('root', type, fn); },
    removeEventListener() {},
    querySelector() { return null; },
    setAttribute() {},
    remove() {},
    innerHTML: '',
    textContent: '',
  };
  created.push(el);
  return el;
}

globalThis.document = { createElement: element, body: element('body') };
let coarse = true;
globalThis.window = {
  innerWidth: 900,
  innerHeight: 500,
  matchMedia: (q) => ({ matches: q.includes('coarse') ? coarse : !coarse }),
  addEventListener: (type, fn) => record('window', type, fn),
  removeEventListener: () => {},
};

const { TouchControls } = await bundle([['{ TouchControls }', 'src/core/Touch']], 'touch');

let fails = 0;
const fail = (m) => {
  console.log('  FAIL ' + m);
  fails++;
};
const ok = (m) => console.log('  ok — ' + m);

/** A pointer event, as the class actually reads one. */
const ev = (pointerId, x, y, target = null) => ({
  pointerId,
  clientX: x,
  clientY: y,
  target,
  preventDefault() {},
});

const down = (e) => fire('root', 'pointerdown', e);
const move = (e) => fire('window', 'pointermove', e);
const up = (e) => fire('window', 'pointerup', e);

/** The on-screen button for an action, as built by the constructor. */
const button = (action) => created.find((el) => el.dataset.action === action);

console.log('[1] shown only where it belongs');
{
  if (!TouchControls.wanted()) fail('not offered on a coarse pointer');
  else ok('offered on a coarse pointer');
  coarse = false;
  if (TouchControls.wanted()) fail('offered on a desktop, where it is just clutter');
  else ok('not offered on a fine pointer');
  coarse = true;
}

const controls = new TouchControls(document.body);

console.log('\n[2] the stick');
{
  if (!controls.active) fail('inactive on a touch device');

  // Pushing up must walk forward. Screen Y grows downward and the game's does
  // not, and a sign error here walks the player backwards into traffic.
  down(ev(1, 100, 400));
  move(ev(1, 100, 342));
  let a = controls.poll();
  if (!(a.moveY > 0.9)) fail(`pushing up gave moveY ${a.moveY.toFixed(2)}; forward is positive`);
  else ok('pushing up walks forward');

  move(ev(1, 158, 400));
  a = controls.poll();
  if (!(a.moveX > 0.9)) fail(`pushing right gave moveX ${a.moveX.toFixed(2)}`);
  else ok('pushing right walks right');

  // Clamped to the circle: a thumb dragged across the whole screen must not
  // report a speed the rest of the game has never seen.
  move(ev(1, 900, 400));
  a = controls.poll();
  if (Math.hypot(a.moveX, a.moveY) > 1.001) fail('deflection exceeds full');
  else ok('deflection is clamped to the ring');

  // Full push is sprint on the ground and glide in the air — one gesture,
  // because the keyboard already uses one key and picks by whether you are
  // standing on something.
  if (!a.sprint || !a.glide) fail('a full push is neither sprint nor glide');
  else ok('a full push is sprint and glide');

  up(ev(1, 900, 400));
  a = controls.poll();
  if (a.moveX !== 0 || a.moveY !== 0) fail('the stick did not recentre on release');
  else if (a.sprint) fail('still sprinting after letting go');
  else ok('recentres on release');
}

console.log('\n[3] holds and taps');
{
  // Swing is held. A swing that ends when the thumb stops moving is unplayable.
  down(ev(2, 800, 400, button('web')));
  if (!controls.poll().web) fail('swing did not register');
  controls.endFrame();
  if (!controls.poll().web) fail('swing stopped being held without a release');
  else ok('swing is held across frames');
  up(ev(2, 800, 400));
  if (controls.poll().web) fail('swing survived its release');
  else ok('swing ends on release');

  // Everything else is one frame, or a tap becomes an auto-fire.
  down(ev(3, 700, 400, button('dodge')));
  if (!controls.poll().dodge) fail('dodge did not register');
  else ok('dodge registers on press');
  controls.endFrame();
  if (controls.poll().dodge) fail('dodge repeated on the next frame — that is auto-fire');
  else ok('dodge is a single frame');
  up(ev(3, 700, 400));
}

console.log('\n[4] three fingers at once');
{
  // The one that separates a working touch layer from a broken one.
  controls.endFrame();
  down(ev(10, 100, 400));                        // left thumb: stick
  down(ev(11, 800, 300, button('web')));         // right thumb: swing
  down(ev(12, 600, 200));                        // third finger: camera
  move(ev(10, 100, 350));
  move(ev(12, 660, 200));

  const a = controls.poll();
  if (!(a.moveY > 0)) fail('the stick stopped working once another finger landed');
  else if (!a.web) fail('the swing was cancelled by another finger');
  else if (!(a.lookX > 0)) fail('the camera did not track the third finger');
  else ok('stick, swing and camera all work at the same time');

  up(ev(10, 100, 350));
  up(ev(11, 800, 300));
  up(ev(12, 660, 200));
}

console.log('\n[5] look is a delta, not a position');
{
  controls.endFrame();
  down(ev(20, 600, 250));
  move(ev(20, 640, 250));
  const first = controls.poll().lookX;
  if (!(first > 0)) fail('dragging right did not look right');
  controls.endFrame();
  // No further movement: the camera must stop, not keep turning.
  if (controls.poll().lookX !== 0) fail('the camera kept turning after the finger stopped');
  else ok('look is consumed each frame and stops when the finger does');
  up(ev(20, 640, 250));
}

console.log('\n[6] reeling, on the thumb already holding the line');
{
  controls.endFrame();
  down(ev(30, 800, 400, button('web')));
  move(ev(30, 800, 310));
  const a = controls.poll();
  if (!(a.reel > 0.9)) fail(`dragging up the swing button gave reel ${a.reel.toFixed(2)}`);
  else ok('dragging up reels in');
  move(ev(30, 800, 490));
  if (!(controls.poll().reel < -0.9)) fail('dragging down did not pay out');
  else ok('dragging down pays out');
  up(ev(30, 800, 490));
  if (controls.poll().reel !== 0) fail('reel stuck after release');
  else ok('reel clears on release');
}

console.log('\n[7] every button is reachable');
{
  const missing = [];
  for (const action of ['web', 'strike', 'dodge', 'zip', 'gadget', 'heal', 'ability', 'swap', 'finisher', 'skillMenu', 'settings']) {
    if (!button(action)) missing.push(action);
  }
  if (missing.length) fail(`no on-screen control for: ${missing.join(', ')}`);
  else ok('all eleven actions have a button');
}

console.log('');
console.log(fails === 0 ? 'TOUCH OK' : `${fails} PROBLEM(S) FOUND`);
process.exit(fails === 0 ? 0 : 1);
