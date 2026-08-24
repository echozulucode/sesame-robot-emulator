---
type: status
updated: 2026-08-23
current_phase: "Phase 1 (Virtual MVP) complete - Phase 2 (Learning application) not started"
blockers: []
next_actions:
  - "USER EVALUATION of the Virtual MVP (see the walkthrough in this entry)"
  - "Decision: adopt QEMU as a QemuSesameRobot backend (~4-7 d, Q1 recommendation)"
  - "Opportunistic: 13 checklist steps (4h25m) need only a bare ESP32-S2 + one servo + an OLED, no robot"
  - "Then Phase 2: architecture graph, See the Signal traces, source explorer, first lessons"
---

# Status Log

## Session: 2026-08-23 (later) - Phase 1 executed end to end

**Phase:** 1 - Virtual MVP -> **COMPLETE**. Plan: `docs/plans/phase-1-virtual-mvp.md`.

**Constraint:** no physical Sesame robot, and none expected. The planned hardware-verification
sprint was cancelled and replaced by **V0**, a CAD-derived reconstruction.

**Actions taken:** 8 tasks across 4 waves (V0, V1, Q1, V2, V5, V3, V4, V6), 7 commits.
`pnpm -r build`/`typecheck` clean, **674 tests passing**, **10 validators passing**.

**Outcome:**

- **V0 replaced the hardware sprint successfully.** The STL->CAD frame map resolved by an
  **8876x margin** (0.0035 mm vs 31.23 mm over 96 candidates). Closed 7 unresolved items plus
  F6 item 7, which F6 had said required a physical robot. Corrected F5: the STEP is in inches,
  not mm.
- **Q1 superseded the Renode track.** Real Sesame firmware executes under Espressif QEMU,
  reaching bootOrder 7/20 and entering `setup()` - against Renode's 0/20. With Wi-Fi elided it
  runs all 20 steps and emits real `@SESAME` telemetry. **Recommended for adoption, ~4-7 d.**
- **The Phase 0 architecture paid off literally.** Real firmware under QEMU -> UART0 -> the
  *unmodified* bridge -> the R3F scene: 8 joints from 21 `observed` events, zero bridge changes.
- **Cross-layer consistency verified numerically.** V1's simulator independently reproduces
  Phase 0's replay fixture byte-for-byte. In-browser stand pose: max joint error 0.000 deg,
  ground plane -68.650045 mm vs V2's -68.650046 mm.
- **V6 made 81 hardware-gated values runtime-swappable** behind a four-mechanism guess barrier,
  and produced a 28-step, 10h15m verification checklist.

**A correction to a claim repeated several times earlier:** `Adafruit_SSD1306::begin()` returns
false **only on malloc failure** - it never checks an I2C ACK. Boot steps 4 and 5 pass with no
display modelled at all. The "OLED is a hard boot blocker" inference was drawn from the firmware's
error path, not the library's behaviour. An SSD1306 model buys visibility, not boot.

**New upstream defect found:** ISSUE-20260823-021 - `/api/status` concatenates command and face
names into JSON unescaped, while `jsonEscape()` is correctly applied to SSIDs 98 lines later.

**Blockers:** none. The two hardware issues (007, 008) are now **deferred, not blocking** - V6's
calibration layer means closing them later is data entry, not rework.

**Next concrete action:** user evaluation, then the QEMU-adoption decision, then Phase 2.

---

## Session: 2026-08-23 — Phase 0 executed end to end

**Phase:** 0 — Foundations & Renode Research → **COMPLETE**

**Actions taken:**

- Read the research report and probed the machine before planning: found `arduino-cli` absent,
  Renode **1.15.3** installed (older than the 1.16.1 the report assumes), and exactly one Xtensa
  file with zero ESP32 files — empirically confirming the report's central blocker before
  writing a line of the plan.
- Wrote `docs/plans/phase-0-foundations-and-renode-research.md`: 13 tasks across workstream F
  (Foundations) and R (Renode research), 5 dependency waves, 8 agent roles.
- Executed with a team of subagents across 5 waves. Deviated from the written plan on one point:
  **agents never run `git commit`** — concurrent agents racing the git index corrupts it, so the
  orchestrator commits per wave.
- 11 commits. `pnpm -r build` / `typecheck` clean, `pnpm -r test` **368 passed / 1 skipped**,
  all 7 validators PASS.

**Outcome — the two gates:**

- **Gate A — NO above the CPU line, YES below it.** Renode's Xtensa core runs real ESP32-S2
  compiler output correctly (windowed ABI, register-window overflow/underflow, `memw`, 41/43
  SRs, 49/54 opcodes). Above it, nothing: the Sesame ELF and a three-line Arduino sketch both
  abort on **instruction #0**. 0 of 20 boot steps reached. Backlog ≈16–25 d to user code.
- **Gate B — YES via instrumented firmware.** Two hook sites, +10 KB flash, bit-for-bit
  reproducible, transport observed end to end through real Renode.

**What this changed about the plan:** nothing structural — and that is the useful result. The
report's behavioural-simulator-first ordering is now evidence-backed rather than inferred.
Building on emulation would have left Phase 1 roughly 25 days from its first moving joint.
The report's "weeks to months" for SoC work collapses to ≈16–25 d, and two feared risk
categories were deleted outright (register windows work; S2 has no cache ops or conditional
store at all, so "Renode cache control" was never a question).

**Evidence highlights:**

- The joint sign convention is corroborated by two independent derivations: F5's identical-solid
  classes from STL geometry and F6's analysis of 223 real choreography steps land on the same
  partition, collapsing 6 of 21 movement functions to round numbers.
- Experiment 8 closed with real headless-Edge screenshots one telemetry event apart, plus all
  eight angles read back from the rendered canvas by bar pixel width.

**Defects found in our own work, all fixed:** silent `git apply` no-op (caught only by a
cross-artifact pin assertion), USB-CDC telemetry misrouting (caught by an auditor reading a
build manifest), `core.autocrlf` byte drift hidden by git's stat cache.

**Defects found in upstream Sesame, deliberately NOT patched:** `epd_bitmap_stand` /
`epd_bitmap_defualt` declared weak and never defined — absent from the ELF symbol table with
zero diagnostics, so the startup `default` face is a null pointer. Plus four doc-drift items.

**Blockers:** none technical. The single gating dependency for Phase 1 quality is access to a
physical Sesame robot.

**Next concrete action:** P1-0 hardware verification sprint. Ten open questions — including
whether the top-down render is from above or below (which flips left/right) and whether R/L
are the robot's or the viewer's — all reduce to putting the robot on a desk and looking at it.

---
