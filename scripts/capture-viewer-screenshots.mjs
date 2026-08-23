#!/usr/bin/env node
/**
 * Phase-0 closeout — evidence for the plan's "a joint visibly moving in the
 * browser".
 *
 * R7 proved the pipeline as far as the WebSocket boundary with an automated
 * test, and the definition of done says *browser*. Nothing in the repository
 * recorded a browser ever rendering the stream, so the last hop was unevidenced.
 * This closes it with a real browser engine, not a simulated one.
 *
 * What it does:
 *   1. starts the real bridge on the `runWavePose` replay fixture, serving
 *      debug-viewer/ over the same HTTP server (`--serve-viewer`);
 *   2. launches the machine's own Edge/Chrome in `--headless=new` with the
 *      DevTools protocol enabled — zero install, no puppeteer, no npm dep;
 *   3. navigates to the viewer and then *reads the rendered canvas back*,
 *      deriving each joint's angle from the pixel width of its bar. That is
 *      the assertion: it fails if the browser renders nothing, renders the
 *      wrong joints, or renders them in the wrong order;
 *   4. waits for two DIFFERENT points in the wave — L3 at 100 deg and L3 at
 *      180 deg — and screenshots each. Two frames, because one static frame
 *      does not prove motion.
 *
 * The screenshots are byte-compared: identical images would mean the second
 * capture was the same frame and the "motion" claim would be unearned.
 *
 * Usage: node scripts/capture-viewer-screenshots.mjs [--out <dir>] [--keep-open]
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
const outDir = path.resolve(REPO, argv.includes('--out') ? argv[argv.indexOf('--out') + 1] : 'docs/findings/assets');

// The firmware enum order. The viewer must render in THIS order; alphabetising
// it would silently rewire four servos, so the check is on the order too.
const JOINT_ORDER = ['R1', 'R2', 'L1', 'L2', 'R4', 'R3', 'L3', 'L4'];

// Steady-state angles during runWavePose after the t=420 ms setup, read from
// emulator/bridge/fixtures/wave-pose.replay.jsonl. L3 is the joint that waves.
const EXPECTED_STEADY = { R1: 100, R2: 45, L1: 45, L2: 90, R4: 80, R3: 180, L4: 180 };

// ------------------------------------------------------------------- browser
const CANDIDATES = [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  process.env.CHROME_PATH,
].filter(Boolean);
const browser = CANDIDATES.find((p) => fs.existsSync(p));
if (!browser) {
  console.error('[viewer] no Edge or Chrome found. Set CHROME_PATH to a Chromium binary.');
  process.exit(3);
}

const freePort = () => new Promise((res, rej) => {
  const s = net.createServer();
  s.on('error', rej);
  s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => res(port)); });
});

const children = [];
const cleanup = () => { for (const c of children) { try { c.kill(); } catch { /* already gone */ } } };
process.on('exit', cleanup);

const fail = (msg) => { console.error(`FAIL  ${msg}`); cleanup(); process.exit(1); };

// --------------------------------------------------------------------- bridge
const wsPort = await freePort();
const bridgeArgs = [
  path.join(REPO, 'emulator/bridge/dist/cli.js'),
  '--replay', path.join(REPO, 'emulator/bridge/fixtures/wave-pose.replay.jsonl'),
  '--loop', '--serve-viewer', '--ws-port', String(wsPort), '--quiet',
];
const bridge = spawn(process.execPath, bridgeArgs, { cwd: REPO, stdio: ['ignore', 'pipe', 'pipe'] });
children.push(bridge);
let bridgeOut = '';
bridge.stdout.on('data', (d) => { bridgeOut += d.toString(); });
bridge.stderr.on('data', (d) => { bridgeOut += d.toString(); });

const viewerUrl = await new Promise((res, rej) => {
  const t = setTimeout(() => rej(new Error(`bridge did not print a viewer URL:\n${bridgeOut}`)), 15000);
  const poll = setInterval(() => {
    const m = /viewer\s+(http:\/\/\S+)/.exec(bridgeOut);
    if (m) { clearInterval(poll); clearTimeout(t); res(m[1]); }
    if (bridge.exitCode !== null) { clearInterval(poll); clearTimeout(t); rej(new Error(`bridge exited ${bridge.exitCode}:\n${bridgeOut}`)); }
  }, 100);
}).catch((e) => fail(e.message));
console.log(`[viewer] bridge up, serving ${viewerUrl}`);

// ------------------------------------------------------------------ chromium
const cdpPort = await freePort();
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'sesame-viewer-'));
const chrome = spawn(browser, [
  '--headless=new',
  `--remote-debugging-port=${cdpPort}`,
  `--user-data-dir=${profile}`,
  '--window-size=1400,900',
  '--hide-scrollbars', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  '--disable-extensions', '--disable-background-timer-throttling',
  '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows',
  viewerUrl,
], { stdio: ['ignore', 'pipe', 'pipe'] });
children.push(chrome);
let chromeErr = '';
chrome.stderr.on('data', (d) => { chromeErr += d.toString(); });
console.log(`[viewer] ${path.basename(browser)} --headless=new, CDP on ${cdpPort}`);

// Wait for the DevTools endpoint, then find the page target.
const deadline = Date.now() + 30000;
let target = null;
while (Date.now() < deadline && !target) {
  try {
    const list = await (await fetch(`http://127.0.0.1:${cdpPort}/json/list`)).json();
    target = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
  } catch { /* not listening yet */ }
  if (!target) await new Promise((r) => setTimeout(r, 200));
}
if (!target) fail(`the browser never exposed a CDP page target.\n${chromeErr}`);

const sock = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((res, rej) => { sock.onopen = res; sock.onerror = () => rej(new Error('CDP socket failed')); })
  .catch((e) => fail(e.message));

let nextId = 1;
const pending = new Map();
sock.onmessage = (m) => {
  const msg = JSON.parse(m.data);
  if (msg.id && pending.has(msg.id)) {
    const { res, rej } = pending.get(msg.id);
    pending.delete(msg.id);
    msg.error ? rej(new Error(`${msg.error.message}`)) : res(msg.result);
  }
};
const cdp = (method, params = {}) => new Promise((res, rej) => {
  const id = nextId++;
  pending.set(id, { res, rej });
  sock.send(JSON.stringify({ id, method, params }));
  setTimeout(() => { if (pending.delete(id)) rej(new Error(`${method} timed out`)); }, 20000);
});

await cdp('Page.enable');
await cdp('Runtime.enable');
await cdp('Page.navigate', { url: viewerUrl });
await new Promise((r) => setTimeout(r, 1500));

/**
 * Read the joint angles back OUT of the rendered canvas.
 *
 * The viewer draws each joint as a bar whose filled width is `angle/180` of the
 * track, in a blue that nothing else on the canvas uses. Deriving the angle
 * from pixels — rather than from a variable — means this asserts what a human
 * would actually see, and it fails if the page renders nothing at all.
 */
const READ_CANVAS = `(() => {
  const order = ${JSON.stringify(JOINT_ORDER)};
  const c = document.getElementById('joints');
  if (!c) return { error: 'no #joints canvas' };
  const x = c.getContext('2d');
  const W = c.width, H = c.height, rowH = H / order.length, barX = 62, barW = W - 62 - 54;
  const out = {};
  for (let i = 0; i < order.length; i++) {
    const y = Math.round(i * rowH + rowH / 2);
    const row = x.getImageData(barX, y, barW, 1).data;
    let last = -1;
    for (let px = 0; px < barW; px++) {
      const r = row[px * 4], g = row[px * 4 + 1], b = row[px * 4 + 2];
      // fillStyle is rgb(110, 128..168, 214..254); the empty track is #22262f.
      if (r > 90 && r < 130 && g > 110 && g < 190 && b > 200) last = px;
    }
    out[order[i]] = last < 0 ? null : Math.round(((last + 1) / barW) * 180);
  }
  return {
    angles: out,
    connection: (document.getElementById('conn') || {}).textContent,
    counts: (document.getElementById('counts') || {}).textContent,
    provenance: (document.getElementById('prov') || {}).textContent,
    face: (document.getElementById('face') || {}).textContent,
    canvas: W + 'x' + H,
  };
})()`;

const readCanvas = async () => {
  const r = await cdp('Runtime.evaluate', { expression: READ_CANVAS, returnByValue: true });
  return r.result.value;
};

/** Poll the rendered canvas until L3 reads within tolerance of `want`. */
async function waitForL3(want, tolerance = 4, timeoutMs = 25000) {
  const stop = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < stop) {
    const s = await readCanvas();
    last = s;
    if (s && s.angles && s.angles.L3 !== null && Math.abs(s.angles.L3 - want) <= tolerance) return s;
    await new Promise((r) => setTimeout(r, 60));
  }
  fail(`the viewer never rendered L3 at ${want} deg. Last read: ${JSON.stringify(last)}`);
  return null;
}

fs.mkdirSync(outDir, { recursive: true });
const shots = [];
for (const [want, name, caption] of [
  [100, 'exp8-browser-l3-100.png', 'L3 down (100 deg)'],
  [180, 'exp8-browser-l3-180.png', 'L3 up (180 deg)'],
]) {
  const state = await waitForL3(want);
  const shot = await cdp('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  const buf = Buffer.from(shot.data, 'base64');
  const file = path.join(outDir, name);
  fs.writeFileSync(file, buf);
  const sha = crypto.createHash('sha256').update(buf).digest('hex');
  shots.push({ file, name, caption, bytes: buf.length, sha256: sha, state });
  console.log(`[viewer] ${caption}: ${path.relative(REPO, file).replaceAll('\\', '/')} (${buf.length} B)  angles=${JSON.stringify(state.angles)}`);
}

// ------------------------------------------------------------------ assertions
const problems = [];
const check = (c, m) => { if (!c) problems.push(m); };

check(shots.length === 2, 'did not capture two screenshots');
check(shots[0].sha256 !== shots[1].sha256, 'the two screenshots are byte-identical — nothing moved between them');
for (const s of shots) {
  check(s.bytes > 5000, `${s.name} is only ${s.bytes} bytes — the page probably rendered blank`);
  check(/connected/i.test(s.state.connection ?? ''), `${s.name}: viewer status is "${s.state.connection}", not connected`);
  check(s.state.canvas === '720x330', `${s.name}: joint canvas is ${s.state.canvas}`);
  check(Object.keys(s.state.angles).length === 8, `${s.name}: ${Object.keys(s.state.angles).length} joints rendered, expected 8`);
  for (const [j, want] of Object.entries(EXPECTED_STEADY)) {
    const got = s.state.angles[j];
    check(got !== null && Math.abs(got - want) <= 4, `${s.name}: joint ${j} rendered ${got} deg, fixture says ${want} deg`);
  }
}
check(Math.abs(shots[0].state.angles.L3 - 100) <= 4, `first capture L3 = ${shots[0].state.angles.L3}, wanted 100`);
check(Math.abs(shots[1].state.angles.L3 - 180) <= 4, `second capture L3 = ${shots[1].state.angles.L3}, wanted 180`);

const summary = {
  capturedAt: new Date().toISOString(),
  browser: { path: browser, headless: 'new' },
  viewerUrl,
  fixture: 'emulator/bridge/fixtures/wave-pose.replay.jsonl (runWavePose)',
  jointOrderAssertedInBrowser: JOINT_ORDER,
  method: 'joint angles derived from the rendered canvas pixel widths over CDP Runtime.evaluate; images via Page.captureScreenshot',
  shots: shots.map((s) => ({
    file: path.relative(REPO, s.file).replaceAll('\\', '/'),
    caption: s.caption, bytes: s.bytes, sha256: s.sha256,
    renderedAngles: s.state.angles, connection: s.state.connection,
    counts: s.state.counts, provenance: s.state.provenance, face: s.state.face,
  })),
  ok: problems.length === 0,
};
fs.writeFileSync(path.join(outDir, 'exp8-browser-capture.json'), `${JSON.stringify(summary, null, 2)}\n`);

try { sock.close(); } catch { /* closing anyway */ }
cleanup();
try { fs.rmSync(profile, { recursive: true, force: true }); } catch { /* windows file locks */ }

if (problems.length) {
  console.error(`FAIL  browser capture — ${problems.length} problem(s):`);
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}
console.log('OK    two real-browser renders captured, joint values read back from the rendered canvas, images differ');
process.exit(0);
