/**
 * The module-first shell's state — Phase 4 W7 — and the three ways
 * `localStorage` fails.
 *
 * Same terms as `lessons.test.ts` and `lab.test.ts`, because the shell's
 * persistence is deliberately the same shape as theirs: the accessor itself can
 * throw in a private window with site data blocked, the value can be absent,
 * and it can be somebody else's JSON. All three must render the documented
 * defaults, and none of them is an error anybody has to see.
 *
 * The breakpoints are tested at their EDGES and against the arithmetic that
 * produced them, not in the middle, because a boundary whose justification has
 * been deleted is the hollow thing this project keeps catching. W3's 1700 was
 * "two 360 px docks leave the stage half the screen"; there are no docks, so it
 * is gone, and 2314 is here instead with the one claim it makes — that the
 * ordinary layout holds the whole 63-node graph above it.
 *
 * The exclusivity of the modules is not tested by opening two and asserting one
 * closed. It is tested by there being NO WAY to say two: `activeModule` is one
 * nullable id per breakpoint, so the illegal state is unrepresentable, and what
 * the tests below check is that every path into the state respects that.
 */
import { afterEach, describe, expect, it } from 'vitest';

import {
  activeModuleFor,
  breakpointForWidth,
  clearShell,
  COMPACT_MAX_PX,
  contentWidthFor,
  DEFAULT_ACTIVE_MODULE,
  DEFAULT_SHELL,
  DOCK_IDS,
  DOCK_SECTIONS,
  dockForSection,
  isModuleId,
  isPanelId,
  loadShell,
  MEDIUM_MAX_PX,
  MODE_LABEL,
  modeForState,
  MODULE_CHROME_PX,
  MODULE_IDS,
  MODULE_LABEL,
  MODULE_MIN_PX,
  MODULE_RAIL_LABEL,
  moduleForDock,
  moduleForSelection,
  moduleSurfaceWidthFor,
  panelIsVisible,
  PANEL_IDS,
  PANEL_W_PX,
  parseDockId,
  parseModuleId,
  parseSectionId,
  saveShell,
  SECTION_IDS,
  sectionForSelection,
  sectionIsVisible,
  sheetsOverStage,
  stageRuleFor,
  STAGE_MIN_PX,
  toggleModule,
  withModule,
  withPanelSheet,
  type ShellState,
} from '../ui/shell-state.js';
import {
  environmentHardware,
  environmentSystemName,
  PRIMARY_COMMANDS,
  primaryCommandCount,
  primaryCommandsAreInVocabulary,
} from '../ui/StatusBar.js';

const STORAGE_KEY = 'sesame-lab.shell.v3';

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
  it('keeps the laptop the bug was reported on out of the sheet regime', () => {
    expect(breakpointForWidth(1440)).toBe('medium');
    expect(breakpointForWidth(1414)).toBe('medium');
    expect(breakpointForWidth(1760)).toBe('medium');
    expect(breakpointForWidth(1920)).toBe('medium');
  });

  it('closes Compact at 1199 and opens the panel regime at 1200 — by arithmetic', () => {
    expect(COMPACT_MAX_PX).toBe(1199);
    expect(breakpointForWidth(1199)).toBe('compact');
    expect(breakpointForWidth(1200)).toBe('medium');
    // 64 rail + 280 panel + 480 stage floor + 376 module = 1200. That is the
    // first width at which the four boxes the module-first shell is made of all
    // fit beside each other; below it the panel and the module are sheets.
    expect(64 + PANEL_W_PX + STAGE_MIN_PX + MODULE_MIN_PX).toBe(COMPACT_MAX_PX + 1);
  });

  it('puts Wide where the ORDINARY layout holds the whole 63-node graph', () => {
    expect(MEDIUM_MAX_PX).toBe(2313);
    expect(breakpointForWidth(2313)).toBe('medium');
    expect(breakpointForWidth(2314)).toBe('wide');
    // W4's full-graph band starts at 960 px of SURFACE. This is that boundary
    // solved for the window, and it is the boundary's entire meaning — the
    // harness asserts the graph really does reach `full` above it.
    expect(moduleSurfaceWidthFor(MEDIUM_MAX_PX + 1, 'wide')).toBeGreaterThanOrEqual(960);
    expect(moduleSurfaceWidthFor(MEDIUM_MAX_PX, 'medium')).toBeLessThan(960);
  });

  it('replaces W3’s 1700 rather than leaving it with its reason deleted', () => {
    // 1700 was "two 360 px docks plus a 64 px rail still leave the stage half
    // the screen". There are no docks. A number that survives the deletion of
    // its own justification is the hollow boundary this project has hit before.
    expect(breakpointForWidth(1700)).toBe('medium');
    expect(breakpointForWidth(1699)).toBe('medium');
  });

  it('floats the panel and the module over the stage only at Compact', () => {
    expect(sheetsOverStage('compact')).toBe(true);
    expect(sheetsOverStage('medium')).toBe(false);
    expect(sheetsOverStage('wide')).toBe(false);
  });
});

describe('the geometry the two stage rules are computed from', () => {
  it('takes the rail and the side panel out of the content area', () => {
    expect(contentWidthFor(1894, 'medium')).toBe(1894 - 64 - PANEL_W_PX);
    // At Compact the panel is a sheet and takes nothing.
    expect(contentWidthFor(854, 'compact')).toBe(854 - 64);
  });

  it('splits the content 50/50 and takes the module’s own chrome off the top', () => {
    // 1920x1080 is a 1894 px viewport: 1550 of content, 775 each, 727 of
    // surface — which clears W4's 720 px subsystem boundary.
    expect(moduleSurfaceWidthFor(1894, 'medium')).toBe((1894 - 344) / 2 - MODULE_CHROME_PX);
    expect(moduleSurfaceWidthFor(1894, 'medium')).toBeGreaterThanOrEqual(720);
  });

  it('records what the panel width costs, and what actually decided the band', () => {
    expect(PANEL_W_PX).toBe(280);
    const at = (panel: number, chrome: number): number => (1894 - 64 - panel) / 2 - chrome;
    // Anywhere in §11.4's 280-320 band clears W4's 720 px subsystem boundary at
    // 1920x1080. The panel width is a MARGIN decision, not a threshold one.
    expect(at(280, MODULE_CHROME_PX)).toBeGreaterThanOrEqual(720);
    expect(at(320, MODULE_CHROME_PX)).toBeGreaterThanOrEqual(720);
    expect(at(280, MODULE_CHROME_PX)).toBeGreaterThan(at(320, MODULE_CHROME_PX));
    // What DID decide it was the module column's own chrome. At the 71 px this
    // shell shipped with before the panel-inside-a-panel was flattened, a 1920
    // monitor got the causal path whatever the side panel was set to.
    expect(at(280, 71)).toBeLessThan(720);
    expect(at(320, 71)).toBeLessThan(720);
  });

  /**
   * The arithmetic against what a browser actually measured.
   *
   * Every row is a reading from `capture-web-screenshots.mjs` phase 12, in the
   * headless Edge the harness runs, so this is not a restatement of the formula
   * — it is the formula checked against the layout. If a stylesheet change moves
   * a box, one of the two fails and says which.
   */
  it('agrees with what the browser measured at all six windows', () => {
    const MEASURED: readonly {
      window: string;
      innerWidth: number;
      content: number;
      module: number;
      surface: number;
    }[] = [
      { window: '1280x800', innerWidth: 1254, content: 910, module: 430, surface: 409 },
      { window: '1440x900', innerWidth: 1414, content: 1070, module: 535, surface: 510 },
      { window: '1760x1000', innerWidth: 1734, content: 1390, module: 695, surface: 670 },
      { window: '1920x1080', innerWidth: 1894, content: 1550, module: 775, surface: 750 },
      { window: '2560x1440', innerWidth: 2534, content: 2190, module: 1095, surface: 1070 },
    ];
    for (const row of MEASURED) {
      const breakpoint = breakpointForWidth(row.innerWidth);
      expect([row.window, contentWidthFor(row.innerWidth, breakpoint)]).toEqual([
        row.window,
        row.content,
      ]);
      // A LOWER BOUND, never an over-claim: the pane's own padding is a
      // container query (10 px below 520 px of pane, 12 above), and
      // MODULE_CHROME_PX takes the larger, so a narrow window measures up to
      // 4 px wider than the model says and never narrower.
      const model = Math.round(moduleSurfaceWidthFor(row.innerWidth, breakpoint));
      expect([row.window, model <= row.surface]).toEqual([row.window, true]);
      expect([row.window, row.surface - model <= 4]).toEqual([row.window, true]);
      expect([row.window, row.module - row.surface <= MODULE_CHROME_PX]).toEqual([row.window, true]);
    }
  });

  it('records the band each of those windows lands the architecture in', () => {
    // The measurement the whole workstream is judged on. W4's bands are 720 for
    // the subsystem graph and 960 for the whole 63-node map, on the artifact's
    // OWN box; these are the widths the ordinary layout hands it.
    const band = (surface: number): string =>
      surface >= 960 ? 'full' : surface >= 720 ? 'subsystem' : 'path';
    expect(band(moduleSurfaceWidthFor(1414, 'medium'))).toBe('path');
    expect(band(moduleSurfaceWidthFor(1734, 'medium'))).toBe('path');
    expect(band(moduleSurfaceWidthFor(1894, 'medium'))).toBe('subsystem');
    expect(band(moduleSurfaceWidthFor(2534, 'wide'))).toBe('full');
    // And the number §11.6 asks for: >= 1000 px of surface. It arrives at
    // 2560x1440 and NOT at 1920x1080, and that is arithmetic rather than a
    // shortfall of effort — see the findings.
    expect(moduleSurfaceWidthFor(2534, 'wide')).toBeGreaterThanOrEqual(1000);
    expect(moduleSurfaceWidthFor(1894, 'medium')).toBeLessThan(1000);
    // 1000 px of surface needs 2050 of content, which needs this much viewport.
    expect(2 * (1000 + MODULE_CHROME_PX) + 64 + PANEL_W_PX).toBe(2394);
  });

  it('lets the stage’s own floor outrank the 50% split on a narrow window', () => {
    // At 1280x800 (a 1254 px viewport) half the content is 455, below the
    // 480 px floor, so the stage keeps 480 and the module gives way — which
    // leaves the stage MORE than half, never less.
    const content = contentWidthFor(1254, 'medium');
    expect(content / 2).toBeLessThan(STAGE_MIN_PX);
    expect(moduleSurfaceWidthFor(1254, 'medium')).toBe(content - STAGE_MIN_PX - MODULE_CHROME_PX);
    expect(content - STAGE_MIN_PX).toBeLessThan(STAGE_MIN_PX);
  });
});

describe('the two stage rules, published rather than averaged', () => {
  it('names the regime from what is actually on screen', () => {
    expect(stageRuleFor(null, null)).toBe('area-50');
    expect(stageRuleFor('modules', null)).toBe('content-50');
    expect(stageRuleFor('learn', null)).toBe('content-50');
  });

  it('lets the focus workspace outrank both, and only while it is open', () => {
    expect(stageRuleFor('modules', 'modules')).toBe('focus-exempt');
    expect(stageRuleFor(null, 'modules')).toBe('focus-exempt');
    expect(stageRuleFor('modules', '')).toBe('content-50');
  });
});

describe('the two kinds of pane', () => {
  it('splits the eight ids into five modules and three panel cards', () => {
    expect([...MODULE_IDS]).toEqual(['modules', 'signal', 'source', 'learn', 'lab']);
    expect([...PANEL_IDS]).toEqual(['commands', 'face', 'inspector']);
    expect([...MODULE_IDS, ...PANEL_IDS].sort()).toEqual([...SECTION_IDS].sort());
    // No id is both, which is what makes `isModuleId` a decision rather than a
    // hint the shell has to remember to apply.
    for (const id of SECTION_IDS) expect(isModuleId(id)).toBe(!isPanelId(id));
  });

  it('keeps the Lab a module, because it is an editing surface', () => {
    // §11.3 puts it in the exclusive set and asks for it to be flagged if that
    // proves wrong on screen. A pose table, a pixel editor and a C++ export do
    // not fit on a 280 px panel without a scroller, and a scroller is the one
    // thing §11.4 forbids there.
    expect(isModuleId('lab')).toBe(true);
    expect(isPanelId('lab')).toBe(false);
  });

  it('keeps U6’s two domains, which is what the mode label is derived from', () => {
    expect([...DOCK_SECTIONS.control]).toEqual(['commands', 'face', 'lab']);
    expect([...DOCK_SECTIONS.analysis]).toEqual([
      'inspector',
      'modules',
      'signal',
      'source',
      'learn',
    ]);
    for (const id of SECTION_IDS) expect(DOCK_IDS).toContain(dockForSection(id));
  });

  it('names every module on the rail without breaking the 60 px column', () => {
    for (const id of MODULE_IDS) {
      expect(MODULE_LABEL[id].length).toBeGreaterThan(0);
      // 60 px of usable rail column at the 14 px floor is about six characters.
      expect(MODULE_RAIL_LABEL[id].length).toBeLessThanOrEqual(6);
    }
    // The one place they differ, and why: `Architecture` would break mid-word
    // in the one zone this product promises never to hide anything in.
    expect(MODULE_LABEL.modules).toBe('Architecture');
    expect(MODULE_RAIL_LABEL.modules).toBe('Arch');
  });
});

describe('one active module', () => {
  it('has no way to represent two — the state is one nullable id', () => {
    const withArch = withModule(DEFAULT_SHELL, 'medium', 'modules');
    const withSignal = withModule(withArch, 'medium', 'signal');
    expect(activeModuleFor(withSignal, 'medium')).toBe('signal');
    // Not "the others were closed": there is nowhere for another one to be.
    expect(typeof withSignal.activeModule.medium).toBe('string');
    for (const id of MODULE_IDS) {
      expect(sectionIsVisible(withSignal, 'medium', id)).toBe(id === 'signal');
    }
  });

  it('gives the robot the whole content area with nothing active', () => {
    const none = withModule(DEFAULT_SHELL, 'medium', null);
    expect(activeModuleFor(none, 'medium')).toBeNull();
    expect(stageRuleFor(activeModuleFor(none, 'medium'), null)).toBe('area-50');
  });

  it('toggles the active one off rather than requiring a second control', () => {
    const arch = withModule(DEFAULT_SHELL, 'medium', 'modules');
    expect(activeModuleFor(toggleModule(arch, 'medium', 'modules'), 'medium')).toBeNull();
    expect(activeModuleFor(toggleModule(arch, 'medium', 'signal'), 'medium')).toBe('signal');
  });

  it('keeps one breakpoint’s choice out of another’s', () => {
    const next = withModule(DEFAULT_SHELL, 'medium', 'lab');
    expect(activeModuleFor(next, 'medium')).toBe('lab');
    expect(activeModuleFor(next, 'compact')).toBe(DEFAULT_ACTIVE_MODULE.compact);
    expect(activeModuleFor(next, 'wide')).toBe(DEFAULT_ACTIVE_MODULE.wide);
  });

  it('returns the same object when nothing changed', () => {
    const arch = withModule(DEFAULT_SHELL, 'medium', 'modules');
    expect(withModule(arch, 'medium', 'modules')).toBe(arch);
  });

  it('meets a Compact reader with the robot and a large screen with the graph', () => {
    expect(DEFAULT_ACTIVE_MODULE.compact).toBeNull();
    expect(DEFAULT_ACTIVE_MODULE.medium).toBe('modules');
    expect(DEFAULT_ACTIVE_MODULE.wide).toBe('modules');
  });
});

describe('the side panel', () => {
  it('is always visible above Compact — a zone that can close can hide provenance', () => {
    expect(panelIsVisible(DEFAULT_SHELL, 'medium')).toBe(true);
    expect(panelIsVisible(DEFAULT_SHELL, 'wide')).toBe(true);
    // And it cannot be closed there, whatever is asked of it.
    expect(panelIsVisible(withPanelSheet(DEFAULT_SHELL, 'medium', false), 'medium')).toBe(true);
    for (const id of PANEL_IDS) expect(sectionIsVisible(DEFAULT_SHELL, 'medium', id)).toBe(true);
  });

  it('is a sheet at Compact, and takes turns with the module there', () => {
    expect(panelIsVisible(DEFAULT_SHELL, 'compact')).toBe(false);
    const sheet = withPanelSheet(DEFAULT_SHELL, 'compact', true);
    expect(panelIsVisible(sheet, 'compact')).toBe(true);
    // Both are sheets over the same edge, so one puts the other away.
    const thenModule = withModule(sheet, 'compact', 'learn');
    expect(panelIsVisible(thenModule, 'compact')).toBe(false);
    expect(activeModuleFor(thenModule, 'compact')).toBe('learn');
    const thenPanel = withPanelSheet(thenModule, 'compact', true);
    expect(activeModuleFor(thenPanel, 'compact')).toBeNull();
  });
});

describe('the mode label', () => {
  it('keeps the brief’s two words', () => {
    expect(MODE_LABEL.control).toBe('Control');
    expect(MODE_LABEL.analysis).toBe('Analyze');
  });

  it('derives the mode from the active module, so it cannot disagree with it', () => {
    expect(modeForState(withModule(DEFAULT_SHELL, 'medium', 'lab'), 'medium')).toBe('control');
    expect(modeForState(withModule(DEFAULT_SHELL, 'medium', 'signal'), 'medium')).toBe('analysis');
    expect(modeForState(withModule(DEFAULT_SHELL, 'medium', 'modules'), 'medium')).toBe('analysis');
  });

  it('falls back to Control with nothing active — the reader is driving the robot', () => {
    expect(modeForState(withModule(DEFAULT_SHELL, 'medium', null), 'medium')).toBe('control');
  });

  it('survives a reload because the active module does', () => {
    const store = installStorage();
    saveShell(withModule(DEFAULT_SHELL, 'medium', 'source'));
    expect(store.has(STORAGE_KEY)).toBe(true);
    expect(modeForState(loadShell(), 'medium')).toBe('analysis');
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
  it('sends a joint or node selection to the graph and a bare symbol to the source', () => {
    expect(moduleForSelection({ joint: 'R4', nodeId: 'joint.R4', symbolId: 'ServoName' })).toBe('modules');
    expect(moduleForSelection({ joint: null, nodeId: 'ledc', symbolId: null })).toBe('modules');
    expect(moduleForSelection({ joint: null, nodeId: null, symbolId: 'setFace' })).toBe('source');
    // Kept under its U6 name for the debug hook and eight harness phases.
    expect(sectionForSelection).toBe(moduleForSelection);
  });

  it('opens nothing for the empty selection — deselecting must not move anything', () => {
    expect(moduleForSelection({ joint: null, nodeId: null, symbolId: null })).toBeNull();
  });

  it('only ever reveals a MODULE, so a selection cannot take the commands away', () => {
    for (const target of ['modules', 'source'] as const) {
      expect(isModuleId(target)).toBe(true);
      expect(dockForSection(target)).toBe('analysis');
    }
  });
});

describe('the status line’s quick-run cluster', () => {
  it('names only commands the firmware actually has', () => {
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
    store.set(STORAGE_KEY, '{"version":99,"activeModule":{"wide":"everything"}}');
    expect(loadShell()).toEqual(DEFAULT_SHELL);
    store.set(STORAGE_KEY, 'not json at all');
    expect(loadShell()).toEqual(DEFAULT_SHELL);
    store.set(STORAGE_KEY, 'null');
    expect(loadShell()).toEqual(DEFAULT_SHELL);
  });

  it('discards the v2 two-dock record rather than reading it as a module', () => {
    // A v2 record describes a shell that no longer exists — a set of open
    // sections across two docks, and two dock widths. Half-understanding it
    // would produce a shell confidently wrong about what the reader can see.
    const store = installStorage();
    store.set(
      'sesame-lab.shell.v2',
      JSON.stringify({
        version: 2,
        open: { compact: ['learn'], medium: ['signal'], wide: ['modules', 'signal'] },
        dockOpen: { control: { wide: true }, analysis: { wide: true } },
        dockWidthPx: { control: 400, analysis: 460 },
      }),
    );
    expect(loadShell()).toEqual(DEFAULT_SHELL);
    // And `clearShell()` removes it, so it cannot linger for a future version
    // to half-recognise.
    clearShell();
    expect(store.has('sesame-lab.shell.v2')).toBe(false);
  });

  it('drops an invented module id and keeps the default for that breakpoint', () => {
    const store = installStorage();
    store.set(
      STORAGE_KEY,
      JSON.stringify({
        version: 3,
        activeModule: { compact: 'commands', medium: 'not-a-module', wide: null },
        panelSheet: { compact: true },
      }),
    );
    const loaded = loadShell();
    // `commands` is a PANEL card, not a module. A stored record must not be
    // able to make the side panel into the module column.
    expect(loaded.activeModule.compact).toBe(DEFAULT_ACTIVE_MODULE.compact);
    expect(loaded.activeModule.medium).toBe(DEFAULT_ACTIVE_MODULE.medium);
    expect(loaded.activeModule.wide).toBeNull();
    expect(loaded.panelSheet.compact).toBe(true);
  });

  it('refuses to let a stored record hide the panel above Compact', () => {
    const store = installStorage();
    store.set(
      STORAGE_KEY,
      JSON.stringify({
        version: 3,
        activeModule: { compact: null, medium: null, wide: null },
        panelSheet: { compact: false, medium: true, wide: true },
      }),
    );
    const loaded = loadShell();
    expect(loaded.panelSheet.medium).toBe(false);
    expect(loaded.panelSheet.wide).toBe(false);
    expect(panelIsVisible(loaded, 'medium')).toBe(true);
  });

  it('round-trips a real preference', () => {
    installStorage();
    const state: ShellState = {
      version: 3,
      activeModule: { compact: 'learn', medium: 'source', wide: 'signal' },
      panelSheet: { compact: true, medium: false, wide: false },
    };
    saveShell(state);
    expect(loadShell()).toEqual(state);
  });
});

describe('ids parsed from an attribute or a debug call', () => {
  it('accepts every drawn id and nothing else', () => {
    for (const id of SECTION_IDS) expect(parseSectionId(id)).toBe(id);
    expect(parseSectionId('nope')).toBeNull();
    for (const id of MODULE_IDS) expect(parseModuleId(id)).toBe(id);
    // A panel card is not a module, and the parser is where that is enforced.
    for (const id of PANEL_IDS) expect(parseModuleId(id)).toBeNull();
    for (const id of DOCK_IDS) expect(parseDockId(id)).toBe(id);
    expect(parseDockId('middle')).toBeNull();
  });

  it('maps the harness’s dock verbs onto the one field', () => {
    // `analysis` means "show me something that explains this robot"; `control`
    // is the side panel, which is always there, so it clears the module.
    expect(moduleForDock('analysis')).toBe('modules');
    expect(moduleForDock('control')).toBeNull();
  });
});
