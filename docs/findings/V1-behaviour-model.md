# V1 — Behaviour model (`@sesame-lab/sesame-sim`)

**Task:** Phase 1 · V1 · `docs/plans/phase-1-virtual-mvp.md` §3
**Agent:** `behaviour-model`
**Date:** 2026-08-23
**Status:** complete — `pnpm -r build` / `test` / `typecheck` green
**Deliverable:** `packages/sesame-sim/`, exporting `SimulatedSesameRobot`

---

## 1. What was built

`SimulatedSesameRobot` implements the research report's `SesameRobot` contract
(`connect`/`disconnect`, `capabilities`, `command`, `setFace`, `setJoint`,
`setPose`, `getState`, `subscribe`) and emits
`@sesame-lab/sesame-protocol` events with `provenance: "simulated"`, a
monotonic `seq`, `simTimeUs` in virtual microseconds, and a `traceId` that
threads one user action through every event it causes.

It is two things bolted together, and keeping them apart is the whole design:

| Layer | What it is | Where it comes from |
|---|---|---|
| **Control structure** | `loop()`, `setServoAngle()`, `delayWithFace()`, `pressingCheck()`, `setFace()`, `updateAnimatedFace()`, `updateIdleBlink()` | Transcribed from `firmware/sesame-firmware-main.ino`, cited line by line in `src/machine.ts` |
| **Choreography** | all 21 movement functions, all 395 steps | **Generated** from `hardware/hardware-map.json`. Never hand-written |

Nothing in the package hand-transcribes a movement. If a joint angle is wrong,
the bug is in the extractor and there is exactly one place to fix it.

### Files

```
packages/sesame-sim/
  scripts/build-choreography.mjs   projects hardware-map.json -> a typed TS module
  src/
    index.ts                       public surface
    robot.ts                       SimulatedSesameRobot
    robot-contract.ts              the report's SesameRobot interface
    machine.ts                     the cooperative firmware machine
    choreography.ts                typed accessors over the generated data
    choreography-types.ts          the step/movement types
    generated/choreography.ts      GENERATED — 21 movements, 395 steps
    clock.ts    config.ts    errors.ts    realtime.ts    rng.ts
    __tests__/                     10 files, 122 tests
```

### Why the choreography is generated into a `.ts` module

The package has to run in a browser — V3 drives the R3F robot from it — so it
cannot read a 300 KB JSON file off disk at runtime. Importing the JSON with
`resolveJsonModule` would make `tsc` synthesise a structural `.d.ts` for all 395
steps; a module typed as `Choreography` emits 765 bytes of declaration instead.
`choreography-drift.test.ts` re-runs the generator with `--check` on every test
run, so the generated file cannot be edited into a fork of the extractor's
output.

---

## 2. The scheduling model

### The problem

`delayWithFace()` runs after **every single servo write**, and it is not a
delay:

```c
void delayWithFace(unsigned long ms) {            // ino:996
  unsigned long start = millis();
  while (millis() - start < ms) {
    updateAnimatedFace();
    server.handleClient();
    dnsServer.processNextRequest();
    delay(5);
  }
}
```

So the default 20 ms `motorCurrentDelay` is four HTTP polls, four DNS polls and
four face-animation ticks. A model that blocked for 20 ms would produce
identical joint angles and materially different behaviour: faces frozen inside
movements, and an HTTP stop that cannot land where the real one lands.

### The solution

Every function that can delay is a **generator** that yields a `Pump` at each
point the firmware re-enters its pumps — and nowhere else, which is exactly the
firmware's own concurrency contract. The driver decides what a yield costs:

- **virtual time** (default): nothing. The generator is drained synchronously,
  a 3.7-second wave executes in well under a millisecond of wall clock, and the
  stream is reproducible because there is no scheduler to interleave anything.
- **real time**: `driveRealtime()` sleeps at each yield, anchored to total
  elapsed virtual time so a slow host catches up rather than accumulating drift.
  It is a *pacer around the same generator*, never a second implementation.

The clock is injectable (`SimClock`, default `VirtualClock`). Nothing in the
model calls `Date.now()`, `performance.now()` or `setTimeout`.

`onPump(hook)` exposes the pump point. That is the seam V5's HTTP adapter
should use: servicing requests there gives it the firmware's timing instead of
a parallel event loop, and it is why `stop()` is deliberately **synchronous** —
on the robot, `/cmd?stop=` is serviced from inside `server.handleClient()`,
which runs from inside `delayWithFace()`, so a stop really does land mid-gait
at the next `pressingCheck()`. `scheduling.test.ts` fires a stop from a pump
hook and watches the gait bail out and stand up.

Two quanta, one firmware-determined and one not:

| Loop | Period | Source |
|---|---|---|
| `delayWithFace()` | **5 ms** | `delay(5)`, ino:1001. A firmware constant, not a knob |
| `pressingCheck()` | **1 ms** (`spinQuantumMs`) | **Simulation choice.** The loop spins on bare `yield()` with no delay at all, so it has no firmware-defined period |
| `loop()` | **1 ms** (`loopQuantumMs`) | **Simulation choice**, same reason |

---

## 3. Upstream quirks reproduced

Every one of these is a place where the honest thing and the tidy thing differ.

| # | Quirk | Issue / source | Test |
|---|---|---|---|
| 1 | **`setFace("stand")` emits nothing at all.** `epd_bitmap_stand` and `epd_bitmap_defualt` are declared `__attribute__((weak))` and never defined, so `countFrames()` returns 0, the fallback table is also empty, `updateFaceBitmap()` is never reached — and `currentFaceName` is quietly rewritten to `"default"`. Every pose ends with `runStandPose(1)`, so this fires constantly | **ISSUE-20260823-004**, `face-bitmaps.h:52`, confirmed at binary level by F3 | `faces.test.ts` |
| 2 | **Subtrim before the clamp.** `constrain(angle + servoSubtrim[ch], 0, 180)`, so a trimmed channel saturates on a request that is legal untrimmed, and telemetry reports the saturated value | ino:1053 | `servo.test.ts` |
| 3 | **`delayWithFace()` is a re-entrancy point**, not dead time | ino:996 | `scheduling.test.ts` |
| 4 | **Face playback mode is one global**, set per call site by `setFaceWithMode()`. `dead` plays `once` in `runShrugPose` and `boomerang` in `runDeadPose`; a bare `setFace()` inherits whatever was global | ino:58, `hardware-map.json` `faces.playbackModeOwnership` | `faces.test.ts` |
| 5 | **`enterIdle()` is not inactivity-triggered.** Exactly one call site: `runStandPose(face == 1)`. `firmware/README.md:667` claims otherwise | ino:1011, movement-sequences.h:88 | `faces.test.ts` |
| 6 | **Idle blinking freezes during movements.** `updateIdleBlink()` is called from `loop()` and nowhere else, so the 3-second hold in `runBowPose` cannot blink | ino:758 | `faces.test.ts`, `scheduling.test.ts` |
| 7 | **`setFace()`'s early return is case-sensitive** while its registry lookup is case-insensitive, so `setFace("Wave")` after `setFace("wave")` re-runs the whole body | ino:904 vs :917 | `faces.test.ts` |
| 8 | **`FACE_ANIM_ONCE` redraws its last frame twice.** On the tick that finds `index + 1 >= count`, it pins the index, sets `faceAnimFinished` — and still falls through to `updateFaceBitmap()` | ino:967-970, :980 | `faces.test.ts` |
| 9 | **The first animated frame advances immediately.** `setFace()` resets `lastFaceFrameMs` to literal `0`, so `millis() - 0 >= interval` is true at once on any robot that has been up longer than one frame | ino:911, :963 | `faces.test.ts` |
| 10 | **`/cmd?stop=` does not call `exitIdle()`**, while `/cmd?pose=`, `/cmd?go=` and `POST /api/command` all do | ino:244 vs :235/:241/:384 | `faces.test.ts` |
| 11 | **`rest` and `stand` are cleared inline in `loop()`**, not by the pose function, which is why the choreography carries no `clearCommandIf` for them. Derived structurally rather than hardcoded | ino:768-769 | implicit in `robot.test.ts` |
| 12 | **The gaits never clear `currentCommand`**, so `loop()` re-invokes them for as long as the key is held | ino:764-767 | `robot.test.ts` |
| 13 | **An unrecognised command is never cleared** and does nothing forever. Reproduced behind `strictCommandVocabulary: false` | `hardware-map.json` `commands.dispatchNote` | `errors.test.ts` |
| 14 | **`setServoAngle()` silently ignores channels ≥ 8** — no error, no clamp, no write | ino:1052 | modelled; unreachable through the typed API |
| 15 | **`measuredDeg` is `null`, always.** No encoder, no pot tap, no current sense, no firmware path | `HAS_JOINT_POSITION_FEEDBACK = false` | `servo.test.ts` |

None of these is "fixed". Where the model refuses to reproduce something (#13
by default), the refusal is opt-out and the `SimError` carries a
`firmwareBehaviour` string describing what the robot would have done, so the
divergence is discoverable at the call site and not only in this document.

---

## 4. Judgement calls

Each of these is a place the firmware does not determine the answer. They are
all `SimulatedRobotOptions` fields with the reasoning in the JSDoc, so a future
`RealSesameRobot` can be held to a decision rather than to an accident.

| Choice | Default | Why |
|---|---|---|
| **`pressingCheck()` period** | 1 ms | The loop is `yield()` with no delay; it has no period. 1 ms flips a face frame within a millisecond of when it is due and costs 100 iterations per 100 ms window instead of a million |
| **`loop()` period** | 1 ms | Same: `loop()` has no delay in it either |
| **Idle-blink PRNG** | seeded mulberry32, seed 1 | `randomSeed(micros())` (ino:653) is genuinely irreproducible on silicon. A determinism guarantee is worth more to this project than reproducing irreproducibility. Documented as a divergence, injectable via `rng` |
| **Servo slew for `simulatedDeg`** | 600 °/s | MG90S **datasheet** figure (0.1 s / 60° at 4.8 V), no load, no backlash, no supply sag. **Nobody has timed this robot's servos.** Set `slewDegPerSec: null` for instantaneous. `measuredDeg` stays `null` regardless |
| **Power-on `commandedDeg`** | 90 | `setup()` attaches the servos and deliberately does not move them ("Show rest face on startup without moving motors", ino:746). Where a horn actually sits is unknown. 90 is the assembly datum (F6 §3.3). `RobotState.commandedDeg` is a required `number`, so *something* must appear; `SimulatedRobotState.simulated.everCommanded[j]` is how a UI distinguishes "commanded to 90" from "never commanded" |
| **Unknown command** | throws `UnknownCommandError` | The firmware assigns it and leaves the robot in a permanently non-empty command that matches nothing. A teaching UI should not silently wedge. `strictCommandVocabulary: false` restores the firmware behaviour |
| **`setJoint` out of range** | throws `AngleOutOfRangeError` | An asymmetry worth naming: `setServoAngle()` *clamps*, but the only externally reachable single-joint path, `GET /cmd?motor=&value=`, **rejects** outside `0..180` before calling it (ino:252). The external contract is a rejection; the clamp still governs `angle + subtrim` |
| **Fractional angles** | truncated toward zero | Matches `String::toInt()` on the HTTP path |
| **Unknown face** | no error | The firmware does not validate face names either; it silently falls back and draws nothing. Throwing would hide quirk #1 |
| **`log` event channel** | `firmware` | The choreography's `Serial.println()` steps are UART bytes on the robot, and the R7 bridge tags them `uart`. Nothing here crosses a wire, and `uart` means "bytes were observed". Configurable to `uart` for bridge-shaped consumers |
| **Continuous commands** | one dispatch iteration | `forward`/`backward`/`left`/`right` never clear `currentCommand`, so the firmware repeats them forever; `await command('forward')` cannot model "forever". One iteration is a full `walkCycles` gait plus the closing stand. `tick()` runs more, `command('stop')` clears |
| **`runMovement()` sets `currentCommand`** | yes, when empty | Not decoration: a gait called with an empty command bails at its first `pressingCheck()` and stands up. The serial CLI does exactly this — `rn wf` is `currentCommand = "forward"; runWalkPose(); currentCommand = "";` (ino:795) |
| **`setPose` ordering** | firmware channel order | The firmware has no multi-joint primitive; every pose is a run of `setServoAngle()` calls in enum order. Ordering by `JOINT_ORDER` rather than by the caller's key order also makes the event stream a function of the pose, not of object construction |
| **Calls are serialised** | yes | The firmware has one thread. `stop()` is the deliberate exception, because on the robot it really does arrive from inside a pump |
| **`network.state`** | `unavailable` | There is no radio and V1 ships no HTTP server. `"ap"` with a plausible IP would be a lie; V5 is what makes this `"simulated"` |
| **`oledFramebuffer` capability** | `false` | V1 emits `face.expression`, not `oled.frame`. V4 renders pixels from the expression stream |
| **`SesameRobot` lives in this package** | for now | Nothing else defines it yet. It should move to a neutral home when `RealSesameRobot` or `RenodeSesameRobot` appears; moving an interface with one implementation is cheap |

---

## 5. Tests — 122 across 10 files

| File | Covers |
|---|---|
| `choreography-drift.test.ts` | the generated module is byte-identical to a fresh generation; 21 movements; **395** steps counted three independent ways; `file:line` on every step; every declared step kind is exercised *and* every exercised kind is declared; joint/index agreement with `JOINT_ORDER`; the typed-out firmware constants pinned against the map |
| `movements.test.ts` | **every one of the 21 functions executes**, and its emitted `(joint, angle)` sequence equals an expansion of `hardware-map.json` produced by code that shares nothing with the interpreter; `walkCycles` honoured; C++ default arguments bound (`runStandPose(0)` skips face and idle, `runStandPose(1)` does not) |
| `determinism.test.ts` | same commands + same seed → **byte-identical** stream, run twice in-process, over a script that exercises virtual time, the trace counter, the seq counter, the seeded PRNG and clock-dependent face timing; a different seed differs only after the first random draw; every movement individually stable; `seq` strictly +1 and `simTimeUs` non-decreasing |
| `poses.test.ts` | `runStandPose` → the documented eight targets; **F6's round-number collapses** re-derived through the model against `hardware/joint-map.json`'s own `directionSign`/`zeroReferenceDeg` (rest → 0 on all eight, stand → +45 hips / +90 feet, shrug → −90 feet, dead → 0 feet); `runDeadPose` leaves the robot collapsed; `runShrugPose` shows two faces |
| `faces.test.ts` | the empty-face bug from three angles; global playback mode; boomerang/once semantics; case sensitivity; boot face; idle entry, exit and freeze |
| `servo.test.ts` | subtrim before clamp, including saturation past both boundaries and the counter-case that proves the order; `motorCurrentDelay` cost; `measuredDeg` null; the speed model and `everCommanded` |
| `scheduling.test.ts` | pumps every 5 ms; an HTTP-shaped hook serviced from inside a servo delay; **face animation advancing during a servo delay**; interleaving in a real pose; idle frozen inside a movement; a stop fired from a pump interrupting a gait; virtual time costing no wall time; the real-time pacer and its speed multiplier |
| `errors.test.ts` | not-connected, unknown command (both modes), unknown joint, out-of-range and non-finite angles, boundaries, truncation, all-or-nothing `setPose`, and that `setFace` never throws |
| `robot.test.ts` | `SesameRobot` assignability, capabilities, state shape, unsubscribe, call serialisation, choreography provenance, motion state, and that every event is a valid protocol event with `simulated` provenance |
| `replay-fixture-parity.test.ts` | **cross-check against Phase 0's R7 replay fixture**: an independent renderer of the same choreography, written months earlier. Identical servo stream, identical elapsed time (3680 ms), identical face events for `runWavePose` — and the model additionally emits the inter-frame animation the fixture explicitly declined to model |

The determinism test is the one worth calling out. It serialises every event to
JSON and compares whole strings rather than spot-checking fields, because the
property is easy to lose by accident — one `Date.now()`, one `Math.random()`,
one insertion-order-dependent iteration and it is gone.

---

## 6. Where `hardware-map.json` was not enough

It drove the model further than expected: all 395 steps, the clamp, the subtrim
defaults, `motorCurrentDelay`, the joint order, `walkCycles` and `frameDelay`
all came straight out of it, and the joint/index cross-check passed on all 223
servo steps. Five things had to be read out of firmware source instead.

1. **`delayWithFace()`'s 5 ms quantum is not machine-readable.** It exists only
   inside the prose of `servos.servoConfig.motorCurrentDelay.appliedNote`
   ("…with a `delay(5)` per iteration"). This is the single most load-bearing
   number in the scheduling model — it sets how many times a servo delay
   re-enters the face driver — and it is currently a sentence.
   *Suggested:* a `reentrancyPoints` block with `{ symbol, quantumMs,
   pumps: [...], source }` for `delayWithFace` and `pressingCheck`.

2. **`pressingCheck()`'s structure is only a code string.** `interruptCheck`
   steps carry the literal `if (!pressingCheck("forward", frameDelay)) return;`
   and an `onInterrupt` prose field. That it spins on `yield()` with **no**
   delay — unlike `delayWithFace` — is not represented anywhere, and it is what
   makes its period a simulation choice rather than a firmware fact.

3. **`setFace()`'s algorithm is not represented.** The map has the symbol, the
   call sites, the frame counts and the modes, but the seven-step body — early
   return, fps reset, fallback table, zero-frame rename to `"default"`, the
   `frameCount > 0` guard on `updateFaceBitmap()` — had to come from ino:903.
   Four of the fifteen reproduced quirks live in those seven statements.
   `servos.servoConfig.setServoAngle.steps[]` is exactly the right shape; the
   same treatment for `setFace` and `updateAnimatedFace` would close this.

4. **"Cleared inline in `loop()`" is prose only.** `commands.vocabulary[].clearsSelfNote`
   says it in English for `rest` and `stand`; there is no boolean. The model
   derives it structurally instead (a movement clears itself iff its body
   contains a matching `clearCommandIf`), which is arguably better — but it is
   a derivation, not a read. A `clearedBy: "loop" | "self" | null` field would
   make it a read.

5. **The power-on servo angle is not determined anywhere**, by the map or by
   the firmware. `setup()` attaches and deliberately does not command. This is
   a genuine unknown, not a gap in the extractor, and it is the one V1 value
   that would be settled in about ten seconds by a physical robot and a
   protractor. It belongs on V6's hardware-verification checklist.

One smaller note: `faces.defaultFps` (8) is in the map but not in the
choreography projection, so `DEFAULT_FACE_FPS` is a typed literal in
`config.ts`. `choreography-drift.test.ts` asserts it against the map, so it
cannot rot, but it is a literal rather than a projection.

---

## 6b. `hardware-map.json` unresolved items this model touches

Four of the extractor's ten open items are V1's concern. None is closed by V1;
all four are handled explicitly rather than silently.

| Item | How V1 handles it |
|---|---|
| `broken-face-bitmaps` | Reproduced, not fixed — quirk #1. `thinking`'s unreachable `epd_bitmap_thinking_2` falls out for free, because the model takes frame counts from `FACE_CATALOG`, which records the count `countFrames()` would return |
| `face-playback-mode-per-face` | Reproduced as designed: `currentFaceMode` is one global on the machine, written only by `setFaceWithMode()`. The 19 faces with no intrinsic mode simply inherit whatever was global |
| `unknown-command-sink` | The default is a thrown `UnknownCommandError`; `strictCommandVocabulary: false` reproduces the firmware's never-cleared sink |
| `servo-model` | The item explicitly requires that any Phase-1 slew rate be declared inferred. `slewDegPerSec` defaults to the MG90S **datasheet** 600 °/s, is documented as a simulation choice at every point it appears, is reported in `SimulatedRobotState.simulated.slewDegPerSec`, and drives only `simulatedDeg` — never `measuredDeg`, which stays `null` |

---

## 7. What V1 deliberately does **not** do

Stated so nobody mistakes the model for more than it is.

- **No `oled.frame` events.** V1 models expressions; V4 renders the 128×64
  framebuffer from them, including the empty-face bug.
- **No HTTP server.** V5 puts one in front of this, and `onPump()` is the seam
  it should use.
- **No WiFi, no mDNS, no captive-portal DNS.** `updateWifiSetup()` and
  `updateWifiInfoScroll()` are not modelled. There is no radio to model.
- **No physics.** Kinematics only — Gate E.
- **No serial CLI.** The 26 CLI commands in the map are not implemented;
  `runMovement()` and `setCurrentCommand()` cover what the CLI is for.
- **No measurement, of anything.** No physical Sesame has been used in this
  project. `provenance` is `"simulated"` on every event, `measuredDeg` is
  `null` on every joint, and the servo speed model is a datasheet number
  labelled as such wherever it surfaces.
