/**
 * Shared test fixtures: a deterministic PRNG, an exhaustive event generator,
 * and a representative "nasty" byte stream.
 */
import { JOINT_ORDER } from '@sesame-lab/sesame-model';

import { FACE_CATALOG, MAX_FACE_FRAMES } from '../catalog.js';
import { PROVENANCES, type Provenance, type SesameTelemetry } from '../events.js';
import { OLED_FRAME_BYTES, encodeOledFrame, setOledPixel } from '../oled.js';

/** mulberry32 — small, deterministic, good enough for split-point fuzzing. */
export function makeRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A deterministic non-blank 128x64 frame. */
export function sampleFrame(seed = 1): Uint8Array {
  const buffer = new Uint8Array(OLED_FRAME_BYTES);
  const random = makeRandom(seed);
  for (let y = 0; y < 64; y++) {
    for (let x = 0; x < 128; x++) {
      if (random() < 0.35) setOledPixel(buffer, x, y, true);
    }
  }
  return buffer;
}

/**
 * Every event kind, across every axis that affects the wire form, and
 * constructed so that a correct parser emits **no warnings** for any of them.
 *
 * That last property is what makes the round-trip assertion a strict deep
 * equality rather than a fuzzy comparison.
 */
export function warningFreeEvents(): SesameTelemetry[] {
  const events: SesameTelemetry[] = [];
  let seq = 0;

  const decorate = (provenanceIndex: number): {
    seq: number;
    provenance: Provenance;
    simTimeUs?: number;
    traceId?: string;
  } => {
    const provenance = PROVENANCES[provenanceIndex % PROVENANCES.length] as Provenance;
    const n = seq++;
    return {
      seq: n,
      provenance,
      ...(n % 2 === 0 ? { simTimeUs: n * 1000 + 7 } : {}),
      ...(n % 3 === 0 ? { traceId: `wave-${String(n).padStart(4, '0')}` } : {}),
    };
  };

  // servo.target: every joint x the clamp endpoints and some interior values.
  const angles = [0, 1, 72, 90, 179, 180];
  JOINT_ORDER.forEach((joint, jointIndex) => {
    angles.forEach((angleDeg, angleIndex) => {
      events.push({
        type: 'servo.target',
        ...decorate(jointIndex + angleIndex),
        joint,
        angleDeg,
      });
    });
  });

  // face.expression: every catalog face, with and without a frame index.
  FACE_CATALOG.forEach((face, index) => {
    events.push({ type: 'face.expression', ...decorate(index), name: face.name });
    const maxFrame = face.frameCount > 0 ? face.frameCount - 1 : MAX_FACE_FRAMES - 1;
    for (const frame of new Set([0, maxFrame])) {
      events.push({ type: 'face.expression', ...decorate(index + 1), name: face.name, frame });
    }
  });

  // oled.frame: blank, dense, and all-on.
  const allOn = new Uint8Array(OLED_FRAME_BYTES).fill(0xff);
  [new Uint8Array(OLED_FRAME_BYTES), sampleFrame(7), allOn].forEach((buffer, index) => {
    events.push({
      type: 'oled.frame',
      ...decorate(index),
      width: 128,
      height: 64,
      pixels: encodeOledFrame(buffer),
    });
  });

  // log: every channel, plus texts that exercise the free-text field.
  const texts = [
    '',
    'ok',
    'Sesame booting',
    'a  b   c',
    'value=42 not a tag because it is not in the tag run',
    'unicode: °C ✓',
    'punctuation !"#$%&()*+,-./:;<>?[]^_`{|}~',
  ];
  (['uart', 'firmware', 'emulator'] as const).forEach((channel, channelIndex) => {
    texts.forEach((text, textIndex) => {
      events.push({
        type: 'log',
        ...decorate(channelIndex + textIndex),
        channel,
        text,
      });
    });
  });

  // protocol.hello: with and without an emitter identity.
  [
    { protocolVersion: 1, emitter: '' },
    { protocolVersion: 1, emitter: 'sesame-fw-s2mini/0.1.0' },
    { protocolVersion: 0, emitter: 'replay-harness' },
  ].forEach((hello, index) => {
    events.push({ type: 'protocol.hello', ...decorate(index), ...hello });
  });

  return events;
}

/**
 * A byte stream that contains everything the parser is supposed to survive:
 * boot logging, CRLF and lone-CR terminators, telnet IAC negotiation, a
 * sentinel mid-line, two concatenated segments with no newline between them, an
 * unknown verb, a malformed line, a full OLED frame, and a partial line at EOF.
 */
export function nastyStream(): Uint8Array {
  const parts: (string | Uint8Array)[] = [];

  parts.push('ets Jul 29 2019 12:21:46\r\n');
  parts.push('rst:0x1 (POWERON),boot:0x8 (SPI_FAST_FLASH_BOOT)\r\n');
  // Telnet negotiation, exactly what telnetMode:true would splice in.
  parts.push(new Uint8Array([0xff, 0xfb, 0x01, 0xff, 0xfd, 0x03]));
  parts.push('Sesame firmware starting\n');
  parts.push('@SESAME hello 1 sesame-fw-s2mini/0.1.0\n');
  parts.push('I2C ok, SSD1306 ok\r');
  parts.push('@SESAME servo R1 90\n');
  parts.push('@SESAME servo t=1234567 R2 45\n');
  parts.push('@SESAME face wave 0\n');
  parts.push('boot: @SESAME servo L1 12\n');
  parts.push('@SESAME servo L2 33@SESAME face happy\n');
  parts.push('@SESAME frobnicate 1 2 3\n');
  parts.push('@SESAME servo R9 72\n');
  parts.push('@SESAME servo R4 999\n');
  parts.push('@SESAME log firmware entering runWavePose\n');
  parts.push('@SESAME oled b64 ' + encodeOledFrame(sampleFrame(3)) + '\n');
  parts.push('\r\n\n\r');
  parts.push('@SESAME servo p=s x=wave-0042 L4 180\r\n');
  parts.push(new Uint8Array([0xff, 0xff, 0x80, 0x81]));
  parts.push('trailing partial line with no terminator');

  const encoder = new TextEncoder();
  const chunks = parts.map((p) => (typeof p === 'string' ? encoder.encode(p) : p));
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}
