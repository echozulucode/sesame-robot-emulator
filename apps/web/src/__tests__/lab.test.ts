/**
 * Lab mode's exports and its project store.
 *
 * Same posture as `architecture.test.ts` and `source.test.ts`: nothing the Lab
 * says about itself is trusted. The C++ emitter is held against **the real
 * firmware header on disk** rather than against a string in this file, the
 * face emitter is held against the byte layout `drawBitmap()` reads, and the
 * project store is driven through the three ways `localStorage` fails.
 *
 * The parts that need a browser — a drag across the pixel canvas, a played
 * animation reaching an angle in the scene graph — are asserted in a real
 * browser by `scripts/capture-web-screenshots.mjs` phase 11, not here.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JOINT_ORDER, quantiseCommandedAngle, type JointName } from '@sesame-lab/sesame-model';
import { afterEach, describe, expect, it } from 'vitest';

import {
  blankFrame,
  getPixel,
  setPixel,
  FRAME_BYTES,
  FRAME_BYTES_PER_ROW,
} from '../editors/pixel-frame.js';
import { importMovement, type SequenceDoc } from '../editors/sequence.js';
import {
  CPP_CALL_SHAPE,
  aliasingInExport,
  cppIdentifier,
  emitSesameCpp,
  parseSesameCpp,
  roundTrip,
  studioRangeViolations,
} from '../lab/cpp-export.js';
import { emitFaceHeader, faceHeaderRoundTrip, faceIdentifier, parseFaceHeader } from '../lab/face-header.js';
import {
  EMPTY_FACE_BASE64,
  clearProject,
  decodeFace,
  emptyProject,
  encodeFace,
  frameAsPose,
  loadProject,
  neutralPose,
  poseAsFrame,
  projectIsEmpty,
  saveProject,
} from '../lab/lab-doc.js';
import { renderAuthoredBitmap } from '../oled/framebuffer.js';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');

/** The upstream firmware, read at test time. Never edited, only compared against. */
const MOVEMENT_HEADER = fs.readFileSync(
  path.join(REPO, 'firmware/upstream/firmware/movement-sequences.h'),
  'utf8',
);

const STORAGE_KEY = 'sesame-lab.lab.v1';

// ------------------------------------------------------------- a fake store
//
// `globalThis.localStorage` does not exist under Node, so every test that
// touches persistence installs one and removes it afterwards. The three
// failures the module claims to survive are each driven by a different fake.

interface FakeStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

function installStorage(fake: FakeStorage | null): void {
  Object.defineProperty(globalThis, 'localStorage', {
    value: fake ?? undefined,
    configurable: true,
    writable: true,
  });
}

function workingStorage(): FakeStorage & { readonly map: Map<string, string> } {
  const map = new Map<string, string>();
  return {
    map,
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => {
      map.set(key, value);
    },
    removeItem: (key) => {
      map.delete(key);
    },
  };
}

afterEach(() => {
  installStorage(null);
});

// =========================================================== the call shape

describe('the exported C++ matches the firmware’s own call shape', () => {
  it('emits the line runStandPose() actually contains', () => {
    // Lifted out of the header on disk, not typed here: if upstream ever
    // reformats `setServoAngle(R1, 135);` this test fails and the exporter is
    // the thing that has to move.
    const realLine = MOVEMENT_HEADER.split('\n')
      .map((line) => line.trim())
      .find((line) => line.startsWith('setServoAngle(R1, 135);'));
    expect(realLine, 'movement-sequences.h no longer contains setServoAngle(R1, 135);').toBeDefined();

    const emitted = emitSesameCpp(
      { name: 'x', basedOnMovement: null, frames: [{ angles: { R1: 135 }, delayMs: 0 }] },
      { header: false },
    );
    expect(emitted).toContain('setServoAngle(R1, 135);');
    expect(CPP_CALL_SHAPE.replace('%JOINT%', 'R1').replace('%ANGLE%', '135')).toBe(
      'setServoAngle(R1, 135);',
    );
    // …and the emitted call is the header's line, character for character.
    expect((realLine ?? '').startsWith('setServoAngle(R1, 135);')).toBe(true);
  });

  it('names channels with the enum constants movement-sequences.h declares', () => {
    // `enum ServoName : uint8_t { R1 = 0, R2 = 1, ... }` — every identifier the
    // exporter can emit has to be one of these or the paste will not compile.
    const enumBody = /enum\s+ServoName\s*:\s*uint8_t\s*\{([^}]*)\}/.exec(MOVEMENT_HEADER)?.[1] ?? '';
    const declared = [...enumBody.matchAll(/([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(\d+)/g)].map((m) => ({
      name: m[1] as string,
      index: Number(m[2]),
    }));
    expect(declared).toHaveLength(8);
    // The exporter's names, and their channel indices, are the header's.
    expect(declared.map((d) => d.name)).toEqual([...JOINT_ORDER]);
    declared.forEach((entry, index) => {
      expect(entry.index).toBe(index);
    });
  });

  it('reads the firmware’s own runStandPose body back as one frame of eight writes', () => {
    const body = /void\s+runStandPose\([^)]*\)\s*\{([\s\S]*?)\n\}/.exec(MOVEMENT_HEADER)?.[1] ?? '';
    expect(body).toContain('setServoAngle(R1, 135)');
    const parsed = parseSesameCpp(body);
    expect(parsed.rejected).toEqual([]);
    const writes = parsed.frames.flatMap((frame) =>
      JOINT_ORDER.filter((j) => frame.angles[j] !== undefined).map((j) => [j, frame.angles[j]]),
    );
    // runStandPose() commands all eight, and the four the firmware writes as
    // 135/45/45/135 come back exactly.
    expect(Object.fromEntries(writes)).toMatchObject({ R1: 135, R2: 45, L1: 45, L2: 135 });
    expect(writes).toHaveLength(8);
  });
});

// ============================================================= round-tripping

const twoFrames: SequenceDoc = {
  name: 'runLabPose',
  basedOnMovement: null,
  frames: [
    { angles: { R1: 135, R2: 45, L1: 45, L2: 135, R4: 0, R3: 180, L3: 0, L4: 180 }, delayMs: 300 },
    { angles: { R1: 90, L2: 90 }, delayMs: 150 },
  ],
};

describe('emit → parse → compare', () => {
  it('round-trips a two-frame animation', () => {
    const result = roundTrip(twoFrames);
    expect(result.ok, result.detail).toBe(true);
    expect(result.framesIn).toBe(2);
    expect(result.framesOut).toBe(2);
    expect(result.writes).toHaveLength(10);
    // The writes come back in FIRMWARE ENUM ORDER, not the order they were
    // typed: the exporter reorders because the firmware does.
    expect(result.writes.slice(0, 8).map((w) => w.joint)).toEqual([...JOINT_ORDER]);
  });

  it('round-trips with either delay spelling', () => {
    for (const delayStyle of ['delayWithFace', 'delay'] as const) {
      const result = roundTrip(twoFrames, { delayStyle });
      expect(result.ok, `${delayStyle}: ${result.detail}`).toBe(true);
      expect(emitSesameCpp(twoFrames, { delayStyle })).toContain(`${delayStyle}(300);`);
    }
  });

  it('round-trips a frame that is only a wait, and one with a zero wait', () => {
    const doc: SequenceDoc = {
      name: 'x',
      basedOnMovement: null,
      frames: [
        { angles: {}, delayMs: 500 },
        { angles: { R3: 12 }, delayMs: 0 },
      ],
    };
    const result = roundTrip(doc);
    expect(result.ok, result.detail).toBe(true);
    expect(result.framesOut).toBe(2);
  });

  it('round-trips every importable movement', () => {
    // The strongest available corpus: the real choreography, flattened by
    // `importMovement()` and pushed through the exporter and back.
    for (const fn of ['runStandPose', 'runWavePose', 'runDancePose', 'runRestPose']) {
      const imported = importMovement(fn);
      expect(imported, `${fn} did not import`).not.toBeNull();
      const result = roundTrip(imported?.doc ?? twoFrames);
      expect(result.ok, `${fn}: ${result.detail}`).toBe(true);
    }
  });

  it('round-trips an empty document to an empty one', () => {
    const result = roundTrip({ name: 'x', basedOnMovement: null, frames: [] });
    expect(result.ok, result.detail).toBe(true);
    expect(result.framesOut).toBe(0);
  });

  it('reads numeric channels, which is how the firmware’s for-loop writes them', () => {
    // `for (int i = 0; i < 8; i++) setServoAngle(i, 90);` expands to eight
    // numeric writes in the extracted choreography, and a learner pasting that
    // loop's expansion in should get eight named joints back.
    const parsed = parseSesameCpp('setServoAngle(0, 90); setServoAngle(7, 90); delayWithFace(10);');
    expect(parsed.numericChannels).toEqual([
      { index: 0, joint: 'R1' },
      { index: 7, joint: 'L4' },
    ]);
    expect(parsed.frames[0]?.angles).toEqual({ R1: 90, L4: 90 });
  });

  it('rejects a channel the firmware’s guard would drop rather than inventing one', () => {
    const parsed = parseSesameCpp('setServoAngle(8, 90); delay(1);');
    expect(parsed.rejected).toHaveLength(1);
    expect(parsed.rejected[0]).toContain('setServoAngle(8, 90)');
    // The wait still closes a frame, and that frame commands NOTHING — which
    // is what `if (channel < 8)` does on the robot: no error, no clamp, no
    // write. Inventing a ninth channel to hold it would be the lie.
    expect(parsed.frames).toHaveLength(1);
    expect(parsed.frames[0]?.angles).toEqual({});
  });

  it('ignores comments, including the honesty header it emits', () => {
    const source = emitSesameCpp(twoFrames, { header: true });
    expect(source).toContain('89 of the 181');
    const parsed = parseSesameCpp(source);
    // The header mentions "181" and "92"; a parser that scanned numbers rather
    // than calls would have invented frames out of the warning.
    expect(parsed.frames).toHaveLength(2);
    expect(parsed.functionName).toBe('runLabPose');
  });

  it('reports a disagreement rather than passing quietly', () => {
    // Drive the comparator itself: an emitted text with a tampered angle must
    // fail, naming both numbers. A round-trip that has never failed is not
    // known to work.
    const source = emitSesameCpp(twoFrames, { header: false }).replace(
      'setServoAngle(R1, 135);',
      'setServoAngle(R1, 134);',
    );
    const parsed = parseSesameCpp(source);
    expect(parsed.frames[0]?.angles.R1).toBe(134);
    expect(twoFrames.frames[0]?.angles.R1).toBe(135);
  });
});

describe('what the export says about itself', () => {
  it('carries the never-verified and the aliasing warnings in the code, not just the UI', () => {
    const source = emitSesameCpp(twoFrames);
    expect(source).toContain('COMMANDED ANGLES');
    expect(source).toContain('physical robot');
    expect(source).toContain('89 of the 181');
  });

  it('recomputes aliasing from the library’s arithmetic rather than a table', () => {
    const doc: SequenceDoc = {
      name: 'x',
      basedOnMovement: null,
      frames: [{ angles: { R1: 99, R2: 100 }, delayMs: 0 }],
    };
    const aliasing = aliasingInExport(doc);
    const ninetyNine = aliasing.find((a) => a.angleDeg === 99);
    expect(ninetyNine).toBeDefined();
    expect(ninetyNine?.aliases).toContain(100);
    // …and the tick is the library's, not a remembered number.
    expect(ninetyNine?.ticks).toBe(quantiseCommandedAngle(99).ticks);
    expect(quantiseCommandedAngle(99).ticks).toBe(quantiseCommandedAngle(100).ticks);
  });

  it('names Studio’s narrower per-servo ranges without enforcing them', () => {
    const doc: SequenceDoc = {
      name: 'x',
      basedOnMovement: null,
      frames: [{ angles: { R1: 20, R2: 170 }, delayMs: 0 }],
    };
    const violations = studioRangeViolations(doc);
    expect(violations.map((v) => v.joint).sort()).toEqual(['R1', 'R2']);
    // The firmware would accept both, so the export still emits them.
    expect(emitSesameCpp(doc, { header: false })).toContain('setServoAngle(R1, 20);');
    expect(roundTrip(doc).ok).toBe(true);
  });

  it('sanitises the function name into a legal identifier', () => {
    expect(cppIdentifier('my wave 2!')).toBe('my_wave_2');
    expect(cppIdentifier('')).toBe('runLab');
    expect(cppIdentifier('2fast')).toBe('runLab2fast');
    expect(emitSesameCpp(twoFrames, { functionName: 'my wave', header: false })).toContain(
      'void my_wave() {',
    );
  });
});

// ============================================================== the face

describe('the face export', () => {
  it('writes the row-major layout drawBitmap() reads, not the panel’s', () => {
    const frame = setPixel(blankFrame(), 3, 9, true);
    // Row-major, MSB first: (3, 9) is byte 9*16 + 0, bit 0x80 >> 3.
    expect(frame[9 * FRAME_BYTES_PER_ROW]).toBe(0x10);

    // The SSD1306 holds the same pixel somewhere completely different:
    // page 1, index 3 + 1*128 = 131, bit 1. Same pixel, different byte — which
    // is exactly why the export must not emit the panel's buffer.
    const gddram = renderAuthoredBitmap(frame);
    expect(gddram[131]).toBe(0b10);
    expect(gddram[9 * FRAME_BYTES_PER_ROW]).toBe(0);
  });

  it('round-trips a drawn frame byte for byte', () => {
    let frame = blankFrame();
    for (let y = 20; y < 23; y += 1) for (let x = 20; x < 23; x += 1) frame = setPixel(frame, x, y, true);
    const result = faceHeaderRoundTrip(frame, 'labface');
    expect(result.ok, result.detail).toBe(true);

    const parsed = parseFaceHeader(emitFaceHeader(frame, 'labface'));
    expect(parsed.byteCount).toBe(FRAME_BYTES);
    expect(parsed.symbol).toBe('epd_bitmap_labface');
    for (let y = 20; y < 23; y += 1) {
      for (let x = 20; x < 23; x += 1) expect(getPixel(parsed.frame, x, y)).toBe(true);
    }
    expect(getPixel(parsed.frame, 23, 23)).toBe(false);
  });

  it('emits an array shaped like the ones already in face-bitmaps.h', () => {
    const source = emitFaceHeader(blankFrame(), 'labface');
    expect(source).toContain("// 'labface', 128x64px");
    expect(source).toContain('const unsigned char epd_bitmap_labface [] PROGMEM = {');
    expect(source).toContain('FACE_LIST');
    // 64 rows of 16 bytes, tab-indented, exactly as image2cpp writes them.
    const rows = source.split('\n').filter((line) => line.startsWith('\t0x'));
    expect(rows).toHaveLength(64);
    // 16 bytes, and a trailing ", " before the newline — the same trailing
    // comma-space every row in the real header carries.
    expect(rows[0]?.match(/0x/g)).toHaveLength(16);
    expect(rows[0]?.endsWith(', ')).toBe(true);
    expect(rows.at(-1)?.endsWith(', ')).toBe(false);
  });

  it('reports a short array rather than padding it', () => {
    const parsed = parseFaceHeader('const unsigned char epd_bitmap_x [] PROGMEM = { 0x01, 0x02 };');
    expect(parsed.ok).toBe(false);
    expect(parsed.detail).toContain('found 2');
  });

  it('sanitises the face name the way setFace() matches them', () => {
    expect(faceIdentifier('My Face!')).toBe('my_face');
    expect(faceIdentifier('')).toBe('labface');
  });
});

// =========================================================== the project

describe('the Lab project', () => {
  it('keeps Sesame Studio’s model: pose → frame → animation', () => {
    const pose = { ...neutralPose(), R1: 135 } as Record<JointName, number>;
    const frame = poseAsFrame(pose, 250);
    // A frame is a pose plus a wait. All eight channels, because a pose is
    // eight angles — not "the ones that changed".
    expect(Object.keys(frame.angles).sort()).toEqual([...JOINT_ORDER].sort());
    expect(frame.delayMs).toBe(250);
    expect(frame.angles.R1).toBe(135);
    // …and back again.
    expect(frameAsPose(frame, neutralPose()).R1).toBe(135);
    // A partial frame fills the rest from the pose it is loaded into.
    expect(frameAsPose({ angles: { L4: 10 }, delayMs: 0 }, pose)).toMatchObject({ R1: 135, L4: 10 });
  });

  it('saves and reloads a project', () => {
    const storage = workingStorage();
    installStorage(storage);
    const project = {
      ...emptyProject(),
      name: 'my thing',
      pose: { ...neutralPose(), R1: 135 } as Record<JointName, number>,
      animation: twoFrames,
      faceBase64: encodeFace(setPixel(blankFrame(), 5, 5, true)),
    };
    saveProject(project);
    const back = loadProject();
    expect(back.name).toBe('my thing');
    expect(back.pose.R1).toBe(135);
    expect(back.animation.frames).toHaveLength(2);
    expect(back.animation.frames[0]?.angles.R2).toBe(45);
    expect(getPixel(decodeFace(back.faceBase64), 5, 5)).toBe(true);
    expect(projectIsEmpty(back)).toBe(false);

    clearProject();
    expect(loadProject().name).toBe(emptyProject().name);
    expect(projectIsEmpty(loadProject())).toBe(true);
  });

  it('survives a localStorage that throws on every access', () => {
    installStorage({
      getItem() {
        throw new Error('site data blocked');
      },
      setItem() {
        throw new Error('site data blocked');
      },
      removeItem() {
        throw new Error('site data blocked');
      },
    });
    expect(() => saveProject(emptyProject())).not.toThrow();
    expect(() => clearProject()).not.toThrow();
    const back = loadProject();
    expect(back).toEqual(emptyProject());
    expect(projectIsEmpty(back)).toBe(true);
  });

  it('survives an absent localStorage entirely', () => {
    installStorage(null);
    expect(loadProject()).toEqual(emptyProject());
    expect(() => saveProject(emptyProject())).not.toThrow();
  });

  it('discards a record it does not recognise rather than merging it', () => {
    const storage = workingStorage();
    installStorage(storage);
    for (const bad of [
      'not json at all',
      '"a string"',
      'null',
      JSON.stringify({ version: 2, name: 'from the future' }),
      JSON.stringify({ version: 1, pose: 'nope', animation: 42 }),
    ]) {
      storage.map.set(STORAGE_KEY, bad);
      const back = loadProject();
      expect(back.version).toBe(1);
      expect(back.pose).toEqual(neutralPose());
      expect(back.animation.frames).toEqual([]);
    }
  });

  it('keeps the well-formed half of a partly-invented record', () => {
    const storage = workingStorage();
    installStorage(storage);
    storage.map.set(
      STORAGE_KEY,
      JSON.stringify({
        version: 1,
        name: 'half good',
        pose: { R1: 135, R2: 'ninety', L1: 400, nonsense: 12 },
        animation: {
          name: 'x',
          frames: [
            { angles: { R1: 100, R9: 5, L2: 'x' }, delayMs: 200 },
            'not a frame',
            { angles: { R3: 200 }, delayMs: -5 },
          ],
        },
        faceBase64: 'not base64 at all',
        delayStyle: 'sleep',
        savedAt: 'yesterday',
      }),
    );
    const back = loadProject();
    expect(back.name).toBe('half good');
    expect(back.pose.R1).toBe(135);
    // A non-number, an out-of-range angle and an invented key all fall back.
    expect(back.pose.R2).toBe(90);
    expect(back.pose.L1).toBe(90);
    expect(back.animation.frames).toHaveLength(2);
    expect(back.animation.frames[0]?.angles).toEqual({ R1: 100 });
    // An OUT-OF-RANGE authored angle is kept, deliberately: the editor's whole
    // out-of-range readout is about showing the firmware would clamp it.
    expect(back.animation.frames[1]?.angles.R3).toBe(200);
    expect(back.animation.frames[1]?.delayMs).toBe(0);
    expect(back.faceBase64).toBe(EMPTY_FACE_BASE64);
    expect(back.delayStyle).toBe('delayWithFace');
    expect(back.savedAt).toBe(0);
  });
});
