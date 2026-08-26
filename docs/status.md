---
type: status
updated: 2026-08-26
current_phase: "Phase 2 complete; responsive shell landed. Awaiting external Renode research."
blockers: []
next_actions:
  - "Evaluate: `pnpm dev` (lab host + vite, one command) or `pnpm dev:sim` for a faster boot"
  - "External research pending on the Renode decision (docs/research/renode-fit-deep-research-prompt.md)"
  - "Optional: the carried-forward items in plan.md Phase 3+"
---

# Status Log

## Session: 2026-08-26 (later) - dev script + responsive shell

**Two user-reported problems, both real, both fixed.**

**1. "The QEMU firmware shows an error on the web page."** Diagnosed by reproduction, not guesswork:
`vite dev` proxies `/api`, `/lab`, `/cmd`, `/getSettings` and `/setSettings` to a lab host on
127.0.0.1:8099, so Vite alone serves the app but leaves the QEMU backend reporting
*no lab host (HTTP 500)*. **The instructions I had given were wrong** - dev mode needs both
processes, not either one. Fixed with `pnpm dev` / `pnpm dev:sim` (`scripts/dev-lab.mjs`,
dependency-free). Two Windows bugs surfaced and were fixed while testing it: Node 24 refuses to
spawn a `.cmd` (EINVAL, CVE-2024-27980 hardening) and `shell: true` reintroduces DEP0190; and a
stale host on 8099 gave a raw EADDRINUSE stack trace instead of a sentence.

**2. "You can barely see the robot."** Measured: `styles.css` was **2,407 lines with zero `@media`
queries** and a hard-coded `1fr | 520px | 400px` grid. The 3D viewport got **494x191 at 1440x900**
- 24% of the screen - and **334x91 at 1280x800**, under both floors, which the harness called green
because none of its 26 captures asserted viewport share.

Rebuilt as a three-zone responsive shell (56px rail / flexible stage with a 45vh-480px floor /
six-section accordion dock). **Viewport share is now 80-87% at every size.** The rule that fixed it:
below Wide the dock **overlays rather than pushes**, asserted by measuring the stage shut then open
(0.0 px moved).

**Judgement worth keeping:** auto-expand-on-selection fires only for `origin === 'scene'`, because
`LessonRunner` calls `selectSymbol` mid-lesson and obeying the spec literally would have collapsed
a lesson while it played.

**Four plan errors found once on screen**, documented rather than worked around - most usefully
that Source's bounded scroll regions are load-bearing: an auto-height row would let the code grow
to all 429 lines while L4's "it scrolled there" assertion kept passing and meaning nothing.

**No assertion dropped; two strengthened.** Phase 7 gained checks that Modules and Signal are open
together at Wide, so V8's simultaneity requirement is verified rather than assumed. Phase 10's wait
was tightened after this exposed a pre-existing race.

**State:** 934 tests, 11 validators, 32 captures / 0 problems, zero dependencies added.
ISSUE-023 world-frame drift 0.000000 mm at every breakpoint and across a dock resize.

---

## Session: 2026-08-25/26 - Phase 2 complete

**Phase:** 2 - Learning application -> **COMPLETE**. Seven tasks, 6 commits,
**912 tests / 11 validators green**, 26 real-browser captures, 0 problems.

- **L1** architecture graph (63 nodes / 65 edges derived from `hardware-map.json`, 5 hand-authored
  and dashed) + **See the Signal**, whose `pwm.output` row stays `INFERRED` on both backends
  because Q3 proved QEMU emits no waveform.
- **L3** source annotations - 90 symbols, 39 concepts, 17 teaching notes, every citation storing
  its own line text so the validator can re-read and compare.
- **L4** source explorer - four synchronised panes, upstream source bundled at build time with two
  independent hash-refusal gates, both exercised by flipping a single byte.
- **L5** lesson content - 19 lessons, 74 steps, and **Gate F enforced by a validator**: 44/44
  factual claims resolve to a matching symbol, and a lesson cannot promote itself.
- **L6** lesson runner - lessons 1-6 fully playable; checks were **falsified before being
  confirmed**, and an unbuilt check cannot complete a step.
- **L7** Lab mode - Studio's pose/frame/animation model preserved, C++ export verified against the
  real firmware header and round-tripped by two independent parsers.

**The through-line:** every layer refuses to claim more than it can show. `pwm.output` is inferred
even under real firmware; conceptual lessons are badged from `grounding` rather than from empty
symbols; unbuilt controls render a red NOT BUILT panel; the exported C++ carries its
never-verified warning inside the generated code so it survives the clipboard.

**Standing constraint honoured throughout:** no physical hardware, ever. `isPhysicallyObserved()`
is permanently false, and nothing in Learn or Lab claims a servo moved.

**Carried forward** (none blocking, all in plan.md Phase 3+): loop playback, multi-frame faces,
a serial console, six deferred lesson controls, one faults-count inconsistency, and the
undocumented CRLF/trim conventions in `source-annotations.json`.

---

## Session: 2026-08-24 - QEMU adopted as a real emulator backend

**Trigger:** user chose the emulator over the simulator - *"The simulated is cool, but I want an
emulator."* Six tasks, 7 commits, **776 tests / 9 validators green**.

**Delivered:**

- **Q2 `QemuSesameRobot`** - a commandable backend. Protocol v2 adds a host->device direction
  that invents no wire format: it adopts the firmware's own serial console, modelling the
  prefix-sensitive dispatcher line by line. All 15 contract cases pass.
- **V7 browser drives real firmware.** DOM click on `wave` -> `POST /api/command` -> QEMU ->
  8/8 joints move. Transport is the API adapter over `QemuSesameRobot`, chosen because the
  bridge envelope's `origin` means `'uart'|'bridge'`, so the app would have had to assert
  "emulator" on its own authority.
- **Q3 answered the fidelity question.** QEMU's LEDC is modelled and its duty ratios are exactly
  right (29/29 match the TRM formula, timer decodes to 50.000 Hz) but the **waveform is inert** -
  no `timer_mod`, no `qemu_irq`, and `led_get_intensity` has zero call sites. The instrumented
  firmware hook therefore stays load-bearing.
- **ISSUE-023 fixed** (user-reported world-jump): the ground plane was being repositioned every
  frame, so the floor slid under a robot pinned at the origin. Now pinned; regression test
  confirmed red before green.

**Three data corrections from Q3, propagated:**

1. **`attach(pin, 732, 2929)` never produces 2929 us** - `ESP32Servo.h:98` clamps to **2500**.
   Carried since F4 and inherited by every angle-to-pulse calculation. **No test anywhere
   encoded it; the wrong number survived because nothing checked it.** Now checked.
2. **10-bit channels mean 89 of 181 commandable angles alias** onto a neighbour at the pin, on
   real hardware too. A simulator reporting 181 distinct positions claims precision the hardware
   lacks. `servo-pulse.ts` now derives 92/89 rather than asserting them.
3. Q1's claim that QEMU's trace backend is inert was wrong; corrected in place with a dated note.

**Honesty machinery, since the emulator can now be mistaken for hardware:** `TelemetryOrigin` is
orthogonal to provenance (epistemic weight vs which boundary); `isPhysicallyObserved()` is the
predicate to branch on and is **false for everything QEMU produces**. An audit found the app
branched on origin *nowhere*, so every emulated angle rendered as a bare green `observed`. The
UI now names the board as *the legacy V1 board, not the S2 Mini in the pin diagram*.

**Known and visible, not hidden:** QEMU panics on ~28% of boots (root-caused to its ESP32
cache/DPORT model, unfixable from our side); `connect()` relaunches and the UI shows attempts
while they happen. The recommended S2 Mini has **no QEMU machine at all**.

---

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
