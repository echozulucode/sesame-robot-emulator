# V3 + V4 — the browser robot and the virtual OLED

**Tasks:** Phase 1 · V3, V4 · `docs/plans/phase-1-virtual-mvp.md` §3
**Agent:** `browser-robot`
**Date:** 2026-08-23
**Depends on:** V2 (`assets/sesame.glb`), V1 (`@sesame-lab/sesame-sim`), R6/R7 (the bridge), Q1 (QEMU)
**Deliverable:** `apps/web/` — React 19 + TypeScript + Vite 7 + React Three Fiber 9 + three 0.185

**Verify:** `pnpm capture:web` · **Run:** `pnpm dev:web` · **Demo over the bridge:** `pnpm demo:web`

> **Still not physically verified.** No physical Sesame exists for this project.
> Every joint in this app shows `measuredDeg = null` and says why; every event
> carries the provenance its producer gave it, and nothing in the UI upgrades
> one. The only screen in this document whose telemetry is `observed` is the one
> fed by firmware genuinely executing under QEMU — and even there, "observed"
> means *bytes crossed a UART*, not *a robot moved*.

---

## 1. Result in one paragraph

`apps/web` loads `assets/sesame.glb`, drives its eight named joint nodes from a
`SesameTelemetry` stream, and renders a 128×64 SSD1306 framebuffer both as an 8×
inspectable canvas and as a `CanvasTexture` on the `oled_screen` quad. Two
backends are switchable at runtime and no third exists: `SimulatedSesameRobot`
in-process, and the Phase-0 bridge over its WebSocket. Both were driven
headlessly in Edge and asserted on **through the three.js scene graph**, not
through React state. The stand pose was verified *in the browser* against V2's
own numbers: every joint node's quaternion matches the asset's reference pose to
**0.000°**, and the ground plane recomputed in-browser from the posed foot
vertices is **−68.650045 mm** against V2's recorded **−68.650046 mm** — a
residual of **8.86 × 10⁻⁷ mm**. The bridge path is not a claim: real Sesame
firmware executing under Espressif QEMU pushed `@SESAME servo` lines through the
**unmodified** bridge into this scene, all eight joints, provenance `observed`
([screenshot](assets/v3-browser-qemu-observed.png)). `debug-viewer/` is
superseded but **not deleted**, for a reason given in §9.

---

## 2. Architecture

```text
                    ┌──────────────────────────────┐
  in-process ──────▶│ SimBackend                   │  provenance: simulated
  @sesame-lab/      │  SimulatedSesameRobot        │  canCommand: true
  sesame-sim        │  timeMode: 'realtime'        │
                    └──────────────┬───────────────┘
                                   │  SesameTelemetry
  QEMU / Renode /   ┌──────────────┴───────────────┐
  a real board  ───▶│ BridgeBackend                │  provenance: per-event
  → UART → bridge   │  ws://…/telemetry            │  canCommand: false
                    └──────────────┬───────────────┘
                                   ▼
                        ┌──────────────────────┐
                        │ TelemetryStore       │  one reduction, provenance kept
                        └──┬────────────────┬──┘
       useFrame, 0 React   │                │  useStoreTick, ~8 Hz
                           ▼                ▼
                  Object3D.quaternion   JointInspector · OledPanel ·
                  CanvasTexture         Controls · AssetPanel
```

| File | What it is |
|---|---|
| `src/three/rig.ts` | The **only** place that knows how to move the model — and it knows almost nothing, because V2 put the rules in the file. Reads `rotationAxis`, `signPerCommandedDeg`, `firmwareIndex`, parenting and provenance out of `object.userData` at runtime. |
| `src/three/RobotScene.tsx` | R3F canvas, lights, orbit camera, pose-dependent ground grid, click-to-select, the OLED texture. Kinematics only. |
| `src/state/telemetry-store.ts` | The event reduction. Refuses to fill `measuredDeg`, refuses to upgrade provenance, refuses to invent a first `commandedDeg`. |
| `src/backends/` | `types.ts` (the seam), `sim-backend.ts`, `bridge-backend.ts`. |
| `src/oled/framebuffer.ts` | `drawBitmap` → GDDRAM → base64 → decode → canvas. §5. |
| `src/generated/face-bitmaps.ts` | GENERATED from `firmware/face-bitmaps.h`. §5.1. |
| `src/debug-hook.ts` | `window.__sesame` — what the headless harness drives and reads. |
| `src/ui/` | Controls, JointInspector, OledPanel, AssetPanel, ProvenanceTag. |

~4 100 lines of TypeScript excluding the generated bitmap module. **52 tests**
in four files, plus a drift check on the generated module. Bundle: 1 334 kB
(352 kB gzipped) plus the 1 283 kB GLB.

### The GLB is not copied

A Vite plugin serves `assets/sesame.glb` from the repository root in dev and
`emitFile`s it into `dist/` at build. There is no second copy of a deterministic,
hash-recorded 1.28 MB artefact in git, and no way for the two to drift.

### Nothing is hardcoded that the data can supply

- Joint identity, axes, signs, pivots, parenting: `assets/sesame.glb` `extras`.
- Command buttons: `COMMAND_VOCABULARY` from `@sesame-lab/sesame-protocol`,
  which `catalog-drift.test.ts` re-derives from `hardware/hardware-map.json`.
- Face list and frame counts: `FACE_CATALOG`, same provenance.
- Pixel data: `firmware/face-bitmaps.h`, with the SHA-256 recorded.
- Ground plane: recomputed per pose from the posed foot vertices.

`buildRig()` throws rather than rendering if a joint node is missing, if
`firmwareIndex` disagrees with `@sesame-lab/sesame-model`, if an axis is not a
unit vector, if a sign is not ±1, or if `neutralCommandedDeg` is not 90. A
plausible-looking robot that does not match the asset is the worst outcome
available, so it is made impossible rather than unlikely.

---

## 3. The two backends

|  | `SimBackend` | `BridgeBackend` |
|---|---|---|
| Source | `SimulatedSesameRobot`, in this tab | `ws://host:port/telemetry` |
| Default | **yes** | no |
| Provenance | always `simulated` | whatever the event says |
| Commands | all 20, plus faces and per-joint sliders | **none** |
| `simulatedDeg` | from the model's 600 °/s datasheet slew | `null` |
| Time | `timeMode: 'realtime'` — a wave takes the robot's own 3.68 s | the wire's own timing |

**The bridge backend sends nothing, deliberately.** `@SESAME` v1 defines no
host → device messages and R7's hub discards client messages on purpose ("this
port must not become an accidental control API"). The UI says that in a red box
rather than greying buttons out mysteriously.

**Envelope origin is respected.** Only `origin: "uart"` envelopes reach the
telemetry stream. The bridge's own lifecycle lines — which the bridge correctly
tags `observed`, because the bridge really did connect — are surfaced as
connection status. R6 put `origin` in the envelope precisely so a fact about the
plumbing cannot be counted as a fact about the robot, and the harness asserts
that the replay phase reports **zero** `observed` robot events.

### The payoff, demonstrated

`emulator/bridge` was not modified. `--viewer-dir` has existed since R7, so:

```powershell
node emulator/bridge/dist/cli.js --uart-port 3456 --serve-viewer --viewer-dir apps/web/dist
```

serves this app from the same HTTP server the WebSocket upgrades on. Phase 5 of
the verification does exactly that with Espressif QEMU on the other end of
`--uart-port`, and the browser robot moves under real firmware. Two lines of
harness code; zero lines of bridge, protocol, sim or app code.

---

## 4. Provenance, and the four numbers

### Provenance is displayed at three scales

1. **A banner**: "this scene is being driven by **SIMULATED / OBSERVED /
   INFERRED**", with the protocol's own §7.1 wording, plus live counts per
   provenance.
2. **Per joint**: the tag on the event that last set that joint's
   `commandedDeg`, in the table and in the detail panel.
3. **Per OLED frame**: separately for the *pixels* and for the *trigger*. §5.

### `measuredDeg` is `null`, always, and says so

The inspector shows a `measured` column on every row, permanently reading
`null`, with a boxed note underneath:

> `HAS_JOINT_POSITION_FEEDBACK = false`. The stock Sesame drives eight MG90S
> servos over one-way PWM: no encoder, no potentiometer tap, no current sense,
> and no firmware path that could report a real angle. This column is not "not
> yet received" — it is *unknowable on this hardware*, and it is never filled in
> from `commandedDeg`.

`JointView.measuredDeg` is typed `null`, not `number | null`, so no code in the
app can assign one by accident.

A fourth distinction the UI makes and most would not: **`commandedDeg` starts
`null`, not 90.** `setup()` attaches the servos and deliberately does not move
them, so where a horn sits at power-on is genuinely unknown; the rig stays at the
GLB's rest transform and the table says `never`.

There is also a `simulatedDeg` toggle that animates the scene from the model's
slew estimate instead of the commanded angle — disabled on the bridge backend,
because there is no model behind a wire.

---

## 5. V4 — the OLED

### 5.1 Where the pixels come from

`hardware/hardware-map.json` records `bitmapDataNote: "Pixel data intentionally
not extracted"`. That is right for a machine-readable *description* of the
firmware, but V4 has to light real pixels and the plan forbids a placeholder. So
`apps/web/scripts/build-face-bitmaps.mjs` projects `firmware/face-bitmaps.h`
into a committed TypeScript module — 46 bitmaps, 45 reachable frames — storing
each frame **in the firmware's own authored layout**, unconverted.

The generator reproduces `countFrames()` exactly: it walks
`epd_bitmap_x, _1 … _5` and stops at the first slot with no definition, because
an undefined weak symbol is a null pointer at link time. That is what makes
`stand`, `defualt` and `default` come out with **zero** frames, and what makes
`epd_bitmap_thinking_2` **unreachable** (`thinking_1` is not defined). Both facts
are exported from the module, not left in a comment.

`firmware/upstream/` is gitignored, so the module is committed and the generator
is a *check*: `pnpm --filter @sesame-lab/web validate:face-bitmaps` runs on every
`pnpm test`, fails on drift, and reports SKIPPED when no upstream checkout is
present. The LF-normalised source SHA-256 travels in the module.

**Independent corroboration:** a test asserts the frame count of all 38 faces
against `FACE_CATALOG` in `@sesame-lab/sesame-protocol`, which is a checked
mirror of `hardware/hardware-map.json`. F4 read the frame counts out of firmware
source; this generator read them out of the header. They agree on all 38.

### 5.2 The encoding path — no shortcuts

```text
face-bitmaps.h        row-major, MSB-first, 16 B/row     what the author drew
  │  drawBitmap(0, 0, bmp, 128, 64, WHITE)               Adafruit_GFX, emulated
  ▼
GDDRAM buffer         page-ordered, 1024 B               what reaches the glass
  │  base64                                              @SESAME oled b64 …
  ▼
1368-character payload
  │  decodeOledFrame / oledPixel                         @sesame-lab/sesame-protocol
  ▼
<canvas> at 8× (1024×512)   +   CanvasTexture on oled_screen
```

Drawing the authored bitmap straight onto a canvas would be a third of the code
and a lie: the authored layout is not the layout the panel holds, `oled.frame`
carries the panel's layout, and a learner comparing this to a real `@SESAME oled`
line has to be looking at the same bytes. So the simulated path goes through the
protocol's own codec — `index = x + (y >> 3) * 128`, bit `y & 7` from the LSB —
and a test pins the protocol document's worked example (pixel `(3, 9)` → byte
131, bit 1) plus the two orderings that are easiest to get backwards.

**Hovering a pixel** reports its byte index, page and bit position. Faint lines
mark the eight page boundaries. That is the part a picture of a face cannot
teach.

### 5.3 Pixel provenance is not face provenance

When the app renders a frame from a `face.expression` event, the *pixels* are
tagged **`inferred`** — "constructed for explanation; no backend observed it" —
even when the face event itself was `observed`. The trigger's provenance is shown
alongside. When a real `oled.frame` event arrives, the pixels carry **that
event's** provenance and the panel says "this is what reached the glass".

### 5.4 The 3D projection

`oled_screen`'s material is replaced with an unlit `MeshBasicMaterial` — an OLED
emits its own light, so shading it with the scene's lamps would be visibly wrong
— carrying a `CanvasTexture` over a 128×64 canvas with `NearestFilter` on both
filters and **`flipY = false`**, per V2 §6. The harness asserts `flipY === false`
and that the texture's image really is the app's canvas, because "it looked
right" is not a check.

Carried forward verbatim: the 23.60 × 11.80 mm active plane is **`inferred`, not
measured**. V2 read the CAD glass window (23.60 × 13.70 mm) exactly out of the
STEP; the 2:1 rectangle the framebuffer is mapped onto is a decision of V2. A
real 0.96" SSD1306's active area is smaller than its glass. The Asset panel says
this on screen.

### 5.5 The empty-face bug, rendered truthfully

`setFace("stand")` and `setFace("default")` draw nothing:
`epd_bitmap_stand` and `epd_bitmap_defualt` are `__attribute__((weak))` and never
defined, `countFrames()` returns 0, the fallback table is empty too, and
`updateFaceBitmap()` is never reached (ISSUE-20260823-004).

Two consequences the app models separately, because they are different:

- **The panel retains its previous frame.** No `display.display()` call means
  GDDRAM is untouched — so the glass keeps showing the old face. Blanking
  instead would invent a behaviour the hardware does not have. From power-on,
  retention *is* a blank screen, and that is the screenshot.
- **No telemetry is emitted at all.** V1 correctly emits nothing, so a UI that
  only listens to the stream sees nothing and has nothing to explain. The
  silence is the symptom. `TelemetryStore.noteFaceRequest()` therefore notices
  host-side that the requested face has no bitmap and raises the explanation —
  tagged `inferred`, and saying so, because nothing observed it.

The two `⚠`-marked face buttons in the UI are `stand` and `default`. Pressing
either produces a blank screen and the reason. No placeholder is substituted.

---

## 6. Verification — six real-browser captures

`scripts/capture-web-screenshots.mjs`, run as `pnpm capture:web`. Reuses the
Phase-0 Edge/CDP approach and asserts something stronger than
`capture-viewer-screenshots.mjs` did: not "the page drew a bar of the right
width" but "`Object3D.quaternion` on the node named L3 actually changed". React
can be perfectly correct while three.js renders nothing.

Machine summary, including every assertion's inputs:
[`assets/v3-v4-browser-capture.json`](assets/v3-v4-browser-capture.json).

| Phase | What it asserts | Result |
|---|---|---|
| **1 · sim wave** | Eight joints start at the asset's rest transform (`sceneCommandedDeg` 90, `storeCommandedDeg` null); `runWavePose` is commanded; the scene graph is polled to L3 = 100° and L3 = 180°; the two screenshots differ byte-for-byte; the max quaternion-component delta between them is **0.620**; the scene follows the wire on all eight; the WebGL drawing buffer contains **5 161** non-background pixels; the render loop drew >10 frames; the simulator emitted **zero** `observed` events | pass |
| **2 · stand pose** | Every joint node's quaternion vs the one V2's pose rule predicts for the asset's `referencePose`: **max error 0.000°**. Every commanded angle from V1's choreography equals V2's CAD reading, joint by joint. The ground plane recomputed in-browser from the posed foot mesh vertices: **−68.650045 mm** vs V2's **−68.650046 mm**, residual **8.86 × 10⁻⁷ mm** | pass |
| **3 · OLED** | `happy` lights **528** pixels, payload is exactly **1368** characters; the texture is on `oled_screen` with `flipY === false`; after a reset `setFace("stand")` lights **0** pixels, causes **0** `display()` writes, and the UI carries the ISSUE-20260823-004 explanation; on a panel that already had a face, `setFace("stand")` leaves the base64 **byte-identical** | pass |
| **4 · bridge, replay** | Backend switched at runtime; app served by the bridge's own HTTP server; all eight joints driven over the WebSocket; scene matches wire to <1e-4°; provenance is **`simulated`** (a `--replay` stream did not happen on a robot) with **zero** `observed` robot events; joints keep moving as more telemetry arrives | pass |
| **5 · bridge, QEMU** | Real Sesame firmware under `qemu-system-xtensa` (esp32), UART0 on a TCP socket, the unmodified Phase-0 bridge, the unmodified app. **All eight joints** driven — R1 100, R2 45, L1 45, L2 90, R4 80, R3 180, L3 180, L4 180 — from **21 `observed`** events (the exact count varies with how much boot log the ring buffer held), **0** simulated, **0** inferred | pass |

| Screenshot | sha256 of the committed image (first 16) |
|---|---|
| [`v3-browser-wave-l3-100.png`](assets/v3-browser-wave-l3-100.png) — wave, L3 down | `0cd212973168e867` |
| [`v3-browser-wave-l3-180.png`](assets/v3-browser-wave-l3-180.png) — wave, L3 up | `22561ddbf3902291` |
| [`v4-browser-oled-face.png`](assets/v4-browser-oled-face.png) — a real face, 8x panel + 3D projection | `22394197e6e5f282` |
| [`v4-browser-oled-empty-face.png`](assets/v4-browser-oled-empty-face.png) — honestly blank + the reason | `f96991c32c9fbb36` |
| [`v3-browser-bridge-backend.png`](assets/v3-browser-bridge-backend.png) — bridge WebSocket, `simulated` | `b5c122801f4844ca` |
| [`v3-browser-qemu-observed.png`](assets/v3-browser-qemu-observed.png) — **real firmware, `observed`** | `5220381fe18a2212` |

Those digests identify the images in this directory, not a reproducible target:
re-running the harness renders new frames and the bytes change (anti-aliasing,
and which millisecond of a 3.68 s wave the capture lands on). The **within-run**
byte comparison is the one that carries meaning, and the harness enforces it —
two identical captures would mean the second was the same frame. `phases` and
`shots` in the JSON are rewritten on every run, so the digests there always match
the images beside them.

### Two things the harness had to learn the hard way

- **Headless Chromium has no GPU here.** WebGL comes from SwiftShader
  (`--use-gl=swiftshader --enable-unsafe-swiftshader`) and renders this scene at
  a few frames per second while telemetry arrives every 20 ms. Comparing the
  scene graph to the store without waiting is a race that passes on an idle
  machine and fails on a loaded one. `SceneHandles.renderStats()` exposes
  `frames` and `appliedPoseVersion`, both written by the same `useFrame` that
  writes the quaternions, and the harness waits for
  `appliedPoseVersion === storePoseVersion` before every comparison. A stalled
  render loop leaves every scene-graph reading stale *but plausible*, which is
  this app's nastiest failure mode; `frames` is the check for it.
- **QEMU discards UART output while nothing is attached.** `-serial
  tcp:…,server=on,wait=off` means the bridge must dial before the firmware
  prints. The harness attaches the bridge 1.2 s after QEMU starts and waits for
  its `uart connected` line before launching a browser, so a missing UART cannot
  masquerade as an app bug. The hub's ring buffer then holds the backlog for the
  browser, which takes much longer to start.

The QEMU phase is **non-fatal**: Q1 is off the critical path and `tools/qemu/` is
gitignored, so on a machine without it the phase reports SKIPPED and the run
still passes. Phases 1–4 are hard gates.

### In-browser vs. in-Node

The same geometric assertions also run in `pnpm test` (`rig.test.ts`,
`pipeline.test.ts`) by parsing the GLB with `GLTFLoader.parse()` in Node. That is
deliberate duplication: passing in Node and failing in the browser localises the
fault to the app rather than the asset.

---

## 7. What V1 and V2 exposed that turned out to be insufficient

Neither is a defect; both are gaps a consumer only finds by being one.

1. **Nothing machine-readable carries the face pixels.** `hardware-map.json`
   deliberately stops at "here is where the bitmap is defined". That is the right
   boundary for the extractor, but it means every renderer of the OLED must
   parse `face-bitmaps.h` itself. `apps/web` now has a generator that does; if a
   second consumer appears, it should move to `packages/` or into the extractor
   rather than be written twice. **Suggested:** a `faces.frames[].bitmapBase64`
   field, or a sibling `hardware/face-bitmaps.json`, keyed by symbol.
2. **A zero-frame face emits no event, so it is invisible to a telemetry-only
   UI.** V1 reproduces the bug perfectly — including the silence. But a viewer
   that only consumes `SesameTelemetry` cannot distinguish "nothing happened"
   from "something was attempted and drew nothing", which is the entire teaching
   value. The app fills the gap host-side (`noteFaceRequest`). **Suggested for
   V6 or a V1 follow-up:** an optional `log`-channel line, or a
   `face.expression` variant with `frameCount: 0`, so the attempt is on the wire
   where a lesson can point at it.
3. **`assets/sesame.glb` does not record the OLED's *outward* orientation in a
   form a consumer can check cheaply.** It records `screenNormalCanonical` and
   the UV convention in prose, which is enough — but "does the texture come out
   mirrored" is only answerable by looking. It came out correct; the app asserts
   `flipY === false` and that the texture is bound, and no more. A machine-check
   would need a marker asymmetry in the quad's UVs.
4. **V2's headline residual is not reproducible in a browser.** The 2.065 × 10⁻⁶
   mm figure is per-vertex against the raw STLs on disk, and the STLs are not
   shipped to a client. The in-browser check substitutes the ground plane, which
   is a different measurement of the same chain (it depends on the mesh data,
   the pivots, the parenting, the axes and the signs all being right together)
   and lands at 8.86 × 10⁻⁷ mm. Worth stating plainly: **this is not V2's
   number re-measured, it is a second number about the same rig.**
5. **`RealtimeOptions` is a second constructor argument, not part of
   `SimulatedRobotOptions`.** Minor, and discoverable only by reading `robot.ts`
   — `new SimulatedSesameRobot({ timeMode: 'realtime' }, { speed: 2 })` is easy
   to get wrong because the speed knob lives somewhere the options type does not
   mention.

Everything else V2 promised held exactly: node names as the contract, `cmd = 90`
as the identity, one number per joint, no axis conversion, `extras` readable
through `object.userData` and `gltf.asset.extras`, and the ground plane being
genuinely pose-dependent (−68.650 mm standing, −31.115 mm at rest — the app
recomputes it and the grid moves).

---

## 8. What remains unverifiable without hardware

| Item | Why the browser cannot settle it |
|---|---|
| **Direction of travel** on any joint | `signPerCommandedDeg` is V0's fit to CAD horn occurrences, status `inferred`. The app renders whatever the asset says; a mirrored leg would look plausible. Only a built robot and a protractor decide. V6. |
| **Which printed part is bolted where** | Every `semanticNameAlias` is displayed with an "unverified guess" tag and nothing keys off it. |
| **Mechanical travel limits** | V2 clamps nothing and neither does this app beyond the firmware's own 0–180. A slider can drive a joint somewhere the real linkage cannot go. |
| **Horn spline quantisation, per-robot subtrim, power-on horn position** | `commandedDeg` starts `null` for exactly this reason. |
| **Servo slew** | 600 °/s is the MG90S datasheet figure. `simulatedDeg` is labelled an inference everywhere it appears and never becomes `measuredDeg`. |
| **The OLED active area** | 23.60 × 11.80 mm is V2's decision, not a measurement. A real panel's active area is smaller than its glass, so the face is probably drawn slightly too large. |
| **The top cover you see** | `Top-Cover-Cat-v100.stl`, not the recommended `Top-Cover-Enclosed-v117.stl`, which is not watertight (ISSUE-20260823-006). The Asset panel says so on screen. |
| **That the firmware moves a real robot at all** | Phase 5's `observed` means bytes crossed a UART out of executing firmware. There were no servos on the other end. |

---

## 9. `debug-viewer/` — superseded, not deleted

It should go. Everything it does, `apps/web` does better, and Phase 0 named it a
throwaway in its own source. It is still on disk because deleting it turns a
currently-green test red, and that test is out of this agent's scope:

```
emulator/bridge/src/__tests__/bridge-e2e.test.ts:171
  it('serves the debug viewer from the same origin as the socket', …)
    viewerDir: path.join(REPO, 'debug-viewer')
    expect(html).toContain("['R1', 'R2', 'L1', 'L2', 'R4', 'R3', 'L3', 'L4']")
    expect(html).toContain('THIS IS A THROWAWAY')
```

`emulator/` is on this task's do-not-modify list, and shipping a red
`pnpm -r test` to buy a deleted directory is a bad trade.

**To finish the retirement** (three small edits, all outside `apps/web`):

1. In that test, point `viewerDir` at `path.join(REPO, 'apps/web/dist')` and
   replace the two `toContain` assertions with something the built app carries —
   e.g. `expect(html).toContain('<div id="root">')`. Note it then depends on
   `apps/web` having been built; gating it on `fs.existsSync` is the cheap fix.
2. Change `viewerDir`'s default in `emulator/bridge/src/config.ts` from
   `'debug-viewer'` to `'apps/web/dist'` (and the two `USAGE` lines).
3. `rm -rf debug-viewer`, and update the root `demo:telemetry` script (a
   `demo:web` script that already passes `--viewer-dir apps/web/dist` has been
   added alongside it).

`scripts/capture-viewer-screenshots.mjs` and its `exp8-*` images are Phase-0
*evidence* and should stay regardless; they are a record of what was proven when,
not a live tool. In the meantime `debug-viewer/index.html` carries a SUPERSEDED
banner in its own header comment, pointing at this document and at the test that
is holding it in place — so the reason it survives is discoverable from the file
itself, not only from here.

---

## 10. Deliberate non-goals

- **No physics.** Gate E: no near-term lesson needs it. Every frame is forward
  kinematics from one number per joint.
- **No third backend.** Anything that wants to drive this scene either
  implements `SesameRobot` in-process or speaks `@SESAME` over the bridge.
- **No architecture-graph view, no lesson content, no pose editor.** Phase 2.
- **No writes to `packages/`, `emulator/`, `hardware/`, `assets/` or
  `firmware/`.** Outside `apps/web/`, `scripts/` and `docs/`, the only edits are
  a comment block in `debug-viewer/index.html`, three new root `package.json`
  scripts, `apps/*` added to `pnpm-workspace.yaml`, and the resulting
  `pnpm-lock.yaml`.
- **`reproducibility.json` unchanged.** V3/V4 add no pinned artefact: the GLB is
  V2's and already recorded, and `face-bitmaps.ts` is a projection of
  `firmware/face-bitmaps.h`, which `sesameUpstreamCommit` already pins — with
  the module carrying its own source SHA-256 and a `--check` that runs on every
  test.

---

## 11. Reproducing this

```powershell
pnpm install
pnpm -r build                       # packages, bridge, then apps/web
pnpm -r test                        # 52 web tests + the face-bitmap drift check
pnpm -r typecheck
pnpm capture:web                    # six real-browser captures; add --skip-qemu to skip phase 5
pnpm dev:web                        # http://127.0.0.1:5173
pnpm demo:web                       # the bridge serving apps/web/dist on one origin
```

Node 24.13.0 · pnpm 10.34.1 · Edge (headless, SwiftShader) · Windows 11.
No package outside `apps/web` gained a dependency; nothing under `reference/` or
`firmware/upstream/` was written to.
