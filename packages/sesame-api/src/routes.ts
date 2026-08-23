/**
 * The route table, with the provenance F4 extracted for every row.
 *
 * This is a projection of `hardware/hardware-map.json → network.http.routes`,
 * and `route-table.test.ts` asserts it against that file on every run: same
 * ten paths, same handler symbols, same `file:line`, same
 * `methodEnforcedInHandler`. If the extractor learns something new about the
 * firmware's routing, this table fails a test rather than quietly drifting.
 *
 * The one field that is ours rather than the extractor's is
 * {@link RouteSpec.strictMethods} — see {@link SesameApiOptions.methodPolicy}.
 */

/** Provenance, in the shape `hardware-map.json` uses. */
export interface SourceRef {
  readonly file: string;
  readonly line: number;
}

export interface RouteSpec {
  /** `server.uri()` this route matches, exactly. `*` is the catch-all. */
  readonly path: string;
  /** The firmware function that serves it. */
  readonly handlerSymbol: string;
  /** Where that function is defined. */
  readonly handlerSource: SourceRef;
  /** Where `server.on(...)` / `server.onNotFound(...)` registers it. */
  readonly registrationSource: SourceRef;
  /**
   * **Every route upstream is `HTTP_ANY`** — the two-argument
   * `WebServer::on(uri, handler)` overload binds no method
   * (`hardware-map.json → network.http.routeRegistrationNote`,
   * `docs/findings/F4-doc-drift.md` §1.9, ISSUE-20260823-005 item 4). The
   * `GET`/`POST` labels in `firmware/README.md` are not enforced by anything.
   */
  readonly registeredMethod: 'ANY';
  /**
   * The method a route checks *inside* its handler, if any. Only two do, and
   * both answer 405.
   */
  readonly methodEnforcedInHandler: 'POST' | null;
  /**
   * What `methodPolicy: 'strict'` would allow. **Not upstream behaviour** —
   * this is the README's documented intent, offered as an opt-in for someone
   * hardening a deployment. `HEAD` rides along with `GET` because Node answers
   * it from the same handler.
   */
  readonly strictMethods: readonly string[];
}

const GET_ONLY = ['GET', 'HEAD'] as const;
const POST_ONLY = ['POST'] as const;

/** The nine explicit registrations plus the catch-all, in registration order. */
export const ROUTE_TABLE: readonly RouteSpec[] = Object.freeze([
  {
    path: '/',
    handlerSymbol: 'handleRoot',
    handlerSource: { file: 'firmware/sesame-firmware-main.ino', line: 226 },
    registrationSource: { file: 'firmware/sesame-firmware-main.ino', line: 712 },
    registeredMethod: 'ANY',
    methodEnforcedInHandler: null,
    strictMethods: GET_ONLY,
  },
  {
    path: '/cmd',
    handlerSymbol: 'handleCommandWeb',
    handlerSource: { file: 'firmware/sesame-firmware-main.ino', line: 230 },
    registrationSource: { file: 'firmware/sesame-firmware-main.ino', line: 713 },
    registeredMethod: 'ANY',
    methodEnforcedInHandler: null,
    strictMethods: GET_ONLY,
  },
  {
    path: '/getSettings',
    handlerSymbol: 'handleGetSettings',
    handlerSource: { file: 'firmware/sesame-firmware-main.ino', line: 270 },
    registrationSource: { file: 'firmware/sesame-firmware-main.ino', line: 714 },
    registeredMethod: 'ANY',
    methodEnforcedInHandler: null,
    strictMethods: GET_ONLY,
  },
  {
    path: '/setSettings',
    handlerSymbol: 'handleSetSettings',
    handlerSource: { file: 'firmware/sesame-firmware-main.ino', line: 280 },
    registrationSource: { file: 'firmware/sesame-firmware-main.ino', line: 715 },
    registeredMethod: 'ANY',
    methodEnforcedInHandler: null,
    strictMethods: GET_ONLY,
  },
  {
    path: '/api/status',
    handlerSymbol: 'handleGetStatus',
    handlerSource: { file: 'firmware/sesame-firmware-main.ino', line: 289 },
    registrationSource: { file: 'firmware/sesame-firmware-main.ino', line: 718 },
    registeredMethod: 'ANY',
    methodEnforcedInHandler: null,
    strictMethods: GET_ONLY,
  },
  {
    path: '/api/command',
    handlerSymbol: 'handleApiCommand',
    handlerSource: { file: 'firmware/sesame-firmware-main.ino', line: 303 },
    registrationSource: { file: 'firmware/sesame-firmware-main.ino', line: 719 },
    registeredMethod: 'ANY',
    methodEnforcedInHandler: 'POST',
    strictMethods: POST_ONLY,
  },
  {
    path: '/api/wifi/scan',
    handlerSymbol: 'handleWifiScan',
    handlerSource: { file: 'firmware/sesame-firmware-main.ino', line: 555 },
    registrationSource: { file: 'firmware/sesame-firmware-main.ino', line: 722 },
    registeredMethod: 'ANY',
    methodEnforcedInHandler: null,
    strictMethods: GET_ONLY,
  },
  {
    path: '/api/wifi/connect',
    handlerSymbol: 'handleWifiConnect',
    handlerSource: { file: 'firmware/sesame-firmware-main.ino', line: 597 },
    registrationSource: { file: 'firmware/sesame-firmware-main.ino', line: 723 },
    registeredMethod: 'ANY',
    methodEnforcedInHandler: 'POST',
    strictMethods: POST_ONLY,
  },
  {
    path: '/api/wifi/status',
    handlerSymbol: 'handleWifiStatus',
    handlerSource: { file: 'firmware/sesame-firmware-main.ino', line: 623 },
    registrationSource: { file: 'firmware/sesame-firmware-main.ino', line: 724 },
    registeredMethod: 'ANY',
    methodEnforcedInHandler: null,
    strictMethods: GET_ONLY,
  },
  {
    path: '*',
    handlerSymbol: 'handleNotFound',
    handlerSource: { file: 'firmware/sesame-firmware-main.ino', line: 643 },
    registrationSource: { file: 'firmware/sesame-firmware-main.ino', line: 729 },
    registeredMethod: 'ANY',
    methodEnforcedInHandler: null,
    // The catch-all has no method restriction in either mode: an unmatched
    // path is unmatched whatever verb asked for it.
    strictMethods: [],
  },
]);

/** Look up an explicit route. The catch-all is not returned. */
export function findRoute(path: string): RouteSpec | undefined {
  return ROUTE_TABLE.find((r) => r.path !== '*' && r.path === path);
}

/** The `onNotFound` row. */
export const CATCH_ALL_ROUTE: RouteSpec = ROUTE_TABLE[ROUTE_TABLE.length - 1] as RouteSpec;
