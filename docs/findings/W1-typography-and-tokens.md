---
task: "W1 — the type scale, the spacing scale and the cascade layers"
phase: 4
status: complete
date: 2026-08-27
owns: apps/web, scripts/capture-web-screenshots.mjs
plan: docs/plans/phase-4-ui-ux-revision.md §4 W1
source: "docs/research/Sesame Lab_ responsive UI_UX research brief.md"
amends: docs/findings/U6-two-dock-shell.md
---

# W1 — typography and tokens

**No layout changes.** The plan is explicit that fixing the type scale alongside the
shell makes regressions unattributable, so this workstream moved sizes and spacing
and nothing else. Where raising the type genuinely broke a box, the box was fixed —
never the type — and where it could not be fixed without moving a pane, it is
recorded below for W3 and W4 rather than smuggled in here.

**Trigger:** the same reader, for the third time.

> *"I still cannot read any of the content."*

That complaint survived U1–U5 (which gave the stage its width back) and U6 (which
gave it its height back and put one pane on screen at a time). Two layout fixes did
not touch it, which is consistent with typography being the actual cause — and the
external brief says so in as many words: *"the 88% of declarations at 12px or below
is one of the main causes"*, and *"fix it before interpreting further usability
feedback"*.

---

## 1. What was measured, before

`apps/web/src/styles.css`, 3,091 lines, at the commit this workstream started from:

| | |
|---|---:|
| `font-size` declarations with a px value | **144** |
| …at 12px or below | **128 (88.9%)** |
| …at 10px | 18 |
| …at 9px | 13 |
| …**below 14px** | **140 (97.2%)** |
| …at or above 14px | 4 |
| base `font` on `body` | **13px** |

The distribution: `9px ×13 · 9.5 ×3 · 10 ×18 · 10.5 ×4 · 11 ×38 · 11.5 ×8 · 12 ×44 ·
12.5 ×2 · 13 ×9 · 13.5 ×1 · 14 ×3 · 15 ×1`.

Four declarations out of 144 were legible by the brief's floor.

## 2. The token system

Eight role tokens, one per row of the brief's 1440×900 table. Named by **role**
rather than by t-shirt size, because every invariant is role-shaped — *"code ≥ 15",
"prose ≥ 17", "nothing below 14"* — and a role name is checkable against the table.

| Token | 1440×900 | 2560 | Role | Uses |
|---|---:|---:|---|---:|
| `--font-badge` | **14** | 15 | badges, chips, line numbers, counters, dots — the absolute floor | 47 |
| `--font-code` | **15** | 16 | monospace, telemetry values, table cells | 16 |
| `--font-ui` | **16** | 17 | the default: body, labels, buttons, inputs | 52 |
| `--font-prose` | **17** | 18 | lesson and explanation prose | 14 |
| `--font-heading` | **18** | 20 | section headings inside a pane | 9 |
| `--font-title` | **20** | 24 | pane titles | 2 |
| `--font-workspace` | **24** | 28 | mode/workspace titles | 0 |
| `--font-display` | **28** | 32 | milestones | 0 |

`--font-workspace` and `--font-display` are defined and unused. They are the two
rows of the table this shell has no surface for yet; W3's workspace title is the
first one that will claim `--font-workspace`. They are asserted against the table
anyway, so the row exists when the surface arrives.

### Fluid upward, floored downward

Every `clamp()` **minimum is the 1440×900 value**:

```css
--font-ui: clamp(1rem, 0.9196rem + 0.0893vw, 1.0625rem); /* 16 -> 17 */
```

At 1440 and at every width below it, that computes to exactly 16px. Above 1440 it
interpolates to 17px at 2560. The brief's warning is *"do not fluidly shrink below
the readability floor"*, and this is the strongest available reading of it: there is
no viewport width at which the app produces smaller text than the table says.

That also makes **"no compact mode as a default"** structural rather than a
discipline. A narrower window cannot shrink type, because there is nothing to shrink
it with — the harness now proves that statically by requiring **zero `font-size`
declarations inside any `@media` block in the file**, and the five that used to be
there (13–13.5px overrides that *raised* sizes below Wide) are gone, because 13px is
now below the floor.

### Line height and space

`--leading-tight/ui/code/body/prose/heading/title/display` (1.35 / 1.45 / 1.5 / 1.55
/ 1.62 / 1.3 / 1.25 / 1.2), covering the brief's three bands, plus the brief's
"small, boring" space scale `--space-0 … --space-8` (0, 4, 8, 12, 16, 24, 32, 48, 64)
and `--shell-gap`. Tiny type encourages tiny spacing and the brief is explicit that
the two have to be corrected together.

## 3. Cascade layers

```css
@layer reset, tokens, base, shell, components, panes, utilities, overrides;
```

Every rule in the file is in one of them. Two things came out of doing it, and both
were bugs the harness caught rather than opinions:

**React Flow's stylesheet was unlayered, so it beat the entire file.** It was
`import '@xyflow/react/dist/style.css'` in `ArchitectureGraph.tsx`; a stylesheet
imported that way is unlayered, and unlayered rules outrank *every* layer, including
`overrides`. The symptom was exact: the library's `.react-flow__edge-text {
font-size: 10px }` and its 10px attribution link survived on a page whose own
stylesheet had no literal left in it. It is now
`@import '@xyflow/react/dist/style.css' layer(reset);` at the top of `styles.css`,
which is where third-party base styles belong.

**`shell` loses to `panes`, and the below-Wide dock overrides were in `shell`.** The
`@media (max-width: 1440px)` block does two different jobs: dock geometry
(`.docks`, `.dock`, `.stage`) and pane internals (`.dock-section-body .source-outline`,
`.arch-canvas`, `.lab-code`…). Layered, the second half stopped winning and
`.source-outline` and `.source-context` grew their own scrollbars back — three
scrollable boxes in a dock that is allowed one. The block is split: geometry stays in
`shell`, pane internals moved to the end of `panes`. That split is also the honest
one, and it is what W2 replaces with container queries.

## 4. What raising the type broke, and how each was fixed

Every one of these was found by measuring computed styles and box geometry in a real
browser at four window sizes and eight open panes, not by looking at screenshots.

| # | What broke | Fix — none of them was "make it smaller again" |
|---|---|---|
| 1 | **The rail's provenance and origin chips.** 9px with `text-overflow: ellipsis` — a correctness surface a reader could not finish reading, in the zone the product promises never closes. At 14px in a 48px column even one word broke mid-word (`emulat/ed`). | Two changes. The rail is **72px** instead of 56 (64px of usable column, which fits every one of the protocol's origin words whole), and `OriginTag` gained a `compact` variant that renders the origin's **kind** without its engine and board. The full string is still rendered whole on the status line and in `#prov-banner`; the short form is produced by calling `describeOrigin({ kind })` — the protocol's own function with the detail stripped — so there is no second table of words to drift. |
| 2 | **Architecture graph nodes.** 124×46 held a 12px label over a 9px summary. At 15/14px both clipped. | `NODE_W` 124→**192**, `NODE_H` 46→**112**, `ROW_H` 62→136, node padding reserves room for the absolutely-positioned expand button, summary clamp 2→3 lines. See §6 — this one has a cost. |
| 3 | **Signal trace rows.** `layer │ label │ badge` on one unwrappable line with a 108px minimum on the layer column, fitting only because the three were 10.5, 12.5 and 9px. At 14/16/14 the head ran up to 145px past the row — and every trace row carries `data-origin-kind`. | `flex-wrap: wrap` and `min-inline-size: 0`. The column alignment the minimum bought is worth less than a provenance badge a reader can finish. |
| 4 | **Witness text.** `overflow-wrap` was not set, and one witness contains `HSCH0/HSCH1/HSCH2/HSCH3/LSCH0/LSCH1/LSCH2/LSCH3` — 47 characters with nowhere to break. In a 271px Wide dock that ran 155px past the row. | `overflow-wrap: anywhere` on `.trace-row-witness` and `.trace-row-detail`. It was already off the edge at 10.5px; raising the type is what made the harness able to see it. |
| 5 | **C++ at Compact.** A 96-column line of `movement-sequences.h` at 15px is wider than a 560px sheet, and the below-Wide block had forced `overflow: visible`, so it was clipped by `.source-panel`. | W5's rule is *"preserve real code, do not reflow C++ as prose"*, so the code region scrolls **sideways**: `overflow-x: auto; overflow-y: hidden`. The `hidden` is deliberate — the box takes its content height below Wide so nothing is hidden, and it stops the browser promoting `overflow-x: auto` into a scroller on both axes, which would have put a second vertical scrollbar in the dock. |
| 6 | **Collapsed-section badges.** A 12px pane title left room for the §5.1 badge beside it in a narrow dock; a 20px one does not, and `robot unmodified` rendered as `robot unmodifi`. | The toggle wraps; the badge drops to its own line instead of being cut. |
| 7 | **The OLED/inspector key–value grid.** A flat 108px key column is a third of a 320px dock at 11px and two thirds of a 190px one at 15px, so `simulated` broke across two lines. | `grid-template-columns: fit-content(40%) minmax(0, 1fr)` — a share of whatever width the pane has, instead of a number chosen for one dock size. Stacking the pair outright below a threshold is a container query and belongs to W2. |
| 8 | **React Flow's attribution link.** 10px, from the library's own rule on the anchor rather than the wrapper. | Covered by the layered `@import` above, plus a rule that names the anchor. |

## 5. The invariants this workstream added

**Static, before any browser starts** (`scripts/capture-web-screenshots.mjs`, the
type-scale block). It is first because it is the one thing a browser cannot prove: a
page can render every visible node at 16px and still carry a `font-size: 9px` rule
on a pane nobody happened to open.

| Invariant | Result |
|---|---|
| the cascade layers are declared, in order | pass |
| **every `font-size` is a role token** or `inherit` | **141 declarations, 0 literals** |
| **no `font-size` inside any `@media` block** | **0** |
| each token's `clamp()` **minimum** equals the brief's table | 8/8 |
| the smallest role token is exactly the 14px floor | pass |

**In the browser**, at 880×900, 1280×800, 1440×900 and 2560×1440, with each of the
eight dock sections opened in turn — computed styles, as the brief and the plan both
require, rather than a grep.

| Invariant | Result |
|---|---|
| **no visible meaningful text computes below 14px** | 0 violations at all four windows |
| at 1440×900 **body ≥ 16** | 16.00 |
| at 1440×900 **code / telemetry / table cells ≥ 15** | 15.00 |
| at 1440×900 **lesson prose ≥ 17** | 17.00 |
| **no correctness surface is ellipsised, clamped or cut** — `.prov`, `[data-origin-kind]`, `#prov-banner`, witness text, lesson check results, NOT BUILT panels | 0 violations at all four windows |
| dock text at Compact/Medium is never smaller than at 1440 | pass, and now identical by construction |
| type never shrinks as the window grows either | pass (Wide reads 16.98 / 15.98 / 17.98) |

Two of these deserve a note about what they do **not** claim.

**The Wide reference changed.** U6 asserted that five nodes are not smaller at Medium
or Compact than at *Wide*. With a scale that is fluid upward, a 2560px desktop
legitimately reads 16.98px body against 1440's 16.00, and asserting parity with Wide
would assert that a bigger screen may not use its width. The reference is now the
1440×900 laptop the brief was written for, and Wide is checked separately in the
other direction — clamp may grow the scale and never shrink it. The rule the reader's
complaint deserves is unchanged; only the thing it is measured against is.

**Pan/zoom surfaces are measured at their authored size.** The architecture canvas
carries `data-zoom-surface="architecture"`. Inside it the floor is asserted on the
computed `font-size`; everywhere else it is asserted on the size **after** every
transform in force. See §6 — the harness records the worst on-screen size it finds
inside a zoom surface as a NOTE rather than swallowing it.

## 6. Handed on

**W4 — the architecture graph, and this workstream made it slightly worse.** Stated
plainly because it is the one regression here. A bigger node box means React Flow's
`fitView` picks a smaller zoom, so the text lands on screen smaller even though it is
authored larger. Measured A/B, same state, node label only:

| Window | graph canvas | old box, 12px label | new box, 15px label |
|---|---:|---:|---:|
| 880×900 | 439 px | 4.2 px (zoom 0.352) | **3.8 px** (zoom 0.250) |
| 1440×900 | 599 px | 9.0 px (zoom 0.750) | **8.0 px** (zoom 0.532) |
| 1600×900 | 243 px | 4.1 px (zoom 0.342) | **3.7 px** (zoom 0.243) |
| 2560×1440 | 351 px | 5.4 px (zoom 0.453) | **5.1 px** (zoom 0.322) |

A 10–15% loss on a surface that was already three to six times below the floor. Edge
labels are worse still; the harness reports the worst it finds, every run:

> the architecture graph draws 395 run(s) of text below the 14px floor ON SCREEN, at
> as little as 2.1px…

There is no type size that fixes this. Shrinking the nodes brings the clipping back;
enlarging them zooms out further; leaving the type at 9px would have made the numbers
above worse still. The brief's answer is the one in the plan: *"do not squeeze the
63-node architecture graph into a 460px pane"* — a causal-path navigator below 720px
of pane width, a subsystem graph to 959px, the full map only at 960px or in a focus
workspace. W1 deliberately did not disguise the debt by shrinking anything else, and
the `data-zoom-surface` attribute exists so the type invariant cannot silently absorb
it later.

**W3 — the status line.** `StatusBar` chooses its segments by *viewport* breakpoint,
but the line lives in the *stage*, which at Wide can be barely half the viewport once
both docks are in flow. At 1600×900 with both docks open the optional glance words
(`0 physically observed`, `0/8 joints commanded`, `ground −31.1 mm`) ellipsise to
about half their width. The provenance and origin chips never do — they are checked,
and they render whole — so what truncates is the derived glance counts, not the
honesty surfaces. Fixing it properly means choosing segments by measured width, which
is a component change to the line W3 rewrites anyway (and where the persistent
`SYSTEM: QEMU EMULATOR · PHYSICAL HARDWARE: NONE` line lands).

**W3 — the rail.** 72px is the minimum that fits the protocol's origin words at the
floor; it is not a design. The plan already specifies a 64px rail with a readable
14px label and W3 owns it.

**W2 — narrow panes.** At 1600×900 the two in-flow docks shrink to about 230px each,
which is roughly 25 characters of 17px prose. Nothing here is below the floor and
nothing is truncated, but a 25ch measure is a long way from the brief's 45–75ch. That
is a pane-width problem, not a type problem, and it is what container queries plus
one workbench are for.

**Wide, with every section open at once.** Opening all eight sections at 2560×1440
leaves each at its 220px minimum and the bounded panes inside them clip. It is not a
state phase 12 or a reader reaches — the accordion opens a few — and it is
pre-existing (the minimum is a fixed pixel count, not a type size). Noted so W2's
scroll-ownership pass does not have to rediscover it.

## 7. Verification

- `pnpm -r run test` — **948 passing**, unchanged.
- `pnpm --filter @sesame-lab/web typecheck` — clean.
- `node scripts/capture-web-screenshots.mjs` — **32 captures, 0 problems**, one NOTE
  (§6). Every pre-existing assertion still holds: the three source registers still
  render in different computed styles (L4), ISSUE-20260823-023 still holds the world
  frame to 1e-6 mm at every breakpoint and across both dock resizes, both docks still
  overlay rather than push below Wide, one pane is open at a time behind exactly one
  scrollbar, and `wave` is still reachable from the status line with both docks shut.
- **Zero new dependencies.**

The screenshots changed and were read rather than counted. The judgement they support:
at 1440×900 the shell, the command vocabulary, the inspector, the source explorer,
the signal trace and the lesson runner are legible for a 12-year-old — 16px UI, 15px
C++, 17px prose, 20px pane titles, nothing clipped and no correctness surface cut.
The architecture graph is not, and no amount of type work will make it so; that is
§6's first paragraph and W4's job.
