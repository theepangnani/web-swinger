/**
 * Numeric checks on the pure-maths half of this round's changes. The static
 * suite proves the code resolves; this proves it produces sane numbers.
 */
import { bundle } from './_bundle.mjs';

const { CONFIG, DayNight, TIME_OF_DAY, THREE } = await bundle(
  [
    ['{ CONFIG }', 'src/core/Config'],
    ['{ DayNight, TIME_OF_DAY }', 'src/world/DayNight'],
    ['* as THREE', 'three'],
  ],
  'num',
);

let fails = 0;
const fail = (m) => {
  console.log('  FAIL ' + m);
  fails++;
};

// --- 1. sun/moon direction is continuous all the way round the clock -------
console.log('[1] day/night light path');
function sunOffset(time) {
  const angle = (time - 0.25) * Math.PI * 2;
  const elevation = Math.sin(angle);
  const east = Math.cos(angle);
  const x = east * 0.75;
  const y = Math.max(0.22, elevation);
  const z = -0.35;
  const len = Math.hypot(x, y, z);
  return [x / len, y / len, z / len];
}
let worst = 0;
let worstAt = 0;
const step = 1 / 4000;
for (let t = 0; t < 1; t += step) {
  const a = sunOffset(t);
  const b = sunOffset(t + step);
  const d = Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
  if (d > worst) {
    worst = d;
    worstAt = t;
  }
}
// One 4000th of a cycle should move the light a tiny fraction of a unit. The
// old mirrored version jumped ~1.5 at each horizon crossing.
console.log(`  largest single-step move: ${worst.toFixed(5)} at t=${worstAt.toFixed(3)}`);
if (worst > 0.01) fail('sun direction is discontinuous — the horizon snap is back');

// --- 2. the partner's follow point is genuinely behind the player ----------
console.log('[2] ally follow point');
const ally = CONFIG.ally;
let minBehind = Infinity;
for (let i = 0; i < 720; i++) {
  const heading = (i / 720) * Math.PI * 2;
  for (const bob of [0, 1.1, 2.2, 3.3, 4.4]) {
    const lateral = Math.sin(bob * 0.7) * ally.followDistance * 0.35;
    const forward = -ally.followDistance;
    const gx = Math.sin(heading) * forward + Math.cos(heading) * lateral;
    const gz = Math.cos(heading) * forward - Math.sin(heading) * lateral;
    // Project onto the player's forward axis: negative means behind.
    const along = gx * Math.sin(heading) + gz * Math.cos(heading);
    minBehind = Math.min(minBehind, -along);
  }
}
console.log(`  always at least ${minBehind.toFixed(2)} m behind the player`);
if (minBehind < 5) fail('follow point can drift alongside or in front');

// --- 3. Sandman's weak point sits where his head is -----------------------
console.log('[3] sandman weak point');
const sm = CONFIG.enemies.sandman;
const modelHeadY = sm.headHeight;
const modelTop = 3.5; // top of the built mesh, in model units
if (modelHeadY > modelTop) fail('head band is above the model');
if (modelHeadY < modelTop * 0.7) fail('head band is too low to be the head');
const worldHead = modelHeadY * sm.baseScale;
const bandLow = worldHead - sm.headRadius * sm.baseScale;
const bandHigh = worldHead + sm.headRadius * sm.baseScale;
console.log(
  `  head at ${worldHead.toFixed(1)} m above his feet, band ${bandLow.toFixed(1)}–${bandHigh.toFixed(1)} m`,
);
if (bandLow < 4) fail('band reaches low enough to hit from the ground — the weak point is free');

const bodyHits = Math.ceil(sm.hp / (CONFIG.combat.meleeDamage * sm.bodyDamageScale));
const headHits = Math.ceil(sm.hp / (CONFIG.combat.meleeDamage * sm.headDamageScale));
console.log(`  ${headHits} head hits vs ${bodyHits} body hits at base melee damage`);
if (headHits > 60) fail('head route is too long even done right');
if (bodyHits < headHits * 3) fail('body route is not enough of a penalty to teach the mechanic');

// --- 4. arena geometry still permits disengaging --------------------------
console.log('[4] arena bounds');
const arena = CONFIG.enemies.arena;
const maxSeparation = arena.radius + arena.playerRadius;
console.log(
  `  villain ${arena.radius} m + player ${arena.playerRadius} m = ${maxSeparation} m, disengage at ${arena.disengageDistance} m`,
);
if (maxSeparation <= arena.disengageDistance) {
  fail('the player can never get far enough to end a fight — soft lock');
}
if (arena.flierRadius <= arena.radius) fail('flier arena is not wider than the ground one');

// --- 5. web release is actually a jump -----------------------------------
console.log('[5] web release');
const move = CONFIG.move;
const slow = move.releaseBoost;
const fast = move.releaseBoost + move.releaseBoostMax;
console.log(`  release gives ${slow}–${fast} m/s against a ${move.jumpSpeed} m/s jump`);
if (slow < move.jumpSpeed * 0.4) fail('a slow release still reads as a drop');
if (fast > CONFIG.traversal.chargeJumpSpeed) fail('release out-jumps the charged jump');

// --- 6. imported buildings end up swingable ------------------------------
console.log('[6] osm height scaling');
const osm = CONFIG.city.osm;
const floorLow = osm.minHeight * (1 - osm.minHeightJitter);
console.log(
  `  a 6 m house becomes ${Math.max(floorLow, 6 * osm.heightScale).toFixed(1)}–` +
    `${Math.max(osm.minHeight * (1 + osm.minHeightJitter), 6 * osm.heightScale).toFixed(1)} m`,
);
if (floorLow < CONFIG.web.minLength) fail('the shortest building is below the minimum web length');
if (osm.maxHeight > CONFIG.web.maxLength * 2.5) fail('tallest building dwarfs the web reach');

// --- 7. the clock actually keeps running ---------------------------------
// Every story chapter names a time, so a pin that never released meant the
// cycle ran exactly once and then froze for the rest of the game. Drive the
// real DayNight and check the clock is still moving long after it arrived.
console.log('[7] day/night keeps running');
function rig() {
  const scene = new THREE.Scene();
  scene.background = new THREE.Color();
  scene.fog = new THREE.FogExp2(0, 0.001);
  const sun = new THREE.DirectionalLight();
  const hemi = new THREE.HemisphereLight();
  // Only toneMappingExposure is touched, so a bare object stands in for the
  // renderer rather than needing a GL context.
  return new DayNight(scene, { toneMappingExposure: 1 }, sun, hemi);
}
const DT = 1 / 60;
{
  const dn = rig();
  dn.setTime(TIME_OF_DAY.DAY);
  dn.pin('NIGHT');

  // Arrival: the ease must terminate rather than approaching forever.
  let arrivedAt = -1;
  for (let f = 0; f < 60 * 120; f++) {
    dn.update(DT, new THREE.Vector3());
    if (arrivedAt < 0 && Math.abs(shortest(dn.time - TIME_OF_DAY.NIGHT)) < 0.006) arrivedAt = f * DT;
    if (arrivedAt >= 0) break;
  }
  if (arrivedAt < 0) fail('pinning to NIGHT never reached night');
  console.log(`  DAY -> NIGHT pin arrived in ${arrivedAt.toFixed(1)} s`);

  const held = dn.time;
  const seconds = 60;
  for (let f = 0; f < 60 * seconds; f++) dn.update(DT, new THREE.Vector3());
  const moved = Math.abs(shortest(dn.time - held));
  const expected = seconds / CONFIG.dayNight.cycleSeconds;
  console.log(
    `  ${seconds} s after arrival the clock moved ${(moved * 24).toFixed(2)} h ` +
      `(expected ${(expected * 24).toFixed(2)} h)`,
  );
  if (moved < expected * 0.9) fail('the clock is frozen after a chapter pin — the cycle runs once');
}
// --- 8. every hour of the day is bright enough to fight in ----------------
// The complaint that started this: the enemies were not visible at night.
// Walk the keyframe table hour by hour and check the floor, while making sure
// the lift has not flattened the whole day into one look.
console.log('[8] brightness floor across the day');
{
  const scene = new THREE.Scene();
  scene.background = new THREE.Color();
  scene.fog = new THREE.FogExp2(0, 0.001);
  const sun = new THREE.DirectionalLight();
  const hemi = new THREE.HemisphereLight();
  // Only toneMappingExposure is written, so a bare object stands in for the
  // renderer rather than needing a GL context.
  const renderer = { toneMappingExposure: 1 };
  const dn = new DayNight(scene, renderer, sun, hemi);

  let lo = Infinity;
  let hi = -Infinity;
  let darkestKey = 0;
  let dimmest = Infinity;
  for (let i = 0; i <= 240; i++) {
    const t = i / 240;
    dn.setTime(t);
    dn.update(0, new THREE.Vector3());
    if (renderer.toneMappingExposure < lo) {
      lo = renderer.toneMappingExposure;
      darkestKey = t;
    }
    hi = Math.max(hi, renderer.toneMappingExposure);
    // Key + fill together are what actually lands on an enemy's face.
    dimmest = Math.min(dimmest, sun.intensity + hemi.intensity);
  }
  console.log(
    `  exposure ${lo.toFixed(2)}–${hi.toFixed(2)} (darkest at ${(darkestKey * 24).toFixed(1)}h), ` +
      `dimmest key+fill ${dimmest.toFixed(2)}`,
  );
  if (lo < 1.3) fail('night is still below the readable exposure floor');
  if (dimmest < 2) fail('there is an hour with almost no light on the enemies');
  if (hi - lo < 0.05) fail('the whole day renders at one brightness — the cycle is invisible');
  if (hi - lo > 0.4) fail('the day/night swing is wide enough to blow out noon');

  // The slider has to be able to rescue a dim monitor from the bottom of that.
  const trimmed = lo * 1.6;
  if (trimmed < hi) fail('max brightness cannot lift night to the brightness of an untrimmed day');
}

function shortest(d) {
  let x = d % 1;
  if (x > 0.5) x -= 1;
  if (x < -0.5) x += 1;
  return x;
}

console.log(fails === 0 ? '\nNUMERIC CHECKS OK' : `\n${fails} PROBLEM(S)`);
process.exit(fails === 0 ? 0 : 1);
