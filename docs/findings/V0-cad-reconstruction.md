# V0 — CAD assembly reconstruction

**Task:** Phase 1 · V0
**Agent:** `cad-reconstruction`
**Date:** 2026-08-23
**Replaces:** the cancelled Phase-1 hardware verification sprint, for everything geometric
**Depends on:** F5 (`hardware/assets-inventory.json`), F6 (`hardware/joint-map.json`), F4 (`hardware/hardware-map.json`)

**Machine-readable output:** [`hardware/assembly-map.json`](../../hardware/assembly-map.json)
(+ [`assembly-map.schema.json`](../../hardware/assembly-map.schema.json))
**Regenerate:** `tools/py-assets/.venv/Scripts/python.exe scripts/reconstruct-assembly.py …` (§10)
**Validate:** `pnpm validate:assembly-map` · **Joint map:** `pnpm build:joint-map` then `pnpm validate:joint-map`

> **Still not physically verified.** Every part carries `verified: false`. What
> changed is the *source*: geometry that used to be a reading of a PNG is now a
> reading of the design master. A CAD-authoritative value is a statement about
> the **design**, never about how a particular robot was assembled — and that
> distinction is the reason `semanticName` still cannot be promoted.

---

## 1. Result in one paragraph

The STL→CAD frame map is the **identity rotation, zero translation, scale
exactly 25.4**. It won a 96-candidate search by a factor of **8 876**. With it,
every printed part gets an exact rigid pose in one canonical robot frame, and
the assembled robot passes every physical-consistency test posed: the four hip
axes land on the CAD's exact grid, the four femur↔foot mates are coaxial with a
317.7× separation from the nearest rival, nothing interpenetrates, and all four
feet are exactly vertical. **Six of the nine unresolved items are closed, one
more (absolute rotation sense) that F6 said needed a robot is closed too, and
one is split into a resolved half and a still-open half.** The eight semantic
names are unchanged from F6's guess — but they no longer rest on a drawing.

---

## 2. The thing F5 was looking at from the wrong side

F5 found one hip pivot matching a CAD point to six digits "with the Z sign
inverted" and refused to generalise. That refusal was correct, and the reason
is more interesting than a near-miss.

F5 compared STL positions against the **assembly-frame** CAD transforms. But the
eight joint STLs are not at assembly positions, and they are not at a
"representative station" either. **Each joint STL is simply its own CAD body's
local geometry**, and the eight CAD bodies happen to be modelled at only two
mirrored stations. The Z-sign inversion F5 saw is the mirror between those two
modelling stations. It is a real feature of the design; it is just not a frame
flip, and no amount of staring at it was going to yield the frame map.

Two further corrections fall out of the same work:

| F5/F6 said | Correction |
|---|---|
| The CAD length unit is the millimetre, from `SI_UNIT(.MILLI.,.METRE.)` | That entity is the **base of an inch conversion**. All 107 geometric representation contexts assign `CONVERSION_BASED_UNIT('inch')` with `LENGTH_MEASURE_WITH_UNIT(25.4)`, so **every STEP coordinate is an inch value**. This does not disturb F5's (independently argued, correct) conclusion that the *STL* files are millimetres — it is precisely why the scale factor comes out at exactly 25.4, and it explains F5 §2's "curiosity" that every overall dimension is a multiple of 0.05 in. |
| F5 §3.3: "+Z is the 'R' side" in the STL frame | The two femur STL stations correspond to *shape classes*, not to sides: R1 and L2 share one station, R2 and L1 the other. Harmless in F5's own use, but it would mislead anyone reading positions out of that frame. |
| F6: the rest-pose contradiction is "likeliest" reconciled by the prose describing the horn plate and the diagram the leg | Backwards. See §6. |

---

## 3. Method

No OpenCascade, no FreeCAD, no cadquery — none was needed, and none was tried
on python 3.13. The move that unlocks everything is that a **STEP B-Rep's
`VERTEX_POINT` set is exactly recoverable symbolically**, and a tessellator
emits every B-Rep vertex into the STL. So the two representations share an exact
point set, and registering them is a measurement rather than a fit.

1. Parse the STEP: 442 013 entities, the assembly tree (220 occurrences, all
   transforms resolved), the unit context, and per-`PRODUCT` vertex clouds
   reached through `SHAPE_DEFINITION_REPRESENTATION` →
   `SHAPE_REPRESENTATION_RELATIONSHIP` (a plain SRR is an identity mapping, so
   following it introduces no transform).
2. Enumerate the candidate space: 48 signed axis permutations (all 24 proper
   rotations *and* all 24 reflections between coordinate axes) × 2 scale
   hypotheses (25.4 and 1.0), with the translation **fitted per candidate** so
   no candidate is penalised for being off-centre.
3. Score = mean point-to-nearest-STL-vertex residual **plus the spread of the
   fitted translation across the ten parts**. The second term is what makes it a
   test: a frame map is one global map, so a candidate needing a different
   translation for each part is not one.
4. Place every STL at its CAD instance transform and score the assembled robot.

Translation is fitted by translation-only ICP from four deterministic starts
(centroid, bbox centre, bbox min, bbox max), best residual wins.

---

## 4. The candidate search

| rank | scale | axis perm | signs | residual mm | translation spread mm | **score** |
|---|---|---|---|---|---|---|
| **1** | **25.4** | **(0,1,2)** | **(+,+,+)** | **0.000868** | **0.002651** | **0.003519** |
| 2 | 25.4 | (0,1,2) | (+,−,+) | 4.980 | 26.255 | 31.235 |
| 3 | 25.4 | (1,0,2) | (+,−,+) | 7.616 | 29.336 | 36.952 |
| 4 | 25.4 | (1,0,2) | (−,−,+) | 7.794 | 31.361 | 39.156 |
| 5 | 25.4 | (0,1,2) | (−,+,+) | 1.428 | 38.978 | 40.405 |
| 6 | 25.4 | (1,0,2) | (+,+,+) | 7.513 | 39.053 | 46.566 |
| … | | | | | | worst 157.2 |

**Margin: 8 875.9×.** The fitted translation of the winner is
`[0.000009, 0.0, −0.000305]` mm — zero to within float32 STL storage. This is
not a close call and no tie-break judgement was required.

Per-part registration residuals under the winner:

| part | B-Rep vertices | mean mm | max mm |
|---|---|---|---|
| R1 / R2 / L1 / L2 | 237 / 263 / 211 / 237 | 0.00062 | 0.0758 |
| R3 / R4 / L3 / L4 | 230 / 212 / 208 / 190 | 0.00031 | 0.00031 |
| Internal-Frame | 444 | 0.00047 | 0.0431 |
| Bottom-Cover | 118 | 0.00326 | 0.3485 |

The non-zero maxima are tessellation, not misalignment: a B-Rep vertex on a
curved edge is not always *also* a mesh vertex once the surface is faceted, so
the nearest mesh vertex can be up to a chord-height away. The feet, which are
almost entirely planar, come in at 3 × 10⁻⁴ mm — float32 noise.

---

## 5. The canonical frame, and what fixes it

```
id            sesame-robot          (right-handed)
+Y            up
−Z            forward               (glTF/three.js convention)
+X            the robot's own right
origin        the centroid of the four hip rotation axes, in their plane
```

`canonicalFromCadRootMm` is recorded in the artefact, so the CAD root frame is
always recoverable. The CAD root is `+Y` up, `−X` forward, `−Z` right, in inches.

**Up** is authoritative: the three body shells stack along `+Y_cad` in build
order and the four feet hang to `−Y`, reaching 68.65 mm below the hip plane
while the whole chassis occupies 22.97 mm.

**Forward** is authoritative, and it is the pleasing one. The build guide's
physical cue is *"Notch = front. USB port = back."* The STEP assembly places
`USB_type_C_smd_12p` at one end of the chassis and the OLED's screen border at
the other. That fixes fore/aft from the design master, not from a render.

**Right** follows: `right = forward × up`. All four **R**-named CAD products
land on that side and all four **L**-named products on the other, which settles
a question no repository text answers — **"R" and "L" denote the robot's own
right and left.**

### And therefore: the top-down drawing is a view from above

This was flagged as the single biggest win available in V0, because if
`sesame-topdown.png` were a bottom view all eight semantic names would flip.

The drawing puts **FRONT** at the top and the **R** parts on the image's right.
Looking *down* on a robot whose front points up-screen, its own right side
appears on the image's right. Looking *up* from below, it would appear on the
left. The CAD says R is the robot's own right. **The drawing is therefore a view
from above, and it agrees with the CAD.** The question is not so much answered
as retired: 3D positions moot the 2D render entirely.

---

## 6. What the assembled robot says

### 6.1 The hip axes land on the CAD's grid, and explain a number F5 measured

The four hip servo **cases** sit on an exact 1.500 × 2.000 in
(38.100 × 50.800 mm) grid. The four hip **axes** — the actual output shafts, read
from the servo horn occurrences — form a **48.400 × 50.800 mm** rectangle, all
four exactly vertical, all four in one plane.

50.800 mm is exactly 2.000 in: the two rows face the same way across the robot.
48.400 = 38.100 + 2 × 5.150: the front and rear rows face *opposite* ways, and
each output shaft sits **5.15 mm** off its case centre. That 5.15 mm is the
number F5 derived independently, from the printed-part meshes alone, as the
offset between an MG90S output shaft and its mounting-ear midpoint. Two
completely separate measurements, one from plastic and one from the CAD servo
model, agreeing to three decimals.

### 6.2 The femur↔foot pairing, measured

All 16 femur-distal-axis / foot-pivot-axis combinations, scored by coaxiality
error (the larger of the two point-to-line distances — the common perpendicular
is useless here, because four of the sixteen combinations are perpendicular axes
that happen to cross):

| mate | error mm | axis angle |
|---|---|---|
| R1 ↔ R3 | 0.1877 | 0.0000° |
| R2 ↔ R4 | 0.0001 | 0.0000° |
| L1 ↔ L3 | 0.1877 | 0.0000° |
| L2 ↔ L4 | 0.0001 | 0.0000° |
| nearest non-mate | **59.624** | — |

A **317.7× separation**. The 0.1877 mm on the two front legs is F5 pivot-detector
noise, not a design asymmetry: R3 and L4 are the same solid, and F5's detector
put their pivot 0.1877 mm apart in the part frame. Independently, those same
four pairs are the *only* femur/foot pairs whose placed meshes share a bounding
box at all.

This matches `reference-configuration.png` exactly. F6 was right; it is now
measured.

### 6.3 Nothing interpenetrates

Twelve pairs of placed printed parts have overlapping AABBs — the four
femur↔foot mates, the four femur↔frame interfaces, and the body-shell stack.
**Maximum penetration depth across all twelve: 0.0000 mm.** No femur touches
another femur; no foot touches a non-mating femur.

The body shells meet exactly: bottom cover → internal frame gap **0.000000 mm**,
internal frame → top cover gap **0.000000 mm**. That is what justifies placing
the three top covers at the identity, since the STEP assembly contains no top
cover at all (recorded as an open item).

### 6.4 The CAD is drawn in `runStandPose`

All four hip horns sit at exactly ±45.000° from their case neutral, and all four
feet are exactly vertical (each foot's 58.420 mm long dimension lies along
canonical Y to machine precision). In F6's body-relative convention that is
+45° on every hip and +90° on every foot — `runStandPose`, and nothing else in
the 395-step corpus.

This is a *tested* identification rather than an assumption. Solving
`α = s·(commandedDeg − 90) + d` over the servos whose horn occurrence exists:

| family | samples | slope | offset | max residual |
|---|---|---|---|---|
| hips | 4 | **−1.0** | **0.0** | 0.000000° |
| knees | 2 | **+1.0** | **0.0** | 0.000000° |

Both solve uniquely and exactly. Crucially the offset is **solved for, not
assumed**, and it comes out at zero — any other pose assignment leaves a
non-zero offset. The hips and knees take opposite slopes because the servo is
mounted the other way round at the knee: the case is bolted inside the foot and
the horn to the femur, so the child link is the one carrying the case.

**This closes F6's item 7, the absolute rotational sense**, which F6 listed as
needing a physical robot. It depends on two things, both stated in the artefact
rather than hidden: that the CAD pose is `runStandPose` (evidenced above), and
that a 180° servo turns one degree of shaft per commanded degree over 0–180 (the
BOM specifies 180° MG90S units; the firmware clamps to 0–180).

### 6.5 The rest-pose contradiction, settled — against F6's guess

F6 recorded a contradiction: the build guide says that at Rest *"the hip joint
should move perfectly parallel to the body"*, while `sesame-angle-guide.png`
draws each hip's 90° ray pointing laterally outward. F6 guessed the prose
described the horn plate and the diagram the leg.

Undoing each hip horn's measured ±45° rotation puts every leg **exactly along
the body's long axis** — front legs forward, rear legs rearward, **0.000000° off**
on all four. So at the 90° datum the hip really is parallel to the body, exactly
as the prose says, and the diagram's lateral rays are not the leg direction.
F6's guess was backwards, and is corrected in the data as well as here.

(This also makes the design read sensibly: the hip sweeps a clean 90° from
parallel-to-body at 0 body-relative, through the 45° diagonal splay of Stand, to
fully lateral at +90 — which is precisely the range the choreography uses.)

### 6.6 The servo datum plane

F5 asked for "an MG90S CAD model, a STEP B-Rep evaluation, or measuring a built
robot". The B-Rep evaluation delivers it: the CAD servo model's **output-horn
occurrence has an explicit origin on the shaft axis**, which is exactly the
along-axis datum that was missing. It agrees with F5's independently measured
pivot axis to **4 × 10⁻⁵ mm**.

Two caveats, both recorded:

- Six of the eight joints get it directly. The two **front** leg servos appear
  in the STEP only as mirrored *case* bodies with no horn occurrence, so no
  shaft datum is recoverable for R3 and L3. Use their mirror twins'.
- The CAD models an **SG90 (Tower Pro)** while `hardware/bom/README.md` calls
  for **MG90S**. Same 32.2 × 12 × 30 mm footprint, same 27.8 mm ear pitch, so
  the printed parts fit either — but the datum recorded is the SG90's. New open
  item `servo-model-is-sg90-not-mg90s`.

Worth saying plainly, because F5 treated this gap as more serious than it is:
**for a revolute joint the along-axis position of the origin has no effect on the
kinematics.** The axis *line* was always sufficient for V2/V3.

---

## 7. What changed in the joint map

`hardware/joint-map.json` is regenerated by `scripts/build-joint-map.mjs`, which
now reads `hardware/assembly-map.json` as a fourth input. Version 1.0.0 → 1.1.0.

| Field | Was | Now | Method |
|---|---|---|---|
| `conventions.canonicalFrame` | *(absent)* | **authoritative** | New. The `sesame-robot` frame, its axes, and the frame-map margin. |
| `conventions.coordinateFrame` (`stl-assembly`) | the only frame | `supersededBy: conventions.canonicalFrame` | Retained so F5's raw `rotationAxis`/`pivotOrigin` stay auditable. |
| `conventions.lengthUnitSource` | "STEP declares millimetre" | corrected to inch-with-25.4-base | See §2. |
| `joints[*].cadPose` | *(absent)* | **inferred**, with `poseStatus: authoritative` | New. 4×4 pose from STL mm → canonical frame, joint axis, servo shaft datum, placed bbox. |
| `joints[*].parentLink` (feet) | `inferred`, read off two PNGs | **`authoritative`** | Unique coaxial pairing in the CAD, 317.7× margin. |
| `joints[*].parentLink` (femurs) | `authoritative`, servo grid | `authoritative`, now quoting the measured 48.400 × 50.800 mm **axis** rectangle | §6.1. |
| `joints[*].directionSign.absoluteSense` | *(absent — F6 said "NOT established")* | **inferred** | New. `childRotationDeg = ∓1 × (commandedDeg − 90)` about the stated axis, fitted exactly. |
| `joints[*].directionSign.caveat` | "the sign is RELATIVE, not absolute" | reworded: the sign is a bookkeeping convention; the physical sense is in `absoluteSense` | — |
| `joints[R1,R2,L1,L2].zeroReferenceDeg.cadRestGeometry` | *(absent)* | **inferred** | New. Leg direction at Rest and at Stand; 0.000° from the body long axis at Rest. |
| `joints[*].semanticName` | `verified:false`, basis = two drawings | `verified:false`, basis = **CAD measurement**, `wouldBeConfirmedBy` cut from 4 items to 2 | §5. |
| `joints[*].rotationAxis`, `pivotOrigin` | inferred, STL frame | **unchanged** | Deliberate: they are still a mesh fit, still reported verbatim in F5's frame, and the validator still pins them to F5. |
| `zeroReferenceDeg.value`, `directionSign.value` | inferred | **unchanged** | Still inferred from choreography and documentation. The CAD corroborates but does not replace them. |
| `angleLimitsDeg.mechanicalLimitsDeg` | `null` | **still `null`** | V0 reconstructed one pose. It did not sweep anything. |

### Why `semanticName` is still `verified: false`

Because it is the honest answer, not because the type system is in the way. The
CAD says where the body *named* `R1` belongs. It cannot say that the servo on
this firmware channel drives the part *engraved* `R1` on a particular machine —
F5 measured R1 ≡ L2, R2 ≡ L1, R3 ≡ L4, R4 ≡ L3 as identical solids, so two parts
can be swapped at build time and neither the firmware nor the CAD would notice.

What did change is that `wouldBeConfirmedBy` went from four items to two: the
build-time inspection above, and whether the drawn front is the direction the
`walk` command travels. The two that closed — view direction, and whether R/L are
the robot's own sides — are recorded in `SEMANTIC_CLOSED_BY_V0` so the shrinking
of that list is auditable rather than silent.

### The eight semantic names

Unchanged from F6: `R1 right_front_hip`, `R2 right_rear_hip`,
`L1 left_front_hip`, `L2 left_rear_hip`, `R3 right_front_knee`,
`R4 right_rear_knee`, `L3 left_front_knee`, `L4 left_rear_knee`.

That they did not move is the point. F6 guessed them off two drawings with an
explicit warning that a bottom-view reading would flip all eight. The CAD
confirms every one.

---

## 8. Unresolved items: before and after

| Item | F5/F6 | V0 | How |
|---|---|---|---|
| `stl-to-cad-frame-mapping` | open | **resolved** | Identity ⊗ 25.4, 8 876× margin |
| `per-instance-assembly-poses` | open | **resolved** | 10 parts authoritative, 3 top covers inferred |
| `view-direction-of-the-labelled-drawings` | open | **resolved** | R products on the robot's own right |
| `front-rear-orientation` | partial | **resolved** | USB-C aft, OLED forward, in the STEP |
| `hip-to-foot-instance-naming` | partial | **resolved** | Unique coaxial mate, 317.7× margin |
| `rest-pose-hip-orientation-contradiction` | open | **resolved** | Legs parallel to the body at 90°; F6's guess corrected |
| `servo-datum-plane` | open | **resolved** | CAD horn occurrence, agrees to 4 × 10⁻⁵ mm |
| *absolute rotational sense* (F6 item 7) | open, "needs a robot" | **resolved** | Exact fit over the CAD horn angles |
| `joint-zero-sign-and-limits` | partial | **still partial** | Absolute sense closed; **mechanical travel limits still unknown** |
| `horn-spline-quantisation` | open | **still open** | Unreachable from CAD by construction → V6 |
| `parts-installed-where-drawn` | open | **still open** | Build-time question → physical inspection |
| per-robot subtrim | open | **still open** | → V6 |
| `walk-direction-vs-drawn-front` | *(was folded into front/rear)* | **new, open** | The CAD fixes which end is which, not which way it walks |
| `servo-model-is-sg90-not-mg90s` | — | **new, open** | CAD models SG90; BOM says MG90S |
| `top-cover-not-in-cad` | — | **new, open** | STEP has no top cover; its pose is inferred |

Nothing was closed by assertion. `scripts/validate-assembly-map.mjs` requires
every entry in `resolvedByThisTask` to be backed by a check that actually
passes, and refuses to let `horn-spline-quantisation`, `mechanical-travel-limits`,
`per-robot-subtrim` or `parts-installed-where-drawn` leave `unresolved[]`.

---

## 9. What V2 (glTF) can now rely on

- **One frame, documented:** `sesame-robot`, right-handed, +Y up, −Z forward,
  +X right. That is glTF's own convention, so the pipeline needs no axis
  conversion — just millimetre-to-metre scaling if it wants SI.
- **A 4×4 `poseFromStlMm` per part**, applying directly to the STL mesh as
  loaded. Thirteen parts: eight joints, the internal frame, the bottom cover and
  three top-cover variants (print one).
- **A kinematic tree with no ambiguity:** four femurs on `internal-frame`, one
  foot per femur, mates measured.
- **Per-joint axis + a point on it**, plus a servo shaft datum on six of eight.
- **A signed rotation rule:** `childRotationDeg = −1 × (commandedDeg − 90)` for
  hips about `+Y`, `+1 × (commandedDeg − 90)` for knees about the stated axis.
  An animated viewer can be driven straight from commanded angles without
  guessing a sign.
- **A known-good reference pose** (`runStandPose`) to snap the rig against, and
  a rest pose whose geometry is stated.

Two things V2 must still handle itself: `Top-Cover-Enclosed-v117.stl` is
**still not watertight** (10 disconnected bodies — F5), so it needs repair
before any physics or boolean use; and the ground plane at
`y = −68.65 mm` is *pose-dependent*, not a frame property.

---

## 10. Reproducing this

```powershell
tools/py-assets/.venv/Scripts/python.exe scripts/reconstruct-assembly.py `
  --step     firmware/upstream/hardware/cad/Sesame-ESP32-v122.step `
  --stl-dir  firmware/upstream/hardware/printing/stl `
  --repo-root . --out hardware/assembly-map.json

pnpm validate:assembly-map     # or: node scripts/validate-assembly-map.mjs
pnpm build:joint-map
pnpm validate:joint-map
pnpm validate:assets-inventory
```

The run takes about 45 s (the 96-candidate search is ~35 s of it) and is
**deterministic**: two runs with the same `--generated-at` produce byte-identical
files (verified). Nothing under `reference/` or `firmware/upstream/` is written
to; no package was installed.

`packages/sesame-model`'s 53 tests still pass unchanged — the new joint-map
fields are additive and the runtime parser tolerates them.

### Validation layers

`scripts/validate-assembly-map.mjs` (`pnpm validate:assembly-map`) is four
layers: JSON Schema; provenance (every path cites `firmware/upstream/`, every
sha256 re-hashed off disk, every STL identity cross-checked against F5);
**geometric self-consistency recomputed rather than trusted** (every pose matrix
orthonormal and right-handed, the declared frame actually right-handed, hip axes
vertical and on the recorded rectangle, mate graph a bijection, kinematic tree
acyclic and rooted at the frame); and epistemic invariants (no `verified: true`
anywhere; a `resolved` frame map must have actually won decisively; an
`authoritative` pose must name a CAD occurrence; every resolution claim must be
backed by a passing check).

`scripts/validate-joint-map.mjs` gained a fifth layer that re-reads
`assembly-map.json` and fails if any promoted value has drifted from it.

### Tool versions

`python 3.13.13` · `numpy 2.5.2` · `trimesh 4.12.2` · `scipy 1.18.1` — the
existing `tools/py-assets/.venv`. **No OpenCascade, cadquery or FreeCAD was
installed or needed**; the question of whether an OCC wheel builds on python
3.13 never had to be answered.
