---
task: "L6 — the lesson runner: Learn mode, playing L5's content"
phase: 2
status: complete
date: 2026-08-25
owns: apps/web, scripts/capture-web-screenshots.mjs
---

# L6 — the lesson runner

L5 wrote 74 success conditions and made "click next to continue" structurally
impossible. This is the consumer L5 could not see: a Learn mode that plays them,
where a step is complete **because the robot reached the asserted state**.

Evidence: `docs/findings/assets/v3-v4-browser-capture.json` → `phases.lessonRunner`.
22 real-browser captures, 0 problems, full run with QEMU. **169 `apps/web` tests
(34 new), 885 across the workspace. No dependency was added and the lockfile is
untouched.**

---

## 1. What was built, and what was not

`hardware/lessons.json` declares **22 control kinds** and **34 check types**.
Stubbing 22 controls badly is worse than building 16 well, so the scope taken
was L5's own line: the six polished lessons, **playable end to end**.

| | Built | Not built |
|---|---:|---:|
| control kinds | **16** | 6 |
| check types | **26** | 8 |

**Controls built:** `robot-explode`, `board-selector`, `graph-node-picker`,
`pose-runner`, `command-button`, `joint-slider`, `channel-number`,
`subtrim-control`, `pwm-inspector`, `trace-inspector`, `source-selector`,
`sequence-editor`, `face-picker`, `pixel-editor`, `fault-injector`,
`http-console`.

**Not built:** `joint-picker`, `serial-console`, `boot-stepper`,
`backend-switch`, `emulator-controls`, `none`. Every one of them is used only by
an outline lesson, and `none` is used by no step at all.

**Checks not built:** `backend-switched`, `boot-step-reached`,
`emulator-boot-observed`, `fault-diagnosed`, `json-repaired`,
`lab-project-saved`, `route-method-probe`, `serial-command` — again, outline
lessons only.

### How the unbuilt ones fail

Loudly, and in two places:

- **A control that is not built renders `<NotBuilt>`** — a red-bordered panel
  naming the control kind and giving the reason, with an `is-notbuilt` badge on
  the outline row. It is not possible to mistake it for a rendered control, and
  it is not possible to get an empty box.
- **A check that is not built returns `unsupported`**, which the panel renders
  as `NOT BUILT` on a red card, and which `recordOutcome()` refuses to persist.
  There is no path by which an `unsupported` outcome becomes `passed`, unlocks a
  challenge, or satisfies a prerequisite. A unit test drives **every**
  parameterisation of every unbuilt check that appears in the data and asserts
  the status; a second drives all 34 declared types with empty parameters and
  asserts none of them returns `passed`.

`src/lessons/registry.ts` holds both lists beside the code that implements them —
deliberately not in the generated module, so a generator cannot declare a check
implemented. `lessons.test.ts` asserts the two lists partition the declared 22,
name only declared ids, and cover every control and check the six polished
lessons use.

---

## 2. The mechanic: checks against actual state

`src/lessons/checks.ts` is the file the runner's credibility lives in. Every 250
ms the active step's check — and every *unlocked* challenge's check — is
re-evaluated against `TelemetryStore`, `TraceStore`, the shared `SelectionState`,
the backend's `RobotState`, and a journal of telemetry events and issued actions
(`src/lessons/runtime.ts`). No evaluator reads a step id. There is no function a
button can call to mark a step done: `recordOutcome()` takes an *outcome*, and
the only status it will persist is `passed`.

Three properties are worth naming.

**Derived numbers are recomputed, never trusted.** `quantisation-collision` does
not read `expectTicks` and believe it — it calls `quantiseCommandedAngle()` from
`packages/sesame-model` and *compares*. A unit test tampers `expectTicks` to 86
and asserts the check **fails** naming both numbers. Every
`pwm-value-matched` and fixed `quantisation-collision` in the whole artefact is
recomputed in the test suite and agrees.

**Quiz answers are necessary and never sufficient.** Four checks ask the learner
to identify something (a trace badge, a joint, the joints a movement commands, a
playback mode). Each one *also* computes the truth from live state — the badge
`traceBadge()` actually put on the rendered row, the choreography's own direct
joints, the mode sampled off `RobotState` while the movement was running — and
fails if the data and the system disagree, whatever the learner picked.

**A malformed check is a loud failure.** A check missing a parameter its
`requires` names returns `failed` with *"this check cannot be evaluated"*, not
`pending` and not a skip.

### The check fails when the state is wrong

A check that has never failed is not known to work. Six falsifications are
driven in a real browser in phase 10, each *before* the correct action:

| Driven | Result |
|---|---|
| named `R1` as the `L4` module | `failed` — "1 of 8 named wrongly" |
| commanded `R1` to 90° when the step asks 135° | `failed`, observed `R1=90` |
| wrote channel **3**, which `if (channel < 8)` lets through | `failed` — "a `servo.target` DID arrive" |
| called the `pwm.output` row `simulated` | `failed` — the row reads `inferred-for-explanation` |
| claimed `runWavePose` commands only `R1` | `failed` — the body commands `R1 L2 R4 L3` |
| booted with no fault injected | `failed` — "boot ran to completion" |
| opened `delayWithFace` without coming from `setServoAngle` | stayed `pending` |
| called `runWavePose`'s face mode `loop` | `failed` — the robot reported `once` |

Unit tests add the tampered-constant failure and a `face-fallback` that fails
when the robot reports `stand` rather than `default`.

---

## 3. Two checks the obvious implementation gets wrong

**`face-reselect` cannot be measured by the frame index.** TN-013 says
`setFace()` early-returns on the same name, so the animation does not restart —
and the obvious reading, "did `currentFaceFrameIndex` go back to 0?", is
unusable: the `wave` face has exactly **one** frame, so its index never leaves 0
and "let it run partway" is not something a learner can do. What the early return
actually does is emit **nothing at all**, so the check counts `face.expression`
events after each of the two requests. The silence is the observable, and it
works for a one-frame face and a forty-frame one alike.

**`face-mode-identified` cannot be measured after the movement.**
`currentFaceMode` is one global, set per call site — which is the point of the
step — and by the time `runWavePose` has finished, `enterIdle()` has already
overwritten `once` with `boomerang`. So the runner *samples* `RobotState` on its
polling tick and the check reads the sample taken **while that movement was
running with its own face on screen**. Reading the last value would report what
the next thing set, which is exactly the confusion the step exists to expose.

---

## 4. Honesty surfaces

**`conceptual` is driven by `curriculum[].grounding`.** The generator asserts
each lesson's `grounding` equals its `source-annotations.json` curriculum entry's
and refuses to emit otherwise, and it computes the three conceptual modules that
**do** carry symbols (`inside-the-brain`, `build-a-leg-pose`, `build-a-movement`)
into the module so a test can pin them by name. Phase 10 asserts 7 badged cards
and checks those three by id — a badge driven by `symbols.length === 0` would
have left them unlabelled, which is L4 §6.3's finding.

**`boundaryNote` has its own register**, not a caveat's. A dashed box keyed by
`claim.domain`, headed *"this fact is about the EMULATOR, not about Sesame
source"* (or the library, or Sesame Lab), carrying `claim.observability`
underneath. Phase 10 reads computed styles back out of the browser and asserts
the border style and background differ from ordinary prose.

**Three explanation levels, one on screen.** The switch replaces; it never
stacks. Phase 10 asserts `explanationCount === 1` on open at `beginner12`, and
`=== 1` again after switching to `architecture`. `goDeeper` is a `<details>` with
no `open`, asserted `false` on the step that has one.

**Seven faults, sorted by `injectorIsLabFeature`.** The catalogue renders two
headed groups: shipped behaviour, badged `REAL` and with **no switch to flip**,
above the ones Sesame Lab injects, badged `INJECTED` and dashed. Each carries
L5's note about which part is real — `oled-init-fail` is the sharp one: the
`while (1);` is firmware, making `display.begin()` fail on demand is ours.

**Nothing claims a servo moved.** No new provenance is minted anywhere in Learn
mode; the PWM inspector carries a permanent "computed here, never observed"
banner; `isPhysicallyObserved()` is untouched and still false everywhere.

**A new banner: "Sesame Lab is modifying this robot."** Subtrim and injected
faults are sticky state, correctly — and a `+40` left on `R1` in lesson 2 is
still there in lesson 4, where `stand` then commands 175° instead of 135° and the
pose check fails for a reason that has nothing to do with the step. That
confusion is the lab's fault, not the firmware's, so any lab-side modification is
named on screen from every step with an offer to put it back. The harness hits
this exact case and clears it the way a learner would.

---

## 5. Progression, and what a skip is

- A lesson is **playable** when every step of every prerequisite has **passed**.
- A challenge opens when the success id its `unlockedBy` names has **passed**.
- A **skip** is recorded as `skipped`. It is shown as skipped, it satisfies no
  `unlockedBy` and no prerequisite, and `recordSkip()` will not downgrade a pass.
- A locked lesson is **readable** — it opens in the same read-only outline form
  an unwritten module does, with a banner naming what has to be passed first. A
  wall without a door is not pedagogy; a skip that quietly unlocks the curriculum
  is the "continue anyway" this task rules out wearing a hat.
- Nothing anywhere is time-gated. There is no timer, no acknowledgement and no
  Next button in the runner, and no check type in the vocabulary could express
  one.

Phase 10 proves the whole chain: lesson 2 is asserted **locked** before lesson 1
is played, unlocked after all five of lesson 1's steps pass, and
`send-an-http-command` is asserted **still locked** after lesson 6 finishes with
two skipped steps.

Progress lives in `localStorage` under `sesame-lab.lessons.v1`. Every read and
write is wrapped: a unit test replaces the accessor with one that throws on
every access and asserts load/save/clear all survive and render as empty, and
another feeds it a wrong-version record, non-JSON, and a record containing an
invented outcome — all discarded, with the well-formed half of the last one
kept.

---

## 6. Shared editors — where Lab mode should look

`apps/web/src/editors/`. Nothing in it imports from `src/lessons/`, so Lab
composes these rather than reimplementing them. L5 §8's direction of dependency
("authored as Lab tools that Learn borrows") is the reason.

| File | What it is |
|---|---|
| `sequence.ts` | the document model, `importMovement()` (flattens the real choreography, expanding nested calls), `scaleDelays`, range validation |
| `SequenceEditor.tsx` | frames × 8 channels + a wait, with a loud out-of-range readout |
| `pixel-frame.ts` | 128×64, one bit per pixel, MSB first — the layout `face-bitmaps.h` uses — plus `densestWindow()` |
| `PixelEditor.tsx` | canvas editor; `onPaint(x, y, on)`, **not** `onChange(frame)` |
| `SubtrimControl.tsx` | per-channel offset, labelled a Lab feature |
| `FaultInjector.tsx` | the seven declared faults, split by `injectorIsLabFeature` |
| `HttpConsole.tsx` | real requests, real statuses |
| `PwmInspector.tsx` | angle in, recomputed pulse and ticks out |

Two API notes for whoever takes Lab. `PixelEditor` hands the parent a
*coordinate*, because the obvious `onChange(nextFrame)` computed from
`props.frame` silently drops pixels — a drag delivers several `pointermove`
events before React re-renders and every one of them reads the same stale frame.
And `SequenceEditor` issues one `setServoAngle()` per channel in enum order and
then waits, because the firmware has no multi-joint primitive; there is no
interpolation here because there is none there.

### The subtrim seam

`SimBackend` owns a mutable eight-element array and passes it to
`SimulatedSesameRobot`. `resolveOptions()` stores it **by reference** and
`FirmwareMachine.adjustedAngle()` reads `opts.subtrimDeg[channel]` at the moment
of each write, so writing into it changes what the *model* computes next —
exactly as `st <ch> <deg>` on the firmware's serial CLI does. The alternative
(the lab adding an offset before handing the angle over) would put lab arithmetic
where firmware arithmetic belongs and make `constrain(angle + subtrim, 0, 180)`
untestable. A unit test drives the whole seam: 160° → 160°, set +40, 160° → 180°,
180° → 180°, and `RobotState.joints.R1.subtrimDeg === 40`. Nothing in
`packages/` was changed.

---

## 7. Verification — phase 10

`scripts/capture-web-screenshots.mjs` gains **phase 10**, in the phases 1–9
browser session on the simulator. It drives the DOM: real clicks, real `input`
events pushed through `HTMLInputElement.prototype`'s own value setter, real
`change` on `<select>`, real `PointerEvent`s on the pixel canvas.

**Lessons 1, 2, 4 and 5 are played end to end** — 24 checks passed against live
telemetry — and lesson 6 gets four of six.

- **lesson 2, the required one:** R1 driven to 135 by the slider; channel 8
  producing no `servo.target` inside a 500 ms window (and channel 3 producing one,
  first); +40 of subtrim collapsing 160° and 180° onto one commanded angle, with
  **the three.js scene read back** to confirm R1 is drawn at the saturated 180°;
  99° and 100° programming 87 ticks, with the inspector's own readout asserted;
  all eight trace rungs in causal order; and `delayWithFace` reached *from*
  `setServoAngle` — asserted to stay `pending` when opened directly.
- both lesson 2 challenges asserted to unlock from the successes they name;
- **ISSUE-20260823-023 re-asserted with Learn mode mounted and a lesson open**:
  ground plane, robot root, orbit target and camera all drift **0.000000 mm**
  across a `rest → stand` sweep in which the foot contact moved 37.535 mm.

Three new captures: `l6-lesson-conceptual-badge.png`,
`l6-lesson-two-complete.png`, `l6-lesson-fault-injector.png`.

Layout note: Learn mode takes a **third grid row**, not a column, for the same
reason L4's pane took a second one — a column comes out of the viewport's width,
and that is the class of change ISSUE-20260823-023 came from. The pane is a slim
strip until a lesson is opened.

---

## 8. What `hardware/lessons.json` did not support

Nothing in `hardware/` was changed. Four things are worth writing down.

1. **The fault count is inconsistent with itself.** `vocabularies.faults` has
   **four** entries with `injectorIsLabFeature: false` — `blank-face-stand`,
   `unknown-command-sticks`, `walk-cancelled-into-idle`, `status-json-unescaped` —
   and **three** with `true`. But `debug-a-robot` → `injected-or-real` → `claim.text`
   says *"three are shipped firmware behaviour and are not injected at all"*, and
   `docs/findings/L5-lesson-content.md` §6.6 says the same. The data is 4/3; the
   prose is 3/4. The UI is driven by the flag, so it renders four shipped faults.
   One of the two needs correcting and it is not this task's file.

2. **Two of `read-the-firmware`'s six steps cannot pass without a robot behind
   the firmware's HTTP routes.** `http-request` and `http-json-field` need
   `/api/status` and `/api/command`, and those exist only in front of
   `apps/web/server/lab-host.mjs`. Served from anywhere else — `vite preview`,
   the Phase-0 bridge — the console reports the real 404 and the check fails
   naming what is missing. That is the honest behaviour and phase 10 asserts it,
   but it means "lesson 6 is playable" is conditional on how the app is served,
   which `lessons.json` has no way to say. A `requiresBackend` field on a step
   would let the runner tell a learner up front instead of at the failure.

3. **`face-reselect`'s `faceName: "wave"` is not demonstrable via the frame
   index** — the `wave` bitmap table has one frame — and `expectAnimationRestart`
   reads as though it were. See §3; the check works, but the parameter name
   points at the wrong observable.

4. **`source-span-selected` with `reachedFrom` needs navigation the app's
   selection rules do not provide.** `setServoAngle` with `reachedFrom:
   "trace-row"` is unreachable through L4's `selectTraceRow`, which sends a
   `servo.target` row to its *joint* (correctly — the alternative would light the
   other seven under a click about one leg). The runner adds an explicit "follow
   the trace row back into `setServoAngle`" affordance that searches the rows on
   screen for one whose `sourceRef` falls inside the symbol and does nothing when
   there is none. Worth a note in the schema that `reachedFrom` is a claim about
   the *route*, and that a runner has to provide the route.

Two smaller notes. The in-process simulator **serialises** commands, so
"cancelling a walk" is a second command word arriving after the first rather than
`pressingCheck()`'s cancel path; the step's observable (the stand vector after a
different word) is still checked against real telemetry, but the mechanism a
learner sees is not the firmware's. And `robot-explode` is drawn as an SVG
exploded diagram rather than by moving the three.js scene, because the ground
plane the harness measures is computed from the posed foot vertices and moving
the robot's frame for decoration is precisely how ISSUE-20260823-023 happened.

---

## 9. Not done, deliberately

- Lab mode. The editors are built and shared; composing them into a Lab is the
  next task, and this document names where they live.
- The six unbuilt controls and eight unbuilt checks, per §1.
- No entry added to `docs/index.yaml`, and `docs/plan.md`'s Phase 2 checklist is
  untouched: both sit outside this task's ownership with concurrent agents
  active. The orchestrator should add this document, `L4-source-explorer.md` and
  `L5-lesson-content.md`.
