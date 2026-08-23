#!/usr/bin/env node
/**
 * R7 - render a real Sesame choreography into a timed `@SESAME` UART stream.
 *
 * The point of this script is that the Path-B replay demo shows the *actual*
 * robot's wave, not a hand-written approximation of one. `hardware/hardware-map.json`
 * (F4) carries all 21 movement functions as machine-readable step lists, each
 * step with `file:line` provenance back to `firmware/movement-sequences.h`, so
 * the fixture is derived from firmware source rather than invented here.
 *
 * What is modelled, and why it is faithful:
 *
 *   - `servo` steps become `@SESAME servo <joint> <deg>` - exactly what R6's
 *     hook 1 emits - followed by `motorCurrentDelay` ms, because setServoAngle()
 *     ALWAYS ends in delayWithFace(motorCurrentDelay). Subtrim defaults to 0 for
 *     all 8 channels and every angle in the map is already inside 0..180, so the
 *     post-clamp value the hook reports equals the requested angle.
 *   - `face` steps become `@SESAME face <name> 0` - what R6's hook 2 emits when
 *     setFace() renders frame 0 - but only when the name actually changes,
 *     because setFace() early-returns on an unchanged name
 *     (sesame-firmware-main.ino:904).
 *   - `log` steps become bare, non-sentinel lines, because in firmware they are
 *     plain `Serial.println(F("WAVE"))`. The parser turns them into `log` events
 *     on channel `uart`, which is exactly the interleaving the real UART has.
 *   - `call` recurses, `repeat` repeats, `conditional` is evaluated against the
 *     call's arguments, `delay` and `interruptCheck` advance the clock.
 *
 * What is NOT modelled, stated so nobody mistakes the fixture for a recording:
 *
 *   - Inter-frame face animation. updateAnimatedFace() fires from inside
 *     delayWithFace() at the face's fps and would emit further `face` lines.
 *     Reproducing that needs wall-clock timing we do not have, and guessing it
 *     would make the fixture look like a recording when it is a rendering.
 *   - The OLED framebuffer. R6 ships that hook disabled by default.
 *   - Any timing jitter. Every duration here is the firmware's nominal value.
 *
 * Usage:
 *   node scripts/build-replay-fixture.mjs                 # runWavePose -> default path
 *   node scripts/build-replay-fixture.mjs runDancePose -o out.jsonl
 *   node scripts/build-replay-fixture.mjs --check         # regenerate and diff
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MAP = path.join(REPO, 'hardware', 'hardware-map.json');

const argv = process.argv.slice(2);
const CHECK = argv.includes('--check');
const fn = argv.find((a) => !a.startsWith('-')) ?? 'runWavePose';
const outFlag = argv.indexOf('-o');
const OUT = outFlag >= 0
  ? path.resolve(argv[outFlag + 1])
  : path.join(REPO, 'emulator', 'bridge', 'fixtures', `${kebab(fn)}.replay.jsonl`);

function kebab(name) {
  return name.replace(/^run/, '').replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase();
}

const hwmap = JSON.parse(fs.readFileSync(MAP, 'utf8'));
const byName = new Map(hwmap.movements.map((m) => [m.function, m]));
if (!byName.has(fn)) {
  console.error(`unknown movement '${fn}'. Known: ${[...byName.keys()].join(', ')}`);
  process.exit(2);
}

const MOTOR_DELAY_MS = hwmap.servos.servoConfig.motorCurrentDelay.defaultMs;
const SUBTRIM = hwmap.servos.servoConfig.subtrim.defaults;
const JOINT_ORDER = hwmap.servos.order;

/** The one clamp every servo target passes through. sesame-firmware-main.ino:1053. */
const clamp = (deg, index) => Math.min(180, Math.max(0, deg + (SUBTRIM[index] ?? 0)));

/**
 * Callees that are real functions in firmware but emit nothing on UART0.
 * scheduleNextIdleBlink() only sets a millis() deadline
 * (sesame-firmware-main.ino:1005) - no servo, no face, no print.
 */
const SILENT_CALLEES = new Set(['scheduleNextIdleBlink']);

/**
 * Face name (lowercased - setFace() matches case-insensitively, :917) -> number
 * of DEFINED frames. Zero means the face renders nothing at all; see the `face`
 * case below.
 */
const FACE_FRAMES = new Map(hwmap.faces.faces.map((f) => [f.name.toLowerCase(), f.frameCount ?? 0]));

const out = [];
let tMs = 0;
/** setFace() early-returns when the requested name is already current (:904). */
let currentFace = 'default';

const push = (line, note) => out.push({ tMs, line, note });

function run(name, args, depth) {
  if (depth > 8) throw new Error(`recursion too deep at ${name}`);
  const m = byName.get(name);
  if (!m) throw new Error(`unknown movement function '${name}'`);
  const bound = { ...(m.defaultArgs ?? {}), ...(args ?? {}) };
  walk(m.steps, bound, depth, name);
}

function walk(steps, args, depth, owner) {
  for (const step of steps ?? []) {
    switch (step.type) {
      case 'log':
        // Plain Serial.println in firmware: no sentinel, so it arrives as a
        // `log` event on channel `uart` and proves passthrough ordering.
        push(step.text, `${owner}: Serial.println`);
        break;

      case 'face': {
        // setFace() early-returns on an unchanged name (:904).
        if (step.name === currentFace) break;

        // A face whose frame table is empty renders NOTHING. setFace() falls
        // back to face_defualt_frames, that table is empty too, and the final
        // `if (currentFaceFrameCount > 0)` guard at :931 means updateFaceBitmap()
        // - hook 2 - is never reached. So no telemetry line is emitted, and the
        // current face is left as "default".
        //
        // This is not a hypothetical: `stand`, `default` and `defualt` all have
        // frameCount 0 because epd_bitmap_stand and epd_bitmap_defualt are
        // declared `__attribute__((weak))` and never defined (face-bitmaps.h:52),
        // which F3 confirmed at binary level - `nm` finds no such symbols in the
        // linked ELF. runWavePose ends with runStandPose(1), so this rule is
        // exercised by the shipped fixture, not just guarded against.
        const frameCount = FACE_FRAMES.get(step.name.toLowerCase()) ?? 0;
        if (frameCount === 0) {
          currentFace = 'default';
          break;
        }

        currentFace = step.name;
        push(`@SESAME face ${step.name} 0`, `${owner}: setFace -> hook 2, frame 0`);
        break;
      }

      case 'servo': {
        const deg = clamp(step.angleDeg, step.index);
        if (JOINT_ORDER[step.index] !== step.joint) {
          throw new Error(`joint/index disagreement: ${step.joint} at index ${step.index}`);
        }
        push(`@SESAME servo ${step.joint} ${deg}`, `${owner}: setServoAngle -> hook 1`);
        tMs += MOTOR_DELAY_MS;      // setServoAngle always ends in delayWithFace()
        break;
      }

      case 'delay':
        tMs += step.ms;
        break;

      case 'interruptCheck':
        tMs += step.durationMsDefault ?? 0;
        break;

      case 'repeat': {
        const n = step.count ?? step.countDefault ?? 0;
        for (let i = 0; i < n; i++) walk(step.steps, args, depth, owner);
        break;
      }

      case 'conditional': {
        if (evalCondition(step.condition, args)) walk(step.steps, args, depth, owner);
        break;
      }

      case 'call':
        // Allowlisted rather than "skip anything not in the map": a callee that
        // silently produces no telemetry must be a deliberate decision, not an
        // accident of the map being incomplete.
        if (SILENT_CALLEES.has(step.function)) break;
        run(step.function, step.args, depth + 1);
        break;

      case 'clearCommandIf':
      case 'state':
        break;                       // no observable UART output

      default:
        throw new Error(`unhandled step type '${step.type}' in ${owner}`);
    }
  }
}

/** Only the forms the map actually contains; anything else is a hard error. */
function evalCondition(condition, args) {
  const m = /^(\w+)\s*==\s*(\d+)$/.exec(condition ?? '');
  if (!m) throw new Error(`unsupported condition '${condition}'`);
  return Number(args[m[1]]) === Number(m[2]);
}

// The instrumented firmware announces itself once, at the end of setup().
push('@SESAME hello 1 sesame-fw-s2mini/0.1.0', 'R6 boot banner');
run(fn, undefined, 0);

const header = {
  fixture: `${fn} rendered as an @SESAME UART stream`,
  generatedBy: 'scripts/build-replay-fixture.mjs',
  source: { file: 'hardware/hardware-map.json', movement: fn },
  firmwareSource: byName.get(fn).sourceRange,
  protocol: 'docs/protocol/sesame-telemetry-v1.md',
  motorCurrentDelayMs: MOTOR_DELAY_MS,
  notModelled: [
    'updateAnimatedFace() inter-frame emissions (wall-clock dependent)',
    'the OLED framebuffer hook (ships disabled)',
    'timing jitter (all durations are the firmware nominal values)',
  ],
  lines: out.length,
  durationMs: tMs,
};

const text = [JSON.stringify({ header }), ...out.map((o) => JSON.stringify(o))].join('\n') + '\n';

if (CHECK) {
  const existing = fs.existsSync(OUT) ? fs.readFileSync(OUT, 'utf8') : '';
  if (existing !== text) {
    console.error(`[fixture] ${path.relative(REPO, OUT)} is STALE - re-run scripts/build-replay-fixture.mjs`);
    process.exit(1);
  }
  console.log(`[fixture] ${path.relative(REPO, OUT)} up to date (${out.length} lines, ${tMs} ms)`);
} else {
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, text);
  console.log(`[fixture] ${path.relative(REPO, OUT)}  ${out.length} lines, ${tMs} ms of choreography`);
}
