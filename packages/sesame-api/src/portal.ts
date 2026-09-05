/**
 * `GET /` — the captive-portal control UI.
 *
 * **This is a stub, and it says so on the page.** The real firmware serves
 * `index_html`, a ~40 KB PROGMEM raw string literal in
 * `firmware/captive-portal.h:9` (registered at
 * `firmware/sesame-firmware-main.ino:712`, handler `handleRoot()` at `:226`).
 * Copying it here would be copying a UI, not implementing a contract: nothing
 * about `/api/status` or `/api/command` depends on which HTML `/` returns, and
 * the browser UI is V3's job, not V5's.
 *
 * What the stub *does* preserve is everything a client can observe about the
 * route: status 200, `Content-Type: text/html`, and — via `handleNotFound()`
 * (`:643`) — the fact that **every** unmatched non-`/api/` path returns this
 * same page with a **200**, not a 404. That captive-portal redirect behaviour
 * is the part an integration can actually depend on.
 *
 * Pass `portalHtml` to {@link SesameApiOptions} to serve something else. The
 * page is self-contained: no external requests, no inline event handlers
 * beyond its own script, nothing fetched from a CDN.
 */

/** The stub page. Deliberately small, deliberately labelled. */
export const STUB_PORTAL_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Sesame Robot Emulator — compatibility proxy</title>
<style>
  :root { color-scheme: light dark; }
  body { font: 15px/1.5 ui-sans-serif, system-ui, sans-serif; margin: 0; padding: 2rem;
         max-width: 44rem; background: Canvas; color: CanvasText; }
  h1 { font-size: 1.25rem; margin: 0 0 .25rem; }
  p.sub { margin: 0 0 1.5rem; opacity: .7; }
  .note { border-left: 3px solid currentColor; padding: .5rem 0 .5rem .75rem; opacity: .8;
          margin: 0 0 1.5rem; }
  button { font: inherit; padding: .35rem .7rem; margin: 0 .3rem .3rem 0; cursor: pointer; }
  pre { background: rgba(127,127,127,.14); padding: .75rem; overflow-x: auto; border-radius: 4px; }
</style>
</head>
<body>
<h1>Sesame Robot Emulator compatibility proxy</h1>
<p class="sub">Sesame-compatible HTTP API in front of a robot backend.</p>
<div class="note">
  <strong>This page is a stub.</strong> The real robot serves its captive-portal
  control UI here (<code>firmware/captive-portal.h</code>). The API routes below
  are the real contract and behave as the firmware does, quirks included.
</div>
<p>Try a command:</p>
<div id="cmds"></div>
<pre id="out">GET /api/status</pre>
<script>
  const COMMANDS = ['rest','stand','wave','dance','swim','point','pushup','bow','cute',
    'freaky','worm','shake','shrug','dead','crab','forward','backward','left','right','stop'];
  const out = document.getElementById('out');
  const host = document.getElementById('cmds');
  for (const name of COMMANDS) {
    const b = document.createElement('button');
    b.textContent = name;
    b.addEventListener('click', async () => {
      await fetch('/api/command', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ command: name }),
      });
      const r = await fetch('/api/status');
      out.textContent = await r.text();
    });
    host.appendChild(b);
  }
  setInterval(async () => {
    try { out.textContent = await (await fetch('/api/status')).text(); } catch { /* offline */ }
  }, 2000);
</script>
</body>
</html>
`;
