# V2 — articulated glTF asset pipeline

**Task:** Phase 1 · V2
**Agent:** `asset-pipeline`
**Date:** 2026-08-23
**Depends on:** V0 (`hardware/assembly-map.json`), F6 (`hardware/joint-map.json` v1.1.0),
F5 (`hardware/assets-inventory.json`)

**Artefact:** [`assets/sesame.glb`](../../assets/sesame.glb) — 1 282 796 bytes
**Build:** `tools/py-assets/.venv/Scripts/python.exe scripts/build-gltf.py`
**Determinism check:** `… scripts/build-gltf.py --check`
**Validate:** `pnpm validate:gltf` · or `node scripts/validate-gltf.mjs`

> **Still not physically verified.** Every node in the GLB carries
> `extras.verified: false`, and `validate-gltf.mjs` fails the build if the
> string `"verified":true` appears anywhere in the file. V2 added no
> measurements; it re-expressed V0's, and V0's confidences travel with them.

---

## 1. Result in one paragraph

The eight printed joints, three body shells and the OLED are now one deterministic
GLB with a named, correctly parented kinematic tree whose **rest pose is the
neutral pose** — every servo at `commandedDeg = 90`, every joint node at the
identity rotation. Driving that rig with `runStandPose`'s commanded angles
reproduces V0's own part placements to **2.07 × 10⁻⁶ mm per vertex**, measured
*through* the written file: the validator reads the GLB's float32 positions and
quaternions, walks the node graph, and compares against the raw STL on disk
transformed by V0's `poseFromStlMm`. Nothing on that path is shared with how the
GLB was built, and since V0 proved the CAD *is* stand, it is an end-to-end test
of the whole chain. The file is 1.28 MB (683 KiB gzipped), byte-identical across
rebuilds, contains **no decimation and no quantisation** — every exported vertex
position is the STL's own float32 value, rigidly transformed — and ships the
watertight `Cat` top cover in place of the recommended-but-broken `Enclosed` one,
with the substitution recorded in the asset itself rather than only here.

---

## 2. The node hierarchy

```text
scene "sesame-robot"
└── sesame_body                     identity — glTF world space IS the canonical frame
    ├── body_internal_frame         mesh  Internal-Frame-v121.stl
    ├── body_bottom_cover           mesh  Bottom-Cover-v121.stl
    ├── body_top_cover              mesh  Top-Cover-Cat-v100.stl   ← substituted, §5
    ├── oled_screen                 mesh  1 quad, 128×64 texture target, §6
    ├── R1   hip   +Y   t = ( 25.400,   0.000, −24.200) mm
    │   └── R3   knee  (−1, 0, 0)   t = ( 10.943, −21.402, −36.830) mm rel. R1
    ├── R2   hip   +Y   t = ( 25.400,   0.000, +24.200) mm
    │   └── R4   knee  (−1, 0, 0)   t = ( 11.431, −21.590, +36.830) mm rel. R2
    ├── L1   hip   +Y   t = (−25.400,   0.000, −24.200) mm
    │   └── L3   knee  (+1, 0, 0)   t = (−11.117, −21.402, −36.830) mm rel. L1
    └── L2   hip   +Y   t = (−25.400,   0.000, +24.200) mm
        └── L4   knee  (+1, 0, 0)   t = (−11.431, −21.590, +36.830) mm rel. L2
```

- **Node names are the firmware names.** `R1 R2 L1 L2 R4 R3 L3 L4` — nothing
  else identifies a joint. `extras.firmwareIndex` is the servo channel, checked
  against `JOINT_ORDER` in `@sesame-lab/sesame-model` *and* against
  `joint-map.json`'s `firmwareIndex`; the validator fails if those two disagree
  with each other, never mind with the GLB.
- **Semantic names are aliases only.** `extras.semanticNameAlias` carries
  `right_front_hip` and friends alongside `semanticNameVerified: false` and a
  note saying why. V0 corroborated all eight from the CAD; the CAD still cannot
  say which printed part was bolted where, so they did not get promoted and they
  are not the node's identity.
- **Parenting is the joint map's**, verified against it rather than restated:
  each foot is a child of the femur `assembly-map.json` mates it to, so a knee
  follows its hip with no application-side bookkeeping.
- The two extra levels — the three `body_*` mesh children and the split between
  a joint node and the geometry it carries — exist so a viewer can hide the top
  cover. `sesame_body` itself is a grouping node at the canonical origin and
  carries no mesh.
- Every joint node's mesh is **baked into that joint's own frame**, so the node's
  local TRS is nothing but the joint transform: translation = the pivot, rotation
  = the joint angle. There is no second transform to compose and no place for a
  sign to hide.

### Units, and why the file is in metres

glTF declares the metre; V0, F5, F6 and the telemetry protocol are all in
millimetres. The GLB is written in **metres** (vertex positions and node
translations scaled by 1/1000) so it drops into any conformant viewer at the
right size, and every millimetre value kept in `extras` retains its `Mm` suffix
and is **not** scaled. `asset.extras.units.millimetresPerUnit = 1000` is the one
number a consumer needs; `validate-gltf.mjs` asserts it.

No axis conversion is applied anywhere. V0's canonical frame (`+Y` up, `−Z`
forward, `+X` the robot's own right) is already glTF's, which is the whole
reason this pipeline is a scale and a rename rather than a transform stack.

---

## 3. The pose rule, and the stand-pose reproduction residual

Every joint node carries the rule it obeys:

```
localRotation = quaternion(extras.rotationAxis,
                           extras.signPerCommandedDeg × (commandedDeg − 90) degrees)
```

with `signPerCommandedDeg` = **−1** on the four hips and **+1** on the four
knees, read out of `assembly-map.json`'s `rotationSense.rule` rather than
re-typed. `commandedDeg = 90` is therefore the identity on every joint, and the
rest pose stored in the file is the neutral pose.

Because the rest rotations are all identity, each node's rest orientation is
axis-aligned with the canonical frame, so `extras.rotationAxis` is readable both
as a local axis and as a canonical direction. At rest the hips are `±Y` and the
knees are exactly `(±1, 0, 0)`.

### Four checks, three of them independent of the construction

| check | result | independent? |
|---|---|---|
| **Stand-pose reproduction, per vertex, through the written GLB** vs `poseFromStlMm` applied to the STL on disk | **2.065 × 10⁻⁶ mm** | **yes** |
| Posed AABB vs `assembly-map.placedBoundingBoxMm` | **1.79 × 10⁻⁵ mm** | **yes** |
| Rest-pose knee axes vs V0's `restPoseGeometry.perJoint[*].restPoseKneeAxis` | **0.000000°** on all four | **yes** |
| Foot verticality at stand: each foot's 58.420 mm long dimension along canonical Y | **0.000 mm** deviation, all four | yes |
| Same reproduction computed in float64 inside the builder | 2.8 × 10⁻¹⁴ mm | **no** — circular |

The last row is honest bookkeeping: inside the builder the rest pose is derived
by *inverting* the stand rotations, so re-applying them can only give back what
went in. It proves the rig algebra self-consistent and nothing more. The number
that means something is the first row, and it is a different measurement: the
validator never sees the builder's matrices. It parses the GLB, walks
`sesame_body → R1 → R3`, composes float32 quaternions, transforms float32
vertex positions, and compares the resulting point set against binary-STL
vertices pushed through V0's 4×4 — matching by nearest neighbour in a hash grid,
because lexicographic pairing is unsafe on meshes this full of exactly-tied
coordinates. **2 nanometres** is float32 storage noise on a 130 mm robot.

The rest-knee-axis row is the one that could have failed. V0 derived those four
axes from the CAD servo horn occurrences; V2 derives them by undoing the hip
rotation on the stand-pose axes. Two different routes, exact agreement.

### The ground plane is not baked in

`groundPlaneY = −68.65 mm` is a property of `runStandPose`, not of the frame —
V0 flagged this and V2 does not bake it. The GLB carries
`asset.extras.groundPlane` with the **method** ("min canonical Y over every foot
vertex at the pose in question, POSE-DEPENDENT"), the value at two poses
(`runStandPose` −68.650046 mm, rest −31.115119 mm — the feet are horizontal at
rest, so the robot is *higher*), and an explicit instruction to recompute it.
The validator asserts the two values differ, so nobody can quietly collapse them
into a constant.

---

## 4. Mesh policy — what was and was not done to the geometry

| decision | choice | why |
|---|---|---|
| **Vertex positions** | untouched | The STL's own float32 values, rigidly transformed. No decimation, no simplification, no welding tolerance, no quantisation. A pivot, a mating face or a bearing bore **cannot** have moved, and the 2 nm residual is the proof. |
| **Normals** | angle-split, 35° smoothing | Vertices are shared only where incident faces agree in normal to within 35°; sharper edges get split vertices. Purely a shading choice — it changes no position. 153 918 non-indexed corners collapse to **39 326** vertices, which is where most of the size saving came from. |
| **Indices** | `uint16`, indexed | Largest single mesh is 6 677 vertices. |
| **Compression** | **none** | Draco needs an encoder this project has not installed, and installing one is out of scope for an agent forbidden from touching the lockfile. `KHR_mesh_quantization` would cut the payload roughly in half but pushes a *required* extension onto V3 for a file that is already 683 KiB on the wire. Revisit if V3 ever needs to load this over anything worse than localhost. |
| **Mesh instancing** | **none** | F5's four shape-equivalence classes (R1≡L2, R2≡L1, R3≡L4, R4≡L3) agree over only 95–97 % of sampled surface points, and F5 identified the residual as **the engraved part label**. Sharing mesh data between R1 and L2 would silently erase the engraving that names them — and their triangle counts differ (7 594 vs 7 666), so they are not the same mesh in the first place. The saving would have been ~450 KiB; the cost would have been deleting the only feature that tells the two parts apart. |

**Size:** 1 282 796 bytes total — 1 251 704 B binary, 31 064 B JSON.
**699 570 bytes gzipped (683 KiB).** 51 308 triangles, 39 326 vertices, 12 meshes.

---

## 5. The top cover: `Cat`, not the recommended `Enclosed`

`Top-Cover-Enclosed-v117.stl` is the recommended print and **is not watertight**:
10 disjoint bodies, no enclosed volume (F5 / ISSUE-20260823-006). Shipping it
would put a silently degenerate solid in front of every viewer and in front of
any future physics or boolean work.

**`Top-Cover-Cat-v100.stl` ships instead.** From the upstream
`top-covers/README.md` it is *"the modern version of the enclosed top cover with
cat ears instead of stubby ears… all current features"* — the same cover, a
different ear. It is watertight (5 bodies, all closed) and shares the recommended
cover's footprint. The third variant, `No-Ears`, is explicitly *"a template for
designing your own ears… only really meant for designing ears onto"*, so it is a
worse stand-in for the real part despite being the smallest mesh.

The substitution is recorded **in the asset**, on node `body_top_cover`:
`extras.substitutedFor`, `extras.substitutionReason`. `validate-gltf.mjs` fails
if that declaration is missing, if the reason stops naming the watertightness
defect, or if the broken mesh ever becomes the one that ships. It is not possible
to lose this by editing a document.

Note also that the STEP contains **no top cover at all** — V0's pose for it is an
inference (identity, corroborated by a zero-gap zero-overlap shell stack), not a
CAD reading, and `body_top_cover.extras.poseStatus` says `inferred`.

---

## 6. `oled_screen` — the convention V4 gets to rely on

The OLED is the one thing V2 had to read out of the STEP itself, because V0's
assembly map covers printed parts only. The CAD models the display as a library
part `Display_OLED_0.96_128x64` whose `Body - Screen Border` is a **rectangular
annulus lying on the front face of the glass**: outer rectangle = the bezel,
inner rectangle = the visible window. Both were read exactly, off 16 B-Rep
vertices, and the builder refuses to proceed if that shape is not what it finds.

```text
node   oled_screen                       (child of sesame_body)
mesh   one quad, 2 triangles, POSITION + NORMAL + TEXCOORD_0
origin (0.0194, 6.6356, −31.7214) mm canonical   — centre of the CAD glass window
rot    quaternion (0, 0.984808, 0.173648, 0)     — the module's own placement
plane  23.60 × 11.80 mm, lying in the node's local z = 0
tilt   20.000° from vertical, pitched back; normal (0, +0.342020, −0.939693)
```

**Local axes.** `+X` is the robot's own **left**, which is the **right** of an
observer standing in front of it; `+Y` is screen-up (canonical up, pitched back
20° with the module); `+Z` is out of the screen toward that observer, and is the
surface normal.

**UV convention.** `TEXCOORD_0` follows glTF's own image convention, origin
top-left: `(0,0)` is the quad corner at `(−w/2, +h/2)` and `(1,1)` is
`(+w/2, −h/2)`. So **SSD1306 pixel (col 0, row 0) lands on the top-left of the
screen as seen by someone facing the robot** — `u` increases with the column
index, `v` increases with the row index. A `CanvasTexture` in three.js will need
`flipY = false`, since three.js flips non-glTF textures by default and this quad
is authored for the unflipped convention.

**What is measured and what is chosen.** The window rectangle
(**23.60 × 13.70 mm**) and the bezel (24.70 × 14.70 mm) are read out of the STEP.
The **11.80 mm plane height is a decision of V2, not a measurement**: the CAD
library part does not model the pixel-active area, so the 128×64 framebuffer is
mapped to the 2:1 rectangle of the window's *full width*, centred on the window,
which keeps pixels square. A real 0.96" SSD1306's active area is smaller than its
glass; if that ever matters, shrink `extras.planeSizeMm` and keep this node's
frame — the frame is the part that came from the CAD. `extras.planeStatus` is
`inferred` and the validator asserts it stays that way.

---

## 7. Determinism

`build-gltf.py` has no clock, no RNG, no dict-order dependence and no
`generatedAt`. Node, mesh, accessor and buffer-view ordering is fixed by explicit
lists; every float written to JSON is rounded; quaternion signs are canonicalised
so `−0.0` cannot appear. JSON is emitted compact with `ensure_ascii`, and both
GLB chunks are padded deterministically.

```
$ … scripts/build-gltf.py           → sha256 0a866fc0e73dced4…
$ … scripts/build-gltf.py --check   → determinism: OK (byte-identical rebuild)
```

`--check` re-runs the whole build and fails on any SHA-256 difference against the
file already on disk. Two consecutive builds were byte-identical.

The GLB records the SHA-256 of all 15 of its inputs in `asset.extras.sources`;
`validate-gltf.mjs` re-hashes every one off disk, so a silently-changed STL is a
validation failure rather than a mystery.

**Not gitignored.** `.gitignore` ignores `*.bin`, which is exactly why the asset
is a single self-contained **GLB** rather than a `.gltf` + `.bin` pair — no
ignore rule needed adjusting, and `git check-ignore assets/sesame.glb` reports
nothing ignoring it. `tools/` and `firmware/upstream/` are ignored, so the build's
inputs are not in the repository; that was already true of V0 and is why the
input hashes are recorded in the artefact.

---

## 8. Validation

`scripts/validate-gltf.mjs` — **220 checks**, Node standard library only, no
dependencies, wired as `pnpm validate:gltf`. Five layers:

1. **Structure** — every required node name exists and is unique, exactly one
   scene, exactly one root, and it is `sesame_body`; every node has one parent.
2. **Rig** — all eight joints present; `JOINT_ORDER` cross-checked between
   `@sesame-lab/sesame-model`'s source and `joint-map.json`; `firmwareIndex`
   matches its slot; parenting matches `assembly-map.json`; every rest rotation is
   the identity; `signPerCommandedDeg` matches the rule string in the assembly
   map; axes are unit; each knee is a child of its own hip.
3. **Geometry** — drives the rig to `runStandPose` and compares against V0:
   per-vertex against the STLs on disk under `poseFromStlMm`, AABBs against
   `placedBoundingBoxMm`, the ground plane, foot verticality, and that
   `commandedDeg = 90` on every joint is *exactly* the rest transform.
4. **Provenance** — re-hashes every declared source; asserts no `verified:true`
   anywhere; asserts the top-cover substitution is declared, that the reason names
   the defect, and that the broken mesh is not the one shipped.
5. **OLED** — quad, UV set present, `(0,0)` really is the top-left corner, plane
   is 2:1, plane matches `extras.planeSizeMm`, the declared normal is the real
   one, and the screen faces `−Z`.

Layers 3 and 4 are the point: they compare the asset against *other files*, not
against its own claims.

---

## 9. What V3 can rely on

- **Node names are the contract.** `R1 R2 L1 L2 R4 R3 L3 L4`, plus `sesame_body`
  and `oled_screen`. Look joints up by name; `extras.firmwareIndex` gives the
  servo channel. Do not key anything off `semanticNameAlias`.
- **Drive one number per joint.** Set the node's local quaternion from
  `extras.rotationAxis` and `extras.signPerCommandedDeg × (commandedDeg − 90)`.
  Nothing else moves; parenting already carries a foot with its femur. Feeding
  `90` to all eight returns the rig exactly to its rest transform.
- **World space is the canonical `sesame-robot` frame, in metres.** `+Y` up,
  `−Z` forward, `+X` the robot's own right, origin at the centroid of the four
  hip axes. `sesame_body` is the identity, so no root correction is needed.
- **`extras` travels with the file.** three.js exposes node extras as
  `object.userData` and asset extras as `gltf.asset.extras`, so the rotation
  rule, the joint order, the frame definition, the ground-plane method and the
  provenance are all readable at runtime without shipping a sidecar.
- **`oled_screen` is ready for V4**: a UV-mapped quad with a documented pixel
  origin, §6.
- **Do not assume:** a ground-plane height (pose-dependent — recompute, or read
  the two recorded poses); that any `semanticNameAlias` is verified (none is);
  that the visible top cover is the recommended print (it is not, §5).

### Carried forward from V0, unchanged and still open

| item | state |
|---|---|
| `servo-model-is-sg90-not-mg90s` | open. The GLB emits **no servo geometry**, so nothing here depends on it — but the joint axes it inherits were read off the CAD's SG90 horn occurrences while the BOM calls for an MG90S. Recorded in `asset.extras.knownDiscrepancies`. |
| `top-cover-not-in-cad` | open. The STEP has no top cover; its pose is V0's inference. |
| front-leg servo datum (R3, L3) | open, and irrelevant here: a revolute joint does not care where along its axis the origin sits. |
| `mechanical-travel-limits` | open. **V2 clamps nothing.** The rig will happily rotate a joint to any angle; the firmware's 0–180 clamp and the unknown mechanical travel belong to V1/V6, not to the asset. |
| `parts-installed-where-drawn`, `horn-spline-quantisation`, per-robot subtrim | open → V6. |

---

## 10. Reproducing this

```powershell
tools/py-assets/.venv/Scripts/python.exe scripts/build-gltf.py
tools/py-assets/.venv/Scripts/python.exe scripts/build-gltf.py --check
pnpm validate:gltf          # or: node scripts/validate-gltf.mjs
```

The build takes about 4 s. `python 3.13.13` · `numpy 2.5.2` — `trimesh` and
`scipy` are pulled in only because the OLED extraction reuses V0's STEP reader
from `scripts/reconstruct-assembly.py` rather than duplicating it; no geometry
passes through trimesh, and the STL reader here is deliberately hand-rolled so
that no library's welding tolerance can touch a vertex. **No package was
installed**, nothing under `reference/` or `firmware/upstream/` was written to,
and no `pnpm install` was run.
