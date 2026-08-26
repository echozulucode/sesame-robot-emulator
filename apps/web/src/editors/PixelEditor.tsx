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
 */
import { useCallback, useEffect, useRef, type ReactElement } from 'react';

import { FRAME_HEIGHT, FRAME_WIDTH, getPixel } from './pixel-frame.js';

const SCALE = 4;

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

export function PixelEditor(props: PixelEditorProps): ReactElement {
  const { frame, onPaint, onClear, onPush, changed, densest } = props;
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const painting = useRef<boolean | null>(null);

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
  }, [frame]);

  const at = useCallback((event: { clientX: number; clientY: number }): { x: number; y: number } | null => {
    const canvas = canvasRef.current;
    if (canvas === null) return null;
    const box = canvas.getBoundingClientRect();
    const x = Math.floor(((event.clientX - box.left) / box.width) * FRAME_WIDTH);
    const y = Math.floor(((event.clientY - box.top) / box.height) * FRAME_HEIGHT);
    if (x < 0 || y < 0 || x >= FRAME_WIDTH || y >= FRAME_HEIGHT) return null;
    return { x, y };
  }, []);

  return (
    <div className="editor editor-pixel" data-testid="pixel-editor">
      <canvas
        ref={canvasRef}
        width={FRAME_WIDTH * SCALE}
        height={FRAME_HEIGHT * SCALE}
        className="pixel-canvas"
        data-testid="pixel-canvas"
        onPointerDown={(e) => {
          const point = at(e);
          if (point === null) return;
          const on = !getPixel(frame, point.x, point.y);
          painting.current = on;
          onPaint(point.x, point.y, on);
        }}
        onPointerMove={(e) => {
          if (painting.current === null) return;
          const point = at(e);
          if (point === null) return;
          onPaint(point.x, point.y, painting.current);
        }}
        onPointerUp={() => {
          painting.current = null;
        }}
        onPointerLeave={() => {
          painting.current = null;
        }}
      />
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
        <code> drawBitmap() </code>path a real face takes.
      </p>
    </div>
  );
}
