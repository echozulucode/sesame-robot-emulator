# Sesame Lab — UI/UX Improvement Plan
## Responsive shell: left rail · maximised stage · two collapsible docks

**Status:** built. §§1–9 are the original plan and shipped as U1–U5; **§10 amends them** and is what
is on screen now.
**Opened:** 2026-08-26 · **Amended:** 2026-08-27
**Trigger:** user evaluation on a laptop — *"For medium screens like my laptop, you can barely see
the robot at all."* — then, after U1–U5 shipped, three more readings of the same screen:
*"I don't like the commands and OLED at the bottom"*, *"everything is too small and too many
scrollbars"*, and *"I'd rather have to scroll through the pane vertically on smaller screens than
tiny content and many scrollbars."*

---

## 1. The measured problem

`apps/web/src/styles.css` is **2,407 lines with zero `@media` queries.** The shell is a fixed grid:

```css
.app {
  grid-template-columns: minmax(0, 1fr) minmax(0, 520px) 400px;
  grid-template-rows:    minmax(0, 1fr) minmax(0, 380px) auto auto;
}
```

Both fixed columns and the fixed row are unconditional, so on a 1440×900 laptop:

| Axis | Budget | Consumed | **Left for the robot** |
|---|---|---|---|
| Width | 1440 | 520 (workbench) + 400 (inspector) + gaps | **≈ 500 px** |
| Height | ~780 usable | 380 (source explorer) + two `auto` rows ≈ 120 | **≈ 280 px** |

**The 3D viewport gets roughly 500 × 280 — about 13% of the screen**, on the machine the product is
being evaluated on. On a 2560-wide monitor the same CSS leaves ~1,640 px and looks fine, which is
why this was never caught: every one of the 26 harness captures runs at a fixed 1440×900 or wider
window, and none of them assert how much space the viewport actually got.

**This is a layout bug, not a taste problem.** The robot is the product.

## 2. Design

Adopt the three-zone shell the user described — the pattern used by Claude Cowork and most modern
IDE-style tools.

```text
┌──┬────────────────────────────────────────┬─────────────────┐
│  │                                        │  RIGHT DOCK     │
│L │                                        │  ▼ Inspector    │
│E │            CENTER STAGE                │  ▶ Modules      │
│F │         (3D robot + OLED)              │  ▶ Signal       │
│T │                                        │  ▶ Source       │
│  │                                        │  ▶ Lab          │
│R │                                        │                 │
│A │                                        │  collapsible,   │
│I ├────────────────────────────────────────┤  resizable,     │
│L │  optional bottom drawer (Lab / console)│  overlays on md │
└──┴────────────────────────────────────────┴─────────────────┘
  56px            flexible, never < 45vh          0 / 320–520px
```

**Left rail (56 px, always visible).** Mode switch (Learn / Lab), backend selector, connection +
provenance status. Icons with labels on hover; never collapses, because the provenance badge must
never be more than a glance away — that is a product-honesty requirement, not decoration.

**Center stage (flexible, guaranteed minimum).** The 3D viewport and the OLED. Gets every pixel not
claimed by the rail and the dock. **Hard floor: `min-height: 45vh` and `min-width: 480px`.** If the
dock cannot fit above that floor, the dock overlays instead of pushing.

**Right dock (collapsible, resizable, breakpoint-aware).** All secondary panes become collapsible
sections in one accordion:

| Section | Today |
|---|---|
| Inspector | column 3 |
| Modules (architecture graph) | workbench top |
| Signal (See the Signal) | workbench bottom |
| Source | row 2 |
| Lab | row 4 |
| Emulator facts | inside inspector |

## 3. Breakpoints

Three, keyed to what actually fits rather than to device names.

| Name | Width | Dock behaviour | Sections open |
|---|---|---|---|
| **Compact** | < 900 px | Hidden; opens as a **full-height sheet** over the stage | 1 |
| **Medium** | 900–1440 px | **Collapsed to a 44 px icon strip**; clicking opens it as an **overlay** over the stage, not a push | 1 (accordion) |
| **Wide** | > 1440 px | **Docked** at 320–520 px, user-resizable, persisted | many |

**Medium is the case that is broken today, and the rule that fixes it is: on medium the dock
overlays, it does not push.** The stage keeps its full width; the dock floats above it with a
scrim. That is what buys the laptop its robot back.

At **Wide**, restore the report's requirement that the architecture graph and the Signal trace be
visible *simultaneously* — the cross-highlight is the feature. Below Wide that is physically
impossible, which leads to §5.

## 4. Section behaviour

- **Accordion, not tabs.** Sections carry live state (a trace is running, a lesson check is
  pending); tabs imply "one at a time" and destroy context on switch.
- **Persisted per breakpoint** in `localStorage`, defensively (try/catch both ways; correct render
  with no stored value — the existing Lab persistence is the model).
- **Compact and Medium auto-collapse to one open section**; Wide restores the user's set.
- **Header shows state while collapsed** — event count, lesson progress, pending check — so
  collapsing costs no awareness.
- **Resizable dock** with a drag handle, min 320 / max 520, double-click to reset.

## 5. The cross-highlight problem — the one real risk

The report's central interaction is that clicking `R4` in the 3D scene highlights it in the
architecture graph, the trace and the inspector. **If those sections are collapsed, that highlight
happens where nobody can see it**, and the app silently appears to do nothing.

That would be a genuine regression in the feature Phase 2 spent the most effort on. Two mitigations,
both required:

1. **A collapsed section whose content just became selected shows a badge on its header** — a dot
   plus a count, e.g. `Modules ● R4`. The selection is still visible, just summarised.
2. **`selectNode`/`selectJoint`/`selectSymbol` auto-expand their target section on Compact and
   Medium**, exactly as the source explorer already auto-expands a collapsed graph node.

Neither invents new state — `SelectionState` already exists and is already shared by all four panes.

## 6. Explicitly out of scope

- No visual redesign — colours, type and the three registers (description / commentary /
  `libraryEvidence`) stay exactly as they are. L4 asserts their computed styles differ; that test
  must keep passing.
- No new dependencies. L4, L6 and L7 each added zero; a layout change does not justify a UI kit.
- No change to what any pane *says*. Provenance, `isPhysicallyObserved()`, the `conceptual` badges,
  the NOT BUILT panels and the modifying-this-robot banner are correctness surfaces, not styling.
- No touch to `hardware/`, `packages/` or the backends.

## 7. Tasks

| Task | Scope |
|---|---|
| **U1** | Shell: left rail, center stage, right dock skeleton; move existing panes in unchanged |
| **U2** | Breakpoints + the overlay-not-push rule; stage floor (`45vh` / `480px`) |
| **U3** | Accordion sections: collapse, persist, header state, resizable dock |
| **U4** | Cross-highlight preservation: header badges + auto-expand (§5) |
| **U5** | Harness: multi-viewport captures and the assertions in §8 |

U1–U4 are one agent's work — they are the same component tree, and splitting them across agents
would mean two agents editing `App.tsx` concurrently, which this project has already established as
a data-loss risk. U5 is the same agent, because a layout change that does not update the harness
leaves 26 captures asserting a layout that no longer exists.

## 8. Verification — the gap that let this ship

The harness has 26 captures and **none assert how much space the viewport got**. That is precisely
why a 13%-of-screen robot passed every check.

Add, at **three window sizes** (1280×800, 1440×900, 2560×1440):

- [ ] **Viewport occupies ≥ 45% of viewport height and ≥ 480 px width at every breakpoint** — the
      assertion that would have caught this
- [ ] Robot is visible: non-background WebGL pixel count above a floor at each size
- [ ] **ISSUE-023 world-frame stability re-asserted at every breakpoint.** A user found that bug
      after a layout change; this *is* a layout change. Grid drift must stay 0.000 mm while the
      foot contact sweeps.
- [ ] Dock overlays rather than pushes at Medium — assert the stage's width is unchanged when the
      dock opens
- [ ] Collapsed-section selection shows a header badge (§5.1)
- [ ] `selectJoint` auto-expands its section on Medium (§5.2)
- [ ] Section collapse state survives reload
- [ ] Learn mode still completes lesson 2 end to end at Medium
- [ ] Lab C++ export still round-trips at Compact
- [ ] All 912 tests still pass; L4's computed-style assertions still pass

## 9. Definition of done

- [ ] The robot is the largest thing on screen at 1440×900
- [ ] Every existing pane reachable at every breakpoint
- [ ] Cross-highlight demonstrably survives collapse
- [ ] Zero new dependencies
- [ ] No change to any correctness or provenance surface
- [ ] Harness asserts viewport share at three sizes


---

# 10. Amendment — the second dock, the status line, and one scroller

**Built 2026-08-27.** §§1–9 above describe what shipped as U1–U5 and the problem it solved. Three
readings of the result changed three of its decisions. What follows replaces the corresponding parts
of §2, §3, §4 and §8; everything else in this plan still stands, including the whole of §5 and §6.

## 10.1 What the reader said, and what each sentence cost

| Reading | What it invalidated |
|---|---|
| *"I don't like the commands and OLED at the bottom. How about a second vertical dock next to the other one with similar functionality."* | §2's "center stage (3D robot **+ OLED**)" and the optional bottom drawer. The strip cost `clamp(120px, 20vh, 176px)` — up to 176 px of the height U1–U5 existed to give back. |
| *"The present right pane also doesn't have good UX for medium sized screens. Everything is too small and too many scrollbars."* | §4's accordion, which nested `.dock-body` → `.dock-section-body` → a pane's own scroller three deep, and §3's 320–520 px dock, which is a width the overlay never had to pay for. |
| *"When I select one of the panes, the other should be collapsed... I'd rather have to scroll through the pane vertically on smaller screens than tiny content and many scrollbars."* | The idea that a bounded, individually-scrolling region is a kindness. At one column it is not. |

## 10.2 The layout, as built

```text
+--+--------------------------+-------------+---------------+
|  |                          | CONTROL     | ANALYSIS      |
|R |       CENTER STAGE       | v Commands  | v Inspector   |
|A |    3D robot (>= 45vh)    | > Face      | > Modules     |
|I |                          | > Lab       | > Signal      |
|L +--------------------------+             | > Source      |
|  |  status line (34 px)     |             | > Learn       |
+--+--------------------------+-------------+---------------+
 56px      never < 45vh          0/44/400      0/44/460
```

**The control dock is inboard**, adjacent to the stage, so the reading order is the robot, then the
surfaces that drive it, then the surfaces that explain it.

**`Lab` moved across** from the analysis dock. It is a driving surface, not a reading one, and the
pane that authors the OLED's pixels now sits beside the OLED it authors.

**The bottom strip is a 34 px status line.** Its content scales with the breakpoint rather than with
its own box, so what it shows is testable from `window.__sesame.shell()` rather than by reading
pixels:

| Breakpoint | On the line |
|---|---|
| Compact | connection · provenance · origin · `wave` `stop` |
| Medium | + event count, physically-observed count, backend, board · `stand` `rest` |
| Wide | + joint summary, ground plane, boot attempts, origin engine |

Every value is a summary of something the inspector states in full, read from the same store field,
so the two cannot disagree. Nothing here computes a verdict.

## 10.3 The rules that replace §3 and §4

| | U1–U5 | **Now** |
|---|---|---|
| Docks | one | **two**; below Wide **at most one open** |
| Open sections below Wide | one per dock | **one across both docks** |
| Overlay width at Medium | `min(460px, 92vw)` | **620 px control / 720 px analysis**, capped at 84vw |
| Scrollers in an open dock below Wide | up to 3, nested | **exactly 1** — the dock body |
| Panes below Wide | bounded, each scrolling | **natural content height** |
| Type in the dock below Wide | same as Wide | **larger than Wide**, and asserted never smaller |
| Dock width range | 320–520 | 320–560 |

The overlay's width is free — below Wide the docks are out of flow and take nothing from the stage —
so it is spent. That is the cheapest fix available for "everything is too small", and it exists only
because the overlay rule from §3 exists.

## 10.4 `.source-code`, and the assertion that had to stay meaningful

U5 recorded the source pane's three bounded rows (130 / `1fr` min 200 / 220 px) as load-bearing: an
auto-height row lets the code region grow to all 429 lines while L4's *"selecting a joint scrolled
the code to the symbol's first line"* assertion keeps passing and stops meaning anything.

That argument still holds **at Wide**, where the bounds and the assertion both live — L4 runs in the
1600×1000 session and is unchanged. Below Wide the code region is bounded by **line count** instead:
`SourceExplorer` renders a window around the selected symbol, says in the UI which lines it is
showing, and offers a button to lift the budget. The harness asserts the rendered `.src-line` count
equals the announced range and stays under the budget. A cap a reader can read beats a mystery
gutter, and the check is about the bound that is actually in force at that width.

## 10.5 `[data-command="wave"]`, resolved rather than weakened

Moving the vocabulary into a dock that starts shut put *"`wave` is reachable at every breakpoint
without opening anything"* in tension. Resolution:

- `[data-command="wave"]` stays the single, unambiguous handle on the real vocabulary button, now in
  the control dock's `Commands` section. Phases 6 and 7 open that section and click it
  **hit-tested** — the button must have a laid-out box and be the topmost element at the centre of
  it. The check it replaces (`querySelector !== null && !disabled`) passes for a `hidden` button, so
  this is strictly stronger than what was there.
- The status line carries a `[data-quick-command]` cluster — `wave`, `stand`, `rest`, `stop`, named
  from `COMMAND_VOCABULARY` so a shortcut cannot invent a command the firmware lacks. Phase 12
  asserts, **with both docks shut, at every breakpoint**, that `wave` is hit-test-reachable and
  enabled, then clicks it and requires telemetry to come back.

Two attributes rather than two `data-command` buttons, so no selector in the harness can click a
shortcut when it meant the vocabulary.

## 10.6 Verification — what §8 becomes

Everything in §8 still runs. Added or strengthened:

- [x] **Viewport share improved at every size** — 95.8 / 95.2 / 95.8 / 97.5 %, against 82.0 / 80.0 /
      80.0 / 86.9 %
- [x] **Overlay-not-push measured once per dock** — 0.0 px, both docks, all three sizes below Wide
- [x] **Exactly one scrollable box in the open dock** at Compact and Medium
- [x] **Exactly one open section across both docks** at Compact and Medium
- [x] **No computed font size in the dock smaller at Medium/Compact than at Wide**
- [x] **`wave` hit-test-reachable with both docks shut**, and it commands
- [x] **The source pane's rendered line count equals its announced window** below Wide
- [x] ISSUE-20260823-023 at every breakpoint **and across a resize of each dock**
- [x] Both docks' widths and the open section survive a real reload
- [x] 948 workspace tests pass (36 shell tests, up from 22)

## 10.7 Definition of done — amended

- [x] The robot is the largest thing on screen at 1440×900, and larger than U1–U5 left it
- [x] Every pane reachable at every breakpoint; `wave` reachable without opening anything
- [x] One pane, one scrollbar, at Compact and Medium
- [x] Nothing in the dock is smaller below Wide than at Wide
- [x] Zero new dependencies; the lockfile is untouched
- [x] No change to any correctness or provenance surface
