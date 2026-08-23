/**
 * The three `/api/wifi/*` routes.
 *
 * F4 found these in source and nowhere else: they appear in neither
 * `firmware/README.md`'s API reference nor the research report's route table
 * (`docs/findings/F4-doc-drift.md` §1.9, §2.2 — ISSUE-20260823-005 item 4).
 * A compatibility proxy that omits them is not compatible with the Settings
 * panel the real captive portal ships.
 *
 * **There is no radio here, and this package does not pretend otherwise.** What
 * is reproduced is the *state machine and the response shapes*
 * (`sesame-firmware-main.ino:555`–`:632`, and `network.station.runtimeProvisioning`
 * in `hardware-map.json`): the three states, the 405/400/409 ladder on
 * `connect`, the `{"scanning":true}` interstitial, the key set of
 * `/api/wifi/status`. What is *not* reproduced is any actual joining of any
 * actual network, and the default provider says so in `lastError` rather than
 * inventing a plausible SSID.
 *
 * A backend that does have a radio — a physical robot, or a QEMU image with a
 * Wi-Fi mock — supplies its own {@link WifiProvider} and the routes become
 * real without the handlers changing.
 */

/** `WifiSetupState` — `sesame-firmware-main.ino:83`. */
export type WifiSetupState = 'WIFI_SETUP_IDLE' | 'WIFI_SETUP_QUEUED' | 'WIFI_SETUP_CONNECTING';

/** One row of `/api/wifi/scan`'s array. */
export interface WifiNetwork {
  readonly ssid: string;
  readonly rssi: number;
  readonly secure: boolean;
}

/** What `/api/wifi/status` reports. */
export interface WifiStatus {
  readonly connected: boolean;
  readonly connecting: boolean;
  readonly lastError: string;
  /** Only meaningful when `connected`. */
  readonly ssid: string;
  readonly ip: string;
  readonly host: string;
  readonly mdns: boolean;
  readonly rssi: number;
}

/**
 * The seam a backend with a radio implements.
 *
 * Deliberately shaped like the firmware's own calls rather than like a nice
 * API: `beginScan`/`scanResults` mirror `WiFi.scanNetworks(true)` +
 * `WiFi.scanComplete()`, because that async two-step is what produces the
 * `{"scanning":true}` response an existing client already handles.
 */
export interface WifiProvider {
  /** `WiFi.scanNetworks(true)`. Resolves when results are ready. */
  beginScan(): void;
  /** `WiFi.scanComplete()` — `null` while a scan is still running. */
  scanResults(): readonly WifiNetwork[] | null;
  /** Queue a join. Never blocks; the outcome shows up in {@link status}. */
  connect(ssid: string, password: string): void;
  status(): WifiStatus;
}

/** `deviceHostname` — `sesame-firmware-main.ino:78`. */
export const DEFAULT_HOSTNAME = 'sesame-robot';

export interface NoRadioWifiOptions {
  /**
   * What `/api/wifi/scan` returns once its "scan" finishes. Default `[]` — a
   * scan that completed and found nothing, which is the truthful answer for a
   * host process with no 802.11 interface.
   */
  readonly networks?: readonly WifiNetwork[];
  /**
   * `lastError` reported after a `connect` attempt. The default names the
   * reason rather than imitating a plausible RF failure, so a client that logs
   * it cannot mistake this for a signal problem.
   */
  readonly connectError?: string;
  /** `deviceHostname`. Default `sesame-robot`. */
  readonly hostname?: string;
}

/**
 * The default provider: the firmware's state machine with the radio removed.
 *
 * - `beginScan()` completes immediately, so the first `/api/wifi/scan` returns
 *   `{"scanning":true}` (the firmware's start-a-scan branch, `:562`–`:572`) and
 *   the second returns the list. Two calls, exactly as the real portal's poll
 *   loop expects.
 * - `connect()` moves IDLE → QUEUED and then straight to IDLE with an error, so
 *   the 409 "already in progress" path is reachable in tests but a client
 *   polling `/api/wifi/status` gets a definite answer instead of hanging for
 *   the firmware's 15 s.
 */
export class NoRadioWifiProvider implements WifiProvider {
  readonly #networks: readonly WifiNetwork[];
  readonly #connectError: string;
  readonly #hostname: string;

  #scanState: 'idle' | 'running' | 'complete' = 'idle';
  #setupState: WifiSetupState = 'WIFI_SETUP_IDLE';
  #lastError = '';

  constructor(options: NoRadioWifiOptions = {}) {
    this.#networks = options.networks ?? [];
    this.#connectError =
      options.connectError ??
      'no radio: sesame-api is a host-side compatibility proxy and cannot join a network';
    this.#hostname = options.hostname ?? DEFAULT_HOSTNAME;
  }

  beginScan(): void {
    this.#scanState = 'complete';
  }

  scanResults(): readonly WifiNetwork[] | null {
    if (this.#scanState === 'complete') {
      this.#scanState = 'idle'; // WiFi.scanDelete() — :585
      return this.#networks;
    }
    return null;
  }

  connect(ssid: string, _password: string): void {
    void ssid;
    this.#setupState = 'WIFI_SETUP_QUEUED';
    // updateWifiSetup() would run this from loop(). There is nothing to run.
    this.#setupState = 'WIFI_SETUP_IDLE';
    this.#lastError = this.#connectError;
  }

  /** Exposed so the 409 branch is reachable without a radio. */
  setSetupState(state: WifiSetupState): void {
    this.#setupState = state;
  }

  status(): WifiStatus {
    return {
      connected: false,
      connecting: this.#setupState !== 'WIFI_SETUP_IDLE',
      lastError: this.#lastError,
      ssid: '',
      ip: '',
      host: `${this.#hostname}.local`,
      mdns: false,
      rssi: 0,
    };
  }
}
