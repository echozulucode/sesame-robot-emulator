/**
 * PHASE 14 — the honesty surfaces, asserted against the PACKAGED artefact.
 *
 * Phase 5 T5. Everything Phases 2-4 built about provenance has to survive
 * `tauri build`, and packaging is exactly where it would be quietly lost: a CSP
 * that strips something, a build flag, an asset that resolves in dev and not in
 * the bundle. A release build that dropped `PHYSICAL HARDWARE: NONE` would tell
 * a child an emulator is a robot.
 *
 * T4 read those surfaces out of the packaged window **once, by looking**. This
 * phase makes them fail the build if they regress. Nothing here is new
 * behaviour; all of it is assertion.
 *
 * ## The trap this is built around
 *
 * A plain `cargo build --release` has **no `custom-protocol` feature**, so the
 * binary serves `devUrl` and silently loads whatever is on `:5173`. T4 hit it
 * and said so:
 *
 * > *"anyone verifying a packaging property should check the CDP target URL
 * > says `tauri.localhost`."*
 *
 * So {@link packagedOriginProblem} is the first thing that runs, its verdict
 * gates every other assertion in the file, and {@link selfTestPackagedOriginGuard}
 * asserts on every run that the guard REJECTS a Vite origin. A guard that has
 * never refused anything is not known to be a guard.
 *
 * ## Why the verdicts are pure functions with a self-test table
 *
 * This project has shipped six assertions that could not fail: `querySelector
 * !== null` passing for a hidden button; L4's "it scrolled there" going
 * vacuous; W7's `clientHeight - scrollHeight` bounded the wrong way, repeated
 * by W8; `data-oled-zoom` claiming 2 while rendering 1.77x; and W6's contrast
 * maths reporting 4.21 for a run that was 1.66.
 *
 * The pattern they share is that the *arithmetic* was never shown a case it
 * should refuse. So every verdict here is a pure function over a reading, and
 * {@link selfTestVerdicts} runs each one against a GOOD fixture and a BAD one
 * on every run — the bad fixture is the regression the check exists to catch,
 * written down. If a verdict stops rejecting it, the phase fails before it ever
 * launches the app.
 *
 * Where the DOM can be mutated instead, it is: {@link NEGATIVE_CONTROLS} breaks
 * the real packaged window — truncates the environment line, injects the
 * desktop-simulator line, flattens a badge's contrast, shrinks a control,
 * shrinks type, strips a focus ring — and requires the corresponding scan to
 * report the defect before it is undone. Those are the checks proved against
 * the artefact rather than against a fixture.
 *
 * ## What it does not do
 *
 * It does not build anything. An artefact is a prerequisite, and when there is
 * none the phase reports `ran: false` with the command that produces one — it
 * is never silently skipped, and it never reports success without having driven
 * a window.
 */

import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';

import {
  CONTRAST_JS,
  CONTRAST_TEXT,
  CORRECTNESS_JS,
  ENUM_FOCUSABLE_JS,
  FOCUS_STATE_JS,
  OVERFLOW_JS,
  POINTER_ONLY_JS,
  PROVENANCE_JS,
  TARGETS_JS,
  TARGET_FINE_PX,
  TARGET_WCAG_FLOOR_PX,
  TEXT_FLOOR_PX,
  TYPE_SCAN_JS,
} from './honesty-probes.mjs';
import { attachToDebugPort } from './cdp.mjs';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ===========================================================================
// THE GUARD — is this a packaged window at all?
// ===========================================================================

/**
 * The origin a Tauri v2 window serves its embedded assets from on Windows.
 *
 * Not a prefix, not a substring: the whole hostname. `tauri.localhost.evil` and
 * `http://tauri.localhost:5173/` both contain it and neither is it.
 */
export const PACKAGED_ORIGIN_HOST = 'tauri.localhost';

/**
 * `null` when `url` is a packaged window's own origin; otherwise the reason it
 * is not, in the words the reader of a failing run needs.
 *
 * The case this exists for is the one T4 hit: a binary without the
 * `custom-protocol` feature serves `devUrl`, the window looks identical, and
 * every "packaging" assertion made against it is actually an assertion about a
 * Vite dev server that may be running yesterday's code.
 */
export function packagedOriginProblem(url) {
  if (typeof url !== 'string' || url.length === 0) {
    return `the CDP target reported no URL (${JSON.stringify(url)}), so nothing is known about what the window is serving`;
  }
  if (url === 'about:blank') {
    return 'the CDP target is still about:blank — the webview had not navigated when it was read, and every reading below would describe an empty document';
  }
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return `the CDP target URL ${JSON.stringify(url)} does not parse as a URL`;
  }
  if (parsed.hostname !== PACKAGED_ORIGIN_HOST) {
    const dev =
      parsed.port !== '' ||
      ['localhost', '127.0.0.1', '[::1]', '::1'].includes(parsed.hostname);
    return (
      `the CDP target is ${JSON.stringify(url)}, not http://${PACKAGED_ORIGIN_HOST}/. ` +
      (dev
        ? 'That is a DEV SERVER, so this run would be verifying Vite rather than the package. ' +
          'A plain `cargo build --release` has no `custom-protocol` feature and falls back to ' +
          "`devUrl` — build with `pnpm exec tauri build` (`just tauri-build`). "
        : '') +
      'Every assertion below is about what the shipped executable serves, and it is not serving this.'
    );
  }
  if (parsed.port !== '') {
    return `the CDP target is ${JSON.stringify(url)}: the host is right but a port is set, which the asset protocol never does. Something else is answering on that name.`;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return `the CDP target is ${JSON.stringify(url)}, whose scheme is ${parsed.protocol}`;
  }
  return null;
}

/**
 * The guard, shown the things it must refuse — every run.
 *
 * `http://127.0.0.1:5173/` is in this table because it is not hypothetical: it
 * is the exact URL a `cargo build --release` window reports, and it was
 * reproduced against a real Vite instance while this was written (see
 * `docs/findings/T5-packaged-honesty.md` §3).
 */
export const PACKAGED_ORIGIN_SELF_TEST = [
  { url: 'http://tauri.localhost/', accept: true },
  { url: 'http://tauri.localhost/index.html', accept: true },
  { url: 'https://tauri.localhost/', accept: true },
  { url: 'http://127.0.0.1:5173/', accept: false },
  { url: 'http://localhost:5173/', accept: false },
  { url: 'http://localhost:5173/index.html', accept: false },
  { url: 'http://tauri.localhost:5173/', accept: false },
  { url: 'http://tauri.localhost.example.com/', accept: false },
  { url: 'about:blank', accept: false },
  { url: '', accept: false },
  { url: 'file:///C:/x/index.html', accept: false },
];

export function selfTestPackagedOriginGuard() {
  const problems = [];
  for (const { url, accept } of PACKAGED_ORIGIN_SELF_TEST) {
    const verdict = packagedOriginProblem(url);
    if (accept && verdict !== null) {
      problems.push(
        `the packaged-origin guard REFUSED ${JSON.stringify(url)}, which is a packaged window: ${verdict}`,
      );
    }
    if (!accept && verdict === null) {
      problems.push(
        `the packaged-origin guard ACCEPTED ${JSON.stringify(url)}. That is the whole trap: a run ` +
          `pointed at a dev server would report the package as honest without ever loading it.`,
      );
    }
  }
  return problems;
}

// ===========================================================================
// THE VERDICTS — pure, so each can be shown a case it must refuse
// ===========================================================================

/** `SYSTEM: QEMU EMULATOR · PHYSICAL HARDWARE: NONE`, whole and unclipped. */
export const ENVIRONMENT_LINE_EMULATOR = 'SYSTEM: QEMU EMULATOR · PHYSICAL HARDWARE: NONE';
/** The same line when the reader has switched the packaged app to the sim. */
export const ENVIRONMENT_LINE_HOST_MODEL = 'SYSTEM: HOST MODEL · PHYSICAL HARDWARE: NONE';

/**
 * The environment line: present, exact, and not cut off.
 *
 * `expected` is passed in rather than assumed, because the packaged app can be
 * switched to the behavioural simulator and the line legitimately changes — the
 * thing that may not change is `PHYSICAL HARDWARE: NONE`, and that is checked
 * independently of which system is named.
 */
export function environmentLineProblems(reading, expected) {
  const problems = [];
  if (reading === null || reading === undefined) {
    return ['[data-testid="status-environment"] is not in the packaged window at all'];
  }
  const text = String(reading.text ?? '').replace(/\s+/g, ' ').trim();
  if (text !== expected) {
    problems.push(
      `the packaged window's environment line reads ${JSON.stringify(text)}; it must read ` +
        `${JSON.stringify(expected)}. This is the sentence that stops a child reading an emulator ` +
        `as a robot, and packaging is where it would be lost.`,
    );
  }
  if (!text.includes('PHYSICAL HARDWARE: NONE')) {
    problems.push(
      `the packaged window's environment line does not carry "PHYSICAL HARDWARE: NONE": ` +
        `${JSON.stringify(text)}`,
    );
  }
  if (reading.visible !== true) {
    problems.push('the environment line is in the DOM of the packaged window but is not laid out');
  }
  if (reading.ellipsised === true || reading.clamped === true || reading.cut === true) {
    problems.push(
      `the environment line is TRUNCATED in the packaged window ` +
        `(ellipsis=${String(reading.ellipsised)} line-clamp=${String(reading.clamped)} ` +
        `scrollWidth ${reading.scrollWidth} > clientWidth ${reading.clientWidth}). W3's rule is ` +
        `that it may not be, and a half-shown claim is worse than none.`,
    );
  }
  return problems;
}

/**
 * `isPhysicallyObserved()` false for EVERY event — the count, never a sample.
 *
 * Three conjuncts, and the third is what stops the zero being vacuous. A store
 * that had stopped attributing events would report `physicallyObservedEvents:
 * 0` for a perfectly bad reason, so the reading also has to show that every
 * event it counted WAS attributed to the emulator boundary.
 */
export function physicalHardwareProblems(reading, { minEvents = 1 } = {}) {
  const problems = [];
  if (reading === null || reading === undefined) {
    return ['the packaged window reported no origin counts at all'];
  }
  const total = Number(reading.totalEvents);
  const physical = Number(reading.physicallyObservedEvents);
  const counts = reading.counts ?? {};
  if (!(total >= minEvents)) {
    problems.push(
      `the packaged window counted ${JSON.stringify(reading.totalEvents)} telemetry events; at ` +
        `least ${minEvents} were expected, and "0 physically observed out of 0" is not a claim ` +
        `about anything`,
    );
  }
  if (physical !== 0) {
    problems.push(
      `${physical} of ${total} events in the packaged window satisfied isPhysicallyObserved(). ` +
        `No physical Sesame exists; that predicate is the one thing standing between an emulator ` +
        `and a measurement.`,
    );
  }
  const attributed = Object.values(counts).reduce((sum, n) => sum + Number(n), 0);
  if (total >= minEvents && attributed !== total) {
    problems.push(
      `the packaged window counted ${total} events but attributed ${attributed} of them to an ` +
        `origin (${JSON.stringify(counts)}). An unattributed event is one the zero above does not ` +
        `cover.`,
    );
  }
  if (total >= minEvents && Number(counts['physical-robot'] ?? 0) !== 0) {
    problems.push(
      `${counts['physical-robot']} event(s) in the packaged window claim a PHYSICAL ROBOT boundary: ` +
        JSON.stringify(counts),
    );
  }
  return problems;
}

/**
 * The origin is Rust's measurement joined to the path-derived record — never
 * asserted by the app.
 *
 * `measuredEngine` is read here by running the BUNDLED `qemu-system-xtensa.exe`
 * with `--version`, which is the same thing Rust does with the same file. The
 * derived record is a compile-time constant of a different shape
 * (`qemu-system-xtensa/9.2.2-esp_develop_…`), so if the frontend were asserting
 * the engine rather than reading it, `engine` would equal the constant and this
 * refuses it by name.
 */
export function originProvenanceProblems(facts, { measuredEngine, derivedEngine }) {
  const problems = [];
  if (facts === null || facts === undefined) {
    return ['the packaged window reported no emulator facts'];
  }
  const origin = facts.origin ?? {};
  if (origin.kind !== 'emulator') {
    problems.push(`the packaged window's origin kind is ${JSON.stringify(origin.kind)}, expected "emulator"`);
  }
  if (String(origin.engine ?? '') !== measuredEngine) {
    problems.push(
      `the packaged window reports engine ${JSON.stringify(origin.engine)}; the BUNDLED ` +
        `qemu-system-xtensa.exe answers ${JSON.stringify(measuredEngine)} to --version. The engine ` +
        `must be a fact about the process Rust spawned, not a value the app supplied.`,
    );
  }
  if (String(origin.engine ?? '') === derivedEngine) {
    problems.push(
      `the packaged window reports engine ${JSON.stringify(origin.engine)}, which is exactly the ` +
        `frontend's compile-time QEMU_RELEASE constant. That is the app asserting its own origin — ` +
        `V7 chose the backend-stamped origin precisely so it could not.`,
    );
  }
  if (facts.board !== 'distro-v1-esp32') {
    problems.push(
      `the packaged window names board ${JSON.stringify(facts.board)}. It runs the LEGACY V1 board ` +
        `and saying anything else would let it pass for the board this project recommends.`,
    );
  }
  if (facts.mode !== 'qemu') {
    problems.push(`RobotState.mode in the packaged window is ${JSON.stringify(facts.mode)}`);
  }
  /*
    The OTHER half of the origin: the frozen record `originForImage()` derives
    from the image PATH, which is what the engine measurement is joined to.
    Rust reports the image it opened and the derivation supplies the limits; an
    origin with a measured engine and an empty record would be a machine
    identity with nothing said about what it does not model, which is the half
    that makes the claim honest rather than merely specific.
  */
  if (!Array.isArray(facts.elided) || facts.elided.length === 0) {
    problems.push(
      `the packaged window's origin lists ${JSON.stringify(facts.elided)} as the subsystems the ` +
        `emulator does not model. The path-derived record names nine; an empty list is an ` +
        `emulator claiming to model everything.`,
    );
  }
  if (!Array.isArray(facts.firmwareDeviations) || facts.firmwareDeviations.length === 0) {
    problems.push(
      `the packaged window's origin lists no firmware deviations. The image it boots is not stock ` +
        `firmware, and the record that says how it differs is part of the origin rather than a ` +
        `footnote.`,
    );
  }
  for (const board of ['s2mini', 'distro-v3-s3']) {
    if (typeof facts.unsupportedBoards?.[board] !== 'string') {
      problems.push(
        `the packaged window does not explain why ${board} cannot be emulated. The S2 Mini is the ` +
          `board this project RECOMMENDS; a learner must not conclude they are watching their own ` +
          `hardware.`,
      );
    }
  }
  return problems;
}

/**
 * The board, named in words a reader meets — *"the legacy V1 board. Not the S2
 * Mini"* — rather than only as an id in an object.
 */
export function boardNamingProblems(text) {
  const problems = [];
  const flat = String(text ?? '').replace(/\s+/g, ' ');
  if (!/distro-v1-esp32/i.test(flat)) {
    problems.push(`the packaged window does not render the board id: ${JSON.stringify(flat.slice(0, 160))}`);
  }
  if (!/legacy V1 board/i.test(flat)) {
    problems.push(
      `the packaged window does not call distro-v1-esp32 the LEGACY V1 BOARD: ` +
        `${JSON.stringify(flat.slice(0, 200))}`,
    );
  }
  if (!/not the S2 ?Mini/i.test(flat)) {
    problems.push(
      `the packaged window does not say the emulated board is NOT THE S2 MINI. The S2 Mini is the ` +
        `board in this project's own pin diagram, and the sentence exists so a reader cannot ` +
        `conclude the emulator is running the board they built: ${JSON.stringify(flat.slice(0, 200))}`,
    );
  }
  return problems;
}

/**
 * The OLED is `observed` only where the CAPABILITY says so, and the wording
 * still carries the qualifier that keeps it from being a claim about glass.
 *
 * The hook reads `getBuffer()` inside `updateFaceBitmap()`, BEFORE
 * `display.display()` pushes it over I2C at a chip that is not attached. That
 * distinction is the whole difference between "the firmware drew this" and "a
 * panel showed this", and it is exactly the sentence a packaging step could
 * drop without anything looking wrong.
 */
export function oledProblems(oled, facts, detailText) {
  const problems = [];
  if (oled === null || oled === undefined || facts === null || facts === undefined) {
    return ['the packaged window reported no OLED state or no emulator facts'];
  }
  const elided = Array.isArray(facts.elided) ? facts.elided : [];
  const bufferElided = elided.includes('ssd1306-panel');
  const glassElided = elided.includes('ssd1306-glass');
  if (bufferElided === glassElided) {
    problems.push(
      `the packaged window's elided list names ${JSON.stringify(elided.filter((e) => e.startsWith('ssd1306')))}. ` +
        `Exactly one of ssd1306-panel and ssd1306-glass belongs there.`,
    );
  }
  if (facts.oledFramebuffer !== !bufferElided) {
    problems.push(
      `the packaged window declares oledFramebuffer=${String(facts.oledFramebuffer)} while ` +
        `ssd1306-panel is ${bufferElided ? '' : 'not '}in its elided list; those are two statements ` +
        `of one fact`,
    );
  }
  const state = oled.pixels?.state;
  if (facts.oledFramebuffer === true) {
    if (state !== 'observed') {
      problems.push(
        `the emulator in the packaged window declares oledFramebuffer=true and the pane derived ` +
          `${JSON.stringify(state)} rather than "observed"`,
      );
    }
    if (oled.pixels?.fromEmulator !== true) {
      problems.push('the packaged window shows observed OLED pixels that do not claim to come from the emulator');
    }
  } else if (state === 'observed') {
    problems.push(
      `the packaged window calls the OLED pixels "observed" while the emulator declares ` +
        `oledFramebuffer=false. That is the claim the capability record exists to forbid.`,
    );
  }
  if (state === 'observed') {
    const flat = String(detailText ?? '').replace(/\s+/g, ' ');
    if (!/getBuffer\(\)/.test(flat)) {
      problems.push(
        `the packaged window's observed-pixel explanation does not name getBuffer(): ` +
          `${JSON.stringify(flat.slice(0, 200))}`,
      );
    }
    if (!/display\.display\(\)/.test(flat)) {
      problems.push(
        `the packaged window's observed-pixel explanation does not say the buffer was read BEFORE ` +
          `display.display() pushed it. Without that the pane is claiming pixels reached a panel, ` +
          `which nothing has confirmed: ${JSON.stringify(flat.slice(0, 200))}`,
      );
    }
    if (!/not a measurement/i.test(flat)) {
      problems.push(
        `the packaged window's observed-pixel explanation stopped saying an emulated framebuffer is ` +
          `not a measurement: ${JSON.stringify(flat.slice(0, 240))}`,
      );
    }
  }
  return problems;
}

/** `pwm.output` is INFERRED under real firmware too, and no row claims physical. */
export function traceProblems(trace) {
  const problems = [];
  if (trace === null || trace === undefined) return ['the packaged window produced no causal trace'];
  const rows = Array.isArray(trace.rows) ? trace.rows : [];
  const pwm = rows.find((r) => r.layer === 'pwm.output');
  if (pwm === undefined) {
    problems.push('the packaged window\'s trace has no pwm.output row at all');
  } else {
    if (pwm.provenance !== 'inferred' || pwm.badge !== 'INFERRED FOR EXPLANATION') {
      problems.push(
        `pwm.output in the packaged window reads ${JSON.stringify(pwm.provenance)} / ` +
          `${JSON.stringify(pwm.badge)}. It must stay INFERRED FOR EXPLANATION: QEMU's LEDC model ` +
          `stores duty and produces no pulse, no edge and no waveform (Q3 §2-§3), so there is ` +
          `nothing to observe even though the firmware really ran.`,
      );
    }
    if (pwm.physicallyObserved === true) {
      problems.push('pwm.output in the packaged window claims physical observation');
    }
  }
  const servo = rows.find((r) => r.layer === 'servo.target');
  if (servo === undefined) {
    problems.push('the packaged window\'s trace never saw a servo.target row');
  } else if (servo.badge !== 'OBSERVED FROM EMULATOR') {
    problems.push(
      `servo.target in the packaged window shows ${JSON.stringify(servo.badge)}, expected ` +
        `"OBSERVED FROM EMULATOR" — the strongest claim anything in this project may make`,
    );
  }
  const claiming = rows.filter((r) => r.physicallyObserved === true || /ON HARDWARE/.test(String(r.badge)));
  if (claiming.length > 0) {
    problems.push(
      `${claiming.length} trace row(s) in the packaged window claim physical observation: ` +
        JSON.stringify(claiming.map((r) => r.layer)),
    );
  }
  return problems;
}

/**
 * Every verdict above, shown a good reading and the regression it exists to
 * catch — on every run, before the window is launched.
 *
 * The bad fixtures are not invented failures. Each one is the shape the
 * corresponding surface would take if packaging dropped it: the environment
 * line ellipsised, one event slipping through `isPhysicallyObserved()`, the
 * engine coming from the frontend's own constant, the board renamed to the
 * recommended one, `observed` pixels with no framebuffer, `pwm.output`
 * promoted.
 */
export function selfTestVerdicts() {
  const problems = [];
  const mustPass = (what, verdicts) => {
    if (verdicts.length > 0) {
      problems.push(`the ${what} verdict rejected a GOOD reading: ${verdicts.join(' | ')}`);
    }
  };
  const mustFail = (what, verdicts) => {
    if (verdicts.length === 0) {
      problems.push(
        `the ${what} verdict ACCEPTED the regression it exists to catch. An assertion that cannot ` +
          `fail is not an assertion.`,
      );
    }
  };

  const goodEnv = {
    text: ENVIRONMENT_LINE_EMULATOR,
    visible: true,
    ellipsised: false,
    clamped: false,
    cut: false,
    scrollWidth: 300,
    clientWidth: 300,
  };
  mustPass('environment-line', environmentLineProblems(goodEnv, ENVIRONMENT_LINE_EMULATOR));
  mustFail('environment-line (missing)', environmentLineProblems(null, ENVIRONMENT_LINE_EMULATOR));
  mustFail(
    'environment-line (truncated)',
    environmentLineProblems({ ...goodEnv, ellipsised: true, cut: true, scrollWidth: 460 }, ENVIRONMENT_LINE_EMULATOR),
  );
  mustFail(
    'environment-line (hardware claimed)',
    environmentLineProblems(
      { ...goodEnv, text: 'SYSTEM: QEMU EMULATOR · PHYSICAL HARDWARE: 3 OBSERVED EVENTS' },
      ENVIRONMENT_LINE_EMULATOR,
    ),
  );
  mustFail(
    'environment-line (not laid out)',
    environmentLineProblems({ ...goodEnv, visible: false }, ENVIRONMENT_LINE_EMULATOR),
  );

  const goodCounts = { totalEvents: 40, physicallyObservedEvents: 0, counts: { emulator: 40 } };
  mustPass('physical-hardware', physicalHardwareProblems(goodCounts, { minEvents: 20 }));
  mustFail(
    'physical-hardware (one event slipped through)',
    physicalHardwareProblems({ ...goodCounts, physicallyObservedEvents: 1 }, { minEvents: 20 }),
  );
  mustFail(
    'physical-hardware (nothing happened)',
    physicalHardwareProblems({ totalEvents: 0, physicallyObservedEvents: 0, counts: {} }, { minEvents: 20 }),
  );
  mustFail(
    'physical-hardware (events not attributed)',
    physicalHardwareProblems({ ...goodCounts, counts: { emulator: 12 } }, { minEvents: 20 }),
  );
  mustFail(
    'physical-hardware (a physical-robot boundary)',
    physicalHardwareProblems(
      { totalEvents: 40, physicallyObservedEvents: 0, counts: { emulator: 39, 'physical-robot': 1 } },
      { minEvents: 20 },
    ),
  );

  const MEASURED = 'QEMU emulator version 9.2.2 (esp_develop_9.2.2_20260417)';
  const DERIVED = 'qemu-system-xtensa/9.2.2-esp_develop_9.2.2_20260417';
  const goodFacts = {
    origin: { kind: 'emulator', engine: MEASURED, board: 'distro-v1-esp32' },
    board: 'distro-v1-esp32',
    mode: 'qemu',
    elided: ['wifi-mac', 'ssd1306-glass', 'ledc-waveform'],
    firmwareDeviations: ['the OLED framebuffer hook is not in stock firmware'],
    unsupportedBoards: { s2mini: 'no ESP32-S2 machine', 'distro-v3-s3': 'no ESP32-S3 machine' },
  };
  const engines = { measuredEngine: MEASURED, derivedEngine: DERIVED };
  mustPass('origin-provenance', originProvenanceProblems(goodFacts, engines));
  mustFail(
    'origin-provenance (engine asserted by the app)',
    originProvenanceProblems({ ...goodFacts, origin: { ...goodFacts.origin, engine: DERIVED } }, engines),
  );
  mustFail(
    'origin-provenance (board renamed to the recommended one)',
    originProvenanceProblems({ ...goodFacts, board: 's2mini' }, engines),
  );
  mustFail(
    'origin-provenance (unsupported boards dropped)',
    originProvenanceProblems({ ...goodFacts, unsupportedBoards: {} }, engines),
  );
  mustFail(
    'origin-provenance (origin kind upgraded)',
    originProvenanceProblems({ ...goodFacts, origin: { ...goodFacts.origin, kind: 'hardware' } }, engines),
  );
  mustFail(
    'origin-provenance (the elided list emptied)',
    originProvenanceProblems({ ...goodFacts, elided: [] }, engines),
  );
  mustFail(
    'origin-provenance (the firmware deviations dropped)',
    originProvenanceProblems({ ...goodFacts, firmwareDeviations: [] }, engines),
  );

  const GOOD_BOARD_TEXT =
    'distro-v1-esp32 — the legacy V1 board. Not the S2 Mini in this project’s pin diagram.';
  mustPass('board-naming', boardNamingProblems(GOOD_BOARD_TEXT));
  mustFail('board-naming (id only)', boardNamingProblems('distro-v1-esp32'));
  mustFail(
    'board-naming (the disclaimer dropped)',
    boardNamingProblems('distro-v1-esp32 — the legacy V1 board.'),
  );

  const goodOled = { pixels: { state: 'observed', fromEmulator: true } };
  const goodOledFacts = { oledFramebuffer: true, elided: ['ssd1306-glass', 'wifi-mac'] };
  const GOOD_OLED_TEXT =
    'the hook reads getBuffer() inside updateFaceBitmap(), BEFORE display.display() pushes it over ' +
    'I2C at a chip that is not attached. It is still not a measurement.';
  mustPass('oled', oledProblems(goodOled, goodOledFacts, GOOD_OLED_TEXT));
  mustFail(
    'oled (observed without the capability)',
    oledProblems(goodOled, { oledFramebuffer: false, elided: ['ssd1306-panel'] }, GOOD_OLED_TEXT),
  );
  mustFail(
    'oled (the getBuffer qualifier dropped)',
    oledProblems(goodOled, goodOledFacts, 'These pixels came from the emulator. It is still not a measurement.'),
  );
  mustFail(
    'oled (the display.display() qualifier dropped)',
    oledProblems(
      goodOled,
      goodOledFacts,
      'the hook reads getBuffer() inside updateFaceBitmap(). It is still not a measurement.',
    ),
  );
  mustFail(
    'oled (both names elided at once)',
    oledProblems(goodOled, { oledFramebuffer: true, elided: ['ssd1306-panel', 'ssd1306-glass'] }, GOOD_OLED_TEXT),
  );

  const goodTrace = {
    rows: [
      { layer: 'servo.target', provenance: 'observed', badge: 'OBSERVED FROM EMULATOR', physicallyObserved: false },
      { layer: 'pwm.output', provenance: 'inferred', badge: 'INFERRED FOR EXPLANATION', physicallyObserved: false },
    ],
  };
  mustPass('trace', traceProblems(goodTrace));
  mustFail(
    'trace (pwm.output promoted)',
    traceProblems({
      rows: [
        goodTrace.rows[0],
        { layer: 'pwm.output', provenance: 'observed', badge: 'OBSERVED FROM EMULATOR', physicallyObserved: false },
      ],
    }),
  );
  mustFail(
    'trace (a row claims hardware)',
    traceProblems({
      rows: [
        { ...goodTrace.rows[0], badge: 'OBSERVED ON HARDWARE', physicallyObserved: true },
        goodTrace.rows[1],
      ],
    }),
  );

  return problems;
}

// ===========================================================================
// page-side readings
// ===========================================================================

/**
 * The origin counters and the event total, in one round trip.
 *
 * `origin()` carries the counts and the physically-observed tally;
 * `provenance()` carries the total. The comparison between them is the whole
 * point — "0 physically observed" says nothing until it is 0 OUT OF something,
 * with every one of those events accounted for.
 */
const ORIGIN_COUNTS_JS = `(() => {
  const origin = window.__sesame.origin();
  const provenance = window.__sesame.provenance();
  return {
    driving: origin.driving,
    counts: origin.counts,
    physicallyObservedEvents: origin.physicallyObservedEvents,
    totalEvents: provenance.totalEvents,
  };
})()`;

/** The environment line, and whether anything cut it off. */
const ENVIRONMENT_LINE_JS = `(() => {
  const el = document.querySelector('[data-testid="status-environment"]');
  if (el === null) return null;
  const cs = getComputedStyle(el);
  const r = el.getBoundingClientRect();
  return {
    text: (el.textContent ?? '').replace(/\\s+/g, ' ').trim(),
    visible: cs.display !== 'none' && cs.visibility !== 'hidden' && r.width > 1 && r.height > 1,
    ellipsised: cs.textOverflow === 'ellipsis',
    clamped: cs.webkitLineClamp !== undefined && cs.webkitLineClamp !== '' && cs.webkitLineClamp !== 'none',
    cut: el.scrollWidth > el.clientWidth + 1 || el.scrollHeight > el.clientHeight + 1,
    scrollWidth: el.scrollWidth,
    clientWidth: el.clientWidth,
  };
})()`;

/**
 * The desktop-simulator line, read as a PRESENCE rather than as an absence.
 *
 * "`querySelector(...) !== null` passing for a hidden button" is one of the six
 * assertions this project has shipped that could not fail, and its mirror image
 * — asserting a node is absent — fails the same way the moment the testid is
 * renamed. So the reading also reports whether the CARD that would contain the
 * line is mounted, and {@link NEGATIVE_CONTROLS} injects a node with the same
 * testid and requires this probe to find it.
 */
const DESKTOP_SIMULATOR_JS = `(() => {
  const line = document.querySelector('[data-testid="panel-desktop-simulator"]');
  const card = document.querySelector('[data-testid="panel-trust"]');
  const laidOut = (el) => {
    if (el === null) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  };
  return {
    present: line !== null,
    visible: laidOut(line),
    text: line === null ? null : (line.textContent ?? '').replace(/\\s+/g, ' ').trim(),
    trustCardMounted: card !== null && laidOut(card),
    noLabHostPresent: document.querySelector('[data-testid="panel-no-lab-host"]') !== null,
  };
})()`;

/** The badge families that must survive packaging, counted where they render. */
const BADGE_CENSUS_JS = `(() => {
  const laidOut = (el) => {
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    return cs.display !== 'none' && cs.visibility !== 'hidden' && r.width > 0 && r.height > 0;
  };
  const count = (selector) => [...document.querySelectorAll(selector)].filter(laidOut).length;
  const textOf = (selector) => {
    const el = [...document.querySelectorAll(selector)].find(laidOut) ?? null;
    return el === null ? null : (el.textContent ?? '').replace(/\\s+/g, ' ').trim().slice(0, 120);
  };
  return {
    conceptualBadges: count('.badge.is-conceptual, [data-grounding="conceptual"]'),
    conceptualText: textOf('.badge.is-conceptual, [data-grounding="conceptual"]'),
    notBuiltBadges: count('.badge.is-notbuilt, [data-build-status="not-built"]'),
    notBuiltText: textOf('.badge.is-notbuilt, [data-build-status="not-built"]'),
    notBuiltPanels: count('.lesson-notbuilt, [data-testid="lesson-control-notbuilt"]'),
  };
})()`;

/**
 * Hash whatever the packaged window is actually serving, in the window.
 *
 * FNV-1a over the raw bytes rather than SHA-256, deliberately: `crypto.subtle`
 * needs a secure context and `http://tauri.localhost` is only *probably* one
 * depending on the embedder's opinion, and this comparison must not be the
 * thing that silently stops running. Collision resistance is irrelevant — the
 * question is whether the executable is serving the `apps/web/dist` on disk or
 * a build from before the change under test.
 */
const SERVED_ASSETS_JS = `(async () => {
  const fnv = (bytes) => {
    let h = 0x811c9dc5;
    for (let i = 0; i < bytes.length; i += 1) {
      h ^= bytes[i];
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    return h >>> 0;
  };
  const read = async (url) => {
    const response = await fetch(url, { cache: 'no-store' });
    if (!response.ok) return { url, ok: false, status: response.status };
    const bytes = new Uint8Array(await response.arrayBuffer());
    return { url, ok: true, bytes: bytes.length, sum: fnv(bytes) };
  };
  const index = await read('/index.html');
  /*
    Vite writes the refs RELATIVE — "./assets/index-BSgqlBYh.js" — so the first
    version of this filtered on a leading "/" and matched nothing. It reported
    "checked: 1" and looked fine, because index.html carries the content hash of
    every bundle in the filename and would have caught a rebuild anyway. It
    would NOT have caught a bundle that is the right name and the wrong bytes,
    which is the failure a packaging step can actually produce.
  */
  const here = new URL(document.baseURI);
  const refs = [...document.querySelectorAll('script[src], link[rel="stylesheet"][href]')]
    .map((el) => el.getAttribute('src') ?? el.getAttribute('href'))
    .filter((u) => typeof u === 'string' && u.length > 0)
    .map((u) => new URL(u, document.baseURI))
    .filter((u) => u.origin === here.origin)
    .map((u) => u.pathname);
  const assets = [];
  for (const ref of refs) assets.push(await read(ref));
  return { index, assets };
})()`;

// ===========================================================================
// the negative controls — break the real window, require the scan to notice
// ===========================================================================

/**
 * Each control mutates the PACKAGED window, requires the detector that guards
 * that surface to report a defect, and puts it back.
 *
 * These are the checks proved against the artefact rather than against a
 * fixture. `restore` runs even when the control fails, and the phase re-reads
 * the surface afterwards so a control that failed to clean up cannot be
 * mistaken for a regression in the app.
 */
export const NEGATIVE_CONTROLS = [
  {
    what: 'the environment line, truncated',
    why: 'W3 says the line may not be truncated; a check that never saw a clipped one is a check that reads a class name',
    mutate: `(() => {
      const el = document.querySelector('[data-testid="status-environment"]');
      if (el === null) return false;
      el.setAttribute('data-t5-saved-style', el.getAttribute('style') ?? '');
      el.setAttribute('style', 'display:block;max-width:24px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap');
      return true;
    })()`,
    detect: ENVIRONMENT_LINE_JS,
    fired: (reading) =>
      environmentLineProblems(reading, ENVIRONMENT_LINE_EMULATOR).some((p) => /TRUNCATED/.test(p)),
    restore: `(() => {
      const el = document.querySelector('[data-testid="status-environment"]');
      if (el === null) return false;
      const saved = el.getAttribute('data-t5-saved-style') ?? '';
      if (saved === '') el.removeAttribute('style'); else el.setAttribute('style', saved);
      el.removeAttribute('data-t5-saved-style');
      return true;
    })()`,
  },
  {
    what: 'the environment line, claiming hardware',
    /*
      A CLONE inserted before the real line, never the real line's own markup.

      The first version of this control set `innerHTML` and put the same string
      back afterwards. The text was right again and the element was DEAD: React
      holds references to the text nodes it created, and destroying them leaves
      a subtree that never updates. Everything downstream still passed, and then
      the packaged app was asked to switch to the simulator and its environment
      line went on reading QEMU EMULATOR — a bug in the harness that looked
      exactly like a bug in the product, which is the worst thing a negative
      control can do. Every other control here mutates only the `style`
      attribute, which React does not manage on these elements.
    */
    why: 'the exact-text check must fail on the one substitution that matters, not merely on a missing element',
    mutate: `(() => {
      const el = document.querySelector('[data-testid="status-environment"]');
      if (el === null || el.parentElement === null) return false;
      const clone = el.cloneNode(false);
      clone.setAttribute('data-t5-env-clone', 'true');
      clone.textContent = 'SYSTEM: SESAME ROBOT · PHYSICAL HARDWARE: 12 OBSERVED EVENTS';
      el.parentElement.insertBefore(clone, el);
      return document.querySelector('[data-testid="status-environment"]') === clone;
    })()`,
    detect: ENVIRONMENT_LINE_JS,
    fired: (reading) => environmentLineProblems(reading, ENVIRONMENT_LINE_EMULATOR).length > 0,
    restore: `(() => {
      const clone = document.querySelector('[data-t5-env-clone="true"]');
      if (clone !== null) clone.remove();
      return true;
    })()`,
  },
  {
    what: 'the desktop-simulator line, present',
    why: 'asserting a node is ABSENT passes just as happily when the testid has been renamed away',
    mutate: `(() => {
      const card = document.querySelector('[data-testid="panel-trust"] [data-pane-content]')
        ?? document.querySelector('[data-testid="panel-trust"]');
      if (card === null) return false;
      const p = document.createElement('p');
      p.className = 'warn-inline panel-desktop-simulator';
      p.setAttribute('data-testid', 'panel-desktop-simulator');
      p.setAttribute('data-t5-injected', 'true');
      p.textContent = 'injected by the T5 negative control';
      card.appendChild(p);
      return true;
    })()`,
    detect: DESKTOP_SIMULATOR_JS,
    fired: (reading) => reading.present === true && reading.visible === true,
    restore: `(() => {
      const p = document.querySelector('[data-t5-injected="true"]');
      if (p !== null) p.remove();
      return true;
    })()`,
  },
  {
    what: 'a provenance badge at 1:1 contrast',
    why: 'W6\'s contrast arithmetic once reported 4.21:1 for a run that was 1.66:1; it has to be shown a run it must refuse',
    mutate: `(() => {
      const el = document.querySelector('[data-testid="panel-provenance"] .prov')
        ?? document.querySelector('.prov');
      if (el === null) return false;
      el.setAttribute('data-t5-saved-style', el.getAttribute('style') ?? '');
      const bg = getComputedStyle(el).backgroundColor;
      el.setAttribute('style', 'color:' + (bg === 'rgba(0, 0, 0, 0)' ? '#0d1015' : bg) + ';background-color:' + (bg === 'rgba(0, 0, 0, 0)' ? '#0d1015' : bg));
      return true;
    })()`,
    detect: CONTRAST_JS,
    fired: (reading) => Array.isArray(reading.failures) && reading.failures.length > 0,
    restore: `(() => {
      const el = document.querySelector('[data-t5-saved-style]');
      if (el === null) return false;
      const saved = el.getAttribute('data-t5-saved-style') ?? '';
      if (saved === '') el.removeAttribute('style'); else el.setAttribute('style', saved);
      el.removeAttribute('data-t5-saved-style');
      return true;
    })()`,
  },
  {
    what: 'a control shrunk below the WCAG floor',
    why: 'the target scan hit-tests rather than measuring a rect, and a hit test that never missed proves nothing',
    mutate: `(() => {
      const el = document.querySelector('[data-command]') ?? document.querySelector('button');
      if (el === null) return false;
      el.setAttribute('data-t5-saved-style', el.getAttribute('style') ?? '');
      el.setAttribute('style', 'width:8px;height:8px;min-width:8px;min-height:8px;padding:0;overflow:hidden');
      return true;
    })()`,
    detect: TARGETS_JS(TARGET_FINE_PX),
    fired: (reading) => reading.underWcag.length > 0 || reading.unhittable.length > 0,
    restore: `(() => {
      const el = document.querySelector('[data-t5-saved-style]');
      if (el === null) return false;
      const saved = el.getAttribute('data-t5-saved-style') ?? '';
      if (saved === '') el.removeAttribute('style'); else el.setAttribute('style', saved);
      el.removeAttribute('data-t5-saved-style');
      return true;
    })()`,
  },
  {
    what: 'text below the 14 px floor',
    why: 'the W1 floor is the one invariant a packaged CSS bundle could lower without anything else changing',
    mutate: `(() => {
      const el = document.querySelector('[data-testid="status-environment"]');
      if (el === null) return false;
      el.setAttribute('data-t5-saved-style', el.getAttribute('style') ?? '');
      el.setAttribute('style', 'font-size:9px');
      return true;
    })()`,
    detect: TYPE_SCAN_JS,
    fired: (reading) => reading.below.length > 0,
    restore: `(() => {
      const el = document.querySelector('[data-t5-saved-style]');
      if (el === null) return false;
      const saved = el.getAttribute('data-t5-saved-style') ?? '';
      if (saved === '') el.removeAttribute('style'); else el.setAttribute('style', saved);
      el.removeAttribute('data-t5-saved-style');
      return true;
    })()`,
  },
  {
    what: 'a focused control with its ring removed',
    why: ':focus-visible is a modality heuristic, and "has an outline" is exactly the sort of claim this project has been caught making',
    mutate: `(() => {
      const el = document.querySelector('[data-command]') ?? document.querySelector('button');
      if (el === null) return false;
      el.setAttribute('data-t5-saved-style', el.getAttribute('style') ?? '');
      el.setAttribute('style', 'outline:none !important;box-shadow:none !important');
      el.focus();
      return true;
    })()`,
    detect: FOCUS_STATE_JS,
    fired: (reading) => reading !== null && reading.hasRing === false,
    restore: `(() => {
      const el = document.querySelector('[data-t5-saved-style]');
      if (el === null) return false;
      const saved = el.getAttribute('data-t5-saved-style') ?? '';
      if (saved === '') el.removeAttribute('style'); else el.setAttribute('style', saved);
      el.removeAttribute('data-t5-saved-style');
      el.blur();
      return true;
    })()`,
  },
];

// ===========================================================================
// process helpers
// ===========================================================================

const freePort = () =>
  new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });

const portIsListening = (port) =>
  new Promise((resolve) => {
    const socket = net.connect({ port, host: '127.0.0.1' });
    const done = (answer) => {
      socket.destroy();
      resolve(answer);
    };
    socket.on('connect', () => done(true));
    socket.on('error', () => done(false));
    setTimeout(() => done(false), 700);
  });

/** `tasklist`, not the harness's own bookkeeping — T3's rule. */
export function processCount(image) {
  try {
    const out = execFileSync('tasklist', ['/FI', `IMAGENAME eq ${image}`, '/NH'], {
      encoding: 'utf8',
      windowsHide: true,
    });
    return out.split(/\r?\n/).filter((line) => line.toLowerCase().includes(image.toLowerCase())).length;
  } catch {
    return 0;
  }
}

const fnv1a = (buffer) => {
  let h = 0x811c9dc5;
  for (let i = 0; i < buffer.length; i += 1) {
    h ^= buffer[i];
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
};

// ===========================================================================
// the phase
// ===========================================================================

/**
 * Run phase 14 and return what belongs in the harness's report.
 *
 * `ctx.check(condition, message)` is the harness's own recorder, so a failure
 * here fails the same run and prints in the same list. Nothing in this file
 * calls `process.exit`.
 */
export async function runPackagedHonestyPhase(ctx) {
  const {
    repo,
    check,
    note,
    log = console.log,
    shoot = null,
    exePath = null,
    skip = false,
  } = ctx;

  const record = { ran: false, reason: null };

  if (skip) {
    record.reason = '--skip-packaged';
    log('[web] phase 14 SKIPPED: --skip-packaged');
    return record;
  }

  // ------------------------------------------------------- the artefact
  const exe = exePath ?? path.join(repo, 'src-tauri/target/release/sesame-lab-desktop.exe');
  const bundleDir = path.join(repo, 'src-tauri/target/release/bundle');
  if (!fs.existsSync(exe)) {
    record.reason =
      `no packaged artefact at ${path.relative(repo, exe).replaceAll('\\', '/')}. ` +
      `Build one with \`just tauri-build\` (\`pnpm exec tauri build\`). A plain ` +
      `\`cargo build --release\` will NOT do: without the custom-protocol feature the window ` +
      `serves devUrl, and this phase would be measuring a Vite dev server.`;
    record.command = 'just tauri-build';
    log(`[web] phase 14 SKIPPED — ${record.reason}`);
    note(`the packaged honesty phase did not run: ${record.reason}`);
    return record;
  }

  log('[web] phase 14: the honesty surfaces, in the PACKAGED window');
  const before = ctx.problemCount();

  /*
    Reported, never asserted.

    Installers sitting next to the executable are a HINT that `tauri build` ran
    here, and only a hint: they say nothing about whether this exe is the one it
    produced. The `tauri.localhost` guard is what actually settles that, and
    treating the bundle directory as evidence would be exactly the kind of proxy
    that passes while the real property fails.
  */
  record.bundleDirs = fs.existsSync(bundleDir)
    ? fs.readdirSync(bundleDir).sort()
    : [];

  // ------------------------------- the guard, and the verdicts, before anything
  //
  // Both run before the app is launched. If the arithmetic below cannot refuse
  // a bad reading, nothing it says about a good one is worth reading.
  const guardSelfTest = selfTestPackagedOriginGuard();
  for (const problem of guardSelfTest) check(false, `phase 14: ${problem}`);
  const verdictSelfTest = selfTestVerdicts();
  for (const problem of verdictSelfTest) check(false, `phase 14: ${problem}`);
  log(
    `[web] phase 14 self-test: the origin guard refused ` +
      `${PACKAGED_ORIGIN_SELF_TEST.filter((c) => !c.accept).length} non-packaged origins and ` +
      `accepted ${PACKAGED_ORIGIN_SELF_TEST.filter((c) => c.accept).length}; every verdict rejected ` +
      `the regression it exists to catch`,
  );
  record.selfTest = {
    originGuardCases: PACKAGED_ORIGIN_SELF_TEST.length,
    originGuardProblems: guardSelfTest.length,
    verdictProblems: verdictSelfTest.length,
  };

  // A dev server on :5173 is not fatal — but if the window turns out to be on
  // it, the guard's message should not be the first the reader hears of it.
  const viteUp = await portIsListening(5173);
  record.devServerOn5173 = viteUp;
  if (viteUp) {
    note(
      'phase 14: something is listening on :5173 while the packaged window was checked. That is ' +
        'exactly what a non-packaged binary would have loaded, and the tauri.localhost guard is ' +
        'what separates the two.',
    );
  }

  // -------------------------------------- what the bundled QEMU says it is
  //
  // Rust runs `--version` on the file it is about to spawn. This runs it on the
  // same file, from outside the app, so the engine string in the window can be
  // compared against a measurement rather than against another copy of a table.
  let measuredEngine = null;
  let bundledQemu = null;
  try {
    const reportPath = path.join(repo, 'src-tauri/target/release/.t5-resource-report.json');
    execFileSync(exe, ['--resource-report', reportPath], { windowsHide: true, timeout: 60000 });
    const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
    fs.rmSync(reportPath, { force: true });
    record.resourceReport = { ok: report.ok, total: report.total, present: report.present, bytes: report.bytes };
    check(
      report.ok === true,
      `phase 14: the packaged executable reports ${report.present}/${report.total} bundled resources present`,
    );
    bundledQemu = report.entries.find((e) => e.target === 'qemu/bin/qemu-system-xtensa.exe')?.path ?? null;
    if (bundledQemu !== null) {
      measuredEngine = execFileSync(bundledQemu, ['--version'], { encoding: 'utf8', windowsHide: true })
        .split(/\r?\n/)[0]
        .trim();
    }
  } catch (error) {
    check(false, `phase 14: could not read the packaged artefact's own resource report: ${String(error.message ?? error)}`);
  }
  check(
    typeof measuredEngine === 'string' && measuredEngine.length > 0,
    'phase 14: the bundled qemu-system-xtensa.exe did not answer --version, so the engine string ' +
      'in the window could only have been compared against another copy of the frontend table',
  );
  record.measuredEngine = measuredEngine;
  record.bundledQemu = bundledQemu === null ? null : path.relative(repo, bundledQemu).replaceAll('\\', '/');

  const derivedEngine = (() => {
    try {
      const source = fs.readFileSync(path.join(repo, 'packages/sesame-qemu/src/capabilities.ts'), 'utf8');
      const release = /QEMU_RELEASE = '([^']+)'/.exec(source)?.[1] ?? null;
      const template = /engine: `qemu-system-xtensa\/([^`$]+)\$\{QEMU_RELEASE\}`/.exec(source)?.[1] ?? null;
      return release === null || template === null ? null : `qemu-system-xtensa/${template}${release}`;
    } catch {
      return null;
    }
  })();
  record.derivedEngine = derivedEngine;
  check(
    derivedEngine !== null,
    'phase 14: could not read the frontend\'s derived engine constant out of ' +
      'packages/sesame-qemu/src/capabilities.ts, so "the app did not assert this" is unproven',
  );

  // --------------------------------------------------------- launch it
  const cdpPort = await freePort();
  const proc = spawn(exe, [], {
    env: { ...process.env, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${cdpPort}` },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: false,
  });
  let stderr = '';
  proc.stderr.on('data', (d) => (stderr += d.toString()));
  record.pid = proc.pid;

  const closeApp = async () => {
    try {
      execFileSync(
        'powershell.exe',
        ['-NoLogo', '-NoProfile', '-Command', `$p = Get-Process -Id ${proc.pid} -ErrorAction SilentlyContinue; if ($p) { $null = $p.CloseMainWindow() }`],
        { windowsHide: true, timeout: 20000 },
      );
    } catch {
      /* it may already be gone */
    }
    for (let i = 0; i < 60 && proc.exitCode === null && proc.signalCode === null; i += 1) await sleep(250);
    try {
      proc.kill();
    } catch {
      /* gone */
    }
    await sleep(1500);
  };

  let session = null;
  try {
    session = await attachToDebugPort({ port: cdpPort, timeoutMs: 60000 });
  } catch (error) {
    check(false, `phase 14: the packaged window never exposed a CDP page target: ${String(error.message ?? error)}\n${stderr}`);
    await closeApp();
    record.ran = false;
    record.reason = 'the packaged window never exposed a CDP page target';
    return record;
  }

  const { evaluate, cdp, target } = session;
  record.cdpTarget = target.url;

  // ================================================================ THE GUARD
  const originVerdict = packagedOriginProblem(target.url);
  check(originVerdict === null, `phase 14: ${originVerdict ?? ''}`);
  log(`[web] phase 14 CDP target: ${target.url}`);
  if (originVerdict !== null) {
    // Nothing below would be about the package. Stop rather than produce a
    // green report for the wrong document.
    session.close();
    await closeApp();
    record.ran = false;
    record.reason = originVerdict;
    record.survivorsAfterClose = {
      qemu: processCount('qemu-system-xtensa.exe'),
      desktop: processCount('sesame-lab-desktop.exe'),
    };
    return record;
  }
  record.ran = true;

  const shootPackaged =
    shoot === null
      ? async () => null
      : async (name, caption) => {
          const png = await cdp('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
          return shoot(name, caption, Buffer.from(png.data, 'base64'));
        };

  const waitFor = async (expression, predicate, what, timeoutMs = 30000) => {
    const deadline = Date.now() + timeoutMs;
    let last;
    while (Date.now() < deadline) {
      try {
        last = await evaluate(expression);
        if (predicate(last)) return last;
      } catch {
        /* the app may still be mounting */
      }
      await sleep(120);
    }
    check(false, `phase 14: timed out waiting for ${what}. Last value: ${JSON.stringify(last)?.slice(0, 400)}`);
    return last;
  };

  try {
    await waitFor(
      'typeof window.__sesame !== "undefined" && window.__sesame.ready === true',
      (v) => v === true,
      'the app to mount inside the packaged window',
      90000,
    );

    // It is the desktop shell, and it says so through the global the app
    // branches on rather than through a user-agent string.
    const shell = await evaluate(
      `({ tauri: '__TAURI__' in window, internals: '__TAURI_INTERNALS__' in window, href: location.href })`,
    );
    check(
      shell.tauri === true || shell.internals === true,
      `phase 14: neither __TAURI__ nor __TAURI_INTERNALS__ is present in the packaged window ` +
        `(${JSON.stringify(shell)}); detectDesktopShell() would have returned present:false and the ` +
        `app would have opened on the browser default`,
    );
    record.shell = shell;

    // ------------------------------------ is it serving THIS apps/web/dist?
    //
    // A packaged binary embeds the frontend at build time. Verifying a
    // packaging property against an executable built before the change under
    // test is the same class of mistake as verifying it against Vite, and it is
    // quieter — the window looks right, because it once was.
    const served = await evaluate(SERVED_ASSETS_JS);
    const compare = (entry) => {
      const rel = decodeURIComponent(new URL(entry.url, 'http://tauri.localhost/').pathname).replace(/^\//, '');
      const onDisk = path.join(repo, 'apps/web/dist', rel);
      if (!entry.ok) return `${rel}: the packaged window answered HTTP ${entry.status} for its own asset`;
      if (!fs.existsSync(onDisk)) return `${rel}: served by the package, absent from apps/web/dist`;
      const buffer = fs.readFileSync(onDisk);
      if (buffer.length !== entry.bytes || fnv1a(buffer) !== entry.sum) {
        return (
          `${rel}: the packaged window serves ${entry.bytes} B (fnv ${entry.sum}) and ` +
          `apps/web/dist holds ${buffer.length} B (fnv ${fnv1a(buffer)}). The executable was built ` +
          `from a different frontend than the one in the tree, so every assertion below would be ` +
          `about an older app. Rebuild with \`just tauri-build\`.`
        );
      }
      return null;
    };
    const assetProblems = [served.index, ...served.assets].map(compare).filter((p) => p !== null);
    for (const problem of assetProblems) check(false, `phase 14: ${problem}`);
    // The count, because the first version of the ref filter matched NOTHING and
    // reported a clean `checked: 1`. A comparison that ran over one file it
    // happened to name explicitly is not a comparison of what the app serves.
    check(
      served.assets.length >= 2,
      `phase 14: the packaged window's index.html referenced ${served.assets.length} same-origin ` +
        `script/stylesheet(s). The app is one ES module and one stylesheet at minimum; a smaller ` +
        `number means the freshness comparison skipped the bundles rather than cleared them.`,
    );
    record.servedAssets = {
      checked: 1 + served.assets.length,
      matchesDist: assetProblems.length === 0,
      files: [served.index, ...served.assets].map((a) => a.url),
    };
    // The comparison has to be able to say no. One byte, on a copy.
    {
      const indexOnDisk = fs.readFileSync(path.join(repo, 'apps/web/dist/index.html'));
      const tampered = Buffer.from(indexOnDisk);
      tampered[Math.floor(tampered.length / 2)] ^= 0x01;
      check(
        fnv1a(tampered) !== fnv1a(indexOnDisk),
        'phase 14: the served-asset comparison did not notice a one-byte change, so "the package ' +
          'serves this dist" was never a measurement',
      );
    }

    // ================================================= the packaged surfaces
    const backendId = await evaluate('window.__sesame.backendId()');
    check(
      backendId === 'qemu',
      `phase 14: the packaged window opened on backend ${JSON.stringify(backendId)} rather than the ` +
        `bundled emulator`,
    );

    const connected = await waitFor(
      'window.__sesame.status()',
      (v) => v !== null && v.connection === 'connected',
      'the bundled QEMU to boot inside the packaged app',
      180000,
    );
    log(
      `[web] phase 14: the bundled emulator booted after ${connected?.attempts} attempt(s), ` +
        `${connected?.elapsedMs} ms`,
    );
    check(
      typeof connected?.attempts === 'number' && connected.attempts >= 1,
      `phase 14: the packaged window did not surface a boot attempt count ` +
        `(${JSON.stringify(connected?.attempts)}); ISSUE-20260823-022 retries roughly a quarter of ` +
        `cold boots and a silent multi-second freeze reads as a hang`,
    );
    record.boot = { attempts: connected?.attempts ?? null, elapsedMs: connected?.elapsedMs ?? null };

    // --------------------------------------------- the environment line, idle
    const envIdle = await evaluate(ENVIRONMENT_LINE_JS);
    for (const problem of environmentLineProblems(envIdle, ENVIRONMENT_LINE_EMULATOR)) {
      check(false, `phase 14 (before any command): ${problem}`);
    }
    record.environmentLine = envIdle?.text ?? null;

    // ---------------------------------------------------- the origin, and Rust
    const facts = await evaluate('window.__sesame.emulatorFacts()');
    for (const problem of originProvenanceProblems(facts, { measuredEngine, derivedEngine })) {
      check(false, `phase 14: ${problem}`);
    }
    record.origin = {
      kind: facts?.origin?.kind ?? null,
      engine: facts?.origin?.engine ?? null,
      board: facts?.board ?? null,
      elided: facts?.elided ?? null,
      oledFramebuffer: facts?.oledFramebuffer ?? null,
    };

    // ----------------------------------- the board, in words, on the screen
    const openTrustScreen = () =>
      evaluate(`(() => {
        const dialog = document.querySelector('[data-popover="trust"]');
        if (dialog !== null && dialog.open) return true;
        document.querySelector('[data-panel-more="trust"]')?.click();
        return true;
      })()`);
    await openTrustScreen();
    await sleep(500);
    const rendered = await evaluate(`JSON.stringify({
      emulator: document.querySelector('[data-testid="emulator"]')?.innerText ?? '',
      verdict: document.querySelector('#measurement-verdict')?.innerText ?? '',
      originBanner: document.querySelector('#origin-banner')?.innerText ?? '',
      unsupported: document.querySelector('[data-testid="unsupported-boards"]')?.innerText ?? '',
      notAMeasurement: document.querySelector('[data-testid="not-a-measurement"]')?.innerText ?? '',
    })`);
    const renderedIdle = JSON.parse(rendered);
    await evaluate(`document.querySelector('[data-popover-close="trust"]')?.click()`);
    await sleep(350);
    for (const problem of boardNamingProblems(renderedIdle.emulator)) {
      check(false, `phase 14: ${problem}`);
    }
    check(
      /s2mini/i.test(renderedIdle.unsupported),
      'phase 14: the packaged window does not tell the reader that the recommended DIY board cannot ' +
        'be emulated',
    );
    check(
      /isPhysicallyObserved/.test(renderedIdle.notAMeasurement),
      'phase 14: the packaged window does not name the predicate that separates emulated from ' +
        'measured, before a single joint has moved',
    );
    record.boardText = String(renderedIdle.emulator).replace(/\s+/g, ' ').trim().slice(0, 220);

    // ------------------------------- the desktop-simulator line, ABSENT here
    const simLineIdle = await evaluate(DESKTOP_SIMULATOR_JS);
    check(
      simLineIdle.trustCardMounted === true,
      'phase 14: the trust card is not mounted in the packaged window, so "the desktop-simulator ' +
        'line is absent" would be a statement about a card that is not there either',
    );
    check(
      simLineIdle.present === false,
      `phase 14: the packaged window renders the desktop-simulator line — ` +
        `${JSON.stringify(simLineIdle.text)} — while the bundled emulator is driving. That line ` +
        `says the build has no emulator, and it does.`,
    );
    /*
      ABSENT because the state is false, not because the branch was deleted.

      This is the mirror of the six assertions that could not fail. `absent`
      passes just as happily when the testid has been renamed, the component
      removed, or the branch dropped by a bundler — and unlike every other
      surface here, no reachable state of THIS artefact renders the line (§6),
      so nothing else would notice. Two things are checked instead: the probe
      can see such a node when one exists (the negative control injects one),
      and the branch is still in the JavaScript the executable serves.
    */
    const simLineInBundle = await evaluate(`(async () => {
      const refs = [...document.querySelectorAll('script[src]')]
        .map((el) => new URL(el.getAttribute('src'), document.baseURI))
        .filter((u) => u.origin === new URL(document.baseURI).origin);
      let testid = 0;
      let sentence = 0;
      for (const ref of refs) {
        const text = await (await fetch(ref.pathname, { cache: 'no-store' })).text();
        if (text.includes('panel-desktop-simulator')) testid += 1;
        if (text.includes('This desktop build has no emulator yet')) sentence += 1;
      }
      return { bundles: refs.length, testid, sentence };
    })()`);
    check(
      simLineInBundle.testid > 0 && simLineInBundle.sentence > 0,
      `phase 14: the JavaScript the packaged executable serves contains the ` +
        `panel-desktop-simulator testid in ${simLineInBundle.testid} bundle(s) and its sentence in ` +
        `${simLineInBundle.sentence}. The line is absent from the DOM because the emulator is ` +
        `driving; if it were absent from the BUNDLE, "absent" would mean the branch had been ` +
        `deleted and this check would have gone on passing.`,
    );
    record.desktopSimulatorLine = {
      presentInDom: simLineIdle.present,
      inBundle: simLineInBundle,
    };
    check(
      simLineIdle.noLabHostPresent === false,
      'phase 14: the packaged window says there is no lab host on this origin. There is no origin ' +
        'to have one on, and the emulator is a Rust command — that advice is unactionable in a ' +
        'packaged .exe',
    );

    await shootPackaged(
      't5-packaged-idle.png',
      'the PACKAGED desktop app (http://tauri.localhost/, embedded assets, bundled QEMU) with real firmware booted and idle: SYSTEM: QEMU EMULATOR · PHYSICAL HARDWARE: NONE, the legacy V1 board named as not the S2 Mini, and no desktop-simulator line because the emulator is driving',
    );

    // ==================================================== NEGATIVE CONTROLS
    //
    // Break the packaged window, require the scan to notice, put it back.
    const controls = [];
    for (const control of NEGATIVE_CONTROLS) {
      let mutated = false;
      let fired = null;
      let reading = null;
      try {
        mutated = (await evaluate(control.mutate)) === true;
        if (mutated) {
          await sleep(160);
          reading = await evaluate(control.detect);
          fired = control.fired(reading);
        }
      } catch (error) {
        fired = `threw: ${String(error.message ?? error)}`;
      } finally {
        try {
          await evaluate(control.restore);
        } catch {
          /* reported below by the re-read */
        }
        await sleep(160);
      }
      check(
        mutated === true,
        `phase 14 negative control "${control.what}": could not be set up in the packaged window, so ` +
          `the check it guards is unproven here`,
      );
      check(
        fired === true,
        `phase 14 negative control "${control.what}": the check did NOT report a defect (${JSON.stringify(fired)}). ` +
          `${control.why}.`,
      );
      controls.push({ what: control.what, mutated, fired: fired === true });
    }
    record.negativeControls = controls;
    log(
      `[web] phase 14: ${controls.filter((c) => c.fired).length}/${controls.length} checks proved by ` +
        `breaking the packaged window first`,
    );

    // The mutations are undone; if any were not, everything after this would
    // blame the app for the harness's mess.
    const envRestored = await evaluate(ENVIRONMENT_LINE_JS);
    for (const problem of environmentLineProblems(envRestored, ENVIRONMENT_LINE_EMULATOR)) {
      check(false, `phase 14 (after the negative controls were undone): ${problem}`);
    }
    const simRestored = await evaluate(DESKTOP_SIMULATOR_JS);
    check(
      simRestored.present === false,
      'phase 14: the injected desktop-simulator node was not removed after its negative control',
    );

    // =========================================================== the command
    //
    // A real button in the packaged window, hit-tested — `HTMLElement.click()`
    // fires on a hidden element too, and a check that a hidden button "works"
    // is a check that proves nothing.
    /*
      The scene BEFORE the click, so "the packaged window moved the robot" is a
      difference rather than a still frame.

      The cli-oled image boots idle on purpose, so nothing should be commanded
      yet; if anything were, the post-click reading would not be attributable to
      the click.
    */
    const restJoints = await evaluate('window.__sesame.sceneJoints()');
    const preCommanded = restJoints.filter((j) => j.storeCommandedDeg !== null);
    check(
      preCommanded.length === 0,
      `phase 14: ${preCommanded.length} joint(s) were already commanded in the packaged window ` +
        `before anything was pressed (${preCommanded.map((j) => j.joint).join(', ')}), so the ` +
        `post-click reading would not be attributable to the click`,
    );

    await evaluate(`window.__sesame.setSection('commands', true)`);
    await sleep(450);
    const clicked = await evaluate(`(() => {
      const button = document.querySelector('[data-command="wave"]');
      if (button === null) return { ok: false, why: 'no [data-command="wave"] button in the packaged window' };
      if (button.disabled) return { ok: false, why: 'the wave button is disabled' };
      const rect = button.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) return { ok: false, why: 'the wave button has no laid-out box' };
      const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
      if (hit === null || !(hit === button || button.contains(hit)))
        return { ok: false, why: 'something is covering the wave button: ' + (hit?.className ?? 'nothing') };
      button.click();
      return { ok: true };
    })()`);
    check(clicked.ok === true, `phase 14: could not click wave in the packaged window: ${clicked.why}`);

    const start = await evaluate('window.__sesame.renderStats()');
    await waitFor(
      'window.__sesame.renderStats()',
      (v) => v !== null && v.storePoseVersion > (start?.storePoseVersion ?? 0) + 8,
      'servo telemetry to come back out of the firmware the packaged window commanded',
      90000,
    );
    await waitFor(
      'window.__sesame.renderStats()',
      (v) => v !== null && v.appliedPoseVersion === v.storePoseVersion,
      'the render loop in the packaged window to apply the firmware’s telemetry',
      60000,
    );

    // ------------------------------------ the survivor check, proved BOTH ways
    //
    // T3's invariant is "no orphan after close". A count taken only after the
    // window is gone cannot tell "the teardown worked" from "nothing ever
    // started", so the emulator is counted here, while it is demonstrably
    // running and has just executed a command.
    const qemuWhileRunning = processCount('qemu-system-xtensa.exe');
    check(
      qemuWhileRunning >= 1,
      `phase 14: tasklist sees ${qemuWhileRunning} qemu-system-xtensa.exe while the packaged window ` +
        `is driving real firmware. The survivor check after close would then be measuring nothing.`,
    );

    // ------------------------------------------- the eight joints, attributed
    const joints = await evaluate('window.__sesame.sceneJoints()');
    /*
      THREE.Object3D.quaternion, not a screenshot and not the store.

      React can be perfectly correct while three.js renders nothing, and a
      packaged build that mounted the DOM and never drove the scene graph would
      pass every text assertion in this file. The delta is read off the scene.
    */
    const sceneDelta = (() => {
      let worst = 0;
      for (const after of joints) {
        const before = restJoints.find((j) => j.joint === after.joint);
        if (before === undefined) continue;
        for (let i = 0; i < 4; i += 1) {
          worst = Math.max(worst, Math.abs(after.quaternion[i] - before.quaternion[i]));
        }
      }
      return worst;
    })();
    check(
      sceneDelta > 1e-3,
      `phase 14: pressing wave in the packaged window changed nothing in the three.js scene graph ` +
        `(worst quaternion component delta ${sceneDelta.toExponential(3)}). The firmware answered, ` +
        `and the robot a reader is looking at did not move.`,
    );
    record.sceneQuaternionDelta = sceneDelta;
    const driven = joints.filter((j) => j.storeCommandedDeg !== null);
    check(
      driven.length === 8,
      `phase 14: only ${driven.length}/8 joints were driven by the wave the packaged window commanded`,
    );
    let physicalJoints = 0;
    for (const joint of driven) {
      check(
        joint.storeProvenance === 'observed',
        `phase 14: ${joint.joint} was last written by a ${joint.storeProvenance} event in the packaged window`,
      );
      check(
        joint.storeOriginKind === 'emulator',
        `phase 14: ${joint.joint} carries origin.kind ${JSON.stringify(joint.storeOriginKind)} in the packaged window`,
      );
      if (joint.storePhysicallyObserved !== false) physicalJoints += 1;
    }
    check(
      physicalJoints === 0,
      `phase 14: ${physicalJoints} joint(s) in the packaged window report isPhysicallyObserved() true`,
    );

    // --------------------------- isPhysicallyObserved(), counted not sampled
    const origins = await evaluate(ORIGIN_COUNTS_JS);
    for (const problem of physicalHardwareProblems(origins, { minEvents: 20 })) {
      check(false, `phase 14: ${problem}`);
    }
    record.origins = {
      totalEvents: origins?.totalEvents ?? null,
      physicallyObservedEvents: origins?.physicallyObservedEvents ?? null,
      counts: origins?.counts ?? null,
      drivingBoard: origins?.driving?.board ?? null,
    };
    check(
      origins?.driving?.board === 'distro-v1-esp32',
      `phase 14: the driving origin in the packaged window names board ${JSON.stringify(origins?.driving?.board)}`,
    );
    log(
      `[web] phase 14: ${origins?.physicallyObservedEvents} physically observed of ` +
        `${origins?.totalEvents} events, counts ${JSON.stringify(origins?.counts)}`,
    );

    // The panel, after something has moved: the verdict has something to say.
    await openTrustScreen();
    await sleep(450);
    const movingRaw = await evaluate(`JSON.stringify({
      verdict: document.querySelector('#measurement-verdict')?.innerText ?? '',
      originBanner: document.querySelector('#origin-banner')?.innerText ?? '',
      physical: document.querySelector('[data-testid="panel-physical-hardware"]')?.innerText ?? '',
      physicalCount: document.querySelector('[data-testid="panel-physical-hardware"]')?.getAttribute('data-physically-observed') ?? null,
    })`);
    const moving = JSON.parse(movingRaw);
    await evaluate(`document.querySelector('[data-popover-close="trust"]')?.click()`);
    await sleep(350);
    check(
      /Not a measurement/i.test(moving.verdict),
      `phase 14: the packaged window's verdict line reads ${JSON.stringify(String(moving.verdict).slice(0, 160))}`,
    );
    check(
      /emulated/i.test(moving.originBanner) && /distro-v1-esp32/i.test(moving.originBanner),
      `phase 14: the packaged window's origin badge is ${JSON.stringify(String(moving.originBanner).slice(0, 160))}`,
    );
    check(
      /PHYSICAL HARDWARE:\s*NONE/i.test(String(moving.physical).replace(/\s+/g, ' ')) &&
        moving.physicalCount === '0',
      `phase 14: the packaged trust card reads ${JSON.stringify(String(moving.physical).replace(/\s+/g, ' '))} ` +
        `with data-physically-observed=${JSON.stringify(moving.physicalCount)} after a real wave`,
    );

    // ------------------------------------------------------------- the OLED
    const oled = await evaluate('window.__sesame.oled()');
    let oledDetail = '';
    try {
      await evaluate(`document.querySelector('[data-info="oled-pixels"]')?.click()`);
      await sleep(450);
      oledDetail = await evaluate(
        `document.querySelector('[data-popover="oled-pixels"]')?.innerText ?? ''`,
      );
      await evaluate(`document.querySelector('[data-popover-close="oled-pixels"]')?.click()`);
      await sleep(300);
    } catch {
      /* reported by the verdict below */
    }
    for (const problem of oledProblems(oled, facts, oledDetail)) {
      check(false, `phase 14: ${problem}`);
    }
    record.oled = {
      state: oled?.pixels?.state ?? null,
      fromEmulator: oled?.pixels?.fromEmulator ?? null,
      litPixels: oled?.litPixels ?? null,
      pixelProvenance: oled?.source?.pixelProvenance ?? null,
      qualifierRendered: /getBuffer\(\)/.test(oledDetail) && /display\.display\(\)/.test(oledDetail),
    };

    // ------------------------------------------------------------ the trace
    const trace = await waitFor(
      'window.__sesame.trace()',
      (t) => t !== null && t.rows.some((r) => r.layer === 'servo.target'),
      'the causal trace in the packaged window to pick up the firmware’s servo events',
      60000,
    );
    for (const problem of traceProblems(trace)) check(false, `phase 14: ${problem}`);
    record.trace =
      trace === null || trace === undefined
        ? null
        : trace.rows.map((r) => ({ layer: r.layer, provenance: r.provenance, badge: r.badge }));

    // ------------------------------------- CONCEPTUAL and NOT BUILT, rendered
    await evaluate(`window.__sesame.setModule('learn')`);
    await sleep(700);
    const learnBadges = await evaluate(BADGE_CENSUS_JS);
    check(
      learnBadges.conceptualBadges >= 1,
      `phase 14: the packaged window's Learn module shows ${learnBadges.conceptualBadges} CONCEPTUAL ` +
        `badges. A module with no firmware symbol behind it must say so, in the packaged app as ` +
        `much as in the dev one.`,
    );
    // Lesson 8 opens on a serial-console step this runner does not build.
    await evaluate(`document.querySelector('[data-testid="lesson-card-talk-over-serial"]')?.click()`);
    await sleep(700);
    const notBuilt = await evaluate(BADGE_CENSUS_JS);
    check(
      notBuilt.notBuiltBadges + notBuilt.notBuiltPanels >= 1,
      `phase 14: the packaged window renders ${notBuilt.notBuiltBadges} NOT BUILT badges and ` +
        `${notBuilt.notBuiltPanels} NOT BUILT panels on a lesson whose controls are not built. An ` +
        `unbuilt control that looks built is the same lie as an emulator that looks like hardware.`,
    );
    record.badges = {
      conceptual: learnBadges.conceptualBadges,
      conceptualText: learnBadges.conceptualText,
      notBuiltBadges: notBuilt.notBuiltBadges,
      notBuiltPanels: notBuilt.notBuiltPanels,
      notBuiltText: notBuilt.notBuiltText,
    };
    await shootPackaged(
      't5-packaged-not-built.png',
      'the packaged window on a lesson whose controls the runner does not build: NOT BUILT is rendered rather than implied, and the CONCEPTUAL badges survived the bundle',
    );
    await evaluate(`document.querySelector('[data-testid="lesson-back"]')?.click()`);
    await sleep(400);

    // ============================ W1 and W6, in the packaged window's own size
    //
    // TWICE, and the second one is the point. The bare shell is 73 runs of text
    // and 18 controls; almost every provenance badge, witness paragraph and
    // trace row in the product is inside a MODULE, and a scan that only ever
    // saw the shell would be clearing the smallest surface the app has.
    //
    // `signal` is the module chosen because it is the provenance-dense one —
    // the causal ladder, its badges, its witnesses — which is the same reason
    // phase 13 scans it. The window is the packaged app's own default size
    // (1200x760 from `tauri.conf.json`), because that is what a reader gets;
    // the six-window sweep stays phase 12's job against the dev build.
    const a11yBySurface = {};
    let ringlessTotal = 0;
    let walkedTotal = 0;
    for (const surface of [null, 'signal']) {
      const where = surface === null ? 'the shell, no module' : `the ${surface} module`;
      await evaluate(`window.__sesame.setModule(${JSON.stringify(surface)})`);
      await sleep(900);

      const scans = {};
      scans.type = await evaluate(TYPE_SCAN_JS);
      scans.contrast = await evaluate(CONTRAST_JS);
      scans.targets = await evaluate(TARGETS_JS(TARGET_FINE_PX));
      scans.overflow = await evaluate(OVERFLOW_JS);
      scans.correctness = await evaluate(CORRECTNESS_JS);
      scans.provenance = await evaluate(PROVENANCE_JS);
      scans.pointerOnly = await evaluate(POINTER_ONLY_JS);

      check(
        scans.type.below.length === 0,
        `phase 14 [${where}]: ${scans.type.below.length} run(s) of text in the packaged window are below the ` +
          `${TEXT_FLOOR_PX}px floor: ` +
          scans.type.below.slice(0, 5).map((b) => `${b.name} ${b.authoredPx}px "${b.text}"`).join('; '),
      );
      check(
        scans.type.truncated.length === 0,
        `phase 14 [${where}]: ${scans.type.truncated.length} correctness surface(s) are truncated in the packaged ` +
          `window: ${scans.type.truncated.slice(0, 5).map((t) => `${t.name} "${t.text}"`).join('; ')}`,
      );
      check(
        scans.contrast.failures.length === 0,
        `phase 14 [${where}]: ${scans.contrast.failures.length} run(s) of text in the packaged window are under ` +
          `${CONTRAST_TEXT}:1: ` +
          scans.contrast.failures
            .slice(0, 6)
            .map((f) => `${f.name} ${String(f.ratio)}:1 "${f.text}"`)
            .join('; '),
      );
      check(
        scans.contrast.uiFailures.length === 0,
        `phase 14 [${where}]: ${scans.contrast.uiFailures.length} control boundary/ies in the packaged window are ` +
          `under 3:1: ${scans.contrast.uiFailures.slice(0, 5).map((f) => `${f.name} ${String(f.ratio)}:1`).join('; ')}`,
      );
      check(
        scans.contrast.measured > 40,
        `phase 14 [${where}]: the contrast scan measured only ${scans.contrast.measured} runs of text in the ` +
          `packaged window; a scan that found almost nothing has not cleared anything`,
      );
      check(
        scans.targets.underWcag.length === 0,
        `phase 14 [${where}]: ${scans.targets.underWcag.length} control(s) in the packaged window are under the ` +
          `${TARGET_WCAG_FLOOR_PX}px floor: ` +
          scans.targets.underWcag.slice(0, 5).map((t) => `${t.name} ${String(t.hitW)}x${String(t.hitH)}`).join('; '),
      );
      check(
        scans.targets.underFloor.length === 0,
        `phase 14 [${where}]: ${scans.targets.underFloor.length} control(s) in the packaged window are under the ` +
          `project's ${TARGET_FINE_PX}px tier: ` +
          scans.targets.underFloor.slice(0, 5).map((t) => `${t.name} ${String(t.hitW)}x${String(t.hitH)}`).join('; '),
      );
      check(
        scans.targets.checked > 10,
        `phase 14 [${where}]: the target scan hit-tested only ${scans.targets.checked} controls in the packaged window`,
      );
      check(
        scans.overflow.docScrollWidth <= scans.overflow.docClientWidth + 1 &&
          scans.overflow.undeclared.length === 0,
        `phase 14 [${where}]: the packaged window overflows horizontally ` +
          `(${scans.overflow.docScrollWidth} > ${scans.overflow.docClientWidth}) or has ` +
          `${scans.overflow.undeclared.length} undeclared horizontal scroller(s)`,
      );
      check(
        scans.correctness.truncated.length === 0 && scans.correctness.hidden.length === 0,
        `phase 14 [${where}]: correctness surfaces in the packaged window — ${scans.correctness.truncated.length} ` +
          `truncated, ${scans.correctness.hidden.length} collapsed: ` +
          [...scans.correctness.truncated, ...scans.correctness.hidden].slice(0, 5).join('; '),
      );
      check(
        scans.correctness.seen > 0,
        `phase 14 [${where}]: the correctness scan found none of its surfaces in the packaged window at all`,
      );
      check(
        scans.correctness.belowFloor.length === 0,
        `phase 14 [${where}]: ${scans.correctness.belowFloor.length} correctness surface(s) are below the floor in ` +
          `the packaged window: ${scans.correctness.belowFloor.slice(0, 5).join('; ')}`,
      );
      check(
        scans.provenance.withoutWord.length === 0,
        `phase 14 [${where}]: ${scans.provenance.withoutWord.length} provenance datum/data in the packaged window ` +
          `do not render their own category as a word: ` +
          JSON.stringify(scans.provenance.withoutWord.slice(0, 4)),
      );
      check(
        scans.provenance.colourOnly.length === 0,
        `phase 14 [${where}]: ${scans.provenance.colourOnly.length} element(s) in the packaged window are painted ` +
          `in a provenance hue with no word beside them: ` +
          JSON.stringify(scans.provenance.colourOnly.slice(0, 4)),
      );
      check(
        scans.provenance.badges > 0,
        `phase 14 [${where}]: the provenance scan found no badges at all in the packaged window`,
      );
      // The predicate's own answer, rendered. `data-origin-physical` is
      // `String(kind === 'physical-robot')` on every OriginTag, so a `true`
      // anywhere is the app telling a reader it is looking at hardware.
      scans.originPhysical = await evaluate(`(() => {
        const tags = [...document.querySelectorAll('[data-origin-physical]')];
        return {
          rendered: tags.length,
          physical: tags
            .filter((el) => el.getAttribute('data-origin-physical') !== 'false')
            .map((el) => (el.textContent ?? '').trim().slice(0, 60)),
        };
      })()`);
      check(
        scans.originPhysical.rendered > 0,
        `phase 14 [${where}]: no [data-origin-physical] tag is rendered in the packaged window, so ` +
          `"none of them claims hardware" is a statement about an empty set`,
      );
      check(
        scans.originPhysical.physical.length === 0,
        `phase 14 [${where}]: ${scans.originPhysical.physical.length} rendered origin(s) in the packaged window ` +
          `claim a physical robot: ${JSON.stringify(scans.originPhysical.physical.slice(0, 4))}`,
      );
      check(
        scans.pointerOnly.length === 0,
        `phase 14 [${where}]: ${scans.pointerOnly.length} element family/ies in the packaged window are clickable ` +
          `and reachable only with a pointer: ` +
          scans.pointerOnly.slice(0, 5).map((r) => `${r.name} x${String(r.n)}`).join('; '),
      );

      // The focus ring, under real keyboard modality — Tab, not el.focus().
      await evaluate(`document.body.focus()`);
      await evaluate(ENUM_FOCUSABLE_JS);
      const ringless = [];
      let walked = 0;
      for (let i = 0; i < 40; i += 1) {
        await cdp('Input.dispatchKeyEvent', { type: 'rawKeyDown', windowsVirtualKeyCode: 9, key: 'Tab', code: 'Tab' });
        await cdp('Input.dispatchKeyEvent', { type: 'keyUp', windowsVirtualKeyCode: 9, key: 'Tab', code: 'Tab' });
        const state = await evaluate(FOCUS_STATE_JS);
        if (state === null) continue;
        walked += 1;
        if (state.focusVisible === true && state.hasRing === false) {
          ringless.push({ name: state.name, text: state.text });
        }
        if (state.reachable === 0 && state.onScreen === true) {
          ringless.push({ name: state.name, text: state.text, obscured: true });
        }
      }
      check(
        walked > 5,
        `phase 14 [${where}]: tabbing through the packaged window reached only ${walked} focusable element(s)`,
      );
      check(
        ringless.length === 0,
        `phase 14 [${where}]: ${ringless.length} control(s) in the packaged window take keyboard focus with no ` +
          `visible ring, or are entirely obscured while focused: ` +
          ringless.slice(0, 5).map((r) => `${r.name} "${r.text}"`).join('; '),
      );
      a11yBySurface[where] = {
        textNodesScanned: scans.type.nodes,
        belowFloor: scans.type.below.length,
        contrastMeasured: scans.contrast.measured,
        contrastFailures: scans.contrast.failures.length,
        uiContrastFailures: scans.contrast.uiFailures.length,
        targetsChecked: scans.targets.checked,
        targetsUnderWcag: scans.targets.underWcag.length,
        targetsUnderTier: scans.targets.underFloor.length,
        correctnessSurfaces: scans.correctness.seen,
        correctnessTruncated: scans.correctness.truncated.length,
        provenanceBadges: scans.provenance.badges,
        originTagsRendered: scans.originPhysical.rendered,
        pointerOnlyFamilies: scans.pointerOnly.length,
        focusablesWalked: walked,
        ringless: ringless.length,
      };
      walkedTotal += walked;
      ringlessTotal += ringless.length;
      log(
        `[web] phase 14 a11y (${where}): ${scans.type.nodes} text nodes, ${scans.contrast.measured} ` +
          `contrast runs, ${scans.targets.checked} targets hit-tested, ${scans.provenance.badges} ` +
          `provenance badges, ${walked} focusables tabbed — ` +
          `${scans.type.below.length}/${scans.contrast.failures.length}/${scans.targets.underWcag.length}/${ringless.length} defects`,
      );
    }
    record.a11y = a11yBySurface;
    check(
      walkedTotal > 10 && ringlessTotal === 0,
      `phase 14: across both surfaces the tab walk reached ${walkedTotal} controls and found ` +
        `${ringlessTotal} without a visible focus ring`,
    );
    await evaluate(`window.__sesame.setModule('signal')`);
    await sleep(700);

    await shootPackaged(
      't5-packaged-wave.png',
      'the same packaged window after a real runWavePose executed on emulated Xtensa: eight joints observed from the emulator, isPhysicallyObserved() false for every event, pwm.output still INFERRED FOR EXPLANATION',
    );

    // ------------------------------- and what the packaged app says on the sim
    //
    // The desktop-simulator line's condition is `backendId === 'sim' &&
    // labProbe.labHost === 'desktop'`, and T4's seam flip made the second half
    // unreachable in a build that HAS an emulator. So the line stays absent
    // here — and what must not be absent is the claim it used to carry, which
    // the environment line and the origin badge take over.
    await evaluate(`window.__sesame.setBackend('sim')`);
    await waitFor(
      'window.__sesame.backendId()',
      (v) => v === 'sim',
      'the packaged window to switch to the behavioural simulator',
      30000,
    );
    await evaluate(`window.__sesame.run('wave')`).catch(() => null);
    /*
      Wait for the LINE, not for a fixed sleep.

      `environmentSystemName()` is derived from the DRIVING ORIGIN and falls
      back to the selected backend only before anything has arrived, so the
      strip goes on saying QEMU EMULATOR until the simulator's first event
      lands. Reading it too early gave a failure that named the right surface
      for the wrong reason — the check would have been measuring how fast this
      machine is.
    */
    await waitFor(
      `document.querySelector('[data-testid="status-environment"]')?.getAttribute('data-system') ?? null`,
      (v) => v === 'HOST MODEL',
      'the packaged window to re-derive its environment line from the simulator’s own origin',
      30000,
    );
    const envSim = await evaluate(ENVIRONMENT_LINE_JS);
    for (const problem of environmentLineProblems(envSim, ENVIRONMENT_LINE_HOST_MODEL)) {
      check(false, `phase 14 (packaged app on the simulator): ${problem}`);
    }
    const simLineOnSim = await evaluate(DESKTOP_SIMULATOR_JS);
    const originsSim = await evaluate(ORIGIN_COUNTS_JS);
    check(
      originsSim.physicallyObservedEvents === 0,
      `phase 14: ${originsSim.physicallyObservedEvents} event(s) from the packaged app's own ` +
        `simulator satisfied isPhysicallyObserved()`,
    );
    check(
      Number(originsSim.counts?.['host-model'] ?? 0) > 0,
      `phase 14: on the simulator the packaged window attributes ${JSON.stringify(originsSim.counts)}; ` +
        `nothing is naming the host model, which is the claim that replaces the desktop-simulator ` +
        `line in a build that does have an emulator`,
    );
    record.simulator = {
      environmentLine: envSim?.text ?? null,
      desktopSimulatorLinePresent: simLineOnSim.present,
      counts: originsSim?.counts ?? null,
      physicallyObservedEvents: originsSim?.physicallyObservedEvents ?? null,
    };
    if (simLineOnSim.present === false) {
      note(
        'phase 14: the packaged app does NOT render `panel-desktop-simulator` even when the ' +
          'behavioural simulator is driving. Its condition is `backendId === "sim" && ' +
          'labProbe.labHost === "desktop"`, and T4 made the second half unreachable in a build that ' +
          'has an emulator. What the reader gets instead is asserted here: the environment line ' +
          'reads SYSTEM: HOST MODEL · PHYSICAL HARDWARE: NONE and every event is attributed to ' +
          'host-model. The line itself is asserted PRESENT only by injecting one (the negative ' +
          'control above), because no reachable state of this artefact renders it.',
      );
    }

    const errors = session.errors();
    check(
      errors.length === 0,
      `phase 14: the packaged window logged ${errors.length} error(s): ${errors.slice(0, 3).join(' | ')}`,
    );
    record.pageErrors = errors.length;
  } catch (error) {
    check(false, `phase 14 threw: ${String(error.stack ?? error.message ?? error)}`);
  } finally {
    session.close();
    await closeApp();
  }

  // ------------------------------------------------------- T3's invariant
  const survivors = {
    qemu: processCount('qemu-system-xtensa.exe'),
    desktop: processCount('sesame-lab-desktop.exe'),
  };
  record.survivorsAfterClose = survivors;
  check(
    survivors.qemu === 0,
    `phase 14: ${survivors.qemu} qemu-system-xtensa.exe survived the packaged window closing. T3's ` +
      `job object is what stops a child's machine collecting emulators.`,
  );
  check(
    survivors.desktop === 0,
    `phase 14: ${survivors.desktop} sesame-lab-desktop.exe survived the close`,
  );

  record.ok = ctx.problemCount() === before;
  record.stderr = stderr.slice(0, 400);
  log(
    `[web] phase 14: ${record.ok ? 'ok' : `${ctx.problemCount() - before} problem(s)`}; ` +
      `survivors qemu=${survivors.qemu} desktop=${survivors.desktop}`,
  );
  return record;
}
