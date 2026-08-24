#!/usr/bin/env node
/**
 * `sesame-qemu` — the bidirectional demo.
 *
 * Q1 could only show telemetry coming *out*: the firmware was built with
 * `currentCommand = "wave"` injected into `setup()`, so it waved once at power
 * on and there was no way to ask it for anything. The whole point of this
 * program is the other arrow. It boots an image with **no** injected movement,
 * writes a command word to UART0, and prints the servo events the firmware
 * emits in response — same wire, opposite direction.
 *
 * ```
 * node packages/sesame-qemu/dist/cli.js --command wave
 * node packages/sesame-qemu/dist/cli.js --command stand --face happy
 * node packages/sesame-qemu/dist/cli.js --command wave --json
 * ```
 *
 * Exit code is 0 only if the commanded movement actually produced servo
 * telemetry, so this doubles as a smoke test.
 */
import { isPhysicallyObserved, type SesameTelemetry } from '@sesame-lab/sesame-protocol';

import { QemuSesameRobot } from './robot.js';
import { DEFAULT_IMAGE_PATH, DEFAULT_QEMU_PATH } from './config.js';

interface Args {
  command: string;
  face: string | null;
  image: string;
  qemu: string;
  json: boolean;
  verbose: boolean;
}

function parseArgs(argv: readonly string[]): Args {
  const args: Args = {
    command: 'wave',
    face: null,
    image: DEFAULT_IMAGE_PATH,
    qemu: DEFAULT_QEMU_PATH,
    json: false,
    verbose: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i] ?? '';
    const next = (): string => {
      const value = argv[++i];
      if (value === undefined) {
        process.stderr.write(`sesame-qemu: ${token} requires a value\n`);
        process.exit(2);
      }
      return value;
    };
    switch (token) {
      case '--command':
        args.command = next();
        break;
      case '--face':
        args.face = next();
        break;
      case '--image':
        args.image = next();
        break;
      case '--qemu':
        args.qemu = next();
        break;
      case '--json':
        args.json = true;
        break;
      case '--verbose':
        args.verbose = true;
        break;
      case '--help':
      case '-h':
        process.stdout.write(USAGE);
        process.exit(0);
        break;
      default:
        // Unrecognised flags are refused rather than ignored: emulator/qemu's
        // own args.mjs has the same rule, for the same reason — a silently
        // ignored flag produces a full, expensive run that looks obedient.
        process.stderr.write(`sesame-qemu: unknown option ${token}\n\n${USAGE}`);
        process.exit(2);
    }
  }
  return args;
}

const USAGE = `Boot real Sesame firmware under QEMU, command it over UART0, and print what comes back.

usage: node dist/cli.js [options]

  --command <word>  movement word to run (default: wave)
  --face <name>     set a face first
  --image <path>    flash image (default: distro-v1-esp32-cli.flash.bin)
  --qemu <path>     qemu-system-xtensa binary
  --json            machine-readable output
  --verbose         echo QEMU's own stderr and every boot attempt
  --help            show this message
`;

const args = parseArgs(process.argv.slice(2));

const robot = new QemuSesameRobot({
  imagePath: args.image,
  qemuPath: args.qemu,
  ...(args.verbose ? { logger: (m: string) => process.stderr.write(`${m}\n`) } : {}),
});

const events: SesameTelemetry[] = [];
robot.subscribe((event) => events.push(event));

const say = (line: string): void => {
  if (!args.json) process.stdout.write(`${line}\n`);
};

const bootStarted = Date.now();
say('booting real Sesame firmware under Espressif QEMU...');
await robot.connect();
const bootMs = Date.now() - bootStarted;

const attempts = robot.bootAttempts;
say(
  `booted in ${String(bootMs)} ms after ${String(attempts.length)} attempt(s)` +
    (attempts.length > 1 ? '  <- ISSUE-20260823-022 fired and was retried past' : ''),
);
say(`  qemu pid ${String(robot.session?.pid)}, UART0 on tcp/${String(robot.session?.port)}`);

const bootEvents = events.length;
say(`  ${String(bootEvents)} telemetry events during boot`);

try {
  if (args.face !== null) {
    events.length = 0;
    say(`\n--> setFace(${JSON.stringify(args.face)})`);
    await robot.setFace(args.face);
    say(`    sent: ${JSON.stringify((await robot.getState()).observed.lastCommandLine)}`);
    const faces = events.filter((e) => e.type === 'face.expression');
    say(
      faces.length === 0
        ? '    <- nothing. An unknown or bitmap-less face draws nothing (ISSUE-20260823-004).'
        : `    <- ${String(faces.length)} face frame(s): ${faces.map((f) => `${f.name}:${String(f.frame ?? 0)}`).join(' ')}`,
    );
  }

  events.length = 0;
  const commandStarted = Date.now();
  say(`\n--> command(${JSON.stringify(args.command)})`);
  await robot.command(args.command);
  const commandMs = Date.now() - commandStarted;

  const state = await robot.getState();
  const servo = events.filter((e) => e.type === 'servo.target');
  const faces = events.filter((e) => e.type === 'face.expression');

  say(`    sent on UART0: ${JSON.stringify(state.observed.lastCommandLine)}`);
  say(`    firmware ran it in ${String(commandMs)} ms and replied with:`);
  say(`      ${String(servo.length)} servo.target`);
  say(`      ${String(faces.length)} face.expression`);
  say(`      ${String(events.length - servo.length - faces.length)} log`);
  say('');
  for (const event of servo.slice(0, 12)) {
    say(`      @SESAME servo ${event.joint} ${String(event.angleDeg)}`);
  }
  if (servo.length > 12) say(`      ... ${String(servo.length - 12)} more`);

  say('\n    joint state, from telemetry only:');
  for (const [joint, js] of Object.entries(state.joints)) {
    const seen = state.observed.everObserved[joint as keyof typeof state.observed.everObserved];
    say(
      `      ${joint.padEnd(3)} ${String(js.commandedDeg).padStart(3)}deg  ` +
        `${seen ? 'observed' : 'ASSUMED (never written by the firmware)'}`,
    );
  }

  const anyPhysical = events.some((e) => isPhysicallyObserved(e));
  say('\n    provenance:');
  say(`      provenance ......... observed  (the firmware hook really ran)`);
  say(`      origin.kind ........ ${String(robot.origin.kind)}`);
  say(`      origin.board ....... ${String(robot.origin.board)}   <- the LEGACY V1 board`);
  say(`      origin.elided ...... ${(robot.origin.elided ?? []).join(', ')}`);
  say(`      isPhysicallyObserved on any event: ${String(anyPhysical)}   <- must be false`);

  if (args.json) {
    process.stdout.write(
      `${JSON.stringify(
        {
          bootMs,
          bootAttempts: attempts,
          command: args.command,
          commandLine: state.observed.lastCommandLine,
          commandMs,
          servoEvents: servo.length,
          faceEvents: faces.length,
          joints: state.joints,
          everObserved: state.observed.everObserved,
          origin: robot.origin,
          anyPhysicallyObserved: anyPhysical,
        },
        null,
        2,
      )}\n`,
    );
  }

  if (servo.length === 0) {
    process.stderr.write(
      `\nFAIL: "${args.command}" produced no servo telemetry. The command reached the ` +
        `console but the firmware moved nothing.\n`,
    );
    process.exitCode = 1;
  }
} finally {
  await robot.disconnect();
  say('\ndisconnected; qemu process reaped');
}
