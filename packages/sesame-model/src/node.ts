/**
 * Node-only entry point: load `hardware/joint-map.json` off disk and validate
 * it.
 *
 * Kept separate from `index.ts` so the model package stays usable in a browser.
 *
 * ```ts
 * import { loadJointMap } from '@sesame-lab/sesame-model/node';
 * const map = loadJointMap();
 * map.pinFor('R4', 's2-mini'); // 8
 * ```
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import { JointMapView } from './joint-map.js';
import { CalibrationView } from './calibration.js';

const moduleDir = dirname(fileURLToPath(import.meta.url));

/**
 * Where the loader looks, in order.
 *
 * 1. `dist/joint-map.json`, copied in by the package's build step, so an
 *    installed copy of the package is self-contained.
 * 2. `hardware/joint-map.json` in the repository, so a source checkout picks up
 *    edits without rebuilding.
 */
export const JOINT_MAP_SEARCH_PATHS: readonly string[] = [
  resolve(moduleDir, 'joint-map.json'),
  resolve(moduleDir, '..', '..', '..', 'hardware', 'joint-map.json'),
  resolve(moduleDir, '..', '..', '..', '..', 'hardware', 'joint-map.json'),
];

/**
 * Read, parse and validate the joint map.
 *
 * @param path explicit path; otherwise {@link JOINT_MAP_SEARCH_PATHS} is tried
 *             in order.
 * @throws if no candidate can be read, or if the data fails
 *         {@link JointMapView.parse}.
 */
export function loadJointMap(path?: string): JointMapView {
  const candidates = path === undefined ? JOINT_MAP_SEARCH_PATHS : [path];
  const tried: string[] = [];
  for (const candidate of candidates) {
    let raw: string;
    try {
      raw = readFileSync(candidate, 'utf8');
    } catch {
      tried.push(candidate);
      continue;
    }
    return JointMapView.parse(JSON.parse(raw));
  }
  throw new Error(`cannot read hardware/joint-map.json; tried:\n  ${tried.join('\n  ')}`);
}

export { JointMapValidationError, JointMapView } from './joint-map.js';

// ---------------------------------------------------------------------------
// Calibration
// ---------------------------------------------------------------------------

/**
 * Where {@link loadCalibration} looks, in order — mirroring
 * {@link JOINT_MAP_SEARCH_PATHS}.
 */
export const CALIBRATION_SEARCH_PATHS: readonly string[] = [
  resolve(moduleDir, 'calibration.json'),
  resolve(moduleDir, '..', '..', '..', 'hardware', 'calibration.json'),
  resolve(moduleDir, '..', '..', '..', '..', 'hardware', 'calibration.json'),
];

/**
 * Environment variable that redirects the calibration loader at run time.
 *
 * This is the whole point of the layer: swapping in the calibration for a
 * specific robot must not require a rebuild, a code change or a rewritten
 * `hardware/` file.
 *
 * ```powershell
 * $env:SESAME_CALIBRATION = "C:\robots\sesame-002.calibration.json"
 * pnpm demo:web
 * ```
 */
export const CALIBRATION_PATH_ENV = 'SESAME_CALIBRATION';

/** Options for {@link loadCalibration}. */
export interface LoadCalibrationOptions {
  /** Explicit path. Beats the environment variable and the search paths. */
  readonly path?: string;
  /**
   * Cross-check carried-forward values against this joint map. Defaults to
   * `loadJointMap()`; pass `null` to skip (useful in a test with a fixture).
   */
  readonly jointMap?: JointMapView | null;
  /** Read `process.env[SESAME_CALIBRATION]`. Default `true`. */
  readonly useEnv?: boolean;
}

/**
 * Read, parse and validate a calibration document.
 *
 * Resolution order: `options.path`, then `$SESAME_CALIBRATION`, then
 * {@link CALIBRATION_SEARCH_PATHS}. The shipped `hardware/calibration.json` is
 * entirely carried-forward, so loading it changes no behaviour.
 */
export function loadCalibration(options: LoadCalibrationOptions = {}): CalibrationView {
  const fromEnv = (options.useEnv ?? true) ? process.env[CALIBRATION_PATH_ENV] : undefined;
  const explicit = options.path ?? (fromEnv !== undefined && fromEnv !== '' ? fromEnv : undefined);
  const candidates = explicit === undefined ? CALIBRATION_SEARCH_PATHS : [explicit];
  const jointMap = options.jointMap === undefined ? loadJointMap() : options.jointMap;

  const tried: string[] = [];
  for (const candidate of candidates) {
    let raw: string;
    try {
      raw = readFileSync(candidate, 'utf8');
    } catch {
      tried.push(candidate);
      continue;
    }
    return CalibrationView.parse(
      JSON.parse(raw),
      jointMap === null ? {} : { jointMap },
    );
  }
  throw new Error(`cannot read hardware/calibration.json; tried:\n  ${tried.join('\n  ')}`);
}

export { CalibrationValidationError, CalibrationView } from './calibration.js';
