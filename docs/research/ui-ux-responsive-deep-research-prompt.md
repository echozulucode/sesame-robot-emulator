# Deep research prompt — responsive UI/UX for a technical learning tool aimed at a 12-year-old

**Purpose:** an external-research brief for a **UI/UX specialist who is also fluent in React and modern CSS**. Copy everything below the rule into a deep-research tool.

**What we want:** not reassurance. A critique of the choices we made, plus concrete guidelines, a revised type/spacing/colour system, and layout rules that scale from a phone to a 4K monitor — with **the 1440×900 laptop treated as the primary target, not an afterthought.**

---

## Who you are being asked to be

A senior UI/UX designer with deep React and CSS expertise — container queries, `clamp()`, fluid type, CSS grid/subgrid, dvh units, modern layout primitives, and the React patterns that make them tractable. You also need judgement about **designing technical tools for children** without patronising them.

## The product

**Sesame Lab** teaches a technically curious **~12-year-old boy** how a real robot works. Sesame is an open-source ESP32 quadruped: 8 servos, a 128×64 OLED face, Arduino firmware.

The app shows a **3D robot** driven either by a behavioural simulator or by **real firmware executing in an emulator (QEMU)**. Around it sit panes that let the learner trace one command — say `wave` — from an HTTP request, through the firmware function, to a servo angle, to a joint rotating.

The stated design intent, from the project's own spec:

> *"An engineering lab with training wheels, not software for small children."*
> Explicitly rejected: oversized cartoon buttons, mascot narration, fake currency, confetti for trivial clicks, long forced walkthroughs.
> Explicitly wanted: short explanations adjacent to something manipulable, a visible cause-and-effect loop after almost every action, optional depth rather than walls of text, authentic code and pin numbers, debugging framed as normal engineering.

**This tension is the core design question we want you to arbitrate.** We aimed at "junior engineering tool." We may have landed on "dense professional IDE that a 12-year-old cannot read." Tell us where the line actually is.

## Current implementation

- **React 19 + TypeScript + Vite 7**, `@xyflow/react` for the node graph, **three.js / React Three Fiber** for the 3D robot.
- **One hand-written stylesheet, 3,091 lines. No Tailwind, no CSS-in-JS, no component library, no design system.** Zero UI dependencies — deliberate, and we would need a strong argument to change it.
- Dark theme only. Tokens:

```css
--bg:#0d1015  --panel:#151a22  --panel-2:#1b212b  --line:#262d39
--text:#dfe5ee  --dim:#8b95a6  --muted:#6b7688
--accent:#6e9ee6  --warn:#e6b45a
--observed:#4ec9a0  --simulated:#6e9ee6  --inferred:#c08de0
```

- **Base font: `13px/1.5 ui-sans-serif, system-ui, 'Segoe UI'`.**
- **Of 144 `font-size` declarations, 128 — 88% — are ≤ 12px.** 18 are 10px, 13 are 9px.
- Breakpoints: three, at `899px` and `1440px`. Media queries only; **no container queries anywhere.**

### Layout as it stands

```text
┌──┬────────────────────────────┬───────────┬──────────────┐
│  │                            │ CONTROL   │ ANALYSIS     │
│R │                            │ DOCK      │ DOCK         │
│A │        3D ROBOT            │           │              │
│I │        (the stage)         │ Commands  │ Inspector    │
│L │                            │ Face/OLED │ Modules      │
│  │                            │           │ Signal       │
│56├────────────────────────────┤           │ Source       │
│px│ thin status bar            │           │ Learn / Lab  │
└──┴────────────────────────────┴───────────┴──────────────┘
```

- **Rail** 56px, never collapses.
- **Stage** floor `min-height: 45vh`, `min-width: min(480px, 100%)`.
- **Docks** are accordions. Above 1440px they are in flow and resizable (320–520px). **Below 1440px they are `position: absolute` and overlay the stage**, so opening one costs the robot no width. Currently `min(460px, 92vw)`, being widened.
- On smaller widths, one section open at a time across both docks.

## The three problems, in the user's words

1. > *"For medium screens like my laptop, you can barely see the robot at all."*
   **Fixed.** The viewport went from 494×191 (24% of a 1440×900 screen) to 1314×646 (80%).

2. > *"Everything is too small and too many scrollbars."*
   Three levels of nested scrolling existed: dock body → section body → six different inner panes. Being reduced to one scroller with panes at natural height, per the user's explicit preference: *"I'd rather have to scroll through the pane vertically on smaller screens than tiny content and many scrollbars."*
   **We suspect the deeper cause is the 88%-under-12px type scale, not the layout.**

3. > *"The architecture pane is so tiny that it is unusable on medium screens."*
   **Unsolved, and the hardest.** It is a `@xyflow/react` node graph: 63 nodes / 65 edges, collapsible, showing ESP32 → Movement → 8 Servos, Face → OLED, Network → HTTP API. Expanding a node reveals a chain such as *movement function → `setServoAngle` → `ESP32Servo` → LEDC → GPIO → MG90S → joint*. At Wide it gets `52vh` and works. In a ~460px overlay it is unusable. **A pan/zoom canvas may simply be the wrong representation below some width** — we want your view on that.

## What each pane holds — the constraint that makes this hard

Panes differ in *kind*, so one responsive rule will not serve all of them:

| Pane | Content | Why it resists shrinking |
|---|---|---|
| **Modules** | 63-node pan/zoom graph | Spatial. Needs 2D area; a list is a different artefact, not a smaller one |
| **Signal** ("See the Signal") | Causal trace: 8 layered rows per command, each with a provenance badge and a sentence of witness text | Wide rows. Reads as a table; truncation destroys it |
| **Source** | Real C++ from a pinned firmware commit, 429 lines, with line numbers, symbol highlighting and annotation | Long *and* wide. Code does not reflow |
| **Inspector** | 8 joints × 4 numeric columns, plus provenance | Tabular |
| **Learn** | Lesson runner: prose, a manipulable control, a pass/fail check | Prose wants ~60–70ch; the control wants room |
| **Lab** | Five tabs: pose sliders, animation frames, 128×64 pixel editor, API console | Editors want direct manipulation |
| **Face** | 128×64 OLED at 8× = 1024×512 logical | Fixed aspect. Below ~4× the pixels stop being inspectable |

## A non-negotiable constraint

Several UI elements are **correctness surfaces, not decoration**, and must not be compressed away:

- Every telemetry event carries provenance: `observed` / `simulated` / `inferred`, plus an origin (emulator vs physical). **Nothing has ever run on real hardware**, and the UI must never imply it did.
- A row reading `pwm.output` is **inferred** even when real firmware is executing, because the emulator models no PWM waveform.
- Lessons are badged `conceptual` when a claim cannot be traced to a firmware symbol.
- Unbuilt controls render an explicit "NOT BUILT" panel rather than silently doing nothing.

**Any design that hides these behind a disclosure, an icon, or a tooltip is wrong.** Show us how to keep them legible *and* unobtrusive at every size — that is a genuine design problem and we do not think we have solved it.

## What we are asking for

### A. Critique
1. Where does the current approach fail a 12-year-old specifically — type scale, information density, colour, affordance clarity, cognitive load?
2. Is "dark professional IDE" right for this audience, or a mistake we rationalised? What does the evidence say about technical tools for 11–14-year-olds? Is there a defensible middle between Scratch and VS Code?
3. Is the two-dock accordion the right pattern, or a desktop idiom forced onto a laptop?
4. **Is 88% of type at ≤12px the real cause of "I cannot read the content"?** What base size and scale would you specify for this age group on a 1440×900 screen?

### B. A responsive system
5. A **fluid type scale** (`clamp()`), spacing scale, and density rules from ~375px to ~3840px. Concrete numbers.
6. **Should we adopt container queries?** These panes live in resizable docks, so their width is decoupled from the viewport — the textbook case. What would that change, and what is the migration cost from 3,091 lines of media-query CSS?
7. **Breakpoint strategy.** We have three (899/1440). Too few? Wrong places? Should the *dock* have its own breakpoints independent of the viewport?
8. **1440×900 is the primary target.** What should it look like specifically? Not "it depends" — a recommended configuration.

### C. The hard panes
9. **The architecture graph below ~1000px.** Options we see: (a) a different representation — indented tree, breadcrumb-scoped list; (b) full-screen focus mode; (c) reduce the visible node set; (d) something else. Which, and why? Does a spatial graph earn its place on a laptop at all?
10. **Code at narrow widths.** Horizontal scroll, soft wrap with continuation markers, or a narrower font? What do the best code readers do?
11. **The trace table.** Rows have 4–5 fields plus a sentence. Card-per-row below some width? Which fields survive?

### D. Rules we can enforce
12. Give us **machine-checkable rules** — we assert layout in a headless browser already. E.g. "no computed font-size below Npx", "no more than one scroll container per pane", "line length between 45 and 75ch". We would rather encode your guidance as tests than as good intentions.
13. What should we assert to catch "cluttered and clumsy" *before* a user reports it?

### E. Styling for the actual audience
14. Concrete revisions: palette, type, spacing, iconography, motion — that read as **a serious tool a 12-year-old can use**, not a toy and not a professional IDE shrunk down. Keep the existing provenance colours if they work; say if they do not (`--observed` green, `--simulated` blue, `--inferred` purple — these carry real meaning and are load-bearing).
15. **Accessibility**: contrast against these dark tokens, focus states, keyboard navigation, target sizes, `prefers-reduced-motion`. Note that colour currently carries provenance meaning — what is the non-colour redundancy?
16. Is dark-only defensible, or do we need a light theme?

## Constraints on your recommendations

- **Zero UI dependencies today.** Recommend Tailwind or a component library only with a clear argument for a hand-written stylesheet of this size; state the migration cost honestly.
- React 19, Vite 7, TypeScript, `@xyflow/react`, three.js/R3F. Dark-first.
- **No physical hardware exists**, ever. Nothing may imply a real servo moved.
- The 3D robot is the product's centrepiece and must stay dominant at every size.
- We can restructure the stylesheet freely — but we cannot lose the provenance surfaces or the layout assertions that protect them.

## Output we want

Prioritised and specific. Concrete values, not principles: type ramps with numbers, spacing scales, breakpoint tables, CSS for the patterns you recommend, React structure where it matters. Cite research on interfaces for this age group where it exists, and say plainly where you are applying professional judgement instead. **Where you think we made a bad call, say so directly** — we would rather rebuild than defend it.

Answer **A4, B6, B8, C9 and D12** first; those unblock the most work.
