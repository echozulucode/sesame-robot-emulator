/**
 * The shell's layout state: which breakpoint we are at, which dock sections are
 * open, and how wide the dock is.
 *
 * ## Why this module exists at all
 *
 * `styles.css` had 2,407 lines and zero `@media` queries, and `.app` was a
 * `minmax(0,1fr) minmax(0,520px) 400px` grid with a fixed 380 px source row.
 * On a 1440x900 laptop that leaves the 3D viewport roughly 500x280 — about 13%
 * of the screen — and the robot is the product. That is a layout defect, and
 * the reason it survived is that all 26 harness captures run at 1440x900 or
 * wider and **none of them asserted how much space the viewport got**.
 *
 * So the shell is three zones: a 56 px rail that never collapses, a stage that
 * gets every pixel nothing else claimed, and a right dock of accordion
 * sections. The rules that make the laptop case work are here rather than in
 * CSS, because two of them are decisions rather than styling:
 *
 *  1. **At Medium the dock overlays; it does not push.** The stage keeps its
 *     full width and the dock floats above it. That is what buys the laptop its
 *     robot back, and it is asserted by measuring the stage's width with the
 *     dock shut and again with it open.
 *  2. **Compact and Medium hold one open section; Wide restores a set.** The
 *     cross-highlight — click `R4` in 3D, see it in the graph, the trace and the
 *     inspector — is the feature Phase 2 spent the most effort on, and a
 *     collapsed section is where a highlight goes to be invisible. Hence
 *     {@link sectionForSelection} and the header badges: the selection is
 *     always either on screen or summarised on a header that is.
 *
 * ## Storage
 *
 * `localStorage`, defensively, on exactly the terms `src/lessons/progress.ts`
 * and `src/lab/lab-doc.ts` set: every read and every write is wrapped, the
 * accessor itself can throw in a private window with site data blocked, the
 * value can be absent, and it can be somebody else's JSON. All three render the
 * same way — the defaults below — and none of them is an error anybody has to
 * see. A layout preference is a convenience, never the source of truth.
 */

/** Keyed to what fits, not to device names. */
export type Breakpoint = 'compact' | 'medium' | 'wide';

/**
 * The dock's accordion sections, in the order they are drawn.
 *
 * Six, and they are exactly the panes that used to be columns and rows around
 * the viewport. `inspector` carries what the old `.sidebar` carried minus the
 * OLED and the command grid, both of which moved onto the stage — the OLED
 * because the plan puts it there, the commands because a button that drives the
 * robot belongs beside the robot and must be reachable at every breakpoint
 * without opening anything.
 */
export const SECTION_IDS = ['inspector', 'modules', 'signal', 'source', 'learn', 'lab'] as const;
export type SectionId = (typeof SECTION_IDS)[number];

const isSectionId = (value: string): value is SectionId =>
  (SECTION_IDS as readonly string[]).includes(value);

export const DOCK_MIN_PX = 320;
export const DOCK_MAX_PX = 520;
export const DOCK_DEFAULT_PX = 460;

/** Below this the dock cannot sit beside the stage at all. */
export const COMPACT_MAX_PX = 899;
/** Above this the dock is docked rather than floating. */
export const MEDIUM_MAX_PX = 1440;

export function breakpointForWidth(width: number): Breakpoint {
  if (width <= COMPACT_MAX_PX) return 'compact';
  if (width <= MEDIUM_MAX_PX) return 'medium';
  return 'wide';
}

/** Compact and Medium hold exactly one open section. Wide holds a set. */
export function isSingleOpen(breakpoint: Breakpoint): boolean {
  return breakpoint !== 'wide';
}

/**
 * What is open before anybody has expressed a preference.
 *
 * Wide opens `modules` and `signal` together on purpose: V8's whole argument
 * for splitting the workbench in half was that the architecture graph and the
 * causal trace have to be visible **at the same time**, because the
 * cross-highlight is the feature and a scroll between them destroys it. The
 * inspector joins them because it is the third reader of the same selection.
 */
export const DEFAULT_OPEN: Readonly<Record<Breakpoint, readonly SectionId[]>> = Object.freeze({
  compact: ['modules'],
  medium: ['modules'],
  wide: ['inspector', 'modules', 'signal'],
});

/** The dock starts visible only where it costs the stage nothing. */
export const DEFAULT_DOCK_OPEN: Readonly<Record<Breakpoint, boolean>> = Object.freeze({
  compact: false,
  medium: false,
  wide: true,
});

export interface ShellState {
  readonly version: 1;
  /** Open sections, per breakpoint. Persisted per breakpoint, as the plan asks. */
  readonly open: Readonly<Record<Breakpoint, readonly SectionId[]>>;
  /** Whether the dock itself is showing, per breakpoint. */
  readonly dockOpen: Readonly<Record<Breakpoint, boolean>>;
  /** Wide only. Clamped to [320, 520] on the way in and on the way out. */
  readonly dockWidthPx: number;
}

export const DEFAULT_SHELL: ShellState = Object.freeze({
  version: 1,
  open: DEFAULT_OPEN,
  dockOpen: DEFAULT_DOCK_OPEN,
  dockWidthPx: DOCK_DEFAULT_PX,
});

const STORAGE_KEY = 'sesame-lab.shell.v1';

export const clampDockWidth = (px: number): number =>
  !Number.isFinite(px) ? DOCK_DEFAULT_PX : Math.max(DOCK_MIN_PX, Math.min(DOCK_MAX_PX, Math.round(px)));

/** Keep only real section ids, keep their canonical order, and drop duplicates. */
function cleanSections(value: unknown, breakpoint: Breakpoint): readonly SectionId[] {
  if (!Array.isArray(value)) return DEFAULT_OPEN[breakpoint];
  const kept = SECTION_IDS.filter((id) => value.includes(id));
  // One open section is the rule below Wide; a stored two-element list from a
  // wider window must not be able to smuggle a second one back in.
  if (isSingleOpen(breakpoint)) return kept.slice(0, 1);
  return kept;
}

/**
 * Read the stored layout.
 *
 * Never throws, and never returns a partially-typed object: anything that is
 * not recognisably this schema is discarded rather than merged, because a
 * half-understood record produces a shell that is confidently wrong about what
 * the reader can see.
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
    if (candidate.version !== 1) return DEFAULT_SHELL;
    const storedOpen = (candidate.open ?? {}) as Record<string, unknown>;
    const storedDock = (candidate.dockOpen ?? {}) as Record<string, unknown>;
    const open: Record<Breakpoint, readonly SectionId[]> = {
      compact: cleanSections(storedOpen.compact, 'compact'),
      medium: cleanSections(storedOpen.medium, 'medium'),
      wide: cleanSections(storedOpen.wide, 'wide'),
    };
    const dockOpen: Record<Breakpoint, boolean> = {
      compact: typeof storedDock.compact === 'boolean' ? storedDock.compact : DEFAULT_DOCK_OPEN.compact,
      medium: typeof storedDock.medium === 'boolean' ? storedDock.medium : DEFAULT_DOCK_OPEN.medium,
      wide: typeof storedDock.wide === 'boolean' ? storedDock.wide : DEFAULT_DOCK_OPEN.wide,
    };
    return {
      version: 1,
      open,
      dockOpen,
      dockWidthPx:
        typeof candidate.dockWidthPx === 'number' ? clampDockWidth(candidate.dockWidthPx) : DOCK_DEFAULT_PX,
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
  } catch {
    /* nothing to do and nothing worth saying */
  }
}

// ------------------------------------------------------------------ updates

/** Open or close one section, honouring the one-at-a-time rule below Wide. */
export function withSection(
  state: ShellState,
  breakpoint: Breakpoint,
  id: SectionId,
  open: boolean,
): ShellState {
  const current = state.open[breakpoint];
  let next: readonly SectionId[];
  if (!open) next = current.filter((s) => s !== id);
  else if (isSingleOpen(breakpoint)) next = [id];
  else next = SECTION_IDS.filter((s) => s === id || current.includes(s));
  if (next.length === current.length && next.every((s, i) => s === current[i])) return state;
  return { ...state, open: { ...state.open, [breakpoint]: next } };
}

export function withDockOpen(state: ShellState, breakpoint: Breakpoint, open: boolean): ShellState {
  if (state.dockOpen[breakpoint] === open) return state;
  return { ...state, dockOpen: { ...state.dockOpen, [breakpoint]: open } };
}

export function withDockWidth(state: ShellState, px: number): ShellState {
  const clamped = clampDockWidth(px);
  if (state.dockWidthPx === clamped) return state;
  return { ...state, dockWidthPx: clamped };
}

export const sectionIsOpen = (state: ShellState, breakpoint: Breakpoint, id: SectionId): boolean =>
  state.open[breakpoint].includes(id);

// -------------------------------------------------------- the §5 mitigation

/**
 * Which section a selection wants to be seen in.
 *
 * §5 of the plan is the one real risk in the whole change: clicking `R4` in the
 * 3D scene highlights it in the graph, the trace and the inspector, and **if
 * those sections are collapsed the highlight happens where nobody can see it**,
 * so the app appears to do nothing. A node or joint selection is loudest in the
 * architecture graph, which is the pane that redraws around it; a bare symbol
 * selection — one with no node, which is two thirds of the outline — is only
 * visible in the source pane.
 *
 * Returns `null` for the empty selection: deselecting must not open anything.
 */
export function sectionForSelection(selection: {
  readonly joint: string | null;
  readonly nodeId: string | null;
  readonly symbolId: string | null;
}): SectionId | null {
  if (selection.nodeId !== null || selection.joint !== null) return 'modules';
  if (selection.symbolId !== null) return 'source';
  return null;
}

/** Parse a section id that came from an attribute or a debug call. */
export function parseSectionId(value: string): SectionId | null {
  return isSectionId(value) ? value : null;
}
