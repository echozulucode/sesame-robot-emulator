/**
 * Shared test helpers.
 *
 * The one rule these follow: a helper may *observe* the model, never
 * re-implement it. The single exception is `expandServoWrites()`, which is a
 * deliberately independent expansion of the choreography JSON — it exists to
 * disagree with the interpreter if the interpreter is wrong, so it is written
 * from the data rather than shared with `machine.ts`.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import type { JointName } from '@sesame-lab/sesame-model';
import type { SesameTelemetry, ServoTargetEvent } from '@sesame-lab/sesame-protocol';

import { SimulatedSesameRobot } from '../robot.js';
import type { SimulatedRobotOptions } from '../config.js';

const here = dirname(fileURLToPath(import.meta.url));

/** Repository root, from `packages/sesame-sim/src/__tests__`. */
export const REPO_ROOT = resolve(here, '..', '..', '..', '..');

/** The extractor's output, read fresh so tests can catch generator drift. */
export function readHardwareMap(): {
  movements: readonly HwMovement[];
  servos: { order: readonly JointName[]; servoConfig: Record<string, unknown> };
} {
  const path = resolve(REPO_ROOT, 'hardware', 'hardware-map.json');
  return JSON.parse(readFileSync(path, 'utf8')) as never;
}

/** Loose shapes for the raw JSON, so tests can read it without the package types. */
export interface HwStep {
  type: string;
  joint?: JointName;
  index?: number;
  angleDeg?: number;
  ms?: number;
  name?: string;
  mode?: string | null;
  text?: string;
  function?: string;
  args?: Record<string, number> | null;
  condition?: string;
  count?: number | null;
  countDefault?: number | null;
  countRef?: string | null;
  command?: string;
  durationMsDefault?: number | null;
  durationMsRef?: string | null;
  variable?: string;
  value?: boolean | number;
  steps?: HwStep[];
  source?: { file: string; line: number };
}

export interface HwMovement {
  function: string;
  kind: string;
  signature: string;
  loops: boolean;
  interruptible: boolean;
  triggeredByCommand?: string[];
  defaultArgs?: Record<string, number> | null;
  note?: string | null;
  source: { file: string; line: number };
  sourceRange: { from: { file: string; line: number }; to: { file: string; line: number } };
  steps: HwStep[];
}

/** One servo write: the pair the choreography is ground truth for. */
export interface ServoWrite {
  readonly joint: JointName;
  readonly angleDeg: number;
}

/** Runtime values the choreography refers to by name. Firmware defaults. */
export interface ExpandSettings {
  readonly walkCycles: number;
}

/**
 * Expand a movement's `(joint, angle)` writes straight from `hardware-map.json`.
 *
 * No clock, no faces, no pumps, no interruption — a `pressingCheck` that is
 * never interrupted always returns true, which is the case under test. This is
 * the ground truth the simulator's `servo.target` stream is compared against.
 */
export function expandServoWrites(
  movements: readonly HwMovement[],
  name: string,
  args: Record<string, number> = {},
  settings: ExpandSettings = { walkCycles: 10 },
  depth = 0,
): ServoWrite[] {
  if (depth > 8) throw new Error(`recursion too deep at ${name}`);
  const movement = movements.find((m) => m.function === name);
  if (movement === undefined) throw new Error(`no movement '${name}'`);
  const bound = { ...(movement.defaultArgs ?? {}), ...args };
  const out: ServoWrite[] = [];

  const walk = (steps: readonly HwStep[]): void => {
    for (const step of steps) {
      switch (step.type) {
        case 'servo':
          out.push({ joint: step.joint as JointName, angleDeg: step.angleDeg as number });
          break;
        case 'repeat': {
          const n =
            step.count ??
            (step.countRef === 'walkCycles' ? settings.walkCycles : (step.countDefault ?? 0));
          for (let i = 0; i < n; i++) walk(step.steps ?? []);
          break;
        }
        case 'conditional': {
          const match = /^(\w+)\s*==\s*(-?\d+)$/.exec(step.condition ?? '');
          if (match === null) throw new Error(`bad condition '${step.condition ?? ''}'`);
          if (bound[match[1] as string] === Number(match[2])) walk(step.steps ?? []);
          break;
        }
        case 'call':
          if (step.function === 'scheduleNextIdleBlink') break;
          out.push(
            ...expandServoWrites(
              movements,
              step.function as string,
              step.args ?? {},
              settings,
              depth + 1,
            ),
          );
          break;
        default:
          break;
      }
    }
  };

  walk(movement.steps);
  return out;
}

/** A connected robot plus a live recording of everything it emits. */
export interface Rig {
  readonly robot: SimulatedSesameRobot;
  readonly events: SesameTelemetry[];
  /** Only the servo writes, in order. */
  servoWrites(): ServoWrite[];
  /** Events of one type, in order. */
  ofType<T extends SesameTelemetry['type']>(type: T): Extract<SesameTelemetry, { type: T }>[];
  /** Drop everything recorded so far. */
  clear(): void;
}

/** Build a connected robot with a recorder attached. */
export async function makeRig(options: SimulatedRobotOptions = {}): Promise<Rig> {
  const robot = new SimulatedSesameRobot(options);
  const events: SesameTelemetry[] = [];
  robot.subscribe((event) => events.push(event));
  await robot.connect();
  return {
    robot,
    events,
    servoWrites: () =>
      events
        .filter((e): e is ServoTargetEvent => e.type === 'servo.target')
        .map((e) => ({ joint: e.joint, angleDeg: e.angleDeg })),
    ofType: <T extends SesameTelemetry['type']>(type: T) =>
      events.filter((e): e is Extract<SesameTelemetry, { type: T }> => e.type === type),
    clear: () => {
      events.length = 0;
    },
  };
}

/** Index of the first occurrence of `needle` in `haystack`, or `-1`. */
export function indexOfSubsequence(
  haystack: readonly ServoWrite[],
  needle: readonly ServoWrite[],
): number {
  if (needle.length === 0) return -1;
  outer: for (let i = 0; i + needle.length <= haystack.length; i++) {
    for (let j = 0; j < needle.length; j++) {
      const h = haystack[i + j];
      const n = needle[j];
      if (h === undefined || n === undefined) continue outer;
      if (h.joint !== n.joint || h.angleDeg !== n.angleDeg) continue outer;
    }
    return i;
  }
  return -1;
}
