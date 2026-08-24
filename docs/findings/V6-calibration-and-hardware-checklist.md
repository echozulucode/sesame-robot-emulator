# V6 — the calibration layer

**Task:** Phase 1 · V6 · `docs/plans/phase-1-virtual-mvp.md` §3 — the final Phase 1 task
**Agent:** `calibration`
**Date:** 2026-08-23
**Depends on:** V0 (`hardware/assembly-map.json`), F6 (`hardware/joint-map.json` v1.1.0), V1, V2, V3/V4
**Companion:** [`V6-hardware-verification-checklist.md`](V6-hardware-verification-checklist.md) — the ordered script

**Artefacts:** [`hardware/calibration.json`](../../hardware/calibration.json) · [`calibration.schema.json`](../../hardware/calibration.schema.json)
**Generate:** `pnpm build:calibration` · **Validate:** `pnpm validate:calibration`
**Code:** `packages/sesame-model/src/calibration.ts` (+ `loadCalibration()` in `/node`)

> **Nothing here has been measured.** All 81 hardware-gated fields carry
> `measured: false`. The document exists so that the day one of them *is*
> measured, it is a JSON edit and a validator run — not a change in three
> packages.

---

## 1. Result in one paragraph

Eighty-one values across the codebase were guesses, datasheet figures, design
intent or explicitly-reasoned simulation choices dressed as constants. They are
now one document — `hardware/calibration.json` — that **layers over**
`hardware/joint-map.json` rather than forking it, is validated by five layers of
checks, is loadable and overridable at run time (`$SESAME_CALIBRATION`,
`applyCalibrationOverride()`), defaults to *exactly* today's values so nothing
changes behaviour, and cannot be edited into a lie: **a carried-forward value
may not differ from the design value it layers over, and a value can only differ
by being marked `measured: true`, which requires a timestamp, an operator, an
instrument, a procedure step and — the expensive one — a robot serial.** The
guess barrier that Phase 0 built around `semanticName` is extended to all of it,
including the one honest promotion path: a *measured* `partIdentity` is the only
thing that can turn a spatial name from a guess into a fact, and it does so
through `CalibrationView.semanticNameFor()` without touching `joint-map.json`.
The companion checklist prices the whole verification at **10 h 15 min**, of
which **4 h 25 min needs no robot at all** — just a bare ESP32-S2, one loose
servo and an OLED module.

---

## 2. Part 1 — the audit

Every hardware-gated value found by sweeping `packages/`, `apps/`, `emulator/`,
`hardware/` and `assets/`. "Consumers" lists what would have to change if the
value changed *before* V6.

### 2.1 Now runtime-swappable (81 fields)

| # | Value | Current source | Epistemic status | Consumers | Settled by |
|---|---|---|---|---|---|
| 1 | `semanticName` × 8 → `partIdentity` × 8 | V0 CAD placement | **guessed** (`verified:false`) | `joint-map.json`, GLB `extras.semanticNameAlias`, `apps/web` JointInspector | **V6-02** — read the engravings |
| 2 | `directionSign` × 8 (bookkeeping) | F6, 223-step corpus | inferred | `joint-map.json`, `JointMapView.toBodyRelativeDeg`, `sesame-sim` pose tests | V6-18 |
| 3 | `rotationSenseSign` × 8 (physical) | V0 exact fit to CAD horn occurrences | inferred | `assembly-map.json`, `joint-map.json`, **`assets/sesame.glb` `extras.signPerCommandedDeg` (baked)**, `apps/web/src/three/rig.ts` | V6-18 |
| 4 | `zeroReferenceDeg` × 8 | F6, four documentary sources | inferred | `joint-map.json`, `JointMapView`, **GLB `neutralCommandedDeg` (baked, and `rig.ts` throws if ≠ 90)** | V6-20 |
| 5 | `servoSubtrimDeg` × 8 | firmware default `{0,…}` (`:113`) | authoritative *as a default*; per-build value unknown | `sesame-sim` `subtrimDeg`, `sesame-api` state | V6-20 |
| 6 | `hornSplineOffsetDeg` × 8 | **nothing** — assumed 0 | unknown | nothing consumed it; it was only ever a prose caveat | V6-20 |
| 7 | `mechanicalLimitsDeg` × 8 | `null`; the joint-map validator *forbids* filling it in | unknown | nothing — which is the problem | V6-22 |
| 8 | `safeTravelDeg` × 8 | did not exist | unknown | new | V6-23 |
| 9 | `powerOnCommandedDeg` × 8 + 1 | V1 simulation choice, 90 | **genuinely undetermined**; `setup()` attaches without commanding | `sesame-sim` `powerOnDeg`; `apps/web` deliberately shows `null` | V6-13 |
| 10 | `slewDegPerSec` | MG90S **datasheet**, 0.1 s/60° @4.8 V | datasheet, not measured | `sesame-sim` `simulatedDeg`, `apps/web` slew toggle | V6-15 → V6-25 |
| 11 | `spinQuantumMs` | V1 simulation choice, 1 ms | **no firmware period exists** (`pressingCheck()` spins on bare `yield()`) | `sesame-sim` scheduler | V6-08 |
| 12 | `loopQuantumMs` | V1 simulation choice, 1 ms | same | `sesame-sim` scheduler | V6-08 |
| 13 | `hornSplineTeeth` | MG90S spec, 20 → 18° quantum, ±9° | specification | the "±9°" caveat in F6, V0 and the joint map | V6-16 |
| 14 | `angleGainDegPerCommandedDeg` | **assumed 1.0**, over the effective `732…2500 µs` window (`attach(pin, 732, 2929)` *requests* 2929; ESP32Servo clamps it) | assumption, stated by V0 but never listed as an open item | V0's absolute-sense fit; every body-relative conversion | V6-14 |
| 15 | `servoModel` | BOM says MG90S; CAD models SG90 | **contested** | V0's servo datum (SG90); the slew figure (MG90S) | V6-04 |
| 16 | `oledActivePlaneMm` | 23.60 mm CAD reading × **11.80 mm V2 decision** | inferred | **GLB `oled_screen` quad geometry (baked)**, `apps/web` AssetPanel | V6-05 |
| 17 | `walkDirectionMatchesDrawnFront` | unknown | unknown | the second `wouldBeConfirmedBy` on all eight semantic names | V6-24 |

Rows 1–9 are per joint (8 each, 9 for row 9 counting the whole-robot fallback);
rows 10–17 are whole-robot. **8 × 9 + 9 = 81.**

Row 14 is the one nobody had on a list. `servos[i].attach(servoPins[i], 732,
2929)` maps 0–180 commanded degrees onto an unusual pulse window, and *every*
angular claim in the project assumes that window sweeps exactly 180 mechanical
degrees. V0 states the assumption; no artefact tracked it.

> **Corrected 2026-08-24 (Q3, `docs/findings/Q3-ledc-fidelity.md` §6.2, §6.4):** this paragraph read
> "an unusual pulse window — the common library default is 500–2500 µs". The window is unusual, but
> not at the top end and not by that much: **`ESP32Servo::attach()` clamps the requested 2929 µs to
> `MAX_PULSE_WIDTH` 2500 (`ESP32Servo.h:98`, applied at `ESP32Servo.cpp:126`) before storing it**,
> so the effective window is **732…2500 µs** — the same top as the library default, only the bottom
> is unusual. Confirmed by measurement: 180° produced 12 % duty at a 20 ms frame (= 2500 µs), not
> the 14.6 % 2929 µs would give. The assumption in row 14 is unaffected — a gain is a property of
> the servo — but it is a gain over 732…2500, and a bench measurement referenced to 2929 would come
> out ~17 % low. Separately, the channels are 10-bit, so the pulses actually emitted are
> **722.65625…2500 µs in 19.53125 µs steps: 92 distinct values for 181 commandable angles.**

### 2.2 Deliberately **not** made calibratable

Putting an authoritative value behind a calibration knob would be worse than
useless: it invites somebody to "calibrate" a fact.

| Value | Why it stays where it is |
|---|---|
| `angleLimitsDeg.value` = 0…180 | The firmware clamp, `constrain(angle + subtrim, 0, 180)` at `:1053`. Authoritative. It is not a travel limit and must never be confused with one — that is what `mechanicalLimitsDeg` is for |
| `DELAY_WITH_FACE_QUANTUM_MS` = 5 | A genuine firmware constant, `delay(5)` at `:1001`. Unlike the spin quanta, this one *is* determined |
| `motorCurrentDelay` = 20, `frameDelay` = 100, `walkCycles` = 10, `faceFps` = 8 | Firmware defaults that are **runtime-settable on the robot itself** (`/setSettings`). Already `SimulatedRobotOptions` fields; a second knob would be a second source of truth |
| `pinsByBoard`, `firmwareIndex`, `kind`, `JOINT_ORDER` | Authoritative identity. Calibration is keyed *on* them |
| `HAS_JOINT_POSITION_FEEDBACK = false` / `measuredDeg = null` | A fact about the hardware: eight MG90S on one-way PWM, no encoder, no pot tap, no current sense. F6 was explicit that a flag no backend can set is an invitation to set it. Calibration does not change it, and `toSimOptions()` cannot |
| Ground plane (−68.65 mm standing) | Recomputed per pose from posed foot vertices. Derived, not stored |
| Top-cover variant (Cat vs Enclosed) | An asset selection recorded in the GLB, not a measurement. V6-01 records which cover is fitted; repairing `Top-Cover-Enclosed-v117.stl` is ISSUE-20260823-006 |
| `rotationAxis`, `pivotOrigin`, `cadPose` | Design geometry. A built robot cannot disagree with it without being built wrong, which is a different finding |

---

## 3. Part 2 — the design

### 3.1 One document, layered, never forked

```
hardware/joint-map.json      the DESIGN     identity · geometry · the firmware clamp
        ▲  layers over
hardware/calibration.json    ONE ROBOT      sign · zero · subtrim · horn offset · limits ·
                                            slew · gain · power-on · part identity · quanta
```

`calibration.json` repeats **no** identity, **no** geometry and **no**
authoritative firmware value. It carries `firmwareName` and `firmwareIndex` only
as the key, and the validator asserts they still match `JOINT_ORDER`.

It is **generated** (`scripts/build-calibration.mjs`), deterministically, *from
the joint map*, so the carried-forward values are derived rather than
transcribed. `pnpm build:calibration --check` fails on any hand edit to the
reference document.

### 3.2 The two-state field

```ts
type CalibratedValue<T> = CarriedForwardValue<T> | MeasuredValue<T>;

interface CarriedForwardValue<T> {          interface MeasuredValue<T> {
  value: T;                                   value: T;
  measured: false;                            measured: true;
  source: string;                             measuredAt: string;
  method: string;                             measuredBy: string;
  wouldBeConfirmedBy: string[];               robotSerial: string;   // ← which robot
  checklistStep: string;                      instrument: string;
  closesIssues: string[];                     method: string;
}                                             checklistStep: string;
                                              closesIssues: string[];
                                            }
```

`measured` is a **discriminant**, not decoration. `field.measuredAt` on a
carried-forward value is a compile error, asserted with `@ts-expect-error` in the
test suite. Rendering "measured on …" for a guess is therefore not a code-review
finding; it does not compile.

### 3.3 Four mechanisms that have to be defeated together

1. **The type discriminant** above.
2. **A carried-forward value may not drift.** `parseCalibration(…, { jointMap })`
   and `pnpm validate:calibration` re-derive every `measured: false` value from
   the joint map (sign, zero, mechanical limits) or from the documented
   simulation default (slew, quanta, power-on, OLED plane) and reject any
   difference. **You cannot change a number without claiming you measured it.**
3. **Claiming you measured it costs five attributions**, one of which is a robot
   serial. `session` must also be present, and `meta.robotId` must equal
   `session.robotSerial`. The shipped reference document additionally refuses
   `measured: true` outright — a calibrated robot gets its own file.
4. **`meta.calibrationStatus` and the field counts are recomputed, never
   trusted**, by both the runtime parser and the CLI validator.

A fifth, smaller one: prose in `method` / `source` is scanned for wording that
would let an unmeasured value *read* as an observation. Negated phrasing — "NOT
MEASURED on any robot", which is what this project actually writes — is stripped
before the test, so the check catches the claim without punishing the caveat.

### 3.4 The one honest promotion path for `semanticName`

The joint map's `UnverifiedSemanticName.verified` is the literal `false` and must
stay that way: it describes the design, and the design cannot know which printed
part a builder bolted where (R1 ≡ L2, R2 ≡ L1, R3 ≡ L4, R4 ≡ L3 are identical
solids). So calibration does not edit it. Instead:

```ts
view.semanticNameFor('R1', jointMap)
// { kind: 'guess',        guess: UnverifiedSemanticName }        ← today, no string on the branch
// { kind: 'confirmed',    value: 'right_front_hip', confirmation: MeasuredValue<…> }
// { kind: 'contradicted', engravedName: 'L2', guess, confirmation }
```

`kind: 'confirmed'` is reachable **only** from a `partIdentity` field with
`measured: true`, which means a named person checked a named robot with a named
instrument on a named date. `kind: 'guess'` exposes no string at all — you still
have to go through `readGuessedSemanticName(…, SEMANTIC_NAME_IS_A_GUESS)`. And
the third branch matters: a build where the engraving disagrees is a *finding*,
not an error to smooth over.

### 3.5 Runtime swapping, three ways

| Where | How |
|---|---|
| Node | `loadCalibration()` — explicit path → `$SESAME_CALIBRATION` → `dist/calibration.json` → `hardware/calibration.json` |
| Browser | `CalibrationView.parse(json)` on anything you fetched |
| Live edit | `applyCalibrationOverride(base, { joints: { R4: { servoSubtrimDeg: … } } })` — field-level, keeps the other 80 fields' provenance intact, and **revalidates**, so an override cannot smuggle in a document the loader would reject |
| Export | `serializeCalibration(doc)` — revalidates, then emits the exact on-disk format |

Setting `$env:SESAME_CALIBRATION` to a per-robot file and re-running is the whole
"swap in a calibrated robot" story. No rebuild, no code change, no edit to
`hardware/`.

### 3.6 How consumers get it

`@sesame-lab/sesame-model` already owns the joint map and the guess barrier, and
is already a dependency of `sesame-sim`, `sesame-api` and `apps/web`. Extending
it was strictly cheaper than a parallel mechanism.

```ts
new SimulatedSesameRobot({ ...calibration.toSimOptions() })
// { subtrimDeg, powerOnDeg, slewDegPerSec, spinQuantumMs, loopQuantumMs }
```

`CalibrationSimOptions` is **structurally** typed, not imported from
`sesame-sim` — the dependency runs the other way and must not be made circular.
`calibration-propagation.test.ts` asserts it equals `resolveOptions()` field for
field, so the two cannot drift apart silently.

For a viewer, `toRigCalibration()` and `rigRotationDeg(joint, requestedDeg)`:

```
rigRotationDeg = rotationSenseSign × gain × (clamp(requested + subtrim) − zero) + hornOffset
```

With the shipped defaults (subtrim 0, zero 90, gain 1, offset 0) that reduces to
V2's baked rule `signPerCommandedDeg × (commandedDeg − 90)` exactly — asserted in
the tests at 12 decimal places, on all eight joints, at five angles each.

### 3.7 Changes outside `packages/sesame-model`

Kept to the minimum the plan allows, and listed so nothing is hidden:

| File | Change | Why |
|---|---|---|
| `packages/sesame-sim/src/__tests__/calibration-propagation.test.ts` | **new test file only** | The plan requires a test proving an override reaches `sesame-sim`'s output, and the test has to live where both packages are visible. **No `sesame-sim` source file was modified** — the layer feeds the existing `SimulatedRobotOptions`, so no new seam was needed |
| `packages/sesame-model/src/joint-map.ts` | added the optional `absoluteSense` field to `DirectionSign` | V0 added it to the *data* in joint-map v1.1.0 but not to the types, so it was unreadable from TypeScript. Additive and optional; all 53 pre-existing tests still pass |
| `packages/sesame-model/scripts/copy-joint-map.mjs` → `copy-hardware-data.mjs` | copies both artefacts into `dist/` | so an installed package is self-contained for `loadCalibration()` too |
| root `package.json` | `build:calibration`, `validate:calibration` | wiring |

Nothing in `sesame-api`, `apps/web`, `emulator/`, `assets/`, `firmware/` or
`reference/` was touched.

### 3.8 Validation

`pnpm validate:calibration`, five layers:

1. **JSON Schema** (draft 2020-12, ajv strict, `additionalProperties: false`).
   The `calibratedValue` `oneOf` is the guess barrier in data: the
   carried-forward branch *forbids* every attribution field and the measured
   branch *requires* all of them, so no document can sit between the two states.
2. **Structure** — eight joints in enum order, every field present, subtrim
   inside the firmware's −90…+90.
3. **Layering** — `joint-map.json` re-hashed off disk against
   `meta.layersOver.sha256`; every carried-forward value re-derived.
4. **Epistemic invariants** — §3.3, plus: the four things V0 could not close
   (`horn-spline-quantisation`, `per-robot-subtrim`, `parts-installed-where-drawn`,
   `mechanical-travel-limits`) must still be open, and the reference document is
   scanned for a stray `"measured": true`.
5. **Cross-document** — every `checklistStep` must exist as a step in
   `V6-hardware-verification-checklist.md`, and every `ISSUE-`-shaped entry in
   `closesIssues` must exist in `docs/issues.yaml`. A calibration field pointing
   at a procedure nobody wrote is worse than one pointing at nothing.

**Exercised negatively**, because a check that has never failed is not known to
work. Five deliberately broken copies, each rejected with the intended message:

| Injected fault | Caught by | Message |
|---|---|---|
| `R1.zeroReferenceDeg` 90 → 87, still `measured:false` | layer 3 | *"a carried-forward value must equal the design value it layers over (90), found 87"* |
| `measured:true` with `robotSerial: ""` | layer 1 | neither `oneOf` branch validates |
| `measured:true` with `session: null` | layer 4 | *"a measured value requires session to be present"* |
| `checklistStep: "V6-99"` | layer 5 | *"is not a step in docs/findings/V6-hardware-verification-checklist.md"* |
| `calibrationStatus: "complete"` with nothing measured | layer 4 | *"says 'complete' but 0 of 81 fields are measured"* |

The runtime parser is tested the same way in `calibration.test.ts` (30 tests).

---

## 4. Part 3 — the web UI panel: **skipped, deliberately**

The plan says build it *only if it is genuinely small*. It is not, and
`apps/web` is on this task's do-not-modify list, so the two instructions agree.

What it would actually take, so the decision is auditable:

1. `apps/web/src/three/rig.ts` — `applyCommandedDeg()` hard-codes
   `sign * (commandedDeg − 90)` and `buildRig()` **throws** if the asset's
   `neutralCommandedDeg` is not exactly 90 (`NEUTRAL_COMMANDED_DEG`, line 29). A
   calibrated zero of 93 cannot be expressed through that function at all; it
   needs a second entry point taking a rotation in degrees.
2. `apps/web/src/three/RobotScene.tsx` — the `useFrame` that writes quaternions
   has no access to anything but `commandedDeg`.
3. `App.tsx` — a `CalibrationOverride` in state, threaded to the scene and the
   panel, plus a layout slot.
4. A new `CalibrationPanel.tsx` — 8 × 3 numeric inputs, a robot-serial field, a
   session block, and an export button.

That is roughly 250 lines across four files in a package this task must not
change, and it would land untested against a real robot. **Part 4 was the better
use of the time**, and the plan says so explicitly.

**What was built instead is the panel's engine**, so the eventual UI is a
rendering job rather than a design job:

- `applyCalibrationOverride()` — field-level live edits with revalidation;
- `serializeCalibration()` — the export button, minus the button;
- `toRigCalibration()` / `rigRotationDeg()` — exactly what the scene needs to
  pose a calibrated robot;
- `describeCalibratedValue()` — the label text, in wording that cannot imply an
  observation.

Recommended as a small, contained Phase 2 task, best done *with the robot on the
desk* — twiddling sliders against a real robot is the point, and doing it
blind risks building the wrong control.

---

## 5. What is still baked in, and should not be

Found during the audit; **not fixed**, because each is a V2 asset regeneration or
an `apps/web` change and both are out of scope. Listed so the next person does
not have to rediscover them.

1. **`assets/sesame.glb` bakes `signPerCommandedDeg` per joint.** It is a second
   copy of V0's `absoluteSense`, in a binary. The calibration layer corrects the
   pose *at the call site* (`rigRotationDeg`), so a sign flip is expressible —
   but the asset will then disagree with the calibration, and only prose says
   which wins. **Fix:** either have `scripts/build-gltf.py` stop baking the sign
   (a viewer reads it from `joint-map.json`, which it already loads), or have it
   read `hardware/calibration.json` and record the `robotId` it was built for.
   The first is better.

2. **`assets/sesame.glb` bakes `neutralCommandedDeg = 90`, and
   `apps/web/src/three/rig.ts` throws if it is anything else.** That assertion is
   correct today and hostile to calibration tomorrow: a robot whose measured zero
   is 93 cannot be represented in the asset at all. **Fix:** keep the asset at
   the design neutral and apply the calibrated zero at pose time — which is what
   `rigRotationDeg()` does — but relax the throw into a check that the *asset*
   matches the *joint map*, not the literal 90.

3. **The OLED quad's 23.60 × 11.80 mm geometry is baked into the GLB.** V6-05
   will almost certainly measure something else, and `oledActivePlaneMm` will
   then be a measured field that no consumer can act on without regenerating the
   asset. **Fix:** V2 regeneration reading the calibration, or a UV/scale
   override applied in the scene.

4. **`apps/web` has no calibration awareness at all.** It drives the rig straight
   from `commandedDeg` through the GLB's rule. Wiring `CalibrationView` in is the
   same change as §4 item 2, and it is the prerequisite for the panel.

5. **Nothing consumes `mechanicalLimitsDeg` or `safeTravelDeg`.** Once V6-22 and
   V6-23 fill them in, `apps/web`'s joint sliders and `sesame-api`'s
   `/api/command` should clamp to them and say so. Today a slider can drive a
   joint somewhere the real linkage cannot go — V3/V4 noted this and it is still
   true.

6. **`servoSubtrim` is RAM-only on the real robot.** The stock firmware's
   `subtrim save` prints a C initialiser for a human to paste into source. That
   is upstream's design and we are not changing it, but it means the calibration
   document is the *only* durable home for those eight numbers, and something
   must re-apply them after every power cycle. No such re-applier exists;
   it belongs to a future `RealSesameRobot`.

---

## 6. What V6 deliberately did not do

- **No promotion of anything.** All 81 fields are `measured: false`, all eight
  `semanticName`s are still `verified: false`, `mechanicalLimitsDeg` is still
  `null` in the joint map, and the joint-map validator still forbids filling it
  in. V6 added no measurements; it added the place they go.
- **No fork of the joint map**, and no duplicated identity or geometry.
- **No change to `sesame-sim`, `sesame-api`, `apps/web`, `emulator/` or
  `assets/`** beyond one new test file (§3.7).
- **No calibration UI** (§4).
- **No `reproducibility.json` entry.** `calibration.json` is a projection of
  `joint-map.json` plus documented defaults, is regenerated deterministically,
  and is checked byte-for-byte by its own validator. Adding a hash of a file the
  validator already reproduces would be ceremony.
- **No auto-apply anywhere.** No package loads `calibration.json` by default.
  That is deliberate: the shipped document is a no-op, so auto-loading it would
  buy nothing and would make the day somebody *does* calibrate harder to reason
  about. Consumers opt in with `loadCalibration()`.

---

## 7. Reproducing this

```powershell
pnpm install
pnpm build:calibration              # regenerates hardware/calibration.json, deterministically
pnpm validate:calibration           # schema + structure + layering + epistemics + cross-doc
pnpm validate:joint-map             # unchanged and still passing — calibration layers, never edits
pnpm -r build ; pnpm -r test ; pnpm -r typecheck
```

`packages/sesame-model` goes from 53 to **83** tests; `packages/sesame-sim` gains
**7**. All existing tests pass unchanged. Nothing under `reference/` or
`firmware/upstream/` was written to, and no dependency was added anywhere.

### Swapping in a calibrated robot, once one exists

```powershell
$env:SESAME_CALIBRATION = "C:\robots\sesame-001.calibration.json"
node scripts/validate-calibration.mjs $env:SESAME_CALIBRATION
pnpm demo:web
```
