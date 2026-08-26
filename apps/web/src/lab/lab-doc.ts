/**
 * The Lab project — Sesame Studio's model, kept, and its Tkinter UI, not.
 *
 * The research report is explicit about which half of Studio survives:
 *
 * ```text
 * Pose      = eight servo angles
 * Frame     = pose + duration/delay
 * Animation = ordered frames
 * Export    = Sesame-compatible movement commands
 * ```
 *
 * …*"but reimplement the editor as a shared TypeScript component connected
 * directly to virtual or real Sesame. This eliminates today's copy-to-clipboard
 * workflow while preserving compatibility."*
 *
 * So the model here is Studio's, one for one. A **pose** is eight angles and
 * nothing else — no name, no easing, no interpolation, because a pose on this
 * robot is literally eight numbers a `for` loop writes. A **frame** is a pose
 * plus a wait, which is `SequenceFrame` in `src/editors/sequence.ts`, already
 * shaped that way because the firmware's movement bodies are. An **animation**
 * is an ordered list of frames, which is `SequenceDoc`. Nothing is added.
 *
 * What *is* different from Studio: the project drives the robot directly
 * (`LabWiring.runSequence`), the export is a compatibility artefact rather than
 * the only output, and the whole thing persists so an experiment survives a
 * reload.
 *
 * ## Persistence
 *
 * `localStorage`, defensively, on exactly the terms `src/lessons/progress.ts`
 * uses: the accessor itself throws in a private window with site data blocked,
 * the value can be absent, and it can be somebody else's JSON. All three render
 * as a fresh empty project and none is an error a learner has to see. Anything
 * that is not recognisably this schema is **discarded rather than merged** — a
 * half-understood project would produce an editor that is confidently wrong
 * about what the learner built.
 */
import { JOINT_ORDER, type JointName } from '@sesame-lab/sesame-model';
import { base64Decode, base64Encode } from '@sesame-lab/sesame-protocol';

import { FRAME_BYTES, blankFrame } from '../editors/pixel-frame.js';
import { EMPTY_SEQUENCE, type SequenceDoc, type SequenceFrame } from '../editors/sequence.js';
import type { DelayStyle } from './cpp-export.js';

const STORAGE_KEY = 'sesame-lab.lab.v1';

/** The neutral pose. `runRestPose()` is `for (i<8) setServoAngle(i, 90)`. */
export const NEUTRAL_DEG = 90;

/** A pose is eight angles. That is the whole type. */
export type Pose = Readonly<Record<JointName, number>>;

export const neutralPose = (): Pose =>
  Object.fromEntries(JOINT_ORDER.map((j) => [j, NEUTRAL_DEG])) as Record<JointName, number>;

export interface LabProject {
  readonly version: 1;
  readonly name: string;
  /** What the sliders are showing. Commanded angles, before subtrim. */
  readonly pose: Pose;
  readonly animation: SequenceDoc;
  /** The authored 128x64 face, row-major MSB-first, base64 of 1024 bytes. */
  readonly faceName: string;
  readonly faceBase64: string;
  readonly cppFunctionName: string;
  readonly delayStyle: DelayStyle;
  /** Last API-console request, so a reload lands on what was being poked at. */
  readonly httpMethod: string;
  readonly httpRoute: string;
  readonly httpBody: string;
  /** Epoch ms. Informational; nothing gates on it. */
  readonly savedAt: number;
}

export const EMPTY_FACE_BASE64: string = base64Encode(new Uint8Array(FRAME_BYTES));

export function emptyProject(): LabProject {
  return {
    version: 1,
    name: 'lab project',
    pose: neutralPose(),
    animation: { ...EMPTY_SEQUENCE, name: 'runLabPose' },
    faceName: 'labface',
    faceBase64: EMPTY_FACE_BASE64,
    cppFunctionName: 'runLabPose',
    delayStyle: 'delayWithFace',
    httpMethod: 'GET',
    httpRoute: '/api/status',
    httpBody: '',
    savedAt: 0,
  };
}

/** Append the current slider pose as a frame. Studio's "Add Frame", exactly. */
export function poseAsFrame(pose: Pose, delayMs: number): SequenceFrame {
  const angles: Partial<Record<JointName, number>> = {};
  for (const joint of JOINT_ORDER) angles[joint] = Math.round(pose[joint]);
  return { angles, delayMs: Math.max(0, Math.round(delayMs)) };
}

/** The pose a frame describes, filling unwritten channels from a base pose. */
export function frameAsPose(frame: SequenceFrame, base: Pose): Pose {
  const pose: Record<JointName, number> = { ...base } as Record<JointName, number>;
  for (const joint of JOINT_ORDER) {
    const angle = frame.angles[joint];
    if (angle !== undefined) pose[joint] = angle;
  }
  return pose;
}

export function decodeFace(base64: string): Uint8Array {
  try {
    const bytes = base64Decode(base64);
    if (bytes.length !== FRAME_BYTES) return blankFrame();
    return bytes;
  } catch {
    return blankFrame();
  }
}

export const encodeFace = (frame: Uint8Array): string => base64Encode(frame);

// ------------------------------------------------------------------ storage

function cleanPose(raw: unknown): Pose {
  const pose = neutralPose() as Record<JointName, number>;
  if (raw === null || typeof raw !== 'object') return pose;
  const record = raw as Record<string, unknown>;
  for (const joint of JOINT_ORDER) {
    const value = record[joint];
    // 0-180 is the firmware's whole commandable domain; anything else is not a
    // pose this robot has, so it is dropped rather than clamped into one.
    if (typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 180) {
      pose[joint] = Math.round(value);
    }
  }
  return pose;
}

function cleanFrames(raw: unknown): readonly SequenceFrame[] {
  if (!Array.isArray(raw)) return [];
  const frames: SequenceFrame[] = [];
  for (const entry of raw as unknown[]) {
    if (entry === null || typeof entry !== 'object') continue;
    const candidate = entry as { angles?: unknown; delayMs?: unknown };
    const angles: Partial<Record<JointName, number>> = {};
    if (candidate.angles !== null && typeof candidate.angles === 'object') {
      const record = candidate.angles as Record<string, unknown>;
      for (const joint of JOINT_ORDER) {
        const value = record[joint];
        // Out-of-range angles are KEPT if they are integers: the editor's whole
        // out-of-range readout is about showing that the firmware would clamp
        // them silently, and dropping them on reload would hide the lesson.
        if (typeof value === 'number' && Number.isInteger(value)) angles[joint] = value;
      }
    }
    const delayMs =
      typeof candidate.delayMs === 'number' && Number.isFinite(candidate.delayMs) && candidate.delayMs >= 0
        ? Math.round(candidate.delayMs)
        : 0;
    frames.push({ angles, delayMs });
  }
  return frames;
}

function cleanString(raw: unknown, fallback: string, maxLength = 64): string {
  if (typeof raw !== 'string') return fallback;
  return raw.slice(0, maxLength);
}

/** Read the stored project. Never throws; never returns a partial type. */
export function loadProject(): LabProject {
  let raw: string | null = null;
  try {
    raw = globalThis.localStorage?.getItem(STORAGE_KEY) ?? null;
  } catch {
    return emptyProject();
  }
  if (raw === null) return emptyProject();
  const base = emptyProject();
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== 'object') return base;
    const candidate = parsed as Record<string, unknown>;
    if (candidate['version'] !== 1) return base;

    const animation = candidate['animation'];
    const animationRecord =
      animation !== null && typeof animation === 'object' ? (animation as Record<string, unknown>) : {};
    const faceBase64 = cleanString(candidate['faceBase64'], base.faceBase64, 4096);
    const delayStyle = candidate['delayStyle'] === 'delay' ? 'delay' : 'delayWithFace';

    return {
      version: 1,
      name: cleanString(candidate['name'], base.name),
      pose: cleanPose(candidate['pose']),
      animation: {
        name: cleanString(animationRecord['name'], base.animation.name),
        basedOnMovement:
          typeof animationRecord['basedOnMovement'] === 'string'
            ? (animationRecord['basedOnMovement'] as string).slice(0, 64)
            : null,
        frames: cleanFrames(animationRecord['frames']),
      },
      faceName: cleanString(candidate['faceName'], base.faceName),
      // Validated by decoding it: a corrupt payload becomes a blank face rather
      // than an exception on the first paint.
      faceBase64: decodeFace(faceBase64).some((b) => b !== 0) ? faceBase64 : base.faceBase64,
      cppFunctionName: cleanString(candidate['cppFunctionName'], base.cppFunctionName),
      delayStyle,
      httpMethod: cleanString(candidate['httpMethod'], base.httpMethod, 12),
      httpRoute: cleanString(candidate['httpRoute'], base.httpRoute, 256),
      httpBody: cleanString(candidate['httpBody'], base.httpBody, 4096),
      savedAt: typeof candidate['savedAt'] === 'number' ? candidate['savedAt'] : 0,
    };
  } catch {
    return base;
  }
}

/** Persist. A failure is silent by design: storage is a convenience, not truth. */
export function saveProject(project: LabProject): void {
  try {
    globalThis.localStorage?.setItem(STORAGE_KEY, JSON.stringify({ ...project, savedAt: Date.now() }));
  } catch {
    /* private window, quota, or site data blocked — the Lab runs the same */
  }
}

export function clearProject(): void {
  try {
    globalThis.localStorage?.removeItem(STORAGE_KEY);
  } catch {
    /* nothing to do and nothing worth saying */
  }
}

/** True when anything has been authored. Drives the "saved"/"empty" readout. */
export function projectIsEmpty(project: LabProject): boolean {
  return (
    project.animation.frames.length === 0 &&
    project.faceBase64 === EMPTY_FACE_BASE64 &&
    JOINT_ORDER.every((joint) => project.pose[joint] === NEUTRAL_DEG)
  );
}
