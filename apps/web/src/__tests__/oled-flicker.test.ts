/**
 * The face stopped flickering between `inferred` and `observed` — Phase 4 W5.
 *
 * > *"The face is occasionally flickering between inferred and observed."*
 *
 * The cause was two event paths writing `oledSource` for the SAME face change,
 * in a fixed order, on the default `cli-oled` QEMU image:
 *
 *   `face.expression`  ->  the app renders `firmware/face-bitmaps.h` host-side
 *                          and labels those pixels `inferred`
 *   `oled.frame`       ->  the guest's own 1024 bytes arrive, and the same
 *                          panel is relabelled `observed`
 *
 * The firmware's idle-blink state machine repeats that pair every 120-220 ms.
 * Nothing was wrong with either label — each was true about the pixels that had
 * just been drawn — so a debounce would have made a correct label lag rather
 * than fixing anything. What was wrong was drawing two sets of pixels.
 *
 * These tests drive the store with the interleaved sequence and assert the
 * label never leaves `observed` once the capability is declared, and never
 * *enters* it when the capability is false. Both directions matter: the whole
 * property W8 built is that this is derived from the capability document rather
 * than from which backend is connected, and a fix that pinned `observed` for
 * everyone would have destroyed it.
 *
 * ## The one that would have failed before
 *
 * `alternating face/frame events leave one steady claim` fails on the previous
 * build with `pixelProvenance` reading `inferred` on every odd sample — that is
 * the flicker, as an array.
 */
import { OLED_FRAME_BYTES, base64Encode } from '@sesame-lab/sesame-protocol';
import type { SesameTelemetry } from '@sesame-lab/sesame-protocol';
import { describe, expect, it } from 'vitest';

import { renderFace } from '../oled/framebuffer.js';
import { pixelOrigin } from '../oled/pixel-provenance.js';
import type { EmulatorFacts } from '../backends/types.js';
import { TelemetryStore } from '../state/telemetry-store.js';

/** The face every one of these uses: it has frames, so `renderFace` succeeds. */
const FACE = 'happy';

/** The guest's own buffer, as `oled.frame` carries it. Not all zeroes. */
function guestFrame(seq: number): SesameTelemetry {
  const rendered = renderFace(FACE, 0);
  if (rendered === null) throw new Error(`${FACE} has no frames; pick another fixture face`);
  // Flip a byte so this buffer is distinguishable from the host render.
  const bytes = Uint8Array.from(rendered.gddram);
  bytes[0] = bytes[0] === 0 ? 0xff : 0;
  return {
    type: 'oled.frame',
    seq,
    provenance: 'observed',
    origin: { kind: 'emulator' },
    pixels: base64Encode(bytes),
  } as SesameTelemetry;
}

function faceEvent(seq: number, name = FACE): SesameTelemetry {
  return {
    type: 'face.expression',
    seq,
    provenance: 'observed',
    origin: { kind: 'emulator' },
    name,
    frame: 0,
  } as SesameTelemetry;
}

function facts(oledFramebuffer: boolean): EmulatorFacts {
  return {
    origin: { kind: 'emulator', engine: 'qemu-system-xtensa/9.2.2', board: 'distro-v1-esp32' },
    board: 'distro-v1-esp32',
    unsupportedBoards: {},
    commandChannel: 'uart0',
    elided: oledFramebuffer ? ['ssd1306-glass'] : ['ssd1306-panel'],
    firmwareDeviations: [],
    knownFlakiness: '',
    oledFramebuffer,
    mode: null,
    everObserved: null,
    lastCommandLine: null,
    panic: null,
  };
}

/** One face change under the `cli-oled` image: the name, then the buffer. */
function runInterleaved(store: TelemetryStore, pairs: number): string[] {
  const seen: string[] = [];
  let seq = 1;
  for (let i = 0; i < pairs; i += 1) {
    store.ingest(faceEvent(seq++));
    seen.push(String(store.oledSource.pixelProvenance));
    store.ingest(guestFrame(seq++));
    seen.push(String(store.oledSource.pixelProvenance));
  }
  return seen;
}

describe('the framebuffer capability, declared', () => {
  it('starts false, so nothing changes for a backend that never declares one', () => {
    expect(new TelemetryStore().oledFramebufferDeclared).toBe(false);
  });

  it('alternating face/frame events leave ONE steady claim', () => {
    const store = new TelemetryStore();
    store.declareOledFramebuffer(true);
    store.ingest(guestFrame(1));
    const seen = runInterleaved(store, 6);
    expect(new Set(seen)).toEqual(new Set(['observed']));
    expect(store.oledSource.kind).toBe('wire');
  });

  it('...and WITHOUT the declaration the same sequence really does alternate', () => {
    // Not a curiosity: this is the behaviour being fixed, and asserting it here
    // is what proves the test above is measuring the fix rather than a constant.
    const store = new TelemetryStore();
    store.declareOledFramebuffer(false);
    store.ingest(guestFrame(1));
    const seen = runInterleaved(store, 3);
    expect(new Set(seen)).toEqual(new Set(['inferred', 'observed']));
  });

  it('a face NAME on a framebuffer backend does not write the panel', () => {
    const store = new TelemetryStore();
    store.declareOledFramebuffer(true);
    store.ingest(guestFrame(1));
    const afterFrame = store.panel.base64;
    store.ingest(faceEvent(2, 'sad'));
    expect(store.panel.base64).toBe(afterFrame);
    expect(store.oledSource.kind).toBe('wire');
  });

  it('...and on a backend without one it does, which is the honest path', () => {
    const store = new TelemetryStore();
    store.declareOledFramebuffer(false);
    const before = store.panel.base64;
    store.ingest(faceEvent(1));
    expect(store.panel.base64).not.toBe(before);
    expect(store.oledSource.kind).toBe('rendered');
    expect(store.oledSource.pixelProvenance).toBe('inferred');
  });

  it('still reports the FACE itself, because that name really did cross the wire', () => {
    const store = new TelemetryStore();
    store.declareOledFramebuffer(true);
    store.ingest(faceEvent(1, 'sad'));
    expect(store.face?.name).toBe('sad');
    expect(store.face?.provenance).toBe('observed');
  });

  it('still reports ISSUE-20260823-004 — a face with zero frames draws nothing', () => {
    // The zero-frame branch must survive the change: it is true on every
    // backend and it is the one thing this handler may never stop saying.
    const store = new TelemetryStore();
    store.declareOledFramebuffer(true);
    store.ingest(faceEvent(1, 'stand'));
    expect(store.emptyFace?.requested).toBe('stand');
    expect(store.emptyFace?.reason).toMatch(/zero frames/);
  });

  it('the declaration is idempotent and reversible', () => {
    const store = new TelemetryStore();
    store.declareOledFramebuffer(true);
    store.declareOledFramebuffer(true);
    expect(store.oledFramebufferDeclared).toBe(true);
    store.declareOledFramebuffer(false);
    expect(store.oledFramebufferDeclared).toBe(false);
    store.ingest(faceEvent(1));
    expect(store.oledSource.kind).toBe('rendered');
  });
});

describe('what the pane then says', () => {
  it('is one sentence for the whole sequence on a framebuffer image', () => {
    const store = new TelemetryStore();
    store.declareOledFramebuffer(true);
    store.ingest(guestFrame(1));
    const claims = new Set<string>();
    for (let i = 0; i < 8; i += 1) {
      store.ingest(faceEvent(10 + i));
      claims.add(pixelOrigin(facts(true), store.oledSource).claim);
      store.ingest(guestFrame(100 + i));
      claims.add(pixelOrigin(facts(true), store.oledSource).claim);
    }
    expect([...claims]).toEqual(['These pixels came from the emulator — the buffer the firmware drew.']);
  });

  it('and one sentence for the older image, which is the other one', () => {
    const store = new TelemetryStore();
    store.declareOledFramebuffer(false);
    const claims = new Set<string>();
    for (let i = 0; i < 4; i += 1) {
      store.ingest(faceEvent(10 + i));
      claims.add(pixelOrigin(facts(false), store.oledSource).claim);
    }
    expect([...claims]).toEqual(['These pixels did not come from the emulator.']);
  });
});

describe('the guest frame fixture', () => {
  it('is a real 1024-byte page-ordered buffer', () => {
    const store = new TelemetryStore();
    store.declareOledFramebuffer(true);
    store.ingest(guestFrame(1));
    expect(store.panel.gddram.length).toBe(OLED_FRAME_BYTES);
  });
});
