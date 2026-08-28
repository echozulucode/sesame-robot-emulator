/**
 * The shell: a 64 px rail, a stage, ONE workbench below 1700 px or TWO docks
 * above it, and a status strip across the bottom.
 *
 * Everything here is layout. Not one pane's *content* is touched: the
 * architecture graph, the trace, the source explorer, Learn and Lab are handed
 * in as children and render exactly what they rendered when they were grid
 * rows. Provenance, `isPhysicallyObserved()`, the `conceptual` badges, the NOT
 * BUILT panels and the modifying-this-robot banner are correctness surfaces and
 * none of them is styling.
 *
 * ```text
 * 1200-1699 px — ONE workbench, IN FLOW           >= 1700 px — U6's two docks
 * +--+--------------------+---------------+       +--+--------+-------+-------+
 * |R |                    | Control|Analyze|      |R |        |CONTROL|ANALYSIS|
 * |A |    CENTER STAGE    |Inspector Signal|      |A | STAGE  |v Cmds |v Inspec|
 * |I |  3D robot, >= 50%  |----------------|      |I |        |> Face |> Module|
 * |L |  of the SCREEN AREA|                |      |L |        |> Lab  |> Signal|
 * |  |                    |   ONE PANE     |      |  |        |       |> Source|
 * +--+--------------------+---------------+       +--+--------+-------+-------+
 * | SYSTEM: ... · PHYSICAL HARDWARE: NONE |       | ... the same 32 px strip   |
 * +---------------------------------------+       +----------------------------+
 * ```
 *
 * ## Why one workbench — Phase 4 W3, §3 of the plan
 *
 * The brief recommended one workbench at 1440x900 and the user resolved it with
 * a sharper rule: *"I'd rather the robot area shrink. 50% of the screen area is
 * more than enough."* That rule makes the decision arithmetic. At 1440x900 with
 * a 64 px rail and a 32 px status strip, two 360 px docks leave the stage 43.9%
 * of the screen area and two 320 px docks leave 49.3%; one 540 px workbench
 * leaves 56.0%. Two docks are not available on a laptop at any usable width.
 *
 * Above 1700 px they are — two 360 px docks plus the rail still leave 1276 px
 * of stage — so U6's two-dock shell is not deleted. It is the wide-desktop
 * regime, and `Docks` chooses between the two.
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
 * expanded — or by which dock now draws it.
 *
 * ## The pane contract, and one scroller — Phase 4 W2
 *
 * A reader on a laptop reported "everything is too small and too many
 * scrollbars", and the dock nested three deep: `.dock-body`, then
 * `.dock-section-body`, then a pane's own `overflow-y: auto`. U6 fixed that
 * below Wide by hand, inside a media query, and W2 makes it structural:
 *
 *  - every section is a PANE — `<section class="pane" data-pane=ID
 *    aria-labelledby>` with `.pane__header` and `.pane__content` — and the pane
 *    carries `container: pane / inline-size`, so everything inside it responds
 *    to ITS width rather than the window's;
 *  - a pane owns at most ONE ordinary vertical scroller. Anything else that
 *    scrolls has to declare itself with `data-2d-surface`, and there are three:
 *    `code` (429 lines of C++, and the box L4's "selecting a joint scrolled the
 *    code to its first line" assertion is measured against), `graph` (React
 *    Flow's pan surface) and `pixels` (the 128x64 OLED);
 *  - `data-sections` on `.docks` says which of the two height regimes is in
 *    force — `one` pane owning the dock, or `many` sharing it. That is the same
 *    `isSingleOpen()` the accordion obeys, published to CSS so a pane rule can
 *    respond to the regime instead of to `@media (max-width: 1440px)`. W3
 *    changes what sets it; nothing that reads it has to change.
 *
 * `capture-web-screenshots.mjs` drives each pane to nine explicit container
 * widths in two different windows and requires the readings to be identical.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement, type ReactNode } from 'react';

import type { BackendId, BackendStatus } from '../backends/types.js';
import type { Provenance, TelemetryOrigin } from '@sesame-lab/sesame-protocol';
import { OriginTag, ProvenanceTag } from './ProvenanceTag.js';
import {
  breakpointForWidth,
  clampDockWidth,
  DEFAULT_SHELL,
  DOCK_DEFAULT_PX,
  DOCK_IDS,
  DOCK_SECTIONS,
  dockForSection,
  dockIsOpen,
  isSingleOpen,
  loadShell,
  MODE_LABEL,
  modeForState,
  saveShell,
  SECTION_IDS,
  sectionIsOpen,
  sectionIsVisible,
  withDockOpen,
  withDockWidth,
  withSection,
  usesWorkbench,
  type Breakpoint,
  type DockId,
  type SectionId,
  type ShellState,
} from './shell-state.js';

export interface ShellController {
  readonly breakpoint: Breakpoint;
  readonly state: ShellState;
  /**
   * True where the workbench floats above the stage instead of taking width
   * from it — Compact only, from Phase 4 W3.
   *
   * It used to be `breakpoint !== 'wide'`, because U6 floated both docks at
   * Medium so the stage never lost a pixel. §3 replaced that with the 50%-area
   * rule and the workbench went back into flow, so at Medium the stage really
   * does shrink and this is `false` there. Below 1100 px nothing else fits and
   * the workbench is a sheet again.
   */
  readonly dockOverlays: boolean;
  /** True where the shell draws ONE workbench instead of two docks. */
  readonly usesWorkbench: boolean;
  /** Which mode the workbench is in. Derived from the open section. */
  readonly mode: DockId;
  /** Switch mode. Shows that mode's first pane if none of its panes is open. */
  setMode(mode: DockId): void;
  isDockOpen(dock: DockId): boolean;
  /** The section's accordion state, regardless of whether its dock is showing. */
  isOpen(id: SectionId): boolean;
  /** Expanded AND its dock showing — what a reader can actually see. */
  isVisible(id: SectionId): boolean;
  setSection(id: SectionId, open: boolean): void;
  toggleSection(id: SectionId): void;
  setDockOpen(dock: DockId, open: boolean): void;
  setDockWidth(dock: DockId, px: number): void;
  /**
   * Put a section where it can be seen — §5.2.
   *
   * Opens the section's own dock if it is shut and expands the section, which
   * below Wide closes whatever else was open IN THAT DOCK and shuts the other
   * dock. Called from the selection path, and only for selections that
   * originated in the 3D scene: a click inside a pane that is already on screen
   * needs no help, and hijacking the dock while a learner is mid-lesson would
   * be worse than the problem it solves.
   */
  reveal(id: SectionId): void;
}

/**
 * Breakpoint, open sections and dock widths, restored from `localStorage`.
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
    (dock: DockId, open: boolean) => update((previous) => withDockOpen(previous, dock, breakpoint, open)),
    [breakpoint, update],
  );

  const setDockWidth = useCallback(
    (dock: DockId, px: number) => update((previous) => withDockWidth(previous, dock, px)),
    [update],
  );

  const reveal = useCallback(
    (id: SectionId) =>
      update((previous) =>
        withSection(withDockOpen(previous, dockForSection(id), breakpoint, true), breakpoint, id, true),
      ),
    [breakpoint, update],
  );

  const mode = modeForState(state, breakpoint);

  const setMode = useCallback(
    (next: DockId) => update((previous) => withDockOpen(previous, next, breakpoint, true)),
    [breakpoint, update],
  );

  return useMemo(
    () => ({
      breakpoint,
      state,
      dockOverlays: breakpoint === 'compact',
      usesWorkbench: usesWorkbench(breakpoint),
      mode,
      setMode,
      isDockOpen: (dock: DockId) => dockIsOpen(state, breakpoint, dock),
      isOpen: (id: SectionId) => sectionIsOpen(state, breakpoint, id),
      isVisible: (id: SectionId) => sectionIsVisible(state, breakpoint, id),
      setSection,
      toggleSection,
      setDockOpen,
      setDockWidth,
      reveal,
    }),
    [breakpoint, state, mode, setMode, setSection, toggleSection, setDockOpen, setDockWidth, reveal],
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
          className={`rail-btn${shell.isVisible('learn') ? ' active' : ''}`}
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
          className={`rail-btn${shell.isVisible('lab') ? ' active' : ''}`}
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
          <OriginTag origin={drivingOrigin} compact />
          <span className="dim rail-events">{totalEvents}</span>
        </div>
      </div>
    </nav>
  );
}

// ------------------------------------------------------------------- docks

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

export interface DocksProps {
  readonly shell: ShellController;
  readonly sections: readonly DockSectionSpec[];
}

const DOCK_META: Readonly<Record<DockId, { label: string; hint: string }>> = {
  control: { label: 'controls', hint: 'commands, face and the Lab — the surfaces that drive this robot' },
  analysis: { label: 'analysis', hint: 'inspector, modules, signal, source and lessons' },
};

/**
 * The workbench regime and the two-dock regime, and the scrim that closes a
 * Compact sheet.
 *
 * At Wide (>= 1700 px) `.docks` is in flow and the two docks U6 built take
 * width from the stage; two 360 px docks plus a 64 px rail still leave >=
 * 1276 px of stage there, which clears the 50%-area rule comfortably.
 *
 * Below Wide there is ONE workbench — Phase 4 W3, §3 of the plan. Two docks
 * cannot give a laptop 45 ch of prose AND the stage half the screen: 360+360
 * leaves 43.9% of the area at 1440x900 and 320+320 leaves 49.3%, so the choice
 * was made by arithmetic rather than by preference. One 540 px workbench leaves
 * 56.0%.
 *
 * `.docks` still wraps both regimes, and it still carries `data-sections`. That
 * is deliberate: every pane rule W2 keyed on `[data-sections='one']` — the
 * Source pane's two height regimes, the arch canvas, pane spacing, scroll
 * ownership — goes on working through the change with no pane-rule edits at
 * all, because what those rules describe is "one pane owns this column", which
 * is exactly what a workbench is.
 */
export function Docks(props: DocksProps): ReactElement {
  const { shell, sections } = props;
  const overlayOpen = shell.dockOverlays && DOCK_IDS.some((dock) => shell.isDockOpen(dock));

  return (
    <>
      {/*
        The scrim. Only at Compact, where the workbench is a sheet over the
        stage: it is what closes it by clicking beside it. It is deliberately
        NOT rendered at Medium any more — the workbench is in flow there, there
        is nothing to click "beside", and a scrim over an interactive stage
        would be the overlay model surviving its own retirement.
      */}
      {overlayOpen && (
        <button
          type="button"
          className="dock-scrim"
          data-testid="dock-scrim"
          aria-label="close the workbench"
          onClick={() => {
            for (const dock of DOCK_IDS) if (shell.isDockOpen(dock)) shell.setDockOpen(dock, false);
          }}
        />
      )}

      {/*
        `data-sections` is the STRUCTURAL form of what used to be a viewport
        media query — Phase 4 W2, and W3 is the change it was built for.

        `one` means one pane owns the column's height: it renders at its natural
        height, the body is the single scroller, and the panes inside it do not
        bound themselves. `many` means several open sections share the column,
        each bounded, which is what keeps the architecture graph and the Signal
        trace on screen together at Wide.

        W3 changed what SETS it — a workbench is `one` by definition — and
        nothing that reads it changed with it. That was the whole point of
        publishing it as state rather than leaving it inside `@media`.
      */}
      <div
        className="docks"
        data-testid="docks"
        data-overlay={String(shell.dockOverlays)}
        data-regime={shell.usesWorkbench ? 'workbench' : 'docks'}
        data-sections={isSingleOpen(shell.breakpoint) ? 'one' : 'many'}
      >
        {shell.usesWorkbench ? (
          <Workbench shell={shell} sections={sections} />
        ) : (
          DOCK_IDS.map((dock) => (
            <Dock
              key={dock}
              dock={dock}
              shell={shell}
              sections={sections.filter((s) => dockForSection(s.id) === dock)}
            />
          ))
        )}
      </div>
    </>
  );
}

export interface WorkbenchProps {
  readonly shell: ShellController;
  readonly sections: readonly DockSectionSpec[];
}

/**
 * ONE workbench: a mode switch, a section navigator, and the current pane.
 *
 * ```text
 * +----------------------------------+
 * |  Control | Analyze          [>]  |  <- the mode switch, 2 top-level ideas
 * |  Inspector Modules Signal Source |  <- the section navigator, this mode's
 * +----------------------------------+
 * |  Signal                          |  <- the pane title
 * |  ...the pane, and nothing else   |
 * ```
 *
 * The brief's words, and the three things they rule out:
 *
 *  - *"preserve Control and Analyze as top-level concepts, but make them two
 *    modes of a single laptop workbench"* — so the two domains survive; what
 *    does not survive is two of them being on screen at once, each with its own
 *    navigation, its own open state and its own scroll position.
 *  - *"use tabs or a compact section navigator before using nested
 *    accordions"* — so the collapsed-accordion column is gone below Wide. A
 *    pane is chosen from a row of tabs, and the panes that are not chosen are
 *    `display: none` rather than a stack of headers competing for the column.
 *  - *"once a learner is in Signal, that pane should feel like the current
 *    task, not like one accordion section inside a dock inside another dock
 *    beside another dock"* — so the chosen pane gets a plain `<h2>` title and
 *    the entire column, and there is exactly one scroller under it.
 *
 * ## What did NOT change, on purpose
 *
 * **Every pane is still mounted.** `data-open="false"` is `display: none`, the
 * same relationship the accordion's `hidden` body had, and for the same four
 * reasons in this module's header comment: L4's refusal check counts
 * `.src-line` nodes, L6's lesson checks sample while a movement runs, L4 counts
 * `concept-text` elements, and V8 reads the drawn quaternion. An unmounted pane
 * makes all four vacuous.
 *
 * **§5.1 still holds.** A selection that lands in a pane the reader is not
 * looking at is still announced where they ARE looking — on that pane's tab in
 * the navigator, and, when it landed in the other mode, as a dot on the mode
 * switch. It is the same `badge`/`badgeIsSelection` pair the collapsed
 * accordion header used, rendered on the thing that is now on screen.
 *
 * **The mode is derived, not stored.** See `modeForState()`.
 */
export function Workbench(props: WorkbenchProps): ReactElement {
  const { shell, sections } = props;
  const mode = shell.mode;
  const open = shell.isDockOpen(mode);
  const inMode = sections.filter((s) => dockForSection(s.id) === mode);
  const active = inMode.find((s) => shell.isOpen(s.id)) ?? null;

  return (
    <aside
      className="workbench"
      data-testid="workbench"
      data-workbench=""
      data-mode={mode}
      data-open={String(open)}
      data-overlay={String(shell.dockOverlays)}
      data-breakpoint={shell.breakpoint}
      aria-label="workbench"
    >
      {/*
        Collapsed, the workbench is a 44 px icon strip and every one of the
        eight panes is still one click away — the reachability promise U6 made
        with two strips, kept with one, and 44 px cheaper for the stage.
      */}
      {!open && (
        <div className="dock-strip workbench-strip" data-testid="workbench-strip">
          <button
            type="button"
            className="dock-strip-btn dock-toggle"
            data-testid="workbench-toggle"
            data-dock-toggle-for={mode}
            aria-expanded={false}
            title="open the workbench"
            onClick={() => shell.setDockOpen(mode, true)}
          >
            ‹
          </button>
          {sections.map((section) => (
            <button
              key={section.id}
              type="button"
              className={`dock-strip-btn${section.badgeIsSelection ? ' has-selection' : ''}`}
              data-dock-strip={section.id}
              title={section.badge === null ? section.label : `${section.label} — ${section.badge}`}
              onClick={() => shell.reveal(section.id)}
            >
              <span aria-hidden="true">{section.glyph}</span>
              {section.badgeIsSelection && <i className="dock-strip-dot" aria-hidden="true" />}
            </button>
          ))}
        </div>
      )}

      {open && (
        <div className="workbench-frame">
          {/* ------------------------------------------------ the mode switch */}
          <div className="workbench-head">
            <div className="workbench-modes" role="radiogroup" aria-label="workbench mode">
              {DOCK_IDS.map((id) => {
                /* A selection sitting in the OTHER mode is still announced —
                   as a dot here, because the navigator only lists one mode's
                   panes and §5.1 does not stop at a mode boundary. */
                const carries = sections.some(
                  (s) => dockForSection(s.id) === id && s.badgeIsSelection && s.id !== active?.id,
                );
                return (
                  <button
                    key={id}
                    type="button"
                    role="radio"
                    aria-checked={mode === id}
                    className={`workbench-mode${mode === id ? ' active' : ''}`}
                    data-workbench-mode={id}
                    title={DOCK_META[id].hint}
                    onClick={() => shell.setMode(id)}
                  >
                    {MODE_LABEL[id]}
                    {carries && <i className="dock-badge-dot" aria-hidden="true" />}
                  </button>
                );
              })}
            </div>
            <button
              type="button"
              className="workbench-collapse"
              data-testid="workbench-toggle"
              data-dock-toggle-for={mode}
              aria-expanded
              title="close the workbench — the robot takes the whole shell"
              onClick={() => shell.setDockOpen(mode, false)}
            >
              ›
            </button>
          </div>

          {/* -------------------------------------------- the section navigator */}
          <div
            className="workbench-nav"
            role="tablist"
            data-testid="workbench-nav"
            aria-label={`${MODE_LABEL[mode]} panes`}
          >
            {inMode.map((section) => {
              const isActive = section.id === active?.id;
              return (
                <button
                  key={section.id}
                  type="button"
                  role="tab"
                  id={`nav-${section.id}`}
                  aria-selected={isActive}
                  aria-controls={`pane-${section.id}`}
                  className={`workbench-tab${isActive ? ' active' : ''}`}
                  data-section-nav={section.id}
                  title={section.badge === null ? section.label : `${section.label} — ${section.badge}`}
                  onClick={() => shell.setSection(section.id, true)}
                >
                  <span className="workbench-tab-label">{section.label}</span>
                  {/*
                    §5.1, on the navigator.

                    Only a SELECTION badge, never a count. "13 commands" beside
                    every tab is the density the brief is complaining about;
                    `Inspector ● R4` is the thing a reader would otherwise miss,
                    and it is the one the harness asserts is legible.
                  */}
                  {!isActive && section.badgeIsSelection && section.badge !== null && (
                    <span
                      className="dock-badge is-selection"
                      data-dock-badge={section.id}
                      data-selection="true"
                    >
                      <i className="dock-badge-dot" aria-hidden="true" />
                      {section.badge}
                    </span>
                  )}
                </button>
              );
            })}
          </div>

          {/*
            THE single scroller. `data-scroll-owner` is a contract, not a hint:
            the harness asserts that every OTHER vertical scroller inside a pane
            either carries `data-2d-surface` or does not exist. `.dock-body` is
            kept as a class because W2's `[data-sections='one'] .dock-body`
            spacing rule is about a column owned by one pane, which is what this
            is.
          */}
          <div
            className="dock-body workbench-body"
            data-testid="workbench-body"
            data-any-open={String(active !== null)}
            data-scroll-owner="workbench"
          >
            {sections.map((section) => {
              const sectionOpen = shell.isOpen(section.id);
              return (
                <section
                  key={section.id}
                  className={`pane dock-section workbench-pane${sectionOpen ? ' is-open' : ''}`}
                  id={`pane-${section.id}`}
                  role="tabpanel"
                  data-pane={section.id}
                  data-dock-section={section.id}
                  data-dock={dockForSection(section.id)}
                  data-open={String(sectionOpen)}
                  aria-labelledby={`pane-${section.id}-title`}
                >
                  {/*
                    A TITLE, not a toggle. The navigator above already decides
                    which pane is showing, and a chevron that collapses the one
                    pane on screen is the accordion-inside-a-dock idiom the
                    brief asked us to stop using. The `<h2>` and the id stay
                    exactly as the pane contract specifies them.
                  */}
                  <h2
                    className="pane__header dock-section-header workbench-pane-title"
                    data-pane-chrome="header"
                  >
                    <span className="dock-section-label" id={`pane-${section.id}-title`}>
                      {section.label}
                    </span>
                    {section.badge !== null && (
                      <span
                        className={`workbench-pane-note${section.badgeIsSelection ? ' is-selection' : ''}`}
                        data-pane-note={section.id}
                      >
                        {section.badge}
                      </span>
                    )}
                  </h2>
                  <div
                    className="pane__content dock-section-body"
                    data-pane-content={section.id}
                    data-scroll-owner="pane"
                    hidden={!sectionOpen}
                  >
                    {section.body}
                  </div>
                </section>
              );
            })}
          </div>
        </div>
      )}
    </aside>
  );
}

export interface DockProps {
  readonly dock: DockId;
  readonly shell: ShellController;
  readonly sections: readonly DockSectionSpec[];
}

/**
 * One dock: its icon strip, its accordion and its drag handle.
 *
 * The 44 px icon strip is all the dock shows until it is opened, which is how
 * every pane stays REACHABLE at every breakpoint without any of them costing
 * the stage a pixel.
 */
export function Dock(props: DockProps): ReactElement {
  const { dock, shell, sections } = props;
  const drag = useRef<{ startX: number; startWidth: number } | null>(null);
  const open = shell.isDockOpen(dock);

  const onResizeDown = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      drag.current = { startX: event.clientX, startWidth: shell.state.dockWidthPx[dock] };
      event.currentTarget.setPointerCapture(event.pointerId);
    },
    [dock, shell.state.dockWidthPx],
  );

  const onResizeMove = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      const start = drag.current;
      if (start === null) return;
      // The handle is on the dock's LEFT edge, so dragging left widens it.
      shell.setDockWidth(dock, clampDockWidth(start.startWidth + (start.startX - event.clientX)));
    },
    [dock, shell],
  );

  const onResizeUp = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    drag.current = null;
    event.currentTarget.releasePointerCapture(event.pointerId);
  }, []);

  const anyOpen = sections.some((s) => shell.isOpen(s.id));

  return (
    <aside
      className="dock"
      data-testid={`dock-${dock}`}
      data-dock={dock}
      data-open={String(open)}
      data-overlay={String(shell.dockOverlays)}
      data-breakpoint={shell.breakpoint}
      aria-label={DOCK_META[dock].label}
      style={{ ['--dock-w' as string]: `${String(shell.state.dockWidthPx[dock])}px` }}
    >
      <div className="dock-strip" data-testid={`dock-strip-${dock}`}>
        <button
          type="button"
          className="dock-strip-btn dock-toggle"
          data-testid={`dock-toggle-${dock}`}
          data-dock-toggle-for={dock}
          aria-expanded={open}
          title={`${open ? 'close' : 'open'} the ${DOCK_META[dock].label} dock — ${DOCK_META[dock].hint}`}
          onClick={() => shell.setDockOpen(dock, !open)}
        >
          {open ? '›' : '‹'}
        </button>
        {sections.map((section) => (
          <button
            key={section.id}
            type="button"
            className={`dock-strip-btn${shell.isVisible(section.id) ? ' active' : ''}${
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

      {/*
        The workbench scroller. `data-scroll-owner` is a contract, not a hint:
        the harness asserts that every OTHER vertical scroller inside a pane
        either carries `data-2d-surface` or does not exist.
      */}
      <div
        className="dock-body"
        data-testid={`dock-body-${dock}`}
        data-any-open={String(anyOpen)}
        data-scroll-owner="workbench"
      >
        {sections.map((section) => {
          const sectionOpen = shell.isOpen(section.id);
          return (
            /*
              THE PANE STRUCTURAL CONTRACT — Phase 4 W2.

              `section.pane[data-pane]` > `.pane__header h2` > `.pane__content`,
              labelled by its own title, and `container: pane / inline-size` so
              everything inside it can ask how wide IT is rather than how wide
              the window is. The dock-era class names are kept alongside the
              contract ones on purpose: renaming 3,000 lines of selectors in the
              same change that introduces container queries is exactly the
              "visual regressions become unattributable" failure the brief warns
              about.
            */
            <section
              key={section.id}
              className={`pane dock-section${sectionOpen ? ' is-open' : ''}`}
              data-pane={section.id}
              data-dock-section={section.id}
              data-dock={dock}
              data-open={String(sectionOpen)}
              aria-labelledby={`pane-${section.id}-title`}
            >
              <h2 className="pane__header dock-section-header" data-pane-chrome="header">
                <button
                  type="button"
                  className="dock-section-toggle"
                  data-dock-toggle={section.id}
                  aria-expanded={sectionOpen}
                  onClick={() => shell.toggleSection(section.id)}
                >
                  <span className="dock-caret" aria-hidden="true">
                    {sectionOpen ? '▾' : '▸'}
                  </span>
                  <span className="dock-section-label" id={`pane-${section.id}-title`}>
                    {section.label}
                  </span>
                  {/*
                    §5.1. Shown only while the section is collapsed: an open
                    section shows the real thing, and a badge beside it would
                    be a second, staler statement of the same fact.
                  */}
                  {!sectionOpen && section.badge !== null && (
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
              <div
                className="pane__content dock-section-body"
                data-pane-content={section.id}
                data-scroll-owner="pane"
                hidden={!sectionOpen}
              >
                {section.body}
              </div>
            </section>
          );
        })}
      </div>

      {!shell.dockOverlays && open && (
        <div
          className="dock-resizer"
          data-testid={`dock-resizer-${dock}`}
          role="separator"
          aria-orientation="vertical"
          onPointerDown={onResizeDown}
          onPointerMove={onResizeMove}
          onPointerUp={onResizeUp}
          onDoubleClick={() => shell.setDockWidth(dock, DOCK_DEFAULT_PX[dock])}
          title="drag to resize · double-click to reset"
        />
      )}
    </aside>
  );
}

/** Every section id, in draw order. Re-exported so `App` need not import both. */
export { SECTION_IDS, DOCK_IDS, DOCK_SECTIONS, dockForSection, isSingleOpen };
export type { SectionId, Breakpoint, DockId };
