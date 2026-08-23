/**
 * R6 regression guard: **the telemetry must leave through UART0.**
 *
 * The defect this pins was found by R4 after R6 had already "passed". The first
 * cut of the instrumentation emitted with `Serial.printf`, and Arduino-ESP32
 * resolves `Serial` at compile time (`cores/esp32/HardwareSerial.h:441-452`):
 *
 *   ARDUINO_USB_CDC_ON_BOOT=1, ARDUINO_USB_MODE=0  ->  #define Serial USBSerial
 *   ARDUINO_USB_CDC_ON_BOOT=1, ARDUINO_USB_MODE=1  ->  #define Serial HWCDCSerial
 *   ARDUINO_USB_CDC_ON_BOOT=0                      ->  #define Serial Serial0
 *
 * The `s2mini` profile builds with `CDC_ON_BOOT=1 / USB_MODE=0`. So the firmware
 * compiled, linked, contained all three `@SESAME` format strings at verifiable
 * offsets in `.flash.rodata`, passed every check R6 had — and emitted every byte
 * out a USB CDC endpoint, never reaching UART0, which is the transport R3 proved,
 * the one Renode's socket terminal is wired to, and the only one the bridge
 * consumes.
 *
 * That is the shape of failure worth guarding: **telemetry that is perfectly
 * correct and perfectly undelivered.** String presence in the binary cannot see
 * it. Only the `this` pointer at the call site can.
 *
 * So this file asserts on the routing decision at three levels, and — because a
 * check that has never failed is not known to work — it pins the analyser
 * against real captured disassembly of the *defective* build as well as the
 * fixed one.
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { REPO } from './helpers.js';

const PATCH = path.join(REPO, 'firmware/patches/telemetry-instrumentation.patch');
const EVIDENCE = path.join(REPO, 'firmware/build/telemetry-literals.json');
const ARTIFACT_DIR = path.join(REPO, 'firmware/artifacts/s2mini-instrumented');

const patchText = fs.readFileSync(PATCH, 'latin1');
const addedLines = patchText
  .split(/\r?\n/)
  .filter((l) => l.startsWith('+') && !l.startsWith('+++'))
  .map((l) => l.slice(1));
const addedCode = addedLines.filter((l) => !l.trimStart().startsWith('//'));

const analyser = (await import(
  pathToFileURL(path.join(REPO, 'scripts/lib/xtensa-call-args.mjs')).href
)) as {
  resolveArgRegister(lines: readonly string[], from: number, reg: number, maxHops?: number): number | null;
  findTelemetryPrintfSites(
    lines: readonly string[],
    formatVmas: Map<number, string>,
    serialSymbols: Map<number, string>,
  ): { literal: string; callSite: string; formatVma: string; port: string | null }[];
};

// ---------------------------------------------------------------------------
// Level 1 — the source routes everything through one named port.
// ---------------------------------------------------------------------------
describe('R6 transport routing — source', () => {
  it('names UART0 explicitly instead of inheriting whatever `Serial` means', () => {
    expect(addedCode.join('\n')).toMatch(/^#define SESAME_TELEMETRY_PORT Serial0$/m);
  });

  it('emits no @SESAME line through a bare `Serial`', () => {
    // This is the assertion that would have failed on the original patch.
    const stray = addedCode.filter((l) => l.includes('"@SESAME') && !l.includes('SESAME_TELEMETRY_PORT.'));
    expect(stray, `these lines bypass SESAME_TELEMETRY_PORT:\n${stray.join('\n')}`).toEqual([]);

    // Belt and braces: no `Serial.printf(` anywhere in the added code at all.
    // `Serial0.` and `SESAME_TELEMETRY_PORT.` are fine; bare `Serial.` is not.
    const bareSerial = addedCode.filter((l) => /(?<![\w.])Serial\.(printf|print|println|write)\s*\(/.test(l));
    expect(bareSerial, `added code writes to a bare Serial:\n${bareSerial.join('\n')}`).toEqual([]);
  });

  it('opens the port only when the sketch has not already opened it', () => {
    const body = addedCode.join('\n');
    // With CDC_ON_BOOT=0 the core makes `Serial` a literal macro for `Serial0`,
    // so setup()'s own Serial.begin(115200) has already done the work and a
    // second begin() would reinstall the driver over itself.
    expect(body).toMatch(/#if defined\(ARDUINO_USB_CDC_ON_BOOT\) && ARDUINO_USB_CDC_ON_BOOT/);
    expect(body).toMatch(/#define SESAME_TELEMETRY_OWNS_PORT 1/);
    expect(body).toMatch(/#define SESAME_TELEMETRY_OWNS_PORT 0/);
    expect(body).toMatch(/#if SESAME_TELEMETRY_OWNS_PORT\s*\n\s*SESAME_TELEMETRY_PORT\.begin\(SESAME_TELEMETRY_BAUD\);/);
  });

  it('brings telemetry up before the OLED init that hard-fails under emulation', () => {
    // R4: display.begin() returning false enters `while (1);` at :662, and
    // nothing after it ever runs. A hello emitted later never arrives at all.
    //
    // The OLED init is not inside the patch's context, so the comparison is
    // against F4's boot order in hardware-map.json — which is checked in, and
    // carries the file:line provenance this claim needs anyway.
    const bootOrder = JSON.parse(
      fs.readFileSync(path.join(REPO, 'hardware/hardware-map.json'), 'utf8'),
    ).bootOrder as { operation: string; subsystem: string; bootBlocker: boolean; source: { line: number } }[];

    const oledInit = bootOrder.find((b) => b.operation.startsWith('display.begin('));
    expect(oledInit, 'no display.begin() in the hardware-map boot order').toBeDefined();
    expect(oledInit!.bootBlocker).toBe(true);

    // Where does the patch insert sesameTelemetryBegin()? Walk the hunks,
    // counting original-file lines, and read off the line it lands after.
    let originalLine = 0;
    let insertedAfter: number | null = null;
    let sawSerialBegin: number | null = null;
    for (const raw of patchText.split(/\r?\n/)) {
      const hunk = /^@@ -(\d+)/.exec(raw);
      if (hunk) {
        originalLine = Number(hunk[1]) - 1;
        continue;
      }
      if (raw.startsWith('+++') || raw.startsWith('---') || raw.startsWith('diff ') || raw.startsWith('index ')) continue;
      if (raw.startsWith('+')) {
        if (raw.includes('sesameTelemetryBegin();')) insertedAfter = originalLine;
        continue;
      }
      originalLine++;                                   // context or removed line
      if (raw.trimEnd().endsWith('Serial.begin(115200);')) sawSerialBegin = originalLine;
    }

    expect(insertedAfter, 'the patch never calls sesameTelemetryBegin()').not.toBeNull();
    expect(sawSerialBegin, "the patch does not anchor on the sketch's Serial.begin()").not.toBeNull();
    // Immediately after the sketch's own Serial.begin(), and well before the OLED.
    expect(insertedAfter).toBe(sawSerialBegin);
    expect(insertedAfter!).toBeLessThan(oledInit!.source.line);
  });
});

// ---------------------------------------------------------------------------
// Level 2 — the analyser can tell a right answer from a wrong one.
// ---------------------------------------------------------------------------
describe('R6 transport routing — the analyser itself', () => {
  // Verbatim from `objdump -d` of the DEFECTIVE build (instrumented s2mini,
  // ELF b14a9161…), the one that emitted to USB CDC. Kept as evidence, and as
  // the only proof that the check below can fail.
  const DEFECTIVE = `
40085502:	eacd81        	l32r	a8, 40080038 <_stext+0x18> (3ffc9c78 <_ZL10ServoNames>)
4008551a:	eb89b1        	l32r	a11, 40080340 <_stext+0x320> (3f00081c <_flash_rodata_start+0x6fc>)
4008551d:	eb1ea1        	l32r	a10, 40080198 <_stext+0x178> (3ffc9f64 <USBSerial>)
40085522:	0cafe5        	call8	40092020 <_ZN5Print6printfEPKcz>
`.trim().split('\n');

  // Verbatim from the FIXED build (ELF 7c3fd85a…), inside setup(). Note the
  // port arrives in a10 via `mov.n a10, a7` from an l32r 0x25 bytes earlier —
  // a naive "look at the nearest l32r" check reports nothing here.
  const FIXED_FORWARDED = `
40084f68 <setup()>:
40084f68:	010136        	entry	a1, 128
40084f6e:	ec8a21        	l32r	a2, 40080198 <_stext+0x178> (3ffca1f4 <USBSerial>)
40084f79:	20a220        	or	a10, a2, a2
40084f85:	0de0e5        	call8	40092d94 <USBCDC::begin(unsigned long)>
40084f8b:	eca071        	l32r	a7, 4008020c <_stext+0x1ec> (3ffca168 <Serial0>)
40084faa:	0cb0e5        	call8	40091ab8 <HardwareSerial::begin(unsigned long, unsigned long, signed char, signed char, bool, unsigned long, unsigned char)>
40084fb0:	ecc2b1        	l32r	a11, 400802b8 <_stext+0x298> (3f000708 <_flash_rodata_start+0x5e8>)
40084fb5:	07ad        	mov.n	a10, a7
40084fba:	0d53e5        	call8	400924f8 <Print::printf(char const*, ...)>
`.trim().split('\n');

  const SERIALS = new Map<number, string>([
    [0x3ffc9f64, 'USBSerial'],
    [0x3ffca1f4, 'USBSerial'],
    [0x3ffca168, 'Serial0'],
  ]);

  it('reports USBSerial for the build that really did emit to USB CDC', () => {
    const sites = analyser.findTelemetryPrintfSites(
      DEFECTIVE,
      new Map([[0x3f00081c, '@SESAME servo %s %d\\n']]),
      SERIALS,
    );
    expect(sites).toHaveLength(1);
    expect(sites[0]!.port).toBe('USBSerial');   // <-- the defect, reproduced
  });

  it('follows a port forwarded through a callee-saved register', () => {
    const sites = analyser.findTelemetryPrintfSites(
      FIXED_FORWARDED,
      new Map([[0x3f000708, '@SESAME hello %d %s\\n']]),
      SERIALS,
    );
    expect(sites).toHaveLength(1);
    expect(sites[0]!.port).toBe('Serial0');
    // ...and it must not be fooled by the USBSerial that setup() legitimately
    // uses a few instructions earlier for the sketch's own Serial.begin().
    expect(sites[0]!.callSite).toBe('0x40084fba');
  });

  it('ignores printf calls whose format string is not telemetry', () => {
    const sites = analyser.findTelemetryPrintfSites(DEFECTIVE, new Map(), SERIALS);
    expect(sites).toEqual([]);
  });

  it('stops at the enclosing function label rather than reading the previous function', () => {
    // A value defined before the function's own entry point is not this
    // function's value; resolving across the boundary would invent an answer.
    const reg = analyser.resolveArgRegister(FIXED_FORWARDED, 1, 7);
    expect(reg).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Level 3 — the built artifact.
// ---------------------------------------------------------------------------
describe('R6 transport routing — built artifact', () => {
  const evidence = JSON.parse(fs.readFileSync(EVIDENCE, 'utf8')) as {
    routing: {
      available: boolean;
      expectedPort?: string;
      serialSymbols?: Record<string, string>;
      sites?: { literal: string; callSite: string; port: string | null }[];
    };
  };
  const haveRouting = evidence.routing?.available === true;

  it.skipIf(!haveRouting)(
    'every telemetry call site in the ELF takes Serial0 as its `this` pointer ' +
      '(requires: node scripts/build-firmware.mjs s2mini-instrumented && node scripts/extract-telemetry-literals.mjs)',
    () => {
      const sites = evidence.routing.sites ?? [];
      // hello + servo + face. The OLED emitter is compiled out.
      expect(sites).toHaveLength(3);
      for (const site of sites) {
        expect(site.port, `${site.literal} at ${site.callSite}`).toBe('Serial0');
      }
      expect(new Set(sites.map((s) => s.literal)).size).toBe(3);
    },
  );

  it.skipIf(!haveRouting)('the USB CDC object exists in the ELF but is not the telemetry port', () => {
    // Its presence is correct and wanted: the sketch's own Serial.print goes
    // there, so the developer's USB monitor keeps working while telemetry runs
    // on UART0. What matters is that no telemetry site points at it.
    const symbols = evidence.routing.serialSymbols ?? {};
    expect(Object.keys(symbols)).toContain('Serial0');
    expect(Object.keys(symbols)).toContain('USBSerial');
    for (const site of evidence.routing.sites ?? []) expect(site.port).not.toBe('USBSerial');
  });

  // -------------------------------------------------------------------------
  // All three shipped profiles, not just the one R4 happened to catch.
  // -------------------------------------------------------------------------
  //
  // Only `s2mini-instrumented` carries telemetry today, so only it can have the
  // defect today. But the reason the other two are fine is different in each
  // case, and one of those reasons is luck:
  //
  //   s2mini          CDC_ON_BOOT=1 USB_MODE=0  ->  Serial is USBSerial     (would break)
  //   distro-v3-s3    CDC_ON_BOOT=1 USB_MODE=1  ->  Serial is HWCDCSerial   (would break)
  //   distro-v1-esp32 CDC_ON_BOOT=0             ->  Serial IS Serial0       (safe, by accident:
  //                                                 the original ESP32 has no USB peripheral)
  //
  // Pinning the table means that if anyone instruments the S3 profile later, or
  // flips a board option, the assumption is checked rather than assumed.
  const EXPECTED_ALIAS: Record<string, string> = {
    's2mini': 'USBSerial',
    's2mini-instrumented': 'USBSerial',
    'distro-v3-s3': 'HWCDCSerial',
    'distro-v1-esp32': 'Serial0',
  };

  for (const [profile, expectedAlias] of Object.entries(EXPECTED_ALIAS)) {
    const file = path.join(REPO, 'firmware/artifacts', profile, 'build-manifest.json');
    it.skipIf(!fs.existsSync(file))(
      `${profile}: a bare \`Serial\` resolves to ${expectedAlias}, and any telemetry it carries uses Serial0`,
      () => {
        const manifest = JSON.parse(fs.readFileSync(file, 'utf8')) as {
          buildFlags: Record<string, string | null>;
          telemetry: { port: string; portIsUart0: boolean } | null;
        };
        const extra = manifest.buildFlags['build.extra_flags'] ?? '';
        const flag = (k: string) => new RegExp(`-D${k}=([^\\s]+)`).exec(extra)?.[1] ?? null;
        const cdc = flag('ARDUINO_USB_CDC_ON_BOOT');
        const usbMode = flag('ARDUINO_USB_MODE');
        const alias = cdc === '1' ? (usbMode === '1' ? 'HWCDCSerial' : 'USBSerial') : 'Serial0';
        expect(alias, `${profile} build flags: ${extra.slice(0, 200)}`).toBe(expectedAlias);

        // The invariant that actually matters, for every profile, forever:
        // telemetry — if present at all — goes to UART0.
        if (manifest.telemetry) {
          expect(manifest.telemetry.port).toBe('Serial0');
          expect(manifest.telemetry.portIsUart0).toBe(true);
        }
      },
    );
  }

  const manifestPath = path.join(ARTIFACT_DIR, 'build-manifest.json');
  it.skipIf(!fs.existsSync(manifestPath))('the manifest records what a bare `Serial` would have been', () => {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as {
      telemetry: {
        port: string;
        portIsUart0: boolean;
        serialAliasesTo: string;
        telemetryOwnsPort: boolean;
        arduinoUsbCdcOnBoot: string | null;
      };
    };
    expect(manifest.telemetry.port).toBe('Serial0');
    expect(manifest.telemetry.portIsUart0).toBe(true);
    // s2mini is a CDC-on-boot board: this is precisely the profile R4 caught.
    expect(manifest.telemetry.arduinoUsbCdcOnBoot).toBe('1');
    expect(manifest.telemetry.serialAliasesTo).toBe('USBSerial');
    expect(manifest.telemetry.telemetryOwnsPort).toBe(true);
  });
});
