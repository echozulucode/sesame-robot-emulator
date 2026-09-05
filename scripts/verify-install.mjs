/**
 * Install the NSIS installer somewhere fresh and check what a recipient gets —
 * Phase 5 T6.
 *
 * T2 ran this by hand once and wrote the transcript into its finding. That is
 * fine for a claim about a build; it is not fine for the deliverable, which is
 * *"it installs on a machine that has never seen this project"* and which stops
 * being true silently — a resource dropped from `bundle.resources`, a licence
 * file renamed, an installer that starts wanting administrator rights.
 *
 * So it is a script, with the same three-outcome discipline
 * `verify-packaged-honesty.mjs` uses:
 *
 *   exit 0   installed, checked, and (unless --keep) uninstalled again
 *   exit 1   something is wrong, named
 *   exit 2   there was no installer to check — NOT the same as "everything
 *            passed", which is why it is a third code
 *
 * ## The discipline this exists to enforce
 *
 * Everything the installed application is asked to do is asked of it with:
 *
 *   * the **repository nowhere on PATH** — every entry under the repo root is
 *     stripped, and the result is asserted to contain none;
 *   * `NODE_PATH`, `PNPM_HOME`, `CARGO_HOME` and friends removed;
 *   * the working directory set to a **freshly created empty directory** that
 *     is not inside the repository and not inside the install.
 *
 * That is T2's empty-directory test, kept honest: `app.path()` resolves against
 * the directory the executable is in, so an installed copy checks the installed
 * copy — and a path that leaked in from the developer's machine has nowhere to
 * hide.
 *
 * ## Usage
 *
 *   node scripts/verify-install.mjs                 install, check, uninstall
 *   node scripts/verify-install.mjs --keep          leave the install in place
 *   node scripts/verify-install.mjs --no-emulator   skip the QEMU boot (fast)
 *   node scripts/verify-install.mjs --check <dir>   re-run the file checks
 *                                                   against an existing install
 *
 * `--check <dir>` is there for the negative controls: delete a licence file or
 * flip a byte in one, re-run, and watch it refuse. A check that has never
 * refused anything is not known to be a check.
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PRODUCT = 'Sesame Robot Emulator';
const EXE = 'sesame-robot-emulator.exe';

const problems = [];
const placeholderNotes = [];
const notes = [];
const fail = (message) => problems.push(message);
const check = (ok, message) => {
  if (!ok) fail(message);
  return ok;
};
const log = (line) => process.stdout.write(`${line}\n`);

/* ------------------------------------------------------------------ layout
 *
 * Every licence file the installer is required to place, and the repository
 * file it must be byte-identical to.
 *
 * The map is written out here rather than derived from `tauri.conf.json`,
 * deliberately and against this project's usual instinct: `build.rs` already
 * derives the RESOURCE MANIFEST from the config, so a licence dropped from the
 * config would drop out of the manifest too and `--resource-report` would go on
 * saying `ok` about a shorter list. This list is the second opinion. It is the
 * only place in the repository that says, independently of the config, which
 * licence texts a recipient must end up holding.
 */
const REQUIRED_LICENCES = {
  'licenses/README.txt': 'licenses/README.txt',
  'licenses/Sesame-Robot-Emulator-LICENSE-Apache-2.0.txt': 'LICENSE',
  'licenses/Sesame-Robot-Emulator-NOTICE.txt': 'NOTICE',
  'licenses/THIRD-PARTY-NOTICES.md': 'THIRD-PARTY-NOTICES.md',
  'licenses/QEMU-GPL-2.0.txt': 'licenses/QEMU-GPL-2.0.txt',
  'licenses/QEMU-LICENSE.txt': 'licenses/QEMU-LICENSE.txt',
  'licenses/QEMU-SOURCE-OFFER.txt': 'licenses/QEMU-SOURCE-OFFER.txt',
  'licenses/LGPL-2.1.txt': 'licenses/LGPL-2.1.txt',
  'licenses/FIRMWARE-LGPL-RELINK.txt': 'licenses/FIRMWARE-LGPL-RELINK.txt',
};

/**
 * Sentences that must survive into the installed copy of a licence text.
 *
 * A file can be present, the right size, and still be the wrong document — the
 * failure T2 §4 named for resources ("a resource that is present at the wrong
 * size is worse than one that is absent") has a quieter cousin here, where a
 * text file with a plausible name contains a placeholder or a summary. So the
 * operative sentences are asserted, not the file names.
 */
const REQUIRED_PHRASES = {
  'licenses/QEMU-GPL-2.0.txt': [
    'GNU GENERAL PUBLIC LICENSE',
    'Version 2, June 1991',
    'You may copy and distribute the Program',
    'Accompany it with a written offer, valid for at least three',
  ],
  'licenses/LGPL-2.1.txt': [
    'GNU LESSER GENERAL PUBLIC LICENSE',
    'Version 2.1, February 1999',
    'link a "work that uses the Library" with the Library',
  ],
  'licenses/QEMU-LICENSE.txt': [
    'The QEMU emulator as a whole is released under the GNU General',
    'Public License, version 2',
  ],
  'licenses/QEMU-SOURCE-OFFER.txt': [
    'THREE (3) YEARS',
    'esp-develop-9.2.2-20260417',
    'complete corresponding machine-readable source code',
  ],
  'licenses/FIRMWARE-LGPL-RELINK.txt': [
    'LGPL-2.1-or-later',
    'firmware/build/sketch.yaml',
    'section 6',
  ],
  'licenses/Sesame-Robot-Emulator-LICENSE-Apache-2.0.txt': ['Apache License', 'Version 2.0, January 2004'],
  'licenses/Sesame-Robot-Emulator-NOTICE.txt': ['Sesame Robot Project', 'NOTICE OF MODIFICATION'],
  'licenses/README.txt': ['GNU General Public License, version 2', 'QEMU-SOURCE-OFFER.txt'],
};

/** The marker left where the user has to supply something nobody may invent. */
const PLACEHOLDER = '[[FILL IN';

const sha256 = (file) => createHash('sha256').update(fs.readFileSync(file)).digest('hex');

/**
 * The two Start Menu entries a per-user NSIS install writes, by name.
 *
 * The app's own is Tauri's; the licences one is `src-tauri/installer-hooks.nsh`
 * and exists because a licence file inside a folder nobody opens is not
 * "accompanying" anything.
 */
function startMenuShortcuts() {
  const programs = path.join(
    process.env.APPDATA ?? path.join(os.homedir(), 'AppData', 'Roaming'),
    'Microsoft',
    'Windows',
    'Start Menu',
    'Programs',
  );
  return {
    'the application': path.join(programs, `${PRODUCT}.lnk`),
    'the licences': path.join(programs, `${PRODUCT} licences.lnk`),
  };
}

/* ------------------------------------------------------- the scrubbed child
 *
 * One place that builds the environment, so no call site can forget.
 */
function cleanEnv() {
  const env = { ...process.env };
  const repo = REPO.toLowerCase();
  const sep = path.delimiter;
  const kept = (env.PATH ?? env.Path ?? '')
    .split(sep)
    .filter((entry) => entry.trim() !== '' && !entry.toLowerCase().includes(repo));
  delete env.PATH;
  delete env.Path;
  env.PATH = kept.join(sep);
  for (const key of ['NODE_PATH', 'PNPM_HOME', 'npm_config_local_prefix', 'INIT_CWD', 'CARGO_HOME', 'RUSTUP_HOME']) {
    delete env[key];
  }
  const leaked = kept.filter((entry) => entry.toLowerCase().includes(repo));
  check(
    leaked.length === 0,
    `the scrubbed PATH still contains ${leaked.length} entry(s) under the repository: ${leaked.join(', ')}`,
  );
  return env;
}

function runInstalled(exe, args, cwd, timeoutMs = 300000) {
  return spawnSync(exe, args, {
    cwd,
    env: cleanEnv(),
    encoding: 'utf8',
    timeout: timeoutMs,
    windowsHide: true,
  });
}

/* --------------------------------------------------------------- the icon
 *
 * Decode the 16x16 entry of the shipped .ico and count the pixels of the face
 * colour. T1 §6 left the Tauri default logo in place and named it as T6's; a
 * 1024x1024 preview says nothing about the cell the icon is actually seen in.
 */
function icoFace(icoPath) {
  const buf = fs.readFileSync(icoPath);
  if (buf.readUInt16LE(0) !== 0 || buf.readUInt16LE(2) !== 1) return { error: 'not an .ico' };
  const count = buf.readUInt16LE(4);
  const sizes = [];
  let entry = null;
  for (let i = 0; i < count; i += 1) {
    const off = 6 + i * 16;
    const width = buf[off] === 0 ? 256 : buf[off];
    sizes.push(width);
    if (width === 16) entry = { bytes: buf.readUInt32LE(off + 8), at: buf.readUInt32LE(off + 12) };
  }
  if (entry === null) return { sizes, error: 'no 16x16 entry' };
  const image = buf.subarray(entry.at, entry.at + entry.bytes);
  if (image.readUInt32BE(0) !== 0x89504e47) return { sizes, error: '16x16 entry is not a PNG' };
  // minimal PNG reader: 8-bit RGBA, the only thing `tauri icon` emits
  let p = 8;
  let width = 0;
  let height = 0;
  let colour = 0;
  const idat = [];
  while (p + 8 <= image.length) {
    const len = image.readUInt32BE(p);
    const type = image.toString('ascii', p + 4, p + 8);
    const data = image.subarray(p + 8, p + 8 + len);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      colour = data[9];
    }
    if (type === 'IDAT') idat.push(data);
    p += 12 + len;
  }
  if (colour !== 6) return { sizes, error: `16x16 entry is colour type ${colour}, not RGBA` };
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const bpp = 4;
  const stride = width * bpp;
  const out = Buffer.alloc(height * stride);
  let q = 0;
  for (let y = 0; y < height; y += 1) {
    const filter = raw[q];
    q += 1;
    for (let x = 0; x < stride; x += 1) {
      const a = x >= bpp ? out[y * stride + x - bpp] : 0;
      const b = y > 0 ? out[(y - 1) * stride + x] : 0;
      const c = x >= bpp && y > 0 ? out[(y - 1) * stride + x - bpp] : 0;
      let v = raw[q + x];
      if (filter === 1) v += a;
      else if (filter === 2) v += b;
      else if (filter === 3) v += (a + b) >> 1;
      else if (filter === 4) {
        const pp = a + b - c;
        const pa = Math.abs(pp - a);
        const pb = Math.abs(pp - b);
        const pc = Math.abs(pp - c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      out[y * stride + x] = v & 255;
    }
    q += stride;
  }
  // the face is --observed #4ec9a0: green dominant, opaque, and nothing else in
  // the icon is that colour
  let face = 0;
  let opaque = 0;
  for (let i = 0; i < out.length; i += 4) {
    const [r, g, b, a] = [out[i], out[i + 1], out[i + 2], out[i + 3]];
    if (a > 200) opaque += 1;
    if (a > 200 && g > 140 && g > r + 40 && b > 100 && b < g) face += 1;
  }
  return { sizes, width, height, facePixels: face, opaquePixels: opaque };
}

/* --------------------------------------------------------------- the checks */

function checkInstalledTree(dir) {
  log(`\n[install] checking the installed tree at ${dir}`);
  const exe = path.join(dir, `${PRODUCT}.exe`);
  const exeAlt = path.join(dir, EXE);
  const found = fs.existsSync(exe) ? exe : fs.existsSync(exeAlt) ? exeAlt : null;
  check(found !== null, `neither "${PRODUCT}.exe" nor ${EXE} is in ${dir}`);

  // ---- the licence texts a recipient who never sees the repository gets
  let placeholders = 0;
  for (const [target, source] of Object.entries(REQUIRED_LICENCES)) {
    const installed = path.join(dir, ...target.split('/'));
    const origin = path.join(REPO, ...source.split('/'));
    if (!check(fs.existsSync(installed), `the installer did not place ${target}. A licence a recipient cannot find is not accompanying the binary.`)) {
      continue;
    }
    const bytes = fs.statSync(installed).size;
    check(bytes > 0, `${target} is installed but empty`);
    if (fs.existsSync(origin)) {
      const same = sha256(installed) === sha256(origin);
      check(
        same,
        `${target} in the install is not byte-identical to ${source} in the repository ` +
          `(${bytes} B vs ${fs.statSync(origin).size} B). The installed copy is the one a ` +
          `recipient reads, so it is the one that has to be right.`,
      );
    }
    const text = fs.readFileSync(installed, 'utf8');
    for (const phrase of REQUIRED_PHRASES[target] ?? []) {
      check(
        text.includes(phrase),
        `${target} does not contain ${JSON.stringify(phrase)}. The file is present and is not the ` +
          `document it is named after.`,
      );
    }
    let line = 0;
    for (const l of text.split('\n')) {
      line += 1;
      if (l.includes(PLACEHOLDER)) {
        placeholders += 1;
        placeholderNotes.push(`${target}:${line} — ${l.trim().slice(0, 96)}`);
      }
    }
  }
  check(
    fs.existsSync(path.join(dir, 'licenses')),
    'there is no licenses\\ folder beside the executable',
  );

  // ---- and the two Start Menu entries, which are how a recipient finds either
  for (const [what, lnk] of Object.entries(startMenuShortcuts())) {
    check(
      fs.existsSync(lnk),
      `the installer created no Start Menu entry for ${what} (${lnk}). "Sesame Robot Emulator" is what a ` +
        `child types into the Start menu, and the licences are only accompanying the binary if ` +
        `someone can find them a year later.`,
    );
  }

  // ---- the icon, in the cell it is actually seen in
  const ico = path.join(REPO, 'src-tauri', 'icons', 'icon.ico');
  if (fs.existsSync(ico)) {
    const face = icoFace(ico);
    if (check(face.error === undefined, `src-tauri/icons/icon.ico: ${face.error ?? ''}`)) {
      check(
        face.facePixels >= 8,
        `the 16x16 entry of icon.ico has ${face.facePixels} pixels of the face colour. At 16 px the ` +
          `two eyes and the mouth are the whole icon; if they have vanished into the background ` +
          `the icon is a dark square and nobody can find it on a taskbar.`,
      );
      log(
        `[install] icon.ico: sizes ${face.sizes.join('/')}, 16x16 has ${face.facePixels} face ` +
          `pixels of ${face.opaquePixels} opaque`,
      );
    }
  }

  return { exe: found, placeholders };
}

function main() {
  const argv = process.argv.slice(2);
  const keep = argv.includes('--keep');
  const skipEmulator = argv.includes('--no-emulator');
  const checkOnly = argv.includes('--check') ? argv[argv.indexOf('--check') + 1] : null;

  if (checkOnly !== null) {
    checkInstalledTree(path.resolve(checkOnly));
    return report();
  }

  const bundle = path.join(REPO, 'src-tauri', 'target', 'release', 'bundle', 'nsis');
  const installer = fs.existsSync(bundle)
    ? fs.readdirSync(bundle).filter((f) => f.endsWith('-setup.exe')).map((f) => path.join(bundle, f))[0]
    : undefined;
  if (installer === undefined) {
    log(
      `SKIPPED  no NSIS installer under ${bundle}.\n` +
        `         Build one with \`just tauri-build\`. Nothing was verified — this is exit 2, not exit 0.`,
    );
    process.exit(2);
  }

  const stamp = `sesame-install-${Date.now().toString(36)}`;
  const root = path.join(os.tmpdir(), stamp);
  const dir = path.join(root, 'app');
  const empty = path.join(root, 'empty-cwd');
  fs.mkdirSync(empty, { recursive: true });

  log(`[install] installer  ${installer} (${(fs.statSync(installer).size / 1048576).toFixed(1)} MiB)`);
  log(`[install] target     ${dir}   (did not exist)`);

  // /S silent, /D target — /D must be last and unquoted, which is NSIS's rule
  // and not a typo.
  const install = spawnSync(installer, ['/S', `/D=${dir}`], { encoding: 'utf8', timeout: 300000 });
  check(install.status === 0, `the installer exited ${String(install.status)}: ${install.stderr ?? ''}`);
  check(fs.existsSync(dir), `the installer did not create ${dir}`);
  if (!fs.existsSync(dir)) return report();

  const { exe, placeholders } = checkInstalledTree(dir);
  if (exe === null) return report();

  // ---- the resource report, from an empty directory, repository off PATH
  log(`\n[install] --resource-report, cwd ${empty}, repository stripped from PATH`);
  const reportPath = path.join(root, 'resource-report.json');
  const rr = runInstalled(exe, ['--resource-report', reportPath], empty, 120000);
  check(rr.status === 0, `--resource-report exited ${String(rr.status)} from the installed copy`);
  let resources = null;
  if (fs.existsSync(reportPath)) {
    resources = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
    check(resources.ok === true, `the installed copy reports ${resources.present}/${resources.total} resources present`);
    check(
      resources.resourceDir.toLowerCase().startsWith(dir.toLowerCase()),
      `the installed copy resolved its resources to ${resources.resourceDir}, which is not inside ` +
        `the install. That is a path that came from somewhere other than app.path().`,
    );
    const missed = (resources.entries ?? []).filter((e) => !e.ok);
    for (const entry of missed) fail(`installed resource ${entry.target}: ${entry.problem}`);
    log(
      `[install] resources  ${resources.present}/${resources.total} present, ` +
        `${(resources.bytes / 1048576).toFixed(1)} MiB, resourceDir ${resources.resourceDir}`,
    );
    const licences = (resources.entries ?? []).filter((e) => e.target.startsWith('licenses/'));
    check(
      licences.length === Object.keys(REQUIRED_LICENCES).length,
      `the installed copy's own manifest lists ${licences.length} licence resources; this script ` +
        `requires ${Object.keys(REQUIRED_LICENCES).length}. The two lists are deliberately ` +
        `independent — bundle.resources drives one and this script is the other — so a ` +
        `disagreement means a licence was dropped from the config.`,
    );
  } else {
    fail('the installed copy wrote no resource report');
  }

  // ---- and the emulator, booted from the install, with nothing else on PATH
  if (!skipEmulator) {
    log(`\n[install] --emulator-selftest (boots the bundled QEMU), cwd ${empty}`);
    const selftest = path.join(root, 'emulator-selftest.json');
    const es = runInstalled(exe, ['--emulator-selftest', selftest, '--cycles', '1'], empty, 300000);
    check(es.status === 0, `--emulator-selftest exited ${String(es.status)} from the installed copy`);
    if (fs.existsSync(selftest)) {
      const doc = JSON.parse(fs.readFileSync(selftest, 'utf8'));
      const cycle = (doc.cycles ?? [])[0] ?? doc;
      check(cycle.ok === true, `the installed copy could not boot its own bundled QEMU`);
      check(
        (doc.survivors ?? []).length === 0,
        `${(doc.survivors ?? []).length} qemu-system-xtensa.exe survived the installed copy's selftest`,
      );
      log(
        `[install] emulator   booted in ${String(cycle.bootMs)} ms after ${String(cycle.attempts)} ` +
          `attempt(s), ${String(cycle.uartBytes)} UART bytes, survivors ${String((doc.survivors ?? []).length)}`,
      );
    } else {
      fail('the installed copy wrote no emulator selftest report');
    }
  }

  // ---- uninstall, and prove it left nothing
  if (!keep) {
    const uninstaller = fs.readdirSync(dir).find((f) => /^uninstall.*\.exe$/i.test(f));
    if (check(uninstaller !== undefined, `no uninstaller in ${dir}`)) {
      log(`\n[install] uninstalling with ${uninstaller} /S`);
      const un = spawnSync(path.join(dir, uninstaller), ['/S'], { encoding: 'utf8', timeout: 300000 });
      check(un.status === 0, `the uninstaller exited ${String(un.status)}`);

      /*
        The uninstaller is ASYNCHRONOUS, and the first version of this got it
        wrong in the way that matters.

        NSIS copies itself to %TEMP% and re-launches, so the process spawnSync
        waited for has already returned while the real work is still going on —
        and the work is not one deletion but four: the install directory, the
        HKCU uninstall key, two Start Menu entries and the WebView2 profile
        under %LOCALAPPDATA%. Polling only the DIRECTORY and then asserting the
        other three reported all four as survivors after a perfectly clean
        uninstall, with a log line beside them cheerfully saying the opposite.
        So the wait is for the whole condition, the assertion is that same
        predicate evaluated once more afterwards, and the log line is derived
        from it rather than typed.
      */
      const webview = path.join(
        process.env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData', 'Local'),
        'com.echozed.sesame-robot-emulator',
      );
      const leftovers = () => {
        const key = spawnSync(
          'reg',
          ['query', 'HKCU\Software\Microsoft\Windows\CurrentVersion\Uninstall', '/s', '/f', PRODUCT],
          { encoding: 'utf8' },
        );
        return {
          files: fs.existsSync(dir) ? fs.readdirSync(dir) : [],
          registry: key.status === 0 && (key.stdout ?? '').includes(PRODUCT) ? (key.stdout ?? '') : null,
          shortcuts: Object.entries(startMenuShortcuts()).filter(([, lnk]) => fs.existsSync(lnk)),
          webview: fs.existsSync(webview),
        };
      };
      // `webview` is deliberately NOT part of `clean`: a silent uninstall never
      // removes it (see below), so waiting for it would always burn the full
      // deadline and then report a note anyway.
      const clean = (l) => l.files.length === 0 && l.registry === null && l.shortcuts.length === 0;
      const deadline = Date.now() + 60000;
      let state = leftovers();
      while (!clean(state) && Date.now() < deadline) {
        spawnSync(process.execPath, ['-e', 'setTimeout(() => {}, 400)']);
        state = leftovers();
      }
      check(
        state.files.length === 0,
        `the uninstaller left ${state.files.length} entry(s) behind in ${dir}: ${state.files.slice(0, 8).join(', ')}`,
      );
      check(
        state.registry === null,
        `an uninstall registry entry for ${PRODUCT} survived the uninstaller:
${String(state.registry).slice(0, 400)}`,
      );
      for (const [what, lnk] of state.shortcuts) {
        check(false, `the Start Menu entry for ${what} survived the uninstaller: ${lnk}`);
      }
      /*
        The WebView2 profile is a NOTE, not a failure, and the distinction was
        measured rather than assumed.

        The generated `installer.nsi` removes `$LOCALAPPDATA\${BUNDLEID}` only
        inside `${If} $DeleteAppDataCheckboxState = 1` — the "delete application
        data" checkbox on the uninstaller's page, which a `/S` uninstall does
        not tick. So a silent uninstall leaves it by design, exactly as it
        leaves a browser profile, and asserting otherwise made this check fail
        on a correct uninstall the second time it was run.

        It is reported rather than ignored because "nothing was left behind" is
        a claim, and this is the one thing that is: about 15 MB of WebView2
        cache under the bundle id, holding no Sesame Robot Emulator state — the app writes
        nothing there — and removed by ticking the box, or by deleting the
        folder.
      */
      if (state.webview) {
        notes.push(
          `${webview} — the WebView2 cache. A silent uninstall leaves it: the generated NSIS ` +
            `script only removes it when the uninstaller's "delete application data" checkbox is ` +
            `ticked, which /S does not tick. Sesame Robot Emulator stores nothing in it.`,
        );
      }
      log(
        `[install] uninstalled: ${state.files.length} file(s) left, ` +
          `${state.registry === null ? 'no' : 'an'} HKCU uninstall entry, ` +
          `${state.shortcuts.length} Start Menu entry(s) left, ` +
          `WebView2 cache ${state.webview ? 'left in place (see the note below)' : 'removed'}`,
      );
    }
    try {
      fs.rmSync(root, { recursive: true, force: true });
    } catch {
      /* the temp root is best-effort */
    }
  } else {
    log(`\n[install] --keep: the install is still at ${dir}`);
  }

  if (placeholders > 0) {
    log(
      `\n[install] ${placeholders} placeholder(s) in the installed licence texts. These are ` +
        `DELIBERATE and must be filled in by hand before this installer is given to anyone:`,
    );
    for (const line of placeholderNotes) log(`          ${line}`);
  }
  if (notes.length > 0) {
    log(`
[install] ${notes.length} note(s) — not failures, but things worth knowing:`);
    for (const line of notes) log(`          ${line}`);
  }

  return report();
}

function report() {
  if (problems.length === 0) {
    log(`\nOK    the installed application checks out — ${problems.length} problem(s)`);
    process.exit(0);
  }
  log(`\nFAIL  the installed application — ${problems.length} problem(s):`);
  for (const problem of problems) log(`  - ${problem}`);
  process.exit(1);
}

main();
