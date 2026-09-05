/**
 * The prerequisites a clone has to acquire, in one list — Phase 5 T7.
 *
 * `just doctor` and `just setup` are the same question asked twice: *what is
 * missing?* and *fetch what is missing.* Written twice they can disagree, and a
 * disagreement here is the worst kind — `doctor` saying OK about something
 * `setup` never fetched, or `setup` cheerfully re-running a step `doctor`
 * already sees as present. So there is one array, and both read it.
 *
 * Every entry answers four things:
 *
 *   detect()   is it here? — a FILE on disk, never a flag or a stamp file. A
 *              stamp says "we ran the fetcher", which is not the same claim.
 *   level      what its absence means: FAIL blocks `just dev`, WARN does not.
 *   fix        the exact command `just doctor` prints.
 *   setup      what `just setup` runs to get it, or null when it is derived
 *              from an earlier step and needs no command of its own.
 *
 * The order is the dependency order, and `just setup` walks it top to bottom:
 * the flash image is built by an Arduino toolchain that is fetched by a step
 * above it, out of a firmware tree fetched by the step above that.
 *
 * `firmware/upstream` sits before the builds for a reason found by running this
 * on a real cold clone: the web build **publishes four annotated upstream files
 * into `apps/web/dist/upstream/`**, and with the tree absent it emits a warning,
 * builds anyway, and produces a dist whose source explorer has nothing to show.
 * `apps/web/dist/index.html` exists either way, so the post-condition here
 * cannot tell the two apart — the ordering is what makes it right.
 *
 * ## The images, and why there are three of them
 *
 * This list is the first place in the repository that says all three out loud.
 * `just qemu-image` builds ONE — `distro-v1-esp32-cli`, which is the only one
 * `just dev` boots — and until T7 nothing said that the 41-capture harness also
 * needs `distro-v1-esp32-nowifi` for its bridge phase, or that
 * `just tauri-build` bundles `distro-v1-esp32-cli-oled` and nothing else. A
 * clone that followed the README to the letter could reach `just dev` and then
 * find both verification targets unable to run, with no row anywhere saying
 * why. Hence `IMAGE_CLI`, `IMAGE_NOWIFI` and `IMAGE_OLED` below, each naming
 * the consumer that needs it.
 */
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const WORKSPACE_BUILD = [
  'packages/sesame-qemu/dist/cli.js',
  'packages/sesame-api/dist/cli.js',
  'emulator/bridge/dist/cli.js',
];

export const QEMU_BIN = 'tools/qemu/qemu/bin/qemu-system-xtensa.exe';
export const ARDUINO_CLI = 'tools/arduino-cli/arduino-cli.exe';
export const UPSTREAM_INO = 'firmware/upstream/firmware/sesame-firmware-main.ino';
export const IMAGE_DIR = 'emulator/qemu/images';
export const IMAGE_CLI = `${IMAGE_DIR}/distro-v1-esp32-cli.flash.bin`;
export const IMAGE_NOWIFI = `${IMAGE_DIR}/distro-v1-esp32-nowifi.flash.bin`;
export const IMAGE_OLED = `${IMAGE_DIR}/distro-v1-esp32-cli-oled.flash.bin`;

/** `just upstream` picks by platform; so does this, and for the same reason. */
const upstreamCommand = () =>
  process.platform === 'win32'
    ? { command: 'pwsh', args: ['-NoProfile', '-File', 'scripts/fetch-upstream.ps1'] }
    : { command: 'bash', args: ['scripts/fetch-upstream.sh'] };

const firmwareToolchainCommand = () =>
  process.platform === 'win32'
    ? { command: 'pwsh', args: ['-NoProfile', '-File', 'scripts/setup-firmware-toolchain.ps1'] }
    : { command: 'bash', args: ['scripts/setup-firmware-toolchain.sh'] };

const node = (...args) => ({ command: process.execPath, args });

/**
 * @typedef {object} Prereq
 * @property {string}   id        stable key, used by --only and by the report
 * @property {string}   name      the label `just doctor` prints
 * @property {'FAIL'|'WARN'} level what its absence means for `just dev`
 * @property {(repo: string) => { present: boolean, detail: string }} detect
 * @property {string}   fix       the command `just doctor` prints when absent
 * @property {null | { label: string, command: string, args: string[], minutes: string, optional?: boolean }} setup
 */

/** @type {Prereq[]} */
export const PREREQS = [
  {
    id: 'node_modules',
    name: 'node_modules',
    level: 'FAIL',
    detect: (repo) => {
      const present = fs.existsSync(path.join(repo, 'node_modules'));
      return { present, detail: present ? 'installed' : 'missing' };
    },
    fix: 'pnpm install',
    setup: {
      label: 'workspace dependencies',
      // Deliberately run even when node_modules exists. pnpm is the thing that
      // knows whether the lockfile moved; skipping on a directory's existence
      // would make `just setup` report "already present" for a clone whose
      // dependencies had changed under it. It is a few seconds warm.
      always: true,
      command: 'pnpm',
      args: ['install'],
      minutes: '~1 min cold, ~4 s warm',
    },
  },
  {
    id: 'upstream',
    name: 'firmware/upstream',
    level: 'WARN',
    detect: (repo) => {
      const present = fs.existsSync(path.join(repo, UPSTREAM_INO));
      return { present, detail: present ? 'present (pinned)' : 'not fetched' };
    },
    fix: 'just upstream  - the source explorer refuses to render without it',
    setup: {
      label: 'the pinned upstream Sesame tree (the source explorer refuses to render without it)',
      ...upstreamCommand(),
      minutes: '~90 s, 220 MB',
    },
  },
  {
    id: 'workspace-build',
    name: 'workspace build',
    level: 'FAIL',
    detect: (repo) => {
      const missing = WORKSPACE_BUILD.filter((p) => !fs.existsSync(path.join(repo, p)));
      return {
        present: missing.length === 0,
        detail: missing.length === 0 ? 'dist/ present' : `missing ${String(missing.length)}: ${missing[0]}`,
      };
    },
    fix: 'just build  (on a COLD clone the first attempt can fail; run it twice - see retryOnce below)',
    setup: {
      label: 'build every workspace package',
      command: 'pnpm',
      args: ['-r', 'build'],
      minutes: '~1 min',
      /*
        `packages/sesame-api` and `packages/sesame-qemu` are a CYCLIC workspace
        dependency — pnpm says so on install — and on a clone where neither has
        a `dist/` yet, pnpm can schedule them together. `sesame-api`'s `tsc`
        then cannot resolve `@sesame-lab/sesame-qemu` and the recursive build
        exits 2. Measured on a real cold clone; the second attempt succeeds,
        because by then `sesame-qemu/dist` exists.

        So this is retried exactly once, and only on a non-zero exit. It is not
        a general "try again if it did not work" — that would turn a real
        failure into a slower real failure. It is a named workaround for a
        named ordering hazard, and if the second attempt fails the step is
        reported FAILED with both exit codes.
      */
      retryOnce: 'the api/qemu workspace cycle: on a cold clone the first pass has no sesame-qemu/dist to resolve against',
    },
  },
  {
    id: 'web-dist',
    name: 'apps/web/dist',
    level: 'WARN',
    detect: (repo) => {
      const present = fs.existsSync(path.join(repo, 'apps/web/dist/index.html'));
      return { present, detail: present ? 'built' : 'not built' };
    },
    fix: 'just build-web  (`just run`, `just capture` and `just tauri-build` need it; `just dev` does not)',
    // `pnpm -r build` above builds it too, so this normally reports "already
    // present" by the time setup reaches it. It has a command anyway, because
    // it is reachable on its own after `just clean`.
    setup: {
      label: 'build the web app',
      command: 'pnpm',
      args: ['--filter', '@sesame-lab/web', 'build'],
      minutes: '~20 s',
    },
  },
  {
    id: 'qemu',
    name: 'qemu binary',
    level: 'FAIL',
    detect: (repo) => {
      const present = fs.existsSync(path.join(repo, QEMU_BIN));
      return { present, detail: present ? 'tools/qemu/' : 'not fetched' };
    },
    fix: 'node emulator/qemu/fetch-qemu.mjs',
    setup: {
      label: "Espressif's pinned QEMU fork",
      ...node('emulator/qemu/fetch-qemu.mjs'),
      minutes: '~35 s, 173 MB',
    },
  },
  {
    id: 'arduino-toolchain',
    name: 'arduino toolchain',
    level: 'WARN',
    detect: (repo) => {
      const present = fs.existsSync(path.join(repo, ARDUINO_CLI));
      return { present, detail: present ? 'tools/arduino-cli/' : 'not installed' };
    },
    fix: 'pwsh -NoProfile -File scripts/setup-firmware-toolchain.ps1  - only needed to BUILD a flash image',
    setup: {
      label: 'the portable Arduino/ESP32 toolchain (only needed to build a flash image)',
      ...firmwareToolchainCommand(),
      minutes: '~31 min, 14 GB',
      // Skipped when every image `just setup` was asked for is already on disk:
      // the toolchain is a means, not an end, and a clone that was handed its
      // images has no reason to download a gigabyte of compiler.
      onlyIfImagesMissing: true,
    },
  },
  {
    id: 'image-cli',
    name: 'qemu flash image',
    level: 'FAIL',
    detect: (repo) => {
      const present = fs.existsSync(path.join(repo, IMAGE_CLI));
      const dir = path.join(repo, IMAGE_DIR);
      const count = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith('.flash.bin')).length : 0;
      return {
        present,
        detail: present ? `distro-v1-esp32-cli (+${String(count - 1)} other)` : count ? `${String(count)} image(s), not cli` : 'none',
      };
    },
    fix: 'just qemu-image',
    setup: {
      label: 'the flash image `just dev` boots (distro-v1-esp32-cli)',
      ...node('emulator/qemu/build-qemu-images.mjs', 'cli'),
      minutes: '~5.5 min',
      image: IMAGE_CLI,
    },
  },
  {
    id: 'image-nowifi',
    name: 'harness flash image',
    level: 'WARN',
    detect: (repo) => {
      const present = fs.existsSync(path.join(repo, IMAGE_NOWIFI));
      return { present, detail: present ? 'distro-v1-esp32-nowifi' : 'not built' };
    },
    fix: 'node emulator/qemu/build-qemu-images.mjs nowifi  - `just capture` phase 5 needs it',
    setup: {
      label: "the flash image the capture harness's bridge phase boots (distro-v1-esp32-nowifi)",
      ...node('emulator/qemu/build-qemu-images.mjs', 'nowifi'),
      minutes: '~5.5 min',
      image: IMAGE_NOWIFI,
      extra: true,
    },
  },
  {
    id: 'image-oled',
    name: 'desktop flash image',
    level: 'WARN',
    detect: (repo) => {
      const present = fs.existsSync(path.join(repo, IMAGE_OLED));
      return { present, detail: present ? 'distro-v1-esp32-cli-oled' : 'not built' };
    },
    fix: 'node emulator/qemu/build-qemu-images.mjs cli-oled  - `just tauri-build` bundles it',
    setup: {
      label: 'the flash image `just tauri-build` bundles (distro-v1-esp32-cli-oled)',
      ...node('emulator/qemu/build-qemu-images.mjs', 'cli-oled'),
      minutes: '~5.5 min',
      image: IMAGE_OLED,
      extra: true,
    },
  },
];

/** Look one up by id. Throws rather than returning undefined — a typo in a
 *  caller's id would otherwise silently drop a prerequisite from a run. */
export const prereq = (id) => {
  const found = PREREQS.find((p) => p.id === id);
  if (!found) throw new Error(`no prerequisite with id "${id}" (have: ${PREREQS.map((p) => p.id).join(', ')})`);
  return found;
};

/** Evaluate every prerequisite against a checkout. */
export const inspect = (repo) => PREREQS.map((p) => ({ ...p, ...p.detect(repo) }));
