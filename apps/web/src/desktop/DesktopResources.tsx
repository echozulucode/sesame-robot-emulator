/**
 * The bundled-resource report, on screen — Phase 5 T2.
 *
 * Lives in the connection card's "More" screen, which is where the app already
 * puts *diagnostics about the arrangement* as opposed to claims about what
 * drove the scene. It renders **nothing at all** outside the Tauri desktop
 * shell: a browser tab has no bundled resources, and a panel reading "0 of 0,
 * all fine" would be a statement about something that does not exist.
 *
 * It is deliberately not on the trust panel. Whether `qemu-system-xtensa.exe`
 * is next to the executable is a packaging fact; it is not evidence about
 * provenance, and correctness surfaces do not get diluted with plumbing.
 *
 * `[data-testid="desktop-resources"]` so the harness and T6 can read it, and
 * `window.__sesame.resourceReport()` returns the same document.
 */
import { useEffect, useState, type ReactElement } from 'react';

import {
  fetchResourceReport,
  formatBytes,
  summarise,
  type ResourceReport,
} from './resource-report.js';

export function DesktopResources(): ReactElement | null {
  const [report, setReport] = useState<ResourceReport | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    fetchResourceReport()
      .then((r) => {
        if (live) setReport(r);
      })
      .catch((e: unknown) => {
        if (live) setError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      live = false;
    };
  }, []);

  /*
    An error here is worth showing even though the report is a diagnostic: the
    command failing means the Rust side is not answering at all, and in a
    packaged app that is the difference between "the emulator is missing" and
    "the shell is broken".
  */
  if (error !== null) {
    return (
      <div className="warn" data-testid="desktop-resources" data-resources-ok="false">
        <strong>The desktop shell did not answer `resource_report`.</strong>
        <p>{error}</p>
      </div>
    );
  }

  if (report === null) return null;

  return (
    <div
      className={report.ok ? 'prov-detail' : 'warn'}
      data-testid="desktop-resources"
      data-resources-ok={String(report.ok)}
      data-resources-present={String(report.present)}
      data-resources-total={String(report.total)}
      data-resources-bytes={String(report.bytes)}
    >
      <p className="note">
        <strong>Bundled resources: </strong>
        {summarise(report)}
      </p>
      <p className="note muted">
        Resolved through <code>app.path()</code> under <code>{report.resourceDir}</code> — never a
        path into this repository, which does not exist on the machine this app is for.
      </p>
      <ul className="note muted">
        {report.entries.map((entry) => (
          <li key={entry.target}>
            <code>{entry.target}</code>{' '}
            {entry.ok ? (
              <>{entry.bytes === null ? '' : formatBytes(entry.bytes)}</>
            ) : (
              <b>{entry.problem}</b>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
