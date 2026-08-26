#!/usr/bin/env node
/**
 * Generates hardware/lessons.json — the LESSON CONTENT LAYER for Phase 2 (task L5).
 *
 * This file is the content. There is no UI here: the runner is a separate task and
 * an unseen consumer, so the emitted JSON is a CONTRACT, not a convenience.
 *
 * WHAT IS AUTHORED AND WHAT IS DERIVED
 *   Authored here : learning goals, ordered steps, the three explanatory levels,
 *                   what the learner manipulates, the expected cause and effect,
 *                   and the checkable success condition of every step.
 *   Derived here  : every citation's file/line (from hardware/source-annotations.json),
 *                   every grounding classification (copied from that file's
 *                   `curriculum[]`, never re-decided), the PWM/quantisation numbers
 *                   (recomputed from ESP32Servo 3.0.9's own arithmetic), the
 *                   per-lesson unions of symbols/concepts/notes/joints/trace layers,
 *                   and the `unlocks` inverse of `prerequisites`.
 *
 * GATE F — the rule this artifact exists to keep
 *   Every lesson claiming "this is how Sesame actually works" must cite a pinned
 *   firmware symbol or source location. If it cannot, it is labelled `conceptual`.
 *   In the data that is `step.claim`: a claim with `type: "factual"` and
 *   `domain: "firmware"` MUST carry at least one `symbol` citation that resolves in
 *   source-annotations.json. `domain: "library"`, `"emulator"` and `"lab"` are the
 *   three honest boundaries — each carries its own citation kind and a mandatory
 *   `boundaryNote` saying what world the fact lives in. `type: "conceptual"` requires
 *   a `conceptualReason` and is forbidden from using "how Sesame actually works"
 *   framing. scripts/validate-lessons.mjs enforces all of it independently.
 *
 * NO HARDWARE CLAIMS
 *   Per docs/plan.md, "Standing constraint — no physical hardware, ever". No lesson
 *   here says a servo moved, a joint rotated, or a pulse was seen. Only what the code
 *   COMMANDS. The validator carries a regex screen as a backstop.
 *
 * Deterministic: same inputs plus the same --generated-at give byte-identical output.
 *
 * Usage:
 *   node scripts/build-lessons.mjs [--out hardware/lessons.json]
 *                                  [--generated-at 2026-08-25T00:00:00Z]
 *                                  [--check]
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, relative } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..');
const rel = (p) => relative(repoRoot, p).replaceAll('\\', '/');

const argv = process.argv.slice(2);
const argOf = (name, dflt) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt;
};
const CHECK = argv.includes('--check');
const OUT = resolve(repoRoot, argOf('--out', 'hardware/lessons.json'));
const GENERATED_AT = argOf('--generated-at', new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'));

const die = (msg) => { console.error(`FAIL  ${msg}`); process.exit(1); };
const readJson = (p) => {
  const abs = resolve(repoRoot, p);
  if (!existsSync(abs)) die(`missing input ${rel(abs)}`);
  try { return JSON.parse(readFileSync(abs, 'utf8')); } catch (e) { die(`${rel(abs)} is not valid JSON: ${e.message}`); }
  return null;
};

// --------------------------------------------------------------------------
// 1. Inputs
// --------------------------------------------------------------------------
const SA = readJson('hardware/source-annotations.json');   // L3 — the grounding authority
const HW = readJson('hardware/hardware-map.json');         // F4 — the entity authority
const REPRO = readJson('reproducibility.json');            // library version pins

const SYM = new Map(SA.symbols.map((s) => [s.id, s]));
const CONCEPT = new Map(SA.concepts.map((c) => [c.id, c]));
const NOTE = new Map(SA.teachingNotes.map((n) => [n.id, n]));
const MODULE = new Map(SA.curriculum.map((m) => [m.id, m]));

/** JOINT_ORDER, read out of the package that defines it rather than retyped. */
const JOINT_ORDER = (() => {
  const src = readFileSync(resolve(repoRoot, 'packages/sesame-model/src/joints.ts'), 'utf8');
  const m = src.match(/export const JOINT_ORDER = \[([^\]]+)\] as const;/);
  if (!m) die('could not read JOINT_ORDER from packages/sesame-model/src/joints.ts');
  const order = m[1].split(',').map((s) => s.trim().replace(/^'|'$/g, '')).filter(Boolean);
  if (order.join(',') !== HW.servos.order.join(',')) {
    die(`JOINT_ORDER (${order.join(',')}) disagrees with hardware-map servos.order (${HW.servos.order.join(',')})`);
  }
  return order;
})();

// --------------------------------------------------------------------------
// 2. Citation builders — the only way a fact gets into this file
// --------------------------------------------------------------------------
/** A pinned firmware symbol. file/startLine/endLine are DERIVED, never typed. */
function sym(id) {
  const s = SYM.get(id);
  if (!s) die(`sym("${id}") is not a symbol in source-annotations.json`);
  return {
    kind: 'symbol',
    symbol: s.id,
    file: s.file,
    startLine: s.startLine,
    endLine: s.endLine,
    signature: s.signature ?? null,
  };
}

/** A path into hardware/hardware-map.json. Resolved at build time AND by the validator. */
function hw(path, note = null) {
  resolveHwPath(path); // dies if it does not resolve
  return { kind: 'hardware-map', path, note };
}

/** A fact that belongs to a LIBRARY, not to Sesame source. Shaped deliberately unlike a firmware citation. */
function lib(library, file, line, text, note) {
  const version = REPRO.libraries?.[library];
  if (!version) die(`lib("${library}") is not pinned in reproducibility.json -> libraries`);
  return { kind: 'library', library, version, file, line, text, note };
}

/** A finding or plan document in this repository. Used for emulator- and project-level facts. */
function doc(path, section = null, evidenceTag = null) {
  if (!existsSync(resolve(repoRoot, path))) die(`doc("${path}") does not exist`);
  return { kind: 'document', doc: path, section, evidenceTag };
}

/** A tracked defect. The validator greps docs/issues.yaml for the id. */
function issue(id) { return { kind: 'issue', id }; }

/** One of L3's 17 teaching notes. Title is derived so it cannot drift. */
function tn(id) {
  const n = NOTE.get(id);
  if (!n) die(`tn("${id}") is not a teaching note in source-annotations.json`);
  return { kind: 'teaching-note', note: n.id, title: n.title };
}

/** Resolve `a.b[2].c` and `a.b[field=value].c` into hardware-map.json. */
function resolveHwPath(path) {
  let cur = HW;
  for (const raw of path.split('.')) {
    const m = raw.match(/^([^[\]]+)((\[[^\]]+\])*)$/);
    if (!m) die(`hardware-map path "${path}" is malformed at "${raw}"`);
    const key = m[1];
    if (cur === null || typeof cur !== 'object' || !(key in cur)) die(`hardware-map path "${path}" does not resolve: no "${key}"`);
    cur = cur[key];
    for (const sel of (m[2] ?? '').matchAll(/\[([^\]]+)\]/g)) {
      const inner = sel[1];
      if (!Array.isArray(cur)) die(`hardware-map path "${path}": [${inner}] applied to a non-array`);
      if (/^\d+$/.test(inner)) {
        cur = cur[Number(inner)];
      } else {
        const eq = inner.indexOf('=');
        if (eq < 0) die(`hardware-map path "${path}": selector "[${inner}]" must be an index or field=value`);
        const f = inner.slice(0, eq), v = inner.slice(eq + 1);
        cur = cur.find((el) => el && String(el[f]) === v);
      }
      if (cur === undefined) die(`hardware-map path "${path}": selector "[${inner}]" matched nothing`);
    }
  }
  return cur;
}

// --------------------------------------------------------------------------
// 3. ESP32Servo 3.0.9 arithmetic, recomputed rather than quoted
// --------------------------------------------------------------------------
const PWM = {
  minPulseUs: HW.servos.servoConfig.attachMinPulseUs,               // 732, requested and NOT clamped
  maxPulseUs: HW.servos.servoConfig.attachMaxPulseUs,               // 2500, AFTER the library clamp
  requestedMaxUs: HW.servos.servoConfig.attachMaxPulseRequestedUs,  // 2929, what the source literally says
  frameUs: HW.servos.servoConfig.pulseQuantisation.frameUs,         // 20000
  ticks: HW.servos.servoConfig.pulseQuantisation.timerWidthTicks,   // 1024
};
const usPerTick = PWM.frameUs / PWM.ticks;
/** Arduino map(), integer-truncating, exactly as Servo::write() -> writeMicroseconds() does it. */
const angleToUs = (deg) => Math.trunc((deg * (PWM.maxPulseUs - PWM.minPulseUs)) / 180) + PWM.minPulseUs;
/** ESP32Servo::usToTicks(), truncating into the 10-bit LEDC frame. */
const usToTicks = (us) => Math.trunc(us / usPerTick);
function quantise(deg) {
  const us = angleToUs(deg);
  const ticks = usToTicks(us);
  return {
    angleDeg: deg,
    requestedPulseUs: us,
    ticks,
    quantisedPulseUs: Number((ticks * usPerTick).toFixed(5)),
  };
}
const SWEEP = Array.from({ length: 181 }, (_, d) => quantise(d));
const DISTINCT_TICKS = new Set(SWEEP.map((q) => q.ticks));
const ALIASED = SWEEP.filter((q, i) => i > 0 && SWEEP[i - 1].ticks === q.ticks).length;
{
  // Cross-check against the numbers F4 recorded independently. If these disagree, stop.
  const pq = HW.servos.servoConfig.pulseQuantisation;
  if (DISTINCT_TICKS.size !== pq.distinctReachablePulseValues) die(`recomputed distinct pulse values ${DISTINCT_TICKS.size} != hardware-map ${pq.distinctReachablePulseValues}`);
  if (ALIASED !== pq.aliasedAngleCount) die(`recomputed aliased angle count ${ALIASED} != hardware-map ${pq.aliasedAngleCount}`);
}
/** The alias pair the lessons use. Asserted, not remembered. */
const ALIAS_PAIR = [99, 100];
if (SWEEP[ALIAS_PAIR[0]].ticks !== SWEEP[ALIAS_PAIR[1]].ticks) die(`${ALIAS_PAIR[0]} and ${ALIAS_PAIR[1]} no longer alias`);

/**
 * Terminal commanded-angle vector of a movement, in JOINT_ORDER, from hardware-map
 * choreography. Follows `call` steps into other movements, because every Sesame
 * movement ends by calling runStandPose() and that call is what sets the final vector.
 */
function terminalPose(fn, seen = new Set()) {
  const mv = HW.movements.find((m) => m.function === fn);
  if (!mv) die(`terminalPose("${fn}"): no such movement in hardware-map.json`);
  if (seen.has(fn)) return {};
  seen.add(fn);
  const last = {};
  const walk = (steps) => {
    for (const s of steps ?? []) {
      if (s.type === 'servo' && typeof s.angleDeg === 'number') last[s.joint] = s.angleDeg;
      else if (s.type === 'call' && HW.movements.some((m) => m.function === s.function)) {
        Object.assign(last, terminalPose(s.function, seen));
      } else if (Array.isArray(s.steps)) walk(s.steps);
    }
  };
  walk(mv.steps);
  return last;
}
/** The same thing as an ordered array, which is the shape a success check carries. */
const poseVector = (fn) => {
  const last = terminalPose(fn);
  return JOINT_ORDER.map((j) => ({ joint: j, angleDeg: last[j] ?? null }));
};
/** The playback mode a movement sets on its face, read from hardware-map choreography. */
function faceModeOf(fn) {
  const mv = HW.movements.find((m) => m.function === fn);
  if (!mv) die(`faceModeOf("${fn}"): no such movement`);
  const find = (steps) => {
    for (const s of steps ?? []) {
      if (s.type === 'face' && s.mode) return s.mode;
      if (Array.isArray(s.steps)) { const r = find(s.steps); if (r) return r; }
    }
    return null;
  };
  const mode = find(mv.steps);
  if (!mode) die(`faceModeOf("${fn}"): no face step with a mode`);
  return mode;
}

/** Joints a movement's own body commands directly, in firmware enum order (L3 already computed it). */
function directJoints(symbolId) {
  const s = SYM.get(symbolId);
  if (!s) die(`directJoints("${symbolId}"): unknown symbol`);
  return s.robotParts.slice();
}

// --------------------------------------------------------------------------
// 4. Vocabularies — the contract with a runner UI this task cannot see
// --------------------------------------------------------------------------
const EXPLANATION_LEVELS = [
  { id: 'beginner12', label: 'Beginner, around age 12', description: 'Short. Sits next to the thing being manipulated. No jargon that has not been shown on screen.' },
  { id: 'beginnerProgrammer', label: 'Beginner programmer', description: 'The same fact in code terms: names, signatures, control flow.' },
  { id: 'architecture', label: 'Architecture view', description: 'Where the fact sits in the stack, and what it is an instance of.' },
];

const STEP_KINDS = [
  { id: 'concept', description: 'A short explanation attached to something manipulable. Never a wall of text.' },
  { id: 'manipulate', description: 'The learner changes something and watches the effect.' },
  { id: 'predict', description: 'The learner commits to an answer before running. The prediction is recorded and compared.' },
  { id: 'observe', description: 'The learner runs something and reads the resulting robot or telemetry state.' },
  { id: 'debug', description: 'Something is wrong on purpose. Framed as ordinary engineering; requires failureIsNormal.' },
  { id: 'explain', description: 'The learner states what happened, usually by selecting the source that caused it.' },
  { id: 'variation', description: 'A small open-ended change with a checkable outcome.' },
];

const CONTROL_KINDS = [
  { id: 'robot-explode', description: '3D robot: rotate, and pull the exploded view apart.' },
  { id: 'joint-picker', description: 'Click a joint on the 3D robot or in the joint list.' },
  { id: 'joint-slider', description: 'Command one servo channel to an angle, 0-180.' },
  { id: 'channel-number', description: 'Type a raw channel index, including out-of-range values.' },
  { id: 'subtrim-control', description: 'Per-channel signed degree offset, -90..90.' },
  { id: 'board-selector', description: 'Switch the board pin profile (s2-mini, distro-v1..v3).' },
  { id: 'pose-runner', description: 'Run one of the firmware movement functions by its command word.' },
  { id: 'command-button', description: 'Send one command word, the way the captive-portal UI does.' },
  { id: 'sequence-editor', description: 'Lab: author an ordered list of commanded angles and delays.' },
  { id: 'face-picker', description: 'Select a face by name, as setFace() does.' },
  { id: 'pixel-editor', description: 'Lab: edit a 128x64 monochrome frame.' },
  { id: 'pwm-inspector', description: 'Angle in, computed pulse and tick count out. Never an observed waveform.' },
  { id: 'source-selector', description: 'Select a span of pinned firmware source in the explorer.' },
  { id: 'graph-node-picker', description: 'Click a node in the architecture graph.' },
  { id: 'trace-inspector', description: 'Read the See-the-Signal ladder, including its provenance badges.' },
  { id: 'http-console', description: 'Build and send a request to one of the firmware routes.' },
  { id: 'serial-console', description: 'Type into the firmware serial CLI.' },
  { id: 'fault-injector', description: 'Turn on one of the declared faults.' },
  { id: 'boot-stepper', description: 'Step the boot sequence one bootOrder entry at a time.' },
  { id: 'backend-switch', description: 'Switch between the behavioural simulator and firmware under QEMU.' },
  { id: 'emulator-controls', description: 'Start, stop and inspect the QEMU-backed robot.' },
  { id: 'none', description: 'No control. Only legal on outline steps and on steps whose success is read off an earlier action.' },
];

const CLAIM_DOMAINS = [
  { id: 'firmware', description: 'A fact about pinned Sesame firmware. Requires at least one resolving symbol citation. This is Gate F.' },
  { id: 'library', description: 'A fact about a pinned third-party library the firmware calls, not about Sesame source. Requires a library citation and a boundaryNote.' },
  { id: 'emulator', description: 'A fact about QEMU or the behavioural simulator. Requires a document citation, a boundaryNote and an observability value.' },
  { id: 'lab', description: 'A fact about Sesame Lab itself (an editor, an injector, an adapter). Requires a document or hardware-map citation and a boundaryNote.' },
  { id: 'none', description: 'Only for conceptual claims, which assert nothing about how Sesame works.' },
];

const OBSERVABILITY = [
  { id: 'ran-in-qemu', description: 'Real firmware instructions executed on emulated silicon and this was in the output.' },
  { id: 'computed-not-observed', description: 'Real arithmetic, performed here. No pin has ever emitted it.' },
  { id: 'inert-in-emulator', description: 'The emulated peripheral models state but produces no signal.' },
  { id: 'simulated', description: 'Produced by the behavioural model, which is not firmware.' },
];

const TRACE_LAYERS = [
  { id: 'ui.command', description: 'A real DOM event in the lab page.' },
  { id: 'http.request', description: "The robot's own HTTP route, whether or not one was actually sent." },
  { id: 'firmware.command', description: 'The command word the firmware would dispatch, and the function it names.' },
  { id: 'movement.enter', description: 'The movement function starting, as announced by its own Serial banner.' },
  { id: 'servo.target', description: 'setServoAngle() reached a channel with an angle.' },
  { id: 'pwm.output', description: 'What that angle becomes at the pin - computed here, never observed.' },
  { id: 'joint.target', description: 'The mechanical joint that servo channel drives. A target, never a position.' },
  { id: 'visual.joint', description: 'What the 3D scene is showing, read back off the scene graph.' },
];
const TRACE_LAYER_IDS = new Set(TRACE_LAYERS.map((l) => l.id));

const PROVENANCE_BADGES = [
  'observed-in-this-app',
  'observed-from-emulator',
  'simulated',
  'inferred-for-explanation',
];

/**
 * Every check type a success condition may use, with the parameters it requires.
 * A runner implements this table. There is deliberately NO "acknowledged",
 * "read", "continue" or "elapsed" check: a step cannot be completed by clicking
 * next or by waiting.
 */
const CHECK_TYPES = [
  { id: 'joints-identified', requires: ['joints'], description: 'The learner named each listed joint by its firmware name.' },
  { id: 'board-switched', requires: ['fromBoard', 'toBoard', 'expectJointNamesUnchanged'], description: 'A board profile change was applied; joint identity did not change with it.' },
  { id: 'source-span-selected', requires: ['symbol'], description: 'The learner selected the named source span in the explorer.' },
  { id: 'pose-vector', requires: ['movement', 'expect'], description: 'All eight channels hold the commanded angles that movement ends on.' },
  { id: 'servo-target', requires: ['joint', 'angleDeg'], description: 'That channel was commanded to that angle.' },
  { id: 'telemetry-absent', requires: ['event', 'afterAction', 'windowMs'], description: 'No such event appeared in the window. Absence is the observable.' },
  { id: 'commanded-angle-collision', requires: ['joint', 'inputAngleA', 'inputAngleB', 'subtrimDeg', 'expectCommandedAngle'], description: 'Two different requested angles produced one commanded angle after subtrim and clamp.' },
  { id: 'quantisation-collision', requires: ['expectSameTicks'], description: 'Two angles produced the same LEDC tick count.' },
  { id: 'pwm-value-matched', requires: ['angleDeg', 'expectRequestedPulseUs', 'expectTicks', 'expectQuantisedPulseUs'], description: 'The learner read the computed pulse and tick count for an angle.' },
  { id: 'quantisation-survey', requires: ['expectDistinctPulseValues', 'expectAliasedAngles'], description: 'A full 0-180 sweep was inspected and the aliasing counted.' },
  { id: 'trace-badge-identified', requires: ['traceLayer', 'expectedProvenance'], description: 'The learner identified what a trace row is really claiming.' },
  { id: 'trace-field-absent', requires: ['traceLayer', 'field'], description: 'The learner found the field the data does not support and cannot show.' },
  { id: 'trace-complete', requires: ['traceLayers'], description: 'One command produced a row on each listed layer, in causal order.' },
  { id: 'movement-joints-identified', requires: ['movement', 'expectDirectJoints'], description: "The learner listed the joints that movement's own body commands." },
  { id: 'sequence-variation', requires: ['basedOnMovement', 'changedField', 'expectSameTerminalPose'], description: 'A timing or ordering change was applied and its effect on the terminal pose checked.' },
  { id: 'sequence-authored', requires: ['minFrames', 'maxCommandedAngleOutOfRange'], description: 'A Lab sequence was authored and every commanded angle stayed in range.' },
  { id: 'face-selected', requires: ['faceName', 'expectFramesRenderedAtLeast'], description: 'That face was selected and at least that many frames were drawn.' },
  { id: 'face-fallback', requires: ['requestedFace', 'expectReportedFace', 'expectFramesRendered'], description: 'A face was requested, the fallback path ran, and the reported name differs from the request.' },
  { id: 'face-reselect', requires: ['faceName', 'expectAnimationRestart'], description: 'The same face was selected twice and the animation did or did not restart.' },
  { id: 'face-after-movement', requires: ['movement', 'expectFace'], description: 'After the movement finished, the face state is the expected one.' },
  { id: 'face-mode-identified', requires: ['movement', 'expectMode'], description: 'The learner identified the playback mode a movement sets.' },
  { id: 'pixel-edit', requires: ['minPixelsChanged'], description: 'The learner changed at least that many pixels in a 128x64 frame.' },
  { id: 'http-request', requires: ['route', 'method', 'expectStatus'], description: 'A request to that route returned that status.' },
  { id: 'http-json-field', requires: ['route', 'jsonPath'], description: 'A field of the JSON response holds the expected value.' },
  { id: 'route-method-probe', requires: ['route', 'method', 'expectStatus'], description: 'The learner probed a route with a method and compared the status to the route table.' },
  { id: 'json-repaired', requires: ['route', 'expectStatus'], description: 'A malformed request body was corrected until the route accepted it.' },
  { id: 'serial-command', requires: ['input', 'expectLogContains'], description: 'A serial CLI line was sent and the firmware log carried the expected text.' },
  { id: 'subtrim-set', requires: ['joint', 'subtrimDeg'], description: 'That channel carries that subtrim offset.' },
  { id: 'boot-halt', requires: ['expectHaltAtBootOrder', 'expectLogContains'], description: 'Boot stopped at that bootOrder step and printed that line.' },
  { id: 'boot-step-reached', requires: ['expectBootOrder'], description: 'Boot reached that bootOrder step.' },
  { id: 'fault-diagnosed', requires: ['faultId', 'expectIdentifiedSymbol'], description: 'An injected fault was traced to the source span that causes it.' },
  { id: 'backend-switched', requires: ['fromBackend', 'toBackend', 'expectSameCommandedPose'], description: 'The same command was issued on both backends and the commanded poses compared.' },
  { id: 'emulator-boot-observed', requires: ['backend', 'expectBootOrderReached'], description: 'A real firmware boot under QEMU reached that step.' },
  { id: 'lab-project-saved', requires: ['projectKind'], description: 'The learner saved a Lab project of that kind.' },
];
const CHECK_TYPE = new Map(CHECK_TYPES.map((c) => [c.id, c]));

/**
 * Faults the debugging lessons may inject. Every one is a real firmware behaviour
 * with a citation; the INJECTOR is a Sesame Lab feature and says so.
 */
const FAULTS = [
  { id: 'blank-face-stand', title: 'The stand face renders nothing', causeSymbol: 'face-weak-decls', teachingNote: 'TN-001', injectorIsLabFeature: false, note: 'Not injected. This is the shipped behaviour of the pinned firmware.' },
  { id: 'subtrim-saturation', title: 'Large subtrim eats the top of the range', causeSymbol: 'setServoAngle', teachingNote: 'TN-003', injectorIsLabFeature: true, note: 'The firmware behaviour is real; setting the offset from the lab UI is not - firmware only exposes it over serial.' },
  { id: 'oled-init-fail', title: 'The display never initialises and boot stops', causeSymbol: 'setup', teachingNote: 'TN-014', injectorIsLabFeature: true, note: 'The while(1) is real firmware. Making display.begin() fail on demand is a Sesame Lab injection.' },
  { id: 'oled-wrong-address', title: 'The display is addressed at 0x3D instead of 0x3C', causeSymbol: 'display-config-defines', teachingNote: 'TN-014', injectorIsLabFeature: true, note: 'The address constant is real firmware. Changing it at runtime is a Sesame Lab injection; in firmware it is a compile-time define.' },
  { id: 'unknown-command-sticks', title: 'An unrecognised command word is never cleared', causeSymbol: 'command-dispatch', teachingNote: 'TN-010', injectorIsLabFeature: false, note: 'Not injected. Send an unknown word and the shipped dispatcher does this by itself.' },
  { id: 'walk-cancelled-into-idle', title: 'Cancelling a walk runs a whole stand pose and enters idle', causeSymbol: 'pressingCheck', teachingNote: 'TN-011', injectorIsLabFeature: false, note: 'Not injected. Change the command mid-walk and the shipped cancel path does this.' },
  { id: 'status-json-unescaped', title: 'A quote in a command word breaks /api/status', causeSymbol: 'handleGetStatus', teachingNote: 'TN-008', injectorIsLabFeature: false, note: 'Not injected. The route interpolates without calling the escaper that sits 100 lines above it.' },
];
const FAULT_IDS = new Set(FAULTS.map((f) => f.id));

// --------------------------------------------------------------------------
// 5. Authoring helpers
// --------------------------------------------------------------------------
/** Factual claim about pinned FIRMWARE. Gate F: needs a resolving symbol citation. */
const F = (text, citations) => ({ type: 'factual', domain: 'firmware', text, citations, boundaryNote: null, conceptualReason: null, observability: null, groundingDisclosure: false });
/** Factual claim about a pinned LIBRARY the firmware calls. Not Sesame source; says so. */
const LIBF = (text, citations, boundaryNote) => ({ type: 'factual', domain: 'library', text, citations, boundaryNote, conceptualReason: null, observability: null, groundingDisclosure: true });
/** Factual claim about the EMULATOR or the simulator. */
const EMUF = (text, citations, boundaryNote, observability) => ({ type: 'factual', domain: 'emulator', text, citations, boundaryNote, conceptualReason: null, observability, groundingDisclosure: true });
/** Factual claim about SESAME LAB itself - an editor, an injector, an adapter. */
const LABF = (text, citations, boundaryNote) => ({ type: 'factual', domain: 'lab', text, citations, boundaryNote, conceptualReason: null, observability: null, groundingDisclosure: true });
/** Conceptual claim. Asserts nothing about how Sesame works, and must say why it cannot. */
const C = (text, conceptualReason, citations = []) => ({ type: 'conceptual', domain: 'none', text, citations, boundaryNote: null, conceptualReason, observability: null, groundingDisclosure: true });

const M = (control, target, affordance, bounds = null) => {
  if (!CONTROL_KINDS.some((c) => c.id === control)) die(`unknown control kind "${control}"`);
  return { control, target, affordance, bounds };
};
const E = (text, observable) => ({
  text,
  observable: observable.map(([traceLayer, what]) => {
    if (!TRACE_LAYER_IDS.has(traceLayer)) die(`unknown trace layer "${traceLayer}"`);
    return { traceLayer, what };
  }),
});
const OK = (id, description, check, hint, failureIsNormal = null) => {
  const t = CHECK_TYPE.get(check.type);
  if (!t) die(`unknown check type "${check.type}" in success "${id}"`);
  for (const r of t.requires) if (!(r in check)) die(`check "${check.type}" in success "${id}" is missing required parameter "${r}"`);
  return { id, description, check, hint, failureIsNormal };
};

/** Build one step, filling in the link unions from the citations. */
function S(spec) {
  const {
    id, kind, title, detail = 'full',
    b12, prog = null, arch = null,
    deeper = null, claim, manipulate = null, expect = null, success = null,
    concepts = [], notes = [], joints = [], layers = [],
  } = spec;
  if (!STEP_KINDS.some((k) => k.id === kind)) die(`unknown step kind "${kind}" in step "${id}"`);
  const cites = [...claim.citations, ...(deeper?.citations ?? [])];
  const symbols = [...new Set(cites.filter((c) => c.kind === 'symbol').map((c) => c.symbol))];
  const noteIds = [...new Set([...notes, ...cites.filter((c) => c.kind === 'teaching-note').map((c) => c.note)])];
  const hardwareMap = [...new Set(cites.filter((c) => c.kind === 'hardware-map').map((c) => c.path))];
  const traceLayers = [...new Set([...layers, ...(expect?.observable ?? []).map((o) => o.traceLayer)])]
    .sort((a, b) => TRACE_LAYERS.findIndex((l) => l.id === a) - TRACE_LAYERS.findIndex((l) => l.id === b));
  // Joints declared on the step, plus every joint the cited symbols command directly.
  const symbolJoints = symbols.flatMap((s) => SYM.get(s)?.robotParts ?? []);
  const robotParts = JOINT_ORDER.filter((j) => joints.includes(j) || symbolJoints.includes(j));
  for (const j of joints) if (!JOINT_ORDER.includes(j)) die(`step "${id}" names joint "${j}", which is not in JOINT_ORDER`);
  for (const c of concepts) if (!CONCEPT.has(c)) die(`step "${id}" names concept "${c}", which is not in source-annotations.json`);
  for (const n of noteIds) if (!NOTE.has(n)) die(`step "${id}" names teaching note "${n}", which is not in source-annotations.json`);
  return {
    id, order: 0, kind, title, detail,
    explanation: { beginner12: b12, beginnerProgrammer: prog, architecture: arch },
    goDeeper: deeper ? { title: deeper.title, body: deeper.body, citations: deeper.citations ?? [] } : null,
    claim, manipulate, expect, success,
    links: {
      symbols,
      concepts: [...new Set(concepts)].sort(),
      teachingNotes: noteIds.sort(),
      robotParts,
      traceLayers,
      hardwareMap,
    },
  };
}

// --------------------------------------------------------------------------
// 6. The lessons
//
// Order is NOT the research report's table order. It is reordered around
// Sesame's real architecture, and around one specific correction the report
// makes: teach MOVEMENT SEQUENCING before inverse kinematics, because the
// firmware is itself sequence-oriented. Two consequences:
//   - `four-legs-cooperate` (real pose vectors, factual) moves ahead of
//     `build-a-leg-pose` (hip/leg anatomy, conceptual and permanently so).
//   - `inside-the-brain` moves out of slot 2. It is conceptual, and putting an
//     ungrounded module second would teach a 12-year-old that the citations do
//     not mean anything.
// The twelve factual modules run first; the seven conceptual ones close the
// curriculum, where "here is how Sesame works today - how could we improve it?"
// is a question the learner can now actually answer.
// --------------------------------------------------------------------------
const LESSONS = [];
const L = (spec) => { LESSONS.push(spec); };

// ============================================================ 1. meet-sesame
L({
  id: 'meet-sesame',
  title: 'Meet Sesame',
  status: 'polished',
  estimatedMinutes: 12,
  prerequisites: [],
  learningGoal:
    'Name the four things that make Sesame a robot - one controller, eight servo channels, one 128x64 display and the firmware that ties them together - and call any joint by the name the firmware uses for it.',
  willBeAbleTo: [
    'Point at any joint on the 3D robot and give its firmware name.',
    'Explain why the joint order is R1, R2, L1, L2, R4, R3, L3, L4 and not alphabetical.',
    'Say what the lab can and cannot tell you about a real robot.',
  ],
  labHandoff: 'The exploded view and the joint list stay available in Lab as the robot inspector.',
  openQuestions: [
    'The firmware never says which joint is a hip and which is a knee. Where would that information have to come from?',
  ],
  steps: [
    S({
      id: 'eight-channels',
      kind: 'concept',
      title: 'Eight channels, eight names',
      b12: 'Sesame has eight joints. The code does not call them legs or arms. It calls them R1, R2, L1, L2, R4, R3, L3 and L4 - and that order is the order the firmware itself uses.',
      prog: 'A single `Servo servos[8]` array, indexed by an `enum ServoName`. The enum decides the numbering; nothing else does.',
      arch: 'Eight PWM output channels on one microcontroller, addressed by index. Identity is the index; everything else is a label somebody added later.',
      claim: F(
        'The firmware declares exactly eight servo channels and names them with an enum, in the order R1, R2, L1, L2, R4, R3, L3, L4.',
        [sym('servos-array'), sym('ServoName'), sym('ServoNames'), hw('servos.order')],
      ),
      deeper: {
        title: 'Why that order looks scrambled',
        body: 'The enum is the wiring order, not a tour around the body. R4 comes before R3. Anything that re-sorts this list into something tidier is inventing an order the firmware does not have, and the two will disagree the first time you compare them.',
        citations: [sym('ServoName'), hw('servos.orderNote')],
      },
      manipulate: M('robot-explode', 'robot', 'Rotate the robot, then pull the exploded view apart to separate the eight joint modules from the body.'),
      expect: E('Each module you pull out is labelled with its firmware name, and the labels appear in enum order, not left-to-right.', [
        ['visual.joint', 'Eight labelled joint modules, in JOINT_ORDER.'],
      ]),
      success: OK(
        'named-all-eight',
        'Every one of the eight joints has been named correctly.',
        { type: 'joints-identified', joints: JOINT_ORDER },
        'The names are on the modules once you separate them. R and L are the two sides the firmware distinguishes; the digit is which of the four on that side.',
      ),
      concepts: ['servo', 'state'],
    }),
    S({
      id: 'one-pin-each',
      kind: 'manipulate',
      title: 'One wire per channel - and the wire depends on the board',
      b12: 'Each joint is driven by one pin on the controller. Sesame has been built on four different boards, and each board wires the same eight joints to different pins.',
      prog: 'A `const int servoPins[8]` array. Three of the four board pinouts are commented out; the Lolin S2 Mini one is live.',
      arch: 'Logical channel to physical GPIO is a board-level binding. The channel identity survives a board change; the pin number does not.',
      claim: F(
        'Four board pinouts are present in the source, three commented out. On the active Lolin S2 Mini profile the eight channels are on GPIO 1, 2, 4, 6, 8, 10, 13 and 14.',
        [sym('servo-pin-table'), hw('servos.joints[firmwareName=R1].pinsByBoard'), hw('boards')],
      ),
      manipulate: M('board-selector', 'servoPins', 'Switch the board profile between s2-mini, distro-v3, distro-v2 and distro-v1 and watch the pin labels on the exploded robot.', { options: HW.boards.map((b) => b.id) }),
      expect: E('The pin numbers change on every joint. The joint names do not change at all.', [
        ['visual.joint', 'Pin labels update; joint names stay fixed.'],
      ]),
      success: OK(
        'board-switch-compared',
        'A board switch was applied and the learner confirmed the joint names did not move with the pins.',
        { type: 'board-switched', fromBoard: 's2-mini', toBoard: 'distro-v1', expectJointNamesUnchanged: true },
        'Compare R1 before and after. Its pin number is one of the things that changed. Its name is not.',
      ),
      concepts: ['gpio', 'servo'],
    }),
    S({
      id: 'the-face-is-separate',
      kind: 'concept',
      title: 'The face is a different device entirely',
      b12: "Sesame's face is a small screen, and it is not wired like the joints at all. It has two wires instead of one, and it has an address.",
      prog: 'An `Adafruit_SSD1306 display` object, 128x64, on I2C address 0x3C, over the two pins the firmware defines as SDA and SCL.',
      arch: 'A bus peripheral, not a GPIO output. One pair of wires is shared by every device on the bus, and each device is picked out by address.',
      claim: F(
        'The display is a 128x64 SSD1306 on I2C address 0x3C, declared as a single object and driven over the two I2C pins the firmware defines.',
        [sym('display-object'), sym('display-config-defines'), sym('i2c-pin-defines'), hw('display.i2cAddress')],
      ),
      manipulate: M('graph-node-picker', 'oled', 'Click the OLED node in the architecture graph and follow it down to the two I2C pins.'),
      expect: E('The OLED branch of the graph has an address on it. The servo branch has pin numbers and no addresses. That difference is the whole point.', [
        ['visual.joint', 'The graph highlights the OLED chain: display object, bus, pins.'],
      ]),
      success: OK(
        'found-display-declaration',
        'The learner opened the source span that declares the display.',
        { type: 'source-span-selected', symbol: 'display-object' },
        'Follow the OLED node down. The graph node links to the line of firmware that creates it.',
      ),
      concepts: ['oled', 'i2c'],
    }),
    S({
      id: 'run-one-real-movement',
      kind: 'observe',
      title: 'Run one real movement and watch eight names light up',
      b12: 'Press stand. Eight angles get sent, one per joint, in the same order you just learned. This is the whole robot doing its simplest job.',
      prog: '`runStandPose(1)` calls `setServoAngle()` eight times with fixed angles, then enters idle.',
      arch: 'A pose is a vector of commanded angles applied in a fixed order. There is no solver anywhere in this path.',
      claim: F(
        'runStandPose() commands the eight channels to a fixed vector of angles, in enum order, and every Sesame movement ends by calling it.',
        [sym('runStandPose'), hw('movements[function=runStandPose]')],
      ),
      manipulate: M('pose-runner', 'stand', 'Run the stand pose and watch the trace fill in.'),
      expect: E('Eight servo.target rows appear, in JOINT_ORDER, carrying the angles written in the source you can see beside them.', [
        ['ui.command', 'You pressed stand.'],
        ['firmware.command', 'The command word "stand" names runStandPose.'],
        ['movement.enter', 'The movement announces itself with its own Serial banner.'],
        ['servo.target', 'Eight commanded angles, one per channel.'],
        ['joint.target', 'The joint each channel drives.'],
        ['visual.joint', 'What the 3D scene ended up drawing.'],
      ]),
      success: OK(
        'stand-pose-reached',
        'All eight channels hold the angles runStandPose commands.',
        { type: 'pose-vector', movement: 'runStandPose', expect: poseVector('runStandPose') },
        'Just run it. The check is that the eight commanded angles match the eight numbers in the source beside you.',
      ),
      concepts: ['pose', 'movement', 'servo'],
    }),
    S({
      id: 'what-you-did-not-see',
      kind: 'predict',
      title: 'One row of that trace is not what it looks like',
      b12: 'Six rows appeared. Before you look closely: which of them do you think is a real measurement, and which is arithmetic somebody did for you?',
      prog: 'Every trace row carries a provenance badge. Read `pwm.output` and decide what its badge should say.',
      arch: 'Provenance is a first-class property of a telemetry row. A system that cannot say where a number came from cannot be trusted about any of them.',
      claim: EMUF(
        "The pwm.output row is computed by this application. QEMU's LEDC model stores a duty value and produces no pulse, no edge and no waveform, and there is no physical robot in this project - so nothing has ever emitted the pulse that row describes.",
        [doc('docs/findings/Q3-ledc-fidelity.md', 'S0, S2-S3', 'RAN'), doc('docs/plan.md', 'Standing constraint - no physical hardware, ever')],
        'This is a fact about the emulator and about this project, not about Sesame firmware. The firmware is innocent: it really does ask for that pulse.',
        'inert-in-emulator',
      ),
      manipulate: M('trace-inspector', 'pwm.output', 'Open the pwm.output row and read its provenance badge and its witness line.'),
      expect: E('The badge says the number was inferred for explanation. The witness line names the arithmetic and says no pin ever emitted it.', [
        ['pwm.output', 'Computed here, never observed.'],
      ]),
      success: OK(
        'pwm-provenance-identified',
        'The learner identified pwm.output as computed rather than observed.',
        { type: 'trace-badge-identified', traceLayer: 'pwm.output', expectedProvenance: 'inferred-for-explanation' },
        'Every row has a badge. Only some of them claim to have seen anything.',
        null,
      ),
      concepts: ['pwm', 'emulator'],
      layers: ['pwm.output'],
    }),
  ],
  challenges: [
    {
      id: 'ch-name-a-joint-cold',
      level: 'starter',
      title: 'Name a joint with the labels turned off',
      coreConcept: 'servo',
      unlockedBy: 'named-all-eight',
      success: OK('ch-joint-cold', 'Four joints named with labels hidden.', { type: 'joints-identified', joints: ['R1', 'L2', 'R4', 'L3'] }, 'Use the enum order: it starts on the right side.'),
    },
  ],
});

// ====================================================== 2. command-one-joint
L({
  id: 'command-one-joint',
  title: 'Command one joint',
  status: 'polished',
  estimatedMinutes: 20,
  prerequisites: ['meet-sesame'],
  learningGoal:
    'Follow one number all the way from the slider you moved to the pulse width the code asks for, and find the two places along that path where the number you asked for is not the number that arrives.',
  willBeAbleTo: [
    'Name the function every commanded angle in this firmware passes through.',
    'Show two different requested angles that end up as one commanded angle, and explain which of subtrim and clamping did it.',
    'Explain why a one-degree slider is over-promising.',
  ],
  labHandoff: 'The joint sliders and the subtrim controls are the Lab joint panel.',
  openQuestions: [
    'setServoAngle() silently does nothing for channel 8. What would you have it do instead, and what would that cost?',
  ],
  steps: [
    S({
      id: 'one-function',
      kind: 'manipulate',
      title: 'Every angle in this firmware goes through one function',
      b12: 'There is exactly one place in the whole program where an angle is handed to a joint. Find it once and you can follow every movement Sesame makes.',
      prog: '`void setServoAngle(uint8_t channel, int angle)` - seven lines, and every movement function calls it.',
      arch: 'A single choke point between the movement layer and the driver library. That is what makes the rest of this lesson possible.',
      claim: F(
        'setServoAngle(channel, angle) is the only function in this firmware that writes an angle to a servo channel.',
        [sym('setServoAngle'), hw('servos.servoConfig.setServoAngle')],
      ),
      manipulate: M('joint-slider', 'R1', 'Drag R1 to 135 degrees - the angle the stand pose uses.', { min: 0, max: 180, step: 1 }),
      expect: E('One servo.target row appears for R1, and the source explorer highlights the same seven lines every time, whichever joint you drag.', [
        ['servo.target', 'R1 commanded to the angle you chose.'],
      ]),
      success: OK(
        'r1-to-135',
        'R1 was commanded to 135 degrees.',
        { type: 'servo-target', joint: 'R1', angleDeg: 135 },
        'The slider is the control. 135 is the value the stand pose uses for this channel.',
      ),
      concepts: ['servo', 'state'],
      joints: ['R1'],
    }),
    S({
      id: 'channel-eight',
      kind: 'predict',
      title: 'Ask for channel 8 and predict what happens',
      b12: 'There are eight channels, numbered 0 to 7. What do you think happens if the code asks for channel 8? Commit to an answer, then try it.',
      prog: 'The whole body of setServoAngle() is wrapped in `if (channel < 8)`. There is no else, no return code and no log line.',
      arch: 'A guard that fails silently. The caller cannot distinguish "done" from "ignored", so a mistake here is invisible until something does not move.',
      claim: F(
        'setServoAngle() wraps its entire body in a channel < 8 guard and does nothing at all - no error, no log, no return value - for any channel outside that range.',
        [sym('setServoAngle'), tn('TN-015')],
      ),
      manipulate: M('channel-number', 'setServoAngle', 'Type channel 8 with any angle and send it.'),
      expect: E('Nothing happens. Not an error - nothing. The trace stays empty, which is exactly what makes this kind of bug expensive.', [
        ['servo.target', 'No row appears at all.'],
      ]),
      success: OK(
        'channel-8-silent',
        'A channel-8 command produced no servo.target event within the window.',
        { type: 'telemetry-absent', event: 'servo.target', afterAction: 'setServoAngle(8, 90)', windowMs: 500 },
        'Watch the trace, not the robot. The evidence here is a row that never arrives.',
        'Nothing you did was wrong. Silence is the observation.',
      ),
      notes: ['TN-015'],
      concepts: ['servo', 'error-handling'],
    }),
    S({
      id: 'subtrim-before-clamp',
      kind: 'debug',
      title: 'Subtrim is added BEFORE the limits are applied',
      b12: 'Sesame can nudge each joint by a fixed amount, to straighten a joint that sits crooked. The nudge is added first, and only then is the result squeezed back into 0 to 180. Order matters.',
      prog: '`constrain(angle + servoSubtrim[channel], 0, 180)` - one line, and the addition happens inside the constrain call.',
      arch: 'A calibration offset applied upstream of saturation. Trim therefore consumes range at the ends rather than shifting the whole interval.',
      claim: F(
        'setServoAngle() computes constrain(angle + servoSubtrim[channel], 0, 180): the per-channel offset is added first and the 0-180 clamp is applied to the result.',
        [sym('setServoAngle'), sym('servoSubtrim'), hw('servos.servoConfig.angleClamp'), hw('servos.servoConfig.subtrim'), tn('TN-003')],
      ),
      deeper: {
        title: 'What the other order would have done',
        body: 'If the clamp came first and the offset second, a trimmed channel could be commanded past 180 and the library would have to deal with it. As written, the firmware can never ask for an angle outside 0-180 - but a channel with +40 of trim has lost the top 40 degrees of its range, and nothing tells you.',
        citations: [sym('setServoAngle')],
      },
      manipulate: M('subtrim-control', 'R1', 'Set R1 subtrim to +40, then command R1 to 160 and to 180 in turn.', { min: -90, max: 90 }),
      expect: E('Both requests end up commanding 180. Two different numbers went in; one number came out. Nothing warns you.', [
        ['servo.target', 'Both commands report the same commanded angle.'],
      ]),
      success: OK(
        'subtrim-saturation-found',
        'Two different requested angles were shown collapsing onto one commanded angle because of subtrim.',
        { type: 'commanded-angle-collision', joint: 'R1', inputAngleA: 160, inputAngleB: 180, subtrimDeg: 40, expectCommandedAngle: 180, expectSameCommandedAngle: true },
        '160 + 40 is 200, and 180 + 40 is 220. Both get squeezed to 180.',
        'Finding this is the exercise, not a mistake. The firmware behaves this way on every robot that ships with it.',
      ),
      notes: ['TN-003'],
      concepts: ['calibration', 'servo'],
      joints: ['R1'],
    }),
    S({
      id: 'angles-that-alias',
      kind: 'observe',
      title: 'The angle you asked for is not the angle at the pin',
      b12: `You can type 181 different angles, from 0 to 180. Only ${DISTINCT_TICKS.size} different pulses can actually come out. That means ${ALIASED} of your angles are copies of the one next door.`,
      prog: `Servo::write() maps 0-180 onto ${PWM.minPulseUs}-${PWM.maxPulseUs} microseconds with integer map(), then usToTicks() truncates that into a ${PWM.ticks}-step frame.`,
      arch: 'Two truncations in series against a 10-bit timer. The command resolution the API advertises is finer than the resolution the hardware timer can represent.',
      claim: LIBF(
        `Across the whole 0-180 range only ${DISTINCT_TICKS.size} distinct pulse values are reachable, so ${ALIASED} of the 181 commandable angles produce a pulse identical to their neighbour's. ${ALIAS_PAIR[0]} and ${ALIAS_PAIR[1]} degrees are one such pair: both become ${SWEEP[ALIAS_PAIR[0]].ticks} ticks.`,
        [
          lib('ESP32Servo', 'src/ESP32Servo.h', 91, '#define DEFAULT_TIMER_WIDTH 10', 'The 10-bit timer width that causes the aliasing.'),
          lib('ESP32Servo', 'src/ESP32Servo.cpp', 260, 'int Servo::usToTicks(int usec) - usec / (REFRESH_USEC / timer_width_ticks), truncated to int', 'The truncation itself.'),
          hw('servos.servoConfig.pulseQuantisation'),
          tn('TN-007'),
        ],
        'This is arithmetic inside ESP32Servo 3.0.9, not inside Sesame source. Sesame only chooses the angle; the library decides what pulse that becomes. The numbers here are recomputed from the library\'s own formulas, not measured.',
      ),
      manipulate: M('pwm-inspector', 'R1', `Step the angle from ${ALIAS_PAIR[0]} to ${ALIAS_PAIR[1]} and watch the computed tick count.`, { min: 0, max: 180, step: 1 }),
      expect: E('The requested pulse width changes. The tick count does not. At the pin those two angles would be the same request.', [
        ['servo.target', 'Two different commanded angles.'],
        ['pwm.output', 'One tick count for both.'],
      ]),
      success: OK(
        'alias-pair-found',
        'Two adjacent angles were shown producing the same tick count.',
        { type: 'quantisation-collision', angleA: ALIAS_PAIR[0], angleB: ALIAS_PAIR[1], expectSameTicks: true, expectTicks: SWEEP[ALIAS_PAIR[0]].ticks, learnerChosen: false },
        'Watch the ticks column, not the microseconds column. The microseconds are what was asked for; the ticks are what can be represented.',
      ),
      notes: ['TN-007'],
      concepts: ['quantisation', 'pwm', 'servo'],
      joints: ['R1'],
    }),
    S({
      id: 'follow-the-whole-ladder',
      kind: 'observe',
      title: 'Follow one number down all eight rungs',
      b12: 'One press, eight rows. Each row is a different thing being true, and two of them are guesses. Read the badges.',
      prog: 'The trace runs ui.command, http.request, firmware.command, movement.enter, servo.target, pwm.output, joint.target, visual.joint - in causal order.',
      arch: 'A causal ladder with per-rung provenance. Each rung answers a different question and each has a different witness.',
      claim: EMUF(
        'On both backends the joint.target and pwm.output rungs are inferred, never observed. On the QEMU backend movement.enter and servo.target are observed from executing firmware; on the simulator they are produced by the behavioural model.',
        [doc('docs/findings/V8-architecture-graph-and-signal-trace.md', 'Section 2', 'RAN'), doc('docs/findings/Q1-qemu-spike.md', 'Section 7', 'RAN')],
        'This describes what this project can witness. It is not a statement about Sesame hardware, which nothing here has ever touched.',
        'ran-in-qemu',
      ),
      manipulate: M('trace-inspector', 'stand', 'Run stand and open every rung of the trace in turn.'),
      expect: E('Eight rungs, in order, each with a badge. The badges are not all the same, and that is the lesson.', [
        ['ui.command', 'A real DOM event.'],
        ['http.request', "The robot's own route."],
        ['firmware.command', 'The command word and the function it names.'],
        ['movement.enter', "The movement's own Serial banner."],
        ['servo.target', 'The commanded angle.'],
        ['pwm.output', 'Computed, never observed.'],
        ['joint.target', 'A target, never a position.'],
        ['visual.joint', 'What the scene drew.'],
      ]),
      success: OK(
        'full-ladder-observed',
        'One command produced a row on every rung of the ladder.',
        { type: 'trace-complete', traceLayers: TRACE_LAYERS.map((l) => l.id) },
        'Any movement command will do it. Stand is the shortest.',
      ),
      concepts: ['servo', 'state', 'timing'],
    }),
    S({
      id: 'the-delay-that-is-not-a-delay',
      kind: 'explain',
      title: 'The last line of setServoAngle is stranger than it looks',
      b12: 'After every single angle, the code waits 20 milliseconds. But it does not sit still while it waits - it goes and does other jobs. You will take that apart properly later.',
      prog: 'The function ends with `delayWithFace(motorCurrentDelay)`, and `delayWithFace()` is a loop that services HTTP, DNS and the face animation every 5 ms.',
      arch: 'Cooperative multitasking on a single thread. The delay is a scheduling point, not dead time.',
      claim: F(
        'setServoAngle() ends by calling delayWithFace(motorCurrentDelay), and delayWithFace() spends that time calling updateAnimatedFace(), server.handleClient() and dnsServer.processNextRequest() in a loop.',
        [sym('setServoAngle'), sym('delayWithFace'), sym('animation-constants'), tn('TN-002')],
      ),
      manipulate: M('source-selector', 'delayWithFace', 'Click through from the last line of setServoAngle into delayWithFace and read its six lines.'),
      expect: E('You land in a while loop that is doing three other jobs. Nothing about the name suggested that.', [
        ['servo.target', 'The row you clicked from.'],
      ]),
      success: OK(
        'found-delaywithface',
        'The learner navigated from setServoAngle into delayWithFace.',
        { type: 'source-span-selected', symbol: 'delayWithFace', reachedFrom: 'setServoAngle' },
        'The call is on the last line of the function body.',
      ),
      notes: ['TN-002'],
      concepts: ['reentrancy', 'timing'],
    }),
  ],
  challenges: [
    {
      id: 'ch-three-angles',
      level: 'starter',
      title: 'Move one servo to 45, 90 and 135',
      coreConcept: 'servo',
      unlockedBy: 'r1-to-135',
      success: OK('ch-three-angles-ok', 'One channel was commanded to all three angles.', { type: 'servo-target', joint: 'R2', angleDeg: 45 }, 'Any single channel. Watch the trace row change each time.'),
    },
    {
      id: 'ch-fix-a-crooked-joint',
      level: 'explorer',
      title: 'Use subtrim to straighten a joint - without losing range',
      coreConcept: 'calibration',
      unlockedBy: 'subtrim-saturation-found',
      success: OK('ch-subtrim-ok', 'A subtrim offset small enough not to saturate at the pose angle was applied.', { type: 'subtrim-set', joint: 'L1', subtrimDeg: 8 }, 'Check the stand angle for that channel first, then work out how much headroom you have.'),
    },
  ],
});

// =========================================================== 3. how-pwm-asks
L({
  id: 'how-pwm-asks',
  title: 'How PWM asks a servo to move',
  status: 'polished',
  estimatedMinutes: 22,
  prerequisites: ['command-one-joint'],
  learningGoal:
    'Turn an angle into the pulse the code asks for, by hand and then with the inspector - and find the exact point where this project stops being able to tell you anything at all.',
  willBeAbleTo: [
    'Explain what a 50 Hz servo frame is and why the pulse width is the message.',
    'Show that attach(pin, 732, 2929) never produces a 2929 microsecond pulse, and name the line that stops it.',
    'Say precisely what QEMU does and does not do when the firmware writes to LEDC.',
  ],
  labHandoff: 'The pulse inspector becomes the Lab signal panel, wired to the same arithmetic.',
  openQuestions: [
    'The timer is 10 bits. If you could change one thing about this chain to get finer control, what would you change, and what would it cost?',
  ],
  steps: [
    S({
      id: 'fifty-times-a-second',
      kind: 'concept',
      title: 'Fifty times a second, forever',
      b12: 'A hobby servo is not told "go to 90". It is told the same thing over and over, fifty times a second: a short pulse whose length is the message.',
      prog: '`servos[i].setPeriodHertz(50)` in setup(), then `attach()` per channel. The frame is 20 milliseconds long.',
      arch: 'Position is encoded in pulse width on a fixed-period carrier. The carrier is a hardware timer; the width is the payload.',
      claim: F(
        `The firmware sets every servo channel to a ${HW.servos.servoConfig.pwmFrequencyHz} Hz period in setup(), which is a ${PWM.frameUs / 1000} millisecond frame, and then attaches each channel to its pin.`,
        [sym('setup'), hw('servos.servoConfig.pwmFrequencyHz'), hw('servos.servoConfig.attachCall')],
      ),
      manipulate: M('pwm-inspector', 'R1', 'Set R1 to 90 degrees and read the frame: the pulse width and the gap that follows it.', { min: 0, max: 180 }),
      expect: E(`At 90 degrees the code asks for ${SWEEP[90].requestedPulseUs} microseconds out of the ${PWM.frameUs} microsecond frame - about ${((SWEEP[90].requestedPulseUs / PWM.frameUs) * 100).toFixed(1)} percent of it.`, [
        ['pwm.output', 'The computed pulse width for the angle you set.'],
      ]),
      success: OK(
        'read-the-frame-at-90',
        'The learner read off the computed pulse and tick count for 90 degrees.',
        { type: 'pwm-value-matched', angleDeg: 90, expectRequestedPulseUs: SWEEP[90].requestedPulseUs, expectTicks: SWEEP[90].ticks, expectQuantisedPulseUs: SWEEP[90].quantisedPulseUs },
        'The inspector shows three numbers: what was asked for, how many timer ticks that is, and what those ticks come back out as.',
      ),
      concepts: ['pwm', 'ledc', 'timing'],
      joints: ['R1'],
    }),
    S({
      id: 'the-number-that-never-happens',
      kind: 'debug',
      title: 'The firmware asks for 2929. It never gets it.',
      b12: `The code says the longest pulse should be ${PWM.requestedMaxUs} microseconds. The library refuses, and quietly uses ${PWM.maxPulseUs} instead. Neither of them tells you.`,
      prog: `\`servos[i].attach(servoPins[i], ${PWM.minPulseUs}, ${PWM.requestedMaxUs})\`. Inside Servo::attach(), \`if (max > MAX_PULSE_WIDTH) max = MAX_PULSE_WIDTH;\` runs before the value is stored.`,
      arch: 'A library-side saturation of a caller-supplied configuration value, applied silently at bind time. The caller keeps a wrong mental model for the life of the program.',
      claim: LIBF(
        `Both things are true: the firmware really does call attach(pin, ${PWM.minPulseUs}, ${PWM.requestedMaxUs}), and ESP32Servo clamps the requested maximum to ${PWM.maxPulseUs} microseconds before storing it. The minimum is not clamped, because ${PWM.minPulseUs} is already above the library's own minimum. So the widest pulse this firmware can ever ask for is ${PWM.maxPulseUs}.`,
        [
          sym('setup'),
          lib('ESP32Servo', 'src/ESP32Servo.h', 98, '#define MAX_PULSE_WIDTH      2500     // the longest pulse sent to a servo', 'The constant that wins.'),
          lib('ESP32Servo', 'src/ESP32Servo.cpp', 126, 'if (max > MAX_PULSE_WIDTH) max = MAX_PULSE_WIDTH;  - inside Servo::attach(), before this->max = max', 'The clamp itself.'),
          hw('servos.servoConfig.attachPulseClamp'),
          tn('TN-006'),
        ],
        'The clamp is in ESP32Servo 3.0.9. Reading only Sesame source would leave you believing in a 2929 microsecond pulse that cannot exist.',
      ),
      manipulate: M('pwm-inspector', 'R1', 'Set the angle to 180 - the maximum - and compare the pulse the inspector reports to the 2929 in the source beside it.', { min: 0, max: 180 }),
      expect: E(`180 degrees gives ${SWEEP[180].requestedPulseUs} microseconds, not ${PWM.requestedMaxUs}. The source and the behaviour disagree, and the library is the reason.`, [
        ['pwm.output', `${SWEEP[180].requestedPulseUs} microseconds at full scale.`],
      ]),
      success: OK(
        'max-pulse-is-2500',
        'The learner confirmed the maximum pulse is the clamped value, not the requested one.',
        { type: 'pwm-value-matched', angleDeg: 180, expectRequestedPulseUs: SWEEP[180].requestedPulseUs, expectTicks: SWEEP[180].ticks, expectQuantisedPulseUs: SWEEP[180].quantisedPulseUs },
        'Set 180 and read the pulse. Then look at the third argument of the attach call in the source pane.',
        'The firmware is not broken and neither are you. Two correct pieces of code disagree, and the library wins silently. Finding that is the job.',
      ),
      notes: ['TN-006'],
      concepts: ['pwm', 'servo', 'calibration'],
    }),
    S({
      id: 'sweep-the-whole-range',
      kind: 'observe',
      title: 'Count how many pulses there really are',
      b12: `Sweep all the way from 0 to 180 and count the different pulses. There are ${DISTINCT_TICKS.size}, not 181.`,
      prog: `181 commandable angles map onto ticks ${Math.min(...DISTINCT_TICKS)} to ${Math.max(...DISTINCT_TICKS)} of a ${PWM.ticks}-step frame. ${ALIASED} of them collide with their neighbour.`,
      arch: 'Command-space resolution exceeding representation resolution. The excess is not an error; it is invisible, which is worse.',
      claim: LIBF(
        `Enumerating all 181 angles through ESP32Servo's own map() and usToTicks() yields ${DISTINCT_TICKS.size} distinct tick values and ${ALIASED} angles that alias onto a neighbour. This is a property of the library and the 10-bit timer, not of the emulator.`,
        [lib('ESP32Servo', 'src/ESP32Servo.cpp', 260, 'int Servo::usToTicks(int usec)', 'The truncation.'), hw('servos.servoConfig.pulseQuantisation'), tn('TN-007'), doc('docs/findings/Q3-ledc-fidelity.md', 'Section 6.4', 'RAN')],
        'Recomputed here from the library formulas and cross-checked against the same numbers derived independently in Q3. Nothing was measured.',
      ),
      manipulate: M('pwm-inspector', 'sweep', 'Sweep 0 to 180 and read the table of tick values. Look for the repeats.', { min: 0, max: 180 }),
      expect: E('The tick column steps up unevenly. Some angles share a value with the one before; roughly every other angle does.', [
        ['pwm.output', `${DISTINCT_TICKS.size} distinct tick values across 181 angles.`],
      ]),
      success: OK(
        'sweep-counted',
        'The full sweep was inspected and the aliasing counted.',
        { type: 'quantisation-survey', expectDistinctPulseValues: DISTINCT_TICKS.size, expectAliasedAngles: ALIASED },
        'Count the rows where the tick number is the same as the row above.',
      ),
      notes: ['TN-007'],
      concepts: ['quantisation', 'ledc'],
    }),
    S({
      id: 'where-this-stops-being-true',
      kind: 'predict',
      title: 'Where does this stop being something you can check?',
      b12: 'Everything so far was arithmetic, and arithmetic can be checked. The next step down - a real pulse on a real wire - is where this lab runs out. Predict what the emulator does with these numbers.',
      prog: "QEMU's esp32 machine does model an LEDC device. It converts the duty to a percentage, stores one byte, and nothing ever reads it.",
      arch: 'A register-accurate peripheral model with no signal generation. Register plausibility is not waveform correctness.',
      claim: EMUF(
        "QEMU's LEDC model has no timer, no clock, no GPIO connection and no output. Every servo write reaches it and is converted to a duty percentage that matches the TRM formula, and then it produces no pulse, no edge and no concept of 50 Hz. There is also no physical robot in this project, so nothing anywhere has emitted these pulses.",
        [doc('docs/findings/Q3-ledc-fidelity.md', 'Section 0, Sections 2-3', 'RAN'), doc('docs/plan.md', 'Standing constraint - no physical hardware, ever'), issue('ISSUE-20260824-024')],
        'This is a fact about QEMU and about this project. Sesame firmware asks for the right pulse; nobody here can watch it arrive.',
        'inert-in-emulator',
      ),
      manipulate: M('trace-inspector', 'pwm.output', 'Read the witness line under the pwm.output row.'),
      expect: E('The badge says inferred for explanation, and the witness names the arithmetic and states plainly that no pin ever emitted it.', [
        ['pwm.output', 'Inferred for explanation, on both backends.'],
      ]),
      success: OK(
        'pwm-inference-confirmed',
        'The learner identified pwm.output as inferred on both backends.',
        { type: 'trace-badge-identified', traceLayer: 'pwm.output', expectedProvenance: 'inferred-for-explanation' },
        'Switch backends and look again. This row does not change.',
      ),
      concepts: ['emulator', 'ledc', 'pwm'],
    }),
    S({
      id: 'the-missing-channel-number',
      kind: 'explain',
      title: 'The field the trace refuses to show you',
      b12: 'The pulse row tells you a joint, an angle, a pulse and a tick count. It does not tell you which of the eight hardware channels carried it - because nobody here knows.',
      prog: 'Eight LEDC channels are programmed and Q3 read back which eight. Which servo sits on which of them is not recorded anywhere in this repository.',
      arch: 'A deliberate hole in the data model. The graph node states the set and declines to state the mapping.',
      claim: EMUF(
        'Q3 established which eight LEDC channels are programmed, but nothing in this repository records which servo is on which channel, so the trace prints no channel number at all.',
        [doc('docs/findings/V8-architecture-graph-and-signal-trace.md', 'Section 1, "The edge the data does not support"', 'RAN'), doc('docs/findings/Q3-ledc-fidelity.md', 'Section 2.1', 'RAN'), hw('servos.servoConfig.ledcChannelsProgrammed')],
        'An absence, not a fact about Sesame. The honest move was to print nothing rather than a plausible guess.',
        'ran-in-qemu',
      ),
      manipulate: M('trace-inspector', 'pwm.output', 'Look for a channel number on the pulse row. Then look at the LEDC node in the architecture graph.'),
      expect: E('There is no channel number. The graph node says which eight channels exist and says the per-joint assignment is unestablished.', [
        ['pwm.output', 'No channel field.'],
      ]),
      success: OK(
        'missing-channel-found',
        'The learner located the field the data does not support.',
        { type: 'trace-field-absent', traceLayer: 'pwm.output', field: 'channel' },
        'Compare the fields on this row with the fields on servo.target. One thing you might expect is not there.',
      ),
      concepts: ['ledc', 'emulator'],
    }),
    S({
      id: 'pick-your-own-collision',
      kind: 'variation',
      title: 'Find two angles a servo could not tell apart',
      b12: `You have seen one pair. There are ${ALIASED} of them. Find your own, anywhere in the range.`,
      prog: 'Any two angles whose usToTicks() results are equal will do.',
      arch: 'Exploring the fibres of a non-injective map. Half the domain collapses.',
      claim: LIBF(
        `Aliasing is spread across the whole 0-180 range, not concentrated at the ends: ${ALIASED} of the 181 angles share a tick value with their neighbour.`,
        [lib('ESP32Servo', 'src/ESP32Servo.h', 91, '#define DEFAULT_TIMER_WIDTH 10', 'The timer width that decides how many pulses exist.'), hw('servos.servoConfig.pulseQuantisation'), tn('TN-007')],
        'A property of ESP32Servo 3.0.9 against a 10-bit timer, recomputed here.',
      ),
      manipulate: M('pwm-inspector', 'R1', 'Choose any two angles you think will collide and check them.', { min: 0, max: 180 }),
      expect: E('About half your guesses will be right. Adjacent angles collide roughly every other step.', [
        ['pwm.output', 'Two angles, one tick count.'],
      ]),
      success: OK(
        'own-collision-found',
        'A learner-chosen pair of angles was shown to produce the same tick count.',
        { type: 'quantisation-collision', expectSameTicks: true, learnerChosen: true },
        'Adjacent angles are the easy case. Try any pair one degree apart and check.',
      ),
      concepts: ['quantisation'],
    }),
  ],
  challenges: [
    {
      id: 'ch-match-pulse-to-angle',
      level: 'explorer',
      title: 'Given a pulse width, work back to the angles that could have produced it',
      coreConcept: 'quantisation',
      unlockedBy: 'sweep-counted',
      success: OK('ch-back-solve', 'A tick value was traced back to more than one possible commanded angle.', { type: 'quantisation-collision', expectSameTicks: true, learnerChosen: true }, 'Start from the tick count, not the microseconds.'),
    },
  ],
});

// ==================================================== 4. four-legs-cooperate
L({
  id: 'four-legs-cooperate',
  title: 'Make eight joints cooperate',
  status: 'polished',
  estimatedMinutes: 25,
  prerequisites: ['command-one-joint'],
  learningGoal:
    'Read a real Sesame movement as what it actually is - an ordered list of commanded angles and waits - predict where it ends up, and find the side effects that are not in the list.',
  willBeAbleTo: [
    'Predict the terminal pose of a movement by reading its source.',
    'Name the four joints runWavePose commands itself, and explain why all eight end up moving.',
    'Explain why cancelling a walk is not instant and what it leaves behind.',
  ],
  labHandoff: 'The sequence editor and the pose runner are the Lab movement workbench; sequences authored here open there.',
  openQuestions: [
    'Every movement in this firmware is hand-written. What could you express with a solver that you cannot express with a list - and what would you lose?',
  ],
  steps: [
    S({
      id: 'a-movement-is-a-list',
      kind: 'concept',
      title: 'A movement is a list, not a formula',
      b12: 'Sesame does not work out how to stand. Somebody wrote the eight angles down, in order, and the robot replays them. Every single movement in the firmware is like this.',
      prog: 'Each movement is an `inline void run<Name>Pose()` in a header: a Serial banner, a face call, a run of setServoAngle() calls, some delayWithFace() waits, and a final runStandPose(1).',
      arch: 'Open-loop scripted sequences. No kinematics, no interpolation, no feedback - which is exactly why sequencing is the right thing to teach first.',
      claim: F(
        `The firmware contains ${HW.movements.length} movement and pose functions, all hand-written as ordered calls. There is no movement data format and no solver anywhere in the tree.`,
        [sym('runStandPose'), sym('movement-prototypes'), hw('movements[function=runStandPose]')],
      ),
      manipulate: M('pose-runner', 'stand', 'Run stand with the source pane open, and watch the highlight walk down the function line by line.'),
      expect: E('The highlight moves one line at a time, and one servo.target row appears per line. The list and the trace are the same thing.', [
        ['movement.enter', 'The banner the function prints.'],
        ['servo.target', 'One row per source line, in source order.'],
      ]),
      success: OK(
        'stand-vector-matched',
        'All eight channels hold the angles runStandPose commands.',
        { type: 'pose-vector', movement: 'runStandPose', expect: poseVector('runStandPose') },
        'Run it and compare the eight rows to the eight lines beside them.',
      ),
      concepts: ['movement', 'pose', 'timing'],
    }),
    S({
      id: 'which-joints-does-wave-move',
      kind: 'predict',
      title: 'Wave names four joints. So why do all eight end up with new angles?',
      b12: `Read the wave function and count the joints it names. There are ${directJoints('runWavePose').length}: ${directJoints('runWavePose').join(', ')}. But run it and all eight get commanded. Work out why before you look.`,
      prog: 'runWavePose() calls setServoAngle() on four channels itself - and calls runStandPose() twice, at the start and at the end, which commands all eight.',
      arch: 'Direct effects versus transitive effects. A call graph question disguised as a robotics question.',
      claim: F(
        `runWavePose() commands ${directJoints('runWavePose').join(', ')} directly, and reaches all eight channels transitively because it calls runStandPose() at the start and again at the end.`,
        [sym('runWavePose'), sym('runStandPose'), hw('movements[function=runWavePose]')],
      ),
      manipulate: M('pose-runner', 'wave', 'Run wave with the call graph open, and follow the calls out of the function body.'),
      expect: E('Four joints are named in the source; eight appear in the trace. The extra four arrive from inside runStandPose.', [
        ['movement.enter', 'WAVE.'],
        ['servo.target', 'Rows from two different functions, interleaved.'],
        ['joint.target', 'All eight joints touched.'],
      ]),
      success: OK(
        'wave-direct-joints',
        "The learner listed exactly the joints runWavePose's own body commands.",
        { type: 'movement-joints-identified', movement: 'runWavePose', expectDirectJoints: directJoints('runWavePose') },
        'Count only the setServoAngle calls written inside runWavePose itself. The rest come from a function it calls.',
      ),
      concepts: ['movement', 'pose'],
      joints: directJoints('runWavePose'),
    }),
    S({
      id: 'timing-is-in-the-list-too',
      kind: 'manipulate',
      title: 'The waits are part of the movement',
      b12: 'Wave repeats one arm motion four times, with a 300 millisecond wait each way. Change the wait and the movement feels different - but it still finishes in exactly the same place.',
      prog: 'A `for (int i = 0; i < 4; i++)` loop with `delayWithFace(300)` on each side. Change the delay and the terminal vector is unaffected.',
      arch: 'Time is data in a scripted sequence. Duration and destination are independent, which is a property of open-loop replay.',
      claim: F(
        'runWavePose() repeats one two-position arm motion four times with a wait on each side, and then commands the stand vector, so the terminal pose does not depend on the wait length.',
        [sym('runWavePose'), sym('delayWithFace'), hw('movements[function=runWavePose]')],
      ),
      manipulate: M('sequence-editor', 'runWavePose', 'Copy wave into the editor, change the 300 ms waits, and run both versions.'),
      expect: E('The shorter version finishes sooner and draws fewer face frames along the way. Both end on the same eight angles.', [
        ['servo.target', 'The same commanded angles, closer together in time.'],
      ]),
      success: OK(
        'timing-varied-same-pose',
        'A timing change was applied and the terminal pose was shown to be unchanged.',
        { type: 'sequence-variation', basedOnMovement: 'runWavePose', changedField: 'delayMs', expectSameTerminalPose: true },
        'Compare the last eight rows of each run, not the whole trace.',
      ),
      concepts: ['timing', 'animation', 'movement'],
    }),
    S({
      id: 'stand-is-an-exit',
      kind: 'observe',
      title: 'Stand is not just a pose - it is how the robot goes quiet',
      b12: `Every movement ends by calling stand. And stand, when it is called the usual way, also puts the face into idle. That is why Sesame starts blinking on its own after a movement.`,
      prog: 'runStandPose(int face = 1). With face == 1 it sets the stand face and calls enterIdle(); with face == 0 it only commands the eight angles. enterIdle() is reachable from nowhere else.',
      arch: 'A shared exit path carrying a state-machine transition. The parameter is the difference between "go to this pose" and "finish".',
      claim: F(
        `runStandPose() takes a face parameter defaulting to 1, and only the face == 1 path calls enterIdle(). enterIdle() sets the idle face in boomerang mode and schedules the next blink; nothing else in the firmware calls it.`,
        [sym('runStandPose'), sym('enterIdle'), sym('scheduleNextIdleBlink'), tn('TN-005')],
      ),
      deeper: {
        title: 'The two calls inside wave are not the same call',
        body: 'runWavePose() calls runStandPose(0) at the start and runStandPose(1) at the end. The first is a pose change; the second is an ending. Same function, same eight angles, different meaning - and the only visible difference is the face.',
        citations: [sym('runWavePose'), sym('runStandPose')],
      },
      manipulate: M('pose-runner', 'wave', 'Run wave and keep watching after the last angle has been commanded.'),
      expect: E('After the last commanded angle, the face becomes idle and then starts blinking at random intervals. Nothing asked for that; it fell out of the ending.', [
        ['movement.enter', 'WAVE, then the stand that ends it.'],
        ['servo.target', 'The eight stand angles.'],
      ]),
      success: OK(
        'idle-after-wave',
        'The face reached the idle state after the movement finished.',
        { type: 'face-after-movement', movement: 'runWavePose', expectFace: 'idle' },
        'Watch the face state, not the joints. It changes after the joints have stopped.',
      ),
      notes: ['TN-005'],
      concepts: ['idle', 'state-machine', 'face'],
    }),
    S({
      id: 'cancelling-is-not-free',
      kind: 'debug',
      title: 'Cancelling a walk runs a whole stand pose first',
      b12: 'Start walking, then send a different command. The walk does not just stop. It runs a complete stand pose - eight more angles - and then goes idle. That is what "stop" means here.',
      prog: 'The walk gait is punctuated by `pressingCheck(cmd, ms)`. If currentCommand has changed, it calls runStandPose(1) and returns false. The cancel path is a movement.',
      arch: 'Cancellation implemented as a transition to a known pose rather than as an abort. Predictable, but it is not a no-op and it is not instant.',
      claim: F(
        'pressingCheck() services HTTP, DNS and the face while it waits, and if currentCommand has changed it runs a full runStandPose(1) - eight commanded angles and an idle transition - before returning false.',
        [sym('pressingCheck'), sym('runWalkPose'), sym('runStandPose'), tn('TN-011')],
      ),
      manipulate: M('command-button', 'forward', 'Send forward, wait a moment, then send stand. Watch what arrives after the cancel.'),
      expect: E('A complete stand pose appears in the trace after your second command - and then the idle face. The cancel cost eight commanded angles.', [
        ['firmware.command', 'The command word changed mid-movement.'],
        ['servo.target', 'Eight more rows, from the cancel path.'],
      ]),
      success: OK(
        'cancel-side-effect-seen',
        'A mid-walk cancel was shown to produce a complete stand pose.',
        { type: 'pose-vector', movement: 'runStandPose', expect: poseVector('runStandPose'), afterAction: 'cancel forward mid-gait' },
        'Cancel it early, while the gait is still in its first cycle, so the stand rows are easy to pick out.',
        'This is not a bug you caused. It is how the shipped cancel path works, and knowing it is the difference between predicting the robot and being surprised by it.',
      ),
      notes: ['TN-011', 'TN-010'],
      concepts: ['movement', 'state-machine', 'reentrancy'],
    }),
    S({
      id: 'write-your-own-sequence',
      kind: 'variation',
      title: 'Write a three-frame sequence of your own',
      b12: 'Now write one. Three positions, in order, with waits between them - and every angle has to stay inside 0 to 180 after subtrim is added.',
      prog: 'Author it in the Lab sequence editor. The editor checks each commanded angle against the same constrain() the firmware applies.',
      arch: 'Composing in the same shape the firmware uses. What you author here is a list, because that is what a Sesame movement is.',
      claim: LABF(
        'The sequence editor is a Sesame Lab tool. This firmware has no movement data format and no way to receive a sequence at runtime - movements are C++ functions compiled into the image, which is exactly why Sesame Studio exists as a separate upstream tool.',
        [hw('movements[function=runDancePose]'), doc('docs/findings/L3-source-annotations.md', 'Section 5')],
        'What you author is a Lab artifact. It is shaped like a Sesame movement and it is validated against the same limits, but nothing here can send it to the firmware.',
      ),
      manipulate: M('sequence-editor', 'new', 'Author three frames. Each frame is a set of commanded angles plus a wait.'),
      expect: E('The editor rejects any angle that would be clamped, and shows you the commanded value beside the one you typed.', [
        ['servo.target', 'Your angles, replayed in order.'],
      ]),
      success: OK(
        'sequence-authored',
        'A three-frame sequence was authored with no out-of-range commanded angles.',
        { type: 'sequence-authored', minFrames: 3, maxCommandedAngleOutOfRange: 0 },
        'Check any channel that carries subtrim: the offset is added before the limit, so it eats your headroom.',
      ),
      concepts: ['movement', 'pose', 'timing'],
    }),
    S({
      id: 'where-kinematics-would-go',
      kind: 'explain',
      title: 'Where a solver would go - and why there is not one',
      b12: 'You could imagine telling Sesame "put this foot here" and letting it work out the angles. That is called inverse kinematics. Sesame does not do it, and to even ask the question you would need to know which joint is which leg - which nobody here does.',
      prog: 'A solver needs link lengths and a joint tree. The firmware has eight indices, eight names and eight pin numbers. It has no notion of a hip, a leg, or a left and right pairing.',
      arch: 'The step from scripted sequences to kinematics is a step from an ordered list to a model. Sesame Lab has the list; it does not have a verifiable model.',
      claim: C(
        'Sesame runs no kinematics of any kind. Describing a pose in terms of legs and hips is a reading laid on top of the firmware, not something the firmware says.',
        MODULE.get('build-a-leg-pose').conceptualReason,
        [sym('runStandPose'), hw('servos.joints')],
      ),
      manipulate: M('source-selector', 'runStandPose', 'Search the whole pinned tree for the words hip, leg, left and right. Count the hits.'),
      expect: E('The movement functions name joints and angles and nothing else. There is no anatomy in the firmware to solve against.', [
        ['servo.target', 'Angles, by channel. Never by limb.'],
      ]),
      success: OK(
        'no-anatomy-in-source',
        'The learner confirmed from the source that the firmware carries no limb naming.',
        { type: 'source-span-selected', symbol: 'runStandPose' },
        'Read the eight lines. Every one of them names a channel, an angle, and nothing else.',
      ),
      concepts: ['pose', 'servo'],
    }),
  ],
  challenges: [
    {
      id: 'ch-reproduce-wave',
      level: 'builder',
      title: 'Rebuild wave in the sequence editor from the source alone',
      coreConcept: 'movement',
      unlockedBy: 'sequence-authored',
      success: OK('ch-wave-rebuilt', 'A sequence was authored that ends on the same vector wave ends on.', { type: 'sequence-authored', minFrames: 6, maxCommandedAngleOutOfRange: 0 }, 'Do not forget the stand pose at each end. It is most of the movement.'),
    },
    {
      id: 'ch-trace-which-line',
      level: 'builder',
      title: 'Given a servo.target row, find the line that caused it',
      coreConcept: 'movement',
      unlockedBy: 'wave-direct-joints',
      success: OK('ch-line-found', 'A trace row was traced back to the source line that produced it.', { type: 'source-span-selected', symbol: 'runWavePose', reachedFrom: 'trace-row' }, 'The rows are in source order. Count them.'),
    },
  ],
});

// ========================================================== 5. sesames-face
L({
  id: 'sesames-face',
  title: "Sesame's face",
  status: 'polished',
  estimatedMinutes: 22,
  prerequisites: ['meet-sesame'],
  learningGoal:
    'Understand the face as a named entry in a table of 128x64 bitmaps, and then diagnose - from the source - why one of the faces the firmware ships with draws nothing at all.',
  willBeAbleTo: [
    'Explain how one list of face names becomes three different things at compile time.',
    'Diagnose a blank face from the source, without guessing.',
    'Explain why selecting the same face twice does not restart its animation.',
  ],
  labHandoff: 'The pixel editor and the face picker become the Lab face workbench.',
  openQuestions: [
    'The empty-face fallback is itself empty. What should a display do when it has nothing to show, and how would you know it had happened?',
  ],
  steps: [
    S({
      id: 'one-list-three-expansions',
      kind: 'concept',
      title: 'One list of names, expanded three different ways',
      b12: 'All of Sesame\'s face names live in one list. The compiler then reads that same list three times, and builds three different things out of it. Change the list once and all three change.',
      prog: 'An X-macro: `#define FACE_LIST X(walk) X(rest) ...`, expanded once into weak extern declarations, once into frame arrays, and once into the lookup table setFace() searches.',
      arch: 'A single source of truth expanded by the preprocessor into declarations, storage and a registry. Adding a face is a one-line change by construction.',
      claim: F(
        `FACE_LIST names ${HW.faces.faces.length} faces in one macro and is expanded three times: into weak extern bitmap declarations, into per-face frame arrays via MAKE_FACE_FRAMES, and into the faceEntries table that setFace() searches by name.`,
        [sym('FACE_LIST'), sym('face-weak-decls'), sym('MAKE_FACE_FRAMES'), sym('faceEntries'), tn('TN-017')],
      ),
      manipulate: M('source-selector', 'FACE_LIST', 'Open FACE_LIST, then follow it to each of its three expansions in turn.'),
      expect: E('The same list of names shows up in three places that look nothing alike. None of them was typed out by hand.', [
        ['visual.joint', 'The face registry, highlighted in all three expansions.'],
      ]),
      success: OK(
        'found-face-list',
        'The learner opened the FACE_LIST declaration.',
        { type: 'source-span-selected', symbol: 'FACE_LIST' },
        'It is at the top of the bitmap header, above three thousand lines of image data.',
      ),
      notes: ['TN-017'],
      concepts: ['macro', 'face', 'bitmap'],
    }),
    S({
      id: 'pick-a-face',
      kind: 'manipulate',
      title: 'Pick a face by name',
      b12: 'Faces are chosen by name, not by number. The code looks the name up in the table, finds its picture frames, and draws the first one.',
      prog: '`setFace(const String&)` walks faceEntries, compares case-insensitively, sets currentFaceFrames and currentFaceFrameCount, and draws frame 0.',
      arch: 'Name-keyed lookup into a static registry, with a fallback entry. The name is the API; the frame pointers are the implementation.',
      claim: F(
        'setFace() looks the requested name up in faceEntries case-insensitively, counts its non-null frames, and draws frame 0 through updateFaceBitmap(), which clears the display, draws a 128x64 bitmap and pushes the buffer.',
        [sym('setFace'), sym('updateFaceBitmap'), sym('countFrames'), hw('faces.faces[name=happy]')],
      ),
      manipulate: M('face-picker', 'happy', 'Select the happy face and watch the virtual display.'),
      expect: E('The display clears and one 128x64 frame is drawn. The reported face name matches what you asked for.', [
        ['visual.joint', 'A frame on the virtual OLED.'],
      ]),
      success: OK(
        'happy-face-drawn',
        'The happy face was selected and at least one frame was drawn.',
        { type: 'face-selected', faceName: 'happy', expectFramesRenderedAtLeast: 1 },
        'Any named face from the list. Happy is a good one to start with because it has frames.',
      ),
      concepts: ['face', 'bitmap', 'oled'],
    }),
    S({
      id: 'the-face-that-draws-nothing',
      kind: 'debug',
      title: 'Ask for the stand face. Nothing happens.',
      b12: 'The firmware has a face called stand, and the stand pose asks for it. It draws nothing at all - and the robot does not notice. Your job is to work out why from the source.',
      prog: 'Every bitmap is declared weak and undefined. Two of them - stand and defualt - are never defined anywhere, so their frame arrays hold null pointers, countFrames() returns 0, and the fallback path selects the same empty array.',
      arch: 'A weak symbol that nothing ever defines links successfully to a null address. The failure is silent by construction, and the fallback shares the defect.',
      claim: F(
        'The stand and defualt bitmaps are declared as weak externs and never defined, so countFrames() returns 0 for both. setFace("stand") therefore falls through to the fallback, which is the same empty array, sets currentFaceName to "default", and draws nothing - leaving whatever was on the display before.',
        [sym('face-weak-decls'), sym('countFrames'), sym('setFace'), tn('TN-001'), issue('ISSUE-20260823-004')],
      ),
      deeper: {
        title: 'Why nothing warned anybody',
        body: 'A weak declaration that is never defined resolves to null instead of failing the link. The Arduino platform compiles this sketch with warnings off, so there is no diagnostic at build time either. It was confirmed absent from the compiled ELF symbol table, so this is not something you can talk yourself out of by re-reading the source.',
        citations: [sym('face-weak-decls'), doc('docs/findings/F3-firmware-build.md'), issue('ISSUE-20260823-004')],
      },
      manipulate: M('face-picker', 'stand', 'Select the stand face and watch both the display and the reported face name.'),
      expect: E('The display does not change. The reported name comes back as "default", which is not what you asked for - and that mismatch is the only evidence you get.', [
        ['visual.joint', 'The previous frame is still on screen.'],
      ]),
      success: OK(
        'blank-face-diagnosed',
        'The learner observed the fallback: stand was requested, zero frames were drawn, and the reported face is "default".',
        { type: 'face-fallback', requestedFace: 'stand', expectReportedFace: 'default', expectFramesRendered: 0 },
        'Compare the name you asked for with the name the robot reports afterwards. They are different, and that is the clue.',
        'You have not broken anything. This is a real defect in the shipped firmware, tracked as ISSUE-20260823-004. Finding it from the source is exactly what debugging is.',
      ),
      notes: ['TN-001'],
      concepts: ['weak-symbol', 'error-handling', 'face'],
    }),
    S({
      id: 'asking-twice-does-nothing',
      kind: 'predict',
      title: 'Ask for the same face twice',
      b12: 'Select a face. Now select the same face again. Predict what happens to the animation - does it start over?',
      prog: 'setFace() early-returns when the requested name equals currentFaceName and the frame pointer is non-null. The frame index, the direction and the finished flag are all left alone.',
      arch: 'An idempotence guard on a state setter. Cheap, correct for the common case, and surprising the one time you wanted a restart.',
      claim: F(
        'setFace() returns immediately if the requested name matches currentFaceName and frames are already loaded, so re-selecting the current face does not reset the frame index and does not restart the animation.',
        [sym('setFace'), tn('TN-013')],
      ),
      manipulate: M('face-picker', 'wave', 'Select the wave face, let it run partway, then select wave again.'),
      expect: E('The animation carries on from where it was. Nothing restarts. To restart it you have to select something else and come back.', [
        ['visual.joint', 'Frame index continues rather than resetting.'],
      ]),
      success: OK(
        'reselect-does-not-restart',
        'The learner confirmed that re-selecting the current face does not restart its animation.',
        { type: 'face-reselect', faceName: 'wave', expectAnimationRestart: false },
        'Watch the frame counter, not the picture. It is the thing that would have reset.',
      ),
      notes: ['TN-013'],
      concepts: ['animation', 'state', 'face'],
    }),
    S({
      id: 'playback-mode-is-global',
      kind: 'observe',
      title: 'How a face plays is decided by whoever asked for it',
      b12: 'Some faces play once and stop. Some loop forever. Some bounce back and forth. That choice is not stored with the face - it is made by the line of code that selected it.',
      prog: '`setFaceWithMode(name, mode)` sets a single global currentFaceMode and then calls setFace(). Wave asks for its face in ' + faceModeOf('runWavePose') + ' mode; enterIdle() asks for idle in boomerang mode.',
      arch: 'Playback policy held in global state and set per call site, rather than as a property of the animation. Two call sites can disagree about the same face.',
      claim: F(
        `Playback mode is one global, set by setFaceMode() through setFaceWithMode() at each call site. runWavePose() selects its face in ${faceModeOf('runWavePose')} mode; enterIdle() selects the idle face in boomerang mode.`,
        [sym('setFaceWithMode'), sym('setFaceMode'), sym('FaceAnimMode'), sym('updateAnimatedFace'), tn('TN-004')],
      ),
      manipulate: M('pose-runner', 'wave', 'Run wave and watch the face play, then wait for idle and watch that one.'),
      expect: E('The wave face plays through and stops. The idle face keeps going, bouncing forwards and backwards. Same mechanism, different mode.', [
        ['movement.enter', 'The call site that chose the mode.'],
        ['visual.joint', 'Frames advancing, or not.'],
      ]),
      success: OK(
        'wave-face-mode',
        'The learner identified the playback mode runWavePose sets.',
        { type: 'face-mode-identified', movement: 'runWavePose', expectMode: faceModeOf('runWavePose') },
        'The mode is the second argument of the setFaceWithMode call on the third line of the function.',
      ),
      notes: ['TN-004'],
      concepts: ['animation', 'face', 'state'],
    }),
    S({
      id: 'draw-your-own-frame',
      kind: 'variation',
      title: 'Draw your own frame',
      b12: 'The display is 128 pixels across and 64 down, and each one is on or off. Draw something. Then read the honest bit: you cannot send it to the robot.',
      prog: 'The firmware ships bitmaps in flash and draws them with drawBitmap(). There is no route, no serial command and no code path anywhere that accepts a bitmap at runtime.',
      arch: 'Content compiled into the image. Authoring is an offline toolchain step, not a runtime capability.',
      claim: LABF(
        'The pixel editor is a Sesame Lab tool. The firmware has no way to receive a bitmap at runtime: face data lives in PROGMEM and is selected by name, and nothing in the route table or the serial CLI accepts image data.',
        [sym('face-bitmap-data'), sym('updateFaceBitmap'), hw('network.http.routes'), hw('commands.serialCli')],
        'What you draw is a Lab artifact on a virtual display of the same size and depth. It is not something this firmware could be given.',
      ),
      manipulate: M('pixel-editor', 'new-frame', 'Draw a 5x5 shape anywhere in the 128x64 frame.', { width: 128, height: 64, depth: 1 }),
      expect: E('Your frame renders on the virtual display exactly as a shipped face would. The path stops there.', [
        ['visual.joint', 'Your frame on the virtual OLED.'],
      ]),
      success: OK(
        'pixels-drawn',
        'At least 5 pixels were changed in a frame.',
        { type: 'pixel-edit', minPixelsChanged: 5, regionWidth: 5, regionHeight: 5 },
        'Zoom in first. At full size a 5x5 shape is very small.',
      ),
      concepts: ['bitmap', 'oled', 'progmem'],
    }),
  ],
  challenges: [
    {
      id: 'ch-find-the-other-blank',
      level: 'explorer',
      title: 'One other shipped face is also blank. Find it.',
      coreConcept: 'weak-symbol',
      unlockedBy: 'blank-face-diagnosed',
      success: OK('ch-second-blank', 'The second undefined bitmap was located and demonstrated.', { type: 'face-fallback', requestedFace: 'defualt', expectReportedFace: 'default', expectFramesRendered: 0 }, 'Its name is spelled the way it is spelled in the source. That is a clue in itself.'),
    },
  ],
});

// ====================================================== 6. read-the-firmware
L({
  id: 'read-the-firmware',
  title: 'Read the firmware',
  status: 'polished',
  estimatedMinutes: 28,
  prerequisites: ['four-legs-cooperate', 'sesames-face'],
  learningGoal:
    'Read loop() as the whole program, and work out how one thread with no operating system manages to run a movement, animate a face and answer HTTP at the same time.',
  willBeAbleTo: [
    'Say what setup() and loop() each do, and name the six service calls at the top of loop().',
    'Explain how an HTTP request gets answered in the middle of a movement.',
    'Name the only failure in this firmware that stops the robot completely.',
  ],
  labHandoff: 'The source explorer stays open in Lab, cross-linked to the trace and the architecture graph.',
  openQuestions: [
    'delayWithFace() makes movements interruptible by accident. What would break if it just called delay()?',
  ],
  steps: [
    S({
      id: 'setup-once-loop-forever',
      kind: 'concept',
      title: 'One function runs once. One runs forever.',
      b12: 'An Arduino program is two functions. setup() runs once when the robot powers on. loop() runs over and over, forever, until the power goes off. That is the whole program.',
      prog: '`void setup()` and `void loop()`. Everything else is called from one of them.',
      arch: 'A bare-metal superloop. No scheduler, no threads, no operating system - so everything that appears concurrent is cooperative.',
      claim: F(
        `setup() runs the ${HW.bootOrder.length}-step boot sequence once, and loop() then runs forever, making six service calls before it looks at the current command.`,
        [sym('setup'), sym('loop'), hw('bootOrder')],
      ),
      manipulate: M('source-selector', 'loop', 'Open loop() and read it top to bottom. It is shorter than you expect.'),
      expect: E('Six calls, then one long if/else chain, then the serial console. That is the entire runtime behaviour of the robot.', [
        ['firmware.command', 'The dispatch chain at the bottom of loop.'],
      ]),
      success: OK(
        'loop-opened',
        'The learner opened loop().',
        { type: 'source-span-selected', symbol: 'loop' },
        'It is directly below setup(). Look for the six service calls at the top.',
      ),
      concepts: ['event-loop', 'firmware', 'boot'],
    }),
    S({
      id: 'the-dispatch-chain',
      kind: 'observe',
      title: 'Nineteen commands, one if/else chain',
      b12: 'When you press a button, the robot does not look anything up. It compares your word against nineteen others, in order, until one matches.',
      prog: 'A flat `if (cmd == "forward") ... else if (cmd == "backward") ...` chain over currentCommand, one branch per movement function.',
      arch: 'Linear string dispatch. Order is the priority, and the command vocabulary is defined by this chain and nowhere else.',
      claim: F(
        `The command dispatcher inside loop() is a flat if/else chain comparing currentCommand against ${HW.commands.vocabulary.filter((c) => c.command).length} command words, each naming one movement function.`,
        [sym('command-dispatch'), sym('loop'), hw('commands.vocabulary[command=wave]')],
      ),
      manipulate: M('command-button', 'wave', 'Send wave and watch the dispatcher highlight walk down the chain until it matches.'),
      expect: E('The highlight steps through the earlier comparisons before landing on yours. Every command pays for the ones written above it.', [
        ['firmware.command', 'The branch that matched.'],
        ['movement.enter', 'The function that branch names.'],
      ]),
      success: OK(
        'dispatch-chain-found',
        'The learner opened the command dispatcher.',
        { type: 'source-span-selected', symbol: 'command-dispatch' },
        'It is the block inside loop() guarded by a check that currentCommand is not empty.',
      ),
      concepts: ['event-loop', 'string-parsing', 'state-machine'],
    }),
    S({
      id: 'a-delay-that-is-not-a-delay',
      kind: 'manipulate',
      title: 'A wait that does three other jobs',
      b12: 'Sesame has one processor and no way to do two things at once. So when a movement waits, it does not sit still - it answers the network, updates the face, and only then checks the clock again.',
      prog: '`delayWithFace(ms)` loops until the deadline calling updateAnimatedFace(), server.handleClient() and dnsServer.processNextRequest(), with a 5 ms delay() between passes.',
      arch: 'Cooperative multitasking without threads. Every servo write yields, because setServoAngle() ends with one of these.',
      claim: F(
        'delayWithFace() spends its wait calling updateAnimatedFace(), server.handleClient() and dnsServer.processNextRequest() in a loop, and setServoAngle() calls it after every single commanded angle - so a movement services the network between one joint and the next.',
        [sym('delayWithFace'), sym('setServoAngle'), tn('TN-002')],
      ),
      deeper: {
        title: 'This is also how a movement gets cancelled',
        body: 'server.handleClient() inside delayWithFace() can run an HTTP handler, and that handler can assign currentCommand. So the call stack really can be movement to delay to HTTP handler to a variable the movement is about to read. pressingCheck() reads exactly that variable. The re-entrancy is not incidental - it is the cancellation mechanism.',
        citations: [sym('delayWithFace'), sym('pressingCheck'), sym('handleCommandWeb')],
      },
      manipulate: M('http-console', '/api/status', 'Start wave, and while it is still running, send a GET to /api/status.'),
      expect: E('The request is answered while the movement is running - by the movement itself, from inside its own wait.', [
        ['http.request', 'A response arrives mid-movement.'],
        ['servo.target', 'The movement is still commanding angles.'],
      ]),
      success: OK(
        'http-answered-mid-movement',
        'A request was answered while a movement was in progress.',
        { type: 'http-request', route: '/api/status', method: 'GET', expectStatus: 200, duringMovement: 'runWavePose' },
        'Wave is long enough. Send the request while angles are still being commanded.',
      ),
      notes: ['TN-002'],
      concepts: ['reentrancy', 'event-loop', 'http'],
    }),
    S({
      id: 'the-only-hard-stop',
      kind: 'debug',
      title: 'The one failure that stops the robot completely',
      b12: 'Almost nothing in this firmware is fatal. Wi-Fi can fail, a face can be missing, a command can be nonsense - it keeps going. There is exactly one thing that stops it dead, and it is the screen.',
      prog: 'If `display.begin()` returns false, setup() prints a line and executes `while (1);`. No servo is ever attached, because that happens later in setup().',
      arch: 'A single unrecoverable initialisation. Ordering makes it worse: the display comes up before the servos, so a display fault takes the whole robot with it.',
      claim: F(
        'A failed display.begin() is the only hard stop in this firmware: setup() prints "SSD1306 allocation failed." and enters while(1). Servo attach happens later in setup(), so nothing is ever attached and loop() is never reached.',
        [sym('setup'), hw('display.bootFailureBehaviour'), hw('bootOrder[order=4]'), tn('TN-014')],
      ),
      manipulate: M('fault-injector', 'oled-init-fail', 'Turn on the display-init fault and boot the robot.'),
      expect: E('Boot stops at the display step. No servos are attached, no HTTP server starts, and loop() never runs. One line on the serial console is the entire diagnosis.', [
        ['movement.enter', 'Never reached.'],
      ]),
      success: OK(
        'boot-halt-observed',
        'Boot was shown halting at the display step with the expected log line.',
        { type: 'boot-halt', expectHaltAtBootOrder: 4, expectLogContains: 'SSD1306 allocation failed.' },
        'Watch the boot step list. It stops, and everything after it never happens.',
        'A halt is a legitimate design choice, not a bug. The exercise is deciding whether you agree with it - a robot that cannot show a face still has eight working joints.',
      ),
      notes: ['TN-014'],
      concepts: ['boot', 'error-handling', 'oled'],
    }),
    S({
      id: 'the-command-that-never-clears',
      kind: 'debug',
      title: 'Send a word the robot does not know',
      b12: 'Send a command that is not on the list. Nothing happens - and then nothing keeps happening, forever, because nobody ever clears it.',
      prog: 'The dispatcher matches nothing, so no branch clears currentCommand. Every subsequent loop() iteration walks the whole chain again and matches nothing again. /api/status keeps reporting it.',
      arch: 'A state variable with no owner on the failure path. The self-clearing is written per branch, so a missing branch means no clearing at all.',
      claim: F(
        'Only the branches that match clear currentCommand, and the continuous movement commands never clear it at all. An unrecognised word therefore stays in currentCommand indefinitely and is reported by /api/status on every request.',
        [sym('command-dispatch'), sym('handleGetStatus'), tn('TN-010')],
      ),
      manipulate: M('http-console', '/api/command', 'Send a command word that is not in the vocabulary, then read /api/status a few times.'),
      expect: E('The robot does nothing, but /api/status keeps reporting your made-up word as the current command. It never goes away on its own.', [
        ['http.request', 'The status route keeps returning it.'],
        ['firmware.command', 'A command word that matches no branch.'],
      ]),
      success: OK(
        'stuck-command-observed',
        'An unrecognised command word was shown persisting in /api/status.',
        { type: 'http-json-field', route: '/api/status', jsonPath: 'currentCommand', equalsLearnerInput: true },
        'Read the status route twice, a few seconds apart. The value does not change.',
        'You did not break the robot. The dispatcher has no else branch, and that is visible in six lines of source.',
      ),
      notes: ['TN-010'],
      concepts: ['state', 'error-handling', 'api'],
    }),
    S({
      id: 'which-line-moved-this-joint',
      kind: 'explain',
      title: 'Which line moved this joint?',
      b12: 'Pick any row in the trace and ask the source explorer which line caused it. Then do it backwards: pick a line and ask what it moved.',
      prog: 'Every telemetry row carries the symbol it came from; every symbol carries the joints it commands directly and the joints it reaches through calls.',
      arch: 'A bidirectional join between a runtime event stream and a static annotation set, keyed on the pinned commit.',
      claim: F(
        'Each annotated symbol records the joints its own body commands and the joints it reaches transitively, both in firmware enum order, so a trace row and a source span can be navigated in either direction.',
        [sym('setServoAngle'), sym('runWavePose'), doc('docs/findings/L3-source-annotations.md', 'Section 6')],
      ),
      manipulate: M('source-selector', 'setServoAngle', 'Click a servo.target row in the trace and follow it back into the source.'),
      expect: E('You land on the exact call that produced it, inside the movement function - and the joint list on that symbol matches what the trace showed.', [
        ['servo.target', 'The row you started from.'],
      ]),
      success: OK(
        'trace-to-source',
        'A trace row was navigated back to the source that produced it.',
        { type: 'source-span-selected', symbol: 'setServoAngle', reachedFrom: 'trace-row' },
        'Any servo.target row will do. They all pass through the same function.',
      ),
      concepts: ['firmware', 'movement'],
    }),
  ],
  challenges: [
    {
      id: 'ch-service-calls',
      level: 'explorer',
      title: 'Name all six service calls at the top of loop, and what each one is for',
      coreConcept: 'event-loop',
      unlockedBy: 'loop-opened',
      success: OK('ch-six-calls', 'The six service calls were identified in the source.', { type: 'source-span-selected', symbol: 'loop' }, 'They are the six lines before the first if statement.'),
    },
  ],
});

// --------------------------------------------------------------------------
// 7. The remaining thirteen, as outlines.
//
// Outline means: the goal, the ordered steps, the grounding classification and
// every reference are settled and machine-checked; the three explanatory levels
// and the full cause-and-effect copy are not yet written. The validator holds
// outlines to every rule except the ones about polish, so an outline can never
// smuggle in an uncited factual claim.
// --------------------------------------------------------------------------

// ==================================================== 7. two-wires-to-a-face
L({
  id: 'two-wires-to-a-face',
  title: 'Two wires to a face',
  status: 'outline',
  estimatedMinutes: 20,
  prerequisites: ['sesames-face'],
  learningGoal: 'Follow a face from a name in a table down to two wires and an address, and find the point where this project is modelling a library rather than Sesame.',
  willBeAbleTo: [
    'Explain what an I2C address is for and why the servos do not have one.',
    'Name the four boot steps that must succeed before anything can be drawn.',
    'Say which part of the OLED chain is Sesame source and which part is Adafruit code.',
  ],
  labHandoff: 'The bus inspector joins the Lab signal panel.',
  openQuestions: ['Every device on the bus shares the same two wires. What happens if two of them claim the same address?'],
  steps: [
    S({
      id: 'address-on-a-shared-wire', kind: 'concept', detail: 'outline',
      title: 'One pair of wires, several possible devices, one address each',
      b12: 'The screen and the controller share two wires. Every message starts with an address, so the right device knows the message is for it.',
      claim: F('The firmware defines the two I2C pins, begins the bus with them, and constructs the display for address 0x3C; the same two pins would carry any other device on the bus.',
        [sym('i2c-pin-defines'), sym('display-config-defines'), sym('display-object'), hw('display.i2cAddress'), hw('boards')]),
      manipulate: M('graph-node-picker', 'i2c', 'Follow the OLED chain down from the face name to the two pins.'),
      success: OK('i2c-chain-followed', 'The learner opened the source that defines the bus pins.', { type: 'source-span-selected', symbol: 'i2c-pin-defines' }, 'The two defines sit with the other configuration constants near the top of the sketch.'),
      concepts: ['i2c', 'oled', 'gpio'],
    }),
    S({
      id: 'wrong-address-blank-screen', kind: 'debug', detail: 'outline',
      title: 'Move the display to the wrong address',
      b12: 'Change the address by one and the screen goes blank - or rather, the robot never starts at all. Work out which, and why.',
      claim: F('display.begin() is called with the address constant and its failure path is the firmware\'s only while(1), so an address that matches no device stops boot at the display step rather than producing a blank screen later.',
        [sym('setup'), sym('display-config-defines'), hw('display.bootFailureBehaviour'), tn('TN-014')]),
      manipulate: M('fault-injector', 'oled-wrong-address', 'Address the display at 0x3D and boot.'),
      success: OK('wrong-address-diagnosed', 'The fault was traced to the address constant.', { type: 'fault-diagnosed', faultId: 'oled-wrong-address', expectIdentifiedSymbol: 'display-config-defines' }, 'Start from the last boot step that completed.', 'Wrong-address is the single most common I2C mistake there is. Diagnosing it from one log line is a real skill.'),
      concepts: ['i2c', 'boot', 'error-handling'],
    }),
    S({
      id: 'where-sesame-ends', kind: 'explain', detail: 'outline',
      title: 'Where Sesame stops and the library starts',
      b12: "Sesame's code asks for a whole picture in one call. Everything after that - splitting the picture into messages on the wire - is somebody else's code.",
      claim: LIBF('Sesame source ends at display.clearDisplay(), display.drawBitmap() and display.display(). The byte-level bus transaction is inside Adafruit_SSD1306 and Adafruit_BusIO.',
        [sym('updateFaceBitmap'), lib('Adafruit_SSD1306', 'src/Adafruit_SSD1306.cpp', null, 'Adafruit_SSD1306::display() walks the framebuffer onto the bus', 'The transaction Sesame never writes itself. No line is pinned: the library tree is gitignored, so the citable identity is library plus version.'), hw('display.renderPath')],
        'A lesson that animates individual bus bytes is modelling Adafruit_SSD1306, not this firmware. The line number is deliberately not pinned: the library tree is gitignored, so the citable identity is library plus version.'),
      manipulate: M('source-selector', 'updateFaceBitmap', 'Read the three calls and note where the trail goes cold.'),
      success: OK('render-boundary-found', 'The learner located the last line of Sesame source in the render path.', { type: 'source-span-selected', symbol: 'updateFaceBitmap' }, 'It is three lines long. All three are library calls.'),
      concepts: ['i2c', 'oled', 'bitmap'],
    }),
  ],
  challenges: [],
});

// ======================================================== 8. talk-over-serial
L({
  id: 'talk-over-serial',
  title: 'Talk over serial',
  status: 'outline',
  estimatedMinutes: 18,
  prerequisites: ['command-one-joint', 'read-the-firmware'],
  learningGoal: 'Use the debugging console the firmware author actually used, and find the two things it can do that the web UI cannot.',
  willBeAbleTo: [
    'Run a movement from the serial console.',
    'Set and save a subtrim value, and explain why "save" does not save anything.',
    'Explain why a serial console exists on a robot that already has an HTTP API.',
  ],
  labHandoff: 'The serial console is a permanent Lab panel.',
  openQuestions: ['subtrim save prints a C initialiser for you to paste into the source. What would it take to store it on the robot instead?'],
  steps: [
    S({
      id: 'run-a-move-from-serial', kind: 'manipulate', detail: 'outline',
      title: 'Two letters run a movement',
      b12: 'The console takes very short commands. rn wv runs the wave. It is faster to type than anything else on the robot.',
      claim: F(`The serial CLI accepts ${HW.commands.serialCli.length} input forms, compared with strcmp() against a fixed buffer inside loop(), including short two-letter aliases for every movement.`,
        [sym('serial-cli'), sym('loop'), hw('commands.serialCli[input=rn wv]')]),
      manipulate: M('serial-console', 'rn wv', 'Type rn wv and press enter.'),
      success: OK('serial-wave-ran', 'A movement was started from the serial console.', { type: 'serial-command', input: 'rn wv', expectLogContains: 'WAVE' }, 'The firmware prints the movement name as its first act.'),
      concepts: ['serial', 'cli'],
    }),
    S({
      id: 'subtrim-over-serial', kind: 'manipulate', detail: 'outline',
      title: 'The only way to change subtrim',
      b12: 'Subtrim can only be set here. There is no web page for it and no API route. If you want to straighten a joint, this console is the tool.',
      claim: F('Subtrim is settable only from the serial CLI, in the range -90 to 90; no HTTP route exposes it.',
        [sym('serial-cli'), sym('servoSubtrim'), hw('servos.servoConfig.subtrim'), tn('TN-003')]),
      manipulate: M('serial-console', 'st 0 8', 'Set a subtrim offset on channel 0, then command that channel and watch the commanded angle.'),
      success: OK('subtrim-over-serial-set', 'A subtrim offset was set from the console.', { type: 'subtrim-set', joint: 'R1', subtrimDeg: 8 }, 'Channel 0 is R1. The command is st, the channel, then the offset.'),
      concepts: ['calibration', 'cli', 'serial'],
    }),
    S({
      id: 'save-that-does-not-save', kind: 'debug', detail: 'outline',
      title: 'subtrim save does not save',
      b12: 'There is a save command. It prints your values as a line of C++ for you to paste back into the source. Nothing is stored on the robot.',
      claim: F('subtrim save prints a C initialiser to the serial console. Subtrim lives in RAM only; nothing is written to flash, so every power cycle returns all eight offsets to zero.',
        [sym('serial-cli'), hw('servos.servoConfig.subtrim')]),
      manipulate: M('serial-console', 'st save', 'Set an offset, save it, then restart the robot.'),
      success: OK('subtrim-not-persisted', 'The learner showed that a saved offset does not survive a restart.', { type: 'serial-command', input: 'st save', expectLogContains: 'servoSubtrim' }, 'Read what save actually prints. It is source code, addressed to you.', 'Losing your calibration on every power cycle is a design decision with reasons behind it. Working out what those reasons might have been is the exercise.'),
      concepts: ['calibration', 'state', 'cli'],
    }),
  ],
  challenges: [],
});

// ================================================== 9. send-an-http-command
L({
  id: 'send-an-http-command',
  title: 'Send an HTTP command',
  status: 'outline',
  estimatedMinutes: 22,
  prerequisites: ['read-the-firmware'],
  learningGoal: 'Drive the robot the way another program would, and find three places where this API does something you would not expect from its documentation.',
  willBeAbleTo: [
    'Send a valid /api/command request and get a movement out of it.',
    'Show that every route accepts every HTTP method, and say why that matters.',
    'Explain why a 200 OK from /cmd does not mean the movement finished.',
  ],
  labHandoff: 'The request builder becomes the Lab API console.',
  openQuestions: ['The JSON body is parsed with indexOf(). Construct a body that fools it.'],
  steps: [
    S({
      id: 'first-request', kind: 'manipulate', detail: 'outline',
      title: 'Ask the robot to wave, over the network',
      b12: 'A command is a small message with a word in it. Send it to the right address and the robot does the thing.',
      claim: F(`The firmware registers ${HW.network.http.routes.length} routes, and /api/command reads a command word out of the request body and assigns it to currentCommand for loop() to dispatch.`,
        [sym('handleApiCommand'), sym('command-dispatch'), hw('network.http.routes[path=/api/command]')]),
      manipulate: M('http-console', '/api/command', 'Build a POST with a command field set to wave and send it.'),
      success: OK('api-command-accepted', 'A valid command request was accepted.', { type: 'http-request', route: '/api/command', method: 'POST', expectStatus: 200 }, 'The body needs a command field. The route reads it out by searching the text.'),
      concepts: ['http', 'api', 'route'],
    }),
    S({
      id: 'every-method-everywhere', kind: 'observe', detail: 'outline',
      title: 'Every route answers every method',
      b12: 'Try sending your command as a GET instead of a POST. Then try it on a route that has nothing to do with commands.',
      claim: F('All routes are registered with the two-argument server.on(), which binds them to HTTP_ANY, so every route answers every method. Only /api/command checks the method itself, returning 405 for anything that is not POST.',
        [sym('setup'), sym('handleApiCommand'), hw('network.http.routes[path=/cmd]'), tn('TN-009')]),
      manipulate: M('http-console', '/cmd', 'Send the same request as GET, PUT and DELETE and compare the statuses.'),
      success: OK('method-any-observed', 'The learner probed a route with an unexpected method and got a success status.', { type: 'route-method-probe', route: '/cmd', method: 'DELETE', expectStatus: 200 }, 'Compare what you get back with what the route table says the route is for.'),
      concepts: ['http', 'route', 'api'],
    }),
    S({
      id: 'ok-before-it-happened', kind: 'debug', detail: 'outline',
      title: 'The robot says OK before it has done anything',
      b12: 'The reply comes back straight away, while the movement has not even started. The reply means "I heard you", not "I did it".',
      claim: F('/cmd assigns currentCommand and sends 200 OK immediately, with a comment saying so. loop() picks the command up afterwards, so the response carries no information about whether the movement ran.',
        [sym('handleCommandWeb'), sym('command-dispatch'), tn('TN-016')]),
      manipulate: M('http-console', '/cmd', 'Send a movement command and compare the timestamp of the response with the first servo.target row.'),
      success: OK('ack-before-action', 'The learner showed the response arriving before the first commanded angle.', { type: 'http-request', route: '/cmd', method: 'POST', expectStatus: 200 }, 'Line the two timestamps up in the trace.', 'Answering early is a deliberate choice by the firmware author, written in a comment. Deciding whether it was the right one is the exercise.'),
      concepts: ['http', 'api', 'timing'],
    }),
    S({
      id: 'indexof-is-not-a-parser', kind: 'debug', detail: 'outline',
      title: 'The JSON parser that is not a parser',
      b12: 'The robot does not really read JSON. It searches the text for a few exact strings. If your message is spelled differently but still valid JSON, it will not be understood.',
      claim: F('handleApiCommand() locates fields with body.indexOf("\\"command\\":") and a second attempt with a space, then slices between quote positions. There is no JSON parser anywhere in the firmware.',
        [sym('handleApiCommand'), tn('TN-012')]),
      manipulate: M('http-console', '/api/command', 'Send valid JSON with different whitespace, key order or escaping until you find a body that the route cannot read.'),
      success: OK('parser-fooled-and-fixed', 'A body the route could not read was found and then repaired.', { type: 'json-repaired', route: '/api/command', expectStatus: 200 }, 'Two spellings are handled explicitly. Everything else is not.', 'Breaking a parser on purpose is how you find out what it really accepts. Every valid message it rejects is a real limitation, not your mistake.'),
      concepts: ['json', 'string-parsing', 'api'],
    }),
  ],
  challenges: [],
});

// ====================================================== 10. read-json-state
L({
  id: 'read-json-state',
  title: 'Read the robot\'s state as JSON',
  status: 'outline',
  estimatedMinutes: 20,
  prerequisites: ['send-an-http-command'],
  learningGoal: 'Read the robot\'s own description of itself, then break it with a single quotation mark and understand exactly why that works.',
  willBeAbleTo: [
    'Read /api/status and say what each field means.',
    'Produce a response that is not valid JSON, using only a legal command word.',
    'Explain what an escaping function is for, and find the one this route does not call.',
  ],
  labHandoff: 'The state inspector is a permanent Lab panel.',
  openQuestions: ['The escaper is a hundred lines above the route that needs it. How would you make that mistake impossible rather than unlikely?'],
  steps: [
    S({
      id: 'what-the-robot-says', kind: 'observe', detail: 'outline',
      title: 'What the robot says about itself',
      b12: 'One request returns everything the robot is willing to tell you: what it is doing, what face it is wearing, and whether it is on a network.',
      claim: F('/api/status returns currentCommand, currentFace, networkConnected and apIP, plus networkIP when connected. Those five fields are the entire externally visible state.',
        [sym('handleGetStatus'), hw('network.http.routes[path=/api/status]')]),
      manipulate: M('http-console', '/api/status', 'Send a GET and read the five fields.'),
      success: OK('status-read', 'The status route was read and the current face identified.', { type: 'http-json-field', route: '/api/status', jsonPath: 'currentFace' }, 'Run a movement first so there is something interesting in there.'),
      concepts: ['json', 'api', 'state'],
    }),
    S({
      id: 'break-it-with-a-quote', kind: 'debug', detail: 'outline',
      title: 'Break the response with one character',
      b12: 'Send a command word with a quotation mark in it. Then read the status. The reply is no longer valid JSON, and every program that reads it will fail.',
      claim: F('handleGetStatus() builds its response by string concatenation and interpolates currentCommand and currentFaceName without escaping, even though jsonEscape() is defined in the same file. A quote in a command word therefore terminates the JSON string early.',
        [sym('handleGetStatus'), sym('jsonEscape'), tn('TN-008'), issue('ISSUE-20260823-021')]),
      manipulate: M('http-console', '/api/command', 'Send a command word containing a quotation mark, then read /api/status.'),
      success: OK('status-json-broken', 'A malformed status response was produced from a legal request.', { type: 'http-json-field', route: '/api/status', jsonPath: 'currentCommand', equalsLearnerInput: true }, 'The command does not have to be a real one. It only has to be stored.', 'This is a real tracked defect, ISSUE-20260823-021, and you found it the same way a security researcher would: by putting a character somewhere nobody expected one.'),
      concepts: ['json', 'string-parsing', 'error-handling'],
    }),
    S({
      id: 'the-escaper-nobody-called', kind: 'explain', detail: 'outline',
      title: 'The fix was already in the file',
      b12: 'The firmware already has a function that would have prevented this. The status route just does not call it.',
      claim: F('jsonEscape() exists in the same file and escapes backslashes, quotes and control characters. Other response builders use it; handleGetStatus() does not.',
        [sym('jsonEscape'), sym('handleGetStatus'), sym('handleWifiScan')]),
      manipulate: M('source-selector', 'jsonEscape', 'Find the escaper, then find every route that calls it and every route that does not.'),
      success: OK('escaper-located', 'The learner located the unused escaper.', { type: 'source-span-selected', symbol: 'jsonEscape' }, 'Search for the function name. The interesting part is how few call sites there are.'),
      concepts: ['json', 'error-handling', 'api'],
    }),
  ],
  challenges: [],
});

// ================================================== 11. sesame-on-a-network
L({
  id: 'sesame-on-a-network',
  title: 'Put Sesame on a network',
  status: 'outline',
  estimatedMinutes: 22,
  prerequisites: ['send-an-http-command'],
  learningGoal: 'Understand the two ways Sesame can be on a network at once, and read the boot sequence that sets them up - including the seven steps that do not exist in the emulator.',
  willBeAbleTo: [
    'Explain the difference between the robot making a network and the robot joining one.',
    'Explain what a captive portal is and which two pieces of firmware create the illusion.',
    'Say which parts of this lesson can never be demonstrated under QEMU, and why.',
  ],
  labHandoff: 'The network state view joins the Lab inspector.',
  openQuestions: ['Wi-Fi credentials are deliberately not written to flash. What does that buy, and what does it cost?'],
  steps: [
    S({
      id: 'two-modes-at-once', kind: 'concept', detail: 'outline',
      title: 'Making a network and joining one',
      b12: 'Sesame can make its own Wi-Fi network for you to join, or join one you already have. It can do both at the same time.',
      claim: F('setup() optionally connects to a configured network first, then unconditionally starts a soft access point, so the robot can hold both an AP address and a station address at once.',
        [sym('setup'), sym('connectToWifi'), sym('network-config-defines'), hw('bootOrder[order=6]')]),
      manipulate: M('graph-node-picker', 'network', 'Open the network branch and follow both paths.'),
      success: OK('two-modes-found', 'The learner opened the connection helper.', { type: 'source-span-selected', symbol: 'connectToWifi' }, 'One of the two paths can fail and be tolerated. Find which.'),
      concepts: ['wifi', 'ap-mode', 'state-machine'],
    }),
    S({
      id: 'the-captive-portal-trick', kind: 'observe', detail: 'outline',
      title: 'Why joining the robot pops open a page',
      b12: 'A DNS server that answers every question with the robot\'s own address, plus a route that catches everything else. Between them, any address you type lands on the robot. When it is on your home network instead, it advertises a name so you do not have to remember an address.',
      claim: F('A DNSServer is started alongside the HTTP server and loop() pumps it every iteration, and handleNotFound() catches unmatched paths - together, the captive portal. On a joined network startMdns() advertises a hostname instead.',
        [sym('dns-server'), sym('handleNotFound'), sym('startMdns'), sym('loop'), hw('bootOrder[order=12]'), hw('bootOrder[order=10]')]),
      manipulate: M('http-console', '*', 'Request a path that does not exist and read what comes back.'),
      success: OK('notfound-probed', 'The catch-all route was probed.', { type: 'route-method-probe', route: '*', method: 'GET', expectStatus: 404 }, 'Ask for something that is definitely not a route.'),
      concepts: ['dns', 'http', 'ap-mode', 'mdns'],
    }),
    S({
      id: 'none-of-this-runs-in-qemu', kind: 'explain', detail: 'outline',
      title: 'None of this runs on the emulator',
      b12: 'The emulated chip has no radio. To make the firmware boot at all under QEMU, seven boot steps had to be removed - and all seven are on this page.',
      claim: EMUF('QEMU\'s esp32 machine has no Wi-Fi radio. The image used in this project elides the Wi-Fi, SoftAP, mDNS, DNS and server.begin() steps - seven of the twenty boot steps - so the remaining thirteen can execute.',
        [doc('docs/findings/Q1-qemu-spike.md', 'Section 7', 'RAN'), doc('docs/findings/Q2-qemu-backend.md', 'Section 0', 'RAN')],
        'A limitation of the emulator, not of Sesame. On a real robot these steps run; nothing in this project can watch them do it.',
        'ran-in-qemu'),
      manipulate: M('boot-stepper', 'nowifi', 'Step the boot sequence on the QEMU backend and find the gaps.'),
      success: OK('elided-steps-found', 'The learner stepped the emulated boot and found where the network steps are missing.', { type: 'boot-step-reached', expectBootOrder: 13 }, 'Compare the emulated boot list against the twenty steps in the firmware.'),
      concepts: ['wifi', 'emulator', 'boot'],
    }),
  ],
  challenges: [],
});

// ======================================================= 12. debug-a-robot
L({
  id: 'debug-a-robot',
  title: 'Debug a robot',
  status: 'outline',
  estimatedMinutes: 30,
  prerequisites: ['read-the-firmware', 'sesames-face', 'send-an-http-command'],
  learningGoal: 'Diagnose four faults you have already met, but this time without being told which lesson they came from - working from the symptom to the source span.',
  willBeAbleTo: [
    'Work backwards from a symptom to a source span, using the trace and the boot list.',
    'Tell a firmware defect apart from a fault Sesame Lab injected.',
    'Write down a diagnosis that names a line of code.',
  ],
  labHandoff: 'The fault injector stays in Lab, with all declared faults available.',
  openQuestions: ['Three of these faults produce no error message at all. What would you add to the firmware to make each one announce itself?'],
  steps: [
    S({
      id: 'symptom-first', kind: 'debug', detail: 'outline',
      title: 'Here is the symptom. Find the line.',
      b12: 'Something is wrong. You are not told what. Work from what you can see back to the code that explains it.',
      claim: F('Each declared fault corresponds to a real behaviour of the pinned firmware with a named source span: the undefined face bitmaps, the pre-clamp subtrim, the display-init halt, the never-cleared command word and the unescaped status response.',
        [sym('face-weak-decls'), sym('setServoAngle'), sym('setup'), sym('command-dispatch'), sym('handleGetStatus'), tn('TN-001'), tn('TN-003'), tn('TN-014')]),
      manipulate: M('fault-injector', 'random', 'Take a fault without being told which one it is.'),
      success: OK('fault-traced', 'A fault was traced to the source span that causes it.', { type: 'fault-diagnosed', faultId: 'blank-face-stand', expectIdentifiedSymbol: 'face-weak-decls' }, 'Start from the last thing that definitely worked.', 'Being wrong twice before being right is the normal shape of this. The trace does not judge.'),
      concepts: ['error-handling', 'calibration', 'face'],
    }),
    S({
      id: 'injected-or-real', kind: 'explain', detail: 'outline',
      title: 'Is this fault real, or did the lab do it to you?',
      b12: 'Some of these faults are in the firmware as it ships. Others are things the lab turned on to give you something to find. Knowing which is which matters.',
      claim: LABF('Of the declared faults, three are shipped firmware behaviour and are not injected at all; the rest are Sesame Lab injections that make a real firmware failure path reachable on demand.',
        [doc('docs/findings/L3-source-annotations.md', 'Section 5'), hw('display.bootFailureBehaviour')],
        'The injector is a Sesame Lab feature. Every failure it produces is a real firmware path, but the trigger is not.'),
      manipulate: M('fault-injector', 'catalogue', 'Read the fault list and sort it into shipped behaviour and injected behaviour.'),
      success: OK('fault-provenance-sorted', 'The learner distinguished a shipped defect from an injected one.', { type: 'fault-diagnosed', faultId: 'unknown-command-sticks', expectIdentifiedSymbol: 'command-dispatch' }, 'One of these needs no injector at all. Send a nonsense word and watch.'),
      concepts: ['error-handling', 'firmware'],
    }),
    S({
      id: 'write-the-diagnosis', kind: 'variation', detail: 'outline',
      title: 'Write a diagnosis somebody else could act on',
      b12: 'A diagnosis is not "the face is broken". It is a symptom, a line of code, and a reason the one causes the other.',
      claim: F('Every teaching note in this project carries at least two source citations, because a claim about firmware behaviour without a line number is not checkable.',
        [sym('countFrames'), sym('setFace'), doc('docs/findings/L3-source-annotations.md', 'Section 4')]),
      manipulate: M('source-selector', 'countFrames', 'Write your diagnosis and attach the source span it rests on.'),
      success: OK('diagnosis-cited', 'A diagnosis was submitted with a source span attached.', { type: 'source-span-selected', symbol: 'countFrames' }, 'The span should be the code that explains the symptom, not the code where you first noticed it.'),
      concepts: ['error-handling', 'firmware'],
    }),
  ],
  challenges: [],
});

// ==================================================== 13. inside-the-brain
L({
  id: 'inside-the-brain',
  title: 'Inside the brain',
  status: 'outline',
  estimatedMinutes: 18,
  prerequisites: ['read-the-firmware', 'how-pwm-asks'],
  learningGoal: 'Look at what is behind the pin numbers you have been using - and find out how little of that this project can actually show you.',
  willBeAbleTo: [
    'Explain what a peripheral is and why a pin number is a peripheral question.',
    'Say which facts about the chip come from firmware source and which come from a README.',
  ],
  labHandoff: 'The board profile selector stays in Lab.',
  openQuestions: ['The firmware names four boards and never names its own chip. How would you find out what it is running on, from inside the program?'],
  steps: [
    S({
      id: 'the-chip-is-not-in-the-source', kind: 'concept', detail: 'outline',
      title: 'The firmware never says what chip it is',
      b12: 'You would expect the code to say what computer it runs on. It does not. It names pin numbers and four board layouts, and nothing else.',
      claim: C('Nothing in the pinned firmware describes the processor, its memory, or its peripheral layout. Pin assignment is factual; anything about the inside of the chip is a reading imported from elsewhere.',
        MODULE.get('inside-the-brain').conceptualReason,
        [sym('servo-pin-table'), sym('ino-includes'), hw('boards')]),
      manipulate: M('source-selector', 'servo-pin-table', 'Search the pinned tree for the chip family name. Count the hits.'),
      success: OK('no-soc-in-source', 'The learner confirmed the firmware carries no description of the SoC.', { type: 'source-span-selected', symbol: 'servo-pin-table' }, 'The board comments are the closest the source gets, and they name boards, not chips.'),
      concepts: ['esp32', 'gpio'],
    }),
    S({
      id: 'pins-are-real', kind: 'manipulate', detail: 'outline',
      title: 'The pins, at least, are real',
      b12: 'Pin numbers are in the source and you can trust them. Which pin belongs to which joint is a fact. What is inside the chip behind that pin is not, here.',
      claim: F('The per-board pin arrays are the one hardware fact the firmware states about itself, and the active profile is the only one not commented out.',
        [sym('servo-pin-table'), hw('servos.joints[firmwareName=L4].pinsByBoard')]),
      manipulate: M('board-selector', 'servoPins', 'Switch boards and watch the pins move under fixed joint names.'),
      success: OK('pins-are-factual', 'A board switch was applied and the pin change confirmed against source.', { type: 'board-switched', fromBoard: 's2-mini', toBoard: 'distro-v3', expectJointNamesUnchanged: true }, 'Three of the four arrays are commented out. Only one is compiled.'),
      concepts: ['gpio', 'esp32'],
    }),
  ],
  challenges: [],
});

// ==================================================== 14. build-a-leg-pose
L({
  id: 'build-a-leg-pose',
  title: 'Build a leg pose - and ask a better question',
  status: 'outline',
  estimatedMinutes: 25,
  prerequisites: ['four-legs-cooperate'],
  learningGoal: 'Coordinate two channels into something that looks like a limb, then confront the fact that nobody in this project can tell you whether it is one - and use that to frame what inverse kinematics would actually require.',
  willBeAbleTo: [
    'Coordinate two joints into a repeatable relative pose.',
    'Explain why the joint map records limb names as guesses that can never be settled here.',
    'State what a kinematic solver would need that this project does not have.',
  ],
  labHandoff: 'Paired-joint controls stay in Lab.',
  openQuestions: [
    'Sesame works today as a list of angles. What would improve if it worked as a model instead - and what would you have to establish first to even try?',
  ],
  steps: [
    S({
      id: 'two-joints-together', kind: 'manipulate', detail: 'outline',
      title: 'Move two channels as one',
      b12: 'Pick two channels and move them together, keeping a fixed relationship between them. That is the whole idea of a limb, expressed as arithmetic.',
      claim: F('Pose functions coordinate channels only by writing them in sequence with fixed angles; the firmware has no concept of a pair, a chain or a linkage.',
        [sym('runStandPose'), sym('runCrabPose'), hw('movements[function=runCrabPose]')]),
      manipulate: M('joint-slider', 'R1', 'Move R1 and R2 together, holding the difference between them constant.', { min: 0, max: 180 }),
      success: OK('paired-joints', 'Two channels were commanded into a fixed relative pose.', { type: 'servo-target', joint: 'R2', angleDeg: 45 }, 'Start from the stand angles for the two channels and move both by the same amount.'),
      concepts: ['pose', 'servo'],
    }),
    S({
      id: 'nobody-knows-which-is-a-hip', kind: 'explain', detail: 'outline',
      title: 'Nobody here knows which one is a hip',
      b12: 'You just made something that looks like a leg bending. Whether those two channels really are a hip and a knee is a guess - and in this project it is a guess that can never be checked.',
      claim: C('The firmware has no hip, no leg, and no left or right pairing. Limb names live in the joint map marked unverified, and the standing no-hardware constraint makes that permanent rather than pending.',
        MODULE.get('build-a-leg-pose').conceptualReason,
        [hw('servos.joints'), doc('docs/plan.md', 'Standing constraint - no physical hardware, ever'), doc('docs/findings/F6-joint-map.md')]),
      manipulate: M('joint-picker', 'R1', 'Turn on the semantic-name overlay and read the verification status on each name.'),
      success: OK('semantic-names-unverified', 'The learner found the verification status attached to the limb names.', { type: 'source-span-selected', symbol: 'ServoName' }, 'The firmware enum is the only authoritative name a joint has.'),
      concepts: ['pose', 'calibration'],
    }),
    S({
      id: 'what-a-solver-would-need', kind: 'concept', detail: 'outline',
      title: 'Here is how Sesame works today. How could it work better?',
      b12: 'To tell a robot "put this foot there", you need to know how the pieces connect and how long they are. Sesame has none of that. Now that you know what is missing, you can say what it would take.',
      claim: C('Inverse kinematics needs a joint tree, link lengths and a convention for the zero position. Sesame has an ordered list of angles and no model, which is why sequencing is the honest thing to teach first.',
        MODULE.get('build-a-leg-pose').conceptualReason,
        [sym('runStandPose'), sym('runWalkPose')]),
      manipulate: M('sequence-editor', 'new', 'Write down what you would need to know about the robot before a solver could work, and check each item against what this project actually has.'),
      success: OK('solver-requirements-listed', 'A sequence was authored that reaches a target pose by hand, in place of a solver.', { type: 'sequence-authored', minFrames: 2, maxCommandedAngleOutOfRange: 0 }, 'Do by hand what a solver would do, and notice how much you had to assume.'),
      concepts: ['pose', 'movement'],
    }),
  ],
  challenges: [],
});

// ==================================================== 15. build-a-movement
L({
  id: 'build-a-movement',
  title: 'Build a movement',
  status: 'outline',
  estimatedMinutes: 25,
  prerequisites: ['four-legs-cooperate'],
  learningGoal: 'Author a full movement in the editor, export it as Sesame C++, and understand why exporting source is the only way it could ever reach a robot.',
  willBeAbleTo: [
    'Author a multi-frame movement with timing.',
    'Read the exported C++ and match it line for line against a shipped movement.',
    'Explain why the firmware cannot be sent a movement at runtime.',
  ],
  labHandoff: 'Everything authored here is a Lab project.',
  openQuestions: ['What would have to change in the firmware for a movement to be sent over the API instead of compiled in?'],
  steps: [
    S({
      id: 'author-then-export', kind: 'variation', detail: 'outline',
      title: 'Author a movement, then read it as C++',
      b12: 'Build your movement out of frames, then look at it as code. It should look exactly like the ones in the firmware, because that is the only form it could take.',
      claim: LABF('The editor and the C++ export are Sesame Lab features. Movements in this firmware are hand-written inline functions in a header, so the only representation the firmware could ever accept is source code.',
        [hw('movements[function=runDancePose]'), doc('docs/findings/L3-source-annotations.md', 'Section 5')],
        'The editor is not part of Sesame. The upstream project has its own separate tool, Sesame Studio, for the same reason: nothing at runtime can take a movement.'),
      manipulate: M('sequence-editor', 'new', 'Author at least five frames with timing, then open the export view.'),
      success: OK('movement-exported', 'A five-frame movement was authored with every commanded angle in range.', { type: 'sequence-authored', minFrames: 5, maxCommandedAngleOutOfRange: 0 }, 'Copy the shape of a shipped movement: banner, face, angles, waits, stand.'),
      concepts: ['movement', 'timing', 'firmware'],
    }),
    S({
      id: 'compare-to-a-real-one', kind: 'observe', detail: 'outline',
      title: 'Compare yours with a real one',
      b12: 'Put your exported code next to the dance function from the firmware. Find every difference.',
      claim: F('Shipped movements follow one shape: a Serial banner, a setFaceWithMode() call, runs of setServoAngle() with delayWithFace() between them, and a closing runStandPose(1) plus a command self-clear.',
        [sym('runDancePose'), sym('runWavePose'), hw('movements[function=runDancePose]')]),
      manipulate: M('source-selector', 'runDancePose', 'Read the dance function and compare it with your export.'),
      success: OK('compared-to-shipped', 'The learner opened a shipped movement to compare against their export.', { type: 'source-span-selected', symbol: 'runDancePose' }, 'The closing two lines are the ones people forget.'),
      concepts: ['movement', 'firmware'],
    }),
    S({
      id: 'why-there-is-no-editor', kind: 'explain', detail: 'outline',
      title: 'Why the firmware has no editor of its own',
      b12: 'Everything in this lesson happens in the lab, not on the robot. There is no frame editor in Sesame and no format for a movement - so this whole idea is one the lab brought with it.',
      claim: C("There is no movement editor and no movement data format anywhere in the pinned firmware. The editing experience taught here belongs to Sesame Lab, so this module cannot claim to describe how Sesame works.",
        MODULE.get('build-a-movement').conceptualReason,
        [sym('movement-prototypes'), hw('movements[function=runWavePose]')]),
      manipulate: M('source-selector', 'movement-prototypes', 'Search the pinned tree for anything that reads a movement at runtime.'),
      success: OK('no-movement-format', 'The learner confirmed the firmware has no runtime movement format.', { type: 'source-span-selected', symbol: 'movement-prototypes' }, 'Every movement is a function name in a header. There is nothing else to find.'),
      concepts: ['movement', 'firmware'],
    }),
  ],
  challenges: [],
});

// ================================================= 16. what-an-emulator-is
L({
  id: 'what-an-emulator-is',
  title: 'What an emulator really is',
  status: 'outline',
  estimatedMinutes: 25,
  prerequisites: ['read-the-firmware', 'how-pwm-asks'],
  learningGoal: 'Learn the three-way distinction this whole project is built on - a behavioural simulator, a firmware emulator, and physical hardware - and learn exactly what each one can and cannot tell you.',
  willBeAbleTo: [
    'Define simulator and emulator in a way that survives being asked for an example.',
    'Say which of the two backends in this lab is which, and what evidence each produces.',
    'Name three things neither of them can tell you, and say why.',
  ],
  labHandoff: 'The backend selector and the emulator controls are permanent Lab tools.',
  openQuestions: [
    'If the emulator models a peripheral\'s registers correctly but produces no signal, has it verified anything? Argue both sides.',
  ],
  steps: [
    S({
      id: 'three-things-not-two', kind: 'concept', detail: 'outline',
      title: 'Three things, not two',
      b12: 'A simulator is a model of what a robot does. An emulator is a pretend computer running the robot\'s real program. Real hardware is neither. They answer different questions, and this lab has two of the three.',
      claim: C('Simulator, emulator and physical hardware are three different kinds of evidence. Nothing in the pinned firmware describes its own execution environment, so this distinction cannot be grounded in Sesame source at all.',
        MODULE.get('what-an-emulator-is').conceptualReason,
        [doc('docs/findings/Q1-qemu-spike.md', 'Section 0'), doc('docs/plan.md', 'Standing constraint - no physical hardware, ever')]),
      manipulate: M('backend-switch', 'simulator', 'Run the same command on each backend and compare what each one is able to report.'),
      success: OK('backends-compared', 'The same command was run on both backends and the commanded poses compared.', { type: 'backend-switched', fromBackend: 'simulator', toBackend: 'qemu', expectSameCommandedPose: true }, 'Compare the commanded angles first, then compare the provenance badges. Only one of those two is the same.'),
      concepts: ['emulator', 'simulator'],
    }),
    S({
      id: 'what-qemu-actually-did', kind: 'observe', detail: 'outline',
      title: 'What the emulator actually did',
      b12: 'The emulator ran Sesame\'s real compiled program, instruction by instruction, and the program printed things. That is a genuinely strong claim - and it stops at the edge of the chip.',
      claim: EMUF('QEMU boots the real compiled firmware image and executes it: setup() runs, movement functions run, and the firmware\'s own serial output arrives on UART0. The full contract suite passes against it.',
        [doc('docs/findings/Q2-qemu-backend.md', 'Section 0', 'RAN'), doc('docs/findings/Q1-qemu-spike.md', 'Section 7', 'RAN')],
        'A fact about the emulator, not about Sesame hardware. Real instructions, emulated silicon, no physical robot anywhere in the chain.',
        'ran-in-qemu'),
      manipulate: M('emulator-controls', 'boot', 'Boot the firmware under QEMU and watch the boot steps arrive.'),
      success: OK('qemu-boot-watched', 'A real firmware boot under QEMU was observed reaching the servo step.', { type: 'emulator-boot-observed', backend: 'qemu', expectBootOrderReached: 17 }, 'The boot list fills in as the firmware\'s own log lines arrive.'),
      concepts: ['emulator', 'boot', 'firmware'],
    }),
    S({
      id: 'three-things-it-cannot-tell-you', kind: 'explain', detail: 'outline',
      title: 'Three things neither backend can tell you',
      b12: 'No waveform. No radio. And no idea whether a joint is a hip. Each of those is missing for a different reason, and being able to say which reason is the skill.',
      claim: EMUF('The image used here has Wi-Fi elided because the emulated machine has no radio; the emulated LEDC stores duty and produces no waveform; and limb identity is unverifiable because there is no physical robot. Three different kinds of gap.',
        [doc('docs/findings/Q1-qemu-spike.md', 'Section 7', 'RAN'), doc('docs/findings/Q3-ledc-fidelity.md', 'Section 0', 'RAN'), doc('docs/plan.md', 'Standing constraint - no physical hardware, ever')],
        'These are limits of the emulator and of this project. None of them is a defect in Sesame.',
        'inert-in-emulator'),
      manipulate: M('trace-inspector', 'pwm.output', 'Find one row that is observed from the emulator and one that is inferred, on the same trace.'),
      success: OK('gap-kinds-distinguished', 'The learner distinguished an emulator-observed row from an inferred one.', { type: 'trace-badge-identified', traceLayer: 'servo.target', expectedProvenance: 'observed-from-emulator' }, 'Run on the QEMU backend. Two rungs change badge; the rest do not.'),
      concepts: ['emulator', 'simulator', 'pwm'],
    }),
  ],
  challenges: [],
});

// ================================================== 17. real-versus-virtual
L({
  id: 'real-versus-virtual',
  title: 'Real versus virtual',
  status: 'outline',
  estimatedMinutes: 18,
  prerequisites: ['what-an-emulator-is'],
  learningGoal: 'Run the same command through two completely different implementations behind one interface, and see what an abstraction is actually for.',
  willBeAbleTo: [
    'Explain what it means for two backends to share a contract.',
    'Say what "real" can and cannot mean in this project.',
  ],
  labHandoff: 'The backend selector stays in Lab.',
  openQuestions: ['The contract suite runs the same fifteen cases against both backends. What would a sixteenth case have to check that neither currently does?'],
  steps: [
    S({
      id: 'one-interface-two-backends', kind: 'manipulate', detail: 'outline',
      title: 'One interface, two very different things behind it',
      b12: 'The same button drives a model of the robot and a pretend computer running the robot\'s real program. The page cannot tell the difference, and that is the point.',
      claim: C('The shared robot contract is Sesame Lab\'s own abstraction. No pinned firmware symbol corresponds to it, and in this project "real" can only ever mean real firmware under QEMU - a physical adapter is permanently out of scope.',
        MODULE.get('real-versus-virtual').conceptualReason,
        [doc('docs/findings/V5-api-adapter.md'), doc('docs/plan.md', 'Standing constraint - no physical hardware, ever')]),
      manipulate: M('backend-switch', 'qemu', 'Send the same command on both backends and compare the resulting commanded poses.'),
      success: OK('contract-parity', 'The same command produced the same commanded pose on both backends.', { type: 'backend-switched', fromBackend: 'qemu', toBackend: 'simulator', expectSameCommandedPose: true }, 'Compare the eight commanded angles, not the timing. The timing is not part of the contract.'),
      concepts: ['simulator', 'emulator', 'api'],
    }),
    S({
      id: 'what-real-cannot-mean', kind: 'explain', detail: 'outline',
      title: 'What "real" cannot mean here',
      b12: 'One of these backends is more real than the other. Neither of them is a robot, and in this project neither ever will be.',
      claim: C('Phase 3 and a physical-hardware adapter are permanently out of scope, so every claim this system will ever make about a servo is a claim about what the code commanded.',
        MODULE.get('real-versus-virtual').conceptualReason,
        [doc('docs/plan.md', 'Standing constraint - no physical hardware, ever')]),
      manipulate: M('trace-inspector', 'joint.target', 'Read the joint.target row on both backends and compare the badges.'),
      success: OK('joint-target-is-a-target', 'The learner identified joint.target as inferred on both backends.', { type: 'trace-badge-identified', traceLayer: 'joint.target', expectedProvenance: 'inferred-for-explanation' }, 'There is no position feedback anywhere in this system. That row is a target.'),
      concepts: ['simulator', 'emulator', 'state'],
    }),
  ],
  challenges: [],
});

// ========================================================= 18. inside-qemu
L({
  id: 'inside-qemu',
  curriculumRef: 'inside-renode',
  supersedes: 'inside-renode',
  title: 'Inside QEMU',
  status: 'outline',
  estimatedMinutes: 25,
  prerequisites: ['what-an-emulator-is'],
  learningGoal: 'Take the emulator apart: watch real firmware boot, step it, and look at the peripheral that models everything correctly except the one thing you wanted.',
  willBeAbleTo: [
    'Watch a real firmware boot and name what executed.',
    'Explain what an emulated peripheral is, using LEDC as the example.',
    'Say why "the registers hold plausible values" is not "a pulse was produced".',
  ],
  labHandoff: 'The emulator controls stay in Lab.',
  openQuestions: ['What would you have to add to the LEDC model to make the pwm.output row honest? Is it worth it?'],
  steps: [
    S({
      id: 'watch-real-firmware-boot', kind: 'observe', detail: 'outline',
      title: 'Watch a real firmware image boot',
      b12: 'This is not a model of Sesame. It is Sesame\'s actual compiled program, running on a pretend chip, printing its own messages.',
      claim: EMUF('The QEMU backend boots a real compiled Sesame image on the legacy Distro V1 board profile and the firmware executes: the boot steps arrive as the firmware\'s own log lines on UART0.',
        [doc('docs/findings/Q1-qemu-spike.md', 'Section 7', 'RAN'), doc('docs/findings/Q2-qemu-backend.md', 'Section 0', 'RAN')],
        'The emulated machine is the legacy ESP32 Distro V1 board, not the Lolin S2 Mini the source builds for by default - that is the profile QEMU supports.',
        'ran-in-qemu'),
      manipulate: M('emulator-controls', 'boot', 'Boot it and read the log.'),
      success: OK('firmware-boot-observed', 'A real firmware boot was observed reaching the servo attach step.', { type: 'emulator-boot-observed', backend: 'qemu', expectBootOrderReached: 17 }, 'Watch for the first line the firmware itself prints.'),
      concepts: ['emulator', 'boot', 'firmware'],
    }),
    S({
      id: 'a-peripheral-that-does-nothing', kind: 'debug', detail: 'outline',
      title: 'A peripheral that stores the right number and does nothing with it',
      b12: 'The emulator does have a PWM peripheral. It works out the correct duty percentage, stores one byte, and nothing anywhere ever reads it again.',
      claim: EMUF('QEMU\'s LEDC device is mapped and decoded, and every servo write reaches it and produces a duty percentage matching the TRM formula. It has no timer, no clock, no GPIO connection and no output, and the byte it stores has no readers in the binary.',
        [doc('docs/findings/Q3-ledc-fidelity.md', 'Section 0, Sections 2-3', 'SRC'), issue('ISSUE-20260824-024')],
        'This is what the emulator does, established by reading its registers back over a debugger. It is not a statement about Sesame or about any real chip.',
        'inert-in-emulator'),
      manipulate: M('emulator-controls', 'ledc', 'Command an angle and inspect what the emulated peripheral holds afterwards.'),
      success: OK('inert-peripheral-found', 'The learner confirmed that the pwm row stays inferred even on the emulator backend.', { type: 'trace-badge-identified', traceLayer: 'pwm.output', expectedProvenance: 'inferred-for-explanation' }, 'Switch to QEMU and look at that row again. It does not improve.', 'This is the most useful disappointment in the project. An emulator that models registers is not an emulator that models signals, and knowing the difference is the whole lesson.'),
      concepts: ['emulator', 'ledc', 'pwm'],
    }),
    S({
      id: 'why-not-renode', kind: 'explain', detail: 'outline',
      title: 'Why this lesson is not about Renode',
      b12: 'The plan for this project originally used a different emulator, called Renode. It was replaced, and the honest thing is to say so rather than teach a tool nobody here uses.',
      claim: EMUF('The Renode track was superseded by QEMU and closed. Espressif\'s QEMU delivered, vendor-maintained, what the Renode route was costed at weeks of work to reach.',
        [doc('docs/plan.md', 'Phase 4: Renode track - SUPERSEDED by QEMU'), doc('docs/findings/Q1-qemu-spike.md', 'Section 0'), issue('ISSUE-20260823-001')],
        'A fact about this project\'s tooling decisions, not about Sesame.',
        'ran-in-qemu'),
      manipulate: M('emulator-controls', 'about', 'Read which emulator is running and what it is standing in for.'),
      success: OK('emulator-identified', 'The learner identified which emulator the lab actually runs.', { type: 'emulator-boot-observed', backend: 'qemu', expectBootOrderReached: 1 }, 'The backend names itself in the emulator panel.'),
      concepts: ['emulator'],
    }),
    S({
      id: 'not-a-lesson-about-sesame', kind: 'explain', detail: 'outline',
      title: 'This lesson is not about Sesame',
      b12: "Everything on this page is about the emulator. Sesame's own code never mentions where it is running, so nothing here can be checked against the firmware.",
      claim: C('Nothing in the pinned firmware describes its own execution environment, so no claim on this page can be grounded in a Sesame symbol. The subject is the emulator, and this module is labelled conceptual for that reason.',
        MODULE.get('inside-renode').conceptualReason,
        [doc('docs/findings/L3-source-annotations.md', 'Section 5')]),
      manipulate: M('source-selector', 'setup', 'Search the pinned tree for the word emulator, or for anything naming the machine it runs on.'),
      success: OK('no-self-description', 'The learner confirmed the firmware never describes its own execution environment.', { type: 'source-span-selected', symbol: 'setup' }, 'setup() is where a program would say what it is running on, if it ever did.'),
      concepts: ['emulator', 'firmware'],
    }),
  ],
  challenges: [],
});

// =========================================== 19. build-your-own-experiment
L({
  id: 'build-your-own-experiment',
  title: 'Build your own experiment',
  status: 'outline',
  estimatedMinutes: 40,
  prerequisites: ['read-the-firmware', 'debug-a-robot', 'what-an-emulator-is'],
  learningGoal: 'Ask a question about Sesame that nobody has answered here, and answer it with the tools - with a citation.',
  willBeAbleTo: [
    'Pose a question that has a checkable answer.',
    'Answer it with evidence, and say what kind of evidence it is.',
  ],
  labHandoff: 'This lesson is the door into Lab. Everything the learner has built stays available.',
  openQuestions: ['What is the most interesting thing about Sesame that this curriculum does not cover?'],
  steps: [
    S({
      id: 'ask-something-checkable', kind: 'variation', detail: 'outline',
      title: 'Ask a question with a checkable answer',
      b12: 'Pick something you actually want to know. Then work out what evidence would settle it, and whether this lab can produce that evidence at all.',
      claim: C('This module has no subject of its own. It inherits the grounding of whatever the learner draws on, which is why the citation habit has to come from the earlier lessons rather than from this one.',
        MODULE.get('build-your-own-experiment').conceptualReason,
        [doc('docs/findings/L3-source-annotations.md', 'Section 5')]),
      manipulate: M('source-selector', 'loop', 'Choose a question, then find the source span that would answer it.'),
      success: OK('experiment-saved', 'A Lab project was saved carrying a question and the evidence for it.', { type: 'lab-project-saved', projectKind: 'experiment' }, 'A good question names something you could observe. "Is it fast?" is not one; "how many face frames are drawn during a wave?" is.'),
      concepts: ['firmware', 'state'],
    }),
    S({
      id: 'say-what-kind-of-evidence', kind: 'explain', detail: 'outline',
      title: 'Say what kind of evidence you have',
      b12: 'Every answer in this lab is one of four things: it is in the source, it is in a library, the emulator did it, or the lab worked it out. Say which one yours is.',
      claim: C('An answer without a stated kind of evidence is not finished. This project keeps four kinds apart on purpose, and a learner who can name which one they have is doing the thing the curriculum is for.',
        MODULE.get('build-your-own-experiment').conceptualReason,
        [doc('docs/findings/L3-source-annotations.md', 'Section 4'), doc('docs/plan.md', 'Standing constraint - no physical hardware, ever')]),
      manipulate: M('trace-inspector', 'any', 'Attach the evidence to your experiment and label its kind.'),
      success: OK('evidence-labelled', 'A saved experiment carries a labelled kind of evidence.', { type: 'lab-project-saved', projectKind: 'experiment-with-evidence' }, 'If the answer came from a trace row, its badge already tells you the kind.'),
      concepts: ['emulator', 'firmware'],
    }),
  ],
  challenges: [],
});

// --------------------------------------------------------------------------
// 8. Derivation — everything below this line is computed, not authored
// --------------------------------------------------------------------------
const byId = new Map();
for (const l of LESSONS) {
  if (byId.has(l.id)) die(`duplicate lesson id "${l.id}"`);
  byId.set(l.id, l);
}
{
  // Every one of L3's 19 curriculum modules is claimed exactly once.
  const refs = LESSONS.map((l) => l.curriculumRef ?? l.id);
  const seen = new Set();
  for (const r of refs) {
    if (!MODULE.has(r)) die(`lesson curriculumRef "${r}" is not a module in source-annotations.json`);
    if (seen.has(r)) die(`two lessons claim curriculum module "${r}"`);
    seen.add(r);
  }
  const missing = SA.curriculum.map((m) => m.id).filter((id) => !seen.has(id));
  if (missing.length) die(`curriculum modules with no lesson: ${missing.join(', ')}`);
}

const lessonsOut = LESSONS.map((l, li) => {
  const curriculumRef = l.curriculumRef ?? l.id;
  const mod = MODULE.get(curriculumRef);

  for (const p of l.prerequisites) if (!byId.has(p)) die(`lesson "${l.id}" requires "${p}", which is not a lesson`);

  const steps = l.steps.map((s, si) => ({ ...s, order: si + 1 }));
  if (!steps.length) die(`lesson "${l.id}" has no steps`);

  const union = (pick) => {
    const out = [];
    for (const s of steps) for (const v of pick(s)) if (!out.includes(v)) out.push(v);
    return out;
  };
  const symbols = union((s) => s.links.symbols).sort();
  const concepts = union((s) => s.links.concepts).sort();
  const teachingNotes = union((s) => s.links.teachingNotes).sort();
  const hardwareMap = union((s) => s.links.hardwareMap).sort();
  const robotParts = JOINT_ORDER.filter((j) => steps.some((s) => s.links.robotParts.includes(j)));
  const traceLayers = TRACE_LAYERS.map((t) => t.id).filter((t) => steps.some((s) => s.links.traceLayers.includes(t)));

  const challenges = (l.challenges ?? []).map((c, ci) => {
    if (!CONCEPT.has(c.coreConcept)) die(`challenge "${c.id}" names concept "${c.coreConcept}", which does not exist`);
    if (!steps.some((s) => s.success?.id === c.unlockedBy)) die(`challenge "${c.id}" is unlocked by "${c.unlockedBy}", which is not a success condition in lesson "${l.id}"`);
    return { ...c, order: ci + 1 };
  });

  return {
    id: l.id,
    order: li + 1,
    curriculumRef,
    supersedes: l.supersedes ?? null,
    title: l.title,
    module: mod.module,
    mainExperience: mod.mainExperience,
    realSesameConcept: mod.realSesameConcept,
    status: l.status,
    grounding: mod.grounding,
    groundingNote: mod.groundingNote,
    conceptualReason: mod.conceptualReason,
    learningGoal: l.learningGoal,
    willBeAbleTo: l.willBeAbleTo,
    prerequisites: l.prerequisites,
    unlocks: [],
    estimatedMinutes: l.estimatedMinutes,
    labHandoff: l.labHandoff ?? null,
    openQuestions: l.openQuestions ?? [],
    links: { symbols, concepts, teachingNotes, robotParts, traceLayers, hardwareMap },
    steps,
    challenges,
  };
});

// unlocks is the inverse of prerequisites, in curriculum order.
for (const l of lessonsOut) {
  l.unlocks = lessonsOut.filter((o) => o.prerequisites.includes(l.id)).map((o) => o.id);
}

// --------------------------------------------------------------------------
// 9. Coverage
// --------------------------------------------------------------------------
const allSteps = lessonsOut.flatMap((l) => l.steps);
const claims = allSteps.map((s) => s.claim);
const usedNotes = new Set(lessonsOut.flatMap((l) => l.links.teachingNotes));
const usedConcepts = new Set(lessonsOut.flatMap((l) => l.links.concepts));
const usedSymbols = new Set(lessonsOut.flatMap((l) => l.links.symbols));
const tally = (arr, key) => Object.fromEntries(Object.entries(arr.reduce((a, v) => { const k = key(v); a[k] = (a[k] ?? 0) + 1; return a; }, {})).sort());

const coverage = {
  lessons: {
    total: lessonsOut.length,
    polished: lessonsOut.filter((l) => l.status === 'polished').length,
    outline: lessonsOut.filter((l) => l.status === 'outline').length,
    factual: lessonsOut.filter((l) => l.grounding === 'factual').length,
    conceptual: lessonsOut.filter((l) => l.grounding === 'conceptual').length,
    conceptualLessons: lessonsOut.filter((l) => l.grounding === 'conceptual').map((l) => l.id),
    factualWithBoundaryNote: lessonsOut.filter((l) => l.grounding === 'factual' && l.groundingNote).map((l) => l.id),
    supersedingLessons: lessonsOut.filter((l) => l.supersedes).map((l) => ({ id: l.id, supersedes: l.supersedes })),
  },
  steps: {
    total: allSteps.length,
    full: allSteps.filter((s) => s.detail === 'full').length,
    outline: allSteps.filter((s) => s.detail === 'outline').length,
    byKind: tally(allSteps, (s) => s.kind),
    withManipulable: allSteps.filter((s) => s.manipulate !== null).length,
    withCauseAndEffect: allSteps.filter((s) => s.expect !== null).length,
    withSuccessCondition: allSteps.filter((s) => s.success !== null).length,
    withGoDeeper: allSteps.filter((s) => s.goDeeper !== null).length,
  },
  claims: {
    total: claims.length,
    byType: tally(claims, (c) => c.type),
    byDomain: tally(claims, (c) => c.domain),
    firmwareFactualWithSymbolCitation: claims.filter((c) => c.type === 'factual' && c.domain === 'firmware' && c.citations.some((x) => x.kind === 'symbol')).length,
  },
  checks: {
    distinctTypesUsed: [...new Set(allSteps.filter((s) => s.success).map((s) => s.success.check.type))].sort(),
    declaredTypes: CHECK_TYPES.length,
  },
  teachingNotes: {
    total: SA.teachingNotes.length,
    used: usedNotes.size,
    unused: SA.teachingNotes.map((n) => n.id).filter((id) => !usedNotes.has(id)),
    byLesson: Object.fromEntries(lessonsOut.filter((l) => l.links.teachingNotes.length).map((l) => [l.id, l.links.teachingNotes])),
  },
  concepts: { total: SA.concepts.length, used: usedConcepts.size, unused: SA.concepts.map((c) => c.id).filter((id) => !usedConcepts.has(id)) },
  symbols: { total: SA.symbols.length, cited: usedSymbols.size },
  robotParts: { order: JOINT_ORDER, orderSource: 'packages/sesame-model/src/joints.ts JOINT_ORDER, cross-checked against hardware-map.json servos.order' },
};

// --------------------------------------------------------------------------
// 10. Emit
// --------------------------------------------------------------------------
const dropUndefined = (v) => JSON.parse(JSON.stringify(v));

const docOut = dropUndefined({
  meta: {
    schemaVersion: '1.0.0',
    schema: './lessons.schema.json',
    task: 'L5 — lesson content as data (Phase 2)',
    generatedAt: GENERATED_AT,
    generatedBy: 'scripts/build-lessons.mjs',
    validateWith: 'node scripts/validate-lessons.mjs',
    upstreamCommit: SA.meta.upstreamCommit,
    sourceArtifacts: [
      { file: 'hardware/source-annotations.json', role: 'The grounding authority. Every symbolRef, conceptRef and teaching-note ref resolves here, and every lesson copies its grounding classification from curriculum[] rather than deciding one.' },
      { file: 'hardware/hardware-map.json', role: 'The entity authority. Movement choreography, routes, boot order, faces, pins and servoConfig are referenced by path and never restated.' },
      { file: 'packages/sesame-model/src/joints.ts', role: 'JOINT_ORDER. Every robotParts entry is one of these eight names, in this order.' },
      { file: 'reproducibility.json', role: 'Library version pins. A library citation carries the pinned version.' },
    ],
    learner: {
      profile: 'A technically curious learner of about twelve. An engineering lab with training wheels, not software for small children.',
      commitments: [
        'Short explanations immediately adjacent to something manipulable.',
        'A visible cause-and-effect loop after almost every action.',
        'Optional depth (goDeeper) rather than mandatory walls of text.',
        'Authentic Sesame code, pins, protocols and numbers.',
        'Meaningful choices aligned to the learning goal.',
        'Debugging framed as normal engineering, never as failure.',
        'Challenges unlocked by demonstrating a concept, never by a timer.',
      ],
      antiPatterns: [
        'No oversized cartoon buttons and no mascot narration.',
        'No fake currency, points, gems or streaks.',
        'No confetti for trivial clicks.',
        'No long forced walkthroughs: every step ends on a checkable observable, not on a Next button.',
      ],
      antiPatternEnforcement: 'scripts/validate-lessons.mjs screens all prose for mascot, currency and celebration vocabulary, caps beginner12 explanation length, requires cause-and-effect coverage, requires every debug step to carry failureIsNormal, and rejects any success condition that is not one of the declared observable checks. There is no time-based or acknowledgement-based check type in the vocabulary, so a timer gate cannot be expressed.',
    },
    gateF: 'Every lesson claiming "this is how Sesame actually works" must cite a pinned firmware symbol or source location; if it cannot, it is labelled conceptual. In this file that rule lives on step.claim. type=factual with domain=firmware REQUIRES at least one symbol citation resolving in source-annotations.json. domain=library, domain=emulator and domain=lab are the three honest boundaries and each requires its own citation kind plus a boundaryNote. type=conceptual requires a conceptualReason and may not use "actually works" framing. Lesson-level grounding is COPIED from source-annotations.json curriculum[] and the validator fails if it differs, so a lesson cannot promote itself to factual.',
    noHardwareClaims: 'Per docs/plan.md, "Standing constraint — no physical hardware, ever". No lesson in this file says a servo moved, a joint rotated or a pulse was observed. Angles are what the code COMMANDS. The pwm.output values here are recomputed from ESP32Servo 3.0.9 arithmetic and have never been observed at a pin: QEMU\'s LEDC model produces no waveform and there is no physical robot.',
    curriculumOrdering: 'Not the research report\'s table order. Reordered around Sesame\'s real architecture, and around the report\'s own correction that movement sequencing must be taught before inverse kinematics because the firmware is sequence-oriented. The twelve factual modules run first; the seven conceptual ones close the curriculum, where "here is how Sesame works today, how could we improve it?" is a question the learner can answer.',
    renodeDecision: 'The report\'s "Inside Renode" module is REWRITTEN as inside-qemu, not retired. Its subject — bus, memory, peripheral, time — is still worth teaching and the project has a working QEMU backend to teach it on; only the tool changed. The lesson keeps curriculumRef "inside-renode" so its grounding still resolves against source-annotations.json, carries supersedes: "inside-renode", and its final step tells the learner plainly that the original plan used Renode and why it was replaced.',
    consumers: [
      'The Phase 2 lesson runner (a later task): reads lessons[].steps[] in order, renders explanation at the learner\'s chosen level, binds manipulate.control, and evaluates success.check against robot/telemetry state.',
      'The source explorer: links[].symbols and every symbol citation carry file/startLine/endLine already resolved.',
      'The architecture graph and See-the-Signal: links[].concepts and links[].traceLayers are the cross-highlighting keys.',
      'Lab mode: labHandoff names what each lesson leaves behind as an editable project.',
    ],
  },
  vocabularies: {
    explanationLevels: EXPLANATION_LEVELS,
    stepKinds: STEP_KINDS,
    controlKinds: CONTROL_KINDS,
    claimDomains: CLAIM_DOMAINS,
    observability: OBSERVABILITY,
    citationKinds: [
      { id: 'symbol', description: 'A pinned firmware symbol in source-annotations.json. file/startLine/endLine are derived from it.' },
      { id: 'hardware-map', description: 'A resolvable path into hardware/hardware-map.json.' },
      { id: 'library', description: 'A pinned third-party library, cited as library + version + path-within-library + line, because the library tree is gitignored.' },
      { id: 'document', description: 'A findings or plan document in this repository, optionally with an evidence tag of RAN, SRC or INFER.' },
      { id: 'issue', description: 'A tracked defect id in docs/issues.yaml.' },
      { id: 'teaching-note', description: 'One of the teaching notes in source-annotations.json.' },
    ],
    traceLayers: TRACE_LAYERS,
    provenanceBadges: PROVENANCE_BADGES,
    checkTypes: CHECK_TYPES,
    faults: FAULTS,
    pwmModel: {
      note: 'Recomputed by scripts/build-lessons.mjs from ESP32Servo 3.0.9 arithmetic and cross-checked against hardware-map.json servos.servoConfig.pulseQuantisation. Never observed at a pin.',
      minPulseUs: PWM.minPulseUs,
      maxPulseUs: PWM.maxPulseUs,
      requestedMaxPulseUs: PWM.requestedMaxUs,
      frameUs: PWM.frameUs,
      timerWidthTicks: PWM.ticks,
      usPerTick,
      commandableAngles: SWEEP.length,
      distinctPulseValues: DISTINCT_TICKS.size,
      aliasedAngles: ALIASED,
      aliasPairUsedInLessons: ALIAS_PAIR,
    },
  },
  coverage,
  lessons: lessonsOut,
});

const text = `${JSON.stringify(docOut, null, 2)}\n`;

if (CHECK) {
  if (!existsSync(OUT)) { console.error(`FAIL  ${rel(OUT)} does not exist — run: node scripts/build-lessons.mjs`); process.exit(1); }
  const strip = (t) => { const o = JSON.parse(t); if (o.meta) delete o.meta.generatedAt; return JSON.stringify(o); };
  if (strip(readFileSync(OUT, 'utf8')) !== strip(text)) {
    console.error(`FAIL  ${rel(OUT)} is STALE — re-run: node scripts/build-lessons.mjs`);
    process.exit(1);
  }
  console.log(`OK    ${rel(OUT)} up to date (${lessonsOut.length} lessons, ${allSteps.length} steps)`);
} else {
  writeFileSync(OUT, text, 'utf8');
  console.log(`OK    ${rel(OUT)}`);
  console.log(`      ${lessonsOut.length} lessons (${coverage.lessons.polished} polished, ${coverage.lessons.outline} outline) · ${coverage.lessons.factual} factual / ${coverage.lessons.conceptual} conceptual`);
  console.log(`      ${allSteps.length} steps · ${coverage.steps.withSuccessCondition} success conditions · ${coverage.claims.total} claims (${JSON.stringify(coverage.claims.byDomain)})`);
  console.log(`      teaching notes used ${coverage.teachingNotes.used}/${coverage.teachingNotes.total}${coverage.teachingNotes.unused.length ? ` (unused: ${coverage.teachingNotes.unused.join(', ')})` : ''}`);
  console.log(`      concepts used ${coverage.concepts.used}/${coverage.concepts.total} · symbols cited ${coverage.symbols.cited}/${coverage.symbols.total}`);
}
