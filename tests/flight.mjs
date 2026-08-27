/**
 * The two villains who fly, and whether they stay out of the buildings.
 *
 * The Goblin's altitude is steered by damping toward a target that already
 * accounts for the rooftops below him, which sounds like it should be enough
 * and is not: damping is a preference, not a rule. His orbit carries him
 * horizontally faster than he climbs, so crossing a tall tower took less time
 * than getting over it — he rose up through the roof, crossed inside the
 * building, and sank back down through it on the way out. From the street that
 * reads as phasing in and out of the geometry.
 *
 * This drives the real EnemySystem over a stub city with one very tall tower
 * in the middle of his orbit and checks every frame, because the failure only
 * exists for the second or two he is over it — a check at the end of the run
 * would find him comfortably in open air and report success.
 */
import { bundle } from './_bundle.mjs';

const { EnemySystem, THREE, CONFIG } = await bundle(
  [
    ['{ EnemySystem }', 'src/enemies/EnemySystem'],
    ['{ CONFIG }', 'src/core/Config'],
    ['* as THREE', 'three'],
  ],
  'flight',
);

let fails = 0;
const fail = (m) => {
  console.log('  FAIL ' + m);
  fails++;
};
const ok = (m) => console.log('  ok — ' + m);

/**
 * A city that is flat except for one tower, sat right where the orbit crosses.
 *
 * A flat city cannot fail this test: with the ground at zero everywhere, any
 * altitude at all clears it. The tower is the whole experiment — and where it
 * is matters as much as that it exists. The first version of this file put the
 * tower directly under the player, which is the one place the Goblin never
 * goes: he orbits at a fixed radius *around* the player, so a tower narrower
 * than that radius sits inside the ring and is circled, never crossed. The
 * test passed with the fix removed, which is the only reason it was caught.
 *
 * It now sits exactly one orbit radius from the player, so the ring runs
 * straight over the top of it, and is narrow enough that crossing it is the
 * brief transit the bug needs.
 */
const TOWER = { x: 36, z: 0, radius: 16, height: 210 };
function groundHeightAt(x, z) {
  return Math.hypot(x - TOWER.x, z - TOWER.z) < TOWER.radius ? TOWER.height : 0;
}

let roofSeed = 0;
function roof() {
  roofSeed++;
  const a = roofSeed * 2.399963;
  const r = 260 + ((roofSeed * 137) % 700);
  return {
    roof: new THREE.Vector3(Math.cos(a) * r, 40, Math.sin(a) * r),
    height: 40,
    width: 30,
    depth: 30,
  };
}
const city = {
  randomRoof: roof,
  roofNear: roof,
  groundHeightAt,
  hasLineOfSight: () => true,
  escapeRoof: roof,
};

let seed = 987654321;
const rng = () => {
  seed = (seed * 1664525 + 1013904223) >>> 0;
  return seed / 4294967296;
};

/** The least a player needs from a physics body: a position it can be chased to. */
function stubPlayer(pos) {
  return {
    pos,
    velocity: new THREE.Vector3(),
    hp: 100,
    grounded: true,
    invulnTimer: 0,
    takeDamage: () => false,
    addImpulse: () => {},
    damageTakenScale: 1,
  };
}

console.log('[1] a flier never ends up inside a building');
{
  const enemies = new EnemySystem(city, rng);
  // Standing one orbit radius from the tower, so the Goblin's ring crosses it.
  const player = stubPlayer(new THREE.Vector3(0, 30, 0));

  // Put them in play and then move them next to the player, because `engaged`
  // is a distance test: unengaged, the Goblin orbits his *home roof* — a
  // random point hundreds of metres away in this stub — and the tower is never
  // involved in the run at all. That is what the first two versions of this
  // file were quietly measuring.
  for (const kind of ['GREEN GOBLIN', 'ELECTRO']) {
    const v = enemies.activateNext(new THREE.Vector3(0, 40, 0), rng, kind);
    if (v) {
      v.pos.set(20, 50, 0);
      v.home = { roof: new THREE.Vector3(0, 0, 0), height: 0, width: 30, depth: 30 };
    }
  }

  const worst = new Map();
  let overTower = 0;
  let frames = 0;

  // Two minutes at 60 Hz. The orbit period is a few seconds, so this crosses
  // the tower many times over.
  for (let i = 0; i < 7200; i++) {
    enemies.update(1 / 60, player);
    frames++;
    for (const v of enemies.villains) {
      if (!v.alive || v.dormant) continue;
      if (v.kind !== 'GREEN GOBLIN' && v.kind !== 'ELECTRO') continue;
      // Depth below the surface underneath them. Positive means inside.
      const surface = groundHeightAt(v.pos.x, v.pos.z);
      if (surface > 0) overTower++;
      const inside = surface - v.pos.y;
      const previous = worst.get(v.kind) ?? -Infinity;
      if (inside > previous) worst.set(v.kind, inside);
    }
  }

  for (const [kind, depth] of worst) {
    if (depth > 0) {
      fail(`${kind} was ${depth.toFixed(1)} m inside the tower at its worst`);
    } else {
      ok(`${kind} stayed ${(-depth).toFixed(1)} m clear of the roof at its closest`);
    }
  }
  if (worst.size === 0) fail('neither flier was ever in play — the test proved nothing');
  // The check that makes the rest of it mean anything. A flier that never
  // passes over the tower trivially never enters it, and the first two
  // versions of this file reported a confident pass on exactly that.
  if (overTower === 0) {
    fail('no flier ever crossed the tower — this run tested nothing');
  } else {
    ok(`${overTower} frames were spent directly over the tower`);
  }
  console.log(`  ${frames} frames simulated over a ${TOWER.height} m tower`);
}

console.log('\n[2] the clamp is a floor, not a ceiling');
{
  // The first version of this check put the Goblin 120 m above his hover
  // height and asserted he did not descend — which he immediately did, because
  // that is his altitude damp doing exactly its job, and the check was testing
  // the wrong thing. The real claim is that the clamp only ever raises: the
  // fliers must still range freely above the rooftops rather than being
  // pinned to them.
  const enemies = new EnemySystem(city, rng);
  enemies.activateNext(new THREE.Vector3(TOWER.x, TOWER.height + 20, TOWER.z), rng, 'GREEN GOBLIN');
  const player = stubPlayer(new THREE.Vector3(0, 30, 0));

  let lowest = Infinity;
  let highest = -Infinity;
  for (let i = 0; i < 3600; i++) {
    enemies.update(1 / 60, player);
    for (const v of enemies.villains) {
      if (v.kind !== 'GREEN GOBLIN' || !v.alive || v.dormant) continue;
      const clear = v.pos.y - groundHeightAt(v.pos.x, v.pos.z);
      if (clear < lowest) lowest = clear;
      if (clear > highest) highest = clear;
    }
  }

  const floor = CONFIG.enemies.goblin.minClearance;
  if (lowest < floor - 0.5) {
    fail(`dropped to ${lowest.toFixed(1)} m, under the ${floor} m floor`);
  } else if (highest < floor * 2) {
    fail(`never rose above ${highest.toFixed(1)} m — the clamp is pinning him to the floor`);
  } else {
    ok(`ranged ${lowest.toFixed(1)}-${highest.toFixed(1)} m above the surface, floor is ${floor} m`);
  }
}

console.log('\n[3] the numbers behind it');
{
  const g = CONFIG.enemies.goblin;
  if (!(g.lookAhead > 0)) fail('the Goblin no longer looks ahead — he will react to towers he is inside');
  if (!(g.climbRate >= 3)) fail(`climb rate is ${g.climbRate}; he cannot outrun his own orbit`);
  if (!(g.minClearance > 0)) fail('no clearance over rooftops');
  ok(`look-ahead ${g.lookAhead}s, climb ${g.climbRate}, clearance ${g.minClearance} m`);
}

console.log('');
console.log(fails === 0 ? 'FLIGHT OK' : `${fails} PROBLEM(S) FOUND`);
process.exit(fails === 0 ? 0 : 1);
