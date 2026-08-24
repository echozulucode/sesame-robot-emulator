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
 *      differs by an anti-aliasing seed.
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
 *      TCP socket, the same unmodified bridge, the same unmodified app. This is
 *      the one phase whose telemetry is `observed`.
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
  const downShot = await page.shoot(
    'v3-browser-wave-l3-100.png',
    'runWavePose, L3 down (100°) — simulated backend',
  );
  const up = await atL3(180);
  const upShot = await page.shoot(
    'v3-browser-wave-l3-180.png',
    'runWavePose, L3 up (180°) — simulated backend',
  );

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
  for (const shot of [downShot, upShot]) {
    check(shot.bytes > 8000, `${shot.name} is only ${shot.bytes} bytes — the page probably rendered blank`);
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
    const ok =
      observed.provenance.driving === 'observed' && driven.length > 0 && observed.canvasPixels > 2000;
    if (!ok) {
      notes.push(
        `QEMU phase ran but did not fully satisfy its checks: driving=${observed.provenance.driving}, ` +
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
      jointsDriven: driven.map((j) => ({ joint: j.joint, deg: j.storeCommandedDeg })),
      canvasPixels: observed.canvasPixels,
      note:
        'This is the only phase whose telemetry is `observed`: the bytes came out of firmware that ' +
        'really executed. The bridge was not modified for it — a live --uart-port socket is what it ' +
        'was built for.',
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
    `stand pose verified in-browser; both backends drove the same scene`,
);
process.exit(0);
