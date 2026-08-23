/**
 * `SesameApiAdapter` — the ten firmware routes, over any `SesameRobot`.
 *
 * Transport-free on purpose: this class turns a request into a response and
 * knows nothing about sockets, so `server.ts` can put `node:http` in front of
 * it, a test can call it directly with no port, and something else can mount it
 * inside an existing server. All the fidelity lives here.
 *
 * The architectural claim it exists to make, from the research report: **API
 * parity is achievable at a host proxy, independently of Wi-Fi emulation.** An
 * external tool points at `http://sesame-robot.local/api/command` or at
 * `http://127.0.0.1:8080/api/command` and the command semantics are the same,
 * because both end at the same `SesameRobot` contract. Nothing in this file
 * mentions `SimulatedSesameRobot`.
 */
import { isJointName, jointAtIndex, jointIndex, type RobotState } from '@sesame-lab/sesame-model';
import { COMMAND_NAMES } from '@sesame-lab/sesame-protocol';
import type { SesameRobot } from '@sesame-lab/sesame-sim';

import { ArduinoRequest, arduinoToInt, buildRequestArgs } from './arduino.js';
import { parseApiCommandBody } from './manual-json.js';
import { STUB_PORTAL_HTML } from './portal.js';
import { findRoute, type RouteSpec } from './routes.js';
import { jsonString, sesameSafeToken } from './sanitize.js';
import {
  applySetSettings,
  DEFAULT_RUNTIME_SETTINGS,
  isSettingsCapable,
  renderSettingsJson,
  type RuntimeSettings,
} from './settings.js';
import { NoRadioWifiProvider, type WifiProvider } from './wifi.js';

/** A request, reduced to what an Arduino `WebServer` handler can see. */
export interface ApiRequest {
  /** Upper-case verb. */
  readonly method: string;
  /** Request target: path plus optional `?query`. */
  readonly url: string;
  /** Lower-cased header names. Only `content-type` and `origin` are read. */
  readonly headers?: Readonly<Record<string, string | undefined>>;
  /** Raw body bytes as text. Empty string when there is no body. */
  readonly body?: string;
}

/** A response, before a transport writes it. */
export interface ApiResponse {
  readonly status: number;
  readonly contentType: string;
  readonly body: string;
  /** Extra headers the transport should set. Empty for every firmware route. */
  readonly headers?: Readonly<Record<string, string>>;
}

/**
 * How strictly to police HTTP verbs.
 *
 * - `'any'` (**default**) — what the robot does. Every route is `HTTP_ANY`;
 *   only `/api/command` and `/api/wifi/connect` answer 405, and only because
 *   their handlers check. `GET /setSettings?walkCycles=3` works, and so does
 *   `DELETE /cmd?pose=wave`.
 * - `'strict'` — a **deliberate divergence**, off by default: each route
 *   accepts only the verbs `firmware/README.md` documents. Useful when this
 *   proxy is exposed to something that treats a stray verb as a signal. It
 *   will reject requests the real robot accepts, which is exactly why it is
 *   not the default.
 */
export type MethodPolicy = 'any' | 'strict';

/**
 * What to do with a command word outside the firmware's 20-word vocabulary.
 *
 * - `'firmware'` (**default**) — reproduce the sink. `currentCommand` is set,
 *   nothing matches it in `loop()`, nothing ever clears it, and the response is
 *   a cheerful `200 {"status":"ok","message":"Command executed"}`.
 *   `hardware-map.json → commands.dispatchNote`, `unresolved[unknown-command-sink]`.
 * - `'strict'` — answer `400`. A divergence, and a defensible one for a
 *   teaching UI, but it is not what the robot does.
 */
export type CommandVocabularyPolicy = 'firmware' | 'strict';

export interface SesameApiAdapterOptions {
  /** The backend. Any implementation of the contract. */
  readonly robot: SesameRobot;
  /** See {@link MethodPolicy}. Default `'any'`. */
  readonly methodPolicy?: MethodPolicy;
  /** See {@link CommandVocabularyPolicy}. Default `'firmware'`. */
  readonly commandVocabulary?: CommandVocabularyPolicy;
  /**
   * What `/api/status` reports as `apIP`. On the robot this is
   * `WiFi.softAPIP()` (`:294`). There is no SoftAP here, so the default is the
   * address this proxy is actually reachable at — the truthful analogue.
   * Override for a client that hard-codes `192.168.4.1`.
   */
  readonly apIp?: string;
  /** Initial values for the four `/getSettings` keys. Firmware defaults otherwise. */
  readonly settings?: Partial<RuntimeSettings>;
  /** The `/api/wifi/*` provider. Defaults to {@link NoRadioWifiProvider}. */
  readonly wifi?: WifiProvider;
  /** Body for `GET /` and for the captive-portal 200 on unmatched paths. */
  readonly portalHtml?: string;
  /** Where background dispatch failures go. Default: `console.error`. */
  readonly logger?: (message: string) => void;
}

const OK_TEXT: ApiResponse = { status: 200, contentType: 'text/plain', body: 'OK' };

function text(status: number, body: string): ApiResponse {
  return { status, contentType: 'text/plain', body };
}

function json(status: number, body: string): ApiResponse {
  return { status, contentType: 'application/json', body };
}

/** The firmware's 20 non-empty command words, as a set. */
const VOCABULARY = new Set(COMMAND_NAMES);

export class SesameApiAdapter {
  readonly #robot: SesameRobot;
  readonly #methodPolicy: MethodPolicy;
  readonly #commandVocabulary: CommandVocabularyPolicy;
  readonly #portalHtml: string;
  readonly #wifi: WifiProvider;
  readonly #log: (message: string) => void;

  #apIp: string;
  #settings: RuntimeSettings;
  /**
   * The unknown-command sink. `null` means "ask the backend".
   *
   * Upstream has no such variable because upstream *is* the variable: an
   * unrecognised word is written straight into `currentCommand`, matches no
   * branch, and stays there. A backend that validates its vocabulary never
   * accepts the word at all, so the adapter holds it instead — which is what
   * makes `/api/status` report it exactly as the robot would.
   */
  #shadowCommand: string | null = null;
  readonly #pending = new Set<Promise<unknown>>();

  constructor(options: SesameApiAdapterOptions) {
    this.#robot = options.robot;
    this.#methodPolicy = options.methodPolicy ?? 'any';
    this.#commandVocabulary = options.commandVocabulary ?? 'firmware';
    this.#portalHtml = options.portalHtml ?? STUB_PORTAL_HTML;
    this.#wifi = options.wifi ?? new NoRadioWifiProvider();
    this.#log = options.logger ?? ((m) => { console.error(m); });
    this.#apIp = options.apIp ?? '127.0.0.1';
    this.#settings = { ...DEFAULT_RUNTIME_SETTINGS, ...options.settings };
  }

  /** The backend this adapter fronts. */
  get robot(): SesameRobot {
    return this.#robot;
  }

  /** Set once the transport knows what address it bound to. */
  setApIp(ip: string): void {
    this.#apIp = ip;
  }

  /**
   * Wait for every command dispatched in the background to finish.
   *
   * **Not part of the firmware contract** — the robot has no such affordance.
   * It exists because `/cmd?pose=` and `POST /api/command` answer `200`
   * *before* the movement runs (`:231`, `:384`), exactly as upstream does, and
   * a test or a scripted demo needs somewhere to await that.
   */
  async drain(): Promise<void> {
    while (this.#pending.size > 0) {
      await Promise.allSettled([...this.#pending]);
    }
  }

  // =========================================================================
  // Dispatch
  // =========================================================================

  #track(work: Promise<unknown>): void {
    const tracked = work.catch((error: unknown) => {
      this.#log(`[sesame-api] backend command failed: ${String(error)}`);
    });
    this.#pending.add(tracked);
    void tracked.finally(() => this.#pending.delete(tracked));
  }

  /**
   * Assign `currentCommand` and let the backend run it — the handler half of
   * `loop()`'s dispatch.
   *
   * Returns `false` only in `commandVocabulary: 'strict'` mode for a word
   * outside the vocabulary; in `'firmware'` mode it always "succeeds", because
   * on the robot it always does.
   */
  #startCommand(rawName: string): boolean {
    // An empty value is a real case: `/cmd?pose=` sets currentCommand = "".
    const name = rawName === '' ? '' : sesameSafeToken(rawName);

    if (name === '' || name === 'stop') {
      // `stop` is not queued behind anything. On the robot it is serviced from
      // inside `server.handleClient()`, which runs from inside
      // `delayWithFace()`, so it really does land in the middle of a gait.
      this.#shadowCommand = null;
      this.#track(Promise.resolve(this.#robot.command('stop')));
      return true;
    }

    if (!VOCABULARY.has(name)) {
      if (this.#commandVocabulary === 'strict') return false;
      // The sink. No backend call: a backend that validates would refuse, and
      // one that does not would do nothing. Either way the observable result is
      // a command that is set, does nothing, and is never cleared.
      this.#shadowCommand = name;
      return true;
    }

    this.#shadowCommand = null;
    // Deliberately not awaited. `handleCommandWeb()` comments on this in the
    // source: "We send 200 OK immediately so the web browser doesn't hang
    // waiting for animation to finish" (:231).
    this.#track(Promise.resolve(this.#robot.command(name)));
    return true;
  }

  // =========================================================================
  // Entry point
  // =========================================================================

  async handle(request: ApiRequest): Promise<ApiResponse> {
    const method = request.method.toUpperCase();
    const rawUrl = request.url;
    const queryIndex = rawUrl.indexOf('?');
    const uri = queryIndex === -1 ? rawUrl : rawUrl.slice(0, queryIndex);
    const queryString = queryIndex === -1 ? '' : rawUrl.slice(queryIndex + 1);
    const body = request.body ?? '';
    const headers = request.headers ?? {};

    const args = buildRequestArgs({
      queryString,
      contentType: headers['content-type'],
      body,
      hasBody: body.length > 0,
    });
    const req = new ArduinoRequest(uri, method, args);

    const route = findRoute(uri);
    if (route === undefined) return this.#handleNotFound(req);

    if (this.#methodPolicy === 'strict' && !route.strictMethods.includes(method)) {
      return this.#strictMethodRejection(route);
    }

    switch (route.handlerSymbol) {
      case 'handleRoot':
        return this.#handleRoot();
      case 'handleCommandWeb':
        return this.#handleCommandWeb(req);
      case 'handleGetSettings':
        return this.#handleGetSettings();
      case 'handleSetSettings':
        return await this.#handleSetSettings(req);
      case 'handleGetStatus':
        return await this.#handleGetStatus();
      case 'handleApiCommand':
        return await this.#handleApiCommand(req);
      case 'handleWifiScan':
        return this.#handleWifiScan();
      case 'handleWifiConnect':
        return this.#handleWifiConnect(req);
      case 'handleWifiStatus':
        return this.#handleWifiStatus();
      default:
        return this.#handleNotFound(req);
    }
  }

  #strictMethodRejection(route: RouteSpec): ApiResponse {
    // Shaped like the two upstream 405s so a client only has to understand one
    // error format, but this whole branch is a divergence — see MethodPolicy.
    return route.path.startsWith('/api/')
      ? json(405, '{"error":"Method not allowed"}')
      : text(405, 'Method Not Allowed');
  }

  // =========================================================================
  // handleRoot — :226
  // =========================================================================

  #handleRoot(): ApiResponse {
    return { status: 200, contentType: 'text/html', body: this.#portalHtml };
  }

  // =========================================================================
  // handleCommandWeb — :230
  // =========================================================================

  #handleCommandWeb(req: ArduinoRequest): Promise<ApiResponse> | ApiResponse {
    // The if/else-if chain is the contract: `?pose=wave&stop=1` runs the wave,
    // because `pose` is tested first (:232) and nothing else is looked at.
    if (req.hasArg('pose')) {
      if (!this.#startCommand(req.arg('pose'))) return text(400, 'Unknown command');
      return OK_TEXT;
    }
    if (req.hasArg('go')) {
      if (!this.#startCommand(req.arg('go'))) return text(400, 'Unknown command');
      return OK_TEXT;
    }
    if (req.hasArg('stop')) {
      // Note what is *missing*: `exitIdle()`. `/cmd?stop=` is the one command
      // path that does not call it (:244 vs :235/:241) — F4 §1.5.
      this.#startCommand('stop');
      return OK_TEXT;
    }
    if (req.hasArg('motor') && req.hasArg('value')) {
      return this.#handleMotor(req);
    }
    return text(400, 'Bad Args');
  }

  async #handleMotor(req: ArduinoRequest): Promise<ApiResponse> {
    const motorArg = req.arg('motor');
    const motorNum = arduinoToInt(motorArg);
    // `servoNameToIndex()` — firmware/movement-sequences.h:18. Exact, case
    // sensitive, the eight firmware names only.
    const servoIdx = isJointName(motorArg) ? jointIndex(motorArg) : -1;
    const angle = arduinoToInt(req.arg('value'));

    let index = -1;
    if (motorNum >= 1 && motorNum <= 8 && angle >= 0 && angle <= 180) {
      index = motorNum - 1; // "Convert 1-based to 0-based index" — :254
    } else if (servoIdx !== -1 && angle >= 0 && angle <= 180) {
      index = servoIdx;
    } else {
      return text(400, 'Invalid motor or angle');
    }

    const joint = jointAtIndex(index);
    if (joint === undefined) return text(400, 'Invalid motor or angle');

    // Awaited, unlike a pose: `setServoAngle()` runs *inside* the handler on
    // the robot (:254), so the 200 lands after the write and after its
    // `motorCurrentDelay`.
    try {
      await this.#robot.setJoint(joint, angle);
    } catch (error) {
      // Upstream has no failure path here; a backend does. Divergence, logged.
      this.#log(`[sesame-api] setJoint failed: ${String(error)}`);
      return text(500, 'Servo write failed');
    }
    return OK_TEXT;
  }

  // =========================================================================
  // handleGetSettings / handleSetSettings — :270, :280
  // =========================================================================

  #handleGetSettings(): ApiResponse {
    return json(200, renderSettingsJson(this.#settings));
  }

  async #handleSetSettings(req: ArduinoRequest): Promise<ApiResponse> {
    this.#settings = applySetSettings(this.#settings, (name) => ({
      present: req.hasArg(name),
      value: arduinoToInt(req.arg(name)),
    }));
    if (isSettingsCapable(this.#robot)) {
      try {
        await this.#robot.setSesameSettings({ ...this.#settings });
      } catch (error) {
        this.#log(`[sesame-api] backend rejected settings: ${String(error)}`);
      }
    }
    // Always 200 "OK". There is no validation and no failure path — :285.
    return OK_TEXT;
  }

  /** The settings as this adapter currently holds them. */
  get settings(): Readonly<RuntimeSettings> {
    return { ...this.#settings };
  }

  // =========================================================================
  // handleGetStatus — :289
  // =========================================================================

  async #handleGetStatus(): Promise<ApiResponse> {
    const state: RobotState = await this.#robot.getState();

    const currentCommand = this.#shadowCommand ?? state.motion.command ?? '';
    // `currentFaceName`, straight from the backend. For `stand` and `default`
    // this is the face the robot *thinks* it is showing, which is not the one
    // on the panel: both bitmaps are weak-undefined upstream, `countFrames()`
    // returns 0, `updateFaceBitmap()` is never reached, and the name is
    // silently rewritten to "default" (ISSUE-20260823-004, F4 §1.6).
    // `sesame-sim` reproduces that; this layer must not launder it.
    const currentFace = state.face.expression;
    const connected = state.network.state === 'station';

    let out = '{';
    out += `"currentCommand":${jsonString(currentCommand)},`;
    out += `"currentFace":${jsonString(currentFace)},`;
    out += `"networkConnected":${connected ? 'true' : 'false'},`;
    out += `"apIP":${jsonString(this.#apIp)}`;
    if (connected) {
      out += `,"networkIP":${jsonString(state.network.ip ?? '')}`;
    }
    out += '}';
    return json(200, out);
  }

  // =========================================================================
  // handleApiCommand — :303
  // =========================================================================

  async #handleApiCommand(req: ArduinoRequest): Promise<ApiResponse> {
    if (req.method !== 'POST') {
      return json(405, '{"error":"Method not allowed"}');
    }

    // `server.arg("plain")`. Empty for a form-urlencoded body — see
    // `buildRequestArgs`, and note that this is the single most common way to
    // get a mystifying 400 out of the real robot.
    const body = req.arg('plain');
    const parsed = parseApiCommandBody(body);
    if (!parsed.ok) {
      return json(parsed.status, `{"error":${jsonString(parsed.error)}}`);
    }

    // "Set face if provided" — :365. Awaited: `setFace()` runs inside the
    // handler on the robot, before the response.
    if (parsed.face.length > 0) {
      try {
        await this.#robot.setFace(sesameSafeToken(parsed.face));
      } catch (error) {
        this.#log(`[sesame-api] setFace failed: ${String(error)}`);
      }
    }

    if (parsed.faceOnly) {
      return json(200, '{"status":"ok","message":"Face updated"}');
    }

    if (parsed.command === 'stop') {
      this.#startCommand('stop');
      return json(200, '{"status":"ok","message":"Command stopped"}');
    }

    if (!this.#startCommand(parsed.command)) {
      return json(400, `{"error":"Unknown command","command":${jsonString(parsed.command)}}`);
    }
    return json(200, '{"status":"ok","message":"Command executed"}');
  }

  // =========================================================================
  // /api/wifi/* — :555, :597, :623
  // =========================================================================

  #handleWifiScan(): ApiResponse {
    const results = this.#wifi.scanResults();
    if (results === null) {
      this.#wifi.beginScan();
      return json(200, '{"scanning":true}');
    }
    const rows = results.map(
      (n) =>
        `{"ssid":${jsonString(n.ssid)},"rssi":${String(n.rssi)},"secure":${n.secure ? 'true' : 'false'}}`,
    );
    return json(200, `[${rows.join(',')}]`);
  }

  #handleWifiConnect(req: ArduinoRequest): ApiResponse {
    if (req.method !== 'POST') {
      return json(405, '{"success":false,"error":"Method not allowed"}');
    }
    const ssid = req.arg('ssid');
    if (ssid.length === 0) {
      return json(400, '{"success":false,"error":"SSID required"}');
    }
    if (this.#wifi.status().connecting) {
      return json(409, '{"success":false,"error":"Connection attempt already in progress"}');
    }
    this.#wifi.connect(ssid, req.arg('password'));
    return json(200, '{"success":true,"pending":true}');
  }

  #handleWifiStatus(): ApiResponse {
    const s = this.#wifi.status();
    let out = `{"connected":${s.connected ? 'true' : 'false'}`;
    out += `,"connecting":${s.connecting ? 'true' : 'false'}`;
    if (s.lastError.length > 0) out += `,"lastError":${jsonString(s.lastError)}`;
    if (s.connected) {
      out += `,"ssid":${jsonString(s.ssid)}`;
      out += `,"ip":${jsonString(s.ip)}`;
      out += `,"host":${jsonString(s.host)}`;
      out += `,"mdns":${s.mdns ? 'true' : 'false'}`;
      out += `,"rssi":${String(s.rssi)}`;
    }
    out += '}';
    return json(200, out);
  }

  // =========================================================================
  // handleNotFound — :643
  // =========================================================================

  #handleNotFound(req: ArduinoRequest): ApiResponse {
    if (req.uri.startsWith('/api/')) {
      return json(404, '{"error":"Not found"}');
    }
    // Everything else gets the portal, with a **200**. That is the captive
    // portal working as designed: `/generate_204`, `/hotspot-detect.html` and
    // a mistyped `/cmnd` all return the control UI, not a 404.
    return this.#handleRoot();
  }
}
