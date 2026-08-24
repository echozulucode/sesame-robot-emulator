#!/usr/bin/env node
/**
 * The lab host — what makes a **browser button drive real firmware**.
 *
 * `apps/web` runs in a browser. `@sesame-lab/sesame-qemu` spawns processes and
 * opens sockets. Something has to sit between them, and this is it:
 *
 * ```text
 *  browser button
 *    -> POST /api/command {"command":"wave"}          the FIRMWARE's own route
 *    -> SesameApiAdapter (@sesame-lab/sesame-api, unmodified)
 *    -> QemuSesameRobot.command('wave')
 *    -> "rn wv" on UART0 of a real ESP32 image executing under QEMU
 *    -> @SESAME servo lines back out of the same UART
 *    -> robot.subscribe() -> GET /lab/stream (SSE) -> the same 3D scene
 * ```
 *
 * ## Why the HTTP adapter rather than the bridge's `--allow-control`
 *
 * Both work (Q2 §2.4), and the bridge path was the tempting one because the
 * WebSocket already carries telemetry. Three things decided it the other way:
 *
 * 1. **One protocol regardless of backend.** `SesameApiAdapter` fronts *any*
 *    `SesameRobot`. The browser's "wave" button posts the same body to the same
 *    path whether a simulator, QEMU or (one day) a physical robot is behind it,
 *    and the contract suite already exercises that exact adapter — C07–C15 pass
 *    through it against `QemuSesameRobot`. A bespoke `{v:2,type:'command'}`
 *    WebSocket frame would be a second command vocabulary that nothing else
 *    speaks.
 * 2. **Origin.** `QemuSesameRobot` stamps `QEMU_ORIGIN` on every event it
 *    emits, so `origin.kind === 'emulator'`, the board and the elided
 *    subsystems all arrive in the browser *from the thing that knows them*. The
 *    bridge's envelope has an `origin` field, but it means something else
 *    (`'uart' | 'bridge'`) and carries no `TelemetryOrigin` at all — so on that
 *    path the browser would have to assert "this is an emulator" on its own
 *    authority, which is exactly the claim `origin` exists to stop anyone
 *    making without evidence.
 * 3. **Boot honesty.** `connect()` takes 2–17 s and may retry past
 *    ISSUE-20260823-022. The robot object knows how many attempts it burned;
 *    a UART socket does not.
 *
 * The two `/lab/*` endpoints are the only thing here that is not firmware
 * parity, and they exist because HTTP parity cannot express them: the firmware
 * has no telemetry stream and no way to say "I am an emulator".
 *
 * ## What it will not do
 *
 * Binds loopback only, with no opt-out flag. The `sesame-api` server has
 * `--allow-remote` because it is a general tool; this is a lab host that also
 * *serves an app which posts commands to itself*, so publishing it would hand
 * anyone on the network a robot and a UI for it.
 *
 * ```
 * node apps/web/server/lab-host.mjs --port 8099            # QEMU (default)
 * node apps/web/server/lab-host.mjs --backend sim          # same wire, no emulator
 * ```
 */
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { SesameApiAdapter } from '@sesame-lab/sesame-api';
import { isPhysicallyObserved } from '@sesame-lab/sesame-protocol';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '../../..');

const USAGE = `lab-host — serve apps/web and drive a Node-only robot backend from it

  --backend qemu|sim   which SesameRobot to put behind /api/*  (default qemu)
  --port <n>           listen port (default 0 = ask the OS)
  --dist <dir>         static root (default apps/web/dist)
  --no-static          do not serve files; API + /lab/* only (for vite dev)
  --quiet              no progress lines on stderr
  --help               this text
`;

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(`--${name}`);
const valueOf = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : fallback;
};
if (flag('help')) {
  process.stdout.write(USAGE);
  process.exit(0);
}

const BACKEND = valueOf('backend', 'qemu');
const PORT = Number(valueOf('port', '0'));
const DIST = path.resolve(REPO, valueOf('dist', 'apps/web/dist'));
const SERVE_STATIC = !flag('no-static');
const QUIET = flag('quiet');

const log = (line) => {
  if (!QUIET) process.stderr.write(`[lab] ${line}\n`);
};

// ===========================================================================
// Session state — everything the UI needs to not mislead a learner
// ===========================================================================

/**
 * The ring buffer exists for the same reason the bridge's does: the firmware
 * says `@SESAME hello` and paints the `rest` face at the end of `setup()`,
 * which is over before a browser has finished loading a 1.28 MB GLB. Without a
 * replay the app would connect to a stream that had already said everything
 * interesting and looks, to a learner, like a backend that emits nothing.
 */
const RING_MAX = 4000;
const ring = [];
let ringBase = 0; // number of events dropped off the front

/** @type {Set<{write: (chunk: string) => void}>} */
const streams = new Set();

const session = {
  backend: BACKEND,
  /** `booting` | `ready` | `failed` */
  phase: 'starting',
  detail: 'process starting',
  startedAtMs: Date.now(),
  connectedAtMs: null,
  /** Attempts consumed so far. Live during boot, authoritative after. */
  attempts: 0,
  /** Failed attempts, i.e. ISSUE-20260823-022 firings. */
  failedAttempts: 0,
  attemptLog: [],
  events: 0,
  /** Events for which `isPhysicallyObserved()` was true. Expected: zero. */
  physicallyObservedEvents: 0,
  error: null,
  capabilities: null,
  origin: null,
  robotState: null,
};

function broadcast(event) {
  ring.push(event);
  if (ring.length > RING_MAX) {
    ring.shift();
    ringBase += 1;
  }
  session.events += 1;
  if (isPhysicallyObserved(event)) session.physicallyObservedEvents += 1;
  const frame = `data: ${JSON.stringify({ n: ringBase + ring.length, event })}\n\n`;
  for (const stream of streams) {
    try {
      stream.write(frame);
    } catch {
      streams.delete(stream);
    }
  }
}

// ===========================================================================
// The robot
// ===========================================================================

async function makeRobot() {
  if (BACKEND === 'sim') {
    const { SimulatedSesameRobot } = await import('@sesame-lab/sesame-sim');
    return new SimulatedSesameRobot({ timeMode: 'realtime' }, { speed: 1 });
  }
  if (BACKEND !== 'qemu') throw new Error(`unknown --backend ${BACKEND}`);
  const { QemuSesameRobot } = await import('@sesame-lab/sesame-qemu');
  return new QemuSesameRobot({
    logger: (message) => {
      // The only live view of a retry. `bootAttempts` is not assigned until
      // launchWithRetry() returns, and a connect that needs seven attempts is
      // seventeen seconds of silence otherwise — which is the exact shape of
      // the under-measurement Q2 §1.1 started from.
      const failed = /boot attempt (\d+) failed: (.*)$/.exec(message);
      if (failed !== null) {
        session.failedAttempts += 1;
        session.attempts = session.failedAttempts + 1;
        session.attemptLog.push({ attempt: Number(failed[1]), ok: false, reason: failed[2] });
        session.detail =
          `boot attempt ${failed[1]} panicked (ISSUE-20260823-022) — relaunching. ` +
          `${failed[2].slice(0, 120)}`;
        log(session.detail);
      }
    },
  });
}

const robot = await makeRobot();
const adapter = new SesameApiAdapter({ robot, logger: (m) => log(m) });

robot.subscribe(broadcast);

session.phase = 'booting';
session.attempts = 1;
session.detail =
  BACKEND === 'qemu'
    ? 'launching qemu-system-xtensa and waiting for the firmware’s own end-of-setup() banner'
    : 'powering on the behaviour model';

const connectPromise = robot
  .connect()
  .then(async () => {
    session.phase = 'ready';
    session.connectedAtMs = Date.now();
    const attempts = robot.bootAttempts ?? [];
    if (Array.isArray(attempts) && attempts.length > 0) {
      session.attempts = attempts.length;
      session.failedAttempts = attempts.filter((a) => !a.ok).length;
      session.attemptLog = attempts.map((a) => ({ ...a }));
    }
    session.capabilities = await robot.capabilities();
    session.origin = session.capabilities?.origin ?? robot.origin ?? null;
    session.detail =
      `${BACKEND} backend ready in ${session.connectedAtMs - session.startedAtMs} ms ` +
      `after ${session.attempts} boot attempt(s)`;
    log(session.detail);
  })
  .catch((error) => {
    session.phase = 'failed';
    session.error = String(error?.message ?? error);
    session.detail = session.error;
    log(`connect failed: ${session.error}`);
  });

// ===========================================================================
// HTTP
// ===========================================================================

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.glb': 'model/gltf-binary',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
  '.ico': 'image/x-icon',
};

function staticFileFor(pathname) {
  if (!SERVE_STATIC) return null;
  const clean = pathname === '/' ? '/index.html' : pathname;
  // Path traversal: resolve then require containment. `..%2f` decodes before
  // this point, so the containment check is the one that has to hold.
  const resolved = path.resolve(DIST, `.${decodeURIComponent(clean)}`);
  if (resolved !== DIST && !resolved.startsWith(DIST + path.sep)) return null;
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) return null;
  return resolved;
}

async function sessionPayload() {
  // The robot's own state, so `observed.everObserved` and `bootAttempts` come
  // from the backend rather than from anything this file remembers.
  try {
    session.robotState = await robot.getState();
  } catch (error) {
    session.robotState = null;
    void error;
  }
  const now = Date.now();
  return {
    ...session,
    elapsedMs: (session.connectedAtMs ?? now) - session.startedAtMs,
    streamClients: streams.size,
    ringEvents: ring.length,
  };
}

function readBody(req, limit = 64 * 1024) {
  return new Promise((resolve, reject) => {
    let body = '';
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
      body += chunk.toString('utf8');
    });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

const server = http.createServer((req, res) => {
  void (async () => {
    const url = req.url ?? '/';
    const pathname = url.split('?')[0];

    // --------------------------------------------------------------- /lab/*
    if (pathname === '/lab/session') {
      const payload = await sessionPayload();
      const body = JSON.stringify(payload);
      res.writeHead(200, {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
      });
      res.end(body);
      return;
    }

    if (pathname === '/lab/stream') {
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-store',
        connection: 'keep-alive',
        'x-accel-buffering': 'no',
      });
      // Replay first, then live. Same contract as the bridge's ring buffer:
      // a movement that finished before the browser opened still appears.
      for (const [i, event] of ring.entries()) {
        res.write(`data: ${JSON.stringify({ n: ringBase + i + 1, event })}\n\n`);
      }
      const client = { write: (chunk) => res.write(chunk) };
      streams.add(client);
      const keepAlive = setInterval(() => {
        try {
          res.write(': keep-alive\n\n');
        } catch {
          /* closing */
        }
      }, 15000);
      req.on('close', () => {
        clearInterval(keepAlive);
        streams.delete(client);
      });
      return;
    }

    // ------------------------------------------------------------- statics
    if (req.method === 'GET' || req.method === 'HEAD') {
      const file = staticFileFor(pathname);
      if (file !== null) {
        const type = MIME[path.extname(file).toLowerCase()] ?? 'application/octet-stream';
        res.writeHead(200, { 'content-type': type, 'cache-control': 'no-store' });
        if (req.method === 'HEAD') res.end();
        else fs.createReadStream(file).pipe(res);
        return;
      }
    }

    // -------------------------------------------- the ten firmware routes
    let body = '';
    try {
      body = await readBody(req);
    } catch {
      res.writeHead(413, { 'content-type': 'text/plain' });
      res.end('Payload Too Large');
      return;
    }

    if (session.phase === 'booting') {
      // A command posted mid-boot must not look like a command that ran.
      res.writeHead(503, { 'content-type': 'application/json', 'retry-after': '3' });
      res.end(
        JSON.stringify({
          error: 'backend still booting',
          phase: session.phase,
          attempts: session.attempts,
          detail: session.detail,
        }),
      );
      return;
    }
    if (session.phase === 'failed') {
      res.writeHead(503, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: session.error, phase: 'failed' }));
      return;
    }

    const response = await adapter.handle({
      method: req.method ?? 'GET',
      url,
      headers: Object.fromEntries(
        Object.entries(req.headers).map(([k, v]) => [k, Array.isArray(v) ? v[0] : v]),
      ),
      body,
    });
    res.writeHead(response.status, {
      'content-type': response.contentType,
      'cache-control': 'no-store',
      ...(response.headers ?? {}),
    });
    res.end(response.body);
  })().catch((error) => {
    try {
      res.writeHead(500, { 'content-type': 'text/plain' });
      res.end(String(error?.message ?? error));
    } catch {
      /* already sent */
    }
  });
});

server.listen(PORT, '127.0.0.1', () => {
  const { port } = server.address();
  adapter.setApIp('127.0.0.1');
  process.stdout.write(`lab-host http://127.0.0.1:${port}/\n`);
  process.stdout.write(`lab-host backend ${BACKEND}\n`);
  if (SERVE_STATIC) process.stdout.write(`lab-host static ${DIST}\n`);
});

let stopping = false;
const shutdown = () => {
  if (stopping) return;
  stopping = true;
  server.close();
  void connectPromise.finally(() =>
    Promise.resolve(robot.disconnect())
      .catch(() => undefined)
      .then(() => process.exit(0)),
  );
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
