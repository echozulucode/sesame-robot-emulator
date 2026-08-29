#!/usr/bin/env node
/**
 * V3 + V4 evidence — drive `apps/web` in a real browser engine and read the
 * results back out of the **three.js scene graph**.
 *
 * Phase 0 established the rule: a browser claim is not evidence until a browser
 * has been driven headlessly. `scripts/capture-viewer-screenshots.mjs` did that
 * for the throwaway canvas viewer by measuring bar widths in pixels. This does
 * it for the R3F app, and asserts something stronger: not "the page drew
 * something the right width", but "`Object3D.quaternion` on the node named L3
 * actually changed". React can be perfectly correct while three.js renders
 * nothing; only the scene graph settles that.
 *
 * Five phases, in one browser session each:
 *
 *   1. SIM BACKEND — every joint starts at the asset's rest transform, then
 *      `runWavePose` is commanded and the scene graph is polled until L3
 *      reaches two DIFFERENT angles. A screenshot at each. The two images must
 *      differ byte-for-byte and the eight quaternions must differ numerically:
 *      one static frame does not prove motion, and neither does one that only
 *      differs by an anti-aliasing seed. It also samples the WORLD FRAME - the
 *      grid, the GLB root, the orbit target and the camera, off `matrixWorld` -
 *      from before the first command through the wave, and requires all four to
 *      hold to 1e-6 mm while the pose moves. Everything else here reads the
 *      pose; nothing read the frame the pose is expressed in, which is how
 *      ISSUE-20260823-023 shipped past a green harness.
 *   2. STAND POSE — `window.__sesame.verifyStandPose()`, which compares every
 *      joint node against the quaternion V2's own pose rule predicts for the
 *      reference pose stored in the GLB, and recomputes the ground plane from
 *      the posed foot vertices to compare against V2's recorded −68.650046 mm.
 *      That is the whole chain: choreography -> sim -> GLB -> scene.
 *   3. OLED — a real face must light real pixels, the 1368-character payload
 *      must be the protocol's page-ordered encoding, the texture must be on the
 *      `oled_screen` material with `flipY = false`, and `setFace("stand")` must
 *      draw nothing and say why.
 *   4. BRIDGE BACKEND (replay) — switch backends at runtime and drive the same
 *      scene from the Phase-0 bridge's WebSocket, with the app served by the
 *      bridge's own static server. Zero bridge changes: `--viewer-dir` already
 *      existed.
 *   5. BRIDGE BACKEND (QEMU) — optional, and only when Q1's toolchain is
 *      present: real Sesame firmware executing under Espressif QEMU, UART0 on a
 *      TCP socket, the same unmodified bridge, the same unmodified app. The
 *      bridge is receive-only, so this phase WATCHES firmware; it cannot drive
 *      it, and the envelopes carry no `TelemetryOrigin` at all.
 *   6. QEMU, COMMANDED FROM THE BROWSER — the one that matters. The app is
 *      served by `apps/web/server/lab-host.mjs`, which puts the firmware's own
 *      ten HTTP routes in front of `QemuSesameRobot`. The harness CLICKS the
 *      `wave` button in the DOM, and then asserts that the eight joint
 *      quaternions in the THREE.js scene graph moved, that every one of them
 *      was last written by an event with `provenance: 'observed'` AND
 *      `origin.kind === 'emulator'`, and that `isPhysicallyObserved()` was
 *      never true for anything. It re-runs the ISSUE-20260823-023 world-frame
 *      check across that wave, because that bug was found by a human on the
 *      simulator path and a new driving path is a new chance for it to return.
 *
 *   7. ARCHITECTURE + SEE THE SIGNAL — the Phase-2 pair. Numbered last but RUN
 *      inside the phase 1-4 browser session, switched back to the simulator:
 *      it needs a backend that can be driven AND can thread a trace id, which
 *      is the one thing QEMU cannot do. The graph starts at the report's
 *      collapsed top level, a DOM click expands `Servos` into the real chain
 *      (setServoAngle -> ESP32Servo -> LEDC -> GPIO -> MG90S -> eight joints),
 *      a DOM click on `wave` fires a command, and the trace is asserted row by
 *      row: causal ORDER, and the exact provenance badge each layer must carry.
 *      `pwm.output` must read INFERRED FOR EXPLANATION on every backend, and no
 *      row anywhere may claim physical observation. Cross-linking is asserted
 *      through the SCENE GRAPH: clicking the R4 node in the graph must light
 *      R4's materials in three.js and nothing else. Phase 6 asserts the same
 *      ladder under real firmware, where two rows legitimately change and
 *      `pwm.output` legitimately does not. ISSUE-20260823-023 is re-run in
 *      both, because three new panes of React are a new chance for the world
 *      frame to move.
 *
 *   8. SOURCE EXPLORER — the four synchronised panes closed into a loop. A DOM
 *      click on a symbol in the outline must light its architecture node AND
 *      its `robotParts` in the three.js materials; selecting a joint in the 3D
 *      scene must scroll the code view onto a symbol whose `robotParts`
 *      contains it. The rendered LINE NUMBERS are compared against
 *      `hardware/source-annotations.json` — the painted text of the line
 *      numbered `startLine` must equal the `startLineText` L3 recorded, which
 *      is the assertion that catches a drifted file or the wrong tree.
 *   9. THE REFUSAL — `firmware/upstream/` is gitignored, so the source is
 *      bundled at build time and hashed again in the browser. This phase serves
 *      a `dist/` with ONE BYTE changed and requires the pane to render no code
 *      at all. A subtly wrong source view is worse than an honest error, so the
 *      branch is exercised rather than merely written.
 *
 *  10. LEARN MODE — the lesson runner PLAYS lessons rather than rendering them:
 *      real clicks and real `input` events drive the controls, and each success
 *      condition is asserted to flip to `passed` only when the underlying state
 *      is right. Several checks are driven to `failed` FIRST, because a check
 *      that has never failed could be a constant.
 *  11. LAB MODE — the unrestricted surface, under `lab-host --backend sim` so
 *      the sliders, the console and the 3D scene all talk to ONE robot behind
 *      the firmware's own routes. Nothing here has a check to wait on, so every
 *      claim is asserted against something outside the Lab: the played
 *      animation is read off `Object3D.quaternion`, the exported C++ is parsed
 *      by a SECOND parser written in this file, the drawn face is decoded out
 *      of the SSD1306's page-ordered GDDRAM pixel by pixel, `/api/status` is
 *      parsed to prove our adapter does not reproduce ISSUE-20260823-021, and
 *      the project is checked across a real `location.reload()`.
 *
 *  12. THE RESPONSIVE SHELL — the assertion whose ABSENCE let a 13%-of-screen
 *      robot ship. Phases 1-11 run at ONE window and none of them ever asked
 *      how much space the 3D viewport got, so a fixed three-column grid passed
 *      every check while leaving a 1440x900 laptop about 500x280 for the thing
 *      the product is about. This phase opens six windows — 880x900, 1280x800,
 *      1440x900, 1760x1000, 1920x1080 and 2560x1440 — and at each one measures
 *      the CANVAS rather than its container.
 *
 *      **TWO STAGE REGIMES, both asserted — Phase 4 W7 §11.2.** The 50%-of-
 *      screen rule and "the architecture needs half the screen with the robot
 *      in the other half" cannot both be literal once a rail, a status strip
 *      and a side panel exist, so they are two NAMED regimes and the app
 *      publishes which one it is claiming on `data-stage-rule`:
 *
 *        area-50     no module active  -> stage >= 50% of the VIEWPORT area
 *        content-50  a module is up    -> stage >= 50% of the CONTENT area
 *                                         (viewport - rail - strip - panel)
 *
 *      Plus the inverse W3 wrote and W7 adapted: activating a module must take
 *      more than 300 px from the canvas, because "in flow" is a claim about the
 *      layout rather than a comment. The 45% height floor and the 480 px width
 *      floor stay as the Compact backstop.
 *
 *      **1760x1000 is in the sweep by name**: W4 measured the two-dock regime
 *      holding only 45.0% of the area there at its default dock widths, and
 *      that gap is what W7 closes by deleting the regime.
 *
 *      Also asserted: ONE active module at every width (the count of laid-out
 *      module panes, for every module in turn) and zero accordion toggles
 *      anywhere; the side panel's scroll rule — **no scroller outside the two
 *      cards allowed one, and those two only when their own content does not
 *      fit** (Phase 4 W5, replacing W7's "zero scrollers" when the user
 *      overrode it) — and the named correctness surfaces present on it with every
 *      "more info" screen shut; the architecture's own box against W4's
 *      720/960 bands in the ORDINARY layout; the environment line
 *      `SYSTEM: ... · PHYSICAL HARDWARE: NONE`, visible and whole; `wave`
 *      reachable from the status line, HIT-TESTED, with no module open; the
 *      §5.1 selection badge, now on the rail; the §5.2 auto-reveal; reload
 *      persistence of the active module and of the DERIVED mode; and
 *      ISSUE-20260823-023 re-run at every breakpoint AND across a module
 *      clear/activate and a module switch. Learn plays lesson 2 end to end at
 *      Medium and the Lab's C++ export is re-parsed at Compact.
 *
 * Usage: node scripts/capture-web-screenshots.mjs [--out <dir>] [--skip-qemu]
 * Exit 0 pass · 1 fail · 3 no browser found.
 */
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const argOf = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : fallback;
};
const OUT = path.resolve(REPO, argOf('out', 'docs/findings/assets'));
const SKIP_QEMU = argv.includes('--skip-qemu');

const APP_DIST = path.join(REPO, 'apps/web/dist');
const BRIDGE_CLI = path.join(REPO, 'emulator/bridge/dist/cli.js');
const WAVE_FIXTURE = path.join(REPO, 'emulator/bridge/fixtures/wave-pose.replay.jsonl');
const QEMU_EXE = path.join(REPO, 'tools/qemu/qemu/bin/qemu-system-xtensa.exe');
const QEMU_IMAGE = path.join(REPO, 'emulator/qemu/images/distro-v1-esp32-nowifi.flash.bin');
const LAB_HOST = path.join(REPO, 'apps/web/server/lab-host.mjs');
/**
 * The image `QemuSesameRobot` boots by default.
 *
 * Not the `nowifi` one phase 5 uses: that build injects `currentCommand =
 * "wave"` into `setup()` because nothing could ask the robot to move. Phase 6
 * exists precisely because something can now, so it needs the image that boots
 * IDLE — otherwise "the joints moved after the click" would be indistinguishable
 * from "the joints were already moving".
 */
const QEMU_CLI_IMAGE = path.join(REPO, 'emulator/qemu/images/distro-v1-esp32-cli.flash.bin');

const JOINT_ORDER = ['R1', 'R2', 'L1', 'L2', 'R4', 'R3', 'L3', 'L4'];

// ---------------------------------------------------------------- bookkeeping
const problems = [];
const notes = [];
const shots = [];
const phases = {};
const check = (condition, message) => {
  if (!condition) problems.push(message);
  return condition;
};

const children = [];
const killAll = () => {
  for (const child of children) {
    try {
      child.kill();
    } catch {
      /* already gone */
    }
  }
};
process.on('exit', killAll);

const die = (message) => {
  console.error(`FAIL  ${message}`);
  // Everything `check()` had already recorded, printed rather than lost. A
  // `waitFor` that times out is usually the SYMPTOM of an earlier failed check,
  // and exiting without showing them turns a five-line diagnosis into a
  // bisect.
  if (problems.length > 0) {
    console.error(`      ...with ${problems.length} problem(s) already recorded:`);
    for (const problem of problems) console.error(`      - ${problem}`);
  }
  killAll();
  process.exit(1);
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const freePort = () =>
  new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });

// ------------------------------------------------------------- prerequisites
for (const [what, where] of [
  ['the built app (run: pnpm --filter @sesame-lab/web build)', path.join(APP_DIST, 'index.html')],
  ['the app’s copy of the GLB', path.join(APP_DIST, 'sesame.glb')],
  ['the built bridge (run: pnpm -r build)', BRIDGE_CLI],
  ['the wave replay fixture', WAVE_FIXTURE],
]) {
  if (!fs.existsSync(where)) die(`missing ${what}: ${path.relative(REPO, where).replaceAll('\\', '/')}`);
}

const BROWSER_CANDIDATES = [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  process.env.CHROME_PATH,
].filter(Boolean);
const BROWSER = BROWSER_CANDIDATES.find((p) => fs.existsSync(p));
if (!BROWSER) {
  console.error('[web] no Edge or Chrome found. Set CHROME_PATH to a Chromium binary.');
  process.exit(3);
}

// -------------------------------------------------------------------- bridge
/**
 * Start the Phase-0 bridge, serving the built app from its own HTTP server.
 *
 * `--serve-viewer --viewer-dir apps/web/dist` is the whole integration. The
 * bridge was not touched: `--viewer-dir` has existed since R7, and it means the
 * app and its WebSocket share one origin, so the browser needs no port typed in
 * and there is no cross-origin question to answer.
 */
async function startBridge({
  replay = null,
  uartPort = null,
  provenance = null,
  quiet = true,
  viewerDir = APP_DIST,
} = {}) {
  const wsPort = await freePort();
  // The bridge's UART listener defaults to 3456, and the checked-in Renode
  // script and the QEMU work both use that port. A capture run has no UART peer
  // at all in the replay phases, so give it a free port rather than letting an
  // unrelated concurrent process on 3456 abort the whole harness.
  if (uartPort === null) uartPort = await freePort();
  const args = [BRIDGE_CLI, '--ws-port', String(wsPort), '--serve-viewer', '--viewer-dir', viewerDir];
  // `--quiet` suppresses the bridge's lifecycle lines on stderr, including
  // "uart connected" — which is the one line the QEMU phase needs to see.
  if (quiet) args.push('--quiet');
  if (replay !== null) args.push('--replay', replay, '--loop', '--loop-gap', '400');
  if (uartPort !== null) args.push('--uart-host', '127.0.0.1', '--uart-port', String(uartPort));
  if (provenance !== null) args.push('--provenance', provenance);

  const proc = spawn(process.execPath, args, { cwd: REPO, stdio: ['ignore', 'pipe', 'pipe'] });
  children.push(proc);
  let output = '';
  proc.stdout.on('data', (d) => (output += d.toString()));
  proc.stderr.on('data', (d) => (output += d.toString()));

  const url = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`bridge printed no viewer URL:\n${output}`)), 15000);
    const poll = setInterval(() => {
      const match = /viewer\s+(http:\/\/\S+)/.exec(output);
      if (match) {
        clearInterval(poll);
        clearTimeout(timeout);
        resolve(match[1]);
      }
      if (proc.exitCode !== null) {
        clearInterval(poll);
        clearTimeout(timeout);
        reject(new Error(`bridge exited ${proc.exitCode}:\n${output}`));
      }
    }, 100);
  });

  return { proc, url, wsPort, output: () => output };
}

// ------------------------------------------------------------------ lab host
/**
 * Start `apps/web/server/lab-host.mjs`, serving the built app itself.
 *
 * One origin, exactly as the bridge's `--viewer-dir` gives phases 1-5: the page
 * that posts `/api/command` is served by the process that answers it, so there
 * is no CORS question and no port to type. The host begins listening before the
 * emulator has booted, on purpose — that is what lets the browser observe the
 * boot rather than only its outcome.
 */
async function startLabHost({ backend = 'qemu' } = {}) {
  const port = await freePort();
  const proc = spawn(
    process.execPath,
    [LAB_HOST, '--backend', backend, '--port', String(port), '--dist', APP_DIST],
    { cwd: REPO, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  children.push(proc);
  let output = '';
  proc.stdout.on('data', (d) => (output += d.toString()));
  proc.stderr.on('data', (d) => (output += d.toString()));

  const url = await new Promise((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error(`lab host printed no URL:\n${output}`)),
      20000,
    );
    const poll = setInterval(() => {
      const match = /lab-host\s+(http:\/\/\S+)/.exec(output);
      if (match) {
        clearInterval(poll);
        clearTimeout(timeout);
        resolve(match[1]);
      }
      if (proc.exitCode !== null) {
        clearInterval(poll);
        clearTimeout(timeout);
        reject(new Error(`lab host exited ${proc.exitCode}:\n${output}`));
      }
    }, 100);
  });
  return { proc, url, port, output: () => output };
}

// ------------------------------------------------------------------ browser
/**
 * The window every phase but 12 runs in.
 *
 * 1760x1000, unchanged from W3 — but it is **Medium** now rather than Wide, and
 * that is a statement about the shell rather than about the window.
 *
 * W3 moved the default here so phase 7 could have the architecture graph and
 * the Signal trace on screen AT ONCE. §11.3 makes that impossible on purpose:
 * one module is active at a time. So phase 7 asserts something stronger in its
 * place — that the SELECTION survives a module switch, which is a property of
 * there being one `SelectionState` rather than of two panes happening to share
 * a screen.
 *
 * `wide` now means "the ORDINARY layout holds the whole 63-node graph", which
 * needs 2314 px of viewport. Phases 1-11 do not need that; they need a module
 * column wide enough to lay a pane out and measure it, which 1760 gives.
 */
const DEFAULT_WINDOW = { width: 1760, height: 1000 };

/**
 * The six windows phase 12 measures.
 *
 * Four are U6's and W3's: 880x900 for Compact, the two the plan names inside
 * the laptop band, and 2560x1440. **1760x1000 and 1920x1080 were added in W7**
 * and both are there because a previous workstream measured something at them
 * that nothing asserted — see the comments on the rows themselves. 1600x1000
 * was dropped: it was in the sweep because it was the top of the workbench
 * band, and there is no workbench band any more.
 */
const RESPONSIVE_WINDOWS = [
  { label: 'compact', width: 880, height: 900, breakpoint: 'compact', u5SharePct: 82.0 },
  { label: 'laptop-small', width: 1280, height: 800, breakpoint: 'medium', u5SharePct: 80.0 },
  { label: 'laptop', width: 1440, height: 900, breakpoint: 'medium', u5SharePct: 80.0 },
  /*
    1760x1000 — **the reopened gap**, and it is asserted by name.

    W4 measured that the two-dock Wide regime held only **45.0%** of the
    window's area here at its DEFAULT dock widths (400 + 460), below the 50%
    floor W3 asserted. W3 had set the 1700 boundary from 360 + 360 and phase 12
    only ever measured 2560, where the same layout held 75.7%. W7 removes the
    two-dock regime, so the gap cannot reopen — and this window is in the sweep
    so that claim is measured rather than argued.
  */
  { label: 'desktop-small', width: 1760, height: 1000, breakpoint: 'medium', u5SharePct: 82.0 },
  /*
    1920x1080 — the width W4 handed over as the one that decides whether the
    module-first shell actually fixed the complaint. The architecture surface
    here is what §11.6 asks to be measured and reported.
  */
  { label: 'desktop', width: 1920, height: 1080, breakpoint: 'medium', u5SharePct: 84.0 },
  { label: 'desktop-wide', width: 2560, height: 1440, breakpoint: 'wide', u5SharePct: 86.9 },
];

// ===========================================================================
// THE TYPE SCALE, CHECKED IN THE STYLESHEET — Phase 4 W1
// ===========================================================================
//
// Static, and first, because it is the one invariant a browser cannot prove.
// A page can render every visible node at 16px and still carry a `font-size:
// 9px` rule on a pane nobody happened to open in this run; the measurement
// that started Phase 4 was made by grepping the stylesheet, so that is where
// the "no arbitrary literals" rule is enforced.
//
// The browser checks below it prove the other half: that the tokens are used,
// and that what a reader actually sees is at or above the floor.
//
// The eight role tokens ARE the brief's 1440x900 table. Asserting each clamp
// minimum against the table here is what stops the scale drifting back down a
// pixel at a time — an override in a media query would have to lower a token,
// and there is nothing left to lower it to.
const TYPE_ROLES = {
  badge: { px: 14, what: 'badges, chips, line numbers, counters — the absolute floor' },
  code: { px: 15, what: 'monospace, telemetry values, table cells' },
  ui: { px: 16, what: 'the default: body, labels, buttons, inputs' },
  prose: { px: 17, what: 'lesson and explanation prose' },
  heading: { px: 18, what: 'section headings inside a pane' },
  title: { px: 20, what: 'pane titles' },
  workspace: { px: 24, what: 'mode and workspace titles' },
  display: { px: 28, what: 'milestones' },
};
const TEXT_FLOOR_PX = 14;
const CASCADE_LAYERS = 'reset, tokens, base, shell, components, panes, utilities, overrides';

{
  const cssPath = path.join(REPO, 'apps/web/src/styles.css');
  const css = fs.readFileSync(cssPath, 'utf8');

  check(
    css.includes(`@layer ${CASCADE_LAYERS};`),
    `apps/web/src/styles.css does not declare the cascade layers in order — expected ` +
      `"@layer ${CASCADE_LAYERS};". Without the declaration the layer order is source order, ` +
      `which is the thing the layers exist to replace.`,
  );

  // Every declaration, with the line it is on, so a failure names the line.
  const declarations = [];
  css.split(/\r?\n/).forEach((line, i) => {
    const m = /font-size:\s*([^;]+);/.exec(line);
    if (m !== null) declarations.push({ line: i + 1, value: m[1].trim() });
  });
  const literals = declarations.filter(
    (d) => !/^var\(--font-(badge|code|ui|prose|heading|title|workspace|display)\)$/.test(d.value) &&
      d.value !== 'inherit',
  );
  check(
    literals.length === 0,
    `apps/web/src/styles.css has ${literals.length} font-size declaration(s) that are not a role ` +
      `token: ${literals.slice(0, 6).map((d) => `line ${d.line}: ${d.value}`).join(', ')}. Every ` +
      `size comes from the token block; a literal is how 128 of 144 declarations ended up at 12px ` +
      `or below, and it is how they would get back there.`,
  );

  // The tokens themselves, against the brief's table. `clamp(MIN, …, MAX)` with
  // MIN equal to the 1440x900 value is the whole "fluid upward, floored
  // downward" rule; a token whose minimum drifts below the table has silently
  // reintroduced a compact mode.
  const tokenSizes = {};
  for (const [role, spec] of Object.entries(TYPE_ROLES)) {
    const m = new RegExp(`--font-${role}:\\s*clamp\\(([^,]+),`).exec(css);
    if (m === null) {
      problems.push(`--font-${role} (${spec.what}) is not defined as a clamp() in the token block`);
      continue;
    }
    const min = /^([0-9.]+)rem$/.exec(m[1].trim());
    const px = min === null ? Number.NaN : Number(min[1]) * 16;
    tokenSizes[role] = px;
    check(
      Math.abs(px - spec.px) < 0.01,
      `--font-${role} floors at ${String(px)}px; the brief's 1440x900 table says ${spec.px}px ` +
        `(${spec.what}). The clamp MINIMUM is the floor, so this is the number a narrow window ` +
        `gets.`,
    );
  }
  check(
    tokenSizes.badge === TEXT_FLOOR_PX,
    `the smallest role token is ${String(tokenSizes.badge)}px, not the ${TEXT_FLOOR_PX}px floor`,
  );

  // No media query may set a size. Responsive behaviour changes arrangement,
  // column count, representation and disclosure — never type size. The tokens
  // are viewport-fluid ABOVE 1440 and constant below it, so a font-size inside
  // an `@media` block can only ever be a compact mode by another name.
  const mediaFontSizes = [];
  {
    let depth = 0;
    let inMedia = -1;
    css.split(/\r?\n/).forEach((line, i) => {
      if (/^\s*@media/.test(line) && inMedia < 0) inMedia = depth;
      for (const ch of line) {
        if (ch === '{') depth += 1;
        if (ch === '}') {
          depth -= 1;
          if (inMedia >= 0 && depth <= inMedia) inMedia = -1;
        }
      }
      if (inMedia >= 0 && /font-size:/.test(line)) mediaFontSizes.push(i + 1);
    });
  }
  check(
    mediaFontSizes.length === 0,
    `apps/web/src/styles.css sets a font-size inside an @media block at line(s) ` +
      `${mediaFontSizes.join(', ')}. "No compact mode as a default" is a product rule: a ` +
      `breakpoint may change arrangement, column count, representation and disclosure, and may ` +
      `not change how big the text is.`,
  );

  phases.typeScale = {
    ok: problems.length === 0,
    source: 'docs/research/Sesame Lab_ responsive UI_UX research brief.md, "The typography problem is real and severe"',
    layers: CASCADE_LAYERS,
    tokens: Object.fromEntries(
      Object.entries(TYPE_ROLES).map(([role, spec]) => [
        `--font-${role}`,
        { floorPx: spec.px, role: spec.what },
      ]),
    ),
    fontSizeDeclarations: declarations.length,
    arbitraryLiterals: literals.length,
    fontSizesInsideMediaQueries: mediaFontSizes.length,
    was: '144 declarations, 128 of them <= 12px, 18 at 10px, 13 at 9px, on a 13px base',
  };
  console.log(
    `[web] type scale: ${declarations.length} font-size declarations, ${literals.length} literals, ` +
      `${mediaFontSizes.length} inside media queries; floor ${TEXT_FLOOR_PX}px`,
  );
}

// ===========================================================================
// THE CONTAINER/VIEWPORT SPLIT, CHECKED IN THE STYLESHEET — Phase 4 W2
// ===========================================================================
//
// Static, and beside the type scale, for the same reason: a browser run can
// only prove things about the panes it happened to open at the widths it
// happened to visit. What this block proves is about the FILE.
//
// The brief's split is a table of questions, and the failure mode it guards
// against is a pane rule drifting back into a viewport query — where it cannot
// be right, because the same 1440 px window holds a 399 px pane in a docked
// column, a 649 px pane in an overlay, and (from W3) a 494 px pane in a
// workbench. Three widths, one media query, at most one of them correct.
const PANE_CONTAINER_THRESHOLDS_REM = [32.5, 45];

{
  const cssPath = path.join(REPO, 'apps/web/src/styles.css');
  const css = fs.readFileSync(cssPath, 'utf8');

  check(
    /\.pane\s*\{[^}]*container:\s*pane\s*\/\s*inline-size/.test(css),
    'apps/web/src/styles.css does not give `.pane` `container: pane / inline-size`. Without the ' +
      'containment context every `@container pane` rule in the file is inert, and inert CSS fails ' +
      'silently — which is exactly how a responsive rule stops being applied without anyone noticing.',
  );

  // Every container query in the file, with the line it is on.
  const containerQueries = [];
  css.split(/\r?\n/).forEach((line, i) => {
    const m = /@container\s+([^{]+)\{/.exec(line);
    if (m !== null) containerQueries.push({ line: i + 1, condition: m[1].trim() });
  });
  check(
    containerQueries.length > 0,
    'apps/web/src/styles.css has no `@container` rules at all. W2 exists to put pane internals on ' +
      'container queries; a file with none has not done it.',
  );

  // Every one of them queries the NAMED pane container. An unnamed
  // `@container (width < …)` resolves against the nearest ancestor container of
  // any kind, which today is the pane and tomorrow is whatever W3 or W4 adds.
  const unnamed = containerQueries.filter((q) => !q.condition.startsWith('pane '));
  check(
    unnamed.length === 0,
    `apps/web/src/styles.css has ${unnamed.length} container query that does not name the \`pane\` ` +
      `container: ${unnamed.map((q) => `line ${q.line}: @container ${q.condition}`).join(', ')}. ` +
      `An unnamed query binds to the nearest containment context of any kind, which is a different ` +
      `rule the moment somebody adds a second container.`,
  );

  // The thresholds are the brief's, and there are only two of them. A third
  // number appearing here is a per-pane breakpoint, which is how a "responsive
  // system" becomes forty unrelated numbers.
  const thresholds = [
    ...new Set(
      containerQueries.flatMap((q) => [...q.condition.matchAll(/([0-9.]+)rem/g)].map((m) => Number(m[1]))),
    ),
  ].sort((a, b) => a - b);
  check(
    JSON.stringify(thresholds) === JSON.stringify(PANE_CONTAINER_THRESHOLDS_REM),
    `the container queries use thresholds ${JSON.stringify(thresholds)}rem; the brief's pane bands ` +
      `are ${JSON.stringify(PANE_CONTAINER_THRESHOLDS_REM)}rem (520 px and 720 px). Every extra ` +
      `number is a breakpoint somebody chose for one pane and nobody can check.`,
  );

  // The same rule the type scale enforces for `@media`, for the mechanism that
  // replaced it. W1 removed every font-size from every media query on the
  // grounds that "no compact mode as a default" is a product rule rather than a
  // preference; a container query that shrinks type is the same mistake with a
  // better excuse, because it would be genuinely responsive and still wrong.
  const containerFontSizes = [];
  {
    let depth = 0;
    let inContainer = -1;
    css.split(/\r?\n/).forEach((line, i) => {
      if (/^\s*@container/.test(line) && inContainer < 0) inContainer = depth;
      for (const ch of line) {
        if (ch === '{') depth += 1;
        if (ch === '}') {
          depth -= 1;
          if (inContainer >= 0 && depth <= inContainer) inContainer = -1;
        }
      }
      if (inContainer >= 0 && /font-size:/.test(line)) containerFontSizes.push(i + 1);
    });
  }
  check(
    containerFontSizes.length === 0,
    `apps/web/src/styles.css sets a font-size inside an @container block at line(s) ` +
      `${containerFontSizes.join(', ')}. Responsive behaviour changes arrangement, column count, ` +
      `representation and disclosure — not how big the text is, and that holds for the pane's own ` +
      `width exactly as it holds for the window's.`,
  );

  phases.containerQueries = {
    ok: problems.length === 0,
    source:
      'docs/research/Sesame Lab_ responsive UI_UX research brief.md, ' +
      '"Container queries should become the pane-level responsive mechanism"',
    contract: '<section class="pane" data-pane> · .pane__header h2 · .pane__content{min-inline-size:0}',
    container: 'container: pane / inline-size',
    thresholdsRem: PANE_CONTAINER_THRESHOLDS_REM,
    queries: containerQueries.length,
    unnamedQueries: unnamed.length,
    fontSizesInsideContainerQueries: containerFontSizes.length,
    split: {
      viewport: 'rail vs bottom nav, docks overlay vs in flow, dock widths, the stage margin',
      shellState: "data-sections — whether one pane owns the dock's height or several share it",
      container: "Signal's row, Inspector's table vs records, Learn's measure and its control column",
      react: "the artifact itself — useContainerWidth() + paneWidthBand(), W4's three graphs",
    },
  };
  console.log(
    `[web] container queries: ${containerQueries.length} rules, all naming \`pane\`, thresholds ` +
      `${PANE_CONTAINER_THRESHOLDS_REM.join('/')}rem, ${containerFontSizes.length} font-sizes inside them`,
  );
}

async function launchBrowser(url, window = DEFAULT_WINDOW) {
  const cdpPort = await freePort();
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'sesame-web-'));
  const proc = spawn(
    BROWSER,
    [
      '--headless=new',
      `--remote-debugging-port=${cdpPort}`,
      `--user-data-dir=${profile}`,
      `--window-size=${window.width},${window.height}`,
      '--hide-scrollbars',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-extensions',
      '--disable-background-timer-throttling',
      '--disable-renderer-backgrounding',
      '--disable-backgrounding-occluded-windows',
      // Headless Chromium has no GPU here, so WebGL must come from SwiftShader.
      // Without this the canvas silently fails to get a context and the whole
      // point of the exercise evaporates.
      '--use-gl=swiftshader',
      '--enable-unsafe-swiftshader',
      url,
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );
  children.push(proc);
  let stderr = '';
  proc.stderr.on('data', (d) => (stderr += d.toString()));

  const deadline = Date.now() + 30000;
  let target = null;
  while (Date.now() < deadline && target === null) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${cdpPort}/json/list`)).json();
      target = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl) ?? null;
    } catch {
      /* not listening yet */
    }
    if (target === null) await sleep(200);
  }
  if (target === null) die(`the browser never exposed a CDP page target.\n${stderr}`);

  const socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.onopen = resolve;
    socket.onerror = () => reject(new Error('CDP socket failed'));
  }).catch((e) => die(e.message));

  let nextId = 1;
  const pending = new Map();
  // A React error boundary or a throw inside useFrame kills the render loop
  // silently: the page keeps its last frame and every scene-graph read returns
  // a stale but plausible number. Capturing the console is what turns that into
  // a diagnosis instead of a mystery.
  const pageErrors = [];
  socket.onmessage = (message) => {
    const parsed = JSON.parse(message.data);
    if (parsed.method === 'Runtime.exceptionThrown') {
      const d = parsed.params.exceptionDetails;
      pageErrors.push(d.exception?.description ?? d.text);
    }
    if (parsed.method === 'Runtime.consoleAPICalled' && parsed.params.type === 'error') {
      pageErrors.push(parsed.params.args.map((a) => a.description ?? a.value).join(' '));
    }
    if (parsed.id !== undefined && pending.has(parsed.id)) {
      const { resolve, reject } = pending.get(parsed.id);
      pending.delete(parsed.id);
      if (parsed.error) reject(new Error(parsed.error.message));
      else resolve(parsed.result);
    }
  };
  const cdp = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      pending.set(id, { resolve, reject });
      socket.send(JSON.stringify({ id, method, params }));
      setTimeout(() => {
        if (pending.delete(id)) reject(new Error(`${method} timed out`));
      }, 30000);
    });

  await cdp('Page.enable');
  await cdp('Runtime.enable');

  /** Evaluate an expression in the page and return its value. */
  const evaluate = async (expression) => {
    const result = await cdp('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    if (result.exceptionDetails) {
      throw new Error(
        `page threw: ${result.exceptionDetails.exception?.description ?? result.exceptionDetails.text}`,
      );
    }
    return result.result.value;
  };

  const shoot = async (name, caption) => {
    const png = await cdp('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    const buffer = Buffer.from(png.data, 'base64');
    fs.mkdirSync(OUT, { recursive: true });
    const file = path.join(OUT, name);
    fs.writeFileSync(file, buffer);
    const record = {
      file: path.relative(REPO, file).replaceAll('\\', '/'),
      name,
      caption,
      bytes: buffer.length,
      sha256: crypto.createHash('sha256').update(buffer).digest('hex'),
    };
    shots.push(record);
    console.log(`[web] shot ${name} — ${caption} (${buffer.length} B)`);
    return record;
  };

  const close = () => {
    try {
      socket.close();
    } catch {
      /* closing anyway */
    }
    try {
      proc.kill();
    } catch {
      /* gone */
    }
    try {
      fs.rmSync(profile, { recursive: true, force: true });
    } catch {
      /* windows file locks */
    }
  };

  return { evaluate, shoot, close, stderr: () => stderr, errors: () => pageErrors };
}

/**
 * Poll the page until `predicate` holds.
 *
 * `soft: true` throws instead of exiting, for the QEMU phase — Q1 is off the
 * critical path and its toolchain is gitignored, so a failure there is a
 * finding to report, not a reason to fail V3's gate.
 */
async function waitFor(evaluate, expression, predicate, what, timeoutMs = 30000, soft = false) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    last = await evaluate(expression);
    if (predicate(last)) return last;
    await sleep(60);
  }
  const message = `timed out waiting for ${what}. Last value: ${JSON.stringify(last)?.slice(0, 900)}`;
  if (soft) throw new Error(message);
  die(message);
  return last;
}

/**
 * A SECOND `setServoAngle()` parser, written here on purpose.
 *
 * The Lab renders its own round-trip verdict, and asserting that verdict
 * would only prove the Lab agrees with itself. This one reads the exported
 * text by the same rule the firmware's bodies are read under — writes
 * accumulate, a wait closes the frame — and the phase compares its output
 * against the frames THIS FILE authored through the sliders.
 */
const parseExportedCpp = (source) => {
  const text = source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, '');
  const tokens = [];
  const callRe = /setServoAngle\s*\(\s*([A-Za-z_][A-Za-z0-9_]*|\d+)\s*,\s*(-?\d+)\s*\)/g;
  const delayRe = /\b(delayWithFace|delay)\s*\(\s*(\d+)\s*\)/g;
  for (let m = callRe.exec(text); m !== null; m = callRe.exec(text)) {
    tokens.push({ at: m.index, kind: 'servo', name: m[1], value: Number(m[2]) });
  }
  for (let m = delayRe.exec(text); m !== null; m = delayRe.exec(text)) {
    tokens.push({ at: m.index, kind: 'delay', name: m[1], value: Number(m[2]) });
  }
  tokens.sort((a, b) => a.at - b.at);
  const frames = [];
  let current = {};
  let order = [];
  for (const token of tokens) {
    if (token.kind === 'delay') {
      if (order.length === 0 && token.value === 0) continue;
      frames.push({ angles: current, order, delayMs: token.value });
      current = {};
      order = [];
      continue;
    }
    current = { ...current, [token.name]: token.value };
    order = [...order, token.name];
  }
  if (order.length > 0) frames.push({ angles: current, order, delayMs: 0 });
  return frames;
};

const maxQuaternionDelta = (a, b) => {
  let worst = 0;
  for (const joint of JOINT_ORDER) {
    const left = a.find((j) => j.joint === joint)?.quaternion ?? [0, 0, 0, 1];
    const right = b.find((j) => j.joint === joint)?.quaternion ?? [0, 0, 0, 1];
    for (let i = 0; i < 4; i++) worst = Math.max(worst, Math.abs(left[i] - right[i]));
  }
  return worst;
};

// ===========================================================================
// PHASES 1-4: the app served by the bridge, replaying runWavePose
// ===========================================================================
const replayBridge = await startBridge({ replay: WAVE_FIXTURE }).catch((e) => die(e.message));
console.log(`[web] bridge serving apps/web/dist at ${replayBridge.url} (ws :${replayBridge.wsPort})`);

const page = await launchBrowser(replayBridge.url);
const reportPageErrors = (phase) => {
  const errors = page.errors();
  if (errors.length > 0) problems.push(`${phase}: the page logged ${errors.length} error(s): ${errors.slice(0, 3).join(' | ')}`);
};

const RENDER_STATS = 'window.__sesame.renderStats()';

/**
 * Wait until the render loop has applied the newest telemetry.
 *
 * Headless Chromium has no GPU here, so WebGL runs on SwiftShader at a few
 * frames per second while telemetry arrives every 20 ms. Comparing the scene
 * graph against the store without waiting is a race, and one that passes on a
 * fast machine and fails on a loaded one — the worst kind. `appliedPoseVersion`
 * is written by the same `useFrame` that writes the quaternions, so equality
 * with `storePoseVersion` means the scene is showing what the store holds.
 */
const waitSceneCaughtUp = (what = 'the render loop to apply the newest telemetry') =>
  waitFor(
    page.evaluate,
    RENDER_STATS,
    (s) => s !== null && s.appliedPoseVersion === s.storePoseVersion,
    what,
  );

/**
 * Wait until the robot has actually STOPPED, then until the scene has caught up.
 *
 * `waitSceneCaughtUp()` alone is not enough before a scene-vs-store comparison:
 * setting `window.__waving = false` only stops the *loop*, and the wave already
 * in flight keeps writing servo events for up to another 3.7 s. The store then
 * moves between the "caught up" poll and the read that follows it, and the
 * comparison fails on a race rather than on a defect — which is exactly the
 * false alarm this harness must not produce, since a stalled render loop is a
 * real failure mode it also has to be able to catch.
 */
const waitQuiescent = async (what = 'the robot to stop moving') => {
  const deadline = Date.now() + 30000;
  let last = -1;
  let stableSince = Date.now();
  while (Date.now() < deadline) {
    const stats = await page.evaluate(RENDER_STATS);
    const version = stats?.storePoseVersion ?? -1;
    if (version !== last) {
      last = version;
      stableSince = Date.now();
    } else if (Date.now() - stableSince > 700) {
      return waitSceneCaughtUp(what);
    }
    await sleep(120);
  }
  problems.push(`timed out waiting for ${what}`);
  return null;
};

await waitFor(
  page.evaluate,
  'typeof window.__sesame !== "undefined" && window.__sesame.ready',
  (v) => v === true,
  'the app to load assets/sesame.glb and build the rig',
  60000,
);
console.log('[web] app loaded, rig built');

/**
 * Put a dock section on screen before a phase reads its geometry.
 *
 * The panes are ALWAYS MOUNTED — collapsing a dock section is `hidden` on its
 * body, never an unmount, precisely so that phase 9's "zero `.src-line` nodes"
 * cannot pass vacuously and phase 10's 250 ms check evaluator keeps running.
 * But a hidden element has no rect, so anything that measures a scroll position
 * or clicks a React Flow node at real coordinates has to open its section
 * first, and saying so here is better than a phase that silently depended on a
 * default.
 *
 * Wide opens `inspector`, `modules` and `signal` by default and holds a set, so
 * this only ever ADDS; it never closes what another phase opened.
 */
/**
 * Give one dock section the whole dock, so a CAPTURE shows what its caption
 * claims.
 *
 * The panes used to be grid rows and columns, all on screen at once. They are
 * accordion sections in a scrolling dock now, and with four of them open the
 * dock holds more content than it can show — a screenshot taken without this
 * frames whichever section happens to be at the top of the scroller rather than
 * the pane the phase just proved something about.
 *
 * It changes no assertion. Collapsing a section is `hidden`, never an unmount:
 * every pane stays mounted and live, `querySelector` still finds its nodes,
 * `HTMLElement.click()` still reaches its buttons, and L6's 250 ms check
 * evaluator keeps running against real telemetry throughout. The one thing a
 * collapsed section does not have is a laid-out box, which is why anything
 * measuring geometry calls this (or `openSection`) FIRST rather than after.
 */
/**
 * The two kinds of pane the module-first shell has — Phase 4 W7.
 *
 * MODULES are mutually exclusive: `Architecture · Signal · Source · Learn ·
 * Lab`, one active at a time or none, chosen from the rail. PANEL cards —
 * Commands, Face and the joint glance — are always on the side panel above
 * Compact, so "opening" one is a no-op there and opens the sheet at Compact.
 *
 * Mirrored here rather than read out of the page so a phase that names a pane
 * that stopped existing fails loudly at the first call instead of silently
 * doing nothing.
 */
const MODULE_IDS = ['modules', 'signal', 'source', 'learn', 'lab'];
const PANEL_IDS = ['commands', 'face', 'inspector'];

const isModulePane = (id) => {
  if (!MODULE_IDS.includes(id) && !PANEL_IDS.includes(id)) die(`no such pane: ${id}`);
  return MODULE_IDS.includes(id);
};

/**
 * Put one pane on screen and nothing else in its column.
 *
 * For a module that is `setModule(id)`, which by construction deactivates
 * whatever else was up — there is no set to close. For a panel card it is the
 * Compact sheet, and a no-op above Compact where the panel is always there.
 */
const focusSection = async (evaluate, id) => {
  if (isModulePane(id)) {
    await evaluate(`window.__sesame.setModule(${JSON.stringify(id)})`);
  } else {
    await evaluate(
      `window.__sesame.setModule(null); window.__sesame.setSection(${JSON.stringify(id)}, true)`,
    );
  }
  // A repaint, plus React Flow's resize observer, plus the column's own
  // scroller back to the top now that a different pane is in it.
  await sleep(500);
  await evaluate(`void document.querySelector('[data-testid="module-body"]')?.scrollTo(0, 0)`);
  await sleep(250);
};

const openSection = async (evaluate, id) => {
  await evaluate(
    isModulePane(id)
      ? `window.__sesame.setModule(${JSON.stringify(id)})`
      : `window.__sesame.setSection(${JSON.stringify(id)}, true)`,
  );
  // One repaint plus React Flow's own resize observer, which needs a laid-out
  // box before it will place nodes at real coordinates.
  await sleep(450);
};

/** Put the module column's scroller back to the top before a capture. */
const scrollDockTop = (evaluate) =>
  evaluate(`void document.querySelector('[data-testid="module-body"]')?.scrollTo(0, 0)`);

/**
 * Click the real `[data-command="wave"]` button, and mean it.
 *
 * The command vocabulary moved from a fixed strip under the stage into the
 * control dock's `Commands` section, so the section is opened first and the
 * button is HIT-TESTED rather than merely found: `HTMLElement.click()` fires on
 * a `hidden` element too, and a check that a hidden button "works" is a check
 * that proves nothing. `elementFromPoint` at the button's own centre is what
 * separates "a reader could press this" from "React still has a handler".
 */
const clickWaveButton = async (evaluate) => {
  await openSection(evaluate, 'commands');
  return evaluate(`(() => {
    const button = document.querySelector('[data-command="wave"]');
    if (button === null) return { ok: false, why: 'no [data-command="wave"] button in the DOM' };
    if (button.disabled) return { ok: false, why: 'the wave button is disabled' };
    const rect = button.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0)
      return { ok: false, why: 'the wave button has no laid-out box' };
    const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
    if (hit === null || !(hit === button || button.contains(hit)))
      return { ok: false, why: 'something is covering the wave button: ' + (hit?.className ?? 'nothing') };
    button.click();
    return { ok: true, why: button.textContent, rect: { w: rect.width, h: rect.height } };
  })()`);
};

// `ready` means the rig exists, which is set from a `useEffect` — and that can
// fire before the render loop's first `useFrame`. The pose-dependent foot
// contact is computed IN `useFrame`, so sampling the world frame at that moment
// yields `footContactMm: null`, the rest-pose value never enters the sample set,
// and phase 1's vacuity guard fails on a startup race rather than on a defect.
await waitFor(
  page.evaluate,
  'window.__sesame.worldFrame()?.footContactMm ?? null',
  (v) => typeof v === 'number',
  'the render loop to compute a foot-contact height at the rest pose',
);

// --------------------------------------------------------------- phase 1
{
  const rest = await page.evaluate('window.__sesame.sceneJoints()');
  check(rest.length === 8, `the scene graph exposed ${rest.length} joints, expected 8`);
  check(
    rest.map((j) => j.joint).join(',') === JOINT_ORDER.join(','),
    `joints came back as ${rest.map((j) => j.joint).join(',')}, not the firmware enum order`,
  );
  for (const joint of rest) {
    check(
      Math.abs(joint.sceneCommandedDeg - 90) < 1e-6,
      `${joint.joint} is at ${joint.sceneCommandedDeg}° before anything was commanded; ` +
        `the GLB's rest transform is the identity, which is commandedDeg 90`,
    );
    check(
      joint.storeCommandedDeg === null,
      `${joint.joint} shows a commanded angle before anything was commanded`,
    );
  }

  /*
   * ============================ THE DEFAULT BACKEND — Phase 4 W8
   *
   * > *"The QEMU should be the default."*
   *
   * This page is served by the BRIDGE, so there is no lab host on its origin at
   * all — which is also what `pnpm demo:web` gives a reader. The contract under
   * test is therefore the awkward half of the request rather than the easy one:
   *
   *   1. the app opens on `qemu`, because that is the default and because
   *      silently landing on the host model when the emulator is unreachable is
   *      the substitution this whole project exists to refuse;
   *   2. and it SAYS SO. `[data-testid="panel-no-lab-host"]` is on the side
   *      panel, not behind a disclosure, because "an unexplained error" is a
   *      thing a user of this project has already reported once.
   *
   * The other two legs are asserted where they can be: phase 11 boots a lab
   * host with `--backend sim` and requires the app to have DETECTED it (below),
   * and phase 6 boots one with QEMU and requires it to stay.
   */
  const backend = await page.evaluate('window.__sesame.backendId()');
  check(
    backend === 'qemu',
    `with no lab host on the origin the app opened on "${backend}"; QEMU is the default and the ` +
      `absence of a lab host is not a reason to substitute the host model for the emulator`,
  );
  const noLabHostGuidance = await page.evaluate(`(() => {
    const el = document.querySelector('[data-testid="panel-no-lab-host"]');
    if (el === null) return { present: false };
    const box = el.getBoundingClientRect();
    return {
      present: true,
      text: el.innerText,
      laidOut: box.width > 0 && box.height > 0,
      insidePopover: el.closest('[data-popover]') !== null,
    };
  })()`);
  check(
    noLabHostGuidance.present === true &&
      noLabHostGuidance.laidOut === true &&
      noLabHostGuidance.insidePopover === false,
    `the app defaulted to QEMU with no lab host behind it and the panel does not say so: ` +
      `${JSON.stringify(noLabHostGuidance)}. The guidance may not live only inside a "more info" ` +
      `screen — that is an unexplained error with a paragraph hidden behind it.`,
  );
  phases.defaultBackend = {
    servedBy: 'bridge (no lab host)',
    opened: backend,
    guidanceOnPanel: noLabHostGuidance.present === true,
    guidanceInsidePopover: noLabHostGuidance.insidePopover === true,
  };

  // Phases 1-4 are about the SIMULATOR and the replay stream, so they choose
  // one explicitly from here. The default is asserted above rather than
  // depended on below.
  await page.evaluate('window.__sesame.setBackend("sim")');
  await waitFor(
    page.evaluate,
    'window.__sesame.backendId()',
    (v) => v === 'sim',
    'the app to switch to the simulator for phases 1-4',
  );
  await sleep(400);

  // ------------------------------------------- world-frame stability samples
  //
  // ISSUE-20260823-023. Everything above reads the POSE; nothing read the
  // FRAME the pose is expressed in, and that is precisely how a user came to
  // report "the 3d world seems to jump around" against a harness that was
  // green. The eight quaternions were right the whole time — the floor was
  // sliding under them, because the grid tracked the pose-dependent ground
  // plane while the robot root stayed pinned at the canonical origin.
  //
  // So: sample the world frame from BEFORE anything is commanded (the rest
  // pose, foot contact -31.115 mm) through the wave (-68.650 mm), and require
  // every fixed thing in the scene to be still while the pose moves 37.5 mm of
  // foot height underneath it. The first sample must be taken here, before the
  // first `run("wave")`: the slide happens on the very first commanded pose,
  // and a check that only samples mid-movement never sees it.
  const worldFrames = [];
  const sampleWorldFrame = async (label) => {
    const frame = await page.evaluate('window.__sesame.worldFrame()');
    if (frame === null) {
      problems.push(`worldFrame() returned null at "${label}" - the scene did not expose its frame`);
      return null;
    }
    worldFrames.push({ label, ...frame });
    return frame;
  };
  await sampleWorldFrame('rest, nothing commanded');
  const restShot = await page.shoot(
    'v3-world-frame-rest.png',
    'rest pose, nothing commanded - the fixed floor the wave is judged against',
  );

  // Run waves back to back until told to stop.
  //
  // One wave is 3.68 s of real firmware timing, and SwiftShader renders this
  // scene at a few frames per second, so a single pass can easily finish
  // between two polls. Looping the command removes that race without changing
  // what is being exercised: it is still `runWavePose`, still through the
  // model, still at the robot's own speed.
  await page.evaluate(`
    window.__waving = true;
    void (async () => {
      while (window.__waving) await window.__sesame.run('wave');
    })();
  `);

  const atL3 = async (want, tolerance = 1) =>
    waitFor(
      page.evaluate,
      'window.__sesame.sceneJoints()',
      (joints) => {
        const l3 = joints.find((j) => j.joint === 'L3');
        return l3 !== undefined && Math.abs(l3.sceneCommandedDeg - want) <= tolerance;
      },
      `the scene graph to show L3 at ${want}°`,
    );

  // 100 and 180 are the two L3 angles runWavePose alternates between, read
  // from the choreography (and independently from the Phase-0 fixture).
  const down = await atL3(100);
  await sampleWorldFrame('runWavePose, L3 at 100 deg');
  const downShot = await page.shoot(
    'v3-browser-wave-l3-100.png',
    'runWavePose, L3 down (100°) — simulated backend',
  );
  const up = await atL3(180);
  await sampleWorldFrame('runWavePose, L3 at 180 deg');
  const upShot = await page.shoot(
    'v3-browser-wave-l3-180.png',
    'runWavePose, L3 up (180°) — simulated backend',
  );

  // A few more, spread across the wave, so the check is not two lucky moments.
  for (let i = 0; i < 6; i++) {
    await sleep(180);
    await sampleWorldFrame(`runWavePose, sample ${i + 1}`);
  }

  await page.evaluate('window.__waving = false');

  const delta = maxQuaternionDelta(down, up);
  check(
    delta > 1e-3,
    `the joint quaternions in the scene graph barely changed between the two captures ` +
      `(max component delta ${delta.toExponential(3)}) — nothing actually moved`,
  );
  check(
    downShot.sha256 !== upShot.sha256,
    'the two screenshots are byte-identical — the second capture is the same frame',
  );
  for (const shot of [downShot, upShot, restShot]) {
    check(shot.bytes > 8000, `${shot.name} is only ${shot.bytes} bytes — the page probably rendered blank`);
  }

  // ------------------------------------------ world-frame stability, asserted
  //
  // Tolerance is 1e-6 mm - a nanometre, well below float32 mesh-storage noise
  // and seven orders of magnitude below the 37.5 mm slide this exists to catch.
  // Nothing in the scene is animated, so exact equality would very nearly hold;
  // the epsilon is only so OrbitControls' damping arithmetic cannot false-alarm.
  const FRAME_EPS_MM = 1e-6;
  const firstFrame = worldFrames[0];
  const drift = (a, b) => {
    if (!Array.isArray(a) || !Array.isArray(b)) return Number.NaN;
    let worst = 0;
    for (let i = 0; i < 3; i++) worst = Math.max(worst, Math.abs(a[i] - b[i]));
    return worst;
  };
  const worstDrift = {};
  let contactSpread = 0;
  if (firstFrame === undefined) {
    problems.push('no world-frame samples were taken');
  } else {
    for (const [key, what] of [
      ['groundWorldMm', 'the ground plane / grid'],
      ['robotRootWorldMm', 'the robot root'],
      ['cameraTargetMm', 'the OrbitControls target'],
      ['cameraPositionMm', 'the camera'],
    ]) {
      let worst = 0;
      let worstAt = '';
      for (const sample of worldFrames.slice(1)) {
        const d = drift(firstFrame[key], sample[key]);
        if (!(d >= 0)) {
          problems.push(`${what}: worldFrame().${key} was unreadable at "${sample.label}"`);
          continue;
        }
        if (d > worst) {
          worst = d;
          worstAt = sample.label;
        }
      }
      worstDrift[key] = worst;
      check(
        worst <= FRAME_EPS_MM,
        `${what} moved ${worst.toFixed(3)} mm in world space between "${firstFrame.label}" and ` +
          `"${worstAt}". Nothing in this scene may translate while a movement plays: the robot ` +
          `root is pinned at the canonical origin, so anything else that moves makes the whole ` +
          `world appear to jump (ISSUE-20260823-023).`,
      );
    }

    // Without this the checks above are vacuous: if the pose never changed, of
    // course nothing moved. The foot-contact height is the pose-dependent value
    // the grid used to chase, so a wide spread here is the proof that the wave
    // really did put the scene through the condition that used to break it.
    const contacts = worldFrames.map((f) => f.footContactMm).filter((v) => typeof v === 'number');
    contactSpread = contacts.length === 0 ? 0 : Math.max(...contacts) - Math.min(...contacts);
    check(
      contactSpread > 1,
      `the pose-dependent foot-contact height varied by only ${contactSpread.toFixed(3)} mm across ` +
        `the wave, so the world-stability assertions above proved nothing`,
    );

    // And the floor is where the ASSET says the reference pose's floor is -
    // read out of the GLB, not a number typed into the viewer.
    const assetGround = await page.evaluate(
      'window.__sesame.assetFacts().groundPlane.atRunStandPoseMm',
    );
    check(
      Math.abs((firstFrame.groundWorldMm?.[1] ?? Number.NaN) - assetGround) <= FRAME_EPS_MM,
      `the grid sits at ${firstFrame.groundWorldMm?.[1]} mm; the asset records the reference ` +
        `pose's ground plane at ${assetGround} mm`,
    );
    check(
      drift(firstFrame.robotRootWorldMm, [0, 0, 0]) <= FRAME_EPS_MM,
      `the GLB root is at ${JSON.stringify(firstFrame.robotRootWorldMm)} mm, not the canonical ` +
        `origin - every world-space number this app reports is measured from there`,
    );
    console.log(
      `[web] world frame stable over ${worldFrames.length} samples: ground drift ` +
        `${worstDrift.groundWorldMm.toExponential(2)} mm, root drift ` +
        `${worstDrift.robotRootWorldMm.toExponential(2)} mm, orbit-target drift ` +
        `${worstDrift.cameraTargetMm.toExponential(2)} mm, while the foot contact swept ` +
        `${contactSpread.toFixed(3)} mm`,
    );
  }

  // The scene must follow the telemetry, not lead it — checked once the robot
  // has stopped AND the render loop has caught up, so this is a correctness
  // assertion and not a race.
  await waitQuiescent('the wave to finish before comparing the scene against the store');
  const settled = await page.evaluate('window.__sesame.sceneJoints()');
  for (const joint of settled) {
    check(
      joint.storeCommandedDeg !== null &&
        Math.abs(joint.sceneCommandedDeg - joint.storeCommandedDeg) < 1e-4,
      `${joint.joint}: the scene graph says ${joint.sceneCommandedDeg}° but telemetry said ` +
        `${joint.storeCommandedDeg}°`,
    );
  }

  const snapshot = await page.evaluate('window.__sesame.snapshot()');
  check(
    snapshot.renderStats !== null && snapshot.renderStats.frames > 10,
    `the render loop drew ${snapshot.renderStats?.frames} frames — it is stalled, and every ` +
      `scene-graph reading above would be stale`,
  );
  check(
    typeof snapshot.canvasPixels === 'number' && snapshot.canvasPixels > 2000,
    `only ${snapshot.canvasPixels} non-background pixels came back out of the WebGL drawing ` +
      `buffer — the renderer produced no image`,
  );
  check(
    snapshot.provenance.driving === 'simulated',
    `the app says the scene is driven by "${snapshot.provenance.driving}", expected "simulated"`,
  );
  check(
    snapshot.provenance.counts.observed === 0,
    `the simulated backend produced ${snapshot.provenance.counts.observed} "observed" events; ` +
      `a simulator must never upgrade its own provenance`,
  );

  phases.simWave = {
    ok: problems.length === 0,
    maxQuaternionDelta: delta,
    worldFrame: {
      toleranceMm: FRAME_EPS_MM,
      worstDriftMm: worstDrift,
      footContactSpreadMm: contactSpread,
      samples: worldFrames,
    },
    canvasPixels: snapshot.canvasPixels,
    l3Down: down.find((j) => j.joint === 'L3'),
    l3Up: up.find((j) => j.joint === 'L3'),
    provenance: snapshot.provenance,
  };
}

// --------------------------------------------------------------- phase 2
{
  // runWavePose ends with runStandPose(1), so waiting for the command to
  // finish is also waiting for the stand pose. Command it explicitly anyway,
  // so the check does not depend on the tail of another movement.
  await page.evaluate('window.__sesame.run("stand")');
  await waitSceneCaughtUp('the scene to settle into the stand pose');

  const verification = await page.evaluate('window.__sesame.verifyStandPose()');
  check(
    verification.ok,
    `in-browser stand-pose verification failed: ${verification.problems.join('; ')}`,
  );
  check(
    verification.referencePose === 'runStandPose',
    `the asset's reference pose is "${verification.referencePose}"`,
  );
  for (const joint of verification.perJoint) {
    check(
      joint.storeCommandedDeg === joint.expectedDeg,
      `${joint.joint}: the model commanded ${joint.storeCommandedDeg}°, the asset's reference pose ` +
        `says ${joint.expectedDeg}° — V1's choreography and V2's CAD reading disagree`,
    );
  }
  console.log(
    `[web] stand pose in-browser: max joint error ${verification.maxJointAngleErrorDeg.toExponential(3)}°, ` +
      `ground plane ${verification.groundPlaneMm?.toFixed(6)} mm vs V2's ${verification.v2GroundPlaneMm} mm ` +
      `(residual ${verification.groundPlaneResidualMm?.toExponential(3)} mm)`,
  );
  phases.standPose = verification;
}

// --------------------------------------------------------------- phase 3
{
  await page.evaluate('window.__sesame.setFace("happy")');
  await sleep(250);
  const withFace = await page.evaluate('window.__sesame.oled()');

  check(withFace.litPixels > 200, `the OLED shows only ${withFace.litPixels} lit pixels for "happy"`);
  check(withFace.base64.length === 1368, `the payload is ${withFace.base64.length} chars, expected 1368`);
  check(withFace.face?.name === 'happy', `the panel reports face "${withFace.face?.name}"`);
  check(
    withFace.source.pixelProvenance === 'inferred',
    `the rendered pixels claim provenance "${withFace.source.pixelProvenance}"; nothing transmitted ` +
      `them, so they are inferred`,
  );
  check(
    withFace.source.triggerProvenance === 'simulated',
    `the face event that triggered the draw claims "${withFace.source.triggerProvenance}"`,
  );
  check(withFace.projectedIn3d, 'the oled_screen material is not carrying the panel canvas as its texture');
  check(
    withFace.textureFlipY === false,
    `the CanvasTexture has flipY = ${withFace.textureFlipY}; V2 §6 requires false for this quad's UVs`,
  );

  // Bring the OLED panel into view: the evidence has to show the 8x pixel
  // canvas and the 3D projection in the same frame.
  await focusSection(page.evaluate, 'face');
  await page.evaluate(
    `void document.querySelector('[data-testid="oled"]')?.scrollIntoView({ block: 'start' })`,
  );
  await sleep(400);
  await page.shoot(
    'v4-browser-oled-face.png',
    'virtual OLED rendering a real face (happy): the 8x logical framebuffer on the right, the same pixels projected onto oled_screen in 3D on the left',
  );

  // Now the upstream bug, on a panel that has never drawn: honestly blank.
  await page.evaluate('window.__sesame.reset()');
  await page.evaluate('window.__sesame.setFace("stand")');
  await sleep(350);
  const blank = await page.evaluate('window.__sesame.oled()');
  check(blank.litPixels === 0, `setFace("stand") after a reset lit ${blank.litPixels} pixels; expected 0`);
  check(blank.writes === 0, `setFace("stand") caused ${blank.writes} display() writes; expected 0`);
  check(
    blank.emptyFace !== null && /ISSUE-20260823-004/.test(blank.emptyFace.reason),
    'the UI did not explain why the screen is blank; a blank panel with no explanation looks like a bug ' +
      'in the viewer rather than the upstream bug it is',
  );

  await page.shoot(
    'v4-browser-oled-empty-face.png',
    'setFace("stand") drew nothing: an honestly blank 128x64 panel plus the reason, rather than a substituted placeholder face (ISSUE-20260823-004)',
  );

  // ...and on a panel that already had a face: retained, exactly as the glass.
  await page.evaluate('window.__sesame.setFace("angry")');
  await sleep(300);
  const angry = await page.evaluate('window.__sesame.oled()');
  check(angry.litPixels > 0, 'the "angry" face drew no pixels');
  await page.evaluate('window.__sesame.setFace("stand")');
  await sleep(300);
  const retained = await page.evaluate('window.__sesame.oled()');
  check(
    retained.base64 === angry.base64,
    'the panel changed when setFace("stand") drew nothing; the glass would have kept the old frame',
  );

  phases.oled = {
    happy: { litPixels: withFace.litPixels, payloadChars: withFace.base64.length },
    projectedIn3d: withFace.projectedIn3d,
    textureFlipY: withFace.textureFlipY,
    pixelProvenance: withFace.source.pixelProvenance,
    triggerProvenance: withFace.source.triggerProvenance,
    emptyFaceBlank: blank.litPixels === 0,
    emptyFaceExplained: blank.emptyFace?.reason ?? null,
    emptyFaceRetainsPreviousFrame: retained.base64 === angry.base64,
  };
}

// --------------------------------------------------------------- phase 4
{
  await page.evaluate('window.__sesame.setBackend("bridge")');
  await waitFor(
    page.evaluate,
    'window.__sesame.status().connection',
    (v) => v === 'connected',
    'the app to connect to the bridge WebSocket',
  );
  const state = await waitFor(
    page.evaluate,
    'window.__sesame.snapshot()',
    (s) => s.provenance.totalEvents > 20 && s.sceneJoints.some((j) => j.storeCommandedDeg !== null),
    'telemetry to arrive over the bridge and reach the scene',
  );

  check(state.backend === 'bridge', `the app reports backend "${state.backend}"`);

  //
  // The claim is that telemetry arriving over the WebSocket REACHES THE SCENE,
  // so the comparison is polled until the two agree rather than sampled once
  // after `waitSceneCaughtUp()`. The replay is still streaming here: the store
  // can move between the "caught up" poll and the read that follows it, and a
  // single sample then fails on a race rather than on a defect — the same false
  // alarm `waitQuiescent()` exists to prevent elsewhere in this file. Nothing
  // is weakened: if the scene never converges, the last reading is asserted and
  // fails exactly as before, and a stalled render loop still never converges.
  await waitSceneCaughtUp('the scene to apply telemetry arriving over the WebSocket');
  let wired = await page.evaluate('window.__sesame.sceneJoints()');
  const agrees = (rows) => {
    const driven = rows.filter((j) => j.storeCommandedDeg !== null);
    return (
      driven.length === 8 &&
      driven.every((j) => Math.abs(j.sceneCommandedDeg - j.storeCommandedDeg) < 1e-4)
    );
  };
  for (let attempt = 0; attempt < 40 && !agrees(wired); attempt += 1) {
    await sleep(150);
    wired = await page.evaluate('window.__sesame.sceneJoints()');
  }
  const commanded = wired.filter((j) => j.storeCommandedDeg !== null);
  check(commanded.length === 8, `only ${commanded.length}/8 joints were driven over the WebSocket`);
  for (const joint of commanded) {
    check(
      Math.abs(joint.sceneCommandedDeg - joint.storeCommandedDeg) < 1e-4,
      `${joint.joint}: scene ${joint.sceneCommandedDeg}° vs wire ${joint.storeCommandedDeg}° — the scene never caught up with the WebSocket stream`,
    );
  }
  // A replayed fixture did not happen on any robot, and the bridge says so.
  const settledProvenance = await page.evaluate('window.__sesame.provenance()');
  check(
    settledProvenance.driving === 'simulated',
    `the bridge-fed scene claims provenance "${settledProvenance.driving}"; a --replay stream ` +
      `must default to simulated`,
  );
  // The bridge's own lifecycle lines are `observed` — the bridge really did
  // connect — but they are facts about the plumbing, not about the robot, and
  // must not be counted as robot telemetry.
  check(
    settledProvenance.counts.observed === 0,
    `${settledProvenance.counts.observed} "observed" events reached the robot's event stream from a ` +
      `replayed fixture; bridge-origin envelopes are leaking into it`,
  );

  // The fixture loops, so more telemetry is coming. Wait for the store to
  // advance and for the scene to apply it, rather than for a wall-clock
  // interval that a slow renderer can sleep straight through.
  const before = await page.evaluate('window.__sesame.sceneJoints()');
  const startVersion = (await page.evaluate(RENDER_STATS)).storePoseVersion;
  await waitFor(
    page.evaluate,
    RENDER_STATS,
    (s) => s !== null && s.storePoseVersion > startVersion + 8,
    'more servo telemetry to arrive over the bridge',
  );
  await waitSceneCaughtUp();
  const after = await page.evaluate('window.__sesame.sceneJoints()');
  const delta = maxQuaternionDelta(before, after);
  check(delta > 1e-3, `nothing moved as bridge telemetry arrived (delta ${delta.toExponential(3)})`);

  // Back to the top of the dock: this shot's evidence is the backend switch and
  // the provenance banner, both of which live in the inspector section now.
  // (`.sidebar` was the old third column; the dock's scroller replaced it.)
  await scrollDockTop(page.evaluate);
  await sleep(400);
  await page.shoot(
    'v3-browser-bridge-backend.png',
    'the same scene driven over the Phase-0 bridge WebSocket (replay fixture), served from the bridge’s own HTTP server',
  );

  phases.bridgeReplay = {
    ok: true,
    totalEvents: settledProvenance.totalEvents,
    provenance: settledProvenance,
    maxQuaternionDelta: delta,
    servedBy: 'emulator/bridge --serve-viewer --viewer-dir apps/web/dist (no bridge changes)',
  };
}


// --------------------------------------------------------------- phase 7
//
// PHASE 7: the architecture graph and "See the Signal", cross-linked.
//
// Runs on the simulator because it is the backend that can be driven AND the
// one that can thread a trace id end to end, so it is the only place the
// difference between a causal join and a time-window guess is demonstrable.
// The QEMU leg of the same feature is asserted in phase 6.
//
// Everything below is read out of the live page: the architecture layout the
// component actually rendered, the trace rows the panel actually shows, and —
// for the cross-link — `MeshStandardMaterial.emissiveIntensity` on the joint
// subtrees, because a React `selected` prop can be perfectly correct while the
// mesh stays unlit.
{
  await page.evaluate('window.__sesame.setBackend("sim")');
  await waitFor(
    page.evaluate,
    'window.__sesame.status().connection',
    (c) => c === 'connected',
    'the simulator backend to come back up for the architecture/trace phase',
  );

  /*
   * ONE MODULE AT A TIME — Phase 4 W7, and this is where it costs something.
   *
   * V8's argument for splitting the workbench in half was that the graph and
   * the trace have to be visible AT ONCE, because the cross-highlight is the
   * feature and a scroll between them destroys it. §11.3 overrides that with a
   * direct instruction — *"The Architecture, Signals, Source and Learn modules
   * should only have one active at a time"* — so the two are now a module
   * SWITCH apart rather than a glance apart.
   *
   * What is asserted instead, and it is the honest replacement rather than a
   * relaxation: the selection SURVIVES the switch. Selecting a node in the
   * graph and then switching to Signal must find that node's rows already
   * highlighted, because `SelectionState` is one object and neither pane owns
   * a copy. That is checked in §"cross-highlight across a module switch" below.
   */
  await openSection(page.evaluate, 'modules');
  const bothOpen = await page.evaluate('window.__sesame.shell()');
  check(
    bothOpen.breakpoint === 'medium',
    `phases 1-11 run at ${DEFAULT_WINDOW.width}x${DEFAULT_WINDOW.height}, which the module-first ` +
      `shell classifies as Medium — Wide is now the width at which the ORDINARY layout holds the ` +
      `whole 63-node graph (>= 2314 px of viewport). Got "${bothOpen.breakpoint}".`,
  );
  check(
    bothOpen.activeModule === 'modules' && bothOpen.openSections.includes('modules'),
    `the architecture module is not the active one: ${JSON.stringify({
      active: bothOpen.activeModule,
      open: bothOpen.openSections,
    })}`,
  );
  // The exclusivity, asserted as a COUNT of laid-out module panes rather than
  // as "the others are closed": there is exactly one, at every width, in every
  // state, and a second one would mean the state had grown a second slot.
  check(
    bothOpen.moduleColumn.laidOutPanes.length === 1 &&
      bothOpen.moduleColumn.laidOutPanes[0] === 'modules',
    `${bothOpen.moduleColumn.laidOutPanes.length} module pane(s) have a laid-out box ` +
      `(${JSON.stringify(bothOpen.moduleColumn.laidOutPanes)}); one module is active at a time`,
  );

  // ------------------------------------------------- the collapsed top level
  const collapsed = await page.evaluate('window.__sesame.archGraph()');
  const REPORT_TOP_LEVEL = [
    'esp32',
    'movement',
    'face',
    'network',
    'serial',
    'servos',
    'oled',
    'http-api',
    'developer',
  ];
  check(
    JSON.stringify([...collapsed.visibleNodeIds].sort()) ===
      JSON.stringify([...REPORT_TOP_LEVEL].sort()),
    `the collapsed graph drew ${JSON.stringify(collapsed.visibleNodeIds)}, expected exactly the ` +
      `report's top level ${JSON.stringify(REPORT_TOP_LEVEL)}`,
  );
  const collapsedPairs = collapsed.edges.map((e) => `${e.source}->${e.target}`);
  for (const pair of [
    'esp32->movement',
    'esp32->face',
    'esp32->network',
    'esp32->serial',
    'movement->servos',
    'face->oled',
    'network->http-api',
    'serial->developer',
  ]) {
    check(collapsedPairs.includes(pair), `the collapsed graph is missing the edge ${pair}`);
  }
  check(
    collapsed.upstreamCommit === '401730514cefed738710d22303e84b0dcd6b76d0',
    `the graph cites upstream ${collapsed.upstreamCommit}, not the pinned commit`,
  );
  check(
    collapsed.totalNodes > 60,
    `only ${collapsed.totalNodes} nodes were generated from hardware-map.json`,
  );
  // The claims the data cannot express are enumerated, not hidden.
  check(
    collapsed.handAuthored.length === 5,
    `the graph declares ${collapsed.handAuthored.length} hand-authored claims: ` +
      JSON.stringify(collapsed.handAuthored),
  );
  check(
    collapsed.unresolvedNodeIds.includes('servo.mg90s'),
    'the MG90S node is not marked unresolved — hardware-map.json records no torque, slew or travel',
  );

  // ---------------------------------------------------------------- W4 setup
  //
  // The three floors this phase measures the focus workspace against. They are
  // named here rather than inlined because two of them REPLACE a rule rather
  // than relaxing it, and a replacement that has no name cannot be looked up.
  const W4_STAGE_AREA_FLOOR_PCT = 50;
  /** What the stage keeps INSTEAD of the area rule, per side, in CSS pixels. */
  const W4_FOCUS_STAGE_FLOOR_PX = 220;
  /** Non-background share of the middle of the drawing buffer. Phase 12's floor. */
  const W4_ROBOT_PIXEL_FLOOR_PCT = 2;
  /** Filled in below; reported with the phase. */
  let archPathTypeReading = null;
  let w4Workspace = null;

  /**
   * How much of the MIDDLE of the drawing buffer is not the clear colour.
   *
   * The same read phase 12 does, inlined here because the focus workspace's
   * exemption is granted on the condition that Sesame stays LIVE, and a layout
   * box can be exactly the right size and completely empty.
   */
  const w4RobotPixels = (evaluate) =>
    evaluate(`(() => {
      let canvas = null;
      let gl = null;
      for (const candidate of document.querySelectorAll('canvas')) {
        const context = candidate.getContext('webgl2') ?? candidate.getContext('webgl');
        if (context !== null) { canvas = candidate; gl = context; break; }
      }
      if (gl === null) return null;
      const w = Math.min(canvas.width, 400);
      const h = Math.min(canvas.height, 400);
      const x = Math.max(0, Math.floor((canvas.width - w) / 2));
      const y = Math.max(0, Math.floor((canvas.height - h) / 2));
      const pixels = new Uint8Array(w * h * 4);
      gl.readPixels(x, y, w, h, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
      let n = 0;
      for (let i = 0; i < pixels.length; i += 4) {
        if (Math.abs(pixels[i] - 0x0d) > 6 || Math.abs(pixels[i + 1] - 0x10) > 6 || Math.abs(pixels[i + 2] - 0x15) > 6) n += 1;
      }
      return { lit: n, sampled: w * h, sharePct: (n / (w * h)) * 100 };
    })()`);

  // ================================================================
  // W4: WHAT A LAPTOP ACTUALLY GETS
  // ================================================================
  //
  // This is the assertion the user's complaint has been waiting three
  // workstreams for. The analysis dock at Wide gives the architecture pane
  // about 400 px, and 400 px of a 63-node spatial diagram is what W1 measured
  // at 8.0 px of node label and 3.8 px at 880. So the ORDINARY layout must
  // mount the causal path here, at every window this harness visits, and its
  // text must clear the 14 px floor with no zoom-surface exemption.
  const archOrdinary = await page.evaluate('window.__sesame.archGraph()');
  check(
    archOrdinary.mode === 'path',
    `at ${DEFAULT_WINDOW.width}x${DEFAULT_WINDOW.height} the architecture pane mounted the ` +
      `"${archOrdinary.mode}" representation in a ${archOrdinary.surfaceWidthPx} px surface. The ` +
      `brief's rule is a causal path below 720 px, and no dock or workbench in this shell reaches ` +
      `720 px - which is the point: the 63-node map does not live in the ordinary layout any more.`,
  );
  check(
    archOrdinary.surfaceWidthPx !== null && archOrdinary.surfaceWidthPx < 720,
    `the architecture surface is ${archOrdinary.surfaceWidthPx} px wide in the ordinary layout; ` +
      `the representation above is only correct if that is under 720`,
  );

  // React chose it. The proof is a DOM that has no React Flow in it at all.
  const archMounted = await page.evaluate(`(() => ({
    canvases: document.querySelectorAll('[data-pane="modules"] .arch-canvas').length,
    flowNodes: document.querySelectorAll('[data-pane="modules"] .react-flow__node').length,
    zoomSurfaces: document.querySelectorAll('[data-pane="modules"] [data-zoom-surface]').length,
    steps: [...document.querySelectorAll('[data-arch-path-step]')].map((n) => n.getAttribute('data-arch-path-step')),
  }))()`);
  check(
    archMounted.canvases === 0 && archMounted.flowNodes === 0,
    `the causal-path representation still has ${archMounted.canvases} React Flow canvas(es) and ` +
      `${archMounted.flowNodes} flow node(s) in the DOM. CSS must not be what hides the graph: ` +
      `mounting it and hiding it wastes the layout work and leaves two DOMs claiming to be the ` +
      `same diagram, which is what the brief says not to do.`,
  );
  check(
    archMounted.zoomSurfaces === 0,
    `the causal-path representation declares ${archMounted.zoomSurfaces} [data-zoom-surface]. ` +
      `That marker is W1's exemption for the one surface a reader zooms, and it now belongs to ` +
      `the full graph alone - claiming it here would let this workstream's own debt back in.`,
  );

  // The chain, not a subset of the map: the brief's worked example is
  // ESP32 -> Movement -> 8 Servos -> setServoAngle -> ESP32Servo -> LEDC ->
  // GPIO -> MG90S, and every one of those is a real edge in the generated data.
  for (const id of [
    'esp32',
    'movement',
    'servos',
    'servo.setServoAngle',
    'servo.esp32servo',
    'servo.ledc',
    'servo.gpio',
    'servo.mg90s',
  ]) {
    check(
      archMounted.steps.includes(id),
      `the causal path does not walk ${id}; it drew ${JSON.stringify(archMounted.steps)}`,
    );
  }

  // THE MEASUREMENT. Every run of text inside the architecture panel, times
  // the transform actually in force, against the 14 px floor.
  const archPathType = await page.evaluate(`(() => {
    const root = document.querySelector('[data-testid="architecture-graph"]');
    if (root === null) return null;
    const scaleOf = (el) => {
      let scale = 1, node = el, guard = 0;
      while (node !== null && node !== document.documentElement && guard < 60) {
        const t = getComputedStyle(node).transform;
        if (t !== 'none' && t !== '') {
          const nums = t.slice(t.indexOf('(') + 1, -1).split(',').map(Number);
          if (t.startsWith('matrix3d') && nums.length >= 6) scale *= Math.abs(nums[5]);
          else if (nums.length >= 4) scale *= Math.abs(nums[3]);
        }
        node = node.parentElement; guard += 1;
      }
      return scale;
    };
    let worst = null, runs = 0;
    for (const el of root.querySelectorAll('*')) {
      const cs = getComputedStyle(el);
      if (cs.display === 'none' || cs.visibility === 'hidden') continue;
      let own = '';
      for (const n of el.childNodes) if (n.nodeType === 3) own += n.nodeValue;
      if (own.trim().length === 0) continue;
      const box = el.getBoundingClientRect();
      if (box.width < 1 || box.height < 1) continue;
      runs += 1;
      const px = Math.round(parseFloat(cs.fontSize) * scaleOf(el) * 100) / 100;
      if (worst === null || px < worst.px) worst = { px, text: own.trim().slice(0, 40) };
    }
    return { worst, runs };
  })()`);
  check(
    archPathType !== null && archPathType.runs > 12,
    `the causal path drew ${archPathType?.runs} runs of text; a nine-step chain with its ` +
      `relations and summaries is more than that, so this measurement would have been vacuous`,
  );
  check(
    archPathType !== null &&
      archPathType.worst !== null &&
      archPathType.worst.px >= TEXT_FLOOR_PX - 0.01,
    `the smallest text ON SCREEN in the causal path is ${archPathType?.worst?.px}px ` +
      `(${JSON.stringify(archPathType?.worst?.text)}), below the ${TEXT_FLOOR_PX}px floor. W1 ` +
      `measured 8.0px here for the same pane and handed it to W4; this is the number that says ` +
      `whether three representations actually fixed it.`,
  );
  archPathTypeReading = archPathType;

  await scrollDockTop(page.evaluate);
  await sleep(500);
  await focusSection(page.evaluate, 'modules');
  const graphPathShot = await page.shoot(
    'w4-architecture-causal-path.png',
    'the causal-path representation in the ordinary layout at 1760x1000, where the module column gives the architecture 670px of surface: ESP32 to MG90S as an indented chain with the derived edge labels between the steps, every run of text at or above the 14px floor - the same information React Flow drew at 8.0px in a 397px dock',
  );

  // -------------------------------------------------- fire a command, by click
  await page.evaluate('window.__sesame.reset()');
  const worldBefore = await page.evaluate('window.__sesame.worldFrame()');
  const traceClick = await clickWaveButton(page.evaluate);
  check(traceClick.ok, `could not click the wave button for the trace: ${traceClick.why}`);

  // Wait for the ladder to be complete FOR EVERY JOINT THE MOVEMENT WRITES,
  // not merely for the first `visual.joint` row to appear. `runWavePose` writes
  // R1 first, so "any visual row exists" is satisfied about 200 ms in, with
  // three quarters of the movement still to run — and every assertion below
  // would then be about a quarter of a wave. Waiting on the last rung of the
  // slowest joint is waiting for the real thing.
  const WAVE_JOINTS = ['R1', 'L2', 'R4', 'L3'];
  const trace = await waitFor(
    page.evaluate,
    'window.__sesame.trace()',
    (t) =>
      t !== null &&
      WAVE_JOINTS.every((joint) =>
        t.rows.some((r) => r.layer === 'visual.joint' && r.joint === joint),
      ),
    'the causal trace to reach visual.joint for every joint runWavePose writes',
    90000,
  );

  // --------------------------------------------------------- causal ordering
  const ranks = trace.rows.map((r) => r.rank);
  check(
    ranks.every((r, i) => i === 0 || ranks[i - 1] <= r),
    `the trace rows are not in causal order: ${JSON.stringify(trace.rows.map((r) => r.layer))}`,
  );
  const LADDER = [
    'ui.command',
    'http.request',
    'firmware.command',
    'movement.enter',
    'servo.target',
    'pwm.output',
    'joint.target',
    'visual.joint',
  ];
  for (const layer of LADDER) {
    check(trace.rows.some((r) => r.layer === layer), `the trace has no ${layer} row`);
  }
  // And the DOM is causally ordered too. Asserted on the RENDERED `data-rank`
  // rather than by comparing the DOM against a separately-fetched store
  // snapshot: a movement is still running, so those two reads are of different
  // moments and comparing them would be a race, not a check. What must hold at
  // every moment is that the list a learner is looking at reads top to bottom
  // in causal order.
  //
  // Polled rather than read once. The store is ready — the `waitFor` above
  // proved it — but the trace PANEL repaints on its own 260 ms tick, so a
  // single read can legitimately catch a DOM that is one tick behind the store
  // and report a seven-rung ladder for an eight-rung trace. That is a race in
  // the reading, not a defect in the app, and it surfaces whenever anything
  // else on the page makes a repaint arrive a little later. The loop keeps the
  // LAST value, so a genuine missing layer still fails with the same message.
  const DOM_ROWS_EXPR = `Array.from(document.querySelectorAll('[data-trace-row]')).map((n) => ({
       layer: n.getAttribute('data-layer'),
       rank: Number(n.getAttribute('data-rank')),
     }))`;
  let domRows = [];
  const domDeadline = Date.now() + 8000;
  for (;;) {
    domRows = await page.evaluate(DOM_ROWS_EXPR);
    if (new Set(domRows.map((r) => r.layer)).size >= LADDER.length) break;
    if (Date.now() >= domDeadline) break;
    await sleep(120);
  }
  check(
    domRows.length >= LADDER.length,
    `the trace panel rendered ${domRows.length} rows for an eight-layer ladder`,
  );
  check(
    domRows.every((r, i) => i === 0 || domRows[i - 1].rank <= r.rank),
    `the rendered trace rows are not in causal order: ${JSON.stringify(domRows.map((r) => r.layer))}`,
  );
  check(
    JSON.stringify([...new Set(domRows.map((r) => r.layer))]) === JSON.stringify(LADDER),
    `the rendered trace shows the layers as ${JSON.stringify([...new Set(domRows.map((r) => r.layer))])}, ` +
      `expected the report's ladder ${JSON.stringify(LADDER)}`,
  );

  // ------------------------------------------------ per-row provenance, exact
  const rowByLayer = new Map();
  for (const row of trace.rows) if (!rowByLayer.has(row.layer)) rowByLayer.set(row.layer, row);
  const EXPECTED = {
    'ui.command': { provenance: 'observed', badge: 'OBSERVED IN THIS APP' },
    'http.request': { provenance: 'inferred', badge: 'INFERRED FOR EXPLANATION' },
    'firmware.command': { provenance: 'inferred', badge: 'INFERRED FOR EXPLANATION' },
    'movement.enter': { provenance: 'simulated', badge: 'SIMULATED' },
    'servo.target': { provenance: 'simulated', badge: 'SIMULATED' },
    'pwm.output': { provenance: 'inferred', badge: 'INFERRED FOR EXPLANATION' },
    'joint.target': { provenance: 'inferred', badge: 'INFERRED FOR EXPLANATION' },
    'visual.joint': { provenance: 'inferred', badge: 'INFERRED FOR EXPLANATION' },
  };
  for (const [layer, want] of Object.entries(EXPECTED)) {
    const row = rowByLayer.get(layer);
    check(
      row !== undefined && row.provenance === want.provenance && row.badge === want.badge,
      `${layer}: the UI shows provenance ${JSON.stringify(row?.provenance)} / badge ` +
        `${JSON.stringify(row?.badge)}, expected ${want.provenance} / ${want.badge}`,
    );
  }

  // The one that matters most. `pwm.output` must be inferred on EVERY backend:
  // Q3 proved QEMU's LEDC emits no waveform, and there is no physical robot, so
  // no pin has ever produced the pulse this row prints.
  const pwm = rowByLayer.get('pwm.output');
  check(
    pwm !== undefined && pwm.provenance === 'inferred' && pwm.physicallyObserved === false,
    'pwm.output is not marked inferred — the pulse figure is computed here, never observed',
  );
  check(
    typeof pwm?.label === 'string' && /\d+ ticks/.test(pwm.label) && /µs/.test(pwm.label),
    `pwm.output shows ${JSON.stringify(pwm?.label)}, expected a real quantised tick count and pulse`,
  );
  check(
    !/channel\s*=\s*\d/i.test(`${pwm?.label ?? ''}`),
    `pwm.output printed a channel number (${pwm?.label}); no artefact in this repository records ` +
      `which LEDC channel carries which servo`,
  );

  // Nothing, anywhere, ever.
  const claimsHardware = trace.rows.filter((r) => r.physicallyObserved || /ON HARDWARE/.test(r.badge));
  check(
    claimsHardware.length === 0,
    `${claimsHardware.length} trace row(s) claim physical observation: ` +
      JSON.stringify(claimsHardware.map((r) => r.layer)),
  );

  // The simulator threads the id; that is what makes this join causal.
  check(
    trace.carriedTraceId === true,
    'the simulator did not thread the trace id back — the join would be a time window, not causal',
  );
  const wireRows = trace.rows.filter((r) => r.match !== 'app-local');
  check(
    wireRows.length > 0 && wireRows.every((r) => r.match === 'trace-id'),
    `on the simulator every adopted row must be matched by trace id; got ` +
      JSON.stringify(wireRows.map((r) => [r.layer, r.match])),
  );

  // The wave's own joints, from the extracted choreography.
  //
  // `runWavePose` ends by calling `runStandPose(1)`, which writes all eight, so
  // the trace legitimately carries more than the four the wave itself sets --
  // and the trace id proves those extra rows really do belong to this command
  // rather than to something that happened to overlap. What must hold is that
  // the four the choreography names are all there, and that the rows are in
  // firmware enum order rather than alphabetical.
  const tracedJoints = [...new Set(trace.rows.filter((r) => r.joint !== null).map((r) => r.joint))];
  for (const joint of WAVE_JOINTS) {
    check(
      tracedJoints.includes(joint),
      `runWavePose writes ${joint} in hardware-map.json but the trace has no row for it ` +
        `(traced: ${JSON.stringify(tracedJoints)})`,
    );
  }
  const ENUM_ORDER = ['R1', 'R2', 'L1', 'L2', 'R4', 'R3', 'L3', 'L4'];
  const servoRowJoints = trace.rows.filter((r) => r.layer === 'servo.target').map((r) => r.joint);
  check(
    JSON.stringify(servoRowJoints) ===
      JSON.stringify(ENUM_ORDER.filter((j) => servoRowJoints.includes(j))),
    `the trace lists servo rows as ${JSON.stringify(servoRowJoints)}; they must follow the firmware ` +
      `enum order R1 R2 L1 L2 R4 R3 L3 L4, in which R4 really does come before R3`,
  );

  // The graph and the trace are two dock sections open together, so the trace is
  // already on screen; what needs scrolling is the row list inside it, down to
  // the row this feature is really about.
  await sleep(350);
  await focusSection(page.evaluate, 'signal');
  const traceShot = await page.shoot(
    'v8-see-the-signal.png',
    'the causal trace for one Wave: eight layers, each with its own provenance, origin and a witness clause — and pwm.output marked INFERRED FOR EXPLANATION with the real ESP32Servo-quantised pulse beside it',
  );

  // The row the whole feature exists for, brought into view: this is where
  // "the code said 180 deg" and "a servo would have gone there" separate.
  //
  // The section is given the dock BEFORE the row list is scrolled, not after: a
  // collapsed section has no laid-out box, so `offsetTop` would be 0 for every
  // row and the scroll would be a no-op.
  await focusSection(page.evaluate, 'signal');
  await page.evaluate(`(() => {
    const rows = document.querySelector('[data-testid="trace-rows"]');
    const pwm = document.querySelector('[data-layer="pwm.output"]');
    if (rows !== null && pwm !== null) rows.scrollTop = pwm.offsetTop - rows.offsetTop - 8;
  })()`);
  await sleep(350);
  const pwmShot = await page.shoot(
    'v8-see-the-signal-pwm.png',
    'the pwm.output row: the real ESP32Servo-quantised pulse, marked INFERRED FOR EXPLANATION, with the witness naming Q3’s finding that QEMU’s LEDC produces no waveform and that no physical pin has ever emitted it',
  );

  // ================================================================
  // W4: THE FOCUS WORKSPACE
  // ================================================================
  //
  // The brief's fourth row, and the one place it qualifies "the robot must
  // dominate":
  //
  //   "It can temporarily give the graph most of the content area while
  //    retaining Sesame as a live, smaller stage. This is the one place where I
  //    would interpret 'robot must remain dominant' as product identity and
  //    persistent causal feedback, not literally 'the robot must own more
  //    pixels than every task surface at every instant'."
  //
  // Everything V8 asserted about the 63-node graph lives here now, because this
  // is where the 63-node graph lives: no dock and no workbench in this shell
  // reaches 960 px, so the full map is reached by an explicit action rather
  // than by being crushed into a column. The DOM BUTTON is clicked and
  // hit-tested rather than a debug hook being called - the claim is "a learner
  // can open this".
  await openSection(page.evaluate, 'modules');
  const shellBeforeWorkspace = await page.evaluate('window.__sesame.shell()');
  const workspaceOpen = await page.evaluate(`(() => {
    const button = document.querySelector('[data-testid="arch-workspace-toggle"]');
    if (button === null) return { ok: false, why: 'no [data-testid="arch-workspace-toggle"] in the DOM' };
    const rect = button.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return { ok: false, why: 'the workspace button has no laid-out box' };
    const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
    if (hit === null || !(hit === button || button.contains(hit)))
      return { ok: false, why: 'something is covering the workspace button: ' + (hit?.className ?? 'nothing') };
    button.click();
    return { ok: true, why: button.textContent, targetPx: Math.round(Math.min(rect.width, rect.height)) };
  })()`);
  check(workspaceOpen.ok, `could not open the architecture workspace: ${workspaceOpen.why}`);
  check(
    (workspaceOpen.targetPx ?? 0) >= 36,
    `the workspace button is ${workspaceOpen.targetPx}px on its short side; the policy floor is ` +
      `36px for a fine pointer`,
  );
  await sleep(1600);

  const archWorkspace = await page.evaluate('window.__sesame.archGraph()');
  const shellWorkspace = await page.evaluate('window.__sesame.shell()');
  check(
    archWorkspace.workspaceOpen === true && shellWorkspace.focusPane === 'modules',
    `the workspace did not open: ${JSON.stringify({
      pressed: archWorkspace.workspaceOpen,
      focusPane: shellWorkspace.focusPane,
    })}`,
  );
  check(
    archWorkspace.surfaceWidthPx !== null && archWorkspace.surfaceWidthPx >= 960,
    `the workspace gave the architecture surface ${archWorkspace.surfaceWidthPx} px; the full ` +
      `63-node map needs 960 and the workspace exists to provide it`,
  );
  check(
    archWorkspace.mode === 'full',
    `the workspace is open and the pane is still showing "${archWorkspace.mode}". The workspace ` +
      `is NOT a fourth mode: it changes the pane's width and archModeForWidth() then chooses, ` +
      `which is why a workspace on a 1280px window honestly gives the subsystem graph instead.`,
  );

  // THE EXEMPTION, ASSERTED RATHER THAN SKIPPED.
  //
  // W3's rule is that the stage keeps >= 50% of the window's area, and phase 12
  // asserts it at every breakpoint. This is the one arrangement the brief
  // exempts, and the exemption is only honest if three things are true at once:
  // the app SAYS it is claiming the exemption, the layout really is outside the
  // ordinary rule, and the robot is still there and still live.
  check(
    shellWorkspace.stageRule === 'focus-exempt',
    `the shell says the stage rule is "${shellWorkspace.stageRule}" while the focus workspace is ` +
      `open. The app has to declare which rule applies, because a harness that decided for itself ` +
      `would branch on the same condition the layout branches on and could never disagree with it.`,
  );
  check(
    shellWorkspace.stageAreaSharePct < W4_STAGE_AREA_FLOOR_PCT,
    `the focus workspace claims the exemption and the stage still holds ` +
      `${shellWorkspace.stageAreaSharePct.toFixed(1)}% of the window's area, at or above the ` +
      `${W4_STAGE_AREA_FLOOR_PCT}% floor it is exempt from. An exemption nothing needs is an ` +
      `exemption that is not being tested, and this project has shipped three of those.`,
  );
  check(
    shellWorkspace.canvasWidthPx >= W4_FOCUS_STAGE_FLOOR_PX &&
      shellWorkspace.canvasHeightPx >= W4_FOCUS_STAGE_FLOOR_PX,
    `inside the focus workspace the 3D canvas is ` +
      `${shellWorkspace.canvasWidthPx.toFixed(0)}x${shellWorkspace.canvasHeightPx.toFixed(0)}; the ` +
      `floor that REPLACES the area rule is ${W4_FOCUS_STAGE_FLOOR_PX}px on each side. "Product ` +
      `identity and persistent causal feedback" is a claim about a robot that is still on screen, ` +
      `not about one that has been reduced to a sliver.`,
  );
  const workspacePixels = await w4RobotPixels(page.evaluate);
  check(
    workspacePixels !== null && workspacePixels.sharePct >= W4_ROBOT_PIXEL_FLOOR_PCT,
    `inside the focus workspace only ${workspacePixels?.sharePct?.toFixed(1)}% of the middle of ` +
      `the WebGL drawing buffer is non-background. The exemption is granted on the condition that ` +
      `Sesame stays a LIVE reference, so this is read out of the drawing buffer rather than out ` +
      `of a layout box that could be the right size and empty.`,
  );
  w4Workspace = {
    surfaceWidthPx: archWorkspace.surfaceWidthPx,
    mode: archWorkspace.mode,
    stageRule: shellWorkspace.stageRule,
    stageAreaSharePct: shellWorkspace.stageAreaSharePct,
    canvasPx: [shellWorkspace.canvasWidthPx, shellWorkspace.canvasHeightPx],
    robotPixelSharePct: workspacePixels?.sharePct ?? null,
  };

  // `.workbench` was the middle column that held the graph above the trace.
  // Both are dock sections now and the dock's own scroller is what moves.
  await scrollDockTop(page.evaluate);
  await sleep(700);
  await focusSection(page.evaluate, 'modules');
  const graphCollapsedShot = await page.shoot(
    'v8-architecture-collapsed.png',
    'the FULL 63-node graph, in the focus workspace — the architecture pane holds 1,200px, Sesame stays live as a smaller reference on the left, and the collapsed top level is the report’s nine nodes with every label above the 14px floor',
  );

  // ----------------------------------------------- expand a node, by clicking
  //
  // The DOM button, not the debug hook: the claim is "a learner can expand it".
  const expandClick = await page.evaluate(`(() => {
    const button = document.querySelector('[data-expand="servos"]');
    if (button === null) return { ok: false, why: 'no [data-expand="servos"] control in the DOM' };
    button.click();
    return { ok: true, why: button.textContent };
  })()`);
  check(expandClick.ok, `could not expand the Servos node: ${expandClick.why}`);
  // The viewport animates to the newly revealed chain; screenshot after it lands.
  await sleep(900);

  const expanded = await page.evaluate('window.__sesame.archGraph()');
  const CHAIN = [
    'servo.setServoAngle',
    'servo.esp32servo',
    'servo.ledc',
    'servo.gpio',
    'servo.mg90s',
  ];
  for (const id of [...CHAIN, 'joint.R1', 'joint.R4', 'joint.L3', 'joint.L4']) {
    check(
      expanded.visibleNodeIds.includes(id),
      `expanding Servos did not reveal ${id} — the chain the firmware actually walks`,
    );
  }
  const expandedPairs = expanded.edges.map((e) => `${e.source}->${e.target}`);
  for (let i = 0; i + 1 < CHAIN.length; i++) {
    const pair = `${CHAIN[i]}->${CHAIN[i + 1]}`;
    check(expandedPairs.includes(pair), `the expanded chain is missing the edge ${pair}`);
  }
  check(
    expandedPairs.includes('servo.mg90s->joint.L3'),
    'the expanded chain does not reach a joint node',
  );
  // The DOM really drew them, not just the layout function.
  const domNodes = await page.evaluate(
    `Array.from(document.querySelectorAll('[data-arch-node]')).map((n) => n.getAttribute('data-arch-node'))`,
  );
  for (const id of CHAIN) {
    check(domNodes.includes(id), `${id} is in the layout but not in the DOM — React Flow did not draw it`);
  }
  await focusSection(page.evaluate, 'modules');
  const graphExpandedShot = await page.shoot(
    'v8-architecture-servos-expanded.png',
    'Servos expanded inside the focus workspace: movement → setServoAngle → ESP32Servo → LEDC → GPIO → MG90S → eight joints, every node backed by a hardware-map.json path and a firmware file:line',
  );

  // ------------------------------------------------------------ cross-linking
  //
  // Graph -> 3D. Click the R4 node in the architecture pane and read the
  // THREE.js materials back: if the highlight did not reach the scene graph,
  // `emissiveByJoint` stays zero everywhere and this fails.
  const r4Click = await page.evaluate(`(() => {
    const node = document.querySelector('[data-arch-node="joint.R4"]');
    if (node === null) return { ok: false, why: 'joint.R4 is not in the DOM' };
    node.click();
    return { ok: true, why: node.getAttribute('data-arch-node') };
  })()`);
  check(r4Click.ok, `could not click the R4 node in the graph: ${r4Click.why}`);
  await sleep(300);

  const sceneSel = await page.evaluate('window.__sesame.sceneSelection()');
  check(
    sceneSel.joint === 'R4',
    `clicking R4 in the architecture graph left the app's selection at ${JSON.stringify(sceneSel.joint)}`,
  );
  check(
    JSON.stringify(sceneSel.litJoints) === JSON.stringify(['R4']),
    `the 3D scene lit ${JSON.stringify(sceneSel.litJoints)} after R4 was clicked in the graph — ` +
      `read off MeshStandardMaterial.emissiveIntensity, so this is what the renderer has, not what ` +
      `React thinks`,
  );
  check(
    sceneSel.emissiveByJoint.R4 > 0,
    `R4's emissiveIntensity in the scene graph is ${sceneSel.emissiveByJoint.R4}`,
  );

  // 3D -> graph -> trace. Select L3 the way a click in the viewport would, then
  // check the other two panes followed.
  await page.evaluate('window.__sesame.selectJoint("L3")');
  await sleep(300);
  const afterSceneSelect = await page.evaluate('window.__sesame.archGraph()');
  check(
    afterSceneSelect.selectedNodeId === 'joint.L3',
    `selecting L3 in the 3D scene left the graph on ${JSON.stringify(afterSceneSelect.selectedNodeId)}`,
  );
  /*
   * THE CROSS-HIGHLIGHT, ACROSS A MODULE SWITCH — Phase 4 W7.
   *
   * V8 read this with the graph and the trace open together, which §11.3 has
   * made impossible: one module is active at a time. So the switch is part of
   * the assertion now, and it is a STRONGER one rather than a weaker one — it
   * proves that `SelectionState` is one object rather than two panes agreeing
   * while they happen to be on screen at the same moment. The selection is made
   * in the architecture module, the reader switches to Signal, and the rows are
   * already lit when they arrive.
   */
  await focusSection(page.evaluate, 'signal');
  const shellAcrossSwitch = await page.evaluate('window.__sesame.shell()');
  check(
    shellAcrossSwitch.activeModule === 'signal' &&
      shellAcrossSwitch.moduleColumn.laidOutPanes.join(',') === 'signal',
    `switching to Signal left ${JSON.stringify(shellAcrossSwitch.moduleColumn.laidOutPanes)} laid ` +
      `out and the active module ${JSON.stringify(shellAcrossSwitch.activeModule)}`,
  );
  check(
    (await page.evaluate('window.__sesame.selection()')).joint === 'L3',
    'the selection did not survive the module switch — which would make the cross-highlight a ' +
      'property of two panes being on screen together rather than of one SelectionState',
  );
  const hitRows = await page.evaluate(
    `Array.from(document.querySelectorAll('[data-trace-row].hit')).map((n) => ({
       layer: n.getAttribute('data-layer'),
       joint: n.getAttribute('data-joint'),
     }))`,
  );
  check(
    hitRows.length > 0 && hitRows.every((r) => r.joint === 'L3'),
    `selecting L3 in the architecture module and then switching to Signal highlighted ` +
      `${JSON.stringify(hitRows)}; every highlighted row must be an L3 row`,
  );
  check(
    hitRows.some((r) => r.layer === 'servo.target') && hitRows.some((r) => r.layer === 'pwm.output'),
    `selecting L3 did not highlight its servo.target and pwm.output rows: ${JSON.stringify(hitRows)}`,
  );
  await focusSection(page.evaluate, 'modules');

  // Auto-expansion: selecting a joint from the 3D view must open whatever chain
  // is needed to show it, or the cross-link is a promise the graph cannot keep.
  await page.evaluate('window.__sesame.selectJoint(null)');
  await page.evaluate('window.__sesame.toggleNode("servos")');
  await sleep(200);
  const afterCollapse = await page.evaluate('window.__sesame.archGraph()');
  check(
    !afterCollapse.visibleNodeIds.includes('joint.L3'),
    'collapsing Servos left the joint nodes on screen',
  );
  await page.evaluate('window.__sesame.selectJoint("L3")');
  await sleep(300);
  const afterReselect = await page.evaluate('window.__sesame.archGraph()');
  check(
    afterReselect.visibleNodeIds.includes('joint.L3'),
    'selecting L3 from the 3D scene did not auto-expand the graph to reveal joint.L3',
  );

  // ------------------------------------- W4: and the exemption ENDS
  //
  // The other half of the exemption. It is temporary by construction - the
  // workspace closes itself when its pane leaves the screen - and the check
  // that matters is that the ordinary rule comes back rather than staying
  // relaxed, because "exempt while a mode is on" and "exempt" are the same
  // assertion if nothing ever turns the mode off.
  /*
   * Close it — if it is still open. It may not be: the workspace closes ITSELF
   * when the module it belongs to leaves the screen, and the cross-highlight
   * check above deliberately switches to Signal and back. That self-closing is
   * the property this block is about, so it is asserted here rather than
   * assumed, and the toggle is only clicked when there is something to undo.
   */
  const workspaceBeforeClose = await page.evaluate('window.__sesame.shell()');
  check(
    workspaceBeforeClose.focusPane === null,
    `the focus workspace survived a switch to another module and back ` +
      `(focusPane=${JSON.stringify(workspaceBeforeClose.focusPane)}). "Exempt while a mode is on" ` +
      `and "exempt" are the same assertion if nothing ever turns the mode off, and switching away ` +
      `from the module the exemption is FOR is the plainest way to turn it off.`,
  );
  if (workspaceBeforeClose.focusPane !== null) {
    await page.evaluate(`document.querySelector('[data-testid="arch-workspace-toggle"]').click()`);
    await sleep(1400);
  }
  const shellAfterWorkspace = await page.evaluate('window.__sesame.shell()');
  const archAfterWorkspace = await page.evaluate('window.__sesame.archGraph()');
  check(
    // `content-50` rather than `area-50`, because the architecture module is
    // still the active one — which is the whole point: the exemption ended and
    // the ORDINARY rule for this state came back. W3's shell had no second
    // ordinary rule for it to come back to.
    shellAfterWorkspace.stageRule === 'content-50' && shellAfterWorkspace.focusPane === null,
    `closing the workspace left the shell at stageRule=${JSON.stringify(shellAfterWorkspace.stageRule)}, ` +
      `focusPane=${JSON.stringify(shellAfterWorkspace.focusPane)}`,
  );
  // The exemption is GIVEN BACK, measured as "the layout is the one it was
  // before", not as "the layout satisfies the floor". Those are different
  // claims and only the first is W4's: this phase runs at 1760x1000, where the
  // two-dock Wide regime holds 45% of the area with its DEFAULT dock widths and
  // has done since W3 - see the note below and the W4 findings. Asserting the
  // 50% floor here would be asserting somebody else's arithmetic in the middle
  // of a check about whether a button undoes itself.
  const areaGivenBack =
    Math.abs(shellAfterWorkspace.stageAreaSharePct - shellBeforeWorkspace.stageAreaSharePct) < 0.5;
  check(
    areaGivenBack,
    `closing the workspace left the stage at ${shellAfterWorkspace.stageAreaSharePct.toFixed(1)}% ` +
      `of the window's area; before it opened the same layout held ` +
      `${shellBeforeWorkspace.stageAreaSharePct.toFixed(1)}%. The exemption is temporary or it is ` +
      `not an exemption.`,
  );
  /*
   * W4's NOTE about this window is DELETED, not re-worded — Phase 4 W7.
   *
   * It read: "at 1760x1000 the two-dock Wide regime holds only 45.0% of the
   * window's area at its default dock widths, below W3's 50% floor". There is
   * no two-dock regime and there are no dock widths, so the note describes a
   * layout that no longer exists — and a note that goes on printing about a
   * deleted regime is the same failure as an assertion that goes on passing
   * against one. The gap it recorded is closed by construction and asserted by
   * name: 1760x1000 is in `RESPONSIVE_WINDOWS`, and phase 12 measures both
   * stage regimes there.
   *
   * The stage holding under 50% of the WINDOW here is now correct rather than a
   * defect: a module is up, so the rule in force is `content-50`, which the
   * shell publishes and phase 12 checks.
   */
  check(
    shellAfterWorkspace.stageContentSharePct >= 49.8,
    `after the workspace closed the stage holds ` +
      `${shellAfterWorkspace.stageContentSharePct.toFixed(1)}% of the CONTENT area under the ` +
      `"${shellAfterWorkspace.stageRule}" rule; the floor for that regime is 50%`,
  );
  check(
    archAfterWorkspace.mode === 'path',
    `after the workspace closed the pane is showing "${archAfterWorkspace.mode}"; the ordinary ` +
      `layout is under 720 px and must be back on the causal path`,
  );

  // ------------------------------ W4: the SUBSYSTEM representation, on screen
  //
  // The intermediate artifact needs a container between 720 and 960 px, and no
  // dock or workbench in this shell produces one - so the pane is DRIVEN to it,
  // exactly as the container sweep drives every pane in phase 12. That is the
  // whole reason W2 built container queries: the pane's width is a thing that
  // can be set, and a representation that can only be reached by owning a
  // different laptop cannot be looked at.
  await page.evaluate(`(() => {
    const pane = document.querySelector('[data-pane="modules"]');
    if (pane !== null) pane.style.width = '900px';
  })()`);
  await sleep(1200);
  const subsystemReading = await page.evaluate('window.__sesame.archGraph()');
  check(
    subsystemReading.mode === 'subsystem',
    `a 900 px modules pane mounted "${subsystemReading.mode}"; between 720 and 960 px of surface ` +
      `the brief's artifact is one subsystem`,
  );
  check(
    subsystemReading.subsystem !== null,
    `the subsystem representation named no subsystem: ${JSON.stringify(subsystemReading.subsystem)}`,
  );
  check(
    subsystemReading.renderedNodeIds.length >= 3 &&
      subsystemReading.renderedNodeIds.length <= 19,
    `the subsystem representation drew ${subsystemReading.renderedNodeIds.length} nodes; the ` +
      `product rule is 18 plus the root anchor`,
  );
  const subsystemZoom = await page.evaluate(`(() => {
    const v = document.querySelector('.react-flow__viewport');
    if (v === null) return null;
    const t = getComputedStyle(v).transform;
    const n = t.slice(t.indexOf('(') + 1, -1).split(',').map(Number);
    return n.length >= 4 ? Math.round(n[3] * 1000) / 1000 : null;
  })()`);
  check(
    subsystemZoom !== null && subsystemZoom >= 1,
    `the subsystem graph is drawn at zoom ${subsystemZoom}. Its zoom FLOOR is 1 and that is the ` +
      `whole design: a 15px label at zoom 1 is a 15px label, and the brief's principle is to stop ` +
      `"Fit View" shrinking labels until everything technically fits and nothing is usable. What ` +
      `moves instead is the viewport, which is why the surface is a declared [data-2d-surface].`,
  );
  // =====================================================================
  // W8: CLICKING A NODE MUST NOT ZOOM OUT
  // =====================================================================
  //
  // > *"the graph looks awesome. One complaint is that when I click on a node,
  // > it zooms out and I need to keep manually zooming in."*
  //
  // A real defect with a real cause: `focusId` and `pathIds` were DEPENDENCIES
  // of the re-frame effect, so a selection re-ran it, and in the `full`
  // representation it fell through to `fitView({ padding: 0.16 })` — refitting
  // all 63 nodes and discarding whatever zoom the reader had scrolled to.
  //
  // The invariant is stated as the user stated it and asserted as a number:
  // **the zoom does not decrease across a node click.** It is checked in BOTH
  // representations that have a viewport, and in each one the reader is first
  // put somewhere a refit would visibly undo — zoomed IN past the fitted zoom —
  // because a check that clicks at the fitted zoom cannot tell "kept the zoom"
  // from "refitted to the same number".
  //
  // `archGraph().viewportZoom` is W7's published transform, read off the DOM
  // rather than recomputed, so this cannot agree with itself by construction.
  const zoomOf = () => page.evaluate('window.__sesame.archGraph().viewportZoom');
  /**
   * Click the first node in `candidates` a pointer could actually reach.
   *
   * Two details, both learned the hard way.
   *
   * **A LIST, not one id.** Phase 7 drives the modules pane 440 px wider than
   * the column that holds it, on purpose, so part of the graph is off the right
   * of the window and `elementFromPoint` returns null for it. Which node that
   * is depends on the layout; requiring one particular node to be hit-testable
   * would make this check fail for a reason that has nothing to do with what it
   * asserts.
   *
   * **`el.click()`, not synthetic `mousedown`/`mouseup`.** A hand-built
   * `MouseEvent` has `view === null`, and React Flow's drag machinery reads
   * `sourceEvent.view.document` — which threw `Cannot read properties of null
   * (reading 'document')` into the page's error log on the first run of this
   * check. `HTMLElement.click()` dispatches the event the platform would.
   */
  const clickArchNode = (candidates) =>
    page.evaluate(`(() => {
      for (const id of ${JSON.stringify(candidates)}) {
        const node = document.querySelector('[data-arch-node="' + id + '"]');
        if (node === null) continue;
        const box = node.getBoundingClientRect();
        if (box.width < 1 || box.height < 1) continue;
        const x = box.left + box.width / 2;
        const y = box.top + box.height / 2;
        if (x < 0 || y < 0 || x > window.innerWidth || y > window.innerHeight) continue;
        const hit = document.elementFromPoint(x, y);
        if (hit === null || !node.contains(hit)) continue;
        hit.click();
        return { ok: true, node: id };
      }
      return { ok: false, why: 'no candidate node was hit-testable' };
    })()`);

  const zoomChecks = [];
  {
    // The pane is still 900 px wide here, so this is the SUBSYSTEM view.
    const candidates = subsystemReading.renderedNodeIds.filter(
      (id) => id !== subsystemReading.selectedNodeId,
    );
    const before = await zoomOf();
    const clicked = await clickArchNode(candidates);
    await sleep(900);
    const after = await zoomOf();
    check(
      clicked.ok === true,
      `could not click any of ${candidates.length} node(s) in the subsystem representation: ` +
        `${JSON.stringify(clicked)}`,
    );
    check(
      before !== null && after !== null && after >= before - 1e-6,
      `clicking ${JSON.stringify(clicked.node)} in the SUBSYSTEM representation took the zoom from ` +
        `${before} to ${after}. A selection may pan; it may never zoom out. This representation's ` +
        `whole claim is that at zoom 1 the authored size is the size on screen.`,
    );
    zoomChecks.push({ representation: 'subsystem', node: clicked.node ?? null, before, after });
  }
  await page.evaluate(`(() => {
    const pane = document.querySelector('[data-pane="modules"]');
    if (pane !== null) pane.style.width = '';
  })()`);
  await sleep(900);

  {
    // ...and the FULL graph, which is where the user met it. The focus
    // workspace is the one arrangement in this window that mounts all 63 nodes.
    await page.evaluate(`document.querySelector('[data-testid="arch-workspace-toggle"]').click()`);
    await sleep(1600);
    const mounted = await page.evaluate('window.__sesame.archGraph()');
    if (mounted.mode === 'full' || mounted.mode === 'subsystem') {
      // Zoom IN first, past whatever `fitView` chose. A refit on selection is
      // only VISIBLE against a zoom the reader chose, and this is the gesture
      // the complaint describes ("I need to keep manually zooming in").
      const fitted = await zoomOf();
      await page.evaluate(`(() => {
        const zoomIn = document.querySelector('.react-flow__controls-zoomin');
        if (zoomIn !== null) { zoomIn.click(); zoomIn.click(); }
      })()`);
      await sleep(900);
      const zoomedIn = await zoomOf();
      check(
        zoomedIn !== null && fitted !== null && zoomedIn > fitted + 1e-3,
        `the zoom-in control did not change the ${mounted.mode} graph's zoom (${fitted} -> ` +
          `${zoomedIn}); without that this check cannot tell "kept the zoom" from "refitted"`,
      );
      const candidates = mounted.renderedNodeIds.filter((id) => id !== mounted.selectedNodeId);
      const clicked = await clickArchNode(candidates);
      await sleep(1000);
      const after = await zoomOf();
      const selected = await page.evaluate('window.__sesame.archGraph().selectedNodeId');
      check(
        clicked.ok === true && selected === clicked.node,
        `clicking a node in the ${mounted.mode} representation did not select it ` +
          `(${JSON.stringify(clicked)}, selection is ${JSON.stringify(selected)})`,
      );
      check(
        after !== null && zoomedIn !== null && after >= zoomedIn - 1e-6,
        `clicking ${JSON.stringify(clicked.node)} in the ${mounted.mode} representation took the ` +
          `zoom from ${zoomedIn} to ${after}. THIS is the user's complaint, as a number: a node ` +
          `click re-fitted the whole graph and threw away the zoom they had chosen. Selecting a ` +
          `node may PAN to it and may not refit.`,
      );
      zoomChecks.push({
        representation: mounted.mode,
        node: clicked.node ?? null,
        fitted,
        before: zoomedIn,
        after,
      });
    } else {
      problems.push(
        `the architecture workspace mounted "${mounted.mode}", so the zoom-on-click invariant was ` +
          `not checked against a React Flow viewport at all`,
      );
    }
    await page.evaluate(`document.querySelector('[data-testid="arch-workspace-toggle"]').click()`);
    await sleep(1200);
  }

  // ------------------------------- W4: the cross-highlight, in the PATH view
  //
  // The requirement V8 spent the most effort on, restated for a representation
  // that has no React Flow in it: clicking `R4` anywhere must still light it
  // here, and clicking it here must still light the mesh. Same `SelectionState`,
  // same `selectNode`, different artifact.
  await page.evaluate('window.__sesame.selectJoint("L3")');
  await sleep(500);
  const pathAfterSelect = await page.evaluate(`(() => {
    const steps = [...document.querySelectorAll('[data-arch-path-step]')];
    return {
      mode: document.querySelector('[data-testid="arch-surface"]').getAttribute('data-arch-mode'),
      steps: steps.map((n) => n.getAttribute('data-arch-path-step')),
      selected: [...document.querySelectorAll('[data-arch-node][data-selected="true"]')].map((n) => n.getAttribute('data-arch-node')),
    };
  })()`);
  check(
    pathAfterSelect.mode === 'path' && pathAfterSelect.steps.includes('joint.L3'),
    `selecting L3 in the 3D scene did not put it on the causal path; the chain drawn was ` +
      `${JSON.stringify(pathAfterSelect.steps)}`,
  );
  check(
    pathAfterSelect.selected.includes('joint.L3'),
    `the causal path drew joint.L3 without marking it selected: ` +
      `${JSON.stringify(pathAfterSelect.selected)}`,
  );
  // And the chain a reader is looking at really is the chain: L3's path has to
  // arrive through the servo chain, including the hand-authored last edge.
  for (const id of ['servo.ledc', 'servo.gpio', 'servo.mg90s']) {
    check(
      pathAfterSelect.steps.includes(id),
      `L3's causal path skipped ${id}: ${JSON.stringify(pathAfterSelect.steps)}`,
    );
  }
  const handEdges = await page.evaluate(
    `document.querySelectorAll('[data-arch-edge-derivation="hand-authored"]').length`,
  );
  check(
    handEdges >= 1,
    `the causal path ends on a joint through servo.mg90s -> joint.L3, which is one of the five ` +
      `hand-authored claims, and marked ${handEdges} relation(s) as hand-authored. Dashing an ` +
      `edge is not available in a representation that has no edges to dash, so it has to say so.`,
  );

  // Path -> 3D. Click the step in the DOM and read THREE.js back.
  await page.evaluate('window.__sesame.selectJoint(null)');
  await sleep(300);
  const pathClick = await page.evaluate(`(() => {
    const node = document.querySelector('[data-arch-node="servo.ledc"]');
    if (node === null) return { ok: false, why: 'servo.ledc is not on the causal path' };
    node.click();
    return { ok: true };
  })()`);
  check(pathClick.ok, `could not click a step in the causal path: ${pathClick.why}`);
  await sleep(400);
  const afterPathClick = await page.evaluate('window.__sesame.archGraph()');
  check(
    afterPathClick.selectedNodeId === 'servo.ledc',
    `clicking a causal-path step left the selection at ` +
      `${JSON.stringify(afterPathClick.selectedNodeId)}; every representation writes the same ` +
      `SelectionState through the same selectNode()`,
  );
  // A node about all eight joints selects no ONE joint - V8's rule, unchanged
  // by the representation. What it does light is `litJointsFor()`'s second arm:
  // the joints the SYMBOL this node cites commands, which for LEDC is all
  // eight. Measured rather than assumed, because the first version of this
  // check asserted an empty set and the app was right.
  const afterPathScene = await page.evaluate('window.__sesame.sceneSelection()');
  check(
    afterPathScene.joint === null,
    `selecting LEDC from the causal path set the joint to ${JSON.stringify(afterPathScene.joint)}; ` +
      `a node about all eight joints is about the stage, not about a limb, and collapsing that to ` +
      `"pick the first joint" would be a lie the 3D scene would then render`,
  );
  check(
    afterPathScene.litJoints.length === 8,
    `selecting LEDC from the causal path lit ${JSON.stringify(afterPathScene.litJoints)}; the ` +
      `node cites a span of code that commands all eight, which is litJointsFor()'s symbol arm ` +
      `and is the same answer the full graph gives for the same click`,
  );
  // And one that IS about a limb - reached through the branch row, which is
  // the representation's answer to "the chain shows one joint and there are
  // eight". `+N more` opens the rest in place, so nothing in the graph is
  // unreachable from the narrow view; that is the promise all three share.
  await page.evaluate('window.__sesame.selectJoint(null)');
  await sleep(400);
  const branchOpen = await page.evaluate(`(() => {
    const more = document.querySelector('[data-arch-branches-more="servo.mg90s"]');
    if (more === null) return { ok: false, why: 'no branch-expander beside servo.mg90s' };
    more.click();
    return { ok: true, label: more.textContent };
  })()`);
  check(branchOpen.ok, `could not open the causal path's branch row: ${branchOpen.why}`);
  await sleep(400);
  const branchClick = await page.evaluate(`(() => {
    const node = document.querySelector('[data-arch-branch="joint.L4"]');
    if (node === null) return { ok: false, why: 'joint.L4 is not reachable from the causal path' };
    node.click();
    return { ok: true };
  })()`);
  check(
    branchClick.ok,
    `${branchClick.why}. Every node has to be reachable from every representation, or the narrow ` +
      `view is a subset of the product rather than a view of it.`,
  );
  await sleep(500);
  const branchScene = await page.evaluate('window.__sesame.sceneSelection()');
  check(
    branchScene.joint === 'L4' && JSON.stringify(branchScene.litJoints) === JSON.stringify(['L4']),
    `clicking L4 in the causal path lit ${JSON.stringify(branchScene.litJoints)} in the scene ` +
      `graph - read off MeshStandardMaterial.emissiveIntensity, so this is what the renderer has`,
  );
  await page.evaluate('window.__sesame.selectJoint(null)');
  await sleep(300);

  // ------------------------------------- ISSUE-20260823-023, re-asserted here
  //
  // A user found the sliding ground plane once already, on the simulator path,
  // and this phase adds a whole new set of re-renders (React Flow, the trace
  // panel, a three-column grid). A resize or a re-layout that nudged the scene
  // would be exactly the same class of bug with a new cause.
  const FRAME_EPS_MM = 1e-6;
  const framesHere = [{ label: 'phase 7, before any command', ...worldBefore }];
  // Sweep the pose through the transition that actually moves the contact
  // plane. `runRestPose` puts all eight at 90 deg (feet up, contact -31.1 mm)
  // and every movement ends at `runStandPose` (-68.65 mm); the 37.5 mm between
  // them IS the distance the grid used to slide. A wave alone does not move the
  // MINIMUM foot height at all, so sampling only a wave would leave this check
  // vacuous however many samples it took.
  await page.evaluate('window.__sesame.run("rest")');
  await waitSceneCaughtUp('the scene to reach the rest pose for the phase 7 frame check');
  const restFrame = await page.evaluate('window.__sesame.worldFrame()');
  if (restFrame === null) problems.push('worldFrame() returned null at the phase 7 rest pose');
  else framesHere.push({ label: 'phase 7, rest pose', ...restFrame });

  // Fire-and-forget, looped, exactly as phase 1 does: `Runtime.evaluate` awaits
  // a returned promise, so `await run("wave")` would sample a robot that had
  // already finished moving and the check would be blind to the transition.
  await page.evaluate(`
    window.__waving = true;
    void (async () => {
      while (window.__waving) await window.__sesame.run('wave');
    })();
  `);
  for (let i = 0; i < 8; i++) {
    await sleep(240);
    const f = await page.evaluate('window.__sesame.worldFrame()');
    if (f === null) problems.push('worldFrame() returned null during phase 7');
    else framesHere.push({ label: `phase 7, wave sample ${i + 1}`, ...f });
  }
  await page.evaluate('window.__waving = false');
  const first = framesHere[0];
  const worstHere = {};
  for (const key of ['groundWorldMm', 'robotRootWorldMm', 'cameraTargetMm', 'cameraPositionMm']) {
    let worst = 0;
    for (const sample of framesHere.slice(1)) {
      const a = first?.[key];
      const b = sample[key];
      if (!Array.isArray(a) || !Array.isArray(b)) continue;
      for (let i = 0; i < 3; i++) worst = Math.max(worst, Math.abs(a[i] - b[i]));
    }
    worstHere[key] = worst;
    check(
      worst <= FRAME_EPS_MM,
      `${key} moved ${worst.toFixed(6)} mm in world space while the architecture graph and trace ` +
        `panels were mounted and re-rendering (ISSUE-20260823-023)`,
    );
  }
  const contactsHere = framesHere.map((f) => f.footContactMm).filter((v) => typeof v === 'number');
  const spreadHere =
    contactsHere.length === 0 ? 0 : Math.max(...contactsHere) - Math.min(...contactsHere);
  check(
    spreadHere > 1,
    `the foot contact varied by only ${spreadHere.toFixed(3)} mm in phase 7, so the world-stability ` +
      `re-check proved nothing`,
  );

  phases.architectureAndTrace = {
    ok: true,
    backend: 'sim',
    /**
     * W8 — the zoom across a node click, in both representations that have a
     * viewport.
     *
     * `before` is a zoom the reader chose (the full graph is deliberately
     * zoomed IN past `fitView`'s answer first), `after` is the zoom once the
     * click has been answered. `after >= before` is the whole invariant.
     */
    zoomOnSelection: zoomChecks,
    graph: {
      upstreamCommit: collapsed.upstreamCommit,
      totalNodes: collapsed.totalNodes,
      collapsedNodeIds: collapsed.visibleNodeIds,
      expandedByClick: 'servos',
      revealedChain: CHAIN,
      handAuthored: collapsed.handAuthored,
      unresolvedNodeIds: collapsed.unresolvedNodeIds,
    },
    trace: {
      id: trace.id,
      command: trace.command,
      carriedTraceId: trace.carriedTraceId,
      windowAdopted: trace.windowAdopted,
      ladder: trace.rows.map((r) => ({
        layer: r.layer,
        label: r.label,
        provenance: r.provenance,
        originKind: r.originKind,
        badge: r.badge,
        match: r.match,
        joint: r.joint,
      })),
      physicallyObservedRows: 0,
    },
    crossLink: {
      graphClickToScene: { clicked: 'joint.R4', litJoints: sceneSel.litJoints },
      sceneSelectToGraph: 'joint.L3',
      sceneSelectToTrace: hitRows,
      autoExpanded: true,
      // W4: the same object, the same entry point, in the artifact a laptop
      // actually gets. `SelectionState` is written by `selectNode()` from all
      // three representations, so there is one code path rather than three.
      pathSelectToScene: { clicked: 'joint.L4', litJoints: branchScene.litJoints },
      pathSelectIsStageNotLimb: { clicked: 'servo.ledc', litJoints: afterPathScene.litJoints },
    },
    /**
     * W4 — the three representations, as measured in this phase.
     *
     * `ordinary` is what a reader gets without doing anything, at the widest
     * window this harness runs the rest of its phases in. `workspace` is the
     * explicit action, and it carries the numbers the stage-area exemption is
     * granted against rather than merely a flag saying it was granted.
     */
    representations: {
      thresholdsPx: { subsystem: 720, full: 960 },
      ordinary: {
        mode: archOrdinary.mode,
        surfaceWidthPx: archOrdinary.surfaceWidthPx,
        reactFlowMounted: archMounted.canvases,
        zoomSurfaces: archMounted.zoomSurfaces,
        steps: archMounted.steps,
        worstOnScreenPx: archPathTypeReading?.worst?.px ?? null,
        textRuns: archPathTypeReading?.runs ?? null,
      },
      subsystem: {
        drivenContainerPx: 900,
        mode: subsystemReading.mode,
        surfaceWidthPx: subsystemReading.surfaceWidthPx,
        subsystem: subsystemReading.subsystem,
        nodes: subsystemReading.renderedNodeIds.length,
        zoom: subsystemZoom,
      },
      workspace: w4Workspace,
      stageRuleAfterClose: shellAfterWorkspace.stageRule,
      stageAreaAfterClosePct: shellAfterWorkspace.stageAreaSharePct,
    },
    worldFrame: {
      toleranceMm: FRAME_EPS_MM,
      worstDriftMm: worstHere,
      footContactSpreadMm: spreadHere,
      samples: framesHere.length,
    },
    shots: [
      graphPathShot.name,
      graphCollapsedShot.name,
      graphExpandedShot.name,
      traceShot.name,
      pwmShot.name,
    ],
  };

  await page.evaluate('window.__sesame.stop()');
}

// --------------------------------------------------------------- phase 8
//
// PHASE 8: the source explorer, and the four-way sync closed into a loop.
//
// ```text
// Real source  <->  Architecture node  <->  Robot part  <->  Runtime event
// ```
//
// The report calls those four panes the point of the feature. Everything here
// is driven through the DOM or through the one shared selection, and read back
// out of the DOM and the three.js materials — never out of React state, for the
// same reason phase 1 reads `Object3D.quaternion`.
//
// It runs in this session, on the simulator, immediately after phase 7, so the
// wave trace phase 7 produced is still on screen and the "which rows ran inside
// this code?" direction has something real to answer with.
{
  const sourceShots = [];

  // The source pane is a dock section now rather than the second grid row, and
  // everything below measures a real scroll position, so it has to be laid out.
  await openSection(page.evaluate, 'source');

  // ---------------------------------------------------- the integrity gate
  const initial = await page.evaluate('window.__sesame.sourceExplorer()');
  check(
    initial.integrity === 'ok',
    `the source pane reports integrity "${initial.integrity}" for ${initial.file} — the bytes the ` +
      `browser received do not hash to what hardware/source-annotations.json recorded`,
  );
  check(
    initial.upstreamCommit === '401730514cefed738710d22303e84b0dcd6b76d0',
    `the source pane cites upstream ${initial.upstreamCommit}, not the pinned commit`,
  );
  check(
    initial.outlineSymbolIds.length > 20,
    `the outline drew ${initial.outlineSymbolIds.length} symbols for movement-sequences.h`,
  );

  // ------------------------------------------- source -> node -> robot part
  //
  // A real click on the outline row, not the debug hook: the claim is "a
  // learner can select this".
  const symbolClick = await page.evaluate(`(() => {
    const row = document.querySelector('[data-source-symbol="runWavePose"]');
    if (row === null) return { ok: false, why: 'runWavePose is not in the source outline' };
    row.click();
    return { ok: true, why: row.getAttribute('data-start-line') };
  })()`);
  check(symbolClick.ok, `could not select runWavePose in the source outline: ${symbolClick.why}`);
  await sleep(500);

  const wave = await page.evaluate('window.__sesame.sourceExplorer()');
  check(
    wave.symbolId === 'runWavePose',
    `clicking runWavePose left the shared selection at ${JSON.stringify(wave.symbolId)}`,
  );

  // 1. THE LINE NUMBERS. The painted text of the line numbered `startLine` must
  //    be the text L3 recorded for that line. This is the check that catches a
  //    drifted file, a wrong tree, and an off-by-one window, and it is asserted
  //    against the annotations rather than against a literal.
  check(
    wave.symbol !== null && wave.renderedStartLineText === wave.symbol.startLineText,
    `line ${wave.symbol?.startLine} rendered as ${JSON.stringify(wave.renderedStartLineText)} but ` +
      `source-annotations.json records ${JSON.stringify(wave.symbol?.startLineText)}`,
  );
  check(
    wave.symbol !== null && wave.renderedEndLineText === wave.symbol.endLineText,
    `line ${wave.symbol?.endLine} rendered as ${JSON.stringify(wave.renderedEndLineText)} but ` +
      `source-annotations.json records ${JSON.stringify(wave.symbol?.endLineText)}`,
  );
  check(
    wave.renderedFirstLine !== null &&
      wave.symbol !== null &&
      wave.renderedFirstLine <= wave.symbol.startLine &&
      (wave.renderedLastLine ?? 0) >= wave.symbol.endLine,
    `the window ${wave.renderedFirstLine}-${wave.renderedLastLine} does not contain the whole ` +
      `symbol ${wave.symbol?.startLine}-${wave.symbol?.endLine}`,
  );
  // Every line some artefact in this repository cites is marked in the gutter.
  check(
    JSON.stringify(wave.citedLines) === JSON.stringify(wave.expectedCitedLines),
    `the pane marked lines ${JSON.stringify(wave.citedLines)} as cited; the annotations cite ` +
      `${JSON.stringify(wave.expectedCitedLines)}`,
  );

  // 2. THE ARCHITECTURE NODE follows.
  const waveGraph = await page.evaluate('window.__sesame.archGraph()');
  check(
    waveGraph.selectedNodeId === 'movement.runWavePose',
    `selecting runWavePose in the source pane left the graph on ` +
      `${JSON.stringify(waveGraph.selectedNodeId)}`,
  );
  check(
    wave.archNodesInSymbol.includes('movement.runWavePose'),
    `the pane found ${JSON.stringify(wave.archNodesInSymbol)} citing lines inside runWavePose`,
  );

  // 3. THE ROBOT PARTS follow, read off MeshStandardMaterial.emissiveIntensity.
  //    `runWavePose` commands four joints and no single one, so this cannot come
  //    from the scalar joint selection — it comes from the symbol's robotParts.
  const waveScene = await page.evaluate('window.__sesame.sceneSelection()');
  check(
    JSON.stringify(waveScene.litJoints) === JSON.stringify(['R1', 'L2', 'R4', 'L3']),
    `selecting runWavePose lit ${JSON.stringify(waveScene.litJoints)} in the three.js materials; ` +
      `hardware/source-annotations.json says the span commands R1 L2 R4 L3`,
  );
  check(
    waveScene.emissiveByJoint.R2 === 0 && waveScene.emissiveByJoint.L1 === 0,
    `joints the wave does not command are lit: ${JSON.stringify(waveScene.emissiveByJoint)}`,
  );

  // 4. THE RUNTIME EVENTS follow — rows whose sourceRef landed in lines 91-107.
  check(
    wave.runtimeRowLayers.includes('movement.enter'),
    `no trace row was attributed to runWavePose's line range: ` +
      `${JSON.stringify(wave.runtimeRowLayers)}`,
  );

  await page.evaluate(`void document.querySelector('.source-code')?.scrollTo(0, 0)`);
  await sleep(400);
  await focusSection(page.evaluate, 'source');
  sourceShots.push(
    await page.shoot(
      'l4-source-explorer-wave.png',
      'runWavePose selected in the source explorer: real source at the pinned tree’s own line numbers, ' +
        'cited lines marked in the gutter, the architecture node and the four commanded joints lit from ' +
        'the same one selection',
    ),
  );

  // --------------------------------------- 3D -> source, and the scroll
  //
  // The reverse direction the report names: click a leg, land on the line that
  // names it. `selectJoint` is what a click in the viewport does.
  await page.evaluate('window.__sesame.selectJoint("L3")');
  await sleep(500);
  const fromScene = await page.evaluate('window.__sesame.sourceExplorer()');
  check(
    fromScene.symbol !== null && fromScene.symbol.robotParts.includes('L3'),
    `selecting L3 in the 3D scene put the source pane on ${JSON.stringify(fromScene.symbolId)}, ` +
      `whose robotParts are ${JSON.stringify(fromScene.symbol?.robotParts)} — L3 is not among them`,
  );
  check(
    fromScene.renderedStartLineText === (fromScene.symbol?.startLineText ?? null),
    `the source pane rendered ${JSON.stringify(fromScene.renderedStartLineText)} at line ` +
      `${fromScene.symbol?.startLine}, not the annotated ${JSON.stringify(fromScene.symbol?.startLineText)}`,
  );
  // It SCROLLED there: the symbol's first line is inside the code view's own
  // scroll viewport, not merely present in the DOM somewhere below the fold.
  const scrolled = await page.evaluate(`(() => {
    const container = document.querySelector('.source-code');
    const target = container?.querySelector('[data-line="${fromScene.symbol?.startLine ?? 0}"]');
    if (!container || !target) return { ok: false, why: 'no code view or no such line' };
    const top = target.getBoundingClientRect().top - container.getBoundingClientRect().top;
    return { ok: top >= 0 && top <= container.clientHeight, top, height: container.clientHeight };
  })()`);
  check(
    scrolled.ok === true,
    `the code view did not scroll to line ${fromScene.symbol?.startLine}: ${JSON.stringify(scrolled)}`,
  );

  // ------------------------------- three registers, three visual treatments
  //
  // L3 separates what the code SAYS (`description`), what we THINK
  // (`commentary`) and what a LIBRARY says (`libraryEvidence`, a different
  // tree). If those three render alike the distinction is lost the moment it
  // reaches a learner, so the computed styles are asserted to differ.
  await page.evaluate('window.__sesame.selectSymbol("setServoAngle")');
  await sleep(500);
  const registers = await page.evaluate(`(() => {
    const paint = (selector) => {
      const node = document.querySelector(selector);
      if (node === null) return null;
      const style = getComputedStyle(node);
      return {
        color: style.color,
        background: style.backgroundColor,
        borderLeft: style.borderLeftColor,
        borderStyle: style.borderStyle,
        fontStyle: style.fontStyle,
      };
    };
    return {
      description: paint('[data-testid="source-description"]'),
      commentary: paint('[data-commentary="TN-007"] p'),
      library: paint('[data-library-evidence="TN-007"]'),
      hasNote: document.querySelector('[data-teaching-note="TN-007"]') !== null,
      noteKind: document.querySelector('[data-teaching-note="TN-007"]')?.getAttribute('data-kind') ?? null,
      libraryText: document.querySelector('[data-library-evidence="TN-007"]')?.textContent ?? '',
      quantisation: document.querySelector('[data-testid="servo-resolution"]')?.textContent ?? '',
      pulseUs: document.querySelector('[data-testid="servo-pulse-us"]')?.textContent ?? '',
    };
  })()`);
  check(registers.hasNote, 'TN-007 is not rendered on setServoAngle');
  check(registers.noteKind === 'surprise', `TN-007 rendered as kind ${registers.noteKind}`);
  check(registers.commentary !== null, 'TN-007 rendered no commentary block');
  check(registers.library !== null, 'TN-007 rendered no libraryEvidence block');
  check(
    registers.description !== null &&
      registers.commentary !== null &&
      registers.description.color !== registers.commentary.color,
    `a fact and a judgement render in the same colour: ${JSON.stringify(registers)}`,
  );
  check(
    registers.commentary?.fontStyle === 'italic',
    `commentary is not visually set apart from the description: ${JSON.stringify(registers.commentary)}`,
  );
  check(
    registers.library !== null &&
      registers.commentary !== null &&
      registers.library.background !== registers.commentary.background,
    `library evidence and commentary share a background: ${JSON.stringify(registers)}`,
  );
  check(
    registers.library?.borderStyle === 'dashed',
    `library evidence is not marked as pointing outside the pinned tree: ` +
      `${JSON.stringify(registers.library)}`,
  );
  check(
    registers.libraryText.includes('ESP32Servo') && registers.libraryText.includes('3.0.9'),
    `the library citation does not name the library and version: ${registers.libraryText.slice(0, 120)}`,
  );

  // TN-007 itself: the UI must not imply one-degree servo resolution.
  check(
    /89/.test(registers.quantisation) && /alias/i.test(registers.quantisation),
    `the servo-resolution note does not say that 89 of the 181 commanded angles alias: ` +
      `${registers.quantisation.slice(0, 200)}`,
  );
  check(
    registers.pulseUs.includes('1601.56'),
    `a commanded 90 deg is shown as ${registers.pulseUs}, not the 1601.56 us the 10-bit LEDC ` +
      `channel actually emits`,
  );

  // The three registers live below the fold in a 380 px strip; scroll the
  // context column so the screenshot shows what the assertions just checked.
  // W2: `.source-context` no longer owns a scroller of its own — the pane does —
  // so this frames the shot by scrolling whichever box actually scrolls.
  await page.evaluate(`(() => {
    const note = document.querySelector('[data-teaching-note="TN-007"]');
    if (!note) return false;
    note.scrollIntoView({ block: 'center' });
    return true;
  })()`);
  await sleep(350);
  await focusSection(page.evaluate, 'source');
  sourceShots.push(
    await page.shoot(
      'l4-source-teaching-notes.png',
      'setServoAngle: the description is a fact checkable line by line, the amber aside is a labelled ' +
        'judgement, and the dashed violet block is ESP32Servo 3.0.9 — a different tree that the pinned ' +
        'line checker cannot resolve',
    ),
  );

  // ------------------------------------------------ concepts: depth, capped
  const levelBefore = await page.evaluate('window.__sesame.sourceExplorer()');
  const levelClick = await page.evaluate(`(() => {
    const tab = document.querySelector('[data-level="beginner12"]');
    if (tab === null) return { ok: false, why: 'no explanatory-level control' };
    tab.click();
    return {
      ok: true,
      texts: document.querySelectorAll('[data-testid="concept-text"]').length,
      shown: document.querySelector('[data-testid="concept-text"]')?.textContent ?? '',
    };
  })()`);
  check(levelClick.ok, `could not switch explanatory level: ${levelClick.why}`);
  await sleep(250);
  const levelAfter = await page.evaluate('window.__sesame.sourceExplorer()');
  check(
    levelBefore.conceptLevelShown === 'beginnerProgrammer' &&
      levelAfter.conceptLevelShown === 'beginner12',
    `the explanatory level did not switch: ${levelBefore.conceptLevelShown} -> ` +
      `${levelAfter.conceptLevelShown}`,
  );
  check(
    levelClick.texts === 1,
    `${levelClick.texts} explanatory levels are on screen at once; the report asks for optional ` +
      `depth, not a wall of text`,
  );

  // Density: `face` claims 38 of the 90 symbols. The panel ranks and caps.
  await page.evaluate('window.__sesame.selectSymbol("setFace")');
  await sleep(400);
  const density = await page.evaluate(`(() => {
    const conceptChip = document.querySelector('[data-source-concept="face"]');
    if (conceptChip !== null) conceptChip.click();
    return null;
  })()`);
  void density;
  await sleep(300);
  const faceConcept = await page.evaluate('window.__sesame.sourceExplorer()');
  const shownSymbols = await page.evaluate(
    `document.querySelectorAll('[data-concept-symbol]').length`,
  );
  check(
    faceConcept.conceptId === 'face' && faceConcept.conceptDensity === 38,
    `the face concept reports ${faceConcept.conceptDensity} symbols (expected 38) on concept ` +
      `${faceConcept.conceptId}`,
  );
  check(
    shownSymbols > 0 && shownSymbols <= 6,
    `the concept panel drew ${shownSymbols} symbol chips for a 38-symbol concept — it must cap and ` +
      `page rather than hairball`,
  );

  // ------------------------------------------------------ the conceptual badge
  await page.evaluate('window.__sesame.selectSymbol("runStandPose")');
  await sleep(400);
  const gateF = await page.evaluate('window.__sesame.sourceExplorer()');
  const badge = await page.evaluate(`(() => {
    const node = document.querySelector('[data-module="build-a-leg-pose"]');
    return node === null
      ? null
      : {
          grounding: node.getAttribute('data-grounding'),
          text: node.textContent ?? '',
          title: node.getAttribute('title') ?? '',
        };
  })()`);
  check(
    gateF.conceptualModulesTotal === 7,
    `the artefact declares ${gateF.conceptualModulesTotal} conceptual modules, not the 7 L3 recorded`,
  );
  check(
    badge !== null && badge.grounding === 'conceptual',
    `the "Build a leg pose" module is not badged conceptual on runStandPose: ${JSON.stringify(badge)}`,
  );
  check(
    badge !== null && /conceptual/i.test(badge.text),
    `the conceptual badge is not readable as text: ${JSON.stringify(badge?.text)}`,
  );
  check(
    badge !== null && badge.title.length > 40,
    `the conceptual badge does not carry the reason it cannot be grounded: ${JSON.stringify(badge?.title)}`,
  );

  // ------------------------- the biggest file, then ISSUE-20260823-023 again
  //
  // `face-bitmaps.h` is 3158 lines and 297 kB, hashed in the browser before a
  // line of it is drawn. Loading it is the heaviest thing this pane ever does,
  // so the world-frame check runs AFTER it, not before.
  const bigFileClick = await page.evaluate(`(() => {
    const tab = document.querySelector('[data-source-file="firmware/face-bitmaps.h"]');
    if (tab === null) return { ok: false, why: 'no face-bitmaps.h tab' };
    tab.click();
    return { ok: true };
  })()`);
  check(bigFileClick.ok, `could not open the largest annotated file: ${bigFileClick.why}`);
  const bigFile = await waitFor(
    page.evaluate,
    'window.__sesame.sourceExplorer()',
    (r) => r !== null && r.file === 'firmware/face-bitmaps.h' && r.integrity !== 'loading',
    'the 297 kB face-bitmaps.h to be fetched and hashed in the browser',
  );
  check(
    bigFile.integrity === 'ok',
    `face-bitmaps.h failed its integrity check in the browser: ${bigFile.integrity}`,
  );
  check(
    bigFile.renderedLineCount > 0 && bigFile.renderedLineCount <= 240,
    `the pane painted ${bigFile.renderedLineCount} lines of a 3158-line file — it must cap and say so`,
  );

  const FRAME_EPS_MM_8 = 1e-6;
  await page.evaluate('window.__sesame.run("rest")');
  await waitSceneCaughtUp('the scene to reach the rest pose for the phase 8 frame check');
  const restFrame8 = await page.evaluate('window.__sesame.worldFrame()');
  const frames8 = [];
  if (restFrame8 === null) problems.push('worldFrame() returned null at the phase 8 rest pose');
  else frames8.push({ label: 'phase 8, rest pose, source pane mounted', ...restFrame8 });

  await page.evaluate(`
    window.__waving = true;
    void (async () => {
      while (window.__waving) await window.__sesame.run('stand');
    })();
  `);
  for (let i = 0; i < 6; i++) {
    await sleep(260);
    // Keep the source pane working while the scene moves: a re-render that
    // nudged the world frame is exactly the bug class being re-tested.
    await page.evaluate(
      `window.__sesame.selectSymbol(${i % 2 === 0 ? '"runWavePose"' : '"runStandPose"'})`,
    );
    const f = await page.evaluate('window.__sesame.worldFrame()');
    if (f === null) problems.push('worldFrame() returned null during phase 8');
    else frames8.push({ label: `phase 8, sample ${i + 1}`, ...f });
  }
  await page.evaluate('window.__waving = false');
  await page.evaluate('window.__sesame.stop()');

  const first8 = frames8[0];
  const worst8 = {};
  for (const key of ['groundWorldMm', 'robotRootWorldMm', 'cameraTargetMm', 'cameraPositionMm']) {
    let worst = 0;
    for (const sample of frames8.slice(1)) {
      const a = first8?.[key];
      const b = sample[key];
      if (!Array.isArray(a) || !Array.isArray(b)) continue;
      for (let i = 0; i < 3; i++) worst = Math.max(worst, Math.abs(a[i] - b[i]));
    }
    worst8[key] = worst;
    check(
      worst <= FRAME_EPS_MM_8,
      `${key} moved ${worst.toFixed(6)} mm in world space while the SOURCE pane was mounted, ` +
        `loading a 297 kB file and re-rendering hundreds of code lines (ISSUE-20260823-023)`,
    );
  }
  const contacts8 = frames8.map((f) => f.footContactMm).filter((v) => typeof v === 'number');
  const spread8 = contacts8.length === 0 ? 0 : Math.max(...contacts8) - Math.min(...contacts8);
  check(
    spread8 > 1,
    `the foot contact varied by only ${spread8.toFixed(3)} mm in phase 8, so the world-stability ` +
      `re-check proved nothing`,
  );

  phases.sourceExplorer = {
    ok: true,
    backend: 'sim',
    upstreamCommit: initial.upstreamCommit,
    integrity: { movementSequences: initial.integrity, faceBitmaps: bigFile.integrity },
    lineNumbers: {
      symbol: 'runWavePose',
      startLine: wave.symbol?.startLine ?? null,
      endLine: wave.symbol?.endLine ?? null,
      renderedStartLineText: wave.renderedStartLineText,
      annotatedStartLineText: wave.symbol?.startLineText ?? null,
      window: [wave.renderedFirstLine, wave.renderedLastLine],
      citedLines: wave.citedLines,
    },
    crossLink: {
      symbolToNode: waveGraph.selectedNodeId,
      symbolToJoints: waveScene.litJoints,
      symbolToTraceLayers: wave.runtimeRowLayers,
      jointToSymbol: fromScene.symbolId,
      jointToSymbolRobotParts: fromScene.symbol?.robotParts ?? [],
      scrolledIntoView: scrolled.ok === true,
    },
    registers: {
      description: registers.description,
      commentary: registers.commentary,
      libraryEvidence: registers.library,
    },
    concepts: {
      levelsOnScreenAtOnce: levelClick.texts,
      switchedTo: levelAfter.conceptLevelShown,
      denseConcept: faceConcept.conceptId,
      density: faceConcept.conceptDensity,
      symbolChipsShown: shownSymbols,
    },
    curriculum: {
      conceptualTotal: gateF.conceptualModulesTotal,
      badged: badge,
    },
    worldFrame: {
      toleranceMm: FRAME_EPS_MM_8,
      worstDriftMm: worst8,
      footContactSpreadMm: spread8,
      samples: frames8.length,
    },
    shots: sourceShots.map((shot) => shot.name),
  };
}

// ---------------------------------------------------------------- phase 10
//
// PHASE 10: LEARN MODE — lesson 2 played end to end, by the DOM.
//
// The runner's whole claim is that a success condition passes because the robot
// reached the asserted state, never because a button was pressed. A phase that
// only asserted "the pane rendered" would prove nothing about that, so this one
// PLAYS two lessons: it drives the controls the way a learner does — real
// clicks, real `input` events on real sliders — and asserts each check flips to
// `passed` only when the underlying state is right.
//
// Three checks are driven to `failed` FIRST, on purpose:
//
//   * name the wrong joint module,
//   * command R1 to 90 when the step asks for 135,
//   * write channel 3, which the `if (channel < 8)` guard lets through, when
//     the step is about a channel it drops.
//
// A check that has never failed is not known to work: it could be a constant.
//
// It also asserts what the research report and L5 §6 ask for structurally —
// exactly one explanation level on screen, `goDeeper` collapsed, the
// `conceptual` badge driven by `grounding` (including on the three conceptual
// modules that DO carry symbols), `boundaryNote` in its own register, the seven
// faults split by `injectorIsLabFeature`, and every unbuilt control rendering a
// visible refusal — and re-runs the ISSUE-20260823-023 world-frame check with
// the new pane mounted.
{
  const lessonShots = [];
  const LESSONS_EXPR = 'window.__sesame.lessons()';

  await openSection(page.evaluate, 'learn');

  /** A real click. SVG modules are `<g>`, which has no `HTMLElement.click()`. */
  const clickOn = (selector) =>
    page.evaluate(`(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (el === null) return { ok: false, why: 'not on screen' };
      if (typeof el.click === 'function') el.click();
      else el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      return { ok: true };
    })()`);

  /**
   * Move a real `<input type="range">`.
   *
   * React installs its own `value` setter on the element, so assigning
   * `el.value` and dispatching `input` is ignored. Going through the prototype
   * descriptor is the documented way to drive a controlled input from outside
   * React, and it is a genuine DOM interaction — not a call into the app.
   */
  const setRange = (selector, value) =>
    page.evaluate(`(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (el === null) return { ok: false, why: 'not on screen' };
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      setter.call(el, String(${JSON.stringify(String(value))}));
      el.dispatchEvent(new Event('input', { bubbles: true }));
      return { ok: true, value: el.value };
    })()`);

  /** Choose an option in a real `<select>`, the React-controlled way. */
  const selectOption = (selector, value) =>
    page.evaluate(`(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (el === null) return { ok: false, why: 'not on screen' };
      const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set;
      setter.call(el, ${JSON.stringify(value)});
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return { ok: true, value: el.value };
    })()`);

  const attrOf = (selector, name) =>
    page.evaluate(`(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      return el === null ? null : el.getAttribute(${JSON.stringify(name)});
    })()`);

  /** Wait for the ACTIVE step's check to reach a status. 250 ms evaluator tick. */
  const waitCheck = async (status, what, timeoutMs = 15000) =>
    waitFor(
      page.evaluate,
      `window.__sesame.lessons().checkStatus`,
      (value) => value === status,
      `${what} (check to read "${status}")`,
      timeoutMs,
    );

  const openStep = async (index) => {
    const lesson = await page.evaluate(`(() => {
      const nav = document.querySelector('[data-testid="lesson-step-nav"]');
      const chip = nav?.children?.[${index}];
      if (chip == null) return { ok: false };
      chip.click();
      return { ok: true };
    })()`);
    await sleep(350);
    return lesson;
  };

  // ------------------------------------------------- the list, and the badge
  //
  // Progress is per-browser-profile and the profile is fresh, but say so out
  // loud rather than depending on it: a stale record would silently skip the
  // progression assertions below.
  await page.evaluate(`(() => { try { localStorage.removeItem('sesame-lab.lessons.v1'); } catch { /* blocked */ } })()`);
  await page.evaluate(`(() => {
    const back = document.querySelector('[data-testid="lesson-back"]');
    if (back !== null) back.click();
  })()`);
  await sleep(300);

  const list = await page.evaluate(LESSONS_EXPR);
  check(list.lessonCount === 19, `the runner offers ${list.lessonCount} modules, not 19`);
  check(
    list.lessonCards.length === 19,
    `the lesson list painted ${list.lessonCards.length} cards, not 19`,
  );

  const conceptualCards = list.lessonCards.filter((c) => c.grounding === 'conceptual');
  check(
    conceptualCards.length === 7,
    `${conceptualCards.length} modules are badged conceptual; hardware/lessons.json has 7`,
  );
  check(
    conceptualCards.every((c) => c.conceptualBadge),
    `a conceptual module rendered no badge: ${JSON.stringify(conceptualCards.filter((c) => !c.conceptualBadge))}`,
  );
  // The point of L4 §6.3: these three carry firmware symbols, so a badge driven
  // by "symbols is empty" would leave them unlabelled. They are badged here
  // because the badge reads `grounding`.
  for (const id of ['build-a-leg-pose', 'build-a-movement', 'inside-the-brain']) {
    const card = list.lessonCards.find((c) => c.id === id);
    check(
      card?.conceptualBadge === true && card.grounding === 'conceptual',
      `${id} carries symbols and must still be badged conceptual; card was ${JSON.stringify(card)}`,
    );
  }
  check(
    list.lessonCards.filter((c) => c.status === 'polished').length === 6,
    `the list marks ${list.lessonCards.filter((c) => c.status === 'polished').length} modules polished, not 6`,
  );
  check(
    list.lessonCards.find((c) => c.id === 'command-one-joint')?.locked === true,
    'lesson 2 is not locked before lesson 1 has been passed',
  );
  check(
    list.unimplementedControls.length === 6 && list.implementedChecks.length === 26,
    `the registry claims ${list.implementedChecks.length} checks and ${list.unimplementedControls.length} unbuilt controls`,
  );

  // A conceptual module opens READ-ONLY while locked, and its banner is there.
  await clickOn('[data-testid="lesson-card-build-a-leg-pose"]');
  await sleep(350);
  const conceptualOpen = await page.evaluate(LESSONS_EXPR);
  check(
    conceptualOpen.openLessonId === 'build-a-leg-pose' && conceptualOpen.conceptualBadge,
    `opening build-a-leg-pose showed no conceptual banner: ${JSON.stringify({
      open: conceptualOpen.openLessonId,
      badge: conceptualOpen.conceptualBadge,
    })}`,
  );
  check(
    conceptualOpen.outlineMode === true,
    'a locked, outline module rendered as playable',
  );
  await focusSection(page.evaluate, 'learn');
  lessonShots.push(
    await page.shoot(
      'l6-lesson-conceptual-badge.png',
      'build-a-leg-pose — a conceptual module that DOES carry firmware symbols, badged from ' +
        'curriculum[].grounding rather than from an empty symbol list, and readable while locked',
    ),
  );
  await clickOn('[data-testid="lesson-back"]');
  await sleep(300);

  // -------------------------------------------------------- lesson 1, played
  //
  // Not decoration: lesson 2 is locked until every step of lesson 1 has PASSED,
  // so playing it is the proof that progression is by demonstration.
  await clickOn('[data-testid="lesson-card-meet-sesame"]');
  await sleep(400);

  // Step 1 — name the eight modules. One wrong answer first.
  const firstAsk = await attrOf('[data-testid="joint-quiz"]', 'data-asking');
  check(firstAsk === 'R1', `the naming quiz opened on ${firstAsk}, not the first joint in enum order`);
  await clickOn('[data-testid="explode-module-L4"]');
  await waitCheck('failed', 'naming R1 as L4');
  const wrongNaming = await page.evaluate(LESSONS_EXPR);
  check(
    (wrongNaming.checkSummary ?? '').includes('wrongly'),
    `a wrong joint name did not read as wrong: ${wrongNaming.checkSummary}`,
  );
  // Answer whatever it asks for, waiting for the prompt to ADVANCE each time.
  // Reading `data-asking` on a fixed sleep raced React and produced a stale
  // prompt, which then recorded a right name against the wrong joint — a very
  // good demonstration that the check notices, and a very bad way to drive it.
  for (let guard = 0; guard < 20; guard += 1) {
    const asking = await attrOf('[data-testid="joint-quiz"]', 'data-asking');
    if (asking === null || asking === '') break;
    await clickOn(`[data-testid="explode-module-${asking}"]`);
    await waitFor(
      page.evaluate,
      `document.querySelector('[data-testid="joint-quiz"]')?.getAttribute('data-asking') ?? null`,
      (value) => value !== asking,
      `the naming quiz to advance past ${asking}`,
      8000,
    );
  }
  await waitCheck('passed', 'naming all eight joints');

  // Step 2 — the board switch. Names must not move with the pins.
  await openStep(1);
  await clickOn('[data-testid="board-s2-mini"]');
  await sleep(150);
  await clickOn('[data-testid="board-distro-v1"]');
  await waitCheck('passed', 'switching the board profile');
  const boardStep = await page.evaluate(LESSONS_EXPR);
  check(
    (boardStep.checkObserved ?? '').includes('R1: 1'),
    `the board switch did not report R1's pin moving: ${boardStep.checkObserved}`,
  );

  // Step 3 — the graph node, followed down to the line that creates the display.
  //
  // The control is the architecture graph, not the source outline: the check is
  // `source-span-selected: display-object`, and it passes because selecting the
  // `oled` node resolves — by line containment, at runtime — onto the symbol
  // that declares it. Nothing here asserts the link; the shared selection does.
  await openStep(2);
  await clickOn('[data-testid="graph-node-oled"]');
  await waitCheck('passed', 'following the OLED node down to its declaration');
  const nodeToSymbol = await page.evaluate('window.__sesame.selection()');
  check(
    nodeToSymbol.symbolId === 'display-object' && nodeToSymbol.nodeId === 'oled',
    `following the oled node landed on ${JSON.stringify(nodeToSymbol)}`,
  );

  // Step 4 — run stand, and hold all eight commanded angles.
  await openStep(3);
  await clickOn('[data-testid="run-stand"]');
  await waitCheck('passed', 'the eight channels reaching runStandPose’s vector', 25000);

  // Step 5 — read the pwm.output badge. Wrong answer first.
  await openStep(4);
  await clickOn('[data-testid="quiz-badge-simulated"]');
  await waitCheck('failed', 'calling the pwm.output row simulated');
  await clickOn('[data-testid="quiz-badge-inferred-for-explanation"]');
  await waitCheck('passed', 'identifying pwm.output as computed rather than observed');

  const lesson1 = await page.evaluate(LESSONS_EXPR);
  check(
    lesson1.stepOutcomes.length === 5 && lesson1.stepOutcomes.every((s) => s.outcome === 'passed'),
    `lesson 1 finished as ${JSON.stringify(lesson1.stepOutcomes)}`,
  );
  const cold = lesson1.challenges.find((c) => c.id === 'ch-name-a-joint-cold');
  check(
    cold?.unlocked === true,
    'the starter challenge did not unlock after its named success was demonstrated',
  );

  // ------------------------------------------------- lesson 2, end to end
  await clickOn('[data-testid="lesson-back"]');
  await sleep(350);
  const afterOne = await page.evaluate(LESSONS_EXPR);
  check(
    afterOne.lessonCards.find((c) => c.id === 'command-one-joint')?.locked === false,
    'passing every step of lesson 1 did not unlock lesson 2',
  );

  // Leave R1 at an angle lesson 2's first step does NOT ask for. `stand` put it
  // on 135 a moment ago, and a check that opened already satisfied would prove
  // nothing about whether it can fail. This goes through the app's own command
  // path, so it is journalled exactly as the slider's would be.
  await page.evaluate('window.__sesame.setJoint("R1", 90)');
  await sleep(700);

  await clickOn('[data-testid="lesson-card-command-one-joint"]');
  await sleep(400);

  // --- the structural claims, on a real step -----------------------------
  const opened = await page.evaluate(LESSONS_EXPR);
  check(
    opened.explanationCount === 1,
    `${opened.explanationCount} explanation levels are on screen at once; the switch must replace, not stack`,
  );
  check(
    opened.shownLevel === 'beginner12',
    `the runner opened on the "${opened.shownLevel}" level, not beginner12`,
  );
  await clickOn('[data-testid="lesson-level-architecture"]');
  await sleep(250);
  const switched = await page.evaluate(LESSONS_EXPR);
  check(
    switched.explanationCount === 1 && switched.shownLevel === 'architecture',
    `after switching levels the pane showed ${switched.explanationCount} at "${switched.shownLevel}"`,
  );
  await clickOn('[data-testid="lesson-level-beginner12"]');
  await sleep(200);

  // --- step 1: servo-target. It opens FAILED, on the real angle. ---------
  await waitCheck('failed', 'R1 sitting at 90 when the step asks for 135');
  const wrongAngle = await page.evaluate(LESSONS_EXPR);
  check(
    (wrongAngle.checkObserved ?? '').includes('90'),
    `the failed servo-target check reported ${wrongAngle.checkObserved}`,
  );
  const sceneAt90 = await page.evaluate('window.__sesame.sceneJoints()');
  check(
    Math.abs((sceneAt90.find((j) => j.joint === 'R1')?.sceneCommandedDeg ?? 0) - 90) < 1,
    `the three.js scene did not follow the lesson slider to 90°: ` +
      `${JSON.stringify(sceneAt90.find((j) => j.joint === 'R1'))}`,
  );

  await setRange('[data-testid="joint-slider-input"]', 135);
  await clickOn('[data-testid="joint-slider-send"]');
  await waitCheck('passed', 'commanding R1 to 135');
  const step1 = await page.evaluate(LESSONS_EXPR);
  check(
    step1.checkType === 'servo-target' && (step1.checkObserved ?? '').includes('135'),
    `step 1 passed reporting ${JSON.stringify({ type: step1.checkType, observed: step1.checkObserved })}`,
  );
  const step1Challenges = step1.challenges.find((c) => c.id === 'ch-three-angles');
  check(
    step1Challenges?.unlocked === true,
    'ch-three-angles did not unlock from the success it names',
  );

  // --- step 2: telemetry-absent. A channel the guard lets through first. --
  await openStep(1);
  await setRange('[data-testid="channel-input"]', 3);
  await page.evaluate(`(() => {
    const el = document.querySelector('[data-testid="channel-input"]');
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setter.call(el, '3');
    el.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
  await clickOn('[data-testid="channel-send"]');
  await waitCheck('failed', 'writing channel 3, which is inside the guard');
  const leaked = await page.evaluate(LESSONS_EXPR);
  check(
    (leaked.checkSummary ?? '').includes('DID arrive'),
    `the absence check did not notice the row that arrived: ${leaked.checkSummary}`,
  );

  await page.evaluate(`(() => {
    const el = document.querySelector('[data-testid="channel-input"]');
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setter.call(el, '8');
    el.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
  await clickOn('[data-testid="channel-send"]');
  await waitCheck('passed', 'channel 8 producing no servo.target inside the window');

  // --- step 3: subtrim before the clamp. goDeeper must be collapsed. ------
  await openStep(2);
  const godeeper = await page.evaluate(LESSONS_EXPR);
  check(
    godeeper.goDeeperOpen === false,
    `the goDeeper block opened by default (${JSON.stringify(godeeper.goDeeperOpen)}) — that is the ` +
      `wall of text the report warns about`,
  );
  check(
    godeeper.stepKind === 'debug',
    `step 3 rendered as kind "${godeeper.stepKind}", not debug`,
  );
  await setRange('[data-testid="subtrim-R1"]', 40);
  await sleep(250);
  await setRange('[data-testid="subtrim-angle"]', 160);
  await clickOn('[data-testid="subtrim-send-button"]');
  await sleep(500);
  await setRange('[data-testid="subtrim-angle"]', 180);
  await clickOn('[data-testid="subtrim-send-button"]');
  await waitCheck('passed', 'two requests colliding on one commanded angle');
  const collision = await page.evaluate(LESSONS_EXPR);
  check(
    (collision.checkObserved ?? '').includes('160°→180°'),
    `the collision check reported ${collision.checkObserved}`,
  );
  // Read back off the SCENE, not off the check: 160 + 40 saturates at 180 and
  // the robot really is drawn there.
  const sceneSaturated = await page.evaluate('window.__sesame.sceneJoints()');
  check(
    Math.abs((sceneSaturated.find((j) => j.joint === 'R1')?.sceneCommandedDeg ?? 0) - 180) < 1,
    `R1 is drawn at ${sceneSaturated.find((j) => j.joint === 'R1')?.sceneCommandedDeg}°, not the ` +
      `saturated 180°`,
  );

  // --- step 4: two angles, one tick count. Recomputed, not read. ---------
  await openStep(3);
  await setRange('[data-testid="pwm-angle"]', 99);
  await sleep(250);
  await setRange('[data-testid="pwm-angle"]', 100);
  await waitCheck('passed', '99° and 100° programming the same tick count');
  const ticks = await page.evaluate(`(() => {
    const el = document.querySelector('[data-testid="pwm-ticks"]');
    return el === null ? null : el.textContent.trim();
  })()`);
  check(
    (ticks ?? '').startsWith('87'),
    `the PWM inspector reads "${ticks}" for 100°; quantiseCommandedAngle() says 87 ticks`,
  );

  // --- step 5: the whole ladder --------------------------------------------
  //
  // Waiting for `checkStatus === "passed"` alone is not enough here, and the
  // reason is worth writing down: lesson 1's `run-stand` left a COMPLETE trace
  // on screen, so the check is already passed when this step opens. A bare
  // `waitCheck('passed')` therefore returns on the previous trace and the read
  // that follows it lands somewhere inside the new one — "7 of 8", with
  // `visual.joint` still a `useFrame` sample away. So wait for the observed
  // string that only the PASSED branch produces, on the trace this click
  // opened, which is a strictly stronger condition than the status alone.
  await openStep(4);
  await clickOn('[data-testid="trace-run-stand"]');
  const ladder = await waitFor(
    page.evaluate,
    LESSONS_EXPR,
    (v) => v !== null && v.checkStatus === 'passed' && (v.checkObserved ?? '').includes('visual.joint'),
    'one command producing a row on every rung, the last of them read off Object3D.quaternion',
    30000,
  );
  check(
    (ladder.checkObserved ?? '').includes('visual.joint'),
    `the ladder check passed without the last rung: ${ladder.checkObserved}`,
  );

  // --- step 6: reach delayWithFace FROM setServoAngle -----------------------
  await openStep(5);
  const boundary = await page.evaluate(LESSONS_EXPR);
  check(
    boundary.controlKind === 'source-selector',
    `step 6 bound the "${boundary.controlKind}" control`,
  );
  // Straight to delayWithFace is not enough: the step asks for the route.
  await clickOn('[data-testid="open-symbol-delayWithFace"]');
  await sleep(600);
  const direct = await page.evaluate(LESSONS_EXPR);
  check(
    direct.checkStatus === 'pending',
    `opening delayWithFace out of nowhere satisfied a check that names how it was reached ` +
      `(${direct.checkStatus})`,
  );
  await clickOn('[data-cite-symbol="setServoAngle"]');
  await sleep(500);
  await clickOn('[data-testid="open-symbol-delayWithFace"]');
  await waitCheck('passed', 'reaching delayWithFace from setServoAngle');

  const lesson2 = await page.evaluate(LESSONS_EXPR);
  check(
    lesson2.stepOutcomes.length === 6 && lesson2.stepOutcomes.every((s) => s.outcome === 'passed'),
    `lesson 2 finished as ${JSON.stringify(lesson2.stepOutcomes)}`,
  );
  check(
    lesson2.challenges.every((c) => c.unlocked),
    `a lesson 2 challenge stayed locked after its success was demonstrated: ` +
      `${JSON.stringify(lesson2.challenges)}`,
  );

  await focusSection(page.evaluate, 'learn');
  lessonShots.push(
    await page.shoot(
      'l6-lesson-two-complete.png',
      'command-one-joint played end to end: six checks passed against real telemetry, the source ' +
        'explorer on delayWithFace, and both challenges unlocked by demonstration',
    ),
  );

  // ---------------------------------------------- boundaryNote, in its own register
  //
  // Lesson 1 step 5 is the emulator claim: the pwm.output row is computed here
  // and no pin has ever emitted it. That is not a caveat on a Sesame fact, and
  // it must not render as one.
  await clickOn('[data-testid="lesson-back"]');
  await sleep(300);
  await clickOn('[data-testid="lesson-card-meet-sesame"]');
  await sleep(350);
  await openStep(4);
  const emulatorStep = await page.evaluate(LESSONS_EXPR);
  check(
    emulatorStep.boundaryNoteCount === 1 && emulatorStep.boundaryDomains[0] === 'emulator',
    `the emulator claim rendered ${emulatorStep.boundaryNoteCount} boundary note(s) ` +
      `${JSON.stringify(emulatorStep.boundaryDomains)}`,
  );
  check(
    (emulatorStep.observability ?? '').includes('inert-in-emulator'),
    `the emulator claim did not show its observability value: ${emulatorStep.observability}`,
  );
  const registers = await page.evaluate(`(() => {
    const panel = document.querySelector('[data-testid="lesson-runner"]');
    const boundary = panel?.querySelector('[data-testid="lesson-boundary-note"]');
    const prose = panel?.querySelector('[data-testid="lesson-explanation"]');
    if (boundary == null || prose == null) return null;
    const b = getComputedStyle(boundary);
    const p = getComputedStyle(prose);
    return {
      boundaryBorderStyle: b.borderTopStyle,
      boundaryBackground: b.backgroundColor,
      proseBorderStyle: p.borderTopStyle,
      proseBackground: p.backgroundColor,
    };
  })()`);
  check(
    registers !== null &&
      registers.boundaryBorderStyle === 'dashed' &&
      registers.boundaryBackground !== registers.proseBackground,
    `boundaryNote is not visually distinct from ordinary prose: ${JSON.stringify(registers)}`,
  );

  // -------------------------------------------------- the refusals, rendered
  //
  // An unbuilt control must be impossible to mistake for a built one. Lesson 8
  // opens on a serial-console step, which this runner does not build.
  await clickOn('[data-testid="lesson-back"]');
  await sleep(300);
  await clickOn('[data-testid="lesson-card-talk-over-serial"]');
  await sleep(350);
  const outlineLesson = await page.evaluate(LESSONS_EXPR);
  check(
    outlineLesson.outlineMode === true,
    'an outline module rendered as if it were playable',
  );
  const notBuiltBadges = await page.evaluate(`(() => {
    const panel = document.querySelector('[data-testid="lesson-runner"]');
    return [...(panel?.querySelectorAll('.badge.is-notbuilt') ?? [])].length;
  })()`);
  check(
    notBuiltBadges >= 1,
    `lesson 8 uses the unbuilt serial-console and marked ${notBuiltBadges} steps as not built`,
  );

  // --------------------------------------------------- lessons 4 and 5, played
  //
  // Not for their own sake: `read-the-firmware` names both as prerequisites, so
  // the only way to reach its fault-injector step is to have PASSED every step
  // of both. That is the progression rule under test.

  // ===== lesson 4 — four-legs-cooperate ==================================
  await clickOn('[data-testid="lesson-back"]');
  await sleep(300);
  await clickOn('[data-testid="lesson-card-four-legs-cooperate"]');
  await sleep(400);

  // The +40 of subtrim lesson 2 left on R1 is still there, and `stand` would
  // command 175° instead of 135°. That is real, sticky lab state and the banner
  // says so on every step; put it back the way a learner would.
  const labMods = await page.evaluate(`document.querySelector('[data-testid="lab-modifications"]') !== null`);
  check(labMods === true, 'the lab did not say that it was still holding +40 of subtrim on R1');
  await clickOn('[data-testid="lab-modifications-clear"]');
  await sleep(400);

  // 1. a movement is a list of commanded angles
  await clickOn('[data-testid="run-stand"]');
  await waitCheck('passed', 'the stand pose vector, in lesson 4', 25000);

  // 2. which joints does wave's own body command? Wrong answer first.
  await openStep(1);
  await clickOn('[data-testid="quiz-joint-R1"]');
  await clickOn('[data-testid="quiz-joint-submit"]');
  await waitCheck('failed', 'claiming wave commands only R1');
  for (const joint of ['L2', 'R4', 'L3']) {
    await clickOn(`[data-testid="quiz-joint-${joint}"]`);
    await sleep(80);
  }
  await clickOn('[data-testid="quiz-joint-submit"]');
  await waitCheck('passed', 'listing the four joints runWavePose commands');

  // 3. timing is in the list too — import wave, run it, slow it down, run again
  await openStep(2);
  await selectOption('[data-testid="sequence-import"]', 'runWavePose');
  await sleep(400);
  await clickOn('[data-testid="sequence-run"]');
  await waitFor(
    page.evaluate,
    `document.querySelector('[data-testid="sequence-run"]')?.disabled ?? true`,
    (value) => value === false,
    'the baseline sequence run to finish',
    45000,
  );
  await clickOn('[data-testid="sequence-slower"]');
  await sleep(200);
  await clickOn('[data-testid="sequence-run-variant"]');
  await waitFor(
    page.evaluate,
    `document.querySelector('[data-testid="sequence-run"]')?.disabled ?? true`,
    (value) => value === false,
    'the slowed sequence run to finish',
    60000,
  );
  await waitCheck('passed', 'a timing change leaving the terminal pose alone', 20000);

  // 4. stand is an exit — wave ends in the idle face
  await openStep(3);
  await clickOn('[data-testid="run-wave"]');
  await waitCheck('passed', 'the face after runWavePose settling on idle', 30000);

  // 5. cancelling a walk is not free
  await openStep(4);
  await clickOn('[data-testid="run-forward"]');
  await sleep(1200);
  await clickOn('[data-testid="run-stand"]');
  await waitCheck('passed', 'the cancel path running a whole stand pose', 30000);

  // 6. author a sequence of your own
  await openStep(5);
  await clickOn('[data-testid="sequence-run"]');
  await waitFor(
    page.evaluate,
    `document.querySelector('[data-testid="sequence-run"]')?.disabled ?? true`,
    (value) => value === false,
    'the authored sequence to finish',
    60000,
  );
  await waitCheck('passed', 'an authored sequence with every angle in range', 20000);

  // 7. where kinematics would go
  await openStep(6);
  await clickOn('[data-testid="open-symbol-runStandPose"]');
  await waitCheck('passed', 'opening runStandPose');

  const lesson4 = await page.evaluate(LESSONS_EXPR);
  check(
    lesson4.stepOutcomes.length === 7 && lesson4.stepOutcomes.every((s) => s.outcome === 'passed'),
    `lesson 4 finished as ${JSON.stringify(lesson4.stepOutcomes)}`,
  );

  // ===== lesson 5 — sesames-face ==========================================
  await clickOn('[data-testid="lesson-back"]');
  await sleep(300);
  await clickOn('[data-testid="lesson-card-sesames-face"]');
  await sleep(400);

  await clickOn('[data-testid="open-symbol-FACE_LIST"]');
  await waitCheck('passed', 'opening FACE_LIST');

  await openStep(1);
  await clickOn('[data-testid="face-happy"]');
  await waitCheck('passed', 'the happy face drawing at least one frame', 15000);

  // The blank `stand` face: zero frames drawn AND the name quietly rewritten.
  await openStep(2);
  await clickOn('[data-testid="face-stand"]');
  await waitCheck('passed', 'setFace("stand") drawing nothing and reporting "default"', 15000);
  const fallback = await page.evaluate(LESSONS_EXPR);
  check(
    (fallback.checkObserved ?? '').includes('"default"'),
    `the fallback check reported ${fallback.checkObserved}`,
  );

  // TN-013: asking twice draws nothing the second time.
  await openStep(3);
  await clickOn('[data-testid="face-wave"]');
  await sleep(900);
  await clickOn('[data-testid="face-wave"]');
  await waitCheck('passed', 'the second setFace early-returning', 15000);

  // The playback mode is one global, set per call site. Wrong answer first.
  await openStep(4);
  await clickOn('[data-testid="run-wave"]');
  await sleep(2500);
  await clickOn('[data-testid="quiz-mode-loop"]');
  await waitCheck('failed', 'calling runWavePose’s face mode loop', 30000);
  await clickOn('[data-testid="quiz-mode-once"]');
  await waitCheck('passed', 'identifying the once mode runWavePose sets', 30000);

  // Draw a frame into the same buffer a face bitmap goes through.
  await openStep(5);
  await page.evaluate(`(() => {
    const canvas = document.querySelector('[data-testid="pixel-canvas"]');
    if (canvas === null) return { ok: false };
    const box = canvas.getBoundingClientRect();
    const at = (px, py) => ({
      clientX: box.left + ((px + 0.5) / 128) * box.width,
      clientY: box.top + ((py + 0.5) / 64) * box.height,
      bubbles: true,
      isPrimary: true,
      pointerId: 1,
    });
    canvas.dispatchEvent(new PointerEvent('pointerdown', at(20, 20)));
    for (let y = 20; y < 23; y += 1) {
      for (let x = 20; x < 23; x += 1) {
        canvas.dispatchEvent(new PointerEvent('pointermove', at(x, y)));
      }
    }
    canvas.dispatchEvent(new PointerEvent('pointerup', at(22, 22)));
    return { ok: true };
  })()`);
  await waitCheck('passed', 'a 3x3 shape drawn into the 128x64 frame', 15000);

  // ============ W5: THE SAME EDITOR, WITHOUT A POINTER THAT CAN DRAG ========
  //
  // > *"WCAG 2.2 requires a non-dragging alternative for drag operations unless
  // > dragging is essential."* — the brief, on the Lab's editors
  //
  // Until W5 the only way into this 8,192-pixel bitmap was `pointerdown` +
  // `pointermove`: there was no `keydown` handler at all and the canvas was not
  // focusable, so this block could not have passed against the previous build.
  // It drives the real keys and reads the caret's own read-out, which is the
  // live region a reader who cannot see the two-pixel outline depends on.
  //
  // The pixel is toggled ON and then OFF again, so the frame this leaves behind
  // is byte-identical to the one the pointer drew and the lesson step above
  // stays passed on its own evidence rather than on this one's leftovers.
  {
    const key = (name) =>
      page.evaluate(`(() => {
        const canvas = document.querySelector('[data-testid="pixel-canvas"]');
        if (canvas === null) return null;
        canvas.focus();
        canvas.dispatchEvent(
          new KeyboardEvent('keydown', { key: ${JSON.stringify(name)}, bubbles: true }),
        );
        return document.activeElement === canvas;
      })()`);

    const caret = () =>
      page.evaluate(
        `(document.querySelector('[data-testid="pixel-caret"]')?.innerText ?? '').replace(/\\s+/g, ' ').trim()`,
      );

    /*
      RELATIVE, not absolute, and the first version of this check was not.

      It asserted the caret landed on (3, 0) after three ArrowRights, and failed
      with "(25, 22)" — because the pointer drag above ended at (22, 22) and the
      caret carries over from it, which is the correct behaviour and is the
      whole point of having one cursor rather than two. The fix is to read where
      the caret is and assert the MOVEMENT, which is a stronger claim anyway:
      "three ArrowRights move exactly three pixels right and none down" cannot
      be satisfied by a caret that ignores the keys.
    */
    const coords = (text) => {
      const m = /\((\d+), (\d+)\)/.exec(text);
      return m === null ? null : { x: Number(m[1]), y: Number(m[2]) };
    };

    const focused = await key('ArrowRight');
    check(
      focused === true,
      'the 128x64 pixel editor did not take keyboard focus. WCAG 2.2 asks for a single-pointer ' +
        'alternative to a drag, and a canvas nothing can focus has none.',
    );
    const afterOne = coords(await caret());
    await key('ArrowRight');
    await key('ArrowRight');
    const afterThree = coords(await caret());
    check(
      afterOne !== null &&
        afterThree !== null &&
        afterThree.x === afterOne.x + 2 &&
        afterThree.y === afterOne.y,
      `two more ArrowRights moved the pixel caret from ${JSON.stringify(afterOne)} to ` +
        `${JSON.stringify(afterThree)}. Arrow keys move it one bitmap pixel, on the axis pressed ` +
        'and no other.',
    );

    await key(' ');
    await sleep(200);
    const litReadout = await caret();
    const litAt = coords(litReadout);
    const expectedByte =
      litAt === null ? null : litAt.x + (litAt.y >> 3) * 128;
    check(
      litAt !== null &&
        litAt.x === afterThree?.x &&
        litAt.y === afterThree?.y &&
        litReadout.includes(`byte ${String(expectedByte)}`) &&
        litReadout.includes('1'),
      `Space at ${JSON.stringify(afterThree)} left the pixel editor reading ` +
        `${JSON.stringify(litReadout)}. It should name the pixel under the caret, its GDDRAM byte ` +
        `(x + (y >> 3) * 128 = ${String(expectedByte)}), and that it is now lit — the keyboard ` +
        'path and its live read-out are one feature.',
    );

    await key(' ');
    await sleep(200);
    const darkReadout = await caret();
    check(
      darkReadout.includes('dark') && coords(darkReadout)?.x === afterThree?.x,
      `toggling the same pixel back off left the read-out at ${JSON.stringify(darkReadout)}; ` +
        'Space is a toggle, so the frame the lesson step was checked against is restored.',
    );
  }
  await clickOn('[data-testid="pixel-push"]');
  await sleep(400);
  const pushed = await page.evaluate('window.__sesame.oled()');
  check(
    (pushed.litPixels ?? 0) > 0,
    `pushing the authored frame lit ${pushed.litPixels} pixels on the virtual panel`,
  );

  const lesson5 = await page.evaluate(LESSONS_EXPR);
  check(
    lesson5.stepOutcomes.length === 6 && lesson5.stepOutcomes.every((s) => s.outcome === 'passed'),
    `lesson 5 finished as ${JSON.stringify(lesson5.stepOutcomes)}`,
  );

  // ===== lesson 6 — read-the-firmware, and the boundary it cannot cross ====
  //
  // Two of its six steps drive the firmware's own HTTP routes, and those routes
  // only exist in front of a robot — `apps/web/server/lab-host.mjs`. This page
  // is served by the Phase-0 bridge's static server, so there is no `/api/status`
  // here, and the point of asserting it is that the console reports the REAL
  // failure instead of synthesising a 200. Those two steps are then SKIPPED, and
  // the skip is recorded as a skip: lesson 6 does not complete, and nothing
  // downstream unlocks.
  await clickOn('[data-testid="lesson-back"]');
  await sleep(300);
  await clickOn('[data-testid="lesson-card-read-the-firmware"]');
  await sleep(400);
  const lesson6Open = await page.evaluate(LESSONS_EXPR);
  check(
    lesson6Open.openLessonId === 'read-the-firmware' && lesson6Open.outlineMode === false,
    `lesson 6 did not open playable after 4 and 5 were passed: ${JSON.stringify({
      open: lesson6Open.openLessonId,
      outline: lesson6Open.outlineMode,
    })}`,
  );

  await clickOn('[data-testid="open-symbol-loop"]');
  await waitCheck('passed', 'opening loop()');

  await openStep(1);
  await clickOn('[data-testid="run-wave"]');
  await sleep(500);
  await clickOn('[data-testid="open-symbol-command-dispatch"]');
  await waitCheck('passed', 'opening the command dispatcher');

  // The honest failure: no robot is serving the firmware's routes here.
  await openStep(2);
  await clickOn('[data-testid="http-send"]');
  await waitCheck('failed', 'GET /api/status with nothing serving the robot’s routes', 20000);
  const httpFailure = await page.evaluate(LESSONS_EXPR);
  check(
    (httpFailure.checkSummary ?? '').includes('lab-host'),
    `the HTTP console did not name what is missing: ${httpFailure.checkSummary}`,
  );
  await clickOn('[data-testid="lesson-skip"]');
  await sleep(400);
  const skipped = await page.evaluate(LESSONS_EXPR);
  check(
    skipped.skipped === true,
    'skipping a step did not record it as skipped',
  );

  // -------------------------------------------- faults: real vs injected
  await openStep(3);
  const faultStep = await page.evaluate(LESSONS_EXPR);
  check(
    faultStep.controlKind === 'fault-injector',
    `the fault step bound "${faultStep.controlKind}"`,
  );
  check(
    faultStep.faults.some((f) => f.id === 'oled-init-fail' && f.injected),
    `oled-init-fail is not labelled as injected: ${JSON.stringify(faultStep.faults)}`,
  );
  // Boot with nothing injected first: it must NOT halt, and the check must say so.
  await clickOn('[data-testid="fault-boot"]');
  await waitCheck('failed', 'booting with no fault injected');
  await clickOn('[data-testid="fault-oled-init-fail"]');
  await sleep(200);
  await clickOn('[data-testid="fault-boot"]');
  await waitCheck('passed', 'boot halting at the display step');
  const bootStep = await page.evaluate(LESSONS_EXPR);
  check(
    (bootStep.checkObserved ?? '').includes('SSD1306 allocation failed.'),
    `the boot halt did not print the firmware's own line: ${bootStep.checkObserved}`,
  );
  // The last two steps: one more skip, and one span reached from a trace row.
  await openStep(4);
  await clickOn('[data-testid="lesson-skip"]');
  await sleep(400);
  await openStep(5);
  await clickOn('[data-testid="follow-trace-to-setServoAngle"]');
  await waitCheck('passed', 'following a trace row back into setServoAngle', 15000);
  const lesson6 = await page.evaluate(LESSONS_EXPR);
  const passed6 = lesson6.stepOutcomes.filter((o) => o.outcome === 'passed').length;
  const skipped6 = lesson6.stepOutcomes.filter((o) => o.outcome === 'skipped').length;
  check(
    passed6 === 4 && skipped6 === 2,
    `lesson 6 finished as ${JSON.stringify(lesson6.stepOutcomes)}; expected 4 passed and 2 skipped`,
  );
  await clickOn('[data-testid="lesson-back"]');
  await sleep(350);
  const afterSkips = await page.evaluate(LESSONS_EXPR);
  const card6 = afterSkips.lessonCards.find((c) => c.id === 'read-the-firmware');
  check(
    afterSkips.lessonCards.find((c) => c.id === 'send-an-http-command')?.locked === true,
    `a lesson whose prerequisite has SKIPPED steps unlocked anyway: ${JSON.stringify(card6)}`,
  );
  await clickOn('[data-testid="lesson-card-read-the-firmware"]');
  await sleep(350);
  await openStep(3);

  await focusSection(page.evaluate, 'learn');
  lessonShots.push(
    await page.shoot(
      'l6-lesson-fault-injector.png',
      'the display-init fault, badged INJECTED and dashed because the while(1) is real firmware but ' +
        'making display.begin() fail on demand is Sesame Lab’s — and the boot it halts at bootOrder 4, ' +
        'printing the line the firmware itself prints',
    ),
  );

  // ------------------------------------- ISSUE-20260823-023, pane mounted
  //
  // A third grid row is a new chance for the world frame to move. Same check as
  // phases 7 and 8, with Learn mode open on a lesson.
  const FRAME_EPS_MM_10 = 1e-6;
  const frames10 = [];
  const before10 = await page.evaluate('window.__sesame.worldFrame()');
  if (before10 === null) problems.push('worldFrame() returned null with the lesson pane mounted');
  else frames10.push({ label: 'phase 10, lesson open', ...before10 });

  await page.evaluate('window.__sesame.run("rest")');
  await waitSceneCaughtUp('the scene to reach the rest pose for the phase 10 frame check');
  const rest10 = await page.evaluate('window.__sesame.worldFrame()');
  if (rest10 === null) problems.push('worldFrame() returned null at the phase 10 rest pose');
  else frames10.push({ label: 'phase 10, rest pose', ...rest10 });

  void page.evaluate('window.__sesame.run("stand")');
  for (let i = 0; i < 10; i += 1) {
    await sleep(160);
    const f = await page.evaluate('window.__sesame.worldFrame()');
    if (f === null) problems.push('worldFrame() returned null during phase 10');
    else frames10.push({ label: `phase 10, sample ${i + 1}`, ...f });
  }
  const first10 = frames10[0];
  const worst10 = {};
  for (const key of ['groundWorldMm', 'robotRootWorldMm', 'cameraTargetMm', 'cameraPositionMm']) {
    let worst = 0;
    for (const sample of frames10.slice(1)) {
      const a = first10?.[key];
      const b = sample[key];
      if (!Array.isArray(a) || !Array.isArray(b)) continue;
      for (let i = 0; i < 3; i++) worst = Math.max(worst, Math.abs(a[i] - b[i]));
    }
    worst10[key] = worst;
    check(
      worst <= FRAME_EPS_MM_10,
      `${key} moved ${worst.toFixed(6)} mm in world space with LEARN MODE mounted and a lesson ` +
        `open (ISSUE-20260823-023)`,
    );
  }
  const contacts10 = frames10.map((f) => f.footContactMm).filter((v) => typeof v === 'number');
  const spread10 = contacts10.length === 0 ? 0 : Math.max(...contacts10) - Math.min(...contacts10);
  check(
    spread10 > 1,
    `the foot contact varied by only ${spread10.toFixed(3)} mm in phase 10, so the world-stability ` +
      `re-check proved nothing`,
  );

  const finalReading = await page.evaluate(LESSONS_EXPR);
  phases.lessonRunner = {
    ok: true,
    backend: 'sim',
    modules: finalReading.lessonCount,
    playable: finalReading.polishedLessonIds,
    implementedControls: finalReading.implementedControls,
    unimplementedControls: finalReading.unimplementedControls,
    implementedChecks: finalReading.implementedChecks,
    lessonOne: lesson1.stepOutcomes,
    lessonTwo: lesson2.stepOutcomes,
    lessonFour: lesson4.stepOutcomes,
    lessonFive: lesson5.stepOutcomes,
    lessonSix: lesson6.stepOutcomes,
    lessonSixNote:
      'two steps drive the firmware’s HTTP routes, which only exist in front of ' +
      'apps/web/server/lab-host.mjs. Served by the bridge, the console reports the real failure ' +
      'and the steps are recorded as SKIPPED, which leaves the lesson incomplete.',
    lessonTwoChallenges: lesson2.challenges,
    falsifications: [
      'named R1 as L4 → failed',
      'commanded R1 to 90 when the step asks 135 → failed',
      'wrote channel 3, which the guard lets through → failed (a servo.target arrived)',
      'called the pwm.output row simulated → failed',
      'booted with no fault injected → failed (boot completed)',
      'opened delayWithFace without coming from setServoAngle → stayed pending',
    ],
    explanationLevels: {
      onScreenAtOnce: opened.explanationCount,
      defaultLevel: opened.shownLevel,
      afterSwitch: switched.shownLevel,
      goDeeperOpenByDefault: godeeper.goDeeperOpen,
    },
    conceptual: {
      badged: conceptualCards.map((c) => c.id),
      withSymbols: ['build-a-leg-pose', 'build-a-movement', 'inside-the-brain'],
    },
    boundaryNote: {
      domain: emulatorStep.boundaryDomains,
      observability: emulatorStep.observability,
      registers,
    },
    faults: faultStep.faults,
    bootHalt: bootStep.checkObserved,
    worldFrame: {
      toleranceMm: FRAME_EPS_MM_10,
      worstDriftMm: worst10,
      footContactSpreadMm: spread10,
      samples: frames10.length,
    },
    shots: lessonShots.map((shot) => shot.name),
  };
}

reportPageErrors('replay session');
page.close();
try {
  replayBridge.proc.kill();
} catch {
  /* gone */
}
await sleep(400);
// ===========================================================================
// PHASE 9: the refusal
// ===========================================================================
//
// `firmware/upstream/` is gitignored, so the four annotated files are bundled
// into `dist/` at build time and hashed AGAIN in the browser before anything is
// drawn. This phase proves the second gate fires, because a branch that has
// never run is a branch that does not work.
//
// The tampering is one byte, deep inside `movement-sequences.h`: the file is
// still valid C++, still 429 lines, and every symbol range in
// `source-annotations.json` still "resolves". That is precisely the failure a
// learner cannot see, and precisely what the hash is for.
{
  const tamperedDist = fs.mkdtempSync(path.join(os.tmpdir(), 'sesame-tampered-'));
  fs.cpSync(APP_DIST, tamperedDist, { recursive: true });
  const victim = path.join(tamperedDist, 'upstream/firmware/movement-sequences.h');
  const bytes = fs.readFileSync(victim);
  const before = crypto.createHash('sha256').update(bytes).digest('hex');
  bytes[Math.floor(bytes.length / 2)] = 0x21;
  fs.writeFileSync(victim, bytes);
  const after = crypto.createHash('sha256').update(bytes).digest('hex');
  // A third file is REMOVED, to exercise the clean-clone path in the same run.
  fs.rmSync(path.join(tamperedDist, 'upstream/firmware/captive-portal.h'));

  const tamperedBridge = await startBridge({ viewerDir: tamperedDist }).catch((e) => die(e.message));
  const badPage = await launchBrowser(tamperedBridge.url);
  await waitFor(
    badPage.evaluate,
    'typeof window.__sesame !== "undefined" && window.__sesame.ready',
    (v) => v === true,
    'the app to load against the tampered dist',
    60000,
  );

  // Open the section BEFORE asserting it drew nothing. The panes stay mounted
  // when a dock section collapses, so `.src-line` would already be 0 here — but
  // a refusal asserted against a pane nobody could see would be exactly the
  // vacuous check this phase exists to avoid.
  await openSection(badPage.evaluate, 'source');
  await badPage.evaluate('window.__sesame.selectSymbol("runWavePose")');
  const refused = await waitFor(
    badPage.evaluate,
    'window.__sesame.sourceExplorer()',
    (r) => r !== null && r.integrity !== 'loading',
    'the browser to hash the tampered file and decide',
  );

  check(
    refused.integrity === 'mismatch',
    `the source pane reported "${refused.integrity}" for a file with one byte changed — it must ` +
      `refuse, not render`,
  );
  check(
    refused.renderedAnySource === false,
    `the pane painted ${refused.renderedLineCount} lines of a tree it could not vouch for; a subtly ` +
      `wrong source view is worse than an honest error`,
  );
  const domLines = await badPage.evaluate(`document.querySelectorAll('.src-line').length`);
  check(domLines === 0, `${domLines} code lines are in the DOM under a failed integrity check`);
  const refusalText = await badPage.evaluate(
    `document.querySelector('[data-testid="source-integrity"]')?.textContent ?? ''`,
  );
  check(
    /Refusing to render/i.test(refusalText),
    `the refusal does not say what happened: ${refusalText.slice(0, 160)}`,
  );
  const shownHashes = await badPage.evaluate(`(() => ({
    expected: document.querySelector('[data-testid="source-expected-sha"]')?.textContent ?? '',
    actual: document.querySelector('[data-testid="source-actual-sha"]')?.textContent ?? '',
  }))()`);
  check(
    shownHashes.expected.includes(before) && shownHashes.actual.includes(after),
    `the refusal does not show both hashes: ${JSON.stringify(shownHashes)}`,
  );

  await focusSection(badPage.evaluate, 'source');
  const refusalShot = await badPage.shoot(
    'l4-source-integrity-refusal.png',
    'one byte changed in the bundled movement-sequences.h: the pane refuses to render any source at ' +
      'all and prints both hashes, rather than showing real C++ under the wrong line numbers',
  );

  // The refusal is PER FILE, not a global bail: an untampered file still reads.
  const goodTab = await badPage.evaluate(`(() => {
    const tab = document.querySelector('[data-source-file="firmware/sesame-firmware-main.ino"]');
    if (tab === null) return false;
    tab.click();
    return true;
  })()`);
  check(goodTab === true, 'the untampered file has no tab to click');
  const stillGood = await waitFor(
    badPage.evaluate,
    'window.__sesame.sourceExplorer()',
    (r) => r !== null && r.file === 'firmware/sesame-firmware-main.ino' && r.integrity !== 'loading',
    'the untampered file to be hashed',
  );
  check(
    stillGood.integrity === 'ok' && stillGood.renderedAnySource === true,
    `one bad file took the whole pane down: sesame-firmware-main.ino reports ` +
      `"${stillGood.integrity}"`,
  );

  // And the clean-clone path: a file that is simply not there.
  const missingTab = await badPage.evaluate(`(() => {
    const tab = document.querySelector('[data-source-file="firmware/captive-portal.h"]');
    if (tab === null) return false;
    tab.click();
    return true;
  })()`);
  check(missingTab === true, 'the removed file has no tab to click');
  const missing = await waitFor(
    badPage.evaluate,
    'window.__sesame.sourceExplorer()',
    (r) => r !== null && r.file === 'firmware/captive-portal.h' && r.integrity !== 'loading',
    'the absent file to be reported',
  );
  check(
    missing.integrity === 'missing' && missing.renderedAnySource === false,
    `a file absent from the build reports "${missing.integrity}" instead of saying so honestly`,
  );
  const missingText = await badPage.evaluate(
    `document.querySelector('[data-testid="source-integrity"]')?.textContent ?? ''`,
  );
  check(
    /fetch-upstream/.test(missingText),
    `the "source unavailable" message does not tell the reader to run scripts/fetch-upstream: ` +
      `${missingText.slice(0, 160)}`,
  );

  badPage.close();
  try {
    tamperedBridge.proc.kill();
  } catch {
    /* gone */
  }
  fs.rmSync(tamperedDist, { recursive: true, force: true });

  phases.sourceIntegrityRefusal = {
    ok: true,
    tamperedBytes: 1,
    file: 'firmware/movement-sequences.h',
    expectedSha256: before,
    servedSha256: after,
    integrity: refused.integrity,
    renderedLines: refused.renderedLineCount,
    domCodeLines: domLines,
    untamperedFileStillReads: stillGood.integrity,
    absentFileReports: missing.integrity,
    shots: [refusalShot.name],
  };
  await sleep(200);
}


// ===========================================================================
// PHASE 5 (optional): real firmware under Espressif QEMU
// ===========================================================================
if (SKIP_QEMU) {
  phases.bridgeQemu = { ran: false, reason: '--skip-qemu' };
  notes.push('QEMU phase skipped by request.');
} else if (!fs.existsSync(QEMU_EXE) || !fs.existsSync(QEMU_IMAGE)) {
  phases.bridgeQemu = {
    ran: false,
    reason: `Q1's toolchain is not present (${path.relative(REPO, QEMU_EXE).replaceAll('\\', '/')}). ` +
      'Run node emulator/qemu/fetch-qemu.mjs and node emulator/qemu/build-qemu-images.mjs first.',
  };
  notes.push('QEMU phase skipped: tools/qemu is gitignored and absent on this machine.');
} else {
  console.log('[web] phase 5: real firmware under Espressif QEMU');
  const uartPort = await freePort();
  const qemu = spawn(
    QEMU_EXE,
    [
      '-display',
      'none',
      '-machine',
      'esp32',
      '-drive',
      `file=${QEMU_IMAGE},if=mtd,format=raw`,
      '-serial',
      `tcp:127.0.0.1:${uartPort},server=on,wait=off`,
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );
  children.push(qemu);
  let qemuLog = '';
  qemu.stdout.on('data', (d) => (qemuLog += d.toString()));
  qemu.stderr.on('data', (d) => (qemuLog += d.toString()));
  // Attach the bridge EARLY. QEMU's `-serial tcp:...,server=on,wait=off`
  // discards output while nothing is connected, so anything the firmware
  // prints before the bridge dials is gone for good. The bridge's ring buffer
  // then holds it for the browser, which takes far longer to start.
  await sleep(1200);
  const tail = (text, n = 700) => text.slice(-n).replaceAll(String.fromCharCode(13), '');

  // A live UART socket, so the bridge's default provenance is `observed` —
  // and that default is correct here, because bytes really did cross a
  // boundary out of executing firmware.
  let qemuBridge = null;
  let qemuPage = null;
  try {
    qemuBridge = await startBridge({ uartPort, quiet: false });
    console.log(`[web] qemu bridge at ${qemuBridge.url} (uart :${uartPort})`);

    // Do not launch a browser at a bridge that never reached the emulator: the
    // failure would then look like an app bug rather than a missing UART.
    const connectDeadline = Date.now() + 20000;
    while (Date.now() < connectDeadline && !/uart connected/.test(qemuBridge.output())) {
      await sleep(200);
    }
    if (!/uart connected/.test(qemuBridge.output())) {
      throw new Error(
        `the bridge never connected to QEMU's UART socket on :${uartPort}. ` +
          `bridge said: ${tail(qemuBridge.output())} | qemu said: ${tail(qemuLog)}`,
      );
    }
    console.log('[web] bridge attached to QEMU UART0');

    qemuPage = await launchBrowser(qemuBridge.url);
    await waitFor(
      qemuPage.evaluate,
      'typeof window.__sesame !== "undefined" && window.__sesame.ready',
      (v) => v === true,
      'the app to load under the QEMU bridge',
      60000,
      true,
    );
    await qemuPage.evaluate('window.__sesame.setBackend("bridge")');
    await waitFor(
      qemuPage.evaluate,
      'window.__sesame.status().connection',
      (v) => v === 'connected',
      'the app to connect to the QEMU bridge',
      30000,
      true,
    );

    const observed = await waitFor(
      qemuPage.evaluate,
      'window.__sesame.snapshot()',
      (s) => s.sceneJoints.some((j) => j.storeCommandedDeg !== null),
      'real @SESAME servo telemetry from executing firmware',
      90000,
      true,
    ).catch((error) => {
      throw new Error(
        `${error.message} | qemu tail: ${tail(qemuLog)} | bridge tail: ${tail(qemuBridge.output())}`,
      );
    });

    await waitFor(
      qemuPage.evaluate,
      RENDER_STATS,
      (s) => s !== null && s.appliedPoseVersion === s.storePoseVersion,
      'the scene to apply the firmware’s telemetry',
      30000,
      true,
    );
    const driven = observed.sceneJoints.filter((j) => j.storeCommandedDeg !== null);
    // `provenance === 'observed'` is CORRECT here and is NOT sufficient: bytes
    // really crossed a UART out of executing firmware. What it must never imply
    // is a measurement, and on this path the bridge stamps no TelemetryOrigin
    // at all — its envelope's `origin` field means 'uart' | 'bridge', a
    // different question. So the app sees `unknown`, and unknown must resolve to
    // NOT-physical rather than to physical-by-default. That is the whole reason
    // phase 6 uses a transport that carries the origin from the party that
    // knows it.
    const originReading = observed.origin ?? { physicallyObservedEvents: null, counts: {} };
    const ok =
      observed.provenance.driving === 'observed' &&
      originReading.physicallyObservedEvents === 0 &&
      driven.length > 0 &&
      observed.canvasPixels > 2000;
    if (!ok) {
      notes.push(
        `QEMU phase ran but did not fully satisfy its checks: driving=${observed.provenance.driving}, ` +
          `physicallyObserved=${originReading.physicallyObservedEvents}, ` +
          `${driven.length} joints driven, ${observed.canvasPixels} canvas pixels.`,
      );
    }
    await scrollDockTop(qemuPage.evaluate);
    await sleep(400);
    await qemuPage.shoot(
      'v3-browser-qemu-observed.png',
      'real Sesame firmware executing under Espressif QEMU, UART0 -> the unmodified Phase-0 bridge -> this scene (provenance: observed)',
    );
    phases.bridgeQemu = {
      ran: true,
      ok,
      provenance: observed.provenance,
      origin: observed.origin ?? null,
      jointsDriven: driven.map((j) => ({ joint: j.joint, deg: j.storeCommandedDeg })),
      canvasPixels: observed.canvasPixels,
      note:
        'Telemetry here is `observed`: the bytes came out of firmware that really executed. The ' +
        'bridge was not modified for it — a live --uart-port socket is what it was built for. It ' +
        'is receive-only, and it stamps no TelemetryOrigin, so the app reports origin `unknown` ' +
        'and refuses to treat that as physical. Phase 6 is the commandable, origin-carrying path.',
    };
  } catch (error) {
    // Q1 is explicitly off the critical path and its toolchain is gitignored,
    // so a failure here is reported rather than allowed to fail V3's gate.
    phases.bridgeQemu = { ran: true, ok: false, error: String(error.message ?? error) };
    notes.push(`QEMU phase failed (non-fatal, Q1 is off the critical path): ${error.message ?? error}`);
  } finally {
    qemuPage?.close();
    try {
      qemuBridge?.proc.kill();
    } catch {
      /* gone */
    }
    try {
      qemu.kill();
    } catch {
      /* gone */
    }
  }
}

// ===========================================================================
// PHASE 6: a browser button driving real firmware
// ===========================================================================
//
// Every earlier phase either drove a MODEL (1-3), or WATCHED firmware without
// being able to touch it (4-5). This one closes the loop, and it is the claim
// the whole project is for, so it is asserted rather than demonstrated:
//
//   a real <button> in a real browser
//     -> POST /api/command {"command":"wave"}        the firmware's own route
//     -> SesameApiAdapter -> QemuSesameRobot -> "rn wv" on UART0
//     -> real Xtensa instructions -> @SESAME servo lines back
//     -> SSE -> TelemetryStore -> Object3D.quaternion
//
// Two assertions carry it. First, the eight quaternions must move, and every
// one of them must have been last written by an event that is BOTH
// `provenance: 'observed'` AND `origin.kind === 'emulator'` — a screenshot of a
// moving robot proves neither. Second, `isPhysicallyObserved()` must never have
// been true, because no physical Sesame exists and an emulator must not be able
// to pass for one.
//
// And the ISSUE-20260823-023 world-frame check runs again here. That bug was
// found by a human looking at the simulator path while the harness was green; a
// second driving path is a second chance for the floor to start sliding.
if (SKIP_QEMU) {
  phases.qemuCommanded = { ran: false, reason: '--skip-qemu' };
} else if (!fs.existsSync(QEMU_EXE) || !fs.existsSync(QEMU_CLI_IMAGE)) {
  phases.qemuCommanded = {
    ran: false,
    reason:
      `the QEMU toolchain or the idle CLI image is missing ` +
      `(${path.relative(REPO, QEMU_CLI_IMAGE).replaceAll('\\', '/')}). Run ` +
      `node emulator/qemu/fetch-qemu.mjs and node emulator/qemu/build-qemu-images.mjs cli.`,
  };
  notes.push('QEMU-commanded phase skipped: tools/qemu and/or the cli image are absent.');
} else {
  console.log('[web] phase 6: a browser button driving real firmware under QEMU');
  let lab = null;
  let labPage = null;
  const before6 = problems.length;
  try {
    lab = await startLabHost({ backend: 'qemu' });
    console.log(`[web] lab host serving apps/web/dist at ${lab.url}`);

    labPage = await launchBrowser(lab.url);
    const evaluate = labPage.evaluate;
    await waitFor(
      evaluate,
      'typeof window.__sesame !== "undefined" && window.__sesame.ready',
      (v) => v === true,
      'the app to load under the lab host',
      60000,
    );

    /*
      THE DEFAULT, on the origin it was written for — Phase 4 W8.

      A QEMU lab host is serving this page, so the reader who runs `just dev` or
      `just run` gets exactly this. Nothing is clicked and nothing is set: the
      app must already be on the emulator, and it must NOT be showing the "no
      lab host" guidance, which is the state the same default produces on the
      bridge-served page in phase 1.
    */
    const opened6 = await evaluate('window.__sesame.backendId()');
    check(
      opened6 === 'qemu',
      `served by a QEMU lab host, the app opened on "${opened6}" rather than the emulator`,
    );
    check(
      (await evaluate(`document.querySelectorAll('[data-testid="panel-no-lab-host"]').length`)) === 0,
      'the app is talking to a lab host and the panel still says there is none',
    );

    await evaluate('window.__sesame.setBackend("qemu")');

    // Best effort: if the emulator is still booting when the page arrives,
    // capture the progress UI. It is allowed to be missed — QEMU boots in about
    // 2.5 s and a cold Chromium takes longer than that — but when it is caught
    // it is the evidence that a 17 s connect reads as progress and not as a
    // hang.
    const bootPhase = await evaluate('window.__sesame.status()');
    let bootShot = null;
    if (bootPhase.connection === 'connecting') {
      bootShot = await labPage.shoot(
        'v3-browser-qemu-booting.png',
        'the 2-17 s QEMU boot, surfaced as progress with the attempt count rather than as a frozen page',
      );
    }

    // 12 boot attempts x ~2 s detection, plus one slow success, plus the poll
    // interval. Q2 measured a 17.4 s worst case for one connect.
    const connected = await waitFor(
      evaluate,
      'window.__sesame.status()',
      (v) => v !== null && v.connection === 'connected',
      'the app to reach the QEMU lab host and see the firmware finish setup()',
      120000,
    );
    console.log(
      `[web] emulator ready after ${connected.attempts} boot attempt(s), ${connected.elapsedMs} ms`,
    );
    check(
      typeof connected.attempts === 'number' && connected.attempts >= 1,
      `the app did not surface a boot attempt count (got ${JSON.stringify(connected.attempts)}); ` +
        `a connect that needed several tries is ISSUE-20260823-022 and hiding it recreates the ` +
        `under-measurement Q2 had to undo`,
    );
    check(
      typeof connected.elapsedMs === 'number',
      'the app did not surface how long the boot took',
    );

    // ------------------------------------------------- the honesty surface
    const facts = await evaluate('window.__sesame.emulatorFacts()');
    check(facts !== null, 'the QEMU backend reported no emulator facts at all');
    if (facts !== null) {
      check(
        facts.origin?.kind === 'emulator',
        `the backend's origin kind is ${JSON.stringify(facts.origin?.kind)}, expected "emulator"`,
      );
      check(
        facts.board === 'distro-v1-esp32',
        `the emulated board is reported as ${JSON.stringify(facts.board)}; this backend runs the ` +
          `LEGACY V1 board and saying anything else would let it pass for the current one`,
      );
      check(facts.mode === 'qemu', `RobotState.mode came back ${JSON.stringify(facts.mode)}`);
      /*
        THE PANEL, AND THE TWO STATEMENTS ABOUT IT — rewritten in Phase 4 W8.

        These two checks used to read `oledFramebuffer === false` and
        `elided.includes('ssd1306-panel')` as constants. They are not constants:
        the default image now ships the firmware's OLED framebuffer hook, so the
        capability is TRUE and `ssd1306-panel` has been replaced by
        `ssd1306-glass`. An assertion that goes on demanding the old values is
        an assertion that fails on a product improvement, which is the same
        failure mode as one that goes on passing against a deleted regime.

        What is invariant, and what is asserted instead:

          1. the emulator declares the panel situation SOMEHOW. Exactly one of
             the two names is in `elided`, always — `ssd1306-panel` when no
             framebuffer is observable, `ssd1306-glass` when the buffer is
             observed but the DEVICE is still absent. Neither being there would
             mean the emulator had stopped saying anything about a chip it does
             not attach;
          2. the two statements AGREE. `oledFramebuffer: true` with
             `ssd1306-panel` still elided is a contradiction, and it is the
             shape a half-finished capability change would take;
          3. and the glass is never claimed. The hook reads `getBuffer()` before
             `display.display()` pushes it at a chip that is not there, so no
             pixel has been confirmed to reach any panel on either image.
      */
      const elided = Array.isArray(facts.elided) ? facts.elided : [];
      const bufferElided = elided.includes('ssd1306-panel');
      const glassElided = elided.includes('ssd1306-glass');
      check(
        bufferElided !== glassElided,
        `the emulator's elided list names ${JSON.stringify(elided.filter((e) => e.startsWith('ssd1306')))} ` +
          `for the panel. Exactly one of ssd1306-panel and ssd1306-glass belongs there: the first ` +
          `says no framebuffer is observable, the second says the framebuffer is observed and the ` +
          `DEVICE still is not. Both or neither means the emulator has stopped saying which.`,
      );
      check(
        facts.oledFramebuffer === !bufferElided,
        `the emulator declares oledFramebuffer=${String(facts.oledFramebuffer)} while ` +
          `ssd1306-panel is ${bufferElided ? '' : 'not '}in its elided list. Those are two ` +
          `statements of one fact and they must agree; the app treats a disagreement as "no ` +
          `framebuffer", which is the safe direction but not a licence for the emulator to ` +
          `contradict itself.`,
      );
      check(
        glassElided || bufferElided,
        `nothing in ${JSON.stringify(elided)} mentions the SSD1306 at all. QEMU attaches no panel ` +
          `to this machine on either image, and silence about that is exactly what the elided ` +
          `list exists to prevent.`,
      );
      for (const board of ['s2mini', 'distro-v3-s3']) {
        check(
          typeof facts.unsupportedBoards?.[board] === 'string',
          `unsupportedBoards does not explain ${board}. The S2 Mini is the board this project ` +
            `RECOMMENDS and QEMU cannot emulate it at all; a learner must not conclude they are ` +
            `watching their own hardware`,
        );
      }
    }

    // The facts have to be ON SCREEN, not merely in an object. This reads the
    // rendered DOM text, which is what a learner actually sees.
    //
    // `readRenderedHonesty` is called twice: once now, and again after the wave.
    // The provenance banner reports the event that last MOVED something, so
    // before the first command it correctly says "nothing yet" — asserting the
    // verdict line here would be asserting against an idle robot.
    /*
     * The emulator's QUALIFIERS moved into the "more info" screen — Phase 4 W7.
     *
     * What stayed on the side panel, permanently and at every width, is the
     * CLAIM: the driving provenance, the origin with its board
     * (`#origin-banner`), `measurementVerdict()`'s headline
     * (`#measurement-verdict`) and `PHYSICAL HARDWARE: NONE`. What is behind
     * one click is the paragraph — which boards the emulator does not model,
     * what it does not simulate — and §11.4 sanctions exactly that: a popover
     * may EXPAND a correctness surface. So the screen is opened before this
     * reads, and the fact that these five strings are still rendered somewhere
     * a learner can reach is what is asserted.
     */
    const openTrustScreen = () =>
      evaluate(`(() => {
        const dialog = document.querySelector('[data-popover="trust"]');
        if (dialog !== null && dialog.open) return true;
        document.querySelector('[data-panel-more="trust"]')?.click();
        return true;
      })()`);
    const readRenderedHonesty = async () => {
      await openTrustScreen();
      await sleep(450);
      const rendered = JSON.parse(
        await evaluate(
          `JSON.stringify({
             emulator: document.querySelector('[data-testid="emulator"]')?.innerText ?? '',
             verdict: document.querySelector('#measurement-verdict')?.innerText ?? '',
             originBanner: document.querySelector('#origin-banner')?.innerText ?? '',
             unsupported: document.querySelector('[data-testid="unsupported-boards"]')?.innerText ?? '',
             notAMeasurement: document.querySelector('[data-testid="not-a-measurement"]')?.innerText ?? '',
           })`,
        ),
      );
      // Shut it again: every other assertion in this phase is about the shell a
      // reader is looking at, and a modal over it would change what is
      // hit-testable.
      await evaluate(`document.querySelector('[data-popover-close="trust"]')?.click()`);
      await sleep(300);
      return rendered;
    };
    const renderedIdle = await readRenderedHonesty();
    check(
      /distro-v1-esp32/.test(renderedIdle.emulator),
      'the emulator panel does not name the board it is actually running',
    );
    check(
      /s2mini/.test(renderedIdle.unsupported),
      'the UI does not tell the reader that the recommended DIY board cannot be emulated',
    );
    check(
      /isPhysicallyObserved/.test(renderedIdle.notAMeasurement),
      'the emulator panel does not name the predicate that separates emulated from measured, ' +
        'before a single joint has moved',
    );

    // --------------------------------------------- nothing has moved yet
    //
    // The `cli` image boots idle on purpose: Q1's `nowifi` build injected
    // `currentCommand = "wave"` into setup() because nothing could ask the robot
    // to move. If any joint were already commanded here, "the joints moved after
    // the click" would prove nothing.
    const rest6 = await evaluate('window.__sesame.sceneJoints()');
    const preCommanded = rest6.filter((j) => j.storeCommandedDeg !== null);
    check(
      preCommanded.length === 0,
      `${preCommanded.length} joint(s) were already commanded before the button was clicked ` +
        `(${preCommanded.map((j) => j.joint).join(', ')}) — the image is not booting idle, so the ` +
        `post-click assertion would not be attributable to the click`,
    );

    const worldFrames6 = [];
    const sample6 = async (label) => {
      const frame = await evaluate('window.__sesame.worldFrame()');
      if (frame === null) {
        problems.push(`worldFrame() returned null at "${label}" during the QEMU wave`);
        return;
      }
      worldFrames6.push({ label, ...frame });
    };
    await sample6('rest, real firmware idle, nothing clicked');

    const idleShot = await labPage.shoot(
      'v3-browser-qemu-idle.png',
      'real firmware booted under QEMU and sitting idle: no joint has been commanded, and the UI says the origin is an emulator on the legacy V1 board',
    );

    // ------------------------------------------------------- CLICK THE BUTTON
    //
    // `element.click()`, not `__sesame.run()`. The debug hook would exercise the
    // same code path, but the claim being evidenced is "the buttons work", and
    // a disabled button, a missing handler or a `canCommand: false` backend are
    // exactly the failures a direct call would step over.
    const clicked = await clickWaveButton(evaluate);
    check(clicked.ok, `could not click the wave button: ${clicked.why}`);
    console.log('[web] clicked the wave button');

    const startVersion = (await evaluate(RENDER_STATS)).storePoseVersion;
    // runWavePose is 29 servo events over ~3.9 s of real firmware timing.
    await waitFor(
      evaluate,
      RENDER_STATS,
      (v) => v !== null && v.storePoseVersion > startVersion + 8,
      'servo telemetry to come back out of the firmware the button just commanded',
      60000,
    );
    for (let i = 0; i < 6; i++) {
      await sample6(`wave sample ${i + 1}`);
      await sleep(220);
    }
    await waitFor(
      evaluate,
      RENDER_STATS,
      (v) => v !== null && v.appliedPoseVersion === v.storePoseVersion,
      'the render loop to apply the firmware’s telemetry',
    );

    const after6 = await evaluate('window.__sesame.sceneJoints()');
    const delta6 = maxQuaternionDelta(rest6, after6);
    check(
      delta6 > 1e-3,
      `clicking wave changed nothing in the scene graph (max quaternion component delta ` +
        `${delta6.toExponential(3)}). The button did not drive the firmware, or the firmware's ` +
        `telemetry did not reach three.js.`,
    );

    const driven6 = after6.filter((j) => j.storeCommandedDeg !== null);
    check(
      driven6.length === 8,
      `only ${driven6.length}/8 joints were driven by the commanded wave`,
    );
    for (const joint of driven6) {
      check(
        joint.storeProvenance === 'observed',
        `${joint.joint} was last written by a ${joint.storeProvenance} event; firmware that really ` +
          `executed must not be downgraded`,
      );
      check(
        joint.storeOriginKind === 'emulator',
        `${joint.joint} carries origin.kind ${JSON.stringify(joint.storeOriginKind)}, expected ` +
          `"emulator" — the scene must be attributable to the emulator that produced it`,
      );
      check(
        joint.storePhysicallyObserved === false,
        `${joint.joint} reports isPhysicallyObserved() === true. No physical Sesame exists; an ` +
          `emulator must never pass for one`,
      );
      check(
        Math.abs(joint.sceneCommandedDeg - joint.storeCommandedDeg) < 1e-4,
        `${joint.joint}: the scene graph says ${joint.sceneCommandedDeg}° but the firmware said ` +
          `${joint.storeCommandedDeg}°`,
      );
    }

    // ------------------------------------- the trace, on the OTHER backend
    //
    // Phase 7 asserts the ladder on the simulator, where the trace id threads
    // end to end. The same feature has to work here and say something
    // DIFFERENT, because two of its claims genuinely change:
    //
    //  - `servo.target` becomes OBSERVED FROM EMULATOR rather than SIMULATED;
    //  - the join stops being causal. The firmware has no trace-id field and
    //    nothing can carry one across UART0, so rows are matched by arrival
    //    window and the UI must say so instead of implying a link it does not
    //    have.
    //
    // `pwm.output` does NOT change: it is inferred here too, because QEMU's
    // LEDC stores duty and emits no waveform (Q3), so there is nothing to
    // observe even with real firmware executing.
    const qemuTrace = await waitFor(
      evaluate,
      'window.__sesame.trace()',
      (t) => t !== null && t.rows.some((r) => r.layer === 'servo.target'),
      'the causal trace to pick up the firmware’s servo events',
      45000,
      true,
    ).catch((e) => {
      problems.push(`phase 6: the trace never saw a servo row (${e.message})`);
      return null;
    });

    if (qemuTrace !== null) {
      const qemuRanks = qemuTrace.rows.map((r) => r.rank);
      check(
        qemuRanks.every((r, i) => i === 0 || qemuRanks[i - 1] <= r),
        `the QEMU trace rows are not in causal order: ${JSON.stringify(qemuTrace.rows.map((r) => r.layer))}`,
      );

      const qemuServo = qemuTrace.rows.find((r) => r.layer === 'servo.target');
      check(
        qemuServo?.provenance === 'observed' && qemuServo?.originKind === 'emulator',
        `the QEMU trace's servo.target row reads ${JSON.stringify(qemuServo?.provenance)} / ` +
          `${JSON.stringify(qemuServo?.originKind)}, expected observed / emulator`,
      );
      check(
        qemuServo?.badge === 'OBSERVED FROM EMULATOR',
        `the QEMU trace shows the badge ${JSON.stringify(qemuServo?.badge)}, expected ` +
          `"OBSERVED FROM EMULATOR" — the report's exact wording, and the strongest claim anything ` +
          `in this project may make`,
      );
      check(
        qemuServo?.match === 'time-window',
        `the QEMU trace claims a ${JSON.stringify(qemuServo?.match)} join. The firmware has no ` +
          `trace-id field; presenting a correlation as causation is the exact failure this row's ` +
          `label exists to prevent`,
      );
      check(
        qemuTrace.carriedTraceId === false,
        'the QEMU trace claims events came back carrying its id; nothing can carry one into the guest',
      );

      const qemuPwm = qemuTrace.rows.find((r) => r.layer === 'pwm.output');
      check(
        qemuPwm?.provenance === 'inferred' && qemuPwm?.badge === 'INFERRED FOR EXPLANATION',
        `pwm.output under real firmware reads ${JSON.stringify(qemuPwm?.provenance)}; it must stay ` +
          `inferred — QEMU's LEDC model produces no pulse, no edge and no waveform (Q3 §2-§3), so ` +
          `there is nothing to observe even though the firmware really ran`,
      );
      check(
        !/channel\s*=\s*\d/i.test(`${qemuPwm?.label ?? ''}`),
        `pwm.output printed a channel number under QEMU (${qemuPwm?.label})`,
      );

      const qemuHardware = qemuTrace.rows.filter(
        (r) => r.physicallyObserved || /ON HARDWARE/.test(r.badge),
      );
      check(
        qemuHardware.length === 0,
        `${qemuHardware.length} QEMU trace row(s) claim physical observation: ` +
          JSON.stringify(qemuHardware.map((r) => r.layer)),
      );

      // The correlation caveat has to be ON SCREEN, not merely in an object.
      const correlationText = await evaluate(
        `document.querySelector('[data-testid="trace-correlation"]')?.innerText ?? ''`,
      );
      check(
        /arrival time/i.test(correlationText),
        `the trace panel does not tell the learner the join is by arrival time: ` +
          `${JSON.stringify(String(correlationText).slice(0, 160))}`,
      );

      await evaluate(`(() => {
        const rows = document.querySelector('[data-testid="trace-rows"]');
        const pwm = document.querySelector('[data-layer="pwm.output"]');
        if (rows !== null && pwm !== null) rows.scrollTop = pwm.offsetTop - rows.offsetTop - 8;
      })()`);
      await sleep(350);
      await focusSection(evaluate, 'signal');
      await labPage.shoot(
        'v8-see-the-signal-qemu.png',
        'the same causal trace driven by real firmware under QEMU: servo.target is OBSERVED FROM EMULATOR, pwm.output is still INFERRED FOR EXPLANATION, and the rows are matched to the click by arrival time because the firmware has no trace-id field',
      );

      phases.qemuTrace = {
        ok: true,
        id: qemuTrace.id,
        carriedTraceId: qemuTrace.carriedTraceId,
        windowAdopted: qemuTrace.windowAdopted,
        ladder: qemuTrace.rows.map((r) => ({
          layer: r.layer,
          provenance: r.provenance,
          originKind: r.originKind,
          badge: r.badge,
          match: r.match,
        })),
      };
    }

    // Now that firmware-driven telemetry HAS moved a joint, the banner has
    // something to describe — and what it must describe is an emulator.
    const renderedMoving = await readRenderedHonesty();
    check(
      /Not a measurement/i.test(renderedMoving.verdict),
      `the provenance banner's verdict line reads ${JSON.stringify(renderedMoving.verdict.slice(0, 140))}; ` +
        `an emulated servo angle must be labelled as not a measurement`,
    );
    check(
      /emulated/i.test(renderedMoving.originBanner),
      `describeOrigin() is not rendered beside the provenance badge (banner text: ` +
        `${JSON.stringify(renderedMoving.originBanner.slice(0, 140))})`,
    );
    check(
      // Case-insensitive: `.prov-banner-head` is `text-transform: uppercase`,
      // and `innerText` reflects rendered case rather than source case.
      /distro-v1-esp32/i.test(renderedMoving.originBanner),
      `the origin badge beside the provenance badge does not name the board: ` +
        `${JSON.stringify(renderedMoving.originBanner.slice(0, 140))}`,
    );

    const originReading6 = await evaluate('window.__sesame.origin()');
    check(
      originReading6.counts.emulator > 0,
      `no events were attributed to an emulator boundary: ${JSON.stringify(originReading6.counts)}`,
    );
    check(
      originReading6.physicallyObservedEvents === 0,
      `${originReading6.physicallyObservedEvents} event(s) satisfied isPhysicallyObserved(). That ` +
        `predicate is the one thing standing between an emulator and a measurement`,
    );
    check(
      originReading6.driving?.board === 'distro-v1-esp32',
      `the driving origin names board ${JSON.stringify(originReading6.driving?.board)}`,
    );

    // ------------------------------------- ISSUE-20260823-023, on a new path
    const EPS6 = 1e-6;
    const drift6 = (a, b) => {
      if (!Array.isArray(a) || !Array.isArray(b)) return Number.NaN;
      let worst = 0;
      for (let i = 0; i < 3; i++) worst = Math.max(worst, Math.abs(a[i] - b[i]));
      return worst;
    };
    const worstDrift6 = {};
    let contactSpread6 = 0;
    const first6 = worldFrames6[0];
    if (first6 === undefined) {
      problems.push('no world-frame samples were taken during the QEMU-driven wave');
    } else {
      for (const [key, what] of [
        ['groundWorldMm', 'the ground plane / grid'],
        ['robotRootWorldMm', 'the robot root'],
        ['cameraTargetMm', 'the OrbitControls target'],
        ['cameraPositionMm', 'the camera'],
      ]) {
        let worst = 0;
        let worstAt = '';
        for (const sample of worldFrames6.slice(1)) {
          const d = drift6(first6[key], sample[key]);
          if (!(d >= 0)) {
            problems.push(`${what}: worldFrame().${key} was unreadable at "${sample.label}"`);
            continue;
          }
          if (d > worst) {
            worst = d;
            worstAt = sample.label;
          }
        }
        worstDrift6[key] = worst;
        check(
          worst <= EPS6,
          `${what} moved ${worst.toFixed(3)} mm in world space between "${first6.label}" and ` +
            `"${worstAt}" while firmware-driven telemetry played. ISSUE-20260823-023 was found by a ` +
            `human on the simulator path; it must not reappear on the QEMU one.`,
        );
      }
      const contacts6 = worldFrames6.map((f) => f.footContactMm).filter((v) => typeof v === 'number');
      contactSpread6 = contacts6.length === 0 ? 0 : Math.max(...contacts6) - Math.min(...contacts6);
      check(
        contactSpread6 > 1,
        `the pose-dependent foot-contact height varied by only ${contactSpread6.toFixed(3)} mm ` +
          `across the firmware-driven wave, so the world-stability assertions above proved nothing`,
      );
    }

    // ------------------------------ the environment line, with QEMU driving
    //
    // The one place the plan's literal string can be checked: this is the only
    // phase in which real firmware on emulated silicon is the thing producing
    // the telemetry. `SYSTEM:` is derived from the driving origin rather than
    // from the backend picker, so this asserts that the line follows what is
    // actually driving the scene; `PHYSICAL HARDWARE: NONE` is the counter, and
    // a QEMU run is exactly the case where a novice would otherwise read
    // "observed" as observed on hardware.
    const qemuEnvironment = await evaluate(`(() => {
      const el = document.querySelector('[data-testid="status-environment"]');
      if (el === null) return null;
      return {
        text: (el.textContent ?? '').replace(/\\s+/g, ' ').trim(),
        system: el.getAttribute('data-system'),
        physicallyObserved: Number(el.getAttribute('data-physically-observed')),
        cut: el.scrollWidth > el.clientWidth + 1,
      };
    })()`);
    check(
      qemuEnvironment?.text === 'SYSTEM: QEMU EMULATOR · PHYSICAL HARDWARE: NONE',
      `with real firmware running under QEMU the environment line reads ` +
        `"${qemuEnvironment?.text}". The plan writes it out in full — ` +
        `SYSTEM: QEMU EMULATOR · PHYSICAL HARDWARE: NONE — because the brief is blunt that a ` +
        `novice reads "observed" as observed ON HARDWARE, and this is the run where that ` +
        `misreading would be most costly.`,
    );
    check(
      qemuEnvironment?.cut === false,
      `the environment line is truncated during the QEMU run: ${JSON.stringify(qemuEnvironment)}`,
    );

    // ------------------------------------------------------- the OLED, honestly
    //
    // Rewritten for Phase 4 W8, and the rewrite is the point.
    //
    // The sentence "these pixels did not come from the emulator" used to be a
    // paragraph on the side panel, and the check read its `innerText`. Two
    // things changed and both are asserted here instead:
    //
    //   1. the paragraph is behind an INFO ICON — click, hover or focus — and
    //      the BADGE stayed on the panel. §11.4 allows a popover to expand a
    //      correctness surface and forbids it being where one first appears, so
    //      the check is now that the badge is on the panel with every screen
    //      shut AND that the explanation is reachable, rather than that a
    //      particular string is painted in a particular box;
    //   2. what the pane claims is DERIVED from `oledFramebuffer` / `elided`
    //      rather than from which backend is selected. `oled().pixels` is that
    //      derivation, published. This image models no SSD1306, so the state
    //      must be `elided`; an image built with `SESAME_TELEMETRY_OLED`
    //      enabled reports the capability and sends `oled.frame`, and the same
    //      code path must then read `observed` with no edit in the app. That
    //      half is proved by faking the capability in `oled-provenance.test.ts`,
    //      because it does not need an image to be true.
    const oled6 = await evaluate('window.__sesame.oled()');
    /*
     * THE EXPECTATION IS DERIVED FROM THE EMULATOR'S OWN DECLARATION.
     *
     * This is the assertion that had to survive the image changing under it,
     * and it did: the default QEMU image now ships the framebuffer hook, so
     * `oledFramebuffer` is true, `ssd1306-panel` is gone from `elided` and
     * `ssd1306-glass` is there in its place. A check that had hard-coded
     * "elided" would now be failing on a product improvement, and a check that
     * hard-coded "observed" would stop noticing if the hook were turned off.
     *
     * So the harness computes what the pane OUGHT to say from
     * `emulatorFacts()` — the same document the app reads — and asserts the
     * pane agrees. Neither side names an image, and the older `cli` image would
     * flip both sides together.
     */
    const facts6 = await evaluate('window.__sesame.emulatorFacts()');
    const hookOn =
      facts6 !== null &&
      facts6.oledFramebuffer === true &&
      !(facts6.elided ?? []).includes('ssd1306-panel');
    const expectedPixelState = hookOn ? (oled6.source.kind === 'wire' ? 'observed' : 'host-rendered') : 'elided';
    check(
      oled6.pixels.state === expectedPixelState,
      `the emulator declares oledFramebuffer=${String(facts6?.oledFramebuffer)} and elided=` +
        `${JSON.stringify(facts6?.elided)}, the store's pixels arrived as "${oled6.source.kind}", ` +
        `so the pane should derive "${expectedPixelState}" and it derived ` +
        `${JSON.stringify(oled6.pixels)}. The state is a function of the capability document; ` +
        `anything else means the derivation stopped reading it.`,
    );
    // Whatever the image, the two axes stay separate: an emulated framebuffer
    // is not a measurement. This is the sentence the brief is written about.
    check(
      originReading6.physicallyObservedEvents === 0,
      `${originReading6.physicallyObservedEvents} events claimed physical observation while the ` +
        `OLED framebuffer hook was on. Emulated bytes are not a measurement.`,
    );
    if (hookOn) {
      check(
        oled6.pixels.fromEmulator === true &&
          /came from the emulator/i.test(oled6.pixels.claim) &&
          oled6.source.kind === 'wire' &&
          oled6.source.pixelProvenance === 'observed',
        `the image ships the framebuffer hook and the pane still says ` +
          `${JSON.stringify(oled6.pixels)} with pixels "${oled6.source.kind}"/` +
          `"${oled6.source.pixelProvenance}". The whole point of deriving this from the ` +
          `capability document is that turning the hook ON changes the claim with no edit in the app.`,
      );
      // ...and the qualifier the sibling documented is not smoothed away: the
      // hook reads getBuffer() BEFORE display.display(), so the device is still
      // elided and the pane may not claim anything reached glass.
      check(
        (facts6.elided ?? []).includes('ssd1306-glass'),
        `the emulator dropped ssd1306-glass from elided; the SSD1306 device is still absent and ` +
          `nothing has confirmed a pixel reached any panel`,
      );
    } else {
      check(
        oled6.pixels.fromEmulator === false &&
          /did not come from the emulator/i.test(oled6.pixels.claim) &&
          (oled6.source.pixelProvenance === null || oled6.source.pixelProvenance === 'inferred'),
        `this image models no framebuffer and the pane derived ${JSON.stringify(oled6.pixels)} ` +
          `with pixel provenance ${JSON.stringify(oled6.source.pixelProvenance)}`,
      );
    }
    /** The claim, whichever way it came out — used by the DOM checks below. */
    const pixelClaim6 = oled6.pixels.claim;

    // The affordance itself, in the DOM, with every screen SHUT.
    const pixelInfo = await evaluate(`(() => {
      const badge = document.querySelector('[data-panel-summary="face"] .prov');
      const dot = document.querySelector('[data-info="oled-pixels"]');
      const laidOut = (el) => {
        if (el === null) return false;
        const box = el.getBoundingClientRect();
        return box.width > 0 && box.height > 0;
      };
      return {
        badgeText: badge === null ? null : badge.textContent.trim(),
        badgeOnPanel: laidOut(badge) && badge.closest('[data-popover]') === null,
        dotOnPanel: laidOut(dot) && dot.closest('[data-popover]') === null,
        dotTitle: dot === null ? null : dot.getAttribute('title'),
        dotLabel: dot === null ? null : dot.getAttribute('aria-label'),
        dotTargetPx: dot === null ? 0 : Math.round(dot.getBoundingClientRect().width),
        // The PARAGRAPH is not on the panel. This is the half of the change a
        // "tidy the panel" instruction could have taken too far.
        paragraphOnPanel: [
          ...document.querySelectorAll('[data-testid="side-panel"] p, [data-testid="side-panel"] strong'),
        ].some((el) => /ssd1306|framebuffer|face-bitmaps|drawBitmap/i.test(el.textContent ?? '')),
        openScreens: document.querySelectorAll('dialog[open]').length,
      };
    })()`);
    check(
      pixelInfo.openScreens === 0,
      `${pixelInfo.openScreens} "more info" screen(s) were open while reading the panel`,
    );
    check(
      pixelInfo.badgeOnPanel === true && pixelInfo.badgeText === oled6.source.pixelProvenance,
      `the pixel-provenance BADGE on the side panel reads ${JSON.stringify(pixelInfo.badgeText)} ` +
        `while the store says ${JSON.stringify(oled6.source.pixelProvenance)}: ` +
        `${JSON.stringify(pixelInfo)}. It is a correctness surface and §11.4 forbids it living ` +
        `behind a disclosure — moving the paragraph is allowed, moving the badge is not.`,
    );
    check(
      pixelInfo.dotOnPanel === true && pixelInfo.dotTitle === pixelClaim6,
      `the info affordance is missing or does not carry the DERIVED claim ` +
        `${JSON.stringify(pixelClaim6)}: ${JSON.stringify(pixelInfo)}`,
    );
    check(
      pixelInfo.paragraphOnPanel === false,
      'the explanation is still painted on the side panel; the whole point of the icon is that the ' +
        'panel gets the height back',
    );

    // FOCUS reveals the tip — the keyboard half of "click on and / or mouse
    // over". A hover that is only a hover is not an affordance.
    await evaluate(`document.querySelector('[data-info="oled-pixels"]').focus()`);
    await sleep(300);
    const tipText = await evaluate(
      `document.querySelector('[data-info-tip="oled-pixels"]')?.textContent ?? ''`,
    );
    check(
      tipText === pixelClaim6,
      `focusing the info icon revealed ${JSON.stringify(tipText)}, not the derived claim ` +
        `${JSON.stringify(pixelClaim6)}`,
    );

    // ...and CLICK opens the screen with the paragraphs in it.
    await evaluate(`document.querySelector('[data-info="oled-pixels"]').click()`);
    await sleep(400);
    const pixelScreen = await evaluate(`(() => {
      const dialog = document.querySelector('[data-popover="oled-pixels"]');
      if (dialog === null) return { open: false };
      return { open: dialog.open === true, text: dialog.innerText };
    })()`);
    check(
      pixelScreen.open === true &&
        /ssd1306/i.test(pixelScreen.text ?? '') &&
        /framebuffer/i.test(pixelScreen.text ?? '') &&
        (pixelScreen.text ?? '').includes(pixelClaim6),
      `the info screen did not open with the explanation in it: ${JSON.stringify(pixelScreen).slice(0, 400)}`,
    );
    await evaluate(`document.querySelector('[data-popover-close="oled-pixels"]')?.click()`);
    await sleep(300);

    const snapshot6 = await evaluate('window.__sesame.snapshot()');
    check(
      typeof snapshot6.canvasPixels === 'number' && snapshot6.canvasPixels > 2000,
      `only ${snapshot6.canvasPixels} non-background pixels came out of the WebGL drawing buffer`,
    );
    check(
      snapshot6.renderStats !== null && snapshot6.renderStats.frames > 10,
      `the render loop drew ${snapshot6.renderStats?.frames} frames — every reading above is stale`,
    );

    await focusSection(evaluate, 'inspector');
    await sleep(400);
    const waveShot = await labPage.shoot(
      'v3-browser-qemu-commanded-wave.png',
      'a browser button drove real Sesame firmware: POST /api/command -> the firmware’s serial console under QEMU -> 29 @SESAME servo events -> these quaternions. Labelled emulated, on the legacy V1 board, not a measurement.',
    );
    await focusSection(evaluate, 'face');
    await evaluate(
      `void document.querySelector('[data-testid="oled"]')?.scrollIntoView({ block: 'start' })`,
    );
    await sleep(400);
    await labPage.shoot(
      /*
        RENAMED in Phase 4 W8, from `v4-browser-qemu-oled-inferred.png`.

        The old name asserted the answer. It was true of the `cli` image — no
        framebuffer, `ssd1306-panel` elided, pixels drawn host-side and labelled
        `inferred` — and the default image is `cli-oled` now, which emits the
        guest's own framebuffer and whose pixels are `observed`. A filename that
        states a conclusion the picture no longer supports is the same hazard as
        a note about a deleted regime, so the name says what the picture is OF
        and the caption is DERIVED from what was measured in this run.
      */
      'v4-browser-qemu-oled.png',
      `the OLED under QEMU on the ${hookOn ? 'cli-oled' : 'cli'} image: the emulator declares ` +
        `oledFramebuffer=${String(facts6?.oledFramebuffer)} and elides ` +
        `${JSON.stringify((facts6?.elided ?? []).filter((e) => e.startsWith('ssd1306')))}, the ` +
        `pixels arrived as "${oled6.source.kind}" and are labelled ` +
        `${JSON.stringify(oled6.source.pixelProvenance)}, and the pane derives ` +
        `"${oled6.pixels.state}" — ${pixelClaim6} The badge is on the side panel; the paragraph ` +
        `is behind the ⓘ beside it. isPhysicallyObserved() is false either way: an emulated ` +
        `framebuffer is not a measurement.`,
    );

    const labErrors = labPage.errors();
    check(
      labErrors.length === 0,
      `the QEMU-commanded page logged ${labErrors.length} error(s): ${labErrors.slice(0, 3).join(' | ')}`,
    );

    phases.qemuCommanded = {
      environmentLine: qemuEnvironment,
      ran: true,
      ok: problems.length === before6,
      transport:
        'apps/web/server/lab-host.mjs — @sesame-lab/sesame-api SesameApiAdapter (unmodified) over ' +
        'QemuSesameRobot, plus /lab/stream (SSE) for telemetry the firmware’s HTTP contract has no ' +
        'way to express',
      clickedSelector: '[data-command="wave"]',
      boot: {
        attempts: connected.attempts,
        elapsedMs: connected.elapsedMs,
        progressShotCaptured: bootShot !== null,
      },
      emulatorFacts: facts,
      renderedBanner: renderedMoving.originBanner,
      renderedVerdict: renderedMoving.verdict,
      jointsBeforeClick: preCommanded.length,
      jointsDriven: driven6.map((j) => ({
        joint: j.joint,
        deg: j.storeCommandedDeg,
        provenance: j.storeProvenance,
        originKind: j.storeOriginKind,
        physicallyObserved: j.storePhysicallyObserved,
      })),
      maxQuaternionDelta: delta6,
      origin: originReading6,
      worldFrame: {
        toleranceMm: EPS6,
        worstDriftMm: worstDrift6,
        footContactSpreadMm: contactSpread6,
        samples: worldFrames6,
      },
      oled: {
        pixelProvenance: oled6.source.pixelProvenance,
        kind: oled6.source.kind,
        litPixels: oled6.litPixels,
        // Phase 4 W8: the derivation, and where each half of it is rendered.
        oledHookOn: hookOn,
        expectedPixelState,
        declaredCapability: {
          oledFramebuffer: facts6?.oledFramebuffer ?? null,
          elided: facts6?.elided ?? null,
        },
        derived: oled6.pixels,
        badgeOnPanel: pixelInfo.badgeOnPanel,
        badgeText: pixelInfo.badgeText,
        infoDotOnPanel: pixelInfo.dotOnPanel,
        paragraphOnPanel: pixelInfo.paragraphOnPanel,
        tipOnFocus: tipText === pixelClaim6,
        screenOpensWithExplanation: pixelScreen.open === true,
      },
      canvasPixels: snapshot6.canvasPixels,
      shots: [idleShot.name, waveShot.name],
    };
  } catch (error) {
    // Unlike phase 5, a failure here IS a failure: this phase is the project's
    // headline claim, and the toolchain check above already covers the only
    // legitimate reason to skip it.
    problems.push(`the QEMU-commanded phase failed: ${error.message ?? error}`);
    phases.qemuCommanded = {
      ran: true,
      ok: false,
      error: String(error.message ?? error),
      labHostOutput: lab === null ? null : lab.output().slice(-1200),
    };
  } finally {
    labPage?.close();
    try {
      lab?.proc.kill();
    } catch {
      /* gone */
    }
    await sleep(600);
  }
}

// ===========================================================================
// PHASE 11: LAB MODE — the unrestricted surface
// ===========================================================================
//
// Learn mode is guided and every step of it ends on a check. Lab mode has no
// checks at all, which removes the thing phase 10 leaned on: there is no
// `checkStatus` to wait for and no evaluator whose verdict can be asserted. So
// every claim here is asserted against something OUTSIDE the Lab's own opinion
// of itself:
//
//   * the animation reaches its angles — read off `Object3D.quaternion`, not
//     off the document that was authored;
//   * the exported C++ round-trips — parsed by a SECOND parser written in this
//     file, not by the one the Lab shows a verdict from;
//   * the drawn face is on the panel — decoded out of the SSD1306's own
//     page-ordered GDDRAM, pixel by pixel, not read back out of the editor;
//   * the API console's reply is the real one — a real status from a real
//     route, and `/api/status` is parsed to prove our adapter does NOT
//     reproduce ISSUE-20260823-021 while the Lab says the defect is real;
//   * the project survives a reload — the page is genuinely reloaded.
//
// It runs under `lab-host --backend sim`, with the browser on the lab-host
// backend, so the console, the sliders and the 3D scene are all talking to ONE
// robot behind the firmware's own routes. No QEMU is involved, so unlike
// phases 5 and 6 this one always runs.
{
  console.log('[web] phase 11: lab mode');
  const labShots = [];
  const before11 = problems.length;
  let labHost11 = null;
  let page11 = null;
  try {
    labHost11 = await startLabHost({ backend: 'sim' });
    console.log(`[web] lab host (sim behind the firmware routes) at ${labHost11.url}`);
    page11 = await launchBrowser(labHost11.url);
    const evaluate = page11.evaluate;

    // ------------------------------------------------------------ helpers
    const LAB_EXPR = 'window.__sesame.lab()';

    const clickOn = (selector) =>
      evaluate(`(() => {
        const el = document.querySelector(${JSON.stringify(selector)});
        if (el === null) return { ok: false, why: 'not on screen' };
        if (typeof el.click === 'function') el.click();
        else el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        return { ok: true };
      })()`);

    /** React installs its own value setter; go through the prototype's. */
    const setValue = (selector, value, proto = 'HTMLInputElement') =>
      evaluate(`(() => {
        const el = document.querySelector(${JSON.stringify(selector)});
        if (el === null) return { ok: false, why: 'not on screen' };
        const setter = Object.getOwnPropertyDescriptor(window.${proto}.prototype, 'value').set;
        setter.call(el, ${JSON.stringify(String(value))});
        el.dispatchEvent(new Event('input', { bubbles: true }));
        return { ok: true, value: el.value };
      })()`);

    const selectOption = (selector, value) =>
      evaluate(`(() => {
        const el = document.querySelector(${JSON.stringify(selector)});
        if (el === null) return { ok: false, why: 'not on screen' };
        const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set;
        setter.call(el, ${JSON.stringify(value)});
        el.dispatchEvent(new Event('change', { bubbles: true }));
        return { ok: true, value: el.value };
      })()`);

    const waitReady = (what, timeoutMs = 60000) =>
      waitFor(
        evaluate,
        'typeof window.__sesame !== "undefined" && window.__sesame.ready',
        (v) => v === true,
        what,
        timeoutMs,
      );

    const waitCaughtUp = (what) =>
      waitFor(
        evaluate,
        'window.__sesame.renderStats()',
        (s) => s !== null && s.appliedPoseVersion === s.storePoseVersion,
        what,
      );

    const showLab = () =>
      evaluate(`void document.querySelector('[data-testid="lab-panel"]')?.scrollIntoView({ block: 'end' })`);

    /** Is pixel (x, y) lit in a page-ordered 1024-byte SSD1306 buffer? */
    const gddramPixel = (bytes, x, y) => {
      const index = x + (y >> 3) * 128;
      return ((bytes[index] ?? 0) & (1 << (y & 7))) !== 0;
    };

    /** The 9 pixels one drag puts down, as (x, y) pairs. */
    const STROKE = [];
    for (let y = 20; y < 23; y += 1) for (let x = 40; x < 43; x += 1) STROKE.push([x, y]);

    // ------------------------------------------- a clean start, by reloading
    //
    // The Lab reads its saved project ONCE, when it mounts. Clearing storage
    // after that would leave the already-loaded project on screen, so the
    // clear is followed by a real reload — which also exercises the reload
    // path before the persistence assertion depends on it.
    await waitReady('the app to load under the lab host');
    await evaluate(
      `(() => { try { localStorage.removeItem('sesame-lab.lab.v1'); } catch { /* blocked */ } })()`,
    );
    await evaluate('void location.reload()');
    await sleep(500);
    await waitReady('the app to come back after the pre-test reload');

    /*
      THE THIRD LEG of the default — Phase 4 W8.

      This lab host runs `--backend sim`, and it says so at `/lab/session`. The
      app has to have READ that: opening on QEMU here would put a reader in
      front of an error while a perfectly good robot answered on the same
      origin, which is the mismatch the plain "always QEMU" reading produces.
      Phase 1 asserts the no-host leg and phase 6 the QEMU leg; this is the one
      that proves the choice is a detection rather than a constant.
    */
    const opened11 = await evaluate('window.__sesame.backendId()');
    check(
      opened11 === 'sim',
      `the lab host on this origin reports backend "sim" and the app opened on "${opened11}"`,
    );

    // Lab is a dock section now. Everything below drags a pointer across the
    // pixel canvas at real coordinates, so the section has to be laid out —
    // `LabMode`'s own closed strip is a separate state and is left alone.
    await openSection(evaluate, 'lab');

    await evaluate('window.__sesame.setBackend("qemu")');
    const connected11 = await waitFor(
      evaluate,
      'window.__sesame.status()',
      (v) => v !== null && v.connection === 'connected',
      'the browser to reach the lab host’s simulated robot over the firmware routes',
      60000,
    );
    check(
      connected11.connection === 'connected',
      `the lab-host backend did not connect: ${JSON.stringify(connected11)}`,
    );

    const closed = await evaluate(LAB_EXPR);
    check(closed.present, 'the Lab pane is not in the DOM at all');
    check(closed.open === false, 'the Lab opened itself rather than starting as a strip');

    await clickOn('[data-testid="lab-open"]');
    await sleep(300);
    await showLab();

    // ============================================================ the pose
    //
    // Eight sliders, firmware names, firmware channel order. The assertions
    // that matter are about the ARITHMETIC between the slider and the pin, not
    // about the slider.
    const poseTabOpen = await evaluate(LAB_EXPR);
    check(poseTabOpen.open === true, 'the Lab did not open');
    check(poseTabOpen.tab === 'pose', `the Lab opened on the "${poseTabOpen.tab}" tab, not "pose"`);
    for (const joint of JOINT_ORDER) {
      check(
        poseTabOpen.poseAdjustedDeg[joint] === 90,
        `${joint} opened at ${poseTabOpen.poseAdjustedDeg[joint]}°, not the neutral 90° ` +
          `runRestPose() writes`,
      );
    }

    // `constrain(angle + subtrim, 0, 180)` with no subtrim is the identity, so
    // the adjusted column has to follow the slider exactly.
    await setValue('[data-testid="pose-slider-R1"]', 135);
    await setValue('[data-testid="pose-slider-L4"]', 170);
    await sleep(200);
    const posed = await evaluate(LAB_EXPR);
    check(
      posed.poseAdjustedDeg.R1 === 135 && posed.poseAdjustedDeg.L4 === 170,
      `the adjusted column reads R1=${posed.poseAdjustedDeg.R1} L4=${posed.poseAdjustedDeg.L4}, ` +
        `not 135/170 — with no subtrim, constrain(angle + 0, 0, 180) is the identity`,
    );

    // Quantisation, checked WITHOUT reproducing ESP32Servo's arithmetic here:
    // the claim is that 181 commands produce 92 distinct pulses, so two
    // specific neighbouring angles must land on ONE tick, and the ends must
    // not. Recomputing map()/usToTicks() in this file would only prove the
    // formula was copied correctly.
    await setValue('[data-testid="pose-slider-R2"]', 99);
    await sleep(150);
    const at99 = (await evaluate(LAB_EXPR)).poseTicks.R2;
    await setValue('[data-testid="pose-slider-R2"]', 100);
    await sleep(150);
    const at100 = (await evaluate(LAB_EXPR)).poseTicks.R2;
    await setValue('[data-testid="pose-slider-R2"]', 0);
    await sleep(150);
    const at0 = (await evaluate(LAB_EXPR)).poseTicks.R2;
    await setValue('[data-testid="pose-slider-R2"]', 180);
    await sleep(150);
    const at180 = (await evaluate(LAB_EXPR)).poseTicks.R2;
    check(
      at99 !== null && at99 === at100,
      `99° programmed tick ${at99} and 100° programmed tick ${at100}; the Lab is implying a 1° ` +
        `resolution the 10-bit LEDC channels do not have`,
    );
    check(
      at0 !== null && at180 !== null && at0 !== at180,
      `0° and 180° both programmed tick ${at0}, which would make the whole readout meaningless`,
    );
    await setValue('[data-testid="pose-slider-R2"]', 90);
    await sleep(150);

    await focusSection(evaluate, 'lab');
    labShots.push(
      await page11.shoot(
        'lab-pose-and-quantisation.png',
        'the eight sliders in firmware enum order, each showing constrain(angle + subtrim, 0, 180) ' +
          'and the LEDC tick the adjusted angle actually programs — 99° and 100° share one',
      ),
    );

    // ======================================================= the animation
    //
    // Sesame Studio's model: a pose is eight angles, a frame is a pose plus a
    // wait. Two frames, captured from the sliders exactly as a person would.
    const authored = [
      { R1: 135, R2: 90, L1: 90, L2: 90, R4: 90, R3: 90, L3: 90, L4: 170 },
      { R1: 45, R2: 90, L1: 90, L2: 90, R4: 90, R3: 90, L3: 90, L4: 120 },
    ];
    await clickOn('[data-testid="pose-capture"]');
    await sleep(250);
    await clickOn('[data-testid="lab-tab-pose"]');
    await sleep(200);
    await setValue('[data-testid="pose-slider-R1"]', 45);
    await setValue('[data-testid="pose-slider-L4"]', 120);
    await sleep(200);
    await clickOn('[data-testid="pose-capture"]');
    await sleep(300);
    await showLab();

    const withFrames = await evaluate(LAB_EXPR);
    check(
      withFrames.frameRows === 2,
      `the animation holds ${withFrames.frameRows} frame(s) after two captures, not 2`,
    );

    // ------------------------------------------- the export, parsed here
    const exported = withFrames.exportedCpp;
    check(exported.length > 0, 'the C++ export box is empty');
    check(
      exported.includes('COMMANDED ANGLES') && exported.includes('89 of the 181'),
      'the exported C++ does not carry the never-verified / aliasing warning in the code itself, ' +
        'so the warning does not survive the clipboard',
    );
    check(
      /setServoAngle\(R1, 135\);/.test(exported),
      'the export does not use the firmware’s own call shape setServoAngle(R1, 135);',
    );

    const reparsed = parseExportedCpp(exported);
    check(
      reparsed.length === 2,
      `parsing the exported C++ back gave ${reparsed.length} frame(s), not the 2 that were authored`,
    );
    let roundTripProblems = 0;
    reparsed.forEach((frame, index) => {
      const expected = authored[index] ?? {};
      // Every channel, in firmware enum order — the export must not group,
      // reorder or drop, because the firmware issues them one at a time.
      if (JSON.stringify(frame.order) !== JSON.stringify(JOINT_ORDER)) {
        roundTripProblems += 1;
        problems.push(
          `frame ${index + 1} of the exported C++ writes ${JSON.stringify(frame.order)}; the ` +
            `firmware writes ${JSON.stringify(JOINT_ORDER)} and setServoAngle() is the only call it has`,
        );
      }
      for (const joint of JOINT_ORDER) {
        if (frame.angles[joint] !== expected[joint]) {
          roundTripProblems += 1;
          problems.push(
            `the exported C++ says frame ${index + 1} commands ${joint} to ` +
              `${frame.angles[joint]}°; the sliders authored ${expected[joint]}°`,
          );
        }
      }
    });
    check(
      withFrames.exportedCppRoundTripOk === true,
      `the Lab’s own round-trip readout says ${withFrames.exportedCppRoundTripOk}; this harness ` +
        `re-parsed the same text independently and found ${roundTripProblems} disagreement(s)`,
    );
    check(
      withFrames.exportedCppWrites === 16,
      `the Lab reports ${withFrames.exportedCppWrites} setServoAngle() calls in the export; two ` +
        `full poses is 16`,
    );

    await evaluate(
      `void document.querySelector('[data-testid="lab-cpp-export"]')?.scrollIntoView({ block: 'nearest' })`,
    );
    await sleep(350);
    await focusSection(evaluate, 'lab');
    labShots.push(
      await page11.shoot(
        'lab-cpp-export.png',
        'the Sesame-compatible C++ export — the firmware’s own setServoAngle(R1, 135); call shape, ' +
          'the commanded-angles warning inside the generated code, and the read-back verdict',
      ),
    );

    // --------------------------------------------- play it, read the scene
    await clickOn('[data-testid="sequence-run"]');
    await waitFor(
      evaluate,
      `(() => {
        const button = document.querySelector('[data-testid="sequence-run"]');
        return button === null ? null : button.disabled;
      })()`,
      (v) => v === false,
      'the authored animation to finish playing',
      40000,
    );
    await waitCaughtUp('the scene to apply the animation’s last frame');
    const sceneAfter = await evaluate('window.__sesame.sceneJoints()');
    const finalPose = authored[1];
    let worstAngleErrorDeg = 0;
    for (const reading of sceneAfter) {
      const want = finalPose[reading.joint];
      const error = Math.abs(reading.sceneCommandedDeg - want);
      worstAngleErrorDeg = Math.max(worstAngleErrorDeg, error);
      check(
        error <= 0.5,
        `after playing the animation the 3D scene draws ${reading.joint} at ` +
          `${reading.sceneCommandedDeg.toFixed(3)}°; the animation's last frame commands ${want}°. ` +
          `This is read off Object3D.quaternion, not off the document that was authored`,
      );
      check(
        reading.storePhysicallyObserved === false,
        `${reading.joint} was last written by an event claiming to be physically observed; there ` +
          `is no physical robot in this project`,
      );
    }

    // ============================================================ the face
    //
    // A DRAG, not a click. `PixelEditor` hands the parent one coordinate per
    // pointermove and a drag delivers several before React re-renders, so a
    // parent that computed the next frame from `props.frame` would keep only
    // the last of them. Nine pixels go down in one stroke and all nine have to
    // survive as far as the panel's GDDRAM.
    await clickOn('[data-testid="lab-tab-face"]');
    await sleep(250);
    await showLab();
    const drawn = await evaluate(`(() => {
      const canvas = document.querySelector('[data-testid="pixel-canvas"]');
      if (canvas === null) return { ok: false, why: 'no pixel canvas' };
      const box = canvas.getBoundingClientRect();
      const at = (px, py) => ({
        clientX: box.left + ((px + 0.5) / 128) * box.width,
        clientY: box.top + ((py + 0.5) / 64) * box.height,
        bubbles: true,
        isPrimary: true,
        pointerId: 1,
      });
      canvas.dispatchEvent(new PointerEvent('pointerdown', at(40, 20)));
      for (let y = 20; y < 23; y += 1) {
        for (let x = 40; x < 43; x += 1) {
          canvas.dispatchEvent(new PointerEvent('pointermove', at(x, y)));
        }
      }
      canvas.dispatchEvent(new PointerEvent('pointerup', at(42, 22)));
      return { ok: true };
    })()`);
    check(drawn.ok, `could not draw on the pixel canvas: ${drawn.why}`);
    await sleep(250);

    await clickOn('[data-testid="lab-face-push"]');
    await sleep(500);

    const oled11 = await evaluate('window.__sesame.oled()');
    check(
      oled11.litPixels === STROKE.length,
      `the panel is showing ${oled11.litPixels} lit pixel(s) after a 3x3 drag. Nine went down in ` +
        `one stroke; a parent computing the next frame from a stale props.frame keeps one`,
    );
    const panelBytes = Buffer.from(oled11.base64, 'base64');
    check(
      panelBytes.length === 1024,
      `the panel buffer decoded to ${panelBytes.length} bytes, not the SSD1306's 1024`,
    );
    let panelMismatches = 0;
    for (const [x, y] of STROKE) {
      if (!gddramPixel(panelBytes, x, y)) panelMismatches += 1;
    }
    check(
      panelMismatches === 0,
      `${panelMismatches} of the 9 drawn pixels are not set in the panel's page-ordered GDDRAM ` +
        `(index = x + (y>>3)*128, bit = y&7 from the LSB)`,
    );
    check(
      gddramPixel(panelBytes, 43, 23) === false,
      'a pixel outside the drawn square is lit on the panel',
    );
    check(
      oled11.source.pixelProvenance === 'inferred',
      `the drawn pixels are presented with provenance ${JSON.stringify(oled11.source.pixelProvenance)}; ` +
        `pixels a person drew are inferred, never observed`,
    );

    // The exported header holds the OTHER layout — row-major, MSB first, which
    // is what drawBitmap() reads. Same nine pixels, different bytes.
    const faceReading = await evaluate(LAB_EXPR);
    const faceBytes = [...(faceReading.exportedFace.match(/0x[0-9a-fA-F]{2}/g) ?? [])].map((b) =>
      Number.parseInt(b, 16),
    );
    check(
      faceBytes.length === 1024,
      `the exported face-bitmaps.h array holds ${faceBytes.length} bytes, not 1024`,
    );
    let headerMismatches = 0;
    for (const [x, y] of STROKE) {
      const byte = faceBytes[y * 16 + (x >> 3)] ?? 0;
      if ((byte & (0x80 >> (x & 7))) === 0) headerMismatches += 1;
    }
    check(
      headerMismatches === 0,
      `${headerMismatches} of the 9 drawn pixels are missing from the exported face-bitmaps.h ` +
        `array's row-major bytes`,
    );
    check(
      faceReading.exportedFace.includes('const unsigned char epd_bitmap_labface [] PROGMEM = {'),
      'the face export is not shaped like the arrays already in firmware/face-bitmaps.h',
    );
    check(
      faceReading.exportedFaceRoundTripOk === true,
      `the Lab's own face read-back says ${faceReading.exportedFaceRoundTripOk}`,
    );

    // The banner has to notice. Lab mode sets far more state than Learn does,
    // and an authored face sitting where the robot's own would be is exactly
    // the "is this robot broken, or did we break it?" case it exists for.
    check(
      faceReading.modifications !== null && faceReading.modifications.panelAuthored === true,
      `the "Sesame Lab is modifying this robot" banner does not name the authored panel: ` +
        `${JSON.stringify(faceReading.modifications)}`,
    );

    // …and it has to STOP claiming it the moment the robot repaints. An
    // authored frame is not sticky the way subtrim is: the next face event
    // overwrites those pixels, and a banner that kept saying "Sesame Lab drew
    // this" over the robot's own face would be exactly the kind of confident
    // wrongness the banner exists to prevent. This is the falsification —
    // `panelAuthored` is asserted true above and false here, so it is known
    // not to be a constant.
    await evaluate('void window.__sesame.setFace("happy")');
    await sleep(700);
    const afterRepaint = await evaluate(LAB_EXPR);
    check(
      (afterRepaint.modifications?.panelAuthored ?? false) === false,
      `the banner still claims Sesame Lab drew the panel after the robot repainted it: ` +
        `${JSON.stringify(afterRepaint.modifications)}`,
    );

    await evaluate(
      `void document.querySelector('[data-testid="pixel-editor"]')?.scrollIntoView({ block: 'start' })`,
    );
    await sleep(350);
    await focusSection(evaluate, 'lab');
    labShots.push(
      await page11.shoot(
        'lab-face-editor.png',
        'a 3x3 square drawn in one drag, pushed to the panel through the same drawBitmap() path a ' +
          'real face takes, and exported as a face-bitmaps.h array',
      ),
    );

    // ============================================================== the API
    await clickOn('[data-testid="lab-tab-api"]');
    await sleep(250);
    await showLab();

    const apiReading = await evaluate(LAB_EXPR);
    check(
      apiReading.routeOptions.includes('/api/status') &&
        apiReading.routeOptions.includes('/api/wifi/scan') &&
        apiReading.routeOptions.includes('/getSettings'),
      `the Lab's route picker offers ${JSON.stringify(apiReading.routeOptions)}; it should carry ` +
        `the routes hardware-map.json records, not the five a lesson names`,
    );
    check(
      apiReading.firmwareRouteCount === 10,
      `the generated architecture graph holds ${apiReading.firmwareRouteCount} routes, not the 10 ` +
        `hardware-map.json records`,
    );

    await selectOption('[data-testid="http-method"]', 'POST');
    await sleep(150);
    await setValue('[data-testid="http-route-free"]', '/api/command');
    await setValue('[data-testid="http-body"]', '{"command":"stand"}', 'HTMLTextAreaElement');
    await sleep(150);
    await clickOn('[data-testid="http-send"]');
    const posted = await waitFor(
      evaluate,
      LAB_EXPR,
      (v) => v !== null && v.httpLog.length > 0,
      'the API console to record a reply',
    );
    check(
      /\/api\/command\s*→\s*200/.test(posted.httpLog.at(-1) ?? ''),
      `POST /api/command came back as ${JSON.stringify(posted.httpLog.at(-1))}; this page is served ` +
        `by the lab host, so the firmware's own route is really there`,
    );

    await selectOption('[data-testid="http-method"]', 'GET');
    await setValue('[data-testid="http-route-free"]', '/api/status');
    await sleep(150);
    await clickOn('[data-testid="http-send"]');
    const statusRead = await waitFor(
      evaluate,
      LAB_EXPR,
      (v) => v !== null && v.httpLog.some((line) => line.includes('/api/status')),
      'the API console to record /api/status',
    );
    const statusLine = statusRead.httpLog.find((line) => line.includes('/api/status')) ?? '';
    check(/→\s*200/.test(statusLine), `GET /api/status came back as ${JSON.stringify(statusLine)}`);
    check(
      /currentCommand/.test(statusLine),
      `GET /api/status did not return the firmware's own status document: ${JSON.stringify(statusLine)}`,
    );

    // ISSUE-20260823-021 is real, the Lab says so, and our adapter does NOT
    // reproduce it. Store a command word containing a quotation mark — the
    // exact input that makes upstream emit invalid JSON — and the reply has to
    // still parse.
    await selectOption('[data-testid="http-method"]', 'POST');
    await setValue('[data-testid="http-route-free"]', '/api/command');
    await setValue('[data-testid="http-body"]', '{"command":"x\\"y"}', 'HTMLTextAreaElement');
    await sleep(200);
    await clickOn('[data-testid="http-send"]');
    await sleep(700);
    const injected = await evaluate(`(async () => {
      const response = await fetch('/api/status', { cache: 'no-store' });
      const text = await response.text();
      let parsed = null;
      let error = null;
      try { parsed = JSON.parse(text); } catch (e) { error = String(e && e.message ? e.message : e); }
      return { status: response.status, text, parsed, error };
    })()`);
    check(
      injected.error === null,
      `/api/status returned JSON this harness could not parse after a quotation mark was stored ` +
        `(${injected.error}). Upstream does exactly that — ISSUE-20260823-021 — and our adapter ` +
        `sanitises with no opt-out precisely so it cannot: ${String(injected.text).slice(0, 160)}`,
    );
    check(
      typeof injected.parsed?.currentCommand === 'string' &&
        !injected.parsed.currentCommand.includes('"') &&
        !injected.parsed.currentCommand.includes('@'),
      `currentCommand came back as ${JSON.stringify(injected.parsed?.currentCommand)}; the ` +
        `boundary reduces every name to [A-Za-z0-9_.-]`,
    );
    const issueNoteShown = await evaluate(
      `(document.querySelector('[data-testid="lab-api-issue-021"]')?.textContent ?? '')`,
    );
    check(
      /ISSUE-20260823-021/.test(issueNoteShown) && /not reproduced here/i.test(issueNoteShown),
      'the API console does not tell the learner that the defect is real upstream and deliberately ' +
        'not reproduced by the thing they are talking to',
    );

    await focusSection(evaluate, 'lab');
    labShots.push(
      await page11.shoot(
        'lab-api-console.png',
        'free-form requests against the routes hardware-map.json records, with the HTTP_ANY note ' +
          'and ISSUE-20260823-021 described but not reproduced',
      ),
    );

    // ========================================= the banner, and putting it back
    await clickOn('[data-testid="lab-tab-faults"]');
    await sleep(250);
    const faultToggled = await evaluate(`(() => {
      const panel = document.querySelector('[data-testid="lab-panel"]');
      const box = panel?.querySelector('[data-testid="fault-injector"] input[type="checkbox"]');
      if (box == null) return { ok: false, why: 'no injectable fault switch on screen' };
      box.click();
      return { ok: true };
    })()`);
    check(faultToggled.ok, `could not inject a fault: ${faultToggled.why}`);
    await sleep(400);
    const withFault = await evaluate(LAB_EXPR);
    check(
      withFault.modifications !== null && withFault.modifications.faults >= 1,
      `the banner reports ${JSON.stringify(withFault.modifications)} after a fault was injected`,
    );

    // Both kinds at once, so "put it all back" has two things to put back:
    // an injected fault, which is sticky, and a drawn face, which is not.
    await clickOn('[data-testid="lab-tab-face"]');
    await sleep(300);
    await clickOn('[data-testid="lab-face-push"]');
    await sleep(500);
    const bothModified = await evaluate(LAB_EXPR);
    check(
      (bothModified.modifications?.faults ?? 0) >= 1 &&
        bothModified.modifications?.panelAuthored === true,
      `the banner reports ${JSON.stringify(bothModified.modifications)} with a fault injected AND ` +
        `a drawn face on the panel; it has to name both`,
    );

    await clickOn('[data-testid="lab-modifications-clear"]');
    await sleep(600);
    const cleared = await evaluate(LAB_EXPR);
    check(
      cleared.modifications === null,
      `"put it all back" left ${JSON.stringify(cleared.modifications)} in place`,
    );
    const oledAfterClear = await evaluate('window.__sesame.oled()');
    check(
      oledAfterClear.litPixels !== STROKE.length,
      'putting it back left the drawn face on the panel; the robot’s own face should have been ' +
        'redrawn (a blank panel would be a state no firmware produces)',
    );

    // ========================================================= persistence
    const beforeReload = await evaluate(LAB_EXPR);
    check(
      beforeReload.storedBytes !== null && beforeReload.storedBytes > 0,
      `nothing is stored under sesame-lab.lab.v1 (${beforeReload.storedBytes} bytes)`,
    );
    check(
      beforeReload.storageBlocked === false,
      `the Lab reports storage blocked: ${JSON.stringify(beforeReload.savedText)}`,
    );

    await evaluate('void location.reload()');
    await sleep(700);
    await waitReady('the app to come back after the persistence reload');
    const afterReload = await evaluate(LAB_EXPR);
    check(
      afterReload.open === false,
      'the Lab reopened itself after a reload; only the PROJECT is persisted, not the pane state',
    );
    const restoredNote = await evaluate(
      `(document.querySelector('[data-testid="lab-restored"]')?.textContent ?? '')`,
    );
    check(
      /2 frame\(s\)/.test(restoredNote),
      `the closed Lab reports "${restoredNote}" after a reload; two frames were authored`,
    );

    await clickOn('[data-testid="lab-open"]');
    await sleep(300);
    await clickOn('[data-testid="lab-tab-animation"]');
    await sleep(400);
    await showLab();
    const reloaded = await evaluate(LAB_EXPR);
    check(
      reloaded.frameRows === 2,
      `the animation came back with ${reloaded.frameRows} frame(s) after a reload, not 2`,
    );
    check(
      reloaded.exportedCpp === exported,
      'the C++ exported after a reload is not byte-identical to the one exported before it',
    );
    const reloadedFrames = parseExportedCpp(reloaded.exportedCpp);
    check(
      JSON.stringify(reloadedFrames.map((f) => f.angles)) ===
        JSON.stringify(reparsed.map((f) => f.angles)),
      'the pose sequence changed across the reload',
    );
    await clickOn('[data-testid="lab-tab-face"]');
    await sleep(400);
    const reloadedFace = await evaluate(LAB_EXPR);
    const reloadedFaceBytes = [
      ...(reloadedFace.exportedFace.match(/0x[0-9a-fA-F]{2}/g) ?? []),
    ].map((b) => Number.parseInt(b, 16));
    let reloadedFaceMismatches = 0;
    for (const [x, y] of STROKE) {
      const byte = reloadedFaceBytes[y * 16 + (x >> 3)] ?? 0;
      if ((byte & (0x80 >> (x & 7))) === 0) reloadedFaceMismatches += 1;
    }
    check(
      reloadedFaceMismatches === 0,
      `${reloadedFaceMismatches} of the 9 drawn pixels did not survive the reload`,
    );

    // ============================ ISSUE-20260823-023, with the Lab mounted
    //
    // That bug was a sliding ground plane, found by a person, on a green
    // harness, after a layout change. Lab mode is a FOURTH grid row and a tall
    // one when open, so it gets the same re-check the source explorer and the
    // lesson runner did — with the pane open and a tab being switched under it.
    const EPS11 = 1e-6;
    await evaluate('window.__sesame.setBackend("qemu")');
    await waitFor(
      evaluate,
      'window.__sesame.status()',
      (v) => v !== null && v.connection === 'connected',
      'the lab-host backend to reconnect for the world-frame check',
      60000,
    );
    await evaluate('void window.__sesame.run("rest")');
    await sleep(1400);
    await waitCaughtUp('the scene to reach the rest pose for the phase 11 frame check');
    const frames11 = [];
    const restFrame11 = await evaluate('window.__sesame.worldFrame()');
    if (restFrame11 === null) problems.push('worldFrame() returned null at the phase 11 rest pose');
    else frames11.push({ label: 'phase 11, rest pose, Lab pane open', ...restFrame11 });

    for (let i = 0; i < 6; i++) {
      await evaluate(`void window.__sesame.run(${i % 2 === 0 ? '"stand"' : '"rest"'})`);
      await sleep(450);
      // Keep the Lab working while the scene moves: a re-render that nudged the
      // world frame is exactly the bug class being re-tested.
      await clickOn(`[data-testid="lab-tab-${i % 2 === 0 ? 'pose' : 'animation'}"]`);
      const sample = await evaluate('window.__sesame.worldFrame()');
      if (sample === null) problems.push('worldFrame() returned null during phase 11');
      else frames11.push({ label: `phase 11, sample ${i + 1}`, ...sample });
    }

    const first11 = frames11[0];
    const worst11 = {};
    for (const key of ['groundWorldMm', 'robotRootWorldMm', 'cameraTargetMm', 'cameraPositionMm']) {
      let worst = 0;
      for (const sample of frames11.slice(1)) {
        const a = first11?.[key];
        const b = sample[key];
        if (!Array.isArray(a) || !Array.isArray(b)) continue;
        for (let i = 0; i < 3; i++) worst = Math.max(worst, Math.abs(a[i] - b[i]));
      }
      worst11[key] = worst;
      check(
        worst <= EPS11,
        `${key} moved ${worst.toFixed(6)} mm in world space with LAB MODE open as a fourth grid ` +
          `row, a pose table and two export boxes rendering (ISSUE-20260823-023)`,
      );
    }
    const contacts11 = frames11.map((f) => f.footContactMm).filter((v) => typeof v === 'number');
    const spread11 = contacts11.length === 0 ? 0 : Math.max(...contacts11) - Math.min(...contacts11);
    check(
      spread11 > 1,
      `the foot contact varied by only ${spread11.toFixed(3)} mm in phase 11, so the ` +
        `world-stability re-check proved nothing`,
    );

    const honesty11 = await evaluate(LAB_EXPR);
    check(
      /claims a servo moved/i.test(honesty11.honestyNote ?? ''),
      `the Lab does not carry its "nothing claims a servo moved" line: ` +
        `${JSON.stringify(honesty11.honestyNote)}`,
    );
    const origin11 = await evaluate('window.__sesame.origin()');
    check(
      origin11.physicallyObservedEvents === 0,
      `isPhysicallyObserved() was true for ${origin11.physicallyObservedEvents} event(s) in Lab mode`,
    );

    const errors11 = page11.errors();
    check(
      errors11.length === 0,
      `the Lab page logged ${errors11.length} error(s): ${errors11.slice(0, 3).join(' | ')}`,
    );

    phases.labMode = {
      ok: problems.length === before11,
      servedBy: 'apps/web/server/lab-host.mjs --backend sim (the firmware’s own routes, no QEMU)',
      browserBackend: 'lab host',
      authoredFrames: authored,
      cppRoundTrip: {
        assertedBy: 'a second setServoAngle() parser written in this harness',
        framesParsedBack: reparsed.length,
        writes: withFrames.exportedCppWrites,
        labOwnVerdict: withFrames.exportedCppRoundTripOk,
        callShape: 'setServoAngle(R1, 135); — firmware/movement-sequences.h:80',
      },
      playback: { worstAngleErrorDeg, readFrom: 'Object3D.quaternion' },
      quantisation: { at0, at99, at100, at180 },
      face: {
        strokePixels: STROKE.length,
        panelLitPixels: oled11.litPixels,
        panelLayout: 'page-ordered GDDRAM, index = x + (y>>3)*128, bit = y&7 from the LSB',
        exportLayout: 'row-major MSB first, 16 bytes per row — what drawBitmap() reads',
        pixelProvenance: oled11.source.pixelProvenance,
      },
      api: {
        routeOptions: apiReading.routeOptions,
        commandStatusLine: posted.httpLog.at(-1),
        statusLine,
        issue021: {
          describedInUi: true,
          reproducedByOurAdapter: false,
          currentCommandAfterQuote: injected.parsed?.currentCommand ?? null,
        },
      },
      persistence: {
        key: 'sesame-lab.lab.v1',
        storedBytes: beforeReload.storedBytes,
        survivedReload: reloaded.frameRows === 2 && reloadedFaceMismatches === 0,
      },
      labModifications: {
        namedAuthoredPanel: faceReading.modifications?.panelAuthored ?? null,
        stoppedClaimingAfterRobotRepainted:
          (afterRepaint.modifications?.panelAuthored ?? false) === false,
        namedInjectedFault: withFault.modifications?.faults ?? null,
        namedBothAtOnce:
          (bothModified.modifications?.faults ?? 0) >= 1 &&
          bothModified.modifications?.panelAuthored === true,
        clearedToNull: cleared.modifications === null,
      },
      worldFrame: {
        toleranceMm: EPS11,
        worstDriftMm: worst11,
        footContactSpreadMm: spread11,
        samples: frames11.length,
      },
      shots: labShots.map((s) => s.name),
    };
  } catch (error) {
    problems.push(`the Lab mode phase failed: ${error.message ?? error}`);
    phases.labMode = {
      ok: false,
      error: String(error.message ?? error),
      labHostOutput: labHost11 === null ? null : labHost11.output().slice(-1200),
    };
  } finally {
    page11?.close();
    try {
      labHost11?.proc.kill();
    } catch {
      /* gone */
    }
    await sleep(600);
  }
}


// ===========================================================================
// PHASE 12: THE RESPONSIVE SHELL
// ===========================================================================
//
// The assertion whose ABSENCE let a 13%-of-screen robot ship.
//
// The harness had 26 captures before this one and not a single one of them
// asked how much space the 3D viewport actually got. Every phase ran at one
// fixed window, that window was wide, and the layout was fine there — so a
// `minmax(0,1fr) minmax(0,520px) 400px` grid with a fixed 380 px source row
// passed every check while leaving a 1440x900 laptop roughly 500x280 for the
// thing the product is about.
//
// So this phase visits four windows — one per breakpoint, plus the two the plan
// names inside Medium — and at each one it asserts:
//
//   * the CANVAS (not the container that holds it) is at least 45% of the
//     window's height and at least 480 px wide;
//   * the robot is actually drawn there, by reading non-background pixels back
//     out of the middle of the WebGL drawing buffer;
//   * ISSUE-20260823-023 — the ground plane, the GLB root, the orbit target and
//     the camera hold to 1e-6 mm while the foot contact sweeps 37.5 mm. A user
//     found that bug after a layout change and this IS a layout change, so it is
//     re-run at every breakpoint AND across a dock resize, which is now the one
//     remaining path that resizes the renderer's canvas;
//   * the STAGE KEEPS >= 50% OF THE WINDOW'S AREA at Medium and above — Phase
//     4 §7, and the user's own words: "I'd rather the robot area shrink. 50% of
//     the screen area is more than enough." This REPLACED `overlay-not-push`,
//     which asserted the opposite arrangement (the stage's width identical with
//     the docks shut and with each open) and which W3 made false by design;
//   * and its inverse, because a share is only honest if the box is really
//     there: at Medium the stage must LOSE more than 300 px of canvas when the
//     workbench opens. In flow is a claim about the layout, not a comment;
//   * below Wide there is ONE workbench with a `Control | Analyze` switch, a
//     section navigator instead of a collapsed-accordion column, exactly ONE
//     pane with a laid-out box, and exactly ONE scrollable box in it. All of it
//     comes from a reader: "when I select one of the panes, the other should be
//     collapsed" and "I'd rather have to scroll through the pane vertically
//     than tiny content and many scrollbars";
//   * the environment line — `SYSTEM: ... · PHYSICAL HARDWARE: NONE` — is
//     visible and whole at every width. The brief is blunt that a novice reads
//     "observed" as *observed on hardware*, so this is a correctness surface
//     and it is in the truncation list;
//   * nothing in the dock is SMALLER at Medium or Compact than it is at Wide —
//     the machine-checkable form of "I cannot read any of the content";
//   * `wave` is reachable with both docks SHUT. The vocabulary moved into the
//     control dock, so what carries that promise now is the status line's
//     `[data-quick-command]` cluster, and it is hit-tested with
//     `elementFromPoint` rather than merely found in the DOM;
//   * a collapsed section whose content just became selected shows a header
//     badge, and `selectJoint` auto-expands its target section below Wide (§5)
//     — in the ANALYSIS dock only, because a selection is something to read
//     about and must never yank the controls away;
//   * the collapse state survives a real reload, for both docks;
//   * Learn still plays lesson 2 end to end at Medium, and the Lab's C++ export
//     still round-trips at Compact — the two places a collapsed accordion could
//     have broken a whole mode rather than a pixel count.
// ===========================================================================
{
  console.log('[web] phase 12: the responsive shell');
  const shellShots = [];
  const before12 = problems.length;
  const measured = [];

  // Its own server: `replayBridge` was killed after phase 10, and every page
  // below is a fresh browser at a different window size rather than a resize of
  // an existing one. A real window is what the media queries and `innerWidth`
  // see; a CDP metrics override would be measuring the emulator rather than the
  // layout.
  const shellBridge = await startBridge({ replay: WAVE_FIXTURE }).catch((e) => die(e.message));

  /** Filled in by the Learn-at-Medium run below; reported with the phase. */
  let laptopProseMeasure = null;
  const HEIGHT_FLOOR_PCT = 45;
  const WIDTH_FLOOR_PX = 480;
  /**
   * **THE metric — Phase 4 §7.** The 3D canvas's area as a share of the
   * window's, at Medium and above.
   *
   * It replaces `overlay-not-push`, which measured that opening a dock moved
   * the stage 0.0 px. That assertion was true, and W3 made it false BY DESIGN:
   * the user's rule is *"I'd rather the robot area shrink. 50% of the screen
   * area is more than enough."* Left in place it would have gone on passing at
   * Compact — where a sheet really does float — while saying nothing at all
   * about the laptop, which is the width the whole complaint came from. That is
   * the hollow-assertion failure this project has already hit twice, and §7
   * says so in as many words.
   *
   * Area rather than height, because height was never the half that was broken
   * once the strip under the robot was gone: a full-bleed stage behind an
   * overlay reads 96% tall and 100% wide with a panel sitting on top of it.
   */
  const STAGE_AREA_FLOOR_PCT = 50;
  /**
   * **The second metric — §11.2.** The stage's share of the CONTENT area, in
   * force whenever a module is active.
   *
   * §11.2 is explicit that this and the rule above may not be averaged into one
   * loose threshold, so they are two named regimes and the app publishes which
   * one it is claiming. Content is the viewport minus the rail, the status
   * strip and the side panel — the plain reading of *"with the robot in the
   * other half"* — and it is achievable at every width above the module's own
   * minimum, which the 50%-of-VIEWPORT rule is not once a rail, a strip and a
   * panel exist (§11.2's own table: 36.0% at 1440, 41.9% at 2560).
   */
  const STAGE_CONTENT_FLOOR_PCT = 50;
  /** Mirrored from `ui/shell-state.ts`; asserted against the measured boxes. */
  const RAIL_W_PX = 64;
  const PANEL_W_PX = 280;
  /** Per-window record of what the side panel folded, reported with the phase. */
  const panelFolds = {};
  /** W8: which arrangement the Source pane got at each window, measured. */
  const sourceArrangements = {};
  /** The architecture's own box in the ORDINARY layout, per window — W4's constraint. */
  const archSurfaces = [];
  const FRAME_EPS_MM_12 = 1e-6;
  /** Non-background share of the middle of the drawing buffer. */
  const ROBOT_PIXEL_FLOOR_PCT = 2;

  /**
   * How much of the MIDDLE of the drawing buffer is not the clear colour.
   *
   * `snapshot().canvasPixels` reads a 320x320 corner, which is fine for "did
   * WebGL draw anything" and useless for "is the robot big enough to see": on a
   * 2018x1171 canvas that corner is mostly empty floor. This samples 400x400
   * from the centre, where the robot is, and reports a share rather than a
   * count so one floor is meaningful at every window size.
   */
  const robotPixelShare = (evaluate) =>
    evaluate(`(() => {
      let canvas = null;
      let gl = null;
      for (const candidate of document.querySelectorAll('canvas')) {
        const context = candidate.getContext('webgl2') ?? candidate.getContext('webgl');
        if (context !== null) { canvas = candidate; gl = context; break; }
      }
      if (gl === null) return null;
      const w = Math.min(canvas.width, 400);
      const h = Math.min(canvas.height, 400);
      const x = Math.max(0, Math.floor((canvas.width - w) / 2));
      const y = Math.max(0, Math.floor((canvas.height - h) / 2));
      const pixels = new Uint8Array(w * h * 4);
      gl.readPixels(x, y, w, h, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
      let n = 0;
      for (let i = 0; i < pixels.length; i += 4) {
        if (Math.abs(pixels[i] - 0x0d) > 6 || Math.abs(pixels[i + 1] - 0x10) > 6 || Math.abs(pixels[i + 2] - 0x15) > 6) n += 1;
      }
      return { lit: n, sampled: w * h, sharePct: (n / (w * h)) * 100, bufferW: canvas.width, bufferH: canvas.height };
    })()`);

  /**
   * ISSUE-20260823-023, once per breakpoint.
   *
   * `rest -> stand` rather than `rest -> wave`: V8 §4.3 recorded that the wave
   * sweep was vacuous because the foot contact barely moved, and the whole
   * point is to hold the world still while the pose moves 37.5 mm underneath it.
   */
  const sweepWorldFrame = async (page, label) => {
    const frames = [];
    const sample = async (tag) => {
      const frame = await page.evaluate('window.__sesame.worldFrame()');
      if (frame === null) problems.push(`worldFrame() returned null at "${label}: ${tag}"`);
      else frames.push({ label: `${label}: ${tag}`, ...frame });
    };
    await page.evaluate('window.__sesame.run("rest")');
    await sleep(1400);
    await sample('rest pose');
    void page.evaluate('window.__sesame.run("stand")');
    for (let i = 0; i < 10; i += 1) {
      await sleep(170);
      await sample(`stand sample ${i + 1}`);
    }
    const first = frames[0];
    const worst = {};
    for (const key of ['groundWorldMm', 'robotRootWorldMm', 'cameraTargetMm', 'cameraPositionMm']) {
      let value = 0;
      for (const frame of frames.slice(1)) {
        const a = first?.[key];
        const b = frame[key];
        if (!Array.isArray(a) || !Array.isArray(b)) continue;
        for (let i = 0; i < 3; i++) value = Math.max(value, Math.abs(a[i] - b[i]));
      }
      worst[key] = value;
      check(
        value <= FRAME_EPS_MM_12,
        `${key} moved ${value.toFixed(6)} mm in world space at ${label} (ISSUE-20260823-023)`,
      );
    }
    const contacts = frames.map((f) => f.footContactMm).filter((v) => typeof v === 'number');
    const spread = contacts.length === 0 ? 0 : Math.max(...contacts) - Math.min(...contacts);
    // The guard against a vacuous pass: a check that never moved the pose has
    // not held anything still.
    check(
      spread > 5,
      `the foot contact varied by only ${spread.toFixed(3)} mm at ${label}, so the world-stability ` +
        `check above proved nothing`,
    );
    return { worst, footContactSpreadMm: spread, samples: frames.length };
  };

  /**
   * A shell reading taken only once the layout has stopped moving.
   *
   * Two things settle late and both produce a plausible-looking wrong number:
   * R3F resizes its drawing buffer from a `ResizeObserver` a frame after the
   * box changes, and the browser window itself is still being clamped to the
   * display for the first moments after launch — which is how a `shut` reading
   * once reported a 1347 px window and the `open` reading beside it reported
   * 1313. So read twice and require agreement rather than sleeping and hoping.
   */
  const settledShell = async (page, why) => {
    let previous = null;
    for (let i = 0; i < 30; i += 1) {
      const reading = await page.evaluate('window.__sesame.shell()');
      if (
        previous !== null &&
        previous.windowHeightPx === reading.windowHeightPx &&
        Math.abs(previous.canvasWidthPx - reading.canvasWidthPx) < 0.5 &&
        Math.abs(previous.canvasHeightPx - reading.canvasHeightPx) < 0.5 &&
        Math.abs(previous.stageWidthPx - reading.stageWidthPx) < 0.5
      ) {
        return reading;
      }
      previous = reading;
      await sleep(220);
    }
    problems.push(`the layout never settled while waiting for ${why}`);
    return previous;
  };

  const bootPage = async (window) => {
    const shellPage = await launchBrowser(shellBridge.url, window);
    await waitFor(
      shellPage.evaluate,
      'typeof window.__sesame !== "undefined" && window.__sesame.ready',
      (v) => v === true,
      `the app to load at ${window.width}x${window.height}`,
      60000,
    );
    /*
      The simulator, chosen rather than inherited — Phase 4 W8.

      These pages are served by the BRIDGE, which has no lab host, so the app
      opens on the QEMU default and reports that there is nothing behind it.
      That contract is asserted once, in phase 1, against the same server. Phase
      12 is about LAYOUT and it needs a backend that answers, so it says which
      one it wants instead of depending on a default it is not testing.
    */
    await shellPage.evaluate('window.__sesame.setBackend("sim")');
    await waitFor(
      shellPage.evaluate,
      'window.__sesame.backendId()',
      (v) => v === 'sim',
      `the simulator to be selected at ${window.width}x${window.height}`,
    );
    await waitFor(
      shellPage.evaluate,
      'window.__sesame.worldFrame()?.footContactMm ?? null',
      (v) => typeof v === 'number',
      `the render loop to compute a foot contact at ${window.width}x${window.height}`,
    );
    return shellPage;
  };

  /**
   * Computed font sizes of the same five nodes, in the same open section.
   *
   * "I still cannot read any of the content" is the second complaint this
   * change answers, and the machine-checkable form of it is that nothing in the
   * dock is SMALLER at Medium than at Wide. Below Wide there is one column
   * instead of three and the overlay is wider than the Wide dock, so there is
   * no width argument left for shrinking anything.
   */
  const fontFingerprint = (evaluate) =>
    evaluate(`(() => {
      const of = (sel) => {
        const el = document.querySelector(sel);
        return el === null ? null : parseFloat(getComputedStyle(el).fontSize);
      };
      return {
        'section body': of('[data-dock-section="source"] .dock-section-body'),
        'a line of C++': of('.src-line'),
        'an outline row': of('.source-outline-row'),
        'a file tab': of('.source-tab'),
        'the window note': of('[data-testid="source-window"]'),
      };
    })()`);

  const fonts = {};

  /**
   * Every visible run of text on the page, measured — Phase 4 W1.
   *
   * The brief and the plan both say this explicitly: the floor is checked by
   * reading computed styles in a browser, not by grepping the source. The
   * static check before phase 1 proves no literal survives in the stylesheet;
   * this proves what a reader actually sees, and the two catch different
   * things. A pane could inherit 9px from a parent without a literal anywhere.
   *
   * "Meaningful text" is an element's OWN text — its direct child text nodes —
   * so a paragraph is measured once instead of once per ancestor.
   *
   * ## Two sizes, because one of them is a lie inside a pan/zoom surface
   *
   * `authoredPx` is the computed `font-size`. `screenPx` is that multiplied by
   * the transform actually in force, which is what a reader's eye gets. They
   * differ in exactly one place: React Flow draws the architecture graph
   * through a CSS transform the reader controls, and `fitView` on 63 nodes in a
   * 620px pane lands 14px edge labels on screen at 3-5px.
   *
   * Shrinking that type would not help and enlarging it would not either. So
   * the surface declares itself `[data-zoom-surface]`, the floor is asserted on
   * `authoredPx` inside it and on `screenPx` everywhere else, and the harness
   * RECORDS the worst on-screen size it found there. That number is W4's
   * problem — three representations instead of one shrunk graph — and writing
   * it into the report is what stops this invariant absorbing that debt
   * silently, which is this project's known failure mode.
   */
  const CORRECTNESS_SELECTORS = [
    '.prov',
    '[data-origin-kind]',
    '#prov-banner',
    '.prov-banner p',
    '.trace-row-witness',
    '.trace-witness-key',
    '.lesson-check-status',
    '.lesson-check-summary',
    '.lesson-notbuilt',
    '[data-testid="lesson-control-notbuilt"]',
    '.badge.is-notbuilt',
    /*
      The environment line — Phase 4 W3.

      `SYSTEM: ... · PHYSICAL HARDWARE: NONE` is the brief's answer to
      *"observed" reads to a novice as observed on hardware*, and the plan says
      outright that it may not be truncated and must be visible rather than in a
      legend. Listing it here is what makes that a check: any window where it
      does not fit fails the run, instead of quietly ellipsising the word that
      carries the claim.
    */
    '[data-testid="status-environment"]',
  ];

  const typeScan = (evaluate) =>
    evaluate(`(() => {
      const FLOOR = ${TEXT_FLOOR_PX};
      const out = { below: [], zoomed: [], truncated: [], roles: {}, nodes: 0 };
      const own = (el) => {
        let t = '';
        for (const n of el.childNodes) if (n.nodeType === 3) t += n.nodeValue;
        return t.replace(/\\s+/g, ' ').trim();
      };
      const nameOf = (el) =>
        el.tagName.toLowerCase() +
        (typeof el.className === 'string' && el.className.trim().length > 0
          ? '.' + el.className.trim().split(/\\s+/).join('.')
          : '');
      // The accumulated vertical scale of every transform between this element
      // and the root. Read out of the matrices rather than inferred from
      // getBoundingClientRect()/offsetHeight, which disagree for inline boxes
      // and would report a scale on text nobody transformed.
      const scaleOf = (el) => {
        if (el.ownerSVGElement !== null && el.ownerSVGElement !== undefined && typeof el.getScreenCTM === 'function') {
          const ctm = el.getScreenCTM();
          return ctm === null ? 1 : Math.abs(ctm.d);
        }
        let scale = 1;
        let node = el;
        let guard = 0;
        while (node !== null && node !== document.documentElement && guard < 60) {
          const t = getComputedStyle(node).transform;
          if (t !== 'none' && t !== '') {
            const nums = t.slice(t.indexOf('(') + 1, -1).split(',').map((v) => parseFloat(v));
            if (t.startsWith('matrix3d') && nums.length >= 6) scale *= Math.abs(nums[5]);
            else if (nums.length >= 4) scale *= Math.abs(nums[3]);
          }
          node = node.parentElement;
          guard += 1;
        }
        return scale;
      };
      const smallest = (selector, key) => {
        for (const el of document.querySelectorAll(selector)) {
          const cs = getComputedStyle(el);
          if (cs.display === 'none' || cs.visibility === 'hidden') continue;
          const r = el.getBoundingClientRect();
          if (r.width < 1 || r.height < 1) continue;
          if (own(el).length === 0) continue;
          const px = parseFloat(cs.fontSize);
          if (out.roles[key] === undefined || px < out.roles[key].px) {
            out.roles[key] = { px, sel: selector, text: own(el).slice(0, 40) };
          }
        }
      };

      for (const el of document.querySelectorAll('body *')) {
        const cs = getComputedStyle(el);
        if (cs.display === 'none' || cs.visibility === 'hidden' || cs.opacity === '0') continue;
        const rect = el.getBoundingClientRect();
        if (rect.width < 1 || rect.height < 1) continue;
        const text = own(el);
        if (text.length === 0) continue;
        out.nodes += 1;
        const authoredPx = parseFloat(cs.fontSize);
        const screenPx = authoredPx * scaleOf(el);
        const zoomSurface = el.closest('[data-zoom-surface]');
        const where = zoomSurface === null ? null : zoomSurface.getAttribute('data-zoom-surface');
        if (authoredPx < FLOOR - 0.01) {
          out.below.push({ name: nameOf(el), authoredPx, screenPx, text: text.slice(0, 48), zoomSurface: where });
        } else if (where === null && screenPx < FLOOR - 0.01) {
          out.below.push({ name: nameOf(el), authoredPx, screenPx, text: text.slice(0, 48), zoomSurface: null });
        } else if (where !== null && screenPx < FLOOR - 0.01) {
          out.zoomed.push({ surface: where, name: nameOf(el), authoredPx, screenPx: Math.round(screenPx * 100) / 100, text: text.slice(0, 40) });
        }
      }

      for (const selector of ${JSON.stringify(CORRECTNESS_SELECTORS)}) {
        for (const el of document.querySelectorAll(selector)) {
          const cs = getComputedStyle(el);
          if (cs.display === 'none' || cs.visibility === 'hidden') continue;
          const rect = el.getBoundingClientRect();
          if (rect.width < 1 || rect.height < 1) continue;
          const text = (el.textContent ?? '').replace(/\\s+/g, ' ').trim();
          if (text.length === 0) continue;
          const clamped = cs.webkitLineClamp !== undefined && cs.webkitLineClamp !== '' && cs.webkitLineClamp !== 'none';
          const ellipsised = cs.textOverflow === 'ellipsis';
          const cut = el.scrollWidth > el.clientWidth + 1 || el.scrollHeight > el.clientHeight + 1;
          if (clamped || ellipsised || cut) {
            out.truncated.push({
              selector,
              name: nameOf(el),
              text: text.slice(0, 60),
              ellipsised,
              clamped,
              cut,
              scrollWidth: el.scrollWidth,
              clientWidth: el.clientWidth,
            });
          }
        }
      }

      out.roles.body = { px: parseFloat(getComputedStyle(document.body).fontSize), sel: 'body', text: '' };
      // The graph's viewport transform at the moment of the scan, so a
      // below-floor reading inside a pan surface says WHY rather than only
      // how small. W7 spent a run bisecting exactly this.
      {
        const viewport = document.querySelector('.react-flow__viewport');
        out.viewportTransform = viewport === null ? null : getComputedStyle(viewport).transform;
        const surface = document.querySelector('[data-testid="arch-surface"]');
        out.archMode = surface === null ? null : surface.getAttribute('data-arch-mode');
      }
      smallest('.src-line, .src-text, table.joints td, dl.kv dd, .lab-code, .pose-table td', 'code');
      /*
        .prov-banner p LEFT this list in W7, and that is a decision rather than
        an omission. The paragraph it named — PROVENANCE_MEANING, and the full
        four-line verdict — moved into the "more info" screen; what is on the
        side panel is measurementVerdict()'s CLAIM line, one sentence, at the
        badge token. That is the same shape and the same token as the status
        strip's environment line, which is the other one-line claim this product
        makes, and it is not a reading surface. Lesson prose, source
        descriptions and concept text still are, and they are still measured.
      */
      smallest('.lesson-explanation, .lesson-conceptual, .lesson-goal, .lesson-claim-text, .source-description, .concept-text', 'prose');
      return out;
    })()`);

  /** Everything the scan found, per breakpoint, unioned across the sections. */
  const typeReadings = {};
  const zoomedText = [];

  // --------------------------------------------------- one pass per window
  for (const window of RESPONSIVE_WINDOWS) {
    const where = `${window.width}x${window.height} (${window.breakpoint})`;
    const shellPage = await bootPage(window);
    try {
      /*
       * TWO REGIMES, BOTH MEASURED — §11.2, and this is the whole of it.
       *
       * The reading is taken with NO module active and then with one, because
       * the two stage rules are different rules and the plan is explicit that
       * they may not be averaged into one loose threshold:
       *
       *   no module   the stage keeps >= 50% of the VIEWPORT's area   (area-50)
       *   a module    >= 50% of the CONTENT area — the viewport minus
       *               the rail, the status strip and the side panel  (content-50)
       *
       * The app PUBLISHES which one it is claiming on `.shell`
       * (`data-stage-rule`), exactly as W4 published the focus exemption, and
       * what is asserted below is the declaration against the measurement. A
       * harness that decided the regime for itself would branch on the same
       * condition the layout branches on and could never disagree with it —
       * which is the hollow-assertion failure this project has caught four
       * times.
       */
      // A sleep BEFORE `settledShell`, not instead of it: the settle loop
      // returns as soon as two consecutive readings agree, and two reads taken
      // before React has applied the change agree with each other perfectly.
      await shellPage.evaluate('window.__sesame.setModule(null)');
      await sleep(500);
      const noModule = await settledShell(shellPage, `${where} with no module active`);

      await shellPage.evaluate('window.__sesame.setModule("modules")');
      await sleep(500);
      const archUp = await settledShell(shellPage, `${where} with the architecture module up`);

      await shellPage.evaluate('window.__sesame.setModule("learn")');
      await sleep(500);
      const learnUp = await settledShell(shellPage, `${where} with the Learn module up`);

      check(
        noModule.breakpoint === window.breakpoint,
        `${where} classified itself as "${noModule.breakpoint}"`,
      );

      // The floors §7 keeps as the Compact backstop, at every state.
      for (const [state, reading] of [
        ['no module', noModule],
        ['Architecture up', archUp],
        ['Learn up', learnUp],
      ]) {
        check(
          reading.viewportHeightSharePct >= HEIGHT_FLOOR_PCT,
          `at ${where} with ${state} the 3D canvas is ${reading.canvasHeightPx.toFixed(0)} px ` +
            `of ${reading.windowHeightPx} — ${reading.viewportHeightSharePct.toFixed(1)}% of the ` +
            `window height, below the ${HEIGHT_FLOOR_PCT}% floor. This is the check the old ` +
            `harness did not have, and a 13%-of-screen robot is what its absence cost.`,
        );
        check(
          reading.canvasWidthPx >= WIDTH_FLOOR_PX,
          `at ${where} with ${state} the 3D canvas is only ${reading.canvasWidthPx.toFixed(0)} px ` +
            `wide; the floor is ${WIDTH_FLOOR_PX}`,
        );
      }

      // A thin line, not a strip. 32 px, and it must never grow into one.
      check(
        noModule.statusBarHeightPx > 0 && noModule.statusBarHeightPx <= 40,
        `the status line under the robot is ${noModule.statusBarHeightPx.toFixed(1)} px at ${where}; ` +
          `it replaced a 120-176 px strip and must stay a glance line`,
      );

      if (window.breakpoint !== 'compact') {
        // ------------------------------------ REGIME 1: no module, area-50
        check(
          noModule.stageRule === 'area-50' && noModule.activeModule === null,
          `at ${where} with no module active the shell says its stage rule is ` +
            `${JSON.stringify(noModule.stageRule)} (activeModule ` +
            `${JSON.stringify(noModule.activeModule)}). §7 is unchanged in this regime and the app ` +
            `has to say so.`,
        );
        check(
          noModule.stageAreaSharePct >= STAGE_AREA_FLOOR_PCT,
          `at ${where} with no module active the 3D canvas is ` +
            `${noModule.canvasWidthPx.toFixed(0)}x${noModule.canvasHeightPx.toFixed(0)} = ` +
            `${noModule.stageAreaSharePct.toFixed(1)}% of the window's AREA, below the ` +
            `${STAGE_AREA_FLOOR_PCT}% floor. That floor is the user's own resolution of §3 — ` +
            `"I'd rather the robot area shrink. 50% of the screen area is more than enough".`,
        );

        // --------------------------- REGIME 2: a module up, content-50
        for (const [state, reading] of [
          ['Architecture up', archUp],
          ['Learn up', learnUp],
        ]) {
          check(
            reading.stageRule === 'content-50' && reading.focusPane === null,
            `at ${where} with ${state} the shell says its stage rule is ` +
              `${JSON.stringify(reading.stageRule)} (focusPane ` +
              `${JSON.stringify(reading.focusPane)}). The brief's exemption belongs to the focus ` +
              `workspace and to nothing else; the ordinary layout answers to one of the two ` +
              `published rules at every width.`,
          );
          check(
            reading.stageContentSharePct >= STAGE_CONTENT_FLOOR_PCT - 0.2,
            `at ${where} with ${state} the 3D canvas holds ` +
              `${reading.stageContentSharePct.toFixed(1)}% of the CONTENT area ` +
              `(${reading.contentWidthPx.toFixed(0)}x${reading.contentHeightPx.toFixed(0)}), below ` +
              `the ${STAGE_CONTENT_FLOOR_PCT}% floor. That is §11.2's plain reading of "with the ` +
              `robot in the other half".`,
          );
          // The inverse, adapted from W3 rather than deleted: a share is only
          // honest if the box really moved. W3 asserted the stage LOSES more
          // than 300 px when the workbench opens; the module column is the
          // thing that opens now, and it takes half the content area.
          const lost = noModule.canvasWidthPx - reading.canvasWidthPx;
          check(
            lost > 300,
            `at ${where} activating a module took only ${lost.toFixed(1)} px from the 3D canvas ` +
              `(${noModule.canvasWidthPx.toFixed(1)} -> ${reading.canvasWidthPx.toFixed(1)}). The ` +
              `module column is supposed to be IN FLOW here: if the stage does not shrink, the ` +
              `content-share reading above is measuring a canvas hidden behind a panel, which is ` +
              `exactly the reading §7 retired.`,
          );
        }

        // THE ARITHMETIC, stated as a check rather than as a comment. The
        // content area is the viewport minus the rail, the status strip and the
        // side panel, and every number the two regimes are computed from has to
        // come out of the same three boxes.
        const expectedContent =
          archUp.windowWidthPx - RAIL_W_PX - (archUp.panel.visible ? PANEL_W_PX : 0);
        check(
          Math.abs(archUp.contentWidthPx - expectedContent) <= 1,
          `at ${where} the content box measures ${archUp.contentWidthPx.toFixed(1)} px but ` +
            `${archUp.windowWidthPx} - ${RAIL_W_PX} rail - ${PANEL_W_PX} panel is ` +
            `${expectedContent}. The two stage rules are computed from this box, so a box that is ` +
            `not what it claims makes both of them meaningless.`,
        );
      } else {
        // At Compact the module and the panel are SHEETS: the stage keeps the
        // whole shell and §7's area rule gives way to the floors above.
        check(
          archUp.dockOverlays === true,
          `at ${where} the module reports overlays=${archUp.dockOverlays}. It floats at Compact, ` +
            `where nothing else fits, and is IN FLOW above it — that is the difference the whole ` +
            `regime split is made of.`,
        );
        check(
          Math.abs(noModule.canvasWidthPx - archUp.canvasWidthPx) < 1,
          `at ${where} a sheet took ${(noModule.canvasWidthPx - archUp.canvasWidthPx).toFixed(1)} px ` +
            `from the canvas; a sheet is out of flow and takes nothing`,
        );
        check(
          archUp.moduleColumn.rectWidthPx <= archUp.windowWidthPx * 0.92 + 1,
          `the Compact sheet covers ` +
            `${((archUp.moduleColumn.rectWidthPx / archUp.windowWidthPx) * 100).toFixed(0)}% of the ` +
            `window at ${where} — a sheet that covers everything is a modal, and this is not one`,
        );
      }

      // ================================ ONE ACTIVE MODULE, AT EVERY WIDTH
      //
      // Not "the others were closed": there is nowhere for a second one to be.
      // `ShellState.activeModule` is one nullable id per breakpoint, so the
      // two-open state is unrepresentable — and what a harness can check about
      // an unrepresentable state is that no sequence of the app's own verbs
      // produces one. Every module is activated in turn and the count of
      // laid-out module panes is read each time.
      for (const id of ['modules', 'signal', 'source', 'learn', 'lab']) {
        await shellPage.evaluate(`window.__sesame.setModule(${JSON.stringify(id)})`);
        await sleep(320);
        const reading = await shellPage.evaluate('window.__sesame.shell()');
        check(
          reading.activeModule === id &&
            reading.moduleColumn.laidOutPanes.length === 1 &&
            reading.moduleColumn.laidOutPanes[0] === id,
          `at ${where} activating "${id}" left activeModule=${JSON.stringify(reading.activeModule)} ` +
            `and ${reading.moduleColumn.laidOutPanes.length} laid-out module pane(s) ` +
            `(${JSON.stringify(reading.moduleColumn.laidOutPanes)}). One at a time is §11.3, and ` +
            `it is the state's shape rather than a rule something can forget to apply.`,
        );
        /*
          ORDINARY scrollers, and the qualifier is W2's rather than a loophole
          opened here. A pane owns exactly one ordinary vertical scroller and
          anything else that scrolls must DECLARE itself with
          `data-2d-surface` — the container sweep has always read it that way,
          and this check simply had no declared surface to meet until W8 made
          the Source code region a bounded viewport beside the outline. The
          declared ones are still listed, so a new one cannot appear unnoticed.
        */
        const ordinaryColumnScrollers = reading.moduleColumn.scrollers.filter(
          (name) => !name.endsWith('(2d)'),
        );
        check(
          ordinaryColumnScrollers.length <= 1,
          `at ${where} the "${id}" module column has ${ordinaryColumnScrollers.length} ordinary ` +
            `scrollable box(es): ${JSON.stringify(reading.moduleColumn.scrollers)}. There is one, ` +
            `and it is the column body.`,
        );
      }
      // And no accordion survives anywhere: a two-open state could only come
      // back as a stack of collapsible headers.
      const accordionToggles = await shellPage.evaluate(
        `document.querySelectorAll('.dock-section-toggle, [data-dock-toggle]').length`,
      );
      check(
        accordionToggles === 0,
        `at ${where} the shell rendered ${accordionToggles} accordion toggle(s). The rail's ` +
          `radiogroup is the navigation; a collapsible header beside the open pane is the idiom ` +
          `the brief asked us to stop using and the shape a two-open state would come back in.`,
      );

      // ============== THE SIDE PANEL'S SCROLL RULE, NARROWED — Phase 4 W5
      //
      // §11.4 said *"never its own scrollbar — neither Commands nor Face"*, and
      // W7 delivered it with a fold: cards disappeared in priority order until
      // the content fitted. The user has overridden that:
      //
      // > *"We want to see all the commands where possible and fit the
      // > available space with commands. All other sections should be large
      // > enough that they don't need to change size. Use scrollbars in command
      // > and selected joint only if there isn't enough space to show all
      // > content."*
      //
      // **The old assertion is DELETED rather than relaxed**, because it would
      // otherwise keep passing against a design that no longer holds it — which
      // is the failure mode §7 of the plan names. What replaces it is narrower
      // and is still three claims:
      //
      //   1. no scroller ANYWHERE on the panel outside the two cards that
      //      declare themselves scrollable in the markup;
      //   2. those two scroll only when their own content genuinely exceeds the
      //      box flex gave them — a card that scrolls with room to spare is as
      //      wrong as one that clips;
      //   3. the panel's own box still never overflows. `overflow: hidden` is
      //      still on it, so a positive number here is still content a reader
      //      can neither see nor scroll to.
      await shellPage.evaluate('window.__sesame.setModule("modules")');
      await sleep(400);
      for (const id of ['modules', 'lab', 'source']) {
        await shellPage.evaluate(`window.__sesame.setModule(${JSON.stringify(id)})`);
        await sleep(300);
        const reading = await shellPage.evaluate('window.__sesame.shell()');
        if (!reading.panel.visible) continue;
        check(
          reading.panel.illegalScrollers.length === 0,
          `at ${where} with "${id}" up the side panel has ` +
            `${reading.panel.illegalScrollers.length} scrollable box(es) OUTSIDE the two cards ` +
            `allowed one: ${JSON.stringify(reading.panel.illegalScrollers)}. Commands and Selected ` +
            `joint may scroll when their own content does not fit; the Face and the trust card are ` +
            `sized to their content and never do.`,
        );
        for (const card of reading.panel.scrollableCards) {
          check(
            card.scrolls === card.contentPx > card.boxPx + 1,
            `at ${where} the "${card.id}" card ${card.scrolls ? 'scrolls' : 'does not scroll'} ` +
              `around ${card.contentPx} px of content in a ${card.boxPx} px box. It scrolls when, ` +
              `and only when, the content does not fit.`,
          );
        }
        check(
          reading.panel.overflowPx <= 1,
          `at ${where} with "${id}" up the side panel's content overflows its box by ` +
            `${reading.panel.overflowPx.toFixed(0)} px. It is \`overflow: hidden\`, so this is ` +
            `content a reader cannot reach and cannot scroll to — which is the same lie as a ` +
            `scrollbar, just quieter. Two cards may scroll; the panel itself may not clip.`,
        );
        check(
          Math.abs(reading.panel.rectWidthPx - PANEL_W_PX) <= 1,
          `at ${where} the side panel measures ${reading.panel.rectWidthPx.toFixed(1)} px; §11.4 ` +
            `asks for 280-320 and this shell fixes it at ${PANEL_W_PX}`,
        );
      }

      // ============ CORRECTNESS SURFACES STAY ON THE PANEL — §11.4
      //
      // *"Correctness surfaces may not be demoted into a popover. Provenance,
      // origin, PHYSICAL HARDWARE: NONE, NOT BUILT and CONCEPTUAL badges stay
      // visible on the panel itself. A popover may EXPAND them; it may not be
      // where they first appear."*
      //
      // Read with every "more info" screen CLOSED, because the rule is about
      // what a reader sees without opening anything. `insidePopover` is the
      // failure this exists to catch: the element still exists, it has just
      // stopped being anywhere anybody will meet it.
      {
        if (window.breakpoint === 'compact') {
          await shellPage.evaluate('window.__sesame.setSection("commands", true)');
          await sleep(400);
        }
        const reading = await shellPage.evaluate('window.__sesame.shell()');
        const closed = reading.popovers.every((p) => !p.open);
        check(
          closed && reading.popovers.length >= 3,
          `at ${where} the "more info" screens read ${JSON.stringify(reading.popovers)}; the ` +
            `inventory below is only meaningful with all of them shut`,
        );
        const missing = reading.panel.correctness.filter((c) => !c.visible || c.insidePopover);
        check(
          missing.length === 0,
          `at ${where} ${missing.length} correctness surface(s) are not on the side panel: ` +
            `${missing
              .map((c) => `${c.what} (present=${c.present}, visible=${c.visible}, inPopover=${c.insidePopover})`)
              .join('; ')}. A "minimal panel" brief invites exactly this, and §11.4 forbids it: a ` +
            `popover may expand a correctness surface and may never be where it first appears.`,
        );
        check(
          /PHYSICAL HARDWARE: NONE/.test(
            reading.panel.correctness.find((c) => c.what === 'PHYSICAL HARDWARE')?.text ?? '',
          ),
          `at ${where} the panel's hardware line reads ` +
            `${JSON.stringify(reading.panel.correctness.find((c) => c.what === 'PHYSICAL HARDWARE')?.text)}`,
        );
        /*
          ================= EVERY COMMAND, AT A MINIMAL SIZE — Phase 4 W5

          > *"We want to see all the commands where possible and fit the
          > available space with commands. […] The command buttons should be
          > minimal size like they used to be."*

          Three readings, because the request has three parts and any one of
          them could be the one that regressed. The vocabulary count comes from
          `COMMAND_VOCABULARY` through the DOM rather than from a number here:
          W7's shortlist was four of nineteen, and a check against `>= 5` would
          have passed on a shortlist of five.
        */
        const commandsCard = await shellPage.evaluate(`(() => {
          const card = document.querySelector('[data-panel-card="commands"]');
          const wave = document.querySelector('[data-panel-card="commands"] [data-command="wave"]');
          const rect = wave === null ? null : wave.getBoundingClientRect();
          const panelButtons = document.querySelectorAll('[data-panel-card="commands"] [data-command]');
          const screenButtons = document.querySelectorAll('[data-testid="command-bar-full"] [data-command]');
          return {
            onPanel: panelButtons.length,
            inVocabulary: screenButtons.length,
            wavePx: rect === null ? null : [Math.round(rect.width), Math.round(rect.height)],
            waveFontPx: wave === null ? null : parseFloat(getComputedStyle(wave).fontSize),
          };
        })()`);
        check(
          commandsCard.wavePx !== null &&
            commandsCard.wavePx[0] > 0 &&
            commandsCard.wavePx[1] >= 36 &&
            commandsCard.wavePx[1] <= 44,
          `at ${where} the panel's wave button is ${JSON.stringify(commandsCard.wavePx)}. Minimal ` +
            `means the brief's 36 px fine-pointer target and not much more — it was 56x80 when the ` +
            `elastic card stretched four buttons across a whole panel.`,
        );
        check(
          commandsCard.waveFontPx !== null && commandsCard.waveFontPx >= TEXT_FLOOR_PX,
          `at ${where} the panel's command buttons are set at ${commandsCard.waveFontPx}px. ` +
            `"Minimal" is padding and gap; W1's ${TEXT_FLOOR_PX}px floor is not a thing to spend ` +
            `on density.`,
        );
        /*
          ============ W8: THE FACE AT THE TOP, AND COMMANDS TAKING THE SLACK

          > *"The face should be at the very top. Maximize the height of the
          > commands pane if it fits."*

          Two separate claims, and the second is the one with a mechanism behind
          it. The Commands card is `flex: 1 0 auto` — it may GROW into space
          nothing else wanted and may never shrink — so where the panel has
          slack it is measurably taller than the height its own content needs,
          and where the panel is short it is exactly that height and nothing has
          been crushed. W7's elastic Face card was `0 1 auto`, was crushed to
          10 px, and the crushing did not register at all; growth has no
          equivalent failure mode, which is why the direction matters more than
          the number.
        */
        const cardOrder = reading.panel.cards.map((c) => c.id);
        check(
          cardOrder[0] === 'face',
          `at ${where} the side panel's cards are ${JSON.stringify(cardOrder)}. The face is the ` +
            `surface a reader watches while pressing a command and it was 190 px down the panel; ` +
            `§11.4 is about a correctness surface being ON the panel rather than about which card ` +
            `is first, and every one of them still is.`,
        );
        const elasticCards = reading.panel.cards.filter((c) => c.elastic);
        check(
          elasticCards.length === 1 && elasticCards[0].id === 'commands',
          `at ${where} ${elasticCards.length} card(s) declare themselves elastic: ` +
            `${JSON.stringify(elasticCards.map((c) => c.id))}. Exactly one takes the panel's spare ` +
            `height, and it is Commands.`,
        );
        /*
          ============ THE CARD DOES NOT RESIZE WHEN ITS CONTENT CHANGES — W5

          > *"When it does that, its html container resizes causing everything
          > else to shift position, bouncing up and down."*

          The user reported this alongside the inferred/observed flicker, and
          the two are separate bugs: fixing the flicker removes most occurrences
          and the shift would still happen on a genuine backend switch, or —
          measured here — on the firmware's idle-blink animation, which changes
          the face NAME several times a second.

          **This assertion failed on the build it was written against**, and by
          a lot: at 1440x900 `setFace("happy")` left the Face card 213 px tall
          and `setFace("sleepy")` left it 241, because one extra character
          wrapped a 262 px flex row. The Commands card below went 292 -> 264 and
          its buttons 80 px -> 65. Four names, one of which is the firmware's
          default idle face, and the panel had four different layouts.

          Driven through `setFace` rather than waited for, so it is a
          measurement of the mechanism rather than of whether an animation
          happened to tick during the run — and the names are chosen for LENGTH
          (5, 6 and 9 characters), which is the variable that decides.
        */
        const faceHeights = [];
        for (const faceName of ['happy', 'sleepy', 'surprised', 'idle']) {
          await shellPage.evaluate(`window.__sesame.setFace(${JSON.stringify(faceName)})`);
          await sleep(320);
          faceHeights.push(
            await shellPage.evaluate(`(() => {
              const card = document.querySelector('[data-panel-card="face"]');
              const head = card === null ? null : card.querySelector('.pane__header');
              const commands = document.querySelector('[data-panel-card="commands"]');
              return {
                face: ${JSON.stringify(faceName)},
                cardPx: card === null ? 0 : Math.round(card.getBoundingClientRect().height),
                headPx: head === null ? 0 : Math.round(head.getBoundingClientRect().height),
                commandsTopPx:
                  commands === null ? 0 : Math.round(commands.getBoundingClientRect().top),
              };
            })()`),
          );
        }
        const distinctCard = new Set(faceHeights.map((f) => f.cardPx));
        const distinctTop = new Set(faceHeights.map((f) => f.commandsTopPx));
        check(
          distinctCard.size === 1 && distinctTop.size === 1,
          `at ${where} the Face card took ${distinctCard.size} different height(s) across four ` +
            `face names and the card below it started at ${distinctTop.size} different ` +
            `position(s): ${JSON.stringify(faceHeights)}. A card whose height is a function of ` +
            `live telemetry moves every card under it, several times a second on an animated ` +
            `face — which is the bouncing the user reported.`,
        );

                const scrollableIds = reading.panel.cards.filter((c) => c.scrollable).map((c) => c.id);
        check(
          JSON.stringify(scrollableIds) === JSON.stringify(['commands', 'inspector']),
          `at ${where} the cards that may scroll are ${JSON.stringify(scrollableIds)}. The user ` +
            `named two — "use scrollbars in command and selected joint only" — and the Face and ` +
            `the trust card are not among them at any height.`,
        );
        /*
          The measurement itself: how much of the panel is still unused once
          every card has been laid out. It cannot be negative — that is the
          overflow check above — and where it is large the elastic card should
          have eaten into it rather than leaving the panel with a long empty
          tail. `24rem` caps the growth on purpose, so a very tall panel keeps a
          tail and that is reported rather than asserted away.
        */
        /*
          The tail, and it is a REPORT rather than an assertion now.

          W8 asserted `commandsPx >= commandsContentPx` — "the elastic card may
          only ever grow" — which was the right rule for a card that was
          forbidden a scrollbar and is a false one for a card that has been
          given one. A Commands card 197 px tall around 571 px of content is
          correct behaviour at 2560x900 and would have failed that check. What
          is asserted instead is the conditional above: it scrolls when, and
          only when, it does not fit.
        */
        const panelTail = await shellPage.evaluate(`(() => {
          const inner = document.querySelector('[data-testid="side-panel-inner"]');
          if (inner === null) return null;
          const kids = [...inner.children];
          const last = kids[kids.length - 1];
          if (last === undefined) return null;
          const style = getComputedStyle(inner);
          const bottom =
            inner.getBoundingClientRect().bottom - parseFloat(style.paddingBottom || '0');
          const commands = inner.querySelector('[data-panel-card="commands"]');
          const body = commands === null ? null : commands.querySelector('.command-bar-panel');
          return {
            tailPx: Math.round(bottom - last.getBoundingClientRect().bottom),
            commandsPx: commands === null ? 0 : Math.round(commands.getBoundingClientRect().height),
            commandsContentPx: body === null ? 0 : Math.round(body.scrollHeight),
          };
        })()`);
        check(
          panelTail !== null && panelTail.tailPx >= -1,
          `at ${where} the side panel's last card runs ${JSON.stringify(panelTail)} past the box`,
        );
        panelFolds[window.label] = {
          panelHeightPx: Math.round(reading.panel.rectHeightPx),
          order: cardOrder,
          cards: reading.panel.cards.map((c) => ({ id: c.id, heightPx: Math.round(c.heightPx) })),
          scrollable: reading.panel.scrollableCards,
          illegalScrollers: reading.panel.illegalScrollers,
          overflowPx: reading.panel.overflowPx,
          commandsOnPanel: commandsCard.onPanel,
          commandsInVocabulary: commandsCard.inVocabulary,
          commandButtonPx: commandsCard.wavePx,
          commandsPx: panelTail?.commandsPx ?? null,
          unusedTailPx: panelTail?.tailPx ?? null,
        };
      }

      // ================== A "MORE INFO" SCREEN OPENS, AND CARRIES THE DETAIL
      {
        /*
          Polled, not read once. The side panel FOLDS by measurement after every
          commit, so the frame in which a card's header settles into its final
          position is a frame later than the state that put it there — and a
          hit test taken in that frame reports the box that used to be at those
          coordinates. The loop keeps the LAST answer, so a control that is
          genuinely covered still fails with the same message.
        */
        let opened = { ok: false, why: 'never evaluated' };
        for (let attempt = 0; attempt < 6; attempt += 1) {
          opened = await shellPage.evaluate(`(() => {
            const button = document.querySelector('[data-panel-more="inspector"]');
            if (button === null) return { ok: false, why: 'no [data-panel-more="inspector"] control' };
            const rect = button.getBoundingClientRect();
            if (rect.width < 36 || rect.height < 36) {
              return { ok: false, why: 'the control is ' + Math.round(rect.width) + 'x' + Math.round(rect.height) + ', below 36x36' };
            }
            const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
            if (hit === null || !(hit === button || button.contains(hit))) {
              return {
                ok: false,
                why:
                  'the control is not the topmost element at its own centre; ' +
                  (hit === null ? 'nothing is there' : 'found ' + hit.tagName + '.' + (hit.getAttribute('class') ?? '')),
              };
            }
            button.click();
            return { ok: true };
          })()`);
          if (opened.ok) break;
          await sleep(400);
        }
        check(opened.ok, `at ${where} the inspector's "more info" control: ${opened.why}`);
        await sleep(600);
        const inPopover = await shellPage.evaluate(`(() => {
          const dialog = document.querySelector('[data-popover="inspector"]');
          const table = document.querySelector('[data-popover="inspector"] table.joints');
          const rows = document.querySelectorAll('[data-popover="inspector"] table.joints tbody tr');
          return {
            open: dialog !== null && dialog.open,
            hasTable: table !== null && table.getBoundingClientRect().height > 1,
            rows: rows.length,
          };
        })()`);
        check(
          inPopover.open && inPopover.hasTable && inPopover.rows === 8,
          `at ${where} the inspector screen opened as ${JSON.stringify(inPopover)}; §11.4 names the ` +
            `full seven-column table as the first thing that belongs in one, and there are eight ` +
            `joints`,
        );
        await shellPage.evaluate(
          `document.querySelector('[data-popover-close="inspector"]')?.click()`,
        );
        await sleep(350);
        const afterClose = await shellPage.evaluate('window.__sesame.shell()');
        check(
          afterClose.popovers.every((p) => !p.open),
          `at ${where} a "more info" screen stayed open after Close: ${JSON.stringify(afterClose.popovers)}`,
        );
      }

      // ------------------------------------------- the environment line
      //
      // Not a glance value. The brief's point is that a novice reads "observed"
      // as *observed on hardware*, so the two facts that decide how to read
      // every number on screen are stated in words in the one region that never
      // closes. `PHYSICAL HARDWARE: NONE` is read off the counter, so this also
      // asserts that no event in this session crossed a physical boundary.
      const environment = await shellPage.evaluate(`(() => {
        const el = document.querySelector('[data-testid="status-environment"]');
        if (el === null) return null;
        const rect = el.getBoundingClientRect();
        return {
          text: (el.textContent ?? '').replace(/\\s+/g, ' ').trim(),
          system: el.getAttribute('data-system'),
          physicallyObserved: Number(el.getAttribute('data-physically-observed')),
          widthPx: rect.width,
          cut: el.scrollWidth > el.clientWidth + 1,
          visible: rect.width > 1 && rect.height > 1,
        };
      })()`);
      check(
        environment !== null && environment.visible && !environment.cut,
        `at ${where} the environment line is ${JSON.stringify(environment)}. It must be VISIBLE ` +
          `and whole at every width — the plan calls it a correctness surface and says outright ` +
          `that it may not be truncated and may not live in a legend.`,
      );
      check(
        /^SYSTEM: .+ · PHYSICAL HARDWARE: (NONE|\d+ OBSERVED EVENTS)$/.test(environment?.text ?? ''),
        `at ${where} the environment line reads "${environment?.text}"`,
      );
      check(
        environment?.physicallyObserved === 0 && /PHYSICAL HARDWARE: NONE/.test(environment.text),
        `at ${where} the environment line reports ${environment?.physicallyObserved} physically ` +
          `observed event(s). Every backend this project has produces zero, permanently, and this ` +
          `line reads the counter rather than a constant.`,
      );

      // --------------------------------------------------- the robot is there
      await shellPage.evaluate('window.__sesame.setModule("modules")');
      await sleep(500);
      const pixels = await robotPixelShare(shellPage.evaluate);
      check(
        pixels !== null && pixels.sharePct >= ROBOT_PIXEL_FLOOR_PCT,
        `at ${where} only ${(pixels?.sharePct ?? 0).toFixed(2)}% of the middle of the drawing ` +
          `buffer is non-background — the robot is not visibly drawn`,
      );

      // ------------------------- `wave`, reachable with no module open at all
      await shellPage.evaluate('window.__sesame.setModule(null)');
      await sleep(450);
      const glance = await shellPage.evaluate('window.__sesame.shell()');
      const quickWave = glance.quickCommands.find((c) => c.name === 'wave');
      check(
        quickWave?.reachable === true && quickWave?.enabled === true,
        `at ${where} with no module open, the status line's wave button is ` +
          `${JSON.stringify(quickWave)} — a reader cannot make the robot move without opening ` +
          `something, which is what this check has always been for`,
      );
      check(
        glance.quickCommands.some((c) => c.name === 'stop' && c.reachable),
        `at ${where} there is no reachable stop button on the status line`,
      );
      const quickRan = await shellPage.evaluate(`(() => {
        const button = document.querySelector('[data-quick-command="wave"]');
        if (button === null) return { ok: false, why: 'no quick wave button' };
        button.click();
        return { ok: true };
      })()`);
      check(quickRan.ok, `the status line's wave button did not click at ${where}: ${quickRan.why}`);
      await sleep(900);
      const afterQuick = await shellPage.evaluate('window.__sesame.provenance()');
      check(
        (afterQuick?.totalEvents ?? 0) > 0,
        `clicking the status line's wave button at ${where} produced no telemetry at all`,
      );

      // ------------------------------- §5: the badge, and the auto-reveal
      //
      // Select R4 from the SCENE with a DIFFERENT module up. The architecture
      // module is the one that explains a joint selection, so it must come to
      // the front — and the module the reader was in must go away, because one
      // is active at a time.
      await shellPage.evaluate('window.__sesame.selectJoint(null)');
      await shellPage.evaluate('window.__sesame.setModule("learn")');
      await sleep(350);
      await shellPage.evaluate('window.__sesame.selectJoint("R4")');
      await sleep(600);
      const selected = await shellPage.evaluate('window.__sesame.shell()');
      const modulesSection = selected.sections.find((x) => x.id === 'modules');
      check(
        selected.activeModule === 'modules' && modulesSection?.visible === true,
        `at ${where} selecting R4 in the 3D scene did not bring up the module that highlights it ` +
          `(activeModule=${JSON.stringify(selected.activeModule)}). The app would appear to do ` +
          `nothing, which is the §5 regression this change had to avoid.`,
      );
      // §5.1 from the other side: with the reader in Signal, the selection
      // lands in a module they are NOT looking at and is announced on the rail.
      await shellPage.evaluate('window.__sesame.setModule("signal")');
      await sleep(450);
      const badged = await shellPage.evaluate('window.__sesame.shell()');
      const modulesBadge = badged.sections.find((x) => x.id === 'modules');
      check(
        modulesBadge?.badgeIsSelection === true && modulesBadge?.badge === 'joint.R4',
        `at ${where} the architecture module carries no selection badge on the rail while the ` +
          `reader is in Signal: ${JSON.stringify(modulesBadge)}`,
      );
      check(
        (modulesBadge?.headerText ?? '').includes('R4'),
        `at ${where} the rail's architecture button reads "${modulesBadge?.headerText}" — a reader ` +
          `cannot see that R4 was selected`,
      );
      // A selection is something to read ABOUT, so it must never disturb the
      // side panel: the panel is always there and the inspector glance simply
      // follows the same SelectionState.
      check(
        badged.panel.visible === (window.breakpoint !== 'compact' ? true : badged.panel.visible),
        `at ${where} the side panel changed state because of a selection`,
      );
      await shellPage.evaluate('window.__sesame.selectJoint(null)');

      // ------------------------------------------------- ISSUE-20260823-023
      await shellPage.evaluate('window.__sesame.setModule("modules")');
      await sleep(600);
      const frame = await sweepWorldFrame(shellPage, where);

      // --------------------- ONE scroller in the column, and the Source pane
      await focusSection(shellPage.evaluate, 'source');
      await shellPage.evaluate('window.__sesame.selectSymbol("runWavePose")');
      await sleep(800);
      const opened = await shellPage.evaluate('window.__sesame.shell()');
      fonts[window.label] = await fontFingerprint(shellPage.evaluate);

      const sourceView = await shellPage.evaluate(`(() => {
        const lines = document.querySelectorAll('.src-line').length;
        const note = document.querySelector('[data-testid="source-window"]');
        const text = (note?.textContent ?? '').replace(/\\s+/g, ' ').trim();
        const m = /showing lines (\\d+)[^\\d]+(\\d+) of (\\d+)/.exec(text);
        return {
          lines,
          text,
          from: m === null ? null : Number(m[1]),
          to: m === null ? null : Number(m[2]),
          total: m === null ? null : Number(m[3]),
        };
      })()`);
      check(
        sourceView.from !== null && sourceView.lines === sourceView.to - sourceView.from + 1,
        `at ${where} the source pane rendered ${sourceView.lines} lines but announced ` +
          `"${sourceView.text}". The announcement IS the bound — a cap a reader cannot read is the ` +
          `same class of lie as a wrong line number.`,
      );
      /*
        ONE ORDINARY scroller, and the declared surfaces listed beside it.

        This reading is taken with the SOURCE pane open, which from Phase 4 W8
        is the one pane that can legitimately hold a second scrolling box: at
        720 px of pane and up the code region sits beside the outline as a
        bounded 420 px viewport, and it carries `data-2d-surface="code"` — W2's
        declared exemption, the same one the container sweep has always honoured.
        The marker is in the LIST rather than filtered out of it, so an
        undeclared scroller still fails and a new declared one is still visible
        in the message.
      */
      const openedOrdinary = opened.moduleColumn.scrollers.filter((n) => !n.endsWith('(2d)'));
      check(
        openedOrdinary.length === 1 && openedOrdinary[0] === '[module-body]',
        `at ${where} the module column has ${openedOrdinary.length} ordinary scrollable ` +
          `box(es): ${JSON.stringify(opened.moduleColumn.scrollers)}. There is exactly one, and it ` +
          `is the column body — "I'd rather have to scroll through the pane vertically than tiny ` +
          `content and many scrollbars".`,
      );
      check(
        opened.moduleColumn.laidOutPanes.length === 1 && opened.moduleColumn.laidOutPanes[0] === 'source',
        `at ${where} ${opened.moduleColumn.laidOutPanes.length} module panes have a laid-out box ` +
          `(${JSON.stringify(opened.moduleColumn.laidOutPanes)})`,
      );
      check(
        sourceView.lines <= (window.breakpoint === 'wide' ? 240 : 140),
        `at ${where} the source pane rendered ${sourceView.lines} lines with no scroller of its ` +
          `own; the announced budget is ${window.breakpoint === 'wide' ? 240 : 140}`,
      );

      /*
        ============ THE SOURCE PANE'S TWO ARRANGEMENTS — Phase 4 W8

        > *"the list of items, like 'runDancePose' should be in the left side of
        > the Source pane and minified; the right side should be all the source
        > content, etc. which is presently below it."*

        Measured in the shell a reader actually gets, rather than at a driven
        container width: the module column is `(innerWidth - 344) / 2 - 25`, so
        the pane crosses 720 px between 1760x1000 and 1920x1080 and the
        arrangement a given window gets is a FACT about that window. Recorded
        for every one of them, and photographed at the first window that has it.
      */
      const sourceArrangement = await shellPage.evaluate(`(() => {
        const pane = document.querySelector('[data-pane="source"]');
        const body = pane === null ? null : pane.querySelector('.source-body');
        const outline = pane === null ? null : pane.querySelector('.source-outline');
        const code = pane === null ? null : pane.querySelector('.source-code');
        if (body === null || outline === null || code === null) return null;
        return {
          panePx: pane.clientWidth,
          columns: getComputedStyle(body).gridTemplateColumns.split(/\\s+/).length,
          outlineWidthPx: Math.round(outline.getBoundingClientRect().width),
          outlineHeightPx: Math.round(outline.getBoundingClientRect().height),
          codeWidthPx: Math.round(code.getBoundingClientRect().width),
          codeHeightPx: Math.round(code.getBoundingClientRect().height),
          codeScrolls: code.scrollHeight > code.clientHeight + 1,
          declared2d: code.getAttribute('data-2d-surface'),
        };
      })()`);
      check(
        sourceArrangement !== null &&
          sourceArrangement.columns === (sourceArrangement.panePx >= 720 ? 2 : 1),
        `at ${where} the Source pane is ${sourceArrangement?.panePx} px and laid its regions out in ` +
          `${sourceArrangement?.columns} column(s); the threshold is 720 px of pane`,
      );
      sourceArrangements[window.label] = sourceArrangement;
      if (window.label === 'desktop') {
        shellShots.push(
          await shellPage.shoot(
            'w8-source-outline-beside-code.png',
            `the Source module at ${where}, the first window whose module column reaches 720 px of ` +
              `pane: the symbol outline is a ${sourceArrangement?.outlineWidthPx} px column on the ` +
              `left and the source fills the ${sourceArrangement?.codeWidthPx} px on the right, ` +
              `where both used to be stacked and the outline was a full-width list taller than the ` +
              `code it indexes. Below 720 px of pane they still stack, and the outline is minified ` +
              `into as many columns as it has room for.`,
          ),
        );
      }

      // ============ THE ARCHITECTURE'S OWN BOX, IN THE ORDINARY LAYOUT — W4
      //
      // W4 handed this over as a constraint rather than a suggestion: the full
      // 63-node graph only ever reached its own band inside the focus
      // workspace, because no dock in the old shell was 960 px. The module
      // column is half the content area now, so the band it reaches is a
      // FUNCTION OF THE WINDOW and is worth measuring at each one.
      await focusSection(shellPage.evaluate, 'modules');
      await sleep(600);
      const arch = await shellPage.evaluate('window.__sesame.archGraph()');
      const archShell = await shellPage.evaluate('window.__sesame.shell()');
      const expectedMode =
        (archShell.moduleColumn.surfaceWidthPx ?? 0) >= 960
          ? 'full'
          : (archShell.moduleColumn.surfaceWidthPx ?? 0) >= 720
            ? 'subsystem'
            : 'path';
      check(
        arch.mode === expectedMode,
        `at ${where} the architecture surface is ` +
          `${(archShell.moduleColumn.surfaceWidthPx ?? 0).toFixed(0)} px and the pane mounted ` +
          `"${arch.mode}"; W4's bands are 720 and 960 and put that at "${expectedMode}"`,
      );
      // The boundary this shell's `wide` breakpoint IS: above it the ORDINARY
      // layout holds the whole 63-node map, below it does not.
      if (window.breakpoint === 'wide') {
        check(
          (archShell.moduleColumn.surfaceWidthPx ?? 0) >= 960 && arch.mode === 'full',
          `at ${where} — Wide — the ordinary layout gives the architecture ` +
            `${(archShell.moduleColumn.surfaceWidthPx ?? 0).toFixed(0)} px and mounted ` +
            `"${arch.mode}". Wide's entire meaning in this shell is that the whole 63-node graph ` +
            `fits without the focus workspace; a boundary that does not mean that is a boundary ` +
            `with its justification deleted.`,
        );
      } else {
        check(
          (archShell.moduleColumn.surfaceWidthPx ?? 0) < 960,
          `at ${where} — Medium — the ordinary layout already gives the architecture ` +
            `${(archShell.moduleColumn.surfaceWidthPx ?? 0).toFixed(0)} px, which is the full-graph ` +
            `band. The Wide boundary is then in the wrong place.`,
        );
      }
      /*
        THE SUBSYSTEM'S ZOOM FLOOR, asserted on the published number.
        
        W4 gave the subsystem representation a floor of 1 so that its authored
        size IS its size on screen and the 14 px floor holds with no exemption.
        W7's ordinary layout is the first arrangement that mounts it at a width
        this harness visits, and the first run caught it at **0.929** — 14.4 px
        edge labels drawn at 13.38 px — after a remount at a width React Flow
        had not measured. Reading the transform is what turns "the labels came
        out big enough" into "the property the representation is built on holds".
      */
      if (arch.mode === 'subsystem') {
        check(
          arch.viewportZoom !== null && arch.viewportZoom >= 1 - 1e-6,
          `at ${where} the subsystem graph is drawn at zoom ${arch.viewportZoom}; its floor is 1, ` +
            `which is what makes an authored 14 px label a 14 px label on screen`,
        );
      }
      if (arch.mode === 'path') {
        check(
          arch.viewportZoom === null,
          `at ${where} the causal path has a React Flow viewport (zoom ${arch.viewportZoom}); the ` +
            `path representation is flow text and mounts no canvas at all`,
        );
      }
      const archText = await typeScan(shellPage.evaluate);
      const archWorst = archText.zoomed
        .filter((r) => r.surface === 'architecture')
        .reduce((worst, r) => (worst === null || r.screenPx < worst.screenPx ? r : worst), null);
      archSurfaces.push({
        window: `${window.width}x${window.height}`,
        breakpoint: window.breakpoint,
        contentWidthPx: Math.round(archShell.contentWidthPx),
        moduleWidthPx: Math.round(archShell.moduleColumn.rectWidthPx),
        surfaceWidthPx: Math.round(archShell.moduleColumn.surfaceWidthPx ?? 0),
        mode: arch.mode,
        worstOnScreenPx: archWorst === null ? null : Number(archWorst.screenPx.toFixed(2)),
      });

      // ------------------- THE FLOOR, in every pane, at this window size
      //
      // One pass per pane, because a pane that is not the active module has no
      // laid-out box and text that is never laid out is text this check cannot
      // see. The side panel's three cards are always laid out, so they are
      // covered by every pass.
      {
        const seen = new Map();
        const roles = {};
        for (const section of ['commands', 'modules', 'signal', 'source', 'learn', 'lab']) {
          await focusSection(shellPage.evaluate, section);
          const scan = await typeScan(shellPage.evaluate);
          for (const row of scan.below)
            seen.set(`${row.name}|${row.text}`, {
              ...row,
              section,
              viewportTransform: scan.viewportTransform,
              archMode: scan.archMode,
            });
          for (const row of scan.truncated) seen.set(`T:${row.name}|${row.text}`, { ...row, section, truncation: true });
          for (const row of scan.zoomed) zoomedText.push({ ...row, section, window: where });
          for (const [role, reading] of Object.entries(scan.roles)) {
            if (roles[role] === undefined || reading.px < roles[role].px) roles[role] = { ...reading, section };
          }
        }
        const below = [...seen.values()].filter((r) => r.truncation !== true);
        const truncated = [...seen.values()].filter((r) => r.truncation === true);
        typeReadings[window.breakpoint] = { roles, belowFloor: below.length, truncatedCorrectness: truncated.length };

        check(
          below.length === 0,
          `at ${where}, ${below.length} run(s) of visible text compute below the ${TEXT_FLOOR_PX}px ` +
            `floor: ${below
              .slice(0, 5)
              .map(
                (r) =>
                  `${r.name} ${r.authoredPx.toFixed(1)}px authored / ` +
                  `${r.screenPx.toFixed(2)}px on screen in ${r.section} ("${r.text}")` +
                  (r.archMode === undefined || r.archMode === null
                    ? ''
                    : ` [arch ${r.archMode}, viewport ${r.viewportTransform}]`),
              )
              .join('; ')}. The brief is explicit that this is measured in a browser rather than ` +
            `grepped, and that 9-12px secondary text is "dramatically below" what a 12-year-old ` +
            `can read.`,
        );
        check(
          truncated.length === 0,
          `at ${where}, ${truncated.length} correctness surface(s) are truncated: ${truncated
            .slice(0, 5)
            .map(
              (r) =>
                `${r.name} (${[r.ellipsised ? 'ellipsis' : '', r.clamped ? 'line-clamp' : '', r.cut ? `cut ${r.scrollWidth}>${r.clientWidth}` : ''].filter((x) => x.length > 0).join('+')}) "${r.text}"`,
            )
            .join('; ')}. Raising the type is allowed to break a layout; it is never allowed to ` +
            `hide a provenance badge, an origin, a witness line, a lesson result or a NOT BUILT ` +
            `state.`,
        );

        // The brief's table, at the window it was written for.
        if (window.width === 1440) {
          const at = (role) => roles[role]?.px ?? Number.NaN;
          check(
            at('body') >= TYPE_ROLES.ui.px - 0.01,
            `at 1440x900 the body font is ${at('body').toFixed(2)}px; the brief's default UI size ` +
              `is ${TYPE_ROLES.ui.px}px`,
          );
          check(
            at('code') >= TYPE_ROLES.code.px - 0.01,
            `at 1440x900 the smallest code/telemetry/table text is ${at('code').toFixed(2)}px ` +
              `(${roles.code?.sel}); the brief's floor for it is ${TYPE_ROLES.code.px}px`,
          );
          check(
            at('prose') >= TYPE_ROLES.prose.px - 0.01,
            `at 1440x900 the smallest reading prose is ${at('prose').toFixed(2)}px ` +
              `(${roles.prose?.sel} — "${roles.prose?.text}"); the brief's reading size is ` +
              `${TYPE_ROLES.prose.px}px, and it calls prose a reading surface rather than UI chrome`,
          );
        }
      }

      // ------------------------------------ the active module survives reload
      await shellPage.evaluate('window.__sesame.setModule("source")');
      await sleep(500);
      const beforeReload = await shellPage.evaluate('window.__sesame.shell()');
      await shellPage.evaluate('void location.reload()');
      await sleep(700);
      await waitFor(
        shellPage.evaluate,
        'typeof window.__sesame !== "undefined" && window.__sesame.ready',
        (v) => v === true,
        `the app to come back after a real reload at ${where}`,
        60000,
      );
      /*
        A reload re-runs the default-backend probe, and this page is served by
        the BRIDGE — there is no lab host on its origin, so the app comes back
        on the QEMU default and nothing drives the robot. That is the correct
        product behaviour and phase 1 asserts it; here it is a fact to work
        around rather than to depend on. Without this the ISSUE-20260823-023
        sweep below samples a robot nothing is commanding, and its own vacuity
        guard catches it: "the foot contact varied by only 0.000 mm".
      */
      await shellPage.evaluate('window.__sesame.setBackend("sim")');
      await waitFor(
        shellPage.evaluate,
        'window.__sesame.backendId()',
        (v) => v === 'sim',
        `the simulator to be re-selected after the reload at ${where}`,
      );
      await sleep(600);
      const afterReload = await shellPage.evaluate('window.__sesame.shell()');
      check(
        afterReload.activeModule === beforeReload.activeModule,
        `at ${where} the active module did not survive a real reload: ` +
          `${JSON.stringify(beforeReload.activeModule)} -> ${JSON.stringify(afterReload.activeModule)}`,
      );
      check(
        afterReload.mode === beforeReload.mode,
        `at ${where} the derived mode came back as ${JSON.stringify(afterReload.mode)} rather than ` +
          `${JSON.stringify(beforeReload.mode)}. It is DERIVED from the active module, so it can ` +
          `only disagree if something started storing it separately.`,
      );

      // The capture: the module-first shell as a reader meets it — the robot in
      // one half of the content area, the architecture in the other, and the
      // side panel on the right with no scrollbar of its own.
      await focusSection(shellPage.evaluate, 'modules');
      await sleep(600);
      const shotReading = await shellPage.evaluate('window.__sesame.shell()');
      shellShots.push(
        await shellPage.shoot(
          `u5-shell-${window.label}.png`,
          `the module-first shell at ${where}. The 3D canvas is ` +
            `${shotReading.canvasWidthPx.toFixed(0)}x${shotReading.canvasHeightPx.toFixed(0)} — ` +
            `${shotReading.stageContentSharePct.toFixed(1)}% of the CONTENT area and ` +
            `${shotReading.stageAreaSharePct.toFixed(1)}% of the window, under the ` +
            `"${shotReading.stageRule}" rule the shell publishes. The architecture module has ` +
            `${(shotReading.moduleColumn.surfaceWidthPx ?? 0).toFixed(0)} px of surface and drew ` +
            `its "${arch.mode}" representation; the side panel is ` +
            `${shotReading.panel.rectWidthPx.toFixed(0)} px with ` +
            `${shotReading.panel.illegalScrollers.length} scroller(s) outside the two cards ` +
            `allowed one and ${shotReading.panel.overflowPx.toFixed(0)} px of overflow.` +
            (window.breakpoint === 'compact'
              ? ' At Compact the module and the panel are sheets and the robot keeps the shell.'
              : ''),
        ),
      );

      /*
        THE OTHER REGIME, photographed — §11.2.
        
        `area-50` is half of the resolution and every other capture in this
        sweep is of the half with a module up. A rule with no picture of it is a
        rule a reader has to take on trust, and this one is the DEFAULT state at
        Compact and one click away everywhere else.
      */
      if (window.label === 'laptop') {
        await shellPage.evaluate('window.__sesame.setModule(null)');
        await sleep(900);
        const bare = await settledShell(shellPage, `${where} with no module, for the capture`);
        shellShots.push(
          await shellPage.shoot(
            'w7-shell-no-module.png',
            `the OTHER stage regime at ${where}: with no module active the robot has the whole ` +
              `content area — ${bare.canvasWidthPx.toFixed(0)}x${bare.canvasHeightPx.toFixed(0)}, ` +
              `${bare.stageAreaSharePct.toFixed(1)}% of the WINDOW under the "${bare.stageRule}" ` +
              `rule — and the side panel, the rail and the status strip are the only other things ` +
              `on screen. Clicking a module on the rail moves the shell to "content-50" and gives ` +
              `it half of what is left.`,
          ),
        );
        await shellPage.evaluate('window.__sesame.setModule("modules")');
        await sleep(700);
      }

      // ------------------- ISSUE-20260823-023 ACROSS A MODULE SWITCH
      //
      // The plan says this check becomes *more* load-bearing as the canvas
      // resizes for real, and W7 adds a path W3 did not have: switching module
      // does not resize the canvas (the column keeps its half), but ACTIVATING
      // and CLEARING one takes half the content area away and gives it back.
      // Both are swept.
      let moduleSwitchFrame = null;
      if (window.breakpoint !== 'compact') {
        await shellPage.evaluate('window.__sesame.setModule(null)');
        await sleep(700);
        const cleared = await shellPage.evaluate('window.__sesame.shell()');
        await shellPage.evaluate('window.__sesame.setModule("signal")');
        await sleep(800);
        const reopened = await shellPage.evaluate('window.__sesame.shell()');
        check(
          cleared.canvasWidthPx > reopened.canvasWidthPx + 300,
          `at ${where} clearing and reactivating a module changed the canvas by only ` +
            `${(cleared.canvasWidthPx - reopened.canvasWidthPx).toFixed(0)} px — it is not in flow`,
        );
        await shellPage.evaluate('window.__sesame.setModule("source")');
        await sleep(700);
        moduleSwitchFrame = await sweepWorldFrame(
          shellPage,
          `${where}, across a module clear/activate and a Signal<->Source switch`,
        );
      }

      measured.push({
        window: `${window.width}x${window.height}`,
        breakpoint: noModule.breakpoint,
        u5ViewportHeightSharePct: window.u5SharePct,
        noModule: {
          stageWidthPx: noModule.stageWidthPx,
          canvasWidthPx: noModule.canvasWidthPx,
          canvasHeightPx: noModule.canvasHeightPx,
          viewportHeightSharePct: noModule.viewportHeightSharePct,
          stageAreaSharePct: noModule.stageAreaSharePct,
          stageRule: noModule.stageRule,
        },
        moduleActive: {
          stageWidthPx: archUp.stageWidthPx,
          canvasWidthPx: archUp.canvasWidthPx,
          canvasHeightPx: archUp.canvasHeightPx,
          contentWidthPx: archUp.contentWidthPx,
          moduleWidthPx: archUp.moduleColumn.rectWidthPx,
          surfaceWidthPx: archUp.moduleColumn.surfaceWidthPx,
          stageAreaSharePct: archUp.stageAreaSharePct,
          stageContentSharePct: archUp.stageContentSharePct,
          stageRule: archUp.stageRule,
          scrollers: archUp.moduleColumn.scrollers,
        },
        sidePanel: panelFolds[window.label] ?? null,
        environment: environment?.text ?? null,
        statusBarHeightPx: noModule.statusBarHeightPx,
        statusSegments: noModule.statusSegments,
        stageGivenToModulePx: noModule.stageWidthPx - archUp.stageWidthPx,
        quickCommands: glance.quickCommands,
        sourceLinesRendered: sourceView.lines,
        fontSizesPx: fonts[window.label],
        robotPixels: pixels,
        worldFrame: frame,
        moduleSwitchWorldFrame: moduleSwitchFrame,
        activeModuleSurvivedReload: afterReload.activeModule === beforeReload.activeModule,
      });

      const pageErrors = shellPage.errors();
      check(
        pageErrors.length === 0,
        `the page logged ${pageErrors.length} error(s) at ${where}: ${pageErrors.slice(0, 3).join(' | ')}`,
      );
    } finally {
      shellPage.close();
      await sleep(400);
    }
  }

  // --------------------------------------------------------- legibility
  //
  // "Everything is too small ... I still cannot read any of the content." The
  // machine-checkable form, restated for Phase 4 W1.
  //
  // U6 asserted that the same five nodes are not smaller at Medium or Compact
  // than at WIDE. That comparison no longer says what it was written to say:
  // the type scale is now fluid UPWARD, so a 2560 px desktop legitimately reads
  // 17px body against 1440's 16px, and asserting parity with Wide would mean
  // asserting that a bigger screen may not use its width. The rule the
  // complaint actually deserves is that a NARROWER window never shrinks
  // anything, so the reference is the laptop the brief was written for, and
  // Wide is checked separately in the other direction.
  const LAPTOP = 'laptop';
  for (const narrow of ['compact', 'laptop-small']) {
    const here = fonts[narrow] ?? {};
    const laptop = fonts[LAPTOP] ?? {};
    for (const [what, size] of Object.entries(here)) {
      const reference = laptop[what];
      if (typeof size !== 'number' || typeof reference !== 'number') continue;
      check(
        size >= reference - 0.01,
        `${what} is ${size.toFixed(1)} px at ${narrow} but ${reference.toFixed(1)} px at 1440x900. ` +
          `Below Wide the dock has ONE column instead of three and a wider overlay, so nothing has ` +
          `any reason to be smaller there — and "I cannot read the content" is what happens when ` +
          `it is.`,
      );
    }
  }
  for (const [what, size] of Object.entries(fonts['desktop-wide'] ?? {})) {
    const reference = fonts[LAPTOP]?.[what];
    if (typeof size !== 'number' || typeof reference !== 'number') continue;
    check(
      size >= reference - 0.01,
      `${what} is ${size.toFixed(1)} px at 2560x1440 but ${reference.toFixed(1)} px at 1440x900 — ` +
        `clamp() is allowed to grow the scale on a wider screen and never to shrink it`,
    );
  }

  // And the three role floors, at every window. Every clamp() minimum IS the
  // 1440x900 value, so this can only fail if something reintroduces a rule that
  // sets a size — which the static check before phase 1 also forbids outright.
  // Two independent checks on the same product rule: "no compact mode as a
  // default" is an invariant, not a preference.
  for (const role of ['ui', 'code', 'prose']) {
    const floor = TYPE_ROLES[role].px;
    for (const [bp, reading] of Object.entries(typeReadings)) {
      const px = reading.roles[role === 'ui' ? 'body' : role]?.px;
      if (typeof px !== 'number') continue;
      check(
        px >= floor - 0.01,
        `${role} text is ${px.toFixed(2)}px at ${bp}; its floor is ${floor}px at every window size`,
      );
    }
  }

  if (zoomedText.length > 0) {
    const worst = zoomedText.reduce((a, b) => (a.screenPx <= b.screenPx ? a : b));
    notes.push(
      `the architecture graph draws ${zoomedText.length} run(s) of text below the ${TEXT_FLOOR_PX}px ` +
        `floor ON SCREEN, at as little as ${worst.screenPx}px ("${worst.text}"), because React ` +
        `Flow's fitView zooms 63 nodes into a dock-width pane. The type inside it is authored at ` +
        `${worst.authoredPx}px and the reader can zoom; the map not fitting the pane is W4's ` +
        `three-representation split, not a type-size problem, and W1 deliberately did not disguise ` +
        `it by shrinking anything else.`,
    );
  }

  // ======================================================================
  // CONTAINER, NOT VIEWPORT — Phase 4 W2
  // ======================================================================
  //
  // The brief asks for the two axes to be tested INDEPENDENTLY, and that is not
  // a stylistic preference — it is the only way to catch the failure this
  // workstream exists to remove. A pane whose internals are decided by
  // `@media (max-width: 1440px)` renders one way in a 1440 px window and
  // another in a 1441 px window **at the same pane width**, which is the
  // definition of viewport logic leaking into a pane.
  //
  // So each pane is driven to explicit container widths — the brief's own list,
  // with the values immediately either side of both boundaries, because
  // "519/520 matters more than 480/768" — and the same sweep is run in a 1280 px
  // window and a 2560 px one. Two claims come out of it:
  //
  //   1. the representation changes AT the documented thresholds, measured
  //      against the container's own content box, which is what `@container`
  //      evaluates;
  //   2. the two windows produce IDENTICAL readings at every width. If they did
  //      not, something in a pane would still be asking the wrong question.
  //
  // The width is set on the pane element directly rather than by resizing a
  // dock, because a dock cannot reach 960 px and the point is to test the
  // mechanism rather than today's geometry. The widths a reader can actually
  // produce are covered by the dock-resize sweep earlier in this phase, which
  // drives `setDockWidth` to 320 and 560 and re-checks ISSUE-20260823-023's
  // world frame across each one.
  {
    // The brief's component-harness widths. 519/522 and 719/722 straddle the
    // two thresholds: the pane carries a 1 px border on each side, so a 522 px
    // box is a 520 px container.
    const CONTAINER_WIDTHS = [320, 360, 480, 519, 522, 719, 722, 776, 960, 1016, 1200];
    const NARROW_PX = 520;
    const WIDE_PX = 720;
    const MEASURE_MIN_CH = 45;
    const MEASURE_MAX_CH = 75;
    /*
     * W4's thresholds, on the ARCHITECTURE SURFACE rather than on the pane.
     *
     * The two extra container widths above (776 and 1016) exist because the
     * surface is about 56 px narrower than the pane it sits in, so a pane
     * driven to 720 or 960 lands the artifact on the wrong side of its own
     * boundary. 776 and 1016 are the pane widths that put the SURFACE at
     * exactly 720 and 960 in this layout, and asserting the boundary means
     * standing on it rather than near it.
     */
    const ARCH_SUBSYSTEM_PX = 720;
    const ARCH_FULL_PX = 960;
    const ARCH_SUBSYSTEM_MAX_NODES = 18;
    /** Recorded, never asserted away: the one representation still below 14px. */
    const archFullZoomDebt = [];

    /**
     * Drive one pane through every width and read what changed.
     *
     * Everything measured here is a COMPUTED style or a rendered box. Nothing
     * is read out of the stylesheet, and nothing is inferred from the window,
     * which is the whole point: the two runs must be able to disagree.
     */
    const sweepPane = (evaluate, paneId) =>
      evaluate(`(async () => {
        const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
        const id = ${JSON.stringify(paneId)};
        /*
          "joints" is the seven-column table, which W7 moved into the
          inspector's "more info" screen — so the sweep opens that screen. The
          table is still a PANE (.pane[data-pane=joints]) precisely so this
          keeps testing the container query W2 built for it: a mechanism that
          stopped being exercised because its pane moved is a mechanism that
          has quietly stopped working.
        */
        if (id === 'joints') {
          document.querySelector('[data-panel-more="inspector"]')?.click();
          await sleep(500);
        } else {
          window.__sesame.setModule(id);
        }
        await sleep(500);
        if (id === 'learn') {
          document.querySelector('[data-testid="lesson-card-meet-sesame"]')?.click();
          await sleep(600);
        }
        const pane = document.querySelector('[data-pane="' + id + '"]');
        if (pane === null) return null;

        // One character of THIS element's font, measured rather than assumed:
        // \`ch\` is the advance of "0" and depends on the family the reader's
        // system resolved, not on the px size alone.
        const chOf = (el) => {
          const cs = getComputedStyle(el);
          const probe = document.createElement('span');
          probe.style.cssText = 'position:absolute;visibility:hidden;white-space:pre;left:-9999px';
          probe.style.fontFamily = cs.fontFamily;
          probe.style.fontSize = cs.fontSize;
          probe.style.fontWeight = cs.fontWeight;
          probe.textContent = '0'.repeat(100);
          document.body.appendChild(probe);
          const w = probe.getBoundingClientRect().width / 100;
          probe.remove();
          return w;
        };
        const FORM = new Set(['TEXTAREA', 'INPUT', 'SELECT']);
        const describe = (el) => {
          const testid = el.getAttribute('data-testid');
          const name = testid !== null ? '[' + testid + ']'
            : '.' + ((el.getAttribute('class') || '').split(/\\s+/)[0] || el.tagName.toLowerCase());
          return name + (el.hasAttribute('data-2d-surface') ? '(2d)' : '');
        };
        const isScroller = (el) => {
          if (FORM.has(el.tagName)) return false;
          if (el.scrollHeight <= el.clientHeight + 1) return false;
          const o = getComputedStyle(el).overflowY;
          return o === 'auto' || o === 'scroll';
        };

        const readings = {};
        for (const w of ${JSON.stringify(CONTAINER_WIDTHS)}) {
          pane.style.width = w + 'px';
          // Modules gets longer: a width change here can MOUNT or UNMOUNT React
          // Flow, which is a ResizeObserver callback, a React commit and the
          // library's own measuring pass rather than a repaint.
          await sleep(id === 'modules' ? 520 : 180);
          // The container's own content box. \`clientWidth\` excludes the border,
          // which is exactly what a container query measures.
          const containerPx = pane.clientWidth;
          // Two buckets on purpose. \`representation\` is what the pane DECIDED -
          // discrete, and required to be identical at a given container width in
          // every window. \`measured\` is what came out of it in pixels and
          // characters, which may legitimately differ between windows because the
          // type scale is fluid ABOVE 1440 (W1: floored downward, fluid upward),
          // so one character of 17px prose at 1280 is 9.16px and one character of
          // 18px prose at 2560 is 9.69. The measure in \`ch\` therefore differs
          // while the box does not, and asserting otherwise would assert that a
          // bigger screen may not use its width.
          const signature = {};
          const measured = {};

          const kv = pane.querySelector('dl.kv');
          if (kv !== null) {
            signature.kvTracks = getComputedStyle(kv).gridTemplateColumns.split(/\\s+/).length;
          }
          const table = pane.querySelector('table.joints');
          if (table !== null) {
            signature.jointsDisplay = getComputedStyle(table).display;
            const label = table.querySelector('tbody td .cell-label');
            signature.jointLabelDisplay = label === null ? null : getComputedStyle(label).display;
            const head = table.querySelector('thead');
            signature.jointHeadDisplay = head === null ? null : getComputedStyle(head).display;
            /*
              W5 SETTLES THE TRADE W2 RECORDED AND DID NOT DECIDE, and these
              four readings are what settles it rather than a screenshot.

              W2 built the record band and noted, without deciding, that it had
              bought "every column kept" with "no column left to scan". The
              record is a GROUPED three-line row now, so:

                jointRowDisplay    what the record actually is - 'grid' below the
                                   threshold, 'table-row' above it
                jointCellsLaidOut  how many of the seven columns have a box. It
                                   is 7 in BOTH bands or the pane dropped one,
                                   which is the rule this pane is named after
                jointColumnLefts   the number of distinct left edges among the
                                   eight 'commanded' cells. One, or joints cannot
                                   be compared down a column, which is the half
                                   of the trade W2 gave up
                jointScopesLaidOut the column-scope notes ('inferred',
                                   'no sensor', 'of commanded' twice) that say
                                   what each correctness column is ABOUT. Four in
                                   the table band, four per joint in the record
                                   band, and never zero.
            */
            const tr = table.querySelector('tbody tr');
            signature.jointRowDisplay = tr === null ? null : getComputedStyle(tr).display;
            signature.jointCellsLaidOut =
              tr === null
                ? null
                : [...tr.querySelectorAll('td')].filter((td) => {
                    const b = td.getBoundingClientRect();
                    return b.width > 0 && b.height > 0;
                  }).length;
            signature.jointColumnLefts = new Set(
              [...table.querySelectorAll('tbody td[data-column="commanded"]')].map((td) =>
                Math.round(td.getBoundingClientRect().left),
              ),
            ).size;
            signature.jointScopesLaidOut = [...table.querySelectorAll('.col-scope')].filter((el) => {
              const b = el.getBoundingClientRect();
              return b.width > 0 && b.height > 0;
            }).length;
          }

          /*
            SIGNAL - Phase 4 W5. "A sequence, not a collection of cards."

            The row is a LANE inside a numbered step now, so the two readings W2
            took ('.trace-row''s 'display', and '.trace-row-head''s 'flex-wrap')
            are gone: one named an element that no longer exists, and the other
            would have gone on passing while reading 'grid' in all three bands.
            Both are replaced by a reading of the thing that actually changes
            with width - how many tracks a lane has - plus the four properties
            the brief states as requirements rather than as preferences.
          */
          const laneRow = pane.querySelector('.trace-row');
          if (laneRow !== null) {
            const lanes = [...pane.querySelectorAll('.trace-row')];
            const steps = [...pane.querySelectorAll('.trace-step')];
            const columns = pane.querySelector('.trace-columns');

            // The brief's three shapes, as the one number that separates them:
            // a record (1 track), a two-line row (2), aligned columns (3).
            signature.traceLaneTracks =
              getComputedStyle(laneRow).gridTemplateColumns.split(/\\s+/).length;
            signature.traceColumnsDisplay =
              columns === null ? null : getComputedStyle(columns).display;

            // The ladder itself: steps numbered 1..N with no gaps, in
            // non-decreasing causal rank.
            const stepNos = steps.map((el) => Number(el.getAttribute('data-step')));
            const stepRanks = steps.map((el) => Number(el.getAttribute('data-rank')));
            /*
              The COUNTS go in 'measured', not in 'signature'. Signature is
              compared byte-for-byte between a 1280 window and a 2560 one, and
              how many events a replay has delivered by the time a pane is read
              is a property of the run rather than of the pane. What belongs in
              the identity comparison is the SHAPE, and that is everything else
              here.
            */
            measured.traceSteps = steps.length;
            measured.traceLanes = lanes.length;
            signature.traceStepsNumbered = stepNos.every((n, i) => n === i + 1);
            signature.traceStepsOrdered = stepRanks.every(
              (r, i) => i === 0 || stepRanks[i - 1] <= r,
            );
            /* Every lane belongs to a step, and no lane is orphaned. */
            signature.traceLanesInSteps = lanes.every((el) => el.closest('.trace-step') !== null);

            /*
              THE SIX FIELDS THE BRIEF SAYS MUST SURVIVE AT EVERY WIDTH:
              step/layer, event name, primary value, provenance, origin and the
              COMPLETE witness sentence. Counted as lanes that are missing one,
              so the reading is 0 or it says how many are broken.
            */
            signature.traceLanesMissingAField = lanes.filter((el) => {
              const boxed = (node) => {
                if (node === null || node === undefined) return false;
                const b = node.getBoundingClientRect();
                return b.width > 0 && b.height > 0;
              };
              const step = el.closest('.trace-step');
              const witness =
                el.querySelector('.trace-row-witness') ??
                (step === null ? null : step.querySelector(':scope > .trace-row-witness'));
              return !(
                boxed(step === null ? null : step.querySelector('.trace-step-no')) &&
                boxed(step === null ? null : step.querySelector('.trace-layer')) &&
                boxed(el.querySelector('[data-field="event"]')) &&
                boxed(el.querySelector('[data-field="value"]')) &&
                boxed(el.querySelector('.trace-badge')) &&
                boxed(el.querySelector('[data-origin-kind]')) &&
                boxed(witness)
              );
            }).length;

            /*
              ...and the witness is never truncated to keep the geometry, which
              the brief calls out by name. Measured as a box that cannot show its
              own content, not as a CSS property: '-webkit-line-clamp' and a
              fixed height both truncate without 'text-overflow' ever being set.
            */
            signature.traceWitnessesClipped = [
              ...pane.querySelectorAll('.trace-row-witness'),
            ].filter(
              (el) => el.scrollHeight > el.clientHeight + 1 || el.scrollWidth > el.clientWidth + 1,
            ).length;

            /*
              The hoist: a witness repeated verbatim across a step's lanes is
              drawn once. Reported as the count of witness elements against the
              count of lanes - 15 against 36 for a wave - so the two being equal
              would mean the grouping had quietly stopped working.
            */
            measured.traceWitnessElements = pane.querySelectorAll('.trace-row-witness').length;

            /*
              And the column head sits over the fields it names. Distinct left
              edges of every lane's 'says' field plus the head's, which is 1 or
              the header is naming a track it does not actually share.
            */
            if (columns !== null && getComputedStyle(columns).display !== 'none') {
              const headCell = columns.querySelector('[data-col="says"]');
              const lefts = new Set(
                [...pane.querySelectorAll('[data-field="says"]')].map((el) =>
                  Math.round(el.getBoundingClientRect().left),
                ),
              );
              if (headCell !== null) lefts.add(Math.round(headCell.getBoundingClientRect().left));
              signature.traceSaysLefts = lefts.size;
            } else {
              signature.traceSaysLefts = null;
            }
          }
          const step = pane.querySelector('.lesson-step');
          if (step !== null) signature.lessonStepDisplay = getComputedStyle(step).display;
          /*
            SOURCE — Phase 4 W8. "Does this pane have room for the outline
            beside the code?"

            Three readings, because the arrangement is three decisions and any
            one of them could be the one that regressed: how many column tracks
            the three regions are laid out in, whether the code region is a
            bounded viewport or takes its content height, and how many columns
            the minified outline itself folds into. The last is intrinsic
            (\`repeat(auto-fill, minmax(11rem, 1fr))\`) rather than keyed to a
            threshold, which is why it can be read at every width without adding
            a third number for the static check to reject.
          */
          const sourceBody = pane.querySelector('.source-body');
          if (sourceBody !== null) {
            signature.sourceBodyColumns =
              getComputedStyle(sourceBody).gridTemplateColumns.split(/\\s+/).length;
            const codeBox = pane.querySelector('.source-code');
            signature.sourceCodeOverflowY =
              codeBox === null ? null : getComputedStyle(codeBox).overflowY;
            signature.sourceCodeIs2d = codeBox !== null && codeBox.hasAttribute('data-2d-surface');
            /*
              W5's Source item, which is a VERIFICATION rather than a change.

              > *"Keep code unwrapped by default and allow horizontal scrolling.
              > Do not solve the problem with a narrower or smaller font."*

              The whole of C10 reduces to one computed value on the painted
              line, and it is the one a future "responsive fix" would reach for
              first: 'pre-wrap' at a narrow container would reflow 96-column C++
              into prose and change what the line numbers mean. Read at every
              swept width so the claim is that it holds at all of them, not that
              it holds at the one the screenshot was taken at.
            */
            const srcLine = pane.querySelector('.src-line');
            signature.sourceLineWhiteSpace =
              srcLine === null ? null : getComputedStyle(srcLine).whiteSpace;
            const outlineBox = pane.querySelector('.source-outline');
            signature.sourceOutlineColumns =
              outlineBox === null
                ? null
                : getComputedStyle(outlineBox).gridTemplateColumns.split(/\\s+/).length;
            signature.sourceOutlineWidthPx =
              outlineBox === null ? null : Math.round(outlineBox.getBoundingClientRect().width);
          }
          const prose = pane.querySelector('.lesson-explanation');
          if (prose !== null) {
            const ch = chOf(prose);
            measured.proseCh = Math.round((prose.getBoundingClientRect().width / ch) * 10) / 10;
            measured.proseChPx = Math.round(ch * 100) / 100;
          }
          /*
            W4 moved these from ".arch-canvas" to ".arch-surface", and the move
            is the finding rather than a refactor: below 720 px there IS no
            canvas, because the artifact is ordinary flow text. Reading the band
            off a box that only exists in two of the three representations would
            have made every assertion below skip silently in the third — which
            is precisely the hollow-assertion failure this project has hit.
          */
          const surface = pane.querySelector('.arch-surface');
          if (surface !== null) {
            signature.archBand = surface.getAttribute('data-pane-band');
            signature.archMode = surface.getAttribute('data-arch-mode');
            signature.archSurfacePx = surface.clientWidth;
            signature.archCanvasMounted = pane.querySelectorAll('.arch-canvas').length;
            signature.archBackgroundMounted = pane.querySelectorAll('.react-flow__background').length;
            signature.archFlowNodes = pane.querySelectorAll('[data-arch-node]').length;
            /*
              The point of the whole workstream, measured where it is claimed.

              Every run of text inside the architecture panel, multiplied by the
              transform actually in force. In "path" there is no transform at
              all and in "subsystem" the zoom floor is 1, so in both of those
              this number must clear the 14 px floor with no exemption. "full"
              is the one that still cannot, and it is the only one still
              carrying "data-zoom-surface".
            */
            const scaleOf = (el) => {
              let scale = 1;
              let node = el;
              let guard = 0;
              while (node !== null && node !== document.documentElement && guard < 60) {
                const t = getComputedStyle(node).transform;
                if (t !== 'none' && t !== '') {
                  const nums = t.slice(t.indexOf('(') + 1, -1).split(',').map(Number);
                  if (t.startsWith('matrix3d') && nums.length >= 6) scale *= Math.abs(nums[5]);
                  else if (nums.length >= 4) scale *= Math.abs(nums[3]);
                }
                node = node.parentElement;
                guard += 1;
              }
              return scale;
            };
            let worst = null;
            for (const el of pane.querySelectorAll('[data-testid="architecture-graph"] *')) {
              const cs = getComputedStyle(el);
              if (cs.display === 'none' || cs.visibility === 'hidden') continue;
              let own = '';
              for (const n of el.childNodes) if (n.nodeType === 3) own += n.nodeValue;
              if (own.trim().length === 0) continue;
              const box = el.getBoundingClientRect();
              if (box.width < 1 || box.height < 1) continue;
              const px = Math.round(parseFloat(cs.fontSize) * scaleOf(el) * 100) / 100;
              if (worst === null || px < worst.px) worst = { px, text: own.trim().slice(0, 30) };
            }
            signature.archZoomSurfaces = pane.querySelectorAll('[data-zoom-surface]').length;
            measured.archWorstOnScreenPx = worst === null ? null : worst.px;
            measured.archWorstText = worst === null ? null : worst.text;
          }

          readings[w] = {
            containerPx,
            signature,
            measured,
            scrollers: [pane, ...pane.querySelectorAll('*')].filter(isScroller).map(describe),
          };
        }
        pane.style.width = '';
        await sleep(200);
        return readings;
      })()`);

    /*
      `source` joined the sweep in Phase 4 W8, because W8 gave it its first
      container-driven arrangement. Everything else here is W2's.
    */
    const PANES = ['joints', 'signal', 'learn', 'modules', 'source'];
    const sweeps = {};
    for (const window12 of [
      { label: '1280x800', width: 1280, height: 800 },
      { label: '2560x1440', width: 2560, height: 1440 },
    ]) {
      const cqPage = await bootPage({ width: window12.width, height: window12.height });
      try {
        // A trace has to exist before Signal has rows to lay out.
        await cqPage.evaluate('window.__sesame.run("wave")');
        await sleep(2600);
        sweeps[window12.label] = {};
        for (const paneId of PANES) {
          sweeps[window12.label][paneId] = await sweepPane(cqPage.evaluate, paneId);
        }
      } finally {
        cqPage.close();
        await sleep(400);
      }
    }

    // ------------------------------------------------ 1. the thresholds hold
    const proseNotes = [];
    for (const [label, byPane] of Object.entries(sweeps)) {
      for (const [paneId, readings] of Object.entries(byPane)) {
        if (readings === null) {
          problems.push(`the ${paneId} pane was not on the page at ${label}`);
          continue;
        }
        for (const [asked, reading] of Object.entries(readings)) {
          const px = reading.containerPx;
          const where = `${paneId} at a ${px} px container (asked for ${asked}) in a ${label} window`;
          const narrow = px < NARROW_PX;
          const wide = px >= WIDE_PX;
          const s = reading.signature;
          /* The counts, which are deliberately outside the identity comparison. */
          const m = reading.measured;

          if (s.jointsDisplay !== undefined) {
            check(
              s.jointsDisplay === (narrow ? 'block' : 'table'),
              `${where}: the joint inspector renders as "${s.jointsDisplay}". Below ${NARROW_PX} px ` +
                `of pane it is grouped joint records and above it is a table — seven columns, two ` +
                `of them correctness surfaces, do not fit in 35 px each.`,
            );
            check(
              s.jointLabelDisplay === (narrow ? 'block' : 'none') &&
                s.jointHeadDisplay === (narrow ? 'none' : 'table-header-group'),
              `${where}: the joint cells' labels and the table head are ` +
                `${JSON.stringify([s.jointLabelDisplay, s.jointHeadDisplay])}. Exactly one of the two ` +
                `carries the column names in each band; both or neither is an accessibility defect.`,
            );

            // =============== W5: GROUPING, AND THE ALIGNMENT IT PAID FOR
            check(
              s.jointRowDisplay === (narrow ? 'grid' : 'table-row'),
              `${where}: a joint record renders as "${s.jointRowDisplay}". Below the threshold it ` +
                `is a three-line GRID - identity, the three numbers, then the two badges - and not ` +
                `the seven-line stack W2 left here, which kept every field and lost every column.`,
            );
            check(
              s.jointCellsLaidOut === 7,
              `${where}: ${s.jointCellsLaidOut} of the seven joint columns have a box. "Change ` +
                `grouping before you drop columns" is the rule for this pane, and this is the half ` +
                `of it that can be counted.`,
            );
            check(
              s.jointColumnLefts === 1,
              `${where}: the eight joints' \`commanded\` cells start at ${s.jointColumnLefts} ` +
                `different left edges. One, or a reader cannot run their eye down a column - which ` +
                `is the thing the record band gave up before W5 and the reason it is grouped.`,
            );
            check(
              s.jointScopesLaidOut >= 4,
              `${where}: ${s.jointScopesLaidOut} column-scope note(s) are on screen. Every one of ` +
                `\`simulated\`, \`measured\`, \`prov\` and \`origin\` says what it is about - ` +
                `"the learner should never have to infer whether provenance belongs to the joint, ` +
                `the row, or one numerical datum".`,
            );
          }
          if (s.traceLaneTracks !== undefined) {
            // ==================================== W5: SIGNAL IS A SEQUENCE
            //
            // > *"Signal should become a sequence, not a collection of
            // > unrelated cards. The ordering and common fields are part of the
            // > trace's meaning."*
            //
            // The brief's three shapes at the two thresholds this stylesheet is
            // allowed, as the one number that separates them.
            const expectedTracks = wide ? 3 : narrow ? 1 : 2;
            check(
              s.traceLaneTracks === expectedTracks,
              `${where}: a Signal lane has ${s.traceLaneTracks} column track(s); the brief's shapes ` +
                `are a trace-step RECORD below ${NARROW_PX} px (1), a two-line row to ${WIDE_PX} ` +
                `(2), and aligned columns above it (3).`,
            );
            check(
              s.traceColumnsDisplay === (wide ? 'grid' : 'none'),
              `${where}: the column head is "${s.traceColumnsDisplay}". It names three tracks, so ` +
                `it is laid out exactly where the lane has three - naming a column over a stacked ` +
                `record is a label for something that is not there.`,
            );

            // THE LADDER. Numbered 1..N with no gaps and in non-decreasing
            // causal rank, which is the whole claim the numbers make.
            check(
              s.traceStepsNumbered === true && s.traceStepsOrdered === true,
              `${where}: the ${m.traceSteps} steps are numbered ` +
                `${s.traceStepsNumbered ? 'consecutively' : 'WITH A GAP'} and ordered ` +
                `${s.traceStepsOrdered ? 'causally' : 'OUT OF CAUSAL RANK'}. A number a reader can ` +
                `count on is the difference between a sequence and a pile.`,
            );
            check(
              s.traceLanesInSteps === true && m.traceLanes >= m.traceSteps,
              `${where}: ${m.traceLanes} lane(s) across ${m.traceSteps} step(s), and ` +
                `${s.traceLanesInSteps ? 'all' : 'NOT all'} of them are inside a step. A lane with ` +
                `no rung is the card this workstream removed.`,
            );

            // NOTHING WAS DROPPED TO ACHIEVE IT. The brief's own list of fields
            // that must survive at every width, at every width.
            check(
              s.traceLanesMissingAField === 0,
              `${where}: ${s.traceLanesMissingAField} of ${m.traceLanes} lanes are missing one of ` +
                `the six fields the brief requires at EVERY width - step/layer, event, value, ` +
                `provenance, origin, and a complete witness.`,
            );
            check(
              s.traceWitnessesClipped === 0,
              `${where}: ${s.traceWitnessesClipped} witness sentence(s) cannot show their own ` +
                `content. "Never truncate witness text just to retain table geometry" is the one ` +
                `thing the brief says about this pane in bold.`,
            );

            // ...and the grouping is doing the work it was added for. A wave
            // renders 36 lanes and 15 witnesses; 36 witnesses would mean the
            // hoist had stopped.
            check(
              m.traceWitnessElements <= m.traceLanes,
              `${where}: ${m.traceWitnessElements} witness element(s) for ${m.traceLanes} lane(s). ` +
                `A witness repeated verbatim across a step is drawn once.`,
            );

            if (wide) {
              check(
                s.traceSaysLefts === 1,
                `${where}: the provenance column has ${s.traceSaysLefts} distinct left edge(s) ` +
                  `across the lanes and the column head. "Preserve row alignment" is a measurement, ` +
                  `and a head that does not share the lanes' track list is a caption, not a column.`,
              );
            }
          }
          if (s.lessonStepDisplay !== undefined) {
            check(
              s.lessonStepDisplay === (wide ? 'grid' : 'block'),
              `${where}: the lesson step renders as "${s.lessonStepDisplay}"; at ${WIDE_PX} px and ` +
                `above the control sits beside the prose it acts on`,
            );
          }
          if (s.sourceBodyColumns !== undefined) {
            // ================================ W8: THE SOURCE ARRANGEMENT
            //
            // > *"the list of items, like 'runDancePose' should be in the left
            // > side of the Source pane and minified; the right side should be
            // > all the source content, etc. which is presently below it."*
            //
            // Two tracks at and above 720 px of pane, one below. The boundary is
            // W2's existing `wide` threshold and not a new number — the sweep's
            // static check would reject a third — and 719/722 are in the width
            // list precisely so this is asserted ON it rather than near it.
            check(
              s.sourceBodyColumns === (wide ? 2 : 1),
              `${where}: the Source pane lays its three regions out in ` +
                `${s.sourceBodyColumns} column track(s). At ${WIDE_PX} px and above the outline is ` +
                `a narrow left column and the code fills the right; below it they stack, because a ` +
                `code column of about 340 px would make every one of movement-sequences.h's ` +
                `96-column lines scroll sideways.`,
            );
            // And the code region's regime follows the arrangement, which is
            // what keeps L4's "it SCROLLED to the symbol" assertion meaningful:
            // an unbounded box has `scrollHeight === clientHeight`, so a line is
            // always "inside the viewport" and the check proves nothing.
            check(
              s.sourceCodeOverflowY === (wide ? 'auto' : 'hidden'),
              `${where}: the code region's overflow-y is "${s.sourceCodeOverflowY}". Beside the ` +
                `outline it is a bounded 420 px viewport that genuinely scrolls; stacked it takes ` +
                `its content height and the LINE BUDGET is what bounds it.`,
            );
            check(
              s.sourceCodeIs2d === true,
              `${where}: the code region stopped declaring data-2d-surface, which is the only ` +
                `reason a pane is allowed a second vertical scroller`,
            );
            // W5, verified rather than changed: real code, never reflowed prose.
            check(
              s.sourceLineWhiteSpace === 'pre',
              `${where}: a source line computes white-space "${s.sourceLineWhiteSpace}". ` +
                `The brief's rule for this pane is "keep code unwrapped by default and allow ` +
                `horizontal scrolling; do not solve the problem with a narrower or smaller font" — ` +
                `and a wrapped line silently renumbers the file a reader is comparing against ` +
                `hardware/source-annotations.json.`,
            );
            /*
              THE MINIFIED OUTLINE, and the expectation is arithmetic rather
              than a table.

              `repeat(auto-fill, minmax(11rem, 1fr))` with an 8 px column gap
              puts `floor((W + gap) / (11rem + gap))` tracks in a box of width
              W, so the expected count is computed from the box the browser
              actually gave the outline. That is what makes this INTRINSIC
              rather than a third threshold: the same one declaration gives a
              full-width stacked pane four columns and the 12rem left column
              exactly one, and there is no number for W2's static check to
              reject. Before it, 25 symbols in one full-width column made a
              720 px-TALL index of a 3,000 px file, which is what the complaint
              was about.
            */
            const OUTLINE_MIN_PX = 176; // 11rem, and the root size is not fluid
            const OUTLINE_GAP_PX = 8; // --space-2
            const expectedOutlineColumns = Math.max(
              1,
              Math.floor(
                ((s.sourceOutlineWidthPx ?? 0) + OUTLINE_GAP_PX) / (OUTLINE_MIN_PX + OUTLINE_GAP_PX),
              ),
            );
            check(
              s.sourceOutlineColumns === expectedOutlineColumns,
              `${where}: the minified outline is in ${s.sourceOutlineColumns} column(s) in a ` +
                `${s.sourceOutlineWidthPx} px box; auto-fill at 11rem with an 8 px gap gives ` +
                `${expectedOutlineColumns}.`,
            );
            // ...and beside the code it is exactly one, which is what "a narrow
            // left column" means.
            if (wide) {
              check(
                s.sourceOutlineColumns === 1 && (s.sourceOutlineWidthPx ?? 0) <= 200,
                `${where}: the outline column is ${s.sourceOutlineWidthPx} px wide in ` +
                  `${s.sourceOutlineColumns} column(s); beside the code it is a 12rem index.`,
              );
            }
          }
          if (s.archBand !== undefined) {
            // The React band is measured on the SURFACE, which is the artifact's
            // own box and therefore narrower than the pane by the pane's
            // padding. That is deliberate and conservative in the safe
            // direction — a scoped representation in a box 40 px too small is a
            // better failure than the full map in one.
            const expected =
              s.archSurfacePx < NARROW_PX ? 'narrow' : s.archSurfacePx < WIDE_PX ? 'medium' : 'wide';
            check(
              s.archBand === expected,
              `${where}: the architecture pane publishes band "${s.archBand}" for a ` +
                `${s.archSurfacePx} px surface; paneWidthBand() says "${expected}".`,
            );

            // ============================ W4: WHICH ARTIFACT IS MOUNTED
            //
            // The user's complaint, closed or not closed, is decided here. The
            // thresholds are the brief's — 720 and 960 — and they are a SECOND
            // table from W2's 520/720 on purpose: one is about column count and
            // is read by CSS, the other is about a 63-node diagram and is read
            // by React. See `apps/web/src/arch/representation.ts`.
            const expectedMode =
              s.archSurfacePx < ARCH_SUBSYSTEM_PX
                ? 'path'
                : s.archSurfacePx < ARCH_FULL_PX
                  ? 'subsystem'
                  : 'full';
            check(
              s.archMode === expectedMode,
              `${where}: the architecture pane mounted the "${s.archMode}" representation in a ` +
                `${s.archSurfacePx} px surface; archModeForWidth() says "${expectedMode}". The ` +
                `brief's rule is causal path below ${ARCH_SUBSYSTEM_PX}, one subsystem below ` +
                `${ARCH_FULL_PX}, the whole 63-node map at or above it.`,
            );

            // REACT chose, and CSS did not merely hide. The proof is that the
            // React Flow surface is not in the DOM at all below 720 px — a
            // stylesheet cannot decline to mount something, so a canvas found
            // here would mean the switch had been faked with `display: none`.
            check(
              s.archCanvasMounted === (expectedMode === 'path' ? 0 : 1),
              `${where}: React Flow's canvas is in the DOM ${s.archCanvasMounted} time(s) in the ` +
                `"${s.archMode}" representation. Below ${ARCH_SUBSYSTEM_PX} px it must not be ` +
                `MOUNTED, not merely hidden: mounting the 63-node graph and hiding it wastes the ` +
                `layout work and leaves two DOMs claiming to be the same diagram.`,
            );
            check(
              s.archBackgroundMounted === (expectedMode === 'path' ? 0 : 1),
              `${where}: React Flow's dot grid is mounted ${s.archBackgroundMounted} time(s) in the ` +
                `"${s.archMode}" representation.`,
            );

            // The number of nodes a reader can actually click. `path` shows one
            // chain plus its branch chips; `subsystem` is capped at the product
            // rule; `full` is the whole visible layout.
            if (expectedMode === 'subsystem') {
              check(
                s.archFlowNodes >= 3 && s.archFlowNodes <= ARCH_SUBSYSTEM_MAX_NODES + 1,
                `${where}: the subsystem representation drew ${s.archFlowNodes} nodes; the product ` +
                  `rule is ${ARCH_SUBSYSTEM_MAX_NODES} plus the root anchor. The brief's principle ` +
                  `is to stop "Fit View" shrinking labels until everything technically fits and ` +
                  `nothing is usable.`,
              );
            }

            // ===================== W4: THE FLOOR, WHERE IT IS CLAIMED
            //
            // `data-zoom-surface` was W1's marker for the one surface whose
            // on-screen size is not its authored size. W4 scopes it to the
            // artifact that owes the debt: `path` has no transform and
            // `subsystem` has a zoom floor of 1, so in both the ordinary 14 px
            // floor applies to what is DRAWN, with no exemption at all.
            check(
              s.archZoomSurfaces === (expectedMode === 'full' ? 1 : 0),
              `${where}: the "${s.archMode}" representation declares ${s.archZoomSurfaces} ` +
                `[data-zoom-surface]. Only the full 63-node graph may: it is the only one whose ` +
                `on-screen size is not its authored size, and an exemption that covered the other ` +
                `two would let this workstream's own debt back in silently.`,
            );
            const archText = reading.measured;
            if (expectedMode !== 'full' && archText.archWorstOnScreenPx !== null) {
              check(
                archText.archWorstOnScreenPx >= TEXT_FLOOR_PX - 0.01,
                `${where}: the smallest text ON SCREEN in the "${s.archMode}" representation is ` +
                  `${archText.archWorstOnScreenPx}px (${JSON.stringify(archText.archWorstText)}), below the ` +
                  `${TEXT_FLOOR_PX}px floor. W1 measured 3.8-8.0px here and handed it to W4 as the ` +
                  `thing three representations exist to fix; this is where it is proved fixed.`,
              );
            }
            if (expectedMode === 'full') archFullZoomDebt.push({ where, ...archText });
          }
          if (m.proseCh !== undefined) {
            // 45ch is a geometric claim about the box, so it is checked as one.
            // Where the pane cannot hold it, that is recorded with the number
            // rather than passed over: W1 measured 25ch and handed it here.
            const canHold = px >= MEASURE_MIN_CH * m.proseChPx;
            if (canHold) {
              check(
                m.proseCh >= MEASURE_MIN_CH && m.proseCh <= MEASURE_MAX_CH,
                `${where}: lesson prose measures ${m.proseCh}ch. The brief's band is ` +
                  `${MEASURE_MIN_CH}-${MEASURE_MAX_CH}ch, target ~64, and this container is wide ` +
                  `enough to hold it (${MEASURE_MIN_CH}ch needs ${Math.ceil(MEASURE_MIN_CH * m.proseChPx)} px).`,
              );
            } else if (label === '2560x1440') {
              proseNotes.push(
                `${px} px of pane holds ${m.proseCh}ch; ${MEASURE_MIN_CH}ch needs ` +
                  `${Math.ceil(MEASURE_MIN_CH * m.proseChPx)} px`,
              );
            }
          }

          const ordinary = reading.scrollers.filter((name) => !name.endsWith('(2d)'));
          check(
            ordinary.length <= 1,
            `${where}: ${ordinary.length} ordinary vertical scrollers — ${JSON.stringify(ordinary)}. ` +
              `A pane owns at most one, and anything else that scrolls has to declare itself with ` +
              `data-2d-surface.`,
          );
        }
      }
    }
    if (archFullZoomDebt.length > 0) {
      const worst = archFullZoomDebt.reduce((a, b) =>
        (a.archWorstOnScreenPx ?? 99) <= (b.archWorstOnScreenPx ?? 99) ? a : b,
      );
      notes.push(
        `the FULL 63-node graph still draws text below the ${TEXT_FLOOR_PX}px floor when it is ` +
          `fitted: ${worst.archWorstOnScreenPx}px at its worst (${JSON.stringify(worst.archWorstText)}), ` +
          `${worst.where}. That is the debt W1 measured at 3.8-8.0px and it is NOT fixed - it is ` +
          `SCOPED. The full graph is now the only representation that renders at all below 960px ` +
          `of surface, it is the only one still carrying [data-zoom-surface], and the two ` +
          `representations a laptop actually gets are asserted against the floor above with no ` +
          `exemption. Fixing it inside React Flow would mean refusing to fit, which is panning a ` +
          `63-node map in a pane - the thing the three representations exist to avoid.`,
      );
    }
    if (proseNotes.length > 0) {
      notes.push(
        `lesson prose cannot reach ${MEASURE_MIN_CH}ch at every container width this sweep ` +
          `DRIVES: ${proseNotes.join('; ')}. Those are widths chosen to test the mechanism, not ` +
          `widths the shell produces: the module column is half the content area, so the narrowest ` +
          `Learn pane a reader can reach is about 400 px at 1280x800 and 690 px at 1920x1080. The ` +
          `measure in the shell a reader actually gets is reported beside this, at 1440x900.`,
      );
    }

    // -------------------------------------- 2. the same container, two windows
    //
    // The claim the whole workstream rests on, stated as a diff: at the same
    // container width, a pane's container-driven internals are byte-identical
    // in a 1280 px window and a 2560 px one.
    let divergences = 0;
    for (const paneId of PANES) {
      const small = sweeps['1280x800'][paneId];
      const large = sweeps['2560x1440'][paneId];
      if (small === null || large === null) continue;
      for (const asked of Object.keys(small)) {
        const a = small[asked];
        const b = large[asked];
        if (b === undefined) continue;
        if (a.containerPx !== b.containerPx) {
          divergences += 1;
          problems.push(
            `the ${paneId} pane asked for ${asked} px is ${a.containerPx} px in a 1280 window and ` +
              `${b.containerPx} px in a 2560 one`,
          );
          continue;
        }
        if (JSON.stringify(a.signature) !== JSON.stringify(b.signature)) {
          divergences += 1;
          problems.push(
            `the ${paneId} pane renders DIFFERENTLY at the same ${a.containerPx} px container width ` +
              `in a 1280 window and a 2560 one:\n  1280: ${JSON.stringify(a.signature)}\n  2560: ` +
              `${JSON.stringify(b.signature)}\nViewport logic is still leaking into this pane's ` +
              `internals; that is the defect W2 exists to remove.`,
          );
        }
      }
    }

    phases.paneContainers = {
      ok: divergences === 0,
      containerWidthsPx: CONTAINER_WIDTHS,
      thresholdsPx: { narrow: NARROW_PX, wide: WIDE_PX },
      panes: PANES,
      windows: Object.keys(sweeps),
      divergences,
      measureBandCh: [MEASURE_MIN_CH, MEASURE_MAX_CH],
      measureShortfalls: proseNotes,
      architecture: {
        thresholdsPx: { subsystem: ARCH_SUBSYSTEM_PX, full: ARCH_FULL_PX },
        subsystemMaxNodes: ARCH_SUBSYSTEM_MAX_NODES,
        modesByContainerWidth: Object.fromEntries(
          Object.entries(sweeps['2560x1440'].modules ?? {}).map(([asked, r]) => [
            asked,
            {
              surfacePx: r.signature.archSurfacePx,
              mode: r.signature.archMode,
              nodes: r.signature.archFlowNodes,
              worstOnScreenPx: r.measured.archWorstOnScreenPx,
              zoomSurfaces: r.signature.archZoomSurfaces,
            },
          ]),
        ),
        fullGraphZoomDebt: archFullZoomDebt,
      },
      readings: sweeps['2560x1440'],
    };
    console.log(
      `[web] container sweep: ${PANES.length} panes x ${CONTAINER_WIDTHS.length} widths x 2 windows, ` +
        `${divergences} viewport-dependent difference(s)`,
    );
  }

  // ======================================================================
  // W5: THE INTEGER-PIXEL ZOOM, THE ECHOED PANE TITLES, AND THE LAB EDITORS
  // ======================================================================
  //
  // Three claims that are about the whole shell rather than about one pane's
  // container width, so they are measured per WINDOW rather than in the sweep.
  //
  //   1. **Every 128x64 surface renders at a whole number of screen pixels per
  //      bitmap pixel.** This is the claim W2 handed on as an open policy
  //      decision and it is the one that had already been quietly lost: W7
  //      published `data-oled-zoom={compact ? '2' : '4'}` — an attribute that
  //      STATES the answer — on a canvas whose `max-width: 100%` clamped it to
  //      227 px in a 262 px card, which is **1.77x**. An assertion against that
  //      attribute could not have failed. This one reads the box.
  //
  //   2. **No pane prints its own name under the column's.** W3 handed this
  //      over and W7 fixed three of the five with a structural selector; Learn
  //      and Lab, whose headers sit one level deeper, went on echoing. Measured
  //      by comparing rendered text, so it cannot be fixed by moving a rule.
  //
  //   3. **The Lab's editors pan; they do not push the pane sideways.**
  //      `.lab-body` was an implicit `auto` grid track, which sizes to its
  //      item's MAX-CONTENT: the Pose tab's nine-column table ran the module
  //      column 320 px past its own width, so the table's own `overflow-x` never
  //      engaged and the whole pane scrolled instead.
  {
    const OLED_ZOOM_LADDER = [8, 6, 4, 2, 1];
    const zoomReadings = [];
    const titleEchoes = [];
    const labOverflow = [];

    /** Every surface that claims a zoom, and the box it actually got. */
    const readZooms = (evaluate, where) =>
      evaluate(
        '[...document.querySelectorAll("[data-oled-zoom]")].map((el) => {' +
          'const b = el.getBoundingClientRect();' +
          'return { id: el.id || el.getAttribute("data-testid") || el.className,' +
          ' claimed: Number(el.getAttribute("data-oled-zoom")),' +
          ' widthPx: Math.round(b.width), heightPx: Math.round(b.height),' +
          ' laidOut: b.width > 0 && b.height > 0 };' +
          '})',
      ).then((rows) => rows.map((r) => ({ ...r, where })));

    /*
      An h1/h2/h3 inside a pane whose OWN text equals the pane chrome's title.
      Rendered text on both sides, and only the element's own text nodes, so a
      wrapper that merely contains the title does not count as an echo.
    */
    const readTitleEchoes = (evaluate, where) =>
      evaluate(
        '(() => {' +
          'const norm = (t) => (t || "").replace(/\\s+/g, " ").trim().toLowerCase();' +
          'const boxed = (e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; };' +
          'const out = [];' +
          'for (const holder of document.querySelectorAll("[data-pane]")) {' +
          '  if (!boxed(holder)) continue;' +
          '  const chrome = holder.querySelector(":scope > .pane__header .dock-section-label");' +
          '  if (chrome === null || !boxed(chrome)) continue;' +
          '  const title = norm(chrome.textContent);' +
          '  for (const h of holder.querySelectorAll("h1,h2,h3")) {' +
          '    if (h === chrome || h.contains(chrome) || !boxed(h)) continue;' +
          '    let own = ""; for (const n of h.childNodes) if (n.nodeType === 3) own += n.nodeValue;' +
          '    if (norm(own) === title) out.push({ pane: holder.getAttribute("data-pane"), title });' +
          '  }' +
          '}' +
          'return out;' +
          '})()',
      ).then((rows) => rows.map((r) => ({ ...r, where })));

    for (const window12 of RESPONSIVE_WINDOWS) {
      const label = `${window12.width}x${window12.height}`;
      const w5Page = await bootPage({ width: window12.width, height: window12.height });
      try {
        // --------------------------------------------- 1. the integer zoom
        // The glance card first, with nothing else open.
        zoomReadings.push(...(await readZooms(w5Page.evaluate, `${label} panel`)));

        // The Face "more info" screen, which is where a pixel is hoverable.
        await w5Page.evaluate(
          'document.querySelector(\'[data-panel-more="face"]\')?.click()',
        );
        await sleep(600);
        zoomReadings.push(...(await readZooms(w5Page.evaluate, `${label} face screen`)));
        await w5Page.evaluate('document.querySelectorAll("dialog[open]").forEach((d) => d.close())');
        await sleep(300);

        // --------------------------------- 2. the titles, in every module
        for (const moduleId of ['modules', 'signal', 'source', 'learn', 'lab']) {
          await w5Page.evaluate(`window.__sesame.setModule(${JSON.stringify(moduleId)})`);
          await sleep(moduleId === 'modules' ? 900 : 600);
          titleEchoes.push(...(await readTitleEchoes(w5Page.evaluate, `${label} ${moduleId}`)));
        }

        // ----------------------- 3. the Lab's five editors, one tab at a time
        await w5Page.evaluate(
          '[...document.querySelectorAll(\'[data-pane="lab"] button\')]' +
            '.find((b) => /open the lab/i.test(b.textContent))?.click()',
        );
        await sleep(700);
        const tabIds = await w5Page.evaluate(
          '[...document.querySelectorAll(\'[data-pane="lab"] .lab-tab\')]' +
            '.map((b) => b.getAttribute("data-testid"))',
        );
        for (const tabId of tabIds) {
          await w5Page.evaluate(
            `document.querySelector(${JSON.stringify(`[data-testid="${tabId}"]`)}).click()`,
          );
          await sleep(500);
          const reading = await w5Page.evaluate(
            '(() => {' +
              'const pane = document.querySelector(\'[data-pane="lab"]\');' +
              'const FORM = new Set(["TEXTAREA", "INPUT", "SELECT"]);' +
              'const undeclared = [...pane.querySelectorAll("*")].filter((e) => {' +
              '  if (FORM.has(e.tagName)) return false;' +
              '  if (e.scrollWidth <= e.clientWidth + 1) return false;' +
              '  const o = getComputedStyle(e).overflowX;' +
              '  if (o !== "auto" && o !== "scroll") return false;' +
              '  return !e.hasAttribute("data-2d-surface");' +
              '}).map((e) => e.getAttribute("data-testid") || String(e.className).split(" ")[0]);' +
              'return { paneOverflowPx: Math.round(pane.scrollWidth - pane.clientWidth), undeclared };' +
              '})()',
          );
          labOverflow.push({ where: label, tab: tabId, ...reading });
          zoomReadings.push(...(await readZooms(w5Page.evaluate, `${label} ${tabId}`)));
        }
        reportPageErrors(`phase 12 W5 at ${label}`);
      } finally {
        w5Page.close();
        await sleep(400);
      }
    }

    for (const reading of zoomReadings) {
      if (!reading.laidOut) continue;
      check(
        OLED_ZOOM_LADDER.includes(reading.claimed),
        `${reading.where}: ${reading.id} claims a zoom of ${reading.claimed}, which is not a rung ` +
          `of the ladder ${JSON.stringify(OLED_ZOOM_LADDER)}.`,
      );
      check(
        reading.widthPx === 128 * reading.claimed && reading.heightPx === 64 * reading.claimed,
        `${reading.where}: ${reading.id} says data-oled-zoom="${reading.claimed}" and renders ` +
          `${reading.widthPx}x${reading.heightPx}, which is ` +
          `${(reading.widthPx / 128).toFixed(2)}x. A 128x64 grid at a fractional zoom paints some ` +
          `bitmap pixels wider than others and puts the SSD1306's page-grid lines between device ` +
          `pixels — see apps/web/src/oled/zoom.ts.`,
      );
    }

    check(
      titleEchoes.length === 0,
      `${titleEchoes.length} pane(s) print their own name under the column's: ` +
        `${JSON.stringify(titleEchoes.slice(0, 4))}. W3 handed this over; the structural selector ` +
        `that replaced it caught three of five.`,
    );

    for (const lab of labOverflow) {
      check(
        lab.paneOverflowPx === 0,
        `${lab.where} ${lab.tab}: the Lab pane's own content is ${lab.paneOverflowPx} px wider ` +
          `than the pane. An editor that is too wide must PAN inside its own declared surface; a ` +
          `pane that scrolls sideways has taken the module column with it.`,
      );
      check(
        lab.undeclared.length === 0,
        `${lab.where} ${lab.tab}: ${JSON.stringify(lab.undeclared)} scroll(s) horizontally without ` +
          `declaring data-2d-surface. Horizontal overflow is legitimate for a derivation table, a ` +
          `timeline and a pixel grid, and it says so or it is a leak.`,
      );
    }

    phases.integerPixelZoom = {
      ok: true,
      ladder: OLED_ZOOM_LADDER,
      surfaces: zoomReadings.filter((r) => r.laidOut),
      titleEchoes,
      lab: labOverflow,
    };
    const zoomsSeen = [...new Set(zoomReadings.filter((r) => r.laidOut).map((r) => r.claimed))];
    console.log(
      `[web] W5: ${zoomReadings.filter((r) => r.laidOut).length} OLED surface(s) at integer zooms ` +
        `${JSON.stringify(zoomsSeen.sort((a, b) => b - a))}, ${titleEchoes.length} echoed pane ` +
        `title(s), ${labOverflow.length} Lab editor tab(s) with 0 px of pane overflow`,
    );
  }

  // ======================================================================
  // W4: THE SUBSYSTEM REPRESENTATION, IN A LAYOUT A READER CAN REACH
  // ======================================================================
  //
  // The intermediate artifact is the hardest of the three to photograph
  // honestly, because no dock or workbench in the ordinary shell produces a
  // 720-959 px surface. Phase 7 proves the switch by DRIVING a pane to it, the
  // way the container sweep drives every pane; this proves that the width is
  // also reachable by a real action on a real laptop - a 1440x900 window with
  // the focus workspace open gives the module column about 830 px, and that is
  // the subsystem graph rather than the full map. That is the honest answer at
  // that window and the pane says so out loud rather than claiming a map that
  // would not fit.
  //
  // **1280 -> 1440 in W7**, and the reason is arithmetic rather than taste: the
  // side panel is 280 px and always there, so the workspace at 1280 leaves the
  // module 670 px and the causal path. That is the correct answer at 1280; it
  // is just not the one this capture is of.
  {
    const subPage = await bootPage({ width: 1440, height: 900 });
    try {
      await subPage.evaluate('window.__sesame.setSection("modules", true)');
      await sleep(700);
      await subPage.evaluate('window.__sesame.run("wave")');
      await sleep(2600);
      await subPage.evaluate(
        `document.querySelector('[data-testid="arch-workspace-toggle"]').click()`,
      );
      await sleep(1600);
      const reading = await subPage.evaluate('window.__sesame.archGraph()');
      const shell12 = await subPage.evaluate('window.__sesame.shell()');
      check(
        reading.mode === 'subsystem',
        `at 1440x900 with the focus workspace open the pane holds ` +
          `${reading.surfaceWidthPx} px and mounted "${reading.mode}". The workspace is not a ` +
          `fourth mode: it widens the pane and archModeForWidth() chooses, so a smaller laptop ` +
          `gets the subsystem graph and is told so.`,
      );
      check(
        shell12.stageRule === 'focus-exempt' &&
          shell12.stageAreaSharePct < STAGE_AREA_FLOOR_PCT,
        `the workspace at 1440x900 reports stageRule=${JSON.stringify(shell12.stageRule)} with the ` +
          `stage at ${shell12.stageAreaSharePct.toFixed(1)}% of the area. The exemption is only ` +
          `honest if it is actually needed.`,
      );
      // The floor that REPLACES the area rule, at the smallest window the
      // workspace is offered on. This is the number that decides whether
      // "Sesame stays a live reference" is true or a slogan.
      check(
        shell12.canvasWidthPx >= 220 && shell12.canvasHeightPx >= 220,
        `inside the workspace at 1440x900 the 3D canvas is ` +
          `${shell12.canvasWidthPx.toFixed(0)}x${shell12.canvasHeightPx.toFixed(0)}; the focus ` +
          `floor is 220 px on each side`,
      );
      const subZoom = await subPage.evaluate(`(() => {
        const v = document.querySelector('.react-flow__viewport');
        if (v === null) return null;
        const t = getComputedStyle(v).transform;
        const n = t.slice(t.indexOf('(') + 1, -1).split(',').map(Number);
        return n.length >= 4 ? Math.round(n[3] * 1000) / 1000 : null;
      })()`);
      check(
        subZoom !== null && subZoom >= 1,
        `the subsystem graph at 1440x900 is drawn at zoom ${subZoom}; its floor is 1, which is what ` +
          `makes a 15px node label a 15px node label`,
      );
      const shot = await subPage.shoot(
        'w4-architecture-subsystem.png',
        'the subsystem representation, reached on a 1440x900 laptop by opening the architecture workspace: one Movement neighbourhood of 16 nodes drawn at zoom 1 - every label its authored size on screen - with the other three subsystems one click away, the 21 nodes the 18-node budget could not take counted rather than dropped, and Sesame still live beside it',
      );
      phases.architectureSubsystem = {
        ok: true,
        window: '1440x900',
        via: 'focus workspace',
        surfaceWidthPx: reading.surfaceWidthPx,
        mode: reading.mode,
        subsystem: reading.subsystem,
        nodes: reading.renderedNodeIds.length,
        zoom: subZoom,
        stageRule: shell12.stageRule,
        stageAreaSharePct: shell12.stageAreaSharePct,
        canvasPx: [shell12.canvasWidthPx, shell12.canvasHeightPx],
        shots: [shot.name],
      };
    } finally {
      subPage.close();
      await sleep(400);
    }
  }

  // ======================================================================
  // LEARN, AT MEDIUM
  // ======================================================================
  //
  // The accordion holds ONE open section below Wide, which is exactly the
  // arrangement that could have broken a whole mode rather than a pixel count:
  // a lesson step that selects a symbol, or a check that reads live telemetry,
  // has to keep working while five other panes are collapsed around it.
  //
  // Lesson 2 is locked until every step of lesson 1 has PASSED, so lesson 1 is
  // played here too. Its structural assertions belong to phase 10 and are not
  // repeated; what this asserts is that six checks still reach `passed` against
  // real telemetry at a width where the pane they live in is one of six.
  {
    const learnPage = await bootPage({ width: 1440, height: 900 });
    try {
      const LESSONS_EXPR = 'window.__sesame.lessons()';
      const clickOn = (selector) =>
        learnPage.evaluate(`(() => {
          const el = document.querySelector(${JSON.stringify(selector)});
          if (el === null) return { ok: false, why: 'not on screen' };
          if (typeof el.click === 'function') el.click();
          else el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
          return { ok: true };
        })()`);
      const setRange = (selector, value) =>
        learnPage.evaluate(`(() => {
          const el = document.querySelector(${JSON.stringify(selector)});
          if (el === null) return { ok: false, why: 'not on screen' };
          const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
          setter.call(el, String(${JSON.stringify(String(value))}));
          el.dispatchEvent(new Event('input', { bubbles: true }));
          return { ok: true, value: el.value };
        })()`);
      const attrOf = (selector, name) =>
        learnPage.evaluate(`(() => {
          const el = document.querySelector(${JSON.stringify(selector)});
          return el === null ? null : el.getAttribute(${JSON.stringify(name)});
        })()`);
      const waitCheck = (status, what, timeoutMs = 20000) =>
        waitFor(
          learnPage.evaluate,
          'window.__sesame.lessons().checkStatus',
          (value) => value === status,
          `${what} at Medium (check to read "${status}")`,
          timeoutMs,
        );
      const openStep = async (index) => {
        await learnPage.evaluate(`(() => {
          const nav = document.querySelector('[data-testid="lesson-step-nav"]');
          const chip = nav?.children?.[${index}];
          if (chip != null) chip.click();
        })()`);
        await sleep(400);
      };

      await openSection(learnPage.evaluate, 'learn');
      const atMedium = await learnPage.evaluate('window.__sesame.shell()');
      check(
        atMedium.breakpoint === 'medium' && atMedium.activeModule === 'learn',
        `the Learn run is not at Medium with Learn as the one active module: ${JSON.stringify({
          breakpoint: atMedium.breakpoint,
          active: atMedium.activeModule,
          laidOut: atMedium.moduleColumn.laidOutPanes,
        })}`,
      );

      // ---- lesson 1, to unlock lesson 2 by demonstration
      await clickOn('[data-testid="lesson-card-meet-sesame"]');
      await sleep(500);
      for (let guard = 0; guard < 20; guard += 1) {
        const asking = await attrOf('[data-testid="joint-quiz"]', 'data-asking');
        if (asking === null || asking === '') break;
        await clickOn(`[data-testid="explode-module-${asking}"]`);
        await waitFor(
          learnPage.evaluate,
          `document.querySelector('[data-testid="joint-quiz"]')?.getAttribute('data-asking') ?? null`,
          (value) => value !== asking,
          `the naming quiz to advance past ${asking} at Medium`,
          10000,
        );
      }
      await waitCheck('passed', 'naming all eight joints');
      await openStep(1);
      await clickOn('[data-testid="board-s2-mini"]');
      await sleep(200);
      await clickOn('[data-testid="board-distro-v1"]');
      await waitCheck('passed', 'switching the board profile');
      await openStep(2);
      await clickOn('[data-testid="graph-node-oled"]');
      await waitCheck('passed', 'following the OLED node to its declaration');
      await openStep(3);
      await clickOn('[data-testid="run-stand"]');
      await waitCheck('passed', 'the eight channels reaching runStandPose’s vector', 30000);
      await openStep(4);
      await clickOn('[data-testid="quiz-badge-inferred-for-explanation"]');
      await waitCheck('passed', 'identifying pwm.output as computed rather than observed');

      // The graph-node step above went through the shared selection, which is
      // the §5 path — so assert the dock did not end up somewhere that would
      // have stranded the learner mid-lesson.
      const midLesson = await learnPage.evaluate('window.__sesame.lessons()');
      check(
        midLesson.openLessonId === 'meet-sesame',
        `the lesson pane lost its open lesson at Medium (${midLesson.openLessonId}) — a selection ` +
          `made from inside a lesson must not collapse the section the lesson is in`,
      );

      // ---- lesson 2, end to end
      await clickOn('[data-testid="lesson-back"]');
      await sleep(450);
      const unlocked = await learnPage.evaluate(LESSONS_EXPR);
      check(
        unlocked.lessonCards.find((c) => c.id === 'command-one-joint')?.locked === false,
        'passing every step of lesson 1 at Medium did not unlock lesson 2',
      );
      await learnPage.evaluate('window.__sesame.setJoint("R1", 90)');
      await sleep(800);
      await clickOn('[data-testid="lesson-card-command-one-joint"]');
      await sleep(500);

      await waitCheck('failed', 'R1 sitting at 90 when the step asks for 135');
      await setRange('[data-testid="joint-slider-input"]', 135);
      await clickOn('[data-testid="joint-slider-send"]');
      await waitCheck('passed', 'commanding R1 to 135');

      await openStep(1);
      await setRange('[data-testid="channel-input"]', 3);
      await clickOn('[data-testid="channel-send"]');
      await waitCheck('failed', 'writing channel 3, which is inside the guard');
      await setRange('[data-testid="channel-input"]', 8);
      await clickOn('[data-testid="channel-send"]');
      await waitCheck('passed', 'channel 8 producing no servo.target inside the window');

      await openStep(2);
      await setRange('[data-testid="subtrim-R1"]', 40);
      await sleep(300);
      await setRange('[data-testid="subtrim-angle"]', 160);
      await clickOn('[data-testid="subtrim-send-button"]');
      await sleep(600);
      await setRange('[data-testid="subtrim-angle"]', 180);
      await clickOn('[data-testid="subtrim-send-button"]');
      await waitCheck('passed', 'two requests colliding on one commanded angle');

      await openStep(3);
      await setRange('[data-testid="pwm-angle"]', 99);
      await sleep(300);
      await setRange('[data-testid="pwm-angle"]', 100);
      await waitCheck('passed', '99° and 100° programming the same tick count');

      // The same condition phase 10 waits on, and for the same reason: the
      // check is already passed from lesson 1's trace when this step opens.
      await openStep(4);
      await clickOn('[data-testid="trace-run-stand"]');
      await waitFor(
        learnPage.evaluate,
        LESSONS_EXPR,
        (v) => v !== null && v.checkStatus === 'passed' && (v.checkObserved ?? '').includes('visual.joint'),
        'one command producing a row on every rung at Medium',
        30000,
      );

      // Same order phase 10 uses: land on delayWithFace out of nowhere first,
      // which must NOT satisfy a check that names how the span was reached.
      await openStep(5);
      await clickOn('[data-testid="open-symbol-delayWithFace"]');
      await sleep(700);
      const direct = await learnPage.evaluate(LESSONS_EXPR);
      check(
        direct.checkStatus === 'pending',
        `at Medium, opening delayWithFace out of nowhere satisfied a check that names how it was ` +
          `reached (${direct.checkStatus})`,
      );
      await clickOn('[data-cite-symbol="setServoAngle"]');
      await sleep(600);
      await clickOn('[data-testid="open-symbol-delayWithFace"]');
      await waitCheck('passed', 'reaching delayWithFace from setServoAngle');

      const lesson2 = await learnPage.evaluate(LESSONS_EXPR);
      check(
        lesson2.stepOutcomes.length === 6 && lesson2.stepOutcomes.every((s) => s.outcome === 'passed'),
        `lesson 2 at Medium finished as ${JSON.stringify(lesson2.stepOutcomes)}`,
      );

      // The stage held its half of the screen through all of that.
      const afterLesson = await learnPage.evaluate('window.__sesame.shell()');
      check(
        afterLesson.viewportHeightSharePct >= HEIGHT_FLOOR_PCT && afterLesson.canvasWidthPx >= WIDTH_FLOOR_PX,
        `after playing two lessons at Medium the canvas is ` +
          `${afterLesson.canvasWidthPx.toFixed(0)}x${afterLesson.canvasHeightPx.toFixed(0)} ` +
          `(${afterLesson.viewportHeightSharePct.toFixed(1)}% of the window)`,
      );
      check(
        afterLesson.stageContentSharePct >= STAGE_CONTENT_FLOOR_PCT - 0.2,
        `after playing two lessons at Medium the canvas holds ` +
          `${afterLesson.stageContentSharePct.toFixed(1)}% of the CONTENT area, under the ` +
          `"${afterLesson.stageRule}" rule the shell publishes`,
      );

      /*
       * THE NUMBER THE WHOLE OF §3 RESTS ON, in the shell a reader gets.
       *
       * W1 measured about 25 ch of lesson prose in a two-dock laptop shell and
       * called it a pane-width problem. W2 re-derived it: two in-flow docks
       * cannot give a pane 45 ch AND the stage half the screen below roughly
       * 1900 px. W3's 540 px workbench got 50.7 ch, and the module column —
       * half the content area — gets more again, because there is one column
       * here rather than two.
       *
       * The container sweep proves the MECHANISM at nine widths; this proves
       * the GEOMETRY at the one width the complaint came from.
       */
      await focusSection(learnPage.evaluate, 'learn');
      await sleep(400);
      const measureAtMedium = await learnPage.evaluate(`(() => {
        const el = document.querySelector('.lesson-explanation');
        const pane = document.querySelector('[data-pane-content="learn"]');
        if (el === null) return null;
        const cs = getComputedStyle(el);
        // One character of THIS element's resolved font, measured rather than
        // assumed — the type scale is fluid above 1440.
        const probe = document.createElement('span');
        probe.style.font = cs.font;
        probe.style.position = 'absolute';
        probe.style.visibility = 'hidden';
        probe.textContent = '0';
        document.body.appendChild(probe);
        const chPx = probe.getBoundingClientRect().width;
        probe.remove();
        return {
          fontSizePx: parseFloat(cs.fontSize),
          proseWidthPx: Math.round(el.getBoundingClientRect().width * 10) / 10,
          paneWidthPx: Math.round((pane?.getBoundingClientRect().width ?? 0) * 10) / 10,
          moduleColumnPx: Math.round(
            (document.querySelector('[data-testid="module-column"]')?.getBoundingClientRect().width ?? 0) * 10,
          ) / 10,
          ch: Math.round((el.getBoundingClientRect().width / chPx) * 10) / 10,
          chPx: Math.round(chPx * 100) / 100,
        };
      })()`);
      check(
        measureAtMedium !== null && measureAtMedium.ch >= 45 && measureAtMedium.ch <= 75,
        `at 1440x900 the lesson prose in the real shell measures ` +
          `${measureAtMedium?.ch}ch (${measureAtMedium?.proseWidthPx} px of ` +
          `${measureAtMedium?.fontSizePx}px text in a ${measureAtMedium?.paneWidthPx} px pane, ` +
          `inside a ${measureAtMedium?.moduleColumnPx} px module column). The brief's band is ` +
          `45-75ch, W1 measured about 25 in the two-dock shell, and W2 recorded that two in-flow ` +
          `docks cannot reach 45 below roughly 1900 px. This is the check that says one column did.`,
      );
      laptopProseMeasure = measureAtMedium;

      // The lesson's own quiz clicks a module in the 3D scene, which is the §5
      // path and legitimately reveals the architecture graph — so by the last
      // step Learn is the collapsed header carrying `Command one joint 5/6`.
      // Put it back up for the capture; the assertions above already proved the
      // lesson never lost its place while it was down there.
      await focusSection(learnPage.evaluate, 'learn');
      shellShots.push(
        await learnPage.shoot(
          'u5-learn-at-medium.png',
          'lesson 2 played end to end on a 1440x900 laptop: Learn is the one active module, it ' +
            'has half the content area, six checks passed against real telemetry, and the robot ' +
            'held the other half throughout',
        ),
      );
    } finally {
      learnPage.close();
      await sleep(400);
    }
  }

  // ======================================================================
  // THE LAB'S C++ EXPORT, AT COMPACT
  // ======================================================================
  //
  // Below 900 px the dock is a full-height sheet over the stage, which is the
  // narrowest the Lab's editors are ever laid out. The export is parsed by the
  // same second parser phase 11 uses — the Lab's own round-trip verdict is not
  // trusted here either.
  {
    const labPage12 = await bootPage({ width: 880, height: 900 });
    try {
      const evaluate = labPage12.evaluate;
      const clickOn = (selector) =>
        evaluate(`(() => {
          const el = document.querySelector(${JSON.stringify(selector)});
          if (el === null) return { ok: false, why: 'not on screen' };
          el.click();
          return { ok: true };
        })()`);
      const setValue = (selector, value) =>
        evaluate(`(() => {
          const el = document.querySelector(${JSON.stringify(selector)});
          if (el === null) return { ok: false, why: 'not on screen' };
          const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
          setter.call(el, ${JSON.stringify(String(value))});
          el.dispatchEvent(new Event('input', { bubbles: true }));
          return { ok: true, value: el.value };
        })()`);

      await evaluate(
        `(() => { try { localStorage.removeItem('sesame-lab.lab.v1'); } catch { /* blocked */ } })()`,
      );
      await evaluate('void location.reload()');
      await sleep(800);
      await waitFor(
        evaluate,
        'typeof window.__sesame !== "undefined" && window.__sesame.ready',
        (v) => v === true,
        'the app to come back for the Compact Lab run',
        60000,
      );
      // The reload re-ran the default-backend probe and this origin is the
      // bridge, with no lab host behind it — see the note at the reload in the
      // window sweep above.
      await evaluate('window.__sesame.setBackend("sim")');
      await sleep(400);
      await openSection(evaluate, 'lab');
      const compact = await evaluate('window.__sesame.shell()');
      check(compact.breakpoint === 'compact', `the Lab run is at "${compact.breakpoint}", not Compact`);

      await clickOn('[data-testid="lab-open"]');
      await sleep(500);
      await clickOn('[data-testid="lab-tab-pose"]');
      await sleep(350);

      const authored = [
        { R1: 135, R2: 90, L1: 90, L2: 90, R4: 90, R3: 90, L3: 90, L4: 170 },
        { R1: 45, R2: 90, L1: 90, L2: 90, R4: 90, R3: 90, L3: 90, L4: 120 },
      ];
      await setValue('[data-testid="pose-slider-R1"]', 135);
      await setValue('[data-testid="pose-slider-L4"]', 170);
      await sleep(300);
      await clickOn('[data-testid="pose-capture"]');
      await sleep(350);
      await clickOn('[data-testid="lab-tab-pose"]');
      await sleep(250);
      await setValue('[data-testid="pose-slider-R1"]', 45);
      await setValue('[data-testid="pose-slider-L4"]', 120);
      await sleep(300);
      await clickOn('[data-testid="pose-capture"]');
      await sleep(400);

      const reading = await evaluate('window.__sesame.lab()');
      check(reading.frameRows === 2, `the Compact Lab holds ${reading.frameRows} frame(s), not 2`);
      const reparsed = parseExportedCpp(reading.exportedCpp);
      check(
        reparsed.length === 2,
        `at Compact the exported C++ parsed back to ${reparsed.length} frame(s), not the 2 authored`,
      );
      let disagreements = 0;
      reparsed.forEach((frame, index) => {
        const expected = authored[index] ?? {};
        if (JSON.stringify(frame.order) !== JSON.stringify(JOINT_ORDER)) {
          disagreements += 1;
          problems.push(
            `at Compact, frame ${index + 1} of the exported C++ writes ${JSON.stringify(frame.order)}, ` +
              `not the firmware's ${JSON.stringify(JOINT_ORDER)}`,
          );
        }
        for (const joint of JOINT_ORDER) {
          if (frame.angles[joint] !== expected[joint]) {
            disagreements += 1;
            problems.push(
              `at Compact the exported C++ says frame ${index + 1} commands ${joint} to ` +
                `${frame.angles[joint]}°; the sliders authored ${expected[joint]}°`,
            );
          }
        }
      });
      check(
        reading.exportedCppRoundTripOk === true && reading.exportedCppWrites === 16,
        `at Compact the Lab reports round-trip ${reading.exportedCppRoundTripOk} over ` +
          `${reading.exportedCppWrites} writes; this file re-parsed the same text and found ` +
          `${disagreements} disagreement(s)`,
      );
      check(
        reading.exportedCpp.includes('COMMANDED ANGLES'),
        'the Compact export lost the commanded-angles warning that has to survive the clipboard',
      );

      const stageAtCompact = await evaluate('window.__sesame.shell()');
      check(
        stageAtCompact.canvasWidthPx >= WIDTH_FLOOR_PX,
        `with the Lab sheet open at Compact the canvas is ${stageAtCompact.canvasWidthPx.toFixed(0)} px wide`,
      );

      shellShots.push(
        await labPage12.shoot(
          'u5-lab-at-compact.png',
          'the Lab as a full-height sheet on an 880 px window — a Control-mode tab now, beside the ' +
            'OLED it authors: two frames captured from the eight sliders and the exported C++ ' +
            're-parsed here, byte for byte the same poses',
        ),
      );
    } finally {
      labPage12.close();
      await sleep(400);
    }
  }

  try {
    shellBridge.proc.kill();
  } catch {
    /* gone */
  }

  phases.responsiveShell = {
    ok: problems.length === before12,
    shell: 'rail 64 | stage | ONE module | side panel 280 | status strip 32 — Phase 4 W7',
    modules: {
      ids: MODULE_IDS,
      rule: 'mutually exclusive: ShellState holds ONE nullable id, so two-open is unrepresentable',
      navigation: "the rail's radiogroup; no accordion, no navigator row, no mode switch",
      modeLabel: 'Control | Analyze, DERIVED from the active module and never stored',
      chromePx: 25,
      /*
        W8 — the Source pane's arrangement per window, measured rather than
        derived. The outline sits beside the code from 1920x1080 up; below that
        the module column is under 720 px of pane and the three regions stack.
      */
      sourceArrangements,
    },
    sidePanel: {
      widthPx: PANEL_W_PX,
      // The ORDER, as rendered — Phase 4 W8 put the face at the top. Read off
      // the DOM in `folds[].order` at every window as well, so this line cannot
      // drift away from what the panel does.
      cards: ['face', 'trust (Driving)', 'commands', 'inspector'],
      scrollableCards: ['commands', 'inspector'],
      rule:
        'Phase 4 W5: no scroller outside Commands and Selected joint; those two scroll when, ' +
        'and only when, their own content exceeds the box flex gave them; the panel itself ' +
        'never overflows. This REPLACES W7\'s "zero scrollers at every width", which the user ' +
        'overrode — see docs/findings/W5-hard-panes.md',
      sizing:
        'Face and the trust card are `flex: 0 0 auto` — their own content\'s height at every ' +
        'panel height. Commands is `1 1 auto` and takes the spare; Selected joint is `0 1 auto` ' +
        'and gives height back first. No fold, no layout effect, no measurement after a commit.',
      windows: panelFolds,
      moreInfo: {
        trust: 'the backend switch, PROVENANCE_MEANING, the emulator qualifiers and the counts',
        commands: 'the whole 20-command vocabulary and the face shortlist',
        face: 'the OLED at 4x, the payload, and the full pixel-provenance prose',
        inspector: 'the seven-column joint table, the per-joint slider and the asset facts',
      },
      correctnessOnThePanel: [
        'the driving provenance badge',
        'the driving origin in full, with its board',
        'measurementVerdict()’s claim line',
        'PHYSICAL HARDWARE: NONE, read off the counter',
        'the OLED pixel provenance',
        'the two zero-frame faces, marked',
        'the selected joint and the provenance of its reading',
      ],
    },
    breakpoints: {
      compact: '< 1200 px — the module and the panel are SHEETS; 64 + 280 + 480 + 376 = 1200',
      medium: '1200-2313 px — rail | stage | module | panel, all in flow',
      wide:
        '>= 2314 px — the width at which the ORDINARY layout holds the whole 63-node graph: ' +
        '(innerWidth - 344) / 2 - 25 >= 960. It REPLACES W3’s 1700, which was the two-dock ' +
        'boundary and whose justification W7 deleted.',
    },
    /*
      TWO REGIMES, both asserted, and the app publishes which one is in force.

      §11.2: *"Do not average them into one loose number. Publish which regime
      is in force the way W4 published `data-stage-rule`, and assert both."*
    */
    stageRules: {
      'area-50': 'no module active — the stage keeps >= 50% of the VIEWPORT area (§7, unchanged)',
      'content-50':
        'a module is active — >= 50% of the CONTENT area, the viewport minus the rail, the ' +
        'status strip and the side panel. §11.2’s plain reading of "with the robot in the ' +
        'other half".',
      'focus-exempt': "W4's focus workspace, claimable only while its pane is on screen",
      published: 'data-stage-rule on .shell, beside data-active-module and data-focus-pane',
      alsoAsserted:
        'activating a module must take more than 300 px from the canvas — W3’s inverse ' +
        'check, adapted rather than deleted: in flow is a claim about the layout, not a comment',
      compactBackstop: 'min-height: 45vh and min-width: min(480px, 100%), still asserted everywhere',
    },
    /*
      W4 handed this over: the full 63-node graph only ever reached its own band
      inside the focus workspace, because no dock in the old shell was 960 px
      wide. The module column is half the content area, so the band is a
      function of the window — measured here at every one.
    */
    architectureSurface: archSurfaces,
    statusLine: {
      heightPx: 32,
      spans: 'the whole shell, under the rail, the content area and the side panel',
      environmentLine: 'SYSTEM: <system> · PHYSICAL HARDWARE: NONE — a correctness surface, never truncated',
      quickCommands: '[data-quick-command] — wave/stand/rest/stop, hit-tested at every breakpoint',
    },
    floors: {
      stageAreaSharePct: STAGE_AREA_FLOOR_PCT,
      stageContentSharePct: STAGE_CONTENT_FLOOR_PCT,
      viewportHeightSharePct: HEIGHT_FLOOR_PCT,
      viewportWidthPx: WIDTH_FLOOR_PX,
    },
    windows: measured,
    laptopProseMeasure,
    persistenceKey: 'sesame-lab.shell.v3',
    fontSizesPx: fonts,
    typeFloorPx: TEXT_FLOOR_PX,
    typeReadings,
    textBelowFloorInsideZoomSurfaces: zoomedText.length,
    shots: shellShots.map((s) => s.name),
  };
  for (const row of measured) {
    console.log(
      `[web] ${row.window} ${row.breakpoint}: canvas ` +
        `${row.moduleActive.canvasWidthPx.toFixed(0)}x${row.moduleActive.canvasHeightPx.toFixed(0)} = ` +
        `${row.moduleActive.stageContentSharePct.toFixed(1)}% of CONTENT ` +
        `(${row.moduleActive.stageAreaSharePct.toFixed(1)}% of the window) under ` +
        `"${row.moduleActive.stageRule}"; no module: ` +
        `${row.noModule.stageAreaSharePct.toFixed(1)}% of the window under ` +
        `"${row.noModule.stageRule}"; module ${row.moduleActive.moduleWidthPx.toFixed(0)} px, ` +
        `surface ${Number(row.moduleActive.surfaceWidthPx ?? 0).toFixed(0)} px; the stage gave ` +
        `${row.stageGivenToModulePx.toFixed(0)} px for it`,
    );
  }
  for (const row of archSurfaces) {
    console.log(
      `[web] ${row.window}: architecture surface ${row.surfaceWidthPx} px -> "${row.mode}"` +
        (row.worstOnScreenPx === null ? '' : `, worst label ${row.worstOnScreenPx}px on screen`),
    );
  }
}

// ---------------------------------------------------------------- summary
const summary = {
  capturedAt: new Date().toISOString(),
  browser: { path: BROWSER, headless: 'new', gl: 'swiftshader' },
  app: 'apps/web/dist',
  servedBy: 'emulator/bridge (unmodified) --serve-viewer --viewer-dir apps/web/dist',
  method:
    'joint angles read from THREE.Object3D.quaternion in the live scene graph over CDP ' +
    'Runtime.evaluate; ground plane recomputed in-browser from the posed foot mesh vertices; ' +
    'images via Page.captureScreenshot',
  jointOrderAssertedInBrowser: JOINT_ORDER,
  honesty:
    'Emulated is never presented as physical. The app branches on isPhysicallyObserved(), not on ' +
    'provenance === "observed", and renders describeOrigin() beside every provenance badge.',
  phases,
  shots,
  notes,
  problems,
  ok: problems.length === 0,
};
fs.mkdirSync(OUT, { recursive: true });
fs.writeFileSync(path.join(OUT, 'v3-v4-browser-capture.json'), `${JSON.stringify(summary, null, 2)}\n`);

killAll();

if (problems.length > 0) {
  console.error(`FAIL  browser verification — ${problems.length} problem(s):`);
  for (const problem of problems) console.error(`  - ${problem}`);
  process.exit(1);
}
for (const note of notes) console.log(`NOTE  ${note}`);
console.log(
  `OK    ${shots.length} real-browser captures; joint rotations read back from the scene graph; ` +
    `stand pose verified in-browser; all three backends drove the same scene; ` +
    `the source explorer rendered the pinned tree at its own line numbers and refused a ` +
    `one-byte-tampered copy of it; lessons 1, 2, 4 and 5 were played end to end against real ` +
    `telemetry, with six checks driven to FAILED first; the 3D canvas held at least 50% of the ` +
    `window's AREA with no module up and at least 50% of the CONTENT area with one — the two ` +
    `regimes §11.2 named, both asserted, with the shell publishing which was in force — and at ` +
    `least 45% of its height and 480 px of width everywhere; ONE module was active at every ` +
    `width, with zero accordion toggles anywhere; the side panel held Commands, the face and the ` +
    `selected joint in 280 px, showing the WHOLE command vocabulary, with no scroller outside ` +
    `Commands and Selected joint at any window and no overflow anywhere, and carried ` +
    `the provenance, the origin, the measurement verdict and PHYSICAL HARDWARE: NONE on itself ` +
    `rather than behind a "more info" screen; the environment line stated SYSTEM and PHYSICAL ` +
    `HARDWARE: NONE whole at every width; and wave stayed reachable from the status line with no ` +
    `module open` +
    (phases.qemuCommanded?.ran === true
      ? `; a clicked button drove real firmware under QEMU and every joint it moved carries ` +
        `origin.kind="emulator" with isPhysicallyObserved() false`
      : ''),
);
process.exit(0);
