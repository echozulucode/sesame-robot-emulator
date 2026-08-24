/**
 * "What am I actually looking at?" — the panel a QEMU run must not be shown
 * without.
 *
 * A learner watching this app move a robot has three plausible beliefs
 * available, and only one of them is true:
 *
 * 1. a robot moved   — **false**, and `isPhysicallyObserved()` says so per event;
 * 2. a model guessed — **false** on this backend, and it matters that it is:
 *    the firmware really executed;
 * 3. real firmware ran on an emulated chip that is **not the chip in the pin
 *    diagram** — true, and unguessable from a moving 3D robot.
 *
 * Nothing on this panel is asserted by the app. Every field is transported from
 * `QemuSesameRobot.capabilities()`, which is the only party that knows what its
 * own emulator does and does not model. The app's job is to refuse to hide it.
 *
 * The two rows that exist purely because their absence would mislead:
 *
 * - **`unsupportedBoards`.** The recommended DIY board (S2 Mini) has no QEMU
 *   machine at all, and the *current* Distro board never reaches `setup()`.
 *   A learner reading the S2 Mini pin diagram elsewhere in this project while
 *   watching this scene move is being shown two different machines.
 * - **`elided`.** Negative evidence. Without it, "no Wi-Fi events" reads as
 *   "the radio was idle" instead of "there is no radio".
 */
import type { RobotMode } from '@sesame-lab/sesame-model';
import { JOINT_ORDER } from '@sesame-lab/sesame-model';
import type { ReactElement } from 'react';

import type { BackendStatus, EmulatorFacts } from '../backends/types.js';
import { OriginTag } from './ProvenanceTag.js';

/**
 * What `RobotState.mode` means, with **an arm for every `RobotMode`**.
 *
 * `Record<RobotMode, string>` rather than a `switch` with a default, so adding
 * a fifth mode to the union is a compile error here rather than a silent
 * fallthrough to whatever the default said. `'qemu'` is the arm Q2 added.
 */
export const MODE_MEANING: Readonly<Record<RobotMode, string>> = {
  real: 'a physical Sesame. Nothing in this project reports this, because none exists.',
  simulated: 'a host-side behaviour model. No firmware executed.',
  renode: 'the Renode emulator. Superseded and closed wont_fix; nothing reports this.',
  qemu: 'real firmware executing under Espressif’s QEMU fork. Emulated silicon, not hardware.',
};

export interface EmulatorPanelProps {
  readonly facts: EmulatorFacts | null;
  readonly status: BackendStatus;
  /** Events for which `isPhysicallyObserved()` held. Expected: 0. */
  readonly physicallyObservedEvents: number;
}

export function EmulatorPanel(props: EmulatorPanelProps): ReactElement | null {
  const { facts, status, physicallyObservedEvents } = props;

  const attempts = status.attempts ?? 1;
  const retried = attempts > 1;

  // Booting: this is the 2-17 s window, and a blank panel through it reads as a
  // hang. Q2 measured a 28% per-boot panic rate with a 7-attempt worst case.
  if (facts === null) {
    if (status.connection !== 'connecting') return null;
    return (
      <section className="panel" data-testid="emulator">
        <header className="panel-header">
          <h2>Emulator</h2>
          <span className="panel-sub">booting real firmware</span>
        </header>
        <p className="note" id="qemu-boot-progress">
          <b>{Math.round((status.elapsedMs ?? 0) / 100) / 10} s</b> · boot attempt{' '}
          <b data-testid="boot-attempt">{attempts}</b>
        </p>
        <p className="note muted">{status.detail}</p>
        <p className="note muted">
          A cold boot takes 2–17 s. QEMU’s ESP32 cache model panics on about 28% of them
          (ISSUE-20260823-022) and the backend relaunches rather than failing; the worst connect
          measured needed <b>7</b> attempts. That is a mitigation, not a fix — the QEMU bug is
          untouched.
        </p>
      </section>
    );
  }

  const elided = [...facts.elided];
  const unsupported = Object.entries(facts.unsupportedBoards);
  const neverObserved =
    facts.everObserved === null
      ? []
      : JOINT_ORDER.filter((joint) => facts.everObserved?.[joint] !== true);

  return (
    <section className="panel" data-testid="emulator">
      <header className="panel-header">
        <h2>Emulator</h2>
        <span className="panel-sub">not hardware, and not a model either</span>
      </header>

      <div className="warn" data-testid="not-a-measurement">
        <strong>Real firmware. Emulated silicon. No robot.</strong>
        <p>
          Every event on this stream is tagged <code>provenance: observed</code> — correctly: bytes
          really crossed a UART and the firmware’s own hook really ran. That word does <b>not</b>{' '}
          mean “measured”. The field that settles it is the origin, and{' '}
          <code>isPhysicallyObserved()</code> is <b>false</b> for every event here.
        </p>
        <p className="muted">
          Events that were physically observed since this backend started:{' '}
          <b data-testid="physically-observed-count">{physicallyObservedEvents}</b>
        </p>
      </div>

      <dl className="kv">
        <dt>origin</dt>
        <dd>
          <OriginTag origin={facts.origin} />
        </dd>

        <dt>board</dt>
        <dd data-testid="emulated-board">
          <code>{facts.board}</code>{' '}
          <span className="muted">
            — the <b>legacy V1</b> board. Not the S2 Mini in this project’s pin diagram.
          </span>
        </dd>

        {facts.mode !== null && (
          <>
            <dt>mode</dt>
            <dd>
              <code>{facts.mode}</code> <span className="muted">— {MODE_MEANING[facts.mode]}</span>
            </dd>
          </>
        )}

        <dt>commands</dt>
        <dd>
          <code>{facts.commandChannel}</code>
          <br />
          <span className="muted">
            Buttons here become lines on the firmware’s own serial console.
            {facts.lastCommandLine === null ? (
              ' Nothing has been sent yet.'
            ) : (
              <>
                {' '}
                Last line written: <code>{facts.lastCommandLine}</code>
              </>
            )}
          </span>
        </dd>

        <dt>boot</dt>
        <dd data-testid="boot-attempts">
          {attempts} attempt{attempts === 1 ? '' : 's'}
          {status.elapsedMs === undefined ? '' : ` · ${status.elapsedMs} ms`}
          {retried && (
            <span className="muted">
              {' '}
              — {attempts - 1} boot{attempts - 1 === 1 ? '' : 's'} panicked and were relaunched.
              ISSUE-20260823-022.
            </span>
          )}
        </dd>

        <dt>OLED</dt>
        <dd>
          {facts.oledFramebuffer ? (
            'the emulator transmits framebuffer pixels'
          ) : (
            <span className="muted">
              no pixels. QEMU attaches no SSD1306 to this machine, so the firmware emits face{' '}
              <i>events</i> and nothing else. The panel below draws them host-side and labels those
              pixels <code>inferred</code>.
            </span>
          )}
        </dd>
      </dl>

      {unsupported.length > 0 && (
        <div className="warn" data-testid="unsupported-boards">
          <strong>Boards this cannot emulate — including the one you were told to buy.</strong>
          <ul className="tight">
            {unsupported.map(([board, reason]) => (
              <li key={board}>
                <code>{board}</code> — {reason}
              </li>
            ))}
          </ul>
        </div>
      )}

      <p className="note">
        <b>Elided subsystems</b> — the emulator does not model these, so silence from them is not
        evidence of anything:
      </p>
      <p className="note muted" data-testid="elided">
        {elided.map((name) => (
          <code key={name} className="chip">
            {name}
          </code>
        ))}
      </p>

      {neverObserved.length > 0 && (
        <p className="note muted" data-testid="never-observed">
          <b>{neverObserved.length}</b> of 8 joints have never been reported by the firmware (
          {neverObserved.join(', ')}). Their angle on screen is the documented power-on assumption —
          90°, the servo library’s mid-point — because <code>setup()</code> deliberately writes no
          channel. It is an assumption, not a report.
        </p>
      )}

      <details className="note muted">
        <summary>firmware deviations ({facts.firmwareDeviations.length})</summary>
        <ul className="tight">
          {facts.firmwareDeviations.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
      </details>

      {facts.knownFlakiness !== '' && (
        <details className="note muted">
          <summary>known non-determinism, measured</summary>
          <p>{facts.knownFlakiness}</p>
        </details>
      )}

      {facts.panic !== null && (
        <div className="warn" data-testid="guest-panic">
          <strong>The guest died. Everything above is a last-known value.</strong>
          <p className="wrap">{facts.panic}</p>
        </div>
      )}
    </section>
  );
}
