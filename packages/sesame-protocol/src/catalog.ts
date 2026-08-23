/**
 * The firmware's real vocabulary: 38 face expressions, 21 movement functions,
 * 21 command strings.
 *
 * These are baked in as constants rather than read from
 * `hardware/hardware-map.json` at runtime, because this package must work in a
 * browser with no filesystem. `catalog-drift.test.ts` re-derives every entry
 * from `hardware/hardware-map.json` and fails if they disagree, so the constant
 * cannot silently rot: the JSON stays the single source of truth, this file is
 * a generated-and-checked mirror of it.
 *
 * Provenance for all of it: `hardware/hardware-map.json`, extracted in F4 from
 * `firmware/sesame-firmware-main.ino`, `firmware/face-bitmaps.h` and
 * `firmware/movement-sequences.h` with `file:line` for every fact.
 */

/** How `updateAnimatedFace()` advances through a face's frames. */
export type FacePlaybackMode = 'once' | 'loop' | 'boomerang' | 'inherited';

/** One expression the stock firmware knows how to draw. */
export interface FaceCatalogEntry {
  /** Name as spelled in firmware. `setFace()` matches it case-insensitively. */
  readonly name: string;
  /**
   * Frames actually defined. `countFrames()` counts array slots until the first
   * null pointer, capped at {@link MAX_FACE_FRAMES}. Zero means the face is
   * registered but has no bitmap.
   */
  readonly frameCount: number;
  /** `updateAnimatedFace()` returns immediately when `frameCount <= 1`. */
  readonly animated: boolean;
  /** Frames per second, or `null` where the firmware never sets one. */
  readonly fps: number | null;
  /** Rough grouping, from F4. Not a firmware concept. */
  readonly category: string;
  /** Playback modes observed at the call sites that select this face. */
  readonly modes: readonly FacePlaybackMode[];
}

/** `MAX_FACE_FRAMES` — the X-macro allocates six frame slots per face. */
export const MAX_FACE_FRAMES = 6;

/** All 38 registered expressions, in `faceEntries[]` registry order. */
export const FACE_CATALOG: readonly FaceCatalogEntry[] = Object.freeze([
  { name: 'walk', frameCount: 1, animated: false, fps: 1, category: 'movement', modes: ['once'] },
  { name: 'rest', frameCount: 3, animated: true, fps: 1, category: 'movement', modes: ['boomerang', 'inherited'] },
  { name: 'swim', frameCount: 1, animated: false, fps: 1, category: 'movement', modes: ['once'] },
  { name: 'dance', frameCount: 2, animated: true, fps: 1, category: 'movement', modes: ['loop'] },
  { name: 'wave', frameCount: 1, animated: false, fps: 1, category: 'movement', modes: ['once'] },
  { name: 'point', frameCount: 3, animated: true, fps: 5, category: 'movement', modes: ['boomerang'] },
  { name: 'stand', frameCount: 0, animated: false, fps: 1, category: 'movement', modes: ['once'] },
  { name: 'cute', frameCount: 1, animated: false, fps: 1, category: 'movement', modes: ['once'] },
  { name: 'pushup', frameCount: 1, animated: false, fps: 1, category: 'movement', modes: ['once'] },
  { name: 'freaky', frameCount: 1, animated: false, fps: 1, category: 'movement', modes: ['once'] },
  { name: 'bow', frameCount: 1, animated: false, fps: 1, category: 'movement', modes: ['once'] },
  { name: 'worm', frameCount: 1, animated: false, fps: 1, category: 'movement', modes: ['once'] },
  { name: 'shake', frameCount: 1, animated: false, fps: 1, category: 'movement', modes: ['once'] },
  { name: 'shrug', frameCount: 1, animated: false, fps: 1, category: 'movement', modes: ['once'] },
  { name: 'dead', frameCount: 3, animated: true, fps: 2, category: 'movement', modes: ['once', 'boomerang'] },
  { name: 'crab', frameCount: 1, animated: false, fps: 1, category: 'movement', modes: ['once'] },
  { name: 'defualt', frameCount: 0, animated: false, fps: null, category: 'movement', modes: [] },
  { name: 'idle', frameCount: 1, animated: false, fps: 1, category: 'special', modes: ['boomerang'] },
  { name: 'idle_blink', frameCount: 4, animated: true, fps: 7, category: 'special', modes: ['once'] },
  { name: 'happy', frameCount: 1, animated: false, fps: 1, category: 'conversational', modes: [] },
  { name: 'talk_happy', frameCount: 1, animated: false, fps: 1, category: 'conversational', modes: [] },
  { name: 'sad', frameCount: 1, animated: false, fps: 1, category: 'conversational', modes: [] },
  { name: 'talk_sad', frameCount: 1, animated: false, fps: 1, category: 'conversational', modes: [] },
  { name: 'angry', frameCount: 1, animated: false, fps: 1, category: 'conversational', modes: [] },
  { name: 'talk_angry', frameCount: 1, animated: false, fps: 1, category: 'conversational', modes: [] },
  { name: 'surprised', frameCount: 1, animated: false, fps: 1, category: 'conversational', modes: [] },
  { name: 'talk_surprised', frameCount: 1, animated: false, fps: 1, category: 'conversational', modes: [] },
  { name: 'sleepy', frameCount: 1, animated: false, fps: 1, category: 'conversational', modes: [] },
  { name: 'talk_sleepy', frameCount: 1, animated: false, fps: 1, category: 'conversational', modes: [] },
  { name: 'love', frameCount: 1, animated: false, fps: 1, category: 'conversational', modes: [] },
  { name: 'talk_love', frameCount: 1, animated: false, fps: 1, category: 'conversational', modes: [] },
  { name: 'excited', frameCount: 1, animated: false, fps: 1, category: 'conversational', modes: [] },
  { name: 'talk_excited', frameCount: 1, animated: false, fps: 1, category: 'conversational', modes: [] },
  { name: 'confused', frameCount: 1, animated: false, fps: 1, category: 'conversational', modes: [] },
  { name: 'talk_confused', frameCount: 1, animated: false, fps: 1, category: 'conversational', modes: [] },
  { name: 'thinking', frameCount: 1, animated: false, fps: 1, category: 'conversational', modes: [] },
  { name: 'talk_thinking', frameCount: 1, animated: false, fps: 1, category: 'conversational', modes: [] },
  { name: 'default', frameCount: 0, animated: false, fps: 1, category: 'special', modes: [] },
]);

/** Just the names, in registry order. Note the firmware ships both `defualt` and `default`. */
export const FACE_NAMES: readonly string[] = Object.freeze(FACE_CATALOG.map((f) => f.name));

const FACE_BY_LOWER_NAME: ReadonlyMap<string, FaceCatalogEntry> = new Map(
  FACE_CATALOG.map((entry) => [entry.name.toLowerCase(), entry]),
);

const FACE_NAME_SET: ReadonlySet<string> = new Set(FACE_NAMES);

/** Exact-spelling membership test. */
export function isKnownFaceName(name: string): boolean {
  return FACE_NAME_SET.has(name);
}

/**
 * Resolve a name the way the firmware's `setFace()` does — case-insensitively.
 * Returns the catalog entry, or `undefined` if no face matches.
 */
export function lookupFace(name: string): FaceCatalogEntry | undefined {
  return FACE_BY_LOWER_NAME.get(name.toLowerCase());
}

/**
 * The firmware's spelling of a face name, or `undefined` if unknown.
 * `canonicalFaceName('Wave') === 'wave'`.
 */
export function canonicalFaceName(name: string): string | undefined {
  return lookupFace(name)?.name;
}

/**
 * The 21 movement/pose functions in `firmware/movement-sequences.h`, in
 * declaration order. Not part of the wire protocol; exported so the causal
 * trace (`movement.enter runWavePose`) and the R7 bridge do not each invent
 * their own list.
 */
export const MOVEMENT_FUNCTIONS: readonly string[] = Object.freeze([
  'runRestPose', 'runStandPose', 'runWavePose', 'runDancePose', 'runSwimPose',
  'runPointPose', 'runPushupPose', 'runBowPose', 'runCutePose', 'runFreakyPose',
  'runWormPose', 'runShakePose', 'runShrugPose', 'runDeadPose', 'runCrabPose',
  'runWalkPose', 'runWalkBackward', 'runTurnLeft', 'runTurnRight',
  'enterIdle', 'exitIdle',
]);

/** One entry in the firmware's `currentCommand` dispatch table. */
export interface CommandCatalogEntry {
  /** The command string. The empty string is "no command pending". */
  readonly command: string;
  /** The function `loop()` dispatches to, or `null` for `stop` and the empty command. */
  readonly movementFunction: string | null;
  /** True if `loop()` re-runs it every iteration because it never clears itself. */
  readonly continuous: boolean;
}

/** The command vocabulary `loop()` recognises, in dispatch order. */
export const COMMAND_VOCABULARY: readonly CommandCatalogEntry[] = Object.freeze([
  { command: 'forward', movementFunction: 'runWalkPose', continuous: true },
  { command: 'backward', movementFunction: 'runWalkBackward', continuous: true },
  { command: 'left', movementFunction: 'runTurnLeft', continuous: true },
  { command: 'right', movementFunction: 'runTurnRight', continuous: true },
  { command: 'rest', movementFunction: 'runRestPose', continuous: false },
  { command: 'stand', movementFunction: 'runStandPose', continuous: false },
  { command: 'wave', movementFunction: 'runWavePose', continuous: false },
  { command: 'dance', movementFunction: 'runDancePose', continuous: false },
  { command: 'swim', movementFunction: 'runSwimPose', continuous: false },
  { command: 'point', movementFunction: 'runPointPose', continuous: false },
  { command: 'pushup', movementFunction: 'runPushupPose', continuous: false },
  { command: 'bow', movementFunction: 'runBowPose', continuous: false },
  { command: 'cute', movementFunction: 'runCutePose', continuous: false },
  { command: 'freaky', movementFunction: 'runFreakyPose', continuous: false },
  { command: 'worm', movementFunction: 'runWormPose', continuous: false },
  { command: 'shake', movementFunction: 'runShakePose', continuous: false },
  { command: 'shrug', movementFunction: 'runShrugPose', continuous: false },
  { command: 'dead', movementFunction: 'runDeadPose', continuous: false },
  { command: 'crab', movementFunction: 'runCrabPose', continuous: false },
  { command: 'stop', movementFunction: null, continuous: false },
  { command: '', movementFunction: null, continuous: false },
]);

/** Non-empty command strings. */
export const COMMAND_NAMES: readonly string[] = Object.freeze(
  COMMAND_VOCABULARY.map((c) => c.command).filter((c) => c.length > 0),
);

/**
 * The firmware's servo angle clamp: `constrain(angle + servoSubtrim[ch], 0, 180)`
 * at `firmware/sesame-firmware-main.ino:1053`. Subtrim is applied *before* the
 * clamp, so a telemetry angle is always the post-clamp value.
 */
export const ANGLE_MIN_DEG = 0;

/** See {@link ANGLE_MIN_DEG}. */
export const ANGLE_MAX_DEG = 180;
