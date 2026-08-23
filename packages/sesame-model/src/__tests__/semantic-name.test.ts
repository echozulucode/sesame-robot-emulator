/**
 * The guess barrier.
 *
 * The research report is emphatic that front-left/front-right names must not
 * become canonical before the mapping is physically verified. Prose cannot
 * enforce that; these tests and the types they exercise can.
 *
 * What is asserted here:
 *   1. a semantic name is never a plain string — reading one as a string is a
 *      compile error, not a convention;
 *   2. `verified` is the literal `false`, so the "it's verified" branch is
 *      statically dead;
 *   3. the runtime validator rejects any attempt to smuggle in a bare string or
 *      `verified: true`;
 *   4. no accessor on `JointMapView` hands back a spatial name as a string.
 */
import { describe, expect, it } from 'vitest';

import {
  JointMapValidationError,
  JointMapView,
  SEMANTIC_NAME_IS_A_GUESS,
  readGuessedSemanticName,
  type JointMapEntry,
  type UnverifiedSemanticName,
} from '../joint-map.js';
import { loadFixtureJointMap } from './fixture.js';

const view = JointMapView.parse(loadFixtureJointMap());

describe('semanticName is structurally non-authoritative', () => {
  it('is never a bare string in the data', () => {
    for (const j of view.joints) {
      expect(typeof j.semanticName).not.toBe('string');
      expect(j.semanticName).toBeTypeOf('object');
    }
  });

  it('cannot be read as a plain string by assignment', () => {
    const entry: JointMapEntry = view.get('R1');
    // @ts-expect-error — a guessed spatial name is an object with verified:false,
    // never a string. If this line ever compiles, the barrier is gone.
    const asString: string | undefined = entry.semanticName;
    expect(typeof asString).not.toBe('string');
  });

  it('cannot be used where an authoritative JointName is expected', () => {
    const entry = view.get('R3');
    const guess = readGuessedSemanticName(entry.semanticName, SEMANTIC_NAME_IS_A_GUESS);
    // @ts-expect-error — "right_front_knee" is not a JointName. Only R1..L4 are.
    const asJointName: import('../joints.js').JointName | undefined = guess;
    expect(asJointName).toBe('right_front_knee');
  });

  it('has no verified variant of the type at all', () => {
    // Compile-time proof: nothing in UnverifiedSemanticName can have
    // verified:true, so there is no "it's confirmed" branch to write.
    type VerifiedVariant = Extract<UnverifiedSemanticName, { verified: true }>;
    const noVerifiedVariant: [VerifiedVariant] extends [never] ? true : false = true;
    expect(noVerifiedVariant).toBe(true);

    const name: UnverifiedSemanticName | undefined = view.semanticGuessFor('L2');
    expect(name).toBeDefined();
    if (name !== undefined) {
      const alwaysFalse: false = name.verified;
      expect(alwaysFalse).toBe(false);
      // @ts-expect-error — `verified` is the literal false; it can never be true.
      const neverTrue: true = name.verified;
      expect(neverTrue).toBe(false);
    }
  });

  it('requires an explicit acknowledgement to get the raw string', () => {
    const entry = view.get('R1');
    expect(readGuessedSemanticName(entry.semanticName, SEMANTIC_NAME_IS_A_GUESS))
      .toBe('right_front_hip');

    const readWithBadToken = (): string | undefined =>
      // @ts-expect-error — the acknowledgement token is not optional and not a boolean.
      readGuessedSemanticName(entry.semanticName, true);
    expect(readWithBadToken).toThrow(TypeError);
  });

  it('exposes no accessor that returns a spatial name as a string', () => {
    // labelFor is the authoritative-name accessor and returns R1..L4 only.
    for (const j of view.joints) {
      expect(view.labelFor(j.firmwareName)).toBe(j.firmwareName);
      expect(view.labelFor(j.firmwareName)).not.toContain('_');
    }
  });

  it('carries a basis and a confirmation route on every guess', () => {
    for (const j of view.joints) {
      const s = j.semanticName;
      expect(s).toBeDefined();
      expect(s?.verified).toBe(false);
      expect(s?.basis.length).toBeGreaterThan(40);
      expect(s?.basisPoints.length).toBeGreaterThan(0);
      expect(s?.wouldBeConfirmedBy.length).toBeGreaterThan(0);
    }
  });
});

describe('the runtime validator rejects promoted guesses', () => {
  const mutate = (fn: (joints: Record<string, unknown>[]) => void): unknown => {
    const clone = structuredClone(loadFixtureJointMap()) as { joints: Record<string, unknown>[] };
    fn(clone.joints);
    return clone;
  };

  it('rejects verified: true', () => {
    const broken = mutate((joints) => {
      const first = joints[0];
      if (first === undefined) throw new Error('fixture has no joints');
      first['semanticName'] = {
        value: 'right_front_hip',
        verified: true,
        basis: 'someone was confident',
        basisPoints: ['someone was confident'],
        wouldBeConfirmedBy: ['nothing, apparently'],
        alternativesConsidered: [],
        alternativesNote: '',
      };
    });
    expect(() => JointMapView.parse(broken)).toThrow(JointMapValidationError);
    expect(() => JointMapView.parse(broken)).toThrow(/verified must be the literal false/);
  });

  it('rejects a bare string', () => {
    const broken = mutate((joints) => {
      const first = joints[0];
      if (first === undefined) throw new Error('fixture has no joints');
      first['semanticName'] = 'right_front_hip';
    });
    expect(() => JointMapView.parse(broken)).toThrow(/must be an object, never a bare string/);
  });

  it('rejects a guess with no stated basis', () => {
    const broken = mutate((joints) => {
      const first = joints[0];
      if (first === undefined) throw new Error('fixture has no joints');
      first['semanticName'] = {
        value: 'right_front_hip',
        verified: false,
        basis: '',
        basisPoints: [],
        wouldBeConfirmedBy: [],
        alternativesConsidered: [],
        alternativesNote: '',
      };
    });
    expect(() => JointMapView.parse(broken)).toThrow(/basis must say what the guess rests on/);
  });
});
