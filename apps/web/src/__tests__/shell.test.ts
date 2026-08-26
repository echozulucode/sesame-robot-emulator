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
 * 1440 must be Medium — where the dock overlays — and not Wide, where it would
 * take 460 px out of the stage and give back the bug.
 */
import { afterEach, describe, expect, it } from 'vitest';

import {
  breakpointForWidth,
  clampDockWidth,
  clearShell,
  DEFAULT_OPEN,
  DEFAULT_SHELL,
  DOCK_MAX_PX,
  DOCK_MIN_PX,
  isSingleOpen,
  loadShell,
  parseSectionId,
  saveShell,
  SECTION_IDS,
  sectionForSelection,
  sectionIsOpen,
  withDockOpen,
  withDockWidth,
  withSection,
  type ShellState,
} from '../ui/shell-state.js';

const STORAGE_KEY = 'sesame-lab.shell.v1';

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
    expect(breakpointForWidth(1441)).toBe('wide');
    expect(breakpointForWidth(1280)).toBe('medium');
    expect(breakpointForWidth(2560)).toBe('wide');
  });

  it('closes Compact at 899 and opens Medium at 900', () => {
    expect(breakpointForWidth(899)).toBe('compact');
    expect(breakpointForWidth(900)).toBe('medium');
    expect(breakpointForWidth(320)).toBe('compact');
  });

  it('holds one open section below Wide and a set at Wide', () => {
    expect(isSingleOpen('compact')).toBe(true);
    expect(isSingleOpen('medium')).toBe(true);
    expect(isSingleOpen('wide')).toBe(false);
  });

  it('opens the graph and the trace together at Wide, because the cross-highlight is the feature', () => {
    expect(DEFAULT_OPEN.wide).toContain('modules');
    expect(DEFAULT_OPEN.wide).toContain('signal');
    expect(DEFAULT_OPEN.compact).toHaveLength(1);
    expect(DEFAULT_OPEN.medium).toHaveLength(1);
  });
});

describe('dock width', () => {
  it('clamps to the plan’s 320–520 and survives nonsense', () => {
    expect(clampDockWidth(100)).toBe(DOCK_MIN_PX);
    expect(clampDockWidth(9000)).toBe(DOCK_MAX_PX);
    expect(clampDockWidth(Number.NaN)).toBe(DEFAULT_SHELL.dockWidthPx);
    expect(clampDockWidth(Number.POSITIVE_INFINITY)).toBe(DEFAULT_SHELL.dockWidthPx);
    expect(clampDockWidth(401.6)).toBe(402);
  });

  it('returns the same object when nothing changed', () => {
    const next = withDockWidth(DEFAULT_SHELL, DEFAULT_SHELL.dockWidthPx);
    expect(next).toBe(DEFAULT_SHELL);
  });
});

describe('section updates', () => {
  it('replaces the open section below Wide and adds to the set at Wide', () => {
    const medium = withSection(DEFAULT_SHELL, 'medium', 'source', true);
    expect(medium.open.medium).toEqual(['source']);

    const wide = withSection(DEFAULT_SHELL, 'wide', 'source', true);
    expect(wide.open.wide).toContain('source');
    expect(wide.open.wide).toContain('modules');
    expect(wide.open.wide).toContain('signal');
  });

  it('keeps sections in draw order however they were opened', () => {
    let state: ShellState = { ...DEFAULT_SHELL, open: { ...DEFAULT_SHELL.open, wide: [] } };
    state = withSection(state, 'wide', 'lab', true);
    state = withSection(state, 'wide', 'inspector', true);
    state = withSection(state, 'wide', 'signal', true);
    expect(state.open.wide).toEqual(['inspector', 'signal', 'lab']);
  });

  it('closes a section without disturbing the others', () => {
    const closed = withSection(DEFAULT_SHELL, 'wide', 'modules', false);
    expect(sectionIsOpen(closed, 'wide', 'modules')).toBe(false);
    expect(sectionIsOpen(closed, 'wide', 'signal')).toBe(true);
  });

  it('keeps one breakpoint’s preference out of another’s', () => {
    const medium = withSection(DEFAULT_SHELL, 'medium', 'lab', true);
    expect(medium.open.wide).toEqual(DEFAULT_SHELL.open.wide);
    expect(withDockOpen(medium, 'medium', true).dockOpen.wide).toBe(DEFAULT_SHELL.dockOpen.wide);
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

  it('drops invented section ids and clamps a stored width', () => {
    const store = installStorage();
    store.set(
      STORAGE_KEY,
      JSON.stringify({
        version: 1,
        open: { wide: ['modules', 'not-a-section', 'signal'], medium: ['source'], compact: [] },
        dockOpen: { wide: true, medium: 'yes', compact: false },
        dockWidthPx: 5000,
      }),
    );
    const loaded = loadShell();
    expect(loaded.open.wide).toEqual(['modules', 'signal']);
    expect(loaded.open.medium).toEqual(['source']);
    expect(loaded.open.compact).toEqual([]);
    // A non-boolean is not a preference, so the default stands.
    expect(loaded.dockOpen.medium).toBe(DEFAULT_SHELL.dockOpen.medium);
    expect(loaded.dockWidthPx).toBe(DOCK_MAX_PX);
  });

  it('refuses to let a two-section record from Wide smuggle a second open section into Medium', () => {
    const store = installStorage();
    store.set(
      STORAGE_KEY,
      JSON.stringify({ version: 1, open: { medium: ['modules', 'signal', 'lab'] }, dockOpen: {} }),
    );
    expect(loadShell().open.medium).toHaveLength(1);
  });

  it('round-trips a real preference', () => {
    installStorage();
    const state = withDockWidth(withSection(DEFAULT_SHELL, 'wide', 'source', true), 380);
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

  it('draws the six panes that used to be columns and rows', () => {
    expect([...SECTION_IDS]).toEqual(['inspector', 'modules', 'signal', 'source', 'learn', 'lab']);
  });

  it('clamps the dock between the plan’s two numbers', () => {
    expect(DOCK_MIN_PX).toBe(320);
    expect(DOCK_MAX_PX).toBe(520);
  });
});
