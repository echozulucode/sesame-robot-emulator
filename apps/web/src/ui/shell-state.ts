/**
 * The shell's layout state: which breakpoint we are at, which sections are open
 * in which of the two docks, and how wide each dock is.
 *
 * ## Why this module exists at all
 *
 * `styles.css` had 2,407 lines and zero `@media` queries, and `.app` was a
 * `minmax(0,1fr) minmax(0,520px) 400px` grid with a fixed 380 px source row.
 * On a 1440x900 laptop that leaves the 3D viewport roughly 500x280 — about 13%
 * of the screen — and the robot is the product. That is a layout defect, and
 * the reason it survived is that all 26 harness captures ran at 1440x900 or
 * wider and **none of them asserted how much space the viewport got**.
 *
 * U1–U5 answered that with a rail, a stage and one right dock, and put the
 * command vocabulary and the OLED in a fixed strip under the robot. The strip
 * was the wrong answer: it cost `clamp(120px, 20vh, 176px)` of the one thing
 * the change existed to give back. So it is gone, and the two panes that lived
 * in it moved into a **second dock**:
 *
 * ```text
 *  rail |            stage            | control dock | analysis dock
 *   56  |  robot, then a status line  |  drives it   |  explains it
 * ```
 *
 * The control dock is INBOARD — adjacent to the stage — so the reading order is
 * robot, then the things that drive it, then the things that explain it.
 *
 * The rules that make the laptop case work are here rather than in CSS, because
 * they are decisions rather than styling:
 *
 *  1. **Below Wide there is ONE workbench, in flow, and the stage really
 *     shrinks** — Phase 4 W3. U6 floated two docks over the stage so it never
 *     lost a pixel; the user replaced that with a better rule, *"I'd rather the
 *     robot area shrink, 50% of the screen area is more than enough"*, and that
 *     rule makes two docks impossible on a laptop at any usable width and one
 *     540 px workbench comfortable. So the overlay is retired above 1100 px,
 *     the two docks become two MODES of one workbench, and what is asserted is
 *     the stage's share of the screen AREA rather than the absence of a push.
 *  2. **Below Wide exactly ONE section is open and it gets the whole
 *     workbench.** Choosing `Learn` closes `Commands`. One pane at a time, at
 *     its natural height, inside a single scroller — because the reader's words
 *     were "I'd rather have to scroll through the pane vertically on smaller
 *     screens than tiny content and many scrollbars". At Wide both docks are in
 *     flow and both hold a set, which is what keeps V8's cross-highlight
 *     requirement true.
 *  3. **The cross-highlight** — click `R4` in 3D, see it in the graph, the
 *     trace and the inspector — is the feature Phase 2 spent the most effort
 *     on, and a collapsed section is where a highlight goes to be invisible.
 *     Hence {@link sectionForSelection} and the header badges: the selection is
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
 * Two docks.
 *
 * `control` is the surface that DRIVES this robot — the command vocabulary, the
 * 128x64 face, and the Lab. `analysis` is the surface that EXPLAINS it — the
 * inspector, the architecture graph, the causal trace, the source and the
 * lessons. They are drawn in that order, left to right, so the control dock is
 * the one adjacent to the stage.
 */
export const DOCK_IDS = ['control', 'analysis'] as const;
export type DockId = (typeof DOCK_IDS)[number];

/**
 * The accordion sections, in the order they are drawn.
 *
 * `commands` and `face` used to be a fixed strip under the robot; `lab` moved
 * across from the analysis dock because it is a driving surface rather than a
 * reading one, and because the pane that authors the OLED's pixels now sits
 * next to the OLED it authors.
 */
export const SECTION_IDS = [
  'commands',
  'face',
  'lab',
  'inspector',
  'modules',
  'signal',
  'source',
  'learn',
] as const;
export type SectionId = (typeof SECTION_IDS)[number];

/** Which dock draws which sections. Contiguous in {@link SECTION_IDS}. */
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

export const DOCK_MIN_PX = 320;
export const DOCK_MAX_PX = 560;
/** Used when a stored width is not a number at all. */
export const DOCK_FALLBACK_PX = 420;

/**
 * Per-dock defaults at Wide, where the docks are in flow.
 *
 * The control dock is the narrower of the two: a command grid, a 128x64 panel
 * and the Lab's editors need less room than a 429-line source pane.
 */
export const DOCK_DEFAULT_PX: Readonly<Record<DockId, number>> = Object.freeze({
  control: 400,
  analysis: 460,
});

/**
 * The workbench's width, and the three numbers the brief gives for it.
 *
 * Mirrored in `styles.css` as `--workbench-w: clamp(500px, 37.5vw, 560px)`,
 * which is exactly this triple: 37.5vw is 540 px at 1440 - the brief's target -
 * and the clamp is what keeps a 1280 px laptop from spending more on the
 * workbench than the 50%-area rule leaves it.
 */
export const WORKBENCH_MIN_PX = 500;
export const WORKBENCH_TARGET_PX = 540;
export const WORKBENCH_MAX_PX = 560;

/**
 * Below this the workbench cannot sit beside the stage AT ALL - Phase 4 W3.
 *
 * It was 899, which was the width below which a *dock* could not sit beside the
 * stage. The workbench is bigger than a dock and it is IN FLOW, so the number
 * that matters is different arithmetic and it is worth writing out:
 *
 *   64 px rail + 500 px workbench (its minimum) + 480 px stage floor = 1044.
 *
 * That is the floor arithmetic, but it is not the binding one. §7's rule is
 * that the stage keeps >= 50% of the screen AREA, and with a 32 px status strip
 * the stage needs about 52.5% of the WIDTH to get there. At a window of width W
 * that allows a workbench of at most 0.476W - 64 px, and 500 px - the brief's
 * minimum - stops fitting at about 1185 px.
 *
 * So 1200 is the first width at which one in-flow workbench, the brief's 500 px
 * floor for it and the user's 50%-area rule are all satisfiable at once. Below
 * it the workbench goes back to being a sheet over the stage, which is the only
 * thing a 1000 px window can hold, and §7 does not apply there - it says
 * "Medium and above" and keeps the Compact floors as the backstop instead.
 */
export const COMPACT_MAX_PX = 1199;

/**
 * Above this the two docks come back - Phase 4 W3, §3 of the plan.
 *
 * It was 1440. The user's rule is that the stage keeps >= 50% of the screen
 * AREA, and two in-flow docks cannot do that on a laptop at any usable dock
 * width (43.9% at 360+360, 49.3% at 320+320, both at 1440x900). At 1700 px two
 * 360 px docks plus a 64 px rail still leave >= 1276 px of stage, which clears
 * 50% comfortably - so the two-dock shell U6 built is not deleted, it is the
 * WIDE-DESKTOP regime, and this is the width at which it starts being true.
 */
export const MEDIUM_MAX_PX = 1699;

export function breakpointForWidth(width: number): Breakpoint {
  if (width <= COMPACT_MAX_PX) return 'compact';
  if (width <= MEDIUM_MAX_PX) return 'medium';
  return 'wide';
}

/**
 * Compact and Medium hold exactly one open section, and therefore exactly one
 * open dock. Wide holds a set in each of two docks that are both in flow.
 *
 * Below Wide there is only ONE dock on screen now - the workbench - so "across
 * both docks" has become "in the workbench", which is what the rule always
 * meant. `[data-sections='one'|'many']` is published from this predicate and
 * W2's pane rules read it; nothing that reads it had to change.
 */
export function isSingleOpen(breakpoint: Breakpoint): boolean {
  return breakpoint !== 'wide';
}

/**
 * True where the shell draws ONE workbench instead of two docks - Phase 4 W3.
 *
 * The same predicate as {@link isSingleOpen} today, and deliberately a separate
 * name: one is about how many panes share a column's height, the other is about
 * how many columns there are. They agree now because a workbench holds one pane
 * at a time; they are not the same statement and a future regime could split
 * them.
 */
export function usesWorkbench(breakpoint: Breakpoint): boolean {
  return breakpoint !== 'wide';
}

/**
 * The workbench's two modes, and the words on the switch.
 *
 * The brief: *"preserve Control and Analyze as top-level concepts, but make
 * them two modes of a single laptop workbench"*. They are the same two domains
 * U6 split the docks along, so the mode IS the {@link DockId} - there is no
 * second taxonomy to keep in step with the first, and at Wide the identical
 * split draws as two columns instead of two modes.
 *
 * "Analyze" rather than "Analysis" because the brief writes the switch as
 * `CONTROL | ANALYZE`, two verbs; the dock's own aria label keeps the noun.
 */
export const MODE_LABEL: Readonly<Record<DockId, string>> = Object.freeze({
  control: 'Control',
  analysis: 'Analyze',
});

/**
 * What is open before anybody has expressed a preference.
 *
 * Wide opens `modules` and `signal` together on purpose: V8's whole argument
 * for splitting the workbench in half was that the architecture graph and the
 * causal trace have to be visible **at the same time**, because the
 * cross-highlight is the feature and a scroll between them destroys it. The
 * inspector joins them because it is the third reader of the same selection,
 * and `commands` joins them from the other dock because a button that drives
 * the robot should not need a click to find.
 */
export const DEFAULT_OPEN: Readonly<Record<Breakpoint, readonly SectionId[]>> = Object.freeze({
  compact: ['commands'],
  medium: ['commands'],
  wide: ['commands', 'face', 'inspector', 'modules', 'signal'],
});

/**
 * Which docks start visible.
 *
 * At Compact neither does: the workbench is a SHEET over the stage there, and a
 * first-time reader should meet the robot rather than a panel over it. The
 * quick-run cluster in the status bar under the stage is what keeps a command
 * one click away at that width — see `ui/StatusBar.tsx`.
 *
 * At Medium the workbench starts OPEN, and that is a Phase 4 W3 change with a
 * reason. U6 started it shut because it was an overlay: a panel floating over
 * the robot on first paint is a panel in the way. In flow it is not in the way
 * — it takes 540 px and leaves the stage 56% of the screen, which is the whole
 * point of §3 — and a reader who meets an empty rail has to guess that the
 * product has any panes at all.
 */
export const DEFAULT_DOCK_OPEN: Readonly<Record<DockId, Readonly<Record<Breakpoint, boolean>>>> =
  Object.freeze({
    control: Object.freeze({ compact: false, medium: true, wide: true }),
    analysis: Object.freeze({ compact: false, medium: false, wide: true }),
  });

export interface ShellState {
  readonly version: 2;
  /** Open sections across both docks, per breakpoint. */
  readonly open: Readonly<Record<Breakpoint, readonly SectionId[]>>;
  /** Whether each dock is showing, per breakpoint. */
  readonly dockOpen: Readonly<Record<DockId, Readonly<Record<Breakpoint, boolean>>>>;
  /** Wide only. Clamped to [320, 560] on the way in and on the way out. */
  readonly dockWidthPx: Readonly<Record<DockId, number>>;
}

export const DEFAULT_SHELL: ShellState = Object.freeze({
  version: 2,
  open: DEFAULT_OPEN,
  dockOpen: DEFAULT_DOCK_OPEN,
  dockWidthPx: DOCK_DEFAULT_PX,
});

const STORAGE_KEY = 'sesame-lab.shell.v2';

export const clampDockWidth = (px: number): number =>
  !Number.isFinite(px) ? DOCK_FALLBACK_PX : Math.max(DOCK_MIN_PX, Math.min(DOCK_MAX_PX, Math.round(px)));

/**
 * Keep only real section ids, keep their canonical order, drop duplicates, and
 * below Wide keep at most one per dock.
 *
 * A stored two-element list from a wider window must not be able to smuggle a
 * second open section into one of Medium's docks.
 */
function cleanSections(value: unknown, breakpoint: Breakpoint): readonly SectionId[] {
  if (!Array.isArray(value)) return DEFAULT_OPEN[breakpoint];
  const kept = SECTION_IDS.filter((id) => value.includes(id));
  return isSingleOpen(breakpoint) ? kept.slice(0, 1) : kept;
}

/** Below Wide at most one dock is open; a stored record must not say otherwise. */
function cleanDockOpen(
  value: unknown,
  breakpoint: Breakpoint,
): Record<DockId, boolean> {
  const stored = (value ?? {}) as Record<string, unknown>;
  const read = (dock: DockId): boolean => {
    const perBreakpoint = (stored[dock] ?? {}) as Record<string, unknown>;
    const flag = perBreakpoint[breakpoint];
    return typeof flag === 'boolean' ? flag : DEFAULT_DOCK_OPEN[dock][breakpoint];
  };
  const control = read('control');
  const analysis = read('analysis');
  if (isSingleOpen(breakpoint) && control && analysis) return { control: false, analysis };
  return { control, analysis };
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
    if (candidate.version !== 2) return DEFAULT_SHELL;
    const storedOpen = (candidate.open ?? {}) as Record<string, unknown>;
    const open: Record<Breakpoint, readonly SectionId[]> = {
      compact: cleanSections(storedOpen.compact, 'compact'),
      medium: cleanSections(storedOpen.medium, 'medium'),
      wide: cleanSections(storedOpen.wide, 'wide'),
    };
    const perBreakpoint = {
      compact: cleanDockOpen(candidate.dockOpen, 'compact'),
      medium: cleanDockOpen(candidate.dockOpen, 'medium'),
      wide: cleanDockOpen(candidate.dockOpen, 'wide'),
    };
    const dockOpen: Record<DockId, Record<Breakpoint, boolean>> = {
      control: {
        compact: perBreakpoint.compact.control,
        medium: perBreakpoint.medium.control,
        wide: perBreakpoint.wide.control,
      },
      analysis: {
        compact: perBreakpoint.compact.analysis,
        medium: perBreakpoint.medium.analysis,
        wide: perBreakpoint.wide.analysis,
      },
    };
    const storedWidth = (candidate.dockWidthPx ?? {}) as Record<string, unknown>;
    const dockWidthPx: Record<DockId, number> = {
      control:
        typeof storedWidth.control === 'number'
          ? clampDockWidth(storedWidth.control)
          : DOCK_DEFAULT_PX.control,
      analysis:
        typeof storedWidth.analysis === 'number'
          ? clampDockWidth(storedWidth.analysis)
          : DOCK_DEFAULT_PX.analysis,
    };
    return { version: 2, open, dockOpen, dockWidthPx };
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

const sameList = (a: readonly SectionId[], b: readonly SectionId[]): boolean =>
  a.length === b.length && a.every((s, i) => s === b[i]);

/**
 * Open or close one section, honouring the one-at-a-time rule below Wide.
 *
 * "One at a time" is PER DOCK. Opening `commands` in the control dock at Medium
 * does not close `learn` in the analysis dock — the two docks are independent
 * accordions, and that independence is the whole reason there are two.
 */
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
  if (sameList(next, current)) return state;
  const withOpen = { ...state, open: { ...state.open, [breakpoint]: next } };
  // Below Wide the one open section decides which dock is showing: opening
  // `Commands` shuts the analysis dock, and opening `Learn` shuts the control
  // dock. Anything else would leave a dock open with nothing expanded in it.
  if (!open || !isSingleOpen(breakpoint)) return withOpen;
  const dock = dockForSection(id);
  const other: DockId = dock === 'control' ? 'analysis' : 'control';
  return {
    ...withOpen,
    dockOpen: {
      ...withOpen.dockOpen,
      [dock]: { ...withOpen.dockOpen[dock], [breakpoint]: true },
      [other]: { ...withOpen.dockOpen[other], [breakpoint]: false },
    },
  };
}

/**
 * Show or hide one dock.
 *
 * Below Wide, opening one dock shuts the other, and if the dock being opened
 * has nothing expanded in it, its first section is expanded — otherwise a
 * reader who clicks the chevron gets a column of collapsed headers and no
 * content. At Wide both docks are in flow and both stay open.
 */
export function withDockOpen(
  state: ShellState,
  dock: DockId,
  breakpoint: Breakpoint,
  open: boolean,
): ShellState {
  const other: DockId = dock === 'control' ? 'analysis' : 'control';
  const exclusive = open && isSingleOpen(breakpoint);
  let next: ShellState = state;
  if (state.dockOpen[dock][breakpoint] !== open || (exclusive && state.dockOpen[other][breakpoint])) {
    next = {
      ...state,
      dockOpen: {
        ...state.dockOpen,
        [dock]: { ...state.dockOpen[dock], [breakpoint]: open },
        ...(exclusive ? { [other]: { ...state.dockOpen[other], [breakpoint]: false } } : {}),
      },
    };
  }
  if (!open) return next;
  const showsSomething = next.open[breakpoint].some((id) => dockForSection(id) === dock);
  if (showsSomething) return next;
  const first = DOCK_SECTIONS[dock][0];
  return first === undefined ? next : withSection(next, breakpoint, first, true);
}

export function withDockWidth(state: ShellState, dock: DockId, px: number): ShellState {
  const clamped = clampDockWidth(px);
  if (state.dockWidthPx[dock] === clamped) return state;
  return { ...state, dockWidthPx: { ...state.dockWidthPx, [dock]: clamped } };
}

export const sectionIsOpen = (state: ShellState, breakpoint: Breakpoint, id: SectionId): boolean =>
  state.open[breakpoint].includes(id);

export const dockIsOpen = (state: ShellState, breakpoint: Breakpoint, dock: DockId): boolean =>
  state.dockOpen[dock][breakpoint];

/** Expanded AND its dock showing — what a reader can actually see. */
export const sectionIsVisible = (
  state: ShellState,
  breakpoint: Breakpoint,
  id: SectionId,
): boolean => sectionIsOpen(state, breakpoint, id) && dockIsOpen(state, breakpoint, dockForSection(id));

/**
 * Which mode the workbench is in — Phase 4 W3.
 *
 * DERIVED, never stored. Below Wide exactly one section is open, and a section
 * belongs to exactly one dock, so the open section already says which mode is
 * showing. Storing it separately would create a second source of truth that can
 * disagree with the first — "mode: analyze, open section: commands" is a state
 * this shell simply cannot reach — and it would need its own migration, its own
 * validation and its own clean-up in {@link loadShell}.
 *
 * The consequence worth stating: the mode survives a reload for free, because
 * the open section does.
 *
 * With nothing open (the reader collapsed the workbench and then closed its
 * pane) the mode falls back to whichever dock is showing, and then to
 * `control` — the reading order this shell has always used is the robot, then
 * the surfaces that drive it, then the surfaces that explain it.
 */
export function modeForState(state: ShellState, breakpoint: Breakpoint): DockId {
  const open = state.open[breakpoint][0];
  if (open !== undefined) return dockForSection(open);
  return state.dockOpen.analysis[breakpoint] && !state.dockOpen.control[breakpoint]
    ? 'analysis'
    : 'control';
}

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
 * Both live in the ANALYSIS dock, which is why the auto-expand never disturbs
 * the control dock: a selection is a thing to read about, not a thing to drive.
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

/** Parse a dock id that came from an attribute or a debug call. */
export function parseDockId(value: string): DockId | null {
  return isDockId(value) ? value : null;
}
