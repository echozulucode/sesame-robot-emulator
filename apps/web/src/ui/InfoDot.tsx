/**
 * The info affordance — Phase 4 W8.
 *
 * > *"how do we fix this and also just show an info icon to click on and / or
 * > mouse over to see the info."*
 *
 * A 20 px `ⓘ` that answers **both** verbs and adds no dependency:
 *
 * | gesture | what happens | who implements it |
 * |---|---|---|
 * | hover | a one-line tip appears beside the icon | this component |
 * | keyboard focus | the same tip, on `focus-visible` terms | this component |
 * | click / `Enter` | the full screen opens | W7's `<dialog>`, via `onOpen` |
 *
 * ## Why the tip is a portal and the screen is not here at all
 *
 * The side panel is `overflow: hidden` — §11.4 forbids it a scrollbar, and W7
 * made that literal — and every pane is `container-type: inline-size`, which
 * is `contain: layout`, which makes the pane a containing block for its own
 * fixed-position descendants. So a tip positioned `fixed` from inside a panel
 * card is both contained AND clipped, and it would be invisible in exactly the
 * place this icon is most needed. `createPortal` into `document.body` sidesteps
 * both, using `react-dom`, which has been a dependency since V3.
 *
 * The SCREEN is deliberately not rendered here. W7 renders its four `<dialog>`s
 * as siblings of the shell's columns rather than inside the panel, for a reason
 * that is about assertions rather than aesthetics: it keeps the panel's
 * scroller inventory a statement about the panel. This component therefore
 * raises `onOpen` and the app owns the dialog, on the same terms as the
 * `More` buttons beside it.
 *
 * ## What may go behind it
 *
 * A paragraph. Never a badge, never a verdict, never a count. §11.4:
 * *"correctness surfaces may not be demoted into a popover — a popover may
 * EXPAND them; it may not be where they first appear."* The pixel-provenance
 * badge stays on the Face card's header summary and the icon sits beside it;
 * what moved is the two paragraphs that explain the badge.
 */
import { useCallback, useEffect, useRef, useState, type ReactElement } from 'react';
import { createPortal } from 'react-dom';

export interface InfoDotProps {
  /** Published as `data-info`, and the tip as `data-info-tip`. */
  readonly id: string;
  /** The accessible name of the button. A question, not "info". */
  readonly label: string;
  /** The one line the tip shows. The paragraph belongs in the screen. */
  readonly tip: string;
  /** Open the full screen. The app owns the `<dialog>` — see the header. */
  readonly onOpen: () => void;
}

/** Where the tip sits, in viewport coordinates. */
interface TipAt {
  readonly left: number;
  readonly top: number;
}

export function InfoDot(props: InfoDotProps): ReactElement {
  const { id, label, tip, onOpen } = props;
  const buttonRef = useRef<HTMLButtonElement>(null);
  const [at, setAt] = useState<TipAt | null>(null);

  const show = useCallback(() => {
    const button = buttonRef.current;
    if (button === null) return;
    const box = button.getBoundingClientRect();
    // Below the icon, and nudged left when that would run off the right edge —
    // the icon lives in a 280 px panel pinned to the right of the window, so
    // "below and left-aligned" is off screen more often than not.
    const width = Math.min(320, Math.max(220, globalThis.innerWidth - 24));
    const left = Math.max(8, Math.min(box.left, globalThis.innerWidth - width - 8));
    const top = box.bottom + 6;
    // Only when it actually moved: this runs on every scroll event in the
    // document (see below) and a fresh object per event is a re-render per
    // event, in a tab that also holds a WebGL render loop.
    setAt((previous) =>
      previous !== null && Math.abs(previous.left - left) < 0.5 && Math.abs(previous.top - top) < 0.5
        ? previous
        : { left, top },
    );
  }, []);

  const hide = useCallback(() => setAt(null), []);

  /*
   * A tip anchored to a box that moved is a tip pointing at nothing.
   *
   * It REPOSITIONS rather than hiding, and that is a correction rather than a
   * preference: the first version hid on any scroll, captured document-wide,
   * and the Source pane scrolls its own code view whenever a symbol is selected
   * — so the tip vanished the moment it appeared in exactly the arrangement it
   * was added for. Measured: focus the icon with the Source module up and the
   * tip is gone within 400 ms; with Learn up it stays.
   */
  useEffect(() => {
    if (at === null) return;
    globalThis.addEventListener('scroll', show, true);
    globalThis.addEventListener('resize', show);
    return () => {
      globalThis.removeEventListener('scroll', show, true);
      globalThis.removeEventListener('resize', show);
    };
  }, [at, show]);

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        className="info-dot"
        data-info={id}
        aria-label={label}
        /*
          `title` as well as the tip, and not instead of it. The tip is what the
          user asked for and is styled to match; `title` is what a browser's own
          accessibility surfaces and a long-press on a touch device fall back
          to, and it costs nothing to have both say the same sentence.
        */
        title={tip}
        onClick={onOpen}
        onPointerEnter={show}
        onPointerLeave={hide}
        onFocus={show}
        onBlur={hide}
      >
        <span aria-hidden="true">i</span>
      </button>
      {at !== null &&
        typeof document !== 'undefined' &&
        createPortal(
          <div
            className="info-tip"
            data-info-tip={id}
            role="tooltip"
            style={{ left: `${String(at.left)}px`, top: `${String(at.top)}px` }}
          >
            {tip}
          </div>,
          document.body,
        )}
    </>
  );
}
