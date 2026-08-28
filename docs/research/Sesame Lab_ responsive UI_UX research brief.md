# Sesame Lab: responsive UI/UX research brief

Sesame Lab has the right **product philosophy** and the wrong **density calibration**.

The central idea—real code, real pin numbers, real causal traces, real failure states, no infantilizing rewards—is well matched to an intellectually curious 12-year-old. Research on older children supports using familiar interface conventions, and it specifically warns that children near the upper end of the 9–12 range can reject interfaces that look designed for younger kids. Research with teenagers likewise finds that professional presentation is not inherently a problem; clutter, small text, and gratuitous interface complexity are. citeturn14view0turn14view1

The bad call is not “engineering lab instead of Scratch.” The bad call is **using professional-IDE information density as a proxy for seriousness**. A UI can expose C++, GPIO, LEDC, emulator state, and provenance while using 15–17px text, generous grouping, fewer simultaneous surfaces, and representations that change when there is not enough two-dimensional space.

The highest-priority changes are:

**Raise the floor for all meaningful text to 14px, make ordinary UI text 16px at 1440×900, and make lesson prose 17px.** The current 9–12px typography is a primary cause of the reported readability problem, not a cosmetic issue.

**Adopt container queries.** Your resizable panes are almost the canonical case for them. Keep viewport media queries for shell-level mode changes, but make every pane respond to its own width.

**At 1440×900, stop treating two independent docks as desktop furniture.** Use one approximately 520–560px right-side workbench overlay at a time, with the 3D stage behind it and the camera framed into the remaining unobscured area.

**Do not squeeze the 63-node architecture graph into a 460px pane.** Below about 720px of *pane width*, replace the full map with a scoped causal navigator; from about 720–959px show a subsystem graph; reserve the complete graph for roughly 960px or more, or an explicit focus workspace.

**Turn the design rules into tests.** In particular: no meaningful text under 14px; no nested vertical scrolling; no correctness surface without visible provenance and origin; no `pwm.output` shown as anything but inferred; no body-level horizontal overflow; and no full architecture graph mounted in a sub-720px container.

## Decisions that unblock implementation

### The typography problem is real and severe

**A4 — Yes: the 88% of declarations at 12px or below is one of the main causes of “I cannot read the content.”** It is not the only cause—clutter, competing panes, line length, scroll ownership, and graph scale all matter—but it is sufficiently extreme that you should fix it before interpreting further usability feedback.

Nielsen Norman Group’s older-child guidance gives 12-point text for older children. In CSS’s reference-unit relationship, 1in is 96px and 1pt is 1/72in, making 12 CSS points equivalent to 16 CSS pixels. That is not a magic universal conversion from a research recommendation into a web requirement, but it is a useful sanity check: your **13px base is already below that reference point, and 9–12px secondary text is dramatically below it**. NN/g’s teen research also reports negative reactions to tiny text and dense, cluttered pages. citeturn14view0turn14view1turn14view15

A pediatric online-reading study goes farther, finding display- and font-size effects on viewing distance and pixels per degree and recommending comparatively large type for young children. Its participants and ophthalmic outcome are not an exact match for a 12-year-old using an engineering tool, so I would **not** turn its 16-point-PC recommendation into a 21px UI font. But it is additional directional evidence against solving density with tiny text. citeturn14view16

My recommended **1440×900 typography** is:

| Role | Size at 1440×900 | Line height | Notes |
|---|---:|---:|---|
| Provenance badge, line number, compact metadata | **14px** | 1.30–1.40 | Absolute floor for meaningful text |
| Code, telemetry values, compact table cells | **15px** | 1.45–1.55 | Monospace code should not be made artificially narrow |
| Default UI/body | **16px** | 1.45–1.55 | Buttons, labels, inspector text |
| Lesson/explanation prose | **17px** | 1.55–1.65 | Reading surface, not “UI chrome” |
| Section heading | **18px** | 1.3 | E.g. “See the Signal” |
| Pane title | **20px** | 1.25 | Strong hierarchy |
| Major workspace title | **24px** | 1.2 | Use sparingly |
| Display/lesson milestone | **28–32px** | 1.15–1.2 | Rare; never needed merely to fill 4K space |

**Design judgement:** do not introduce a “compact mode” as the default way to recover screen real estate. For Sesame Lab, responsive behavior should first **change arrangement, column count, representation, and disclosure**, not shrink type. Compact density can exist later as an explicit advanced-user preference.

### Container queries should become the pane-level responsive mechanism

**B6 — Yes, adopt container queries.** W3C distinguishes media queries, which query the user-agent/device environment, from container queries, which query an element’s containing context. MDN’s examples explicitly show components varying based on the width of their containing element rather than the viewport. That maps directly onto Sesame Lab: a Signal pane can be 480px wide in a 1440px viewport or 900px wide in a focus workspace in the same viewport. A viewport breakpoint cannot describe those two states correctly. citeturn14view4turn14view5

Do **not** replace all media queries. Give the two mechanisms separate jobs:

| Question | Use |
|---|---|
| Is the whole application phone/tablet/laptop/wide-desktop shaped? | Viewport media query |
| Should the rail become bottom navigation? | Viewport media query |
| Should docks overlay or enter document flow? | Viewport/shell geometry |
| Does Signal have enough width for a 5-column row? | **Container query** |
| Should Inspector be table or stacked joint records? | **Container query** |
| Should Learn put explanation beside the control? | **Container query** |
| Should Modules show path, scoped graph, or full graph? | **Container width**, with React mounting logic |
| Is reduced motion requested? | User-preference media query |

Start with this:

```css
.pane {
  container-name: pane;
  container-type: inline-size;
}

@container pane (width < 32.5rem) {
  /* below 520px: narrow representation */
}

@container pane (32.5rem <= width < 45rem) {
  /* 520–719px: intermediate representation */
}

@container pane (width >= 45rem) {
  /* 720px+: wide representation */
}
```

Named containment contexts and `container-type: inline-size` are standard container-query primitives, and container-relative units such as `cqi` are available when genuinely useful. citeturn14view5

The migration cost is **medium, not catastrophic**. My estimate, based on the architecture you described rather than an audit of the actual stylesheet, is that roughly a quarter to two-fifths of the selectors may need to be touched or relocated during a clean first pass, but very little needs to be mechanically rewritten merely because it uses CSS. The expensive part is deciding each pane’s responsive semantics, which you need to do regardless of technology.

Do it incrementally:

```css
@layer reset, tokens, base, shell, components, panes, utilities, overrides;
```

First establish tokens and scroll ownership. Then give each pane a container. Then move pane-specific breakpoint logic from viewport queries into that pane’s file or layer. Finally delete obsolete media-query overrides. **Do not combine the container-query migration with Tailwind or a component-library migration.** That would make visual regressions much harder to attribute.

### The primary 1440×900 layout should be designed explicitly

**B8 — At 1440×900 I would ship one dominant stage plus one right-side workbench, not two independent docks.**

Recommended geometry:

| Element | Recommended 1440×900 configuration |
|---|---|
| Navigation rail | **64px**, with icon + readable 14px short label |
| Status/environment strip | **30–32px** high |
| 3D canvas | Full remaining shell, behind workbench |
| Normal workbench | Right overlay, **540px target**, min 500px, max 560px |
| Workbench inset | 12–16px from top/right, 12–16px above status strip |
| Workbench vertical scrolling | Exactly **one** scroller |
| Simultaneous workbenches | **One** |
| Robot safe/unoccluded region | Roughly **820px+ wide × 620px+ high** |
| Architecture full-map mode | Not in the ordinary 540px workbench |
| Learn text measure | About **60–68ch** |
| Normal controls | 36–40px high; larger on coarse-pointer devices |
| Pane interior padding | 16px |
| Row gap | 8–12px |
| Section gap | 24px |

With a 64px rail and a 540px overlay, the unobscured horizontal stage budget is about 836px before small insets. That is a much healthier laptop composition than asking a 1440px-wide shell to behave like an ultrawide workstation with stage + two persistent desktop docks.

The stage should remain the **actual full canvas**, rather than being resized whenever the workbench opens. Instead, expose an occlusion/safe-area value to the camera framing logic:

```css
.app-shell {
  --rail-w: 4rem;
  --workbench-w: 33.75rem; /* 540px */
  --workbench-gap: 1rem;
}

.stage {
  position: absolute;
  inset: 0 0 2rem var(--rail-w);
}

.workbench {
  width: min(var(--workbench-w), calc(100vw - var(--rail-w) - 2rem));
}
```

Conceptually, pass:

```ts
const safeArea = {
  left: railWidth,
  right: workbenchOpen ? workbenchWidth + workbenchGap : 0,
  top: 0,
  bottom: statusHeight,
};
```

to your robot-fit/camera logic. When the workbench opens, the camera target shifts so Sesame remains framed in the unoccluded region. This preserves the feeling that the robot is the environment rather than a video tile being squeezed by chrome.

The current distinction between “Control Dock” and “Analysis Dock” is still useful **information architecture**. It should become a mode switch inside one physical workbench at laptop sizes:

```text
┌─────────────────────────────────────────────────────────────┐
│ Rail │                         ROBOT                         │
│      │                                        ┌─────────────┤
│      │                                        │ Control     │
│      │                                        │ Analyze     │
│      │                                        ├─────────────┤
│      │                                        │ active pane │
│      │                                        │             │
│      │                                        │ one scroll  │
│      │                                        │             │
│      │                                        │             │
│      │                                        └─────────────┤
│      │ SYSTEM: EMULATOR · HARDWARE: NONE                     │
└─────────────────────────────────────────────────────────────┘
```

That last line matters. Because your word **observed** can easily be interpreted by a novice as “observed on hardware,” an environment statement such as **`SYSTEM: QEMU EMULATOR · PHYSICAL HARDWARE: NONE`** should be persistently visible, not buried in a legend.

I would not allow two side-by-side docks until the viewport is substantially wider. Arithmetic explains why: even two modest 360px docks plus a 64px rail and a 900px stage need roughly 1684px before gaps. **A 1440px breakpoint for “full desktop furniture” is therefore badly placed for your primary machine.**

### The architecture graph needs different artifacts at different widths

**C9 — The complete spatial graph does not earn permanent residence in a 460–540px laptop pane.**

That is not an indictment of the graph. WCAG’s reflow criterion itself recognizes that diagrams, data tables, maps, and other intrinsically two-dimensional interfaces sometimes need two-dimensional layout rather than ordinary text reflow. But accessibility permission to pan does not make a 63-node graph understandable in a narrow column. citeturn14view6

Use **three representations of the same architecture model**:

| Pane width | Default Modules representation | Scope |
|---:|---|---|
| `< 720px` | **Causal Path / scoped navigator** | Current path + nearby branches |
| `720–959px` | **Subsystem graph** | Selected subsystem, roughly one meaningful neighborhood |
| `≥ 960px` | **Full architecture graph** | 63 nodes / 65 edges allowed |
| Any width, explicit action | **Focus workspace** | Full graph with room to navigate |

For `wave`, the narrow view should look more like:

```text
WAVE
Movement
  wave()
    ↓ calls
  setServoAngle(...)
    ↓ library
  ESP32Servo
    ↓ implementation
  LEDC
    ↓ output mapping
  GPIO 18
    ↓ drives
  MG90S front-right shoulder
    ↓ rotates
  shoulder joint

[OBSERVED] [QEMU] wave() entered
[OBSERVED] [QEMU] servo target set to 42°
[INFERRED] [QEMU] pwm.output would correspond to …
```

This is not “dumbing down” the graph. It is **changing from an overview task to a tracing task**, which is exactly what the product says it is trying to teach.

At intermediate widths, show the selected subsystem rather than the entire architecture. A Movement view might show 10–18 relevant nodes and their local edges. The exact node cap is a product rule, not a published usability threshold; the principle is to prevent “Fit View” from shrinking labels until technically everything fits but cognitively nothing is usable.

At full width, React Flow remains appropriate. It already exposes zoom, fit-view and lock controls, provides a MiniMap intended as a bird’s-eye navigation aid for larger flows, and supports keyboard-focusable/operable nodes and edges. Those features should be kept for the full graph, not used to justify displaying the entire graph in a tiny pane. citeturn14view10turn14view11turn14view12

There is also an important React implementation consequence: **CSS alone should not be responsible for this switch**, because mounting the full React Flow graph and merely hiding it at narrow sizes wastes work and leaves you managing duplicated semantics. Let container queries handle layout, but use one container measurement to choose the semantic representation:

```tsx
type ArchitectureMode = 'path' | 'subsystem' | 'full';

function modeForWidth(width: number): ArchitectureMode {
  if (width < 720) return 'path';
  if (width < 960) return 'subsystem';
  return 'full';
}
```

A small `ResizeObserver`-based hook at this boundary is justified because the **artifact itself changes**, not merely its styling.

The focus workspace should be an explicit action such as **“Open architecture workspace”**. It can temporarily give the graph most of the content area while retaining Sesame as a live, smaller stage or picture-in-picture reference. This is the one place where I would interpret “robot must remain dominant” as **product identity and persistent causal feedback**, not literally “the robot must own more pixels than every task surface at every instant.” Enforcing literal pixel dominance while reading 429 lines of C++ or navigating 63 nodes would make those tools unusable.

### The machine-checkable contract should be strict

**D12 — Treat these as product invariants, not suggestions.**

The following is the test contract I would start with. WCAG 2.2 provides the baseline for reflow, pointer-target sizing, non-text contrast, dragging alternatives, keyboard access, and related accessibility requirements; several recommendations below intentionally exceed the minimum because your audience is young and your product is dense. citeturn14view6turn15search3turn15search7

| Invariant | Automated assertion |
|---|---|
| **Meaningful text floor** | No visible meaningful text computes below **14px** |
| **Primary laptop body size** | At 1440×900, normal UI/body ≥ **16px**, code/table ≥ **15px**, lesson prose ≥ **17px** |
| **Token discipline** | No arbitrary `font-size` literals outside token definitions/explicit allowlist |
| **Vertical scrolling** | Each pane has **≤1 active vertical scroll owner** |
| **Nested vertical scrolling** | No scrollable `overflow-y:auto|scroll` element has another active vertical scrolling ancestor inside the pane |
| **Page horizontal overflow** | `document.documentElement.scrollWidth <= clientWidth` |
| **Semantic horizontal scroll** | Horizontal overflow allowed only on explicit `[data-2d-surface]` code/table/graph/pixel-editor surfaces |
| **Provenance** | Every telemetry datum visibly renders `OBSERVED`, `SIMULATED`, or `INFERRED` in text |
| **Origin** | Every telemetry datum visibly renders its origin; emulator execution says `QEMU`/`EMULATOR`, never merely “observed” |
| **No phantom hardware** | No current event can render origin `PHYSICAL`; persistent environment status states **hardware none** |
| **PWM invariant** | Every rendered `pwm.output` datum has `data-provenance="inferred"` |
| **Conceptual lesson invariant** | Untraceable lesson claims visibly contain the `CONCEPTUAL` label |
| **Unimplemented controls** | Every unavailable feature renders visible `NOT BUILT` text |
| **Correctness text never truncated** | Provenance, origin, witness text, lesson result, and NOT BUILT states may not use ellipsis/clamping |
| **Control targets** | Sesame policy: ≥ **36×36px** fine-pointer controls, ≥ **44×44px** coarse-pointer primary controls |
| **WCAG absolute target floor** | No pointer target below WCAG’s 24×24px minimum unless a documented criterion exception applies |
| **Contrast** | Normal text ≥ **4.5:1**; required UI/graphic boundaries ≥ **3:1** |
| **Focus** | Every interactive element keyboard reachable and shows an unobscured, visible focus state |
| **Reduced motion** | Under `prefers-reduced-motion: reduce`, nonessential camera tweens, sliding accordions, decorative graph movement and animated transitions are disabled |
| **Lesson measure** | At widths capable of supporting it, prose is **45–75ch**, target roughly **60–68ch** |
| **Modules narrow mode** | At Modules container width `<720px`, complete 63-node React Flow is not mounted |
| **Modules intermediate mode** | At 720–959px, full architecture is not the default view |
| **One laptop workbench** | At 1440×900 standard mode, ≤ **one** workbench overlay is visible |
| **Robot not occluded** | Robot projected bounding box remains inside the declared stage safe area after opening ordinary workbench |
| **Canonical zoom** | At 200% text/page zoom, no correctness text is clipped or replaced solely by tooltips |
| **Text-spacing tolerance** | Applying WCAG text-spacing overrides does not cause loss of content or functionality |
| **Dragging alternatives** | Slider/graph/editor interactions that depend on dragging expose keyboard or single-pointer alternatives where dragging is not essential |

The line-length recommendation is consistent with broad readability guidance: Baymard reports 50–75 characters as an effective body-text range, while USWDS gives 45–90 and a target around 66 for long text. For Sesame, **45–75ch with a target near 64ch** is a sensible stricter policy for lesson prose. citeturn14view13turn14view14

## Audience and product-position critique

### Keep the engineering identity; remove the IDE tax

The evidence does **not** support turning Sesame Lab into a cartoon application. NN/g reports that design guidance varies sharply by age and that older children may regard interfaces aimed even slightly younger as babyish. Its teen research similarly argues for scan-friendly content, meaningful interactivity and clear presentation while warning about clutter and small fonts. citeturn14view0turn14view1

There is also a precedent in programming education for **authentic representation plus reduced environmental complexity**. Greenfoot pairs standard textual Java with an interactive visual world instead of replacing real code with a fake language. MakeCode for micro:bit deliberately lets learners switch between blocks and textual JavaScript/Python, exposing the relationship between simplified and more authentic representations. These products are not proof that Sesame’s exact layout will work, but they demonstrate that the middle ground between Scratch and a professional IDE is real. citeturn15search4turn15search1turn15search6

That middle ground should be Sesame Lab’s position:

**Authentic content, novice-shaped interface.**

Authenticity means:

`wave()` stays `wave()`.  
GPIO 18 stays GPIO 18.  
`ESP32Servo` stays `ESP32Servo`.  
The C++ is the real pinned source.  
QEMU is called QEMU.  
An inferred PWM signal is called inferred.  
An unbuilt thing says NOT BUILT.

Novice-shaped interface means:

Only one question dominates at a time.  
Text is large enough to read.  
The causal path is visible before the whole architecture.  
A pane changes representation rather than becoming microscopic.  
Every interaction produces an understandable result near the thing that caused it.  
More detail is available without being simultaneously visible.

This is also consistent with developmental guidance. NN/g notes that children’s reasoning and executive functions are still developing and recommends clear, specific guidance without over-prescribing every step. Older children have motor abilities that support adult-like mouse, trackpad, dragging and scrolling interactions; that does **not** imply that adult information density is appropriate. citeturn14view2turn14view3

### The current two-dock accordion is a desktop idiom forced too early

The accordion itself is not the central problem. **Two independent accordion docks competing with the robot are.**

At an ultrawide width, two persistent domains—Control and Analysis—could work well. At 1440×900, their existence creates several costs at once: two navigation systems, two possible open states, multiple scroll positions, more borders and headers, and pressure to compress the content inside them.

NN/g’s teen findings are relevant here: dense screens and clutter reduce usability, while teens respond well to useful interactivity and scannable organization. A serious visual style does not compensate for too many simultaneous interface regions. citeturn14view1

**Recommendation:** preserve “Control” and “Analyze” as top-level concepts, but make them two modes of a single laptop workbench. Within that workbench, use tabs or a compact section navigator before using nested accordions.

For example:

```text
CONTROL | ANALYZE

Analyze
  Inspector
  Modules
  Signal
  Source
  Learn
  Lab
```

Once a learner is in **Signal**, that pane should feel like the current task, not like one accordion section inside a dock inside another dock beside another dock.

### The biggest cognitive-load problem is simultaneous representation, not technical vocabulary

I would not simplify vocabulary aggressively. The learner came to understand a robot.

I would simplify **concurrency**:

Do not ask a 12-year-old to understand the robot, a 63-node map, eight servo rows, provenance categories, C++ source, and a lesson narrative at the same visual priority.

A good Sesame interaction is closer to:

```text
Do:        Send wave
See:       Robot waves
Trace:     wave() → setServoAngle()
Inspect:   shoulder target = 42°
Go deeper: open source / architecture
```

The next level is always real, but the entire stack is not permanently foregrounded.

That is what “training wheels” should mean here: **not fake controls, but controlled scope**.

## Responsive design system

### Use fluid typography, but do not fluidly shrink below the readability floor

The type system should scale slightly with available viewport size, then stop. The purpose of `clamp()` is to smooth transitions, not to make 4K displays enormous or phones microscopic.

```css
:root {
  /* Meaningful-text floor: 14px */
  --font-xs: clamp(0.875rem, 0.855rem + 0.07vw, 0.9375rem);
  /* 14 → 15px */

  --font-sm: clamp(0.9375rem, 0.915rem + 0.08vw, 1rem);
  /* 15 → 16px */

  --font-md: clamp(1rem, 0.975rem + 0.09vw, 1.0625rem);
  /* 16 → 17px */

  --font-lg: clamp(1.125rem, 1.08rem + 0.16vw, 1.25rem);
  /* 18 → 20px */

  --font-xl: clamp(1.25rem, 1.16rem + 0.32vw, 1.5rem);
  /* 20 → 24px */

  --font-2xl: clamp(1.5rem, 1.32rem + 0.55vw, 2rem);
  /* 24 → 32px */

  --leading-ui: 1.45;
  --leading-body: 1.55;
  --leading-reading: 1.62;
  --leading-code: 1.5;
}
```

The critical rule is **not the exact interpolation expression**. It is that `--font-xs` has a hard 14px floor and that most text never uses the smallest token.

I would map roles as follows:

```css
body {
  font: 400 var(--font-md) / var(--leading-ui)
    ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI",
    sans-serif;
}

.metadata,
.provenance-badge,
.line-number {
  font-size: var(--font-xs);
}

.code,
.telemetry-value,
.numeric-cell {
  font-size: var(--font-sm);
}

.lesson-copy {
  font-size: clamp(1.0625rem, 1.02rem + 0.12vw, 1.125rem);
  line-height: var(--leading-reading);
  max-inline-size: 68ch;
}

code,
pre {
  font-family:
    ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas,
    "Liberation Mono", monospace;
}
```

Do not use a narrower font as a responsive strategy. A 13px narrow monospace can make more characters fit, but it fixes the developer’s geometry by transferring the cost to the learner.

### Use a small, boring spacing system

The existing UI likely feels “IDE-like” partly because tiny type encourages tiny spacing. Correct the two together.

```css
:root {
  --space-0: 0;
  --space-1: 0.25rem; /* 4 */
  --space-2: 0.5rem;  /* 8 */
  --space-3: 0.75rem; /* 12 */
  --space-4: 1rem;    /* 16 */
  --space-5: 1.5rem;  /* 24 */
  --space-6: 2rem;    /* 32 */
  --space-7: 3rem;    /* 48 */
  --space-8: 4rem;    /* 64 */

  --shell-gap: clamp(0.75rem, 0.55rem + 0.45vw, 1.5rem);
}
```

Recommended semantic use:

| Use | Space |
|---|---:|
| Icon ↔ label | 8px |
| Badge internal padding | 4px × 8px |
| Closely related fields | 8px |
| Row fields | 8–12px |
| Pane padding, laptop | 16px |
| Pane padding, narrow phone | 12px |
| Group-to-group separation | 16–24px |
| Major section separation | 24–32px |
| Reading block separation | 24px |

On a 4K monitor, **show more information; do not merely scale everything up**. Body text should top out around 17px, reading text around 18px, and ordinary pane padding around 20–24px. The additional space is best spent on larger robot rendering, wider code/trace surfaces, parallel panes, and fewer modal/focus transitions.

### Breakpoints should represent shell regimes, not every component

The current `899px` and `1440px` pair is too coarse because it makes component behavior depend on viewport assumptions that are not true once overlays become resizable.

I recommend only a handful of viewport-level shell regimes:

| Viewport | Shell recommendation |
|---:|---|
| `<600px` | Phone: stage + bottom navigation + full-width workbench sheet |
| `600–899px` | Compact/tablet: stage + one overlay/sheet |
| `900–1599px` | **Laptop/default:** stage + one right workbench |
| `1600–2199px` | Wide: one dock may enter flow; optional secondary compact panel |
| `≥2200px` | Ultrawide/4K: two persistent domains permitted if stage still has a large minimum |

The exact 1600/2200 values should ultimately be driven by your stage budget, not browser folklore. The important correction is to stop interpreting **1440px as the beginning of roomy desktop layout**. It is your primary laptop target, so it should sit comfortably in the middle of a stable regime.

Pane breakpoints should then be independent:

| Container width | Generic pane state |
|---:|---|
| `<360px` | Very narrow; one column, minimal chrome |
| `360–519px` | Narrow |
| `520–719px` | Standard |
| `720–959px` | Wide |
| `≥960px` | Spatial/full-workspace capable |

These are not universal responsive-design breakpoints. They are **Sesame Lab component contracts**.

### Use modern viewport primitives for the shell

On mobile browsers, dynamic viewport units exist specifically to account for browser UI that changes the available viewport. Use `dvh` for full-height workspaces rather than assuming traditional `100vh` always represents the currently visible area. Container queries should solve pane width; viewport units should solve app-shell height. citeturn14view5

For example:

```css
.app {
  min-height: 100dvh;
  height: 100dvh;
  overflow: hidden;
}

.workbench-scroll {
  overflow-y: auto;
  overscroll-behavior: contain;
  scrollbar-gutter: stable;
}
```

The shell owns the fixed viewport; the active workbench owns one vertical scroll; pane internals grow naturally unless they are genuinely two-dimensional surfaces.

## Hard-pane behavior

### Source should preserve real code, not pretend C++ is prose

**C10 — Keep code unwrapped by default, provide an obvious Wrap Lines toggle, and allow horizontal scrolling. Do not solve the problem with a narrower or smaller font.**

VS Code defaults word wrap to off and lets users toggle it; GitHub’s code view likewise has a Wrap Lines option. That is a good precedent for authentic source viewing: preserve code’s original horizontal structure by default, but let a learner choose a readable wrapped view. citeturn14view8turn14view9

Recommended Source defaults:

```css
.source-code {
  font-size: var(--font-sm); /* ~15px */
  line-height: 1.5;
  white-space: pre;
  overflow-x: auto;
  overflow-y: visible;
  tab-size: 2;
}

.source-code[data-wrap="true"] {
  white-space: pre-wrap;
  overflow-wrap: normal;
}
```

Do not give Source a fixed internal height merely to manufacture a second scrollbar. The workbench should vertically scroll through all 429 lines; the code surface may independently scroll **horizontally only**, because code is legitimately two-dimensional.

For wrapped mode, visually distinguish continuation lines without changing the copied source. For example, a generated continuation marker or indentation guide can live in presentation markup while the actual copied text remains exactly the firmware source.

At narrow widths, prioritize:

```text
42  void setServoAngle(uint8_t servo, int angle) {
43      ...
           ↳ wrapped continuation
```

over either:

```text
9px micro-code so 110 columns fit
```

or destructive source transformation.

Also provide actions that reduce the amount the learner must visually search: **Jump to current symbol**, **Show called function**, and **Back to trace**. These are pedagogical navigation aids, not simplification of the source.

### Signal should become a sequence, not a collection of unrelated cards

**C11 — Do not immediately turn every trace row into a generic card.** The ordering and common fields are part of the trace’s meaning. At medium and wide widths, preserve row alignment.

At `≥720px` container width:

```text
STEP  EVENT              VALUE      PROVENANCE      WITNESS
 3    servo.target       42°        OBSERVED QEMU   Firmware wrote…
 4    pwm.output         1.7 ms     INFERRED QEMU   QEMU has no…
```

At `520–719px`, use a two-line row:

```text
3  servo.target       42°             [OBSERVED] [QEMU]
   Firmware wrote 42° to the shoulder servo target.
```

Below `520px`, use a **trace-step record**, which is visually card-like but preserves sequence:

```text
03 · SERVO TARGET

42°
[OBSERVED] [QEMU]

Firmware wrote 42° to the
front-right shoulder target.

setServoAngle() · GPIO 18
```

Fields that must survive at every width are:

**step/layer**, **event name**, **primary value**, **provenance**, **origin**, and **complete witness sentence**.

A timestamp, secondary implementation ID, or source link can move to a secondary metadata line. It may reposition; it should not disappear when it changes the interpretation.

Never truncate witness text just to retain table geometry. That is exactly the sort of data for which a table can legitimately require special reflow behavior under WCAG. citeturn14view6

### Inspector should change grouping before it drops columns

For eight joints × four numeric fields plus provenance:

At `≥600px`, keep a true table.

At roughly `440–599px`, use one joint per two-line grid row.

Below about `440px`, show one joint record:

```text
FR SHOULDER
Target      42°
Actual      41.8°
Delta       -0.2°
Servo       #2
[OBSERVED] [QEMU]
```

If individual values have different provenance, place the badge adjacent to the relevant value rather than applying one badge to the entire joint card.

The learner should never have to infer whether provenance belongs to the joint, the row, or one numerical datum.

### Face needs an integer-pixel zoom policy

A 128×64 bitmap editor is one of the cases where “responsive scaling” can make the tool less truthful.

Do not continuously shrink the pixel grid.

Use discrete zoom levels:

| Available editor width | Preferred OLED zoom |
|---:|---:|
| `≥1050px` | 8× → 1024×512 |
| `800–1049px` | 6× → 768×384 |
| `540–799px` | 4× → 512×256 |
| `<540px` | Keep **4×** and use horizontal pan/focus workspace |

A 2× or 3× editor may technically fit, but if individual pixels no longer feel directly manipulable, you have lost the point of the pane. On phones, make “Edit OLED” an explicit focused surface and let the robot remain visible as a small live preview above it.

### Lab editors need editor-specific responsiveness

This is where a generic “pane stacks below 520px” rule fails.

**Pose sliders:** stack label/value/slider; keyboard arrow input must work in addition to dragging. WCAG 2.2 requires a non-dragging alternative for drag operations unless dragging is essential. citeturn15search3turn15search11

**Animation frames:** horizontal timeline may remain horizontally scrollable; frame details should use the parent vertical scroller.

**OLED editor:** discrete pixel zoom as above.

**API console:** preserve request/response text as code-like surfaces. Wrap human-readable explanatory copy; do not silently wrap payload text if whitespace matters.

**Frame editor:** treat the timeline as intrinsically spatial rather than compressing frame targets below usable sizes.

The lesson is that “responsive pane” should mean **responsive to the data model of that pane**, not merely different CSS grid columns.

## Visual language and accessibility

### The dark palette is mostly better than the current typography suggests

Your provenance hues are actually among the stronger parts of the existing palette.

Using the WCAG contrast model against your dark surfaces, the approximate ratios are:

| Token | On `#0d1015` | On `#151a22` | On `#1b212b` | Verdict |
|---|---:|---:|---:|---|
| `--text #dfe5ee` | ~15.0:1 | ~13.8:1 | ~12.8:1 | Excellent |
| `--dim #8b95a6` | ~6.3:1 | ~5.8:1 | ~5.4:1 | Good |
| `--muted #6b7688` | ~4.15:1 | ~3.8:1 | ~3.5:1 | **Too low for normal text** |
| `--accent/#simulated #6e9ee6` | ~7.0:1 | ~6.4:1 | ~5.9:1 | Good |
| `--warn #e6b45a` | ~10.0:1 | ~9.2:1 | ~8.5:1 | Excellent |
| `--observed #4ec9a0` | ~9.2:1 | ~8.5:1 | ~7.8:1 | Excellent |
| `--inferred #c08de0` | ~7.4:1 | ~6.8:1 | ~6.3:1 | Good |

WCAG requires 4.5:1 for ordinary text under the standard contrast criterion; non-text UI indicators required to identify components or states generally need 3:1 against adjacent colors. citeturn14view6

So **keep the observed green, simulated blue and inferred purple**. They do not need wholesale redesign.

The weakest current tokens are `--muted` and `--line`. `#6b7688` should not carry meaningful 10–12px labels on your panels. And `#262d39` is fine as a decorative hairline but is too subtle to be the *only* boundary that communicates where a control begins or where keyboard focus is.

I would revise the dark system approximately to:

```css
:root {
  --bg:             #0b1016;
  --panel:          #121922;
  --panel-2:        #18212d;
  --panel-3:        #202b38;

  --text:           #edf2f8;
  --text-secondary: #b4bfce;
  --text-muted:     #93a0b2;

  --line-subtle:    #344154;
  --line-strong:    #60758d;

  --accent:         #8fb8ff;
  --warn:           #e6b45a;

  /* Keep the established semantic hues */
  --observed:       #4ec9a0;
  --simulated:      #6e9ee6;
  --inferred:       #c08de0;

  --focus:          #b9d4ff;
}
```

The important semantic correction is to stop treating **accent** and **simulated** as literally the same token. Even if they remain neighboring blues visually, they should be separate semantic variables so a future palette revision can change generic action/selection styling without changing provenance.

### Provenance needs redundant text, not clever iconography

WCAG’s use-of-color principle is straightforward: color must not be the only way to communicate meaning. For Sesame Lab, the solution is stronger than adding three obscure icons: **keep the actual words visible.** citeturn14view6

I recommend two explicit tokens everywhere:

```text
[● OBSERVED] [QEMU]
[◆ SIMULATED] [BEHAVIOR SIM]
[△ INFERRED] [QEMU]
```

The shape supplies a second visual cue. The written category is definitive. The origin token prevents the most dangerous misunderstanding.

For example:

```text
servo.target = 42°
● OBSERVED   QEMU
```

means “we observed this state inside QEMU,” **not** “a physical servo was measured.”

Likewise:

```text
pwm.output = 1.7 ms
△ INFERRED   QEMU
```

makes the emulator limitation explicit.

I would also permanently render this in the app-level status area:

```text
EXECUTION: QEMU EMULATOR     PHYSICAL HARDWARE: NONE
```

or, when using the behavior simulator:

```text
EXECUTION: BEHAVIOR SIMULATOR     PHYSICAL HARDWARE: NONE
```

That statement should remain visible even when a pane does not itself contain telemetry.

Do not encode “physical” as an inactive green/red lamp that a child might interpret as a connection indicator. Plain language is better.

### Focus and targets should exceed bare-minimum accessibility where practical

WCAG 2.2’s AA Target Size Minimum is 24×24 CSS pixels, with defined exceptions; W3C explicitly notes that larger targets can make interaction easier. I would make Sesame’s product policy **36px minimum for ordinary desktop controls and 44px for high-frequency controls on coarse-pointer/touch layouts**, while retaining 24px only as the conformance floor. citeturn15search7

Recommended control geometry:

```css
.control {
  min-block-size: 2.25rem; /* 36px */
}

@media (pointer: coarse) {
  .control {
    min-block-size: 2.75rem; /* 44px */
    min-inline-size: 2.75rem;
  }
}
```

A 12-year-old is generally physically capable of the same basic pointer interactions as an adult, according to NN/g’s age-related physical-development guidance, but that is not an argument for tiny hit areas. citeturn14view3

Use a visibly distinct keyboard focus ring:

```css
:where(
  button,
  a,
  input,
  select,
  textarea,
  [tabindex]:not([tabindex="-1"])
):focus-visible {
  outline: 2px solid var(--focus);
  outline-offset: 2px;
}
```

React Flow’s current accessibility support includes keyboard-focusable and operable nodes/edges, `Enter`/`Space` selection, arrow-key operation and automatic panning of focused nodes into view. Keep those capabilities enabled and customize ARIA descriptions to explain Sesame-specific node behavior. citeturn14view10

### Motion should explain state change rather than make the UI feel lively

Recommended timing is professional judgement rather than child-specific experimental evidence:

| Motion | Duration |
|---|---:|
| Hover/press/focus color | 100–140ms |
| Small disclosure | 140–180ms |
| Workbench transition | 180–220ms |
| Intentional camera reframing | 200–300ms |
| Robot physical motion | Whatever accurately communicates the simulated motion |

Do not animate every telemetry row entering. Do not bounce badges. Do not animate a graph merely because nodes changed.

Under reduced motion:

```css
@media (prefers-reduced-motion: reduce) {
  *,
  *::before,
  *::after {
    scroll-behavior: auto !important;
  }

  .workbench,
  .accordion,
  .camera-ui-transition,
  .graph-transition {
    transition: none !important;
    animation: none !important;
  }
}
```

Robot movement that is itself the phenomenon being taught is different from decorative UI animation; removing it entirely could remove information. Instead provide an immediate state change or manual-step mode where needed.

### Dark-only is technically possible but strategically weak

A dark interface is not inherently “adult” or “professional,” nor does WCAG require both light and dark themes. If your dark palette meets contrast and interaction requirements, dark-only can be conformant.

I nevertheless would **not make dark-only the permanent product decision** for a reading-heavy learning environment. Experimental work on display polarity has found proofreading performance advantages for positive polarity—dark text on a light background—over negative polarity. That does not mean every user always reads better in light mode, but it is enough to undermine the argument that dark mode should be the only reading environment. citeturn14view7

My priority would be:

**Now:** fix dark-theme typography, contrast, density, scroll behavior and layout.

**As part of the design-system refactor:** make all colors semantic tokens so a second theme is mechanically possible.

**Before treating the product as broadly finished:** add a light theme plus an explicit user theme choice.

Do not postpone the current fixes until light mode exists. Dark mode is not what makes your 9px text unreadable.

## CSS and React architecture

### Do not adopt Tailwind merely because the stylesheet is long

A 3,091-line stylesheet is not, by itself, evidence that you need Tailwind.

Your difficult problems are:

- component-specific responsive semantics,
- overlapping global media rules,
- typography drift,
- scroll ownership,
- correctness-state styling,
- spatial/editor surfaces,
- and the lack of enforceable tokens.

Tailwind does not decide whether Signal becomes a two-line record at 560px of *container width*. A component library does not know that `pwm.output` can never be observed. Those are the design-system decisions that matter.

**Recommendation: retain native CSS.** Split ownership and introduce layers/tokens first.

A reasonable structure is:

```text
styles/
  tokens.css
  reset.css
  base.css
  shell.css

  components/
    buttons.css
    badges.css
    tabs.css
    workbench.css

  panes/
    modules.css
    signal.css
    source.css
    inspector.css
    learn.css
    lab.css
    face.css

  accessibility.css
```

Whether those become CSS Modules is secondary. The key is that “Signal responsive behavior” should no longer be scattered among global viewport blocks hundreds of lines apart.

### Give every pane an explicit structural contract

I would standardize pane markup:

```tsx
type PaneProps = {
  id: string;
  title: string;
  children: React.ReactNode;
};

export function Pane({ id, title, children }: PaneProps) {
  return (
    <section
      className="pane"
      data-pane={id}
      aria-labelledby={`${id}-title`}
    >
      <header className="pane__header">
        <h2 id={`${id}-title`}>{title}</h2>
      </header>

      <div className="pane__content">
        {children}
      </div>
    </section>
  );
}
```

Then make the **workbench**, not arbitrary pane descendants, the ordinary vertical owner:

```css
.workbench__scroll {
  min-block-size: 0;
  overflow-y: auto;
}

.pane {
  container: pane / inline-size;
}

.pane__content {
  min-inline-size: 0;
}
```

A special surface opts into two-dimensional behavior explicitly:

```tsx
<pre
  className="source-code"
  data-2d-surface="code"
  aria-label="Firmware source"
/>
```

That `data-2d-surface` attribute becomes both documentation and a test hook.

### Give correctness surfaces data semantics too

Do the same with provenance:

```tsx
type Provenance = 'observed' | 'simulated' | 'inferred';
type Origin = 'qemu' | 'behavior-simulator';

function ProvenanceMark({
  provenance,
  origin,
}: {
  provenance: Provenance;
  origin: Origin;
}) {
  return (
    <span
      className="provenance"
      data-provenance={provenance}
      data-origin={origin}
    >
      <span className={`provenance__kind provenance__kind--${provenance}`}>
        {provenance.toUpperCase()}
      </span>
      <span className="provenance__origin">
        {origin === 'qemu' ? 'QEMU' : 'BEHAVIOR SIM'}
      </span>
    </span>
  );
}
```

Notice that `physical` is not even part of the renderable `Origin` union under the product’s current reality.

That gives TypeScript a role in correctness:

```ts
type PwmOutputEvent = {
  kind: 'pwm.output';
  provenance: 'inferred';
  origin: 'qemu';
};
```

rather than relying solely on CSS and browser tests to catch an impossible state.

For unbuilt functionality, likewise make the state explicit:

```tsx
<FeaturePanel status="not-built" />
```

whose contract requires visible `NOT BUILT` copy.

### Use CSS for presentation changes and React for semantic representation changes

This distinction will keep the responsive code tractable.

**CSS container query:** table moves from four columns to two lines.

**React semantic switch:** 63-node architecture graph becomes a causal path navigator.

**CSS:** Learn control moves below prose.

**React semantic switch:** full OLED editor opens focused mode because 4× pixels cannot fit.

**CSS:** badges wrap to a second line.

**React:** API console chooses a dedicated full-workspace editor state.

Do not create a giant React `useMediaQuery` tree for every margin and grid column. Equally, do not try to make CSS alone select between fundamentally different information artifacts.

## Quality gates for “cluttered and clumsy”

D12’s correctness tests prevent objectively broken layouts. **D13 needs perceptual proxy tests**—measures that cannot prove the design is elegant but can catch conditions strongly associated with it becoming cramped.

### Test a matrix of viewport sizes and container sizes independently

Your screenshot/layout suite should include at least:

| Viewport | Why |
|---|---|
| 375×812 | Small phone |
| 430×932 | Large phone |
| 768×1024 | Portrait tablet |
| 1024×768 | Constrained landscape |
| **1440×900** | **Primary release target** |
| 1920×1080 | Ordinary desktop |
| 2560×1440 | Large desktop |
| 3840×2160 | 4K |

But that is not enough after adopting container queries.

Every pane should also run through a component harness at approximately:

```text
320px
360px
480px
519px
520px
719px
720px
959px
960px
1200px
```

The values immediately around boundaries matter more than round device widths. Test `519/520`, not just 480/768.

### Add density budgets

These are **Sesame-specific design judgement**, intentionally stricter than standards.

At 1440×900 in the normal robot workspace:

- Exactly one ordinary workbench may be open.
- No pane may begin with more than two stacked navigation/chrome rows before content.
- The first visible workbench viewport must contain meaningful pane content, not only headings, tabs, filter controls and legends.
- No interactive row should depend on a control smaller than the text next to it.
- Correctness badges must never form a separate “badge cloud”; they belong to the datum they qualify.
- Do not allow three levels of visible panel borders around ordinary content.
- Only editor-like surfaces may deliberately exceed their container horizontally.

You can turn some of these into geometry assertions. For example, mark chrome:

```html
<div data-pane-chrome>...</div>
<div data-pane-content>...</div>
```

Then assert that, on the primary laptop, chrome does not consume more than roughly **30% of the initially visible pane height** before any content appears. Thirty percent is a product threshold, not a universal UX law; its purpose is regression detection.

### Measure occlusion rather than merely element dimensions

A stage can report a large DOM rectangle while the robot is hidden behind an overlay. Your test should know the safe area and compare it with the projected robot bounds.

Pseudo-test:

```ts
expect(robotBounds.left).toBeGreaterThanOrEqual(safeArea.left);
expect(robotBounds.right).toBeLessThanOrEqual(safeArea.right);
expect(robotBounds.top).toBeGreaterThanOrEqual(safeArea.top);
expect(robotBounds.bottom).toBeLessThanOrEqual(safeArea.bottom);
```

At 1440×900 with an ordinary workbench open, I would additionally require an unobscured stage region of at least approximately **800×600 CSS px**. This is a Sesame product budget, not a standards requirement.

### Test scroll topology directly

A useful browser helper is:

```ts
function isVerticallyScrollable(el: HTMLElement): boolean {
  const style = getComputedStyle(el);
  const canScroll = /auto|scroll/.test(style.overflowY);
  return canScroll && el.scrollHeight > el.clientHeight + 1;
}

function activeVerticalScrollers(root: HTMLElement): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>('*')]
    .filter(isVerticallyScrollable);
}
```

Then:

```ts
for (const pane of document.querySelectorAll<HTMLElement>('[data-pane]')) {
  const scrollers = activeVerticalScrollers(pane);
  expect(scrollers.length).toBeLessThanOrEqual(1);
}
```

If the workbench is intentionally the scroll owner outside the pane itself, adapt the scope accordingly and assert that pane descendants contribute zero additional vertical scrollers.

This catches the exact regression the user complained about instead of hoping a screenshot reviewer notices six tiny scrollbars.

### Test typography from computed styles, not source-code grep

A CSS lint rule catching `font-size: 9px` is useful, but computed style catches inheritance and responsive overrides.

```ts
const exempt = new Set([
  // Ideally empty. Add only genuinely non-semantic graphical ticks.
]);

for (const el of document.querySelectorAll<HTMLElement>('body *')) {
  if (!el.innerText.trim()) continue;
  if (el.hidden || getComputedStyle(el).display === 'none') continue;
  if (exempt.has(el.dataset.testId ?? '')) continue;

  const px = Number.parseFloat(getComputedStyle(el).fontSize);
  expect(px).toBeGreaterThanOrEqual(14);
}
```

Run a second assertion specifically at 1440×900:

```text
normal prose/UI     >= 16px
code/table          >= 15px
provenance/metadata >= 14px
lesson prose        >= 17px
```

This is the single test most likely to stop the current density from gradually returning.

### Test correctness semantics independently of visual snapshots

For every generated telemetry event:

```ts
expect(row).toContainVisibleText(/OBSERVED|SIMULATED|INFERRED/);
expect(row).toContainVisibleText(/QEMU|BEHAVIOR SIM/);
```

For PWM:

```ts
for (const event of page.locator('[data-event-kind="pwm.output"]')) {
  await expect(event).toHaveAttribute('data-provenance', 'inferred');
}
```

Globally:

```ts
expect(
  await page.locator('[data-origin="physical"]').count()
).toBe(0);
```

And assert:

```ts
await expect(
  page.getByText(/PHYSICAL HARDWARE:\s*NONE/i)
).toBeVisible();
```

This is better than relying on a screenshot to catch a provenance error because it tests the semantic model and the rendered truth simultaneously.

### Treat 200% zoom and user text spacing as release gates

WCAG’s reflow and text-spacing requirements are intended to prevent loss of content when users enlarge or alter text presentation. In a UI with many panes, this is also a valuable stress test for whether your layout has been tuned around tiny fixed text. citeturn14view6

Run the critical flows with enlarged text:

```text
Open Signal
Send wave
Read complete witness chain
Open Source
Jump to setServoAngle()
Return to trace
Open Inspector
Read joint values and provenance
```

A design that works only because 11px labels fit beside four columns will fail this immediately—which is precisely why the test is useful.

### The final design rule

The line Sesame Lab should hold is:

> **Do not simplify the engineering truth. Simplify how much of that truth competes for attention at one time.**

That means the real C++ remains real C++; provenance remains explicit; QEMU remains QEMU; pin numbers remain pin numbers; incomplete features say NOT BUILT. But a 12-year-old should read those facts at **14–17px**, in one clearly owned workspace, with the robot still visibly responding, and with the representation chosen for the space actually available.

The current system crosses the line into “professional IDE shrunk down” primarily because of **micro-typography, excessive simultaneous chrome, viewport-driven pane logic, and attempts to fit spatial artifacts into widths where they cease to function**. Research on older children argues against childishness, not against readability; research on teens argues for meaningful interaction, not density; educational programming environments show that authentic technical material can coexist with gentler information architecture. citeturn14view0turn14view1turn15search4turn15search6

The rebuild I would prioritize is therefore not a new component library or a new visual brand. It is a **responsive semantic system**: readable type, one laptop workbench, pane-level container queries, multiple representations for genuinely spatial content, one vertical scroll owner, and browser-enforced correctness invariants.