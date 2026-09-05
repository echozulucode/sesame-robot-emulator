/**
 * The Rust supervisor, as the webview sees it — Phase 5 T4.
 *
 * `docs/findings/T3-rust-supervisor.md` §2 is the surface this describes, and
 * nothing here adds to it. Rust owns the two things a webview cannot do — spawn
 * `qemu-system-xtensa.exe`, hold the UART0 socket — and hands back **raw
 * bytes**. Everything above the bytes (the `@SESAME` parser, `encodeCommand()`,
 * the completion barrier, the capability record) is the TypeScript that already
 * exists and is already tested. That division is the whole of option C in
 * `docs/plans/phase-5-tauri-desktop-app.md` §4.
 *
 * ## Two channels, and the rule that makes them two
 *
 * ```text
 * uart   raw bytes  ->  SesameTelemetryParser        (the wire, and only the wire)
 * events JSON       ->  attempt / booted / diagnostic / exited / …
 * ```
 *
 * QEMU's own stdout and stderr arrive on the **event** channel as `diagnostic`
 * and never on the byte channel. That is not tidiness: a `log` event tagged
 * `provenance: 'observed'` carrying something the *emulator* said about itself
 * would be the laundering this project exists to refuse. T3 asserts the
 * separation against the real stream on every cycle; this side must not undo it
 * by folding diagnostics back into the parser.
 *
 * ## Why the transport is an interface
 *
 * `TauriSesameRobot` is held to `describeRobotContract`, and those fifteen cases
 * are Node code — C14 opens a real `node:http` listener — so they cannot run
 * inside a WebView2 window. Making the transport a parameter lets the *same*
 * robot class run in the suite against the *same* Rust supervisor, reached
 * through `--supervisor-stdio` instead of through IPC. See
 * `src-tauri/src/stdio.rs`, which states the two alternatives that were
 * rejected and why a fake would have been worthless here.
 *
 * ## No new dependency
 *
 * `@tauri-apps/api` is still not a dependency of this app. `withGlobalTauri` is
 * `true` in `src-tauri/tauri.conf.json`, so `window.__TAURI__.core` carries both
 * `invoke` and `Channel`, and that is what this uses — the same choice, for the
 * same reason, that `desktop/resource-report.ts` made in T2. Every access is
 * guarded rather than assumed, because this module is bundled into the browser
 * build too, where none of it exists.
 */

/**
 * What Rust reports about the origin: **facts, and only facts.**
 *
 * T3 §7 is explicit about what is deliberately absent here — `elided`, `board`,
 * `firmwareDeviations` and every capability boolean. Those are derived from the
 * image path by frozen, tested objects in `@sesame-lab/sesame-qemu`, and a
 * second hand-typed copy in Rust would be exactly the drift that lets the
 * packaged app claim something the web app does not. Rust carries the identity
 * across; the existing derivation decides what it means.
 */
export interface SupervisorOriginFacts {
  /** Always `'emulator'`. There is no branch in the crate producing another. */
  readonly kind: string;
  /**
   * `qemu-system-xtensa --version`, read out of the binary that was actually
   * spawned — not a constant. `null` if it would not answer.
   */
  readonly engine: string | null;
  /** The `-machine` this session booted. */
  readonly machine: string;
  /** Absolute path of the flash image, as resolved from the bundle. */
  readonly imagePath: string;
  /** Its file name — what `imageHasOledHook()` keys `oledFramebuffer` off. */
  readonly imageName: string;
  /** Absolute path of the emulator binary that was spawned. */
  readonly qemuPath: string;
}

/** One boot attempt, as Rust logged it. `ok: false` is ISSUE-20260823-022. */
export interface SupervisorBootAttempt {
  readonly attempt: number;
  readonly ok: boolean;
  readonly reason?: string;
  readonly ms: number;
}

/** What `spawn_emulator` answers with. */
export interface SupervisorSession {
  readonly pid: number;
  readonly port: number;
  readonly origin: SupervisorOriginFacts;
  readonly snapshot: boolean;
  /** The exact argv, so `snapshot=on` is auditable rather than trusted. */
  readonly args: readonly string[];
  /** Every attempt, failures included. */
  readonly attempts: readonly SupervisorBootAttempt[];
  readonly bootMs: number;
  readonly totalMs: number;
  readonly teardownEnforcedByJobObject: boolean;
  /** The UART0 write budget Rust enforces. 192; see `MAX_BATCH_BYTES`. */
  readonly maxWriteBytes: number;
}

/** Progress, out of band from the bytes. `type` is the tag. */
export type SupervisorEvent =
  | { readonly type: 'attempt'; readonly attempt: number; readonly of: number }
  | {
      readonly type: 'attemptFailed';
      readonly attempt: number;
      readonly of: number;
      readonly reason: string;
      readonly ms: number;
    }
  | {
      readonly type: 'booted';
      readonly attempt: number;
      readonly of: number;
      readonly ms: number;
      readonly pid: number;
      readonly port: number;
    }
  | { readonly type: 'guestPanic'; readonly text: string }
  /** QEMU's own stdout/stderr. **Not guest output.** Never parsed. */
  | { readonly type: 'diagnostic'; readonly stream: string; readonly text: string }
  | { readonly type: 'exited'; readonly code?: number }
  | { readonly type: 'stopped'; readonly pid: number; readonly confirmed: boolean };

/** What `stop_emulator` answers with. `wasRunning: false` is not an error. */
export interface SupervisorStopReport {
  readonly wasRunning: boolean;
  readonly pid?: number;
}

/** What `emulator_status` answers with. Cheap; safe to poll. */
export interface SupervisorStatusReport {
  readonly running: boolean;
  readonly pid?: number;
  readonly port?: number;
  /** Non-null means the guest died and every other field is last-known. */
  readonly guestPanic?: string;
}

/**
 * The knobs Rust exposes.
 *
 * **There are no path fields and that is the design** (T3 §3, deviation 2). A
 * webview that could hand in an arbitrary image could change what
 * `capabilitiesForImage()` reports about pixels it never observed. The paths
 * come from `resources::resolve` and nowhere else, which is how V7's property —
 * *the origin claim comes from the backend rather than the app asserting it* —
 * survives the move off HTTP.
 */
export interface SupervisorSpawnOptions {
  readonly bootAttempts?: number;
  readonly bootTimeoutMs?: number;
  readonly uartPort?: number;
  readonly snapshot?: boolean;
}

/**
 * The transport `TauriSesameRobot` sits on.
 *
 * Four methods, matching T3's four commands one for one. Anything that is not
 * *process lifetime* or *the socket* is deliberately absent: there is no
 * `command()` here, because encoding a command is `encodeCommand()`'s job and
 * fencing one is the barrier protocol's, and both live above this line.
 */
export interface EmulatorSupervisor {
  /**
   * Boot, and stream. `onBytes` receives whatever the socket carried, unframed
   * and in order — including everything buffered before the boot banner, which
   * is where `@SESAME hello` and the `rest` face `setup()` ends with live.
   */
  spawn(
    options: SupervisorSpawnOptions,
    onBytes: (chunk: ArrayBuffer | Uint8Array) => void,
    onEvent: (event: SupervisorEvent) => void,
  ): Promise<SupervisorSession>;
  /** Write raw bytes to UART0. Resolves with the count; does **not** fence. */
  send(bytes: Uint8Array): Promise<number>;
  stop(): Promise<SupervisorStopReport>;
  status(): Promise<SupervisorStatusReport>;
  /** Release the transport itself. A no-op over IPC; closes the pipe over stdio. */
  dispose?(): Promise<void>;
}

/** The shape `withGlobalTauri: true` installs on `window`. */
interface GlobalTauriCore {
  readonly invoke?: (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;
  readonly Channel?: new <T>() => { onmessage: (message: T) => void };
}
interface GlobalTauri {
  readonly core?: GlobalTauriCore;
}

/** `window.__TAURI__.core`, or `null` outside the desktop shell. */
function core(scope: object = globalThis): GlobalTauriCore | null {
  const tauri = (scope as { __TAURI__?: GlobalTauri }).__TAURI__;
  const found = tauri?.core;
  if (found === undefined) return null;
  return typeof found.invoke === 'function' && typeof found.Channel === 'function' ? found : null;
}

/**
 * The supervisor over Tauri IPC, or `null` in a browser tab.
 *
 * `null` rather than a throwing stub: a browser has no emulator to supervise,
 * and answering with an object that fails on first use would put the discovery
 * one step further from the place that can explain it.
 */
export function tauriSupervisor(scope: object = globalThis): EmulatorSupervisor | null {
  const api = core(scope);
  if (api === null) return null;
  const invoke = api.invoke as NonNullable<GlobalTauriCore['invoke']>;
  const ChannelCtor = api.Channel as NonNullable<GlobalTauriCore['Channel']>;

  return {
    async spawn(options, onBytes, onEvent) {
      // `Response::new(Vec<u8>)` on the Rust side is an `InvokeResponseBody::Raw`,
      // so this channel delivers an ArrayBuffer rather than a JSON array of
      // 4,096 numbers per OLED frame. `Channel` stamps every message with an
      // index and reassembles in order — a reordered byte stream is a corrupted
      // one, and the parser downstream cannot tell.
      const uart = new ChannelCtor<ArrayBuffer>();
      uart.onmessage = (chunk) => onBytes(chunk);
      const events = new ChannelCtor<SupervisorEvent>();
      events.onmessage = (event) => onEvent(event);
      return (await invoke('spawn_emulator', { options, uart, events })) as SupervisorSession;
    },
    async send(bytes) {
      // A plain array, not a typed array: the IPC boundary serializes
      // arguments as JSON, and at most 192 bytes per write (T3 enforces it) is
      // small enough that the encoding cost is irrelevant. The *receive*
      // direction is where raw framing matters, and that is what the channel
      // above is for.
      return (await invoke('send_command', { bytes: Array.from(bytes) })) as number;
    },
    async stop() {
      return (await invoke('stop_emulator')) as SupervisorStopReport;
    },
    async status() {
      return (await invoke('emulator_status')) as SupervisorStatusReport;
    },
  };
}
