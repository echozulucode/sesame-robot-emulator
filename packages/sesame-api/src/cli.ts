#!/usr/bin/env node
/**
 * `sesame-api` — run the compatibility proxy in front of a robot backend.
 *
 * This is the **only** file in the package that knows which backends exist. The
 * library, the adapter and the contract suite are all backend-blind
 * (`backend-agnostic.test.ts` asserts it), which is what made `--backend qemu`
 * a change to this file and nothing else.
 *
 * ```
 * pnpm --filter @sesame-lab/sesame-api start -- --realtime
 * curl -s http://127.0.0.1:8080/api/status
 * curl -s -XPOST -d '{"command":"wave"}' http://127.0.0.1:8080/api/command
 *
 * # the same ten routes, in front of firmware that is actually executing:
 * node packages/sesame-api/dist/cli.js --backend qemu
 * curl -s -XPOST -d '{"command":"wave"}' http://127.0.0.1:8080/api/command
 * ```
 *
 * ## `--backend qemu`, and what it does not give you
 *
 * `QemuSesameRobot` satisfies the same `SesameRobot` contract, so every route
 * works over it — but three things about the resulting server are different and
 * a caller must not be left to discover them:
 *
 * - **It is not the robot's web server.** `capabilities().httpApi` is `false`
 *   for that backend: the firmware's own HTTP server needs a radio, and QEMU
 *   models none. This is a *host-side proxy* speaking to the firmware's serial
 *   console. The banner says so.
 * - **`connect()` takes 2–17 s and may retry**, past a QEMU cache-modelling bug
 *   (ISSUE-20260823-022, 28% per boot). The banner reports how many attempts it
 *   burned rather than hiding a slow start.
 * - **Nothing it reports is a measurement.** Every event that backend emits
 *   carries `origin.kind === 'emulator'` on the legacy `distro-v1-esp32` board,
 *   and `isPhysicallyObserved()` is false for all of them.
 *
 * The import is dynamic so that the default path never loads a package that
 * spawns processes and opens sockets.
 */
import type { SesameRobot } from '@sesame-lab/sesame-sim';

import { startSesameApi } from './server.js';

const USAGE = `sesame-api — Sesame-compatible HTTP proxy over a robot backend

  --backend <name>    sim (default) | qemu. \`qemu\` puts the ten firmware
                      routes in front of real Sesame firmware executing under
                      Espressif QEMU, commanded over the firmware's own serial
                      console. It is a HOST-SIDE PROXY: that backend reports
                      httpApi:false because QEMU models no radio, so this is
                      not the robot's own web server. Boot takes 2-17 s and may
                      retry past ISSUE-20260823-022.
  --port <n>          listen port (default 8080; 0 asks the OS. The robot uses
                      80, which is privileged on most hosts — parity is about
                      paths and payloads, not port numbers)
  --host <addr>       bind address (default 127.0.0.1)
  --allow-remote      permit a non-loopback bind. Publishes an unauthenticated
                      robot control API to the network. Prints a warning.
  --realtime          run the behaviour model at wall-clock speed instead of
                      draining each movement instantly. Also the mode in which
                      an HTTP request can be serviced *inside* a movement, the
                      way delayWithFace() does on the robot.
  --speed <x>         real-time multiplier (implies --realtime)
  --strict-methods    reject verbs firmware/README.md does not document.
                      A divergence: upstream registers every route HTTP_ANY.
  --strict-commands   400 on a command word outside the vocabulary.
                      A divergence: upstream sets it and does nothing forever.
  --browser-guard     reject cross-origin browser requests (CSRF / DNS-rebind
                      hardening). Off by default for upstream parity.
  --ap-ip <addr>      what /api/status reports as apIP (default: the bind host)
  --quiet             no startup banner
  --help              this text
`;

type BackendName = 'sim' | 'qemu';

interface Args {
  backend: BackendName;
  port: number;
  host: string;
  allowRemote: boolean;
  realtime: boolean;
  speed: number;
  strictMethods: boolean;
  strictCommands: boolean;
  browserGuard: boolean;
  apIp: string | undefined;
  quiet: boolean;
}

function parseArgs(argv: readonly string[]): Args | 'help' {
  const args: Args = {
    backend: 'sim',
    port: 8080,
    host: '127.0.0.1',
    allowRemote: false,
    realtime: false,
    speed: 1,
    strictMethods: false,
    strictCommands: false,
    browserGuard: false,
    apIp: undefined,
    quiet: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const next = (): string => {
      const value = argv[++i];
      if (value === undefined) throw new Error(`${String(flag)} needs a value`);
      return value;
    };
    switch (flag) {
      case '--help':
      case '-h':
        return 'help';
      case '--backend': {
        const value = next();
        if (value !== 'sim' && value !== 'qemu') {
          throw new Error(`--backend must be sim or qemu, got ${value}`);
        }
        args.backend = value;
        break;
      }
      case '--port':
        args.port = Number(next());
        break;
      case '--host':
        args.host = next();
        break;
      case '--allow-remote':
        args.allowRemote = true;
        break;
      case '--realtime':
        args.realtime = true;
        break;
      case '--speed':
        args.speed = Number(next());
        args.realtime = true;
        break;
      case '--strict-methods':
        args.strictMethods = true;
        break;
      case '--strict-commands':
        args.strictCommands = true;
        break;
      case '--browser-guard':
        args.browserGuard = true;
        break;
      case '--ap-ip':
        args.apIp = next();
        break;
      case '--quiet':
        args.quiet = true;
        break;
      default:
        throw new Error(`unknown flag: ${String(flag)}`);
    }
  }
  return args;
}

/**
 * Construct the requested backend.
 *
 * `describe()` is deferred rather than a string because the QEMU banner has to
 * report `bootAttempts`, which does not exist until `connect()` has returned.
 */
async function makeBackend(
  args: Args,
): Promise<{ robot: SesameRobot; describe: () => string }> {
  if (args.backend === 'qemu') {
    const { QemuSesameRobot, QEMU_ORIGIN } = await import('@sesame-lab/sesame-qemu');
    const robot = new QemuSesameRobot();
    return {
      robot,
      describe: () => {
        const attempts = robot.bootAttempts;
        const failed = attempts.filter((a) => !a.ok).length;
        return (
          `QemuSesameRobot (${QEMU_ORIGIN.engine ?? 'qemu'}, board ${QEMU_ORIGIN.board ?? '?'}) ` +
          `— booted after ${String(attempts.length)} attempt(s)` +
          (failed === 0
            ? ''
            : `, ${String(failed)} of which panicked (ISSUE-20260823-022, a QEMU cache-modelling ` +
              `bug this retries past rather than fixes)`)
        );
      },
    };
  }
  const { SimulatedSesameRobot } = await import('@sesame-lab/sesame-sim');
  const robot = new SimulatedSesameRobot(
    args.realtime ? { timeMode: 'realtime' } : {},
    args.realtime ? { speed: args.speed } : {},
  );
  return {
    robot,
    describe: () =>
      `SimulatedSesameRobot (${args.realtime ? `realtime x${String(args.speed)}` : 'virtual time'})`,
  };
}

async function main(): Promise<void> {
  const parsed = parseArgs(process.argv.slice(2));
  if (parsed === 'help') {
    process.stdout.write(USAGE);
    return;
  }

  const { robot, describe } = await makeBackend(parsed);
  await robot.connect();

  const api = await startSesameApi({
    robot,
    host: parsed.host,
    port: parsed.port,
    allowRemote: parsed.allowRemote,
    methodPolicy: parsed.strictMethods ? 'strict' : 'any',
    commandVocabulary: parsed.strictCommands ? 'strict' : 'firmware',
    browserGuard: parsed.browserGuard,
    ...(parsed.apIp === undefined ? {} : { apIp: parsed.apIp }),
  });

  if (!parsed.quiet) {
    process.stdout.write(
      [
        `sesame-api listening on ${String(api.url)}`,
        `  backend    ${describe()}`,
        `  methods    ${parsed.strictMethods ? 'strict (DIVERGES: upstream is HTTP_ANY)' : 'any (upstream)'}`,
        `  commands   ${parsed.strictCommands ? 'strict (DIVERGES: upstream sinks unknown words)' : 'firmware (unknown words sink)'}`,
        `  provenance ${
          parsed.backend === 'qemu'
            ? 'emulated (qemu-system-xtensa, distro-v1-esp32 — the LEGACY V1 board). ' +
              'Real firmware executed; no hardware did. isPhysicallyObserved() is false ' +
              'for every event this backend emits.'
            : 'every response is simulated; nothing here has touched hardware'
        }`,
        '',
        `  try: curl -s ${String(api.url)}/api/status`,
        '',
      ].join('\n'),
    );
  }

  const shutdown = (): void => {
    void api.close().then(() => robot.disconnect());
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((error: unknown) => {
  process.stderr.write(`${String(error)}\n`);
  process.exitCode = 1;
});
