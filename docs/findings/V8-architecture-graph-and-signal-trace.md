---
task: "V8 — interactive architecture graph + \"See the Signal\" causal trace"
phase: 2
status: complete
date: 2026-08-25
owns: apps/web, scripts/capture-web-screenshots.mjs
---

# V8 — the architecture graph and "See the Signal"

Two features, one deliverable, because the research report's core interaction is
the cross-highlighting *between* them. Both ship in `apps/web`; both run
identically on the simulator and on real firmware under QEMU, and say something
different on each.

Evidence: `docs/findings/assets/v3-v4-browser-capture.json` →
`phases.architectureAndTrace` and `phases.qemuTrace`. 15 real-browser captures,
809 workspace tests, 0 problems.

---

## 1. The graph is projected, not drawn

`apps/web/scripts/build-architecture-graph.mjs` reads `hardware/hardware-map.json`
(and `hardware/joint-map.json` for joint kinds and spatial names) and emits
`apps/web/src/generated/architecture-graph.ts`: **63 nodes, 65 edges**. It runs
as a `--check` in `pnpm --filter @sesame-lab/web test`, so the graph cannot drift
from the map. `hardware/` is read-only to this task.

Every node carries `derivedFrom` (the path into the JSON), `sourceRef` (the
firmware `file:line` the JSON itself cites), `derivation`, and `unresolved`. All
`sourceRef`s resolve against upstream `4017305`, asserted in the browser.

| Part of the graph | Count | Derived from |
|---|---|---|
| Board / MCU | 1 | `boards[]` (4 profiles, `s2-mini` active) |
| Movement functions | 21 | `movements[]` (395 steps, 223 servo writes) |
| HTTP routes | 10 | `network.http.routes[]` |
| Servo chain | 5 | `servos.servoConfig.{setServoAngle, attachPulseClamp, pulseQuantisation, …}` |
| Joints | 8 | `servos.joints[]` + `joint-map.json` |
| OLED chain | 8 | `display.{renderPath, i2cAddress, busClockNote, …}`, `faces.*`, `boards[].i2c` |
| Serial | 2 | `network.serial`, `commands.serialCli` (26 forms) |
| Cross-links | 3 | `setServoAngle.steps[4]` (`delayWithFace()` also pumps face/HTTP/DNS), `commands.setBy` |

Collapsed, the visible set is **exactly** the report's nine-node tree. Edges are
stored once on the real chain and *lifted* to the nearest visible ancestor at
draw time, so `Movement → 8 Servos` and
`setServoAngle → ESP32Servo → LEDC → GPIO → MG90S → R1…L4` come from one edge
list. There is no second diagram, which is what lets the trace light the active
path on this same graph.

### Hand-authored: 5 claims, enumerated and marked

The generator fails if the list grows past a budget, the app renders them with a
dashed border/edge, and a test asserts the list verbatim:

- `node movement`, `node face`, `node network`, `node serial` — the four
  top-level *groupings*. `hardware-map.json` is flat; grouping it is editorial.
  Each one names the `bootOrder[]` subsystems it covers and the generator asserts
  those subsystem strings exist, so the members are data even though the grouping
  is not.
- `edge servo.mg90s->joint.*` — **a GPIO pin driving a particular horn is a wire
  nobody in this repository has traced.** Counted once, drawn eight times, dashed.

### One node marked unresolved

`MG90S` renders in the warning colour with a `?` and quotes
`unresolved[servo-model].reason` verbatim: the BOM names the part and no
rate/torque/travel data exists anywhere in the repo. Permanent, not pending.

### The edge the data does not support

The report's example trace row is `pwm.output channel=6 pulse=…`. **There is no
channel-to-servo mapping in this repository.** Q3 measured *which eight* LEDC
channels are programmed (`HSCH0–3`, `LSCH0–3`, read back over the gdbstub) and
explained the allocation rule, but `hardware-map.json` records the eight as a
**set**. So `PWM_FACTS.channelPerJointKnown` is `false`, the LEDC node states the
set and says the per-joint assignment is unestablished, and the trace prints no
channel number at all — asserted by two unit tests and twice in the browser.

---

## 2. "See the Signal": per-layer provenance

Eight rungs, in causal order, each with a `Provenance`, a `TelemetryOrigin` and a
**witness** — one clause naming who says so. The badge is chosen by
`traceBadge()`, which branches on `isPhysicallyObserved()` first and never on
`provenance === 'observed'`.

| Layer | Simulator | QEMU | Why |
|---|---|---|---|
| `ui.command` | OBSERVED IN THIS APP | same | A real DOM event. No origin claimed: none of the five kinds describes a browser. |
| `http.request` | INFERRED | OBSERVED IN THIS APP | The model sent nothing. Under QEMU the page really POSTs `/api/command` to the lab host — the firmware's own route, served on the host, because Wi-Fi is elided from the image. |
| `firmware.command` | INFERRED | INFERRED | `commands.vocabulary`'s `wave → runWavePose` mapping. No backend emits "the firmware received a command". |
| `movement.enter` | SIMULATED | **OBSERVED FROM EMULATOR** | Starts inferred, then is replaced when the firmware's own entry banner (`"WAVE"`, `movement-sequences.h:92`) arrives on the log channel. Real on both, differently. |
| `servo.target` | SIMULATED | **OBSERVED FROM EMULATOR** | The strongest claim this project can make: real instructions, emulated silicon. |
| `pwm.output` | **INFERRED** | **INFERRED** | See below. |
| `joint.target` | INFERRED | INFERRED | Servo-channel↔joint identity is authoritative; the spatial name is not, and is now permanently unverifiable. There is no position feedback: this is a target, never a position. |
| `visual.joint` | INFERRED | INFERRED | Recovered from `Object3D.quaternion` in this browser. What was drawn, not where a horn is. |

`isPhysicallyObserved()` is false on **every row of every backend**, asserted in
unit tests across four origin shapes and twice in the browser. The
`OBSERVED ON HARDWARE` branch exists in `traceBadge()` and is unreachable.

### `pwm.output`, the row this feature exists for

```text
pwm.output   R1 87 ticks · 1699.22 µs            [INFERRED FOR EXPLANATION]
GPIO 15 (distro-v1), 50 Hz, 10-bit: map(100, 0, 180, 732, 2500) = 1714 µs
  → 87 ticks → 1699.21875 µs. Indistinguishable from 99° at the pin.
WHO SAYS SO  COMPUTED HERE, never observed. QEMU's LEDC model stores the duty
and produces no pulse, no edge and no waveform (Q3 §2–§3, register file read
back over the gdbstub), and there is no physical robot to probe — so no pin has
ever emitted this. The number is real arithmetic: ESP32Servo 3.0.9's own map()
and usToTicks(), including the clamp that turns servos[i].attach(servoPins[i],
732, 2929) into a 2500 µs maximum. Only 92 of 181 commandable angles are
distinguishable at the pin. No channel number is shown because nothing in this
repository records which of HSCH0/…/LSCH3 carries which servo.
```

The figure comes from `quantiseCommandedAngle()` in `@sesame-lab/sesame-model`,
so it is exact and the aliasing is visible (`R4=0` → 37 ticks → 722.66 µs, below
the 732 µs the firmware asked for). The GPIO number follows the **origin's**
board, not the map's active board — `distro-v1` under QEMU, `s2-mini` on the
simulator — so an ESP32 run never prints S2-Mini pins.

### Correlation is never dressed up as causation

`SimBackend` threads the minted `traceId` into `SimulatedSesameRobot`, so every
adopted row is `match: 'trace-id'` and the panel says **"Causal."**

`QemuBackend` takes the id and drops it: the `@SESAME` wire has an `x=` tag but
it is device→host, and the *firmware* has no trace-id concept — the command
channel into the guest is `rn wv` in a 32-byte CLI buffer. Rows are adopted by
arrival window instead, every one labelled `time-window`, and the panel says
**"Correlated, not causal. 21 events were matched to `wave-0001` by arrival
time."** An event carrying somebody else's id is refused outright.

---

## 3. Cross-linking

One `SelectionState` (`{ origin, joint, nodeId }`) in `App.tsx`; the 3D scene,
the graph, the trace and the joint inspector all read and write it. The previous
`selected: JointName | null` is now derived. Selecting a node the graph cannot
currently show **additively** expands its ancestors — never collapses something
the learner opened.

Asserted in the browser, through the **scene graph**, because a React `selected`
prop can be correct while the mesh stays unlit:

- click `joint.R4` in the graph (DOM click) → `MeshStandardMaterial.emissiveIntensity`
  on R4's meshes only: `litJoints: ["R4"]`;
- select `L3` as the 3D view would → graph `selectedNodeId: "joint.L3"`, and the
  DOM's highlighted trace rows are exactly
  `servo.target / pwm.output / joint.target / visual.joint`, all `L3`;
- collapse `Servos`, re-select `L3` → the graph auto-expands to reveal it.

The reader that proves this had a bug worth recording: attributing meshes to
*every* joint ancestor reported R2 as lit whenever R4 was, because the rig is
parented. It now attributes each mesh to its **nearest** joint ancestor, so the
assertion cannot pass on a highlight that never reached the clicked joint.

---

## 4. Automated verification

`scripts/capture-web-screenshots.mjs` gains **phase 7** (simulator) and trace
assertions inside **phase 6** (QEMU). Full run: 15 captures, 0 problems.

- collapsed graph is exactly the report's 9 nodes and 8 edges; upstream commit
  matches; 5 hand-authored claims; `servo.mg90s` marked unresolved;
- a **DOM click** on `[data-expand="servos"]` reveals the 5-node chain and all
  8 joints, in the layout *and* in the DOM;
- a **DOM click** on `[data-command="wave"]` produces rows whose `data-rank` is
  monotonic in the rendered DOM, covering all eight layers, with the exact
  provenance and badge string per layer from the table above;
- 0 rows claim physical observation; `pwm.output` prints ticks and µs and no
  channel; servo rows follow firmware enum order (`R4` before `R3`);
- QEMU leg: `OBSERVED FROM EMULATOR` + `time-window`, `pwm.output` still
  inferred, and the "matched by arrival time" caveat asserted in rendered text;
- **ISSUE-20260823-023 re-asserted** with three new panes of React mounted:
  ground plane, robot root, orbit target and camera all drift **0.000000 mm**
  across a `rest → wave` sweep in which the foot contact moved 37.535 mm.

Three harness defects were fixed while doing this, all real and all latent
before this task made the page heavy enough to expose them:

1. `waitSceneCaughtUp()` did not wait for the **robot** to stop — clearing the
   wave loop leaves an in-flight movement writing for up to 3.7 s more, so a
   scene-vs-store comparison could fail on a race. Now `waitQuiescent()`.
2. `ready` (the rig exists) is set from a `useEffect`, which can fire before the
   first `useFrame` — and the foot-contact height is computed *in* `useFrame`.
   The rest-pose sample could therefore be `null`, drop out of the sample set,
   and make phase 1's own vacuity guard fail on a startup race. The harness now
   waits for the first foot-contact value before sampling.
3. Phase 7's first world-frame check was itself vacuous: a wave does not move
   the *minimum* foot height at all, so any number of samples would have agreed.
   It now sweeps `rest → stand`, which is the 37.5 mm transition the original
   bug was found in.

Three consecutive green runs after the fixes (one full, two `--skip-qemu`).

33 new unit tests (`architecture.test.ts`, `trace.test.ts`) re-read
`hardware-map.json` independently of the generator, so a generator bug that
produced a plausible graph still fails.

---

## 5. One honesty fix outside the two features

`SimBackend` claimed in its own doc comment to emit `origin.kind: 'host-model'`
per event and did not — the model stamps no origin, so the app reported
`unknown` ("nobody said") for every simulated event. The backend now stamps
`{ kind: 'host-model', engine: '@sesame-lab/sesame-sim', elided: [silicon,
pwm-waveform, servo-load, wifi] }` as it forwards, which is the correct layer:
`origin` is explicitly not a wire tag, it is set by whoever owns the transport.
`isPhysicallyObserved()` is unaffected — still false.

---

## 6. What the source-explorer task needs from here

Everything it needs is already exported from
`apps/web/src/generated/architecture-graph.ts`:

- **`ArchNode.sourceRef`** — `{ file, line }` relative to the upstream repo root,
  on **all 63 nodes**, none with a placeholder line, citing exactly two files
  (`firmware/sesame-firmware-main.ino`, `firmware/movement-sequences.h`), plus
  `UPSTREAM_COMMIT` (`4017305…`) to resolve them against.
- **`COMMAND_TRACE_FACTS[].movementSourceRange`** — `{ file, from, to }` per
  movement function, so "show me `runWavePose`" is a line range, not a search.
- **`TraceRow.sourceRef`** — every trace row already carries one, so
  "which line moved this leg?" is a field lookup.
- **`ArchNode.joints`** and **`ArchNode.traceLayers`** — the robot-part and
  runtime-event halves of the report's four-way pane sync
  (`source ↔ architecture node ↔ robot part ↔ runtime event`).
- **`selectNode(nodeId, 'graph')`** in `apps/web/src/state/selection.ts` is the
  single entry point; a source pane should call it rather than keep its own
  selection. `SelectionOrigin` needs one new member (`'source'`) and nothing else.

### The join to L3's annotations already works — measured

L3 (`hardware/source-annotations.json`, committed while this task was running)
gives 90 symbols with `file` + `startLine` + `endLine`. Checked after that commit
landed: **all 63 architecture nodes' `sourceRef` fall inside an annotated
symbol**, zero misses. So `node → symbol` is line containment and needs no new
key, in either direction:

```text
ArchNode.sourceRef {file, line}   ⟶  the symbol whose [startLine, endLine] contains it
symbol.crossRefs.hardwareMap[]    ⟶  ArchNode.derivedFrom  (same document, same paths)
```

The second route is the weaker of the two: L3 spells route paths by key
(`network.http.routes[/].bodySource`) and this generator spells them by index
(`network.http.routes[5]`). Prefer line containment; treat `derivedFrom` as a
hint. Neither side should normalise the other's spelling silently — if the two
disagree about which JSON path a node came from, that is a fact worth surfacing,
not smoothing.

What it must **not** assume: that a `sourceRef` line is a symbol *definition* —
some point at a call site or a registration line, because that is what
`hardware-map.json` cites. `sourceRange` is the field that means "the whole
function", and only movements have one today.

A second thing it must not assume: that the two cited files are the only ones a
learner will want. `faces.bitmapDataLocation` points at
`firmware/face-bitmaps.h` and `network.http.routes[0].bodySource` at
`firmware/captive-portal.h`, both of which this graph names in prose but does
not cite as a `sourceRef`, because `hardware-map.json` records them as
locations rather than as provenance citations.
