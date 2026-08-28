/**
 * The responsive shell's state, and the three ways `localStorage` fails.
 *
 * Same terms as `lessons.test.ts` and `lab.test.ts`, because the shell's
 * persistence is deliberately the same shape as theirs: the accessor itself can
 * throw in a private window with site data blocked, the value can be absent,
 * and it can be somebody else's JSON. All three must render the documented
 * defaults, and none of them is an error anybody has to see.
 *
 * The breakpoint table is tested at its EDGES rather than in the middle,
 * because 1440 is the width the whole change exists for: a laptop at exactly
 * 1440 must be Medium — where the docks overlay — and not Wide, where they
 * would take 820 px out of the stage and give back the bug.
 *
 * The two-dock rules get their own describes, because they are the ones a
 * reader complained about twice: one section open at a time across BOTH docks
 * below Wide, and one dock open at a time, so the open pane gets the full
 * height and the full width of the overlay.
 */
import { afterEach, describe, expect, it } from 'vitest';

import {
  breakpointForWidth,
  clampDockWidth,
  clearShell,
  DEFAULT_OPEN,
  DEFAULT_SHELL,
  DOCK_DEFAULT_PX,
  DOCK_FALLBACK_PX,
  DOCK_IDS,
  DOCK_MAX_PX,
  DOCK_MIN_PX,
  DOCK_SECTIONS,
  dockForSection,
  dockIsOpen,
  isSingleOpen,
  loadShell,
  parseDockId,
  parseSectionId,
  saveShell,
  SECTION_IDS,
  sectionForSelection,
  sectionIsOpen,
  sectionIsVisible,
  withDockOpen,
  withDockWidth,
  withSection,
  modeForState,
  MODE_LABEL,
  usesWorkbench,
  WORKBENCH_MAX_PX,
  WORKBENCH_MIN_PX,
  WORKBENCH_TARGET_PX,
  type ShellState,
} from '../ui/shell-state.js';
import {
  environmentHardware,
  environmentSystemName,
  PRIMARY_COMMANDS,
  primaryCommandCount,
  primaryCommandsAreInVocabulary,
} from '../ui/StatusBar.js';

const STORAGE_KEY = 'sesame-lab.shell.v2';

/** `globalThis.localStorage` does not exist under Node, so it is installed. */
function installStorage(store = new Map<string, string>()): Map<string, string> {
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
    },
  });
  return store;
}

afterEach(() => {
  Reflect.deleteProperty(globalThis, 'localStorage');
});

describe('breakpoints', () => {
  it('puts the laptop the bug was reported on in Medium, not Wide', () => {
    expect(breakpointForWidth(1440)).toBe('medium');
    expect(breakpointForWidth(1280)).toBe('medium');
    expect(breakpointForWidth(2560)).toBe('wide');
  });

  it('moves the two-dock regime up to 1700 — Phase 4 W3, by arithmetic', () => {
    // Two 360 px docks and a 64 px rail leave a 1440 px laptop 43.9% of its
    // screen area, and two 320 px docks leave 49.3%. The user's rule is 50%, so
    // two docks in flow are simply not available on a laptop; at 1700 they
    // leave >= 1276 px of stage and they are.
    expect(breakpointForWidth(1600)).toBe('medium');
    expect(breakpointForWidth(1699)).toBe('medium');
    expect(breakpointForWidth(1700)).toBe('wide');
  });

  it('closes Compact at 1199 and opens Medium at 1200', () => {
    // 64 px rail + the brief's 500 px workbench minimum + a stage that still
    // holds half the screen area stops fitting at about 1185 px. Below that the
    // workbench is a sheet again, which is the only thing that fits.
    expect(breakpointForWidth(1199)).toBe('compact');
    expect(breakpointForWidth(1200)).toBe('medium');
    expect(breakpointForWidth(899)).toBe('compact');
    expect(breakpointForWidth(320)).toBe('compact');
  });

  it('draws one workbench below Wide and two docks at and above it', () => {
    expect(usesWorkbench('compact')).toBe(true);
    expect(usesWorkbench('medium')).toBe(true);
    expect(usesWorkbench('wide')).toBe(false);
  });

  it('holds one open section below Wide and a set at Wide', () => {
    expect(isSingleOpen('compact')).toBe(true);
    expect(isSingleOpen('medium')).toBe(true);
    expect(isSingleOpen('wide')).toBe(false);
  });

  it('opens the graph and the trace together at Wide, because the cross-highlight is the feature', () => {
    expect(DEFAULT_OPEN.wide).toContain('modules');
    expect(DEFAULT_OPEN.wide).toContain('signal');
  });

  it('opens exactly one section below Wide — across both docks, not one each', () => {
    expect(DEFAULT_OPEN.compact).toHaveLength(1);
    expect(DEFAULT_OPEN.medium).toHaveLength(1);
  });
});

describe('the two docks', () => {
  it('draws the driving surfaces inboard and the reading surfaces outboard', () => {
    expect([...DOCK_IDS]).toEqual(['control', 'analysis']);
    expect([...DOCK_SECTIONS.control]).toEqual(['commands', 'face', 'lab']);
    expect([...DOCK_SECTIONS.analysis]).toEqual(['inspector', 'modules', 'signal', 'source', 'learn']);
  });

  it('assigns every section to exactly one dock', () => {
    const assigned = DOCK_IDS.flatMap((dock) => [...DOCK_SECTIONS[dock]]);
    expect(new Set(assigned).size).toBe(SECTION_IDS.length);
    for (const id of SECTION_IDS) expect(DOCK_SECTIONS[dockForSection(id)]).toContain(id);
  });

  it('sends both §5 targets to the analysis dock, so a selection never disturbs the controls', () => {
    expect(dockForSection('modules')).toBe('analysis');
    expect(dockForSection('source')).toBe('analysis');
  });

  it('opens one dock at a time below Wide and both at Wide', () => {
    const medium = withDockOpen(DEFAULT_SHELL, 'analysis', 'medium', true);
    expect(dockIsOpen(medium, 'medium', 'analysis')).toBe(true);
    const both = withDockOpen(medium, 'control', 'medium', true);
    expect(dockIsOpen(both, 'medium', 'control')).toBe(true);
    expect(dockIsOpen(both, 'medium', 'analysis')).toBe(false);

    const wide = withDockOpen(DEFAULT_SHELL, 'control', 'wide', true);
    expect(dockIsOpen(wide, 'wide', 'control')).toBe(true);
    expect(dockIsOpen(wide, 'wide', 'analysis')).toBe(true);
  });

  it('expands a section when a dock is opened with nothing in it to show', () => {
    // The default open section below Wide is `commands`, which lives in the
    // control dock. Opening the ANALYSIS dock with nothing expanded in it would
    // otherwise show a column of collapsed headers and no content.
    const opened = withDockOpen(DEFAULT_SHELL, 'analysis', 'medium', true);
    expect(opened.open.medium).toEqual(['inspector']);
    expect(dockIsOpen(opened, 'medium', 'control')).toBe(false);
  });

  it('keeps its own width per dock', () => {
    const wider = withDockWidth(DEFAULT_SHELL, 'control', 520);
    expect(wider.dockWidthPx.control).toBe(520);
    expect(wider.dockWidthPx.analysis).toBe(DOCK_DEFAULT_PX.analysis);
  });
});

describe('dock width', () => {
  it('clamps to 320–560 and survives nonsense', () => {
    expect(clampDockWidth(100)).toBe(DOCK_MIN_PX);
    expect(clampDockWidth(9000)).toBe(DOCK_MAX_PX);
    expect(clampDockWidth(Number.NaN)).toBe(DOCK_FALLBACK_PX);
    expect(clampDockWidth(Number.POSITIVE_INFINITY)).toBe(DOCK_FALLBACK_PX);
    expect(clampDockWidth(401.6)).toBe(402);
  });

  it('returns the same object when nothing changed', () => {
    const next = withDockWidth(DEFAULT_SHELL, 'analysis', DEFAULT_SHELL.dockWidthPx.analysis);
    expect(next).toBe(DEFAULT_SHELL);
  });
});

describe('section updates', () => {
  it('replaces the ONE open section below Wide, even across docks', () => {
    // The rule a reader asked for in as many words: "when I select one of the
    // panes, the other should be collapsed".
    const medium = withSection(DEFAULT_SHELL, 'medium', 'source', true);
    expect(medium.open.medium).toEqual(['source']);
    expect(dockIsOpen(medium, 'medium', 'analysis')).toBe(true);
    expect(dockIsOpen(medium, 'medium', 'control')).toBe(false);

    const backToControl = withSection(medium, 'medium', 'commands', true);
    expect(backToControl.open.medium).toEqual(['commands']);
    expect(dockIsOpen(backToControl, 'medium', 'control')).toBe(true);
    expect(dockIsOpen(backToControl, 'medium', 'analysis')).toBe(false);
  });

  it('adds to the set at Wide, where both docks are in flow', () => {
    const wide = withSection(DEFAULT_SHELL, 'wide', 'source', true);
    expect(wide.open.wide).toContain('source');
    expect(wide.open.wide).toContain('modules');
    expect(wide.open.wide).toContain('signal');
    expect(wide.open.wide).toContain('commands');
  });

  it('keeps sections in draw order however they were opened', () => {
    let state: ShellState = { ...DEFAULT_SHELL, open: { ...DEFAULT_SHELL.open, wide: [] } };
    state = withSection(state, 'wide', 'learn', true);
    state = withSection(state, 'wide', 'inspector', true);
    state = withSection(state, 'wide', 'commands', true);
    expect(state.open.wide).toEqual(['commands', 'inspector', 'learn']);
  });

  it('closes a section without disturbing the others', () => {
    const closed = withSection(DEFAULT_SHELL, 'wide', 'modules', false);
    expect(sectionIsOpen(closed, 'wide', 'modules')).toBe(false);
    expect(sectionIsOpen(closed, 'wide', 'signal')).toBe(true);
  });

  it('keeps one breakpoint’s preference out of another’s', () => {
    const medium = withSection(DEFAULT_SHELL, 'medium', 'lab', true);
    expect(medium.open.wide).toEqual(DEFAULT_SHELL.open.wide);
    expect(withDockOpen(medium, 'analysis', 'medium', true).dockOpen.analysis.wide).toBe(
      DEFAULT_SHELL.dockOpen.analysis.wide,
    );
  });

  it('reports visibility as expanded AND its dock showing', () => {
    // At Medium the workbench is in flow and starts OPEN — W3 — so `commands`
    // is both open and visible there. At Compact it is a sheet and starts shut,
    // which is why the status line carries the quick-run cluster.
    expect(sectionIsOpen(DEFAULT_SHELL, 'medium', 'commands')).toBe(true);
    expect(sectionIsVisible(DEFAULT_SHELL, 'medium', 'commands')).toBe(true);
    expect(sectionIsOpen(DEFAULT_SHELL, 'compact', 'commands')).toBe(true);
    expect(sectionIsVisible(DEFAULT_SHELL, 'compact', 'commands')).toBe(false);
    const shown = withDockOpen(DEFAULT_SHELL, 'control', 'compact', true);
    expect(sectionIsVisible(shown, 'compact', 'commands')).toBe(true);
  });
});

/**
 * The mode switch — Phase 4 W3.
 *
 * `Control | Analyze` is not new state. It is the dock split U6 already made,
 * shown as two modes of one workbench instead of two columns, so everything
 * these tests check is a consequence of `withDockOpen` and `withSection`
 * rather than of a second machine that has to be kept in step with the first.
 */
describe('the workbench mode switch', () => {
  it('names the two modes with the brief’s words', () => {
    expect(MODE_LABEL.control).toBe('Control');
    expect(MODE_LABEL.analysis).toBe('Analyze');
  });

  it('derives the mode from the open section, so it cannot disagree with it', () => {
    expect(modeForState(DEFAULT_SHELL, 'medium')).toBe('control');
    const analysing = withSection(DEFAULT_SHELL, 'medium', 'signal', true);
    expect(modeForState(analysing, 'medium')).toBe('analysis');
    // And back, which also closes `signal` — one pane at a time.
    const driving = withSection(analysing, 'medium', 'lab', true);
    expect(modeForState(driving, 'medium')).toBe('control');
    expect(driving.open.medium).toEqual(['lab']);
  });

  it('shows the mode’s first pane when nothing in it is open', () => {
    const analysing = withDockOpen(DEFAULT_SHELL, 'analysis', 'medium', true);
    expect(modeForState(analysing, 'medium')).toBe('analysis');
    expect(analysing.open.medium).toEqual(['inspector']);
    expect(analysing.dockOpen.control.medium).toBe(false);
  });

  it('survives a reload because the open section does', () => {
    installStorage();
    saveShell(withSection(DEFAULT_SHELL, 'medium', 'source', true));
    expect(modeForState(loadShell(), 'medium')).toBe('analysis');
  });

  it('falls back to Control with nothing open at all', () => {
    const empty: ShellState = {
      ...DEFAULT_SHELL,
      open: { ...DEFAULT_SHELL.open, medium: [] },
    };
    expect(modeForState(empty, 'medium')).toBe('control');
  });

  it('keeps the brief’s three workbench widths', () => {
    // Mirrored in styles.css as `clamp(500px, 37.5vw, 560px)`, and 37.5vw is
    // exactly 540 at 1440 — the width §3's arithmetic spends.
    expect(WORKBENCH_MIN_PX).toBe(500);
    expect(WORKBENCH_TARGET_PX).toBe(540);
    expect(WORKBENCH_MAX_PX).toBe(560);
    expect(Math.round(1440 * 0.375)).toBe(WORKBENCH_TARGET_PX);
    // §3's table, recomputed rather than quoted: one workbench clears the
    // user's 50% rule at 1440x900 and neither two-dock configuration does.
    const share = (docks: number): number => ((1440 - 64 - docks) * 868) / (1440 * 900);
    expect(share(WORKBENCH_TARGET_PX)).toBeGreaterThan(0.5);
    expect(share(320 + 320)).toBeLessThan(0.5);
    expect(share(360 + 360)).toBeLessThan(0.5);
  });
});

/** The environment line the brief asks for, and the two facts it states. */
describe('the environment line', () => {
  it('names the system from the origin, never from a constant', () => {
    expect(environmentSystemName({ kind: 'emulator', engine: 'qemu-system-xtensa/9.2.2' }, 'sim')).toBe(
      'QEMU EMULATOR',
    );
    expect(environmentSystemName({ kind: 'host-model', engine: '@sesame-lab/sesame-sim' }, 'qemu')).toBe(
      'HOST MODEL',
    );
    expect(environmentSystemName({ kind: 'replay' }, 'qemu')).toBe('RECORDED REPLAY');
  });

  it('falls back to the selected backend before anything has driven the scene', () => {
    expect(environmentSystemName(null, 'qemu')).toBe('QEMU EMULATOR');
    expect(environmentSystemName(null, 'sim')).toBe('HOST MODEL');
    expect(environmentSystemName(null, 'bridge')).toBe('BRIDGE STREAM');
    expect(environmentSystemName({ kind: 'unknown' }, 'qemu')).toBe('QEMU EMULATOR');
  });

  it('reads PHYSICAL HARDWARE off the counter, so NONE is a measurement', () => {
    expect(environmentHardware(0)).toBe('NONE');
    expect(environmentHardware(3)).toBe('3 OBSERVED EVENTS');
  });
});

describe('the §5 mitigation', () => {
  it('sends a joint or node selection to the graph and a bare symbol to the source pane', () => {
    expect(sectionForSelection({ joint: 'R4', nodeId: 'joint.R4', symbolId: 'ServoName' })).toBe('modules');
    expect(sectionForSelection({ joint: null, nodeId: 'ledc', symbolId: null })).toBe('modules');
    expect(sectionForSelection({ joint: null, nodeId: null, symbolId: 'setFace' })).toBe('source');
  });

  it('opens nothing for the empty selection — deselecting must not move the dock', () => {
    expect(sectionForSelection({ joint: null, nodeId: null, symbolId: null })).toBeNull();
  });
});

describe('the status line’s quick-run cluster', () => {
  it('names only commands the firmware actually has', () => {
    // The vocabulary is a checked mirror of `hardware/hardware-map.json`
    // (`catalog-drift.test.ts` re-derives it), so this is what stops a shortcut
    // inventing a command the robot cannot run.
    expect(primaryCommandsAreInVocabulary()).toBe(true);
  });

  it('keeps `wave` at every width — it is what the harness reaches for', () => {
    expect(PRIMARY_COMMANDS[0]).toBe('wave');
    expect(primaryCommandCount('compact')).toBeGreaterThanOrEqual(1);
    expect(primaryCommandCount('medium')).toBe(PRIMARY_COMMANDS.length);
    expect(primaryCommandCount('wide')).toBe(PRIMARY_COMMANDS.length);
  });
});

describe('persistence', () => {
  it('renders the defaults with nothing stored', () => {
    installStorage();
    expect(loadShell()).toEqual(DEFAULT_SHELL);
  });

  it('survives an absent localStorage entirely', () => {
    Reflect.deleteProperty(globalThis, 'localStorage');
    expect(loadShell()).toEqual(DEFAULT_SHELL);
    expect(() => {
      saveShell(DEFAULT_SHELL);
      clearShell();
    }).not.toThrow();
  });

  it('survives a localStorage that throws on every access', () => {
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      get() {
        throw new Error('site data blocked');
      },
    });
    expect(loadShell()).toEqual(DEFAULT_SHELL);
    expect(() => {
      saveShell(DEFAULT_SHELL);
      clearShell();
    }).not.toThrow();
  });

  it('discards somebody else’s JSON rather than merging it', () => {
    const store = installStorage();
    store.set(STORAGE_KEY, '{"version":99,"open":{"wide":["everything"]}}');
    expect(loadShell()).toEqual(DEFAULT_SHELL);
    store.set(STORAGE_KEY, 'not json at all');
    expect(loadShell()).toEqual(DEFAULT_SHELL);
    store.set(STORAGE_KEY, 'null');
    expect(loadShell()).toEqual(DEFAULT_SHELL);
  });

  it('discards the one-dock v1 record rather than reading it as a two-dock one', () => {
    const store = installStorage();
    store.set(
      STORAGE_KEY,
      JSON.stringify({
        version: 1,
        open: { wide: ['modules'] },
        dockOpen: { wide: true },
        dockWidthPx: 460,
      }),
    );
    expect(loadShell()).toEqual(DEFAULT_SHELL);
  });

  it('drops invented section ids and clamps a stored width', () => {
    const store = installStorage();
    store.set(
      STORAGE_KEY,
      JSON.stringify({
        version: 2,
        open: { wide: ['modules', 'not-a-section', 'signal'], medium: ['source'], compact: [] },
        dockOpen: {
          control: { wide: true, medium: 'yes', compact: false },
          analysis: { wide: true, medium: false, compact: false },
        },
        dockWidthPx: { control: 5000, analysis: 12 },
      }),
    );
    const loaded = loadShell();
    expect(loaded.open.wide).toEqual(['modules', 'signal']);
    expect(loaded.open.medium).toEqual(['source']);
    expect(loaded.open.compact).toEqual([]);
    // A non-boolean is not a preference, so the default stands.
    expect(loaded.dockOpen.control.medium).toBe(DEFAULT_SHELL.dockOpen.control.medium);
    expect(loaded.dockWidthPx.control).toBe(DOCK_MAX_PX);
    expect(loaded.dockWidthPx.analysis).toBe(DOCK_MIN_PX);
  });

  it('refuses to let a set from Wide smuggle a second open section into Medium', () => {
    const store = installStorage();
    store.set(
      STORAGE_KEY,
      JSON.stringify({ version: 2, open: { medium: ['commands', 'modules', 'signal'] }, dockOpen: {} }),
    );
    expect(loadShell().open.medium).toHaveLength(1);
  });

  it('refuses to let a stored record open both docks at once below Wide', () => {
    const store = installStorage();
    store.set(
      STORAGE_KEY,
      JSON.stringify({
        version: 2,
        open: { medium: ['commands'] },
        dockOpen: {
          control: { medium: true, compact: true, wide: true },
          analysis: { medium: true, compact: true, wide: true },
        },
      }),
    );
    const loaded = loadShell();
    expect([loaded.dockOpen.control.medium, loaded.dockOpen.analysis.medium]).toEqual([false, true]);
    expect([loaded.dockOpen.control.wide, loaded.dockOpen.analysis.wide]).toEqual([true, true]);
  });

  it('round-trips a real preference', () => {
    installStorage();
    const state = withDockWidth(withSection(DEFAULT_SHELL, 'wide', 'source', true), 'analysis', 380);
    saveShell(state);
    expect(loadShell()).toEqual(state);
    clearShell();
    expect(loadShell()).toEqual(DEFAULT_SHELL);
  });
});

describe('section ids', () => {
  it('accepts every drawn id and nothing else', () => {
    for (const id of SECTION_IDS) expect(parseSectionId(id)).toBe(id);
    expect(parseSectionId('workbench')).toBeNull();
    expect(parseSectionId('')).toBeNull();
  });

  it('accepts the two dock ids and nothing else', () => {
    for (const id of DOCK_IDS) expect(parseDockId(id)).toBe(id);
    expect(parseDockId('right')).toBeNull();
    expect(parseDockId('')).toBeNull();
  });

  it('draws the eight panes: two that were a stage strip, six that were columns and rows', () => {
    expect([...SECTION_IDS]).toEqual([
      'commands',
      'face',
      'lab',
      'inspector',
      'modules',
      'signal',
      'source',
      'learn',
    ]);
  });

  it('clamps the docks between the plan’s two numbers', () => {
    expect(DOCK_MIN_PX).toBe(320);
    expect(DOCK_MAX_PX).toBe(560);
  });
});
