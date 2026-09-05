---
type: plan
project: "Sesame Robot Emulator"
status: active
version: 6
updated: 2026-08-23
phases:
  - id: 0
    name: "Foundations & Renode Research"
    status: complete
  - id: 1
    name: "Virtual MVP (behaviour model + browser robot)"
    status: complete
  - id: 2
    name: "Learning application (architecture view, lessons, Lab mode)"
    status: complete
  - id: 3
    name: "Integration (real hardware adapter, contract tests)"
    status: out_of_scope
  - id: 5
    name: "Rust + Tauri desktop app"
    status: in_progress
  - id: 4
    name: "Renode research track"
    status: superseded_by_qemu
current_phase: 5
---

# Plan: Sesame Robot Emulator

## Standing constraint — no physical hardware, ever

Recorded 2026-08-25 at the user's direction: **this project will never run on physical hardware.**
No robot, no bare ESP32 board, no logic analyser.

This is not a temporary gap awaiting a purchase. It is permanent, and it changes what "done" means:

- **Phase 3 (real hardware adapter) is out of scope.** `RealSesameRobot` will not be built.
- **`isPhysicallyObserved()` returns false for every event this system will ever produce.** That is
  now a permanent property, not a current limitation, and the UI should read that way.
- **The V6 hardware-verification checklist is archival.** It stays as a precise record of what
  *would* settle each open value, and as the answer to "how would you know?", but it will not be
  executed. Its 13 bare-board steps are equally out of reach.
- **Values that only hardware can settle stay unverified permanently.** Semantic joint identity,
  horn spline offset, mechanical travel limits, per-robot subtrim, real servo slew, and the LEDC
  waveform (ISSUE-20260824-024). The calibration layer keeps them runtime-swappable and honestly
  marked; that is the end state, not a waypoint.
- **Emulator fidelity therefore carries more weight**, because there is no ground truth to fall
  back on. Where the emulator is inert (LEDC), the instrumented firmware hook is permanently
  load-bearing rather than a stopgap.

Educationally this is survivable and arguably clarifying: the product teaches what the *code* does,
and says so. It must never imply it is showing what a servo horn did.

## Goal

An educational engineering platform where a technically curious ~12-year-old can trace a
command end-to-end — API call → firmware function → servo angle → joint motion → OLED face —
against a virtual Sesame robot that behaves like the real one, with the same joint names,
movement sequences, faces and API vocabulary.

Architecture principle, locked in ADR-0001: **behavioural-simulator-first, Renode-ready**.
Renode is one interchangeable backend behind a common `SesameRobot` interface, never the
foundation everything else depends on.

## Phase 0: Foundations & Renode Research — COMPLETE (2026-08-23)

Full record: `docs/plans/phase-0-foundations-and-renode-research.md` (the executed plan) and
`docs/findings/PHASE-0-SUMMARY.md` (the independent audit). 11 commits, 368 tests, 7 validators.

Delivered:

| Task | Outcome |
|---|---|
| F1 Repo skeleton + reproducibility ledger | pnpm workspace, ADR-0001/0002, schema-validated ledger |
| F2 Upstream pinned | `4017305`, zero drift vs vendored copy (129/129 byte-identical) |
| F3 Firmware build baseline | 3 profiles, **bit-for-bit deterministic**, Experiment 1 PASS |
| F4 Boundary inventory | `hardware-map.json`, 1167 provenance citations, 395 choreography steps |
| F5 Asset geometry | 15 STLs measured, 8/8 pivot axes, mm units confirmed from STEP |
| F6 Joint map + `sesame-model` | 8 joints, three-way authoritative/inferred/guessed split |
| R1 Renode capability audit | 1.16.1 sidecar; `esp32s2` core executes; UART→TCP proven |
| R2 Xtensa execution ladder | All rungs PASS on real gcc output; 2 blockers root-caused |
| R3 UART probe | Compiled C → Renode → real parser → typed `servo.target` |
| R4 Boot probe | 0/20 boot steps; costed backlog; ESP32-S2 mask ROM integrated |
| R5 Telemetry protocol | `sesame-protocol`, 255 tests, chunk-boundary fuzzed |
| R6 Instrumented firmware | Two hook sites, +10KB flash, Gate B YES |
| R7 Bridge + viewer | Path A (real Renode) and Path B byte-identical |
| EXP6 OLED | Renode leg NO, instrumentation leg YES (first compile) |
| Gates A / B / Summary | Independent synthesis by an agent that did none of the work |

### Gate answers

- **Gate A — NO above the CPU line, YES below it.** Renode runs real ESP32-S2 compiler output
  correctly, but nothing above the processor exists. Both the Sesame ELF and a three-line
  Arduino sketch abort on instruction #0. Backlog ≈16–25 d to user code, +10–16 d for motion,
  Wi-Fi uncostable.
- **Gate B — YES via instrumented firmware.** Exactly one `Servo::write()` call site exists in
  the entire firmware; all 223 servo steps route through the single hook.
- **Gate D (API parity)** — not implemented; evidence says it is achievable at a host proxy
  independent of Wi-Fi emulation.
- **Gates C / E / F** — out of Phase 0 scope.

## Phase 1: Virtual MVP — COMPLETE (2026-08-23)

Executed without a physical robot. Plan: `docs/plans/phase-1-virtual-mvp.md`. 7 commits,
674 tests, 10 validators.

| Task | Outcome |
|---|---|
| V0 CAD assembly reconstruction | Frame map resolved by **8876×**; closed 7 unresolved items + F6 item 7 |
| V1 Behaviour model | `@sesame-lab/sesame-sim`, 15 upstream quirks reproduced, 129 tests |
| Q1 QEMU spike | **Real firmware executes**, bootOrder 7/20, `setup()` entered |
| V2 glTF pipeline | `assets/sesame.glb`, stand residual 2.065e-6 mm through the written GLB |
| V5 API adapter | `@sesame-lab/sesame-api`, Gate D implemented, 15-case contract suite |
| V3 Browser robot | `apps/web`, R3F, both backends, QEMU-driven scene demonstrated |
| V4 Virtual OLED | 8× canvas + 3D projection, empty-face bug rendered honestly |
| V6 Calibration layer | 81 values runtime-swappable; 28-step, 10h15m hardware checklist |

**The headline result:** real Sesame firmware under QEMU → UART0 → the *unmodified* Phase 0
bridge → the R3F scene, 8 joints from 21 `observed` events. The report's claim that the browser
would change zero architecture when a firmware backend arrived is now demonstrated, twice, on
two different emulators.

**Cancelled:** the physical-hardware sprint (P1-0). V0 replaced it for everything geometric;
the remainder is deferred behind V6's calibration layer.

## Phase 2: Learning application — COMPLETE (2026-08-26)

The product the research report is actually about.

- [x] **L1** Interactive architecture graph (React Flow) with cross-pane highlighting — 63 nodes / 65 edges derived from `hardware-map.json`; 5 hand-authored nodes enumerated and dashed
- [x] **L1** "See the Signal" causal traces — per-layer provenance; `pwm.output` stays `INFERRED` on both backends per Q3
- [x] **L3** Source annotation data — 90 symbols, 39 concepts, 17 teaching notes, resolving `file:line` provenance
- [x] **L4** Source explorer UI — four synchronised panes, build-time source bundling with two independent hash-refusal gates, zero new dependencies
- [x] **L5** Lesson content as data — 19 lessons / 74 steps / 74 checkable conditions; **Gate F mechanically enforced**, 44/44 factual claims resolve
- [x] **L6** Lesson runner UI — lessons 1–6 fully playable; 16/22 controls, 26/34 checks built, the rest fail loudly and cannot complete a step
- [x] **L7** Lab mode — five tabs composing L6's editors; C++ export verified against `movement-sequences.h` and round-tripped by two independent parsers

**Decided and done:** QEMU adopted as `QemuSesameRobot` (Q2), wired to the browser (V7), and its
LEDC fidelity characterised (Q3). Renode closed `wont_fix`.

**Open question out for external research:** whether abandoning Renode was correct —
`docs/research/renode-fit-deep-research-prompt.md`.

## Phase 3+: what is left

Phase 3 (real hardware adapter) is **out of scope** — see the standing constraint.

Carried forward from Phase 2's own findings, none blocking:

- **Loop playback** in Lab needs the firmware's `pressingCheck()` cancel path, which the in-process
  simulator serialises away.
- **Multi-frame face animations** — `emitFaceHeader` already takes a `frameIndex`; the frame-strip
  UI does not exist.
- **A `serial-console` control** — the only affordance that reaches subtrim on the lab-host and
  bridge backends, where the sliders are correctly disabled rather than inert.
- **Six deferred lesson controls and eight check types**, needed only by the thirteen outline
  lessons. They fail visibly today and cannot complete a step.
- **Reconcile a data inconsistency**: `vocabularies.faults` has **four** entries with
  `injectorIsLabFeature: false` while `debug-a-robot`'s text and `L5-lesson-content.md` §6.6 both
  say three.
- **Document the CRLF/trim conventions** in `source-annotations.json` that L4 had to reverse-engineer.

## Phase 5: Rust + Tauri desktop app — IN PROGRESS

Plan: `docs/plans/phase-5-tauri-desktop-app.md`. A double-clickable app for the user's nephew,
while `just dev` and the local web server stay exactly as they are.

- [x] **T1** Tauri scaffold — app renders in a desktop window and as a release exe, on the simulator
- [x] **T2** Resource bundling — 13 files / 75.4 MiB, verified in a literally empty directory
- [x] **T3** Rust supervisor — job-object teardown, raw bytes, 0 orphans under adversarial kill
- [x] **T4** `TauriSesameRobot` — 15/15 contract cases, no case adjusted
- [x] **T5** Honesty asserted against the packaged artifact; the `tauri.localhost` guard proved to fail
- [ ] **T6** Installer, icons, first run — in progress
- [ ] **T7** Both targets verified in one pass

**Architecture (§4, Option C):** Rust does only what a browser cannot — spawn QEMU, hold the socket,
stream raw bytes, retry the boot, stamp origin. The `@SESAME` parser, the sim, the lessons and the
UI are reused unchanged. Porting the parser would have meant re-earning an invariant proven across
~1,500 split offsets and 255 tests.

## Public release — prepared, not yet done

`LICENSE` (Apache-2.0), `NOTICE`, `THIRD-PARTY-NOTICES.md` and `README.md` are in. Two items were
removed from the tree before publishing: a tracked arduino-cli `installation.secret`, and a home
directory plus session UUID embedded in five Renode logs. **Both are still in history**, which
`origin/main` already has — see `docs/findings/PUBLIC-RELEASE-CHECKLIST.md` for the agreed
`git filter-repo` pass, to be run only after T7.

The arduino-cli identity was **rotated on 2026-09-02** (file deleted; the CLI regenerates one), so
the value in history is inert.

Open decisions recorded there: the three-year GPL offer address, the permanent source URL, and
whether same-release attachment satisfies "accompany" for a network download.

## Phase 4: Renode track — SUPERSEDED by QEMU

Q1 established that Espressif's QEMU delivers, free and vendor-maintained, what the Renode SoC
track was costed at ≈16–25 d to reach. Renode is no longer merely parked; it is superseded for
the firmware-execution use case.

Retained findings, should anyone resume it: fix `rer` first (ISSUE-20260823-002, it destroys the
emulator at the first fault), then the LX7 opcode table (ISSUE-20260823-003). Do **not** start
LEDC modelling.

## Decisions Made

| Date | Decision | Rationale |
|------|----------|-----------|
| 2026-08-23 | Behavioural-simulator-first; Renode as one backend (ADR-0001) | Decouples the product from the highest-risk research problem |
| 2026-08-23 | Renode 1.16.x portable sidecar, system 1.15.3 untouched (ADR-0002) | ESP32 UART model postdates 1.15.3; clobbering a user install is hard to reverse |
| 2026-08-23 | Agents never commit; orchestrator commits per wave | Concurrent agents racing the git index corrupts it |
| 2026-08-23 | Never edit `firmware/upstream/`; instrumentation is a patch file | Keeps upstream pristine and the patch deletable wholesale later |
| 2026-08-23 | Telemetry emits on `Serial0`, not bare `Serial` | Makes routing a property of the instrumentation, not of a board menu |
| 2026-08-23 | OLED framebuffer hook ships compiled out (`SESAME_TELEMETRY_OLED 0`) | 1385 B ≈ 120 ms at 115200 against a 20 ms budget |
| 2026-08-23 | `semanticName` structurally non-authoritative until physically verified | Prevents a guessed left/right mapping being baked in as fact |
| 2026-08-23 | Gate reports written by an agent that performed none of the work | Independent verification found 6 real defects the authors missed |
| 2026-08-23 | Phase 1 starts with a hardware sprint, not with code | Cheapest way to convert 10 open unknowns into facts |
| 2026-08-23 | **Reversed:** hardware sprint cancelled, replaced by V0 CAD reconstruction | No physical robot available; the CAD carried the geometry and settled it by an 8876x margin |
| 2026-08-23 | Adopt QEMU over Renode for firmware execution | QEMU reaches `setup()` today; Renode was costed at 16-25 d to get there |
| 2026-08-23 | `SimulatedSesameRobot` stays the default backend, QEMU is opt-in | Lessons need determinism and speed; QEMU earns its place for showing real firmware |
| 2026-08-23 | Calibration layers over the joint map, never forks it | One authoritative geometry source; calibration must not become a laundering mechanism |
| 2026-08-25 | No physical hardware, ever; Phase 3 out of scope | User direction. Makes unverifiable values a permanent end state and raises the weight on emulator fidelity |
| 2026-08-25 | Adopt QEMU as a supported backend; Renode closed | QEMU enters setup() today and drives the browser; Renode was 16-25 d from user code |
| 2026-08-23 | Calibration UI deferred to Phase 2 | `rig.ts` throws if `neutralCommandedDeg != 90`; doing it properly means touching a finished package |

## Errors Encountered

| Date | Error | Resolution |
|------|-------|------------|
| 2026-08-23 | `git apply` silent no-op: scratch sketch inside the work tree, paths resolved against repo root, printed `Skipped patch`, **exited 0** — S3 and V1 profiles compiled the S2 Mini config | Throwaway `git init` in scratch dir; caught only by the hardware-map pin assertion |
| 2026-08-23 | Telemetry emitted on USB-CDC, not UART0 — would have worked perfectly onto a transport nobody listens to | Switched to `Serial0`; regression test asserts the routing decision, not string presence |
| 2026-08-23 | `core.autocrlf=true` rewrote checked-out files; git's stat cache then reported the tree clean while bytes on disk were wrong | `.gitattributes` pins LF; fetch scripts assert via `git ls-files --eol` |
| 2026-08-23 | `hardware-map.json` carried `upstreamCommit: null` — 1167 citations pointing into an unnamed commit | Set + cross-artifact assertion against `upstream.pin.json`, exercised negatively |
| 2026-08-23 | F5 provenance pointed at the untracked `reference/` tree, absent from a clean clone | Re-pointed at `firmware/upstream/` after re-hashing all 17 files; hashes unchanged |
| 2026-08-23 | Plan gap: promised the report's experiments 1–7 but never assigned the OLED experiment | Closed as `docs/findings/EXP6-oled.md` during closeout |
| 2026-08-23 | Four wrong numbers in findings docs (R4 headline didn't sum; R2 coverage ambiguous; R6/R7 patch size; "all 21" functions) | Corrected in place with dated notes |
| 2026-08-23 | Repeated claim that the OLED is a hard boot blocker was wrong | `Adafruit_SSD1306::begin()` fails only on malloc, never on I2C ACK; Q1 passed steps 4-5 with no display modelled |
| 2026-08-23 | QEMU's flash model has no Quad-Enable bit; the QIO bootloader panics in `init_flash` | Rebuild with `FlashMode=dio` - 67 bytes of 1,141,552 differ, all metadata, zero instruction bytes |
