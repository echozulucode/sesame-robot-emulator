/**
 * What the asset says about itself.
 *
 * Every value here is read out of the GLB at runtime — V2 shipped its own
 * provenance inside the file, so a viewer does not need a sidecar document and
 * cannot show a stale copy of one. The three items under "do not assume" are
 * V2's own list, quoted rather than summarised.
 */
import type { ReactElement } from 'react';

import type { AssetFacts } from '../three/rig.js';

export interface AssetPanelProps {
  readonly facts: AssetFacts | null;
  readonly groundPlaneMm: number | null;
  readonly showTopCover: boolean;
  readonly onToggleTopCover: (show: boolean) => void;
  readonly driveFromSimulated: boolean;
  readonly onDriveFromSimulated: (value: boolean) => void;
  readonly canDriveFromSimulated: boolean;
}

export function AssetPanel(props: AssetPanelProps): ReactElement {
  const { facts, groundPlaneMm, showTopCover, onToggleTopCover } = props;

  return (
    <section className="panel" data-testid="asset">
      <header className="panel-header">
        <h2>Asset</h2>
        <span className="panel-sub">assets/sesame.glb</span>
      </header>

      <div className="toggles">
        <label>
          <input type="checkbox" checked={showTopCover} onChange={(e) => onToggleTopCover(e.target.checked)} />
          show top cover
        </label>
        <label className={props.canDriveFromSimulated ? '' : 'disabled'}>
          <input
            type="checkbox"
            checked={props.driveFromSimulated}
            disabled={!props.canDriveFromSimulated}
            onChange={(e) => props.onDriveFromSimulated(e.target.checked)}
            id="drive-simulated"
          />
          animate from <code>simulatedDeg</code> (model slew)
        </label>
      </div>

      {facts === null ? (
        <p className="muted">loading…</p>
      ) : (
        <dl className="kv">
          <dt>frame</dt>
          <dd className="small">
            <code>{facts.canonicalFrame.id}</code> — {facts.canonicalFrame.upAxis} up,{' '}
            {facts.canonicalFrame.forwardAxis} forward, {facts.canonicalFrame.rightAxis} the robot's own right.
            World space is this frame, in metres. No axis conversion anywhere.
          </dd>

          <dt>pose rule</dt>
          <dd className="mono small">{facts.poseRule.statement}</dd>

          <dt>ground plane</dt>
          <dd className="small" id="ground-plane">
            {groundPlaneMm === null ? (
              <span className="muted">computing…</span>
            ) : (
              <b>{groundPlaneMm.toFixed(3)} mm</b>
            )}{' '}
            <span className="muted">
              recomputed from the posed foot vertices every time the pose changes — not a constant. V2
              recorded {facts.groundPlane.atRunStandPoseMm.toFixed(3)} mm at <code>runStandPose</code> and{' '}
              {facts.groundPlane.atRestPoseMm.toFixed(3)} mm at rest; the feet are horizontal at rest, so the
              robot stands higher.
            </span>
          </dd>

          <dt>OLED plane</dt>
          <dd className="small">
            {facts.oled.planeSizeMm[0]} × {facts.oled.planeSizeMm[1]} mm, tilted{' '}
            {facts.oled.tiltFromVerticalDeg ?? '?'}° back{' '}
            <span className="warn-inline">{facts.oled.planeStatus}</span>
            <div className="muted">
              The CAD glass window ({facts.oled.cadGlassWindowMm?.join(' × ') ?? '?'} mm) was read exactly out
              of the STEP; the 2:1 active plane the framebuffer is mapped onto is a <em>decision of V2</em>,
              not a measurement. A real 0.96" SSD1306's active area is smaller than its glass.
            </div>
          </dd>

          {facts.topCoverSubstitution !== null && (
            <>
              <dt>top cover</dt>
              <dd className="small">
                <code>{facts.topCoverSubstitution.shipped}</code>{' '}
                <span className="warn-inline">substituted</span>
                <div className="muted">
                  The recommended print is <code>{facts.topCoverSubstitution.substitutedFor}</code> and it is{' '}
                  <b>not watertight</b> (ISSUE-20260823-006). What you see is not the recommended part.
                </div>
              </dd>
            </>
          )}

          <dt>verification</dt>
          <dd className="small warn-inline">{String(facts.verificationStatus)}</dd>

          {facts.doNotAssume.length > 0 && (
            <>
              <dt>do not assume</dt>
              <dd className="small">
                <ul className="tight">
                  {facts.doNotAssume.map((item) => (
                    <li key={item}>{item}</li>
                  ))}
                </ul>
              </dd>
            </>
          )}

          {facts.knownDiscrepancies.length > 0 && (
            <>
              <dt>open discrepancies</dt>
              <dd className="small">
                <ul className="tight">
                  {facts.knownDiscrepancies.map((d) => (
                    <li key={d.id}>
                      <code>{d.id}</code> — {d.detail}
                    </li>
                  ))}
                </ul>
              </dd>
            </>
          )}
        </dl>
      )}
    </section>
  );
}
