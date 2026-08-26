/**
 * The API console — a Lab tool, borrowed by Learn.
 *
 * It sends a **real** request to the current origin and reports the **real**
 * status. That matters more than it sounds: the firmware's ten routes only
 * exist in front of a robot, which means `apps/web/server/lab-host.mjs`. Served
 * from anywhere else — `vite preview`, the bridge's static server — `/api/status`
 * is a 404, and this console says so with the status it actually got rather
 * than simulating a 200. A console that invents plausible replies is the
 * clearest possible way to teach a learner that the network layer is decoration.
 *
 * `duringMovement` is recorded at the moment the reply lands, because that is
 * the whole point of the `delayWithFace()` step: `/api/status` is answered
 * *while a movement is still commanding joints*, from inside the movement's own
 * wait. If the request completes after the robot stopped, the step has not been
 * demonstrated and the check says so.
 */
import { useState, type ReactElement } from 'react';

import { HTTP_COMMAND_ROUTE } from '../generated/architecture-graph.js';

export interface HttpConsoleProps {
  readonly onSend: (method: string, route: string, body: string | null) => void;
  readonly exchanges: readonly {
    readonly method: string;
    readonly route: string;
    readonly status: number | null;
    readonly error: string | null;
    readonly responseText: string;
    readonly duringMovement: string | null;
  }[];
  /** Preselect the route the step is about. */
  readonly defaultRoute?: string;
  readonly defaultMethod?: string;
  readonly defaultBody?: string;
  readonly busy: boolean;
}

const ROUTES = ['/api/status', '/api/command', '/cmd', '/getSettings', '/setSettings'];

export function HttpConsole(props: HttpConsoleProps): ReactElement {
  const { onSend, exchanges, defaultRoute = '/api/status', defaultMethod = 'GET', defaultBody = '', busy } = props;
  const [route, setRoute] = useState(defaultRoute);
  const [method, setMethod] = useState(defaultMethod);
  const [body, setBody] = useState(defaultBody);

  return (
    <div className="editor editor-http" data-testid="http-console">
      <div className="editor-row">
        <select className="lesson-select" data-testid="http-method" value={method} onChange={(e) => setMethod(e.target.value)}>
          {['GET', 'POST', 'PUT', 'DELETE'].map((m) => (
            <option key={m} value={m}>
              {m}
            </option>
          ))}
        </select>
        <select className="lesson-select mono" data-testid="http-route" value={route} onChange={(e) => setRoute(e.target.value)}>
          {[...new Set([defaultRoute, ...ROUTES])].map((r) => (
            <option key={r} value={r}>
              {r}
            </option>
          ))}
        </select>
        <button
          type="button"
          className="lesson-button is-primary"
          data-testid="http-send"
          disabled={busy}
          onClick={() => onSend(method, route, method === 'GET' ? null : body)}
        >
          send
        </button>
      </div>
      {method !== 'GET' && (
        <textarea
          className="mono http-body"
          rows={2}
          value={body}
          data-testid="http-body"
          placeholder={`{"command":"wave"}`}
          onChange={(e) => setBody(e.target.value)}
        />
      )}
      <p className="note muted small">
        <code>{HTTP_COMMAND_ROUTE.path}</code> is registered for{' '}
        <b>{HTTP_COMMAND_ROUTE.registeredMethod}</b> and its handler rejects non-
        {HTTP_COMMAND_ROUTE.enforcedMethod ?? 'POST'} with 405. These are real requests to this
        page&rsquo;s own origin &mdash; if nothing is serving the robot&rsquo;s routes you will see
        the real failure, not a pretend reply.
      </p>
      <ol className="http-log" data-testid="http-log">
        {exchanges.slice(-6).map((exchange, index) => (
          <li key={index} className="mono small">
            <span className={exchange.status === null ? 'is-fail' : ''}>
              {exchange.method} {exchange.route} &rarr; {exchange.status ?? exchange.error ?? 'no reply'}
            </span>
            {exchange.duringMovement !== null && (
              <span className="muted"> · while {exchange.duringMovement} was running</span>
            )}
            {exchange.responseText !== '' && (
              <div className="muted wrap">{exchange.responseText.slice(0, 220)}</div>
            )}
          </li>
        ))}
      </ol>
    </div>
  );
}
