/**
 * The four runtime settings `/getSettings` and `/setSettings` expose.
 *
 * On the robot these are four plain globals that `loop()` and the movement
 * functions read live (`firmware/sesame-firmware-main.ino:117`–`:119`, `:57`).
 * The `SesameRobot` contract has no settings surface at all, so the adapter
 * holds them itself — and forwards them to the backend when the backend says
 * it can take them, via the optional {@link SettingsCapableRobot} extension.
 *
 * That split is deliberate. It keeps `sesame-api` backend-agnostic (a backend
 * that cannot change its frame delay simply does not implement the extension,
 * and the adapter still round-trips the value the way the robot does), while
 * leaving one obvious place for `RealSesameRobot` to plug in a real write.
 */

/** Exactly the four keys `handleGetSettings()` emits — `:270`–`:277`. */
export interface RuntimeSettings {
  /** `int frameDelay = 100;` — the `pressingCheck()` window. `:117`. */
  frameDelay: number;
  /** `int walkCycles = 10;` — the gait loop bound. `:118`. */
  walkCycles: number;
  /** `int motorCurrentDelay = 20;` — the stagger after every servo write. `:119`. */
  motorCurrentDelay: number;
  /** `int faceFps = 8;` — the global fallback frame rate. `:57`. */
  faceFps: number;
}

/** Firmware power-on values. */
export const DEFAULT_RUNTIME_SETTINGS: Readonly<RuntimeSettings> = Object.freeze({
  frameDelay: 100,
  walkCycles: 10,
  motorCurrentDelay: 20,
  faceFps: 8,
});

/**
 * The optional extension a backend implements when it can actually apply the
 * settings. Purely structural — nothing needs to import this to satisfy it.
 */
export interface SettingsCapableRobot {
  getSesameSettings(): RuntimeSettings | Promise<RuntimeSettings>;
  setSesameSettings(settings: RuntimeSettings): void | Promise<void>;
}

/** Structural probe. */
export function isSettingsCapable(robot: unknown): robot is SettingsCapableRobot {
  if (typeof robot !== 'object' || robot === null) return false;
  const candidate = robot as Partial<SettingsCapableRobot>;
  return (
    typeof candidate.getSesameSettings === 'function' &&
    typeof candidate.setSesameSettings === 'function'
  );
}

/**
 * Apply `/setSettings`' argument handling — `handleSetSettings()`, `:280`–`:286`.
 *
 * Faithful to three things that a sane implementation would get wrong:
 *
 * 1. **Every argument is optional and absence means "leave it alone."** There
 *    is no "reset to default".
 * 2. **`faceFps` is floored at 1** (`max(1L, …)`), and *nothing else is
 *    validated*. `?frameDelay=-5` is accepted and stored. `?walkCycles=0`
 *    is accepted and produces a gait that does nothing.
 * 3. **The parse is `String::toInt()`**, so `?walkCycles=lots` stores `0`
 *    rather than being rejected.
 *
 * The response is always `200 "OK"` — there is no failure path.
 */
export function applySetSettings(
  current: Readonly<RuntimeSettings>,
  read: (name: string) => { present: boolean; value: number },
): RuntimeSettings {
  const next: RuntimeSettings = { ...current };
  const frameDelay = read('frameDelay');
  if (frameDelay.present) next.frameDelay = frameDelay.value;
  const walkCycles = read('walkCycles');
  if (walkCycles.present) next.walkCycles = walkCycles.value;
  const motorCurrentDelay = read('motorCurrentDelay');
  if (motorCurrentDelay.present) next.motorCurrentDelay = motorCurrentDelay.value;
  const faceFps = read('faceFps');
  if (faceFps.present) next.faceFps = Math.max(1, faceFps.value);
  return next;
}

/**
 * `handleGetSettings()`' hand-built JSON — `:270`–`:277`.
 *
 * Built by concatenation on purpose: key order is part of the byte-for-byte
 * response an existing client may (unwisely) be matching on, and
 * `JSON.stringify` of an object literal is only *incidentally* ordered.
 */
export function renderSettingsJson(settings: Readonly<RuntimeSettings>): string {
  return (
    '{' +
    `"frameDelay":${String(settings.frameDelay)},` +
    `"walkCycles":${String(settings.walkCycles)},` +
    `"motorCurrentDelay":${String(settings.motorCurrentDelay)},` +
    `"faceFps":${String(settings.faceFps)}` +
    '}'
  );
}
