#!/usr/bin/env node
/**
 * validate-gltf.mjs — Phase 1 task V2.
 *
 * Checks `assets/sesame.glb` against the data it claims to be built from,
 * rather than against itself.  Five layers:
 *
 *   1. STRUCTURE   the required node names exist, are unique, and the scene
 *                  has exactly one root.
 *   2. RIG         all eight joints are present, agree with JOINT_ORDER, are
 *                  parented per hardware/joint-map.json, carry the signed
 *                  rotation rule, and rest at the identity rotation.
 *   3. GEOMETRY    drive the rig to runStandPose and compare the result with
 *                  V0's own numbers: per-vertex against poseFromStlMm applied
 *                  to the raw STL, and against the recorded placed bounding
 *                  boxes, the ground plane and foot verticality.
 *   4. PROVENANCE  every source the GLB names is re-hashed off disk, and the
 *                  top-cover substitution is declared rather than silent.
 *   5. OLED        the screen node's plane, UV set and orientation match the
 *                  convention it documents.
 *
 * The per-vertex stand-pose residual in layer 3 is the honest end-to-end
 * number: it goes through the GLB's float32 storage and its quaternions, and
 * its reference is the STL on disk transformed by V0's matrix — no part of
 * that path is shared with how the GLB was built.
 *
 * Run:  node scripts/validate-gltf.mjs [path/to/sesame.glb]
 * No dependencies beyond the Node standard library.
 */

import { createHash } from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const GLB = resolve(process.argv[2] ?? join(REPO, 'assets', 'sesame.glb'));

const failures = [];
const notes = [];
let checks = 0;

function ok(cond, label, detail = '') {
  checks += 1;
  if (!cond) failures.push(detail ? `${label} — ${detail}` : label);
  return cond;
}
function near(actual, expected, tol, label) {
  return ok(Math.abs(actual - expected) <= tol, label,
    `got ${actual}, expected ${expected} ± ${tol}`);
}

// ---------------------------------------------------------------------------
// tiny linear algebra (column-major-free; plain row-major 4x4 as flat arrays)
// ---------------------------------------------------------------------------

const I4 = () => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

function mul(A, B) {
  const C = new Array(16).fill(0);
  for (let i = 0; i < 4; i++)
    for (let j = 0; j < 4; j++) {
      let s = 0;
      for (let k = 0; k < 4; k++) s += A[i * 4 + k] * B[k * 4 + j];
      C[i * 4 + j] = s;
    }
  return C;
}
function xform(M, p) {
  return [
    M[0] * p[0] + M[1] * p[1] + M[2] * p[2] + M[3],
    M[4] * p[0] + M[5] * p[1] + M[6] * p[2] + M[7],
    M[8] * p[0] + M[9] * p[1] + M[10] * p[2] + M[11],
  ];
}
function fromQuat(q) {
  const [x, y, z, w] = q;
  return [
    1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w), 0,
    2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w), 0,
    2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y), 0,
    0, 0, 0, 1,
  ];
}
function fromTranslation(t) {
  const M = I4();
  M[3] = t[0]; M[7] = t[1]; M[11] = t[2];
  return M;
}
function axisAngle(axis, deg) {
  const n = Math.hypot(...axis);
  const [x, y, z] = axis.map((v) => v / n);
  const rad = (deg * Math.PI) / 180;
  const c = Math.cos(rad), s = Math.sin(rad), t = 1 - c;
  return [
    t * x * x + c, t * x * y - s * z, t * x * z + s * y, 0,
    t * x * y + s * z, t * y * y + c, t * y * z - s * x, 0,
    t * x * z - s * y, t * y * z + s * x, t * z * z + c, 0,
    0, 0, 0, 1,
  ];
}

// ---------------------------------------------------------------------------
// GLB / glTF reading
// ---------------------------------------------------------------------------

function readGlb(path) {
  const buf = readFileSync(path);
  ok(buf.readUInt32LE(0) === 0x46546c67, 'GLB magic');
  ok(buf.readUInt32LE(4) === 2, 'GLB version 2');
  ok(buf.readUInt32LE(8) === buf.length, 'GLB declared length matches the file');
  let off = 12;
  let json = null;
  let bin = null;
  while (off < buf.length) {
    const len = buf.readUInt32LE(off);
    const type = buf.readUInt32LE(off + 4);
    const body = buf.subarray(off + 8, off + 8 + len);
    if (type === 0x4e4f534a) json = JSON.parse(body.toString('utf8'));
    else if (type === 0x004e4942) bin = body;
    off += 8 + len;
  }
  ok(json !== null, 'GLB has a JSON chunk');
  ok(bin !== null, 'GLB has a BIN chunk');
  return { json, bin, bytes: buf.length, sha: createHash('sha256').update(buf).digest('hex') };
}

const COMP = { 5120: [Int8Array, 1], 5121: [Uint8Array, 1], 5122: [Int16Array, 2], 5123: [Uint16Array, 2], 5125: [Uint32Array, 4], 5126: [Float32Array, 4] };
const NCOMP = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 };

function accessor(g, bin, idx) {
  const a = g.accessors[idx];
  const bv = g.bufferViews[a.bufferView];
  const [Type, size] = COMP[a.componentType];
  const n = NCOMP[a.type];
  const start = (bv.byteOffset ?? 0) + (a.byteOffset ?? 0);
  ok(bv.byteStride === undefined, 'accessors are tightly packed');
  const src = bin.buffer.slice(bin.byteOffset + start, bin.byteOffset + start + a.count * n * size);
  return { data: new Type(src), n, count: a.count };
}

// ---------------------------------------------------------------------------
// Binary STL — the independent geometric reference
// ---------------------------------------------------------------------------

function readStlVertices(path) {
  const b = readFileSync(path);
  const n = b.readUInt32LE(80);
  const out = new Float64Array(n * 9);
  for (let i = 0; i < n; i++) {
    const base = 84 + i * 50 + 12;
    for (let k = 0; k < 9; k++) out[i * 9 + k] = b.readFloatLE(base + k * 4);
  }
  return { xyz: out, triangles: n };
}

/** Distinct positions (exact float equality), as an array of triples. */
function distinct(flatXyz) {
  const seen = new Set();
  const out = [];
  for (let i = 0; i < flatXyz.length; i += 3) {
    const k = `${flatXyz[i]},${flatXyz[i + 1]},${flatXyz[i + 2]}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push([flatXyz[i], flatXyz[i + 1], flatXyz[i + 2]]);
  }
  return out;
}

/**
 * Max distance from each point of `a` to the nearest point of `b`, via a
 * uniform hash grid.  Lexicographic pairing is not safe here: the deviations
 * being measured are ~1e-5 mm while these meshes are full of exactly-tied
 * coordinates, so a tie broken the other way would pair a point with a
 * different corner of the same part.  Returns null if any point of `a` has no
 * neighbour within `cell`.
 */
function maxNearestDistance(a, b, cell) {
  const grid = new Map();
  const key = (p) => `${Math.floor(p[0] / cell)},${Math.floor(p[1] / cell)},${Math.floor(p[2] / cell)}`;
  for (const p of b) {
    const k = key(p);
    const bucket = grid.get(k);
    if (bucket) bucket.push(p); else grid.set(k, [p]);
  }
  let worst = 0;
  for (const p of a) {
    const [ix, iy, iz] = [Math.floor(p[0] / cell), Math.floor(p[1] / cell), Math.floor(p[2] / cell)];
    let best = Infinity;
    for (let dx = -1; dx <= 1; dx++)
      for (let dy = -1; dy <= 1; dy++)
        for (let dz = -1; dz <= 1; dz++)
          for (const q of grid.get(`${ix + dx},${iy + dy},${iz + dz}`) ?? [])
            best = Math.min(best, Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]));
    if (!Number.isFinite(best)) return null;
    worst = Math.max(worst, best);
  }
  return worst;
}

// ===========================================================================

if (!existsSync(GLB)) {
  console.error(`FAIL  ${GLB} does not exist. Build it first:\n` +
    '      tools/py-assets/.venv/Scripts/python.exe scripts/build-gltf.py');
  process.exit(1);
}

const { json: g, bin, bytes, sha } = readGlb(GLB);
const amap = JSON.parse(readFileSync(join(REPO, 'hardware/assembly-map.json'), 'utf8'));
const jmap = JSON.parse(readFileSync(join(REPO, 'hardware/joint-map.json'), 'utf8'));

const parts = Object.fromEntries(amap.parts.map((p) => [p.id, p]));
const ajoints = Object.fromEntries(amap.joints.map((j) => [j.firmwareJointName, j]));
const standCmd = amap.referencePose.commandedDeg;

// JOINT_ORDER, taken from the package that owns it if it is readable, and from
// the joint map otherwise.  Both must agree.
const JOINT_ORDER_FROM_MAP = [...jmap.joints]
  .sort((a, b) => a.firmwareIndex - b.firmwareIndex)
  .map((j) => j.firmwareName);
let JOINT_ORDER = JOINT_ORDER_FROM_MAP;
const joinsSrc = join(REPO, 'packages/sesame-model/src/joints.ts');
if (existsSync(joinsSrc)) {
  const m = readFileSync(joinsSrc, 'utf8').match(/JOINT_ORDER\s*=\s*\[([^\]]*)\]/);
  if (m) {
    const fromPkg = m[1].split(',').map((s) => s.trim().replace(/['"]/g, '')).filter(Boolean);
    ok(fromPkg.join(',') === JOINT_ORDER_FROM_MAP.join(','),
      'JOINT_ORDER in @sesame-lab/sesame-model matches hardware/joint-map.json',
      `${fromPkg} vs ${JOINT_ORDER_FROM_MAP}`);
    JOINT_ORDER = fromPkg;
  }
}

// ---------------------------------------------------------------------------
// LAYER 1 — structure
// ---------------------------------------------------------------------------

const nodes = g.nodes ?? [];
const byName = new Map();
nodes.forEach((n, i) => {
  ok(typeof n.name === 'string' && n.name.length > 0, `node ${i} is named`);
  ok(!byName.has(n.name), `node name '${n.name}' is unique`);
  byName.set(n.name, i);
});

const REQUIRED = [...JOINT_ORDER, 'sesame_body', 'oled_screen'];
for (const name of REQUIRED) ok(byName.has(name), `required node '${name}' exists`);

ok(g.scenes?.length === 1 && g.scene === 0, 'exactly one scene, and it is the default');
ok(g.scenes?.[0]?.nodes?.length === 1, 'the scene has a single root node');
ok(nodes[g.scenes[0].nodes[0]]?.name === 'sesame_body', "the scene root is 'sesame_body'");

const parentOf = new Map();
nodes.forEach((n, i) => (n.children ?? []).forEach((c) => {
  ok(!parentOf.has(c), `node ${c} has one parent`);
  parentOf.set(c, i);
}));

// ---------------------------------------------------------------------------
// LAYER 2 — the rig
// ---------------------------------------------------------------------------

ok(JOINT_ORDER.length === 8, 'JOINT_ORDER has eight entries');
const seenIndex = new Set();
for (const name of JOINT_ORDER) {
  const n = nodes[byName.get(name)];
  if (!n) continue;
  const e = n.extras ?? {};
  ok(e.firmwareName === name, `${name}: extras.firmwareName`);
  ok(JOINT_ORDER[e.firmwareIndex] === name,
    `${name}: extras.firmwareIndex ${e.firmwareIndex} is its JOINT_ORDER slot`);
  seenIndex.add(e.firmwareIndex);

  const aj = ajoints[name];
  const expectedParent = aj.parentPart === 'internal-frame' ? 'sesame_body' : aj.parentPart;
  ok(nodes[parentOf.get(byName.get(name))]?.name === expectedParent,
    `${name}: parented to '${expectedParent}'`,
    `actually '${nodes[parentOf.get(byName.get(name))]?.name}'`);

  ok(n.rotation === undefined
    || (Math.abs(n.rotation[0]) + Math.abs(n.rotation[1]) + Math.abs(n.rotation[2]) < 1e-12
      && Math.abs(Math.abs(n.rotation[3]) - 1) < 1e-12),
    `${name}: rest rotation is the identity (commandedDeg 90)`);

  const sign = aj.rotationSense.rule.startsWith('childRotationDeg = -1 *') ? -1 : 1;
  ok(e.signPerCommandedDeg === sign,
    `${name}: signPerCommandedDeg ${e.signPerCommandedDeg} matches assembly-map's rule`);
  ok(e.neutralCommandedDeg === 90, `${name}: neutralCommandedDeg is 90`);
  near(Math.hypot(...e.rotationAxis), 1, 1e-9, `${name}: rotationAxis is a unit vector`);
  ok(e.semanticNameVerified === false,
    `${name}: semanticName is carried as an unverified alias`);
  ok(e.verified === false, `${name}: verified is false`);
  ok(typeof n.mesh === 'number', `${name}: carries geometry`);
}
ok(seenIndex.size === 8, 'the eight firmwareIndex values are distinct');

// a knee must follow its hip
for (const foot of ['R3', 'R4', 'L3', 'L4']) {
  const hip = ajoints[foot].parentPart;
  ok((nodes[byName.get(hip)].children ?? []).includes(byName.get(foot)),
    `${foot} is a child of ${hip}, so it follows it`);
}

// ---------------------------------------------------------------------------
// LAYER 3 — geometry: drive the rig to runStandPose and check V0's numbers
// ---------------------------------------------------------------------------

const MM = g.asset.extras.units.millimetresPerUnit;
ok(MM === 1000, 'the GLB declares millimetresPerUnit = 1000');

function localMatrix(nodeIdx, cmdDeg) {
  const n = nodes[nodeIdx];
  const T = fromTranslation(n.translation ?? [0, 0, 0]);
  const e = n.extras ?? {};
  let R = n.rotation ? fromQuat(n.rotation) : I4();
  if (cmdDeg && e.rotationAxis && e.signPerCommandedDeg !== undefined) {
    const deg = e.signPerCommandedDeg * (cmdDeg[e.firmwareName] - 90);
    R = mul(R, axisAngle(e.rotationAxis, deg));
  }
  return mul(T, R);
}
function worldMatrix(nodeIdx, cmdDeg) {
  let M = localMatrix(nodeIdx, cmdDeg);
  let p = parentOf.get(nodeIdx);
  while (p !== undefined) {
    M = mul(localMatrix(p, cmdDeg), M);
    p = parentOf.get(p);
  }
  return M;
}

/** Every position of a node's mesh, in world millimetres, at the given pose. */
function worldPositionsMm(nodeIdx, cmdDeg) {
  const M = worldMatrix(nodeIdx, cmdDeg);
  const mesh = g.meshes[nodes[nodeIdx].mesh];
  const out = [];
  for (const prim of mesh.primitives) {
    const { data, count } = accessor(g, bin, prim.attributes.POSITION);
    for (let i = 0; i < count; i++) {
      const p = xform(M, [data[i * 3], data[i * 3 + 1], data[i * 3 + 2]]);
      out.push(p[0] * MM, p[1] * MM, p[2] * MM);
    }
  }
  return Float64Array.from(out);
}

let maxVertexMm = 0;
let maxBboxMm = 0;
let comparedParts = 0;
const footWorld = {};

for (const name of JOINT_ORDER) {
  const idx = byName.get(name);
  const world = worldPositionsMm(idx, standCmd);
  if (['R3', 'R4', 'L3', 'L4'].includes(name)) footWorld[name] = world;

  // --- placed bounding box, against assembly-map ---------------------------
  const lo = [Infinity, Infinity, Infinity];
  const hi = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < world.length; i += 3)
    for (let k = 0; k < 3; k++) {
      lo[k] = Math.min(lo[k], world[i + k]);
      hi[k] = Math.max(hi[k], world[i + k]);
    }
  const bb = parts[name].placedBoundingBoxMm;
  for (let k = 0; k < 3; k++) {
    maxBboxMm = Math.max(maxBboxMm, Math.abs(lo[k] - bb.min[k]), Math.abs(hi[k] - bb.max[k]));
  }

  // --- per-vertex, against the STL transformed by V0's own matrix ----------
  const stlPath = join(REPO, parts[name].stlPath);
  if (!existsSync(stlPath)) continue;
  const stl = readStlVertices(stlPath);
  const P = parts[name].poseFromStlMm;
  const flat = new Float64Array(stl.xyz.length);
  for (let i = 0; i < stl.xyz.length; i += 3) {
    const p = [stl.xyz[i], stl.xyz[i + 1], stl.xyz[i + 2]];
    flat[i] = P[0][0] * p[0] + P[0][1] * p[1] + P[0][2] * p[2] + P[0][3];
    flat[i + 1] = P[1][0] * p[0] + P[1][1] * p[1] + P[1][2] * p[2] + P[1][3];
    flat[i + 2] = P[2][0] * p[0] + P[2][1] * p[1] + P[2][2] * p[2] + P[2][3];
  }
  const a = distinct(flat);
  const b = distinct(world);
  if (!ok(a.length === b.length, `${name}: distinct vertex count survives the pipeline`,
    `STL ${a.length} vs GLB ${b.length}`)) continue;
  const worst = maxNearestDistance(b, a, 0.05);
  if (!ok(worst !== null, `${name}: every GLB vertex has an STL counterpart within 0.05 mm`)) continue;
  maxVertexMm = Math.max(maxVertexMm, worst);
  comparedParts += 1;
}

ok(comparedParts === 8, 'all eight moving parts compared per-vertex against the STLs',
  `only ${comparedParts}`);
ok(maxVertexMm < 5e-3,
  'stand-pose reproduction: every vertex within 0.005 mm of V0\'s poseFromStlMm',
  `worst ${maxVertexMm.toExponential(3)} mm`);
ok(maxBboxMm < 5e-3, 'posed bounding boxes match assembly-map placedBoundingBoxMm',
  `worst ${maxBboxMm.toExponential(3)} mm`);

// ground plane, recomputed — pose-dependent, never a constant
let groundStand = Infinity;
for (const w of Object.values(footWorld))
  for (let i = 1; i < w.length; i += 3) groundStand = Math.min(groundStand, w[i]);
near(groundStand, amap.canonicalFrame.groundPlaneYMm, 5e-3,
  'ground plane at runStandPose matches V0');
ok(g.asset.extras.groundPlane.method.includes('POSE-DEPENDENT'),
  'the GLB says out loud that the ground plane is pose-dependent');
ok(typeof g.asset.extras.groundPlane.atRestPoseMm === 'number'
  && g.asset.extras.groundPlane.atRestPoseMm !== g.asset.extras.groundPlane.atRunStandPoseMm,
  'the ground plane is given per pose, not as one constant');

// all four feet exactly vertical at runStandPose (V0 §6.4)
for (const [name, w] of Object.entries(footWorld)) {
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < w.length; i += 3)
    for (let k = 0; k < 3; k++) { lo[k] = Math.min(lo[k], w[i + k]); hi[k] = Math.max(hi[k], w[i + k]); }
  near(hi[1] - lo[1], 58.42, 5e-3, `${name}: 58.42 mm long dimension lies along canonical Y`);
}

// the rest pose really is the neutral pose: identity everywhere
const restCmd = Object.fromEntries(JOINT_ORDER.map((n) => [n, 90]));
let maxRestDrift = 0;
for (const name of JOINT_ORDER) {
  const A = worldMatrix(byName.get(name), null);
  const B = worldMatrix(byName.get(name), restCmd);
  for (let i = 0; i < 16; i++) maxRestDrift = Math.max(maxRestDrift, Math.abs(A[i] - B[i]));
}
ok(maxRestDrift < 1e-12, 'commandedDeg 90 on every joint is exactly the rest transform',
  `drift ${maxRestDrift}`);

// ---------------------------------------------------------------------------
// LAYER 4 — provenance
// ---------------------------------------------------------------------------

const ex = g.asset.extras;
for (const s of ex.sources) {
  const p = join(REPO, s.path);
  if (!existsSync(p)) { notes.push(`source not on disk (upstream not fetched?): ${s.path}`); continue; }
  const got = createHash('sha256').update(readFileSync(p)).digest('hex');
  ok(got === s.sha256, `source sha256 still matches: ${s.path}`);
}
ok(!JSON.stringify(g).includes('"verified":true'),
  'nothing anywhere in the GLB claims verified:true');

const cover = nodes[byName.get('body_top_cover')];
ok(cover !== undefined, "the top cover is a named node ('body_top_cover')");
ok(cover?.extras?.substitutedFor === 'Top-Cover-Enclosed-v117.stl',
  'the top-cover substitution is declared in the asset, not just in the docs');
ok(/not watertight/i.test(cover?.extras?.substitutionReason ?? ''),
  'the substitution reason names the watertightness defect');
ok(parts[cover?.extras?.partId]?.stlFile !== 'Top-Cover-Enclosed-v117.stl',
  'the non-watertight recommended cover is NOT the mesh that shipped');

ok(ex.meshPolicy.instancing.includes('engrav'),
  'the no-instancing decision records why the four shape classes are not interchangeable');

// ---------------------------------------------------------------------------
// LAYER 5 — the OLED screen node
// ---------------------------------------------------------------------------

const oledIdx = byName.get('oled_screen');
const oled = nodes[oledIdx];
ok(nodes[parentOf.get(oledIdx)]?.name === 'sesame_body', 'oled_screen hangs off sesame_body');
const oprim = g.meshes[oled.mesh].primitives[0];
ok(oprim.attributes.TEXCOORD_0 !== undefined, 'oled_screen has a TEXCOORD_0 set for V4');
const opos = accessor(g, bin, oprim.attributes.POSITION);
const ouv = accessor(g, bin, oprim.attributes.TEXCOORD_0);
ok(opos.count === 4 && accessor(g, bin, oprim.indices).count === 6,
  'oled_screen is a single quad');

const [pw, ph] = oled.extras.planeSizeMm;
let xs = [], ys = [], zs = [];
for (let i = 0; i < 4; i++) {
  xs.push(opos.data[i * 3] * MM); ys.push(opos.data[i * 3 + 1] * MM); zs.push(opos.data[i * 3 + 2] * MM);
}
near(Math.max(...xs) - Math.min(...xs), pw, 1e-4, 'oled quad width matches extras.planeSizeMm');
near(Math.max(...ys) - Math.min(...ys), ph, 1e-4, 'oled quad height matches extras.planeSizeMm');
ok(zs.every((z) => Math.abs(z) < 1e-9), 'oled quad lies in its node\'s local z = 0 plane');
near(pw / ph, 128 / 64, 1e-9, 'oled plane is 2:1, matching the 128x64 framebuffer');

// UV (0,0) must be the TOP-LEFT corner of the quad: min x, max y.
let uvTopLeft = -1;
for (let i = 0; i < 4; i++) if (ouv.data[i * 2] === 0 && ouv.data[i * 2 + 1] === 0) uvTopLeft = i;
ok(uvTopLeft >= 0, 'oled quad has a UV (0,0) corner');
if (uvTopLeft >= 0) {
  near(opos.data[uvTopLeft * 3] * MM, -pw / 2, 1e-4, 'UV (0,0) is at local -x');
  near(opos.data[uvTopLeft * 3 + 1] * MM, ph / 2, 1e-4, 'UV (0,0) is at local +y (top)');
}

// the screen must face forward-and-up, and its declared normal must be its real one
const Mo = worldMatrix(oledIdx, null);
const n0 = accessor(g, bin, oprim.attributes.NORMAL);
const wn = xform(Mo, [n0.data[0], n0.data[1], n0.data[2]]);
const o0 = xform(Mo, [0, 0, 0]);
const nrm = [wn[0] - o0[0], wn[1] - o0[1], wn[2] - o0[2]];
const declared = oled.extras.screenNormalCanonical;
for (let k = 0; k < 3; k++) near(nrm[k], declared[k], 1e-6, `oled normal component ${k}`);
ok(nrm[2] < -0.5, 'the screen faces the robot\'s front (canonical -Z)');
near(o0[2] * MM < 0 ? 1 : 0, 1, 0, 'the screen sits in the front half of the robot');
ok(oled.extras.planeStatus === 'inferred', 'the OLED plane is carried as inferred, not measured');

// ===========================================================================

const kb = (bytes / 1024).toFixed(1);
console.log(`assets/sesame.glb  ${bytes.toLocaleString()} bytes (${kb} KiB)  sha256 ${sha}`);
console.log(`  nodes ${nodes.length}   meshes ${g.meshes.length}   triangles ${ex.meshPolicy.triangles.toLocaleString()}   vertices ${ex.meshPolicy.vertices.toLocaleString()}`);
console.log(`  stand-pose reproduction, per vertex vs V0 poseFromStlMm : ${maxVertexMm.toExponential(3)} mm`);
console.log(`  posed AABB vs assembly-map placedBoundingBoxMm          : ${maxBboxMm.toExponential(3)} mm`);
console.log(`  ground plane at runStandPose (recomputed)               : ${groundStand.toFixed(4)} mm`);
console.log(`  top cover shipped                                       : ${parts[cover?.extras?.partId]?.stlFile}`);
for (const n of notes) console.log(`  note: ${n}`);

if (failures.length) {
  console.error(`\nFAIL  ${failures.length} of ${checks} checks failed:`);
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log(`\nOK  ${checks} checks passed.`);
