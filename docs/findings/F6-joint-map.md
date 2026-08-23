# F6 — Joint map and the `sesame-model` package

**Task:** Phase 0 · Workstream F · F6
**Agent:** `asset-pipeline`
**Date:** 2026-08-23
**Depends on:** F4 (`hardware/hardware-map.json`), F5 (`hardware/assets-inventory.json`)
**Machine-readable output:** [`hardware/joint-map.json`](../../hardware/joint-map.json) (+ [`joint-map.schema.json`](../../hardware/joint-map.schema.json))
**Code:** [`packages/sesame-model`](../../packages/sesame-model) — `@sesame-lab/sesame-model`
**Regenerate:** `pnpm build:joint-map` · **Validate:** `pnpm validate:joint-map`

> **Nothing in this document or in `joint-map.json` has been checked against a
> physical robot.** Every spatial name carries `"verified": false`. The three
> epistemic classes below are kept apart in the prose, in the JSON (`status`),
> and in the TypeScript types — where a guess is *structurally* unable to
> masquerade as a fact.

---

## 1. The three columns

Everything in the joint map is exactly one of these, and the distinction is
machine-readable via each field's `status`:

| Class | Means | Where it comes from | How many fields |
|---|---|---|---|
| **authoritative** | Read out of firmware source or the STEP file. If this is wrong, the firmware is wrong. | `firmware/movement-sequences.h`, `firmware/sesame-firmware-main.ino`, `hardware/cad/Sesame-ESP32-v122.step` | `firmwareName`, `firmwareIndex`, `kind`, `pinsByBoard`, `angleLimitsDeg` |
| **inferred** | Derived, with a stated method and confidence. Reproducible from the inputs. | mesh fitting (F5), statistical analysis of the 395-step choreography corpus (F4) | `rotationAxis`, `pivotOrigin`, `shapeEquivalenceClass`, `zeroReferenceDeg`, `directionSign`, `observedRangeDeg`, foot `parentLink` |
| **guessed** | `verified: false`, with a basis and an explicit list of what would settle it. | two labelled drawings in the upstream repository | `semanticName` — and nothing else |

The rule the research report is emphatic about is enforced, not merely
documented: **`firmwareName` plus `firmwareIndex` is the only authoritative
identity of a joint.** `semanticName` is optional in the type, and its
`verified` property is the *literal* `false`, so there is no verified variant
of the type to write code against.

---

## 2. The eight joints

`kind`, `index` and `pin` are authoritative. `axis`, `sign`, `neutral` and the
observed range are inferred. `semantic guess` is guessed.

| # | fw name | kind (STEP) | pin (S2) | shape class | axis | parent | sign | rest° | stand° | observed° | body-rel° | n | semantic guess |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 0 | **R1** | femur | 1 | femur-A | `[0,1,0]` | internal-frame | +1 | 90 | 135 | 90–180 | 0…+90 | 23 | `right_front_hip` |
| 1 | **R2** | femur | 2 | femur-B | `[0,1,0]` | internal-frame | −1 | 90 | 45 | 0–100 | −10…+90 | 22 | `right_rear_hip` |
| 2 | **L1** | femur | 4 | femur-B | `[0,1,0]` | internal-frame | −1 | 90 | 45 | 0–90 | 0…+90 | 23 | `left_front_hip` |
| 3 | **L2** | femur | 6 | femur-A | `[0,1,0]` | internal-frame | +1 | 90 | 135 | 90–180 | 0…+90 | 22 | `left_rear_hip` |
| 4 | **R4** | foot | 8 | foot-B | `[1,0,0]` | R2 | −1 | 90 | 0 | 0–180 | −90…+90 | 32 | `right_rear_knee` |
| 5 | **R3** | foot | 10 | foot-A | `[1,0,0]` | R1 | +1 | 90 | 180 | 0–180 | −90…+90 | 35 | `right_front_knee` |
| 6 | **L3** | foot | 13 | foot-B | `[1,0,0]` | L1 | −1 | 90 | 0 | 0–180 | −90…+90 | 36 | `left_front_knee` |
| 7 | **L4** | foot | 14 | foot-A | `[1,0,0]` | L2 | +1 | 90 | 180 | 0–180 | −90…+90 | 30 | `left_rear_knee` |

Axes are in F5's STL assembly frame (+Y up, +Z the "R" side, fore/aft sign
unknown). Pivot origins are in the JSON; they are **points on the correct line,
not joint centres**, and the schema refuses any entry whose caveat has lost
those words.

`angleLimitsDeg` is `{0, 180}` on all eight — the firmware clamp
`constrain(angle + servoSubtrim[channel], 0, 180)` at
`sesame-firmware-main.ino:1053`. `mechanicalLimitsDeg` is `null` on all eight
and the validator forbids filling it in.

Femurs additionally carry `linkGeometry`: the two horn axes are **90.0° apart**
with a **36.83 mm** common-normal offset (measured, F5).

---

## 3. The choreography analysis — what 395 real steps actually say

This is the genuinely new evidence F6 contributes, and it is worth separating
from the guessing.

`hardware-map.json` carries 21 movement functions and **395 steps**, of which
**223 are `setServoAngle()` calls with literal integer angles** (recursing into
`repeat` and `conditional` blocks; no angle anywhere is computed at runtime, so
the analysis is exact rather than sampled). The generator computes every
statistic in the map from that corpus, and the validator recomputes and
compares them — the numbers are evidence, so they must be reproducible.

### 3.1 Per-joint distribution

| joint | commanded angles (count) | distinct | median |
|---|---|---|---|
| R1 | 90×8 100×1 135×6 180×8 | 4 | 135 |
| R2 | 0×4 20×1 45×6 90×9 100×2 | 5 | 67.5 |
| L1 | 0×8 25×2 45×5 90×8 | 4 | 45 |
| L2 | 90×11 135×6 160×1 180×4 | 4 | 112.5 |
| R4 | 0×9 45×7 80×2 90×6 115×1 135×2 160×2 180×3 | 8 | 62.5 |
| R3 | 0×4 25×1 45×1 90×9 115×1 135×7 160×2 170×1 180×9 | 9 | 135 |
| L3 | 0×8 10×2 45×8 65×1 90×9 100×1 135×1 145×1 180×5 | 9 | 55 |
| L4 | 0×3 10×2 45×2 65×1 90×5 135×8 180×9 | 7 | 135 |

### 3.2 What that shows

1. **Hips use only half the clamp, and always the same half per shape class.**
   R1 and L2 live in `[90, 180]`; L1 in `[0, 90]`; R2 in `[0, 100]`. Feet use
   the whole clamp — all four are commanded at both 0 and 180.
2. **The two halves are the same motion written in two conventions.** Under
   `bodyRelativeDeg = (commandedDeg − 90) × sign`, with `sign = +1` for
   `{R1, L2, R3, L4}` and `−1` for `{R2, L1, R4, L3}`, every hip lands in
   `[−10, +90]` and every foot in `[−90, +90]`, and 88 of 90 hip steps are at
   or above 0 (the two exceptions are one `R2 = 100°` used twice in
   `runPointPose`).
3. **Whole poses collapse to a single number.** `runRestPose` → 0 on all eight.
   `runStandPose` → **+45 on every hip and +90 on every foot**. `runShrugPose`
   → −90 on every foot. `runDeadPose` → 0 on every foot. `runSwimPose` and
   `runCrabPose` → 0 on every hip. That is six of 21 functions becoming
   uniform under one two-parameter transform that was not fitted to them.
4. **Those sign classes are exactly F5's shape classes.** `{R1, L2}` and
   `{R2, L1}` are the pairs F5 measured to be the *same printed solid*; the same
   for `{R3, L4}` and `{R4, L3}`. Identical solids installed at diagonally
   opposite corners must take opposite angular conventions from their mirror
   counterparts, and the firmware behaves exactly as if they do.
5. **Two orthogonal groupings appear, matching the two body axes.** The
   expressive poses move hips by trailing digit — `runShakePose` sets
   `R1 = L1 = 45°` and `R2 = L2 = 0°`, `runCutePose` sets `R1 = L1 = 90°` and
   `R2 = L2 = 70°` — while the gaits move them by leading letter:
   `runWalkPose` drives `{R1, R2}` against `{L1, L2}`, and `runWalkBackward` is
   its mirror. Digit = front/rear, letter = left/right, from firmware alone.
6. **The choreography is written on a 45° grid.** Only 15 distinct angles occur
   across all 223 steps, and 0/45/90/135/180 account for 198 of them (88.8 %).

**What this is evidence of, and what it is not.** It is strong evidence about
*intent*: what the firmware authors are willing to command, and therefore
believe is safe and collision-free. It is *no* evidence about mechanism — not
about what the printed linkage can reach, and not about where a joint actually
ends up. Every derived field is labelled `status: "inferred"` with that method,
and `mechanicalLimitsDeg` stays `null`.

### 3.3 Zero reference and direction sign

`zeroReferenceDeg = 90` on all eight, **inferred**, from four independent
places:

- `runRestPose` commands all eight to 90 with a single loop
  (`movement-sequences.h:74`) — the only pose the firmware treats as uniform.
- The calibration procedure commands every motor to 90° with **no horn
  attached**, before any joint is fitted (`docs/build-guide/README.md`,
  "Calibrating & Running the Testing Firmware" step 4). That makes 90° the
  mechanical assembly datum by construction.
- `servoSubtrim[]` defaults to all zeros (`sesame-firmware-main.ino:113`), so
  on an untrimmed robot the commanded value *is* the datum value.
- `sesame-angle-guide.png` draws 90° as the shared hinge of both hip
  conventions and as "foot horizontal" for both foot conventions.

`directionSign` is **relative, not absolute**. What the evidence supports is
that the two classes are opposite; which one is counter-clockwise about the
stated `rotationAxis` is *not* established, and flipping all eight at once
would be equally consistent with everything measured. The JSON says so in each
entry's `caveat`.

Under the chosen convention, positive means: for a hip, the leg swings away
from lateral in its own outboard fore/aft direction (front legs forward, rear
legs rearward); for a foot, the foot swings from horizontal toward straight
down. `runStandPose` then reads as all four legs splayed 45° outward with all
four feet planted — which is what a stand pose should look like.

---

## 4. What the images resolved, and what they did not

Three upstream artefacts were read directly. All three are drawings, so
everything taken from them is `verified: false`.

### `software/sesame-studio/sesame-topdown.png` — **resolved fore/aft**

A labelled top-down line drawing of the assembled robot with the literal words
**FRONT** at the top edge and **BACK** at the bottom. Layout read from it:

```text
                     FRONT
   L3 ──┬── L1 ┐             ┌ R1 ──┬── R3
        │      │   [chassis] │      │
   L4 ──┴── L2 ┘             └ R2 ──┴── R4
                     BACK
```

This is the artefact F5 said was needed, and it closes F5's open item
`front-rear-orientation` at the level of a document reading. It gives: R1/L1 at
the front, R2/L2 at the rear, R3/L3 at the front, R4/L4 at the rear, all
L-parts on the image's left and all R-parts on the image's right.

**It did not resolve** whether the view is from above or below (which decides
whether image-left is the robot's left), whether "R"/"L" mean the robot's own
sides or a viewer's, or whether the FRONT it marks is the direction the `walk`
command actually travels. The build guide adds a physical cue — *"Notch =
front. USB port = back."* (`docs/build-guide/README.md:168`) — which fixes the
body's front for a builder but still says nothing about gait direction.

### `docs/build-guide/assets/reference-configuration.png` — **resolved the hip↔foot pairing**

The assembled top view in the build guide, same layout, all eight parts
labelled. It shows **R1↔R3, R2↔R4, L1↔L3, L2↔L4**, closing F5's
`hip-to-foot-instance-naming` at document level. F5 could prove which femur
*shape* mates with which foot *shape* but not which instance, because
mirror-identical parts were exported at the same station.

Independent corroboration from firmware: the femur and foot of a leg always
fall in the same direction-sign class, and `runStandPose` pairs
`R1 = 135°` with `R3 = 180°` and `R2 = 45°` with `R4 = 0°`.

Incidental observation, recorded because it looks like a rendering bug and is
not: the `L3` and `L4` labels appear **mirrored** in this render. That is
consistent with F5's finding that the L-parts are Z-mirrors of the R-parts with
the engraving on the opposite face.

### `docs/build-guide/assets/sesame-angle-guide.png` — **resolved the angle conventions**

A three-quarter view, not a top-down one (F5 described it as top-down; that is
a small correction). It labels each joint with its motor index — **00=R1,
01=R2, 02=L1, 03=L2, 04=R4, 05=R3, 06=L3, 07=L4** — reconfirming the firmware
order from documentation, and draws each joint's angular sweep:

- hips **R1, L2**: rays at 90° / 135° / 180°;
- hips **R2, L1**: rays at 90° / 45° / 0°;
- feet: one vertical ray and one horizontal ray per joint, with the caption
  **"VERTICAL ANGLES REPRESENT STRAIGHT DOWN"** — 180° for R3/L4, 0° for R4/L3.

Those are exactly the ranges the choreography uses and exactly the sign classes
derived from it, from a completely independent source.

**It did not resolve** the absolute rotational sense about each axis, and it
produced one contradiction, now tracked: the guide draws each hip's 90° ray
pointing **laterally outward**, while the build guide's prose says that at Rest
"the hip joint should move perfectly parallel to the body"
(`README.md:209`). Both cannot describe the same feature. The likeliest
reconciliation is that the prose describes the horn plate and the diagram the
leg direction — but that is a guess, and it is recorded as the open item
`rest-pose-hip-orientation-contradiction` rather than smoothed over.

---

## 5. What is still not determinable without the physical robot

This is the Phase-1 verification task list. It is also, verbatim, the
`wouldBeConfirmedBy` array on every `semanticName` plus the `unresolved[]`
entries, so a machine reader sees the same list.

| # | Open question | Blocks | What settles it |
|---|---|---|---|
| 1 | Is `sesame-topdown.png` a view from **above** or below? | every left/right assignment inverts if it is a bottom view | Hold a built robot with the notch facing away and read the engraved labels. |
| 2 | Do "R"/"L" mean the **robot's** left and right, or a viewer's? | same | Same inspection. No repository text states it. |
| 3 | Is the drawing's FRONT the direction `walk` **travels**? | whether `*_front_*` means leading edge or merely OLED-facing | Run `walk` on a built robot and watch which end leads. |
| 4 | Are the eight parts installed where the drawings show? | the whole `semanticName` mapping | Physical inspection. F5 measured R1≡L2, R2≡L1, R3≡L4, R4≡L3 as identical solids, so two parts can be physically swapped and neither the firmware nor the geometry would notice. |
| 5 | Where along each pivot axis is the **servo datum plane**? | turning `pivotOrigin` into a kinematic frame origin | An MG90S CAD model, a STEP B-Rep evaluation, or calliper measurement of a built robot. |
| 6 | What is the **STL-frame ↔ CAD-frame** mapping? | per-instance assembly poses; a correct articulated GLB | Evaluate the STEP B-Rep with pythonocc/FreeCAD and compare per-instance bounding boxes. One sample currently matches to six digits with the Z sign inverted; one sample is not a proof. |
| 7 | What is the **absolute rotational sense** of each axis? | the sign of every animated rotation in the viewer | Command one joint from 90° to 135° on a built robot and watch which way it turns. |
| 8 | What are the **mechanical travel limits**? | collision-free pose generation beyond the shipped choreography | Sweep each joint on a built robot, or run a collision study on repaired meshes. |
| 9 | Does Rest put the hip **parallel** or **perpendicular** to the body? | the geometric meaning of the 90° datum | One photograph of a robot at Rest. |
| 10 | What **subtrim** does a given robot need? | per-robot accuracy | Per-robot calibration. Deliberately *not* part of `joint-map.json`: the horn is pressed onto a splined shaft, so the commanded→physical mapping is quantised (±9° worst case on an MG90S's 20-tooth spline) and differs per build. `servoSubtrim[]` exists for exactly this, defaults to zeros, and is never persisted by the stock firmware. |

Items 1–4 are cheap: one built robot, ten minutes, and eight of the eight
`semanticName` entries could flip to verified. Items 5–8 need instrumentation
or CAD work. Item 10 belongs in a separate per-robot calibration artefact and
should never be merged into the joint map.

**A precise "cannot determine without hardware" is the deliverable here.** No
value in `joint-map.json` was invented to fill a gap: where something is
unknown it is `null` and listed in `unresolved[]`, and where something is a
reading of a drawing it says so and names what would confirm it.

---

## 6. `hardware/joint-map.json`

Top-level shape:

```text
meta                      schema/joint-map version, generatedAt, six sources with SHA-256,
                          the epistemic contract, verification status, consumers
conventions               units, the STL frame (+ its caveats), the authoritative 0–180
                          commanded-angle domain, the inferred body-relative formula
shapeEquivalenceClasses   four classes, eight members, diagonal pairing, F5's evidence
choreographyAnalysis      the 21/395/223 corpus, method, six findings, caveat
joints[8]                 in firmware order — see §2
unresolved[9]             F5's six carried forward (three now partially resolved)
                          + three new from F6
```

Validation is three-layer, in `scripts/validate-joint-map.mjs`
(`pnpm validate:joint-map`):

1. **JSON Schema** (draft 2020-12, ajv strict, `additionalProperties: false`
   everywhere). The schema pins `semanticName.verified` to the constant
   `false`, requires the string `NOT THE JOINT CENTRE` in every
   `pivotOrigin.caveat` and `NOT MEASURED` in every `zeroReferenceDeg.caveat`,
   and constrains `semanticName.value` to
   `^(left|right)_(front|rear)_(hip|knee)$`.
2. **Cross-checks against F4 and F5.** Every pin, index, provenance pointer,
   STL SHA-256, pivot axis, pivot origin and confidence must still match its
   upstream artefact, and **every choreography statistic is recomputed from
   `hardware-map.json` and compared**, including each joint's full histogram.
   Source SHA-256s are re-hashed against disk.
3. **Epistemic invariants.** Every `semanticName` carries `verified: false`
   with a non-empty basis and a confirmation route; `rotationAxis` may not
   claim `authoritative`; `mechanicalLimitsDeg` must stay `null`; the femur/foot
   graph must be a bijection; direction signs must be constant within a shape
   class and opposite between mirror classes; and the whole document is scanned
   for a stray `"verified": true`.

The generator (`scripts/build-joint-map.mjs`, `pnpm build:joint-map`) is
deterministic: two runs with the same `--generated-at` produce byte-identical
output.

---

## 7. `packages/sesame-model`

`@sesame-lab/sesame-model`, in the pnpm workspace, strict TS, builds with `tsc`
to `dist/` with declarations. 53 Vitest tests, all passing.

**Exports.** `.` is environment-agnostic (no `node:*` imports, browser-safe);
`./node` adds the filesystem loader.

- `JointName` — the union, written in firmware order.
- `JOINT_ORDER` — `readonly ["R1","R2","L1","L2","R4","R3","L3","L4"]`, with a
  compile-time exhaustiveness proof against `JointName`.
- `jointIndex()` / `jointAtIndex()` / `isJointName()`.
- `RobotState`, `JointState`, `FaceState`, `NetworkState`, `MotionState`,
  `SesameCapabilities` — the report's shapes.
- `JointMap` and its sub-types, `parseJointMap()`, `JointMapView`,
  `JointMapValidationError`.
- `loadJointMap()` (from `/node`) — reads `dist/joint-map.json` if the package
  was built, else the repository's `hardware/joint-map.json`, and validates it.

### The `JOINT_ORDER` regression guard

`src/__tests__/joint-order.test.ts` asserts the tuple is *exactly*
`["R1","R2","L1","L2","R4","R3","L3","L4"]`, that it is **not** the alphabetical
sort, **not** `R1..R4,L1..L4`, **not** interleaved by side, and that indices 4
and 5 are `R4` then `R3`. The runtime validator rejects a re-sorted `joints[]`
array with the same message. The order looks like a typo and is not: it is the
wiring order, confirmed from `movement-sequences.h:5` and independently from
the `00`–`07` labels on the build guide's angle diagram. Alphabetising it
silently rewires four of the eight servos.

### The guess barrier

```ts
export interface UnverifiedSemanticName {
  readonly value: string;
  readonly verified: false;      // literal — there is no verified variant
  readonly basis: string;
  readonly basisPoints: readonly string[];
  readonly wouldBeConfirmedBy: readonly string[];
  // …
}
```

Four things make it awkward to treat a guess as fact:

1. `semanticName` is `UnverifiedSemanticName | undefined`, never a `string`.
   `const s: string = entry.semanticName` is a compile error, asserted with
   `@ts-expect-error` in the tests.
2. `verified` is the literal `false`. `Extract<UnverifiedSemanticName, {verified: true}>`
   is `never`, proven at compile time in the test suite — there is no
   "it's confirmed" branch to write.
3. The string can only be extracted through
   `readGuessedSemanticName(name, SEMANTIC_NAME_IS_A_GUESS)`, whose required
   token makes the call site read as an admission. Passing anything else throws.
4. `JointMapView` exposes no accessor returning a spatial name as a string.
   `labelFor()` returns the firmware name; `semanticGuessFor()` returns the
   record.

The runtime validator rejects a bare string, `verified: true`, and a guess with
an empty basis.

### `measuredDeg`, and the sensing the robot does not have

`JointState.measuredDeg` is typed `number | null | undefined` and documented as
the sensor value — with the point stated in the type's own doc comment: **the
stock Sesame robot has no joint position feedback.** Eight MG90S servos driven
by one-way PWM; no encoder, no potentiometer tap, no current sense, no firmware
path that could report a real angle. On `mode: "real"` the field is `null`
("asked, and unknowable") or absent, and it is never filled from
`commandedDeg`. `HAS_JOINT_POSITION_FEEDBACK` is exported as `false` so code
that branches on it reads as a statement about hardware rather than a magic
literal. `SesameCapabilities` deliberately has **no** `jointFeedback` flag: a
flag that no backend can set is an invitation to set it. A UI that draws
`measuredDeg` as observed would be teaching the learner something false about
the machine, so the model makes that hard to do by accident.

---

## 8. Corrections to earlier findings

Recorded as the plan requires, rather than smoothed over.

| Claim | Correction |
|---|---|
| F5 §5: "`sesame-angle-guide.png` is a top-down line drawing with no front marker" | It is a three-quarter view, not top-down. The "no front marker" part is right. The artefact that *does* carry a front marker is `software/sesame-studio/sesame-topdown.png`. |
| F5 unresolved `front-rear-orientation.resolvedBy`: "docs/images/sesame-topdown.png" | The file is at `software/sesame-studio/sesame-topdown.png`; there is no `docs/images/`. |
| F5 §4.4: "no joint zero, no direction sign, no travel limits" | Still true as a statement about *geometry*. F6 derives a zero and a sign from firmware and documentation instead, at `status: "inferred"`. Travel limits remain genuinely unknown. |
| F5 §6.2: "Foot reach from the knee axis to the far end of the foot shell is 47.06 mm" | Not carried into `joint-map.json`. It is a bounding-box reach, not a contact point, and the joint map has no field it could honestly occupy. |

---

## 9. Reproducing this

```powershell
pnpm install
pnpm build:joint-map          # regenerates hardware/joint-map.json
pnpm validate:joint-map       # schema + F4/F5 cross-checks + epistemic invariants
pnpm -r build                 # tsc -> packages/sesame-model/dist
pnpm -r test                  # 53 vitest tests
```

Nothing under `reference/` or `firmware/upstream/` was written to. The only
dependency added is `vitest` (plus `@types/node`) in
`packages/sesame-model`; no existing dependency was changed.
