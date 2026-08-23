# F5 — Mechanical asset inventory and STL geometry extraction

**Task:** Phase 0 · Workstream F · F5
**Agent:** `asset-pipeline`
**Date:** 2026-08-23
**Machine-readable output:** [`hardware/assets-inventory.json`](../../hardware/assets-inventory.json) (+ [`assets-inventory.schema.json`](../../hardware/assets-inventory.schema.json))
**Regenerate with:** `scripts/setup-asset-env.ps1` then `scripts/extract-stl-geometry.py`

> **Verification status: nothing below has been checked against a physical
> robot.** Every part in the inventory carries `"verified": false`. Where a
> value is measured off a mesh it says so; where it is inferred it carries a
> method and a confidence. Two things that look alike in this document —
> "the axis of a fitted cylinder" and "the joint's kinematic axis" — are not
> the same claim, and the difference is stated every time it matters.

---

## 1. What was found, versus what was expected

The plan expected **11 printed pieces**. The STL tree holds **15 files**,
which is the same 11-piece buildable set plus alternatives:

| Expected | Present | Notes |
|---|---|---|
| Internal frame | `Internal-Frame-v121.stl` | ✅ |
| Bottom cover | `Bottom-Cover-v121.stl` | ✅ |
| Top cover ×1 | **3 styles** — `Top-Cover-Enclosed-v117`, `-Cat-v100`, `-No-Ears-v100` | you print one; `hardware/printing/stl/top-covers/README.md` |
| Joints `R1–R4`, `L1–L4` | all 8 present, `*-v117.stl` | ✅ |
| — | 2 optional magnetic hats under `top-covers/hats/` | cosmetic, not part of the 11 |

No expected part is missing. `hardware/printing/README.md` and
`docs/build-guide/README.md` line 33 both state the 11-piece count and both
agree with the file list.

### Dimension table (millimetres — see §2)

| File | Role | Joint | Bounding box X×Y×Z | Volume mm³ | Area mm² | Tris | Watertight |
|---|---|---|---|---|---|---|---|
| `Internal-Frame-v121.stl` | frame | — | 79.225 × 15.700 × 68.080 | 36 287.4 | 18 877 | 7 780 | yes |
| `Bottom-Cover-v121.stl` | cover | — | 79.225 × 7.270 × 54.243 | 16 976.5 | 9 796 | 1 702 | yes |
| `Top-Cover-Cat-v100.stl` | cover | — | 79.225 × 43.097 × 37.599 | 14 594.2 | 17 078 | 3 916 | yes |
| `Top-Cover-Enclosed-v117.stl` | cover | — | 79.225 × 38.188 × 37.384 | *n/a* | 17 061 | 3 682 | **no** |
| `Top-Cover-No-Ears-v100.stl` | cover | — | 79.225 × 33.655 × 37.384 | 13 581.2 | 16 531 | 2 864 | yes |
| `R1-v117.stl` | femur | R1 | 20.320 × 30.480 × 49.521 | 5 207.2 | 3 505 | 7 594 | yes |
| `R2-v117.stl` | femur | R2 | 20.320 × 30.480 × 49.521 | 5 190.3 | 3 524 | 7 578 | yes |
| `L1-v117.stl` | femur | L1 | 20.320 × 30.480 × 49.521 | 5 211.5 | 3 501 | 7 186 | yes |
| `L2-v117.stl` | femur | L2 | 20.320 × 30.480 × 49.521 | 5 208.7 | 3 504 | 7 666 | yes |
| `R3-v117.stl` | foot | R3 | 9.525 × 19.050 × 58.420 | 4 712.6 | 3 477 | 2 116 | yes |
| `R4-v117.stl` | foot | R4 | 9.525 × 19.050 × 58.420 | 4 698.2 | 3 494 | 1 890 | yes |
| `L3-v117.stl` | foot | L3 | 9.525 × 19.050 × 58.420 | 4 693.6 | 3 504 | 2 052 | yes |
| `L4-v117.stl` | foot | L4 | 9.525 × 19.050 × 58.420 | 4 712.7 | 3 478 | 1 826 | yes |
| `magnetic-chainsaw-hat.stl` | accessory | — | 42.781 × 30.843 × 7.341 | 2 687.6 | 1 781 | 1 108 | yes |
| `magnetic-modular-mount-hat.stl` | accessory | — | 41.125 × 4.790 × 27.285 | 2 655.4 | 2 392 | 1 744 | yes |

**Mesh-integrity finding:** `Top-Cover-Enclosed-v117.stl` — the style the print
guide *recommends* — is **not watertight**. It reports 10 disconnected bodies
and an Euler number of 9, so its volume and centre of mass could not be
computed and are `null` in the inventory. Winding is consistent and there are
no degenerate facets, so it will still slice, but any downstream tool that
needs a closed solid (physics collision meshes, mass properties, boolean ops)
must repair it first. All other 14 meshes are closed, consistently wound, and
free of degenerate facets.

---

## 2. Units

**Conclusion: millimetres. Confidence: high.** This started as an inference and
ended as a *declared* value.

STL files carry no unit, so at first this could only be argued from
plausibility. Three repo-internal checks all pointed at millimetres:

1. `hardware/bom/README.md` calls for *M2 × 5 mm self-threading* and
   *M2.5 × 5 mm machine* screws. The joint parts contain through-bores
   measuring **2.500** diameter at every servo-shaft interface and **1.738**
   at every servo mounting point. Those are an M2.5 clearance hole and an M2
   self-tapping pilot hole to three decimals *if the unit is the millimetre*,
   and nonsense in any other unit.
2. The scale is right: a 58 mm foot link on a 79 mm body is the palm-sized
   desk robot the build guide photographs. In centimetres it is a 790 mm
   machine; in inches, two metres.
3. The two servo-mount bores in every foot shell are **27.800** apart, which
   is the MG90S mounting-ear pitch. *(That pitch is a manufacturer datasheet
   figure and appears nowhere in this repository. It is recorded only as
   external corroboration, never as an input.)*

Then the CAD settled it outright. `scripts/extract-step-assembly.py` reads the
unit context out of `hardware/cad/Sesame-ESP32-v122.step`:

```
#440624 = ( LENGTH_UNIT() NAMED_UNIT(*) SI_UNIT(.MILLI.,.METRE.) )
#440623 = ( CONVERSION_BASED_UNIT('inch',#440626) LENGTH_UNIT() NAMED_UNIT(#440622) )
```

The CAD master these STLs were exported from measures length in millimetres.
That is a declared fact in the exchange file, not an inference.

### A curiosity worth recording

Nearly every *overall* dimension is an exact multiple of 1.27 mm = 0.05 inch:
bounding boxes of 20.32 / 30.48 / 49.52 and 9.525 / 19.05 / 58.42, edge
fillets of R1.27 and R6.35, plate ends of 12.70 diameter. The fastener holes,
by contrast, are exact metric sizes. The second unit declaration above
explains it: the design carries an `inch` conversion unit, and the assembly
placements come out as round inch numbers — the four hip servos sit on an
exact **1.500 × 2.000 inch (38.10 × 50.80 mm)** rectangle. Sesame was laid out
on an imperial grid and fitted with metric hardware. This changes nothing
about the millimetre conclusion; it is worth knowing because anyone who
"cleans up" these dimensions to round millimetres will break the fit.

---

## 3. What the geometry says about the kinematic structure

### 3.1 The eight joint parts are only four distinct shapes

Measured by sampling 20 000 points on one part's surface and taking the
distance to another (`partShapeGroups` in the inventory):

| Relationship | Agreement within 0.05 mm | p99 distance |
|---|---|---|
| **R1 ≡ L2** (identical solids) | 96.7 % | 0.254 |
| **R2 ≡ L1** (identical solids) | 95.1 % | 0.381 |
| **R3 ≡ L4** (identical solids) | 95.9 % | 0.254 |
| **R4 ≡ L3** (identical solids) | 95.3 % | 0.393 |
| R1 = mirror(L1) about Z = 0 | 98.1 % | 0.192 |
| R3 = mirror(L3) about Z = 0 | 95.4 % | 0.397 |

The residual few percent is the engraved part label, and the p99 distance
matches its 0.254 mm engraving depth exactly. So there are **two femur shapes
(a left-hand and a right-hand one, mirror images) and two foot shapes**, and
each is printed twice with a different label. Diagonally opposite legs use
identical parts — the robot has two-fold rotational symmetry about its
vertical axis, not just bilateral symmetry.

This is a fact F6 should encode: `R1`/`L2` and `R2`/`L1` share a kinematic
description up to a 180° rotation about the vertical, and the same for
`R3`/`L4` and `R4`/`L3`.

### 3.2 Yes, R1/R2 are geometrically distinct from R3/R4 — and the CAD names them

The two families are not variations on a theme; they are different machine
elements, and the STEP file names them from the design itself:

| Firmware name | STEP `PRODUCT` name | What it is |
|---|---|---|
| R1, R2, L1, L2 | `femur-joint-R1`, `femurjoint-R2`, `femur-joint-L1`, `femur-joint-L2` | **femur link** — a Z-shaped bracket carrying two servo-horn plates |
| R3, R4, L3, L4 | `foot-joint-R3`, `foot-joint-R4`, `foot-joint-L3`, `foot-joint-L4` | **foot link** — a C-channel that *carries* a servo, with the foot on the far end |

That is a source-of-design statement, not a reading of prose, and it agrees
exactly with the build guide's *Hip Joints* / *Leg Joints* split
(`docs/build-guide/README.md` — "Pre-load the four hip joints (R1, R2, L1, L2)
with one-sided servo horns"; "Slide each leg shell over its dedicated motor").

The geometric difference is stark:

- A **femur** is 20.3 × 30.5 × 49.5 mm, 5 200 mm³, ~7 500 triangles, and has
  *two* servo-horn interfaces whose axes are **exactly 90.0° apart** and
  **36.83 mm** apart on their common normal. It is the link between the
  body-mounted hip servo and the leg servo.
- A **foot** is 9.5 × 19.1 × 58.4 mm, 4 700 mm³, ~2 000 triangles, and has
  *no* horn interface at all. What it has instead is a pair of Ø1.738 mm
  self-tapping bores 27.800 mm apart — the two `M2 × 5 mm self-threading`
  screws that `docs/build-guide/assets/servo-install-leg.png` calls out — plus
  a large open window for the servo body.

So the chain is: **body → hip servo (vertical axis) → femur link → leg servo
(horizontal axis, bolted inside the foot link) → foot link**. Two degrees of
freedom per leg, eight servos, no closed loops. A sprawling quadruped: the hip
yaws the leg fore/aft in the horizontal plane and the knee swings the foot
up/down.

### 3.3 The STL exports share one coordinate frame, with +Y up

Checked rather than assumed. The bottom cover, internal frame and top covers
all start at the same X and stack **edge to edge along Y with zero gap and
zero overlap**:

```
bottom cover   Y ∈ [-1.002,  6.268]
internal frame Y ∈ [ 6.268, 21.968]   <- meets the cover exactly
top cover      Y ∈ [21.968, 60.156]   <- meets the frame exactly
```

That only happens if they were exported in one assembly frame, and it fixes
**+Y as up**. The joint parts share that frame's *orientation* (their measured
axes are directly comparable), and R-named parts sit at +Z with L-named parts
their exact Z-mirror, so **+Z is the "R" side**.

**But the joint parts are not at per-instance assembly positions.** The four
femur STLs occupy only *two* distinct bounding-box origins, and the four foot
STLs likewise. Four legs cannot occupy two positions. The exporter wrote one
file per unique *shape* at a representative station and then re-labelled. This
is confirmed independently: the two femur stations in the STLs are 46.03 mm
apart in Z, while the CAD hip-servo stations are 50.80 mm apart. At most one
member of each mirror pair is where it belongs.

**Which end is the front is still unknown.** Nothing measured distinguishes
fore from aft, and `sesame-angle-guide.png` is a top-down line drawing with no
front marker.

---

## 4. Pivot extraction — how confident, and why

**Result: 8 of 8 joints have a pivot candidate at `confidence: "medium"`, with
`axisConfidence: "high"` and `originConfidence: "medium"` on every one.**

That split is the honest part. The axis *line* — its direction and its
position in the plane perpendicular to itself — is measured. The position
*along* that line, which is where a rigid-body model would want to put the
joint frame, is not, because nothing in the plastic marks the servo's datum
plane.

### 4.1 How the features were found

The first approach failed and is worth recording so nobody repeats it.
Segmenting the surface into smooth patches (connected components of the
face-adjacency graph below a crease-angle threshold) is the textbook way to
isolate a cylinder. On these parts it does not work: every edge is filleted at
R1.27, so the fillets bridge every face into every other face and 4 200 of
R1's 7 594 triangles collapse into one unusable blob that swallows most of the
functional geometry.

What works is a **per-edge cylinder-axis accumulator**. For a cylinder of
radius R and axis (a, d), every face is tangent, so a face centroid p with
unit normal n satisfies `p_perp = a_perp + sR·n`. Two adjacent tangent faces
therefore give

```
(p_i - p_j) · n_i  =  sR · (1 - n_i · n_j)
```

which solves directly for the signed radius (its sign separates holes from
bosses), and then `a = p_i - sR·n_i` lands on the axis, with `d = n_i × n_j`.
Every smoothly-creased face pair casts one such vote; the votes are clustered
in a 7-D space of (direction, axis point, radius, sign) with a KD-tree and
union-find; each cluster is then refit with a least-squares circle over only
the vertices that actually lie on it. Because it works per edge, it is immune
to what the surrounding surface is blended into.

Coaxial clusters are then merged into *axis groups*, which is what makes the
result trustworthy: a lone shallow arc is a fillet, but three concentric
turned features sharing one axis are a designed interface.

### 4.2 The femur pivots — a three-part coaxial signature

Each femur carries two axis groups with an unmistakable signature. For `R1`:

| Axis group | Axis | Members | Reading |
|---|---|---|---|
| proximal | `[0, 1, 0]` at (1.5233, ·, 23.0168) | boss R6.350 + hole R4.004 (2.29 deep) + hole R1.250 | Ø12.70 rounded plate end, Ø8.008 horn-hub bore, Ø2.500 M2.5 screw bore |
| distal | `[1, 0, 0]` at (·, 15.2278, 59.8468) | boss R6.350 (3.56 long) + hole R1.250 | Ø12.70 rounded plate end, Ø2.500 M2.5 screw bore |

The Ø2.500 bore is the M2.5 machine screw the BOM reserves for "servo horn
attachment to servo shafts only". The Ø12.70 rounded end is the arc the plate
was swept about, so the pivot is at its centre *by construction* — and the
bore is exactly concentric with it. A second Ø2.500 bore sits 11.43 mm inboard
on each plate; that is the horn's retention screw, not the shaft, and it is
correctly excluded because it has neither a rounded end nor a hub bore.

The proximal axis is `[0,1,0]` — vertical — which matches
`docs/build-guide/assets/install-frame-motors.png`, where all four hip servos
are screwed to the internal frame with their output shafts pointing straight
up. The distal axis is horizontal and perpendicular to it, to 90.0°.

All four femurs give the identical result, mirrored in Z as expected.

One oddity, recorded so it does not look like a bug: the `screwBore` members
report a `length` of only 0.03–0.12 mm. The horn-hub counterbore is modelled
almost exactly flush with the plate's outer face, leaving a sub-0.15 mm web,
so only a thin band of the Ø2.500 bore wall is actually cylindrical. The bore
is a genuine through-passage — checked by testing points along the axis for
containment in the solid, none of which are inside — and its axis and radius
are unaffected.

### 4.3 The foot pivots — recovered cross-part, which is why they are only medium

A foot link is a servo *carrier*. Its own rotation axis is the output shaft of
the servo bolted inside it, and that shaft protrudes clear of the plastic, so
**the foot mesh contains no shaft feature at all**. Measured in isolation, the
honest answer for R3/R4/L3/L4 would be `confidence: "none"`.

Two independent measurements rescue it:

- Each foot shell has two Ø1.738 mm bores, coaxial in X, **27.800 mm** apart,
  both at exactly `y = 15.2278`. These are the servo's mounting-ear screws.
- Each femur's *distal* horn axis is a line along X at exactly `y = 15.2278`,
  and it crosses the foot shell's bore centre-line **5.15 mm** from its
  midpoint — which is where an MG90S output shaft sits relative to its
  mounting ears.

Two parts measured separately, in a frame that was itself verified separately,
agreeing to the fourth decimal on a coordinate that is not either part's
centre. That is real evidence, so the foot pivots are recorded at `medium`,
with the derivation spelled out in `method` and the mate ambiguity flagged.

**The ambiguity:** because mirror-identical shapes were exported at the same
station, each foot matches *two* femurs geometrically (R3 matches both R1 and
L2). Geometry alone proves which femur *shape* mates with which foot *shape*;
it cannot name the instance. `docs/build-guide/assets/reference-configuration.png`
resolves it — see §6.

### 4.4 What is deliberately **not** claimed

- **No joint zero, no direction sign, no travel limits.** Geometry gives an
  axis. A zero is a calibration fact and a sign is a firmware fact.
- **No joint centre.** `origin` is a point on the correct line. Where the
  servo's reference plane falls along that line is not in the plastic.
- **No assembly poses in the STL frame.** See §3.3.

---

## 5. What the build guide and CAD corroborate

| Claim from geometry | Independent corroboration |
|---|---|
| R1/R2/L1/L2 are hip/femur links; R3/R4/L3/L4 are leg/foot links | STEP `PRODUCT` names `femur-joint-*` / `foot-joint-*`; build guide *Hip Joints* / *Leg Joints* sections |
| Femur pivot axis is vertical | `install-frame-motors.png` — four servos on the frame, shafts up |
| Femur has a second, horizontal horn interface | `joints-preassem.png`, `femur-joints.png` — the L-shaped bracket with a plate at each end |
| Foot link carries its servo on two M2 screws, shaft protruding | `servo-install-leg.png` — "(2×) M2 × 5mm self-threading", "the motor gear should be at the top of the foot" |
| Ø2.500 bore is the shaft screw | BOM: "M2.5 × 5mm machine screws — servo horn attachment to servo shafts only" |
| Ø1.738 bores are the servo mounts | BOM: "M2 × 5 mm self-threading screws — … motor mounts …" |
| Unit is millimetre | STEP `SI_UNIT(.MILLI.,.METRE.)` |
| Imperial layout grid | STEP `CONVERSION_BASED_UNIT('inch')`; hip servos on an exact 1.5 × 2.0 in grid |

One further corroboration, which belongs to F4 but was found here:
`docs/build-guide/assets/sesame-angle-guide.png` labels each joint with its
motor index, and reads **00=R1, 01=R2, 02=L1, 03=L2, 04=R4, 05=R3, 06=L3,
07=L4**. That is the firmware order `R1,R2,L1,L2,R4,R3,L3,L4` the plan calls
out, confirmed from the build documentation as well as from source. The same
diagram gives the pose angles (hips 45°/90°/135°/180° in the horizontal plane;
feet 0° or 180° = straight down, 90° = horizontal), and notes that R3/L4 use
one angular convention and L3/R4 the other — exactly the shape pairing
measured in §3.1.

---

## 6. Recommendation for F6

F6 should treat this inventory as the geometric input and the firmware
extraction (F4) as the semantic input, and keep the two clearly separated.

1. **Take the axis directions from here, at `verified: false`.**
   In the shared STL frame (+Y up, +Z toward the "R" side):
   - femur / hip joints `R1 R2 L1 L2` → rotation axis `[0, 1, 0]` (yaw)
   - foot / knee joints `R3 R4 L3 L4` → rotation axis `[1, 0, 0]` (pitch)
   These are high-confidence measurements and are safe to serialise, provided
   the frame convention is serialised with them.

2. **Take `36.83 mm` as the femur link's axis-to-axis offset** and `90.0°` as
   the twist between its two axes. Both are measured. Foot reach from the knee
   axis to the far end of the foot shell is 47.06 mm from the bounding box —
   that is a *reach*, not a contact point, and should be labelled as such.

3. **Do not copy `origin` into a kinematic model as a joint centre.** Use the
   axis line; leave the along-axis placement to be pinned later. Encode this
   in the type system if possible: an axis with a point-on-line is a different
   thing from a fully-located frame.

4. **Read the hip↔foot pairing off
   `docs/build-guide/assets/reference-configuration.png`** — the assembled top
   view labels all eight parts and shows R1↔R3, R2↔R4, L1↔L3, L2↔L4. Mark it
   `"verified": false`. Geometry alone cannot pick between R1 and L2 as R3's
   mate (§4.3) and should not pretend to.

5. **Keep `semanticName` optional and unverified**, as the plan already
   requires. This work supports "R1 is a femur/hip joint" with high confidence
   (the CAD says so) but supports *nothing* about front versus rear, so
   `right_front_hip` is still unearned. What can be said now, and could not
   before, is that R1/L2 and R2/L1 are the same part — so whatever front/rear
   assignment is eventually made must be consistent with diagonal symmetry.

6. **Carry the two-shape finding into the model.** Only four distinct link
   geometries exist. A joint map that stores eight independent link
   descriptions will drift; one that stores four shapes plus eight placements
   will not.

### Still needed before any of this is authoritative

| Gap | What would close it |
|---|---|
| Servo datum plane along each pivot axis | an MG90S CAD model, or measuring a built robot |
| STL-frame ↔ CAD-frame mapping (one exact correspondence found, Z sign inverted; one sample is not a proof) | evaluate the STEP B-Rep with pythonocc/FreeCAD and compare per-instance bounding boxes |
| Per-instance assembly poses in the STL frame | as above — the CAD poses exist and are recorded, the mapping does not |
| Joint zero, direction sign, travel limits | F4 firmware extraction + the calibration procedure in the build guide |
| Front/rear orientation | physical inspection |
| Hip↔foot instance naming | `reference-configuration.png`, then physical confirmation |
| `Top-Cover-Enclosed-v117.stl` is not watertight | mesh repair before any physics/collision use |

All seven are in `unresolved[]` in the inventory with the same wording, so a
machine reader sees the same list a human does.

---

## 7. Reproducing this

```powershell
pwsh -File scripts/setup-asset-env.ps1        # or: bash scripts/setup-asset-env.sh
tools/py-assets/.venv/Scripts/python.exe scripts/extract-stl-geometry.py `
  --stl-dir reference/sesame-robot-main/hardware/printing/stl `
  --cad-dir reference/sesame-robot-main/hardware/cad `
  --repo-root . --out hardware/assets-inventory.json
```

The run takes about 25 s, validates its own output against
`hardware/assets-inventory.schema.json`, and is **deterministic**: two runs
with `--generated-at <fixed>` produce byte-identical files (verified). Without
that flag the only difference is `meta.generatedAt`. Nothing under
`reference/` is written to, and nothing is installed outside
`tools/py-assets/` (gitignored).

Useful extras:

```bash
# every recovered feature and coaxial group for one part
… scripts/extract-stl-geometry.py --stl-dir <dir> --dump-features R1-v117.stl

# CAD unit context, assembly tree and the eight joint poses
… scripts/extract-step-assembly.py reference/sesame-robot-main/hardware/cad/Sesame-ESP32-v122.step
```

**Note for the orchestrator:** `tools/` is gitignored in its entirety, so
`tools/py-assets/requirements.txt` will not be committed. The pins are
therefore embedded in `scripts/setup-asset-env.ps1` and `.sh`, which *are*
tracked and which rewrite that file on every run. If you would rather track
the requirements file directly, `.gitignore` needs a re-inclusion rule
(`tools/*` + `!tools/py-assets/` + `tools/py-assets/*` +
`!tools/py-assets/requirements.txt`); I did not make that change unilaterally.

### Tool versions used

`python 3.13.13` · `trimesh 4.12.2` · `numpy 2.5.2` · `scipy 1.18.1` ·
`numpy-stl 3.2.0` · `rtree 1.4.1` · `jsonschema 4.26.0` — all pinned in
`tools/py-assets/requirements.txt` and recorded in `meta.toolVersions`.

The `.f3z` was opened as a zip (21 entries, proprietary binary Fusion
documents). No open parser exists for them, so no component names, joints or
units were recovered from it — everything the CAD contributed here came from
the STEP file.
