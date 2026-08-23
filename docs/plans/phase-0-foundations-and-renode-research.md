# Sesame Lab — Phase 0 Implementation Plan
## Workstream F (Foundations) + Workstream R (Renode research)

**Status:** approved for execution
**Source of truth:** `research/Sesame Lab_ Emulator, Virtual Robot, and Interactive Engineering Learning Platform.md`
**Scope:** the `Foundations` and `Renode research` sections of the roadmap Gantt only.
**Date opened:** 2026-08-23

---

## 1. Scope

### In scope

From the roadmap Gantt:

| Gantt bar | This plan |
|---|---|
| Foundations → *Firmware build + architecture freeze* | **F1–F4** |
| Foundations → *Asset/joint validation* | **F5–F6** |
| Renode research → *Renode S2/S3 spike* | **R1–R4** |
| Renode research → *Minimal telemetry path* | **R5–R7** |

From the emulator-phase table, this plan completes: `Build baseline`, `Boundary inventory`, `Renode probe`, `Sesame boot probe`, `Telemetry hook` (instrumented variant), `Bridge`.

From the ten decision experiments, this plan runs experiments **1–7** and answers **Gate A** and **Gate B**.

### Explicitly NOT in scope

No React/R3F app, no lessons, no `SimulatedSesameRobot` behavior model, no physics, no OLED editor, no `one-for-all/sesame-robot-sim` reuse audit (Gate C), no physical-hardware adapter, no Wi-Fi emulation, no LEDC/I²C peripheral modeling. Those are Virtual-MVP / Learning / Integration phases.

The one deliberate scope stretch: **R7 ships a browser page**. It is a ~150-line raw-Canvas debug harness whose only job is to prove the telemetry protocol end-to-end. It is a throwaway, not the product frontend, and is named `debug-viewer` to keep that honest.

### Non-goals guarding against scope creep

- We do **not** fork Sesame firmware. Upstream stays pristine; instrumentation lives in `firmware/patches/` as a `.patch` file applied at build time.
- We do **not** write ESP32 peripheral models in this phase. If R3/R4 shows they are required, that is a *finding*, and it feeds the Phase-1 estimate.
- We do **not** guess joint geometry. Anything unverified against STL/CAD is recorded as `"verified": false` and blocks nothing but is never presented as fact.

---

## 2. Ground truth established before planning

Probed on this machine, 2026-08-23:

| Fact | Value | Consequence |
|---|---|---|
| Repo | `C:\Projects\sesame-robot-emulator`, git init'd, **0 commits** | F1 must create the initial commit and .gitignore before anything downloads |
| `reference/sesame-robot-main/` | untracked local copy of upstream Sesame, matches report | becomes `firmware/upstream/` pinned properly in F2 |
| node / pnpm / python / dotnet / rust | 24.13.0 / 10.34.1 / 3.13.13 / 10.0.301 / 1.95.0 | monorepo + bridge + future C# peripherals all viable |
| `arduino-cli` | **absent** | F3 installs it *portable, in-repo* — no machine-wide mutation |
| Renode | **v1.15.3** at `C:\Program Files\Renode` | older than the v1.16.1 that added the ESP32 UART model |
| Renode Xtensa assets | `platforms/cpus/xtensa-sample-controller.repl` — the only Xtensa file; **zero** ESP32 files | empirically confirms the report's "no official ESP32 platform" finding |
| Network | github.com 200, downloads.arduino.cc 302, builds.renode.io 200 | all downloads viable; `raw.githubusercontent.com` had a TLS-revocation warning — use `github.com` release URLs |

**Renode version decision:** install **v1.16.1+ portable, side-by-side**, under `tools/renode/`. Do not upgrade or touch `C:\Program Files\Renode`. Rationale: the ESP32 UART model landed after 1.15.3, so probing on 1.15.3 would produce a false negative; and clobbering the user's system install is an unnecessary, hard-to-reverse change.

**Firmware parity confirmed:** the local reference copy matches every claim the report makes about pins/addresses/constants, so the report can be trusted as a spec for the boundary inventory rather than re-derived from scratch — but F4 still extracts from *source*, not from the report.

---

## 3. Repository layout created by this phase

Only the directories Phase 0 actually fills. The rest of the monorepo tree in the report is created when its phase arrives.

```text
sesame-robot-emulator/
├── docs/
│   ├── plans/phase-0-foundations-and-renode-research.md   ← this file
│   ├── decisions/                     ADR-0001..N
│   └── findings/                      gate reports, spike write-ups
├── packages/
│   ├── sesame-model/                  JointName, RobotState, joint-map (TS)
│   └── sesame-protocol/               SesameTelemetry union + framing codec (TS)
├── emulator/
│   ├── renode/{platforms,scripts,probes,tests}/
│   └── bridge/                        UART-socket → WebSocket service (TS)
├── firmware/
│   ├── upstream/                      pinned upstream checkout (gitignored)
│   ├── patches/                       instrumentation patches
│   ├── probes/                        minimal ELF sketches for R2–R4
│   ├── build/                         arduino-cli profiles + build scripts
│   └── artifacts/                     ELF/bin/map + build-manifest.json (gitignored)
├── hardware/
│   ├── hardware-map.json              boundary inventory (F4)
│   └── joint-map.json                 joint geometry + semantics (F6)
├── tools/                             portable arduino-cli, renode (gitignored)
└── debug-viewer/                      throwaway canvas harness (R7)
```

---

## 4. Workstream F — Foundations

### F1 · Repo skeleton, reproducibility ledger, initial commit
**Difficulty:** low · **Depends on:** nothing · **Agent:** `repo-foundation`

- pnpm workspace root (`package.json`, `pnpm-workspace.yaml`, `tsconfig.base.json`), strict TS.
- `.gitignore`: `tools/`, `firmware/upstream/`, `firmware/artifacts/`, `node_modules/`, `**/dist/`, `*.elf`, `*.bin`, `*.map`.
- `docs/decisions/ADR-0001-behavioral-simulator-first.md` — records the report's headline decision and the Renode-as-backend inversion.
- `docs/decisions/ADR-0002-renode-portable-sidecar.md` — records the side-by-side 1.16.x decision and why 1.15.3 is unsuitable.
- `reproducibility.json` **schema + a populated instance** covering every field in the report's checklist (upstream commit, lab commit, Arduino core version, ESP32Servo/SSD1306/GFX versions, board FQBN, build flags, ELF SHA-256, Renode version, repl/resc versions, asset version, joint-map version, lesson-content version). Fields not yet known are `null`, never absent.
- Initial commit; every later task commits on top.

**Done when:** `pnpm install` succeeds on a clean clone, `git log` is non-empty, ADR-0001/0002 exist, `reproducibility.json` validates against its own schema.

---

### F2 · Pin upstream Sesame at an exact commit
**Difficulty:** low · **Depends on:** F1 · **Agent:** `repo-foundation`

- `scripts/fetch-upstream.ps1` + `.sh`: clone the upstream Sesame repository (resolve the real remote from the local copy's provenance; if the upstream URL cannot be confirmed, fall back to the vendored copy and record that) at a **pinned SHA** into `firmware/upstream/`.
- Diff the pinned checkout against `reference/sesame-robot-main/`. **Any difference is a finding**, written to `docs/findings/F2-upstream-drift.md`, because the vendored copy is what the report was written against.
- Record SHA + resolved date in `reproducibility.json`.

**Done when:** the script is idempotent, produces a byte-identical tree on re-run, and the drift report exists (even if it says "no drift").

**Fallback:** if upstream cannot be resolved or cloned, `reference/sesame-robot-main/` is promoted to `firmware/upstream/` with a `PROVENANCE.md` stating it is a vendored snapshot of unknown SHA. Phase 0 continues; the unknown SHA becomes a tracked risk, since the report explicitly warns lessons must cite a pinned commit.

---

### F3 · Reproducible firmware build baseline (Experiment 1)
**Difficulty:** medium · **Depends on:** F2 · **Agent:** `firmware-build`

This is the hard gate the report places before all emulator work: *"no emulator work before pass."*

- Install `arduino-cli` **portable** into `tools/arduino-cli/`; set `ARDUINO_DIRECTORIES_*` so the ESP32 core and libraries land in `tools/arduino-data/` — nothing global, nothing in `~/AppData/Local/Arduino15`.
- Pin the `esp32` core to an exact version (record it; do not use `latest`).
- Pin libraries exactly, notably **ESP32Servo 3.0.9** — the report flags later versions as behaviourally different — plus Adafruit SSD1306 and Adafruit GFX.
- Author `firmware/build/profiles/` for the three configurations, using arduino-cli **sketch profiles** so the pinning is declarative and checked in:
  - `s2mini` → `esp32:esp32:lolin_s2_mini` (the checked-in active config)
  - `distro-v3-s3` → `esp32:esp32:esp32s3` (USB-CDC-on-boot, 4 MB SPIFFS partition per the report)
  - `distro-v1-esp32` → `esp32:esp32:esp32` (legacy; also the Espressif-QEMU fallback target)
- The S3 and V1 configs require *un-commenting* the alternate pin/I²C blocks. Do that with **build-time patches in `firmware/patches/`**, never by editing `firmware/upstream/`.
- `scripts/build-firmware.ps1 <profile>` → emits `.elf`, `.bin`, `.map` + `build-manifest.json` (SHA-256 of each, toolchain versions, flags) into `firmware/artifacts/<profile>/`.
- **Determinism check:** build twice, clean, compare ELF SHA-256. If they differ, isolate the cause (timestamp/path embedding is the usual culprit) and either eliminate it or document it precisely as a known non-determinism.

**Done when:** all three profiles build clean; artifacts + manifests emitted; determinism result documented either way; versions written into `reproducibility.json`.

**Risk:** the ESP32 Arduino core is a multi-GB download and the first build is slow. Budgeted; s2mini is built first so downstream Renode work can start before S3/V1 finish.

---

### F4 · Boundary inventory → `hardware/hardware-map.json`
**Difficulty:** low · **Depends on:** F2 (source only — runs in parallel with F3) · **Agent:** `boundary-inventory`

Extracted **from pinned source**, each entry carrying `file` + `line` provenance so lessons can satisfy the report's Gate F.

- **Boards:** all four pin configurations (S2 Mini active `{1,2,4,6,8,10,13,14}` / I²C 33,35; Distro V3 `{4,5,6,7,10,11,12,13}` / 8,9; V2 `{4,5,6,7,15,16,17,18}`; V1 `{15,2,23,19,4,16,17,18}` / 21,22) with which is active.
- **Servos:** firmware index order `R1,R2,L1,L2,R4,R3,L3,L4` — captured as an ordered array so the non-geometric order can never be silently re-sorted. Plus `attach()` endpoints 732–2929 µs, 50 Hz, 4 PWM timers, `motorCurrentDelay` default, subtrim, 0–180 clamp.
- **Display:** 128×64, `0x3C`, reset -1, and the **hard-fail-on-init-failure boot path** — flagged as a boot blocker for unmodified-firmware emulation.
- **Network:** AP SSID/pass, station flags, every HTTP route with method and handler symbol. Cross-check AP SSID against the docs (the report notes a `-BETA` drift) and record any doc/source mismatch.
- **Movement sequences:** every `run*Pose`/movement function, its ordered `setServoAngle` calls and delays, as machine-readable data. This is the raw material the Phase-1 behavior model consumes, and it must come from source, not prose.
- **Faces:** expression names, frame counts, playback modes (loop/once/boomerang), frame rates.
- **Boot order:** the exact `setup()` sequence — serial → I²C → SSD1306 (hard fail) → Wi-Fi → server → servo timers → attach. R4 uses this as its milestone ladder.

Ship a JSON Schema and a validator (`pnpm validate:hardware-map`).

**Done when:** schema validates; every servo/OLED/network/movement boundary present with source provenance; doc-vs-source drift list written to `docs/findings/F4-doc-drift.md`.

---

### F5 · Mechanical asset inventory + STL geometry extraction
**Difficulty:** medium · **Depends on:** F2 · **Agent:** `asset-pipeline`

- Inventory `hardware/printing/stl/` (11 printed pieces: internal frame, top/bottom covers, `R1–R4`, `L1–L4`) and the CAD `.step` / `.f3z`.
- For each STL: bounding box, volume, centroid, mesh integrity, units. Python + `numpy-stl`/`trimesh`, run in a venv under `tools/`.
- Derive candidate joint pivot axes/positions from the servo-horn bosses in the STL geometry. **Measured, with a stated confidence, never guessed.**
- Output `hardware/assets-inventory.json`.

**Done when:** all 11 pieces measured; per-part pivot candidates recorded with confidence; unresolved parts explicitly listed as unresolved.

---

### F6 · Joint map + `sesame-model` package (Gate-F-compliant naming)
**Difficulty:** medium · **Depends on:** F4, F5 · **Agent:** `asset-pipeline`

- `hardware/joint-map.json`: for each of the 8 joints — `firmwareName` (`R1`…`L4`), firmware index, servo pin per board, `semanticName` (e.g. `right_front_hip`) **with `"verified": false` until physically confirmed**, rotation axis, zero-reference, direction sign, angle limits, parent link.
- The report is explicit: do not serialize front-left/front-right names as canonical until the mapping is verified. Enforce that in code — `semanticName` is optional in the type and unverified entries are non-authoritative.
- `packages/sesame-model` (TS): `JointName` union in **firmware order**, `RobotState`, `SesameCapabilities`, `JOINT_ORDER` constant, joint-map loader + runtime validator.
- Unit tests asserting the order is `R1,R2,L1,L2,R4,R3,L3,L4` — a regression guard against someone "fixing" it to alphabetical.

**Done when:** package builds, tests pass, joint-map validates, every unverified claim is machine-readably marked unverified.

---

## 5. Workstream R — Renode research

Runs in parallel with F from day one. Its only hard dependency on F is F3's ELF (for R4); R1–R3 use their own minimal ELFs.

**Standing rule for this workstream:** a negative result, precisely characterised, is a successful deliverable. The report's whole point is collapsing uncertainty. An agent that reports "blocked, here is the exact instruction/register/peripheral that stopped us, here is the evidence" has succeeded. Fabricating or overstating progress is the only failure mode that matters.

### R1 · Renode 1.16.x portable sidecar + Xtensa capability audit
**Difficulty:** low · **Depends on:** F1 · **Agent:** `renode-platform`

- Fetch Renode **1.16.1 or newer** portable Windows build → `tools/renode/`. Do not touch the system install.
- Verify the version actually contains what the report claims: search the distribution for the **ESP32 UART model**, Xtensa CPU support, and any ESP32 `.repl`. Record what exists and what does not, with file paths.
- Smoke-test `xtensa-sample-controller.repl` — get *some* Xtensa core executing *something* under this Renode.
- Audit which generic building blocks are reusable for an ESP32 platform (generic UART/timer/GPIO/I²C models), which downgrades individual "likely new model" rows in the report's feasibility matrix.

**Done when:** `docs/findings/R1-renode-capability-audit.md` states the exact version, the exact Xtensa/ESP32 assets present, and a revised feasibility matrix with evidence per row.

---

### R2 · Minimal Xtensa execution probe (Experiment 2)
**Difficulty:** high/unknown · **Depends on:** R1, F3 (toolchain) · **Agent:** `renode-platform`

- Build a **freestanding** minimal Xtensa ELF for the S2 (LX7) target — known instruction loop, symbol at a known address — using the xtensa toolchain that the ESP32 Arduino core installs in F3.
- Author the smallest plausible `.repl` (CPU + RAM only) and a `.resc` that loads it.
- Try to reach a breakpoint / observe PC advance.

**Pass:** Renode executes target Xtensa instructions and reaches a known symbol.
**Fail:** documented with the exact failure — unsupported CPU type string, missing config register, translation abort — plus the Renode log.

**Gate A input.** The report: *if this fails, stop the full-Renode path.*

---

### R3 · Minimal UART probe (Experiment 3)
**Difficulty:** high · **Depends on:** R2 · **Agent:** `renode-platform`

- Add the ESP32 UART model (if R1 found one) to the `.repl`, mapped at the S2 UART0 base address from the ESP32-S2 TRM.
- Tiny program that writes a known string to UART0.
- Expose the UART over a **host TCP socket** — the report's recommended data plane and the one Windows-friendly integration boundary.

**Pass:** the exact expected string is read from a TCP client on the host.
**Fail:** documented at the register level — which access faulted, at what address.

This establishes the **bridge primitive** that R5–R7 depend on.

---

### R4 · Arduino startup + Sesame boot probe (Experiments 4 & 5)
**Difficulty:** high · **Depends on:** R3, F3, F4 · **Agent:** `renode-boot`

Escalating ladder — stop at the first rung that fails and characterise it precisely:

1. Empty Arduino sketch (`setup()` prints a marker, `loop()` empty), built by F3's real toolchain, loaded into Renode. Does the Arduino-ESP32 runtime reach user `setup()`?
2. If yes: the real Sesame ELF from F3. Using F4's boot-order ladder — serial init → `Wire.begin` → `display.begin()` → Wi-Fi → server → servo attach — find the **exact first unsupported block**.
3. Instrument with Renode's stop-on-unimplemented-access tracing and the GDB server to get the failing PC, symbol, and MMIO address.

**Deliverable:** `docs/findings/R4-boot-probe.md` — how far execution got, the exact first blocker with address + symbol + source line, and a **prioritised list of missing peripheral models with effort estimates**. That list is the single most valuable output of this workstream: it converts the report's "unknown, weeks-to-months" into a costed backlog.

**Expected outcome, stated honestly up front:** based on R1's likely findings, this probe is **more likely to produce a precise blocker report than a booting robot**. That is the planned-for success case.

---

### R5 · Telemetry protocol package `packages/sesame-protocol`
**Difficulty:** low · **Depends on:** F6 · **Agent:** `telemetry-bridge` · **runs in parallel with R2–R4**

Deliberately independent of whether Renode ever boots — this is the contract that lets the Phase-1 frontend be written against a simulator and later swapped to Renode with, in the report's words, *zero architecture change*.

- TS discriminated union exactly as specified: `servo.target`, `face.expression`, `oled.frame`, `log`, with `seq` and optional `simTimeUs`.
- Add the provenance tag the report's "See the Signal" section requires: every event carries `observed | simulated | inferred`. Teaching fidelity must be machine-readable, not a UI convention.
- Wire framing for the UART line protocol: `@SESAME servo R4 72` and `@SESAME face wave 0` — parser + serializer, both directions, with a fuzz / round-trip test.
- `traceId` threading for causal traces.

**Done when:** package builds, round-trip tests pass including malformed/partial-line input (a UART stream splits mid-line — the parser must handle it).

---

### R6 · Instrumented-firmware telemetry hook (Experiment 7 / Gate B)
**Difficulty:** medium · **Depends on:** F3, F4, R5 · **Agent:** `telemetry-bridge`

The report's Gate-B fallback, made primary because it is cheap and unblocks everything:

- `firmware/patches/telemetry-instrumentation.patch` — emits `@SESAME servo <name> <deg>` at the **single convergence point** in `setServoAngle()`, and `@SESAME face <name> <frame>` at the face-render point. Two hook sites, not one per movement function.
- Applied at build time to produce a `s2mini-instrumented` profile. Upstream stays pristine; the patch is designed to be deleted wholesale once real LEDC/I²C models exist.
- **Verify on real silicon if any ESP32 board is available; otherwise verify at build + disassembly level** and mark hardware verification as pending.

**Done when:** the instrumented profile builds, the emitted line format matches R5's parser byte-for-byte (test asserts against the actual firmware string literal, not a copy of it).

---

### R7 · Bridge service + end-to-end proof (Experiment 8)
**Difficulty:** low–medium · **Depends on:** R5, R6, and *either* R3 (real Renode UART) *or* the loopback fallback · **Agent:** `telemetry-bridge`

- `emulator/bridge/`: Node/TS service. UART TCP socket in → framing parser → typed telemetry → **WebSocket** out. Reconnectable on both sides; buffers across reconnects; emits `log` events for its own lifecycle.
- `debug-viewer/`: throwaway static page. Raw canvas, 8 labelled joint bars + a 128×64 pixel grid. No React, no build step, no dependencies.
- **Two proof paths, and we ship whichever we can:**
  - **Path A (preferred):** Renode → emulated UART socket → bridge → WebSocket → viewer.
  - **Path B (fallback, always achievable):** a replay harness feeds recorded/synthesised `@SESAME` lines into the same TCP socket → same bridge → same viewer. This proves the *entire* pipeline except the emulator, and it is exactly the seam Phase 1 needs.
- Contract test: identical telemetry through Path A and Path B produces identical WebSocket output. That is what makes the backends interchangeable.

**Done when:** at least Path B works end-to-end with a joint visibly moving in the browser from a telemetry stream; Path A attempted and its result documented either way.

---

## 6. Gate reports (the actual point of Phase 0)

Three documents, written last, by a dedicated agent that did not perform the work:

- `docs/findings/GATE-A-renode-boot.md` — Can Renode execute a target S2/S3 Arduino binary far enough to reach user code? YES → pursue hybrid firmware emulation. NO → sized estimate of missing CPU/SoC work, split small-enough-to-implement vs. keep-as-research-track.
- `docs/findings/GATE-B-servo-extraction.md` — Can a servo target be captured deterministically? Records whichever of {emulated peripheral, instrumented firmware} works.
- `docs/findings/PHASE-0-SUMMARY.md` — every experiment's result, every gate's answer, a **corrections list where our empirical findings contradict the research report**, and a costed, evidence-backed Phase-1 recommendation.

The corrections list matters. The report is a research document written partly from web sources; where this machine's evidence disagrees with it, the evidence wins and the disagreement is recorded explicitly rather than quietly smoothed over.

---

## 7. Agent team and execution waves

Seven specialist agents plus an independent reporter. Fan-out is bounded by real dependencies, not by optimism.

| Agent | Owns | Skills leaned on |
|---|---|---|
| `repo-foundation` | F1, F2 | monorepo / TS / tooling |
| `firmware-build` | F3 | Arduino / ESP32 / arduino-cli |
| `boundary-inventory` | F4 | C++ source reading, schema design |
| `asset-pipeline` | F5, F6 | STL/CAD geometry, Python, TS |
| `renode-platform` | R1, R2, R3 | Renode, Xtensa, ESP32 TRM |
| `renode-boot` | R4 | Renode + Arduino-ESP32 startup + GDB |
| `telemetry-bridge` | R5, R6, R7 | TS, sockets, WebSocket, firmware patching |
| `gate-reporter` | Gate A/B/summary | independent synthesis |

### Waves

```text
WAVE 0   F1                                    (serial — everything needs the skeleton)

WAVE 1   F2 ──┬──────────────────────────────► F3   (firmware build; long download)
              ├──────────────────────────────► F4   (boundary inventory, source-only)
              └──────────────────────────────► F5   (STL geometry)
         R1   (renode sidecar + audit — independent, starts immediately)

WAVE 2   F6   (needs F4 + F5)
         R2   (needs R1 + F3 toolchain)
         R5   (needs F6 — starts as soon as F6 lands)

WAVE 3   R3   (needs R2)
         R6   (needs F3 + F4 + R5)

WAVE 4   R4   (needs R3 + F3 + F4)
         R7   (needs R5 + R6, opportunistically R3)

WAVE 5   Gate A / Gate B / Phase-0 summary
```

Critical path: `F1 → F2 → F3 → R2 → R3 → R4`. F3's multi-GB core download is the single largest schedule risk, which is why R1 is deliberately pulled forward off the critical path and F4/F5 are source-only so they never wait on a compiler.

### Rules every agent operates under

1. **Report negative results precisely.** "Blocked at address 0x3FF40000, unimplemented MMIO, log attached" is a deliverable. A vague "didn't work" is not, and a fabricated success is a serious failure.
2. **Never edit `firmware/upstream/`.** Instrumentation is a patch file, always.
3. **Provenance or it didn't happen.** Every extracted fact carries `file:line`. Every unverified inference is marked `"verified": false`.
4. **No machine-wide installs.** Everything portable, under `tools/`, gitignored.
5. **Commit per completed task**, with the task ID in the message.
6. **Contradicting the research report is expected and welcome** — record it in the findings.

---

## 8. Definition of done for Phase 0

- [ ] Clean clone → `pnpm install` → `pnpm build` → `pnpm test` all green
- [ ] All three firmware profiles build; ELF SHA-256s recorded; determinism characterised
- [ ] `hardware-map.json` + `joint-map.json` validate, with full source provenance
- [ ] `packages/sesame-model` + `packages/sesame-protocol` in the workspace with tests
- [ ] Renode 1.16.x sidecar installed; capability audit written with evidence
- [ ] Experiments 1–7 each have a recorded pass/fail with evidence
- [ ] Gate A and Gate B answered
- [ ] Telemetry flows end-to-end to a browser (Path A or Path B)
- [ ] `reproducibility.json` fully populated for every artifact produced
- [ ] Phase-0 summary with corrections to the research report and a costed Phase-1 recommendation
