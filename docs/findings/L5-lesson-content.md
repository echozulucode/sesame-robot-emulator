---
task: "L5 — lesson content as data"
phase: 2
status: complete
date: 2026-08-25
owns: hardware/lessons.json, hardware/lessons.schema.json, scripts/build-lessons.mjs, scripts/validate-lessons.mjs
---

# L5 — the lessons, as data

| Artifact | What it is |
|---|---|
| `hardware/lessons.json` | 19 lessons · 74 steps · 74 checkable success conditions · 74 claims, every reference resolved |
| `hardware/lessons.schema.json` | draft 2020-12, `additionalProperties: false` throughout |
| `scripts/build-lessons.mjs` | the authoring pipeline: content in, derived JSON out, deterministic, `--check` |
| `scripts/validate-lessons.mjs` | six layers, wired as `pnpm validate:lessons` |

No UI. `apps/web/`, `packages/` and `scripts/capture-web-screenshots.mjs` were not touched. Two
script entries were added to `package.json` (`build:lessons`, `validate:lessons`); no dependency
change, lockfile untouched. `reproducibility.json`'s `lessonContentVersion` moved from `null` to
`1.0.0`, which is the field it was reserved for.

---

## 1. The nineteen modules

Order is **not** the research report's table order. It is reordered around Sesame's real
architecture, and around the report's own correction — **teach movement sequencing before inverse
kinematics**, because the firmware is itself sequence-oriented. Two consequences worth naming:

- `four-legs-cooperate` (real pose vectors, factual) moves **ahead of** `build-a-leg-pose`
  (hip/knee anatomy, conceptual and permanently so). IK then arrives in lesson 14 framed exactly as
  the report asks: *here is how Sesame works today; how could we improve it?* — and by then the
  learner can answer, because they have read the pose vectors and found that the firmware has no
  limb naming at all.
- `inside-the-brain` moves out of slot 2. It is conceptual, and putting an ungrounded module second
  teaches a twelve-year-old that the citations do not mean anything. The twelve factual modules run
  first; the seven conceptual ones close the curriculum.

| # | Lesson | Status | Grounding | Steps | Prerequisites |
|---:|---|---|---|---:|---|
| 1 | `meet-sesame` | **polished** | factual | 5 | — |
| 2 | `command-one-joint` | **polished** | factual | 6 | 1 |
| 3 | `how-pwm-asks` | **polished** | factual ⚠ | 6 | 2 |
| 4 | `four-legs-cooperate` | **polished** | factual | 7 | 2 |
| 5 | `sesames-face` | **polished** | factual | 6 | 1 |
| 6 | `read-the-firmware` | **polished** | factual | 6 | 4, 5 |
| 7 | `two-wires-to-a-face` | outline | factual ⚠ | 3 | 5 |
| 8 | `talk-over-serial` | outline | factual | 3 | 2, 6 |
| 9 | `send-an-http-command` | outline | factual | 4 | 6 |
| 10 | `read-json-state` | outline | factual | 3 | 9 |
| 11 | `sesame-on-a-network` | outline | factual | 3 | 9 |
| 12 | `debug-a-robot` | outline | factual ⚠ | 3 | 6, 5, 9 |
| 13 | `inside-the-brain` | outline | **conceptual** | 2 | 6, 3 |
| 14 | `build-a-leg-pose` | outline | **conceptual** | 3 | 4 |
| 15 | `build-a-movement` | outline | **conceptual** | 3 | 4 |
| 16 | `what-an-emulator-is` | outline | **conceptual** | 3 | 6, 3 |
| 17 | `real-versus-virtual` | outline | **conceptual** | 2 | 16 |
| 18 | `inside-qemu` *(supersedes `inside-renode`)* | outline | **conceptual** | 4 | 16 |
| 19 | `build-your-own-experiment` | outline | **conceptual** | 2 | 6, 12, 16 |

⚠ = `factual` but carrying L3's `groundingNote`, marking a real boundary that does not disqualify
the module. All three notes are copied verbatim from `source-annotations.json`; the validator fails
if they drift.

**12 factual, 7 conceptual — exactly L3's split.** Nothing was reclassified. Grounding is *copied*
from `source-annotations.json` `curriculum[]` at build time and asserted equal at validate time, so
a lesson structurally cannot promote itself.

### The six that are polished

1–6 above: `meet-sesame`, `command-one-joint`, `how-pwm-asks`, `four-legs-cooperate`,
`sesames-face`, `read-the-firmware`. They are the six because they are the first six *in the
reordered sequence*, all twelve of their steps' worth of prerequisites resolve inside the set, and
between them they cover the whole vertical slice the rest of the curriculum branches off:
joint identity → one commanded angle → the pulse that angle becomes → a sequence of angles →
the display → the loop that runs all of it. Every one of their 36 steps carries all three
explanatory levels, a manipulable, a stated cause-and-effect with the trace rungs it lands on, and
a success condition. The other 13 lessons are outlines: goal, ordered steps, grounding and every
reference are settled and machine-checked; only the `beginnerProgrammer`/`architecture` copy and the
full cause-and-effect text are unwritten. **An outline cannot smuggle in an uncited factual claim** —
the validator applies every rule except the polish ones to them.

---

## 2. Gate F, in machine-checkable form

Gate F is on `step.claim`. A claim has a `type` (`factual` | `conceptual`) and a `domain`
(`firmware` | `library` | `emulator` | `lab` | `none`). The rules the validator enforces:

| Claim | Required |
|---|---|
| `factual` + `firmware` | **≥ 1 `symbol` citation resolving in `source-annotations.json`** — and the cited `file`/`startLine`/`endLine`/`signature` must equal that symbol's. No waiver exists. |
| `factual` + `library` | ≥ 1 `library` citation whose version matches `reproducibility.json`, plus a `boundaryNote` |
| `factual` + `emulator` | ≥ 1 `document` citation to a file that exists, plus a `boundaryNote` **and** an `observability` value (`ran-in-qemu` / `computed-not-observed` / `inert-in-emulator` / `simulated`) |
| `factual` + `lab` | ≥ 1 citation, plus a `boundaryNote` |
| `conceptual` | a `conceptualReason`, `domain: "none"`, and no *"actually works"* framing |
| any claim | *"actually / really works"* framing anywhere in the text requires a resolving firmware `symbolRef`, whatever the type says |
| any conceptual lesson | ≥ 1 step whose claim is conceptual **and** carries `groundingDisclosure` — the module must say out loud where its boundary is |

**44 of 74 claims are firmware-factual, and 44 of 44 carry a resolving `symbolRef`.** The other 30
are 5 library, 10 emulator, 4 lab and 11 conceptual — each with the citation kind its domain
requires. The three non-firmware factual domains exist because the alternative was worse: calling
"QEMU's LEDC produces no waveform" *conceptual* would be a lie about a fact established by reading
registers back over a gdbstub, and calling it *firmware-factual* would be a lie about where it
lives. The domain is how a lesson says which world its fact belongs to.

Everything derived is **recomputed** by the validator rather than trusted: the PWM/quantisation
numbers from ESP32Servo 3.0.9's own arithmetic (and cross-checked against `hardware-map.json`), the
pose vectors from the choreography, the direct-joint lists from `source-annotations.json`, and the
entire `coverage` block.

Eight tamper tests were run, each producing the intended failure:

| Tamper | Caught by |
|---|---|
| flip `inside-the-brain` to `factual` | Gate F grounding equality + two coverage mismatches |
| strip the `symbolRef` off a firmware claim | *"asserts a FIRMWARE fact with no symbolRef"* + coverage |
| slide one cited `startLine` by +1 | citation/annotation mismatch |
| change one angle in a pose vector | recomputed against hardware-map choreography, 3 sites |
| insert mascot narration + fake currency | two independent prose screens |
| put *"actually works"* in a conceptual claim | two Gate F rules |
| invent a `clicked-next` check type | undeclared check type |
| write `HIP1` into `robotParts` | schema `jointName` enum |

---

## 3. The honesty modules

### `what-an-emulator-is` — rewritten, and the best material in the set

Taught as the **three-way** distinction this project actually lives, not the report's two-way one:
a behavioural simulator (a model of what Sesame does), a firmware emulator (a pretend computer
running Sesame's real compiled program), and physical hardware (which this project will never
have). Its three steps are: run one command on both backends and compare what each can *report*;
watch real firmware boot under QEMU and see how strong that claim genuinely is; then name three
things neither backend can tell you — **no waveform, no radio, and no idea whether a joint is a
hip** — which are three *different kinds* of gap, and saying which is which is the skill.

### `inside-renode` → **rewritten as `inside-qemu`, not retired**

The subject — bus, memory, peripheral, time — is still worth teaching, and unlike when the report
was written this project has a working QEMU backend to teach it on. Retiring the module would have
thrown away the pedagogy along with the tool. So: new id `inside-qemu`, `supersedes: "inside-renode"`,
`curriculumRef: "inside-renode"` so its grounding still resolves against L3's curriculum entry, and
a closing step that tells the learner plainly that the original plan used Renode, that it was
superseded, and why. Its middle step is the most useful disappointment in the curriculum: QEMU's
LEDC device *is* mapped and decoded and computes the correct duty ratio, and it has no timer, no
clock, no GPIO connection and no output. "The registers hold plausible values" is not "a pulse was
produced."

### The no-hardware constraint, everywhere

No lesson says a servo moved. Angles are what the code **commands**; `joint.target` is a target and
the lessons say so; `pwm.output` is arithmetic performed here and every lesson that touches it says
no pin has emitted it. `inside-qemu` states that the emulated machine is the **legacy ESP32 Distro
V1** board, not the Lolin S2 Mini the source builds for. `sesame-on-a-network` closes by showing the
learner the seven boot steps that had to be **elided** to make the image run at all, and stepping
the emulated boot to find the gaps. The validator carries a prose screen for the obvious violations;
three phrasings it would *not* have caught (*"after the joints stop"*, *"wave moves four joints"*,
*"all eight change"*) were found and rewritten by review, which is the same result L3 reported.

---

## 4. The sharp edges became the lessons

All **17** of L3's teaching notes are used, most of them as the centre of a step rather than a
footnote:

| Note | The edge | Lesson(s) |
|---|---|---|
| TN-001 | `stand` renders nothing: weak-undefined bitmap, and the fallback is *also* empty | `sesames-face` (the debugging step), `debug-a-robot` |
| TN-002 | `delayWithFace()` pumps HTTP/DNS/face — concurrency without threads | `command-one-joint`, `read-the-firmware` |
| TN-003 | subtrim added **before** the 0–180 clamp | `command-one-joint`, `talk-over-serial`, `debug-a-robot` |
| TN-004 | face playback mode is global, set per call site | `sesames-face` |
| TN-005 | `enterIdle()` reachable only from `runStandPose(face == 1)` | `four-legs-cooperate` |
| TN-006 | `attach(pin, 732, 2929)` never yields 2929 µs | `how-pwm-asks` |
| TN-007 | **89 of 181** commandable angles alias | `command-one-joint`, `how-pwm-asks` |
| TN-008 | `/api/status` interpolates unescaped | `read-json-state` |
| TN-009 | every route registered `HTTP_ANY` | `send-an-http-command` |
| TN-010 | commands that never self-clear | `four-legs-cooperate`, `read-the-firmware` |
| TN-011 | cancelling a walk runs a whole stand pose, and enters idle | `four-legs-cooperate` |
| TN-012 | the JSON API parsed with `indexOf()` | `send-an-http-command` |
| TN-013 | `setFace()` early-returns, so the animation does not restart | `sesames-face` |
| TN-014 | a failed display init is the only hard stop | `read-the-firmware`, `two-wires-to-a-face`, `debug-a-robot` |
| TN-015 | `setServoAngle()` silently ignores channels ≥ 8 | `command-one-joint` |
| TN-016 | `/cmd` answers 200 OK before the movement has run | `send-an-http-command` |
| TN-017 | one face declaration expanded three ways by the preprocessor | `sesames-face` |

The two lessons that write themselves are exactly the ones the task predicted. TN-007 is a
`quantisation-collision` success condition: the learner steps 99° → 100°, the requested pulse
changes, the tick count does not, and the check is that the two produce the same value. TN-008 is a
`debug` step where a single quotation mark in a legal command word makes `/api/status` stop being
JSON — and the follow-up step finds `jsonEscape()` sitting a hundred lines above the route that
should have called it.

---

## 5. Anti-pattern checks applied

The report's list, each one turned into something enforceable:

| Report's anti-pattern | How it is prevented |
|---|---|
| mascot narration | prose screen over every string in every lesson (`hi there`, `sesame says`, `buddy`, `great job`, `woohoo`, …) |
| fake currency, points | prose screen (`coins`, `gems`, `xp`, `streak`, `leaderboard`, …) |
| confetti for trivial clicks | prose screen (`confetti`, `fireworks`, `celebration`) |
| long forced walkthroughs | every step must carry a `manipulate` **and** a `success`; `beginner12` copy is capped at 400 characters and the schema enforces it |
| walls of text | depth lives in the optional `goDeeper`, and a lesson where *every* step has one fails |
| timer-gated unlocks | **structurally impossible**: there is no time-based or acknowledgement-based check type in the vocabulary, and a prose screen catches anyone describing one anyway |
| "click next to continue" | same — there is no such check type, and every lesson after the first must name a prerequisite that actually has success conditions |
| debugging framed as failure | every `debug` step **must** carry `success.failureIsNormal`; the validator found two that did not and they were written |
| oversized cartoon buttons | not expressible here — it is a runner concern, and section 6 says so |

Structural coverage as shipped: 74/74 steps have a manipulable and a success condition; 36/36
polished steps have all three explanatory levels and a stated cause-and-effect; 5 steps carry
optional `goDeeper`; 13 of the 74 steps are `debug`, all with `failureIsNormal`.

---

## 6. What the runner UI will need

**The contract is `vocabularies`.** It is in the data on purpose, because the runner is a consumer
this task could not see. It declares: 3 explanation levels, 7 step kinds, 22 control kinds (21 used), 5 claim
domains, 4 observability values, 6 citation kinds, the 8 trace layers, 4 provenance badges,
**34 check types with their required parameters**, 7 declared faults, and the recomputed PWM model.
Every one of the 34 check types is used by at least one lesson, and every control kind named by a
step is declared.

Specifically, a runner needs to:

1. **Implement 34 success checks.** They are observable robot/telemetry states — a commanded angle,
   a pose vector, a tick count, an absent event, a face fallback, an HTTP status, a boot halt — not
   "clicked next". `check.requires` names each one's parameters. Several are *absences*
   (`telemetry-absent`, `trace-field-absent`): the UI must be able to assert that a row never
   arrived, which is a different affordance from asserting one did.
2. **Bind 21 control kinds.** Several already exist from V3/V4/V8 (`joint-slider`, `pose-runner`,
   `face-picker`, `trace-inspector`, `graph-node-picker`, `backend-switch`, `source-selector`).
   Genuinely new: `pwm-inspector`, `sequence-editor`, `pixel-editor`, `fault-injector`,
   `boot-stepper`, `channel-number`, `subtrim-control`, `robot-explode`.
3. **Render three explanatory levels with a level switch**, defaulting to `beginner12`, and render
   `goDeeper` as a *collapsed* affordance. If it is expanded by default the lesson becomes the wall
   of text the report warns about.
4. **Show a `conceptual` badge** on the seven conceptual lessons and refuse the "this is how Sesame
   actually works" framing there — `grounding` and `conceptualReason` are both in the data. Show a
   different treatment again for `claim.boundaryNote`, which is where a *factual* lesson admits it
   is describing a library, an emulator or the lab rather than Sesame.
5. **Render provenance honestly.** `claim.observability` and the trace layer badges are the vehicle;
   `isPhysicallyObserved()` is permanently false and several success conditions
   (`trace-badge-identified`, `trace-field-absent`) exist precisely to make the learner read them.
6. **Build a fault injector for 7 declared faults** — and label the three that are *not* injected,
   because they are the shipped firmware's own behaviour. `injectorIsLabFeature` carries that flag.
7. **Materialise the four annotated firmware files.** Same requirement L3 flagged: the pinned tree
   is gitignored, and every symbol citation here carries `file`/`startLine`/`endLine` expecting the
   explorer to be able to show them.
8. **Carry lesson work into Lab.** `labHandoff` names what each lesson leaves behind. The sequence
   editor, the pixel editor, the API console and the fault injector are all authored as Lab tools
   that Learn borrows, not the other way round.

---

## 7. Running it

```
node scripts/build-lessons.mjs                       # regenerate
node scripts/build-lessons.mjs --check               # fail if stale
node scripts/validate-lessons.mjs                    # schema + refs + Gate F + anti-patterns
```

Wired as `pnpm build:lessons` and `pnpm validate:lessons`. Deterministic: the same inputs and the
same `--generated-at` give byte-identical output, verified. The validator degrades honestly —
`packages/sesame-model/src/joints.ts` and `apps/web/src/state/trace-store.ts` are cross-checked when
present and *warned about* when absent, rather than silently skipped.

**Not done, deliberately:** `docs/index.yaml` has no entry for this document, and `docs/plan.md`'s
Phase 2 checklist item *"First lessons, ordered around Sesame's real architecture"* is not ticked.
Both files sit outside this task's ownership with a concurrent agent active; the orchestrator should
do it.
