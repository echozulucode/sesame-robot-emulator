#!/usr/bin/env node
/**
 * `sesame-bridge` entry point.
 *
 * Deliberately thin: everything testable lives in `bridge.ts`, so the only
 * things this file is responsible for are argument errors, the remote-bind
 * warning, and shutting down cleanly when someone hits Ctrl-C.
 */
import { SesameBridge } from './bridge.js';
import { ConfigError, USAGE, parseArgs } from './config.js';

async function main(): Promise<number> {
  let config;
  try {
    const parsed = parseArgs(process.argv.slice(2));
    if (parsed === 'help') {
      process.stdout.write(USAGE);
      return 0;
    }
    config = parsed;
  } catch (err) {
    if (err instanceof ConfigError) {
      process.stderr.write(`sesame-bridge: ${err.message}\n`);
      return 2;
    }
    throw err;
  }

  if (config.wsHost !== '127.0.0.1' && config.wsHost !== 'localhost') {
    process.stderr.write(
      `\n  WARNING: binding the telemetry WebSocket to ${config.wsHost}.\n` +
        '  This stream is the same seam robot control will later ride on, and it has\n' +
        '  no authentication of any kind. Do not do this on an untrusted network.\n\n',
    );
  }

  const bridge = new SesameBridge(config);
  const addresses = await bridge.start();

  process.stdout.write(`websocket   ${addresses.ws.url}\n`);
  process.stdout.write(`uart source tcp://${addresses.uart.host}:${addresses.uart.port}\n`);
  if (addresses.replay) {
    process.stdout.write(
      `replay      ${addresses.replay.file} (${addresses.replay.lines} lines, ${addresses.replay.durationMs} ms)\n`,
    );
  }
  if (config.serveViewer) {
    process.stdout.write(`viewer      http://${addresses.ws.host}:${addresses.ws.port}/\n`);
  }

  let stopping = false;
  const shutdown = (signal: string): void => {
    if (stopping) return;
    stopping = true;
    process.stderr.write(`\n[bridge] ${signal} — stopping\n`);
    void bridge.stop().then(
      () => process.exit(0),
      (err: unknown) => {
        process.stderr.write(`[bridge] unclean shutdown: ${String(err)}\n`);
        process.exit(1);
      },
    );
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  return new Promise<number>(() => {
    /* run until signalled */
  });
}

main().then(
  (code) => {
    if (code !== 0) process.exit(code);
  },
  (err: unknown) => {
    process.stderr.write(`sesame-bridge: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  },
);
