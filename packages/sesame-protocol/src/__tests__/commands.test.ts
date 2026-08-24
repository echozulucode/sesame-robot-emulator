/**
 * Protocol v2, host → device: does what we encode reach the branch we meant?
 *
 * The serial CLI's dispatcher is one long `if / else if` chain of `strcmp` and
 * `strncmp`, and `hardware-map.json → commands.serialCliDispatchNote` records
 * that its behaviour depends on the *order* of those tests, not only on their
 * contents. That makes the encoder's correctness a question about a chain of
 * 26 branches rather than about 26 independent strings, and the only honest way
 * to answer it is to model the chain and run every form through it.
 *
 * Two layers, therefore:
 *
 * 1. `classifyCliLine` is pinned against every `input` string in
 *    `hardware/hardware-map.json`, so the model cannot drift from the extracted
 *    firmware facts;
 * 2. `encodeCommand` is checked to land on the branch it claims, including the
 *    forms the dispatch note singles out as order-sensitive.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { JOINT_ORDER, jointIndex } from '@sesame-lab/sesame-model';
import { describe, expect, it } from 'vitest';

import { COMMAND_NAMES } from '../catalog.js';
import {
  BARRIER_COMMAND,
  BARRIER_MARKER,
  CLI_BRANCHES,
  CLI_MOVEMENT_WORDS,
  CommandEncodeError,
  MAX_CLI_LINE_BYTES,
  classifyCliLine,
  encodeCommand,
  safeCliToken,
  type CliBranch,
  type SesameCommand,
} from '../commands.js';

interface HardwareMap {
  readonly commands: {
    readonly serialCli: readonly {
      readonly input: readonly string[];
      readonly action: string;
      readonly movementFunction: string | null;
      readonly source: { readonly file: string; readonly line: number };
    }[];
    readonly serialCliDispatchNote: string;
  };
}

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const MAP = JSON.parse(
  readFileSync(resolve(REPO, 'hardware', 'hardware-map.json'), 'utf8'),
) as HardwareMap;

/**
 * The branch each extracted `input` form is expected to reach.
 *
 * Keyed by the form's **first** input string, which is what `hardware-map.json`
 * uses as its canonical spelling. Written out rather than derived, for the same
 * reason `STAND_POSE_TARGETS` in the contract suite is: a table derived from
 * the thing under test agrees with it by construction.
 */
const EXPECTED_BRANCH: Readonly<Record<string, CliBranch>> = {
  'run walk': 'run-walk',
  'rn wb': 'rn-wb',
  'rn tl': 'rn-tl',
  'rn tr': 'rn-tr',
  'run rest': 'run-rest',
  'run stand': 'run-stand',
  'rn wv': 'rn-wv',
  'rn dn': 'rn-dn',
  'rn sw': 'rn-sw',
  'rn pt': 'rn-pt',
  'rn pu': 'rn-pu',
  'rn bw': 'rn-bw',
  'rn ct': 'rn-ct',
  'rn fk': 'rn-fk',
  'rn wm': 'rn-wm',
  'rn sk': 'rn-sk',
  'rn sg': 'rn-sg',
  'rn dd': 'rn-dd',
  'rn cb': 'rn-cb',
  'face <name>': 'face',
  subtrim: 'subtrim-show',
  'subtrim save': 'subtrim-save',
  'subtrim reset': 'subtrim-reset',
  'subtrim <motor> <value>': 'subtrim-set',
  'all <angle>': 'all',
  '<motor> <angle>': 'motor',
};

/** Fill the map's placeholder forms with something concrete. */
function concrete(form: string): string {
  return form
    .replace('<name>', 'happy')
    .replace('<motor> <value>', '3 5')
    .replace('<angle>', '90')
    .replace('<motor>', '3');
}

describe('serial CLI dispatch model', () => {
  it('covers all 26 forms extracted from firmware', () => {
    expect(MAP.commands.serialCli).toHaveLength(26);
  });

  it('every extracted input form reaches its documented branch', () => {
    for (const entry of MAP.commands.serialCli) {
      const key = entry.input[0];
      expect(key, 'every serialCli entry has at least one input').toBeDefined();
      const expected = EXPECTED_BRANCH[key as string];
      expect(expected, `no expected branch recorded for ${String(key)}`).toBeDefined();
      for (const form of entry.input) {
        expect(classifyCliLine(concrete(form)), `${form} (${entry.action})`).toBe(expected);
      }
    }
  });

  it('the branch list has no unreachable entries', () => {
    const reached = new Set<CliBranch>(Object.values(EXPECTED_BRANCH));
    reached.add('none');
    expect([...CLI_BRANCHES].sort()).toEqual([...reached].sort());
  });

  // The three cases serialCliDispatchNote calls out by name. Each one is a
  // string that matches more than one test in the chain; only the order decides
  // which wins, so each is a genuine regression risk rather than a formality.
  describe('the order-sensitive forms', () => {
    it('"subtrim save" is caught by the exact test, not by strncmp("subtrim ", 8)', () => {
      expect(classifyCliLine('subtrim save')).toBe('subtrim-save');
    });

    it('"st save" is caught before strncmp("st ", 3)', () => {
      expect(classifyCliLine('st save')).toBe('subtrim-save');
    });

    it('"st reset" is caught before strncmp("st ", 3)', () => {
      expect(classifyCliLine('st reset')).toBe('subtrim-reset');
    });

    it('bare "st" is the subtrim dump, NOT the stand pose', () => {
      // The trap the encoder exists to avoid: `rn st` stands the robot up and
      // `st` prints eight numbers. One character apart.
      expect(classifyCliLine('st')).toBe('subtrim-show');
      expect(classifyCliLine('rn st')).toBe('run-stand');
    });

    it('"fc save" is a face called save, because the face test comes first', () => {
      expect(classifyCliLine('fc save')).toBe('face');
      expect(classifyCliLine('face subtrim')).toBe('face');
      expect(classifyCliLine('fc st')).toBe('face');
    });

    it('"st 3 5" reaches subtrim-set only because save/reset were caught earlier', () => {
      expect(classifyCliLine('st 3 5')).toBe('subtrim-set');
    });

    it('a subtrim line with unparseable params is still the subtrim branch, not a motor write', () => {
      expect(classifyCliLine('st x')).toBe('subtrim-set');
      expect(classifyCliLine('subtrim x')).toBe('subtrim-set');
    });

    it('"all" without a trailing space is not the all branch', () => {
      expect(classifyCliLine('all')).toBe('none');
      expect(classifyCliLine('all 90')).toBe('all');
    });

    it('an unrecognised word does nothing at all', () => {
      for (const word of ['not-a-real-command', 'stop', 'hello', 'run', 'rn', '']) {
        expect(classifyCliLine(word)).toBe('none');
      }
    });

    it('truncation at 31 bytes is modelled, because the firmware drops silently', () => {
      // A 40-byte line arrives as its first 31 bytes with no error anywhere.
      const long = `fc ${'a'.repeat(40)}`;
      expect(classifyCliLine(long)).toBe('face');
      expect(classifyCliLine(`${'0'.repeat(MAX_CLI_LINE_BYTES)} 90`)).toBe('none');
    });
  });
});

describe('encodeCommand', () => {
  it('encodes all 19 movement words the CLI can run', () => {
    expect(CLI_MOVEMENT_WORDS).toHaveLength(19);
    for (const word of CLI_MOVEMENT_WORDS) {
      const encoded = encodeCommand({ type: 'movement.run', command: word });
      expect(encoded.bytes).toBeLessThanOrEqual(MAX_CLI_LINE_BYTES);
      expect(encoded.derived).toBe(false);
      expect(classifyCliLine(encoded.line)).toBe(encoded.branch);
      expect(encoded.branch).not.toBe('none');
    }
  });

  it('covers every command word except stop, which the CLI does not have', () => {
    const missing = COMMAND_NAMES.filter((c) => !CLI_MOVEMENT_WORDS.includes(c));
    expect(missing).toEqual(['stop']);
    expect(() => encodeCommand({ type: 'movement.run', command: 'stop' })).toThrow(
      CommandEncodeError,
    );
  });

  it('prefers the unambiguous long forms for stand and rest', () => {
    expect(encodeCommand({ type: 'movement.run', command: 'stand' }).line).toBe('run stand');
    expect(encodeCommand({ type: 'movement.run', command: 'rest' }).line).toBe('run rest');
  });

  it('rejects a movement word the firmware does not know', () => {
    expect(() => encodeCommand({ type: 'movement.run', command: 'moonwalk' })).toThrow(
      /not one of the 19/,
    );
  });

  it('encodes a face and sanitises the name', () => {
    expect(encodeCommand({ type: 'face.set', name: 'happy' }).line).toBe('fc happy');
    // A hostile name cannot forge a segment, split the line or overflow.
    const hostile = encodeCommand({ type: 'face.set', name: '@SESAME servo R1 999' });
    expect(hostile.line).toBe('fc _SESAME_servo_R1_999');
    expect(hostile.bytes).toBeLessThanOrEqual(MAX_CLI_LINE_BYTES);
    expect(classifyCliLine(hostile.line)).toBe('face');
    expect(encodeCommand({ type: 'face.set', name: 'a\nb' }).line).toBe('fc a_b');
    expect(encodeCommand({ type: 'face.set', name: 'a'.repeat(200) }).line).toBe(
      `fc ${'a'.repeat(23)}`,
    );
  });

  it('the longest possible face line still fits the buffer', () => {
    // 23 is the firmware's own `char safe[24]`; `fc ` + 23 = 26 <= 31.
    expect(safeCliToken('x'.repeat(100))).toHaveLength(23);
    expect(encodeCommand({ type: 'face.set', name: 'x'.repeat(100) }).bytes).toBe(26);
  });

  it('encodes a servo write by firmware channel index, not by joint name', () => {
    for (const joint of JOINT_ORDER) {
      const encoded = encodeCommand({ type: 'servo.set', joint, angleDeg: 135 });
      expect(encoded.line).toBe(`${String(jointIndex(joint))} 135`);
      expect(encoded.branch).toBe('motor');
    }
    // R4 is index 4 and R3 is index 5 — the firmware enum order, which is the
    // single most common thing to get backwards.
    expect(encodeCommand({ type: 'servo.set', joint: 'R4', angleDeg: 0 }).line).toBe('4 0');
    expect(encodeCommand({ type: 'servo.set', joint: 'R3', angleDeg: 0 }).line).toBe('5 0');
  });

  it('refuses an out-of-range or fractional angle', () => {
    for (const angle of [-1, 181, 1000, 90.5, Number.NaN]) {
      expect(() => encodeCommand({ type: 'servo.set', joint: 'R1', angleDeg: angle })).toThrow(
        CommandEncodeError,
      );
    }
  });

  it('encodes the subtrim family with the long, order-safe spellings', () => {
    expect(encodeCommand({ type: 'subtrim.show' }).line).toBe('subtrim');
    expect(encodeCommand({ type: 'subtrim.save' }).line).toBe('subtrim save');
    expect(encodeCommand({ type: 'subtrim.reset' }).line).toBe('subtrim reset');
    expect(encodeCommand({ type: 'subtrim.set', channel: 3, valueDeg: -5 }).line).toBe(
      'subtrim 3 -5',
    );
    for (const cmd of [
      { type: 'subtrim.show' },
      { type: 'subtrim.save' },
      { type: 'subtrim.reset' },
      { type: 'subtrim.set', channel: 0, valueDeg: 90 },
    ] as const satisfies readonly SesameCommand[]) {
      const encoded = encodeCommand(cmd);
      expect(classifyCliLine(encoded.line)).toBe(encoded.branch);
    }
  });

  it('refuses a subtrim outside the firmware’s own -90..90 check', () => {
    expect(() => encodeCommand({ type: 'subtrim.set', channel: 0, valueDeg: 91 })).toThrow();
    expect(() => encodeCommand({ type: 'subtrim.set', channel: 8, valueDeg: 0 })).toThrow();
  });

  it('encodes stop as a derived, no-op face write and says so', () => {
    const encoded = encodeCommand({ type: 'command.stop', currentFace: 'rest' });
    expect(encoded.line).toBe('fc rest');
    expect(encoded.branch).toBe('face');
    expect(encoded.derived).toBe(true);
    expect(encoded.note).toMatch(/no stop verb/);
  });

  it('the barrier command is read-only and its marker is a real firmware string', () => {
    expect(classifyCliLine(BARRIER_COMMAND)).toBe('subtrim-show');
    expect(BARRIER_MARKER).toBe('Subtrim values:');
  });
});
