/**
 * Verifies VillainBuilder's joint maths.
 *
 * Limb geometry is authored in body space and pulled back by the pivot at
 * commit time. If that subtraction is wrong the arms end up detached, doubled
 * or inside the chest — and none of that is visible from a typecheck, so it is
 * checked here: build a body, and assert every vertex is exactly where it was
 * authored while the joints are at rest.
 */
import { bundle } from './_bundle.mjs';

const { VillainBuilder, THREE } = await bundle(
  [
    ['{ VillainBuilder }', 'src/enemies/VillainParts'],
    ['* as THREE', 'three'],
  ],
  'joints',
);

let fails = 0;
const fail = (m) => {
  console.log('  FAIL ' + m);
  fails++;
};

/** Centroid of a mesh's vertices, in world space. */
function centroid(mesh) {
  const pos = mesh.geometry.getAttribute('position');
  const v = new THREE.Vector3();
  const sum = new THREE.Vector3();
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i);
    mesh.localToWorld(v);
    sum.add(v);
  }
  return sum.divideScalar(pos.count);
}

const root = new THREE.Group();
const sink = [];
// One material per part, so each becomes its own merged mesh and can be told
// apart. Sharing a material would correctly merge the torso and the leg into
// a single mesh, which is right but untestable.
const torsoMat = new THREE.MeshBasicMaterial();
const armMat = new THREE.MeshBasicMaterial();
const foreMat = new THREE.MeshBasicMaterial();
const legMat = new THREE.MeshBasicMaterial();
const b = new VillainBuilder(root, sink);

// Body-fixed torso at y = 2.
b.sphere(torsoMat, 0.5, { y: 2 });
// A shoulder at (1, 2.4) holding a ball authored at (1.2, 2.0).
b.limb('shoulderL', { x: 1, y: 2.4 });
b.sphere(armMat, 0.2, { x: 1.2, y: 2.0 });
// An elbow hanging off it at (1.3, 1.5), holding a ball at (1.4, 1.1).
b.limb('elbowL', { x: 1.3, y: 1.5 }, 'shoulderL');
b.sphere(foreMat, 0.15, { x: 1.4, y: 1.1 });
b.endLimb();
// Body-fixed again: the leg must not end up parented to the elbow.
b.sphere(legMat, 0.3, { x: 0.4, y: 0.5 });

const joints = b.commit();
root.updateMatrixWorld(true);

console.log('[1] joints exist and are parented correctly');
const shoulder = joints.get('shoulderL');
const elbow = joints.get('elbowL');
if (!shoulder) fail('shoulderL missing');
if (!elbow) fail('elbowL missing');
if (elbow && elbow.parent !== shoulder) fail('elbowL is not a child of shoulderL');
if (shoulder && shoulder.parent !== root) fail('shoulderL is not a child of the body');
console.log(`  shoulder local ${fmt(shoulder.position)}, elbow local ${fmt(elbow.position)}`);
// The elbow's local offset must be its authored origin minus the shoulder's.
if (!near(elbow.position, { x: 0.3, y: -0.9, z: 0 })) {
  fail('elbow local offset is not (origin - parent origin)');
}

console.log('[2] geometry lands where it was authored');
const expected = [
  { name: 'torso', at: { x: 0, y: 2, z: 0 } },
  { name: 'upper arm', at: { x: 1.2, y: 2.0, z: 0 } },
  { name: 'forearm', at: { x: 1.4, y: 1.1, z: 0 } },
  { name: 'leg', at: { x: 0.4, y: 0.5, z: 0 } },
];
const meshes = [];
root.traverse((o) => {
  if (o.isMesh) meshes.push(o);
});
console.log(`  ${meshes.length} merged meshes`);
if (meshes.length !== 4) fail(`expected 4 merged meshes (body + 2 limbs + body again), got ${meshes.length}`);

for (const want of expected) {
  const hit = meshes.find((m) => near(centroid(m), want.at, 0.02));
  if (!hit) fail(`nothing sits at ${want.name} ${fmt(want.at)}`);
}

console.log('[3] rotating a joint moves only what hangs off it');
const legMesh = meshes.find((m) => m.material === legMat);
const armMesh = meshes.find((m) => m.material === armMat);
if (!legMesh || !armMesh) fail('could not identify the leg and arm meshes');
// The leg must be body-fixed, not swept into the last open limb.
if (legMesh.parent !== root) fail('the leg was parented to a limb — endLimb() did not close it');
const legBefore = centroid(legMesh);
shoulder.rotation.x = 1.0;
root.updateMatrixWorld(true);

// The shoulder pivot itself must not move.
const pivot = new THREE.Vector3();
shoulder.getWorldPosition(pivot);
if (!near(pivot, { x: 1, y: 2.4, z: 0 })) fail('the shoulder pivot moved when it rotated');
console.log(`  pivot held at ${fmt(pivot)}`);

// Everything under it must swing; the leg must not.
if (!near(centroid(legMesh), legBefore, 1e-6)) {
  fail('the body-fixed leg moved when the shoulder rotated');
}
if (near(centroid(armMesh), { x: 1.2, y: 2.0, z: 0 }, 0.02)) {
  fail('the upper arm did not move with its shoulder');
}

const elbowWorld = new THREE.Vector3();
elbow.getWorldPosition(elbowWorld);
const swung = elbowWorld.distanceTo(new THREE.Vector3(1.3, 1.5, 0));
console.log(`  elbow travelled ${swung.toFixed(3)} m on a 1 rad shoulder rotation`);
if (swung < 0.3) fail('the elbow barely moved — it is not hanging off the shoulder');

console.log(fails === 0 ? '\nJOINT MATHS OK' : `\n${fails} PROBLEM(S)`);
process.exit(fails === 0 ? 0 : 1);

function near(a, b, tol = 1e-6) {
  return Math.abs(a.x - b.x) < tol && Math.abs(a.y - b.y) < tol && Math.abs(a.z - b.z) < tol;
}
function fmt(v) {
  return `(${v.x.toFixed(2)}, ${v.y.toFixed(2)}, ${v.z.toFixed(2)})`;
}
