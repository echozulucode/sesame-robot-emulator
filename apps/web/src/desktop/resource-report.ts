/**
 * What the desktop shell bundled, and whether it is actually there — Phase 5 T2.
 *
 * ## Why this exists at all
 *
 * The packaged app ships `qemu-system-xtensa.exe`, its BIOS/ROM images, one
 * flash image and the `hardware/*.json` artefacts as Tauri **resources**, and
 * resolves every one of them through `app.path()` rather than any path relative
 * to the repository or the current directory. That is the difference between an
 * app that works on the machine it was built on and one that works on the
 * machine it was built *for*, and the failure mode when it is wrong is late and
 * silent: `tauri dev` is fine, the installer is not, and nobody finds out until
 * the `.exe` is on somebody else's desktop.
 *
 * So Rust reports, rather than the app assuming. `resource_report` returns
 * every bundled file's resolved absolute path, whether it exists, its size, and
 * the size the bundler was given at build time. T3 uses the same two paths this
 * report lists (`qemu/bin/…`, `images/…`) to spawn the emulator, and T6 has
 * something to assert against the installed artefact instead of trusting it.
 *
 * ## No new dependency
 *
 * `@tauri-apps/api` is deliberately still not a dependency of this app (T1 §5).
 * `app.withGlobalTauri` is `true`, so `window.__TAURI__.core.invoke` is present
 * in the webview and that is what is used here. When T4 imports the package
 * properly this file becomes a one-line `invoke()` call and nothing else moves.
 */

/** One bundled file, as Rust found it. */
export interface ResourceEntry {
  /** Path under the resource directory, as configured in `tauri.conf.json`. */
  readonly target: string;
  /** The source it was copied from, relative to `src-tauri/`. */
  readonly source: string;
  /** The absolute path `app.path()` resolved to. Reported verbatim. */
  readonly path: string;
  readonly exists: boolean;
  /** Size on disk, or `null` when it is not there. */
  readonly bytes: number | null;
  /** Size of the source when this build was made, or `null` if it was absent. */
  readonly expectedBytes: number | null;
  /** Present, and the size the bundler was given. */
  readonly ok: boolean;
  /** Why not, when `ok` is false. */
  readonly problem: string | null;
}

/** Every bundled resource, in one document. */
export interface ResourceReport {
  /** True only when every entry is `ok`. */
  readonly ok: boolean;
  /** `BaseDirectory::Resource`. On Windows: the executable's own directory. */
  readonly resourceDir: string;
  readonly total: number;
  readonly present: number;
  /** Bytes actually found, summed — the bundle's real payload. */
  readonly bytes: number;
  readonly entries: readonly ResourceEntry[];
}

/** The shape of the global Tauri object `withGlobalTauri` installs. */
interface GlobalTauri {
  readonly core?: { readonly invoke?: (cmd: string, args?: unknown) => Promise<unknown> };
}

/**
 * `window.__TAURI__.core.invoke`, or `null` outside the desktop shell.
 *
 * Every layer is checked rather than assumed: this module is imported by the
 * browser build too, where none of it exists, and by a jsdom test where some of
 * it can be faked.
 */
function invoker(scope: object = globalThis): ((cmd: string) => Promise<unknown>) | null {
  const tauri = (scope as { __TAURI__?: GlobalTauri }).__TAURI__;
  const invoke = tauri?.core?.invoke;
  return typeof invoke === 'function' ? (cmd) => invoke(cmd) : null;
}

/**
 * Ask the desktop shell what it bundled.
 *
 * `null` — not an error and not an empty report — when this is not the desktop
 * shell. A browser tab has no bundled resources, and answering "0 of 0, all
 * fine" would be a claim about a thing that does not exist.
 */
export async function fetchResourceReport(scope: object = globalThis): Promise<ResourceReport | null> {
  const invoke = invoker(scope);
  if (invoke === null) return null;
  return (await invoke('resource_report')) as ResourceReport;
}

/** `71749689` → `68.4 MiB`. Sizes here are compared by eye against a bundle. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${String(bytes)} B`;
  const mib = bytes / (1024 * 1024);
  if (mib < 1) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${mib.toFixed(1)} MiB`;
}

/** One line summarising a report, for the panel and for a log. */
export function summarise(report: ResourceReport): string {
  const size = formatBytes(report.bytes);
  return report.ok
    ? `${String(report.total)} bundled resources resolved, ${size}`
    : `${String(report.present)} of ${String(report.total)} bundled resources resolved (${size}) — ` +
      `${String(report.entries.filter((e) => !e.ok).length)} problem(s)`;
}
