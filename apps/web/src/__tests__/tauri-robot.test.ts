/**
 * `TauriSesameRobot` and `TauriBackend`, without an emulator — Phase 5 T4.
 *
 * `tauri-contract.test.ts` is the acceptance test and it runs the real thing:
 * real firmware, the real Rust supervisor, all fifteen contract cases. It also
 * **skips** on a clone with no `cargo build`, no bundled QEMU and no flash
 * image, which is most clones and every CI job that does not want a Rust
 * toolchain.
 *
 * So the properties that do not need silicon are asserted here instead, against
 * a fake transport: the byte plumbing, the completion barrier, the write
 * budget, the origin composition, and the two rules this backend exists to
 * keep — *diagnostics are never telemetry*, and *a failed boot's panic is not
 * the surviving session's panic*.
 *
 * The fake is a transport, not a robot. It answers the four supervisor methods
 * and lets a test push bytes; everything above it — `encodeCommand`, the
 * parser, the fence, `getState()` — is the shipped code.
 */
import { describe, expect, it } from 'vitest';

import { isPhysicallyObserved } from '@sesame-lab/sesame-protocol';
import {
  QEMU_CAPABILITIES_FULL,
  QEMU_ORIGIN,
  capabilitiesForImage,
} from '@sesame-lab/sesame-qemu/capabilities';

import { TauriBackend } from '../backends/tauri/backend.js';
import { TauriSesameRobot } from '../backends/tauri/robot.js';
import {
  tauriSupervisor,
  type EmulatorSupervisor,
  type SupervisorEvent,
  type SupervisorSession,
} from '../backends/tauri/supervisor.js';

const OLED_IMAGE = 'C:\\Program Files\\Sesame Robot Emulator\\images\\distro-v1-esp32-cli-oled.flash.bin';
const PLAIN_IMAGE = 'C:\\Program Files\\Sesame Robot Emulator\\images\\distro-v1-esp32-cli.flash.bin';

/** The `subtrim` reply the fence counts. `sesame-firmware-main.ino:826`. */
const BARRIER_REPLY = 'Subtrim values:\n';

function sessionInfo(
  imagePath: string,
  engine: string | null,
  maxWriteBytes: number,
): SupervisorSession {
  return {
    pid: 4242,
    port: 61234,
    origin: {
      kind: 'emulator',
      engine,
      machine: 'esp32',
      imagePath,
      imageName: imagePath.split('\\').pop() ?? imagePath,
      qemuPath: 'C:\\Program Files\\Sesame Robot Emulator\\qemu\\bin\\qemu-system-xtensa.exe',
    },
    snapshot: true,
    args: ['-display', 'none', '-machine', 'esp32'],
    attempts: [{ attempt: 1, ok: true, ms: 1900 }],
    bootMs: 1900,
    totalMs: 1900,
    teardownEnforcedByJobObject: true,
    maxWriteBytes,
  };
}

interface Fake {
  readonly supervisor: EmulatorSupervisor;
  /** Every payload handed to `send_command`, decoded. */
  readonly writes: string[];
  /** Push bytes as if the socket had carried them. */
  emit(text: string): void;
  /** Push a supervisor event. */
  event(event: SupervisorEvent): void;
  /** Pre-boot bytes, delivered before `spawn()` resolves. */
  preBoot?: string;
  stopped: boolean;
}

function fakeSupervisor(
  imagePath = OLED_IMAGE,
  engine: string | null = 'QEMU emulator version 9.2.2 (esp_develop_9.2.2_20260417)',
  maxWriteBytes = 192,
): Fake {
  const writes: string[] = [];
  let bytes: ((chunk: Uint8Array) => void) | null = null;
  let events: ((event: SupervisorEvent) => void) | null = null;
  const decoder = new TextDecoder();
  const fake: Fake = {
    writes,
    stopped: false,
    emit(text) {
      bytes?.(new TextEncoder().encode(text));
    },
    event(event) {
      events?.(event);
    },
    supervisor: {
      spawn(_options, onBytes, onEvent) {
        bytes = onBytes;
        events = onEvent;
        return new Promise((resolve) => {
          // The order the real supervisor produces: everything buffered before
          // the boot banner is flushed to the byte sink, and only then does the
          // spawn call return. A robot that created its parser in `connect()`'s
          // continuation would already have missed these.
          if (fake.preBoot !== undefined) fake.emit(fake.preBoot);
          setTimeout(() => resolve(sessionInfo(imagePath, engine, maxWriteBytes)), 0);
        });
      },
      send(payload) {
        writes.push(decoder.decode(payload));
        return Promise.resolve(payload.length);
      },
      stop() {
        fake.stopped = true;
        return Promise.resolve({ wasRunning: true, pid: 4242 });
      },
      status() {
        return Promise.resolve({ running: true, pid: 4242, port: 61234 });
      },
    },
  };
  return fake;
}

/** Let the microtask/timer queue drain, the way an `await` in the app would. */
const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

describe('the transport is only there inside the desktop shell', () => {
  it('a browser tab has no supervisor, and gets `null` rather than a stub', () => {
    expect(tauriSupervisor({})).toBeNull();
    // Half a Tauri global is not a Tauri global: `withGlobalTauri` gives both
    // `invoke` and `Channel`, and a page with one of them is not one this can
    // talk to.
    expect(tauriSupervisor({ __TAURI__: { core: { invoke: () => Promise.resolve() } } })).toBeNull();
  });

  it('the real shape resolves', () => {
    const scope = {
      __TAURI__: {
        core: {
          invoke: () => Promise.resolve(),
          Channel: class {
            onmessage: (m: unknown) => void = () => undefined;
          },
        },
      },
    };
    expect(tauriSupervisor(scope)).not.toBeNull();
  });

  it('constructing the robot in a browser fails at the wiring, not on first use', () => {
    expect(() => new TauriSesameRobot()).toThrow(/no Tauri IPC on this page/);
  });
});

describe('the bytes reach the existing parser', () => {
  it('boot telemetry that arrived before spawn() resolved is replayed, not lost', async () => {
    const fake = fakeSupervisor();
    // `@SESAME hello` and the `rest` face are emitted inside setup(), BEFORE
    // the end-of-setup banner Rust waits for — so they are always in the
    // pre-banner flush.
    fake.preBoot = '@SESAME hello 1 sesame-fw-s2mini/0.1.0\n@SESAME face rest 0\n';
    const robot = new TauriSesameRobot({ supervisor: fake.supervisor });
    const seen: string[] = [];
    robot.subscribe((event) => seen.push(event.type));

    await robot.connect();
    expect(seen).toContain('protocol.hello');
    expect(seen).toContain('face.expression');
    const state = await robot.getState();
    expect(state.face.expression).toBe('rest');
  });

  it('servo lines become observed commanded angles, and say which joints were seen', async () => {
    const fake = fakeSupervisor();
    const robot = new TauriSesameRobot({ supervisor: fake.supervisor });
    await robot.connect();
    fake.emit('@SESAME servo R1 135\n');
    await tick();

    const state = await robot.getState();
    expect(state.joints.R1.commandedDeg).toBe(135);
    expect(state.observed.everObserved.R1).toBe(true);
    // The seven that were never reported are the documented power-on
    // assumption, and the record says so rather than drawing it as a report.
    expect(state.observed.everObserved.L1).toBe(false);
    expect(state.joints.L1.commandedDeg).toBe(90);
    // No position feedback exists on any Sesame that exists.
    expect(state.joints.R1.measuredDeg).toBeNull();
  });

  it("QEMU's own diagnostics are not telemetry, and never become a log event", async () => {
    const fake = fakeSupervisor();
    const robot = new TauriSesameRobot({ supervisor: fake.supervisor });
    const seen: string[] = [];
    robot.subscribe((event) => seen.push(event.type));
    await robot.connect();

    fake.event({ type: 'diagnostic', stream: 'stderr', text: 'Adding SPI flash device' });
    await tick();
    // A `log` event tagged `provenance: observed` for something the EMULATOR
    // said about itself is exactly the laundering the two-channel split exists
    // to prevent.
    expect(seen).toEqual([]);
  });
});

describe('the completion barrier — the fence rebuilt above the byte layer', () => {
  it('one write carries the command and the barrier, and does not resolve until it comes back', async () => {
    const fake = fakeSupervisor();
    const robot = new TauriSesameRobot({ supervisor: fake.supervisor });
    await robot.connect();

    let settled = false;
    const running = robot.command('wave').then(() => {
      settled = true;
    });
    await tick();

    // One write, not two: the firmware must never see a gap between the
    // command and its fence that it could interleave something into.
    expect(fake.writes).toEqual(['rn wv\nsubtrim\n']);
    expect(settled).toBe(false);

    // Still not finished after the servo writes: the choreography being
    // *visible* is not the choreography being *over*.
    fake.emit('@SESAME servo R4 80\n');
    await tick();
    expect(settled).toBe(false);

    fake.emit(BARRIER_REPLY);
    await running;
    expect(settled).toBe(true);
  });

  it('a multi-joint pose is one line per channel in firmware order, behind one barrier', async () => {
    const fake = fakeSupervisor();
    const robot = new TauriSesameRobot({ supervisor: fake.supervisor });
    await robot.connect();

    const running = robot.setPose({ L1: 10, R1: 20 });
    await tick();
    const payload = fake.writes[0] ?? '';
    // JOINT_ORDER is R1 before L1, and the caller's key order was the other
    // way round. The firmware has no multi-joint primitive, so the faithful
    // encoding is N lines in the enum's order.
    // Channels are written as the firmware's 0-based index: R1 is 0, L1 is 2.
    expect(payload.indexOf('0 20')).toBeGreaterThanOrEqual(0);
    expect(payload.indexOf('0 20')).toBeLessThan(payload.indexOf('2 10'));
    expect(payload.endsWith('subtrim\n')).toBe(true);
    expect(payload.match(/subtrim/g)).toHaveLength(1);

    fake.emit(BARRIER_REPLY);
    await running;
  });

  it('commands are serialised, because the firmware has one console reader', async () => {
    const fake = fakeSupervisor();
    const robot = new TauriSesameRobot({ supervisor: fake.supervisor });
    await robot.connect();

    const first = robot.command('wave');
    const second = robot.command('stand');
    await tick();
    expect(fake.writes).toHaveLength(1);

    fake.emit(BARRIER_REPLY);
    await first;
    await tick();
    expect(fake.writes).toHaveLength(2);
    fake.emit(BARRIER_REPLY);
    await second;
  });

  it('a batch over the budget the wire itself reported is refused before the bytes leave', async () => {
    // The budget is read off `SupervisorSession.maxWriteBytes` rather than
    // being a constant here, so this fake states a small one — which is also
    // the only way to exceed it through the public API, because every real
    // batch is comfortably inside 192 bytes. Rust refuses an over-budget write
    // too (`{kind:"writeTooLarge", budget:192}`, measured in T3 §6); refusing
    // here is what attaches the reason, which is a property of the wire:
    // arduino-esp32's UART ring buffer is 256 bytes, the console drains it one
    // character per loop(), and the overflow is SILENT.
    const fake = fakeSupervisor(OLED_IMAGE, null, 8);
    const robot = new TauriSesameRobot({ supervisor: fake.supervisor });
    await robot.connect();

    await expect(robot.command('wave')).rejects.toThrow(/UART0 receive budget/);
    expect(fake.writes).toEqual([]);
  });
});

describe('a failed boot is not the surviving session', () => {
  it('a guest panic from an abandoned attempt does not poison the session that booted', async () => {
    const fake = fakeSupervisor();
    const robot = new TauriSesameRobot({ supervisor: fake.supervisor });
    // Roughly a quarter of cold boots panic (ISSUE-20260823-022) and Rust
    // retries past them, so these events are routine rather than exotic. This
    // is the regression the contract suite caught: four cases failed with "the
    // guest panicked" against an emulator that booted fine on attempt three.
    const spawned = robot.connect();
    fake.event({ type: 'attempt', attempt: 1, of: 12 });
    fake.event({ type: 'guestPanic', text: 'Guru Meditation Error' });
    fake.event({ type: 'attemptFailed', attempt: 1, of: 12, reason: 'panic', ms: 1800 });
    fake.event({ type: 'exited', code: 1 });
    fake.event({ type: 'attempt', attempt: 2, of: 12 });
    await spawned;

    const state = await robot.getState();
    expect(state.observed.panic).toBeNull();

    const running = robot.command('wave');
    await tick();
    fake.emit(BARRIER_REPLY);
    await expect(running).resolves.toBeUndefined();
  });

  it('a panic AFTER the session exists does stop the next command', async () => {
    const fake = fakeSupervisor();
    const robot = new TauriSesameRobot({ supervisor: fake.supervisor });
    await robot.connect();
    fake.event({ type: 'guestPanic', text: 'Guru Meditation Error' });

    await expect(robot.command('wave')).rejects.toThrow(/the guest panicked/);
    expect((await robot.getState()).observed.panic).toBe('Guru Meditation Error');
  });
});

describe('the origin, and what each half of it is entitled to say', () => {
  it('the board, the elisions and the deviations come from the frozen derivation', async () => {
    const fake = fakeSupervisor();
    const robot = new TauriSesameRobot({ supervisor: fake.supervisor });
    await robot.connect();

    expect(robot.origin.kind).toBe('emulator');
    // The LEGACY V1 board, not the S2 Mini the report recommends for DIY
    // builds — which QEMU cannot emulate at all.
    expect(robot.origin.board).toBe('distro-v1-esp32');
    expect(robot.origin.elided).toEqual(QEMU_ORIGIN.elided);
    expect(robot.origin.firmwareDeviations).toEqual(QEMU_ORIGIN.firmwareDeviations);
    // The glass is still elided even on the image whose framebuffer IS
    // observed: no SSD1306 is attached to the emulated I2C bus, so no pixel has
    // ever been confirmed to reach any panel.
    expect(robot.origin.elided).toContain('ssd1306-glass');
  });

  it('the engine is what Rust read out of the binary it spawned, not a constant', async () => {
    const fake = fakeSupervisor(OLED_IMAGE, 'QEMU emulator version 9.9.9 (a-different-build)');
    const robot = new TauriSesameRobot({ supervisor: fake.supervisor });
    await robot.connect();
    expect(robot.origin.engine).toBe('QEMU emulator version 9.9.9 (a-different-build)');
    expect(robot.origin.engine).not.toBe(QEMU_ORIGIN.engine);
  });

  it('falls back to the derived engine when the binary would not answer', async () => {
    const fake = fakeSupervisor(OLED_IMAGE, null);
    const robot = new TauriSesameRobot({ supervisor: fake.supervisor });
    await robot.connect();
    expect(robot.origin.engine).toBe(QEMU_ORIGIN.engine);
  });

  it('is never physically observed, whatever else it says', async () => {
    const fake = fakeSupervisor();
    const robot = new TauriSesameRobot({ supervisor: fake.supervisor });
    const seen: boolean[] = [];
    robot.subscribe((event) => seen.push(isPhysicallyObserved(event)));
    await robot.connect();
    fake.emit('@SESAME servo R1 135\n@SESAME face wave 0\n');
    await tick();

    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((physical) => physical === false)).toBe(true);
  });
});

describe('the capability record follows the image Rust opened', () => {
  it('the bundled OLED image is the same frozen object the Node backend returns', async () => {
    const fake = fakeSupervisor(OLED_IMAGE);
    const robot = new TauriSesameRobot({ supervisor: fake.supervisor });
    await robot.connect();
    const caps = await robot.capabilities();
    expect(caps).toBe(QEMU_CAPABILITIES_FULL);
    expect(caps.oledFramebuffer).toBe(true);
    expect(caps.realHardware).toBe(false);
    expect(caps.firmwareExecution).toBe(true);
  });

  it('an image without the hook under-claims: no framebuffer, panel back on the elision list', async () => {
    const fake = fakeSupervisor(PLAIN_IMAGE);
    const robot = new TauriSesameRobot({ supervisor: fake.supervisor });
    await robot.connect();
    const caps = await robot.capabilities();
    expect(caps.oledFramebuffer).toBe(false);
    expect(caps.elided).toContain('ssd1306-panel');
    expect(caps).toBe(capabilitiesForImage(PLAIN_IMAGE));
  });
});

describe('TauriBackend — what the UI is given', () => {
  it('surfaces the retry while it is happening, not after', async () => {
    const fake = fakeSupervisor();
    const backend = new TauriBackend({ robot: { supervisor: fake.supervisor } });
    const seen: (number | undefined)[] = [];
    backend.onStatus((status) => seen.push(status.attempts));

    const starting = backend.start();
    fake.event({ type: 'attempt', attempt: 1, of: 12 });
    fake.event({ type: 'attemptFailed', attempt: 1, of: 12, reason: 'panic', ms: 1800 });
    fake.event({ type: 'attempt', attempt: 2, of: 12 });
    await starting;

    // A silent multi-second freeze reads as a hang; `> 1` has to be visible
    // while the wait is happening.
    expect(seen).toContain(2);
    expect(backend.status.connection).toBe('connected');
    expect(backend.status.detail).toMatch(/ISSUE-20260823-022/);
    await backend.stop();
    expect(fake.stopped).toBe(true);
  });

  it('reports the emulator qualifiers, none of which it asserts itself', async () => {
    const fake = fakeSupervisor();
    const backend = new TauriBackend({ robot: { supervisor: fake.supervisor } });
    await backend.start();

    const facts = backend.emulatorFacts();
    expect(facts).not.toBeNull();
    expect(facts?.origin.kind).toBe('emulator');
    expect(facts?.board).toBe('distro-v1-esp32');
    expect(facts?.oledFramebuffer).toBe(true);
    expect(facts?.mode).toBe('qemu');
    expect(facts?.commandChannel).toBe('serial-cli/upstream-1.0');
    expect(Object.keys(facts?.unsupportedBoards ?? {})).toContain('s2mini');
    expect(facts?.knownFlakiness).toMatch(/ISSUE-20260823-022/);
    // Nothing has been commanded yet, so nothing may be drawn as reported.
    expect(Object.values(facts?.everObserved ?? {}).every((v) => v === false)).toBe(true);
    await backend.stop();
  });

  it('models nothing: there is no slew curve behind these angles', async () => {
    const fake = fakeSupervisor();
    const backend = new TauriBackend({ robot: { supervisor: fake.supervisor } });
    await backend.start();
    expect(await backend.modelState()).toBeNull();
    await backend.stop();
  });

  it('is not an emulator until it has booted one', () => {
    const fake = fakeSupervisor();
    const backend = new TauriBackend({ robot: { supervisor: fake.supervisor } });
    expect(backend.emulatorFacts()).toBeNull();
  });
});
