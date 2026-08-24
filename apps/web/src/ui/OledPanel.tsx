/**
 * V4 — the virtual OLED.
 *
 * 128x64 logical pixels, drawn at 8x into a 1024x512 canvas so that logical
 * coordinates stay exact and every individual pixel is separately visible and
 * hoverable. Hovering reports the pixel's byte index and bit position in the
 * SSD1306 page-ordered buffer, because that layout is the thing worth teaching
 * and a picture of a face does not teach it.
 *
 * The same framebuffer is blitted 1:1 into a second 128x64 canvas, which is the
 * `CanvasTexture` mapped onto the `oled_screen` quad in 3D.
 */
import { OLED_HEIGHT, OLED_WIDTH } from '@sesame-lab/sesame-protocol';
import { useEffect, useRef, useState, type ReactElement } from 'react';

import type { EmptyFaceEvent, FaceView, OledSource } from '../state/telemetry-store.js';
import { FACE_PIXEL_SOURCE, type VirtualOledPanel } from '../oled/framebuffer.js';
import { OriginTag, ProvenanceTag } from './ProvenanceTag.js';

/** Logical pixel -> screen pixel. 8 keeps 1024x512, which is still a sane texture. */
export const OLED_SCALE = 8;

const LIT = '#c8f0ff';
const DARK = '#0a0d11';
const GRID = '#141a21';

export interface OledPanelProps {
  readonly panel: VirtualOledPanel;
  /** The 128x64 canvas that backs the 3D texture. Drawn in lockstep. */
  readonly textureCanvas: HTMLCanvasElement;
  readonly face: FaceView | null;
  readonly source: OledSource;
  readonly emptyFace: EmptyFaceEvent | null;
  /** Bumped whenever the panel contents may have changed. */
  readonly version: number;
  readonly onRedraw: () => void;
  /**
   * Set when the backend's origin lists the panel among the subsystems it does
   * not model — `ssd1306-panel` is in QEMU's `elided` list, and
   * `oledFramebuffer` is `false`.
   *
   * This is the one place in the app where a truthful UI could quietly become a
   * lying one. The firmware under QEMU really does emit `face.expression`
   * events, so there is a face name to draw and the bitmaps to draw it with —
   * and drawing it is *useful*, because the 3D robot needs a screen. What must
   * not happen is those host-rendered pixels being presented as though the
   * emulator produced them. They are already tagged `inferred` by the store;
   * this flag is what lets the panel say the harder part out loud: no pixels
   * crossed any boundary, because there is no panel on the far side.
   */
  readonly panelElided: boolean;
}

export function OledPanel(props: OledPanelProps): ReactElement {
  const { panel, textureCanvas, face, source, emptyFace, version, onRedraw, panelElided } = props;
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [hover, setHover] = useState<{ x: number; y: number; on: boolean } | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (canvas === null) return;
    const ctx = canvas.getContext('2d');
    const texCtx = textureCanvas.getContext('2d');
    if (ctx === null || texCtx === null) return;

    const buffer = panel.gddram;

    ctx.fillStyle = DARK;
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    // 1:1 for the texture, so a texel is a pixel and NearestFilter has exact
    // pixel edges to sample.
    const image = texCtx.createImageData(OLED_WIDTH, OLED_HEIGHT);

    ctx.fillStyle = LIT;
    for (let y = 0; y < OLED_HEIGHT; y++) {
      for (let x = 0; x < OLED_WIDTH; x++) {
        // index = x + (y >> 3) * 128, bit y & 7 from the LSB.
        // Written out rather than called, once, because this is the one place
        // in the app where the encoding is the subject.
        const lit = (((buffer[x + (y >> 3) * OLED_WIDTH] ?? 0) >> (y & 7)) & 1) === 1;
        const p = (y * OLED_WIDTH + x) * 4;
        if (lit) {
          ctx.fillRect(x * OLED_SCALE, y * OLED_SCALE, OLED_SCALE, OLED_SCALE);
          image.data[p] = 0xc8;
          image.data[p + 1] = 0xf0;
          image.data[p + 2] = 0xff;
        } else {
          image.data[p] = 0x06;
          image.data[p + 1] = 0x09;
          image.data[p + 2] = 0x0c;
        }
        image.data[p + 3] = 0xff;
      }
    }
    texCtx.putImageData(image, 0, 0);

    // A faint page grid: the eight 8-row bands are the SSD1306's pages, and
    // seeing them makes `index = x + (y >> 3) * 128` legible.
    ctx.strokeStyle = GRID;
    ctx.lineWidth = 1;
    for (let page = 1; page < 8; page++) {
      const y = page * 8 * OLED_SCALE + 0.5;
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(canvas.width, y);
      ctx.stroke();
    }

    onRedraw();
  }, [panel, textureCanvas, version, onRedraw]);

  const onMove = (event: React.MouseEvent<HTMLCanvasElement>): void => {
    const canvas = canvasRef.current;
    if (canvas === null) return;
    const rect = canvas.getBoundingClientRect();
    const x = Math.floor(((event.clientX - rect.left) / rect.width) * OLED_WIDTH);
    const y = Math.floor(((event.clientY - rect.top) / rect.height) * OLED_HEIGHT);
    if (x < 0 || x >= OLED_WIDTH || y < 0 || y >= OLED_HEIGHT) {
      setHover(null);
      return;
    }
    setHover({ x, y, on: panel.pixel(x, y) === 1 });
  };

  const litPixels = panel.litPixels;

  return (
    <section className="panel" data-testid="oled">
      <header className="panel-header">
        <h2>Virtual OLED</h2>
        <span className="panel-sub">SSD1306 128×64 @ I²C 0x3C</span>
      </header>

      <canvas
        ref={canvasRef}
        width={OLED_WIDTH * OLED_SCALE}
        height={OLED_HEIGHT * OLED_SCALE}
        className="oled-canvas"
        id="oled-canvas"
        onMouseMove={onMove}
        onMouseLeave={() => setHover(null)}
      />

      <div className="oled-readout">
        {hover === null ? (
          <span className="muted">hover a pixel to see where it lives in GDDRAM</span>
        ) : (
          <span>
            ({hover.x}, {hover.y}) → byte {hover.x + (hover.y >> 3) * OLED_WIDTH} (page {hover.y >> 3}), bit{' '}
            {hover.y & 7} from LSB = <b>{hover.on ? '1 · lit' : '0 · dark'}</b>
          </span>
        )}
      </div>

      <dl className="kv">
        <dt>face</dt>
        <dd>
          {face === null ? (
            <span className="muted">none yet</span>
          ) : (
            <>
              <code>{face.name}</code> frame {face.frame} <ProvenanceTag value={face.provenance} />{' '}
              <OriginTag origin={face.origin} />
            </>
          )}
        </dd>

        <dt>pixels</dt>
        <dd>
          {source.pixelProvenance === null ? (
            <span className="muted">none drawn</span>
          ) : (
            <ProvenanceTag value={source.pixelProvenance} />
          )}{' '}
          {litPixels} lit · {panel.writes} display() writes
        </dd>

        <dt>payload</dt>
        <dd>
          <code className="wrap">{panel.base64.slice(0, 44)}…</code>
          <span className="muted"> 1368 chars, 1024 bytes, page-ordered</span>
        </dd>
      </dl>

      <p className="note">{source.detail}</p>

      {panelElided && (
        <div className="warn" data-testid="oled-elided">
          <strong>These pixels did not come from the emulator.</strong>
          <p>
            The backend’s origin lists <code>ssd1306-panel</code> among the subsystems it does not
            model, and its <code>oledFramebuffer</code> capability is <code>false</code>: QEMU
            attaches no SSD1306 to this machine, so <code>display.display()</code> inside the guest
            writes to nothing observable. What the firmware <em>does</em> emit is the face{' '}
            <em>name</em>, and that really did cross the UART.
          </p>
          <p className="muted">
            So the image above is drawn here, on the host, from{' '}
            <code>firmware/face-bitmaps.h</code> — the same arrays the firmware would have used. It
            is shown because the 3D robot needs a screen, and it is labelled{' '}
            <code>inferred</code> because nothing transmitted it. It is not a capture of the
            emulator’s framebuffer, and there is no framebuffer to capture.
          </p>
        </div>
      )}

      {emptyFace !== null && (
        <div className="warn" data-testid="empty-face-warning">
          <strong>Nothing was drawn — this is the upstream bug, not a rendering failure.</strong>
          <p>{emptyFace.reason}</p>
          <p className="muted">
            {litPixels === 0 ? (
              <>
                The panel above is <b>genuinely blank</b>: nothing has ever called{' '}
                <code>display.display()</code>, so GDDRAM is still zeroed. That is what the glass would
                show. No placeholder face has been substituted.
              </>
            ) : (
              <>
                The panel above is still showing the <b>previous</b> frame, exactly as the glass would: with
                no call to <code>display.display()</code> the GDDRAM is untouched, so the last face stays
                lit. Reset the panel and try again to see the power-on case. No placeholder face has been
                substituted.
              </>
            )}
          </p>
        </div>
      )}

      <p className="note muted">
        Pixels come from <code>{FACE_PIXEL_SOURCE.file}</code> (sha256 {FACE_PIXEL_SOURCE.sha256.slice(0, 12)}…),
        stored in the firmware's authored row-major layout and converted here by emulating{' '}
        <code>Adafruit_GFX::drawBitmap</code> into the page-ordered buffer the protocol carries.
      </p>
    </section>
  );
}
