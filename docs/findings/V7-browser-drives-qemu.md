# V7 — the browser buttons drive real firmware

**Task:** V7 · **Date:** 2026-08-24 · **Agent:** `ui-qemu`
**Follows:** `docs/findings/Q2-qemu-backend.md` §9 (the UI follow-up it names), `V3-V4-browser-robot.md`,
`V5-api-adapter.md`

### Evidence labelling

| Tag | Meaning |
|---|---|
| `[RAN]` | **verified-by-running** on this machine |
| `[SRC]` | **found-in-source** — read out of a file here |
| `[INFER]` | **inferred** — reasoned, not observed |

---

## 0. The answer

> **A `<button>` in a headless browser now runs real Sesame firmware.** The harness clicks
> `[data-command="wave"]`, that becomes `POST /api/command {"command":"wave"}` on the firmware's own
> route, the adapter calls `QemuSesameRobot.command('wave')`, `rn wv` goes out on UART0, real Xtensa
> instructions run, and 29 `@SESAME servo` lines come back and turn eight `Object3D.quaternion`s in
> the three.js scene graph. **All eight joints assert `provenance: 'observed'`, `origin.kind:
> 'emulator'`, and `isPhysicallyObserved() === false`.** `[RAN]`
>
> Before the click: **0 of 8 joints commanded.** After: **8 of 8**, max quaternion component delta
> **0.707**. Emulator-origin events: **34.** Physically-observed events: **0.** `[RAN]`

`docs/findings/assets/v3-browser-qemu-commanded-wave.png`, and the machine-readable form in
`v3-v4-browser-capture.json → phases.qemuCommanded`.

---

## 1. The transport, and why it is not the bridge

Q2 §9 offered two working paths. Both were viable; the HTTP adapter won on three counts.

| | bridge `--allow-control` | **`SesameApiAdapter` over `QemuSesameRobot`** |
|---|---|---|
| command vocabulary | a v2 WebSocket frame nothing else speaks | **the firmware's own `POST /api/command`**, byte for byte what the real robot answers on port 80 |
| `TelemetryOrigin` | **none.** The envelope's `origin` is `'uart' \| 'bridge'` — which *socket*, not which boundary. The browser would have to assert "emulator" on its own authority | **carried from the party that knows.** `QemuSesameRobot` stamps `QEMU_ORIGIN` on every event it emits |
| boot honesty | a UART socket cannot say how many boots it burned | `robot.bootAttempts` is a first-class field |
| already exercised | — | C07–C15 of the contract suite pass through this exact adapter against this exact backend |

The second row is the decisive one and it is not a matter of taste. `TelemetryOrigin`'s whole
purpose is that the transport owner stamps it, "because the firmware cannot know it is running under
an emulator and should not be asked to claim it is not" (`origin.ts`). On the bridge path the app
would be inferring `emulator` from *which button the user pressed in the backend switch* — which is
the app manufacturing evidence about the physical world. Phase 5 of the harness now proves the
consequence rather than asserting it: over the bridge the app sees **9 events with
`origin.kind: 'unknown'`** and correctly refuses to treat unknown as physical. `[RAN]`

### 1.1 Where the composition root lives

`SesameApiAdapter` is transport-free by design — "something else can mount it inside an existing
server" (`adapter.ts`) — so the composition root is **`apps/web/server/lab-host.mjs`**: a loopback
Node process that mounts the adapter, serves `apps/web/dist`, and adds exactly two endpoints the
firmware's HTTP contract cannot express.

```text
browser button
  -> POST /api/command  (adapter, ten firmware routes, unmodified)
  -> QemuSesameRobot.command('wave')  ->  "rn wv" on UART0  ->  real firmware
  -> @SESAME servo  ->  robot.subscribe()  ->  GET /lab/stream (SSE)
  -> TelemetryStore  ->  Object3D.quaternion
```

`/lab/stream` and `/lab/session` are the only inventions, and each earns its place: the firmware has
no telemetry stream, and it has no way to say "I am an emulator, on this board, with these
subsystems absent". Everything else — `/api/command`, `/api/status`, `/cmd?motor=&value=` — is the
robot's own contract, so **the browser speaks one protocol regardless of which backend is behind
it.** The host binds `127.0.0.1` with no opt-out flag: unlike `sesame-api` it also *serves an app
that posts commands to itself*, so publishing it would hand a network a robot and a UI for it.

### 1.2 `sesame-api --backend qemu` — added, and honestly qualified

Added as asked, simulator still the default, and it is genuinely useful without a browser:

```bash
node packages/sesame-api/dist/cli.js --backend qemu
curl -s -XPOST -d '{"command":"wave"}' http://127.0.0.1:8123/api/command
```
```
  backend    QemuSesameRobot (qemu-system-xtensa/9.2.2-…, board distro-v1-esp32)
             — booted after 2 attempt(s), 1 of which panicked (ISSUE-20260823-022, …)
  provenance emulated (…, the LEGACY V1 board). Real firmware executed; no hardware did.
             isPhysicallyObserved() is false for every event this backend emits.
```
`[RAN]` The import is dynamic, so the default path never loads a package that spawns processes. One
thing the banner says out loud because a user would otherwise assume the opposite: this is a
**host-side proxy**, not the robot's web server — that backend reports `httpApi: false`, because
QEMU models no radio and `server.begin()` is one of the lines the image elides.

**The cost, stated rather than glossed.** `sesame-qemu` already devDepends on
`sesame-api/contract` for its contract suite, so adding the reverse edge makes the workspace graph
cyclic and `pnpm install` now prints:

```
 WARN  There are cyclic workspace dependencies: packages/sesame-api, packages/sesame-qemu
```

That was checked rather than assumed before accepting it: `pnpm install`, `pnpm install
--frozen-lockfile` and `pnpm -r run build` all complete, and the two packages build in parallel.
`[RAN]` The cycle is also *true* — the API CLI really can front the emulator, and the emulator's
tests really do use the API's contract suite — so hiding it behind a path-relative dynamic import
would have traded an accurate warning for an inaccurate silence and an untyped import. The
alternative if the noise ever outweighs the flag: move `describeRobotContract` out of `sesame-api`
into a package both can depend on. Not done here; it is a change to two packages this task does not
own. `[INFER]`

---

## 2. `provenance === 'observed'` — the audit

Grepped the whole repository for the comparison Q2 §9 forbids. **Four sites, and `apps/web` was not
one of them:**

| Site | Verdict |
|---|---|
| `packages/sesame-protocol/src/origin.ts:126` | the definition of `isPhysicallyObserved()` itself. Correct. |
| `origin.ts:119` | prose warning against exactly this comparison. |
| `emulator/renode/tests/r3-uart-capture.mjs:118` | a Renode-track probe, owned elsewhere, on a closed track. |
| `scripts/verify-oled-hook.mjs:241` | asserts a firmware hook's own tag; not a UI branch. |

So the finding is not "a bad comparison was fixed" — it is that **nothing in the app branched on
origin at all**, which is worse, because the field was simply absent from the UI and every emulated
angle rendered as a bare green `observed` badge. The fix is additive:

- `TelemetryStore` now keeps `origin` and `physicallyObserved` **per joint**, plus `originCounts`
  and `physicallyObservedEvents` in aggregate. An event with no origin is counted as `unknown`, not
  dropped — "nobody said" must be distinguishable from "nothing arrived". `[SRC]`
- **`physicallyObserved` is computed by calling `isPhysicallyObserved(event)`**, never by comparing
  strings. Four unit tests pin it, including the two cases that matter: an `observed` event with an
  emulator origin is *not* physically observed, and an `observed` event with **no** origin is *not*
  physically observed either. `[RAN]`
- `describeOrigin()` is rendered beside the provenance badge in the banner, in the joints table
  (a whole column), in the OLED panel's face row, and in the joint detail. The harness asserts the
  **rendered DOM text**, not the object.
- The banner carries a verdict line computed from the predicate:
  *"Not a measurement. The firmware really executed and really wrote these angles, but it did so on
  emulated silicon — so this shows what the CODE does, not what a servo horn did."* `[RAN]`

`describeOrigin()` never returns the empty string, which is why interpolating it cannot degrade into
an unqualified "observed".

---

## 3. What a QEMU run now says on screen

An **Emulator** panel, rendered only for a backend that returns `emulatorFacts()`, and populated
entirely from `QemuSesameRobot.capabilities()` — the app asserts none of it:

- **`origin`** — `emulated (qemu-system-xtensa/9.2.2-esp_develop_9.2.2_20260417, distro-v1-esp32)`.
- **`board`** — `distro-v1-esp32`, labelled *the legacy V1 board — not the S2 Mini in this project's
  pin diagram*.
- **`unsupportedBoards`**, with reasons, under the heading *"Boards this cannot emulate — including
  the one you were told to buy."* `s2mini` (no `esp32s2` machine exists) and `distro-v3-s3` (boots
  ROM and bootloader, never reaches `setup()`). The harness fails if the string `s2mini` is not in
  the rendered text.
- **`elided`** — eight chips, with the sentence that makes them mean something: *silence from these
  is not evidence of anything.*
- **`mode`** — `qemu`, explained from `MODE_MEANING`, a `Record<RobotMode, string>` with **an arm for
  every `RobotMode`** (`real`, `simulated`, `renode`, `qemu`). A `Record` rather than a `switch`
  with a default, so a fifth mode is a compile error rather than a silent fallthrough. The backend
  constructor in `App.tsx` is likewise a `switch` over `BackendId` with no default.
- **`everObserved`** — which joints have never been reported by the firmware, and that their angle
  on screen is the documented 90° power-on *assumption* rather than a report.
- **`isPhysicallyObserved()` count**, displayed. It reads `0`, and it is counted rather than claimed.

### 3.1 The OLED degrades honestly

`ssd1306-panel` is in `elided` and `oledFramebuffer` is `false`, so QEMU produces face **events** and
no pixels at all. The store already tagged host-rendered pixels `inferred` (V4); what was missing was
the *reason*. The panel now says it, and only when the backend declares it:

> **These pixels did not come from the emulator.** … QEMU attaches no SSD1306 to this machine, so
> `display.display()` inside the guest writes to nothing observable. What the firmware *does* emit is
> the face *name*, and that really did cross the UART. … It is shown because the 3D robot needs a
> screen, and it is labelled `inferred` because nothing transmitted it. It is not a capture of the
> emulator's framebuffer, and there is no framebuffer to capture.

Measured: `pixelProvenance: 'inferred'`, `kind: 'rendered'`, 571 lit pixels, note shown. `[RAN]`
The flag is derived from `oledFramebuffer === false || elided.includes('ssd1306-panel')` — from what
the backend says, never from which backend it is.

### 3.2 The 2–17 s connect reads as progress, not as a hang

- The lab host listens **before** the emulator boots, so the browser can watch the boot rather than
  only its outcome. `/lab/session` reports `phase`, `attempts`, `failedAttempts` and `elapsedMs`.
- Retries are visible **while they happen**, not only afterwards: `QemuSesameRobot.bootAttempts` is
  not assigned until `launchWithRetry()` returns, so the host parses the backend's own
  `boot attempt N failed:` logger line and increments a live counter. Without that, a seven-attempt
  connect is seventeen seconds of silence — the exact under-measurement Q2 §1.1 had to undo.
- The UI shows `booting real firmware — attempt N, X.X s elapsed`, and after connecting keeps the
  count: *"booted in 38962 ms after 5 attempt(s) · 4 boot(s) panicked and were relaunched —
  ISSUE-20260823-022, a QEMU cache-modelling bug this retries past rather than fixes."* That is a
  real screenshot from a real run. `[RAN]`
- Command buttons are **disabled until `connection === 'connected'`**, with the reason stated: a
  command posted mid-boot gets a `503`, and a button that looks live but is not teaches the wrong
  thing.
- One bug found and fixed by this requirement: the SSE `onopen` handler composed its status by
  spreading the previous one, which announced `connected, 0 ms` a poll ahead of the real numbers —
  reporting the boot cost as zero. It now defers to `/lab/session`. `[RAN]`

Across three full harness runs the boot needed **1, 5 and 2 attempts** (0 ms→2.7 s, 39.0 s, 17.8 s
wall). The 5-attempt run is ISSUE-20260823-022 firing four times, surfaced rather than hidden. `[RAN]`

---

## 4. Verification — `scripts/capture-web-screenshots.mjs` phase 6

Automated, not a demo. Failure here is a **hard failure** (exit 1), unlike phase 5; the only
legitimate skip is an absent toolchain, checked explicitly.

| Assertion | Result |
|---|---|
| the `cli` image boots **idle** — 0 of 8 joints commanded before the click | **0** `[RAN]` |
| `[data-command="wave"]` exists, is **not disabled**, and is clicked via `element.click()` | ok `[RAN]` |
| the eight scene-graph quaternions moved | max component delta **0.707** `[RAN]` |
| every driven joint: `provenance === 'observed'` | 8/8 `[RAN]` |
| every driven joint: `origin.kind === 'emulator'` | 8/8 `[RAN]` |
| every driven joint: `isPhysicallyObserved() === false` | 8/8 `[RAN]` |
| scene angle equals the angle the firmware reported, < 1e-4° | 8/8 `[RAN]` |
| events by origin | `emulator 34`, everything else **0** `[RAN]` |
| `physicallyObservedEvents` | **0** `[RAN]` |
| rendered DOM names the board, the unsupported `s2mini`, and "Not a measurement" | ok `[RAN]` |
| **ISSUE-20260823-023**: grid, GLB root, orbit target and camera drift during the QEMU wave | **0.000 mm** on all four, tolerance 1e-6 mm `[RAN]` |
| …while the pose-dependent foot contact swept | **37.535 mm** — so the check above is not vacuous `[RAN]` |
| OLED pixels are `inferred` and the elided note is shown | ok `[RAN]` |
| WebGL drawing buffer non-background pixels | **5124** `[RAN]` |
| page console errors | **0** `[RAN]` |

The click is a **DOM click**, deliberately, not `window.__sesame.run()`. The debug hook reaches the
same code, but the claim being evidenced is *"the buttons work"* — and a disabled button, a missing
handler, or a `canCommand: false` backend are exactly the failures a direct call steps over.

Reusing the ISSUE-023 world-frame check on this path was not ceremony. That bug was found by a human
looking at the simulator while the harness was green, because everything sampled the *pose* and
nothing sampled the *frame the pose is expressed in*. A new driving path is a new chance for the
floor to start sliding, and the QEMU wave sweeps the same 37.5 mm of foot height that used to trigger
it.

Three new captures: `v3-browser-qemu-booting.png`, `v3-browser-qemu-idle.png`,
`v3-browser-qemu-commanded-wave.png`, plus `v4-browser-qemu-oled-inferred.png`.

### 4.1 Phase 5 was corrected, not weakened

It asserted `provenance.driving === 'observed'` and stopped there — a check that would have passed
just as happily for a fabricated physical robot. It now *additionally* requires
`physicallyObservedEvents === 0`, and records the origin histogram (`unknown: 9`) that documents why
the bridge path cannot carry this claim. No case was skipped or loosened.

---

## 5. Running it

```bash
pnpm --filter @sesame-lab/web build
node apps/web/server/lab-host.mjs                 # serves the app + the ten firmware routes
# open the printed URL, choose "QEMU firmware", press wave

pnpm --filter @sesame-lab/web dev                 # vite, proxying /api /cmd /lab to :8099
node apps/web/server/lab-host.mjs --port 8099 --no-static

node scripts/capture-web-screenshots.mjs          # the full six-phase gate
```

---

## 6. What this does not claim

- **It does not claim anything was measured.** Nothing in this project has touched hardware. The
  number that says so — `physicallyObservedEvents` — is displayed, counted and asserted precisely so
  the claim is checkable rather than promised.
- **It does not claim the emulated PWM is correct.** Q2 §8 flagged this as the largest open fidelity
  question and it remains open. The servo evidence is the firmware's own hook, *above* the
  peripheral; this work moved it into a browser without validating it.
- **It does not claim the flakiness is fixed.** One of three harness runs needed five boots. The
  backend retries past ISSUE-20260823-022; the QEMU bug is untouched.
- **It does not claim the S2 or S3 work.** It claims the UI now says they do not.
- **It does not claim timing fidelity.** A wave takes ~3.9 s under QEMU. What it takes on hardware is
  unmeasured, because no hardware exists in this project.
- **It does not claim the lab host is production-grade.** It is a loopback lab tool with no
  authentication, which is defensible only because it cannot be reached from another machine.
- **The origin object is repeated on every event** (~500 bytes each) rather than sent once per
  stream. That is a deliberate trade — an event that can be forwarded without its origin is an event
  that can be laundered — and it has not been measured at high event rates. `[INFER]`
