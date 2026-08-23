---
type: status
updated: 2026-08-23
current_phase: "Phase 0 complete — Phase 1 (Virtual MVP) not started"
blockers:
  - "No physical Sesame robot has been used yet. 10 joint-map facts and the whole Gate B silicon list depend on it (ISSUE-20260823-007, -008)."
next_actions:
  - "P1-0: physical hardware verification sprint (1-2 d) — highest evidence-per-day item available"
  - "Optionally file the upstream defect report (ISSUE-20260823-004, -005)"
  - "Then P1-1 behaviour model against the 395 machine-readable choreography steps"
---

# Status Log

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
