# Sesame Lab — UI/UX Revision Plan (Phase 4)
## Typography floor · container queries · one laptop workbench · representation-switching

**Status:** proposed, awaiting approval — **one decision needs your call before W3 starts (§3)**
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

## 3. The one decision that needs you

**The brief recommends against two side-by-side docks at 1440×900 — which is what you asked for and what U6 just shipped.**

Its arithmetic: a 64px rail + two 360px docks + a 900px stage needs **~1684px** before gaps. So *"a 1440px breakpoint for full desktop furniture is badly placed for your primary machine."* It recommends keeping **Control** and **Analyze** as top-level concepts but making them **two modes of one workbench** at laptop size.

I think it is right, and the synthesis that honours both:

| Viewport | Workbench |
|---|---|
| < 1700px (**includes your 1440×900**) | **One** workbench overlay, 540px, with a `Control | Analyze` mode switch at its top |
| ≥ 1700px | **Two** docks side by side, as U6 built them |

Your two-dock layout survives where the arithmetic supports it, and your laptop gets the composition the brief specifies. **This is the only item I will not proceed on without your say-so**, because it partially reverses an explicit request.

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

### W3 · One laptop workbench (**gated on §3**)
64px rail with icon + readable 14px label · 30–32px status strip · 540px workbench inset 12–16px · exactly one scroller · `Control | Analyze` mode switch · tabs or a compact section navigator **before** nested accordions.

**The stage stops being resized.** It stays the full canvas; instead we pass a safe-area to the camera framing logic so Sesame stays framed in the unoccluded region when the workbench opens:

```ts
const safeArea = { left: railWidth, right: workbenchOpen ? workbenchWidth + gap : 0, top: 0, bottom: statusHeight };
```

That keeps the robot feeling like the environment rather than a video tile squeezed by chrome — and it means our viewport-share metric needs rethinking (§7).

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

## 7. A metric we have to retire honestly

We have been asserting **viewport share ≥45%**, and reporting 95.8% at 1440×900 as a win.

Under W3 the stage becomes the full canvas with the workbench overlaying it, so that number stops meaning what it meant — it would trivially read ~100% while the robot sits behind a panel. The brief's replacement is better: **the robot's projected bounding box must remain inside the declared safe area after the workbench opens** (~820×620px unobscured at 1440×900).

Replace the assertion; do not keep both. And say so in the findings rather than letting a number quietly change meaning — that is the class of mistake the "it scrolled there" assertion already taught us.

## 8. Definition of done

- [ ] No visible text below 14px anywhere; all sizes from tokens
- [ ] Container queries drive pane internals; media queries drive shell geometry
- [ ] 1440×900 matches the brief's specified geometry
- [ ] Architecture graph switches representation by container width, React-mounted
- [ ] All 28 invariants asserted, including 200% zoom and text-spacing gates
- [ ] Viewport-share assertion replaced by safe-area occlusion, documented
- [ ] 948 tests still pass; zero new dependencies
