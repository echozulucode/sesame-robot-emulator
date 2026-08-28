/**
 * The NARROW representation — Phase 4 W4, the brief's `< 720 px` artifact.
 *
 * Not a smaller graph. A different one:
 *
 * ```text
 * WAVE
 * Movement
 *   wave()
 *     ↓ calls
 *   setServoAngle(...)
 *     ↓ library
 *   ESP32Servo
 *     ↓ implementation
 *   LEDC
 *     ↓ output mapping
 *   GPIO 18
 *     ↓ drives
 *   MG90S front-right shoulder
 *     ↓ rotates
 *   shoulder joint
 *
 * [OBSERVED] [QEMU] wave() entered
 * [OBSERVED] [QEMU] servo target set to 42°
 * [INFERRED] [QEMU] pwm.output would correspond to …
 * ```
 *
 * > *"This is not 'dumbing down' the graph. It is changing from an overview
 * > task to a tracing task, which is exactly what the product says it is
 * > trying to teach."*
 *
 * ## What this buys, measured
 *
 * Everything here is ordinary flow text at the W1 tokens — the node name at
 * `--font-code` (15 px), the relation and the summary at `--font-badge`
 * (14 px). There is no pan/zoom transform anywhere in the subtree, so the
 * authored size IS the on-screen size. The same information in React Flow at
 * the same pane width lands at 3.8-8.0 px, which is what W1 measured and what
 * no type token can fix.
 *
 * ## What it does NOT drop
 *
 * - **Cross-highlighting.** Every step is `[data-arch-node]` and calls the same
 *   `onSelect` the full graph does, so `SelectionState` — the object the 3D
 *   scene, the trace, the inspector and the source pane all share — is written
 *   and read exactly as before. Clicking `R4` in the 3D view lights the `R4`
 *   step here; clicking the `R4` step here lights the mesh.
 * - **The five hand-authored claims.** A step reached by a hand-authored edge
 *   renders the dashed marker and says so in words, because `servo.mg90s ->
 *   joint.*` — the edge this view walks every time it ends on a joint — is one
 *   of the five.
 * - **The unresolved marker.** `MG90S` is still the warning colour with its `?`.
 * - **`channelPerJointKnown: false`.** Nothing here prints a channel number,
 *   for the same reason nothing else does.
 */
import { useState, type ReactElement } from 'react';

import { OriginTag } from './ProvenanceTag.js';
import { UPSTREAM_COMMIT, type ArchNode } from '../generated/architecture-graph.js';
import { childrenOf } from '../arch/layout.js';
import { type CausalPath, type PathStep } from '../arch/representation.js';
import { nodeIsRelated, nodeIsSelected, type SelectionState } from '../state/selection.js';
import { traceBadge, type Trace, type TraceRow } from '../state/trace-store.js';

export interface ArchitecturePathProps {
  readonly path: CausalPath;
  readonly selection: SelectionState;
  readonly onSelect: (nodeId: string | null) => void;
  readonly activeNodeIds: ReadonlySet<string>;
  /** The trace on screen, for the provenance-tagged events under the chain. */
  readonly trace: Trace | null;
  readonly onSelectRow: (row: TraceRow) => void;
}

/** How many events the chain lists before it starts counting them. */
const EVENTS_SHOWN = 6;

function stepClasses(
  node: ArchNode,
  selection: SelectionState,
  active: boolean,
  isFocus: boolean,
): string {
  return [
    'arch-step',
    `arch-kind-${node.kind}`,
    nodeIsSelected(node.id, selection) ? 'is-selected' : '',
    nodeIsRelated(node.id, selection) ? 'is-related' : '',
    active ? 'is-active' : '',
    isFocus ? 'is-focus' : '',
    node.derivation === 'hand-authored' ? 'is-hand-authored' : '',
    node.unresolved !== null ? 'is-unresolved' : '',
  ]
    .filter((c) => c.length > 0)
    .join(' ');
}

/**
 * One rung, and the edge that reached it.
 *
 * The relation is drawn ABOVE the node it leads to, which is the shape of the
 * brief's example and also the reading order of a trace: what happened, then
 * what it caused.
 */
function Step({
  step,
  index,
  focusId,
  selection,
  activeNodeIds,
  onSelect,
}: {
  readonly step: PathStep;
  readonly index: number;
  readonly focusId: string;
  readonly selection: SelectionState;
  readonly activeNodeIds: ReadonlySet<string>;
  readonly onSelect: (nodeId: string | null) => void;
}): ReactElement {
  const { node, via, branches, allBranches, branchesOmitted } = step;
  const active = activeNodeIds.has(node.id);
  const hidden = childrenOf(node.id).length;
  /*
   * Every branch, on request.
   *
   * Three chips is what fits without turning a chain into a list, but "three
   * and a number" would make most of the graph UNREACHABLE from this
   * representation - and reachability is the promise the three representations
   * share. `+18 more` opens the rest in place, so `joint.R4` can still be
   * selected from a path that ends at `joint.R1`.
   */
  const [allShown, setAllShown] = useState(false);
  const shown = allShown ? allBranches : branches;

  return (
    <li className="arch-step-row" data-arch-step={String(index)}>
      {via !== null && (
        <div
          className={`arch-step-edge${via.derivation === 'hand-authored' ? ' is-hand-authored' : ''}`}
          data-arch-edge-derivation={via.derivation}
        >
          <span className="arch-step-arrow" aria-hidden="true">
            ↓
          </span>
          <span className="arch-step-relation">
            {via.label ?? 'leads to'}
            {via.derivation === 'hand-authored' && (
              <span className="arch-step-hand"> · hand-authored, not in the data</span>
            )}
          </span>
        </div>
      )}

      <button
        type="button"
        className={stepClasses(node, selection, active, node.id === focusId)}
        data-arch-node={node.id}
        data-arch-path-step={node.id}
        data-selected={String(nodeIsSelected(node.id, selection))}
        data-active={String(active)}
        data-derivation={node.derivation}
        aria-current={node.id === focusId ? 'true' : undefined}
        onClick={() => onSelect(nodeIsSelected(node.id, selection) ? null : node.id)}
      >
        <span className="arch-step-label">
          {node.label}
          {node.unresolved !== null && (
            <span
              className="arch-flag"
              title={`hardware-map.json → unresolved[${node.unresolved}]`}
            >
              ?
            </span>
          )}
        </span>
        <span className="arch-step-summary">{node.summary}</span>
        <span className="arch-step-meta">
          {node.sourceRef !== null && (
            <code className="arch-step-source">
              {node.sourceRef.file.replace(/^firmware\//, '')}:{node.sourceRef.line}
            </code>
          )}
          {hidden > 0 && <span className="arch-step-count">{hidden} inside</span>}
        </span>
      </button>

      {(branches.length > 0 || branchesOmitted > 0) && (
        <div className="arch-branches" data-arch-branches={node.id}>
          <span className="arch-branch-key">also from here</span>
          {shown.map((branch) => (
            <button
              key={branch.id}
              type="button"
              className={`arch-branch${activeNodeIds.has(branch.id) ? ' is-active' : ''}`}
              /*
                `data-arch-node` as well as `data-arch-branch`, because a branch
                chip IS a node a reader can select and every representation has
                to answer the same question the same way. V8's cross-highlight
                assertion clicks `[data-arch-node="joint.R4"]`; without this it
                would find nothing here and the check would have to be softened
                for one representation, which is how an invariant stops meaning
                anything.
              */
              data-arch-node={branch.id}
              data-arch-branch={branch.id}
              data-selected={String(nodeIsSelected(branch.id, selection))}
              data-active={String(activeNodeIds.has(branch.id))}
              data-derivation={branch.derivation}
              title={branch.summary}
              onClick={() => onSelect(branch.id)}
            >
              {branch.label}
            </button>
          ))}
          {branchesOmitted > 0 && (
            <button
              type="button"
              className="arch-branch-more"
              data-arch-branches-more={node.id}
              aria-expanded={allShown}
              onClick={() => setAllShown(!allShown)}
            >
              {allShown ? 'show fewer' : `+${String(branchesOmitted)} more`}
            </button>
          )}
        </div>
      )}
    </li>
  );
}

/**
 * The events this path produced, with their provenance and origin in words.
 *
 * The brief's worked example puts them directly under the chain, and at this
 * pane width they cannot be read in the Signal pane at the same time — below
 * 1700 px the workbench shows one pane, so "the graph and the trace on screen
 * together" is not available here and a summary is the honest substitute.
 *
 * Only rows whose `nodeId` is ON the path, so this can never be a second,
 * differently-filtered trace: it is the same rows the Signal pane renders,
 * narrowed to the chain above them, and clicking one selects it there.
 */
function PathEvents({
  path,
  trace,
  onSelectRow,
}: {
  readonly path: CausalPath;
  readonly trace: Trace | null;
  readonly onSelectRow: (row: TraceRow) => void;
}): ReactElement {
  const onPath = new Set(path.nodeIds);
  const rows = (trace?.rows ?? []).filter((row) => row.nodeId !== null && onPath.has(row.nodeId));
  if (trace === null) {
    return (
      <p className="note muted" data-testid="arch-path-events-empty">
        Run a command and the events this chain produced appear here, each with the provenance and
        origin the Signal pane gives it.
      </p>
    );
  }
  const shown = rows.slice(0, EVENTS_SHOWN);
  return (
    <div className="arch-path-events" data-testid="arch-path-events">
      <h3 className="arch-path-events-title">
        what this chain did · <code>{trace.command}</code>
      </h3>
      {shown.length === 0 ? (
        <p className="note muted">
          No event in <code>{trace.id}</code> belongs to a node on this chain.
        </p>
      ) : (
        <ol className="arch-event-list">
          {shown.map((row) => {
            const badge = traceBadge(row);
            return (
              <li
                key={row.id}
                className="arch-event"
                data-arch-event={row.id}
                data-layer={row.layer}
                data-provenance={row.provenance}
                data-physically-observed={String(row.physicallyObserved)}
              >
                <button type="button" className="arch-event-btn" onClick={() => onSelectRow(row)}>
                  <span className={`prov prov-${badge.tone}`}>{badge.text}</span>
                  <OriginTag origin={row.origin} compact />
                  <code className="arch-event-layer">{row.layer}</code>
                  <span className="arch-event-label">{row.label}</span>
                </button>
              </li>
            );
          })}
        </ol>
      )}
      {rows.length > shown.length && (
        <p className="note muted" data-testid="arch-events-more">
          {rows.length - shown.length} more on this chain — the Signal pane has all{' '}
          {trace.rows.length}.
        </p>
      )}
    </div>
  );
}

export function ArchitecturePath(props: ArchitecturePathProps): ReactElement {
  const { path, selection, onSelect, activeNodeIds, trace, onSelectRow } = props;

  return (
    <div className="arch-path" data-testid="arch-path" data-focus-node={path.focusId}>
      <p className="arch-path-lede">
        The chain the firmware actually walks to reach{' '}
        <b>{path.steps[path.steps.length - 1]?.node.label ?? 'this part'}</b>. Every step is
        projected from <code>hardware/hardware-map.json</code> at upstream{' '}
        <code>{UPSTREAM_COMMIT.slice(0, 7)}</code>; a dashed relation is a claim the data cannot
        make.
      </p>
      <ol className="arch-steps" data-testid="arch-steps">
        {path.steps.map((step, index) => (
          <Step
            key={step.node.id}
            step={step}
            index={index}
            focusId={path.focusId}
            selection={selection}
            activeNodeIds={activeNodeIds}
            onSelect={onSelect}
          />
        ))}
      </ol>
      <PathEvents path={path} trace={trace} onSelectRow={onSelectRow} />
    </div>
  );
}
