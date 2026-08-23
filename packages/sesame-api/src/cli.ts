#!/usr/bin/env node
/**
 * `sesame-api` — run the compatibility proxy in front of the behaviour model.
 *
 * This is the **only** file in the package that knows `SimulatedSesameRobot`
 * exists. The library, the adapter and the contract suite are all backend-blind
 * (`no-sim-coupling.test.ts` asserts it), so pointing this at a QEMU-backed or
 * physical robot later is a change to one `import` and one constructor call.
 *
 * ```
 * pnpm --filter @sesame-lab/sesame-api start -- --realtime
 * curl -s http://127.0.0.1:8080/api/status
 * curl -s -XPOST -d '{"command":"wave"}' http://127.0.0.1:8080/api/command
 * ```
 */
import { SimulatedSesameRobot } from '@sesame-lab/sesame-sim';

import { startSesameApi } from './server.js';

const USAGE = `sesame-api — Sesame-compatible HTTP proxy over a robot backend

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

interface Args {
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

async function main(): Promise<void> {
  const parsed = parseArgs(process.argv.slice(2));
  if (parsed === 'help') {
    process.stdout.write(USAGE);
    return;
  }

  const robot = new SimulatedSesameRobot(
    parsed.realtime ? { timeMode: 'realtime' } : {},
    parsed.realtime ? { speed: parsed.speed } : {},
  );
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
        `  backend    SimulatedSesameRobot (${parsed.realtime ? `realtime x${String(parsed.speed)}` : 'virtual time'})`,
        `  methods    ${parsed.strictMethods ? 'strict (DIVERGES: upstream is HTTP_ANY)' : 'any (upstream)'}`,
        `  commands   ${parsed.strictCommands ? 'strict (DIVERGES: upstream sinks unknown words)' : 'firmware (unknown words sink)'}`,
        `  provenance every response is simulated; nothing here has touched hardware`,
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
