/**
 * `TelemetryOrigin` — what, exactly, observed an `observed` event.
 *
 * ## The problem this fixes
 *
 * v1 gave every event a required {@link Provenance}, and it distinguishes the
 * three things a lesson must never confuse: something *happened*
 * (`observed`), a model *computed* it (`simulated`), or it was *constructed*
 * for explanation (`inferred`). That is the right axis, and it stays.
 *
 * But `observed` alone is ambiguous in the one direction that matters most.
 * v1's own wording is "bytes crossed the emulated UART, **or** the physical
 * robot really moved" — those are the same tag. So a QEMU run tagged
 * `provenance: "observed"` is indistinguishable, to any consumer, from a
 * measurement taken off real hardware. It is not one. It is:
 *
 * - an **emulator**, not silicon;
 * - the **legacy Distro V1 ESP32** board, not the current S3 and not the S2
 *   Mini the report recommends for DIY builds (QEMU has no `esp32s2` machine
 *   at all);
 * - firmware with **Wi-Fi elided** and a **DIO bootloader** substituted, so
 *   whole subsystems are absent rather than merely quiet.
 *
 * A learner shown "observed" next to a servo angle and left to infer that a
 * robot moved has been misled, and no amount of prose in a README fixes that,
 * because the prose is not attached to the event.
 *
 * ## Why a second field rather than a fourth provenance
 *
 * Adding `'emulated'` to {@link Provenance} was the obvious move and it is
 * wrong. `Provenance` answers *how much epistemic weight does this carry*;
 * origin answers *which boundary was crossed*. Merging them would force a
 * choice for every future backend — is a hardware-in-the-loop rig `observed` or
 * `emulated`? — and would silently reclassify every existing event.
 *
 * Keeping them orthogonal also keeps the wire alone: `origin` is **not** a wire
 * tag. It is stamped by whoever owns the transport, exactly like
 * `defaultProvenance`, because the firmware cannot know it is running under an
 * emulator and should not be asked to claim it is not.
 */

/** The kind of boundary an event crossed. */
export type OriginKind =
  /** Real silicon, real servos. Nothing in this project produces this yet. */
  | 'physical-robot'
  /** Real firmware instructions, emulated silicon. QEMU, Renode. */
  | 'emulator'
  /** A host-side behaviour model. No firmware executed. */
  | 'host-model'
  /** Recorded bytes played back. Whatever produced them originally is gone. */
  | 'replay'
  /** Nobody said. Treat as "not known to be physical". */
  | 'unknown';

/**
 * Where an event came from, physically.
 *
 * Every field beyond `kind` is optional and every one of them is a *limit*
 * rather than a feature: they exist so a consumer can say "this does not
 * demonstrate S2 behaviour" without knowing anything about QEMU.
 */
export interface TelemetryOrigin {
  readonly kind: OriginKind;

  /**
   * The thing that ran it, with a version.
   * e.g. `qemu-system-xtensa/9.2.2-esp_develop_9.2.2_20260417`.
   */
  readonly engine?: string;

  /**
   * Board profile, spelled as `hardware/hardware-map.json` spells it —
   * `distro-v1-esp32`, `distro-v3-s3`, `s2mini`.
   *
   * This is the field that stops an ESP32-machine run being read as evidence
   * about the S2 Mini. Pin assignments, USB-CDC routing and I2C pins all differ
   * per board, and none of them is demonstrated by a run on another one.
   */
  readonly board?: string;

  /**
   * Subsystems the origin does **not** model, so silence from them means
   * nothing. e.g. `['wifi', 'oled-panel', 'servo-load']`.
   *
   * The point is negative evidence. Without this, "no Wi-Fi events" reads as
   * "the radio was idle" instead of "there is no radio".
   */
  readonly elided?: readonly string[];

  /**
   * How the running image differs from the stock firmware, one clause each.
   * e.g. `['FlashMode=dio bootloader', 'Wi-Fi/SoftAP/mDNS/HTTP elided']`.
   */
  readonly firmwareDeviations?: readonly string[];
}

/** `{ kind: 'unknown' }`, frozen. The default everywhere. */
export const UNKNOWN_ORIGIN: TelemetryOrigin = Object.freeze({ kind: 'unknown' });

/** All origin kinds. */
export const ORIGIN_KINDS = [
  'physical-robot',
  'emulator',
  'host-model',
  'replay',
  'unknown',
] as const;

/** Narrowing guard for untrusted input. */
export function isOriginKind(value: unknown): value is OriginKind {
  return typeof value === 'string' && (ORIGIN_KINDS as readonly string[]).includes(value);
}

/**
 * **The predicate a UI should branch on before saying "the robot did this".**
 *
 * True only for something that happened on physical hardware. An emulator run
 * is `observed` and still returns `false` here, which is the whole point:
 * `provenance === 'observed'` is not, and never was, a licence to draw a
 * measurement.
 */
export function isPhysicallyObserved(event: {
  readonly provenance: string;
  readonly origin?: TelemetryOrigin | undefined;
}): boolean {
  return event.provenance === 'observed' && event.origin?.kind === 'physical-robot';
}

/**
 * A short human label: `"emulated (qemu-system-xtensa/9.2.2, distro-v1-esp32)"`.
 *
 * Deliberately never returns the empty string, so a UI that interpolates it
 * cannot end up displaying an unqualified "observed".
 */
export function describeOrigin(origin: TelemetryOrigin | undefined): string {
  const o = origin ?? UNKNOWN_ORIGIN;
  const head: Record<OriginKind, string> = {
    'physical-robot': 'physical hardware',
    emulator: 'emulated',
    'host-model': 'host model',
    replay: 'replay',
    unknown: 'origin not stated',
  };
  const parts = [o.engine, o.board].filter((p): p is string => p !== undefined && p.length > 0);
  return parts.length === 0 ? head[o.kind] : `${head[o.kind]} (${parts.join(', ')})`;
}
