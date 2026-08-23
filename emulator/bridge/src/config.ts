/**
 * Bridge configuration and the CLI parser that fills it.
 *
 * One decision here is load-bearing rather than cosmetic: **everything binds to
 * 127.0.0.1 by default**. This process turns a telemetry stream into a
 * WebSocket, and the same seam is where robot control will eventually live. The
 * research report is explicit that publishing a robot control API onto a wider
 * network is not something to do by accident, so widening the bind is an
 * explicit flag with a warning, never a default.
 */
import type { Provenance } from '@sesame-lab/sesame-protocol';

export interface BackoffConfig {
  /** First retry delay. */
  readonly initialMs: number;
  /** Ceiling; the delay never grows past this. */
  readonly maxMs: number;
  /** Multiplier per attempt. */
  readonly factor: number;
  /** Fraction of the delay applied as +/- random jitter, 0..1. */
  readonly jitter: number;
}

export interface ReplayConfig {
  /** Path to a `.jsonl` fixture (`{tMs, line}` per line) or a plain `.txt`. */
  readonly file: string;
  /**
   * Playback rate. 1 = real time, 10 = ten times faster, 0 = no waiting at all
   * (what the automated tests use — the ordering assertions are what matter,
   * not the wall clock).
   */
  readonly speed: number;
  /** Restart the fixture when it ends instead of closing the connection. */
  readonly loop: boolean;
  /** Gap between loops, in fixture-time milliseconds. */
  readonly loopGapMs: number;
}

export interface BridgeConfig {
  /** Host of the UART TCP socket to consume (Renode's socket terminal, or the replay server). */
  readonly uartHost: string;
  /** Port of the UART TCP socket. 0 means "pick an ephemeral port" and is only useful with --replay. */
  readonly uartPort: number;
  readonly wsHost: string;
  /** 0 means ephemeral; the real port is reported by `start()`. */
  readonly wsPort: number;
  /**
   * Provenance for events that carry no explicit `p=` tag. Getting this wrong is
   * the easiest way to lie to a learner: a replayed stream labelled `observed`
   * claims the robot did something it never did.
   */
  readonly defaultProvenance: Provenance;
  /** Envelopes retained for clients that connect (or reconnect) mid-stream. */
  readonly bufferSize: number;
  readonly reconnect: BackoffConfig;
  /** When set, the bridge also hosts the replay server it then connects to. */
  readonly replay: ReplayConfig | null;
  /** Serve `debug-viewer/` from the same HTTP server the WebSocket upgrades on. */
  readonly serveViewer: boolean;
  /** Directory served when `serveViewer` is on. */
  readonly viewerDir: string;
  /** Print lifecycle lines to stderr. Off inside tests. */
  readonly verbose: boolean;
}

export const DEFAULT_UART_PORT = 3456;
export const DEFAULT_WS_PORT = 8787;
export const LOOPBACK = '127.0.0.1';

export const DEFAULT_BACKOFF: BackoffConfig = {
  initialMs: 250,
  maxMs: 10_000,
  factor: 2,
  jitter: 0.2,
};

export function defaultConfig(overrides: Partial<BridgeConfig> = {}): BridgeConfig {
  return {
    uartHost: LOOPBACK,
    uartPort: DEFAULT_UART_PORT,
    wsHost: LOOPBACK,
    wsPort: DEFAULT_WS_PORT,
    defaultProvenance: 'observed',
    bufferSize: 2000,
    reconnect: DEFAULT_BACKOFF,
    replay: null,
    serveViewer: false,
    viewerDir: 'debug-viewer',
    verbose: false,
    ...overrides,
  };
}

export class ConfigError extends Error {
  override readonly name = 'ConfigError';
}

const PROVENANCES = new Set<Provenance>(['observed', 'simulated', 'inferred']);

export const USAGE = `sesame-bridge — @SESAME UART telemetry -> WebSocket

  UART TCP socket in -> streaming @SESAME parser -> typed telemetry -> WebSocket out.

Usage:
  sesame-bridge [options]

Source (pick one):
  --uart-host <host>     UART socket host                     (default ${LOOPBACK})
  --uart-port <port>     UART socket port                     (default ${DEFAULT_UART_PORT})
  --replay <file>        Host a replay server on the SAME host:port and connect
                         to it. The bridge's socket code path is identical either
                         way, which is the whole point: Path A and Path B differ
                         only in who is on the other end of the socket.
  --replay-speed <n>     1 = real time, 10 = 10x, 0 = as fast as possible (default 1)
  --loop                 Restart the fixture when it ends
  --loop-gap <ms>        Fixture-time gap between loops       (default 1000)

Output:
  --ws-host <host>       WebSocket bind host                  (default ${LOOPBACK})
  --ws-port <port>       WebSocket port, 0 = ephemeral        (default ${DEFAULT_WS_PORT})
  --serve-viewer         Also serve debug-viewer/ over the same HTTP server
  --viewer-dir <dir>     Directory to serve                   (default debug-viewer)
  --buffer <n>           Envelopes replayed to a joining client (default 2000)

Semantics:
  --provenance <p>       observed | simulated | inferred, for events with no p= tag.
                         Defaults to 'observed' for a live socket and 'simulated'
                         when --replay is used, because a replayed stream did not
                         happen on any robot.

Other:
  --allow-remote         Bind to 0.0.0.0 instead of ${LOOPBACK}. Read the warning
                         this prints before using it.
  --quiet                No lifecycle output on stderr
  --help
`;

/** Parse argv (without node/script). Throws `ConfigError` with a usable message. */
export function parseArgs(argv: readonly string[]): BridgeConfig | 'help' {
  const out: Record<string, unknown> = {};
  let allowRemote = false;
  let provenance: Provenance | null = null;
  let replayFile: string | null = null;
  let replaySpeed = 1;
  let loop = false;
  let loopGapMs = 1000;
  let quiet = false;

  const need = (i: number, flag: string): string => {
    const v = argv[i + 1];
    if (v === undefined || v.startsWith('--')) throw new ConfigError(`${flag} needs a value`);
    return v;
  };
  const num = (raw: string, flag: string, { min = 0 } = {}): number => {
    const n = Number(raw);
    if (!Number.isFinite(n) || n < min) throw new ConfigError(`${flag}: expected a number >= ${min}, got ${raw}`);
    return n;
  };

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] as string;
    switch (a) {
      case '--help': case '-h': return 'help';
      case '--uart-host': out.uartHost = need(i, a); i++; break;
      case '--uart-port': out.uartPort = num(need(i, a), a); i++; break;
      case '--ws-host': out.wsHost = need(i, a); i++; break;
      case '--ws-port': out.wsPort = num(need(i, a), a); i++; break;
      case '--buffer': out.bufferSize = num(need(i, a), a, { min: 1 }); i++; break;
      case '--replay': replayFile = need(i, a); i++; break;
      case '--replay-speed': replaySpeed = num(need(i, a), a); i++; break;
      case '--loop': loop = true; break;
      case '--loop-gap': loopGapMs = num(need(i, a), a); i++; break;
      case '--serve-viewer': out.serveViewer = true; break;
      case '--viewer-dir': out.viewerDir = need(i, a); i++; break;
      case '--allow-remote': allowRemote = true; break;
      case '--quiet': quiet = true; break;
      case '--provenance': {
        const p = need(i, a) as Provenance;
        if (!PROVENANCES.has(p)) throw new ConfigError(`--provenance: expected observed|simulated|inferred, got ${p}`);
        provenance = p; i++; break;
      }
      default:
        throw new ConfigError(`unknown option '${a}'. Try --help.`);
    }
  }

  if (allowRemote) {
    out.wsHost = '0.0.0.0';
  }

  return defaultConfig({
    ...out,
    verbose: !quiet,
    // A replayed stream is a rendering, not an observation. Defaulting it to
    // `simulated` means the honest label is the one you get for free and the
    // dishonest one takes an explicit flag.
    defaultProvenance: provenance ?? (replayFile ? 'simulated' : 'observed'),
    replay: replayFile ? { file: replayFile, speed: replaySpeed, loop, loopGapMs } : null,
  } as Partial<BridgeConfig>);
}
