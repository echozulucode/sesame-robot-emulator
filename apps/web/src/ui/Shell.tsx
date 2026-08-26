/**
 * The three-zone shell: a 56 px rail, a stage, and a collapsible right dock.
 *
 * Everything here is layout. Not one pane's *content* is touched: the
 * architecture graph, the trace, the source explorer, Learn and Lab are handed
 * in as children and render exactly what they rendered when they were grid
 * rows. Provenance, `isPhysicallyObserved()`, the `conceptual` badges, the NOT
 * BUILT panels and the modifying-this-robot banner are correctness surfaces and
 * none of them is styling.
 *
 * The rail never collapses. That is not decoration: the provenance chip lives
 * on it, and the product's central honesty claim is that a reader can always
 * tell at a glance whether what they are looking at was measured, simulated or
 * inferred. A zone that can be closed is a zone that can hide that.
 *
 * ## Sections stay MOUNTED when they collapse
 *
 * Collapsing is `hidden` on the body, never an unmount, and that is load
 * bearing in four separate places:
 *
 *  - L4's refusal check asserts **zero `.src-line` nodes** when the bundled
 *    source fails its hash. An unmounted pane also has zero, so unmounting
 *    would make the sharpest assertion in the harness pass vacuously.
 *  - L6's checks re-evaluate every 250 ms against live state, and several of
 *    them (`face-mode-identified`) can only be answered from a sample taken
 *    WHILE a movement runs. An unmounted runner stops sampling and the check
 *    becomes unmeasurable rather than failing loudly.
 *  - L4 asserts exactly one `concept-text` element exists. Two responsive
 *    copies of a pane would be two.
 *  - V8's `visual.joint` rung is read off `Object3D.quaternion` — what was
 *    actually drawn. The stage is therefore never unmounted either.
 *
 * L7's opposite requirement is preserved by not touching it: the Lab pane's own
 * closed-strip state, where it does not subscribe to `LessonRuntime` at all,
 * still belongs to `LabMode` and is unchanged by whether its dock section is
 * expanded.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement, type ReactNode } from 'react';

import type { BackendId, BackendStatus } from '../backends/types.js';
import type { Provenance, TelemetryOrigin } from '@sesame-lab/sesame-protocol';
import { OriginTag, ProvenanceTag } from './ProvenanceTag.js';
import {
  breakpointForWidth,
  clampDockWidth,
  DEFAULT_SHELL,
  isSingleOpen,
  loadShell,
  saveShell,
  SECTION_IDS,
  sectionIsOpen,
  withDockOpen,
  withDockWidth,
  withSection,
  type Breakpoint,
  type SectionId,
  type ShellState,
} from './shell-state.js';

export interface ShellController {
  readonly breakpoint: Breakpoint;
  readonly state: ShellState;
  readonly dockVisible: boolean;
  /** True when the dock floats above the stage instead of taking width from it. */
  readonly dockOverlays: boolean;
  isOpen(id: SectionId): boolean;
  setSection(id: SectionId, open: boolean): void;
  toggleSection(id: SectionId): void;
  setDockOpen(open: boolean): void;
  setDockWidth(px: number): void;
  /**
   * Put a section where it can be seen — §5.2.
   *
   * Opens the dock if it is shut and expands the section, which below Wide
   * closes whatever else was open. Called from the selection path, and only
   * for selections that originated in the 3D scene: a click inside a pane
   * that is already on screen needs no help, and hijacking the dock while a
   * learner is mid-lesson would be worse than the problem it solves.
   */
  reveal(id: SectionId): void;
}

/**
 * Breakpoint, open sections and dock width, restored from `localStorage`.
 *
 * The width is read once on mount and then from `resize`. `matchMedia` would do
 * as well; `innerWidth` is used because the same number is what the harness
 * measures the stage against, and comparing a layout decision to a different
 * measurement of the same window is how off-by-a-scrollbar bugs start.
 */
export function useShell(): ShellController {
  const [state, setState] = useState<ShellState>(DEFAULT_SHELL);
  const [breakpoint, setBreakpoint] = useState<Breakpoint>('wide');

  // Storage is read in an effect rather than in `useState`'s initialiser so a
  // blocked-storage browser renders the defaults on the first paint instead of
  // throwing during render.
  useEffect(() => {
    setState(loadShell());
  }, []);

  useEffect(() => {
    const measure = (): void => {
      setBreakpoint(breakpointForWidth(globalThis.innerWidth ?? 1600));
    };
    measure();
    globalThis.addEventListener('resize', measure);
    return () => globalThis.removeEventListener('resize', measure);
  }, []);

  const update = useCallback((next: (previous: ShellState) => ShellState) => {
    setState((previous) => {
      const value = next(previous);
      if (value !== previous) saveShell(value);
      return value;
    });
  }, []);

  const setSection = useCallback(
    (id: SectionId, open: boolean) => update((previous) => withSection(previous, breakpoint, id, open)),
    [breakpoint, update],
  );

  const toggleSection = useCallback(
    (id: SectionId) =>
      update((previous) => withSection(previous, breakpoint, id, !sectionIsOpen(previous, breakpoint, id))),
    [breakpoint, update],
  );

  const setDockOpen = useCallback(
    (open: boolean) => update((previous) => withDockOpen(previous, breakpoint, open)),
    [breakpoint, update],
  );

  const setDockWidth = useCallback((px: number) => update((previous) => withDockWidth(previous, px)), [update]);

  const reveal = useCallback(
    (id: SectionId) =>
      update((previous) => withSection(withDockOpen(previous, breakpoint, true), breakpoint, id, true)),
    [breakpoint, update],
  );

  const dockVisible = state.dockOpen[breakpoint];
  return useMemo(
    () => ({
      breakpoint,
      state,
      dockVisible,
      dockOverlays: breakpoint !== 'wide',
      isOpen: (id: SectionId) => sectionIsOpen(state, breakpoint, id),
      setSection,
      toggleSection,
      setDockOpen,
      setDockWidth,
      reveal,
    }),
    [breakpoint, state, dockVisible, setSection, toggleSection, setDockOpen, setDockWidth, reveal],
  );
}

// ---------------------------------------------------------------- left rail

export interface RailProps {
  readonly shell: ShellController;
  readonly backendId: BackendId;
  readonly onBackendChange: (id: BackendId) => void;
  readonly status: BackendStatus;
  readonly drivingProvenance: Provenance | null;
  readonly drivingOrigin: TelemetryOrigin | null;
  readonly totalEvents: number;
}

const BACKEND_RAIL: readonly { id: BackendId; short: string; title: string }[] = [
  { id: 'sim', short: 'SIM', title: 'Simulated model — a host model, in this tab' },
  { id: 'bridge', short: 'BRG', title: 'Bridge WebSocket — receive-only' },
  { id: 'qemu', short: 'QEM', title: 'QEMU firmware — real firmware, commandable' },
];

/**
 * 56 px, always visible, never collapses.
 *
 * Mode, backend, connection and provenance. The provenance chip here is a
 * SUMMARY of the banner in the inspector, not a second opinion: both read
 * `store.drivingProvenance` and `store.drivingOrigin`, so they cannot disagree.
 * The banner keeps its own prose and its own ids — this is a colour and a word.
 */
export function Rail(props: RailProps): ReactElement {
  const { shell, backendId, onBackendChange, status, drivingProvenance, drivingOrigin, totalEvents } = props;
  return (
    <nav className="rail" data-testid="rail" aria-label="mode, backend and provenance">
      <div className="rail-group">
        <button
          type="button"
          className={`rail-btn${shell.isOpen('learn') && shell.dockVisible ? ' active' : ''}`}
          data-rail-mode="learn"
          title="Learn — guided lessons against the live robot"
          onClick={() => shell.reveal('learn')}
        >
          <span className="rail-glyph" aria-hidden="true">
            ◪
          </span>
          <span className="rail-label">Learn</span>
        </button>
        <button
          type="button"
          className={`rail-btn${shell.isOpen('lab') && shell.dockVisible ? ' active' : ''}`}
          data-rail-mode="lab"
          title="Lab — the unrestricted surface"
          onClick={() => shell.reveal('lab')}
        >
          <span className="rail-glyph" aria-hidden="true">
            ⚙
          </span>
          <span className="rail-label">Lab</span>
        </button>
      </div>

      <div className="rail-group" role="radiogroup" aria-label="telemetry backend">
        {BACKEND_RAIL.map((choice) => (
          <button
            key={choice.id}
            type="button"
            role="radio"
            aria-checked={backendId === choice.id}
            className={`rail-btn rail-backend${backendId === choice.id ? ' active' : ''}`}
            data-rail-backend={choice.id}
            title={choice.title}
            onClick={() => onBackendChange(choice.id)}
          >
            {choice.short}
          </button>
        ))}
      </div>

      <div className="rail-spacer" />

      {/*
        The two honesty badges, in the one zone that cannot be closed. The
        plan's words: the provenance badge must never be more than a glance
        away, and that is a product requirement rather than decoration.
      */}
      <div className="rail-status" data-testid="rail-status">
        <span
          className={`rail-conn conn-${status.connection}`}
          data-testid="rail-conn"
          data-connection={status.connection}
          title={`${status.connection} — ${status.detail}`}
        >
          ●
        </span>
        <div className="rail-prov" data-testid="rail-provenance" data-provenance={drivingProvenance ?? 'none'}>
          {drivingProvenance === null ? (
            <span className="prov prov-none">none</span>
          ) : (
            <ProvenanceTag value={drivingProvenance} />
          )}
          <OriginTag origin={drivingOrigin} />
          <span className="dim rail-events">{totalEvents}</span>
        </div>
      </div>
    </nav>
  );
}

// -------------------------------------------------------------- right dock

export interface DockSectionSpec {
  readonly id: SectionId;
  readonly label: string;
  readonly glyph: string;
  /**
   * What the header says while the section is collapsed — §5.1.
   *
   * `null` means nothing worth summarising. A non-null value is rendered as
   * `Modules ● R4`, so a selection that landed in a closed section is still
   * visible, just summarised, instead of happening where nobody can see it.
   */
  readonly badge: string | null;
  /** True when the badge is about the CURRENT selection rather than a count. */
  readonly badgeIsSelection: boolean;
  readonly body: ReactNode;
}

export interface DockProps {
  readonly shell: ShellController;
  readonly sections: readonly DockSectionSpec[];
}

/**
 * The dock, its icon strip, its accordion and its drag handle.
 *
 * At Wide it is in flow and takes width from the stage. At Medium and Compact
 * it is `position: absolute` (see `styles.css`) so it floats over the stage and
 * the stage's measured width does not change when it opens — the rule that
 * fixes the laptop, and the one the harness asserts by measuring the stage
 * before and after.
 */
export function Dock(props: DockProps): ReactElement {
  const { shell, sections } = props;
  const dockRef = useRef<HTMLElement | null>(null);
  const drag = useRef<{ startX: number; startWidth: number } | null>(null);

  const onResizeDown = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      drag.current = { startX: event.clientX, startWidth: shell.state.dockWidthPx };
      event.currentTarget.setPointerCapture(event.pointerId);
    },
    [shell.state.dockWidthPx],
  );

  const onResizeMove = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      const start = drag.current;
      if (start === null) return;
      // The handle is on the dock's LEFT edge, so dragging left widens it.
      shell.setDockWidth(clampDockWidth(start.startWidth + (start.startX - event.clientX)));
    },
    [shell],
  );

  const onResizeUp = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    drag.current = null;
    event.currentTarget.releasePointerCapture(event.pointerId);
  }, []);

  const anyOpen = sections.some((s) => shell.isOpen(s.id));

  return (
    <>
      {/*
        The scrim. Only below Wide, where the dock floats: it is what closes an
        overlay by clicking beside it, and it is deliberately NOT rendered at
        Wide, where the dock is in flow and the stage is still interactive.
      */}
      {shell.dockOverlays && shell.dockVisible && (
        <button
          type="button"
          className="dock-scrim"
          data-testid="dock-scrim"
          aria-label="close the dock"
          onClick={() => shell.setDockOpen(false)}
        />
      )}

      <aside
        className="dock"
        ref={dockRef}
        data-testid="dock"
        data-open={String(shell.dockVisible)}
        data-overlay={String(shell.dockOverlays)}
        data-breakpoint={shell.breakpoint}
        style={{ ['--dock-w' as string]: `${String(shell.state.dockWidthPx)}px` }}
      >
        {/*
          The 44 px icon strip. At Medium this is all the dock shows until it is
          opened, which is how every pane stays REACHABLE at every breakpoint
          without any of them costing the stage a pixel.
        */}
        <div className="dock-strip" data-testid="dock-strip">
          <button
            type="button"
            className="dock-strip-btn dock-toggle"
            data-testid="dock-toggle"
            aria-expanded={shell.dockVisible}
            title={shell.dockVisible ? 'close the dock' : 'open the dock'}
            onClick={() => shell.setDockOpen(!shell.dockVisible)}
          >
            {shell.dockVisible ? '›' : '‹'}
          </button>
          {sections.map((section) => (
            <button
              key={section.id}
              type="button"
              className={`dock-strip-btn${shell.isOpen(section.id) && shell.dockVisible ? ' active' : ''}${
                section.badgeIsSelection ? ' has-selection' : ''
              }`}
              data-dock-strip={section.id}
              title={section.badge === null ? section.label : `${section.label} — ${section.badge}`}
              onClick={() => shell.reveal(section.id)}
            >
              <span aria-hidden="true">{section.glyph}</span>
              {section.badgeIsSelection && <i className="dock-strip-dot" aria-hidden="true" />}
            </button>
          ))}
        </div>

        <div className="dock-body" data-testid="dock-body" data-any-open={String(anyOpen)}>
          {sections.map((section) => {
            const open = shell.isOpen(section.id);
            return (
              <section
                key={section.id}
                className={`dock-section${open ? ' is-open' : ''}`}
                data-dock-section={section.id}
                data-open={String(open)}
              >
                <h2 className="dock-section-header">
                  <button
                    type="button"
                    className="dock-section-toggle"
                    data-dock-toggle={section.id}
                    aria-expanded={open}
                    onClick={() => shell.toggleSection(section.id)}
                  >
                    <span className="dock-caret" aria-hidden="true">
                      {open ? '▾' : '▸'}
                    </span>
                    <span className="dock-section-label">{section.label}</span>
                    {/*
                      §5.1. Shown only while the section is collapsed: an open
                      section shows the real thing, and a badge beside it would
                      be a second, staler statement of the same fact.
                    */}
                    {!open && section.badge !== null && (
                      <span
                        className={`dock-badge${section.badgeIsSelection ? ' is-selection' : ''}`}
                        data-dock-badge={section.id}
                        data-selection={String(section.badgeIsSelection)}
                      >
                        {section.badgeIsSelection && <i className="dock-badge-dot" aria-hidden="true" />}
                        {section.badge}
                      </span>
                    )}
                  </button>
                </h2>
                {/*
                  `hidden` rather than an unmount. See the module comment: four
                  separate harness invariants depend on these panes staying
                  mounted and live while they are shut.
                */}
                <div className="dock-section-body" hidden={!open}>
                  {section.body}
                </div>
              </section>
            );
          })}
        </div>

        {!shell.dockOverlays && shell.dockVisible && (
          <div
            className="dock-resizer"
            data-testid="dock-resizer"
            role="separator"
            aria-orientation="vertical"
            onPointerDown={onResizeDown}
            onPointerMove={onResizeMove}
            onPointerUp={onResizeUp}
            onDoubleClick={() => shell.setDockWidth(DEFAULT_DOCK_WIDTH)}
            title="drag to resize · double-click to reset"
          />
        )}
      </aside>
    </>
  );
}

const DEFAULT_DOCK_WIDTH = 460;

/** Every section id, in draw order. Re-exported so `App` need not import both. */
export { SECTION_IDS, isSingleOpen };
export type { SectionId, Breakpoint };
