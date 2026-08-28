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
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactElement,
  type ReactNode,
} from 'react';

import type { BackendId, BackendStatus } from '../backends/types.js';
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
  return (
    <nav className="rail" data-testid="rail" aria-label="modules, backend and provenance">
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
   * What the card's header still says when the panel had to fold it away.
   *
   * A folded card is a disclosure, and §11.4 forbids a disclosure from being
   * where a correctness surface first appears — so whatever mark the card
   * carries has to survive the fold. The Face's summary is its pixel
   * provenance; Commands' is the count of zero-frame faces; the joint glance's
   * is the selected joint and the provenance of its reading.
   */
  readonly summary: ReactNode;
  /**
   * Deliberately absent: there is no "elastic" card.
   *
   * The first version made the Face card `flex: 0 1 auto` on the theory that a
   * 128x64 panel is the one surface that can give up height without hiding a
   * word. On screen it was crushed to **10 px** — and, worse, the crushing did
   * not register: a `container-type: inline-size` box does not contribute its
   * overflow to an ancestor's scrollable overflow, so `overflowPx` went on
   * reading 0 while the whole card was invisible. A safety valve the assertion
   * cannot see is worse than none, so folding — which is visible in the DOM, in
   * `data-folded`, and in the card's own summary — is the only mechanism.
   */
}

export interface SidePanelProps {
  readonly shell: ShellController;
  /** The trust card. Rendered FIRST and never behind a disclosure. */
  readonly trust: ReactNode;
  readonly cards: readonly PanelCardSpec[];
}

/**
 * Which card folds when the panel runs out of height, and in what order.
 *
 * The reader's own priority, from §11.4: *"the key information and face that
 * you'd want to look at while executing commands"*. The joint glance folds
 * first — it has an "All 8" screen and a line on the status strip. The face
 * folds second, keeping its name and its pixel provenance on the header.
 *
 * **Commands is not in this list, and neither is the trust card.** They cannot
 * fold at any height. Commands because it is the surface the whole side panel
 * exists to hold and because `[data-command="wave"]` is the button four harness
 * phases press — a vocabulary that disappears on a short window is a vocabulary
 * that is sometimes not there. The trust card because §11.4 forbids a
 * correctness surface from living behind a disclosure.
 *
 * If those two alone do not fit, the panel OVERFLOWS and the harness fails on
 * it. That is the intended failure: it is a content problem, and the answer is
 * to make the content shorter rather than to let a scroller or a clip hide it.
 */
const FOLD_ORDER: readonly PanelId[] = ['inspector', 'face'];

/**
 * The right-most side panel — §11.4.
 *
 * 280 px, always visible above Compact, and **zero scrollers at every width**.
 * Three mechanisms, in the order they take effect:
 *
 *  1. `overflow: hidden` on `.side-panel-inner`, so a scrollbar cannot appear
 *     however tall the content gets;
 *  2. the elastic card — the Face — gives up height before anything else does;
 *  3. and if that is still not enough, cards **fold** in {@link FOLD_ORDER}
 *     until the content fits, each keeping its header, its "more info" button
 *     and its `summary`.
 *
 * (3) is the plan's own instruction taken literally: *"If content does not fit,
 * that is a content problem to solve by disclosure, not by adding a scroller."*
 * It is measured rather than guessed — no height breakpoint, no `@container`
 * threshold, no viewport query — because the thing that decides is whether this
 * particular content fits this particular panel, and only a measurement knows.
 *
 * ## Why it cannot oscillate
 *
 * Folding is monotone within a render pass: the layout effect folds AT MOST ONE
 * card per commit and never unfolds. Unfolding happens only when the panel's
 * own box changes size, which is a window resize or a breakpoint change —
 * observed on `.side-panel` rather than on its content, so a fold cannot be the
 * event that triggers the next unfold. Converges in at most three commits.
 */
export function SidePanel(props: SidePanelProps): ReactElement {
  const { shell, trust, cards } = props;
  const visible = shell.panelVisible;
  const panelRef = useRef<HTMLElement>(null);
  const innerRef = useRef<HTMLDivElement>(null);
  const [folded, setFolded] = useState<readonly PanelId[]>([]);
  /**
   * What each card costs while it is open, measured rather than assumed.
   *
   * This is what makes the fold REVERSIBLE. Without it the panel could only
   * ever fold further, so one transient measurement during mount — when the
   * inner box has no height yet and every card "overflows" — would leave the
   * panel permanently folded on a screen with room for all four. That is
   * exactly what the first version did.
   */
  const naturalPx = useRef<Partial<Record<PanelId, number>>>({});

  /*
   * The fit, measured after every commit.
   *
   * One step per commit and never more, in both directions: fold the next card
   * in {@link FOLD_ORDER} when the content overflows, unfold the last one when
   * there is provably room for it — provably, meaning the slack exceeds what
   * that card measured while it was open. It converges because the cost is
   * re-measured from the card itself: if unfolding turns out to cost more than
   * the last measurement said, the next commit folds it again with the true
   * number and the comparison stops being true.
   */
  useLayoutEffect(() => {
    const inner = innerRef.current;
    if (inner === null) return;
    // Not laid out yet — at Compact with the sheet shut this is 0, and folding
    // on a zero-height box would fold everything for no reason.
    if (inner.clientHeight < 80) return;
    for (const el of inner.querySelectorAll('[data-panel-card]')) {
      const id = el.getAttribute('data-panel-card');
      if (id !== null && el.getAttribute('data-folded') === 'false' && isPanelId(id)) {
        naturalPx.current[id] = el.getBoundingClientRect().height;
      }
    }
    const slack = inner.clientHeight - inner.scrollHeight;
    if (slack < -1) {
      setFolded((previous) => {
        const next = FOLD_ORDER.find((id) => !previous.includes(id));
        return next === undefined ? previous : [...previous, next];
      });
      return;
    }
    /*
      Bring one back, most-recently-folded first — which is highest priority
      first, because folding runs down {@link FOLD_ORDER}. If the top one still
      does not fit, a LOWER-priority card that does is unfolded instead: an
      empty gap on the panel teaches nobody anything, and the card that fits is
      strictly more information than the space it would otherwise leave.
    */
    setFolded((previous) => {
      for (let i = previous.length - 1; i >= 0; i -= 1) {
        const id = previous[i];
        if (id === undefined) continue;
        const card = inner.querySelector(`[data-panel-card="${id}"]`);
        const foldedPx = card === null ? 0 : card.getBoundingClientRect().height;
        const cost = (naturalPx.current[id] ?? Number.POSITIVE_INFINITY) - foldedPx;
        if (slack > cost + 8) return previous.filter((other) => other !== id);
      }
      return previous;
    });
  });

  // The panel's own box changed — a window resize, or the Compact sheet
  // opening. Observed on the panel rather than on its content, so a fold can
  // never be the event that triggers the next unfold.
  useEffect(() => {
    const panel = panelRef.current;
    if (panel === null || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => setFolded([]));
    observer.observe(panel);
    return () => observer.disconnect();
  }, []);

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
        data-folded={folded.join(',')}
        aria-label="commands, face and the selected joint"
      >
        <div className="side-panel-inner" ref={innerRef} data-testid="side-panel-inner">
          {trust}
          {cards.map((card) => {
            const isFolded = folded.includes(card.id);
            return (
              <section
                key={card.id}
                className={`pane panel-card${isFolded ? ' is-folded' : ''}`}
                data-pane={card.id}
                data-panel-card={card.id}
                data-dock-section={card.id}
                data-dock={dockForSection(card.id)}
                data-open={String(!isFolded)}
                data-folded={String(isFolded)}
                aria-labelledby={`pane-${card.id}-title`}
              >
                <h2 className="pane__header panel-card-title" data-pane-chrome="header">
                  <span className="dock-section-label" id={`pane-${card.id}-title`}>
                    {card.label}
                  </span>
                  {/*
                    The summary rides on the header whether the card is folded
                    or not, so the mark it carries is in the same place either
                    way and the harness reads one selector rather than two.
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
                  hidden={isFolded}
                >
                  {card.body}
                </div>
              </section>
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
