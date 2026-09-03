/**
 * The bundled-resource report, from the webview's side — Phase 5 T2.
 *
 * The report itself is produced by Rust and proved against a real installed
 * artefact (`docs/findings/T2-tauri-resources.md` §4): the packaged `.exe`,
 * run from a directory containing nothing but itself and its resources, with
 * the repository nowhere on any path. Nothing here re-proves that, and nothing
 * here can.
 *
 * What these tests cover is the seam between the two languages, which is the
 * one part of the mechanism that fails *silently*:
 *
 *  - a command name that does not match the Rust function is not an error in
 *    either language. `invoke('resource_report')` rejects at runtime, in a
 *    packaged build, with no compiler anywhere having had an opinion.
 *  - a command that is not in `generate_handler!` behaves identically.
 *  - outside Tauri the module must answer `null` rather than an empty report:
 *    "0 of 0, all fine" is a claim about something that does not exist.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  fetchResourceReport,
  formatBytes,
  summarise,
  type ResourceReport,
} from '../desktop/resource-report.js';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const read = (relative: string): string =>
  fs.readFileSync(path.join(REPO, relative), 'utf8');

/** The name the webview asks for. Written once, asserted against Rust below. */
const COMMAND = 'resource_report';

const report = (over: Partial<ResourceReport> = {}): ResourceReport => ({
  ok: true,
  resourceDir: 'C:\\Program Files\\Sesame Lab',
  total: 2,
  present: 2,
  bytes: 71749689 + 4194304,
  entries: [],
  ...over,
});

describe('the command name crosses a language boundary and nothing checks it but this', () => {
  it('Rust defines a command with exactly the name the webview invokes', () => {
    expect(read('src-tauri/src/resources.rs')).toContain(`pub fn ${COMMAND}(`);
  });

  it('and registers it in `generate_handler!`, without which invoke fails at runtime', () => {
    const lib = read('src-tauri/src/lib.rs');
    expect(lib).toMatch(
      new RegExp(`generate_handler!\\[[^\\]]*resources::${COMMAND}[^\\]]*\\]`, 's'),
    );
  });

  it('the webview asks for that name and no other', () => {
    expect(read('apps/web/src/desktop/resource-report.ts')).toContain(`invoke('${COMMAND}')`);
  });
});

describe('outside the desktop shell', () => {
  it('answers null rather than an empty report', async () => {
    await expect(fetchResourceReport({})).resolves.toBeNull();
  });

  it('answers null when `__TAURI__` is there but `core.invoke` is not', async () => {
    await expect(fetchResourceReport({ __TAURI__: {} })).resolves.toBeNull();
    await expect(fetchResourceReport({ __TAURI__: { core: {} } })).resolves.toBeNull();
  });
});

describe('inside the desktop shell', () => {
  it('invokes the command and returns what Rust said, unaltered', async () => {
    const asked: string[] = [];
    const answer = report({ total: 13, present: 13 });
    const scope = {
      __TAURI__: {
        core: {
          invoke: (cmd: string) => {
            asked.push(cmd);
            return Promise.resolve(answer);
          },
        },
      },
    };
    await expect(fetchResourceReport(scope)).resolves.toBe(answer);
    expect(asked).toEqual([COMMAND]);
  });
});

describe('the summary line', () => {
  it('reads as a count and a size when everything resolved', () => {
    expect(summarise(report({ total: 13, present: 13, bytes: 79098855 }))).toBe(
      '13 bundled resources resolved, 75.4 MiB',
    );
  });

  it('leads with what is missing when something did not', () => {
    const bad = report({
      ok: false,
      total: 13,
      present: 12,
      bytes: 7349166,
      entries: [
        {
          target: 'qemu/bin/qemu-system-xtensa.exe',
          source: '../tools/qemu/qemu/bin/qemu-system-xtensa.exe',
          path: 'C:\\nowhere\\qemu\\bin\\qemu-system-xtensa.exe',
          exists: false,
          bytes: null,
          expectedBytes: 71749689,
          ok: false,
          problem: 'not found.',
        },
      ],
    });
    expect(summarise(bad)).toContain('12 of 13');
    expect(summarise(bad)).toContain('1 problem(s)');
  });
});

describe('sizes are formatted to be compared against a bundle by eye', () => {
  it.each([
    [0, '0 B'],
    [1023, '1023 B'],
    [70620, '69.0 KiB'],
    [4194304, '4.0 MiB'],
    [71749689, '68.4 MiB'],
  ])('%i -> %s', (bytes, expected) => {
    expect(formatBytes(bytes)).toBe(expected);
  });
});
