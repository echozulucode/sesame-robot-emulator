/**
 * The module-first shell — Phase 4 W7.
 *
 * ```text
 * >= 1200 px                                        < 1200 px
 * +--+-------------+-------------+--------+         +--+---------------------+
 * |R |             |             |Commands|         |R |                     |
 * |A |    ROBOT    | ONE MODULE  |Face    |         |A |   ROBOT (all of it) |
 * |I |             | Arch|Signal |glance  |         |I |                     |
 * |L |             | Source|Learn|        |         |L |  panel and module    |
 * |  |             | Lab         |280 px  |         |  |  are SHEETS         |
 * +--+-------------+-------------+--------+         +--+---------------------+
 * | SYSTEM: ... - PHYSICAL HARDWARE: NONE  |         | the same 32 px strip   |
 * +----------------------------------------+        +------------------------+
 * ```
 *
 * Everything here is layout. Not one pane's *content* is invented: the
 * architecture graph, the trace, the source explorer, Learn and Lab are handed
 * in as children and render what they rendered when they were dock sections.
 * Provenance, `isPhysicallyObserved()`, the `conceptual` badges, the NOT BUILT
 * panels and the modifying-this-robot banner are correctness surfaces and none
 * of them is styling.
 *
 * ## The three things W7 is
 *
 * **1. One active module.** `Architecture · Signal · Source · Learn · Lab` are
 * mutually exclusive, and they are exclusive *structurally*: the state is one
 * nullable id, so a two-open state is not representable. The rail's module
 * group is the navigation — there is no accordion, no navigator row and no mode
 * switch, because the mode is now derived from the one field (see
 * `modeForState`).
 *
 * **2. A side panel that never scrolls.** Commands, the 128x64 face and a
 * glance at the selected joint, ~280 px, always visible above Compact. §11.4:
 * *"Never its own scrollbar — neither Commands nor Face. If content does not
 * fit, that is a content problem to solve by disclosure, not by adding a
 * scroller."* So the panel is `overflow: hidden` and the harness asserts BOTH
 * that it has zero scrollers AND that its `scrollHeight` does not exceed its
 * `clientHeight` — because hiding an overflow is the same lie as scrolling it,
 * just quieter.
 *
 * **3. "More info" screens.** A `<dialog>` per panel card carries the detail:
 * the full command vocabulary, the OLED at 4x with the full pixel-provenance
 * prose, the seven-column joint table, the backend switch and the counts.
 *
 * ### The line a popover may not cross
 *
 * §11.4, and it is the constraint a "minimal panel" brief invites somebody to
 * tidy away: **correctness surfaces may not be demoted into a popover.** The
 * driving provenance, the origin (with its board), `measurementVerdict()`,
 * `PHYSICAL HARDWARE: NONE`, the receive-only warning, the two zero-frame faces
 * and the "these pixels did not come from the emulator" statement are rendered
 * on the panel itself. A popover *expands* them — the same claim with the
 * paragraph attached — and is never where they first appear.
 *
 * ## Panes stay MOUNTED when they are not the active module
 *
 * `display: none`, never an unmount, and that is load bearing in four places:
 *
 *  - L4's refusal check asserts **zero `.src-line` nodes** when the bundled
 *    source fails its hash. An unmounted pane also has zero, so unmounting
 *    would make the sharpest assertion in the harness pass vacuously.
 *  - L6's checks re-evaluate every 250 ms against live state, and several
 *    (`face-mode-identified`) can only be answered from a sample taken WHILE a
 *    movement runs. An unmounted runner stops sampling.
 *  - L4 asserts exactly one `concept-text` element exists.
 *  - V8's `visual.joint` rung is read off `Object3D.quaternion` — what was
 *    actually drawn. The stage is therefore never unmounted either.
 *
 * The module COLUMN is therefore rendered at every width and in every state; it
 * is the column that is `display: none` when no module is active, not the panes
 * inside it.
 */
import {
  Fragment,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactElement,
  type ReactNode,
} from 'react';

import type { BackendId, BackendStatus, ConnectionState } from '../backends/types.js';
import type { Provenance, TelemetryOrigin } from '@sesame-lab/sesame-protocol';
import { OriginTag, ProvenanceTag } from './ProvenanceTag.js';
import {
  activeModuleFor,
  breakpointForWidth,
  DEFAULT_SHELL,
  DOCK_IDS,
  DOCK_SECTIONS,
  dockForSection,
  isModuleId,
  isPanelId,
  loadShell,
  MODE_LABEL,
  MODULE_IDS,
  MODULE_LABEL,
  MODULE_RAIL_LABEL,
  modeForState,
  moduleForDock,
  panelIsVisible,
  PANEL_IDS,
  saveShell,
  SECTION_IDS,
  sectionIsVisible,
  sheetsOverStage,
  toggleModule,
  withModule,
  withPanelSheet,
  type Breakpoint,
  type DockId,
  type ModuleId,
  type PanelId,
  type SectionId,
  type ShellState,
} from './shell-state.js';

export interface ShellController {
  readonly breakpoint: Breakpoint;
  readonly state: ShellState;
  /**
   * True only at Compact, where the module and the panel float over the stage
   * instead of taking width from it.
   *
   * Above Compact everything is in flow and the stage genuinely resizes, which
   * is what `data-stage-rule` and the two area assertions are measured against.
   */
  readonly sheets: boolean;
  /** The one active module, or `null` — the robot has the whole content area. */
  readonly activeModule: ModuleId | null;
  /** `Control | Analyze`, derived from the active module. Never stored. */
  readonly mode: DockId;
  /** True where the side panel has a laid-out box. Always, above Compact. */
  readonly panelVisible: boolean;
  setModule(id: ModuleId | null): void;
  toggleModule(id: ModuleId): void;
  /** Compact only: show or hide the side panel as a sheet. */
  setPanelSheet(open: boolean): void;
  isActive(id: ModuleId): boolean;
  /** On screen — for a module, active; for a panel card, the panel is showing. */
  isVisible(id: SectionId): boolean;
  /**
   * Put a pane where it can be seen — the §5 mitigation.
   *
   * For a module this activates it, which by construction deactivates whatever
   * else was up. For a panel card it opens the Compact sheet and is a no-op
   * above Compact, because the panel is already on screen.
   */
  reveal(id: SectionId): void;
  /** The debug hook's compatibility shim. See `setSectionCompat`. */
  setSection(id: SectionId, open: boolean): void;
  /** The debug hook's compatibility shim. See `moduleForDock`. */
  setDockOpen(dock: DockId, open: boolean): void;
}

/**
 * Breakpoint and the active module, restored from `localStorage`.
 *
 * The width is read once on mount and then from `resize`. `matchMedia` would do
 * as well; `innerWidth` is used because the same number is what the harness
 * measures the stage against, and comparing a layout decision to a different
 * measurement of the same window is how off-by-a-scrollbar bugs start.
 */
export function useShell(): ShellController {
  const [state, setState] = useState<ShellState>(DEFAULT_SHELL);
  const [breakpoint, setBreakpoint] = useState<Breakpoint>('medium');

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

  const setModule = useCallback(
    (id: ModuleId | null) => update((previous) => withModule(previous, breakpoint, id)),
    [breakpoint, update],
  );

  const toggle = useCallback(
    (id: ModuleId) => update((previous) => toggleModule(previous, breakpoint, id)),
    [breakpoint, update],
  );

  const setPanelSheet = useCallback(
    (open: boolean) => update((previous) => withPanelSheet(previous, breakpoint, open)),
    [breakpoint, update],
  );

  const reveal = useCallback(
    (id: SectionId) =>
      update((previous) =>
        isModuleId(id)
          ? withModule(previous, breakpoint, id)
          : withPanelSheet(previous, breakpoint, true),
      ),
    [breakpoint, update],
  );

  /*
   * The compatibility shim, and it is a shim rather than a second model.
   *
   * Eight harness phases drive this shell through `setSection(id, open)` and
   * `setDockOpen(dock, open)`, which were the accordion's verbs. Both are
   * reduced to the one field:
   *
   *   a MODULE   open=true  -> make it the active module
   *              open=false -> clear it, if it is the one that is active
   *   a PANEL id open=true  -> show the panel (a no-op above Compact)
   *              open=false -> hide the Compact sheet; NEVER hides it above
   *                            Compact, because the panel carries correctness
   *                            surfaces and a zone that can be closed is a zone
   *                            that can hide them.
   */
  const setSection = useCallback(
    (id: SectionId, open: boolean) =>
      update((previous) => {
        if (isModuleId(id)) {
          if (open) return withModule(previous, breakpoint, id);
          return activeModuleFor(previous, breakpoint) === id
            ? withModule(previous, breakpoint, null)
            : previous;
        }
        return withPanelSheet(previous, breakpoint, open);
      }),
    [breakpoint, update],
  );

  const setDockOpen = useCallback(
    (dock: DockId, open: boolean) =>
      update((previous) => {
        if (!open) {
          const active = activeModuleFor(previous, breakpoint);
          return active !== null && dockForSection(active) === dock
            ? withModule(previous, breakpoint, null)
            : previous;
        }
        return withModule(previous, breakpoint, moduleForDock(dock));
      }),
    [breakpoint, update],
  );

  const active = activeModuleFor(state, breakpoint);
  const mode = modeForState(state, breakpoint);
  const panelVisible = panelIsVisible(state, breakpoint);

  return useMemo(
    () => ({
      breakpoint,
      state,
      sheets: sheetsOverStage(breakpoint),
      activeModule: active,
      mode,
      panelVisible,
      setModule,
      toggleModule: toggle,
      setPanelSheet,
      isActive: (id: ModuleId) => active === id,
      isVisible: (id: SectionId) => sectionIsVisible(state, breakpoint, id),
      reveal,
      setSection,
      setDockOpen,
    }),
    [
      breakpoint,
      state,
      active,
      mode,
      panelVisible,
      setModule,
      toggle,
      setPanelSheet,
      reveal,
      setSection,
      setDockOpen,
    ],
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
  /** Which modules carry a selection the reader is not looking at. */
  readonly moduleBadges: Readonly<Partial<Record<ModuleId, string>>>;
}

const BACKEND_RAIL: readonly { id: BackendId; short: string; title: string }[] = [
  { id: 'sim', short: 'SIM', title: 'Simulated model — a host model, in this tab' },
  { id: 'bridge', short: 'BRG', title: 'Bridge WebSocket — receive-only' },
  { id: 'qemu', short: 'QEM', title: 'QEMU firmware — real firmware, commandable' },
];

/**
 * The connection lamp's shape, so the state is not carried by hue alone —
 * Phase 4 W6.
 *
 * Filled, hollow, and a cross: three shapes for three answers, in the rail
 * where there is no room for the word. The word itself is on the status line
 * under the robot, which is where a reader who needs it should find it; this is
 * the glance.
 */
const CONNECTION_GLYPH: Readonly<Record<ConnectionState, string>> = {
  connected: '●',
  connecting: '◌',
  idle: '○',
  closed: '○',
  error: '✕',
};

const MODULE_GLYPH: Readonly<Record<ModuleId, string>> = {
  modules: '⌗',
  signal: '∿',
  source: '‹›',
  learn: '◪',
  lab: '⚙',
};

/**
 * 64 px, always visible, never collapses — and now it is the navigation.
 *
 * W3's `Control | Analyze` switch and its section navigator both lived inside
 * the workbench, which meant the reader had to open a panel to find out what
 * panels there were. The five modules are mutually exclusive, so they are a
 * `radiogroup` in the one zone that is always on screen; clicking the checked
 * one again clears it and gives the robot the whole content area.
 *
 * The two honesty badges stay at the foot of it. That is a product requirement
 * rather than decoration: a zone that can be closed is a zone that can hide
 * whether what is on screen was measured, simulated or inferred.
 */
export function Rail(props: RailProps): ReactElement {
  const {
    shell,
    backendId,
    onBackendChange,
    status,
    drivingProvenance,
    drivingOrigin,
    totalEvents,
    moduleBadges,
  } = props;
  /*
    INERT while a Compact sheet covers it — Phase 4 W6.

    At Compact the module and the side panel are sheets over the stage, and the
    scrim that closes them is `position: absolute; inset: 0; z-index: 4` — so it
    covers the 64 px rail as well. That is the intent: while a sheet is open the
    rail is not available, and clicking where it used to be closes the sheet.

    What it was not doing was saying so to a keyboard. The Tab walk found all
    five module buttons, the three backend buttons and the panel toggle
    focusable and **entirely hidden behind the scrim** — WCAG 2.4.11, and the
    plainest possible version of it: a reader tabs onto a control they cannot
    see, in a shell whose whole Compact rule is one thing at a time.

    `inert` is the correct expression of a state the layout already had. The
    way out of a sheet stays keyboard-reachable either way: the module's own
    close button, and the scrim itself, are inside the sheet's own subtree.
  */
  const coveredBySheet = shell.sheets && (shell.activeModule !== null || shell.panelVisible);
  return (
    <nav
      className="rail"
      data-testid="rail"
      aria-label="modules, backend and provenance"
      {...(coveredBySheet ? { inert: true } : {})}
    >
      <div className="rail-group" role="radiogroup" aria-label="active module" data-testid="rail-modules">
        {MODULE_IDS.map((id) => {
          const active = shell.isActive(id);
          const badge = moduleBadges[id];
          return (
            <button
              key={id}
              type="button"
              role="radio"
              aria-checked={active}
              aria-label={MODULE_LABEL[id]}
              className={`rail-btn rail-module${active ? ' active' : ''}`}
              data-module-nav={id}
              data-active={String(active)}
              title={
                badge === undefined
                  ? `${MODULE_LABEL[id]} — one module at a time; click again to give the robot the whole area`
                  : `${MODULE_LABEL[id]} — ${badge}`
              }
              onClick={() => shell.toggleModule(id)}
            >
              <span className="rail-glyph" aria-hidden="true">
                {MODULE_GLYPH[id]}
              </span>
              <span className="rail-label">{MODULE_RAIL_LABEL[id]}</span>
              {/*
                §5.1, at icon size. A selection that landed in a module the
                reader is not looking at is still announced where they ARE
                looking. `data-dock-badge` keeps U6's attribute name so the
                debug hook's one document-wide lookup still finds it.
              */}
              {badge !== undefined && !active && (
                <span className="rail-badge" data-dock-badge={id} data-selection="true">
                  <i className="dock-badge-dot" aria-hidden="true" />
                  <span className="rail-badge-text">{badge}</span>
                </span>
              )}
            </button>
          );
        })}
      </div>

      {/* Compact only: the side panel is a sheet there, so it needs a way back. */}
      {shell.sheets && (
        <div className="rail-group">
          <button
            type="button"
            className={`rail-btn${shell.panelVisible ? ' active' : ''}`}
            data-testid="rail-panel-toggle"
            aria-expanded={shell.panelVisible}
            title="commands, face and the selected joint"
            onClick={() => shell.setPanelSheet(!shell.panelVisible)}
          >
            <span className="rail-glyph" aria-hidden="true">
              ▤
            </span>
            <span className="rail-label">Panel</span>
          </button>
        </div>
      )}

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
        The two honesty badges, in the one zone that cannot be closed. They are
        a SUMMARY of the side panel's trust card, not a second opinion: both
        read `store.drivingProvenance` and `store.drivingOrigin`, so they cannot
        disagree.
      */}
      <div className="rail-status" data-testid="rail-status">
        {/*
          The lamp carries a SHAPE as well as a colour — Phase 4 W6.

          It was `●` in three different colours, and the green is `--observed`:
          the same hue the app uses for the provenance category whose whole
          problem is being over-read. The brief warns about exactly this pairing
          in the other direction — *"do not encode 'physical' as an inactive
          green/red lamp that a child might interpret as a connection
          indicator"* — and a connection lamp painted in the observed green is
          the same collision from the other side.

          The status line under the robot spells the state out in a word
          (`.status-word`), so the page is not relying on this at all; what
          changes here is that the rail's own glyph stops depending on hue.
        */}
        <span
          className={`rail-conn conn-${status.connection}`}
          data-testid="rail-conn"
          data-connection={status.connection}
          title={`${status.connection} — ${status.detail}`}
        >
          {CONNECTION_GLYPH[status.connection] ?? '●'}
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

// -------------------------------------------------------------- the modules

export interface ModuleSpec {
  readonly id: ModuleId;
  readonly label: string;
  /** What the title line says beside the label. `null` means nothing worth saying. */
  readonly note: string | null;
  readonly noteIsSelection: boolean;
  readonly body: ReactNode;
}

export interface ModuleColumnProps {
  readonly shell: ShellController;
  readonly modules: readonly ModuleSpec[];
}

/**
 * The one module column.
 *
 * It is rendered at every width and in every state — see the module comment on
 * why panes may never be unmounted — and it is the COLUMN that disappears when
 * no module is active. `[data-sections='one']` is kept on the wrapper because
 * every W2 pane rule keyed on it (the Source pane's two height regimes, the
 * arch canvas, the lab code block, scroll ownership, pane spacing) describes
 * exactly this arrangement: one pane owning one column's height behind one
 * scroller.
 */
export function ModuleColumn(props: ModuleColumnProps): ReactElement {
  const { shell, modules } = props;
  const active = shell.activeModule;

  return (
    <>
      {/*
        The scrim. Only at Compact, where the module is a sheet over the stage:
        it is what closes it by clicking beside it.
      */}
      {shell.sheets && active !== null && (
        <button
          type="button"
          className="dock-scrim"
          data-testid="dock-scrim"
          aria-label="close the module"
          onClick={() => shell.setModule(null)}
        />
      )}

      <div
        className="docks module-column"
        data-testid="module-column"
        data-sections="one"
        data-regime="module"
        data-overlay={String(shell.sheets)}
        data-active-module={active ?? ''}
        data-breakpoint={shell.breakpoint}
      >
        <div className="module-frame" data-testid="module-frame">
          {/*
            THE single scroller for the module column. `data-scroll-owner` is a
            contract, not a hint: the harness asserts that every OTHER vertical
            scroller inside a pane either carries `data-2d-surface` or does not
            exist.
          */}
          <div
            className="dock-body module-body"
            data-testid="module-body"
            data-any-open={String(active !== null)}
            data-scroll-owner="module"
          >
            {modules.map((module) => {
              const isActive = module.id === active;
              return (
                <section
                  key={module.id}
                  className={`pane dock-section module-pane${isActive ? ' is-open' : ''}`}
                  id={`pane-${module.id}`}
                  data-pane={module.id}
                  data-dock-section={module.id}
                  data-dock={dockForSection(module.id)}
                  data-module={module.id}
                  data-open={String(isActive)}
                  aria-labelledby={`pane-${module.id}-title`}
                >
                  {/*
                    A TITLE, not a toggle and not a tab. The rail decides which
                    module is showing; a chevron that collapses the one module
                    on screen is the accordion idiom the brief asked us to stop
                    using, and a navigator row inside the column would be a
                    second copy of the rail.
                  */}
                  <h2 className="pane__header module-title" data-pane-chrome="header">
                    <span className="dock-section-label" id={`pane-${module.id}-title`}>
                      {module.label}
                    </span>
                    {module.note !== null && (
                      <span
                        className={`module-note${module.noteIsSelection ? ' is-selection' : ''}`}
                        data-pane-note={module.id}
                      >
                        {module.note}
                      </span>
                    )}
                    <button
                      type="button"
                      className="module-close"
                      data-module-close={module.id}
                      title="close this module — the robot takes the whole content area"
                      onClick={() => shell.setModule(null)}
                    >
                      ✕
                    </button>
                  </h2>
                  <div
                    className="pane__content dock-section-body module-content"
                    data-pane-content={module.id}
                    data-scroll-owner="pane"
                    hidden={!isActive}
                  >
                    {module.body}
                  </div>
                </section>
              );
            })}
          </div>
        </div>
      </div>
    </>
  );
}

// ----------------------------------------------------------- the side panel

export interface PanelCardSpec {
  readonly id: PanelId;
  readonly label: string;
  /** The "more info" screen this card opens, if it has one. */
  readonly more: { readonly label: string; readonly onOpen: () => void } | null;
  readonly body: ReactNode;
  /**
   * The card's glance line, beside its name.
   *
   * It existed so that a mark would survive a fold. Nothing folds any more
   * (see {@link SCROLLABLE_CARDS}), and it stays for the reason it was worth
   * having anyway: the Face's summary is its pixel provenance, Commands' is
   * whether this backend can command at all, and the joint glance's is the
   * selected joint and the provenance of its reading — each one better read
   * beside a card's name than three lines into its body.
   *
   * **It must not carry text whose LENGTH varies with live telemetry.** The
   * header is a wrapping flex row 262 px wide, so a value one character longer
   * re-wraps it and moves every card below — which is the bug the fold was
   * blamed for. Anything variable goes in the card's body, on a row of its own
   * with a fixed line count. See `.panel-card-title` in the stylesheet.
   */
  readonly summary: ReactNode;
}

export interface SidePanelProps {
  readonly shell: ShellController;
  /** The trust card. Rendered FIRST and never behind a disclosure. */
  readonly trust: ReactNode;
  readonly cards: readonly PanelCardSpec[];
}

/**
 * ===========================================================================
 * THE FOLD IS GONE — Phase 4 W5, on the user's own correction of W7
 * ===========================================================================
 *
 * > *"the commands pane is not how I described it. We want to see all the
 * > commands where possible and fit the available space with commands. All
 * > other sections should be large enough that they don't need to change size.
 * > Use scrollbars in command and selected joint only if there isn't enough
 * > space to show all content."*
 *
 * W7 answered *"never its own scrollbar"* with a measurement: cards folded away
 * in a priority order until the content fitted, and one elastic card grew into
 * whatever was left. It was correct about the constraint it was given, and it
 * is the wrong shape for this panel for a reason the measurement itself makes
 * obvious — **every card's height became a function of every other card's
 * content**. Measured on the shipped build at 1440x900: `setFace("happy")`
 * gives the Face card 213 px and `setFace("sleepy")` gives it 241, because one
 * more character wrapped a header; the Commands card below it went 292 -> 264
 * and its buttons 80 px -> 65. That is the bouncing, and no amount of tuning
 * the fold order removes it, because the fold order is not what causes it.
 *
 * The replacement has no measurement in it at all:
 *
 * | card | flex | scrolls |
 * |---|---|---|
 * | Face, Driving | `0 0 auto` — its own content's height, always | never |
 * | **Commands** | `1 1 auto` — takes the height nothing else needs | when its own content does not fit |
 * | **Selected joint** | `0 1 auto` — gives height back before Commands does | when its own content does not fit |
 *
 * so a card's height is a function of its own content and of the panel's
 * height, and of nothing else. Nothing folds, nothing is measured after a
 * commit, and there is no state a re-render can change.
 *
 * **This relaxes W7's "the side panel has zero scrollers" invariant, on purpose
 * and on instruction.** The rule is narrower now and it is still a rule: zero
 * scrollers OUTSIDE the two cards named here, and those two scroll only when
 * their own content genuinely exceeds the space they were given. The harness
 * asserts the narrower rule rather than leaving the old one passing against a
 * design that no longer holds it.
 */
const SCROLLABLE_CARDS: readonly PanelId[] = ['commands', 'inspector'];

/**
 * The card that fills the panel — the user's model, restated.
 *
 * > *"Commands fills the available space and shows as many commands as fit."*
 *
 * `flex: 1 1 auto` in the stylesheet. It takes the height nothing else needs,
 * shows **every** command in the vocabulary rather than a shortlist of four,
 * and scrolls when they do not fit — which is what this panel is now allowed to
 * do, in this card and one other, and nowhere else.
 */
const ELASTIC_CARD: PanelId = 'commands';

/**
 * Where the trust card sits — Phase 4 W8.
 *
 * > *"The face should be at the very top."*
 *
 * W7 drew the trust card first and treated that as a consequence of §11.4. It
 * is not one. §11.4 says a correctness surface may not be demoted into a
 * popover — it must be ON the panel, not behind a disclosure — and says nothing
 * whatever about which card is at the top. The trust card is still on the
 * panel, still carrying all four of its named surfaces, and the harness still
 * reads every one of them with every screen shut. Only the order moved.
 *
 * `null` would put it first again, and the constant is named so that a future
 * reader can see this was a decision rather than a rendering accident.
 */
const TRUST_BELOW: PanelId | null = 'face';

/**
 * The right-most side panel — §11.4, as corrected by W5.
 *
 * 280 px, always visible above Compact. Its own box never scrolls
 * (`overflow: hidden` on `.side-panel-inner`); two of its cards may, and only
 * when their own content does not fit the height flex gave them.
 *
 * There is no layout effect here any more, and that is the change. Everything
 * this component used to compute — which card folds, what a card costs while it
 * is open, how much slack is left — is now a flex rule in the stylesheet, which
 * means it is decided during layout instead of one commit behind it. Two of
 * this project's three "assertions that could not fail" lived in the code this
 * replaces (`clientHeight - scrollHeight`, then `contentBottom - lastBottom`),
 * and both were arithmetic that could not come out positive; the third would
 * have been the next one written here.
 */
export function SidePanel(props: SidePanelProps): ReactElement {
  const { shell, trust, cards } = props;
  const visible = shell.panelVisible;
  const panelRef = useRef<HTMLElement>(null);
  const innerRef = useRef<HTMLDivElement>(null);

  return (
    <>
      {shell.sheets && visible && (
        <button
          type="button"
          className="dock-scrim"
          data-testid="panel-scrim"
          aria-label="close the side panel"
          onClick={() => shell.setPanelSheet(false)}
        />
      )}
      <aside
        ref={panelRef}
        className="side-panel"
        data-testid="side-panel"
        data-open={String(visible)}
        data-overlay={String(shell.sheets)}
        data-breakpoint={shell.breakpoint}
        data-scrollable-cards={SCROLLABLE_CARDS.join(',')}
        aria-label="commands, face and the selected joint"
      >
        <div
          className="side-panel-inner"
          ref={innerRef}
          data-testid="side-panel-inner"
          data-trust-below={TRUST_BELOW ?? ''}
        >
          {TRUST_BELOW === null && trust}
          {cards.map((card) => {
            const scrollable = SCROLLABLE_CARDS.includes(card.id);
            return (
              <Fragment key={`slot-${card.id}`}>
              <section
                className="pane panel-card"
                data-pane={card.id}
                data-panel-card={card.id}
                data-dock-section={card.id}
                data-dock={dockForSection(card.id)}
                data-open="true"
                /*
                  `data-folded` is gone with the fold — W5. It was read by the
                  harness and by three CSS rules, and leaving it at a constant
                  "false" would have kept a check passing about a mechanism that
                  no longer exists. What replaces it is the honest statement of
                  what this card is allowed to do with the panel's height.
                */
                data-scrollable={String(scrollable)}
                data-elastic={String(card.id === ELASTIC_CARD)}
                aria-labelledby={`pane-${card.id}-title`}
              >
                <h2 className="pane__header panel-card-title" data-pane-chrome="header">
                  <span className="dock-section-label" id={`pane-${card.id}-title`}>
                    {card.label}
                  </span>
                  {/*
                    The summary rides on the header. It was there so a mark
                    would survive a fold; nothing folds now, and it stays
                    because a badge beside a card's name is a better glance than
                    the same badge three lines into its body.
                  */}
                  <span className="panel-card-summary" data-panel-summary={card.id}>
                    {card.summary}
                  </span>
                  {card.more !== null && (
                    <button
                      type="button"
                      className="panel-more"
                      data-panel-more={card.id}
                      onClick={card.more.onOpen}
                      title={`${card.more.label} — the detail, in a screen of its own`}
                    >
                      {card.more.label}
                    </button>
                  )}
                </h2>
                <div
                  className="pane__content panel-card-body"
                  data-pane-content={card.id}
                  data-scroll-owner="pane"
                >
                  {card.body}
                </div>
              </section>
              {card.id === TRUST_BELOW && trust}
              </Fragment>
            );
          })}
        </div>
      </aside>
    </>
  );
}

// ---------------------------------------------------------------- popovers

export interface PopoverProps {
  readonly id: string;
  readonly title: string;
  readonly open: boolean;
  readonly onClose: () => void;
  readonly children: ReactNode;
}

/**
 * A "more info" screen — §11.4.
 *
 * A native `<dialog>` opened with `showModal()`, so focus containment, `Esc`
 * and the inert backdrop are the platform's rather than ours; zero new
 * dependencies, and a closed dialog is `display: none`, so nothing inside one
 * has a laid-out box, is counted as a scroller or is measured by the type scan.
 *
 * Rendered as a sibling of the shell's own columns rather than inside the side
 * panel, which is what keeps the panel's scroller inventory a statement about
 * the panel.
 */
export function Popover(props: PopoverProps): ReactElement {
  const { id, title, open, onClose, children } = props;
  const ref = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (el === null) return;
    if (open && !el.open) el.showModal();
    if (!open && el.open) el.close();
  }, [open]);

  return (
    <dialog
      ref={ref}
      className="popover"
      data-popover={id}
      data-open={String(open)}
      aria-label={title}
      onClose={onClose}
      onCancel={onClose}
    >
      <div className="popover-frame">
        <header className="popover-head">
          <h2 className="popover-title">{title}</h2>
          <button
            type="button"
            className="popover-close"
            data-popover-close={id}
            onClick={onClose}
          >
            Close
          </button>
        </header>
        {/*
          The popover owns ONE scroller. It is not a pane and it is not on the
          side panel: it is the screen a reader opened on purpose, and the
          "never a scrollbar" rule is about the glance surface it expands.
        */}
        <div className="popover-body" data-scroll-owner="popover">
          {children}
        </div>
      </div>
    </dialog>
  );
}

/** Re-exported so `App` need not import both modules. */
export {
  SECTION_IDS,
  MODULE_IDS,
  PANEL_IDS,
  DOCK_IDS,
  DOCK_SECTIONS,
  dockForSection,
  isModuleId,
  isPanelId,
  MODE_LABEL,
  MODULE_LABEL,
};
export type { SectionId, Breakpoint, DockId, ModuleId, PanelId };
