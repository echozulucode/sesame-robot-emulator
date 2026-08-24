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
async function startBridge({ replay = null, uartPort = null, provenance = null, quiet = true } = {}) {
  const wsPort = await freePort();
  // The bridge's UART listener defaults to 3456, and the checked-in Renode
  // script and the QEMU work both use that port. A capture run has no UART peer
  // at all in the replay phases, so give it a free port rather than letting an
  // unrelated concurrent process on 3456 abort the whole harness.
  if (uartPort === null) uartPort = await freePort();
  const args = [BRIDGE_CLI, '--ws-port', String(wsPort), '--serve-viewer', '--viewer-dir', APP_DIST];
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

await waitFor(
  page.evaluate,
  'typeof window.__sesame !== "undefined" && window.__sesame.ready',
  (v) => v === true,
  'the app to load assets/sesame.glb and build the rig',
  60000,
);
console.log('[web] app loaded, rig built');

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

  // The scene must follow the telemetry, not lead it — checked once the render
  // loop has caught up, so this is a correctness assertion and not a race.
  await waitSceneCaughtUp();
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

reportPageErrors('replay session');
page.close();
try {
  replayBridge.proc.kill();
} catch {
  /* gone */
}
await sleep(400);

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
    `stand pose verified in-browser; all three backends drove the same scene` +
    (phases.qemuCommanded?.ran === true
      ? `; a clicked button drove real firmware under QEMU and every joint it moved carries ` +
        `origin.kind="emulator" with isPhysicallyObserved() false`
      : ''),
);
process.exit(0);
