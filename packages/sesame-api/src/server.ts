/**
 * `SesameApiServer` — `node:http` in front of {@link SesameApiAdapter}.
 *
 * No framework. The whole transport is one request listener, a body reader with
 * a cap, and a bind-address policy; adding Express to serve ten fixed paths
 * would be a dependency for nothing.
 *
 * ## Security posture
 *
 * The real firmware serves this API over plain HTTP on port 80 with **no TLS
 * and no authentication** (`hardware-map.json → network.http.tls/authentication`,
 * both `false`), reachable by anyone associated to an open-ish SoftAP whose
 * password is the literal `12345678` (`sesame-firmware-main.ino:16`). On a toy
 * on a trusted LAN that is a defensible trade. Replicating it as a
 * *remotely-bound default on a general-purpose computer* is not, so:
 *
 * 1. **The default bind address is `127.0.0.1`.** A robot control API is not
 *    published to a network because someone forgot a flag.
 * 2. **Binding anywhere else requires `allowRemote: true`**, and that path
 *    prints a loud multi-line warning naming exactly what is being exposed.
 *    Without the flag, a non-loopback host is a thrown error, not a warning.
 * 3. **Request bodies are capped** (default 64 KiB) and oversized ones are
 *    refused with `413`. The ESP32 has an implicit cap at about the size of its
 *    heap; a Node process does not, and an unbounded `arg("plain")` is a free
 *    denial of service. A deliberate divergence, in the hardening direction.
 * 4. **Every name that crosses this boundary is sanitised** before it can reach
 *    a face, a command, telemetry or a JSON response — see `sanitize.ts`.
 *
 * ### The residual risk, named rather than waved at
 *
 * A loopback-bound HTTP service with no authentication is still reachable from
 * any web page the user visits, via a form post or a no-cors `fetch`, and via
 * DNS rebinding. Upstream has no CSRF defence and neither does this by default,
 * because adding one changes the contract a compatibility proxy exists to
 * preserve. {@link SesameApiOptions.browserGuard} is the opt-in: it rejects any
 * request carrying an `Origin` header that is not this server's own, which
 * blocks the browser-driven cases while leaving `curl`, the lab tooling and the
 * bundled portal page working. Turn it on if the machine browses the web while
 * the robot is live.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { isIP } from 'node:net';
import type { AddressInfo } from 'node:net';

import { SesameApiAdapter, type SesameApiAdapterOptions } from './adapter.js';

/** Hosts that keep the server off the network. */
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

/** The firmware's port. Not the default here — see {@link SesameApiOptions.port}. */
export const FIRMWARE_HTTP_PORT = 80;

/**
 * Default listen port.
 *
 * **Not 80.** Port 80 is privileged on Linux and macOS and routinely occupied
 * on Windows, so defaulting to it would make the common case fail. Parity is
 * about paths, methods, bodies and status codes; the port is a deployment
 * detail the client already has to know, and {@link FIRMWARE_HTTP_PORT} is
 * exported for anyone who wants it.
 */
export const DEFAULT_PORT = 8080;

/** 64 KiB. See the security note above. */
export const DEFAULT_MAX_BODY_BYTES = 64 * 1024;

export interface SesameApiOptions extends SesameApiAdapterOptions {
  /** Default `'127.0.0.1'`. Anything else needs {@link allowRemote}. */
  readonly host?: string;
  /** Default {@link DEFAULT_PORT}. `0` asks the OS for a free port. */
  readonly port?: number;
  /**
   * Permit a non-loopback bind. Default `false`, and leaving it that way is
   * the single most useful thing this package does for a user's safety.
   */
  readonly allowRemote?: boolean;
  /** Default {@link DEFAULT_MAX_BODY_BYTES}. */
  readonly maxBodyBytes?: number;
  /**
   * Reject cross-origin browser requests. Default `false` (upstream parity).
   * See the residual-risk note above.
   */
  readonly browserGuard?: boolean;
  /** Where warnings go. Default `console.warn`. */
  readonly warn?: (message: string) => void;
}

/** Thrown when a remote bind is requested without the opt-in. */
export class RemoteBindRefusedError extends Error {
  override readonly name = 'RemoteBindRefusedError';
  constructor(readonly host: string) {
    super(
      `refusing to bind the Sesame control API to ${host}: this publishes an ` +
        `unauthenticated robot control API to the network. Pass allowRemote: true ` +
        `(CLI: --allow-remote) if that is genuinely what you want.`,
    );
  }
}

/** True for an address that cannot be reached from another machine. */
export function isLoopbackHost(host: string): boolean {
  if (LOOPBACK_HOSTS.has(host)) return true;
  // 127.0.0.0/8 is all loopback.
  return isIP(host) === 4 && host.startsWith('127.');
}

export const REMOTE_BIND_WARNING = [
  '',
  '  ############################################################',
  '  #  SESAME API IS BOUND TO A NON-LOOPBACK ADDRESS           #',
  '  ############################################################',
  '',
  '  Anyone who can reach this address can move the robot.',
  '  There is no authentication and no TLS — deliberately, because',
  '  the firmware this emulates has neither. That is a trade that',
  '  makes sense on a robot on a trusted LAN. It does not make',
  '  sense on a general-purpose computer on an untrusted network.',
  '',
  '  Bind to 127.0.0.1 (the default) unless you need otherwise.',
  '',
].join('\n');

export class SesameApiServer {
  readonly adapter: SesameApiAdapter;
  readonly #server: Server;
  readonly #host: string;
  readonly #requestedPort: number;
  readonly #maxBodyBytes: number;
  readonly #browserGuard: boolean;
  readonly #warn: (message: string) => void;
  #boundPort: number | null = null;

  constructor(options: SesameApiOptions) {
    this.#host = options.host ?? '127.0.0.1';
    this.#requestedPort = options.port ?? DEFAULT_PORT;
    this.#maxBodyBytes = options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
    this.#browserGuard = options.browserGuard ?? false;
    this.#warn = options.warn ?? ((m) => { console.warn(m); });

    const remote = !isLoopbackHost(this.#host);
    if (remote && options.allowRemote !== true) {
      throw new RemoteBindRefusedError(this.#host);
    }
    if (remote) this.#warn(REMOTE_BIND_WARNING);

    this.adapter = new SesameApiAdapter(options);
    if (options.apIp === undefined) this.adapter.setApIp(this.#host);

    this.#server = createServer((req, res) => {
      void this.#onRequest(req, res);
    });
  }

  /** The address the server is bound to. */
  get host(): string {
    return this.#host;
  }

  /** The port actually bound, or `null` before {@link listen}. */
  get port(): number | null {
    return this.#boundPort;
  }

  /** `http://host:port`, or `null` before {@link listen}. */
  get url(): string | null {
    if (this.#boundPort === null) return null;
    const host = this.#host.includes(':') ? `[${this.#host}]` : this.#host;
    return `http://${host}:${String(this.#boundPort)}`;
  }

  /** The underlying `node:http` server, for anyone who needs it. */
  get server(): Server {
    return this.#server;
  }

  async listen(): Promise<number> {
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error): void => reject(error);
      this.#server.once('error', onError);
      this.#server.listen(this.#requestedPort, this.#host, () => {
        this.#server.off('error', onError);
        resolve();
      });
    });
    const address = this.#server.address() as AddressInfo | null;
    this.#boundPort = address?.port ?? this.#requestedPort;
    return this.#boundPort;
  }

  async close(): Promise<void> {
    await new Promise<void>((resolve) => {
      this.#server.close(() => resolve());
    });
    this.#server.closeAllConnections?.();
    await this.adapter.drain();
    this.#boundPort = null;
  }

  async #onRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      if (this.#browserGuard && this.#isForeignOrigin(req)) {
        this.#send(res, 403, 'text/plain', 'Forbidden: cross-origin request blocked');
        return;
      }

      const body = await this.#readBody(req);
      if (body === null) {
        this.#send(res, 413, 'text/plain', 'Payload Too Large');
        return;
      }

      const headers: Record<string, string | undefined> = {};
      for (const [key, value] of Object.entries(req.headers)) {
        headers[key.toLowerCase()] = Array.isArray(value) ? value[0] : value;
      }

      const response = await this.adapter.handle({
        method: req.method ?? 'GET',
        url: req.url ?? '/',
        headers,
        body,
      });
      this.#send(res, response.status, response.contentType, response.body, response.headers);
    } catch (error) {
      // Upstream cannot get here; a backend can. 500 rather than a hung socket.
      this.#warn(`[sesame-api] request failed: ${String(error)}`);
      if (!res.headersSent) this.#send(res, 500, 'text/plain', 'Internal Server Error');
      else res.end();
    }
  }

  #isForeignOrigin(req: IncomingMessage): boolean {
    const origin = req.headers.origin;
    if (typeof origin !== 'string' || origin === '' || origin === 'null') return false;
    const own = this.url;
    if (own === null) return false;
    // Same port, any loopback spelling: the portal page fetches from whichever
    // name the user typed into the address bar.
    try {
      const parsed = new URL(origin);
      if (parsed.port !== String(this.#boundPort)) return true;
      return !isLoopbackHost(parsed.hostname);
    } catch {
      return true;
    }
  }

  /** Read the body, or `null` if it exceeds the cap. */
  async #readBody(req: IncomingMessage): Promise<string | null> {
    const declared = Number(req.headers['content-length'] ?? '0');
    if (Number.isFinite(declared) && declared > this.#maxBodyBytes) return null;

    return await new Promise<string | null>((resolve, reject) => {
      const chunks: Buffer[] = [];
      let total = 0;
      req.on('data', (chunk: Buffer) => {
        total += chunk.length;
        if (total > this.#maxBodyBytes) {
          req.destroy();
          resolve(null);
          return;
        }
        chunks.push(chunk);
      });
      req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      req.on('error', reject);
    });
  }

  #send(
    res: ServerResponse,
    status: number,
    contentType: string,
    body: string,
    extra?: Readonly<Record<string, string>>,
  ): void {
    const payload = Buffer.from(body, 'utf8');
    res.writeHead(status, {
      'Content-Type': contentType,
      'Content-Length': payload.byteLength,
      // Not upstream (the ESP32 sends neither), but a control API should never
      // be cached and should never be sniffed into another content type.
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      ...extra,
    });
    res.end(payload);
  }
}

/** Construct, bind, and return a listening server. */
export async function startSesameApi(options: SesameApiOptions): Promise<SesameApiServer> {
  const server = new SesameApiServer(options);
  await server.listen();
  return server;
}
