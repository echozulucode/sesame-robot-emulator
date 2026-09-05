/**
 * The fault injector — a Lab tool, borrowed by Learn.
 *
 * ## The distinction this panel exists to make
 *
 * `hardware/lessons.json` declares seven faults, and **three of them are not
 * injected at all**: the blank `stand` face, the command word that never
 * clears, and the quote that breaks `/api/status` are the shipped firmware's
 * own behaviour. Turn nothing on and they still happen.
 *
 * A learner who cannot tell "this robot is genuinely broken" from "we broke it
 * for you" has learned the wrong thing about debugging, so `injectorIsLabFeature`
 * is not a footnote here — it sorts the list into two headed groups, the
 * shipped ones have no switch to flip, and each carries the note L5 wrote about
 * exactly which part is real. `oled-init-fail` is the sharpest case: the
 * `while (1);` is real firmware, and making `display.begin()` return false on
 * demand is ours.
 */
import type { ReactElement } from 'react';

import { DECLARED_FAULTS } from '../generated/lessons.js';

export interface FaultInjectorProps {
  readonly active: ReadonlySet<string>;
  readonly onToggle: (id: string, on: boolean) => void;
  /** Show only this fault, the way a lesson step naming one does. */
  readonly only?: string | null;
  readonly onSelectSymbol?: ((symbolId: string) => void) | undefined;
  /** Run the lab's boot model with whatever is switched on. */
  readonly onBoot?: (() => void) | undefined;
  readonly bootLog?: readonly string[] | undefined;
  readonly bootHaltedAt?: number | null | undefined;
}

export function FaultInjector(props: FaultInjectorProps): ReactElement {
  const { active, onToggle, only = null, onSelectSymbol, onBoot, bootLog, bootHaltedAt } = props;
  const shown = only === null ? DECLARED_FAULTS : DECLARED_FAULTS.filter((f) => f.id === only);
  const injected = shown.filter((f) => f.injectorIsLabFeature);
  const shipped = shown.filter((f) => !f.injectorIsLabFeature);

  return (
    <div className="editor editor-faults" data-testid="fault-injector">
      {shipped.length > 0 && (
        <section data-testid="faults-shipped">
          <h5 className="fault-group is-shipped">
            Shipped behaviour &mdash; nothing was injected
          </h5>
          {shipped.map((fault) => (
            <div key={fault.id} className="fault-card is-shipped" data-fault={fault.id} data-injected="false">
              <div className="fault-title">
                <b>{fault.title}</b>
                <span className="fault-badge is-shipped">REAL</span>
              </div>
              <p className="note">{fault.note}</p>
              <p className="note muted small">
                cause:{' '}
                <button
                  type="button"
                  className="linkish mono"
                  onClick={() => onSelectSymbol?.(fault.causeSymbol)}
                  disabled={onSelectSymbol === undefined}
                >
                  {fault.causeSymbol}
                </button>{' '}
                &middot; {fault.teachingNote}
              </p>
            </div>
          ))}
        </section>
      )}

      {injected.length > 0 && (
        <section data-testid="faults-injected">
          <h5 className="fault-group is-injected">Injected by Sesame Robot Emulator</h5>
          {injected.map((fault) => (
            <div key={fault.id} className="fault-card is-injected" data-fault={fault.id} data-injected="true">
              <div className="fault-title">
                <label>
                  <input
                    type="checkbox"
                    checked={active.has(fault.id)}
                    data-testid={`fault-${fault.id}`}
                    onChange={(e) => onToggle(fault.id, e.target.checked)}
                  />{' '}
                  <b>{fault.title}</b>
                </label>
                <span className="fault-badge is-injected">INJECTED</span>
              </div>
              <p className="note">{fault.note}</p>
              <p className="note muted small">
                cause:{' '}
                <button
                  type="button"
                  className="linkish mono"
                  onClick={() => onSelectSymbol?.(fault.causeSymbol)}
                  disabled={onSelectSymbol === undefined}
                >
                  {fault.causeSymbol}
                </button>{' '}
                &middot; {fault.teachingNote}
              </p>
            </div>
          ))}
        </section>
      )}

      {onBoot !== undefined && (
        <div className="editor-row">
          <button type="button" className="lesson-button is-primary" data-testid="fault-boot" onClick={onBoot}>
            boot the robot
          </button>
          <span className="muted small" data-testid="fault-boot-result">
            {bootLog === undefined || bootLog.length === 0
              ? 'not booted yet'
              : bootHaltedAt === null || bootHaltedAt === undefined
                ? 'setup() completed'
                : `halted at boot step ${String(bootHaltedAt)}`}
          </span>
        </div>
      )}
      {bootLog !== undefined && bootLog.length > 0 && (
        <pre className="boot-log mono" data-testid="fault-boot-log">
          {bootLog.join('\n')}
        </pre>
      )}
    </div>
  );
}
