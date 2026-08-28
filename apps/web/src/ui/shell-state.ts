/**
 * The shell's layout state — Phase 4 W7, the MODULE-FIRST shell.
 *
 * ```text
 * +----+-------------------+-------------------+------------+
 * |RAIL|                   |                   | Commands   |
 * | 64 |      ROBOT        |  ACTIVE MODULE    | Face       |
 * |    |                   |  (one of Arch /   | glance     |
 * |    |                   |   Signal /Source /|            |
 * |    |                   |   Learn / Lab)    |  280 px    |
 * |    |                   |                   | no scroller|
 * +----+-------------------+-------------------+------------+
 * | SYSTEM: QEMU EMULATOR - PHYSICAL HARDWARE: NONE          |
 * +----------------------------------------------------------+
 * ```
 *
 * ## What W7 changed, and why the previous model could not stay
 *
 * The user, after W3 and W4 were on screen:
 *
 * > *"On ultra large screens, the modules sections are still unusable. The
 * > architecture diagram needs to use up at least 50% of the screen to be
 * > useful, with the robot in the other half. I think the commands and face
 * > tools can be made to be minimal on small screens and never need their own
 * > individual scrollbars. […] Make that the right most side-panel while the
 * > larger content items can be maximize. The Architecture, Signals, Source and
 * > Learn modules should only have one active at a time."*
 *
 * That splits the eight panes into two kinds that were never the same kind:
 *
 *  - **MODULES** — {@link MODULE_IDS}. Large task surfaces. Exactly ONE is
 *    active at a time, or none. They are the reason a big screen is big.
 *  - **THE SIDE PANEL** — {@link PANEL_IDS}. Commands, the 128x64 face, and a
 *    glance at the selected joint. Always visible above Compact, ~280 px, and
 *    **never its own scrollbar at any width**: when it does not fit, the fix is
 *    disclosure (a "more info" popover), never a scroller.
 *
 * The active module IS the state. There is no second flag: W3's derived
 * `Control | Analyze` generalises rather than being replaced — the mode is
 * {@link modeForState}, computed from the active module, so `mode: 'analyze'`
 * with the Lab up is a state this shell cannot represent, let alone reach.
 *
 * ## What was deleted
 *
 * **The two-dock Wide regime, and the accordion with it.** W4 measured the
 * defect that finished it: at 1760x1000 - the harness's own default window -
 * two docks at their *default* widths (400 + 460, not the 360 + 360 W3 set the
 * 1700 boundary from) left the stage **45.0%** of the window's area, below the
 * 50% floor W3 asserted at 2560 and nowhere else. There is one shell now, at
 * every width above Compact, so the gap cannot reopen; the harness asserts
 * 1760x1000 by name.
 *
 * `dockWidthPx` went with it. A fixed 280 px panel and a 50/50 content split
 * are not preferences a reader drags.
 *
 * ## Storage
 *
 * `localStorage`, defensively, on exactly the terms `src/lessons/progress.ts`
 * and `src/lab/lab-doc.ts` set: every read and every write is wrapped, the
 * accessor itself can throw in a private window with site data blocked, the
 * value can be absent, and it can be somebody else's JSON. All three render the
 * defaults, and none of them is an error anybody has to see. A layout
 * preference is a convenience, never the source of truth.
 */

/** Keyed to what fits, not to device names. */
export type Breakpoint = 'compact' | 'medium' | 'wide';

/**
 * The two domains, kept from U6 and W3.
 *
 * They are no longer two columns and no longer two docks. What survives is the
 * classification — `control` drives this robot, `analysis` explains it — and it
 * is what {@link modeForState} derives the mode label from.
 */
export const DOCK_IDS = ['control', 'analysis'] as const;
export type DockId = (typeof DOCK_IDS)[number];

/**
 * The modules. **Mutually exclusive: at most one is active.**
 *
 * `lab` is in the set on purpose and §11.3 says why: it is a large editing
 * surface — a pose table, a pixel editor, a C++ export — and not a glance
 * surface. Putting it on the side panel would mean either a scroller (forbidden)
 * or an editor nobody can use.
 */
export const MODULE_IDS = ['modules', 'signal', 'source', 'learn', 'lab'] as const;
export type ModuleId = (typeof MODULE_IDS)[number];

/**
 * The side panel's cards, top to bottom. Always visible above Compact.
 *
 * `inspector` is here rather than in {@link MODULE_IDS} because what a reader
 * wants while driving the robot is *which joint is selected and what it is
 * doing*, which is four lines. The seven-column table is the "more info"
 * screen — §11.4 names it as the first thing that belongs in one.
 */
export const PANEL_IDS = ['commands', 'face', 'inspector'] as const;
export type PanelId = (typeof PANEL_IDS)[number];

/**
 * Every pane, in draw order: the panel's three, then the five modules.
 *
 * The ids are U6's, unchanged, and deliberately so: `data-pane`, the debug
 * hook, the harness's `focusSection()` and eight phases of assertions are
 * written against them. What changed is which surface draws them.
 */
export const SECTION_IDS = [
  'commands',
  'face',
  'inspector',
  'modules',
  'signal',
  'source',
  'learn',
  'lab',
] as const;
export type SectionId = (typeof SECTION_IDS)[number];

/** Which domain a section belongs to. The mode label is derived from this. */
export const DOCK_SECTIONS: Readonly<Record<DockId, readonly SectionId[]>> = Object.freeze({
  control: ['commands', 'face', 'lab'],
  analysis: ['inspector', 'modules', 'signal', 'source', 'learn'],
});

const SECTION_DOCK: Readonly<Record<SectionId, DockId>> = Object.freeze(
  Object.fromEntries(
    DOCK_IDS.flatMap((dock) => DOCK_SECTIONS[dock].map((id) => [id, dock] as const)),
  ) as Record<SectionId, DockId>,
);

export const dockForSection = (id: SectionId): DockId => SECTION_DOCK[id];

const isSectionId = (value: string): value is SectionId =>
  (SECTION_IDS as readonly string[]).includes(value);

const isDockId = (value: string): value is DockId => (DOCK_IDS as readonly string[]).includes(value);

export const isModuleId = (value: string): value is ModuleId =>
  (MODULE_IDS as readonly string[]).includes(value);

export const isPanelId = (value: string): value is PanelId =>
  (PANEL_IDS as readonly string[]).includes(value);

// ------------------------------------------------------------------ geometry

/**
 * The side panel's width. Fixed, at §11.4's minimum, and here is what that buys.
 *
 * Every pixel of panel is half a pixel of architecture surface:
 *
 *   content   = innerWidth - 64 rail - PANEL_W
 *   module    = content / 2                      (the 50%-of-content rule)
 *   surface   = module - MODULE_CHROME_PX
 *
 * At 280 px a 1920x1080 window (1894 px of viewport) gives 1550 / 775 / 750 of
 * surface, and the full-graph boundary lands at 2314 px of viewport. At §11.4's
 * other end, 320 px, the same window gives 730 and the boundary moves to 2354.
 * Both clear W4's 720 px subsystem band at 1920, so this is a margin decision
 * rather than a threshold one — and the margin is worth having, because the
 * band boundary is measured on a box whose chrome is easy to grow.
 *
 * **The chrome mattered far more than the width, and that is the finding.** At
 * 71 px of nesting — a frame border, a column body's padding, the pane's
 * padding AND a `.panel` inside all of it — a 1920 monitor got 691 px and the
 * causal path, whatever the panel was set to. See {@link MODULE_CHROME_PX}.
 *
 * 280 px holds the panel's own content: 280 - 2 border - 8 padding = 270 px,
 * and the OLED's integer 2x zoom is 256 px.
 */
export const PANEL_W_PX = 280;

/**
 * What stands between the module COLUMN's footprint and the artifact's own box.
 *
 * The module frame's left border (1) plus the pane's own padding (2 x 12). It
 * was 71 px until the panel-inside-a-panel was flattened, and that mattered:
 * at 71 px a 1920x1080 monitor got 691 px of surface and the causal path, and
 * at 25 px it gets 749 px and the subsystem graph. Mirrored in `styles.css`,
 * and the harness measures BOTH boxes and asserts the difference — a constant
 * nobody checks is how a breakpoint derived from it goes quietly wrong.
 */
export const MODULE_CHROME_PX = 25;

/**
 * The narrowest module column this shell will lay out.
 *
 * W4 measured the causal path at 351 px in the old analysis dock and recorded it
 * as *"legible but cramped"*. 376 is the first width above that, and it is what
 * sets {@link COMPACT_MAX_PX}.
 */
export const MODULE_MIN_PX = 376;

/** The stage's own floor, from U5. Mirrored in `styles.css`. */
export const STAGE_MIN_PX = 480;

/**
 * Below this, the panel and the module are SHEETS over the stage.
 *
 *   64 rail + 280 panel + 480 stage floor + 376 module = 1200.
 *
 * That is the first width at which the four boxes the module-first shell is
 * made of all fit side by side. Below it the panel and the module take turns as
 * a sheet, which is the only arrangement a 1000 px window can hold, and §7's
 * area rule gives way to the Compact floors it names as the backstop.
 */
export const COMPACT_MAX_PX = 1199;

/**
 * Above this the ordinary layout holds the WHOLE 63-node architecture graph.
 *
 * This is the boundary's entire meaning, and it is checkable rather than
 * decorative — the harness asserts the graph reaches `full` above it and does
 * not below. W4's `ARCH_BANDS` put the full graph at >= 960 px of surface, so:
 *
 *   surface >= 960  <=>  (innerWidth - 344) / 2 - 25 >= 960
 *                   <=>  innerWidth >= 2314
 *
 * It replaces W3's 1700, which was the width at which two 360 px docks left the
 * stage half the screen — a fact about a regime that no longer exists. Leaving
 * that number in place with its justification deleted is precisely the hollow
 * boundary this project keeps catching.
 */
export const MEDIUM_MAX_PX = 2313;

export function breakpointForWidth(width: number): Breakpoint {
  if (width <= COMPACT_MAX_PX) return 'compact';
  if (width <= MEDIUM_MAX_PX) return 'medium';
  return 'wide';
}

/** True where the panel and the module float over the stage rather than sitting beside it. */
export function sheetsOverStage(breakpoint: Breakpoint): boolean {
  return breakpoint === 'compact';
}

/**
 * The width of the box the stage and the module share, at a given viewport.
 *
 * Written down once, here, because both stage rules and the module's own band
 * are computed from it and a second copy would be a second answer.
 */
export function contentWidthFor(innerWidth: number, breakpoint: Breakpoint): number {
  if (sheetsOverStage(breakpoint)) return innerWidth - 64;
  return innerWidth - 64 - PANEL_W_PX;
}

/**
 * What the architecture artifact's own box measures, as a LOWER BOUND.
 *
 * Conservative on purpose, and by up to 4 px: the pane's own padding is a
 * container query — 10 px below 520 px of pane and 12 px above it (W2) — and
 * {@link MODULE_CHROME_PX} takes the larger. So on a narrow window the real
 * surface is 4 px wider than this says, and never narrower. A band chosen from
 * a number that can only be too small can only scope the representation harder
 * than the rule requires, which is the same direction W4 chose when it measured
 * the artifact's box rather than the pane's.
 */
export function moduleSurfaceWidthFor(innerWidth: number, breakpoint: Breakpoint): number {
  const content = contentWidthFor(innerWidth, breakpoint);
  const stage = Math.max(STAGE_MIN_PX, content / 2);
  return Math.max(0, content - stage - MODULE_CHROME_PX);
}

// -------------------------------------------------------------- stage rules

/**
 * Which of the stage's rules is in force. Published as `data-stage-rule`.
 *
 * §11.2 is explicit that the two cannot be averaged into one loose number, so
 * they are two named regimes and the app says which one it is claiming:
 *
 *  - `area-50` — **no module active.** The stage keeps >= 50% of the VIEWPORT's
 *    area. §7, unchanged, and the rule the shell answers to by default.
 *  - `content-50` — **a module is active.** The stage keeps >= 50% of the
 *    CONTENT area — the viewport minus the rail, the status strip and the side
 *    panel. That is the plain reading of *"with the robot in the other half"*,
 *    and it is achievable at every width above the module's own minimum.
 *  - `focus-exempt` — W4's focus workspace. The brief's sanctioned exception,
 *    claimable only while the pane that justifies it is on screen.
 *
 * A harness that decided the regime for itself would branch on the same
 * condition the layout branches on and could never disagree with it. The app
 * declares; the harness measures the declaration.
 */
export type StageRule = 'area-50' | 'content-50' | 'focus-exempt';

export function stageRuleFor(activeModule: ModuleId | null, focusPane: string | null): StageRule {
  if (focusPane !== null && focusPane !== '') return 'focus-exempt';
  return activeModule === null ? 'area-50' : 'content-50';
}

// ------------------------------------------------------------------- labels

/**
 * The mode label, and the words on it.
 *
 * W3 built `Control | Analyze` as a two-segment switch because the workbench
 * had to hold both domains in one column. There is no switch any more — the
 * rail's module group IS the navigation — but the two top-level concepts the
 * brief asked us to preserve still describe what the reader is doing, so the
 * label survives as a DERIVED value. See {@link modeForState}.
 */
export const MODE_LABEL: Readonly<Record<DockId, string>> = Object.freeze({
  control: 'Control',
  analysis: 'Analyze',
});

/** What each module is called on the rail and on its own title. */
export const MODULE_LABEL: Readonly<Record<ModuleId, string>> = Object.freeze({
  modules: 'Architecture',
  signal: 'Signal',
  source: 'Source',
  learn: 'Learn',
  lab: 'Lab',
});

/**
 * Short enough for the 60 px of usable rail column at the 14 px floor.
 *
 * `Architecture` is 96 px at 14 px and would break mid-word in the one zone
 * this product promises never to hide anything in, so the rail says `Arch` and
 * the module's own title says `Architecture`. The `<button>` keeps the full
 * word in its `title` and its `aria-label`.
 */
export const MODULE_RAIL_LABEL: Readonly<Record<ModuleId, string>> = Object.freeze({
  modules: 'Arch',
  signal: 'Signal',
  source: 'Source',
  learn: 'Learn',
  lab: 'Lab',
});

// -------------------------------------------------------------------- state

export interface ShellState {
  readonly version: 3;
  /**
   * The one active module, per breakpoint. `null` is a real state: the robot
   * gets the whole content area and `data-stage-rule` says `area-50`.
   */
  readonly activeModule: Readonly<Record<Breakpoint, ModuleId | null>>;
  /**
   * Compact only: is the side panel showing as a sheet?
   *
   * Above Compact the panel is always visible and this is not read. At Compact
   * the panel and the module are sheets over the same edge, so opening one
   * closes the other — see {@link withPanelSheet} and {@link withModule}.
   */
  readonly panelSheet: Readonly<Record<Breakpoint, boolean>>;
}

/**
 * What is on screen before anybody has expressed a preference.
 *
 * Above Compact the architecture graph is up, which is §11.1's own diagram and
 * the user's own sentence: *"the architecture diagram needs to use up at least
 * 50% of the screen to be useful, with the robot in the other half."* A default
 * that showed neither would answer the complaint only for readers who went
 * looking.
 *
 * At Compact nothing is: a first-time reader on a small screen should meet the
 * robot, not a sheet over it.
 */
export const DEFAULT_ACTIVE_MODULE: Readonly<Record<Breakpoint, ModuleId | null>> = Object.freeze({
  compact: null,
  medium: 'modules',
  wide: 'modules',
});

export const DEFAULT_SHELL: ShellState = Object.freeze({
  version: 3,
  activeModule: DEFAULT_ACTIVE_MODULE,
  panelSheet: Object.freeze({ compact: false, medium: false, wide: false }),
});

const STORAGE_KEY = 'sesame-lab.shell.v3';

/** Every key this app has ever written, so a stale record cannot linger. */
const LEGACY_STORAGE_KEYS = ['sesame-lab.shell.v2', 'sesame-lab.shell'] as const;

function cleanModule(value: unknown, breakpoint: Breakpoint): ModuleId | null {
  if (value === null) return null;
  if (typeof value !== 'string') return DEFAULT_ACTIVE_MODULE[breakpoint];
  return isModuleId(value) ? value : DEFAULT_ACTIVE_MODULE[breakpoint];
}

/**
 * Read the stored layout.
 *
 * Never throws, and never returns a partially-typed object: anything that is
 * not recognisably this schema is discarded rather than merged, because a
 * half-understood record produces a shell that is confidently wrong about what
 * the reader can see. A v2 record — two docks, a set of open sections and two
 * dock widths — describes a shell that no longer exists and is discarded whole.
 */
export function loadShell(): ShellState {
  let raw: string | null = null;
  try {
    raw = globalThis.localStorage?.getItem(STORAGE_KEY) ?? null;
  } catch {
    return DEFAULT_SHELL;
  }
  if (raw === null) return DEFAULT_SHELL;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== 'object') return DEFAULT_SHELL;
    const candidate = parsed as Partial<ShellState>;
    if (candidate.version !== 3) return DEFAULT_SHELL;
    const stored = (candidate.activeModule ?? {}) as Record<string, unknown>;
    const sheet = (candidate.panelSheet ?? {}) as Record<string, unknown>;
    const readSheet = (breakpoint: Breakpoint): boolean =>
      typeof sheet[breakpoint] === 'boolean' ? (sheet[breakpoint] as boolean) : false;
    return {
      version: 3,
      activeModule: {
        compact: cleanModule(stored.compact, 'compact'),
        medium: cleanModule(stored.medium, 'medium'),
        wide: cleanModule(stored.wide, 'wide'),
      },
      panelSheet: {
        compact: readSheet('compact'),
        medium: false,
        wide: false,
      },
    };
  } catch {
    return DEFAULT_SHELL;
  }
}

/** Persist. A failure here is silent by design: the layout is not the truth. */
export function saveShell(state: ShellState): void {
  try {
    globalThis.localStorage?.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    /* private window, quota, or site data blocked — the shell runs the same */
  }
}

export function clearShell(): void {
  try {
    globalThis.localStorage?.removeItem(STORAGE_KEY);
    for (const key of LEGACY_STORAGE_KEYS) globalThis.localStorage?.removeItem(key);
  } catch {
    /* nothing to do and nothing worth saying */
  }
}

// ------------------------------------------------------------------ updates

export const activeModuleFor = (state: ShellState, breakpoint: Breakpoint): ModuleId | null =>
  state.activeModule[breakpoint];

/**
 * Make one module active, or none.
 *
 * **This is the whole of "one at a time".** There is no set, no accordion and no
 * second flag to keep in step: the field holds one id or `null`, so a state with
 * two modules open is not reachable because it is not representable. That is
 * strictly stronger than a rule that closes the others, which is a rule
 * something can forget to apply.
 *
 * At Compact the module is a sheet over the same edge the panel sheet uses, so
 * showing a module puts the panel sheet away.
 */
export function withModule(
  state: ShellState,
  breakpoint: Breakpoint,
  id: ModuleId | null,
): ShellState {
  if (state.activeModule[breakpoint] === id && !(id !== null && state.panelSheet[breakpoint])) {
    return state;
  }
  return {
    ...state,
    activeModule: { ...state.activeModule, [breakpoint]: id },
    panelSheet: {
      ...state.panelSheet,
      [breakpoint]: id === null ? state.panelSheet[breakpoint] : false,
    },
  };
}

/** Click the active module again and it goes away — the robot takes the content area. */
export function toggleModule(
  state: ShellState,
  breakpoint: Breakpoint,
  id: ModuleId,
): ShellState {
  return withModule(state, breakpoint, state.activeModule[breakpoint] === id ? null : id);
}

/**
 * Compact only: show or hide the side panel as a sheet.
 *
 * Above Compact the panel is always visible, so this is a no-op there rather
 * than a state that could hide a correctness surface. The panel carries the
 * driving provenance, the origin and `PHYSICAL HARDWARE: NONE`; a zone that can
 * be closed is a zone that can hide them, which is the same argument that keeps
 * the rail from ever collapsing.
 */
export function withPanelSheet(
  state: ShellState,
  breakpoint: Breakpoint,
  open: boolean,
): ShellState {
  if (!sheetsOverStage(breakpoint)) return state;
  if (state.panelSheet[breakpoint] === open) return state;
  return {
    ...state,
    panelSheet: { ...state.panelSheet, [breakpoint]: open },
    activeModule: { ...state.activeModule, [breakpoint]: open ? null : state.activeModule[breakpoint] },
  };
}

/** True where the side panel has a laid-out box a reader can see. */
export function panelIsVisible(state: ShellState, breakpoint: Breakpoint): boolean {
  return sheetsOverStage(breakpoint) ? state.panelSheet[breakpoint] : true;
}

/** Expanded AND on screen — what a reader can actually see, for any pane. */
export function sectionIsVisible(
  state: ShellState,
  breakpoint: Breakpoint,
  id: SectionId,
): boolean {
  if (isPanelId(id)) return panelIsVisible(state, breakpoint);
  return state.activeModule[breakpoint] === id;
}

/**
 * Which mode the shell is in — W3's `Control | Analyze`, generalised.
 *
 * DERIVED, never stored, and now derived from ONE field instead of a list. The
 * active module belongs to exactly one domain, so it already says which mode is
 * showing; with no module active the reader is driving the robot from the side
 * panel, which is `control` by the same reading order this shell has always
 * used — the robot, then the surfaces that drive it, then the ones that explain
 * it.
 *
 * The consequence worth stating: the mode survives a reload for free, because
 * the active module does, and `mode: 'analyze'` with the Lab up is a state this
 * shell cannot represent.
 */
export function modeForState(state: ShellState, breakpoint: Breakpoint): DockId {
  const active = state.activeModule[breakpoint];
  return active === null ? 'control' : dockForSection(active);
}

// -------------------------------------------------------- the §5 mitigation

/**
 * Which pane a selection wants to be seen in.
 *
 * §5 of the U6 plan is still the one real risk: clicking `R4` in the 3D scene
 * highlights it in the graph, the trace and the inspector, and if the pane that
 * shows it is not on screen the app appears to do nothing. A node or joint
 * selection is loudest in the architecture graph; a bare symbol selection — one
 * with no node, which is two thirds of the outline — is only visible in the
 * source pane.
 *
 * Both are MODULES, which is what keeps the auto-reveal from ever disturbing
 * the side panel: a selection is a thing to read about, never a reason to take
 * the commands away. The inspector reads the same selection and is on the panel
 * permanently, so it needs no reveal at all.
 *
 * Returns `null` for the empty selection: deselecting must not open anything.
 */
export function moduleForSelection(selection: {
  readonly joint: string | null;
  readonly nodeId: string | null;
  readonly symbolId: string | null;
}): ModuleId | null {
  if (selection.nodeId !== null || selection.joint !== null) return 'modules';
  if (selection.symbolId !== null) return 'source';
  return null;
}

/** Kept under its U6 name for the debug hook and the harness. */
export const sectionForSelection = moduleForSelection;

/** Parse a section id that came from an attribute or a debug call. */
export function parseSectionId(value: string): SectionId | null {
  return isSectionId(value) ? value : null;
}

/** Parse a dock id that came from an attribute or a debug call. */
export function parseDockId(value: string): DockId | null {
  return isDockId(value) ? value : null;
}

/** Parse a module id that came from an attribute or a debug call. */
export function parseModuleId(value: string): ModuleId | null {
  return isModuleId(value) ? value : null;
}

/**
 * Which module a `setDockOpen(dock, true)` should show — kept for the debug
 * hook, which eight harness phases drive the shell through.
 *
 * `analysis` means "show me something that explains this robot", and the first
 * of those is the architecture graph. `control` has exactly one module (the
 * Lab); opening it is NOT the same as wanting the Lab, so it clears the module
 * instead and leaves the reader with the robot and the side panel — which is
 * what the control domain now IS.
 */
export function moduleForDock(dock: DockId): ModuleId | null {
  return dock === 'analysis' ? 'modules' : null;
}
