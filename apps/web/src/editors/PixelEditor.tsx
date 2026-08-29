/**
 * The 128×64 pixel editor — a Lab tool, borrowed by Learn.
 *
 * Draws into the same byte layout `firmware/face-bitmaps.h` uses (row-major,
 * MSB first) and pushes the result through `renderAuthoredBitmap()`, which is
 * `Adafruit_GFX::drawBitmap()` followed by the SSD1306 page write. So a frame
 * drawn here reaches the virtual panel by the route a real face does, not by a
 * shortcut that happens to look the same.
 *
 * The canvas is drawn imperatively rather than as 8192 DOM nodes: at 4 px per
 * pixel that is one 512×256 canvas, and the alternative re-renders a grid the
 * size of the whole rest of the app on every stroke.
 *
 * ===========================================================================
 * TWO THINGS W5 CHANGED, AND BOTH ARE ABOUT AN EDITOR BEING AN EDITOR
 * ===========================================================================
 *
 * > *"This is where a generic 'pane stacks below 520px' rule fails. […]
 * > 'responsive pane' should mean responsive to the DATA MODEL of that pane."*
 *
 * **1. The zoom is an integer.** `max-width: 100%` on a 512 px canvas in a
 * 429 px column is 3.35 device pixels per logical pixel, which paints some
 * pixels four wide and some three. See `oled/zoom.ts` for the policy and what
 * it costs; the editor takes the largest rung its column can hold, which is 4×
 * at 1440×900, 6× at 1920×1080 and 8× at 2560×1440.
 *
 * **2. It is operable from the keyboard.** WCAG 2.2's *Dragging Movements* asks
 * for a single-pointer alternative to any drag that is not essential, and there
 * was none: `pointerdown`/`pointermove` was the only way in, so a reader who
 * cannot drag could not set one pixel of an 8,192-pixel bitmap. The canvas is
 * focusable, arrow keys move a cursor, `Space`/`Enter` toggles the pixel under
 * it, and holding `Shift` while moving paints as it goes — which is the drag,
 * without the drag. The cursor is drawn on the canvas and its coordinate and
 * GDDRAM byte/bit are announced in a live region, because a caret nobody can
 * read is not an alternative to anything.
 */
import { useCallback, useEffect, useRef, useState, type ReactElement } from 'react';

import { EDITOR_MIN_ZOOM, integerOledZoom } from '../oled/zoom.js';
import { useContainerWidth } from '../ui/use-container-width.js';
import { FRAME_HEIGHT, FRAME_WIDTH, getPixel } from './pixel-frame.js';

/**
 * Logical pixel -> BACKING-STORE pixel, fixed at the top of the zoom ladder.
 * The CSS size comes from {@link integerOledZoom}, so the canvas is only ever
 * downsampled by an exact integer and never upsampled.
 */
const SCALE = 8;

export interface PixelEditorProps {
  readonly frame: Uint8Array;
  /**
   * One pixel, not one frame.
   *
   * The obvious signature is `onChange(nextFrame)` computed from `props.frame`,
   * and it silently drops pixels: a drag delivers several `pointermove` events
   * before React re-renders, so every one of them reads the SAME stale frame
   * and only the last survives. Handing the parent a coordinate lets it apply
   * the edits with a functional update, which is the only version that keeps a
   * fast stroke intact.
   */
  readonly onPaint: (x: number, y: number, on: boolean) => void;
  readonly onClear: () => void;
  /** Push the drawn frame onto the virtual OLED, the way updateFaceBitmap does. */
  readonly onPush: () => void;
  readonly changed: number;
  readonly densest: { readonly width: number; readonly height: number; readonly count: number } | null;
}

const clamp = (value: number, max: number): number => Math.max(0, Math.min(max, value));

export function PixelEditor(props: PixelEditorProps): ReactElement {
  const { frame, onPaint, onClear, onPush, changed, densest } = props;
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const painting = useRef<boolean | null>(null);
  const [caret, setCaret] = useState<{ readonly x: number; readonly y: number } | null>(null);

  /* The slot is an ordinary block that fills the column, so its width is
     decided by the column and the canvas's is derived from it. Measuring the
     canvas instead would be measuring this component's own answer. */
  const slot = useContainerWidth();
  const zoom = integerOledZoom(slot.widthPx ?? 0, {
    logicalWidth: FRAME_WIDTH,
    logicalHeight: FRAME_HEIGHT,
    minZoom: EDITOR_MIN_ZOOM,
  });

  useEffect(() => {
    const canvas = canvasRef.current;
    if (canvas === null) return;
    const ctx = canvas.getContext('2d');
    if (ctx === null) return;
    ctx.fillStyle = '#0b0f14';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = '#8fe3c8';
    for (let y = 0; y < FRAME_HEIGHT; y += 1) {
      for (let x = 0; x < FRAME_WIDTH; x += 1) {
        if (getPixel(frame, x, y)) ctx.fillRect(x * SCALE, y * SCALE, SCALE, SCALE);
      }
    }
    // The keyboard caret, painted last so it is never hidden by a lit pixel.
    // Two strokes, dark under light, so it reads on both states without relying
    // on a colour difference alone.
    if (caret !== null) {
      ctx.lineWidth = 2;
      ctx.strokeStyle = '#0b0f14';
      ctx.strokeRect(caret.x * SCALE - 1, caret.y * SCALE - 1, SCALE + 2, SCALE + 2);
      ctx.strokeStyle = '#e6b45a';
      ctx.strokeRect(caret.x * SCALE, caret.y * SCALE, SCALE, SCALE);
    }
  }, [frame, caret]);

  const at = useCallback((event: { clientX: number; clientY: number }): { x: number; y: number } | null => {
    const canvas = canvasRef.current;
    if (canvas === null) return null;
    const box = canvas.getBoundingClientRect();
    const x = Math.floor(((event.clientX - box.left) / box.width) * FRAME_WIDTH);
    const y = Math.floor(((event.clientY - box.top) / box.height) * FRAME_HEIGHT);
    if (x < 0 || y < 0 || x >= FRAME_WIDTH || y >= FRAME_HEIGHT) return null;
    return { x, y };
  }, []);

  const onKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLCanvasElement>): void => {
      const here = caret ?? { x: 0, y: 0 };
      const step = event.altKey ? 8 : 1;
      let next: { x: number; y: number } | null = null;
      if (event.key === 'ArrowLeft') next = { x: clamp(here.x - step, FRAME_WIDTH - 1), y: here.y };
      else if (event.key === 'ArrowRight') next = { x: clamp(here.x + step, FRAME_WIDTH - 1), y: here.y };
      else if (event.key === 'ArrowUp') next = { x: here.x, y: clamp(here.y - step, FRAME_HEIGHT - 1) };
      else if (event.key === 'ArrowDown') next = { x: here.x, y: clamp(here.y + step, FRAME_HEIGHT - 1) };
      else if (event.key === 'Home') next = { x: 0, y: here.y };
      else if (event.key === 'End') next = { x: FRAME_WIDTH - 1, y: here.y };
      else if (event.key === ' ' || event.key === 'Enter') {
        event.preventDefault();
        setCaret(here);
        onPaint(here.x, here.y, !getPixel(frame, here.x, here.y));
        return;
      } else return;

      event.preventDefault();
      setCaret(next);
      // Shift-and-move is the drag, without the drag: it paints the cells it
      // crosses with the same value the last toggle set.
      if (event.shiftKey) onPaint(next.x, next.y, !getPixel(frame, next.x, next.y));
    },
    [caret, frame, onPaint],
  );

  const byteOf = (x: number, y: number): string =>
    `byte ${String(x + (y >> 3) * FRAME_WIDTH)} (page ${String(y >> 3)}), bit ${String(y & 7)} from LSB`;

  return (
    <div className="editor editor-pixel" data-testid="pixel-editor">
      {/*
        The slot is the declared two-dimensional surface, because it is the box
        that scrolls: an editor holds 4x and pans rather than shrinking below
        it (see EDITOR_MIN_ZOOM), and at a 405 px column 4x is 512 px wide.
      */}
      <div className="pixel-slot" ref={slot.ref} data-testid="pixel-slot" data-2d-surface="pixels">
        <canvas
          ref={canvasRef}
          width={FRAME_WIDTH * SCALE}
          height={FRAME_HEIGHT * SCALE}
          className="pixel-canvas"
          data-testid="pixel-canvas"
          data-2d-surface="pixels"
          data-oled-zoom={zoom}
          style={{ width: `${String(FRAME_WIDTH * zoom)}px`, height: `${String(FRAME_HEIGHT * zoom)}px` }}
          tabIndex={0}
          role="application"
          aria-label={`128 by 64 pixel editor. Arrow keys move the cursor, Space toggles the pixel under it, Shift and an arrow paints. Alt and an arrow moves eight pixels.`}
          onKeyDown={onKeyDown}
          onFocus={() => setCaret((c) => c ?? { x: 0, y: 0 })}
          onPointerDown={(e) => {
            const point = at(e);
            if (point === null) return;
            const on = !getPixel(frame, point.x, point.y);
            painting.current = on;
            setCaret(point);
            onPaint(point.x, point.y, on);
          }}
          onPointerMove={(e) => {
            if (painting.current === null) return;
            const point = at(e);
            if (point === null) return;
            setCaret(point);
            onPaint(point.x, point.y, painting.current);
          }}
          onPointerUp={() => {
            painting.current = null;
          }}
          onPointerLeave={() => {
            painting.current = null;
          }}
        />
      </div>
      {/*
        The caret's position, as text. A keyboard alternative whose only feedback
        is a two-pixel outline on a canvas is not one, and this is also where the
        GDDRAM arithmetic becomes readable at a zoom where hovering is possible.
      */}
      <p className="pixel-caret" data-testid="pixel-caret" aria-live="polite">
        {caret === null ? (
          <span className="muted small">
            Click a pixel, or focus the grid and use the arrow keys.
          </span>
        ) : (
          <span className="mono small">
            ({caret.x}, {caret.y}) → {byteOf(caret.x, caret.y)} ={' '}
            <b>{getPixel(frame, caret.x, caret.y) ? '1 · lit' : '0 · dark'}</b>
          </span>
        )}
      </p>
      <div className="editor-row">
        <button type="button" className="lesson-button" data-testid="pixel-clear" onClick={onClear}>
          clear
        </button>
        <button type="button" className="lesson-button is-primary" data-testid="pixel-push" onClick={onPush}>
          push to the panel
        </button>
        <span className="muted small" data-testid="pixel-count">
          {changed} pixels lit
          {densest === null
            ? ''
            : ` · densest ${String(densest.width)}×${String(densest.height)} holds ${String(densest.count)}`}
        </span>
      </div>
      <p className="note muted small">
        128&times;64, one bit per pixel, MSB first &mdash; the byte layout{' '}
        <code>firmware/face-bitmaps.h</code> uses. &ldquo;Push&rdquo; runs it through the same
        <code> drawBitmap() </code>path a real face takes. The grid is drawn at a whole number of
        screen pixels per bitmap pixel, never a fraction &mdash; currently <b>{zoom}&times;</b>.
      </p>
    </div>
  );
}
