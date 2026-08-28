/**
 * Can the Goblin be caught and killed?
 *
 * He could not be, and it was three of my own rules compounding. Each was
 * written as "the player is far away", and distance is symmetric in a way the
 * intent never was: a player who walks off deserves the consequence, a player
 * who cannot keep up deserves the opposite. Against the one villain who never
 * lands, never stops, and outruns a swing, the two were indistinguishable.
 *
 *   - Recovery fired past 300 m, so the chase healed him 5% a second.
 *   - Objectives progressed past 70 m, so the chase also paid him 25% a go
 *     and made him hit harder each time.
 *   - `engaged` tested a raw 120 m, so falling a little behind flipped him to
 *     "fly home" — at a speed a player on webs cannot match.
 *
 * This drives the real EnemySystem with a pursuer who is deliberately *worse*
 * than the Goblin: slower, always closing, never quite arriving. That is the
 * losing case. If his health still falls under it, a real player wins.
 */
import { bundle } from './_bundle.mjs';

const { EnemySystem, THREE, CONFIG } = await bundle(
  [
    ['{ EnemySystem }', 'src/enemies/EnemySystem'],
    ['{ CONFIG }', 'src/core/Config'],
    ['* as THREE', 'three'],
  ],
  'chase',
);

let fails = 0;
const fail = (m) => {
  console.log('  FAIL ' + m);
  fails++;
};
const ok = (m) => console.log('  ok — ' + m);

let roofSeed = 0;
const roof = () => {
  roofSeed++;
  const a = roofSeed * 2.399963;
  const r = 300 + ((roofSeed * 137) % 700);
  return {
    roof: new THREE.Vector3(Math.cos(a) * r, 45, Math.sin(a) * r),
    height: 45,
    width: 30,
    depth: 30,
  };
};
const city = {
  randomRoof: roof,
  roofNear: roof,
  groundHeightAt: () => 0,
  hasLineOfSight: () => true,
  escapeRoof: roof,
};

let seed = 24681357;
const rng = () => {
  seed = (seed * 1664525 + 1013904223) >>> 0;
  return seed / 4294967296;
};

function stubPlayer(pos) {
  return {
    pos,
    velocity: new THREE.Vector3(),
    hp: 100,
    grounded: false,
    invulnTimer: 0,
    takeDamage: () => false,
    addImpulse: () => {},
    damageTakenScale: 1,
  };
}

/**
 * Runs a pursuit and reports what happened to his health.
 *
 * The setup is the whole experiment and took three goes to get right.
 *
 * Version one started the pursuer twenty metres away and closed at 26 m/s, so
 * the gap never approached the three hundred metres the recovery rule needs.
 * Version two started them five hundred metres back — and the gap still
 * collapsed inside a second, because the Goblin was flying *toward* his home
 * roof and the stub had put that roof on the same side as the player. Both
 * passed with every part of the fix removed.
 *
 * So his home is placed explicitly, far away and directly away from the
 * player. He heads for it, the player follows at a speed a swing can actually
 * sustain, and the pursuit covers real ground — which is the situation being
 * tested and, until now, the one situation the test never produced.
 */
function pursue({ seconds, speed, hitEvery, damage = 40, homeAt = 1200, startGap = 380, startHp = 1 }) {
  const enemies = new EnemySystem(city, rng);
  const v = enemies.activateNext(new THREE.Vector3(0, 60, 0), rng, 'GREEN GOBLIN');
  if (!v) throw new Error('could not field the Goblin');
  v.pos.set(startGap, 60, 0);
  // Hurt him first. The previous version left him on full health and never
  // landed a hit, so `hp < maxHp` was false throughout and there was simply
  // nothing to recover — the check could not have failed however broken the
  // rule was.
  v.hp = v.maxHp * startHp;
  // Directly away from the player, so "go home" is genuinely flight.
  v.home = { roof: new THREE.Vector3(homeAt, 45, 0), height: 45, width: 30, depth: 30 };

  const player = stubPlayer(new THREE.Vector3(0, 55, 0));
  const step = 1 / 60;
  let since = 0;
  let objectives = 0;
  let regenFrames = 0;
  let closingFarFrames = 0;
  let previous = player.pos.distanceTo(v.pos);

  for (let i = 0; i < seconds * 60; i++) {
    const toward = v.pos.clone().sub(player.pos);
    const gap = toward.length();
    // Never occupies the same point: a player cannot stand inside a flier, and
    // letting the stub do it was what collapsed the gap to zero.
    if (gap > 18) player.pos.addScaledVector(toward.divideScalar(gap), speed * step);

    enemies.update(step, player);
    if (!v.alive) break;

    const distance = player.pos.distanceTo(v.pos);
    if (distance > CONFIG.enemies.regen.range && distance < previous) closingFarFrames++;
    previous = distance;

    if (v.regenerating) regenFrames++;
    objectives = v.objectivesDone;

    since += step;
    if (hitEvery > 0 && since >= hitEvery) {
      since = 0;
      enemies.damageTarget(v, damage, player.pos);
    }
  }

  return { v, objectives, regenFrames, closingFarFrames, maxHp: v.maxHp };
}

console.log('[1] a chase does not heal him');
{
  // Never lands a hit, just closes from a long way back for three minutes.
  const r = pursue({ seconds: 180, speed: 22, hitEvery: 0, startHp: 0.4 });

  // The check that makes the rest of it mean anything. If the run never spent
  // time beyond the recovery range while gaining, it never entered the failing
  // condition and a passing result says nothing at all — which is exactly what
  // the first version of this file did.
  if (r.closingFarFrames < 600) {
    fail(
      `only ${(r.closingFarFrames / 60).toFixed(1)}s spent beyond ` +
        `${CONFIG.enemies.regen.range} m while closing — this run tested nothing`,
    );
  } else {
    ok(`${(r.closingFarFrames / 60).toFixed(0)}s spent far behind him and gaining`);
  }

  if (r.regenFrames > 0) {
    fail(`he recovered on ${(r.regenFrames / 60).toFixed(1)}s of frames while being chased`);
  } else {
    ok('no recovery at all across the pursuit');
  }
  if (r.objectives > 0) fail(`he finished ${r.objectives} objective(s) while being chased`);
  else ok('no objectives finished while being chased');
}

console.log('\n[1b] a villain who has been met, and is now being chased');
{
  // [1] never gets within seventy metres, so `met` is never set and the
  // objective rule cannot run there at all — it passes for the wrong reason.
  //
  // Trying to reach this state by playing it out does not work either, and the
  // reason is the fix: once engaged he orbits the *player* at thirty-six
  // metres and never leaves contest range while being pursued. So the state is
  // built directly. That makes this a unit test of the rule rather than an
  // emergent one, which is the honest description of it.
  const enemies = new EnemySystem(city, rng);
  const v = enemies.activateNext(new THREE.Vector3(0, 60, 0), rng, 'GREEN GOBLIN');
  v.pos.set(400, 60, 0);
  v.hp = v.maxHp * 0.5;
  v.met = true;
  v.home = { roof: new THREE.Vector3(1400, 45, 0), height: 45, width: 30, depth: 30 };
  const player = stubPlayer(new THREE.Vector3(0, 55, 0));

  const before = v.objectivesDone;
  let far = 0;
  let regenFrames = 0;
  for (let i = 0; i < 60 * 150; i++) {
    const toward = v.pos.clone().sub(player.pos);
    const gap = toward.length();
    if (gap > 18) player.pos.addScaledVector(toward.divideScalar(gap), 21 / 60);
    enemies.update(1 / 60, player);
    if (v.pos.distanceTo(player.pos) > CONFIG.enemies.objectives.contestRadius) far++;
    if (v.regenerating) regenFrames++;
  }

  if (far < 600) fail(`only ${(far / 60).toFixed(1)}s spent out of contest range — nothing tested`);
  else ok(`${(far / 60).toFixed(0)}s out of contest range, already met`);

  const gained = v.objectivesDone - before;
  if (gained > 0) fail(`he finished ${gained} objective(s) while being chased`);
  else ok('finishes nothing while somebody is gaining on him');
  if (regenFrames > 0) fail(`he recovered on ${(regenFrames / 60).toFixed(1)}s of frames`);
  else ok('and recovers nothing');
}

console.log('\n[1c] falling a little behind is not an escape');
{
  // `engaged` used to test a raw 120 m, so drifting past it flipped him to
  // "fly home" — at a speed a player on webs cannot match, which is the half
  // the player described as running away. The arena's own hysteresis holds to
  // 190 m and he should hold with it.
  //
  // The player is parked at a hundred and fifty metres: past the old test,
  // inside the arena's. Chasing him would keep the gap closed and prove
  // nothing, so this one deliberately stands still.
  const enemies = new EnemySystem(city, rng);
  const v = enemies.activateNext(new THREE.Vector3(0, 60, 0), rng, 'GREEN GOBLIN');
  v.pos.set(30, 60, 0);
  v.home = { roof: new THREE.Vector3(2000, 45, 0), height: 45, width: 30, depth: 30 };
  const player = stubPlayer(new THREE.Vector3(0, 55, 0));

  // Engage properly first, nose to nose.
  for (let i = 0; i < 600; i++) {
    const toward = v.pos.clone().sub(player.pos);
    const gap = toward.length();
    if (gap > 18) player.pos.addScaledVector(toward.divideScalar(gap), 30 / 60);
    enemies.update(1 / 60, player);
  }
  if (!v.arenaActive) fail('never engaged, so this cannot test disengaging');

  // Drop back to 150 m and hold.
  player.pos.set(v.pos.x - 150, 55, v.pos.z);
  let worst = 0;
  for (let i = 0; i < 60 * 60; i++) {
    enemies.update(1 / 60, player);
    worst = Math.max(worst, v.pos.distanceTo(player.pos));
  }
  // Home is two kilometres away: if he decided to leave, this is enormous.
  if (worst > 400) fail(`he left for home, reaching ${worst.toFixed(0)} m while the player held at 150`);
  else ok(`held the fight at ${worst.toFixed(0)} m rather than leaving for a home 2 km away`);
}

console.log('\n[2] he can actually be killed');
{
  // A pursuer landing one ordinary hit every two seconds. Slow, but it should
  // converge — before the fix his health climbed faster than this took it off.
  const r = pursue({ seconds: 200, speed: 26, hitEvery: 2, damage: 45, homeAt: 300, startGap: 40 });
  if (r.v.alive) {
    const left = ((r.v.hp / r.maxHp) * 100).toFixed(0);
    fail(`still alive after 200s of sustained pressure, on ${left}% health`);
  } else {
    ok('down under sustained pressure');
  }
}

console.log('\n[3] walking away still costs you');
{
  // The rule this all exists for must survive the fix: a player who genuinely
  // leaves is a player the villain recovers from.
  const enemies = new EnemySystem(city, rng);
  const v = enemies.activateNext(new THREE.Vector3(0, 60, 0), rng, 'GREEN GOBLIN');
  v.pos.set(0, 60, 0);
  v.hp = v.maxHp * 0.4;
  const player = stubPlayer(new THREE.Vector3(0, 55, 0));

  const before = v.hp;
  // Straight out to well past the recovery range, then stand still.
  for (let i = 0; i < 60 * 90; i++) {
    if (i < 60 * 20) player.pos.x += 30 / 60;
    enemies.update(1 / 60, player);
  }
  if (v.hp <= before) fail('a villain the player abandoned never recovered');
  else ok(`recovered ${(((v.hp - before) / v.maxHp) * 100).toFixed(0)}% after the player left`);
}

console.log('\n[4] the numbers behind it');
{
  const cfg = CONFIG.enemies.objectives;
  if (!(cfg.chaseSpeed > 0)) fail('no closing-speed threshold — distance is symmetric again');
  if (!(cfg.chaseMemory >= 2)) fail(`chase memory is ${cfg.chaseMemory}s; a swing arc will flicker through it`);
  ok(`chase = closing faster than ${cfg.chaseSpeed} m/s, remembered for ${cfg.chaseMemory}s`);
}

console.log('');
console.log(fails === 0 ? 'CHASE OK' : `${fails} PROBLEM(S) FOUND`);
process.exit(fails === 0 ? 0 : 1);
