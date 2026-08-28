/**
 * How wide is this pane, right now — Phase 4 W2.
 *
 * CSS answers that question already: `@container pane (width < 32.5rem)` is
 * the right tool for a column count, a stacked key/value pair or a control that
 * moves under the prose it belongs to. This module exists for the other half of
 * the brief's rule, which is stated as a boundary rather than a preference:
 *
 * > Use CSS for presentation changes and React for semantic representation
 * > changes. […] Do not create a giant React `useMediaQuery` tree for every
 * > margin and grid column. Equally, do not try to make CSS alone select
 * > between fundamentally different information artifacts.
 *
 * The test for which side of the line something is on is whether the two states
 * are the same information laid out differently, or two different artifacts. A
 * table that becomes stacked records is the first: same seven values, same DOM,
 * a container query. A 63-node architecture graph that becomes a causal-path
 * navigator is the second — different nodes, different interactions, different
 * work to mount — and mounting both and hiding one with CSS would duplicate the
 * semantics and waste the render, which is exactly what the brief says not to
 * do.
 *
 * ## What is measured
 *
 * The element's own border-box inline size, from `ResizeObserver`, which is the
 * same quantity `@container` evaluates. Reading it here rather than parsing a
 * `matchMedia` string means the CSS and the React branch cannot disagree about
 * what "520" means: {@link PANE_BANDS} is the single table and the stylesheet's
 * thresholds are the same three numbers written in `rem`.
 *
 * ## Zero dependencies
 *
 * `ResizeObserver` is in every browser this project supports and is already
 * what React Flow uses inside the architecture pane. There is no polyfill and
 * no library; a browser without it simply keeps the initial band, which is the
 * widest one, which is the arrangement that was here before container queries.
 */
import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * The brief's pane-width bands, in CSS pixels.
 *
 * The names are about the PANE, never about a device: a `narrow` pane is a
 * normal thing to have in a 2560 px window, and a `wide` one is a normal thing
 * to have in a 1440 px window with a focus workspace open. That is the whole
 * reason this is not a media query.
 *
 * | band | pane width | what it is for |
 * |---|---|---|
 * | `narrow` | < 520 px | one column; a causal path rather than a map |
 * | `medium` | 520–719 px | two columns; a subsystem neighbourhood |
 * | `wide` | >= 720 px | the full artifact |
 */
export const PANE_BANDS = Object.freeze({ narrow: 0, medium: 520, wide: 720 });

export type PaneBand = 'narrow' | 'medium' | 'wide';

/** Which band a measured pane width falls in. Total, and defined at 0. */
export function paneWidthBand(widthPx: number): PaneBand {
  if (!Number.isFinite(widthPx) || widthPx < PANE_BANDS.medium) return 'narrow';
  return widthPx < PANE_BANDS.wide ? 'medium' : 'wide';
}

export interface ContainerWidth {
  /**
   * Attach to the element whose width matters. It should be the same element
   * the CSS container is on, or a descendant that fills it — otherwise the
   * React branch and the container query are answering different questions.
   */
  readonly ref: (node: HTMLElement | null) => void;
  /** Border-box inline size in CSS pixels. `null` until the first observation. */
  readonly widthPx: number | null;
  /**
   * {@link paneWidthBand} of {@link widthPx}.
   *
   * `wide` before the first measurement, deliberately: an artifact that has not
   * been measured yet should render the complete version rather than a scoped
   * one, because showing less than the truth is the failure mode this project
   * cares about and a single frame of a too-wide layout is not.
   */
  readonly band: PaneBand;
}

/**
 * Measure an element's inline size with `ResizeObserver`.
 *
 * The ref is a callback rather than an object ref so that the observer is
 * attached when the node arrives and detached when it leaves, including across
 * the conditional mounts the dock accordion performs. State is only set when
 * the rounded width actually changes: `ResizeObserver` fires on sub-pixel
 * layout noise, and a re-render per fractional pixel inside a pane that holds a
 * WebGL canvas is not free.
 */
export function useContainerWidth(): ContainerWidth {
  const [widthPx, setWidthPx] = useState<number | null>(null);
  const observer = useRef<ResizeObserver | null>(null);
  const last = useRef<number | null>(null);

  useEffect(
    () => () => {
      observer.current?.disconnect();
      observer.current = null;
    },
    [],
  );

  const ref = useCallback((node: HTMLElement | null) => {
    observer.current?.disconnect();
    observer.current = null;
    if (node === null) return;
    if (typeof ResizeObserver === 'undefined') return;
    const next = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (entry === undefined) return;
      // `borderBoxSize` is what `@container` measures. The rect is the fallback
      // for the one engine generation that shipped the observer without it.
      const measured = entry.borderBoxSize?.[0]?.inlineSize ?? entry.contentRect.width;
      const rounded = Math.round(measured);
      if (last.current === rounded) return;
      last.current = rounded;
      setWidthPx(rounded);
    });
    next.observe(node);
    observer.current = next;
    // The first measurement, synchronously, so the first paint after a mount is
    // not a frame of the wrong artifact.
    const rect = node.getBoundingClientRect();
    const rounded = Math.round(rect.width);
    if (rounded > 0 && last.current !== rounded) {
      last.current = rounded;
      setWidthPx(rounded);
    }
  }, []);

  return { ref, widthPx, band: widthPx === null ? 'wide' : paneWidthBand(widthPx) };
}
