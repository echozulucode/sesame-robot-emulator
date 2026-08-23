# F4 — Documentation vs. source drift

**Task:** F4 (boundary inventory) · **Date:** 2026-08-23 · **Agent:** `boundary-inventory`

Every place the Sesame project's own documentation, or the Sesame Lab research report,
disagrees with the firmware source. **The source wins.** Each row cites both sides.

Source of record: the pinned firmware tree (identical byte-for-byte between
`reference/sesame-robot-main/` and `firmware/upstream/`, verified 2026-08-23).
Paths below are relative to the upstream repository root, matching the provenance
convention in `hardware/hardware-map.json`.

Reading order: **Section 1** is drift inside the Sesame project itself (this is what
lessons would teach wrongly if generated from README prose). **Section 2** is drift
between the Sesame Lab research report and the source. **Section 3** records what was
checked and found *correct*, because a drift report that only lists failures gives no
sense of how far it looked.

---

## 1. Sesame project documentation vs. Sesame firmware source

### 1.1 AP SSID — `Sesame-Controller` vs `Sesame-Controller-BETA` (confirmed)

| | Value | Provenance |
|---|---|---|
| **Source** | `Sesame-Controller` | `firmware/sesame-firmware-main.ino:15` — `#define AP_SSID  "Sesame-Controller"` |
| Docs | `Sesame-Controller-BETA` | `firmware/README.md:104`, `:190`, `:200` |

The research report flagged this; it is confirmed. The docs repeat the wrong SSID three
times, including in the flashing walkthrough (`:104`) and in the runtime WiFi-setup
instructions (`:200`), so a builder following the README will look for a network name
that does not exist. Recorded in the map as `network.ap.ssid`.

### 1.2 I²C bus clock — documented 400 kHz, never configured

`firmware/README.md:164` states: *"Utilizes the ESP32's hardware I2C controller at 400kHz
(Fast Mode)"*. There is **no `Wire.setClock()` call anywhere in the firmware tree**
(grep over all `.ino`/`.h`). `Wire.begin(I2C_SDA, I2C_SCL)` at
`firmware/sesame-firmware-main.ino:656` uses the two-argument overload, so the bus runs at
whatever the Arduino-ESP32 core defaults to for that core version.

Consequence for us: any Renode/I²C timing model must treat the bus clock as a
**core-version-dependent unknown**, not as 400 kHz. Recorded as
`display.busClockHz: null` plus `unresolved[i2c-bus-clock]`.

### 1.3 Boot-path station timeout — "10 seconds / 20 attempts"

`firmware/README.md:117` suggests *"increasing the connection timeout in the code
(currently 10 seconds / 20 attempts)"*. Source:

- default `timeoutMs` is **10000 ms** — `firmware/sesame-firmware-main.ino:213`
- the poll loop delays **250 ms** per iteration — `:465`, i.e. up to **40** iterations, not 20
- and it **fast-fails** on `WL_CONNECT_FAILED` / `WL_NO_SSID_AVAIL` after the first
  second — `:464`, so the real worst case is often far shorter than 10 s

The timeout figure is right; the attempt count is wrong and the fast-fail behaviour is
undocumented.

### 1.4 Idle mode is NOT entered on inactivity

`firmware/README.md:667` (and the verbatim duplicate at `:694`) says: *"**Activation**: When
the robot has received no commands for a period, it enters idle mode"*, and `:169`
repeats *"triggered automatically when no input is detected"*.

Source: `enterIdle()` has **exactly one call site** —
`firmware/movement-sequences.h:88`, inside `runStandPose(int face)`, guarded by
`if (face == 1)`. Nothing in `loop()` watches for inactivity to enter idle. The
inactivity timer that *does* exist (`lastInputTime`, 30 s at
`firmware/sesame-firmware-main.ino:1098`) drives the **WiFi info scroll**, not idle mode.

So: idle is entered on *completion of a user-visible stand pose*, and only ever then.
Every pose function ends with `runStandPose(1)`, which is why the behaviour looks
inactivity-driven from the outside — but a robot that has never been commanded never
enters idle at all. This matters for the Phase-1 behavior model, which would otherwise
implement a timer that does not exist.

### 1.5 Idle exit is narrower than documented

`firmware/README.md:671`: *"**Exit**: Any movement command or input immediately exits idle
mode"*. `exitIdle()` is called from only three sites —
`firmware/sesame-firmware-main.ino:235` (`/cmd?pose=`), `:241` (`/cmd?go=`) and `:384`
(`POST /api/command` with a non-`stop` command).

It is **not** called from `/cmd?stop=` (`:244`), `/cmd?motor=` (`:249`), the serial CLI
(`:786`–`:883`), or `POST /api/command` with `{"command":"stop"}` (`:377`). Those paths
call `recordInput()` only. Driving a servo directly, or stopping, leaves `idleActive`
set and the blink scheduler running.

### 1.6 Two faces in the documented face library have no bitmap at all

`firmware/README.md:797` lists `stand` among the movement faces and `:817` calls
`default` *"The startup/fallback face"*.

Source: `epd_bitmap_stand` and `epd_bitmap_defualt` are declared as **undefined weak
symbols** by the X-macro at `firmware/face-bitmaps.h:52` and are **never defined**
anywhere in the file (the file defines 46 bitmap arrays; neither is among them).
At runtime their frame-array slot 0 is a null pointer, `countFrames()`
(`firmware/sesame-firmware-main.ino:893`) returns 0, and `setFace()` falls through to the
`face_defualt_frames` fallback at `:924`–`:929` — which is *also* empty.

Net observable behaviour: requesting `stand`, `default`, or any unrecognised face name
leaves whatever frame was already on the OLED, and sets `currentFaceName` to `"default"`.
`/api/status` will then report a face that is not being displayed.

Recorded per-face as `frameCount: 0` + `brokenReason`, and in
`unresolved[broken-face-bitmaps]`.

### 1.7 The startup face is `rest`, not `default`

Related to 1.6 but separate: `firmware/README.md:817` calls `default` the *startup* face.
`setup()` calls `setFace("rest")` at `firmware/sesame-firmware-main.ino:747`, with the
comment *"Show rest face on startup without moving motors"*. `rest` has 3 frames and
renders correctly.

### 1.8 `epd_bitmap_thinking_2` is unreachable

`epd_bitmap_thinking_2` is defined at `firmware/face-bitmaps.h:731`, but
`epd_bitmap_thinking_1` is not. `countFrames()` stops at the first null pointer, so
`thinking` has 1 usable frame and 1 KB of flash holds a frame that can never be shown.
Not a documentation claim, but it contradicts the animation convention the README
describes at `:834`–`:838`, which assumes contiguous `_1`, `_2`, … suffixes.

### 1.9 Documented routes are incomplete, and none are method-restricted

`firmware/README.md:153`–`:158` lists five route families and the API reference at
`:284`–`:317` documents them as `GET`. Two problems:

1. **Missing routes.** The three runtime WiFi-provisioning endpoints —
   `/api/wifi/scan` (`firmware/sesame-firmware-main.ino:722`), `/api/wifi/connect`
   (`:723`), `/api/wifi/status` (`:724`) — appear nowhere in the API reference, even
   though `:196`–`:205` documents the *feature* they implement. The `onNotFound`
   catch-all (`:729`) is also undocumented.
2. **Method is not enforced at registration.** Every route uses the two-argument
   `WebServer::on(uri, handler)` overload, which binds `HTTP_ANY`. A `POST /cmd?pose=wave`
   or a `GET /getSettings` via any verb both work. Only `/api/command` (`:304`) and
   `/api/wifi/connect` (`:598`) check the method inside the handler and return 405.

The map records `method: "ANY"` for all ten routes plus a `methodEnforcedInHandler`
field for the two that check.

### 1.10 "Instead of `delay()`" is overstated

`firmware/README.md:160`: *"Instead of `delay()`, the firmware uses a custom
`pressingCheck(String cmd, int ms)` function."* Three qualifications:

- Bare `delay()` calls do exist: `delay(10)` in `setup()` (`:744`), `delay(250)` in the
  boot-path WiFi poll (`:465`), and `delay(5)` inside `delayWithFace()` itself (`:1001`).
- `pressingCheck()` is used **only** by the four walking functions
  (`runWalkPose`, `runWalkBackward`, `runTurnLeft`, `runTurnRight`). All 15 pose
  functions use `delayWithFace()`, which pumps HTTP/DNS but has **no interrupt check** —
  poses genuinely cannot be interrupted mid-sequence.
- `delayWithFace()` is itself invoked once per `setServoAngle()` call (`:1055`), which
  makes every servo write a re-entrancy point for the HTTP handlers. That is
  behaviourally important and documented nowhere.

The map encodes the distinction as `movements[].interruptible` (true for exactly the four
walk functions) with `interruptCheck` steps.

### 1.11 Pin-configuration line numbers in the flashing guide are wrong

`firmware/README.md:79` tells the builder to *"Find the pin configuration section (around
line 55-65)"*. The actual blocks are the I²C defines at
`firmware/sesame-firmware-main.ino:30`–`:40` and the `servoPins` arrays at `:94`–`:113`.
Line 55–65 is the global animation-state block. Similarly `:86` says the network config
is at *"around line 17-22"*; it is at `:13`–`:23`.

### 1.12 Internal drift: the captive portal and the settings API disagree

Not a README issue, but a source-vs-source inconsistency worth recording because it will
confuse a lesson about the settings round-trip:

- `firmware/captive-portal.h:731` sends `motorSpeed` to `/setSettings`.
  `handleSetSettings()` (`firmware/sesame-firmware-main.ino:280`) does not read it.
- `firmware/captive-portal.h:658` reads `data.motorSpeed` from `/getSettings`.
  `handleGetSettings()` (`:270`) does not emit it.
- Conversely the portal never sends `faceFps`, which the API *does* support (`:284`).

So the "Motor Speed" control in the web UI is inert in both directions.

### 1.13 The README contains a duplicated section

`firmware/README.md:688` opens `## Asset Pipeline & Face Customization` but its body is a
verbatim copy of the Idle Animation System section from `:661`. The real asset-pipeline
content appears at `:785` under a second heading of the same name. Cosmetic, but it means
the TOC anchor at `:23` lands on the wrong content.

---

## 2. Sesame Lab research report vs. source

Report: `research/Sesame Lab_ Emulator, Virtual Robot, and Interactive Engineering
Learning Platform.md`. Only the "Sesame robot as it exists today" section is in F4 scope.

### 2.1 The boot-order summary is incomplete (not wrong)

Report `:196`: *"`setup()` starts serial, initializes I²C, initializes the SSD1306, and
enters an infinite failure path if OLED allocation/initialization fails; only after that
does it continue into Wi-Fi, server setup, servo timer allocation and servo attachment."*

The ordering is correct as far as it goes, and the hard-fail claim is exactly right. But
R4 needs a milestone ladder, and six steps are missing from that summary:

| # | Missing step | Provenance |
|---|---|---|
| 2 | `randomSeed(micros())` | `:653` |
| 5 | OLED splash render ("Setting up WiFi...") — the first visible frame | `:664`–`:669` |
| 6 | `WiFi.persistent(false)` | `:674` |
| 10 | mDNS start / OLED scroll-text build | `:695`–`:700` |
| 11 | input-tracking init (starts the 30 s WiFi-info timer) | `:703`–`:705` |
| 12 | **`dnsServer.start(53, "*", myIP)`** — precedes route registration | `:709` |

The DNS server start is the notable one: it comes *before* the HTTP server in the boot
path, so a boot probe that watches for "server up" must expect UDP/53 activity first.
The full 20-step ladder is in `hardware-map.json → bootOrder`.

### 2.2 The route table is incomplete and mis-labels methods

Report `:249`–`:257` lists six routes and labels them `GET`/`POST`. Source has **nine
explicit registrations plus one catch-all**, and all ten are registered `HTTP_ANY` — see
§1.9. Missing from the report: `/api/wifi/scan`, `/api/wifi/connect`, `/api/wifi/status`,
`onNotFound`. The report says *"Relevant routes include"*, so this is under-specification
rather than error, but the emulator's compatibility proxy needs the complete set.

### 2.3 Playback mode is not a per-face property

Report `:194`: *"the firmware supports multiple frames per expression and per-face frame
rates/modes such as loop, once, and boomerang."*

Frame **rates** are per-face (`faceFpsEntries[]`, `:152`–`:191`). **Modes** are not:
`currentFaceMode` is a single global (`:58`, initialised to `FACE_ANIM_LOOP`) that
`setFaceWithMode()` overwrites at each call site (`:942`). `setFace()` alone leaves it
untouched — so `POST /api/command {"face":"happy"}` inherits whatever mode the previous
animation left behind.

Practical consequence: 19 of the 38 registered faces (every conversational face plus
`defualt`/`default`) are never passed to `setFaceWithMode()` anywhere in the firmware and
therefore have **no intrinsic mode at all**. A simulator that stores `mode` on the face
record will produce different visuals from the real robot. The map instead records, per
face, the modes observed at each call site.

### 2.4 `setServoAngle()`'s delay is a re-entrancy point, not a quiet wait

Report `:179` describes the final step as *"a configurable delay intended to reduce
power-current surges"*. Accurate as intent, incomplete as behaviour: the call is
`delayWithFace(motorCurrentDelay)` (`:1055`), and `delayWithFace()` (`:995`) spins on
`updateAnimatedFace()` + `server.handleClient()` + `dnsServer.processNextRequest()` with
a `delay(5)` per iteration.

So every single servo write also services HTTP and DNS and can advance a face animation.
A behaviour model that treats `motorCurrentDelay` as dead time will mis-order events
against the telemetry stream, and an HTTP request can be *accepted* in the middle of a
pose. Recorded as `servoConfig.motorCurrentDelay.appliedNote`.

### 2.5 Sesame Studio labels are `R1..L4`, not `S0–S7`

Report `:264` describes Studio as presenting *"color-coded S0–S7 controls"*. Studio's
widgets are keyed and labelled by firmware joint name — `software/sesame-studio/sesame_studio.py:148`–`:151`
builds `("L1", …), ("L3", …), ("R1", …)` etc. It also enforces per-joint input ranges
that the firmware does not: 45–180 for `R1`/`L2` (`:199`–`:205`), 0–135 for the next pair
(`:214`), 0–180 elsewhere (`:224`), whereas `setServoAngle()` clamps everything to 0–180
(`firmware/sesame-firmware-main.ino:1053`). Out of F4's critical path, but relevant to
Phase-1 pose-editor parity: Studio's ranges are a *convention*, not a firmware limit.

### 2.6 The `192.168.4.1` AP address is a core default, not a firmware constant

Report `:151`-adjacent claims and `firmware/README.md:192` both state the AP IP as
`192.168.4.1`. The firmware never hard-codes it — it reads `WiFi.softAPIP()` at
`firmware/sesame-firmware-main.ino:689` and interpolates the result. The value is
correct in practice but is an Arduino-ESP32 SoftAP default, so a Renode/Wi-Fi mock is
free to hand back something else. Recorded as `defaultIpVerified: false`.

---

## 3. Checked and found correct

Listing these so the negative space is legible — these were verified line-by-line, not
assumed.

| Claim | Source | Verdict |
|---|---|---|
| Servo enum order `R1,R2,L1,L2,R4,R3,L3,L4` | report `:145`–`:156` | **exact match**, `firmware/movement-sequences.h:5`–`:14` |
| S2 Mini pins `{1,2,4,6,8,10,13,14}`, I²C 33/35 | report `:160`, `firmware/README.md:725`–`:734` | **exact match**, `:110` / `:39`–`:40` |
| Distro V3 pins `{4,5,6,7,10,11,12,13}`, I²C 8/9 | report `:160`, `firmware/README.md:755`–`:764` | **exact match**, `:101` / `:31`–`:32` |
| Distro V2 pins `{4,5,6,7,15,16,17,18}` | report `:160`, `firmware/README.md:770`–`:777` | **exact match**, `:104` |
| Distro V1 pins `{15,2,23,19,4,16,17,18}`, I²C 21/22 | report `:160`, `firmware/README.md:740`–`:749` | **exact match**, `:107` / `:35`–`:36` |
| All four README HAL tables' joint labels | `firmware/README.md:723`–`:779` | **exact match** with the enum order, index-for-index |
| 4 PWM timers, 50 Hz, attach 732–2929 µs | report `:177`, `firmware/README.md:144`–`:145` | **exact match**, `:734`–`:742` |
| `motorCurrentDelay` default 20 ms | report `:179`, `firmware/README.md:146` | **exact match**, `:119` |
| 0–180 clamp with subtrim added first | report `:179` | **exact match**, `:1053` |
| SSD1306 128×64 at `0x3C`, reset `-1` | report `:169`/`:194` | **exact match**, `:25`–`:28` |
| SSD1306 init failure enters an infinite loop | report `:196` | **exact match**, `:659`–`:662` (`while (1);`) |
| No position feedback anywhere in the robot | report `:181` | **confirmed** — `setServoAngle()` is write-only; nothing reads servo state |
| No application-created RTOS tasks or planner | report `:225` | **confirmed** — single cooperative `loop()`, no `xTaskCreate` in the tree |
| HTTP on port 80; DNS wildcard on UDP 53 | report `:247`, `firmware/README.md:151` | **exact match**, `:48` / `:709` |
| mDNS `sesame-robot.local`, `_http._tcp` on 80 | `firmware/README.md:152` | **exact match**, `:78` / `:411`–`:413` |
| Credentials not persisted (`WiFi.persistent(false)`) | `firmware/README.md:205` | **exact match**, `:674` |
| Runtime WiFi setup takes ~15 s | `firmware/README.md:202` | **exact match**, `WIFI_CONNECT_TIMEOUT_MS = 15000`, `:91` |
| Max 6 frames per face (root + 5) | `firmware/README.md:838` | **exact match**, `:127`–`:133` |
| `/getSettings` returns exactly the 4 documented keys | `firmware/README.md:314` | **exact match**, `:271`–`:276` |
| Pose command list (15 poses) | `firmware/README.md:404`–`:406` | **exact match** with the `loop()` dispatch, `:768`–`:782` |
| Movement commands loop until stopped | `firmware/README.md:399` | **confirmed** — the four walk functions never clear `currentCommand` |
| `/api/command` parses the body by hand, no JSON lib | report `:258` | **confirmed**, `:315`–`:362` (`indexOf`/`substring` only) |
| `runWavePose` = stand → adjust → delay → alternate one joint | report `:227` | **confirmed** — 4× alternation of `L3` between 180 and 100 |
| `sesame-motor-tester.ino` uses the same pins and pulse range | — | **consistent**: same active `{1,2,4,6,8,10,13,14}`, same 3 commented alternates, `MIN_PULSE`/`MAX_PULSE` = 732/2929 |

---

## 4. Consequences for later Phase-0/1 tasks

- **R4 (boot probe).** Use `hardware-map.json → bootOrder` (20 steps), not the report's
  7-step summary. Only step 4 (`display.begin`) is a proven hard blocker; steps 8/10/12
  are unchecked-return calls that will *appear* to succeed under a mock.
- **R6 (telemetry patch).** One hook site is sufficient and correct:
  `setServoAngle()` at `firmware/sesame-firmware-main.ino:1051`. Emit **after** the
  clamp at `:1053` so the telemetry carries the value actually written, subtrim included.
- **F6 (joint map).** Nothing in this drift report licenses a semantic joint name. The
  firmware names carry no geometry; §3's "exact match" rows are about *indices and pins*
  only.
- **Phase 1 (behavior model).** Do not implement inactivity-triggered idle (§1.4), do not
  store playback mode on faces (§2.3), and model `motorCurrentDelay` as a yield point
  rather than dead time (§2.4).
- **Lesson content.** Generate against the pinned commit, never against README prose —
  §1 lists 13 places that would have taught something false.
