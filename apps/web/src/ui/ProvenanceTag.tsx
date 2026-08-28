/**
 * The three-way provenance badge.
 *
 * `provenance` is a required field on every `SesameTelemetry` event precisely
 * so this cannot be forgotten. The wording is the protocol's own (§7.1), not a
 * paraphrase, because the distinction it draws is the whole point:
 *
 * | value       | meaning                                            | presentable as fact? |
 * |-------------|----------------------------------------------------|----------------------|
 * | `observed`  | something really happened across a real boundary   | yes                  |
 * | `simulated` | a host-side model computed what the robot *would* do | only when labelled |
 * | `inferred`  | constructed for explanation; nothing observed it   | only when labelled   |
 *
 * ## And the second axis, which is the one that matters here
 *
 * `observed` alone is ambiguous in the direction that misleads worst. The
 * protocol's own v1 wording is "bytes crossed the emulated UART, **or** the
 * physical robot really moved" — the same tag for both. So a QEMU run is
 * `observed` and is *not* a measurement, and the app must never decide
 * otherwise by comparing `provenance === 'observed'`.
 *
 * {@link OriginTag} renders `describeOrigin()`, and
 * {@link isPhysicallyObserved} is the predicate to branch on. It returns false
 * for an emulator, and false again when no origin was stated: unknown is *not
 * known to be physical*.
 */
import {
  describeOrigin,
  isPhysicallyObserved,
  type OriginKind,
  type Provenance,
  type SesameTelemetry,
  type TelemetryOrigin,
} from '@sesame-lab/sesame-protocol';
import type { ReactElement } from 'react';

export const PROVENANCE_MEANING: Readonly<Record<Provenance, string>> = {
  observed:
    'Something actually happened on the other side of a real boundary: bytes crossed a UART, the ' +
    'firmware hook really ran, a physical robot really moved.',
  simulated:
    'A host-side behaviour model computed what the robot would do. No firmware executed and no ' +
    'silicon was involved.',
  inferred:
    'Constructed for explanation. No backend observed this; it was derived from something else so ' +
    'that an intermediate step is visible.',
};

export function ProvenanceTag({ value, size }: { readonly value: Provenance; readonly size?: 'lg' }): ReactElement {
  return (
    <span
      className={`prov prov-${value}${size === 'lg' ? ' prov-lg' : ''}`}
      /*
        `data-provenance` on the MARK itself - Phase 4 W2.

        It was already on three wrappers (the rail chip, the status line, a
        trace row) and on none of the badges those wrappers contain, so a test
        that wanted to know what a particular badge claims had to read its text.
        Scraping rendered text is how a correctness assertion quietly becomes a
        typography assertion; the brief's rule is that correctness surfaces
        carry their semantics as data. The class name is not that: it is a
        styling hook that a refactor may rename, and W6's invariants must not
        be the thing that breaks when it does.
      */
      data-provenance={value}
      title={PROVENANCE_MEANING[value]}
    >
      {value}
    </span>
  );
}

/** What each boundary means, in one sentence, for a tooltip. */
export const ORIGIN_MEANING: Readonly<Record<OriginKind, string>> = {
  'physical-robot':
    'Real silicon, real servos. This is the only origin that makes a number on screen a ' +
    'measurement. Nothing in this project produces it — there is no physical Sesame.',
  emulator:
    'Real firmware instructions on emulated silicon. The code really ran; the hardware did not ' +
    'exist. Whole subsystems may be absent rather than merely quiet — see the elided list.',
  'host-model':
    'A host-side behaviour model computed what the robot would do. No firmware executed.',
  replay: 'Recorded bytes played back. Whatever produced them originally is gone.',
  unknown:
    'Nobody stated where this came from. Treated as "not known to be physical", never as physical ' +
    'by default.',
};

/**
 * The origin badge. Always renders something: `describeOrigin()` never returns
 * the empty string, precisely so a UI cannot end up showing a bare "observed".
 */
export function OriginTag({
  origin,
  size,
  compact,
}: {
  readonly origin: TelemetryOrigin | null | undefined;
  readonly size?: 'lg';
  /**
   * Render the origin's KIND without its engine and board — Phase 4 W1.
   *
   * The 56 px rail is the one place on screen where the full string cannot be
   * shown at the 14px readability floor: `"host model (@sesame-lab/sesame-sim)"`
   * needs about 240 px and the rail has 48. It used to be set in 9px type and
   * cut off with an ellipsis, which is the failure this workstream's invariant
   * names outright — a correctness surface may not be truncated.
   *
   * So the rail shows the kind, complete, at 14px; the status line under the
   * robot and `#prov-banner` in the inspector both still render the whole
   * string, and the tooltip here carries the meaning. The short form is
   * produced by calling `describeOrigin()` with the engine and board stripped
   * rather than by a second table of words, so the two cannot drift apart by
   * construction: there is no local copy of the protocol's wording to update.
   */
  readonly compact?: boolean;
}): ReactElement {
  const kind: OriginKind = origin?.kind ?? 'unknown';
  return (
    <span
      className={`prov origin origin-${kind}${size === 'lg' ? ' prov-lg' : ''}`}
      title={compact === true ? `${describeOrigin(origin ?? undefined)} — ${ORIGIN_MEANING[kind]}` : ORIGIN_MEANING[kind]}
      data-origin-kind={kind}
      /*
        The second axis, as data - Phase 4 W2.

        The brief's sharpest correctness point is that `observed` alone is
        insufficient because a novice reads it as observed ON HARDWARE, and the
        predicate that settles it is `isPhysicallyObserved()`, not a string
        comparison. `data-origin-physical` is that predicate's answer for this
        badge, published so an invariant can assert "no rendered origin is ever
        physical" against the model rather than against the words. It is `false`
        on every origin this project can produce, permanently, and that is a
        property rather than a gap.
      */
      data-origin-physical={String(kind === 'physical-robot')}
    >
      {compact === true ? describeOriginKind(kind) : describeOrigin(origin ?? undefined)}
    </span>
  );
}

/**
 * The origin's kind, in the protocol's own words, with no engine or board.
 *
 * Deliberately `describeOrigin()` with the detail removed rather than a local
 * copy of its head table: there is exactly one place in the codebase that
 * decides what an `emulator` origin is called.
 */
export const describeOriginKind = (kind: OriginKind): string => describeOrigin({ kind });

/**
 * One line that settles "is this a measurement?" for a whole stream.
 *
 * Deliberately phrased so that the answer for every backend this project has is
 * "no", and so that the reason differs per backend rather than being a generic
 * disclaimer nobody reads.
 */
export function measurementVerdict(
  provenance: Provenance | null,
  origin: TelemetryOrigin | null | undefined,
): string {
  const detail = measurementDetail(provenance, origin);
  const headline = measurementHeadline(provenance, origin);
  return detail === '' ? headline : `${headline} ${detail}`;
}

/**
 * The CLAIM, in one line — Phase 4 W7.
 *
 * The side panel is 280 px wide and may never grow a scrollbar, and the full
 * verdict is four lines of prose there. §11.4 lets a "more info" screen EXPAND
 * a correctness surface and forbids it from being where one first appears, so
 * the split is between the claim and its explanation: this sentence is on the
 * panel permanently and {@link measurementDetail} is in the screen behind it.
 *
 * Both are computed from `isPhysicallyObserved()` and from the same origin, so
 * the short form and the long form cannot say different things.
 */
export function measurementHeadline(
  provenance: Provenance | null,
  origin: TelemetryOrigin | null | undefined,
): string {
  if (provenance === null) return 'Nothing has driven this scene yet.';
  const physical = isPhysicallyObserved({
    provenance,
    ...(origin === null || origin === undefined ? {} : { origin }),
  } as Pick<SesameTelemetry, 'provenance'> & { origin?: TelemetryOrigin });
  return physical ? 'These numbers were measured on physical hardware.' : 'Not a measurement.';
}

/** Why, in the words that differ per backend. Empty when there is nothing to add. */
export function measurementDetail(
  provenance: Provenance | null,
  origin: TelemetryOrigin | null | undefined,
): string {
  if (provenance === null) return '';
  const physical = isPhysicallyObserved({
    provenance,
    ...(origin === null || origin === undefined ? {} : { origin }),
  } as Pick<SesameTelemetry, 'provenance'> & { origin?: TelemetryOrigin });
  if (physical) return '';
  switch (origin?.kind) {
    case 'emulator':
      return (
        'The firmware really executed and really wrote these angles, but it did ' +
        'so on emulated silicon — so this shows what the CODE does, not what a servo horn did.'
      );
    case 'host-model':
      return 'A host-side model computed this; no firmware executed.';
    case 'replay':
      return 'These are recorded bytes; whatever produced them is gone.';
    default:
      return (
        'No origin was stated, and an unstated origin is treated as “not known ' +
        'to be physical” rather than assumed to be a robot.'
      );
  }
}
