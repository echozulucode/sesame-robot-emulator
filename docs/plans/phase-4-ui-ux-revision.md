# Sesame Lab — UI/UX Revision Plan (Phase 4)
## Typography floor · container queries · one laptop workbench · representation-switching

**Status:** approved. §3 resolved 2026-08-27 by the user's 50%-area rule.
**Opened:** 2026-08-27
**Source:** `docs/research/Sesame Lab_ responsive UI_UX research brief.md` (1,232 lines, external specialist)
**Supersedes:** `docs/plans/phase-3-ui-ux-improvement.md` §§2–4 for laptop widths

---

## 1. What the brief concluded

It answered all five priority questions and confirmed the measurement that prompted it.

| Q | Answer |
|---|---|
| **A4** typography | **Confirmed and severe.** 13px base is already below the 16px reference for older children; 9–12px secondary text is "dramatically below". Fix it *before* interpreting further usability feedback |
| **B6** container queries | **Adopt** — but keep media queries for shell geometry. A pane can be 480px in a 1440px viewport or 900px in a focus workspace; a viewport query cannot describe both |
| **B8** 1440×900 | **One dominant stage + one workbench, not two docks.** 64px rail, 540px overlay, ~836px unobscured stage |
| **C9** architecture graph | **Three artifacts, not one shrunk.** Causal path < 720px, subsystem 720–959px, full graph ≥ 960px, plus an explicit focus workspace |
| **D12** rules | 28 invariants, "product invariants, not suggestions" |

Its closing rule is the one to hold onto:

> **Do not simplify the engineering truth. Simplify how much of that truth competes for attention at one time.**

And its diagnosis of what we built: *"professional IDE shrunk down, primarily because of micro-typography, excessive simultaneous chrome, viewport-driven pane logic, and attempts to fit spatial artifacts into widths where they cease to function."* All four are fixable and all four are ours.

## 2. What it validates

Worth stating, so the revision does not throw away what is working:

- **Authentic content is right.** `wave()` stays `wave()`, GPIO 18 stays GPIO 18, QEMU is called QEMU. Greenfoot and MakeCode are cited as precedent that the middle ground between Scratch and a professional IDE is real.
- **The dark palette is "mostly better than the current typography suggests."** Not a repaint job.
- **Correctness surfaces are endorsed and strengthened.** The brief adds invariants we did not have — most importantly that *"observed"* alone is insufficient, because a novice reads it as *observed on hardware*.
- **Do not adopt Tailwind** merely because the stylesheet is long, and **do not** combine any CSS migration with a component-library migration — visual regressions become unattributable.

## 3. Resolved: one workbench, in flow, robot >= 50% of screen area

The brief recommended against two side-by-side docks at 1440x900 - what was asked for and what U6
shipped - on the arithmetic that a 64px rail + two 360px docks + a 900px stage needs ~1684px.

The user resolved it with a different and better constraint:

> *"I'd rather the robot area shrink. 50% of the screen area is more than enough."*

That rule independently produces the brief's recommendation. At 1440x900 with a 64px rail and a
32px status strip, stage height 868:

| Configuration | Stage | Area | % of screen | |
|---|---|---:|---:|---|
| **One workbench 540px** | 836x868 | 725,648 | **56.0%** | passes |
| One workbench 500px | 876x868 | 760,368 | 58.7% | passes |
| Two docks 320+320 | 736x868 | 638,848 | 49.3% | fails |
| Two docks 360+360 | 656x868 | 569,408 | 43.9% | fails |

**Two docks cannot satisfy the 50% rule at 1440x900 at any usable dock width.** One 540px workbench
clears it with room to spare. So the decision is made by arithmetic rather than by preference.

### Three consequences, all simplifying

1. **Docks go back into flow. The overlay is retired below Wide.** The overlay existed solely to stop
   the stage losing width; the user has now said losing width is fine. In-flow means no scrim, no
   floating panel, and no z-order to reason about.
2. **The safe-area occlusion model is no longer needed.** The brief proposed passing an occlusion
   rectangle to the camera because the stage stayed full-bleed behind the workbench. With the stage
   actually resizing, the canvas reframes on a real resize - which we already handle, and which
   ISSUE-20260823-023 already asserts across dock resizes.
3. **The viewport-share metric survives** rather than being retired (§7 rewritten).

### Two docks above 1700px

Retained. At >= 1700px, two 360px docks plus a 64px rail leave >= 1276px of stage, which clears 50%
comfortably. U6's two-dock work is not wasted - it becomes the wide-desktop regime.

## 4. Workstreams

### W1 · Typography and tokens — do this first, alone
**No layout changes in this workstream.** The brief is explicit that the type scale should be fixed *before* interpreting further usability feedback, and mixing it with layout makes regressions unattributable.

Adopt the specified 1440×900 scale as tokens:

| Role | Size | Line height |
|---|---:|---:|
| Badge, line number, compact metadata | **14px** (absolute floor) | 1.30–1.40 |
| Code, telemetry values, table cells | **15px** | 1.45–1.55 |
| Default UI/body | **16px** | 1.45–1.55 |
| Lesson prose | **17px** | 1.55–1.65 |
| Section heading | **18px** | 1.3 |
| Pane title | **20px** | 1.25 |
| Workspace title | **24px** | 1.2 |

Fluid via `clamp()`, but **never below the 14px floor** — the brief warns against fluidly shrinking into unreadability. Today: 128 of 144 declarations are ≤12px, 18 at 10px, 13 at 9px. Every one must move to a token.

**No compact mode as a default.** Responsive behaviour changes arrangement, column count, representation and disclosure — not type size.

Also: the boring spacing scale, and `@layer reset, tokens, base, shell, components, panes, utilities, overrides`.

### W2 · Container queries + pane structural contract
Give every pane `container: pane / inline-size` and the standard markup contract (`<section data-pane>`, `.pane__header` with an `h2`, `.pane__content` with `min-inline-size: 0`).

Split responsibilities exactly as the brief specifies — **media queries for shell geometry** (rail vs bottom nav, overlay vs in-flow), **container queries for pane internals** (Signal's column count, Inspector table vs stacked, Learn side-by-side vs stacked).

Migrate incrementally: tokens and scroll ownership first, then per-pane containers, then move pane logic out of viewport queries, then delete dead overrides. Estimated a quarter to two-fifths of selectors touched.

### W3 · One laptop workbench (approved, §3)
64px rail with icon + readable 14px label · 30–32px status strip · 540px workbench inset 12–16px · exactly one scroller · `Control | Analyze` mode switch · tabs or a compact section navigator **before** nested accordions.

**The stage is resized, not overlaid.** Per §3 the workbench sits in flow and the canvas genuinely
shrinks to ~836x868 at 1440x900. The brief's safe-area occlusion model is therefore not needed: the
camera reframes on a real resize, which is the path ISSUE-20260823-023 already guards.

Retire the `overlay-not-push` assertion below Wide and replace it with the stage-area rule in §7.
Do not leave it passing against a layout that no longer overlays.

**Persistent environment line:** `SYSTEM: QEMU EMULATOR · PHYSICAL HARDWARE: NONE`. The brief is blunt that *"observed"* reads to a novice as *observed on hardware*, so this must be visible, not in a legend.

### W4 · Architecture graph: three representations
The real fix for the complaint that started this.

| Pane width | Representation | Scope |
|---:|---|---|
| < 720px | **Causal path** navigator | current path + nearby branches |
| 720–959px | **Subsystem graph** | ~10–18 nodes, one neighbourhood |
| ≥ 960px | **Full graph** | all 63 nodes |
| explicit action | **Focus workspace** | full graph, robot as smaller live reference |

**React chooses the representation; CSS does not hide it.** Mounting the full React Flow graph and hiding it at narrow widths wastes work and duplicates semantics — a `ResizeObserver` hook picks `'path' | 'subsystem' | 'full'`.

The narrow view is a *tracing* task rather than an *overview* task — which the brief points out is what the product says it teaches anyway.

This is also where "the robot must dominate" gets qualified: the brief reads it as **product identity and persistent causal feedback**, not literal pixel dominance at every instant. Enforcing literal dominance while reading 429 lines of C++ would make the tool unusable. The focus workspace is the sanctioned exception.

### W5 · The other hard panes
- **Source** — preserve real code, do not reflow C++ as prose
- **Signal** — a *sequence*, not unrelated cards
- **Inspector** — change grouping before dropping columns
- **Face** — integer-pixel zoom policy
- **Lab** — editor-specific responsiveness

### W6 · The 28 invariants
Encode the brief's contract in the harness. Beyond what we assert today:

- no visible meaningful text below **14px**; at 1440×900 body ≥16, code ≥15, prose ≥17
- **no arbitrary `font-size` literals** outside tokens
- ≤1 vertical scroll owner per pane; no nested vertical scrollers
- horizontal overflow only on explicit `[data-2d-surface]`
- **origin rendered, never merely "observed"**; no event may render origin `PHYSICAL`
- every `pwm.output` carries `data-provenance="inferred"`
- **correctness text may never be ellipsised or clamped**
- targets ≥36×36 fine / ≥44×44 coarse; contrast 4.5:1 text, 3:1 UI
- lesson prose 45–75ch, target ~64ch
- Modules: full graph not mounted below 720px; not default 720–959px
- **200% zoom and WCAG text-spacing overrides as release gates**
- reduced-motion disables camera tweens and accordion slides

## 5. Sequence

```text
W1  typography + tokens          alone, no layout changes
W2  container queries + contract  after W1
W3  one laptop workbench          gated on your §3 decision
W4  architecture representations  after W2 (needs pane containers)
W5  remaining panes               after W2
W6  invariants                    alongside each, not at the end
```

One agent per workstream, sequential — they all own `apps/web`, and concurrent agents there have already been established as a data-loss risk.

## 6. Explicitly not doing

- **No Tailwind, no component library.** The brief says do not adopt one merely because the stylesheet is long, and never alongside the container-query migration.
- **No repaint.** The palette is broadly endorsed; provenance colours stay and gain redundant text.
- **No vocabulary simplification.** `ESP32Servo` stays `ESP32Servo`.
- **No compact mode as a default.**

## 7. The stage metric, kept and sharpened

Earlier drafts of this plan proposed retiring viewport share, because a full-bleed stage behind an
overlay would read ~100% while the robot sat behind a panel. §3 removes that problem: the stage is
genuinely resized, so a measured share means what it says again.

Replace the current assertion with the user's rule, and make it area rather than height:

- **Stage area >= 50% of viewport area** at every breakpoint at and above Medium.
- Keep the existing floors (`min-height: 45vh`, `min-width: min(480px, 100%)`) as a Compact backstop.
- **Retire `overlay-not-push`** below Wide, and say so in the findings - it would otherwise keep
  passing against a layout that no longer overlays, which is exactly the hollow-assertion failure
  mode this project has hit twice.
- Keep ISSUE-20260823-023 world-frame stability asserted across every breakpoint and every dock
  resize. That check becomes *more* load-bearing now that the canvas resizes for real.

## 8. Definition of done

- [x] No visible text below 14px anywhere; all sizes from tokens — W1
- [x] Container queries drive pane internals; media queries drive shell geometry — W2
- [x] 1440×900 matches the brief's specified geometry — W3: 64px rail, 32px strip, one
      530px workbench in flow, 820×775 of canvas = 55.7% of the screen area
- [ ] Architecture graph switches representation by container width, React-mounted — W4
- [ ] All 28 invariants asserted, including 200% zoom and text-spacing gates — W6
- [x] **Viewport-share assertion replaced by the stage-AREA rule, and `overlay-not-push`
      DELETED rather than relaxed** — W3, and see §7. The earlier wording here said
      "replaced by safe-area occlusion"; §3 retired the occlusion model along with the
      overlay, and the line survived the rewrite. It is corrected rather than ticked as
      written.
- [x] Tests still pass (959, up from 948); zero new dependencies

---

## 11. W7 — module-first shell (added 2026-08-27, user direction)

> *"On ultra large screens, the modules sections are still unusable. The architecture diagram needs
> to use up at least 50% of the screen to be useful, with the robot in the other half. I think the
> commands and face tools can be made to be minimal on small screens and never need their own
> individual scrollbars. Make use of 'more info' popovers or screens to dive into more details over
> the key information and face that you'd want to look at while executing commands. Make that the
> right most side-panel while the larger content items can be maximize. The Architecture, Signals,
> Source and Learn modules should only have one active at a time."*

### 11.1 The layout

```text
┌────┬──────────────────────┬──────────────────────┬──────────────┐
│    │                      │                      │  Commands    │
│RAIL│       ROBOT          │   ACTIVE MODULE      │  Face        │
│ 64 │                      │  (one of Arch /      │  glance info │
│    │                      │   Signal / Source /  │              │
│    │                      │   Learn / Lab)       │  ~280–320px  │
│    │                      │                      │  no scroller │
├────┴──────────────────────┴──────────────────────┴──────────────┤
│ SYSTEM: QEMU EMULATOR · PHYSICAL HARDWARE: NONE                  │
└──────────────────────────────────────────────────────────────────┘
```

### 11.2 A rule conflict that must be resolved, not averaged

The ≥50%-of-**screen** stage rule (§3, §7) and "architecture ≥50% of the screen with the robot in
the other half" cannot both be literal: with a 64px rail, a 32px status strip and a ~300px side
panel, a 50/50 content split yields:

| Window | Content | Stage | Module |
|---|---:|---:|---:|
| 1440×900 | 1076 | 36.0% | 36.0% |
| 1920×1080 | 1556 | 39.3% | 39.3% |
| 2560×1440 | 2196 | 41.9% | 41.9% |
| 3440×1440 | 3076 | 43.7% | 43.7% |

**Resolution — two regimes, both asserted:**

- **No module active:** stage ≥ **50% of viewport area** (§7 unchanged).
- **A module active:** stage ≥ **50% of the *content* area** — content being the viewport minus
  rail, status strip and side panel. That is the plain reading of *"with the robot in the other
  half"*, and it is achievable at every width above the module's own minimum.

Do not average them into one loose number. Publish which regime is in force the way W4 published
`data-stage-rule`, and assert both.

### 11.3 One active module

`Architecture · Signal · Source · Learn · Lab` are **mutually exclusive**. Selecting one deselects
the others; no accordion, no two-open state. **Lab is included** — it is a large editing surface,
not a glance surface; flag it if that proves wrong on screen.

This generalises W3's derived `Control | Analyze` rather than replacing it: the active module *is*
the state, and the mode label is derived from it.

### 11.4 The side panel

Commands + Face + the glance information you want while driving the robot.

- **Never its own scrollbar** — neither Commands nor Face. If content does not fit, that is a
  content problem to solve by disclosure, not by adding a scroller.
- **"More info" popovers/screens** carry the detail: full inspector table, full origin/provenance
  detail, OLED at larger zoom. The *key* information stays on the panel.
- **Minimal on small screens** — collapses to the rail's icon strip below the workbench regime.
- **Correctness surfaces may not be demoted into a popover.** Provenance, origin,
  `PHYSICAL HARDWARE: NONE`, `NOT BUILT` and `CONCEPTUAL` badges stay visible on the panel itself.
  A popover may *expand* them; it may not be where they first appear.

### 11.5 Also fix — found by W4, not W4's to fix

At **1760×1000 the two-dock Wide regime holds only 45.0%** of area at *default* dock widths. W3 set
the 1700 boundary from 360+360, but the defaults are 400+460, and phase 12 only measured 2560. W7
removes the two-dock regime in favour of this model, which resolves it — assert the new rule at
1760×1000 explicitly so the gap cannot reopen.

### 11.6 Definition of done
- [x] One module active at a time; no two-open state reachable — W7. `activeModule` is one
      nullable id, so the two-open state is *unrepresentable*; asserted as a count of laid-out
      module panes for every module at every window, plus zero accordion toggles document-wide
- [x] Stage ≥50% of viewport with no module; ≥50% of content with one — both asserted, regime
      published as `data-stage-rule="area-50" | "content-50" | "focus-exempt"`. Measured: 50.0%
      of content at 1440/1760/1920/2560, 52.7% at 1280 where the stage's own 480px floor binds;
      69.3–84.4% of the viewport with no module
- [ ] ~~Architecture at ≥1900px gets ≥1000px of surface~~ — **this line is wrong and cannot be
      done.** It contradicts §11.2's own resolution: with the module capped at half the content
      area, 1000px of surface needs `2 × (1000 + 25) + 64 + 280 = 2394px` of *viewport*, so it
      arrives at 2560×1440 (1070px, the full graph) and not at 1920×1080 (750px, the subsystem
      graph). Reported with the arithmetic rather than averaged away — see
      `docs/findings/W7-module-first-shell.md` §2. **Label size measured and reported:** 14.40px
      on screen at 1920 (subsystem, zoom pinned to 1), 4.38px at 2560 (the full graph, fitted),
      14.0px on the causal path at 1440/1760. The 4.38px is the finding: width was never the
      variable — `fitView` fits the SHORT side, and the ordinary layout's canvas is `52vh`
- [x] Side panel has **zero** scrollers at every width; correctness surfaces present on it, not
      only in popovers — W7. Zero scrollers *and* zero overflow, both asserted, because
      `overflow: hidden` turns "it scrolls" into "it is cut". Seven named correctness surfaces
      read with every "more info" screen shut, each carrying `insidePopover`
- [x] 1760×1000 asserted — in `RESPONSIVE_WINDOWS` by name, both regimes measured there. W4's
      NOTE about the 45.0% two-dock gap is **deleted**, because the regime it described is gone
- [x] 985 tests, ISSUE-023 at every breakpoint and across module switches, zero new dependencies
      — 985 passing, 36 captures, 0 problems, world frame at 0.000000mm across a module
      clear/activate and a module switch at every breakpoint

### 11.7 Corrections to §11, found on screen (W7)

- **§11.6's ≥1000px line** — above.
- **§11.4's "280–320px"** is a margin decision, not a threshold one: at the 25px of module
  chrome this shell ended with, anything in that band clears W4's 720px subsystem boundary at
  1920. What actually decided the band was the module column's own chrome — 71px of nested
  card-in-a-card cost a 1920 monitor its subsystem graph whatever the panel was set to — and no
  part of §11 mentions it.
- **§11.4's "collapses to the rail's icon strip"** describes a strip W7 deletes. At Compact the
  panel is a full sheet opened from a `Panel` button on the 64px rail, which already carries the
  five module buttons; a second strip beside it would be two navigations.
- **§11.1's diagram omits the trust card.** It lists "Commands, Face, glance info", and §11.4
  then forbids demoting provenance into a popover — which is a fourth card. It is drawn first
  and it cannot fold.
- **§11.3's "flag it if Lab proves wrong on screen"** — it does not. At 535px of column at
  1440×900 the pose table has room it never had in a 400px dock, and the C++ export still
  round-trips byte-for-byte at Compact.
