/**
 * `@sesame-lab/sesame-bridge` — the seam between a telemetry backend and a
 * browser.
 *
 * ```text
 * Renode emulated UART ──┐
 *                        ├── TCP socket ──► bridge ──► WebSocket ──► viewer
 * replay harness ────────┘
 * ```
 *
 * The bridge does not know or care which of those is on the other end of the
 * socket, and that is the entire value of it: Phase 1 can be written against the
 * replay harness and re-pointed at Renode by changing a port number.
 *
 * ```ts
 * const bridge = new SesameBridge(defaultConfig({ uartPort: 3456, wsPort: 8787 }));
 * const { ws } = await bridge.start();
 * console.log(ws.url);   // ws://127.0.0.1:8787/telemetry
 * ```
 */
export { SesameBridge, type BridgeAddresses } from './bridge.js';
export {
  ConfigError,
  DEFAULT_BACKOFF,
  DEFAULT_UART_PORT,
  DEFAULT_WS_PORT,
  LOOPBACK,
  USAGE,
  defaultConfig,
  parseArgs,
  type BackoffConfig,
  type BridgeConfig,
  type ReplayConfig,
} from './config.js';
export { Backoff } from './backoff.js';
export {
  decodeControlMessage,
  isLoopbackPeer,
  type ControlMessage,
  type ControlOutcome,
} from './control.js';
export {
  WS_ENVELOPE_VERSION,
  isTelemetryEnvelope,
  type EnvelopeOrigin,
  type TelemetryEnvelope,
} from './envelope.js';
export {
  ReplayError,
  ReplayServer,
  loadFixture,
  parseFixture,
  type ReplayFixture,
  type ReplayLine,
  type ReplayServerOptions,
} from './replay-server.js';
export { UartClient, type UartClientHandlers, type UartClientOptions } from './uart-client.js';
export { WsHub, type WsHubOptions } from './ws-hub.js';
