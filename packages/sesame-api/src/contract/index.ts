/**
 * `describeRobotContract` — the backend-agnostic conformance suite.
 *
 * The research report's architectural claim is that lesson code, the browser
 * robot, the REST console and the tests all talk to one `SesameRobot`, and the
 * thing behind it is a swap. A claim like that is worth exactly as much as the
 * test that holds every candidate backend to it, so this is that test.
 *
 * ## Adding a backend
 *
 * ```ts
 * import { describe, it } from 'vitest';
 * import { describeRobotContract } from '@sesame-lab/sesame-api/contract';
 * import { QemuSesameRobot } from '…';
 *
 * describeRobotContract(() => new QemuSesameRobot({ … }), {
 *   name: 'QemuSesameRobot',
 *   runner: { describe, it },
 * });
 * ```
 *
 * That is the entire integration. **No case in this file changes**, no case
 * knows what it is running against, and nothing here imports a concrete robot:
 * the factory is the only injection point, and `@sesame-lab/sesame-sim` appears
 * nowhere in this module's imports (`no-sim-coupling.test.ts` enforces that).
 *
 * A backend that cannot satisfy a case must fail it. The cases are written
 * against the *firmware*, not against the simulator — including the two that
 * assert an upstream bug is still present, because a backend that quietly fixed
 * ISSUE-20260823-004 would put a face on the panel that the real robot does not
 * show, and every lesson built on it would be teaching a robot that does not
 * exist.
 *
 * ## What the runner has to provide
 *
 * `describe` and `it`, structurally. Vitest, Jest, `node:test` (via a two-line
 * shim) — the suite does not import a test framework, so it does not force one
 * on a consumer, and `dist/` carries no dev dependency.
 */
import assert from 'node:assert/strict';

import { JOINT_ORDER, type JointName, type RobotState } from '@sesame-lab/sesame-model';
import type { SesameTelemetry, ServoTargetEvent } from '@sesame-lab/sesame-protocol';
import type { SesameRobot } from '@sesame-lab/sesame-sim';

import { SesameApiAdapter, type ApiRequest, type ApiResponse } from '../adapter.js';
import { RemoteBindRefusedError, SesameApiServer } from '../server.js';

// ---------------------------------------------------------------------------
// Injection points
// ---------------------------------------------------------------------------

/** Produce a fresh, *unconnected* backend. Called once per case. */
export type RobotFactory = () => SesameRobot | Promise<SesameRobot>;

/** The two functions any test framework provides. Structural on purpose. */
export interface ContractRunner {
  describe(name: string, fn: () => void): void;
  it(name: string, fn: () => Promise<void> | void): void;
}

/** What a case is handed. */
export interface ContractContext {
  readonly robot: SesameRobot;
  readonly adapter: SesameApiAdapter;
  /** Every event the backend has emitted since `connect()`. */
  readonly events: readonly SesameTelemetry[];
  /** Drop everything collected so far, so a case can assert on a window. */
  clearEvents(): void;
  /** Servo writes only, in order. */
  servoWrites(): readonly ServoTargetEvent[];
  /** Issue one HTTP request through the adapter, no socket involved. */
  request(request: ApiRequest): Promise<ApiResponse>;
  /** Convenience: `GET path`. */
  get(path: string): Promise<ApiResponse>;
  /** Convenience: `POST path` with a JSON content type. */
  postJson(path: string, body: string): Promise<ApiResponse>;
  /**
   * Every face and command name the adapter actually handed the backend.
   *
   * The boundary is between the HTTP layer and the robot, so this is where a
   * sanitisation failure is observable — before the backend gets a chance to
   * swallow a hostile name silently (which a faithful one will: an unknown face
   * emits no event at all, ISSUE-20260823-004).
   */
  boundaryTokens(): { readonly faces: readonly string[]; readonly commands: readonly string[] };
}

/** One requirement, with the provenance that makes it a requirement. */
export interface ContractCase {
  readonly id: string;
  readonly title: string;
  /** Why this must hold, in one sentence. */
  readonly requirement: string;
  /** `file:line`, an ISSUE id, or a findings document. */
  readonly provenance: string;
  run(ctx: ContractContext): Promise<void>;
}

export interface DescribeRobotContractOptions {
  /** Suite label. Default `'SesameRobot contract'`. */
  readonly name?: string;
  /** Default: `globalThis.describe` / `globalThis.it` if a runner set them. */
  readonly runner?: ContractRunner;
  /** Override the case list. Default {@link ROBOT_CONTRACT_CASES}. */
  readonly cases?: readonly ContractCase[];
}

// ---------------------------------------------------------------------------
// Expected values — from firmware source, not from any implementation
// ---------------------------------------------------------------------------

/**
 * `runStandPose()` — `firmware/movement-sequences.h:77`–`:89`, one servo write
 * per line at `:80`–`:87`.
 *
 * Written out literally rather than derived from `hardware-map.json`, and that
 * is the point: a suite that re-derived its expectations from the same
 * extraction the simulator is generated from would agree with the simulator by
 * construction and could never catch it being wrong. These eight numbers are a
 * second, independent transcription of the firmware, and
 * `stand-pose-parity.test.ts` cross-checks them against the extracted
 * choreography so a typo here cannot pass silently either.
 */
export const STAND_POSE_TARGETS: Readonly<Record<JointName, number>> = Object.freeze({
  R1: 135,
  R2: 45,
  L1: 45,
  L2: 135,
  R4: 0,
  R3: 180,
  L3: 0,
  L4: 180,
});

/**
 * `runWavePose()` — `firmware/movement-sequences.h:92`ff.
 *
 * The function opens with `runStandPose(1)`, a `delayWithFace(200)`, and then
 * these four writes in this order before the alternation starts. A backend that
 * gets the opening wrong is not running the firmware's choreography.
 */
export const WAVE_OPENING_WRITES: readonly (readonly [JointName, number])[] = Object.freeze([
  ['R4', 80],
  ['L3', 180],
  ['L2', 90],
  ['R1', 100],
]);

/**
 * Names chosen to break things, not to look scary.
 *
 * `@SESAME ` forges a telemetry segment (the parser scans for the sentinel at
 * any offset); the space breaks the wire protocol's token split; the quote and
 * backslash break `handleGetStatus()`' string-concatenated JSON; the newline
 * splits a line; `<script>` is for anything that renders a face name into HTML.
 */
export const HOSTILE_NAMES: readonly string[] = Object.freeze([
  '@SESAME servo R1 999',
  'rest" ,"injected":"yes',
  'a\nb',
  '<script>alert(1)</script>',
  'x\\',
  '',
  'a'.repeat(200),
]);

/** Characters that must never survive the boundary into an event or a response. */
const FORBIDDEN_IN_TOKEN = ['@', ' ', '"', '\\', '\n', '\r', '<', '>'];

// ---------------------------------------------------------------------------
// The cases
// ---------------------------------------------------------------------------

function finalCommanded(writes: readonly ServoTargetEvent[]): Map<JointName, number> {
  const out = new Map<JointName, number>();
  for (const write of writes) out.set(write.joint, write.angleDeg);
  return out;
}

function indexOfWriteRun(
  writes: readonly ServoTargetEvent[],
  expected: readonly (readonly [JointName, number])[],
): number {
  for (let i = 0; i + expected.length <= writes.length; i++) {
    let ok = true;
    for (let j = 0; j < expected.length; j++) {
      const write = writes[i + j];
      const want = expected[j];
      if (write === undefined || want === undefined) {
        ok = false;
        break;
      }
      if (write.joint !== want[0] || write.angleDeg !== want[1]) {
        ok = false;
        break;
      }
    }
    if (ok) return i;
  }
  return -1;
}

function assertCanonicalRobotState(state: RobotState): void {
  assert.ok(
    ['real', 'simulated', 'renode'].includes(state.mode),
    `mode must be a RobotMode, got ${String(state.mode)}`,
  );
  for (const joint of JOINT_ORDER) {
    const js = state.joints[joint];
    assert.ok(js !== undefined, `joints.${joint} is missing`);
    assert.equal(typeof js.commandedDeg, 'number', `joints.${joint}.commandedDeg must be a number`);
    assert.ok(
      Number.isFinite(js.commandedDeg) && js.commandedDeg >= 0 && js.commandedDeg <= 180,
      `joints.${joint}.commandedDeg must be within the firmware clamp 0..180`,
    );
    // HAS_JOINT_POSITION_FEEDBACK is false for every Sesame that exists. A
    // backend that fills this in is claiming a sensor the robot does not have.
    assert.ok(
      js.measuredDeg === null || js.measuredDeg === undefined,
      `joints.${joint}.measuredDeg must be null: the stock robot has no position feedback`,
    );
  }
  assert.equal(state.face.width, 128);
  assert.equal(state.face.height, 64);
  assert.equal(typeof state.face.expression, 'string');
  assert.equal(typeof state.face.frame, 'number');
  assert.ok(
    ['unavailable', 'ap', 'station', 'simulated'].includes(state.network.state),
    `network.state must be a NetworkState, got ${String(state.network.state)}`,
  );
  assert.equal(typeof state.motion, 'object');
}

/** Every requirement a Sesame backend must satisfy, in order. */
export const ROBOT_CONTRACT_CASES: readonly ContractCase[] = Object.freeze([
  {
    id: 'C01',
    title: 'stand reaches the eight expected joint targets',
    requirement:
      'command("stand") commands every one of the eight channels to the angle runStandPose writes.',
    provenance: 'firmware/movement-sequences.h:77-89',
    async run(ctx) {
      ctx.clearEvents();
      await ctx.robot.command('stand');
      const final = finalCommanded(ctx.servoWrites());
      for (const joint of JOINT_ORDER) {
        assert.equal(
          final.get(joint),
          STAND_POSE_TARGETS[joint],
          `${joint} should end at ${String(STAND_POSE_TARGETS[joint])}`,
        );
      }
      const state = await ctx.robot.getState();
      for (const joint of JOINT_ORDER) {
        assert.equal(state.joints[joint].commandedDeg, STAND_POSE_TARGETS[joint]);
      }
    },
  },
  {
    id: 'C02',
    title: 'wave begins with the expected sequence',
    requirement:
      'command("wave") stands up first, then writes R4=80, L3=180, L2=90, R1=100 in that order.',
    provenance: 'firmware/movement-sequences.h:92ff',
    async run(ctx) {
      ctx.clearEvents();
      await ctx.robot.command('wave');
      const writes = ctx.servoWrites();
      assert.ok(writes.length >= 12, `wave should write at least 12 servo targets`);

      const standRun = JOINT_ORDER.map(
        (joint) => [joint, STAND_POSE_TARGETS[joint]] as readonly [JointName, number],
      );
      assert.equal(indexOfWriteRun(writes, standRun), 0, 'wave must open with a full stand pose');

      const openingAt = indexOfWriteRun(writes, WAVE_OPENING_WRITES);
      assert.equal(
        openingAt,
        JOINT_ORDER.length,
        'the four wave-setup writes must follow the stand pose immediately',
      );
    },
  },
  {
    id: 'C03',
    title: 'setFace("rest") makes the face state rest',
    requirement:
      'A face with real bitmaps updates both the event stream and the reported face state.',
    provenance: 'firmware/sesame-firmware-main.ino:903, :904; rest has 3 frames',
    async run(ctx) {
      // Boot already set `rest` (setup(), :747), and `setFace()`'s first
      // statement is `if (name == currentFaceName) return;` (:904) — so asking
      // for it again is genuinely a no-op on the robot. Move away first, or
      // this case would be testing the early return rather than the face.
      await ctx.robot.setFace('happy');
      ctx.clearEvents();
      await ctx.robot.setFace('rest');
      const faceEvents = ctx.events.filter((e) => e.type === 'face.expression');
      assert.ok(faceEvents.length >= 1, 'setFace("rest") must emit a face event');
      assert.equal(faceEvents[0]?.name, 'rest');
      const state = await ctx.robot.getState();
      assert.equal(state.face.expression, 'rest');
    },
  },
  {
    id: 'C04',
    title: 'setFace("stand") emits nothing — ISSUE-20260823-004 is reproduced, not fixed',
    requirement:
      'epd_bitmap_stand is a weak, never-defined symbol: countFrames() returns 0, the fallback ' +
      'table is also empty, updateFaceBitmap() is never reached, and currentFaceName is ' +
      'silently rewritten to "default". A backend that emits a face here is showing the user ' +
      'something the robot cannot show.',
    provenance: 'ISSUE-20260823-004; firmware/face-bitmaps.h:52; F4 §1.6',
    async run(ctx) {
      await ctx.robot.setFace('rest');
      ctx.clearEvents();
      await ctx.robot.setFace('stand');
      const faceEvents = ctx.events.filter((e) => e.type === 'face.expression');
      assert.equal(
        faceEvents.length,
        0,
        'setFace("stand") must emit no face event at all — the bitmap does not exist',
      );
      const state = await ctx.robot.getState();
      assert.notEqual(
        state.face.expression,
        'stand',
        'currentFaceName is rewritten away from "stand" by the empty-frame fallback',
      );
    },
  },
  {
    id: 'C05',
    title: 'an invalid command does not move the robot',
    requirement:
      'Either the backend rejects the word (a simulator that refuses to wedge) or it accepts it ' +
      'and does nothing forever (the firmware sink). Both are acceptable; moving is not.',
    provenance: 'hardware-map.json commands.dispatchNote; unresolved[unknown-command-sink]',
    async run(ctx) {
      ctx.clearEvents();
      let rejected = false;
      try {
        await ctx.robot.command('not-a-real-command');
      } catch {
        rejected = true;
      }
      assert.equal(
        ctx.servoWrites().length,
        0,
        'an unrecognised command must not produce servo writes',
      );
      // Named so a reader sees that both branches are legal, deliberately.
      void rejected;
    },
  },
  {
    id: 'C06',
    title: 'getState returns a canonical RobotState',
    requirement:
      'All eight joints, clamped angles, a null measuredDeg, a 128x64 face, and enum-valid mode ' +
      'and network state.',
    provenance: '@sesame-lab/sesame-model state.ts',
    async run(ctx) {
      assertCanonicalRobotState(await ctx.robot.getState());
      await ctx.robot.command('stand');
      assertCanonicalRobotState(await ctx.robot.getState());
    },
  },
  {
    id: 'C07',
    title: 'GET /api/status returns the firmware key set',
    requirement:
      'currentCommand, currentFace, networkConnected and apIP are always present; networkIP only ' +
      'when connected.',
    provenance: 'firmware/sesame-firmware-main.ino:289-301',
    async run(ctx) {
      const res = await ctx.get('/api/status');
      assert.equal(res.status, 200);
      assert.equal(res.contentType, 'application/json');
      const parsed = JSON.parse(res.body) as Record<string, unknown>;
      assert.equal(typeof parsed['currentCommand'], 'string');
      assert.equal(typeof parsed['currentFace'], 'string');
      assert.equal(typeof parsed['networkConnected'], 'boolean');
      assert.equal(typeof parsed['apIP'], 'string');
      if (parsed['networkConnected'] === false) {
        assert.ok(!('networkIP' in parsed), 'networkIP appears only when connected');
      }
    },
  },
  {
    id: 'C08',
    title: 'POST /api/command runs a movement, and answers before it finishes',
    requirement:
      'The handler sets currentCommand and replies 200 immediately; loop() runs the movement ' +
      'afterwards. A proxy that awaited the choreography would hang every browser client.',
    provenance: 'firmware/sesame-firmware-main.ino:375-386, :231',
    async run(ctx) {
      ctx.clearEvents();
      const res = await ctx.postJson('/api/command', '{"command":"stand"}');
      assert.equal(res.status, 200);
      assert.deepEqual(JSON.parse(res.body), { status: 'ok', message: 'Command executed' });
      await ctx.adapter.drain();
      const final = finalCommanded(ctx.servoWrites());
      for (const joint of JOINT_ORDER) {
        assert.equal(final.get(joint), STAND_POSE_TARGETS[joint]);
      }
    },
  },
  {
    id: 'C09',
    title: '/api/status reports a face that is not on screen after stand',
    requirement:
      'Every pose ends with runStandPose(1), which requests the non-existent "stand" bitmap, so ' +
      'the reported face is the fallback name while the panel still shows the previous frame. ' +
      'This is the observable half of ISSUE-20260823-004 and must reach the API unlaundered.',
    provenance: 'ISSUE-20260823-004; F4 §1.6 ("/api/status will then report a face that is not being displayed")',
    async run(ctx) {
      await ctx.robot.setFace('rest');
      await ctx.robot.command('stand');
      const parsed = JSON.parse((await ctx.get('/api/status')).body) as Record<string, unknown>;
      assert.notEqual(
        parsed['currentFace'],
        'stand',
        'the API must not invent a face the firmware never drew',
      );
    },
  },
  {
    id: 'C10',
    title: 'every route answers any verb, and only two check the method',
    requirement:
      'All ten routes register HTTP_ANY. /api/command and /api/wifi/connect answer 405 for ' +
      'non-POST from inside their handlers; nothing else restricts a verb.',
    provenance: 'F4 §1.9; ISSUE-20260823-005 item 4; hardware-map.json routeRegistrationNote',
    async run(ctx) {
      assert.equal((await ctx.request({ method: 'DELETE', url: '/getSettings' })).status, 200);
      assert.equal((await ctx.request({ method: 'PUT', url: '/api/status' })).status, 200);
      assert.equal((await ctx.request({ method: 'POST', url: '/cmd?pose=stand' })).status, 200);
      assert.equal((await ctx.get('/api/command')).status, 405);
      assert.equal((await ctx.get('/api/wifi/connect')).status, 405);
      await ctx.adapter.drain();
    },
  },
  {
    id: 'C11',
    title: 'unmatched paths: JSON 404 under /api/, portal 200 everywhere else',
    requirement:
      'handleNotFound() keeps a typo\'d API path from getting 200 + HTML, and keeps every other ' +
      'path returning the captive portal so OS connectivity checks trigger it.',
    provenance: 'firmware/sesame-firmware-main.ino:643-649',
    async run(ctx) {
      const api = await ctx.get('/api/nope');
      assert.equal(api.status, 404);
      assert.deepEqual(JSON.parse(api.body), { error: 'Not found' });

      const portal = await ctx.get('/generate_204');
      assert.equal(portal.status, 200, 'a captive-portal probe must get the portal, not a 404');
      assert.equal(portal.contentType, 'text/html');
    },
  },
  {
    id: 'C12',
    title: 'an argument with no "=" does not exist',
    requirement:
      'WebServer::_parseArguments discards a token with no value, so /cmd?stop is Bad Args and ' +
      '/cmd?stop= is OK. Clients written against the README get this wrong.',
    provenance: 'Arduino-ESP32 3.3.11 WebServer/src/Parsing.cpp:335-342',
    async run(ctx) {
      const noEquals = await ctx.get('/cmd?stop');
      assert.equal(noEquals.status, 400);
      assert.equal(noEquals.body, 'Bad Args');

      const withEquals = await ctx.get('/cmd?stop=');
      assert.equal(withEquals.status, 200);
      assert.equal(withEquals.body, 'OK');
    },
  },
  {
    id: 'C13',
    title: 'hostile face and command names are sanitised at the boundary',
    requirement:
      'Nothing that arrives over HTTP may forge an @SESAME segment, break the wire protocol\'s ' +
      'token split, or escape out of the string-concatenated JSON /api/status builds.',
    provenance: 'docs/findings/R6-R7-telemetry-bridge.md; telemetry-instrumentation.patch:105',
    async run(ctx) {
      for (const hostile of HOSTILE_NAMES) {
        ctx.clearEvents();
        await ctx.postJson('/api/command', JSON.stringify({ face: hostile }));
        await ctx.postJson('/api/command', JSON.stringify({ command: hostile }));
        await ctx.get(`/cmd?pose=${encodeURIComponent(hostile)}`);
        await ctx.adapter.drain();

        // The primary assertion: what the adapter handed the backend. Checking
        // the event stream alone would pass vacuously, because a hostile name
        // is an unknown face and an unknown face emits nothing.
        const tokens = ctx.boundaryTokens();
        for (const token of [...tokens.faces, ...tokens.commands]) {
          for (const bad of FORBIDDEN_IN_TOKEN) {
            assert.ok(
              !token.includes(bad),
              `${JSON.stringify(token)} reached the backend carrying ${JSON.stringify(bad)}, ` +
                `from ${JSON.stringify(hostile)}`,
            );
          }
        }

        for (const event of ctx.events) {
          if (event.type !== 'face.expression') continue;
          for (const bad of FORBIDDEN_IN_TOKEN) {
            assert.ok(
              !event.name.includes(bad),
              `face event carried ${JSON.stringify(bad)} from ${JSON.stringify(hostile)}`,
            );
          }
        }

        const status = await ctx.get('/api/status');
        // The real assertion: it still parses. Upstream does not escape these
        // fields, so a bare quote in currentCommand produces invalid JSON.
        const parsed = JSON.parse(status.body) as Record<string, unknown>;
        for (const key of ['currentCommand', 'currentFace'] as const) {
          const value = parsed[key];
          assert.equal(typeof value, 'string');
          for (const bad of FORBIDDEN_IN_TOKEN) {
            assert.ok(
              !(value as string).includes(bad),
              `${key} carried ${JSON.stringify(bad)} from ${JSON.stringify(hostile)}`,
            );
          }
        }
      }
    },
  },
  {
    id: 'C14',
    title: 'the server binds loopback by default and refuses a remote bind without opt-in',
    requirement:
      'A Sesame Lab compatibility proxy must not casually publish a robot control API onto a ' +
      'wider network. The firmware has no TLS and no auth; that is only acceptable on loopback.',
    provenance:
      'docs/plans/phase-1-virtual-mvp.md §3 V5; hardware-map.json network.http.tls/authentication',
    async run(ctx) {
      const server = new SesameApiServer({ robot: ctx.robot });
      assert.equal(server.host, '127.0.0.1');
      try {
        const port = await server.listen();
        assert.ok(port > 0);
        const address = server.server.address();
        assert.ok(address !== null && typeof address !== 'string');
        assert.equal(address.address, '127.0.0.1', 'the listener must be on loopback');
      } finally {
        await server.close();
      }

      assert.throws(
        () => new SesameApiServer({ robot: ctx.robot, host: '0.0.0.0' }),
        RemoteBindRefusedError,
        'binding 0.0.0.0 without allowRemote must throw',
      );
    },
  },
  {
    id: 'C15',
    title: 'the settings round-trip survives',
    requirement:
      '/setSettings accepts each of the four keys independently, floors faceFps at 1, and ' +
      'validates nothing else. /getSettings returns exactly those four keys.',
    provenance: 'firmware/sesame-firmware-main.ino:270-286',
    async run(ctx) {
      const before = JSON.parse((await ctx.get('/getSettings')).body) as Record<string, number>;
      assert.deepEqual(Object.keys(before).sort(), [
        'faceFps',
        'frameDelay',
        'motorCurrentDelay',
        'walkCycles',
      ]);

      assert.equal((await ctx.get('/setSettings?walkCycles=3&faceFps=0')).status, 200);
      const after = JSON.parse((await ctx.get('/getSettings')).body) as Record<string, number>;
      assert.equal(after['walkCycles'], 3);
      assert.equal(after['faceFps'], 1, 'faceFps is max(1L, …)');
      assert.equal(after['frameDelay'], before['frameDelay'], 'an absent key is left alone');
    },
  },
]);

// ---------------------------------------------------------------------------
// The runner
// ---------------------------------------------------------------------------

function resolveRunner(explicit: ContractRunner | undefined): ContractRunner {
  if (explicit !== undefined) return explicit;
  const globals = globalThis as Partial<ContractRunner>;
  if (typeof globals.describe === 'function' && typeof globals.it === 'function') {
    return { describe: globals.describe.bind(globalThis), it: globals.it.bind(globalThis) };
  }
  throw new Error(
    'describeRobotContract: no describe/it in scope. Pass { runner: { describe, it } } — ' +
      'this package deliberately does not depend on a test framework.',
  );
}

/**
 * A pass-through decorator that records what crosses the adapter/backend
 * boundary. Behaviourally transparent — every call is delegated unchanged.
 */
class RecordingRobot implements SesameRobot {
  readonly faces: string[] = [];
  readonly commands: string[] = [];

  constructor(private readonly inner: SesameRobot) {}

  connect(): Promise<void> {
    return this.inner.connect();
  }
  disconnect(): Promise<void> {
    return this.inner.disconnect();
  }
  capabilities(): ReturnType<SesameRobot['capabilities']> {
    return this.inner.capabilities();
  }
  command(name: string): Promise<void> {
    this.commands.push(name);
    return this.inner.command(name);
  }
  setFace(name: string): Promise<void> {
    this.faces.push(name);
    return this.inner.setFace(name);
  }
  setJoint(joint: JointName, angleDeg: number): Promise<void> {
    return this.inner.setJoint(joint, angleDeg);
  }
  setPose(pose: Partial<Record<JointName, number>>): Promise<void> {
    return this.inner.setPose(pose);
  }
  getState(): Promise<RobotState> {
    return this.inner.getState();
  }
  subscribe(listener: (event: SesameTelemetry) => void): () => void {
    return this.inner.subscribe(listener);
  }
}

/** Build a fresh context: connect the backend, wire an adapter over it. */
async function createContext(
  createRobot: RobotFactory,
): Promise<{ ctx: ContractContext; dispose: () => Promise<void> }> {
  const robot = new RecordingRobot(await createRobot());
  let events: SesameTelemetry[] = [];
  const unsubscribe = robot.subscribe((event) => events.push(event));
  await robot.connect();

  const adapter = new SesameApiAdapter({ robot, logger: () => undefined });

  const request = (req: ApiRequest): Promise<ApiResponse> => adapter.handle(req);

  const ctx: ContractContext = {
    robot,
    adapter,
    boundaryTokens: () => ({ faces: [...robot.faces], commands: [...robot.commands] }),
    get events() {
      return events;
    },
    clearEvents() {
      events = [];
      // `events` is read through the getter, so replacing the array is enough.
    },
    servoWrites() {
      return events.filter((e): e is ServoTargetEvent => e.type === 'servo.target');
    },
    request,
    get: (path) => request({ method: 'GET', url: path }),
    postJson: (path, body) =>
      request({
        method: 'POST',
        url: path,
        headers: { 'content-type': 'application/json' },
        body,
      }),
  };

  return {
    ctx,
    dispose: async () => {
      await adapter.drain();
      unsubscribe();
      await robot.disconnect();
    },
  };
}

/**
 * Register the whole contract against one backend.
 *
 * Each case gets its own robot from `createRobot`, so a case that wedges the
 * backend cannot leak into the next one.
 */
export function describeRobotContract(
  createRobot: RobotFactory,
  options: DescribeRobotContractOptions = {},
): void {
  const runner = resolveRunner(options.runner);
  const cases = options.cases ?? ROBOT_CONTRACT_CASES;
  const name = options.name ?? 'SesameRobot contract';

  runner.describe(name, () => {
    for (const testCase of cases) {
      runner.it(`${testCase.id} · ${testCase.title}`, async () => {
        const { ctx, dispose } = await createContext(createRobot);
        try {
          await testCase.run(ctx);
        } finally {
          await dispose();
        }
      });
    }
  });
}
