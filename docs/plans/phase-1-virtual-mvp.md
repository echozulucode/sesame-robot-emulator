# Sesame Lab — Phase 1 Implementation Plan
## Virtual MVP (no physical hardware) + QEMU emulation spike

**Status:** approved for execution
**Opened:** 2026-08-23
**Predecessor:** `docs/plans/phase-0-foundations-and-renode-research.md` (complete, 12 commits)
**Constraint that shapes this plan:** **no physical Sesame robot is available.**

---

## 1. What the hardware constraint actually changes

Phase 0's recommended first task was a 1–2 day physical verification sprint. It is removed.
It was carrying two loads, and they separate cleanly:

| Load | Without hardware |
|---|---|
| Joint geometry & orientation (frame mapping, per-instance poses, front/rear, left/right) | **Recoverable from the CAD.** Becomes task **V0** |
| Physical truths (horn spline quantisation, mechanical travel limits, per-robot subtrim, parts-installed-as-drawn, all Gate-B silicon items) | **Not recoverable. Deferred behind a calibration layer** |

The second group is the reason **V6 (calibration layer)** exists. Every hardware-gated value stays
data-driven and runtime-swappable, so the eventual verification is an hour of adjusting a JSON file,
not a re-architecture. Phase 0 already made `semanticName` structurally non-authoritative in
`@sesame-lab/sesame-model`; V6 extends that principle to sign, zero, limits and subtrim.

**Nothing in the Virtual MVP itself requires hardware.** The behaviour model consumes the 395
machine-readable choreography steps already extracted; the OLED and API work are pure software.

### Standing rule for this phase

Phase 0's rules carry over unchanged — provenance or it didn't happen; a precise negative result is
a deliverable; never present an inference as a measurement; agents never run `git commit`.

One addition, specific to Phase 1: **the absence of hardware must never be papered over.** Any value
that would normally be measured is marked `"verified": false` with a `wouldBeConfirmedBy` field, and
the UI must be able to say "this is simulated" rather than implying it was observed. The telemetry
protocol already requires a `provenance` tag on every event; use it honestly.

---

## 2. Scope

### In scope

| Task | Name | Depends on |
|---|---|---|
| **V0** | CAD assembly reconstruction | — |
| **V1** | Behaviour model (`SimulatedSesameRobot`) | — |
| **Q1** | Espressif QEMU spike (original ESP32) | — |
| **V2** | Articulated glTF asset pipeline | V0 |
| **V3** | R3F browser robot + joint inspector | V2, V1 |
| **V4** | Virtual OLED (128×64 canvas) | V1 |
| **V5** | Sesame-compatible HTTP API adapter | V1 |
| **V6** | Calibration layer + hardware-verification checklist | V0, V1, V3 |

### Not in scope

Lessons/curriculum content, the architecture-graph view, "See the Signal" trace UI, pose/face
editors, physics, the physical-hardware adapter, and any further Renode SoC work. Those are Phase 2+.

**Renode stays parked.** If it is ever resumed, fix `rer` first (ISSUE-20260823-002).

---

## 3. Tasks

### V0 · CAD assembly reconstruction
**Difficulty:** medium · **Agent:** `cad-reconstruction`

Replaces the hardware sprint for everything geometric. F5 already text-parsed **220 assembly
transforms** out of `Sesame-ESP32-v122.step` and confirmed the STEP names the parts
(`femur-joint-R1`…`foot-joint-L4`). What is missing is only the STL→CAD frame map: F5 found **one**
exact correspondence with the Z sign inverted and correctly refused to generalise from one sample.

Approach — a search over candidate frame maps, scored by physical self-consistency:
- Enumerate plausible STL→CAD frame transforms (axis permutations and sign flips, plus the known
  inch/mm conversion).
- For each candidate, place every STL at its CAD instance transform and score the assembly:
  mating hip/foot axes coaxial, body shells aligned, no interpenetration, joints reachable.
- Accept only if one candidate wins decisively. **A tie or a near-tie is a finding, not a
  coin-flip** — report it and fall back to marking the item unresolved.

Resolves, if it succeeds: `stl-to-cad-frame-mapping`, `per-instance-assembly-poses`,
`view-direction-of-the-labelled-drawings`, `front-rear-orientation`, `hip-to-foot-instance-naming`,
and possibly `rest-pose-hip-orientation-contradiction` and `servo-datum-plane`.

Deliverables: `hardware/assembly-map.json` (per-instance pose in a single canonical robot frame),
an updated `joint-map.json` promoting whatever is now CAD-authoritative, and
`docs/findings/V0-cad-reconstruction.md`.

---

### V1 · Behaviour model — `@sesame-lab/sesame-sim`
**Difficulty:** medium · **Agent:** `behaviour-model`

`SimulatedSesameRobot` implementing the report's `SesameRobot` interface, driven **entirely by the
395 machine-readable choreography steps** in `hardware-map.json`. No hand-transcribed movements — if
a movement is wrong, the fix belongs in the extractor.

Must reproduce real semantics, including the awkward ones Phase 0 found:
- The firmware's `constrain(angle + subtrim, 0, 180)` order, and the `motorCurrentDelay` (20 ms
  default) after each `setServoAngle`.
- `delayWithFace()` **pumps HTTP/DNS/face animation** — it is a re-entrancy point, not dead time.
  The model must schedule cooperatively, not block.
- Face playback mode is **global state set per call site**, not a per-face property.
- `setFace("stand")` and `setFace("default")` emit **nothing**, because those bitmaps are
  weak-undefined upstream (ISSUE-20260823-004). Reproduce the bug; do not fix it silently.
- `simulatedDeg` may lag `commandedDeg` via a configurable speed model; `measuredDeg` stays `null`
  because the stock robot has no position feedback.

Emits `@sesame-lab/sesame-protocol` events with `provenance: "simulated"`. Tested against the
choreography as ground truth, plus a determinism test (same commands → same event stream).

---

### Q1 · Espressif QEMU spike (original ESP32)
**Difficulty:** medium/unknown · **Agent:** `qemu-spike` · **off the critical path**

Renode's blocker is that no ESP32 SoC platform exists. Espressif maintains a QEMU fork that
**does** have a complete original-ESP32 platform, and F3 already builds a working
`distro-v1-esp32` ELF (87.1% flash) because Sesame still supports that legacy board.

Ladder, stopping and characterising at the first failure:
1. Obtain Espressif's QEMU (Windows x86-64 binaries are documented; WSL2 is an acceptable fallback
   — say which was used).
2. Boot the stock `distro-v1-esp32` image. Does it reach `setup()`? Does UART output appear?
3. If it boots: how far through F4's 20-step `bootOrder` does it get? `display.begin()` hard-fails
   into `while(1)` with no OLED present — determine whether QEMU models enough I²C, or whether a
   stub is needed.
4. If it reaches user code: build the **instrumented** variant and try to capture real
   `@SESAME servo …` lines from genuinely executing firmware.
5. If that works, point the existing Phase 0 bridge at it. **Expect zero bridge changes** — that is
   the architectural claim Path A already validated with Renode, and this would be its second
   independent confirmation.

**This is a spike, not a commitment.** A precise "QEMU boots to step N, blocked by X" is a success.
Deliverable: `docs/findings/Q1-qemu-spike.md` with a costed recommendation on whether QEMU becomes
a supported backend.

---

### V2 · Articulated glTF asset pipeline
**Depends on:** V0 · **Agent:** `asset-pipeline`

STL + V0 assembly poses → a named articulated hierarchy → GLB. Object names must be the firmware
names (`R1`,`R2`,`L1`,`L2`,`R4`,`R3`,`L3`,`L4`, `sesame_body`, `oled_screen`), with semantic aliases
only where V0 made them authoritative. Deterministic and re-runnable. The recommended top cover is
**not watertight** (ISSUE-20260823-006) — use a sound variant for the viewer and record the choice.

### V3 · R3F browser robot + joint inspector
**Depends on:** V2, V1 · **Agent:** `browser-robot`

React + TypeScript + Vite + React Three Fiber in `apps/web`. Loads the GLB, subscribes to telemetry
via the existing bridge WebSocket, drives joint rotations from `servo.target` events. All eight
joints selectable and individually inspectable. Retires the Phase 0 `debug-viewer` throwaway.
Kinematics only — **no physics** (Gate E: no near-term lesson needs it).

### V4 · Virtual OLED
**Depends on:** V1 · **Agent:** `browser-robot` (follow-on)

128×64 logical framebuffer on a scaled canvas, exact pixel geometry, using the SSD1306 GDDRAM
page-ordered encoding already specified in `docs/protocol/sesame-telemetry-v1.md`. Must render the
upstream empty-face bug truthfully rather than substituting a placeholder.

### V5 · Sesame-compatible HTTP API adapter
**Depends on:** V1 · **Agent:** `api-adapter`

`/api/status` and `/api/command` with the same contract as the real firmware, from F4's 10 recorded
routes. **Binds to localhost by default** — the report is explicit about not publishing a robot
control API onto a wider network. Note F4's finding that upstream registers every route as
`HTTP_ANY`, not GET/POST; match observed behaviour and document the divergence if we choose stricter
methods. Contract tests written backend-agnostically so a real robot can be dropped in later.

### V6 · Calibration layer + hardware checklist
**Depends on:** V0, V1, V3 · **Agent:** `cad-reconstruction` (follow-on)

Every hardware-gated value — sign, zero, angle limits, subtrim, semantic names, horn spline offset —
becomes runtime-swappable data with a calibration UI. Plus
`docs/findings/V6-hardware-verification-checklist.md`: an ordered, hour-by-hour script for what to
do the day a physical Sesame arrives, each item naming the exact value it would settle and the
issue it closes.

---

## 4. Waves

```text
WAVE 1   V0  (CAD reconstruction)        │ python/trimesh
         V1  (behaviour model)           │ pnpm
         Q1  (QEMU spike)                │ downloads/qemu
WAVE 2   V2  (glTF pipeline)             │ needs V0
         V5  (API adapter)               │ needs V1
WAVE 3   V3  (R3F robot)                 │ needs V2 + V1
WAVE 4   V4  (virtual OLED)              │ needs V1, follows V3
         V6  (calibration + checklist)   │ needs V0, V1, V3
```

Only one `pnpm install`-ing agent per wave — Phase 0 established that concurrent workspace installs
race the lockfile. The orchestrator commits between waves; agents never touch git.

---

## 5. Definition of done

- [ ] V0 either resolves the frame mapping decisively or reports precisely why it cannot
- [ ] `SimulatedSesameRobot` reproduces all 21 movement functions from extracted choreography, including the upstream empty-face bug
- [ ] Q1 answers whether real Sesame firmware executes under QEMU, with a costed recommendation
- [ ] A browser shows an articulated Sesame moving through `runWavePose`, driven by telemetry
- [ ] Virtual OLED renders faces at exact 128×64 geometry
- [ ] `/api/status` + `/api/command` pass a backend-agnostic contract suite
- [ ] Every hardware-gated value is runtime-swappable and marked unverified
- [ ] A hardware-verification checklist exists, ordered and costed
- [ ] `pnpm -r build` / `typecheck` / `test` green; all validators pass
- [ ] `reproducibility.json` extended for new assets
