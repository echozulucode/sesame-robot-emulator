# V6 — hardware-verification checklist

**Task:** Phase 1 · V6 · `docs/plans/phase-1-virtual-mvp.md` §3
**Agent:** `calibration`
**Date:** 2026-08-23
**Companion:** [`V6-calibration-and-hardware-checklist.md`](V6-calibration-and-hardware-checklist.md) — the audit and the design
**Machine-readable target:** [`hardware/calibration.json`](../../hardware/calibration.json) · **Validate:** `pnpm validate:calibration`

> **This is a script, not a wish list.** Every step names the exact value it
> settles, the field in `hardware/calibration.json` that value lives in, the
> issue it closes, how long it takes, and what to do if the robot disagrees with
> our CAD-derived assumption. Steps are numbered `V6-00` … `V6-27`; the
> validator refuses any calibration field that points at a step number this
> document does not define.

---

## 1. How to read this

| Column | Meaning |
|---|---|
| **Needs** | `desk` · `bare board` (an ESP32-S2 and a USB cable) · `+ servo` · `+ OLED` · `robot` (a fully assembled quadruped) |
| **Settles** | The field in `hardware/calibration.json` this step fills in |
| **Closes** | The issue it advances or closes |
| **If it contradicts us** | The interesting column. Our values are CAD-derived or datasheet figures; the robot is allowed to disagree, and the point of the layer is that disagreeing is cheap |

### The distinction that may make half of this achievable much sooner

**Thirteen of the twenty-eight steps need no robot at all.** They need an
ESP32-S2 Mini, one loose MG90S servo with a horn, a 0.96" SSD1306 module, a
protractor and a USB cable — call it £15 and a shoebox. Those thirteen steps are
**4 h 25 min** of work and they close the *entirety* of ISSUE-20260823-008 ("nothing
has executed on physical silicon"), which is one of only two `needs hardware`
issues in the project and the one Gate B named "the highest evidence-per-day
item available".

| Track | Steps | Time | What it buys |
|---|---|---|---|
| **A — bare board** | V6-04, V6-05, V6-06, V6-07, V6-08, V6-09, V6-10, V6-11, V6-12, V6-13a, V6-14, V6-15, V6-16 | **4 h 25 m** | All of ISSUE-20260823-008; 6 of the 9 whole-robot calibration fields |
| **B — assembled robot** | V6-01, V6-02, V6-03, V6-17, V6-18, V6-19, V6-20, V6-21, V6-22, V6-24, V6-25, V6-26 | **4 h 50 m** | All of ISSUE-20260823-007; all 72 per-joint calibration fields |
| **Desk** | V6-00, V6-23, V6-27 | **1 h 0 m** | Safety, derivation, close-out |

**Total hands-on: 10 h 15 min** — one long day, or more comfortably two half-days
split exactly along the Track A / Track B line.

Run Track A the day a board arrives. Do not wait for a robot.

---

## 2. Safety

A physical quadruped can fall off a desk, bind a joint against its own body,
stall eight servos at once, or brown out mid-gait and drop. None of that is
hypothetical: **we have never measured a mechanical travel limit**
(`mechanicalLimitsDeg` is `null` on all eight joints), so the very first
full-range command is, by construction, into territory nothing has verified is
reachable.

### S1 · Separate non-motion from motion, and do non-motion first

The checklist is ordered so that **everything that can be learned without a
servo moving is learned first**. Steps V6-00 to V6-16 include exactly one moving
servo, and it is a loose one on the bench with no linkage attached to it.
Nothing on the assembled robot moves until V6-17 has passed.

### S2 · Elevated mode is not optional for V6-17 … V6-22

Before any command reaches an assembled robot, the robot must be **off the
ground**: chassis clamped or cradled so all four feet hang free, with at least
50 mm of clearance below the lowest reachable foot position. The lowest point
in the shipped choreography is **68.65 mm** below the hip plane (V0/V2, measured
in the CAD and reproduced in-browser to 8.9 × 10⁻⁷ mm) — assume worse, because
the mechanical limits are unknown.

A leg that binds while the robot is elevated stalls a servo. A leg that binds
while the robot is standing throws the robot.

### S3 · Emergency stop, tested before it is needed

Two independent stops, both verified *before* the first motion command:

1. **Hardware.** A physically separate supply for the servo rail with an inline
   switch within reach of your non-dominant hand. Cutting servo power must not
   reset the ESP32, so that telemetry keeps flowing and you can see what the
   firmware thought it was doing at the moment you cut it.
2. **Software.** `GET /cmd?stop=` — and know its limits before you rely on it.
   V1 established that a stop is serviced from inside `server.handleClient()`,
   inside `delayWithFace()`, inside `setServoAngle()`, and lands at the next
   `pressingCheck()`. That is *fast*, but it is not instantaneous and it does
   **not** interrupt a single in-flight servo write. Also note ISSUE-20260823-004's
   neighbour behaviour: `/cmd?stop=` does not call `exitIdle()`.

Test both at V6-17 by issuing a stop mid-`wave` and confirming the gait bails.

### S4 · Safe pose limits until V6-22 has run

Until mechanical limits are measured, **command only angles the shipped
choreography commands**. That corpus is 223 literal `setServoAngle()` calls
across 21 movement functions, and it is the only evidence anywhere that a pose
is safe — evidence about the firmware authors' *intent*, not about the
mechanism, but it is what there is. Concretely:

- Hips: stay inside each joint's `observedRangeDeg` in `hardware/joint-map.json`
  (R1 and L2: 90–180; L1: 0–90; R2: 0–100).
- Feet: the corpus uses the full 0–180 on all four. It still gets a slow
  approach, one joint at a time, elevated.
- Never command all eight at once during V6-18 … V6-22. `setPose` writes them
  in channel order with a 20 ms stagger, which is what `motorCurrentDelay`
  exists for; a manual eight-at-once step defeats it.

### S5 · Electrical

- Servo rail and logic rail separate. Eight MG90S stalling together is several
  amps; a brown-out mid-write leaves the horn somewhere nobody commanded.
- Watch the supply current during V6-22. A sweep that finds a mechanical limit
  shows up as a current rise *before* it shows up as a noise.
- Do not leave a stalled servo stalled. If a joint stops moving mid-sweep, cut
  the servo rail first and diagnose second.

### S6 · Two people for V6-22 and V6-24

One person on the keyboard, one with a hand on the robot and a hand on the
switch. V6-22 deliberately drives joints into the unknown; V6-24 is the first
time the robot bears its own weight.

---

## 3. Block 0 — Safety and setup

### V6-00 · Safety brief and workspace

| | |
|---|---|
| **Needs** | desk · **15 min** |
| **Settles** | nothing directly — it is what makes the rest safe |

**Do:** Read §2. Build the elevated cradle (S2). Wire the split supply and the
inline servo-rail switch (S3, S5). Clear 600 mm of bench. Put the protractor,
callipers, magnifier and camera where you can reach them.

**Observe:** That the servo rail switch cuts servo power without resetting the
ESP32 — confirm by watching the UART banner *not* reappear.

**If it contradicts us:** If cutting servo power does reset the board, you have
a shared rail. Fix that before continuing; a reset mid-diagnosis destroys the
evidence you were collecting.

---

### V6-01 · Identity, photographs, and a robot serial

| | |
|---|---|
| **Needs** | robot · **10 min** |
| **Settles** | `meta.robotId`, `session.robotSerial` in a new per-robot `calibration.json` |
| **Closes** | prerequisite for every measured field |

**Do:** Assign this robot a serial — anything stable and unambiguous
(`sesame-001`). Photograph it from directly above with the notch pointing away
from you, from directly below, and from each side. Record the board variant, the
top-cover variant printed, and the firmware profile currently flashed.

**Observe:** Which top cover is fitted. The virtual robot ships the **Cat**
cover, not the recommended `Top-Cover-Enclosed-v117.stl`, because the latter is
not watertight (ISSUE-20260823-006).

**Why it is first:** every `measured: true` field in `hardware/calibration.json`
requires a `robotSerial`. Calibration is per-build: horn offset and subtrim on
`sesame-001` say nothing about `sesame-002`.

**If it contradicts us:** nothing to contradict yet. Start the session record.

---

## 4. Block A — the cheap high-value looks (robot, no motion)

These two steps are the single best minutes in the entire programme: **twenty-five
minutes of looking at a stationary robot closes the last remaining gap in all
eight `semanticName` entries.**

### V6-02 · Read the engravings — part identity on all eight channels

| | |
|---|---|
| **Needs** | robot · **20 min** |
| **Settles** | `joints[*].partIdentity` (8 fields) |
| **Closes** | **ISSUE-20260823-007**; `unresolved:parts-installed-where-drawn` |

**Do:** With the robot unpowered and the notch pointing away from you, trace each
servo lead back to its GPIO on the board and read the engraving on the printed
part that servo drives. Use `hardware/joint-map.json` `pinsByBoard['s2-mini']`
for the mapping: R1→1, R2→2, L1→4, L2→6, R4→8, R3→10, L3→13, L4→14. Record, for
each of the eight channels, the name actually engraved on the part.

Note that on the L-parts the engraving is on the **opposite face** (F5), and
that `L3`/`L4` render mirrored in the build guide's reference image — that is
the geometry, not a rendering bug.

**Observe:** Whether channel *n* drives the part engraved with the name the
firmware calls channel *n*.

**Why this is the whole ball game:** V0 proved from the CAD where the *body
named* `R1` belongs. It cannot prove that the servo on channel 0 drives the
*part engraved* `R1`, because F5 measured R1 ≡ L2, R2 ≡ L1, R3 ≡ L4 and
R4 ≡ L3 as **identical solids**. A builder can swap either pair and neither the
firmware, the CAD, nor the geometry would notice. This is the only remaining
`wouldBeConfirmedBy` item on all eight semantic names.

**Record as:**
```json
"partIdentity": { "value": { "matchesFirmwareName": true, "engravedName": "R1" },
                  "measured": true, "checklistStep": "V6-02", … }
```

**If it contradicts us:** If a channel drives a differently-engraved part, that
is a **finding about this build, not an error in the joint map.** Record
`matchesFirmwareName: false` with the engraved name.
`CalibrationView.semanticNameFor()` will then return `kind: "contradicted"`, and
the app must show the firmware name, not the spatial guess. Do **not** "fix" it
by editing `joint-map.json` — the design is unchanged; this robot is wired to a
different physical part. If it is a build error, note it and decide separately
whether to swap the parts back.

---

### V6-03 · Confirm the physical front/rear cues

| | |
|---|---|
| **Needs** | robot · **5 min** |
| **Settles** | corroborates the canonical frame; no calibration field |
| **Closes** | corroborates V0's `front-rear-orientation` |

**Do:** Find the notch and the USB-C port. The build guide says *"Notch = front.
USB port = back."*; the STEP assembly puts `USB_type_C_smd_12p` at one end and
the OLED screen border at the other.

**Observe:** That the notch, the OLED and the CAD "front" are the same end, and
that the R-engraved parts are on the robot's own right when viewed from above
with the front pointing away.

**If it contradicts us:** If the R parts are on the robot's *left*, stop and
report. That would invert the canonical frame's `right = forward × up` and flip
all eight semantic names — V0's largest single claim. It would also mean the
top-down drawing is a bottom view after all. This is the cheapest possible check
on the most load-bearing geometric conclusion in the project, which is why it
costs five minutes and appears this early.

---

## 5. Block B — bench silicon and bench servo (**no robot required**)

Everything from here to V6-16 needs only a bare ESP32-S2 Mini, one loose servo,
a horn, an SSD1306 module and a protractor. **This block can run months before a
robot exists.**

### V6-04 · Which servo is actually fitted

| | |
|---|---|
| **Needs** | + servo (one loose unit) · **10 min** |
| **Settles** | `robot.servoModel` |
| **Closes** | `unresolved:servo-model-is-sg90-not-mg90s` |

**Do:** Read the label on the servo case. Weigh it (MG90S ≈ 13.4 g, SG90 ≈ 9 g).
If in doubt, remove the horn and look at the output gear: MG90S is metal, SG90 is
nylon.

**Observe:** MG90S, SG90, or something else entirely.

**Why it matters:** the BOM calls for MG90S; the CAD models a Tower Pro SG90.
Same 32.2 × 12 × 30 mm footprint and 27.8 mm ear pitch, so the printed parts fit
either — but the servo shaft datum V0 recorded is the **SG90's**, and the 600 °/s
slew figure the simulator uses is the **MG90S's**. Those two facts currently come
from two different servos.

**If it contradicts us:** If it is an SG90, the datasheet slew is ~0.1 s/60° at
4.8 V too but the torque is a third, and V6-15 will probably find it slower under
load. Record the model; V6-15 and V6-16 supersede the datasheet anyway.

---

### V6-05 · OLED active area, with callipers

| | |
|---|---|
| **Needs** | + OLED module and something to drive it · **15 min** |
| **Settles** | `robot.oledActivePlaneMm` |
| **Closes** | `unresolved:oled-active-plane` (partially resolved) |

**Do:** Drive the panel with an all-pixels-on test pattern. Measure the **lit**
rectangle with callipers, not the glass and not the bezel.

**Observe:** width and height of the lit area, in millimetres.

**Our value:** 23.60 × 11.80 mm. The **23.60 mm width is an exact CAD reading**
of the glass window out of the STEP. The **11.80 mm height is a decision of V2**,
chosen to make the framebuffer a 2:1 rectangle. The CAD glass is 23.60 × 13.70 mm,
and a real 0.96" SSD1306's active area is smaller than its glass, so the face is
probably drawn slightly too large.

**If it contradicts us:** it almost certainly will, and by design — this is the
one number in the asset that was explicitly flagged `inferred` rather than
measured. Record the real numbers. **Note the limitation honestly:** changing
this field does *not* resize the quad in `assets/sesame.glb`, whose geometry is
baked. See V6 findings §5 — resizing the quad is a V2 regeneration, not a
calibration.

---

### V6-06 · Flash `s2mini-instrumented` and see a boot banner

| | |
|---|---|
| **Needs** | bare board · **25 min** |
| **Settles** | nothing numeric — it is the gate on V6-07 … V6-12 |
| **Closes** | first half of **ISSUE-20260823-008** |

**Do:** `node scripts/build-firmware.mjs s2mini-instrumented --clean`, flash it,
attach a serial terminal to **UART0** (not USB CDC). Confirm GPIO 43/44 are
physically broken out on the Lolin S2 Mini you have — Gate B §4 item 4 flags this
as untested.

**Observe:** The hello banner, printed immediately after `Serial.begin()`. Gate B
deliberately moved it there because `display.begin()` hard-fails into `while(1)`
with no OLED present, and anything announced later is never announced.

**Why UART0 specifically:** ISSUE-20260823-015. The first version of the
instrumentation emitted every byte to USB CDC, compiled and linked perfectly, and
was read by nobody. The fix names the port (`#define SESAME_TELEMETRY_PORT Serial0`).
If you see nothing on UART0 but your serial monitor shows output, you are on the
CDC endpoint.

**If it contradicts us:** If GPIO 43/44 are not broken out on your board, use the
`distro-v1-esp32` profile (original ESP32, no USB peripheral, `Serial0` by
default) or solder to the pads. Record which, because the flash-size figures in
`reproducibility.json` are per-profile.

---

### V6-07 · Run the existing parser against a real UART stream

| | |
|---|---|
| **Needs** | bare board · **20 min** |
| **Settles** | nothing numeric — it converts Gate B from a source claim to an observation |
| **Closes** | **ISSUE-20260823-008**, the central item |

**Do:** Point the Phase-0 bridge at the board's UART:
`node emulator/bridge/dist/cli.js --uart-port <serial> --serve-viewer --viewer-dir apps/web/dist`.
Trigger a movement over the firmware's own HTTP API. **Expect zero bridge
changes** — that is the architectural claim Path A validated under Renode and
Q1 validated a second time under QEMU; this would be its third and only
non-emulated confirmation.

**Observe:** `@SESAME servo <joint> <angle>` lines arriving, parsed into
`servo.target` events with `provenance: "observed"`, driving the browser robot.

**Why it is worth the twenty minutes:** every claim in Gate B links 1–4 is a
source-, patch-, binary- or disassembly-level claim. The hooks have **never
executed**. This is the step that changes that sentence.

**If it contradicts us:** If lines arrive garbled, check for the ROM/IDF console
interleaving its own bytes on the same wire (Gate B §4 item 4). The parser is
designed to survive it — non-sentinel text becomes `log`/`uart` events — but that
survival has never been observed. Record what interleaving actually looks like;
it is a protocol finding, not a bug.

---

### V6-08 · `Serial0.printf` timing, and the real loop quanta

| | |
|---|---|
| **Needs** | bare board · **30 min** |
| **Settles** | `robot.spinQuantumMs`, `robot.loopQuantumMs` |
| **Closes** | **ISSUE-20260823-008** (timing); `unresolved:simulated-loop-quanta` |

**Do:** Two measurements from one run.

1. **Printf inside the budget.** Toggle a spare GPIO immediately before and after
   `sesameEmitServo()` and scope it, or bracket it with `micros()` and print the
   delta on a later line. The question is whether the telemetry printf completes
   inside the 20 ms `motorCurrentDelay` without perturbing servo timing. At
   115 200 baud a `servo` line is ~1.7 ms of wire time — that is arithmetic;
   whether the call *blocks* for it is not.
2. **The loop quanta.** Count iterations of `pressingCheck()` and of `loop()` per
   100 ms window. Both spin on a bare `yield()` with **no delay at all**, unlike
   `delayWithFace()` whose `delay(5)` is a genuine firmware constant.

**Observe:** microseconds per telemetry line; iterations per second in each spin
loop.

**Our values:** `spinQuantumMs = 1` and `loopQuantumMs = 1` are **simulation
choices with no firmware period behind them** — V1 says so explicitly. They were
picked so a face frame flips within a millisecond of when it is due while costing
100 iterations per 100 ms instead of a million.

**If it contradicts us:** The real loops will almost certainly iterate far faster
than 1 kHz. That is fine and does not make the simulator wrong — but record the
real figure, because it tells you how much finer a `spinQuantumMs` would have to
be to change any observable behaviour, and therefore whether 1 ms is a *safe*
approximation or a *lucky* one. If the printf exceeds 20 ms, the servo stagger is
being driven by telemetry rather than by `motorCurrentDelay`, which is a real
defect in the instrumentation and would need a rate limit or a bigger buffer.

---

### V6-09 · Hook re-entrancy

| | |
|---|---|
| **Needs** | bare board · **20 min** |
| **Settles** | nothing numeric |
| **Closes** | **ISSUE-20260823-008** (re-entrancy) |

**Do:** Run an animated face (`happy`, 8 fps) *during* a movement, so the face
hook fires from inside `updateFaceBitmap()`, which runs re-entrantly out of
`delayWithFace()`, which is itself called from inside `setServoAngle()` — which
is where the servo hook lives.

**Observe:** No deadlock, no reordering, no interleaved half-lines. Check the
event ordering against what `@sesame-lab/sesame-sim` produces for the same
movement: V1's `scheduling.test.ts` asserts face animation advancing *inside* a
servo delay, so there is a reference stream to compare against.

**If it contradicts us:** Interleaved partial lines mean the emit is not atomic
with respect to the re-entrant call. The parser will turn the fragments into
`log` events rather than dropping them, so nothing breaks loudly — which is
exactly why this must be looked for deliberately rather than waited for.

---

### V6-10 · UART saturation on the densest choreography

| | |
|---|---|
| **Needs** | bare board · **20 min** |
| **Settles** | nothing numeric |
| **Closes** | **ISSUE-20260823-008** (wire rate) |

**Do:** Run `runDancePose` and `runWalkPose` with `walkCycles` at its default 10.
These issue writes faster than the wave fixture the bridge was developed against.

**Observe:** Whether any `@SESAME` line is truncated or dropped, and whether the
servo stagger visibly lengthens (which would mean the UART is back-pressuring the
motion).

**Arithmetic to beat:** ~1.7 ms per `servo` line at 115 200 baud against a 20 ms
budget per write. It should fit with 10× headroom. Gate B was explicit that this
is arithmetic today and an observation only on silicon.

**If it contradicts us:** Raise the baud rate before touching the emit rate —
the wire format is the contract and the bridge auto-detects nothing, so a baud
change is one config value in `emulator/bridge`. Record the observed line rate.

---

### V6-11 · The OLED framebuffer hook, enabled for the first time ever

| | |
|---|---|
| **Needs** | bare board + OLED · **30 min** |
| **Settles** | nothing numeric |
| **Closes** | **ISSUE-20260823-008** (OLED hook) |

**Do:** Build with the OLED hook compile flag enabled, flash, and capture
`@SESAME oled b64 …` lines. Feed them through
`@sesame-lab/sesame-protocol`'s `decodeOledFrame` and compare, byte for byte,
against the framebuffer `apps/web` produces for the same face.

**Observe:** a 1368-character base64 payload decoding to 1024 bytes of
page-ordered GDDRAM, identical to the virtual OLED's.

**Why it has never run:** EXP6 verified the hook at compile, ELF and parser level
and round-tripped a byte-identical 1024 B framebuffer — but the literal is
verifiably *absent* from the default build, which is simultaneously the proof
that the compile gate works and the proof that the hook is untested. It also
costs ~1.4 KB of `.bss`, and the app slot is 86.3 % full.

**If it contradicts us:** If the bytes differ, the interesting case is
`setFace("stand")`: it must emit **nothing at all** and leave the panel showing
the previous face, because `epd_bitmap_stand` is a weak undefined symbol
(ISSUE-20260823-004). If the real panel blanks instead of retaining, the app's
model of the bug is wrong and V4's retention behaviour needs revisiting.

---

### V6-12 · ESP32Servo #103 — the cross-channel write leak

| | |
|---|---|
| **Needs** | bare board + 2 servos · **30 min** |
| **Settles** | nothing numeric |
| **Closes** | **ISSUE-20260823-008** (item 7) |

**Do:** Attach two servos on two channels sharing a timer. Command channel A
repeatedly while channel B holds a fixed angle. Watch B.

**Observe:** whether B moves when only A is written.

**Why it is load-bearing:** F3 pinned ESP32Servo to 3.0.9 on the strength of this
upstream report without testing it. If the bug is real in newer versions, it
corrupts *exactly* the signal the telemetry hooks report — the hooks would say
one thing and the servos do another, and every downstream verification would be
measuring the wrong quantity.

**If it contradicts us:** If B moves, the pin is justified and must be documented
as load-bearing rather than cautious. If B does not move on 3.0.9 **or** on the
latest version, the pin can be relaxed and F3's note should say so.

---

### V6-13 · Power-on horn position

| | |
|---|---|
| **Needs** | **13a:** + servo · **13b:** robot · **15 min total** |
| **Settles** | `robot.powerOnCommandedDeg`, `joints[*].powerOnCommandedDeg` |
| **Closes** | **ISSUE-20260823-007**; `unresolved:power-on-servo-angle` |

**Do, 13a (bench, no robot):** Fit a horn to a loose servo at a known position.
Power-cycle the board with firmware that attaches the servo (`attach(pin, 732,
2929)` — the call as written; the library clamps the max to 2500 µs, V6-14) and
issues no command — which is exactly what `setup()` does. Measure
where the horn ends up, with a protractor. Repeat three times from three
different starting positions.

**Do, 13b (robot):** Same, on the assembled robot, reading all eight link angles.

**Observe:** Does the horn hold where it was, snap to a fixed angle, or drift?
Is the answer the same from every starting position?

**Our value:** `90`, and V1 is unusually blunt about it: *"genuinely
undetermined… `setup()` attaches and deliberately does not command"*, and *"the
one V1 value that would be settled in about ten seconds by a physical robot and
a protractor"*. 90 is used only because `RobotState.commandedDeg` is a required
`number` and 90 is the assembly datum. `apps/web` deliberately shows `null`
instead.

**If it contradicts us:** Any of the three outcomes is informative and none is a
problem:
- *Holds position* → `powerOnCommandedDeg` is genuinely per-power-cycle and
  should stay `null` per joint; record that as the measured finding.
- *Snaps to a fixed angle* → record it. If it is not 90, the simulator's default
  is wrong in a way that matters for the first frame a UI draws.
- *Drifts* → record the drift; it is a servo-quality observation worth having
  before anyone builds a pose editor.

---

### V6-14 · Angle gain — does 732…2500 µs really mean 0…180°? (and is there a pulse at all?)

| | |
|---|---|
| **Needs** | + servo, horn, protractor · **20 min** · **+ logic analyser or scope for 14b, 15 min** |
| **Settles** | `robot.angleGainDegPerCommandedDeg`; **ISSUE-20260824-024** |
| **Closes** | `unresolved:servo-angle-gain`; **ISSUE-20260824-024** |

> **Corrected 2026-08-24 (Q3, `docs/findings/Q3-ledc-fidelity.md` §6.2):** this step was titled
> "does 732…**2929** µs really mean 0…180°". **2929 µs is never emitted.** `ESP32Servo::attach()`
> clamps the requested maximum to `MAX_PULSE_WIDTH` 2500 (`ESP32Servo.h:98`, applied at
> `ESP32Servo.cpp:126`) before storing it, so the effective window is **732…2500 µs**, and after
> 10-bit quantisation the pulses actually emitted are **722.65625…2500 µs** in 19.53125 µs steps.
> Measure against 2500, not 2929, or the gain will come out ~17 % low and be recorded as a servo
> property.

**Do, 14a (gain):** Command 0, then 90, then 180. Measure the horn angle at each
with a protractor mounted against the servo case.

**Observe:** the total swept angle, and whether 90 lands halfway.

**Our value:** exactly **1.0** shaft degree per commanded degree. This is an
*assumption*, and V0 states it explicitly as one of the two things its
absolute-rotation-sense fit depends on. The **effective** pulse window
`732…2500 µs` is still not the library default (500…2500 µs), so it is worth
checking rather than assuming somebody calibrated it.

**Do, 14b (the pulse itself — the only step in this document that can settle
ISSUE-20260824-024):** Put a logic analyser or scope on one servo signal pin
with the firmware attached and holding an angle. This is the **only** available
route to a waveform: Q3 established that QEMU's LEDC device models the duty
*ratio* correctly and has no timer, no output wire and no consumer — no pulse,
no edge, no 50 Hz — so nothing under emulation can confirm one, and no emulator
known to this project generates real LEDC waveforms.

**Observe, 14b:** four things, each of which is currently an inference:
- **A pulse exists at all** on the pin. Everything downstream of
  `setServoAngle()` assumes it.
- **Frame period ≈ 20.000 ms** (50.000 Hz). The register file says the firmware
  configured `REF_TICK` 1 MHz ÷ 19.53125 ÷ 2¹⁰ = 50.000 Hz exactly; nothing has
  seen it happen.
- **High time at 0° / 90° / 180° = 722.7 / 1601.6 / 2500.0 µs**, ±19.53 µs.
  Anything near 2929 µs at 180° falsifies the clamp finding; anything near
  732 µs at 0° rather than 722.7 µs falsifies the quantisation finding.
- **Two adjacent commands are indistinguishable.** Command 89° and then 90° and
  confirm the high time does not change — 89 of the 181 commandable angles alias
  onto a neighbour (`quantiseCommandedAngle()` in `@sesame-lab/sesame-model`
  says which). If they *do* differ, the 10-bit resolution finding is wrong.

**If 14b contradicts us:** any of the four is a first-class finding. A pulse at
2929 µs would mean the library clamp was misread; distinguishable neighbours
would mean the timer width is not 10 bits on this build. Record the trace, and
update `hardware/hardware-map.json` → `servos.servoConfig.attachPulseClamp` /
`pulseQuantisation` — those fields exist precisely so this measurement has
somewhere to land.

**If it contradicts us:** If the sweep is, say, 172° rather than 180°, the gain
is 0.956 and *every* body-relative angle the project computes is off by up to 4°
at the extremes. Record it; `CalibrationView.rigRotationDeg()` already multiplies
by this field, so the virtual robot corrects itself the moment the value lands.
V0's sign fit is unaffected — a gain error scales the fit but cannot flip its
sign.

---

### V6-15 · Slew rate, unloaded

| | |
|---|---|
| **Needs** | + servo · **20 min** |
| **Settles** | `robot.slewDegPerSec` |
| **Closes** | `unresolved:servo-model` |

**Do:** Command a 60° step (90 → 150) and time it. Best method with no scope: a
phone camera at 240 fps, counting frames. Repeat at 4.8 V and at 6 V if your
supply allows.

**Observe:** milliseconds per 60°, at each voltage.

**Our value:** **600 °/s**, which is the MG90S **datasheet** figure (0.1 s / 60°
at 4.8 V) with no load, no gear backlash and no supply sag. V1 flags it as *"the
simulation choice most likely to be mistaken for a measurement"*. Nobody has
timed this robot's servos.

**If it contradicts us:** Expect it to. Record the unloaded figure here; V6-25
re-measures under the robot's own weight, and **that** is the number a simulator
should use. `slewDegPerSec` drives `simulatedDeg` only — `measuredDeg` stays
`null` regardless, because the stock robot has no position feedback at all.

---

### V6-16 · Horn spline: count the teeth

| | |
|---|---|
| **Needs** | + servo, magnifier · **10 min** |
| **Settles** | `robot.hornSplineTeeth` |
| **Closes** | `unresolved:horn-spline-quantisation` (the quantum half) |

**Do:** Remove the horn. Count the teeth on the output shaft under
magnification. Then fit the horn in each of two adjacent positions and measure
the angular step with a protractor.

**Observe:** tooth count, and the measured angular step.

**Our value:** **20 teeth → an 18° quantum → ±9° worst case**, quoted throughout
F6 and V0 as the reason `semanticName` and `zeroReferenceDeg` cannot be exact on
a built robot. It is a specification, not a count.

**If it contradicts us:** A 21- or 25-tooth spline changes the quantum and
therefore every "±9°" caveat in the repository. Record it; the caveat text in
`hardware/calibration.json` is generated from this field, and
`CalibrationView.hornSplineQuantumDeg` recomputes from it.

---

## 6. Block C — the assembled robot, elevated

**Nothing below this line runs until §2 S2 and S3 have been satisfied.**

### V6-17 · Elevate, secure, and prove the stops

| | |
|---|---|
| **Needs** | robot · **20 min** |
| **Settles** | nothing — it is the gate on V6-18 … V6-22 |

**Do:** Mount the robot in the cradle with all four feet free and ≥50 mm of
clearance. Power the logic rail; leave the servo rail off. Confirm telemetry and
the HTTP API are up with no servo power. Then power the servo rail.

Issue `wave`, and **while it is running**, (a) send `GET /cmd?stop=` and (b)
separately, on a second run, hit the servo-rail switch.

**Observe:** the gait bails out and runs the closing stand pose (software stop);
all motion ceases instantly and telemetry keeps flowing (hardware stop).

**If it contradicts us:** If the software stop does not land mid-gait, do not
proceed to V6-22 relying on it. The hardware stop is the one that must work.

---

### V6-18 · Absolute rotation sense, all eight joints

| | |
|---|---|
| **Needs** | robot, elevated · **20 min** |
| **Settles** | `joints[*].rotationSenseSign`, `joints[*].directionSign` (16 fields) |
| **Closes** | **ISSUE-20260823-007** |

**Do:** One joint at a time, from the rest pose: command 90, then 135, and watch.
Then 90, then 45. Note the direction of travel of the *child* link relative to
the body, using the canonical frame (+Y up, −Z forward, +X the robot's own
right).

**Observe:** For each joint, whether the child link rotates positively or
negatively about the joint's axis by the right-hand rule.

**Our value:** `childRotationDeg = −1 × (commandedDeg − 90)` on the four hips and
`+1 × (commandedDeg − 90)` on the four knees. V0 fitted this **exactly** over the
CAD horn occurrences — offset solved for, not assumed, and it came out at zero —
so this is a high-confidence prediction, not a coin flip. F6 had listed it as
needing a robot; V0 closed it from the CAD. This step is the independent check.

Also confirm the bookkeeping half: the two members of each shape class
(`{R1, L2}`, `{R2, L1}`, `{R3, L4}`, `{R4, L3}`) must move in *opposite* absolute
directions for the same commanded delta, because they are the same printed solid
installed at diagonally opposite corners.

**If it contradicts us:** A single joint disagreeing is most likely a horn fitted
180° out — check V6-19 before concluding anything. **All eight** disagreeing
means V0's identification of the CAD pose as `runStandPose` is wrong, which
would be a significant finding and should be reported before any further
calibration. Record the measured signs either way; the GLB's baked
`signPerCommandedDeg` is *not* rewritten by this (see V6 findings §5) — the
calibration layer corrects the pose at the call site instead.

---

### V6-19 · Rest-pose geometry — is the hip really parallel to the body?

| | |
|---|---|
| **Needs** | robot, elevated · **15 min** |
| **Settles** | corroborates `zeroReferenceDeg`; feeds V6-20 |
| **Closes** | corroborates V0's `rest-pose-hip-orientation-contradiction` |

**Do:** Command 90 on all eight (that is `runRestPose`, one loop in
`movement-sequences.h:74`). Photograph from directly above with the notch away
from you. Lay a straight edge along the body's long axis.

**Observe:** whether each leg points along the body's long axis — front legs
forward, rear legs rearward — and by how many degrees each one is off.

**Our value:** **0.000° off** on all four, from V0. This settled a contradiction
F6 recorded between the build guide's prose ("at Rest the hip joint should move
perfectly parallel to the body") and `sesame-angle-guide.png`, which draws each
hip's 90° ray pointing laterally. V0 found the prose right and F6's guessed
reconciliation backwards.

**If it contradicts us:** A per-leg offset here **is the horn-spline offset** and
it is the input to V6-20 — expect up to ±9° per leg and do not treat it as an
error. A *systematic* 90° offset on all four means the horns were all fitted at
the lateral position the angle guide draws, in which case the build, not the
model, is the thing that diverged.

---

### V6-20 · Zero, horn offset and subtrim — the twiddle-until-it-matches step

| | |
|---|---|
| **Needs** | robot, elevated · **45 min** |
| **Settles** | `joints[*].zeroReferenceDeg`, `joints[*].hornSplineOffsetDeg`, `joints[*].servoSubtrimDeg` (24 fields) |
| **Closes** | **ISSUE-20260823-007**; `unresolved:horn-spline-quantisation`, `unresolved:per-robot-subtrim` |

**Do:** Per joint, in channel order:

1. Command 90 with subtrim at zero. Measure the link angle against the reference
   geometry from V6-19. **That residual is `hornSplineOffsetDeg`** — record it
   before correcting anything. This is the one number that is destroyed by
   trimming first, so it must be captured first.
2. Trim the channel with the serial command `subtrim <0-7> <value>` (or `st`)
   until the link sits at the reference angle. **That value is
   `servoSubtrimDeg`.**
3. Read all eight back with `subtrim save`, which prints a C initialiser. Copy
   the numbers into the calibration document — do **not** paste them into
   firmware source, which is what upstream intends and what would take them out
   of the data layer.

**Observe:** eight residuals and eight trims. Sanity check: each residual should
be within ±(360/teeth)/2 of zero, per V6-16.

**Our values:** `zeroReferenceDeg = 90` on all eight (inferred by F6 from four
independent places, never measured); `servoSubtrimDeg = 0` (the firmware
default); `hornSplineOffsetDeg = 0` (the no-information default, not a finding).

**If it contradicts us:** A residual larger than the spline quantum means the
horn is not merely one tooth out — check for a bent linkage or a mis-assembled
leg before trimming it away. A required subtrim beyond ±20° is worth
investigating rather than accepting: the firmware clamps `angle + subtrim` to
0–180, so a large trim silently costs you range at one end.

**Note the persistence trap:** the stock firmware keeps subtrim in RAM only and
never writes it to NVS. On this robot, subtrim is lost at every power cycle
unless it is in the calibration document and re-applied. That is precisely why
this layer exists.

---

### V6-21 · Stand pose against the CAD

| | |
|---|---|
| **Needs** | robot, elevated · **20 min** |
| **Settles** | validates V6-18 + V6-20 together |

**Do:** With the calibration from V6-20 applied, command `runStandPose`.
Photograph from above and from the side. Measure the splay angle of each leg and
the foot orientation.

**Observe:** all four legs splayed **45°** outward from the body axis, all four
feet **exactly vertical**.

**Our value:** V0 measured the CAD in this pose: all four hip horns at exactly
±45.000° from case neutral, all four feet exactly vertical, and the ground plane
at −68.650 mm below the hip plane. `apps/web` reproduces the quaternions to
0.000° and the ground plane to 8.9 × 10⁻⁷ mm.

**If it contradicts us:** A leg that is close but not right means a residual
calibration error — go back to V6-20 for that joint. A leg that is grossly wrong
after V6-18 and V6-20 both passed means the femur↔foot mate is not what the CAD
says (V0 measured a 317.7× separation on that pairing, so this would be a real
surprise).

---

### V6-22 · Mechanical travel limits

| | |
|---|---|
| **Needs** | robot, elevated, **two people** · **60 min** |
| **Settles** | `joints[*].mechanicalLimitsDeg` (8 fields) |
| **Closes** | **ISSUE-20260823-007**; `unresolved:joint-zero-sign-and-limits` |

**Do:** One joint at a time, all others at rest. Step outward from 90 in **5°
increments**, pausing at each. Watch the supply current. Stop at the first of:
audible strain, visible binding, a current rise, or the firmware clamp.

Repeat in the other direction. Then repeat with the *neighbouring* joint at each
extreme of its own range, because a knee's limit depends on where its hip is.

**Observe:** per joint, the largest and smallest commanded angle reachable
without strain — and note whether it is pose-dependent.

**Our value:** `null` on all eight, and the validator currently *forbids* filling
it in in the joint map. The firmware clamp is 0–180 and is authoritative, but it
is **not** a travel limit; nothing in the repository says the printed linkage can
reach both ends at every pose.

**If it contradicts us:** There is nothing to contradict — this is a genuine
first measurement. The likely finding is that limits are **pose-dependent**, in
which case record the conservative intersection in `mechanicalLimitsDeg` and note
the coupling in the field's `note`. If a limit falls inside the shipped
choreography's `observedRangeDeg`, that is a significant finding: the firmware
commands a pose the mechanism cannot reach, and it should be reported upstream.

**Safety:** this is the step that deliberately drives into the unknown. Hand on
the switch throughout.

---

### V6-23 · Derive and record safe travel ranges

| | |
|---|---|
| **Needs** | desk · **15 min** |
| **Settles** | `joints[*].safeTravelDeg` (8 fields) |

**Do:** From V6-22, subtract a margin (5° is reasonable; more where the limit was
pose-dependent) and record the result.

**Observe:** whether the safe range still contains the whole shipped
choreography. It should.

**If it contradicts us:** If a shipped movement leaves the safe range, do not
narrow the choreography in `hardware-map.json` — that file is an extraction of
what the firmware *does*, and editing it to say something nicer would break the
one rule this project has. Record the conflict and handle it in the consumer.

---

## 7. Block D — the assembled robot, on the ground

### V6-24 · Walk direction versus the drawn front

| | |
|---|---|
| **Needs** | robot, floor, **two people** · **15 min** |
| **Settles** | `robot.walkDirectionMatchesDrawnFront` |
| **Closes** | **ISSUE-20260823-007**; `unresolved:walk-direction-vs-drawn-front` |

**Do:** Put the robot on a non-slip floor in the stand pose. Mark its position.
Run `forward`. Watch which end leads.

**Observe:** whether the notch/OLED end is the leading end.

**Our value:** `null`. The CAD fixes which end of the chassis is which — USB-C
aft, OLED and notch forward — but says nothing at all about which way the gait
travels. Assuming a quadruped walks toward its face is exactly the kind of
plausible inference this project refuses to make, which is why the field is
`null` rather than `true`.

**If it contradicts us:** If it walks backwards relative to the drawn front, the
semantic names are still correct as *positions* but `*_front_*` means "the OLED
end", not "the leading edge". Record it and say so in the UI; do not rename the
joints. This is the second of the two `wouldBeConfirmedBy` items on every
`semanticName`, and it does not invalidate the first.

---

### V6-25 · Full choreography, and slew under load

| | |
|---|---|
| **Needs** | robot, floor · **30 min** |
| **Settles** | `robot.slewDegPerSec` (the loaded figure — supersedes V6-15) |

**Do:** Run all 21 movement functions in sequence with telemetry captured. Then
time a 60° hip step with the robot bearing its own weight, at 240 fps.

**Observe:** the loaded slew figure; any movement that binds, drops the robot, or
draws unexpected current; whether `runDeadPose` really does leave it collapsed
and `runShrugPose` really does show two faces.

**If it contradicts us:** the loaded figure will be slower than V6-15's, which
will be slower than the 600 °/s datasheet number. Record the loaded one — it is
the one a simulator should use. Note that this changes `simulatedDeg` only;
`measuredDeg` stays `null` forever on this hardware.

---

### V6-26 · End to end: real robot → bridge → browser

| | |
|---|---|
| **Needs** | robot + board · **30 min** |
| **Settles** | nothing numeric — it is the proof the chain holds |
| **Closes** | the last of **ISSUE-20260823-008** |

**Do:** With the calibration document loaded (`$env:SESAME_CALIBRATION`), run the
bridge against the real robot's UART and open `apps/web`. Run `wave`.

**Observe:** eight joints moving in the browser under `provenance: "observed"`,
with the *virtual* robot's pose matching the *physical* robot's pose — which is
what the calibration was for. Re-run `pnpm capture:web`.

**If it contradicts us:** If the virtual robot is mirrored, a sign is wrong — go
back to V6-18. If it is offset, a zero or a subtrim is wrong — V6-20. If it is
scaled, the gain is wrong — V6-14. The three failure modes are visually
distinguishable, which is why the fields are separate.

---

### V6-27 · Close out

| | |
|---|---|
| **Needs** | desk · **30 min** |
| **Settles** | the document itself |

**Do:**

1. Write the per-robot document to `hardware/calibration.<robotId>.json` with a
   populated `session` block. **Do not overwrite
   `hardware/calibration.json`** — that file is the generated reference and the
   validator refuses `measured: true` in it.
2. `node scripts/validate-calibration.mjs hardware/calibration.<robotId>.json`.
3. Update `docs/issues.yaml`: ISSUE-20260823-007 and ISSUE-20260823-008 with
   what was and was not settled.
4. For any field where the robot contradicted the CAD, write it up as a
   correction in `docs/findings/`, not as a silent data edit. V0 §2 is the model
   for how to do that.
5. Re-run `pnpm -r test` and every validator. The joint map should still pass
   unchanged — calibration layers over it and never edits it.

---

## 8. Summary tables

### By what it settles

| Calibration field | Count | Step | Time | Needs |
|---|---|---|---|---|
| `joints[*].partIdentity` | 8 | V6-02 | 20 m | robot |
| `robot.servoModel` | 1 | V6-04 | 10 m | servo |
| `robot.oledActivePlaneMm` | 1 | V6-05 | 15 m | OLED |
| `robot.spinQuantumMs`, `robot.loopQuantumMs` | 2 | V6-08 | 30 m | board |
| `robot.powerOnCommandedDeg`, `joints[*].powerOnCommandedDeg` | 9 | V6-13 | 15 m | servo / robot |
| `robot.angleGainDegPerCommandedDeg` | 1 | V6-14 | 20 m | servo |
| `robot.slewDegPerSec` | 1 | V6-15 → V6-25 | 20 m | servo → robot |
| `robot.hornSplineTeeth` | 1 | V6-16 | 10 m | servo |
| `joints[*].rotationSenseSign`, `joints[*].directionSign` | 16 | V6-18 | 20 m | robot |
| `joints[*].zeroReferenceDeg`, `hornSplineOffsetDeg`, `servoSubtrimDeg` | 24 | V6-20 | 45 m | robot |
| `joints[*].mechanicalLimitsDeg` | 8 | V6-22 | 60 m | robot |
| `joints[*].safeTravelDeg` | 8 | V6-23 | 15 m | desk |
| `robot.walkDirectionMatchesDrawnFront` | 1 | V6-24 | 15 m | robot |
| **Total** | **81** | | | |

### By issue

| Issue | Steps | Fully closed by |
|---|---|---|
| **ISSUE-20260823-007** — ten joint-map facts | V6-02, V6-03, V6-13, V6-14, V6-18, V6-19, V6-20, V6-22, V6-24 | end of V6-24 |
| **ISSUE-20260823-008** — nothing on silicon | V6-06, V6-07, V6-08, V6-09, V6-10, V6-11, V6-12, V6-26 | end of V6-26 (V6-06…V6-12 alone need **no robot**) |
| **ISSUE-20260823-006** — top cover not watertight | V6-01 records which cover is fitted | not closed here; it is a mesh-repair task |

### Hour by hour, both tracks available

| Clock | Steps |
|---|---|
| 0:00 – 0:25 | V6-00, V6-01 |
| 0:25 – 0:50 | V6-02, V6-03 — **the eight semantic names close here** |
| 0:50 – 1:15 | V6-04, V6-05 |
| 1:15 – 2:30 | V6-06, V6-07, V6-08 |
| 2:30 – 4:10 | V6-09, V6-10, V6-11, V6-12 |
| 4:10 – 5:15 | V6-13, V6-14, V6-15, V6-16 |
| 5:15 – 5:35 | V6-17 — **first motion on the assembled robot** |
| 5:35 – 6:55 | V6-18, V6-19, V6-20 |
| 6:55 – 8:15 | V6-21, V6-22 |
| 8:15 – 8:30 | V6-23 |
| 8:30 – 9:15 | V6-24, V6-25 |
| 9:15 – 9:45 | V6-26 |
| 9:45 – 10:15 | V6-27 |

Ten and a quarter hours of hands-on work, allow twelve with breaks and surprises. **The first
hour and a half is worth more than the other eight and a half**: V6-02 alone
closes the last open question behind all eight semantic names, and V6-06 to
V6-08 convert the strongest unverified claim in the whole project — Gate B's
"YES, via instrumented firmware" — from a disassembly-level argument into an
observation.
