# L3 — Source annotations: the data layer for the source explorer

**Task:** L3 (Phase 2, source explorer data layer) · **Date:** 2026-08-25 · **Agent:** `source-annotations`

Deliverables:

| Artifact | What it is |
|---|---|
| `hardware/source-annotations.json` | 90 symbols, 39 concepts, 17 teaching notes, 19 curriculum modules — all resolved against the pinned tree |
| `hardware/source-annotations.schema.json` | draft 2020-12, `additionalProperties: false` throughout |
| `scripts/build-source-annotations.mjs` | deterministic generator, `--check` mode |
| `scripts/validate-source-annotations.mjs` | four-layer validator, wired as `pnpm validate:source-annotations` |

No UI. `apps/web/` and `packages/` were not touched.

The research report is explicit that arbitrary C++ must **not** be explained by an LLM at
runtime; instead the explorer reads annotation metadata maintained against a pinned commit.
This file is that metadata. Every fact in it resolves to `file:line` inside
`firmware/upstream/` at `401730514cefed738710d22303e84b0dcd6b76d0`.

---

## 1. How the line numbers are guaranteed to resolve

F4's model was "extract from pinned source with `file:line` provenance on every fact", and
`pnpm validate:hardware-map --check-lines` checks those citations by confirming the line
number is within the file. **This artifact strengthens that check**, because a source
explorer that highlights the wrong nine lines is worse than one that highlights nothing.

Three mechanisms, in order of strength:

1. **Nothing is located by a hand-typed line number.** The generator's symbol table carries
   an *anchor string* — a substring of the line the symbol starts on — and `locate()` fails
   loudly if that anchor is missing or ambiguous. An `occurrence: n` escape hatch exists for
   deliberately repeated anchors (the six identical `pressingCheck("forward", …)` guards
   inside `runWalkPose`) and still fails if occurrence *n* does not exist. Two anchors were
   rejected as ambiguous while writing this and had to be made specific.

2. **End lines come from a C++-aware brace matcher**, not from counting. It skips line
   comments, block comments, string literals and character literals. On this exact commit a
   naive counter happens to produce the same answer for all 64 brace-matched symbols —
   checked, not assumed — because the two stray braces inside `loop()`'s string literals
   (`"int8_t servoSubtrim[8] = {"` at `firmware/sesame-firmware-main.ino:835` and `"};"` at
   `:840`) balance each other. That is luck, not a property: one more such literal, or an
   unbalanced one, would silently truncate the largest function in the file. The skipping is
   there so the anchor mechanism keeps working when upstream moves.

3. **Every citation carries the source text of the cited line**, and the validator re-reads
   the pinned tree and compares it exactly. `261 cited lines re-read and matched` is the
   pass line. A citation that has slid by one line fails; a citation whose line number is
   still in range but now reads something else fails. File `sha256` and line counts are
   checked first, so tree drift is reported once at the top rather than as fifty mismatches.

Two independent consistency gates run on top of that:

- Every movement/pose symbol's range is located by anchor **and then asserted equal** to the
  range F4 recorded independently in `hardware-map.json`. All 19 agree. If the two artifacts
  ever disagree, both builds fail rather than one silently winning.
- `meta.upstreamCommit` must equal both `firmware/upstream.pin.json` and
  `hardware-map.json`'s `meta.sourceTree.upstreamCommit`.

Tamper test performed: sliding one symbol's `startLine` by +1 and one teaching-note citation
by +2 produced five distinct failures, including the two text mismatches, the concept
back-link mismatch, and a stale coverage count. Flipping one `conceptual` module to
`factual` failed at the schema layer before the semantic checks even ran.

---

## 2. Coverage of the teaching surface

### 2.1 Lines

| File | Lines | Annotated | |
|---|---:|---:|---:|
| `firmware/sesame-firmware-main.ino` | 1137 | 1038 | 91.3 % |
| `firmware/movement-sequences.h` | 429 | 397 | 92.5 % |
| `firmware/face-bitmaps.h` | 3158 | 3141 | 99.5 % |
| `firmware/captive-portal.h` | 1015 | 1007 | 99.2 % |

**Every uncovered line is blank, a comment, a `#pragma once` or an `#include`** — checked
programmatically, not asserted. There is no executable statement in any of the four files
that falls outside an annotated symbol. The uncovered comments are the doc comments sitting
immediately above an annotated function; a UI that wants them can widen a range by scanning
backwards.

### 2.2 Entities

| Surface | Annotated | In `hardware-map.json` |
|---|---:|---:|
| Movement + pose functions | 19 | 19 |
| HTTP routes | 10 | 10 |
| Boot steps referenced | 20 | 20 |
| Command vocabulary referenced | 19 | 19 |
| Faces referenced by name | 18 | 38 |

Faces are annotated as a **registry and a pipeline** (`FACE_LIST`, `MAKE_FACE_FRAMES`,
`faceEntries`, `faceFpsEntries`, `setFace`, `updateAnimatedFace`, `updateFaceBitmap`), not
one symbol per face. Per-face frame data stays in `hardware-map.json`, which already owns it
down to the definition line of each frame array. The 18 faces named here are the ones a
movement function or an idle routine actually selects; the other 20 are the conversational
faces reachable only through `POST /api/command` or the serial `face <name>` command.

### 2.3 Symbols by kind

`helper` 25 · `pose-function` 15 · `handler` 10 · `state` 9 · `config` 6 · `region` 6 ·
`macro` 4 · `movement-function` 4 · `type` 4 · `table` 3 · `entrypoint` 2 · `data` 2.

`region` covers spans that are not C++ declarations but are the natural unit a learner
reads: the include block, the prototype block, the movement header's `extern` contract, and
— importantly — the **two dispatchers nested inside `loop()`**: the command chain at
`:762-783` and the serial CLI at `:786-883`. The validator permits nesting but rejects
partial overlap, so a range can be a sub-view of another but can never straddle two symbols.

---

## 3. Concept vocabulary

39 concepts, each carrying all three of the report's explanatory levels
(`beginner12` / `beginnerProgrammer` / `architecture`) and a `primaryAnchor` giving it a
source citation of its own.

**Nine are copied word-for-word** from the report's "Three explanatory levels" table and are
flagged `verbatimFromReport: true`: `esp32`, `firmware`, `servo`, `pwm`, `i2c`, `api`,
`emulator`, `simulator`, `state`. The other 30 were written in the same register and
deliberately not in a more academic one.

The other 30: `ledc`, `gpio`, `oled`, `bitmap`, `progmem`, `animation`, `face`, `movement`,
`pose`, `timing`, `reentrancy`, `quantisation`, `calibration`, `boot`, `event-loop`,
`state-machine`, `idle`, `wifi`, `ap-mode`, `dns`, `mdns`, `http`, `route`, `json`,
`string-parsing`, `serial`, `cli`, `macro`, `weak-symbol`, `error-handling`.

The vocabulary is **controlled**: the validator rejects any `concepts[]` entry anywhere in
the file that is not a declared id, and checks the symbol↔concept inversion in both
directions, so a concept's `symbols[]` can never be partially stale.

**One concept has zero symbols and that is correct**: `emulator`. Nothing in the firmware
describes its own execution environment, so there is no honest anchor for it. It is reported
in `coverage.concepts.withoutSymbols` rather than force-fitted onto a symbol. This is the
same discipline as the `conceptual` curriculum flag, applied to the vocabulary.

---

## 4. Teaching notes — the sharp edges

17 notes: 2 `defect`, 14 `surprise`, 1 `design`. All nine the task called for are present,
plus eight more that were already documented in this repo. Every note carries at least two
source citations with their line text; a note of kind `defect` is *required by the validator*
to cite an issue id from `docs/issues.yaml`, because an undocumented "defect" in a teaching
artifact is how folklore starts.

| Id | Kind | The edge |
|---|---|---|
| TN-001 | defect | `epd_bitmap_stand` / `epd_bitmap_defualt` weak-undefined ⇒ blank faces (ISSUE-20260823-004) |
| TN-002 | surprise | `delayWithFace()` pumps HTTP/DNS/face — a re-entrancy point, not dead time |
| TN-003 | surprise | Subtrim applied **before** the 0–180 clamp |
| TN-004 | surprise | Face playback mode is global state set per call site |
| TN-005 | surprise | `enterIdle()` reachable only from `runStandPose(face == 1)` |
| TN-006 | surprise | `attach(pin, 732, 2929)` never yields 2929 µs — `ESP32Servo.h:98` clamps to 2500 |
| TN-007 | surprise | 10-bit LEDC ⇒ **89 of 181** commandable angles alias onto a neighbour |
| TN-008 | defect | Unescaped JSON in `/api/status` (ISSUE-20260823-021) |
| TN-009 | surprise | All routes registered `HTTP_ANY` |
| TN-010 | surprise | Continuous commands never self-clear; an unknown command is never cleared at all |
| TN-011 | surprise | `pressingCheck()` cancels a walk by running a full stand pose, which enters idle |
| TN-012 | surprise | The JSON API is parsed with `indexOf()`, not a parser |
| TN-013 | surprise | `setFace()` early-returns on an unchanged name, so the animation does not restart |
| TN-014 | surprise | A failed display init is the **only** hard stop in `setup()` |
| TN-015 | surprise | `setServoAngle()` silently ignores channels ≥ 8 |
| TN-016 | surprise | `/cmd` answers 200 OK before the movement has run |
| TN-017 | design | The face list is one declaration expanded three ways by the preprocessor |

TN-006 and TN-007 are the two notes whose decisive evidence lives in **ESP32Servo 3.0.9, not
in Sesame source**. Those carry a `libraryEvidence` object — `{library, version, file, line,
text}` — deliberately *not* shaped like a firmware citation, so the line checker does not try
to resolve it against a tree it is not in. This mirrors the `librarySource` exception
`hardware-map.json` already carries: the library lives under the gitignored `tools/`, so the
citable identity is library + version + path-within-library + line.

### The no-hardware-claims screen

Per docs/plan.md's standing constraint, no annotation may say a servo *did* anything. Every
description states what the code **commands**. The validator carries a regex screen for the
obvious violations (`the servo moved`, `observed at the pin`, `we measured on hardware`, …),
which is a backstop and not a substitute for review — the review pass caught several phrasings
the regex would not have, including "lifts one limb", "commands a full forward lean" and
"tucks all eight joints", all of which were rewritten into the joint/angle vectors the code
actually writes.

Three factual errors were also caught in that pass and corrected before publishing:
`updateFaceBitmap()` is *not* the only writer of the display (`updateWifiInfoScroll()` draws
frames directly at `:1115`); `runDeadPose` is not the only pose without a return to stand
(`runRestPose` is the other, and it is also the shorter of the two); and `loop()` makes six
service calls, not five.

---

## 5. Curriculum spine — and the `conceptual` gaps

The report's 19-module table is mapped onto symbols and concepts. `grounding` is Gate F in
machine-checkable form: **`factual` requires at least one backing symbol, and the validator
fails the build if a module claims `factual` with none.** `conceptual` requires a
`conceptualReason` explaining why it cannot be grounded, so a lesson author does not go
hunting for a symbol that does not exist.

**12 factual, 7 conceptual.**

### The seven modules that cannot be grounded in firmware source

| Module | Why not |
|---|---|
| **Inside the brain** (`click CPU/memory/GPIO`) | Firmware source names GPIO numbers and nothing else about the SoC. There is no symbol for CPU, memory or peripheral layout, and the MCU family per board comes from `firmware/README.md`, which `hardware-map.json` marks `mcuFamilyVerified: false`. Pin assignment may be taught as fact; the chip interior must be labelled conceptual. |
| **Build a leg pose** (`hip/leg relation`) | The firmware has no notion of a hip or a leg. It has eight indices and a name per index. Which index is a hip, which limb a pair belongs to, and even left versus right are semantic readings carried in `hardware/joint-map.json` with `verified: false` — and per the standing constraint they can **never** be settled. The pose vectors are factual; the anatomy used to describe them is not. |
| **Build a movement** (`frame editor`) | There is no frame editor and no movement data format — movements are hand-written C++ functions, which is exactly why they cannot be edited at runtime. Sesame Studio is a separate upstream tool under `firmware/upstream/software/sesame-studio/` and is out of this annotation set's scope. |
| **Real versus virtual** (`same SesameRobot contract`) | The `SesameRobot` contract is Sesame Lab's own abstraction; no pinned symbol corresponds to it. Additionally "real" here can only ever mean "real firmware under QEMU": Phase 3 and `RealSesameRobot` are permanently out of scope, and the module copy must say so. |
| **What an emulator really is** | Nothing in the firmware describes its own execution environment. The report names Renode, which docs/plan.md records as superseded by QEMU. Either way the subject is the emulator, not Sesame source. |
| **Inside Renode** | Same, plus the Renode track is closed (Phase 4 superseded; ISSUE-20260823-001 `wont_fix`). If built at all it must be rewritten against QEMU, and it will still have no backing firmware symbol. |
| **Build your own experiment** | A synthesis module with no single subject. It inherits whatever grounding the modules the learner draws on already have; it has none of its own. |

Three of the twelve `factual` modules carry a `groundingNote` marking a boundary that is real
but does not disqualify them:

- **How PWM asks a servo to move** — the 50 Hz frame, the pulse-range request and the 0–180
  command range are Sesame source; the angle-to-pulse arithmetic and the 10-bit truncation
  are ESP32Servo 3.0.9, cited by library rather than by a firmware line. **No pulse in this
  project has ever been observed on hardware.**
- **Two wires to a face** — pins, address, bus init and the draw call are Sesame source; the
  byte-level I²C transaction is inside `Adafruit_SSD1306`. A lesson that animates individual
  bus bytes is modelling the library, not this firmware.
- **Debug a robot** — every failure mode has a real source location (subtrim saturation, the
  display-init hard stop, the 400/404/405 responses, the empty-face fallback). The
  *injection mechanism* that triggers them on demand is a Sesame Lab feature and is not in
  firmware.

**This list is the deliverable for the lesson author.** Seven of nineteen modules cannot say
"this is how Sesame actually works" from firmware source, and two of those seven
(`what-an-emulator-is`, `inside-renode`) additionally need rewriting because their subject
matter changed when Renode was superseded.

---

## 6. Relationship to `hardware-map.json`

Nothing F4 owns is restated. `hardware-map.json` owns the **entities** — pins, per-movement
choreography, the route table, boot order, the face registry. This file owns the **reading
surface** — which span of source a learner is looking at, what it does, which concepts it
teaches, and where it is surprising.

Entities are referenced by key through `crossRefs`, and the validator resolves every one of
them against the live map: `movements` against `movements[].function`, `commands` against
`commands.vocabulary[].command`, `routes` against `network.http.routes[].path`, `bootSteps`
against `bootOrder[].order`, `faces` against `faces.faces[].name`, `serialCli` against
`commands.serialCli[].input`, and `robotParts` against `servos.order`. It also enforces the
reverse: **every** hardware-map movement function and **every** route must be referenced by
some annotation, so the map cannot grow an entity the explorer silently ignores.

Two fields are computed from the map rather than typed, so they cannot drift:
`robotParts` (joints a span commands directly, in firmware enum order) and
`robotPartsTransitive` (including joints reached through calls). `runWavePose` comes out as
`robotParts: [R1, L2, R4, L3]` — the same set the research report's worked example gives —
with `robotPartsTransitive` all eight, because it calls `runStandPose`.

---

## 7. What the explorer UI will need from this file

The report's four synchronized panes map onto the data as follows.

**Pane 1 — Real source.** `symbols[]` sorted by `file` then `startLine` is the outline.
`startLine`/`endLine` are the highlight range; `startLineText`/`endLineText` let the UI assert
it is highlighting what it thinks it is before rendering. `kind` drives the icon. The pinned
text itself is **not** in this file — the UI reads `firmware/upstream/<file>`, which is
gitignored, so **the web build needs a step that materialises or bundles the four annotated
files**. `meta.filesAnnotated[].sha256` is there so the UI can refuse to render against a
tree that does not match the annotations.

**Pane 2 — Architecture node.** `concepts[]` is the node vocabulary and
`symbols[].concepts` the edges. Each concept's three `levels` back the "go deeper" control the
report asks for; `primaryAnchor` gives every node a click-through to source. Note that
`concepts[].symbols` is dense (`face` 38, `timing` 33, `animation` 33), so the graph needs
weighting or filtering rather than drawing every edge.

**Pane 3 — Robot part.** `robotParts` / `robotPartsTransitive` answer "which line moved this
joint?" directly; both are already in firmware enum order, which is neither alphabetical nor
geometric and **must not be re-sorted**. Joint identity is `R1`…`L4` only — the UI must not
label a joint "hip" or "front-left", per `build-a-leg-pose` above.

**Pane 4 — Runtime event.** `crossRefs.commands`, `.routes`, `.bootSteps`, `.faces`,
`.serialCli` are the join keys onto a telemetry or replay stream. `crossRefs.calls` gives the
call graph for the "what ran next?" direction.

Also needed:

- **A distinct visual treatment for `teachingNotes` and for `commentary`.** These are the
  highest-value annotations, and `commentary` is explicitly a judgement rather than a fact —
  it must not render like a `description`. `libraryEvidence` must render differently again,
  because it points outside the pinned tree.
- **A `conceptual` badge** on any lesson whose module has `grounding: "conceptual"`, and a
  refusal to render a "this is how Sesame actually works" framing on those. That is Gate F at
  the UI layer, and the JSON already carries the flag and the reason.
- **An honest "not observed on hardware" affordance.** Per the standing constraint,
  `isPhysicallyObserved()` is permanently false. Angles are what the code *commands*; the UI
  should read that way everywhere, and TN-007 means it must not imply one-degree resolution.

---

## 8. Running it

```
node scripts/build-source-annotations.mjs            # regenerate
node scripts/build-source-annotations.mjs --check    # fail if stale
node scripts/validate-source-annotations.mjs         # schema + refs + line resolution
```

Wired as `pnpm build:source-annotations` and `pnpm validate:source-annotations`. Adding those
two script entries required no dependency change — `ajv` is already a root devDependency and
the lockfile is untouched.

The generator is deterministic: same tree plus same `--generated-at` gives byte-identical
output. `--check` compares everything except `meta.generatedAt`.

Both scripts degrade honestly on a clean clone where `firmware/upstream/` has not been
fetched: the validator warns and skips line resolution rather than passing silently, and
`--require-lines` turns that warning into a failure for CI.

**Not done, deliberately:** `docs/index.yaml` has no entry for this document. It sits outside
this task's file ownership and a concurrent agent is active; the orchestrator should add it.
