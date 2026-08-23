---
type: plan
project: "Sesame Lab"
status: active
version: 2
updated: 2026-08-23
phases:
  - id: 0
    name: "Foundations & Renode Research"
    status: complete
  - id: 1
    name: "Virtual MVP (behaviour model + browser robot)"
    status: pending
  - id: 2
    name: "Learning application (architecture view, lessons, Lab mode)"
    status: pending
  - id: 3
    name: "Integration (real hardware adapter, contract tests)"
    status: pending
  - id: 4
    name: "Renode research track (off critical path)"
    status: research
current_phase: 1
---

# Plan: Sesame Lab

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

## Phase 1: Virtual MVP — NEXT

Ordering below is the Phase-0 recommendation, evidence-backed.

- [ ] **P1-0 Physical hardware verification sprint (1–2 d) — DO THIS FIRST.**
      Highest evidence-per-day item in the programme. Converts 8 unverified joint semantic
      names into facts and closes the Gate B silicon list. Ten open questions reduce to
      "put the robot on a desk and look at it." See `issues.yaml` ISSUE-20260823-007/008.
- [ ] **P1-1 Behaviour model (6–10 d).** `SimulatedSesameRobot` consuming the 395
      machine-readable choreography steps in `hardware-map.json`.
- [ ] **P1-2 R3F browser robot (8–12 d).** Articulated glTF from the F5/F6 geometry.
- [ ] **P1-3 API adapter (4–6 d).** `/api/status` + `/api/command` parity at a host proxy.
- [ ] **P1-4 OLED framebuffer in browser (2–4 d).** 128×64 canvas; encoding already specified.

## Phase 4: Renode research track — funded, OFF the critical path

- [ ] Fix `rer` first (0.5 d) — it destroys the emulator at the first real fault, making
      everything after it miserable to debug.
- [ ] `salt`/`saltu` LX7 opcode table drop (~1 d + 1–2 d one-off tlib build bring-up).
- [ ] **Do NOT start LEDC modelling.** Instrumented firmware already satisfies Gate B.

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
