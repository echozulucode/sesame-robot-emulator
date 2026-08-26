# Sesame Lab — UI/UX Improvement Plan
## Responsive shell: left rail · maximised stage · collapsible right dock

**Status:** proposed, awaiting approval
**Opened:** 2026-08-26
**Trigger:** user evaluation on a laptop — *"For medium screens like my laptop, you can barely see
the robot at all."*

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
