#!/usr/bin/env node
/**
 * Generates hardware/source-annotations.json — the DATA LAYER for the Phase 2
 * source explorer (research report, "Code exploration").
 *
 * The report is explicit that arbitrary C++ must NOT be explained by an LLM at
 * runtime. Instead we maintain annotation metadata against a pinned commit.
 * This script is that maintenance step: it re-reads the pinned firmware tree,
 * locates every annotated symbol by an ANCHOR STRING (never by a hand-typed
 * line number), derives end lines by C++-aware brace matching, and copies the
 * exact source text of the first and last line into the output so a validator
 * can re-read and compare it.
 *
 * EPISTEMIC CONTRACT
 *   - Every symbol, concept and teaching note resolves to file:line inside
 *     firmware/upstream/ at meta.upstreamCommit.
 *   - `description` is a statement about what the CODE DOES, checkable against
 *     the cited lines. Anything that is a judgement lives in `commentary[]`
 *     and is labelled as such.
 *   - NO HARDWARE CLAIMS. Per docs/plan.md "Standing constraint — no physical
 *     hardware, ever", nothing here may say a servo moved, only that the code
 *     commanded an angle.
 *   - Entities that hardware/hardware-map.json already owns (pins, movement
 *     choreography, route tables, boot order, face registry) are REFERENCED BY
 *     KEY through `crossRefs`, never restated.
 *
 * Sources of truth:
 *   firmware/upstream.pin.json     the commit every citation resolves into
 *   firmware/upstream/**           the pinned tree (read-only)
 *   hardware/hardware-map.json     F4's boundary inventory — cross-referenced
 *   the curated tables below       descriptions, vocabulary, curriculum spine
 *
 * Deterministic: two runs against the same tree with the same --generated-at
 * produce byte-identical output.
 *
 * Usage:
 *   node scripts/build-source-annotations.mjs [--out hardware/source-annotations.json]
 *                                             [--generated-at 2026-08-25T00:00:00Z]
 *                                             [--check]
 *
 * --check re-derives everything and diffs against the checked-in file,
 * ignoring meta.generatedAt. Exit 1 if stale.
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, relative, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..');
const rel = (p) => relative(repoRoot, p).replaceAll('\\', '/');

const argv = process.argv.slice(2);
const argOf = (name, dflt) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt;
};
const CHECK = argv.includes('--check');
const OUT = resolve(repoRoot, argOf('--out', 'hardware/source-annotations.json'));
const GENERATED_AT = argOf('--generated-at', new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'));

const readJson = (p) => JSON.parse(readFileSync(resolve(repoRoot, p), 'utf8'));

const die = (msg) => { console.error(`FAIL  ${msg}`); process.exit(1); };

// --------------------------------------------------------------------------
// 0. Pinned tree
// --------------------------------------------------------------------------
const PIN = readJson('firmware/upstream.pin.json');
const HW = readJson('hardware/hardware-map.json');

if (HW.meta.sourceTree.upstreamCommit !== PIN.commit) {
  die(`hardware-map.json pins ${HW.meta.sourceTree.upstreamCommit} but firmware/upstream.pin.json pins ${PIN.commit}`);
}

const TREE = resolve(repoRoot, 'firmware/upstream');
if (!existsSync(join(TREE, 'firmware/sesame-firmware-main.ino'))) {
  die(`pinned firmware tree not materialised at ${rel(TREE)} — run scripts/fetch-upstream.ps1 (or .sh) first`);
}

const INO = 'firmware/sesame-firmware-main.ino';
const MOV = 'firmware/movement-sequences.h';
const FACES = 'firmware/face-bitmaps.h';
const PORTAL = 'firmware/captive-portal.h';

const fileCache = new Map();
function lines(file) {
  if (!fileCache.has(file)) {
    const p = join(TREE, file);
    if (!existsSync(p)) die(`annotated file ${file} does not exist under ${rel(TREE)}`);
    const raw = readFileSync(p, 'utf8');
    // Trailing newline produces a final empty element; drop it so counts match
    // "number of lines of text", the same convention hardware-map.json uses.
    const arr = raw.split(/\r?\n/);
    if (arr.length && arr[arr.length - 1] === '') arr.pop();
    fileCache.set(file, arr);
  }
  return fileCache.get(file);
}
const sha256File = (file) => createHash('sha256').update(readFileSync(join(TREE, file))).digest('hex');
const lineText = (file, n) => {
  const L = lines(file);
  if (n < 1 || n > L.length) die(`${file}:${n} is out of range (file has ${L.length} lines)`);
  return L[n - 1].replace(/\s+$/, '');
};

/**
 * Locate the line containing `needle`. Unique by default: 0 or >1 hits is a
 * hard failure, so a source edit that duplicates an anchor is caught rather
 * than silently re-pointed. `occurrence: <1-based n>` opts into a repeated
 * anchor deliberately (e.g. the six identical pressingCheck() guards inside
 * runWalkPose) and still fails if that occurrence does not exist.
 */
function locate(file, needle, occurrence = null) {
  const L = lines(file);
  const hits = [];
  for (let i = 0; i < L.length; i++) if (L[i].includes(needle)) hits.push(i + 1);
  if (hits.length === 0) die(`anchor not found in ${file}: ${JSON.stringify(needle)}`);
  if (occurrence !== null) {
    if (hits.length < occurrence) die(`anchor in ${file} has only ${hits.length} occurrence(s), wanted #${occurrence}: ${JSON.stringify(needle)}`);
    return hits[occurrence - 1];
  }
  if (hits.length > 1) die(`anchor is ambiguous in ${file} (lines ${hits.join(', ')}): ${JSON.stringify(needle)}`);
  return hits[0];
}

/** First line at or after `from` containing `needle`. */
function locateAfter(file, needle, from) {
  const L = lines(file);
  for (let i = from - 1; i < L.length; i++) if (L[i].includes(needle)) return i + 1;
  die(`end anchor not found in ${file} at or after line ${from}: ${JSON.stringify(needle)}`);
}

/**
 * C++-aware brace matcher. Scans forward from `startLine`, skipping line
 * comments, block comments, string literals and character literals, and
 * returns the line holding the brace that closes the first `{` it sees.
 *
 * The string/char skipping is insurance, not decoration: loop() prints the
 * literals "int8_t servoSubtrim[8] = {" and "};" (ino:835, :840). On THIS commit
 * they happen to balance, so a naive counter gets the same answer — but an
 * unbalanced brace inside a future string literal would silently truncate the
 * largest function in the file, and nothing downstream would notice.
 */
function braceEnd(file, startLine) {
  const L = lines(file);
  let depth = 0;
  let seen = false;
  let inBlockComment = false;
  for (let i = startLine - 1; i < L.length; i++) {
    const s = L[i];
    for (let j = 0; j < s.length; j++) {
      const c = s[j];
      const d = s[j + 1];
      if (inBlockComment) {
        if (c === '*' && d === '/') { inBlockComment = false; j++; }
        continue;
      }
      if (c === '/' && d === '/') break;                 // rest of line is a comment
      if (c === '/' && d === '*') { inBlockComment = true; j++; continue; }
      if (c === '"') {                                    // string literal
        j++;
        while (j < s.length && s[j] !== '"') { if (s[j] === '\\') j++; j++; }
        continue;
      }
      if (c === "'") {                                    // char literal
        j++;
        while (j < s.length && s[j] !== "'") { if (s[j] === '\\') j++; j++; }
        continue;
      }
      if (c === '{') { depth++; seen = true; }
      else if (c === '}') {
        depth--;
        if (seen && depth === 0) return i + 1;
        if (depth < 0) die(`brace underflow scanning ${file} from line ${startLine}`);
      }
    }
  }
  die(`unterminated brace scanning ${file} from line ${startLine}`);
}

// --------------------------------------------------------------------------
// 1. Concept vocabulary — the controlled set every `concepts[]` draws from.
//
// The nine marked `verbatimFromReport` are copied word-for-word from the
// research report's "Three explanatory levels" table (Learning application and
// curriculum design). The rest are written in the same register.
// --------------------------------------------------------------------------
const CONCEPTS = [
  { id: 'esp32', label: 'ESP32', verbatimFromReport: true, primaryAnchor: 'setup',
    levels: { beginner12: "Sesame's small computer/brain", beginnerProgrammer: 'runs `setup()` and `loop()`', architecture: 'Xtensa SoC + memory/peripherals' } },
  { id: 'firmware', label: 'firmware', verbatimFromReport: true, primaryAnchor: 'ino-includes',
    levels: { beginner12: 'instructions that live on the robot', beginnerProgrammer: 'C++/Arduino program', architecture: 'application atop Arduino-ESP32/ESP-IDF' } },
  { id: 'servo', label: 'servo', verbatimFromReport: true, primaryAnchor: 'setServoAngle',
    levels: { beginner12: 'a joint you can command to an angle', beginnerProgrammer: '`setServoAngle(R1, 135)`', architecture: 'PWM via ESP32Servo/LEDC' } },
  { id: 'pwm', label: 'PWM', verbatimFromReport: true, primaryAnchor: 'setup',
    levels: { beginner12: 'repeated pulses that encode a requested position', beginnerProgrammer: 'pulse width corresponds to target', architecture: 'timer/LEDC/GPIO waveform' } },
  { id: 'i2c', label: 'I²C', verbatimFromReport: true, primaryAnchor: 'i2c-pin-defines',
    levels: { beginner12: 'two-wire conversation with the display', beginnerProgrammer: 'address + bytes', architecture: 'controller transaction to SSD1306' } },
  { id: 'api', label: 'API', verbatimFromReport: true, primaryAnchor: 'handleApiCommand',
    levels: { beginner12: 'messages another program sends the robot', beginnerProgrammer: 'HTTP + JSON', architecture: 'transport/contract decoupled from implementation' } },
  { id: 'emulator', label: 'emulator', verbatimFromReport: true, primaryAnchor: 'ino-includes',
    levels: { beginner12: 'pretend electronics that run real firmware', beginnerProgrammer: 'CPU + peripherals in software', architecture: 'instruction-level virtual platform' } },
  { id: 'simulator', label: 'simulator', verbatimFromReport: true, primaryAnchor: 'movement-prototypes',
    levels: { beginner12: 'software model of what Sesame does', beginnerProgrammer: 'state/pose model', architecture: 'behavioral or physical model' } },
  { id: 'state', label: 'state', verbatimFromReport: true, primaryAnchor: 'animation-state-globals',
    levels: { beginner12: 'what the robot currently remembers', beginnerProgrammer: 'variables/objects', architecture: 'authoritative model + events' } },

  { id: 'ledc', label: 'LEDC', primaryAnchor: 'setup',
    levels: { beginner12: 'the chip part that makes the pulses without the program having to', beginnerProgrammer: 'ESP32 hardware PWM channels; `ESP32PWM::allocateTimer()` reserves the timers', architecture: 'timer + channel pairs; duty resolution fixes how many distinct pulse widths exist' } },
  { id: 'gpio', label: 'GPIO', primaryAnchor: 'servo-pin-table',
    levels: { beginner12: 'a numbered pin on the board that a wire plugs into', beginnerProgrammer: '`servoPins[8]` maps joint index to pin number', architecture: 'pad/matrix routing between peripheral and package pin' } },
  { id: 'oled', label: 'OLED display', primaryAnchor: 'display-object',
    levels: { beginner12: "Sesame's face screen", beginnerProgrammer: '`Adafruit_SSD1306 display(128, 64, &Wire, -1)`', architecture: 'SSD1306 controller behind a framebuffer library' } },
  { id: 'bitmap', label: 'bitmap', primaryAnchor: 'updateFaceBitmap',
    levels: { beginner12: 'a picture stored as one bit per pixel', beginnerProgrammer: '1024 bytes = 128×64 pixels, drawn with `drawBitmap()`', architecture: 'horizontal-scan monochrome buffer in flash, blitted to the framebuffer' } },
  { id: 'progmem', label: 'PROGMEM', primaryAnchor: 'face-bitmap-data',
    levels: { beginner12: 'pictures kept in the robot’s permanent memory, not its working memory', beginnerProgrammer: '`const unsigned char x[] PROGMEM` keeps large constants out of RAM', architecture: 'flash-resident read-only data' } },
  { id: 'animation', label: 'animation', primaryAnchor: 'updateAnimatedFace',
    levels: { beginner12: 'showing pictures one after another so it looks like motion', beginnerProgrammer: 'a frame index advanced on a millis() interval', architecture: 'frame cursor + playback mode + fps, stepped from the main loop' } },
  { id: 'face', label: 'face', primaryAnchor: 'setFace',
    levels: { beginner12: 'the expression on the screen, chosen by name', beginnerProgrammer: '`setFace("wave")` looks the name up in `faceEntries[]`', architecture: 'name → frame-array registry with a fallback entry' } },
  { id: 'movement', label: 'movement', primaryAnchor: 'runWalkPose',
    levels: { beginner12: 'a whole action, like walking, built from many small joint commands', beginnerProgrammer: 'a function that calls `setServoAngle()` in order, with waits between', architecture: 'procedural sequence; no kinematics solver anywhere in the firmware' } },
  { id: 'pose', label: 'pose', primaryAnchor: 'runStandPose',
    levels: { beginner12: 'one whole-body shape — all eight joints at once', beginnerProgrammer: 'eight `setServoAngle()` calls with no loop', architecture: 'a single commanded joint vector' } },
  { id: 'timing', label: 'timing', primaryAnchor: 'delayWithFace',
    levels: { beginner12: 'how long the robot waits between moves', beginnerProgrammer: '`delayWithFace(ms)` instead of `delay(ms)`', architecture: 'cooperative wait that keeps servicing other subsystems' } },
  { id: 'reentrancy', label: 're-entrancy', primaryAnchor: 'delayWithFace',
    levels: { beginner12: 'other jobs get a turn while the robot is waiting', beginnerProgrammer: 'a wait that runs the web server means new commands can arrive mid-move', architecture: 'a cooperative yield point; shared state can change across it' } },
  { id: 'quantisation', label: 'quantisation', primaryAnchor: 'setServoAngle',
    levels: { beginner12: 'the robot can only pick from a fixed list of positions, not any position', beginnerProgrammer: 'angles map to integer timer ticks, so nearby angles collide', architecture: 'duty resolution bounds the distinct reachable pulse widths' } },
  { id: 'calibration', label: 'calibration / subtrim', primaryAnchor: 'servoSubtrim',
    levels: { beginner12: 'a small correction so a joint sits where you meant', beginnerProgrammer: '`servoSubtrim[channel]` is added to every commanded angle', architecture: 'per-channel offset applied before the output clamp; RAM-only' } },
  { id: 'boot', label: 'boot', primaryAnchor: 'setup',
    levels: { beginner12: 'everything the robot does once, in order, when you switch it on', beginnerProgrammer: '`setup()` runs top to bottom before `loop()` ever runs', architecture: 'ordered peripheral bring-up; one step can hard-stop the rest' } },
  { id: 'event-loop', label: 'event loop', primaryAnchor: 'loop',
    levels: { beginner12: 'the robot checks everything, over and over, forever', beginnerProgrammer: '`loop()` polls DNS, HTTP, face, idle, then the current command', architecture: 'single-threaded cooperative scheduler; no RTOS tasks in user code' } },
  { id: 'state-machine', label: 'state machine', primaryAnchor: 'updateWifiSetup',
    levels: { beginner12: 'the robot is always in exactly one situation, and moves between them', beginnerProgrammer: 'an enum plus a function that advances it each loop', architecture: 'explicit states with timeouts, so a handler never blocks' } },
  { id: 'idle', label: 'idle behaviour', primaryAnchor: 'enterIdle',
    levels: { beginner12: 'what the robot does when nobody is telling it anything', beginnerProgrammer: '`idleActive` plus a randomly scheduled blink', architecture: 'a mode entered from one call site and exited on input' } },
  { id: 'wifi', label: 'Wi-Fi', primaryAnchor: 'connectToWifi',
    levels: { beginner12: 'how Sesame talks to phones and computers without a cable', beginnerProgrammer: '`WiFi.softAP()` makes a network; `WiFi.begin()` joins one', architecture: 'AP, STA or AP+STA interface modes on one radio' } },
  { id: 'ap-mode', label: 'access point / captive portal', primaryAnchor: 'index_html',
    levels: { beginner12: 'Sesame makes its own Wi-Fi network for you to join', beginnerProgrammer: 'SoftAP + a DNS server that answers every name with the robot’s IP', architecture: 'AP + wildcard DNS + catch-all HTTP route' } },
  { id: 'dns', label: 'DNS', primaryAnchor: 'dns-server',
    levels: { beginner12: 'the part that turns a web address into a number', beginnerProgrammer: '`dnsServer.start(53, "*", myIP)` answers every lookup with one address', architecture: 'wildcard responder on UDP 53, pumped from the main loop' } },
  { id: 'mdns', label: 'mDNS', primaryAnchor: 'startMdns',
    levels: { beginner12: 'a friendly name like sesame-robot.local instead of a number', beginnerProgrammer: '`MDNS.begin(hostname)` plus an advertised http service', architecture: 'link-local name advertisement; success tracked so the API can be honest about it' } },
  { id: 'http', label: 'HTTP', primaryAnchor: 'handleRoot',
    levels: { beginner12: 'how a browser asks the robot for something', beginnerProgrammer: '`server.on(path, handler)`; the handler sends a status and a body', architecture: 'request routing table over a single-connection web server' } },
  { id: 'route', label: 'route', primaryAnchor: 'setup',
    levels: { beginner12: 'each web address the robot knows how to answer', beginnerProgrammer: 'path → handler function, registered before `server.begin()`', architecture: 'registration order and method matching decide what a request reaches' } },
  { id: 'json', label: 'JSON', primaryAnchor: 'handleGetStatus',
    levels: { beginner12: 'a way of writing information so another program can read it', beginnerProgrammer: 'built here by joining strings, not by a JSON library', architecture: 'hand-serialised responses; escaping is the caller’s responsibility' } },
  { id: 'string-parsing', label: 'string parsing', primaryAnchor: 'handleApiCommand',
    levels: { beginner12: 'finding the useful part inside a message', beginnerProgrammer: '`indexOf()` / `substring()` instead of a parser', architecture: 'positional scanning; accepts inputs a real parser would reject and vice-versa' } },
  { id: 'serial', label: 'serial', primaryAnchor: 'serial-cli',
    levels: { beginner12: 'typing to the robot over its USB cable', beginnerProgrammer: '`Serial.available()` / `Serial.read()`, one character at a time', architecture: 'UART console; the developer-facing control surface' } },
  { id: 'cli', label: 'command line', primaryAnchor: 'serial-cli',
    levels: { beginner12: 'short typed commands, like `rn wv`', beginnerProgrammer: 'a buffer, then a chain of `strcmp` / `strncmp` tests', architecture: 'prefix-order-sensitive dispatch over a fixed 32-byte buffer' } },
  { id: 'macro', label: 'preprocessor macro', primaryAnchor: 'FACE_LIST',
    levels: { beginner12: 'writing one list once and letting the computer copy it everywhere', beginnerProgrammer: 'the X-macro pattern: `FACE_LIST` expands three different ways', architecture: 'compile-time code generation from a single declaration list' } },
  { id: 'weak-symbol', label: 'weak symbol', primaryAnchor: 'face-weak-decls',
    levels: { beginner12: 'the program says "this picture might exist" — and sometimes it does not', beginnerProgrammer: '`__attribute__((weak))` lets a missing definition link as a null pointer', architecture: 'unresolved weak reference resolves to 0 with no link error' } },
  { id: 'error-handling', label: 'error handling', primaryAnchor: 'handleNotFound',
    levels: { beginner12: 'what happens when you ask for something that is not there', beginnerProgrammer: 'status codes: 400 bad args, 404 not found, 405 wrong method', architecture: 'which failures are reported, which are silent, and which stop the device' } },
];
const CONCEPT_IDS = new Set(CONCEPTS.map((c) => c.id));

// --------------------------------------------------------------------------
// 2. Teaching notes — the sharp edges. Every one is already documented
//    elsewhere in this repo; `references` says where.
// --------------------------------------------------------------------------
const TEACHING_NOTES = [
  {
    id: 'TN-001', title: 'Two face bitmaps are declared but never defined, so those faces render nothing',
    kind: 'defect', severity: 'high',
    summary: 'face-bitmaps.h declares every `epd_bitmap_<name>` as an undefined weak symbol. `epd_bitmap_stand` and `epd_bitmap_defualt` are never defined anywhere in the tree, so `face_stand_frames[0]` and `face_defualt_frames[0]` are null pointers. countFrames() returns 0 for both, setFace("stand") falls through to the default fallback — which is the same empty array — and the previously drawn frame stays on screen while currentFaceName becomes "default".',
    evidenceAnchors: [
      { file: FACES, needle: '#define X(name) extern const unsigned char epd_bitmap_##name[] PROGMEM __attribute__((weak));' },
      { file: INO, needle: 'uint8_t countFrames(const unsigned char* const* frames, uint8_t maxFrames)' },
      { file: INO, needle: '  if (currentFaceFrameCount == 0) {' },
    ],
    symbols: ['face-weak-decls', 'countFrames', 'setFace'],
    concepts: ['weak-symbol', 'face', 'bitmap', 'error-handling'],
    references: ['ISSUE-20260823-004', 'docs/findings/F4-doc-drift.md', 'docs/findings/F3-firmware-build.md'],
    commentary: 'The build emits no diagnostic because the platform compiles with -w. Confirmed absent from the ELF symbol table by F3, so this is not a source-reading artefact.',
  },
  {
    id: 'TN-002', title: 'delayWithFace() is not dead time — it pumps HTTP, DNS and the face animation',
    kind: 'surprise', severity: 'high',
    summary: 'delayWithFace(ms) spins until the deadline calling updateAnimatedFace(), server.handleClient() and dnsServer.processNextRequest() with a delay(5) each pass. Because setServoAngle() ends with delayWithFace(motorCurrentDelay), EVERY commanded joint angle is also a service point for the web server and the captive-portal DNS. A new command can therefore change currentCommand in the middle of a movement sequence.',
    evidenceAnchors: [
      { file: INO, needle: 'void delayWithFace(unsigned long ms) {' },
      { file: INO, needle: '    delayWithFace(motorCurrentDelay);' },
    ],
    symbols: ['delayWithFace', 'setServoAngle', 'pressingCheck'],
    concepts: ['timing', 'reentrancy', 'event-loop', 'http'],
    references: ['hardware/hardware-map.json → servos.servoConfig.motorCurrentDelay.appliedNote'],
    commentary: 'This is the single most load-bearing fact for anyone reasoning about interruptibility: the movement functions look blocking and are not.',
  },
  {
    id: 'TN-003', title: 'Subtrim is added BEFORE the 0–180 clamp, so a large trim saturates the output',
    kind: 'surprise', severity: 'medium',
    summary: 'setServoAngle() computes constrain(angle + servoSubtrim[channel], 0, 180). The trim is applied first and the clamp second, so with a +40 trim every commanded angle above 140 produces the same clamped 180, and the last 40 degrees of the command range stop being distinguishable.',
    evidenceAnchors: [
      { file: INO, needle: 'int adjustedAngle = constrain(angle + servoSubtrim[channel], 0, 180);' },
      { file: INO, needle: '              if (trimValue >= -90 && trimValue <= 90) {' },
    ],
    symbols: ['setServoAngle', 'servoSubtrim', 'serial-cli'],
    concepts: ['calibration', 'servo', 'quantisation'],
    references: ['hardware/hardware-map.json → servos.setServoAngle.steps[2]'],
    commentary: null,
  },
  {
    id: 'TN-004', title: 'Face playback mode is global state set per call site, not a property of a face',
    kind: 'surprise', severity: 'medium',
    summary: 'currentFaceMode is one global, initialised to FACE_ANIM_LOOP. setFaceMode() writes it; setFaceWithMode() writes it and then selects the face; setFace() alone does NOT touch it. The same face therefore plays LOOP, ONCE or BOOMERANG depending purely on which call site last ran — "dead" is selected with FACE_ANIM_ONCE at movement-sequences.h:288 and with FACE_ANIM_BOOMERANG at :302.',
    evidenceAnchors: [
      { file: INO, needle: 'FaceAnimMode currentFaceMode = FACE_ANIM_LOOP;' },
      { file: INO, needle: 'void setFaceMode(FaceAnimMode mode) {' },
      { file: MOV, needle: '  setFaceWithMode("dead", FACE_ANIM_BOOMERANG);' },
    ],
    symbols: ['setFaceMode', 'setFaceWithMode', 'setFace', 'runDeadPose', 'runShrugPose'],
    concepts: ['animation', 'state', 'face'],
    references: ['hardware/hardware-map.json → faces.playbackModeOwnership'],
    commentary: 'A UI that renders "mode" as a column of the face table would be modelling something the firmware does not have.',
  },
  {
    id: 'TN-005', title: 'enterIdle() is reachable from exactly one place: runStandPose(face == 1)',
    kind: 'surprise', severity: 'medium',
    summary: 'enterIdle() has a single call site, the `if (face == 1) enterIdle();` at the end of runStandPose(). Idle is therefore entered on completion of a stand pose, never after a period of inactivity. Twelve of the fifteen poses and all four continuous movements end with runStandPose(1), and pressingCheck() calls it too when a continuous command is cancelled, so idle is reached often — but always by that one route.',
    evidenceAnchors: [
      { file: MOV, needle: '  if (face == 1) enterIdle();' },
      { file: INO, needle: 'void enterIdle() {' },
      { file: INO, needle: '      runStandPose(1);' },
    ],
    symbols: ['runStandPose', 'enterIdle', 'exitIdle', 'pressingCheck'],
    concepts: ['idle', 'state', 'pose'],
    references: ['ISSUE-20260823-005 (drift 3)', 'hardware/hardware-map.json → faces.idle.entryCondition'],
    commentary: 'firmware/README.md:667 describes inactivity-triggered idle. The source does not implement that; the 30-second inactivity timer drives the Wi-Fi info scroll instead.',
  },
  {
    id: 'TN-006', title: 'attach(pin, 732, 2929) never produces a 2929 µs pulse — the library clamps it to 2500',
    kind: 'surprise', severity: 'medium',
    summary: 'setup() calls servos[i].attach(servoPins[i], 732, 2929) and the comment above it says "Map 0-180 to approx 732-2929us". ESP32Servo::attach() clamps the requested maximum to MAX_PULSE_WIDTH (2500) before storing it, so the widest pulse the peripheral is ever asked for is 2500 µs. The minimum is not clamped, because 732 is already above MIN_PULSE_WIDTH 500. Both facts are true and they differ: the firmware really does request 2929, and 2929 is never what comes out.',
    evidenceAnchors: [
      { file: INO, needle: '    servos[i].attach(servoPins[i], 732, 2929);' },
      { file: INO, needle: '    // Map 0-180 to approx 732-2929us' },
    ],
    symbols: ['setup'],
    concepts: ['servo', 'pwm', 'ledc'],
    references: ['docs/findings/Q3-ledc-fidelity.md §3, §6.2', 'hardware/hardware-map.json → servos.servoConfig.attachPulseClamp'],
    libraryEvidence: { library: 'ESP32Servo', version: '3.0.9', file: 'src/ESP32Servo.h', line: 98, text: '#define MAX_PULSE_WIDTH      2500     // the longest pulse sent to a servo' },
    commentary: 'A source explorer that shows the attach() line without this note teaches a number the hardware never sees.',
  },
  {
    id: 'TN-007', title: '10-bit LEDC resolution means 89 of the 181 commandable angles alias onto a neighbour',
    kind: 'surprise', severity: 'medium',
    summary: 'Servo::write() maps 0–180 onto the effective 732–2500 µs range with integer map(), then usToTicks() truncates to a 1024-step, 20 ms frame — about 19.53 µs per tick. Only ticks 37–128 are reachable across the whole range: 92 distinct pulse values for 181 distinct commands, so 89 of the 181 angles are indistinguishable from a neighbouring angle at the pin. The angle-to-tick arithmetic lives in ESP32Servo, not in Sesame source; what Sesame source contributes is the 0–180 command range and the 50 Hz frame.',
    evidenceAnchors: [
      { file: INO, needle: '    servos[i].setPeriodHertz(50);' },
      { file: INO, needle: '    servos[channel].write(adjustedAngle);' },
    ],
    symbols: ['setup', 'setServoAngle'],
    concepts: ['quantisation', 'ledc', 'pwm', 'servo'],
    references: ['docs/findings/Q3-ledc-fidelity.md §6.4', 'hardware/hardware-map.json → servos.servoConfig.pulseQuantisation'],
    libraryEvidence: { library: 'ESP32Servo', version: '3.0.9', file: 'src/ESP32Servo.cpp', line: 260, text: 'int Servo::usToTicks(int usec) — usec / (REFRESH_USEC / timer_width_ticks)' },
    commentary: 'Anything in the UI implying one-degree servo resolution is over-claiming. This is a property of the commanded waveform, not an emulator artefact — and per docs/plan.md it will never be checked against a physical servo.',
  },
  {
    id: 'TN-008', title: '/api/status concatenates command and face names into JSON without escaping',
    kind: 'defect', severity: 'medium',
    summary: 'handleGetStatus() builds its response by string concatenation and interpolates currentCommand and currentFaceName raw. jsonEscape() exists in the same file and IS applied to SSIDs in the Wi-Fi handlers, so the helper is present and simply not used here. A command string containing a double quote makes the next /api/status emit invalid JSON; a longer payload injects additional keys into the response object.',
    evidenceAnchors: [
      { file: INO, needle: '  json += "\\"currentCommand\\":\\"" + currentCommand + "\\",";' },
      { file: INO, needle: 'String jsonEscape(const String& s) {' },
      { file: INO, needle: '    json += "{\\"ssid\\":\\"" + jsonEscape(WiFi.SSID(i)) + "\\",";' },
    ],
    symbols: ['handleGetStatus', 'jsonEscape', 'handleWifiScan'],
    concepts: ['json', 'api', 'string-parsing', 'error-handling'],
    references: ['ISSUE-20260823-021', 'docs/findings/V5-api-adapter.md'],
    commentary: 'Useful as a lesson precisely because the correct helper is visible four hundred lines away in the same file.',
  },
  {
    id: 'TN-009', title: 'Every route is registered HTTP_ANY, so method is not part of the contract',
    kind: 'surprise', severity: 'medium',
    summary: 'All ten registrations use the two-argument server.on(path, handler) overload, which the WebServer library treats as HTTP_ANY. GET /api/command reaches handleApiCommand, which then rejects it itself with 405 at its first line — the method check is in the handler, not in the routing table. /cmd, /getSettings and /setSettings have no method check at all, so POST /setSettings?frameDelay=1 is accepted.',
    evidenceAnchors: [
      { file: INO, needle: '  server.on("/api/command", handleApiCommand);' },
      { file: INO, needle: '{\\"error\\":\\"Method not allowed\\"}' },
      { file: INO, needle: 'void handleSetSettings() {' },
    ],
    symbols: ['setup', 'handleApiCommand', 'handleSetSettings', 'handleCommandWeb'],
    concepts: ['http', 'route', 'api', 'error-handling'],
    references: ['ISSUE-20260823-005 (drift 4)', 'hardware/hardware-map.json → network.http.routeRegistrationNote'],
    commentary: null,
  },
  {
    id: 'TN-010', title: 'Continuous commands never clear themselves, and an unknown command is never cleared at all',
    kind: 'surprise', severity: 'medium',
    summary: 'loop() re-reads currentCommand every iteration. forward/backward/left/right do not clear it, so they repeat until something else writes the variable — that is how "hold to walk" works. Pose commands clear it, either inline in loop() (rest, stand) or at the end of the pose function. A command string that matches no branch is never cleared and simply does nothing, forever, on every loop iteration.',
    evidenceAnchors: [
      { file: INO, needle: '  if (currentCommand != "") {' },
      { file: INO, needle: '    else if (cmd == "rest") { runRestPose(); if (currentCommand == "rest") currentCommand = ""; }' },
      { file: MOV, needle: '  if (currentCommand == "wave") currentCommand = "";' },
    ],
    symbols: ['loop', 'command-dispatch', 'runWavePose', 'runWalkPose'],
    concepts: ['state', 'event-loop', 'movement'],
    references: ['hardware/hardware-map.json → commands.dispatchNote'],
    commentary: null,
  },
  {
    id: 'TN-011', title: 'pressingCheck() cancels a walk by running a full stand pose, which enters idle',
    kind: 'surprise', severity: 'low',
    summary: 'The walk and turn functions call pressingCheck(cmd, frameDelay) between frames. It services HTTP, DNS and the face animation, and if currentCommand has changed it calls runStandPose(1) and returns false, which makes the movement function return. Cancelling a walk therefore commands all eight joints to the stand vector and, via runStandPose(face == 1), enters idle — even when the reason for cancelling was a different command arriving.',
    evidenceAnchors: [
      { file: INO, needle: 'bool pressingCheck(String cmd, int ms) {' },
      { file: MOV, needle: '    if (!pressingCheck("forward", frameDelay)) return;', occurrence: 1 },
    ],
    symbols: ['pressingCheck', 'runWalkPose', 'runTurnLeft', 'runStandPose'],
    concepts: ['reentrancy', 'movement', 'idle', 'state'],
    references: ['hardware/hardware-map.json → movements[runWalkPose]'],
    commentary: 'The next command then runs from a stand pose rather than from wherever the walk was interrupted, which is why chained commands look "reset" between them.',
  },
  {
    id: 'TN-012', title: 'The JSON API is parsed with indexOf(), not with a JSON parser',
    kind: 'surprise', severity: 'low',
    summary: 'handleApiCommand() locates fields by searching the raw body for the literal strings "\\"command\\":\\"" and "\\"command\\": \\"" (and the same two spellings for "face"), then takes the substring up to the next quote. Exactly one optional space after the colon is tolerated; other valid JSON spellings — two spaces, a newline, a different key order with escapes — are not parsed as intended. A request is treated as face-only when a "face" key is present and no "command" substring appears anywhere in the body.',
    evidenceAnchors: [
      { file: INO, needle: '    int cmdStart = body.indexOf("\\"command\\":\\"");' },
      { file: INO, needle: '  bool faceOnly = (faceOnlyStart > 0 && body.indexOf("\\"command\\":") == -1 && body.indexOf("\\"command\\": ") == -1);' },
    ],
    symbols: ['handleApiCommand'],
    concepts: ['json', 'string-parsing', 'api'],
    references: ['docs/findings/V5-api-adapter.md'],
    commentary: null,
  },
  {
    id: 'TN-013', title: 'setFace() returns early when the name is unchanged, so a repeated call does not restart the animation',
    kind: 'surprise', severity: 'low',
    summary: 'The first statement of setFace() is `if (faceName == currentFaceName && currentFaceFrames != nullptr) return;`. Selecting the face that is already selected does not reset the frame index, the direction, the finished flag or the frame timer. setFaceWithMode() still writes the playback mode first, so the mode changes while the frame cursor does not.',
    evidenceAnchors: [
      { file: INO, needle: '  if (faceName == currentFaceName && currentFaceFrames != nullptr) return;' },
      { file: INO, needle: 'void setFaceWithMode(const String& faceName, FaceAnimMode mode) {' },
    ],
    symbols: ['setFace', 'setFaceWithMode'],
    concepts: ['face', 'animation', 'state'],
    references: [],
    commentary: null,
  },
  {
    id: 'TN-014', title: 'A failed display init is the only hard stop in setup()',
    kind: 'surprise', severity: 'medium',
    summary: 'If display.begin() returns false, setup() prints "SSD1306 allocation failed." and enters `while (1);`. Nothing after that runs — no Wi-Fi, no web server, no servo attach. Every other bring-up call in setup() has its return value ignored: Wire.begin(), WiFi.softAP() and dnsServer.start() can all fail without stopping boot.',
    evidenceAnchors: [
      { file: INO, needle: '    Serial.println(F("SSD1306 allocation failed."));' },
      { file: INO, needle: '  WiFi.softAP(AP_SSID, AP_PASS);' },
    ],
    symbols: ['setup'],
    concepts: ['boot', 'error-handling', 'i2c', 'oled'],
    references: ['hardware/hardware-map.json → bootOrder[3].bootBlocker'],
    commentary: 'A good "what would you change?" prompt: the one subsystem that stops the robot is the one that only draws a face.',
  },
  {
    id: 'TN-015', title: 'setServoAngle() silently ignores channels 8 and above',
    kind: 'surprise', severity: 'low',
    summary: 'The whole body of setServoAngle() sits inside `if (channel < 8)`. An out-of-range channel produces no write, no clamp, no serial message and no error return — the call simply does nothing. The HTTP and serial entry points range-check before calling, so the guard is only reachable through a future caller that does not.',
    evidenceAnchors: [
      { file: INO, needle: 'void setServoAngle(uint8_t channel, int angle) {' },
      { file: INO, needle: '  if (channel < 8) {' },
    ],
    symbols: ['setServoAngle'],
    concepts: ['error-handling', 'servo'],
    references: ['hardware/hardware-map.json → servos.setServoAngle.steps[0]'],
    commentary: null,
  },
  {
    id: 'TN-016', title: '/cmd answers 200 OK before the movement has run',
    kind: 'surprise', severity: 'low',
    summary: 'handleCommandWeb() sets currentCommand and sends the response immediately; the movement itself is started by the next loop() iteration. The comment on the first line says so explicitly. The 200 therefore means "command accepted", not "command completed" — and for motor= the write does happen inside the handler, so the two argument forms of the same route differ in when work is done.',
    evidenceAnchors: [
      { file: INO, needle: "  // We send 200 OK immediately so the web browser doesn't hang waiting for animation to finish" },
      { file: INO, needle: '      setServoAngle(motorNum - 1, angle); // Convert 1-based to 0-based index' },
    ],
    symbols: ['handleCommandWeb', 'command-dispatch'],
    concepts: ['http', 'api', 'event-loop'],
    references: ['hardware/hardware-map.json → network.http.routes[/cmd]'],
    commentary: null,
  },
  {
    id: 'TN-017', title: 'The face list is one declaration expanded three ways by the preprocessor',
    kind: 'design', severity: 'info',
    summary: 'FACE_LIST is a backslash-continued list of X(name) invocations. It is expanded three times with three different definitions of X: to declare the weak bitmap symbols, to build each face_<name>_frames[] array of six slots, and to build the faceEntries[] registry. Adding a face means adding one line. face-bitmaps.h also redefines `const` to `extern const` so that image2cpp output pasted below it gains external linkage.',
    evidenceAnchors: [
      { file: FACES, needle: '#define FACE_LIST \\' },
      { file: FACES, needle: '#define const extern const' },
      { file: INO, needle: '#define MAKE_FACE_FRAMES(name) \\' },
      { file: INO, needle: 'const FaceEntry faceEntries[] = {' },
    ],
    symbols: ['FACE_LIST', 'face-const-remap', 'MAKE_FACE_FRAMES', 'faceEntries'],
    concepts: ['macro', 'face', 'weak-symbol'],
    references: ['hardware/hardware-map.json → faces.faceListMacroSource'],
    commentary: 'Worth showing alongside TN-001: the same mechanism that makes adding a face one line long is what lets a missing bitmap link cleanly.',
  },
];

// --------------------------------------------------------------------------
// 3. Symbol table. Lines are NEVER typed here — `anchor` locates the start and
//    `end` says how to find the last line.
//      end: 'brace'                 C++-aware brace match from the start line
//      end: { needle }              first line at or after start containing it
//      end: 'same-line'             one-line symbol
//      end: 'eof'                   to the end of the file
// --------------------------------------------------------------------------
const S = (o) => o;
const SYMBOLS = [
  // ---------------------------------------------------------------- ino: configuration and state
  S({ id: 'ino-includes', file: INO, kind: 'region', anchor: '#include <WiFi.h>', end: { needle: '#include "captive-portal.h"' },
    signature: '#include block', concepts: ['firmware', 'esp32'], robotParts: [],
    description: 'Eleven includes: five Arduino/ESP32 libraries (WiFi, WebServer, DNSServer, ESPmDNS, Wire), ESP32Servo, the two Adafruit display libraries, and the three project headers face-bitmaps.h, movement-sequences.h and captive-portal.h.',
    crossRefs: {} }),
  S({ id: 'network-config-defines', file: INO, kind: 'config', anchor: '// --- Access Point Configuration ---', end: { needle: '#define ENABLE_NETWORK_MODE' },
    signature: '#define AP_SSID / AP_PASS / NETWORK_SSID / NETWORK_PASS / ENABLE_NETWORK_MODE', concepts: ['wifi', 'ap-mode'], robotParts: [],
    description: 'Compile-time network configuration. The access point Sesame creates is named here; station mode is off by default and both station credentials are empty strings.',
    crossRefs: { hardwareMap: ['network.ap', 'network.station'] } }),
  S({ id: 'display-config-defines', file: INO, kind: 'config', anchor: '#define SCREEN_WIDTH 128', end: { needle: '#define OLED_I2C_ADDR' },
    signature: '#define SCREEN_WIDTH / SCREEN_HEIGHT / OLED_RESET / OLED_I2C_ADDR', concepts: ['oled', 'i2c', 'bitmap'], robotParts: [],
    description: 'Display geometry and bus address: 128 by 64 pixels, no reset pin (-1), I²C address 0x3C.',
    crossRefs: { hardwareMap: ['display'] } }),
  S({ id: 'i2c-pin-defines', file: INO, kind: 'config', anchor: '// I2C Pins for Distro Board V2 / V3', end: { needle: '#define I2C_SCL 35' },
    signature: '#define I2C_SDA / I2C_SCL', concepts: ['i2c', 'gpio'], robotParts: [],
    description: 'Three candidate I²C pin pairs, one per board revision. Two are commented out; the S2 Mini pair is the one the checked-in build compiles.',
    crossRefs: { hardwareMap: ['boards[].i2c', 'display.i2c'] } }),
  S({ id: 'dns-server', file: INO, kind: 'state', anchor: 'DNSServer dnsServer;', end: { needle: 'const byte DNS_PORT = 53;' },
    signature: 'DNSServer dnsServer; const byte DNS_PORT = 53;', concepts: ['dns', 'ap-mode'], robotParts: [],
    description: 'The captive-portal DNS responder object and its port.',
    crossRefs: { hardwareMap: ['network.dns'], bootSteps: [12] } }),
  S({ id: 'display-object', file: INO, kind: 'state', anchor: 'Adafruit_SSD1306 display(SCREEN_WIDTH, SCREEN_HEIGHT, &Wire, OLED_RESET);', end: 'same-line',
    signature: 'Adafruit_SSD1306 display(SCREEN_WIDTH, SCREEN_HEIGHT, &Wire, OLED_RESET)', concepts: ['oled', 'i2c'], robotParts: [],
    description: 'The single display object every face-drawing function writes through, bound to the Wire I²C bus.',
    crossRefs: { hardwareMap: ['display'] } }),
  S({ id: 'server-object', file: INO, kind: 'state', anchor: 'WebServer server(80);', end: 'same-line',
    signature: 'WebServer server(80)', concepts: ['http'], robotParts: [],
    description: 'The HTTP server object, fixed to port 80. Handlers are registered on it in setup() and it is serviced from loop(), delayWithFace() and pressingCheck().',
    crossRefs: { hardwareMap: ['network.http'], bootSteps: [13, 14, 15] } }),
  S({ id: 'animation-state-globals', file: INO, kind: 'state', anchor: '// Global state for animations', end: { needle: 'uint8_t idleBlinkRepeatsLeft = 0;' },
    signature: 'currentCommand, currentFaceName, currentFaceFrames, currentFaceFrameCount, currentFaceFrameIndex, lastFaceFrameMs, faceFps, currentFaceMode, faceFrameDirection, faceAnimFinished, currentFaceFps, idleActive, idleBlinkActive, nextIdleBlinkMs, idleBlinkRepeatsLeft',
    concepts: ['state', 'animation', 'face', 'idle'], robotParts: [],
    description: 'The whole animation and command model: the command string loop() dispatches on, the selected face and its frame cursor, the global playback mode, and the idle/blink flags. Fifteen globals, no struct.',
    crossRefs: { hardwareMap: ['commands.stateVariable', 'faces.playbackModeOwnership'] },
    teachingNotes: ['TN-004'] }),
  S({ id: 'wifi-info-globals', file: INO, kind: 'state', anchor: '// WiFi Info Scrolling', end: { needle: 'String wifiInfoText = "";' },
    signature: 'lastInputTime, firstInputReceived, showingWifiInfo, wifiScrollPos, lastWifiScrollMs, wifiInfoText', concepts: ['state', 'oled', 'wifi'], robotParts: [],
    description: 'State for the scrolling connection banner drawn over the face after 30 seconds with no input.',
    crossRefs: {} }),
  S({ id: 'network-globals', file: INO, kind: 'state', anchor: '// Network Mode', end: { needle: 'bool mdnsOk = false;' },
    signature: 'networkConnected, networkIP, deviceHostname, mdnsOk', concepts: ['wifi', 'mdns', 'state'], robotParts: [],
    description: 'Cached station-link facts: whether the robot is joined to a network, the address it got, the hostname it advertises, and whether the mDNS responder actually started.',
    crossRefs: { hardwareMap: ['network.hostname', 'network.mdns'] } }),
  S({ id: 'wifi-setup-state', file: INO, kind: 'state', anchor: '// Runtime WiFi provisioning (web UI)', end: { needle: 'const uint32_t WIFI_SETUP_START_DELAY_MS = 300;' },
    signature: 'enum WifiSetupState { WIFI_SETUP_IDLE, WIFI_SETUP_QUEUED, WIFI_SETUP_CONNECTING } + wifiSetupState, wifiSetupSsid, wifiSetupPass, wifiSetupError, wifiSetupQueuedMs, wifiSetupStartMs, wifiRestoreApOnly, WIFI_CONNECT_TIMEOUT_MS, WIFI_SETUP_START_DELAY_MS',
    concepts: ['state-machine', 'wifi', 'state'], robotParts: [],
    description: 'Three-state machine for web-initiated Wi-Fi joins, plus its timeouts. It exists so an HTTP handler never blocks: the handler queues, loop() drives the attempt.',
    crossRefs: { hardwareMap: ['network.station.runtimeProvisioning'] } }),
  S({ id: 'servos-array', file: INO, kind: 'state', anchor: 'Servo servos[8];', end: 'same-line',
    signature: 'Servo servos[8]', concepts: ['servo', 'pwm'], robotParts: ['R1', 'R2', 'L1', 'L2', 'R4', 'R3', 'L3', 'L4'],
    description: 'The eight ESP32Servo objects, indexed by the ServoName enum. Index is the only joint identity the firmware has.',
    crossRefs: { hardwareMap: ['servos.servoConfig.declarationSymbol'], bootSteps: [17] } }),
  S({ id: 'servo-pin-table', file: INO, kind: 'config', anchor: '// Sesame Distro Board V3 Pinout [NEW]', end: { needle: 'const int servoPins[8] = {1, 2, 4, 6, 8, 10, 13, 14};' },
    signature: 'const int servoPins[8]', concepts: ['gpio', 'servo'], robotParts: ['R1', 'R2', 'L1', 'L2', 'R4', 'R3', 'L3', 'L4'],
    description: 'Four candidate pin arrays, one per board revision, three of them commented out. Element i is the GPIO number for servo index i, so the array is read in ServoName enum order, not in a geometric order.',
    crossRefs: { hardwareMap: ['boards[].servoPins', 'servos.joints[].pinsByBoard'] } }),
  S({ id: 'servoSubtrim', file: INO, kind: 'state', anchor: 'int8_t servoSubtrim[8] = {0, 0, 0, 0, 0, 0, 0, 0};', end: 'same-line',
    signature: 'int8_t servoSubtrim[8]', concepts: ['calibration', 'servo', 'state'], robotParts: ['R1', 'R2', 'L1', 'L2', 'R4', 'R3', 'L3', 'L4'],
    description: 'A signed per-channel degree offset added to every commanded angle. All eight default to zero, the values live only in RAM, and only the serial CLI can change them.',
    crossRefs: { hardwareMap: ['servos.subtrim'] },
    teachingNotes: ['TN-003'] }),
  S({ id: 'animation-constants', file: INO, kind: 'config', anchor: '// Animation constants', end: { needle: 'int motorCurrentDelay = 20;' },
    signature: 'int frameDelay = 100; int walkCycles = 10; int motorCurrentDelay = 20;', concepts: ['timing', 'movement'], robotParts: [],
    description: 'Three runtime-settable tuning values: the per-frame wait in the walk and turn sequences, how many cycles those sequences run, and the wait appended to every setServoAngle() call. All three are changed by GET /setSettings.',
    crossRefs: { hardwareMap: ['servos.servoConfig.motorCurrentDelay'], routes: ['/setSettings', '/getSettings'] } }),
  S({ id: 'FaceEntry', file: INO, kind: 'type', anchor: 'struct FaceEntry {', end: 'brace',
    signature: 'struct FaceEntry { const char* name; const unsigned char* const* frames; uint8_t maxFrames; }', concepts: ['face', 'bitmap'], robotParts: [],
    description: 'One row of the face registry: a name, a pointer to that face’s frame array, and how many slots that array has.',
    crossRefs: { hardwareMap: ['faces.registrySymbol'] } }),
  S({ id: 'MAKE_FACE_FRAMES', file: INO, kind: 'macro', anchor: '#define MAKE_FACE_FRAMES(name) \\', end: { needle: '#undef MAKE_FACE_FRAMES' },
    signature: '#define MAKE_FACE_FRAMES(name)', concepts: ['macro', 'face', 'bitmap'], robotParts: [],
    description: 'Expands FACE_LIST once per face into a six-slot array face_<name>_frames[] holding epd_bitmap_<name> and its _1.._5 suffixed frames. Slots whose bitmap is an unresolved weak symbol are null.',
    crossRefs: { hardwareMap: ['faces.maxFramesPerFace'] },
    teachingNotes: ['TN-017', 'TN-001'] }),
  S({ id: 'MAX_FACE_FRAMES', file: INO, kind: 'config', anchor: 'static const uint8_t MAX_FACE_FRAMES = 6;', end: 'same-line',
    signature: 'static const uint8_t MAX_FACE_FRAMES = 6', concepts: ['face', 'bitmap'], robotParts: [],
    description: 'The fixed number of slots every face frame array gets. It is the cap countFrames() stops at, so no face can have more than six frames without changing this constant and MAKE_FACE_FRAMES together.',
    crossRefs: { hardwareMap: ['faces.maxFramesPerFace'] } }),
  S({ id: 'FaceFpsEntry', file: INO, kind: 'type', anchor: 'struct FaceFpsEntry {', end: 'brace',
    signature: 'struct FaceFpsEntry { const char* name; uint8_t fps; }', concepts: ['face', 'animation', 'timing'], robotParts: [],
    description: 'One row of the per-face frame-rate table: a name and an fps value.',
    crossRefs: { hardwareMap: ['faces.fpsTableSymbol'] } }),
  S({ id: 'faceEntries', file: INO, kind: 'table', anchor: 'const FaceEntry faceEntries[] = {', end: 'brace',
    signature: 'const FaceEntry faceEntries[]', concepts: ['face', 'macro', 'table'].filter((c) => c !== 'table'), robotParts: [],
    description: 'The face registry setFace() searches. Built by expanding FACE_LIST a third time, then appending a hand-written "default" row that aliases the misspelled face_defualt_frames array.',
    crossRefs: { hardwareMap: ['faces.registrySymbol', 'faces.faces'] },
    teachingNotes: ['TN-017', 'TN-001'] }),
  S({ id: 'faceFpsEntries', file: INO, kind: 'table', anchor: 'const FaceFpsEntry faceFpsEntries[] = {', end: 'brace',
    signature: 'const FaceFpsEntry faceFpsEntries[]', concepts: ['face', 'animation', 'timing'], robotParts: [],
    description: 'Per-face frame rate. Every entry but three is 1 fps; point is 5, idle_blink is 7 and dead is 2. A face missing from this table falls back to the global faceFps.',
    crossRefs: { hardwareMap: ['faces.fpsTableSymbol', 'faces.defaultFps'] } }),

  S({ id: 'ino-prototypes', file: INO, kind: 'region', anchor: '// Prototypes', end: { needle: 'void finishWifiSetup(const String& err);' },
    signature: 'forward declarations for the thirty functions defined in this file', concepts: ['firmware', 'esp32'], robotParts: [],
    description: 'One block of forward declarations covering the servo helper, the whole face pipeline, the idle routines, every HTTP handler and every Wi-Fi helper. It is the fastest complete index of what this file contains.',
    crossRefs: {} }),

  // ---------------------------------------------------------------- ino: HTTP handlers
  S({ id: 'handleRoot', file: INO, kind: 'handler', anchor: 'void handleRoot() {', end: 'brace',
    signature: 'void handleRoot()', concepts: ['http', 'ap-mode'], robotParts: [],
    description: 'Sends the captive-portal control page: 200, text/html, the index_html string literal. One statement.',
    crossRefs: { routes: ['/'], hardwareMap: ['network.http.routes[/]'] } }),
  S({ id: 'handleCommandWeb', file: INO, kind: 'handler', anchor: 'void handleCommandWeb() {', end: 'brace',
    signature: 'void handleCommandWeb()', concepts: ['http', 'api', 'servo', 'state', 'error-handling'], robotParts: [],
    description: 'The legacy query-parameter endpoint. Accepts exactly one of pose=, go=, stop=, or motor= with value=. The first three write currentCommand (or clear it) and answer 200 "OK" without running anything; motor= resolves the motor either as a 1-based number or as a joint name and calls setServoAngle() inside the handler. Anything else is 400.',
    crossRefs: { routes: ['/cmd'], hardwareMap: ['network.http.routes[/cmd]', 'commands.setBy'], commands: ['rest', 'stand', 'wave', 'forward', 'stop'] },
    teachingNotes: ['TN-016', 'TN-009'] }),
  S({ id: 'handleGetSettings', file: INO, kind: 'handler', anchor: 'void handleGetSettings() {', end: 'brace',
    signature: 'void handleGetSettings()', concepts: ['http', 'json', 'api'], robotParts: [],
    description: 'Returns the four tuning values as JSON built by string concatenation: frameDelay, walkCycles, motorCurrentDelay, faceFps. All four are integers, so no escaping question arises here.',
    crossRefs: { routes: ['/getSettings'], hardwareMap: ['network.http.routes[/getSettings]'] } }),
  S({ id: 'handleSetSettings', file: INO, kind: 'handler', anchor: 'void handleSetSettings() {', end: 'brace',
    signature: 'void handleSetSettings()', concepts: ['http', 'api', 'timing'], robotParts: [],
    description: 'Writes any of the four tuning values that appear as query arguments, then answers 200 "OK". Only faceFps is range-checked — max(1, value); frameDelay, walkCycles and motorCurrentDelay accept any integer including zero and negatives. A motorSpeed argument, which the captive-portal page does send, has no branch here and is discarded.',
    crossRefs: { routes: ['/setSettings'], hardwareMap: ['network.http.routes[/setSettings]', 'faces.fpsRuntimeSettable'] },
    teachingNotes: ['TN-009'] }),
  S({ id: 'handleGetStatus', file: INO, kind: 'handler', anchor: 'void handleGetStatus() {', end: 'brace',
    signature: 'void handleGetStatus()', concepts: ['http', 'json', 'api', 'state'], robotParts: [],
    description: 'Returns currentCommand, currentFace, networkConnected and apIP, plus networkIP when a station link is up. The JSON is assembled by concatenating strings; the two string-valued fields are interpolated without escaping.',
    crossRefs: { routes: ['/api/status'], hardwareMap: ['network.http.routes[/api/status]'] },
    teachingNotes: ['TN-008'] }),
  S({ id: 'handleApiCommand', file: INO, kind: 'handler', anchor: 'void handleApiCommand() {', end: 'brace',
    signature: 'void handleApiCommand()', concepts: ['http', 'json', 'api', 'string-parsing', 'state', 'error-handling'], robotParts: [],
    description: 'The JSON command endpoint. Rejects non-POST with 405, then locates "face" and "command" fields by substring search, applies the face immediately with setFace(), and either clears currentCommand (for "stop") or assigns it and calls exitIdle(). A body carrying a face and no command field is treated as face-only and acknowledged without touching currentCommand.',
    crossRefs: { routes: ['/api/command'], hardwareMap: ['network.http.routes[/api/command]', 'commands.setBy'] },
    teachingNotes: ['TN-012', 'TN-009'] }),
  S({ id: 'handleWifiScan', file: INO, kind: 'handler', anchor: 'void handleWifiScan() {', end: 'brace',
    signature: 'void handleWifiScan()', concepts: ['http', 'json', 'wifi', 'state-machine'], robotParts: [],
    description: 'Polling scan endpoint. Answers {"scanning":true} while an asynchronous scan runs or a connect is in flight, starts one otherwise (bringing the station interface up first if the robot is AP-only), and once results exist returns an array of ssid/rssi/secure objects with the SSID passed through jsonEscape().',
    crossRefs: { routes: ['/api/wifi/scan'], hardwareMap: ['network.http.routes[/api/wifi/scan]'] },
    teachingNotes: ['TN-008'] }),
  S({ id: 'handleWifiConnect', file: INO, kind: 'handler', anchor: 'void handleWifiConnect() {', end: 'brace',
    signature: 'void handleWifiConnect()', concepts: ['http', 'wifi', 'state-machine', 'error-handling'], robotParts: [],
    description: 'Queues a Wi-Fi join rather than performing one: validates method and SSID, refuses with 409 if an attempt is already in flight, stores the credentials and moves the state machine to WIFI_SETUP_QUEUED, then answers {"success":true,"pending":true}. loop() does the work.',
    crossRefs: { routes: ['/api/wifi/connect'], hardwareMap: ['network.http.routes[/api/wifi/connect]'] } }),
  S({ id: 'handleWifiStatus', file: INO, kind: 'handler', anchor: 'void handleWifiStatus() {', end: 'brace',
    signature: 'void handleWifiStatus()', concepts: ['http', 'json', 'wifi'], robotParts: [],
    description: 'Reports connected, connecting, and the last attempt error, plus ssid/ip/host/mdns/rssi when a link is up. Both string fields that can carry arbitrary bytes go through jsonEscape().',
    crossRefs: { routes: ['/api/wifi/status'], hardwareMap: ['network.http.routes[/api/wifi/status]'] } }),
  S({ id: 'handleNotFound', file: INO, kind: 'handler', anchor: 'void handleNotFound() {', end: 'brace',
    signature: 'void handleNotFound()', concepts: ['http', 'route', 'ap-mode', 'error-handling'], robotParts: [],
    description: 'Unmatched routes split two ways: a path starting /api/ gets a JSON 404, everything else is answered by handleRoot(), which is what makes the captive portal open automatically.',
    crossRefs: { routes: ['*'], hardwareMap: ['network.http.routes[*]'] } }),

  // ---------------------------------------------------------------- ino: network helpers
  S({ id: 'jsonEscape', file: INO, kind: 'helper', anchor: 'String jsonEscape(const String& s) {', end: 'brace',
    signature: 'String jsonEscape(const String& s)', concepts: ['json', 'string-parsing'], robotParts: [],
    description: 'Escapes backslash, double quote and every byte below 0x20 as \\u00xx, so an SSID containing arbitrary octets cannot break the response. Called from handleWifiScan() and handleWifiStatus() only.',
    crossRefs: {},
    teachingNotes: ['TN-008'] }),
  S({ id: 'startMdns', file: INO, kind: 'helper', anchor: 'bool startMdns() {', end: 'brace',
    signature: 'bool startMdns()', concepts: ['mdns', 'wifi'], robotParts: [],
    description: 'Starts the mDNS responder for deviceHostname, advertises an http/tcp service on port 80 on success, and records the outcome in mdnsOk so the API does not claim a .local name that will not resolve.',
    crossRefs: { hardwareMap: ['network.mdns'], bootSteps: [10] } }),
  S({ id: 'announceNetwork', file: INO, kind: 'helper', anchor: 'void announceNetwork(const String& ssid) {', end: 'brace',
    signature: 'void announceNetwork(const String& ssid)', concepts: ['mdns', 'wifi', 'oled'], robotParts: [],
    description: 'Post-join side effects shared by the boot path and the web provisioning path: tear down and restart mDNS on the new interface, then rebuild the OLED scroll text with both the AP address and the joined network address.',
    crossRefs: { hardwareMap: ['network.mdns.restartedOnStationJoin'], bootSteps: [10] } }),
  S({ id: 'setApOnlyInfoText', file: INO, kind: 'helper', anchor: 'void setApOnlyInfoText() {', end: 'brace',
    signature: 'void setApOnlyInfoText()', concepts: ['oled', 'ap-mode'], robotParts: [],
    description: 'Builds the AP-only banner: the access-point name, its password, the SoftAP address, and a note that the captive portal opens by itself.',
    crossRefs: { bootSteps: [10] } }),
  S({ id: 'showWifiInfoNow', file: INO, kind: 'helper', anchor: 'void showWifiInfoNow() {', end: 'brace',
    signature: 'void showWifiInfoNow()', concepts: ['oled', 'state'], robotParts: [],
    description: 'Forces the banner back on after web provisioning by clearing firstInputReceived and back-dating lastInputTime by 30 seconds so the inactivity check passes immediately.',
    crossRefs: {} }),
  S({ id: 'connectToWifi', file: INO, kind: 'helper', anchor: 'bool connectToWifi(const String& ssid, const String& pass, uint32_t timeoutMs) {', end: 'brace',
    signature: 'bool connectToWifi(const String& ssid, const String& pass, uint32_t timeoutMs = 10000)', concepts: ['wifi', 'boot', 'timing'], robotParts: [],
    description: 'The blocking join used only from setup(), where nothing is listening yet. Switches to AP+STA so the access point survives, polls WiFi.status() every 250 ms until the timeout, breaks early on wrong-password or no-such-SSID after a one-second grace period, and on failure disconnects so the driver stops retrying.',
    crossRefs: { hardwareMap: ['network.station'], bootSteps: [7] } }),
  S({ id: 'finishWifiSetup', file: INO, kind: 'helper', anchor: 'void finishWifiSetup(const String& err) {', end: 'brace',
    signature: 'void finishWifiSetup(const String& err)', concepts: ['state-machine', 'wifi'], robotParts: [],
    description: 'Ends a web-initiated attempt: records the error string (empty on success), clears the stored password, and returns the state machine to WIFI_SETUP_IDLE.',
    crossRefs: {} }),
  S({ id: 'updateWifiSetup', file: INO, kind: 'helper', anchor: 'void updateWifiSetup() {', end: 'brace',
    signature: 'void updateWifiSetup()', concepts: ['state-machine', 'wifi', 'event-loop', 'timing'], robotParts: [],
    description: 'Called every loop iteration. When idle it acts as a five-second watchdog that reconciles the cached networkConnected/networkIP with the real link. When queued it waits 300 ms so the HTTP response can flush before the radio may change channel, then begins the join. When connecting it completes on WL_CONNECTED, or fails on a terminal status after a one-second grace period or on the 15-second timeout, mapping the status to one of three human-readable errors.',
    crossRefs: { hardwareMap: ['network.station.runtimeProvisioning'] } }),

  // ---------------------------------------------------------------- ino: entry points
  S({ id: 'setup', file: INO, kind: 'entrypoint', anchor: 'void setup() {', end: 'brace',
    signature: 'void setup()', concepts: ['boot', 'esp32', 'i2c', 'oled', 'wifi', 'http', 'dns', 'pwm', 'servo', 'ledc'], robotParts: ['R1', 'R2', 'L1', 'L2', 'R4', 'R3', 'L3', 'L4'],
    description: 'The twenty-step bring-up, in order: serial, RNG seed, I²C, display (the only step that can stop the rest), an OLED splash, Wi-Fi mode selection and SoftAP, the info banner and mDNS, input-tracking state, captive-portal DNS, nine route registrations plus the catch-all, server.begin(), four LEDC timer allocations, the attach loop that sets 50 Hz and a 732–2929 µs pulse range on all eight servos, a bare delay(10), and finally setFace("rest") — which shows a face without commanding any joint.',
    crossRefs: { hardwareMap: ['bootOrder'], bootSteps: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20], faces: ['rest'], routes: ['/', '/cmd', '/getSettings', '/setSettings', '/api/status', '/api/command', '/api/wifi/scan', '/api/wifi/connect', '/api/wifi/status', '*'] },
    teachingNotes: ['TN-006', 'TN-007', 'TN-009', 'TN-014'] }),
  S({ id: 'loop', file: INO, kind: 'entrypoint', anchor: 'void loop() {', end: 'brace',
    signature: 'void loop()', concepts: ['event-loop', 'esp32', 'state', 'dns', 'http', 'animation', 'idle', 'serial'], robotParts: [],
    description: 'Six service calls in fixed order — DNS, HTTP, Wi-Fi state machine, face animation, idle blink, banner scroll — then the command dispatcher, then the serial CLI. Nothing here yields to an RTOS scheduler; a long movement function simply does not return until it is done or interrupted.',
    crossRefs: { hardwareMap: ['commands.dispatchSymbol'] },
    teachingNotes: ['TN-010', 'TN-002'] }),
  S({ id: 'command-dispatch', file: INO, kind: 'region', anchor: '  if (currentCommand != "") {', end: 'brace',
    signature: 'if (currentCommand != "") { ... }  — the command dispatcher inside loop()', concepts: ['event-loop', 'state', 'movement', 'pose'], robotParts: [],
    description: 'Nineteen string comparisons against a copy of currentCommand, each calling one movement function. rest and stand clear the command inline; the other poses clear it inside their own function; the four continuous commands do not clear it at all. An unmatched non-empty string falls off the end of the chain.',
    crossRefs: { hardwareMap: ['commands.vocabulary', 'commands.dispatchNote'], commands: ['forward', 'backward', 'left', 'right', 'rest', 'stand', 'wave', 'dance', 'swim', 'point', 'pushup', 'bow', 'cute', 'freaky', 'worm', 'shake', 'shrug', 'dead', 'crab'] },
    teachingNotes: ['TN-010'] }),
  S({ id: 'serial-cli', file: INO, kind: 'region', anchor: '  if (Serial.available()) {', end: 'brace',
    signature: 'if (Serial.available()) { ... }  — the serial command dispatcher inside loop()', concepts: ['serial', 'cli', 'calibration', 'servo', 'face', 'string-parsing'], robotParts: ['R1', 'R2', 'L1', 'L2', 'R4', 'R3', 'L3', 'L4'],
    description: 'Accumulates characters into a static 32-byte buffer until newline or carriage return, then walks a chain of strcmp/strncmp tests: nineteen movement abbreviations, `face <name>` / `fc <name>`, the four subtrim forms, `all <angle>`, and finally a two-integer `<motor> <angle>` parsed with sscanf. Matching is order-sensitive: the exact "subtrim" test comes before "subtrim save", which comes before the "subtrim " prefix. Characters beyond 31 are dropped rather than overflowing.',
    crossRefs: { hardwareMap: ['commands.serialCli', 'commands.serialCliDispatchNote', 'servos.subtrim.settableVia'], commands: ['forward', 'backward', 'left', 'right', 'rest', 'stand', 'wave', 'dance', 'swim', 'point', 'pushup', 'bow', 'cute', 'freaky', 'worm', 'shake', 'shrug', 'dead', 'crab'] },
    teachingNotes: ['TN-003'] }),

  // ---------------------------------------------------------------- ino: face pipeline
  S({ id: 'updateFaceBitmap', file: INO, kind: 'helper', anchor: 'void updateFaceBitmap(const unsigned char* bitmap) {', end: 'brace',
    signature: 'void updateFaceBitmap(const unsigned char* bitmap)', concepts: ['oled', 'bitmap', 'i2c'], robotParts: [],
    description: 'Clears the framebuffer, draws one 128×64 bitmap at the origin in white, and pushes the framebuffer over I²C. Three statements. It is the output of the face pipeline, but not the only writer of the display: updateWifiInfoScroll() draws the current frame itself while the banner is showing.',
    crossRefs: { hardwareMap: ['faces.bitmapDimensions', 'display'] } }),
  S({ id: 'countFrames', file: INO, kind: 'helper', anchor: 'uint8_t countFrames(const unsigned char* const* frames, uint8_t maxFrames) {', end: 'brace',
    signature: 'uint8_t countFrames(const unsigned char* const* frames, uint8_t maxFrames)', concepts: ['face', 'bitmap', 'weak-symbol'], robotParts: [],
    description: 'Counts array slots up to maxFrames, stopping at the first null pointer. Returns 0 immediately when the array itself is null or its first slot is null — which is what an undefined weak bitmap symbol produces.',
    crossRefs: { hardwareMap: ['faces.faces[].frameCountRule'] },
    teachingNotes: ['TN-001'] }),
  S({ id: 'setFace', file: INO, kind: 'helper', anchor: 'void setFace(const String& faceName) {', end: 'brace',
    signature: 'void setFace(const String& faceName)', concepts: ['face', 'animation', 'state', 'bitmap'], robotParts: [],
    description: 'Selects a face by name. Returns immediately if that face is already current. Otherwise resets the frame cursor, direction, finished flag and fps, points the frame array at the default fallback, then searches faceEntries[] case-insensitively for a match. If the resulting frame count is zero it falls back to the default array and renames itself "default". Finally it draws frame 0 if one exists. It does NOT touch the playback mode.',
    crossRefs: { hardwareMap: ['faces.lookupSymbol', 'faces.lookupCaseInsensitive', 'faces.faces'] },
    teachingNotes: ['TN-013', 'TN-001', 'TN-004'] }),
  S({ id: 'setFaceMode', file: INO, kind: 'helper', anchor: 'void setFaceMode(FaceAnimMode mode) {', end: 'brace',
    signature: 'void setFaceMode(FaceAnimMode mode)', concepts: ['animation', 'state', 'face'], robotParts: [],
    description: 'Writes the global playback mode and resets direction and the finished flag. Three statements, no face involved.',
    crossRefs: { hardwareMap: ['faces.playbackModes', 'faces.playbackModeOwnership'] },
    teachingNotes: ['TN-004'] }),
  S({ id: 'setFaceWithMode', file: INO, kind: 'helper', anchor: 'void setFaceWithMode(const String& faceName, FaceAnimMode mode) {', end: 'brace',
    signature: 'void setFaceWithMode(const String& faceName, FaceAnimMode mode)', concepts: ['animation', 'face', 'state'], robotParts: [],
    description: 'Sets the mode, then the face — in that order. Every movement function selects its face through this, which is why mode is a property of the call site.',
    crossRefs: { hardwareMap: ['faces.playbackModeOwnership'] },
    teachingNotes: ['TN-004', 'TN-013'] }),
  S({ id: 'getFaceFpsForName', file: INO, kind: 'helper', anchor: 'int getFaceFpsForName(const String& faceName) {', end: 'brace',
    signature: 'int getFaceFpsForName(const String& faceName)', concepts: ['face', 'animation', 'timing'], robotParts: [],
    description: 'Case-insensitive lookup in faceFpsEntries[]; returns the global faceFps when the name is absent from the table.',
    crossRefs: { hardwareMap: ['faces.fpsTableSymbol', 'faces.fpsRuntimeSettable'] } }),
  S({ id: 'updateAnimatedFace', file: INO, kind: 'helper', anchor: 'void updateAnimatedFace() {', end: 'brace',
    signature: 'void updateAnimatedFace()', concepts: ['animation', 'face', 'timing', 'state'], robotParts: [],
    description: 'The frame stepper. Returns immediately for a null or single-frame face, or for a finished ONCE animation. Otherwise, once 1000/fps milliseconds have passed it advances the cursor: modulo for LOOP, clamp-and-latch for ONCE, and ping-pong with a direction flag for BOOMERANG, then draws the new frame. Called from loop(), delayWithFace() and pressingCheck().',
    crossRefs: { hardwareMap: ['faces.animationDriver', 'faces.playbackModes'] },
    teachingNotes: ['TN-002', 'TN-004'] }),
  S({ id: 'delayWithFace', file: INO, kind: 'helper', anchor: 'void delayWithFace(unsigned long ms) {', end: 'brace',
    signature: 'void delayWithFace(unsigned long ms)', concepts: ['timing', 'reentrancy', 'event-loop', 'animation', 'http', 'dns'], robotParts: [],
    description: 'Waits for ms milliseconds by spinning, and on every pass steps the face animation, services one HTTP client and one DNS request, then delays 5 ms. This is the wait every movement function uses and the wait setServoAngle() appends to each write.',
    crossRefs: { hardwareMap: ['network.dns.pumpedFrom', 'faces.animationDriver.calledFrom'] },
    teachingNotes: ['TN-002'] }),
  S({ id: 'scheduleNextIdleBlink', file: INO, kind: 'helper', anchor: 'void scheduleNextIdleBlink(unsigned long minMs, unsigned long maxMs) {', end: 'brace',
    signature: 'void scheduleNextIdleBlink(unsigned long minMs, unsigned long maxMs)', concepts: ['idle', 'timing', 'animation'], robotParts: [],
    description: 'Sets nextIdleBlinkMs to now plus a random interval in [minMs, maxMs). The generator is seeded once in setup() by randomSeed(micros()).',
    crossRefs: { bootSteps: [2] } }),
  S({ id: 'enterIdle', file: INO, kind: 'helper', anchor: 'void enterIdle() {', end: 'brace',
    signature: 'void enterIdle()', concepts: ['idle', 'state', 'face', 'animation'], robotParts: [],
    description: 'Marks idle active, clears the blink flags, selects the "idle" face in BOOMERANG mode, and schedules the first blink 3–7 seconds out.',
    crossRefs: { hardwareMap: ['faces.idle', 'movements[enterIdle]'], faces: ['idle'] },
    teachingNotes: ['TN-005'] }),
  S({ id: 'exitIdle', file: INO, kind: 'helper', anchor: 'void exitIdle() {', end: 'brace',
    signature: 'void exitIdle()', concepts: ['idle', 'state'], robotParts: [],
    description: 'Clears idleActive and idleBlinkActive. It does not change the face, so the idle face stays on screen until something else selects another one.',
    crossRefs: { hardwareMap: ['faces.idle.exitCondition', 'movements[exitIdle]'] },
    teachingNotes: ['TN-005'] }),
  S({ id: 'updateIdleBlink', file: INO, kind: 'helper', anchor: 'void updateIdleBlink() {', end: 'brace',
    signature: 'void updateIdleBlink()', concepts: ['idle', 'animation', 'face', 'timing'], robotParts: [],
    description: 'Runs only while idle is active. When the scheduled moment arrives it selects "idle_blink" in ONCE mode, with a 30 percent chance of queueing a second blink. When that animation reports finished it returns to the "idle" face and schedules the next blink — 120–220 ms out for the second half of a double blink, otherwise 3–7 seconds.',
    crossRefs: { hardwareMap: ['faces.idle'], faces: ['idle', 'idle_blink'] },
    teachingNotes: ['TN-004'] }),

  // ---------------------------------------------------------------- ino: servo + input helpers
  S({ id: 'setServoAngle', file: INO, kind: 'helper', anchor: 'void setServoAngle(uint8_t channel, int angle) {', end: 'brace',
    signature: 'void setServoAngle(uint8_t channel, int angle)', concepts: ['servo', 'pwm', 'ledc', 'calibration', 'quantisation', 'timing', 'reentrancy'], robotParts: ['R1', 'R2', 'L1', 'L2', 'R4', 'R3', 'L3', 'L4'],
    description: 'The one function every commanded joint angle passes through — the HTTP, serial and movement layers all reach the servo objects through it. Ignores channels 8 and above; otherwise adds that channel’s subtrim, clamps the sum to 0–180, writes it to the ESP32Servo object, and waits motorCurrentDelay milliseconds through delayWithFace().',
    crossRefs: { hardwareMap: ['servos.setServoAngle', 'servos.angleClamp', 'servos.subtrim', 'servos.servoConfig.motorCurrentDelay'] },
    teachingNotes: ['TN-003', 'TN-002', 'TN-007', 'TN-015'] }),
  S({ id: 'pressingCheck', file: INO, kind: 'helper', anchor: 'bool pressingCheck(String cmd, int ms) {', end: 'brace',
    signature: 'bool pressingCheck(String cmd, int ms)', concepts: ['reentrancy', 'movement', 'timing', 'state', 'idle'], robotParts: [],
    description: 'The interruptible wait used between walk and turn frames. Services HTTP, DNS and the face animation in a tight loop for ms milliseconds, yielding each pass. If currentCommand stops matching cmd it runs runStandPose(1) and returns false; otherwise it returns true when the time is up.',
    crossRefs: { hardwareMap: ['movements[runWalkPose].interruptible', 'network.dns.pumpedFrom'] },
    teachingNotes: ['TN-011', 'TN-002'] }),
  S({ id: 'recordInput', file: INO, kind: 'helper', anchor: 'void recordInput() {', end: 'brace',
    signature: 'void recordInput()', concepts: ['state', 'oled'], robotParts: [],
    description: 'Stamps lastInputTime and latches firstInputReceived, which permanently suppresses the Wi-Fi banner until showWifiInfoNow() or a reboot clears it. Called from every HTTP command handler and from the serial CLI.',
    crossRefs: { hardwareMap: ['bootOrder'], bootSteps: [11] } }),
  S({ id: 'updateWifiInfoScroll', file: INO, kind: 'helper', anchor: 'void updateWifiInfoScroll() {', end: 'brace',
    signature: 'void updateWifiInfoScroll()', concepts: ['oled', 'timing', 'state', 'wifi'], robotParts: [],
    description: 'Draws the connection banner over the current face. Once any input has been recorded it restores the face and returns forever. Otherwise, 30 seconds after the last input, it starts redrawing every 150 ms: the current frame, a black 128×10 bar across the top, and the banner text scrolled two pixels per step, wrapping when the offset passes six pixels per character.',
    crossRefs: {} }),

  // ---------------------------------------------------------------- movement-sequences.h
  S({ id: 'ServoName', file: MOV, kind: 'type', anchor: 'enum ServoName : uint8_t {', end: 'brace',
    signature: 'enum ServoName : uint8_t { R1=0, R2=1, L1=2, L2=3, R4=4, R3=5, L3=6, L4=7 }', concepts: ['servo', 'gpio'], robotParts: ['R1', 'R2', 'L1', 'L2', 'R4', 'R3', 'L3', 'L4'],
    description: 'The joint names and their indices. The order is neither alphabetical nor geometric — R4 is index 4 and R3 is index 5 — and it is the order servoPins[] and servos[] are indexed by. This enum is the only joint identity the firmware defines.',
    crossRefs: { hardwareMap: ['servos.order', 'servos.joints'] } }),
  S({ id: 'ServoNames', file: MOV, kind: 'table', anchor: 'const String ServoNames[]=', end: 'same-line',
    signature: 'const String ServoNames[]', concepts: ['servo'], robotParts: ['R1', 'R2', 'L1', 'L2', 'R4', 'R3', 'L3', 'L4'],
    description: 'Index-to-name strings in the same enum order, so ServoNames[i] names servos[i].',
    crossRefs: { hardwareMap: ['servos.nameLookup.tableSymbol'] } }),
  S({ id: 'servoNameToIndex', file: MOV, kind: 'helper', anchor: 'inline int servoNameToIndex(const String& servo) {', end: 'brace',
    signature: 'inline int servoNameToIndex(const String& servo)', concepts: ['servo', 'string-parsing'], robotParts: ['R1', 'R2', 'L1', 'L2', 'R4', 'R3', 'L3', 'L4'],
    description: 'Name to index, case-sensitive, by eight explicit comparisons written in L1..L4 then R1..R4 order. Returns -1 for anything else. Used by /cmd?motor= to accept a joint name as well as a number.',
    crossRefs: { hardwareMap: ['servos.nameLookup'], routes: ['/cmd'] } }),
  S({ id: 'FaceAnimMode', file: MOV, kind: 'type', anchor: 'enum FaceAnimMode : uint8_t {', end: 'brace',
    signature: 'enum FaceAnimMode : uint8_t { FACE_ANIM_LOOP=0, FACE_ANIM_ONCE=1, FACE_ANIM_BOOMERANG=2 }', concepts: ['animation', 'face'], robotParts: [],
    description: 'The three playback modes updateAnimatedFace() implements: cycle, play once and latch, or ping-pong.',
    crossRefs: { hardwareMap: ['faces.playbackModes'] },
    teachingNotes: ['TN-004'] }),
  S({ id: 'movement-externs', file: MOV, kind: 'region', anchor: '// External globals and helpers used by movement/pose sequences', end: { needle: 'extern bool pressingCheck(String cmd, int ms);' },
    signature: 'extern declarations for frameDelay, walkCycles, currentCommand, setServoAngle, setFace, setFaceMode, setFaceWithMode, delayWithFace, enterIdle, pressingCheck',
    concepts: ['firmware', 'movement'], robotParts: [],
    description: 'The exact surface the movement header depends on: three globals and seven functions, all defined in the .ino. This list is the movement layer’s contract with the rest of the firmware.',
    crossRefs: {} }),
  S({ id: 'movement-prototypes', file: MOV, kind: 'region', anchor: '// Pose/animation prototypes', end: { needle: 'void runTurnRight();' },
    signature: 'prototypes for the nineteen movement functions', concepts: ['movement', 'pose', 'simulator'], robotParts: [],
    description: 'The complete movement vocabulary in one block: fifteen poses and four continuous movements. runStandPose is the only one with a parameter, and its default is face = 1.',
    crossRefs: { hardwareMap: ['movements'] } }),
  S({ id: 'face-const-remap', file: FACES, kind: 'macro', anchor: '#define const extern const', end: 'same-line',
    signature: '#define const extern const', concepts: ['macro', 'weak-symbol', 'progmem'], robotParts: [],
    description: 'Redefines the keyword `const` for the rest of the file so that image2cpp output pasted below gains external linkage and can satisfy the weak declarations above without editing each pasted array.',
    crossRefs: {},
    teachingNotes: ['TN-017'] }),
  S({ id: 'FACE_LIST', file: FACES, kind: 'macro', anchor: '#define FACE_LIST \\', end: { needle: '\tX(talk_thinking)' },
    signature: '#define FACE_LIST', concepts: ['macro', 'face'], robotParts: [],
    description: 'Thirty-seven X(name) entries — the single declaration list every face table is generated from. Entry 17 is spelled "defualt", and that spelling propagates into every symbol derived from it.',
    crossRefs: { hardwareMap: ['faces.faceListMacroSource', 'faces.faceListEntryCount'] },
    teachingNotes: ['TN-017', 'TN-001'] }),
  S({ id: 'face-weak-decls', file: FACES, kind: 'macro', anchor: '#define X(name) extern const unsigned char epd_bitmap_##name[] PROGMEM __attribute__((weak));', end: { needle: '#undef X' },
    signature: '#define X(name) extern const unsigned char epd_bitmap_##name[] PROGMEM __attribute__((weak));', concepts: ['weak-symbol', 'macro', 'progmem', 'bitmap'], robotParts: [],
    description: 'Expands FACE_LIST into one weak extern declaration per face. A weak reference that is never defined links successfully as a null pointer instead of failing the build.',
    crossRefs: {},
    teachingNotes: ['TN-001', 'TN-017'] }),
  S({ id: 'face-bitmap-data', file: FACES, kind: 'data', anchor: "// 'sleepy-1', 128x64px", end: 'eof',
    signature: 'const unsigned char epd_bitmap_<name>[] PROGMEM = { ... }  ×N', concepts: ['progmem', 'bitmap', 'face'], robotParts: [],
    description: 'The pasted image2cpp output: one 1024-byte horizontal-scan array per defined frame, all in flash. Per-face frame locations are recorded in hardware-map.json rather than here; two of the declared names have no array anywhere in this region.',
    crossRefs: { hardwareMap: ['faces.bitmapDataLocation', 'faces.faces[].frames'] },
    teachingNotes: ['TN-001'] }),
  S({ id: 'index_html', file: PORTAL, kind: 'data', anchor: 'const char index_html[] PROGMEM = R"rawliteral(', end: { needle: ')rawliteral";' },
    signature: 'const char index_html[] PROGMEM', concepts: ['ap-mode', 'http', 'progmem'], robotParts: [],
    description: 'The entire captive-portal control UI — HTML, CSS and JavaScript — as one raw string literal in flash, served verbatim by handleRoot(). It is the client that calls /cmd, /getSettings, /setSettings and the /api/wifi/* endpoints.',
    crossRefs: { routes: ['/'], hardwareMap: ['network.http.routes[/].bodySource'] } }),
];

// Movement functions: located by anchor, everything else derived from hardware-map.
const MOVEMENT_DESCRIPTIONS = {
  runRestPose: 'Prints REST, selects the "rest" face in BOOMERANG mode, then commands all eight joints to 90 degrees in index order. No waits, so the eight writes are separated only by motorCurrentDelay.',
  runStandPose: 'Prints STAND and commands the eight-joint stand vector. The face argument gates both ends: with face == 1 it selects the "stand" face in ONCE mode first and calls enterIdle() last; with face == 0 it does neither, which is how the other poses use it as a plain reset.',
  runWavePose: 'Prints WAVE, selects the "wave" face in ONCE mode, resets to the stand vector without a face, commands R4/L3/L2/R1 to 80/180/90/100, then alternates L3 between 180 and 100 four times with 300 ms waits. Ends with a full stand pose and clears the command if it is still "wave".',
  runDancePose: 'Prints DANCE, selects the "dance" face in LOOP mode, commands R1/R2/L1/L2 to 90 and R4/R3/L3/L4 to 160/160/10/10, then alternates the four lower joints between two vectors five times at 300 ms. The only pose that uses LOOP playback.',
  runSwimPose: 'Prints SWIM, selects the "swim" face in ONCE mode, commands all eight joints to 90, then alternates R1/R2/L1/L2 between 135/45/45/135 and 90/90/90/90 four times at 400 ms.',
  runPointPose: 'Prints POINT, selects the "point" face in BOOMERANG mode, commands one asymmetric eight-joint vector, holds it for two seconds, and returns to stand. The only pose whose face runs at 5 fps.',
  runPushupPose: 'Prints PUSHUP, selects the "pushup" face in ONCE mode, resets to stand, commands L1/R1/L3/R3 to 0/180/90/90, then alternates L3/R3 between 0/180 and 90/90 four times with 600 and 500 ms waits.',
  runBowPose: 'Prints BOW, selects the "bow" face in ONCE mode, resets to stand, commands an eight-joint vector, holds 600 ms, commands L3/R3 to 90 and holds three seconds before returning to stand.',
  runCutePose: 'Prints CUTE, selects the "cute" face in ONCE mode, resets to stand, commands an eight-joint vector, then alternates R4/L4 between 180/45 and 135/0 five times at 300 ms.',
  runFreakyPose: 'Prints FREAKY, selects the "freaky" face in ONCE mode, resets to stand, commands a six-joint vector, then alternates R3 between 25 and 0 three times at 400 ms.',
  runWormPose: 'Prints WORM, selects the "worm" face in ONCE mode, resets to stand, then alternates the four lower joints between two mirrored vectors five times at 300 ms.',
  runShakePose: 'Prints SHAKE, selects the "shake" face in ONCE mode, resets to stand, then alternates R4/L4 between two vectors five times at 300 ms.',
  runShrugPose: 'Prints SHRUG, resets to stand FIRST and only then selects a face — and the face it selects first is "dead", in ONCE mode, before switching to "shrug" a second later. Commands two vectors with 1000 and 1500 ms holds.',
  runDeadPose: 'Prints DEAD, resets to stand, selects the "dead" face in BOOMERANG mode, waits 200 ms and commands the four lower joints to 90. One of only two poses that does not end with a return to stand — runRestPose is the other.',
  runCrabPose: 'Prints CRAB, selects the "crab" face in ONCE mode, resets to stand, then alternates all four lower joints between two vectors five times at 300 ms.',
  runWalkPose: 'Prints WALK FWD, selects the "walk" face in ONCE mode, commands an initial R3/L3/R2/L1 vector, then runs walkCycles iterations of a seven-phase sequence. Every phase ends with pressingCheck("forward", frameDelay), which aborts the whole function — after commanding a stand pose — the moment currentCommand stops being "forward".',
  runWalkBackward: 'Prints WALK BACK and runs the same seven-phase structure as runWalkPose with the joint targets reversed, gated on currentCommand still being "backward". It has no initial vector outside the loop.',
  runTurnLeft: 'Prints TURN LEFT, then runs walkCycles iterations of two four-phase leg-set moves — the source comments name them legset 1 (R1 L2) and legset 2 (R2 L1) — each phase gated on currentCommand still being "left".',
  runTurnRight: 'Prints TURN RIGHT and runs the mirror of runTurnLeft, taking legset 2 before legset 1, gated on currentCommand still being "right".',
  enterIdle: null,   // annotated as a helper above
  exitIdle: null,
};

const MOVEMENT_TEACHING_NOTES = {
  runStandPose: ['TN-005', 'TN-011'],
  runWavePose: ['TN-010', 'TN-002'],
  runWalkPose: ['TN-011', 'TN-010', 'TN-002'],
  runWalkBackward: ['TN-011', 'TN-010'],
  runTurnLeft: ['TN-011', 'TN-010'],
  runTurnRight: ['TN-011', 'TN-010'],
  runShrugPose: ['TN-004'],
  runDeadPose: ['TN-004'],
  runDancePose: ['TN-004'],
};

// --------------------------------------------------------------------------
// 4. Curriculum spine — the report's module table, mapped onto symbols.
//    `grounding: "conceptual"` is a DELIVERABLE, not a gap to be filled in
//    silently: it names the modules whose claim cannot be traced to a pinned
//    firmware symbol, which is exactly what Gate F asks for.
// --------------------------------------------------------------------------
const CURRICULUM = [
  { id: 'meet-sesame', module: 'Meet Sesame', mainExperience: 'rotate/explode 3D robot', realSesameConcept: 'eight joints, body, OLED, controller',
    concepts: ['servo', 'oled', 'esp32'], symbols: ['ServoName', 'servos-array', 'display-object', 'ServoNames'], grounding: 'factual' },
  { id: 'inside-the-brain', module: 'Inside the brain', mainExperience: 'click CPU/memory/GPIO', realSesameConcept: 'ESP32-S2/S3 variants',
    concepts: ['esp32', 'gpio'], symbols: ['servo-pin-table', 'i2c-pin-defines'], grounding: 'conceptual',
    conceptualReason: 'Firmware source names GPIO numbers and nothing else about the SoC. There is no symbol for CPU, memory or peripheral layout, and the MCU family per board comes from firmware/README.md, which hardware-map.json marks mcuFamilyVerified: false. Pin assignment may be taught as fact; anything about the chip interior must be labelled conceptual.' },
  { id: 'command-one-joint', module: 'Command one joint', mainExperience: 'slider moves R1', realSesameConcept: 'setServoAngle()',
    concepts: ['servo', 'calibration', 'quantisation'], symbols: ['setServoAngle', 'servoSubtrim', 'handleCommandWeb', 'servoNameToIndex'], grounding: 'factual' },
  { id: 'how-pwm-asks', module: 'How PWM asks a servo to move', mainExperience: 'pulse-width visualizer', realSesameConcept: '50-Hz servo control',
    concepts: ['pwm', 'ledc', 'quantisation', 'servo'], symbols: ['setup', 'setServoAngle', 'servos-array'], grounding: 'factual',
    groundingNote: 'The 50 Hz frame, the pulse-range request and the 0–180 command range are Sesame source. The angle-to-pulse arithmetic and the 10-bit truncation are ESP32Servo 3.0.9, cited by library+version+line in TN-006 and TN-007 rather than by a firmware line. No pulse in this project has ever been observed on hardware.' },
  { id: 'build-a-leg-pose', module: 'Build a leg pose', mainExperience: 'coordinate two joints', realSesameConcept: 'hip/leg relation',
    concepts: ['pose', 'servo'], symbols: ['runStandPose', 'runRestPose'], grounding: 'conceptual',
    conceptualReason: 'The firmware has no notion of a hip or a leg. It has eight indices and a name per index; which index is a hip, which limb a pair belongs to, and even left versus right are all semantic readings carried in hardware/joint-map.json with verified: false, and per docs/plan.md they can never be settled. Pose vectors are factual; the anatomy they are described with is not.' },
  { id: 'four-legs-cooperate', module: 'Make four legs cooperate', mainExperience: 'inspect stand/wave', realSesameConcept: 'procedural pose sequences',
    concepts: ['pose', 'movement', 'timing'], symbols: ['runStandPose', 'runWavePose', 'movement-prototypes', 'command-dispatch'], grounding: 'factual' },
  { id: 'build-a-movement', module: 'Build a movement', mainExperience: 'frame editor', realSesameConcept: 'same idea as Sesame Studio',
    concepts: ['movement', 'timing'], symbols: ['runWalkPose', 'animation-constants'], grounding: 'conceptual',
    conceptualReason: 'The firmware contains no frame editor and no movement data format — movements are hand-written C++ functions, which is precisely why they cannot be edited at runtime. Sesame Studio is a separate upstream tool under firmware/upstream/software/sesame-studio/ and is not covered by this annotation set. The lesson may show runWalkPose as the thing being replaced, but the editor itself belongs to this app.' },
  { id: 'sesames-face', module: "Sesame's face", mainExperience: 'pixel editor', realSesameConcept: '128×64 bitmap',
    concepts: ['bitmap', 'face', 'progmem'], symbols: ['updateFaceBitmap', 'face-bitmap-data', 'FACE_LIST', 'faceEntries'], grounding: 'factual' },
  { id: 'two-wires-to-a-face', module: 'Two wires to a face', mainExperience: 'animated bytes', realSesameConcept: 'I²C + SSD1306',
    concepts: ['i2c', 'oled', 'animation'], symbols: ['i2c-pin-defines', 'display-config-defines', 'display-object', 'setup', 'updateFaceBitmap', 'updateAnimatedFace'], grounding: 'factual',
    groundingNote: 'Pins, address, bus init and the draw call are all Sesame source. The byte-level I²C transaction itself is inside Adafruit_SSD1306 and has no annotation here; a lesson that animates individual bus bytes is modelling the library, not this firmware.' },
  { id: 'read-the-firmware', module: 'Read the firmware', mainExperience: 'clickable real code', realSesameConcept: '.ino + movement header',
    concepts: ['firmware', 'event-loop', 'boot'], symbols: ['ino-includes', 'setup', 'loop', 'movement-externs', 'movement-prototypes'], grounding: 'factual',
    groundingNote: 'This module is the source explorer itself, so its backing symbol set is the whole of this file.' },
  { id: 'talk-over-serial', module: 'Talk over serial', mainExperience: 'console experiment', realSesameConcept: 'serial CLI',
    concepts: ['serial', 'cli', 'calibration'], symbols: ['serial-cli', 'servoSubtrim', 'setServoAngle'], grounding: 'factual' },
  { id: 'sesame-on-a-network', module: 'Put Sesame on a network', mainExperience: 'AP/station visual', realSesameConcept: 'Wi-Fi/IP concepts',
    concepts: ['wifi', 'ap-mode', 'dns', 'mdns', 'state-machine'], symbols: ['network-config-defines', 'setup', 'connectToWifi', 'updateWifiSetup', 'startMdns', 'dns-server', 'handleWifiScan', 'handleWifiConnect', 'handleWifiStatus'], grounding: 'factual' },
  { id: 'send-an-http-command', module: 'Send an HTTP command', mainExperience: 'request builder', realSesameConcept: '/api/command',
    concepts: ['http', 'api', 'route', 'json'], symbols: ['handleApiCommand', 'handleCommandWeb', 'handleNotFound', 'setup', 'command-dispatch'], grounding: 'factual' },
  { id: 'read-json-state', module: 'Read JSON state', mainExperience: 'inspect response', realSesameConcept: 'API contract',
    concepts: ['json', 'api', 'state'], symbols: ['handleGetStatus', 'handleGetSettings', 'jsonEscape', 'animation-state-globals'], grounding: 'factual' },
  { id: 'debug-a-robot', module: 'Debug a robot', mainExperience: 'injected failures', realSesameConcept: 'calibration/I²C/API mistakes',
    concepts: ['calibration', 'i2c', 'error-handling', 'api'], symbols: ['setServoAngle', 'servoSubtrim', 'setup', 'handleCommandWeb', 'handleNotFound', 'setFace', 'countFrames'], grounding: 'factual',
    groundingNote: 'Each failure mode this module teaches has a real source location — subtrim saturation, the display-init hard stop, 400/404/405 responses, and the empty-face fallback. The injection mechanism that triggers them on demand is a feature of this app and is not in firmware.' },
  { id: 'real-versus-virtual', module: 'Real versus virtual', mainExperience: 'backend switch', realSesameConcept: 'same SesameRobot contract',
    concepts: ['simulator', 'emulator'], symbols: [], grounding: 'conceptual',
    conceptualReason: 'The SesameRobot contract is this app’s own abstraction; no symbol in the pinned firmware corresponds to it. Additionally, per docs/plan.md "Standing constraint — no physical hardware, ever", "real" in this module can only ever mean "real firmware executing under QEMU", never a physical robot — Phase 3 and RealSesameRobot are permanently out of scope, and the module copy must say so.' },
  { id: 'what-an-emulator-is', module: 'What an emulator really is', mainExperience: 'CPU/peripheral explainer', realSesameConcept: 'Renode',
    concepts: ['emulator', 'esp32'], symbols: [], grounding: 'conceptual',
    conceptualReason: 'Nothing in the firmware describes its own execution environment. The report names Renode, which docs/plan.md records as superseded by QEMU; whichever is used, the subject matter is the emulator, not Sesame source, so this module can never be grounded in a pinned symbol.' },
  { id: 'inside-renode', module: 'Inside Renode', mainExperience: 'step virtual machine', realSesameConcept: 'bus/memory/peripheral/time',
    concepts: ['emulator'], symbols: [], grounding: 'conceptual',
    conceptualReason: 'Same as the previous module, and additionally the Renode track is closed (docs/plan.md, Phase 4 superseded; ISSUE-20260823-001 wont_fix). If this module is built at all it must be rewritten against QEMU, and it will still have no backing firmware symbol.' },
  { id: 'build-your-own-experiment', module: 'Build your own experiment', mainExperience: 'unrestricted Lab', realSesameConcept: 'synthesis',
    concepts: [], symbols: [], grounding: 'conceptual',
    conceptualReason: 'A synthesis module with no single subject. It inherits whatever grounding the modules the learner draws on already have; it has none of its own.' },
];

// --------------------------------------------------------------------------
// 5. Resolve every anchor against the pinned tree.
// --------------------------------------------------------------------------
function resolveSymbol(sym) {
  const startLine = locate(sym.file, sym.anchor);
  let endLine;
  if (sym.end === 'brace') endLine = braceEnd(sym.file, startLine);
  else if (sym.end === 'same-line') endLine = startLine;
  else if (sym.end === 'eof') endLine = lines(sym.file).length;
  else endLine = locateAfter(sym.file, sym.end.needle, startLine);
  if (endLine < startLine) die(`${sym.id}: end line ${endLine} precedes start line ${startLine}`);
  return {
    id: sym.id,
    kind: sym.kind,
    file: sym.file,
    startLine,
    endLine,
    lineCount: endLine - startLine + 1,
    startLineText: lineText(sym.file, startLine),
    endLineText: lineText(sym.file, endLine),
    signature: sym.signature,
    description: sym.description,
    concepts: [...sym.concepts].sort(),
    robotParts: sym.robotParts ?? [],
    crossRefs: sym.crossRefs ?? {},
    teachingNotes: sym.teachingNotes ?? [],
    lesson: null,   // filled from CURRICULUM below
    lessons: [],
    commentary: sym.commentary ?? null,
  };
}

const resolved = SYMBOLS.map(resolveSymbol);

// ---- movement functions, derived from hardware-map + located by anchor -----
const JOINT_ORDER = HW.servos.order;
const jointRank = new Map(JOINT_ORDER.map((j, i) => [j, i]));

function walkSteps(steps, visit) {
  for (const st of steps) {
    visit(st);
    if (Array.isArray(st.steps)) walkSteps(st.steps, visit);
    if (Array.isArray(st.branches)) for (const b of st.branches) if (Array.isArray(b.steps)) walkSteps(b.steps, visit);
  }
}

const movementByName = new Map(HW.movements.map((m) => [m.function, m]));

function directJoints(mv) {
  const set = new Set();
  walkSteps(mv.steps, (st) => { if (st.type === 'servo' && st.joint) set.add(st.joint); });
  return [...set].sort((a, b) => jointRank.get(a) - jointRank.get(b));
}
function transitiveJoints(mv, seen = new Set()) {
  if (seen.has(mv.function)) return new Set();
  seen.add(mv.function);
  const set = new Set(directJoints(mv));
  walkSteps(mv.steps, (st) => {
    if (st.type === 'call' && movementByName.has(st.function)) {
      for (const j of transitiveJoints(movementByName.get(st.function), seen)) set.add(j);
    }
  });
  return set;
}
function directFaces(mv) {
  const set = new Set();
  walkSteps(mv.steps, (st) => { if (st.type === 'face' && st.name) set.add(st.name); });
  return [...set].sort();
}
function directCalls(mv) {
  const set = new Set();
  walkSteps(mv.steps, (st) => {
    if (st.type === 'call' && st.function) set.add(st.function);
    if (st.type === 'delay' && st.via) set.add(st.via);
    if (st.type === 'servo') set.add('setServoAngle');
    if (st.type === 'face') set.add('setFaceWithMode');
    if (st.type === 'guard' && st.via) set.add(st.via);
  });
  return [...set].sort();
}

const SERIAL_BY_FN = new Map();
for (const e of HW.commands.serialCli) {
  if (!e.movementFunction) continue;
  if (!SERIAL_BY_FN.has(e.movementFunction)) SERIAL_BY_FN.set(e.movementFunction, []);
  SERIAL_BY_FN.get(e.movementFunction).push(...e.input);
}

const MOVEMENT_CONCEPTS = {
  pose: ['movement', 'pose', 'servo', 'timing', 'animation', 'face'],
  movement: ['movement', 'servo', 'timing', 'animation', 'face', 'reentrancy', 'state'],
};

for (const mv of HW.movements) {
  if (MOVEMENT_DESCRIPTIONS[mv.function] === null) continue;      // already a helper symbol
  const desc = MOVEMENT_DESCRIPTIONS[mv.function];
  if (!desc) die(`no curated description for movement function ${mv.function}`);
  const anchor = `inline ${mv.signature.replace(/^void /, 'void ')} {`.replace('()', '(')
    .replace('(', '(');   // keep the literal signature; anchored below instead
  const startLine = locate(mv.source.file, `inline void ${mv.function}(`);
  const endLine = braceEnd(mv.source.file, startLine);
  // Consistency gate: hardware-map.json recorded these independently in F4.
  if (startLine !== mv.sourceRange.from.line || endLine !== mv.sourceRange.to.line) {
    die(`${mv.function}: located ${mv.source.file}:${startLine}-${endLine} but hardware-map.json records ${mv.sourceRange.from.line}-${mv.sourceRange.to.line}`);
  }
  void anchor;
  const parts = directJoints(mv);
  const trans = [...transitiveJoints(mv)].sort((a, b) => jointRank.get(a) - jointRank.get(b));
  resolved.push({
    id: mv.function,
    kind: mv.kind === 'movement' ? 'movement-function' : 'pose-function',
    file: mv.source.file,
    startLine,
    endLine,
    lineCount: endLine - startLine + 1,
    startLineText: lineText(mv.source.file, startLine),
    endLineText: lineText(mv.source.file, endLine),
    signature: mv.signature,
    description: desc,
    concepts: [...MOVEMENT_CONCEPTS[mv.kind === 'movement' ? 'movement' : 'pose']].sort(),
    robotParts: parts,
    robotPartsTransitive: trans,
    crossRefs: {
      movements: [mv.function],
      commands: mv.triggeredByCommand,
      faces: directFaces(mv),
      calls: directCalls(mv),
      serialCli: (SERIAL_BY_FN.get(mv.function) ?? []).sort(),
      hardwareMap: [`movements[${mv.function}]`],
    },
    teachingNotes: MOVEMENT_TEACHING_NOTES[mv.function] ?? [],
    lesson: null,
    lessons: [],
    commentary: null,
  });
}

resolved.sort((a, b) => (a.file === b.file ? a.startLine - b.startLine : a.file.localeCompare(b.file)));
const SYMBOL_IDS = new Set(resolved.map((s) => s.id));

// ---- lesson back-links -----------------------------------------------------
for (const mod of CURRICULUM) {
  for (const sid of mod.symbols) {
    if (!SYMBOL_IDS.has(sid)) die(`curriculum module ${mod.id} references unknown symbol ${sid}`);
    const s = resolved.find((x) => x.id === sid);
    s.lessons.push(mod.id);
    if (s.lesson === null) s.lesson = mod.id;
  }
  for (const cid of mod.concepts) if (!CONCEPT_IDS.has(cid)) die(`curriculum module ${mod.id} references unknown concept ${cid}`);
}
// Every movement function belongs to the module that teaches sequences.
for (const s of resolved) {
  if ((s.kind === 'pose-function' || s.kind === 'movement-function') && s.lessons.length === 0) {
    s.lessons.push('four-legs-cooperate');
    s.lesson = 'four-legs-cooperate';
  }
}

// ---- validate symbol → concept / part / note references --------------------
const NOTE_IDS = new Set(TEACHING_NOTES.map((n) => n.id));
for (const s of resolved) {
  for (const c of s.concepts) if (!CONCEPT_IDS.has(c)) die(`symbol ${s.id} uses unknown concept ${c}`);
  for (const p of s.robotParts) if (!jointRank.has(p)) die(`symbol ${s.id} uses unknown robot part ${p}`);
  for (const n of s.teachingNotes) if (!NOTE_IDS.has(n)) die(`symbol ${s.id} references unknown teaching note ${n}`);
}

// ---- resolve teaching-note evidence ---------------------------------------
const notes = TEACHING_NOTES.map((n) => {
  for (const sid of n.symbols) if (!SYMBOL_IDS.has(sid)) die(`${n.id} references unknown symbol ${sid}`);
  for (const cid of n.concepts) if (!CONCEPT_IDS.has(cid)) die(`${n.id} references unknown concept ${cid}`);
  const evidence = n.evidenceAnchors.map((a) => {
    const line = locate(a.file, a.needle, a.occurrence ?? null);
    return { file: a.file, line, text: lineText(a.file, line) };
  });
  return {
    id: n.id, title: n.title, kind: n.kind, severity: n.severity,
    summary: n.summary,
    evidence,
    libraryEvidence: n.libraryEvidence ?? null,
    symbols: n.symbols,
    concepts: [...n.concepts].sort(),
    references: n.references,
    commentary: n.commentary ?? null,
  };
});

// ---- resolve concepts ------------------------------------------------------
const conceptsOut = CONCEPTS.map((c) => {
  if (!SYMBOL_IDS.has(c.primaryAnchor)) die(`concept ${c.id} has unknown primaryAnchor ${c.primaryAnchor}`);
  const anchorSym = resolved.find((s) => s.id === c.primaryAnchor);
  return {
    id: c.id,
    label: c.label,
    verbatimFromReport: c.verbatimFromReport === true,
    levels: c.levels,
    primaryAnchor: {
      symbol: c.primaryAnchor,
      file: anchorSym.file,
      line: anchorSym.startLine,
      text: anchorSym.startLineText,
    },
    symbols: resolved.filter((s) => s.concepts.includes(c.id)).map((s) => s.id),
    teachingNotes: notes.filter((n) => n.concepts.includes(c.id)).map((n) => n.id),
    lessons: CURRICULUM.filter((m) => m.concepts.includes(c.id)).map((m) => m.id),
  };
});

// ---- curriculum out --------------------------------------------------------
const curriculumOut = CURRICULUM.map((m) => ({
  id: m.id,
  module: m.module,
  mainExperience: m.mainExperience,
  realSesameConcept: m.realSesameConcept,
  concepts: m.concepts,
  symbols: m.symbols,
  teachingNotes: [...new Set(m.symbols.flatMap((sid) => resolved.find((s) => s.id === sid).teachingNotes))].sort(),
  grounding: m.grounding,
  groundingNote: m.groundingNote ?? null,
  conceptualReason: m.conceptualReason ?? null,
}));

// --------------------------------------------------------------------------
// 6. Coverage — computed, never typed.
// --------------------------------------------------------------------------
const ANNOTATED_FILES = [INO, MOV, FACES, PORTAL];
const coveredLines = {};
for (const f of ANNOTATED_FILES) {
  const total = lines(f).length;
  const mask = new Array(total + 1).fill(false);
  for (const s of resolved) {
    if (s.file !== f) continue;
    for (let i = s.startLine; i <= s.endLine; i++) mask[i] = true;
  }
  const covered = mask.filter(Boolean).length;
  coveredLines[f] = { totalLines: total, annotatedLines: covered, annotatedPct: Math.round((covered / total) * 1000) / 10 };
}

const routesAnnotated = new Set(resolved.flatMap((s) => s.crossRefs.routes ?? []));
const bootStepsAnnotated = new Set(resolved.flatMap((s) => s.crossRefs.bootSteps ?? []));
const movementsAnnotated = resolved.filter((s) => s.kind === 'pose-function' || s.kind === 'movement-function').length;
const commandsAnnotated = new Set(resolved.flatMap((s) => s.crossRefs.commands ?? []));
const hwCommands = HW.commands.vocabulary.filter((v) => v.command !== '' && v.command !== 'stop').map((v) => v.command);

const coverage = {
  note: 'Computed by scripts/build-source-annotations.mjs from the resolved symbol table. "annotatedLines" counts lines inside at least one symbol range, so nested regions (the two dispatchers inside loop()) are counted once.',
  files: coveredLines,
  symbols: {
    total: resolved.length,
    byKind: Object.fromEntries(Object.entries(resolved.reduce((a, s) => { a[s.kind] = (a[s.kind] ?? 0) + 1; return a; }, {})).sort()),
  },
  teachingSurface: {
    movementFunctions: { annotated: movementsAnnotated, inHardwareMap: HW.movements.filter((m) => MOVEMENT_DESCRIPTIONS[m.function] !== null).length },
    httpRoutes: { annotated: routesAnnotated.size, inHardwareMap: HW.network.http.routes.length },
    bootSteps: { referenced: bootStepsAnnotated.size, inHardwareMap: HW.bootOrder.length },
    commandVocabulary: { referenced: [...commandsAnnotated].filter((c) => hwCommands.includes(c)).length, inHardwareMap: hwCommands.length },
    faceRegistry: {
      referencedByName: [...new Set(resolved.flatMap((s) => s.crossRefs.faces ?? []))].length,
      inHardwareMap: HW.faces.faces.length,
      note: 'Faces are annotated as a registry and a pipeline (FACE_LIST, faceEntries, setFace, updateAnimatedFace), not one symbol per face. Per-face frame data stays in hardware-map.json.',
    },
  },
  concepts: { total: conceptsOut.length, verbatimFromReport: conceptsOut.filter((c) => c.verbatimFromReport).length, withoutSymbols: conceptsOut.filter((c) => c.symbols.length === 0).map((c) => c.id) },
  teachingNotes: { total: notes.length, byKind: Object.fromEntries(Object.entries(notes.reduce((a, n) => { a[n.kind] = (a[n.kind] ?? 0) + 1; return a; }, {})).sort()) },
  curriculum: {
    modules: curriculumOut.length,
    factual: curriculumOut.filter((m) => m.grounding === 'factual').length,
    conceptual: curriculumOut.filter((m) => m.grounding === 'conceptual').length,
    conceptualModules: curriculumOut.filter((m) => m.grounding === 'conceptual').map((m) => m.id),
  },
};

// --------------------------------------------------------------------------
// 7. Emit
// --------------------------------------------------------------------------
const doc = {
  meta: {
    schemaVersion: '1.0.0',
    schema: './source-annotations.schema.json',
    task: 'L3 — source-explorer annotation layer (Phase 2)',
    generatedAt: GENERATED_AT,
    generatedBy: 'scripts/build-source-annotations.mjs',
    upstreamCommit: PIN.commit,
    upstreamRepo: PIN.repoUrl,
    upstreamPin: 'firmware/upstream.pin.json',
    pathsRelativeTo: 'the upstream repository root. "firmware/sesame-firmware-main.ino" resolves to firmware/upstream/firmware/sesame-firmware-main.ino in this repo, at meta.upstreamCommit.',
    filesAnnotated: ANNOTATED_FILES.map((f) => ({ file: f, lines: lines(f).length, sha256: sha256File(f) })),
    epistemicContract:
      'Every symbol, concept and teaching note resolves to file:line inside the pinned tree, and carries the exact source text of its first and last line so a validator can re-read and compare. `description` states what the code does and is checkable against the cited lines. Judgements live in `commentary` and are labelled as such. Facts that belong to a LIBRARY rather than to Sesame source carry a `libraryEvidence` object (library + version + path-within-library + line), deliberately not shaped like a firmware citation, because the library tree is gitignored.',
    noHardwareClaims:
      'Per docs/plan.md, "Standing constraint — no physical hardware, ever": this project will never run on a physical robot. No annotation in this file asserts that a servo moved, a joint rotated, or a pulse was observed at a pin — only what the code commands. Any lesson built on this file must read the same way.',
    relationshipToHardwareMap:
      'hardware/hardware-map.json (F4) owns the ENTITIES: pins, per-movement choreography, the route table, boot order, and the face registry. This file owns the READING SURFACE: which span of source a learner is looking at, what it does, which concepts it teaches, and where it is surprising. Entities are referenced by key through `crossRefs`; nothing in hardware-map.json is restated here. Movement symbol line ranges are located independently by anchor and then asserted equal to hardware-map.json\'s, so the two artifacts fail loudly if they ever disagree.',
    gateF:
      'Gate F: every lesson claiming "this is how Sesame actually works" must point to a pinned firmware symbol or source location; if it cannot, it must be labelled conceptual rather than factual. `curriculum[].grounding` is the machine-checkable form of that rule, and `curriculum[].conceptualReason` says why each ungrounded module cannot be grounded.',
    consumers: [
      'Phase 2 source explorer UI (four synchronized panes: source ↔ architecture node ↔ robot part ↔ runtime event)',
      'Phase 2 lesson authoring — curriculum[].grounding gates factual claims',
      'Interactive architecture graph — concepts[] and crossRefs supply the node/edge vocabulary',
    ],
  },
  coverage,
  concepts: conceptsOut,
  symbols: resolved,
  teachingNotes: notes,
  curriculum: curriculumOut,
};

const text = `${JSON.stringify(doc, null, 2)}\n`;

if (CHECK) {
  if (!existsSync(OUT)) { console.error(`FAIL  ${rel(OUT)} does not exist — run: node scripts/build-source-annotations.mjs`); process.exit(1); }
  const existing = readFileSync(OUT, 'utf8');
  const strip = (t) => { const o = JSON.parse(t); if (o.meta) delete o.meta.generatedAt; return JSON.stringify(o); };
  if (strip(existing) !== strip(text)) {
    console.error(`FAIL  ${rel(OUT)} is STALE — re-run: node scripts/build-source-annotations.mjs`);
    process.exit(1);
  }
  console.log(`OK    ${rel(OUT)} up to date (${resolved.length} symbols, ${conceptsOut.length} concepts, ${notes.length} teaching notes)`);
} else {
  writeFileSync(OUT, text, 'utf8');
  console.log(`OK    ${rel(OUT)}`);
  console.log(`      ${resolved.length} symbols · ${conceptsOut.length} concepts · ${notes.length} teaching notes · ${curriculumOut.length} curriculum modules (${coverage.curriculum.conceptual} conceptual)`);
  for (const f of ANNOTATED_FILES) {
    const c = coveredLines[f];
    console.log(`      ${f}  ${c.annotatedLines}/${c.totalLines} lines annotated (${c.annotatedPct}%)`);
  }
}
