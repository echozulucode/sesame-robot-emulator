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
 */
import type { Provenance } from '@sesame-lab/sesame-protocol';
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
    <span className={`prov prov-${value}${size === 'lg' ? ' prov-lg' : ''}`} title={PROVENANCE_MEANING[value]}>
      {value}
    </span>
  );
}
