/**
 * Typed accessors over the extracted choreography.
 *
 * Everything here is a read of `src/generated/choreography.ts`, which is a
 * projection of `hardware/hardware-map.json`. There is no second source of
 * truth for what the robot does.
 */
import { CHOREOGRAPHY } from './generated/choreography.js';
import type { Choreography, ChoreographyStep, MovementDefinition } from './choreography-types.js';

export { CHOREOGRAPHY };

/** The 21 movement functions, in `hardware-map.json` order. */
export const MOVEMENTS: readonly MovementDefinition[] = CHOREOGRAPHY.movements;

/** Just the function names, in the same order. */
export const MOVEMENT_NAMES: readonly string[] = Object.freeze(
  CHOREOGRAPHY.movements.map((m) => m.function),
);

const BY_NAME: ReadonlyMap<string, MovementDefinition> = new Map(
  CHOREOGRAPHY.movements.map((m) => [m.function, m]),
);

/** Look up a movement function by its C++ symbol. */
export function getMovement(name: string): MovementDefinition | undefined {
  return BY_NAME.get(name);
}

/** Depth-first walk over a step tree, nested `repeat`/`conditional` bodies included. */
export function* walkSteps(
  steps: readonly ChoreographyStep[],
): Generator<ChoreographyStep, void, void> {
  for (const step of steps) {
    yield step;
    if (step.type === 'repeat' || step.type === 'conditional') yield* walkSteps(step.steps);
  }
}

/**
 * Total number of steps in a movement's *definition*, nested bodies counted
 * once each. Summed over all 21 movements this is the 395 the extractor
 * reported — which is the number the drift test pins.
 */
export function countSteps(movement: MovementDefinition): number {
  let n = 0;
  for (const _step of walkSteps(movement.steps)) n += 1;
  return n;
}

export type { Choreography, ChoreographyStep, MovementDefinition };
