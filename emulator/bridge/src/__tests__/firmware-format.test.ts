/**
 * R6 — does the instrumented firmware's wire format match the R5 parser
 * byte-for-byte?
 *
 * The failure mode this test is shaped to avoid: writing
 * `expect(parse('@SESAME servo R4 72'))` and calling it verification. That
 * asserts nothing about the firmware. If the C literal said `@SESAME srvo`, or
 * put a tag after the joint name, or forgot the newline, that test would still
 * pass — two copies of the same typo agree with each other perfectly.
 *
 * So no `@SESAME` string is typed anywhere below. Every line fed to the parser
 * is rendered from a format string **extracted from
 * `firmware/patches/telemetry-instrumentation.patch`**, which is the text that
 * produces the compiled source. The only things this file supplies are the
 * printf arguments and the expected decoded meaning.
 *
 * Three levels, weakest to strongest:
 *
 *   1. patch  -> parser        always runs, works on a clean clone
 *   2. patch  -> evidence file cross-check, so the checked-in evidence cannot rot
 *   3. patch  -> built ELF     runs only after `build-firmware s2mini-instrumented`,
 *                              and is the only level that proves the bytes
 *                              survived the compiler. Skipped WITH A REASON
 *                              otherwise, never silently absent.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { JOINT_ORDER } from '@sesame-lab/sesame-model';
import { SesameTelemetryParser, type SesameTelemetry } from '@sesame-lab/sesame-protocol';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const PATCH = path.join(REPO, 'firmware/patches/telemetry-instrumentation.patch');
const EVIDENCE = path.join(REPO, 'firmware/build/telemetry-literals.json');
const ARTIFACT_DIR = path.join(REPO, 'firmware/artifacts/s2mini-instrumented');

const patchText = fs.readFileSync(PATCH, 'latin1');
/** Lines the patch ADDS. Context lines came from upstream, which has no telemetry. */
const addedLines = patchText
  .split(/\r?\n/)
  .filter((l) => l.startsWith('+') && !l.startsWith('+++'))
  .map((l) => l.slice(1));

/**
 * Added lines that are code, not commentary. The comments discuss `micros()`
 * and the sentinel at length; asserting against them would be asserting against
 * prose.
 */
const addedCode = addedLines.filter((l) => !l.trimStart().startsWith('//')).join('\n');

/** Every `@SESAME…` C string literal in the added CODE. */
const literals = [...addedCode.matchAll(/"(@SESAME[^"\\]*(?:\\.[^"\\]*)*)"/g)].map((m) => m[1] as string);

/** The C escapes these literals are allowed to use. Anything else is a bug. */
function unescapeC(s: string): string {
  return s.replace(/\\(.)/g, (_, c: string) => {
    const table: Record<string, string> = { n: '\n', r: '\r', t: '\t', '\\': '\\', '"': '"' };
    const v = table[c];
    if (v === undefined) throw new Error(`unsupported C escape \\${c}`);
    return v;
  });
}

/** Just enough printf for `%s`, `%d` and `%u`. */
function renderPrintf(format: string, args: readonly (string | number)[]): string {
  let i = 0;
  const rendered = unescapeC(format).replace(/%[sdu]/g, (spec) => {
    const arg = args[i++];
    if (arg === undefined) throw new Error(`format '${format}' wants more arguments than were supplied`);
    if (spec === '%s') return String(arg);
    if (typeof arg !== 'number' || !Number.isInteger(arg)) throw new Error(`${spec} needs an integer, got ${String(arg)}`);
    if (spec === '%u' && arg < 0) throw new Error('%u needs a non-negative integer');
    return String(arg);
  });
  if (i !== args.length) throw new Error(`format '${format}' consumed ${i} of ${args.length} arguments`);
  return rendered;
}

const literalFor = (verb: string): string => {
  const hit = literals.find((l) => l.startsWith(`@SESAME ${verb} `));
  if (hit === undefined) throw new Error(`the patch emits no '${verb}' literal; found: ${literals.join(' | ')}`);
  return hit;
};

/** Parse a complete stream in one push, as a plain array. */
function parseAll(text: string, options = {}): SesameTelemetry[] {
  const parser = new SesameTelemetryParser(options);
  return [...parser.push(text), ...parser.flush()];
}

describe('R6 wire format, extracted from the instrumentation patch', () => {
  it('the patch really does add telemetry emitters', () => {
    // Guards the extraction itself: if the regex or the patch shape ever change
    // so that nothing is found, every other test in this file would vacuously
    // pass with an empty literal set.
    expect(literals.length).toBeGreaterThanOrEqual(3);
    expect(literals.map((l) => l.split(' ')[1])).toEqual(
      expect.arrayContaining(['servo', 'face', 'hello']),
    );
  });

  it('every literal is a well-formed single line with no tag in an argument slot', () => {
    for (const literal of literals) {
      // Tags are legal only between the verb and the positional arguments. A
      // `t=…` where an argument belongs makes `@SESAME servo R2 t=1234 45`
      // parse as bad-angle — the exact trap the R5 spec warns about.
      expect(literal, `tag in an argument slot: ${literal}`).not.toMatch(/^@SESAME \S+ \S+=\S+/);
      // A `log` body may contain arbitrary text, which would then be re-split
      // on the sentinel. Firmware simply must not emit the verb.
      expect(literal, `firmware emits the log verb: ${literal}`).not.toMatch(/^@SESAME log\b/);
      expect(literal, `not newline-terminated: ${literal}`).toMatch(/\\n$/);
      expect(unescapeC(literal).split('\n')).toHaveLength(2);
    }
  });

  it('does not emit a simulated-time tag', () => {
    // micros() is wall clock on real silicon. Labelling it `t=` would make a
    // hardware trace look like a deterministic emulator trace.
    for (const literal of literals) expect(literal).not.toMatch(/\bt=/);
    expect(addedCode).not.toMatch(/micros\(\)/);
  });

  describe('hook 1 — setServoAngle', () => {
    const format = literalFor('servo');

    it('decodes to servo.target for every joint in firmware order', () => {
      for (const [index, joint] of JOINT_ORDER.entries()) {
        const angle = index * 20;          // 0..140, all inside the firmware clamp
        const events = parseAll(renderPrintf(format, [joint, angle]));
        expect(events).toHaveLength(1);
        const event = events[0]!;
        expect(event.type).toBe('servo.target');
        if (event.type !== 'servo.target') return;
        expect(event.joint).toBe(joint);
        expect(event.angleDeg).toBe(angle);
        expect(event.warnings ?? []).toEqual([]);
      }
    });

    it('carries the clamp endpoints without warning', () => {
      // The hook fires after `constrain(angle + subtrim, 0, 180)`, so 0 and 180
      // are the only extremes it can produce and neither may be flagged.
      for (const angle of [0, 180]) {
        const [event] = parseAll(renderPrintf(format, ['R1', angle]));
        expect(event?.type).toBe('servo.target');
        expect(event?.warnings ?? []).toEqual([]);
      }
    });

    it('survives being chopped at every byte boundary', () => {
      const stream = JOINT_ORDER.map((j, i) => renderPrintf(format, [j, 10 + i])).join('');
      const whole = parseAll(stream);
      for (let split = 1; split < stream.length; split++) {
        const parser = new SesameTelemetryParser();
        const events = [
          ...parser.push(stream.slice(0, split)),
          ...parser.push(stream.slice(split)),
          ...parser.flush(),
        ];
        expect(events, `split at ${split}`).toEqual(whole);
      }
    });
  });

  describe('hook 2 — updateFaceBitmap', () => {
    const format = literalFor('face');

    it('decodes to face.expression with the frame index', () => {
      // idle_blink, not wave: the parser validates the frame index against the
      // face's real frame count, and `wave` has exactly one frame. Picking a
      // single-frame face here would test the warning path by accident.
      const [event] = parseAll(renderPrintf(format, ['idle_blink', 3]));
      expect(event?.type).toBe('face.expression');
      if (event?.type !== 'face.expression') return;
      expect(event.name).toBe('idle_blink');
      expect(event.frame).toBe(3);
      expect(event.warnings ?? []).toEqual([]);
    });

    it('warns rather than rejects when a frame index runs past the face', () => {
      // `stand` and `default` have NO defined frames at all (F3: the weak
      // epd_bitmap_stand / epd_bitmap_defualt symbols are never defined), so a
      // frame index for them is always out of range. The event still arrives.
      const [event] = parseAll(renderPrintf(format, ['wave', 5]));
      expect(event?.type).toBe('face.expression');
      expect(event?.warnings?.map((w) => w.code)).toContain('frame-out-of-range');
    });

    it('passes an unknown face through with a warning rather than rejecting it', () => {
      const [event] = parseAll(renderPrintf(format, ['not_a_real_face', 0]));
      expect(event?.type).toBe('face.expression');
      expect(event?.warnings?.map((w) => w.code)).toContain('unknown-face');
    });

    it('sanitises the name with a class that cannot break the frame', () => {
      // The name reaches this hook straight from POST /api/command and the
      // serial console, so the C sanitiser is the only thing standing between
      // user input and a forged telemetry segment. Assert on the actual
      // character class in the patch, not on a re-implementation of it.
      const sanitiser = addedCode.match(/const bool ok =([\s\S]*?);/)?.[1];
      expect(sanitiser, 'no sanitiser found in the patch').toBeTruthy();
      expect(sanitiser).toContain("c >= 'A' && c <= 'Z'");
      expect(sanitiser).toContain("c >= 'a' && c <= 'z'");
      expect(sanitiser).toContain("c >= '0' && c <= '9'");
      // The two characters that would actually corrupt a frame.
      expect(sanitiser).not.toContain("' '");
      expect(sanitiser).not.toContain("'@'");
      // ...and the sanitised buffer, not the raw String, is what gets printed.
      expect(addedCode).toMatch(/sesameSafeToken\(name\.c_str\(\), safe, sizeof\(safe\)\)/);
      expect(addedCode).toMatch(/"@SESAME face %s %u\\n", safe/);
    });
  });

  describe('boot banner — hello', () => {
    const format = literalFor('hello');

    it('decodes to protocol.hello at the version the parser implements', () => {
      const [event] = parseAll(renderPrintf(format, [1, 'sesame-fw-s2mini/0.1.0']));
      expect(event?.type).toBe('protocol.hello');
      if (event?.type !== 'protocol.hello') return;
      expect(event.protocolVersion).toBe(1);
      expect(event.emitter).toBe('sesame-fw-s2mini/0.1.0');
      expect(event.warnings ?? []).toEqual([]);
    });

    it('uses the version macro the patch defines', () => {
      const macro = addedCode.match(/#define SESAME_TELEMETRY_VERSION (\d+)/)?.[1];
      expect(macro).toBe('1');
    });
  });

  describe('the OLED hook', () => {
    it('exists but is compiled out by default', () => {
      // 1385 bytes is ~120 ms of UART0 at 115200 baud, six times the 20 ms
      // motorCurrentDelay it would be emitted inside. It ships disabled.
      const body = addedCode;
      expect(body).toMatch(/#define SESAME_TELEMETRY_OLED 0/);
      expect(body).toMatch(/#if SESAME_TELEMETRY_OLED/);
      expect(literals.some((l) => l.startsWith('@SESAME oled '))).toBe(true);
    });

    it('would produce a payload the parser accepts if enabled', () => {
      const format = literalFor('oled');
      const payload = Buffer.alloc(1024).toString('base64');
      expect(payload).toHaveLength(1368);
      const [event] = parseAll(renderPrintf(format, [payload]));
      expect(event?.type).toBe('oled.frame');
      if (event?.type !== 'oled.frame') return;
      expect(event.width).toBe(128);
      expect(event.height).toBe(64);
    });
  });

  describe('a whole hook sequence, as the firmware would interleave it', () => {
    it('keeps sentinel lines and plain Serial.println text in order', () => {
      const stream =
        renderPrintf(literalFor('hello'), [1, 'sesame-fw-s2mini/0.1.0']) +
        'WAVE\n' +                                        // plain Serial.println(F("WAVE"))
        renderPrintf(literalFor('face'), ['wave', 0]) +
        renderPrintf(literalFor('servo'), ['R4', 80]) +
        renderPrintf(literalFor('servo'), ['L3', 180]);
      const events = parseAll(stream);
      expect(events.map((e) => e.type)).toEqual([
        'protocol.hello',
        'log',
        'face.expression',
        'servo.target',
        'servo.target',
      ]);
      expect(events.map((e) => e.seq)).toEqual([0, 1, 2, 3, 4]);
    });
  });
});

describe('R6 evidence file', () => {
  it('records exactly the literals the patch contains', () => {
    const evidence = JSON.parse(fs.readFileSync(EVIDENCE, 'utf8')) as {
      patch: { sha256: string };
      literals: { literal: string; expectedInBinary: boolean }[];
    };
    expect(evidence.literals.map((l) => l.literal).sort()).toEqual([...literals].sort());
    // The OLED literal is the one that must NOT reach the binary.
    for (const entry of evidence.literals) {
      expect(entry.expectedInBinary).toBe(!entry.literal.startsWith('@SESAME oled '));
    }
  });
});

describe('R6 built artifact', () => {
  const elf = path.join(ARTIFACT_DIR, 'sesame-firmware-main.ino.elf');
  const bin = path.join(ARTIFACT_DIR, 'sesame-firmware-main.ino.bin');
  const built = fs.existsSync(elf) && fs.existsSync(bin);

  // Artifacts are gitignored, so on a clean clone this is unbuilt. Skipping with
  // a reason keeps the gap visible instead of pretending it was checked.
  it.skipIf(!built)(
    'contains the enabled literals verbatim, and not the compile-gated one ' +
      `(requires: node scripts/build-firmware.mjs s2mini-instrumented)`,
    () => {
      const elfBuf = fs.readFileSync(elf);
      const binBuf = fs.readFileSync(bin);
      for (const literal of literals) {
        const bytes = Buffer.from(unescapeC(literal), 'latin1');
        const gated = literal.startsWith('@SESAME oled ');
        expect(elfBuf.includes(bytes), `${literal} in .elf`).toBe(!gated);
        expect(binBuf.includes(bytes), `${literal} in .bin`).toBe(!gated);
      }
    },
  );

  const stock = path.join(REPO, 'firmware/artifacts/s2mini/sesame-firmware-main.ino.elf');
  it.skipIf(!fs.existsSync(stock))('the stock s2mini build carries no telemetry at all', () => {
    // If it did, the flash delta attributed to instrumentation would be measuring
    // something else.
    expect(fs.readFileSync(stock).includes(Buffer.from('@SESAME'))).toBe(false);
  });
});
