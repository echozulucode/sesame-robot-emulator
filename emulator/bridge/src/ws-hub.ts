/**
 * The WebSocket side: fan-out plus a replay buffer.
 *
 * The buffer is the part worth explaining. A browser tab that reloads, or a
 * viewer opened halfway through a movement, would otherwise see an empty screen
 * until the next event — and for a robot that has finished moving, "the next
 * event" may be never. So the hub keeps the last N envelopes and hands them to
 * every client on connect. That also covers the other reconnect direction: if
 * the UART socket drops and comes back, clients that stayed connected keep their
 * history and clients that did not get it replayed.
 *
 * The HTTP server the upgrade rides on doubles as the static host for
 * `debug-viewer/`, so the demo is one process and one URL rather than a
 * WebSocket here and a `python -m http.server` there.
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { WebSocketServer, type WebSocket } from 'ws';
import type { TelemetryEnvelope } from './envelope.js';

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

export interface WsHubOptions {
  readonly host: string;
  readonly port: number;
  readonly bufferSize: number;
  /** Absolute path to serve statically, or null for WebSocket only. */
  readonly staticDir: string | null;
  readonly onClientCount?: (count: number) => void;
}

export class WsHub {
  readonly #http: http.Server;
  readonly #wss: WebSocketServer;
  readonly #clients = new Set<WebSocket>();
  /** Ring buffer, oldest first. */
  #buffer: TelemetryEnvelope[] = [];
  #port = 0;

  constructor(private readonly options: WsHubOptions) {
    this.#http = http.createServer((req, res) => this.#serveStatic(req, res));
    this.#wss = new WebSocketServer({ server: this.#http, path: '/telemetry' });

    this.#wss.on('connection', (socket) => {
      this.#clients.add(socket);
      // Backlog first, then live. Both go through the same send path so a client
      // cannot tell them apart by anything except `tHostMs`.
      //
      // Order matters more than it looks: `onClientCount` makes the bridge emit
      // a lifecycle event, which broadcasts to this socket immediately. Firing
      // it before the backlog delivers envelope n+1 ahead of envelopes 1..n and
      // then repeats it — a gap and a duplicate in the same connect.
      for (const envelope of this.#buffer) send(socket, envelope);
      this.options.onClientCount?.(this.#clients.size);
      socket.on('close', () => {
        this.#clients.delete(socket);
        this.options.onClientCount?.(this.#clients.size);
      });
      socket.on('error', () => socket.terminate());
      // v1 is device -> host only. Anything a client sends is discarded rather
      // than interpreted: this port must not become an accidental control API.
      socket.on('message', () => undefined);
    });
  }

  get port(): number {
    return this.#port;
  }

  get clientCount(): number {
    return this.#clients.size;
  }

  /** Envelopes currently retained for joining clients. */
  get buffered(): readonly TelemetryEnvelope[] {
    return this.#buffer;
  }

  listen(): Promise<number> {
    return new Promise((resolve, reject) => {
      const onError = (err: Error): void => reject(err);
      this.#http.once('error', onError);
      this.#http.listen(this.options.port, this.options.host, () => {
        this.#http.removeListener('error', onError);
        const addr = this.#http.address();
        this.#port = typeof addr === 'object' && addr !== null ? addr.port : this.options.port;
        resolve(this.#port);
      });
    });
  }

  broadcast(envelope: TelemetryEnvelope): void {
    this.#buffer.push(envelope);
    if (this.#buffer.length > this.options.bufferSize) {
      this.#buffer = this.#buffer.slice(this.#buffer.length - this.options.bufferSize);
    }
    for (const client of this.#clients) send(client, envelope);
  }

  async close(): Promise<void> {
    for (const client of this.#clients) client.close(1001, 'bridge shutting down');
    this.#clients.clear();
    await new Promise<void>((resolve) => this.#wss.close(() => resolve()));
    await new Promise<void>((resolve) => this.#http.close(() => resolve()));
  }

  #serveStatic(req: http.IncomingMessage, res: http.ServerResponse): void {
    const dir = this.options.staticDir;
    if (!dir) {
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('this bridge serves /telemetry (WebSocket) only\n');
      return;
    }
    const url = new URL(req.url ?? '/', 'http://localhost');
    const rel = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname).replace(/^\/+/, '');
    // Resolve, then check containment. Checking the string for '..' first is the
    // classic mistake: encodings and symlinks route around it.
    const file = path.resolve(dir, rel);
    if (file !== dir && !file.startsWith(dir + path.sep)) {
      res.writeHead(403, { 'content-type': 'text/plain' });
      res.end('forbidden\n');
      return;
    }
    fs.readFile(file, (err, data) => {
      if (err) {
        res.writeHead(404, { 'content-type': 'text/plain' });
        res.end('not found\n');
        return;
      }
      res.writeHead(200, {
        'content-type': CONTENT_TYPES[path.extname(file).toLowerCase()] ?? 'application/octet-stream',
        'cache-control': 'no-store',
      });
      res.end(data);
    });
  }
}

function send(socket: WebSocket, envelope: TelemetryEnvelope): void {
  if (socket.readyState !== socket.OPEN) return;
  socket.send(JSON.stringify(envelope));
}
