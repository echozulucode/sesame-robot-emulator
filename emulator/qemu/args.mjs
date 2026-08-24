// Shared CLI argument parsing for the emulator/qemu scripts.
//
// Why this exists: the original `arg()` helper was
//
//   const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i > 0 ? process.argv[i + 1] : d; };
//
// which silently ignores any flag it does not recognise. A typo'd or invented
// flag therefore produced a full, expensive emulator run with the DEFAULT
// value, and no indication that the flag had done nothing. That is the worst
// kind of CLI: it looks like it obeyed you.
//
// This helper rejects unknown flags, validates numbers, and supports --help.

import path from 'node:path';

/**
 * @param {object} spec
 * @param {string} spec.name        script name, for usage output
 * @param {string} spec.summary     one-line description
 * @param {Record<string, {describe: string, type?: 'string'|'number'|'boolean', default?: unknown}>} spec.flags
 * @param {string[]} [spec.positional] names of accepted positional args
 * @param {string[]} [argv]          defaults to process.argv.slice(2)
 * @returns {Record<string, unknown> & { _: string[] }}
 */
export function parseArgs(spec, argv = process.argv.slice(2)) {
  const known = new Set(Object.keys(spec.flags));
  const out = { _: [] };
  for (const [name, def] of Object.entries(spec.flags)) {
    if ('default' in def) out[name] = def.default;
    else if (def.type === 'boolean') out[name] = false;
  }

  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i];

    if (tok === '--help' || tok === '-h') {
      printUsage(spec);
      process.exit(0);
    }

    if (!tok.startsWith('--')) {
      out._.push(tok);
      continue;
    }

    // Support --name=value as well as --name value.
    const eq = tok.indexOf('=');
    const name = eq === -1 ? tok.slice(2) : tok.slice(2, eq);

    if (!known.has(name)) {
      const hint = nearest(name, [...known]);
      process.stderr.write(
        `${spec.name}: unknown option --${name}` +
        (hint ? ` (did you mean --${hint}?)` : '') + '\n\n' +
        `This script does NOT ignore unrecognised flags, because doing so used to\n` +
        `produce a full emulator run that silently used default values.\n\n`,
      );
      printUsage(spec, process.stderr);
      process.exit(2);
    }

    const def = spec.flags[name];

    if (def.type === 'boolean') {
      out[name] = eq === -1 ? true : tok.slice(eq + 1) !== 'false';
      continue;
    }

    const raw = eq === -1 ? argv[++i] : tok.slice(eq + 1);
    if (raw === undefined) {
      process.stderr.write(`${spec.name}: --${name} requires a value\n`);
      process.exit(2);
    }

    if (def.type === 'number') {
      const n = Number(raw);
      if (!Number.isFinite(n)) {
        process.stderr.write(`${spec.name}: --${name} expects a number, got "${raw}"\n`);
        process.exit(2);
      }
      out[name] = n;
      continue;
    }

    out[name] = raw;
  }

  const maxPositional = spec.positional?.length ?? 0;
  if (out._.length > maxPositional) {
    process.stderr.write(
      `${spec.name}: unexpected argument "${out._[maxPositional]}"\n`,
    );
    printUsage(spec, process.stderr);
    process.exit(2);
  }

  return out;
}

function printUsage(spec, stream = process.stdout) {
  const pos = (spec.positional ?? []).map((p) => ` [${p}]`).join('');
  stream.write(`${spec.summary}\n\n`);
  stream.write(`usage: node ${path.posix.join('emulator/qemu', spec.name)}${pos} [options]\n\n`);
  const width = Math.max(...Object.keys(spec.flags).map((k) => k.length), 4);
  for (const [name, def] of Object.entries(spec.flags)) {
    const dflt = 'default' in def && def.default !== undefined && def.default !== ''
      ? ` (default: ${def.default})`
      : '';
    stream.write(`  --${name.padEnd(width)}  ${def.describe}${dflt}\n`);
  }
  stream.write(`  ${'--help'.padEnd(width + 2)}  show this message\n`);
}

// Cheap Levenshtein, only used to suggest a correction on an unknown flag.
function nearest(input, candidates) {
  let best = null;
  let bestScore = Infinity;
  for (const c of candidates) {
    const d = distance(input, c);
    if (d < bestScore) { bestScore = d; best = c; }
  }
  return bestScore <= Math.max(2, Math.floor(input.length / 3)) ? best : null;
}

function distance(a, b) {
  const dp = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 0; j <= b.length; j++) dp[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      dp[i][j] = Math.min(
        dp[i - 1][j] + 1,
        dp[i][j - 1] + 1,
        dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
  }
  return dp[a.length][b.length];
}
