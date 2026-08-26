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
async function launchBrowser(url) {
  const cdpPort = await freePort();
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'sesame-web-'));
  const proc = spawn(
    BROWSER,
    [
      '--headless=new',
      `--remote-debugging-port=${cdpPort}`,
      `--user-data-dir=${profile}`,
      '--window-size=1440,860',
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

  const backend = await page.evaluate('window.__sesame.backendId()');
  check(backend === 'sim', `the default backend is "${backend}", expected "sim"`);

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

  await waitSceneCaughtUp('the scene to apply telemetry arriving over the WebSocket');
  const wired = await page.evaluate('window.__sesame.sceneJoints()');
  const commanded = wired.filter((j) => j.storeCommandedDeg !== null);
  check(commanded.length === 8, `only ${commanded.length}/8 joints were driven over the WebSocket`);
  for (const joint of commanded) {
    check(
      Math.abs(joint.sceneCommandedDeg - joint.storeCommandedDeg) < 1e-4,
      `${joint.joint}: scene ${joint.sceneCommandedDeg}° vs wire ${joint.storeCommandedDeg}°`,
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

  // Back to the top of the sidebar: this shot's evidence is the backend switch
  // and the provenance banner, not the OLED.
  await page.evaluate(`void document.querySelector('.sidebar')?.scrollTo(0, 0)`);
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

  await page.evaluate(`void document.querySelector('.workbench')?.scrollTo(0, 0)`);
  await sleep(700);
  const graphCollapsedShot = await page.shoot(
    'v8-architecture-collapsed.png',
    'the architecture graph at the report’s collapsed top level: ESP32 and its four setup() branches, every node projected from hardware-map.json',
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
  const graphExpandedShot = await page.shoot(
    'v8-architecture-servos-expanded.png',
    'Servos expanded: movement → setServoAngle → ESP32Servo → LEDC → GPIO → MG90S → eight joints, every node backed by a hardware-map.json path and a firmware file:line',
  );

  // -------------------------------------------------- fire a command, by click
  await page.evaluate('window.__sesame.reset()');
  const worldBefore = await page.evaluate('window.__sesame.worldFrame()');
  const traceClick = await page.evaluate(`(() => {
    const button = document.querySelector('[data-command="wave"]');
    if (button === null) return { ok: false, why: 'no [data-command="wave"] button in the DOM' };
    if (button.disabled) return { ok: false, why: 'the wave button is disabled' };
    button.click();
    return { ok: true, why: button.textContent };
  })()`);
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
  const domRows = await page.evaluate(
    `Array.from(document.querySelectorAll('[data-trace-row]')).map((n) => ({
       layer: n.getAttribute('data-layer'),
       rank: Number(n.getAttribute('data-rank')),
     }))`,
  );
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

  // The workbench is two fixed halves, so the trace is already on screen; what
  // needs scrolling is the row list inside it, down to the row this feature is
  // really about.
  await sleep(350);
  const traceShot = await page.shoot(
    'v8-see-the-signal.png',
    'the causal trace for one Wave: eight layers, each with its own provenance, origin and a witness clause — and pwm.output marked INFERRED FOR EXPLANATION with the real ESP32Servo-quantised pulse beside it',
  );

  // The row the whole feature exists for, brought into view: this is where
  // "the code said 180 deg" and "a servo would have gone there" separate.
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
  const hitRows = await page.evaluate(
    `Array.from(document.querySelectorAll('[data-trace-row].hit')).map((n) => ({
       layer: n.getAttribute('data-layer'),
       joint: n.getAttribute('data-joint'),
     }))`,
  );
  check(
    hitRows.length > 0 && hitRows.every((r) => r.joint === 'L3'),
    `selecting L3 highlighted ${JSON.stringify(hitRows)} in the trace; every highlighted row must ` +
      `be an L3 row`,
  );
  check(
    hitRows.some((r) => r.layer === 'servo.target') && hitRows.some((r) => r.layer === 'pwm.output'),
    `selecting L3 did not highlight its servo.target and pwm.output rows: ${JSON.stringify(hitRows)}`,
  );

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
    },
    worldFrame: {
      toleranceMm: FRAME_EPS_MM,
      worstDriftMm: worstHere,
      footContactSpreadMm: spreadHere,
      samples: framesHere.length,
    },
    shots: [graphCollapsedShot.name, graphExpandedShot.name, traceShot.name, pwmShot.name],
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
  await page.evaluate(`(() => {
    const context = document.querySelector('.source-context');
    const note = document.querySelector('[data-teaching-note="TN-007"]');
    if (!context || !note) return false;
    context.scrollTop += note.getBoundingClientRect().top - context.getBoundingClientRect().top - 8;
    return true;
  })()`);
  await sleep(350);
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
    await qemuPage.evaluate(`void document.querySelector('.sidebar')?.scrollTo(0, 0)`);
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
      check(
        facts.oledFramebuffer === false,
        'the backend claims an OLED framebuffer; QEMU attaches no SSD1306 to this machine',
      );
      check(
        Array.isArray(facts.elided) && facts.elided.includes('ssd1306-panel'),
        `the elided list does not mention the panel: ${JSON.stringify(facts.elided)}`,
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
    const readRenderedHonesty = async () =>
      JSON.parse(
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
    const clicked = await evaluate(`(() => {
      const button = document.querySelector('[data-command="wave"]');
      if (button === null) return { ok: false, why: 'no [data-command="wave"] button in the DOM' };
      if (button.disabled) return { ok: false, why: 'the wave button is disabled' };
      button.click();
      return { ok: true, why: button.textContent };
    })()`);
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

    // ------------------------------------------------------- the OLED, honestly
    const oled6 = await evaluate('window.__sesame.oled()');
    const elidedNote = await evaluate(
      `document.querySelector('[data-testid="oled-elided"]')?.innerText ?? ''`,
    );
    check(
      oled6.source.pixelProvenance === null || oled6.source.pixelProvenance === 'inferred',
      `the OLED claims its pixels are ${JSON.stringify(oled6.source.pixelProvenance)}. QEMU ` +
        `transmits no framebuffer, so any pixels on screen were drawn host-side and are inferred`,
    );
    check(
      /did not come from the emulator/i.test(elidedNote),
      'the OLED panel does not say that its pixels were not produced by the emulator, even though ' +
        'ssd1306-panel is in the elided list',
    );

    const snapshot6 = await evaluate('window.__sesame.snapshot()');
    check(
      typeof snapshot6.canvasPixels === 'number' && snapshot6.canvasPixels > 2000,
      `only ${snapshot6.canvasPixels} non-background pixels came out of the WebGL drawing buffer`,
    );
    check(
      snapshot6.renderStats !== null && snapshot6.renderStats.frames > 10,
      `the render loop drew ${snapshot6.renderStats?.frames} frames — every reading above is stale`,
    );

    await evaluate(`void document.querySelector('.sidebar')?.scrollTo(0, 0)`);
    await sleep(400);
    const waveShot = await labPage.shoot(
      'v3-browser-qemu-commanded-wave.png',
      'a browser button drove real Sesame firmware: POST /api/command -> the firmware’s serial console under QEMU -> 29 @SESAME servo events -> these quaternions. Labelled emulated, on the legacy V1 board, not a measurement.',
    );
    await evaluate(
      `void document.querySelector('[data-testid="oled"]')?.scrollIntoView({ block: 'start' })`,
    );
    await sleep(400);
    await labPage.shoot(
      'v4-browser-qemu-oled-inferred.png',
      'the OLED under QEMU: the firmware emitted a face NAME and no pixels (ssd1306-panel is elided), so the framebuffer is drawn host-side and labelled inferred rather than presented as the emulator’s output',
    );

    const labErrors = labPage.errors();
    check(
      labErrors.length === 0,
      `the QEMU-commanded page logged ${labErrors.length} error(s): ${labErrors.slice(0, 3).join(' | ')}`,
    );

    phases.qemuCommanded = {
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
        elidedNoteShown: /did not come from the emulator/i.test(elidedNote),
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
    `one-byte-tampered copy of it` +
    (phases.qemuCommanded?.ran === true
      ? `; a clicked button drove real firmware under QEMU and every joint it moved carries ` +
        `origin.kind="emulator" with isPhysicallyObserved() false`
      : ''),
);
process.exit(0);
