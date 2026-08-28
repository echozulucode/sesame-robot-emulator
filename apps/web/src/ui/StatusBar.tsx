/**
 * The thin status line under the robot, and the quick-run cluster on it.
 *
 * ## What it replaced
 *
 * U1–U5 put the command vocabulary and the OLED in a `clamp(120px, 20vh,
 * 176px)` strip under the stage. That strip cost the 3D viewport up to 176 px
 * of the height the whole change existed to give it back, which is why it is
 * gone: the two panes moved into the control dock, and this line took the
 * space. It is 34 px, it never scrolls, and it never wraps.
 *
 * ## It is a GLANCE line, not a third copy of the inspector
 *
 * Every value here is a summary of something the inspector states in full, read
 * from the same store fields, so the two cannot disagree:
 *
 *  - the connection dot and word — `BackendStatus.connection`
 *  - the provenance and origin chips — `store.drivingProvenance` /
 *    `store.drivingOrigin`, the same two values the rail's chip and
 *    `#prov-banner` read
 *
 * Nothing here computes a verdict. `isPhysicallyObserved()`, the `conceptual`
 * badges, the NOT BUILT panels and the modifying-this-robot banner are
 * correctness surfaces and they stay exactly where they are.
 *
 * ## Content scales with the window
 *
 * | Breakpoint | What is on the line |
 * |---|---|
 * | Compact | connection · provenance · origin · `wave` `stop` |
 * | Medium  | + event count, physically-observed count, backend, board · `stand` `rest` |
 * | Wide    | + joint summary, boot attempts, ground plane, origin engine |
 *
 * The line is driven by the shell's breakpoint rather than by its own width so
 * that what it shows is testable from `window.__sesame.shell()` rather than by
 * reading pixels, and so that it agrees with which dock layout is in force.
 *
 * ## The quick-run cluster, and why it exists
 *
 * Moving the command vocabulary into a dock puts it behind a click at Compact
 * and Medium, where the docks start shut. The harness asserted that a reader
 * can reach `wave` at every breakpoint **without opening anything**, and that
 * assertion is worth keeping, so this line carries the three commands worth one
 * click plus `stop`.
 *
 * They are `data-quick-command`, never `data-command`: `[data-command="wave"]`
 * stays the single, unambiguous handle on the real vocabulary button in the
 * Commands section, so nothing in the harness can accidentally click a
 * shortcut when it meant the vocabulary — or vice versa. The names come from
 * `COMMAND_VOCABULARY`, which is a checked mirror of
 * `hardware/hardware-map.json`, so a shortcut cannot name a command the
 * firmware does not have; `status-bar.test.ts` fails if one does.
 */
import { COMMAND_VOCABULARY, type OriginKind, type Provenance, type TelemetryOrigin } from '@sesame-lab/sesame-protocol';
import type { ReactElement } from 'react';

import type { BackendId, BackendStatus, EmulatorFacts } from '../backends/types.js';
import { OriginTag, ProvenanceTag } from './ProvenanceTag.js';
import type { Breakpoint } from './shell-state.js';

/**
 * The commands worth a permanent button, in the order they appear.
 *
 * `wave` first because it is the demonstration this whole project opens with,
 * and because it is the one the harness reaches for. Compact shows only the
 * first; Medium and Wide show all three. `stop` is always present — a running
 * `forward` is continuous and never clears `currentCommand` on its own.
 */
export const PRIMARY_COMMANDS = ['wave', 'stand', 'rest'] as const;

/** Every {@link PRIMARY_COMMANDS} entry really is in the firmware's vocabulary. */
export const primaryCommandsAreInVocabulary = (): boolean =>
  PRIMARY_COMMANDS.every((name) => COMMAND_VOCABULARY.some((c) => c.command === name));

/** How many of {@link PRIMARY_COMMANDS} this width has room for. */
export const primaryCommandCount = (breakpoint: Breakpoint): number =>
  breakpoint === 'compact' ? 1 : PRIMARY_COMMANDS.length;

export interface StatusBarProps {
  readonly breakpoint: Breakpoint;
  readonly status: BackendStatus;
  readonly backendId: BackendId;
  readonly drivingProvenance: Provenance | null;
  readonly drivingOrigin: TelemetryOrigin | null;
  readonly provenanceCounts: Readonly<Record<Provenance, number>>;
  readonly originCounts: Readonly<Record<OriginKind, number>>;
  readonly totalEvents: number;
  readonly physicallyObservedEvents: number;
  readonly emulatorFacts: EmulatorFacts | null;
  readonly groundPlaneMm: number | null;
  /** Joints whose `commandedDeg` is no longer `null`, and how many there are. */
  readonly jointsCommanded: number;
  readonly jointCount: number;
  readonly selectedJoint: string | null;
  readonly selectedJointDeg: number | null;
  readonly canCommand: boolean;
  readonly busy: string | null;
  readonly onCommand: (name: string) => void;
  readonly onStop: () => void;
}

export function StatusBar(props: StatusBarProps): ReactElement {
  const {
    breakpoint,
    status,
    backendId,
    drivingProvenance,
    drivingOrigin,
    totalEvents,
    physicallyObservedEvents,
    emulatorFacts,
    groundPlaneMm,
    jointsCommanded,
    jointCount,
    selectedJoint,
    selectedJointDeg,
    canCommand,
    busy,
    onCommand,
    onStop,
  } = props;

  const detailed = breakpoint !== 'compact';
  const full = breakpoint === 'wide';
  const ready = status.connection === 'connected';
  const disabled = !canCommand || !ready || busy !== null;
  const board = emulatorFacts?.board ?? drivingOrigin?.board ?? null;
  const attempts = status.attempts ?? 1;

  return (
    <div className="stage-status" data-testid="stage-status" data-detail={breakpoint}>
      <span
        className={`status-dot conn-${status.connection}`}
        data-testid="status-conn"
        data-connection={status.connection}
        title={status.detail}
        aria-hidden="true"
      >
        ●
      </span>
      <span className="status-word" title={status.detail}>
        {status.connection}
      </span>

      {/*
        The same two values as the rail's chip and as `#prov-banner` in the
        inspector, read from the same two store fields. A summary, never a
        second opinion.
      */}
      <span
        className="status-prov"
        data-testid="status-provenance"
        data-provenance={drivingProvenance ?? 'none'}
      >
        {drivingProvenance === null ? (
          <span className="prov prov-none">nothing yet</span>
        ) : (
          <ProvenanceTag value={drivingProvenance} />
        )}
        <OriginTag origin={drivingOrigin} />
      </span>

      {detailed && (
        <>
          <span className="status-sep" aria-hidden="true" />
          <span className="status-word" data-testid="status-events">
            {totalEvents} events
          </span>
          {/*
            Not a duplicate of the emulator panel's prose: one number, and the
            one that matters most — how many of those events crossed a physical
            boundary. It is 0 for every backend this project has.
          */}
          <span className="status-word dim" data-testid="status-observed">
            {physicallyObservedEvents} physically observed
          </span>
          <span className="status-sep" aria-hidden="true" />
          <span className="status-word mono" data-testid="status-backend">
            {backendId}
          </span>
          {board !== null && (
            <span className="status-word mono dim" data-testid="status-board">
              {board}
            </span>
          )}
        </>
      )}

      {full && (
        <>
          <span className="status-sep" aria-hidden="true" />
          <span className="status-word" data-testid="status-joints">
            {selectedJoint === null || selectedJointDeg === null
              ? `${jointsCommanded}/${jointCount} joints commanded`
              : `${selectedJoint} ${selectedJointDeg.toFixed(0)}°`}
          </span>
          {groundPlaneMm !== null && (
            <span className="status-word dim" data-testid="status-ground">
              ground {groundPlaneMm.toFixed(1)} mm
            </span>
          )}
          {attempts > 1 && (
            <span className="status-word warn-word" data-testid="status-boot-attempts">
              boot attempt {attempts}
            </span>
          )}
          {drivingOrigin?.engine !== undefined && (
            <span className="status-word mono dim" data-testid="status-engine">
              {drivingOrigin.engine}
            </span>
          )}
        </>
      )}

      {/*
        The quick-run cluster. `data-quick-command`, not `data-command`: the
        vocabulary in the control dock keeps the single `[data-command="wave"]`
        handle, and these are shortcuts rather than a second vocabulary.
      */}
      <div className="status-run" data-testid="status-run">
        {PRIMARY_COMMANDS.slice(0, primaryCommandCount(breakpoint)).map((name) => (
          <button
            key={name}
            type="button"
            className="status-cmd"
            data-quick-command={name}
            disabled={disabled}
            onClick={() => onCommand(name)}
            title={`${name} — the same command as the ${name} button in the Commands section`}
          >
            {name}
          </button>
        ))}
        <button
          type="button"
          className="status-cmd status-cmd-stop"
          data-quick-command="stop"
          disabled={!canCommand || !ready}
          onClick={onStop}
          title="/cmd?stop= just clears currentCommand — and notably does NOT call exitIdle()"
        >
          stop
        </button>
      </div>
    </div>
  );
}
