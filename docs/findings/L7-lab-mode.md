---
task: "L7 — Lab mode: the unrestricted experimentation surface"
phase: 2
status: complete
date: 2026-08-26
owns: apps/web, scripts/capture-web-screenshots.mjs
---

# L7 — Lab mode

Learn mode is guided and every step of it ends on a check the robot has to
satisfy. Lab mode has no steps, no checks, no progression and no success
conditions: it is where the learner does what they want. The research report's
phrase is *"an engineering lab with training wheels"*, and the training wheels
here are the honesty labelling — every number says where it came from — not a
rail deciding what to build next.

Evidence: `docs/findings/assets/v3-v4-browser-capture.json` → `phases.labMode`.
25 real-browser captures, 0 problems, full run with QEMU. **196 `apps/web` tests
(27 new), 912 across the workspace. No dependency was added and the lockfile is
untouched.**

---

## 1. What it contains

`apps/web/src/lab/` — a fourth grid row, a slim strip until it is opened, five
tabs. Every editor in it is L6's, composed rather than reimplemented:
`SequenceEditor`, `PixelEditor`, `SubtrimControl`, `FaultInjector`,
`HttpConsole`, `PwmInspector`.

| Tab | What it is |
|---|---|
| **Pose** | eight sliders in `JOINT_ORDER` (`R1 R2 L1 L2 R4 R3 L3 L4`, with the channel index beside each), showing `constrain(angle + subtrim, 0, 180)` as two steps, the **LEDC tick** the adjusted angle programs, and the neighbouring angles that program the same one |
| **Animation** | Sesame Studio's model kept whole — pose → frame → animation — played on the robot, and exported as `setServoAngle()` C++ |
| **Face** | the 128×64 editor, pushed to the panel through `drawBitmap()`, exported as a `face-bitmaps.h` array |
| **API** | free-form requests against the **ten** routes `hardware-map.json` records, not the five a lesson names |
| **Faults** | the seven declared faults, split by `injectorIsLabFeature`, plus the boot model |

New files: `lab/lab-doc.ts` (the document + persistence), `lab/cpp-export.ts`,
`lab/face-header.ts`, `lab/PoseControl.tsx`, `lab/LabMode.tsx`,
`lab/lab-wiring.ts`, and `editors/LabModifications.tsx` (§4).

**Sesame Studio's concepts, one for one.** A pose is eight angles and nothing
else — no name, no easing, no interpolation, because a pose on this robot is
literally eight numbers a `for` loop writes. A frame is a pose plus a wait,
which is `SequenceFrame` already. An animation is an ordered list of frames,
which is `SequenceDoc`. Nothing was added to the model. What *is* different from
Studio is that the project drives the robot directly and the export is a
compatibility artefact rather than the only output — which is exactly the
report's "eliminates today's copy-to-clipboard workflow while preserving
compatibility".

---

## 2. The two shared-editor caveats

**`PixelEditor`'s coordinate API — fixed by using it correctly, not by changing
it.** L6's `onPaint(x, y, on)` is right and `onChange(nextFrame)` is what is
broken: a drag delivers several `pointermove` events before React re-renders, so
a parent computing the next frame from `props.frame` reads the same stale buffer
every time and keeps only the last pixel. The fix is on the *parent* side and it
is the only version that works — the frame is held in its own `useState` and
every stroke is a **functional** update:

```ts
const paint = (x, y, on) => setFace((previous) => setPixel(previous, x, y, on));
```

The frame is therefore held **outside** the project object; the base64 is
written back on save. Doing it through a base64 field inside a larger object
would mean decoding 1024 bytes per `pointermove` for no gain. In Learn a step
toggles one pixel and the defect is invisible; at Lab scale people drag, so
phase 11 drags a nine-pixel square in one stroke and asserts **all nine reach
the panel's GDDRAM**. Nothing in `PixelEditor` was changed.

**`SequenceEditor`'s one `setServoAngle()` per channel — preserved and made
visible.** The firmware has no multi-joint primitive: `runStandPose()` is eight
consecutive calls in enum order. So "send all eight" is *labelled* as eight
calls, the writes are awaited one at a time rather than fired concurrently, and
the export emits eight lines. A `setPose()` abstraction would be a nicer API and
a false one — the aliasing, the per-channel subtrim and the `motorCurrentDelay`
stagger all live in the fact that it is eight writes. The harness asserts the
emitted order is `JOINT_ORDER` and fails if the export ever groups or reorders.

One additive change was made to a shared editor: `HttpConsole` gained optional
`routes`, `freeForm`, `note` and `onDraftChange` props. Every default preserves
Learn's behaviour exactly, and the Learn phases were re-run.

---

## 3. The C++ export is a compatibility contract

It is the one artefact that can leave this system and touch a real robot, so the
call shape is **verified against the firmware, not guessed**.

```c
setServoAngle(R1, 135);      // firmware/movement-sequences.h:80
```

`R1` is not a string: `movement-sequences.h:5` declares
`enum ServoName : uint8_t { R1=0, R2=1, L1=2, L2=3, R4=4, R3=5, L3=6, L4=7 }`,
so the identifier converts to the `uint8_t channel` of
`void setServoAngle(uint8_t channel, int angle)` — the signature
`hardware/hardware-map.json` → `servos.control.setServoAngle.signature` records.
Sesame Studio emits the same call (`sesame_studio.py:196` builds
`f"setServoAngle({servo_idx}, {angle}); "` with `servo_idx` the *name*), so one
export is Studio-compatible and firmware-compatible at once.

Three tests hold it there, and all three read the real header off disk rather
than a string in the test file: the emitted line must be the one
`runStandPose()` contains; the eight identifiers and their indices must be the
ones the `enum` declares; and `parseSesameCpp()` must read the firmware's **own
`runStandPose` body** back as one frame of eight writes with `R1:135, R2:45,
L1:45, L2:135`.

**Round-tripping is proved twice, independently.** The Lab emits, parses its own
output back by the rule the firmware's bodies are read under (writes accumulate,
a wait closes the frame — `importMovement()`'s rule), compares the pose sequence
and shows the verdict. The harness does **not** trust that verdict: phase 11
writes a *second* `setServoAngle()` parser and compares its output against the
frames the harness itself authored through the sliders. Unit tests round-trip
`runStandPose`, `runWavePose`, `runDancePose` and `runRestPose` out of the real
choreography, plus a pure-wait frame, a zero-wait frame and an empty document.

**Where Studio and the firmware disagree, the choice is explicit.** Studio closes
each frame with `delay(ms)`; the firmware's movement bodies use
`delayWithFace(ms)`, which `hardware-map.json` records as spinning for the
duration *while servicing* `updateAnimatedFace()`, `server.handleClient()` and
`dnsServer.processNextRequest()`. A bare `delay()` pasted into the firmware
freezes the face, the web server and the captive-portal DNS. `delayWithFace` is
the default; `delay` is a labelled choice with the cost written next to it.

Two more things the export says out loud, in the **generated code** rather than
only in the UI so they survive the clipboard: these are commanded angles that
have never been verified against a physical robot (and the firmware has no
position feedback to verify them with), and **89 of the 181 commandable angles
are indistinguishable at the pin**. `aliasingInExport()` recomputes that from
`quantiseCommandedAngle()` per document rather than reading a table.

Studio's narrower per-servo ranges (`R1`/`L2` 45–180, `R2`/`L1` 0–135) are
*named* and not enforced: `setServoAngle()` clamps to 0–180 and nothing else, so
those limits are somebody's belief about the linkage rather than a rule the code
has.

---

## 4. "Sesame Lab is modifying this robot", and where it now lives

L6's banner moved to `src/editors/LabModifications.tsx` and both modes render
it. Lab sets far more of this state than Learn does, and a banner implemented
twice would eventually say two different things about the same robot. Learn's
call site is unchanged in behaviour and keeps the `lab-modifications` testid.

It names three kinds of modification, and the list is the whole list:

| | why it is ours and not the robot's |
|---|---|
| subtrim | the arithmetic is firmware; the slider is not — the firmware only exposes `st <ch> <deg>` on the serial CLI |
| injected faults | the `injectorIsLabFeature` ones; the shipped ones are **not** listed, because nothing was injected |
| an authored face | pixels a person drew, sitting where the robot's own face would be |

Commanded joint angles are deliberately **not** listed: driving R1 to 135° is
what the robot is for, and calling it interference would make the banner
permanent and therefore unreadable.

The third kind is new and it behaves differently from the other two, which is
the interesting part. Subtrim and faults are sticky; an authored frame is not —
the next `face.expression` event overwrites those pixels. So
`TelemetryStore` gained a `panelIsAuthored` flag that every other write path
clears, and the banner **stops claiming the panel the moment the robot
repaints**. Phase 11 asserts it true after a push and false after
`setFace("happy")`, so the flag is known not to be a constant.

"Put it all back" now also restores the panel — by **redrawing the face the
robot last reported** (`repaintReportedFace()`), not by blanking it. A blank
panel is itself a state no firmware produces, and re-requesting the same face
would emit nothing at all because `setFace()` early-returns on the same name
(TN-013).

---

## 5. Persistence

`localStorage` under `sesame-lab.lab.v1`, on exactly the terms
`src/lessons/progress.ts` uses: every read and write wrapped, a blocked
accessor, an absent value and somebody else's JSON all rendering as a fresh
empty project, and anything unrecognised **discarded rather than merged**.
Autosaved 400 ms after a change.

Two behaviours worth naming. The save is **read back** before the "saved" badge
appears — `saveProject()` swallows a quota or private-window failure by design,
and a badge that lies about it would be worse than no badge, because the reload
the learner is counting on is the one that would come back empty. And an
**out-of-range authored angle is kept** on reload while an out-of-range *pose*
is dropped: the editor's whole out-of-range readout is about showing that the
firmware would clamp 200° silently, and discarding it on reload would hide the
lesson.

Unit tests drive a `localStorage` that throws on every access, an absent one,
five unrecognisable records, and one half-invented record whose good half
survives. Phase 11 asserts the real thing across a real `location.reload()`:
1935 bytes stored, two frames back, the exported C++ byte-identical, and all
nine drawn pixels still in the exported array.

---

## 6. The API console

Free-form method, route and body against the ten routes read out of the
generated architecture graph — so the list cannot drift from
`hardware/hardware-map.json`. It says that **every route is registered
`HTTP_ANY`** via the two-argument `WebServer::on(uri, handler)` overload, that
only `/api/command` and `/api/wifi/connect` check the method at all, and that
`firmware/README.md`'s GET-only documentation is not enforced by the server —
so `DELETE /getSettings` works, and finding that out is the point of a console
you can type into.

ISSUE-20260823-021 gets both halves. The console explains the real defect —
`handleGetStatus()` concatenates `currentCommand` into JSON unescaped while
upstream escapes SSIDs with `jsonEscape()` twenty lines away — and then says
plainly that **what you are talking to is not that code**: our adapter reduces
every name to `[A-Za-z0-9_.-]` at the boundary with no opt-out, because emitting
attacker-controlled JSON or a forged telemetry sentinel is not a compatibility
feature. Phase 11 stores a command word containing a quotation mark and asserts
`/api/status` still parses, with `currentCommand` coming back as `x_`.

---

## 7. Verification — phase 11

`scripts/capture-web-screenshots.mjs` gains **phase 11**, in its own session
under `lab-host --backend sim`, with the browser on the lab-host backend — so
the sliders, the console and the 3D scene all talk to **one** robot behind the
firmware's own routes. No QEMU is involved, so unlike phases 5 and 6 it always
runs.

Lab has no checks, which removes what phase 10 leaned on: there is no
`checkStatus` to wait for and no evaluator whose verdict can be asserted. So
every claim is asserted against something outside the Lab's own opinion of
itself.

| Claim | Asserted against |
|---|---|
| the animation reaches its angles | `Object3D.quaternion`, read back per joint — worst error **7.1e-15°** |
| the export round-trips | a **second** parser written in the harness, compared to the frames the harness authored — 2 frames, 16 calls |
| the tick readout is not a 1° fiction | 99° and 100° both program tick **87**; 0° programs 37 and 180° programs 128 |
| the drag survived | the panel's page-ordered GDDRAM, decoded pixel by pixel — 9/9, and a pixel outside the square dark |
| the header export is the *other* layout | the same 9 pixels found at `y*16 + (x>>3)`, MSB first |
| the API console's reply is real | `POST /api/command → 200`, `GET /api/status → 200` with `currentCommand` |
| ISSUE-021 is described, not reproduced | `/api/status` still parses after a quote is stored; `currentCommand` is `x_` |
| the banner is accurate | authored panel named, then **not** named after the robot repainted, then both kinds named at once, then null after "put it all back" |
| persistence | a real `location.reload()`; 2 frames, identical C++, 9/9 pixels |
| ISSUE-20260823-023 | ground plane, robot root, orbit target and camera all drift **0.000000 mm** with the Lab open as a fourth row, while the foot contact swept **37.535 mm** |

Four new captures: `lab-pose-and-quantisation.png`, `lab-cpp-export.png`,
`lab-face-editor.png`, `lab-api-console.png`.

### A regression this found, and fixed

The first Lab build **broke phase 7 intermittently**: the rendered causal trace
came back a seven-rung ladder, missing `visual.joint`. Three baseline runs with
the Lab stashed were green, so it was real. Two causes, both fixed:

1. **`LessonRuntime` bumps on every telemetry event** — ~50 Hz during a
   movement — and the Lab pane subscribed to it directly, re-rendering a pose
   table and two export boxes at that rate. It now sets a dirty flag that a
   200 ms timer flushes (the shape `useStoreTick` already uses), and it does not
   subscribe at all while the pane is a closed strip, which renders nothing
   that depends on it. The last-saved face is memoised rather than base64-decoded
   per render, and `App` takes one `snapshot()` per render instead of three.
2. **The harness read the trace DOM once.** The store was ready — the `waitFor`
   above it proved that — but the trace panel repaints on its own 260 ms tick,
   so a single read can catch a DOM one tick behind. That is a race in the
   reading, not a defect in the app, and it would surface for anything that made
   a repaint arrive later. The read is now polled with an 8 s ceiling and keeps
   the last value, so a genuinely missing layer still fails with the same
   message.

Five consecutive green runs since (three `--skip-qemu`, two full).

---

## 8. Not done, and one thing to watch

- **A "run this animation on a loop" control.** The firmware's own continuous
  movements are `while (currentCommand == ...)` loops with `pressingCheck()`
  cancellation, and the in-process simulator serialises commands rather than
  reproducing that cancel path (L6 §8). A Lab loop button would therefore be
  modelling the *editor's* idea of looping, not the firmware's. Phase 3.
- **Multi-frame face animations.** `face-bitmaps.h` supports `_1`, `_2`, …
  suffixes and `emitFaceHeader()` takes a `frameIndex`, but the editor holds one
  frame. Authoring an animated face needs a frame strip and a preview at
  `faceFps`, which is a real piece of UI rather than a parameter.
- **Subtrim is unreachable on the lab-host and bridge backends.** `setSubtrim`
  writes into the array `SimulatedSesameRobot` holds by reference, which only
  exists for the in-process `SimBackend`. The Lab disables the sliders and says
  so rather than moving them and doing nothing — but the firmware's serial CLI
  (`st <ch> <deg>`) is the real affordance and a `serial-console` control would
  reach it on any backend. That control is also one of L6's six unbuilt ones.
- **One flake seen once in eight runs, not reproduced since:** phase 10's
  `face-fallback` step read `failed` for its whole 15 s window. It has not
  recurred in five subsequent runs and nothing in Lab mode touches that path,
  but it is written down here rather than left unmentioned.
- No entry added to `docs/index.yaml` and `docs/plan.md`'s Phase 2 checklist is
  untouched: both sit outside this task's ownership. The orchestrator should add
  this document alongside `L4`, `L5` and `L6`.

Nothing in `hardware/`, `firmware/upstream/`, `reference/` or `packages/` was
changed. L6 §8's four data observations still stand unaddressed and are not
this task's files either.
