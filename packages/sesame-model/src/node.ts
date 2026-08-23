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
