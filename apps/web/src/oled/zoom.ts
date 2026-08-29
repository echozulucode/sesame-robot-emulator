/**
 * The integer-pixel zoom policy for every 128x64 surface in this app.
 *
 * ===========================================================================
 * THE POLICY, AND IT IS A POLICY RATHER THAN A LAYOUT RULE — Phase 4 W5
 * ===========================================================================
 *
 * > *"A 128x64 bitmap editor is one of the cases where 'responsive scaling' can
 * > make the tool less truthful. Do not continuously shrink the pixel grid. Use
 * > discrete zoom levels. A 2x or 3x editor may technically fit, but if
 * > individual pixels no longer feel directly manipulable, you have lost the
 * > point of the pane."* — the brief
 *
 * A `width: 100%` canvas with `image-rendering: pixelated` does not render a
 * uniformly smaller grid. At 2.94 device pixels per logical pixel the browser
 * paints some logical pixels three device pixels wide and some two, and the
 * SSD1306's eight page-grid lines — the whole reason the grid is drawn, because
 * `index = x + (y >> 3) * 128` is the thing being taught — land *between*
 * device pixels. W2 measured exactly that at a 377 px pane and handed the
 * decision on. A reader counting pixels on a fractional zoom counts wrong, and
 * the byte/bit read-out under the canvas then disagrees with what is on screen.
 *
 * So the zoom comes from a **ladder**, never from the box:
 *
 * | available width | zoom | rendered |
 * |---:|---:|---|
 * | >= 1024 px | **8x** | 1024 x 512 |
 * | >= 768 px | **6x** | 768 x 384 |
 * | >= 512 px | **4x** | 512 x 256 |
 * | >= 256 px | **2x** | 256 x 128 |
 * | below that | **1x** | 128 x 64 |
 *
 * which is the brief's own table (`>=1050 -> 8x`, `800-1049 -> 6x`,
 * `540-799 -> 4x`) restated as the constraint that actually decides it: the
 * canvas has to FIT. The brief's thresholds carry ~26 px of pane chrome in
 * them; the ladder carries none, so it is the same table without a second copy
 * of this layout's padding baked into it.
 *
 * ## What it costs, said out loud
 *
 * Between two rungs the box keeps its slack. A 760 px editor renders at 4x and
 * leaves 248 px unused, because 6x needs 768. That is the trade the brief asks
 * for by name and it is the one thing this file gives up.
 *
 * ## What the 2x rung means, which is the decision W2 handed over
 *
 * The side panel's Face card is 262 px wide, so it is **2x, permanently** —
 * there is no arrangement of a 280 px panel in which a 128 px-wide bitmap is
 * directly manipulable. The consequence is stated rather than papered over:
 * **the Face card is a glass, not an editor.** Nothing on it invites a pixel to
 * be hovered or hit; the GDDRAM byte/bit read-out and the pixel editor both
 * live on surfaces that clear 4x — the "more info" screen (6x at every window
 * this project measures) and the Lab's editor column (4x at 1440, 6x at 1920,
 * 8x at 2560). A learner loses the ability to work a pixel from the glance
 * card, which they never had, and gains a card whose grid lines are where the
 * chip puts them.
 */

/**
 * The rungs, largest first. Six is on it because the brief's table names it;
 * two and one are on it because the glance card cannot reach four and the
 * alternative to a small honest rung is a large dishonest one.
 */
export const OLED_ZOOM_LADDER = [8, 6, 4, 2, 1] as const;

export type OledZoom = (typeof OLED_ZOOM_LADDER)[number];

/** The smallest rung. A surface narrower than 128 px still renders at 1x. */
export const MIN_OLED_ZOOM: OledZoom = 1;

/**
 * The floor for a surface a reader is expected to WORK a pixel on.
 *
 * > *"<540px: Keep **4x** and use horizontal pan / focus workspace."* — the
 * > brief's own bottom row
 *
 * This is the half of the policy that is easy to get wrong in the safe-looking
 * direction. Measured, the Lab's editor column is 506 px at 1440x900 — six
 * pixels short of 4x — so a ladder that simply takes the largest rung that fits
 * hands a 1440 laptop a **2x** editor, which is worse than the fractional 3.95x
 * it replaced and is precisely the "you have lost the point of the pane" case.
 * An editor holds its 4x and scrolls sideways instead; the surface is a
 * declared `data-2d-surface`, so a horizontal scroller there is the contract
 * rather than a leak.
 *
 * The Face GLANCE card has no floor, because it is not an editor. See the
 * module header.
 */
export const EDITOR_MIN_ZOOM: OledZoom = 4;

export interface OledZoomOptions {
  /**
   * A height budget, when the caller has one that is not derived from this
   * canvas. Usually absent: a card sized by its content cannot be asked how
   * tall it would be if its content were smaller without the question being
   * circular, and a height read back off the canvas's own box is exactly that
   * question.
   */
  readonly heightPx?: number;
  readonly logicalWidth?: number;
  readonly logicalHeight?: number;
  /** {@link EDITOR_MIN_ZOOM} for an editing surface; 1 for a glance. */
  readonly minZoom?: OledZoom;
}

/** The largest rung whose rendered size fits the box, never below `minZoom`. */
export function integerOledZoom(widthPx: number, options: OledZoomOptions = {}): OledZoom {
  const {
    heightPx = Number.POSITIVE_INFINITY,
    logicalWidth = 128,
    logicalHeight = 64,
    minZoom = MIN_OLED_ZOOM,
  } = options;
  for (const zoom of OLED_ZOOM_LADDER) {
    if (zoom < minZoom) break;
    if (logicalWidth * zoom <= widthPx && logicalHeight * zoom <= heightPx) return zoom;
  }
  return minZoom;
}

/** True when a rendered box is exactly some rung of the ladder. The invariant. */
export function isIntegerOledZoom(renderedWidthPx: number, logicalWidth = 128): boolean {
  const ratio = renderedWidthPx / logicalWidth;
  return (
    (OLED_ZOOM_LADDER as readonly number[]).includes(Math.round(ratio)) &&
    Math.abs(ratio - Math.round(ratio)) < 0.01
  );
}
