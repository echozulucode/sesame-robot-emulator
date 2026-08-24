/**
 * Test helper: read the real `hardware/joint-map.json` from the repository.
 *
 * Tests deliberately run against the real artefact rather than a hand-written
 * fixture. A fixture would drift, and the point of these tests is that the
 * shipped data satisfies the contract.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));

/** `<repo>/hardware/joint-map.json` */
export const JOINT_MAP_PATH = resolve(here, '..', '..', '..', '..', 'hardware', 'joint-map.json');

/** The parsed but *unvalidated* joint map, as raw JSON. */
export function loadFixtureJointMap(): unknown {
  return JSON.parse(readFileSync(JOINT_MAP_PATH, 'utf8'));
}

/** `<repo>/hardware/calibration.json` */
export const CALIBRATION_PATH = resolve(here, '..', '..', '..', '..', 'hardware', 'calibration.json');

/** The parsed but *unvalidated* calibration document, as raw JSON. */
export function loadFixtureCalibration(): unknown {
  return JSON.parse(readFileSync(CALIBRATION_PATH, 'utf8'));
}
