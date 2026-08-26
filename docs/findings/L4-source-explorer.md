---
task: "L4 — source explorer: real source, synchronised with the other three panes"
phase: 2
status: complete
date: 2026-08-25
owns: apps/web, scripts/capture-web-screenshots.mjs
---

# L4 — the source explorer

The research report's four synchronised panes, closed into a loop:

```text
Real source  ↔  Architecture node  ↔  Robot part  ↔  Runtime event
```

Evidence: `docs/findings/assets/v3-v4-browser-capture.json` → `phases.sourceExplorer`
and `phases.sourceIntegrityRefusal`. 19 real-browser captures, 0 problems, 135
`apps/web` tests (42 new), 851 workspace tests. **No dependency was added and the
lockfile is untouched.**

---

## 1. The gitignored source, and why the browser hashes it anyway

`firmware/upstream/` is fetched by script and gitignored. The four annotated files
are therefore absent from a clean clone and from any deployed build unless
something puts them there. Two options were on the table.

**Rejected: vendor the four files into `src/generated/`.** This repository
deliberately does not commit upstream source — `firmware/upstream/` and
`reference/` are both gitignored by explicit decision — and a generator that
quietly reversed that would be laundering 384 kB of someone else's tree into this
one, in a project whose whole posture is that provenance is visible.

**Adopted: bundle at build time, not at commit time.** `serveUpstreamSource()` in
`apps/web/vite.config.ts` is the same shape as the `serveGlb()` plugin that has
served `assets/sesame.glb` since V3 without copying it into the package: a dev
middleware, and `emitFile` into `dist/upstream/<path>` at build. Neither git nor
`src/` gains a copy; `dist/` is self-contained; `apps/web/dist/` is gitignored, so
the upstream bytes never enter version control.

That gives **two independent gates, against two different threats**:

| Gate | Where | Protects against | On mismatch | On absence |
|---|---|---|---|---|
| build | `generateBundle` | building against a moved tree | **fails the build** | warns, emits nothing |
| runtime | `src/source/load.ts` | a stale `dist/`, a cache, a rewritten transfer | **renders no code at all** | says "run `scripts/fetch-upstream`" |

The build-time gate proves what the *builder* had. Only the runtime gate proves
what the *browser received*, and that is the one that protects a learner: source
rendered at wrong line numbers is real C++, correctly coloured, with the highlight
box around the wrong function, and there is no visible symptom.

`SHA-256` is ~70 hand-written lines (`src/source/sha256.ts`) rather than
`crypto.subtle`, because `crypto.subtle` is undefined outside a secure context and
a gate that disappears when the page is served over a LAN address is not a gate.
It is checked against the NIST vectors and against `node:crypto` at 12 lengths
around the padding boundaries. 297 kB costs ~4 ms, once, lazily.

### Both refusal paths were exercised, not merely written

- **Runtime, in a real browser** — harness **phase 9** copies `dist/`, changes
  **one byte** in the middle of `movement-sequences.h` (still valid C++, still 429
  lines, every symbol range still "resolves"), serves it, and asserts
  `integrity === "mismatch"`, `renderedLineCount === 0`, **zero `.src-line` nodes
  in the DOM**, and that both hashes are printed. It further asserts the refusal
  is *per file* — the untampered `.ino` still reads `ok` — and deletes
  `captive-portal.h` in the same run to exercise the clean-clone `missing` path.
  Recorded: `expectedSha256 f77d7137…`, `servedSha256 5a6382ad…`.
- **Build time** — `SESAME_UPSTREAM_DIR` (added so the branch can be driven
  without writing to the read-only `firmware/upstream/`) points the plugin at a
  scratch copy; three unit tests drive `generateBundle` directly and assert it
  errors naming both hashes, emits nothing for the offending file, and *warns
  rather than failing* when the tree is simply absent.

---

## 2. Bidirectional linking

All four directions run through the **one** `SelectionState` in
`state/selection.ts`. Nothing in the pane keeps a private selection.

`SelectionOrigin` gained exactly one member, `'source'`. `SelectionState` gained
one field, `symbolId`, because the two sets are not in bijection: 63 architecture
nodes land inside 90 annotated symbols, so most symbols (`setFace`,
`delayWithFace`, `handleSetSettings`) have no node and folding the symbol into
`nodeId` would make two thirds of the outline unselectable.

**The join is line containment, everywhere, computed at runtime** (V8 measured
zero misses across all 63 nodes). `crossRefs.hardwareMap` ↔ `derivedFrom` is *not*
used to join, because the two artefacts spell the same JSON paths differently;
`derivedFromAgreement()` surfaces the disagreement in the pane instead of
smoothing it, and it fires visibly on `setServoAngle`.

| Direction | Mechanism | Asserted in phase 8 |
|---|---|---|
| symbol → node | innermost symbol range containing `node.sourceRef` | graph `selectedNodeId === "movement.runWavePose"` after a DOM click on the outline |
| symbol → robot part | `symbol.robotParts` → `litJointsFor()` → `MeshStandardMaterial.emissiveIntensity` | lit `["R1","L2","R4","L3"]` exactly; R2 and L1 at 0 |
| symbol → runtime | `TraceRow.sourceRef` inside `[startLine, endLine]` | `firmware.command`, `movement.enter` |
| joint → symbol | `joint.L3`'s own `sourceRef` (`movement-sequences.h:10`) | lands on `ServoName`, whose `robotParts` contains L3, and the code view **scrolled** to it |
| node → symbol | same containment | outline row selected, window recentred |
| trace row → symbol | row's `sourceRef` (new arm: rows with a citation and no node) | — |

Two deliberate asymmetries. **Ambiguity is not resolved by guessing:**
`ServoName` contains nine nodes' citations (eight joints plus `servos`), so
`selectSymbol` leaves `nodeId` null and renders all nine as *related*. And the
symbol→joint and symbol→trace branches are **guarded on `joint === null`**,
because a joint selection resolves to the enum that names all eight, and letting
them fire there would light the other seven under a click about one leg.

Three real defects were found and fixed by these assertions rather than by
reading: a stale `useMemo` dependency that numbered `#pragma once` as line 83; a
`useEffect` that made the file tabs unclickable by snapping back to the selected
symbol's file every render; and an `offsetTop` scroll that measured against the
wrong offset parent. The line number and its text are now produced by the **same**
memo, so they cannot drift apart again.

The 3D highlight also had a latent bug this exposed: it lit every descendant of a
joint, so lighting R2 lit R4's foot. Meshes are now attributed to their **nearest**
joint ancestor — the rule the debug hook already used — which is what makes
"the wave lit exactly four joints" assertable.

---

## 3. Three registers, three treatments

L3 separates what the code *says* from what we *think* from what a *library*
says, and the pane keeps them apart by more than one signal each. Computed styles
are read back from the live browser and asserted to differ.

| Register | Treatment | Verified |
|---|---|---|
| `description` — a fact, checkable line by line | ordinary body text | `rgb(223,229,238)`, no border, upright |
| `commentary` — a judgement | amber left rule, indented, **italic**, labelled "our reading — a judgement, not the code" | `rgb(232,220,196)`, `font-style: italic` |
| `libraryEvidence` — ESP32Servo 3.0.9, **a different tree** | violet **dashed** box, labelled "evidence from a library, not from this pinned tree", cited as library + version + path + line | `border-style: dashed`, distinct background, text names `ESP32Servo 3.0.9` |

Teaching notes render as cards keyed by `kind` (`defect` red, `surprise` blue,
`design` violet) with every citation shown as `file:line` **plus the exact line
text L3 recorded** — which is what turns "trust the annotations" into "here is the
line, and here is what claims it". Cited lines are also marked in the code
gutter; phase 8 asserts the marked set equals the set the annotations cite.

**TN-007 is honoured explicitly.** Any symbol that commands a joint carries a live
readout built on `packages/sesame-model`'s `quantiseCommandedAngle()`: a commanded
90° is shown as **1601.56 µs, tick 82 of 1024, identical to 89°**, above a fixed
line stating 181 commandable angles, 92 distinct pulses, **89 aliased**. The
harness asserts both the `89`/`alias` wording and the `1601.56` figure, so nothing
here can quietly regress into implying 1° resolution.

---

## 4. Concept density

`concepts[].symbols` is dense — `face` 38 of 90, `timing` and `animation` 33 — so
**no concept↔symbol graph is drawn at all**. A ranked, capped, paged list replaces
it. `rankConceptSymbols()` scores each symbol by three terms already present in
the data: `+2` if it is the concept's own `primaryAnchor` (an explicit editorial
judgement about which code best shows the concept), `1/(1+position)` for how
central the concept is to that symbol, and `1/log2(lineCount+2)` for specificity —
so the 3141-line bitmap blob ranks far below the 12-line `setFace()` for the
`face` concept. Ties break on file then start line, so the order is stable and
testable. Six chips per page; the density is shown as a badge on every concept
chip.

The three explanatory levels are a switch, never a stack: phase 8 asserts exactly
**one** `concept-text` element exists on screen and that clicking the control
moves from `beginnerProgrammer` to `beginner12`. `emulator` — the one concept with
zero symbols — says so rather than showing an empty list.

The `conceptual` badge is driven by `curriculum[].grounding` and carries the
`conceptualReason` as its title. Asserted: 7 of 19 modules, and
`build-a-leg-pose` badged on `runStandPose` with its full reason.

---

## 5. Verification

`scripts/capture-web-screenshots.mjs` gains **phase 8** (source explorer) and
**phase 9** (the refusal). Full run with QEMU: 19 captures, 0 problems.

- integrity `ok` for `movement-sequences.h` and for the 297 kB `face-bitmaps.h`,
  hashed in the browser;
- **the rendered line numbers match the annotations**: the painted text of line 91
  equals `runWavePose`'s `startLineText`, and of line 107 its `endLineText` —
  asserted against `source-annotations.json`, not against a literal;
- a DOM click on the outline lights the architecture node **and** exactly
  `R1 L2 R4 L3` in the three.js materials;
- `selectJoint("L3")` lands the code view on a symbol whose `robotParts` contains
  L3, **and the container actually scrolled** (measured with
  `getBoundingClientRect`, not asserted from React state);
- the mismatch path renders **0** code lines and prints both hashes; the absent
  path names `scripts/fetch-upstream`; an untampered file in the same build still
  reads;
- **ISSUE-20260823-023 re-asserted** with the source pane mounted, after loading
  the largest annotated file and re-selecting symbols while the robot moved:
  ground plane, robot root, orbit target and camera all drift **0.000000 mm**
  across a `rest → stand` sweep in which the foot contact moved 37.535 mm. Phase 7
  now runs with the pane mounted too, so the check is doubled.

Layout note: the pane takes a **new grid row**, not a fourth column, so the
viewport keeps its width. Squeezing the renderer's column is the same class of
change that produced ISSUE-20260823-023 in the first place.

Syntax colouring is a 200-line scanner (`src/source/cpp-highlight.ts`), not
`highlight.js` (~90 kB) or `shiki`. The semantic structure is already known from
the annotations; colour here is legibility, and no claim rests on a token class.
It threads state across lines, which is not optional: `index_html` is a
**1007-line raw string literal** that a per-line scanner would render as keyword
soup.

---

## 6. What `source-annotations.json` did not say

Three things cost time and should be written down. **Nothing in `hardware/` was
changed** — all three are documentation gaps, not data errors.

1. **The pinned tree is CRLF, and the artefact treats that two different ways.**
   `git ls-files --eol` in `firmware/upstream/` reports `i/crlf w/crlf`, so this
   is upstream's own content. `meta.filesAnnotated[].sha256` is the hash of the
   **CRLF bytes**; `startLineText`, `endLineText` and every citation `text` are
   recorded with the **CR stripped**. Both are right, and together they pin the
   contract exactly — hash the bytes as received, compare the normalised line —
   but neither the artefact nor the schema says so, and the obvious
   implementation (`split('\n')`, compare to `startLineText`) fails on **every
   line of all four files**.

2. **Citation texts are also `trimEnd`-ed.** 11 of the 261 citations differ from
   the raw line by trailing whitespace alone (`runRestPose`'s opening line among
   them). Leading whitespace is preserved. Measured: after stripping CR and
   trailing whitespace, **250 citations match exactly and 11 match on the trim;
   0 fail.** Worth stating in `meta.epistemicContract`, since the validator's
   "re-read and compare exactly" pass line reads as though no normalisation is
   involved.

3. **`grounding: "conceptual"` does not imply `symbols: []`.** Three of the seven
   conceptual modules do carry symbols — `inside-the-brain` cites the pin table,
   `build-a-leg-pose` cites two pose functions, `build-a-movement` cites
   `runWalkPose`. That is coherent (the pins and the pose vectors are facts; the
   *framing* — a chip interior, an anatomy — is what has no grounding), but a UI
   that badges on "symbols is empty" would badge only four of the seven. The badge
   is driven by `grounding` and a test pins the three exceptions by name.

Two smaller notes. **`symbolAt()` must return `null` for uncovered lines** — L3
covers 91–99 % and every uncovered line is blank, a comment, a `#pragma once` or
an `#include`, so treating `null` as an error fires on the include block. And
**containment is genuinely ambiguous for two nodes** (`developer`, `serial.cli`),
which sit in both `loop` (`:752-884`) and the nested `serial-cli` (`:786-883`);
the innermost span is the more specific reading unit and wins.

---

## 7. Not done, deliberately

- No entry added to `docs/index.yaml` for this document or for
  `L3-source-annotations.md`; that file sits outside this task's ownership and a
  concurrent agent is active. The orchestrator should add both.
- The lesson runner is a later task. This pane surfaces curriculum modules as
  badged chips and nothing more.
- `apps/web/src/generated/source-annotations.ts` is generated and `--check`ed in
  `pnpm --filter @sesame-lab/web test`, so the app cannot drift from
  `hardware/source-annotations.json`. Regenerate with
  `pnpm --filter @sesame-lab/web run build:source-annotations-module`.
