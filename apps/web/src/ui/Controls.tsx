/**
 * Backend switch, provenance banner, and the command vocabulary.
 *
 * ## Two components, one panel's worth of markup
 *
 * This was one `<Controls>` panel in the old third column. The responsive
 * shell splits it in two WITHOUT changing a word of what either half says:
 *
 *  - {@link BackendPanel} — the switch, the connection detail and the
 *    provenance banner (`#prov-banner`, `#origin-banner`,
 *    `#measurement-verdict`). It lives in the dock's inspector section, and a
 *    summary of the same two badges is pinned to the rail, which never
 *    collapses.
 *  - {@link CommandBar} — the command and face vocabulary. It is the
 *    `Commands` section of the CONTROL dock, the inboard one, beside the robot
 *    it drives. It was a fixed strip under the stage until U6; the strip cost
 *    the 3D viewport up to 176 px of height, which is the one thing the shell
 *    exists to maximise.
 *
 *    `[data-command="wave"]` is what the harness clicks in four separate
 *    phases, and it stays the single unambiguous handle on the real vocabulary:
 *    the status line's shortcuts are `[data-quick-command]`, deliberately a
 *    different attribute, so no selector can click a shortcut when it meant the
 *    vocabulary. Phases 6 and 7 open this section and hit-test the button
 *    before clicking it — `HTMLElement.click()` fires on a `hidden` element
 *    too, and a check that a hidden button works proves nothing.
 *
 * Every id, `data-*` attribute and class name below is the one it was before.
 * The split is layout; the provenance surfaces are correctness.
 *
 * Every button on this panel is generated from `COMMAND_VOCABULARY` and
 * `FACE_CATALOG` in `@sesame-lab/sesame-protocol`, which are themselves a
 * checked mirror of `hardware/hardware-map.json` (`catalog-drift.test.ts`
 * re-derives every entry and fails if they disagree). So the vocabulary a
 * learner sees is the firmware's vocabulary, and a hand-typed list cannot drift
 * away from it — including the parts nobody would have typed, like the fact
 * that `forward`/`backward`/`left`/`right` never clear `currentCommand`.
 */
import {
  COMMAND_VOCABULARY,
  FACE_CATALOG,
  type OriginKind,
  type Provenance,
  type TelemetryOrigin,
} from '@sesame-lab/sesame-protocol';
import type { ReactElement } from 'react';

import type { BackendId, BackendStatus, TelemetryBackend } from '../backends/types.js';
import { DesktopResources } from '../desktop/DesktopResources.js';
import {
  measurementHeadline,
  measurementVerdict,
  OriginTag,
  PROVENANCE_MEANING,
  ProvenanceTag,
} from './ProvenanceTag.js';

export interface ControlsProps {
  readonly backend: TelemetryBackend;
  readonly backendId: BackendId;
  readonly onBackendChange: (id: BackendId) => void;
  readonly bridgeUrl: string;
  readonly onBridgeUrlChange: (url: string) => void;
  readonly status: BackendStatus;
  readonly drivingProvenance: Provenance | null;
  /** Which boundary the driving event crossed. Rendered beside the provenance. */
  readonly drivingOrigin: TelemetryOrigin | null;
  readonly provenanceCounts: Readonly<Record<Provenance, number>>;
  readonly originCounts: Readonly<Record<OriginKind, number>>;
  readonly totalEvents: number;
}

/** What the control dock's command bar needs, and nothing else. */
export interface CommandBarProps {
  readonly backend: TelemetryBackend;
  readonly status: BackendStatus;
  readonly busy: string | null;
  readonly error: string | null;
  readonly onCommand: (name: string) => void;
  readonly onFace: (name: string) => void;
  readonly onStop: () => void;
  /**
   * `panel` is the side-panel card: a shortlist, and no scroller anywhere.
   *
   * §11.4 asks for Commands to be *minimal* and to never need a scrollbar of
   * its own, so the panel shows five commands and four faces and the rest is
   * one click away in the "All commands" screen. What it does NOT drop is the
   * correctness content: the receive-only warning, the not-connected note and
   * the two ⚠ faces that draw nothing are on the panel, because a popover may
   * expand a correctness surface and may not be where it first appears.
   */
  readonly variant?: 'panel' | 'full';
}

/**
 * The three backends, and one sentence each on what a button press reaches.
 *
 * Generated rather than hand-placed so the switch cannot grow a fourth arm in
 * the markup and forget it here.
 */
const BACKEND_CHOICES: readonly { id: BackendId; label: string; sub: string }[] = [
  { id: 'sim', label: 'Simulated model', sub: 'a host model, in this tab' },
  { id: 'bridge', label: 'Bridge WebSocket', sub: 'receive-only' },
  { id: 'qemu', label: 'QEMU firmware', sub: 'real firmware, commandable' },
];

/** Faces worth one click. The full 38 are in the model; these are the ones with pixels. */
const FACE_SHORTLIST = ['happy', 'sad', 'angry', 'surprised', 'love', 'sleepy', 'confused', 'idle'];

/**
 * ===========================================================================
 * THE PANEL SHOWS EVERY COMMAND — Phase 4 W5, correcting W7
 * ===========================================================================
 *
 * > *"We want to see all the commands where possible and fit the available
 * > space with commands. […] Use scrollbars in command and selected joint only
 * > if there isn't enough space to show all content. The command buttons should
 * > be minimal size like they used to be."*
 *
 * W7 showed four of the nineteen and put the rest behind an "All 20" screen,
 * because the side panel was forbidden a scrollbar at any width and a full
 * vocabulary would not fit. That constraint has been lifted for this card by
 * name (see `SCROLLABLE_CARDS` in `ui/Shell.tsx`), so the shortlist has nothing
 * left to buy: the card takes the panel's spare height, lays the buttons out at
 * their own minimal size, and scrolls only when the vocabulary genuinely
 * exceeds the space.
 *
 * The screen stays. It is not a duplicate list — it carries the faces, the
 * two ⚠ zero-frame faces, the receive-only warning and the sentence about where
 * the vocabulary comes from, none of which fit on a 262 px card.
 */
const PANEL_COMMANDS: readonly string[] | null = null;

/** Two that work, and the two that draw nothing — see {@link FaceBar}. */
const PANEL_FACES: readonly string[] = ['happy', 'sad'];

/**
 * `setFace("stand")` and `setFace("default")` draw NOTHING.
 *
 * The bitmap is weak-undefined in the firmware — ISSUE-20260823-004 — and that
 * is a correctness surface rather than a curiosity, so both buttons and the
 * count beside them are on the side panel at every width, not only in the "All
 * commands" screen.
 */
const BROKEN_FACES: readonly string[] = ['stand', 'default'];

/**
 * The panel's own note, in ONE line.
 *
 * The full sentence — *"38 faces are registered in the firmware; the two marked
 * ⚠ have zero frames and draw nothing at all"* — is in the "All commands"
 * screen. What may not move there is the FACT, so the ⚠ buttons and this count
 * are both on the panel.
 */

export function BackendPanel(props: ControlsProps): ReactElement {
  const {
    backend,
    backendId,
    onBackendChange,
    bridgeUrl,
    onBridgeUrlChange,
    status,
    drivingProvenance,
    drivingOrigin,
    provenanceCounts,
    originCounts,
    totalEvents,
  } = props;

  return (
    <section className="panel" data-testid="controls">
      <header className="panel-header">
        <h2>Backend</h2>
        <span className={`conn conn-${status.connection}`} id="conn">
          {status.connection}
        </span>
      </header>

      <div className="backend-switch" role="radiogroup" aria-label="telemetry backend">
        {BACKEND_CHOICES.map((choice) => (
          <button
            key={choice.id}
            type="button"
            role="radio"
            aria-checked={backendId === choice.id}
            className={backendId === choice.id ? 'active' : ''}
            data-backend={choice.id}
            title={choice.sub}
            onClick={() => onBackendChange(choice.id)}
          >
            {choice.label}
          </button>
        ))}
      </div>

      <p className="note">{backend.description}</p>

      {backendId === 'qemu' && status.connection === 'connecting' && (
        <div className="warn" data-testid="qemu-connecting">
          <strong>Booting real firmware — this takes 2 to 17 seconds.</strong>
          <p>
            {status.detail}
            {(status.attempts ?? 1) > 1 && (
              <>
                {' '}
                <b>
                  Attempt {status.attempts}: {(status.attempts ?? 1) - 1} earlier boot(s) panicked
                  inside QEMU’s cache model and were relaunched (ISSUE-20260823-022).
                </b>
              </>
            )}
          </p>
        </div>
      )}

      {backendId === 'bridge' && (
        <label className="field">
          <span>bridge URL</span>
          <input
            type="text"
            value={bridgeUrl}
            spellCheck={false}
            onChange={(e) => onBridgeUrlChange(e.target.value)}
            id="bridge-url"
          />
        </label>
      )}

      {backendId === 'qemu' && status.connection === 'error' && (
        <div className="warn" data-testid="qemu-unreachable">
          <strong>No lab host is answering.</strong>
          <p>{status.detail}</p>
          <p className="muted">
            The emulator runs in a Node process, not in this tab: it spawns{' '}
            <code>qemu-system-xtensa</code> and opens a TCP socket for UART0. Start it with{' '}
            <code>node apps/web/server/lab-host.mjs</code>, which serves this page and puts the
            firmware’s own ten HTTP routes in front of the running guest.
          </p>
        </div>
      )}

      <p className="note muted" id="conn-detail">
        {status.detail}
      </p>

      {/*
        Phase 5 T2 — what the packaged app bundled and where it resolved to.

        Renders nothing outside the Tauri desktop shell, so the browser build is
        unchanged. It is here rather than on the trust panel on purpose: whether
        `qemu-system-xtensa.exe` is next to the executable is a PACKAGING fact,
        not evidence about what drove the scene, and §11.4's rule protects
        correctness surfaces from being diluted with plumbing — it does not
        require plumbing to be promoted to one.
      */}
      <DesktopResources />

      {/*
        The BANNER moved to the side panel — Phase 4 W7.

        `#prov-banner`, `#origin-banner` and `#measurement-verdict` are the
        product's central claim, and §11.4 forbids a correctness surface from
        first appearing inside a "more info" screen. This panel is now that
        screen, so what stayed here is what a popover is FOR: the meaning of the
        badge in full prose, and the counts behind it. See {@link TrustCard}.
      */}
      <div className="prov-detail" data-testid="prov-detail">
        <p className="note" data-testid="measurement-verdict-full">
          {measurementVerdict(drivingProvenance, drivingOrigin)}
        </p>
        <p className="note" data-testid="provenance-meaning">
          {drivingProvenance === null
            ? 'No event has moved a joint yet.'
            : PROVENANCE_MEANING[drivingProvenance]}
        </p>
        <div className="prov-counts" id="prov-counts">
          {(['observed', 'simulated', 'inferred'] as const).map((p) => (
            <span key={p} className={`prov prov-${p}${provenanceCounts[p] === 0 ? ' prov-zero' : ''}`}>
              {p} {provenanceCounts[p]}
            </span>
          ))}
          <span className="dim">{totalEvents} events</span>
        </div>
        <div className="prov-counts" id="origin-counts">
          {(['physical-robot', 'emulator', 'host-model', 'replay', 'unknown'] as const).map((k) => (
            <span
              key={k}
              className={`prov origin origin-${k}${originCounts[k] === 0 ? ' prov-zero' : ''}`}
            >
              {k} {originCounts[k]}
            </span>
          ))}
        </div>
      </div>

    </section>
  );
}

export interface TrustCardProps {
  readonly drivingProvenance: Provenance | null;
  readonly drivingOrigin: TelemetryOrigin | null;
  /** `store.physicallyObservedEvents` — a counter, never a constant. */
  readonly physicallyObservedEvents: number;
  /**
   * True when the app is on QEMU and nothing answered `/lab/session` — W8.
   *
   * QEMU is the default now, and this repository ships two arrangements where
   * there is no QEMU behind the origin: `pnpm demo:web` serves the built app
   * from the bridge, and any static server does the same. Defaulting into an
   * unexplained failure there is a problem a user of this project has already
   * reported, so the CLAIM — there is no lab host, and the emulator does not
   * run in this tab — is on the panel, and the paragraph naming the command
   * that starts one is in the "More" screen beside the backend switch that
   * moves off it.
   */
  readonly noLabHost: boolean;
  /**
   * True when this page is inside the Tauri desktop shell **and** the
   * behavioural simulator is what is driving — Phase 5 T1, reworded by T6.
   *
   * There is no lab host inside a packaged `.exe` and there never will be one,
   * so {@link noLabHost}'s "start one" guidance is advice the reader cannot
   * act on. This line is what stands in its place: in a window with no address
   * bar and no terminal, it says on the panel, at every width, that what is
   * driving the scene is a host model.
   *
   * **T6 changed the sentence and the condition, and the two go together.**
   * T1 wrote *"this desktop build has no emulator yet"*, which stopped being
   * true the moment T4 shipped one, and T1's condition
   * (`labProbe?.labHost === 'desktop'`) stopped being *reachable* at the same
   * moment — `labProbe` is only ever set from `desktopSimulatorProbe()`, and
   * only when the shell has no emulator backend. So the line described a state
   * it could no longer be rendered in, and nothing rendered it at all: T5
   * could assert it absent both ways and could only prove the branch still
   * existed by searching the JavaScript the executable serves.
   *
   * The condition is now simply *desktop shell, simulator driving*, which the
   * shipped app reaches whenever the reader switches the backend by hand, and
   * a build with `TAURI_EMULATOR_BACKEND === null` reaches on its first frame.
   * The sentence says only what is true in both.
   */
  readonly desktopSimulator: boolean;
  readonly onMore: () => void;
}

/**
 * The side panel's first card, and the one §11.4 is written about.
 *
 * > *"Correctness surfaces may not be demoted into a popover. Provenance,
 * > origin, `PHYSICAL HARDWARE: NONE`, `NOT BUILT` and `CONCEPTUAL` badges stay
 * > visible on the panel itself. A popover may EXPAND them; it may not be where
 * > they first appear."*
 *
 * So four things are on the panel, permanently, above every disclosure:
 *
 *  1. the driving **provenance** badge, at `lg`;
 *  2. the driving **origin**, in full — `describeOrigin()` including the board,
 *     not the rail's compact kind — carrying `data-origin-physical`;
 *  3. `measurementVerdict()`, which is the sentence that settles *"is this a
 *     measurement?"* and is computed from `isPhysicallyObserved()` rather than
 *     from `provenance === 'observed'`;
 *  4. **PHYSICAL HARDWARE: NONE**, read off the counter. If it were ever
 *     non-zero this would say `n OBSERVED EVENTS` instead of keeping the
 *     reassuring word, exactly as the status strip's environment line does —
 *     both read the same field, so they cannot disagree.
 *
 * `display: inline` with real spaces on the physical-hardware line, and that is
 * a lesson rather than a style: W3 shipped the environment line as
 * `inline-flex` with a `gap`, which looked right and serialised as
 * `PHYSICAL HARDWARE:NONE` to `textContent` and to a screen reader, because a
 * flex item is blockified and a block box drops its trailing whitespace.
 */
export function TrustCard(props: TrustCardProps): ReactElement {
  const {
    drivingProvenance,
    drivingOrigin,
    physicallyObservedEvents,
    noLabHost,
    desktopSimulator,
    onMore,
  } = props;
  return (
    <section
      className={`pane panel-card panel-trust prov-banner prov-${drivingProvenance ?? 'none'}`}
      id="prov-banner"
      data-pane="trust"
      data-panel-card="trust"
      data-testid="panel-trust"
      aria-labelledby="panel-trust-title"
    >
      <h2 className="pane__header panel-card-title" data-pane-chrome="header">
        <span className="dock-section-label" id="panel-trust-title">
          Driving
        </span>
        <button
          type="button"
          className="panel-more"
          data-panel-more="trust"
          onClick={onMore}
          title="the backend switch, what this provenance means, and the counts behind it"
        >
          More
        </button>
      </h2>
      <div className="pane__content panel-card-body" data-pane-content="trust" data-scroll-owner="pane">
        {/*
          Both badges on ONE row. Two badges, never one: `provenance` says how
          much epistemic weight an event carries, `origin` says which boundary
          it crossed, and only the second distinguishes an emulated servo write
          from a measurement. The words that used to introduce them
          ("this scene is being driven by", "which crossed") are in the "More"
          screen: they are prose about the badges, and the badges are the claim.
        */}
        <div className="prov-banner-head" data-testid="panel-provenance">
          {drivingProvenance === null ? (
            <span className="prov prov-none">nothing yet</span>
          ) : (
            <ProvenanceTag value={drivingProvenance} />
          )}
          <span id="origin-banner">
            <OriginTag origin={drivingOrigin} />
          </span>
        </div>
        {/*
          The CLAIM, on the panel, at every width. The paragraph that explains
          it is in the "More" screen — an expansion of a correctness surface,
          which §11.4 allows, rather than the place it first appears, which it
          does not. Both come from the same `isPhysicallyObserved()` call.
        */}
        <p id="measurement-verdict">{measurementHeadline(drivingProvenance, drivingOrigin)}</p>
        <span className="panel-hardware" data-testid="panel-physical-hardware" data-physically-observed={physicallyObservedEvents}>
          <span className="panel-hardware-label">PHYSICAL HARDWARE: </span>
          <span className={physicallyObservedEvents === 0 ? 'panel-hardware-none' : 'panel-hardware-some'}>
            {physicallyObservedEvents === 0
              ? 'NONE'
              : `${String(physicallyObservedEvents)} OBSERVED EVENTS`}
          </span>
        </span>
        {noLabHost && (
          /*
            One line, on the panel, in the state where the default cannot be
            honoured. It is not a second opinion: `status.detail` says the same
            thing and `[data-testid="qemu-unreachable"]` in the "More" screen
            carries the paragraph and the command. What may not happen is the
            reader meeting only a red dot.
          */
          <p className="warn-inline panel-no-lab-host" data-testid="panel-no-lab-host">
            No lab host on this origin, so there is no emulator to drive.{' '}
            <button type="button" className="panel-inline-more" onClick={onMore}>
              how to start one
            </button>
          </p>
        )}
        {desktopSimulator && (
          /*
            The desktop app's own line. Not a duplicate of the origin badge
            above it — that badge says `host-model` once telemetry arrives, and
            this says it BEFORE anything has arrived, in the one arrangement
            where the reader has no address bar and no terminal to infer it
            from.

            Every clause has to be true in both states that reach it: a shipped
            build whose reader chose the simulator, and a build with no emulator
            backend that opened on it. So it says what is driving and what is
            not, and offers the backend switch rather than naming which of the
            two happened.
          */
          <p
            className="warn-inline panel-desktop-simulator"
            data-testid="panel-desktop-simulator"
          >
            This desktop window is being driven by the <b>behavioural simulator</b> — a host model,
            not the emulator and not hardware. No firmware is executing.{' '}
            <button type="button" className="panel-inline-more" onClick={onMore}>
              change what drives this
            </button>
          </p>
        )}
      </div>
    </section>
  );
}

/**
 * The command vocabulary, on the stage.
 *
 * Generated from `COMMAND_VOCABULARY` and `FACE_CATALOG`, exactly as before —
 * a hand-typed list cannot drift away from `hardware/hardware-map.json`, and
 * that includes the parts nobody would have typed, like the fact that the two
 * ⚠ faces have zero frames and draw nothing at all.
 */
export function CommandBar(props: CommandBarProps): ReactElement {
  const { backend, status, busy, error, onCommand, onFace, onStop, variant = 'full' } = props;
  const panel = variant === 'panel';

  const all = COMMAND_VOCABULARY.filter((c) => c.command !== '' && c.command !== 'stop');
  const commands =
    panel && PANEL_COMMANDS !== null
      ? all.filter((c) => PANEL_COMMANDS.includes(c.command))
      : all;
  /*
    The two ⚠ faces are in BOTH lists on purpose. `setFace("stand")` and
    `setFace("default")` draw nothing at all — the bitmap is weak-undefined,
    ISSUE-20260823-004 — and that is a correctness surface rather than a
    curiosity. A "minimal" panel that showed the eight faces that work and hid
    the two that do not would be the exact tidying-away §11.4 forbids.
  */
  const faces = panel ? [] : FACE_SHORTLIST;

  // A backend that has not finished connecting cannot run anything, and on the
  // QEMU path saying so matters: the lab host answers a command posted mid-boot
  // with 503, and a button that looks live but is not is worse than one that is
  // visibly waiting. The emulator takes 2-17 s to boot.
  const ready = status.connection === 'connected';
  const commandsDisabled = !backend.canCommand || !ready || busy !== null;

  return (
    <section
      className={`panel command-bar${panel ? ' command-bar-panel' : ''}`}
      data-testid={panel ? 'command-bar' : 'command-bar-full'}
      data-variant={variant}
    >
      {!panel && (
        <header className="panel-header">
          <h2>Commands</h2>
          <span className="panel-sub">from hardware-map.json, not hardcoded</span>
        </header>
      )}

      {!backend.canCommand && (
        <div className="warn" data-testid="read-only-warning">
          <strong>This backend is receive-only.</strong>
          <p>{backend.commandUnavailableReason}</p>
        </div>
      )}

      {backend.canCommand && !ready && (
        <p className="note muted" data-testid="commands-not-ready">
          Commands are disabled until the backend is connected — it is{' '}
          <code>{status.connection}</code>. Posting a command to an emulator that has not finished
          booting gets a <code>503</code>, and a button that looks live but is not teaches the wrong
          thing about what is happening.
        </p>
      )}

      <div className="cmd-grid">
        {commands.map((c) => (
          <button
            key={c.command}
            type="button"
            className={`cmd${c.continuous ? ' cmd-continuous' : ''}`}
            data-command={c.command}
            disabled={commandsDisabled}
            onClick={() => onCommand(c.command)}
            title={
              c.movementFunction === null
                ? c.command
                : `${c.movementFunction}()${c.continuous ? ' — never clears currentCommand, so loop() repeats it' : ''}`
            }
          >
            {c.command}
          </button>
        ))}
        <button
          type="button"
          className="cmd cmd-stop"
          data-command="stop"
          disabled={!backend.canCommand || !ready}
          onClick={onStop}
          title="/cmd?stop= just clears currentCommand — and notably does NOT call exitIdle()"
        >
          stop
        </button>
      </div>

      {!panel && (
      <div className="cmd-grid faces">
        {faces.map((name) => (
          <button
            key={name}
            type="button"
            className="cmd cmd-face"
            data-face={name}
            disabled={commandsDisabled}
            onClick={() => onFace(name)}
          >
            {name}
          </button>
        ))}
        {BROKEN_FACES.map((name) => (
          <button
            key={name}
            type="button"
            className="cmd cmd-face cmd-broken"
            data-face={name}
            disabled={commandsDisabled}
            onClick={() => onFace(name)}
            title={`setFace("${name}") draws nothing — the bitmap is weak-undefined. ISSUE-20260823-004`}
          >
            {name} ⚠
          </button>
        ))}
      </div>
      )}

      {panel ? (
        <p className="note muted">
          {commands.length === all.length
            ? `all ${String(all.length)} commands, from hardware-map.json`
            : `${String(commands.length)} of ${String(all.length)} commands`}
        </p>
      ) : (
        <p className="note muted">
          {FACE_CATALOG.length} faces are registered in the firmware; the two marked ⚠ have zero
          frames and draw nothing at all.
        </p>
      )}

      {busy !== null && (
        <p className="note" id="busy">
          running <code>{busy}</code>…
        </p>
      )}
      {error !== null && (
        <p className="warn-inline" id="cmd-error">
          {error}
        </p>
      )}
    </section>
  );
}

export interface FaceBarProps {
  readonly backend: TelemetryBackend;
  readonly status: BackendStatus;
  readonly busy: string | null;
  readonly onFace: (name: string) => void;
}

/**
 * The face vocabulary, on the side panel's FACE card — Phase 4 W7.
 *
 * It used to be the second grid inside `CommandBar`, which put the buttons that
 * change the face three cards away from the glass they change. Moving them here
 * costs nothing and buys the Commands card back about 100 px of the panel's
 * height, which is the currency §11.4 will not let the panel spend on a
 * scroller.
 *
 * The two ⚠ faces come with them. A "minimal" panel that showed the two that
 * work and hid the two that draw nothing would be exactly the tidying-away the
 * plan forbids.
 */
export function FaceBar(props: FaceBarProps): ReactElement {
  const { backend, status, busy, onFace } = props;
  const disabled = !backend.canCommand || status.connection !== 'connected' || busy !== null;
  return (
    <div className="face-bar" data-testid="face-bar">
      <div className="cmd-grid faces">
        {PANEL_FACES.map((name) => (
          <button
            key={name}
            type="button"
            className="cmd cmd-face"
            data-face={name}
            disabled={disabled}
            onClick={() => onFace(name)}
          >
            {name}
          </button>
        ))}
        {BROKEN_FACES.map((name) => (
          <button
            key={name}
            type="button"
            className="cmd cmd-face cmd-broken"
            data-face={name}
            disabled={disabled}
            onClick={() => onFace(name)}
            title={`setFace("${name}") draws nothing — the bitmap is weak-undefined. ISSUE-20260823-004`}
          >
            {name} ⚠
          </button>
        ))}
      </div>
      <p className="note muted">
        <span data-zero-frame-faces={String(BROKEN_FACES.length)}>
          ⚠ {BROKEN_FACES.length} of {FACE_CATALOG.length} faces draw nothing
        </span>
      </p>
    </div>
  );
}
