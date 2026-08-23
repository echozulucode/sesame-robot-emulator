/**
 * `@sesame-lab/sesame-api` — a Sesame-compatible HTTP adapter over any
 * `SesameRobot`.
 *
 * ```ts
 * import { SimulatedSesameRobot } from '@sesame-lab/sesame-sim';
 * import { startSesameApi } from '@sesame-lab/sesame-api';
 *
 * const robot = new SimulatedSesameRobot();
 * await robot.connect();
 * const api = await startSesameApi({ robot });   // 127.0.0.1:8080
 * console.log(api.url);
 * ```
 *
 * Three things to know before pointing anything at it:
 *
 * 1. **It is a compatibility surface, not an improved one.** All ten routes F4
 *    extracted are here, with the firmware's status codes, its hand-built JSON,
 *    its `HTTP_ANY` registration, its `indexOf`-based body parser and its
 *    argument-parsing edge cases. Where the firmware does something surprising,
 *    so does this — `GET /cmd?stop` is a 400, a form-urlencoded
 *    `POST /api/command` is a 400, and an unknown command word is a 200 that
 *    does nothing forever. Each is cited at the point it is reproduced.
 *
 * 2. **It does not launder upstream bugs.** `/api/status` will report a face
 *    that is not on the panel after any pose, because `epd_bitmap_stand` is a
 *    weak, never-defined symbol (ISSUE-20260823-004). The contract suite
 *    asserts that it still does.
 *
 * 3. **It binds to `127.0.0.1` and refuses to bind elsewhere without an
 *    explicit opt-in.** The firmware has no TLS and no authentication; that
 *    trade is defensible for a robot on a trusted LAN and is not defensible as
 *    a remotely-bound default on a laptop. See `server.ts`.
 *
 * The one thing it deliberately does **not** reproduce is upstream's unescaped
 * interpolation of network-supplied strings into telemetry and into
 * `/api/status`' JSON. See `sanitize.ts` for why that divergence has no opt-out.
 *
 * Full route table, quirk ledger and security posture:
 * `docs/findings/V5-api-adapter.md`.
 */

export {
  SesameApiAdapter,
  type ApiRequest,
  type ApiResponse,
  type CommandVocabularyPolicy,
  type MethodPolicy,
  type SesameApiAdapterOptions,
} from './adapter.js';

export {
  DEFAULT_MAX_BODY_BYTES,
  DEFAULT_PORT,
  FIRMWARE_HTTP_PORT,
  isLoopbackHost,
  REMOTE_BIND_WARNING,
  RemoteBindRefusedError,
  SesameApiServer,
  startSesameApi,
  type SesameApiOptions,
} from './server.js';

export {
  CATCH_ALL_ROUTE,
  findRoute,
  ROUTE_TABLE,
  type RouteSpec,
  type SourceRef,
} from './routes.js';

export {
  applySetSettings,
  DEFAULT_RUNTIME_SETTINGS,
  isSettingsCapable,
  renderSettingsJson,
  type RuntimeSettings,
  type SettingsCapableRobot,
} from './settings.js';

export {
  ArduinoRequest,
  arduinoToInt,
  buildRequestArgs,
  classifyBody,
  parseArguments,
  urlDecode,
  type BodyKind,
  type RequestArg,
} from './arduino.js';

export { parseApiCommandBody, type ApiCommandParse } from './manual-json.js';

export {
  htmlEscape,
  isSafeToken,
  jsonEscape,
  jsonString,
  SAFE_TOKEN_MAX_LENGTH,
  sesameSafeToken,
} from './sanitize.js';

export { STUB_PORTAL_HTML } from './portal.js';

export {
  DEFAULT_HOSTNAME,
  NoRadioWifiProvider,
  type NoRadioWifiOptions,
  type WifiNetwork,
  type WifiProvider,
  type WifiSetupState,
  type WifiStatus,
} from './wifi.js';
