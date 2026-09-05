/**
 * Attach to a Chrome DevTools Protocol endpoint — Phase 5 T5.
 *
 * `scripts/capture-web-screenshots.mjs` has spoken CDP since V3, but it always
 * spoke it to a browser IT had just spawned, so the plumbing — find the page
 * target, open the socket, correlate ids, collect page errors — lived inside
 * `launchBrowser()` and could not be pointed at anything else.
 *
 * T5 has to point it at something else. The packaged desktop app is a WebView2
 * window inside `sesame-lab-desktop.exe`; there is no `--headless`, no
 * `--user-data-dir` and no profile to delete, and the only way in is the port
 * WebView2 opens when the process is started with
 *
 *     WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=<port>
 *
 * Everything above the socket is identical, so it is this module, and both
 * callers use it. That matters beyond tidiness: the packaged phase must read
 * the target's **URL**, and a second CDP client would have been free to forget.
 */

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Wait for a page target on `port`, then open a session on it.
 *
 * `accept` decides which target counts. The default rejects `about:blank`,
 * which is what WebView2 reports for the first second of its life — a caller
 * that took the first target it saw would read a URL of `about:blank` and
 * conclude nothing at all about what the window is serving.
 *
 * Returns `{ target, cdp, evaluate, errors, close }`. `target.url` is the
 * ORIGIN the page is actually on, and it is returned rather than logged
 * because T5's whole guard is built on it.
 */
export async function attachToDebugPort({
  port,
  timeoutMs = 30000,
  accept = (t) => t.type === 'page' && typeof t.url === 'string' && t.url !== 'about:blank',
  callTimeoutMs = 30000,
} = {}) {
  const deadline = Date.now() + timeoutMs;
  let target = null;
  let lastError = null;
  while (Date.now() < deadline && target === null) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`);
      const list = await response.json();
      target = list.find((t) => accept(t) && typeof t.webSocketDebuggerUrl === 'string') ?? null;
    } catch (error) {
      lastError = error;
    }
    if (target === null) await sleep(200);
  }
  if (target === null) {
    throw new Error(
      `no CDP page target on 127.0.0.1:${port} within ${timeoutMs} ms` +
        (lastError === null ? '' : ` (${String(lastError.message ?? lastError)})`),
    );
  }

  const socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.onopen = resolve;
    socket.onerror = () => reject(new Error(`CDP socket to ${target.webSocketDebuggerUrl} failed`));
  });

  let nextId = 1;
  const pending = new Map();
  // A React error boundary or a throw inside useFrame kills the render loop
  // silently: the page keeps its last frame and every read returns a stale but
  // plausible number. Capturing the console turns that into a diagnosis.
  const pageErrors = [];
  socket.onmessage = (message) => {
    const parsed = JSON.parse(message.data);
    if (parsed.method === 'Runtime.exceptionThrown') {
      const d = parsed.params.exceptionDetails;
      pageErrors.push(d.exception?.description ?? d.text);
    }
    if (parsed.method === 'Runtime.consoleAPICalled' && parsed.params.type === 'error') {
      pageErrors.push(parsed.params.args.map((a) => a.description ?? a.value).join(' '));
    }
    if (parsed.id !== undefined && pending.has(parsed.id)) {
      const { resolve, reject } = pending.get(parsed.id);
      pending.delete(parsed.id);
      if (parsed.error) reject(new Error(parsed.error.message));
      else resolve(parsed.result);
    }
  };

  const cdp = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      pending.set(id, { resolve, reject });
      socket.send(JSON.stringify({ id, method, params }));
      setTimeout(() => {
        if (pending.delete(id)) reject(new Error(`${method} timed out`));
      }, callTimeoutMs);
    });

  await cdp('Page.enable');
  await cdp('Runtime.enable');

  /** Evaluate an expression in the page and return its value. */
  const evaluate = async (expression) => {
    const result = await cdp('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    if (result.exceptionDetails) {
      throw new Error(
        `page threw: ${result.exceptionDetails.exception?.description ?? result.exceptionDetails.text}`,
      );
    }
    return result.result.value;
  };

  const close = () => {
    try {
      socket.close();
    } catch {
      /* closing anyway */
    }
  };

  return { target, cdp, evaluate, errors: () => pageErrors, close };
}
