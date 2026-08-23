/**
 * `catalog.ts` is a browser-safe mirror of `hardware/hardware-map.json`.
 *
 * A mirror rots. This test re-derives every entry from the JSON — which F4
 * extracted from firmware source with `file:line` provenance for every fact —
 * and fails the build if the two disagree. That keeps the JSON authoritative
 * while letting the protocol package run without a filesystem.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  COMMAND_VOCABULARY,
  FACE_CATALOG,
  FACE_NAMES,
  MAX_FACE_FRAMES,
  MOVEMENT_FUNCTIONS,
  ANGLE_MAX_DEG,
  ANGLE_MIN_DEG,
} from '../catalog.js';
import { OLED_FRAME_BYTES, OLED_HEIGHT, OLED_WIDTH } from '../oled.js';

interface HardwareMap {
  readonly servos: {
    readonly order: readonly string[];
    readonly servoConfig: { readonly angleClamp: { readonly min: number; readonly max: number } };
  };
  readonly display: { readonly widthPx: number; readonly heightPx: number };
  readonly movements: readonly { readonly function: string }[];
  readonly commands: {
    readonly vocabulary: readonly {
      readonly command: string;
      readonly movementFunction: string | null;
      readonly continuous: boolean;
    }[];
  };
  readonly faces: {
    readonly count: number;
    readonly maxFramesPerFace: number;
    readonly bitmapDimensions: { readonly bytesPerFrame: number };
    readonly faces: readonly {
      readonly name: string;
      readonly frameCount: number;
      readonly animated: boolean;
      readonly fps: number | null;
      readonly category: string;
      readonly playbackModes: readonly { readonly mode: string }[];
    }[];
  };
}

const here = dirname(fileURLToPath(import.meta.url));
const mapPath = resolve(here, '..', '..', '..', '..', 'hardware', 'hardware-map.json');
const map = JSON.parse(readFileSync(mapPath, 'utf8')) as HardwareMap;

describe('catalog matches hardware/hardware-map.json', () => {
  it('has all 38 faces, in registry order, with matching metadata', () => {
    expect(map.faces.count).toBe(38);
    expect(FACE_CATALOG).toHaveLength(map.faces.count);
    expect(FACE_NAMES).toEqual(map.faces.faces.map((f) => f.name));
    expect(FACE_CATALOG).toEqual(
      map.faces.faces.map((f) => ({
        name: f.name,
        frameCount: f.frameCount,
        animated: f.animated,
        fps: f.fps,
        category: f.category,
        modes: f.playbackModes.map((p) => p.mode),
      })),
    );
  });

  it('agrees on MAX_FACE_FRAMES', () => {
    expect(MAX_FACE_FRAMES).toBe(map.faces.maxFramesPerFace);
  });

  it('has all 21 movement functions, in declaration order', () => {
    expect(MOVEMENT_FUNCTIONS).toEqual(map.movements.map((m) => m.function));
    expect(MOVEMENT_FUNCTIONS).toHaveLength(21);
  });

  it('has the whole command vocabulary, in dispatch order', () => {
    expect(COMMAND_VOCABULARY).toEqual(
      map.commands.vocabulary.map((c) => ({
        command: c.command,
        movementFunction: c.movementFunction,
        continuous: c.continuous,
      })),
    );
  });

  it('agrees on the servo angle clamp', () => {
    expect(ANGLE_MIN_DEG).toBe(map.servos.servoConfig.angleClamp.min);
    expect(ANGLE_MAX_DEG).toBe(map.servos.servoConfig.angleClamp.max);
  });

  it('agrees on the OLED geometry', () => {
    expect(OLED_WIDTH).toBe(map.display.widthPx);
    expect(OLED_HEIGHT).toBe(map.display.heightPx);
    expect(OLED_FRAME_BYTES).toBe(map.faces.bitmapDimensions.bytesPerFrame);
    expect(OLED_FRAME_BYTES).toBe((OLED_WIDTH * OLED_HEIGHT) / 8);
  });

  it('keeps the firmware joint order as its own source of truth', () => {
    // sesame-model owns JOINT_ORDER; hardware-map.json owns servos.order.
    // If they ever disagree, that is a finding, not a merge conflict.
    expect(map.servos.order).toEqual(['R1', 'R2', 'L1', 'L2', 'R4', 'R3', 'L3', 'L4']);
  });
});
