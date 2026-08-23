# V5 — Sesame-compatible HTTP API adapter (`@sesame-lab/sesame-api`)

**Task:** Phase 1 · V5 · `docs/plans/phase-1-virtual-mvp.md` §3
**Agent:** `api-adapter`
**Date:** 2026-08-23
**Status:** complete — `pnpm -r build` / `test` / `typecheck` green (95 new tests)
**Deliverable:** `packages/sesame-api/`, exporting `SesameApiAdapter`, `SesameApiServer`
and `describeRobotContract`

---

## 1. What was built, and what it is for

The research report's claim is that **API parity is achievable at a host proxy, entirely
independently of Wi-Fi emulation.** Phase 0 recorded it as Gate D and deliberately did not
build it. This is it: all ten routes F4 extracted from firmware source, over anything that
implements `SesameRobot`, so that

```
http://sesame-robot.local/api/command      # a real robot
http://127.0.0.1:8080/api/command          # this
```

differ in hostname and nothing else. Nothing in the adapter, the server or the contract
suite mentions `SimulatedSesameRobot`; the only value import of `@sesame-lab/sesame-sim`
in the package is in `src/cli.ts`, and `backend-agnostic.test.ts` fails the build if that
stops being true.

```
packages/sesame-api/
  src/
    adapter.ts        the ten handlers, transport-free
    server.ts         node:http + the bind policy   (no framework)
    arduino.ts        String::toInt, urlDecode, _parseArguments, arg("plain")
    manual-json.ts    handleApiCommand()'s indexOf/substring body scanner
    routes.ts         the route table, checked against hardware-map.json
    sanitize.ts       the boundary
    settings.ts       the four /getSettings keys + the backend extension seam
    wifi.ts           the /api/wifi/* state machine, radio removed
    portal.ts         GET / — a stub, and it says so
    cli.ts            the only file that knows the simulator exists
    contract/index.ts describeRobotContract + 15 cases
    __tests__/        8 files, 95 tests
```

Three layers, deliberately separated: `SesameApiAdapter` is a request→response function
with no sockets in it (so a test needs no port and someone else can mount it inside an
existing server); `SesameApiServer` is the transport and the security policy; the contract
suite depends on both but on no backend.

---

## 2. The route table

Ten routes. Every `file:line` below is F4's, projected from
`hardware/hardware-map.json → network.http.routes`; `route-table.test.ts` asserts our
table against that file — same paths, same order, same handler symbols, same lines, same
`methodEnforcedInHandler` — so the two cannot drift silently.

| # | Path | Handler | Registered | Handler src | Reg. src | Our behaviour |
|---|---|---|---|---|---|---|
| 1 | `GET`* `/` | `handleRoot` | `HTTP_ANY` | `ino:226` | `ino:712` | 200 `text/html`, **stub page** (§3.1) |
| 2 | `/cmd` | `handleCommandWeb` | `HTTP_ANY` | `ino:230` | `ino:713` | `pose`/`go`/`stop`/`motor`+`value`, in that precedence; 200 `OK` / 400 `Invalid motor or angle` / 400 `Bad Args` |
| 3 | `/getSettings` | `handleGetSettings` | `HTTP_ANY` | `ino:270` | `ino:714` | hand-built JSON, four keys, source order |
| 4 | `/setSettings` | `handleSetSettings` | `HTTP_ANY` | `ino:280` | `ino:715` | each key optional, `faceFps` floored at 1, nothing else validated, always 200 `OK` |
| 5 | `/api/status` | `handleGetStatus` | `HTTP_ANY` | `ino:289` | `ino:718` | `currentCommand`, `currentFace`, `networkConnected`, `apIP`, `networkIP` only when connected |
| 6 | `/api/command` | `handleApiCommand` | `HTTP_ANY`, **405 non-POST in handler** (`ino:304`) | `ino:303` | `ino:719` | manual body scan; `{"status":"ok","message":…}` / 400 |
| 7 | `/api/wifi/scan` | `handleWifiScan` | `HTTP_ANY` | `ino:555` | `ino:722` | `{"scanning":true}` then a list (empty — no radio) |
| 8 | `/api/wifi/connect` | `handleWifiConnect` | `HTTP_ANY`, **405 non-POST in handler** (`ino:598`) | `ino:597` | `ino:723` | 405 / 400 `SSID required` / 409 in-flight / 200 `{"success":true,"pending":true}` |
| 9 | `/api/wifi/status` | `handleWifiStatus` | `HTTP_ANY` | `ino:623` | `ino:724` | `connected`/`connecting`/`lastError`, plus five keys when connected |
| 10 | `*` | `handleNotFound` | `onNotFound` | `ino:643` | `ino:729` | `/api/*` → **404** JSON; everything else → **200** portal HTML |

\* Method column is informational only. **Every route is `HTTP_ANY`.** The two-argument
`WebServer::on(uri, handler)` overload binds no method, so `DELETE /getSettings` and
`PUT /api/status` both work. `firmware/README.md`'s `GET` labels are not enforced by
anything (F4 §1.9, ISSUE-20260823-005 item 4). Routes 7–9 and 10 appear in **neither** the
README's API reference **nor** the research report's route table; F4 found them in source.

Route matching is exact-string on the path, as the core's `FunctionRequestHandler` is —
so `/cmd/` is not `/cmd`, and falls to the catch-all and its 200 + HTML.

---

## 3. Where we matched upstream, and where we diverged

### 3.1 Matched — the routes and their shapes

| Behaviour | Provenance | Test |
|---|---|---|
| All ten routes `HTTP_ANY`; only `/api/command` and `/api/wifi/connect` check the verb | `ino:304`, `:598`; `routeRegistrationNote` | `http-routes.test.ts`, contract `C10` |
| `handleCommandWeb`'s if/else-if precedence: `?pose=wave&stop=1` runs the wave | `ino:232`–`:262` | `http-routes.test.ts` |
| `/cmd` answers `200 OK` **before** the movement runs | `ino:231` (its own comment) | contract `C08` |
| `/cmd?motor=` is awaited, because `setServoAngle()` runs *inside* the handler | `ino:254` | `http-routes.test.ts` |
| Motor addressable 1–8 or by exact, case-sensitive firmware name | `movement-sequences.h:18` | `http-routes.test.ts` |
| `/setSettings` floors `faceFps` at 1 and validates nothing else — `frameDelay=-5` sticks | `ino:284` | `http-routes.test.ts`, contract `C15` |
| `/getSettings` emits exactly four keys, in source order, hand-built | `ino:270`–`:277` | `http-routes.test.ts` |
| `onNotFound`: JSON 404 under `/api/`, portal **200** elsewhere | `ino:643`–`:649` | contract `C11` |
| The three undocumented `/api/wifi/*` routes and their 405/400/409 ladder | `ino:555`, `:597`, `:623` | `http-routes.test.ts` |
| `/api/status` reports a face that is **not on screen** after any pose | ISSUE-20260823-004 | contract `C09` |

### 3.2 Matched — the parsing quirks

These are the ones a reasonable implementation gets wrong, and every one is reachable from
the network. Provenance for the core-level rows is the **pinned Arduino-ESP32 3.3.11** tree
vendored at `tools/arduino-data/…/libraries/WebServer/src/` — the version F3 builds with.

| Quirk | Consequence | Provenance |
|---|---|---|
| `_parseArguments` **discards a token with no `=`** | `GET /cmd?stop` is `400 Bad Args`. `?stop=` is the stop | `Parsing.cpp:335`–`:342` |
| `arg("plain")` is empty for a `application/x-www-form-urlencoded` body | `POST /api/command` with a good JSON body and the wrong Content-Type is `400 Missing command field` | `Parsing.cpp:217`–`:231` |
| A `?plain=` in the URL shadows the request body | `arg()` returns the first match, query args are parsed first | `WebServer.cpp:arg` |
| `urlDecode` maps `+`→space, passes a truncated `%A` through, and truncates a bad escape instead of throwing | `%G7` decodes to `\0` | `Parsing.cpp:urlDecode` |
| `String::toInt()` takes a leading integer and gives up silently | `motor=3abc` drives channel 3; `motor=abc` is a 400 | `atol` |
| Body scan: `faceOnlyStart > 0`, strictly | a body that *begins* `"face":"…` (no brace) reads as having no face | `ino:323` |
| Body scan: only `"command":"` and `"command": "` are recognised | `{"command" : "wave"}` is a 400 | `ino:338`–`:341` |
| Body scan: `faceOnly` greps the **whole body** for `"command":` | `{"face":"happy","command":5}` is a 400, not a face update | `ino:323` |
| Body scan: no escape handling | `{"command":"wa\"ve"}` yields the command `wa\` | `ino:349`–`:359` |
| Body scan: nothing requires JSON | `garbage{"command":"wave"}trailing` runs the wave | `ino:315`–`:362` |
| `{"face":""}` answers `200 "Face updated"` having called nothing | `faceOnly` is true but `face.length()` is 0 | `ino:334`, `:365` |
| An unknown command word is a **200 that does nothing forever** | `currentCommand` is set, matches no branch, is never cleared | `commands.dispatchNote`, `unresolved[unknown-command-sink]` |
| `/cmd?stop=` does not call `exitIdle()` while `?pose=`/`?go=` do | idle stays active after a stop | `ino:244` vs `:235`/`:241` (F4 §1.5) |

The unknown-command sink needed one piece of machinery worth naming. `SimulatedSesameRobot`
**rejects** a word outside the vocabulary by default (V1's documented divergence, so a
teaching UI does not silently wedge). Upstream accepts it. To present upstream's behaviour
over any backend, the adapter checks the word against
`@sesame-lab/sesame-protocol`'s `COMMAND_NAMES` itself and, for an unrecognised one, never
calls the backend at all: it holds the word in a shadow `currentCommand` that `/api/status`
reports, exactly as the firmware's never-cleared global would. No backend has to be lenient
to be compatible, and no backend gets wedged.

### 3.3 Deliberate divergences

Six, each with the reason and — where it makes sense — an opt-out. Defaults are always the
upstream behaviour, except where the divergence is a security one.

| # | Divergence | Why | Opt-out |
|---|---|---|---|
| **D1** | **Network-supplied strings are sanitised** to `[A-Za-z0-9_.-]`, max 23 chars, before reaching a face, a command, telemetry or a response body | Two separate bugs. (a) The R6 class: `@SESAME` is scanned for at any offset, so an unsanitised face name forges a telemetry segment — the exact hardening the firmware patch already needed (`telemetry-instrumentation.patch:105`). (b) **A new one, upstream's:** `handleGetStatus()` concatenates `currentCommand` and `currentFaceName` into JSON **unescaped** (`ino:291`–`:292`), while `jsonEscape()` exists and is applied to SSIDs (`ino:390`). `currentCommand` is network-assignable: `GET /cmd?pose=%22` puts a bare double quote in it and the next `/api/status` emits invalid JSON with attacker-chosen keys. See §6 | **None, by design.** The character class is exactly the firmware patch's, so for every legal input the output is byte-identical to upstream's |
| **D2** | **Default port 8080, not 80** | 80 is privileged on Linux/macOS and routinely occupied on Windows; defaulting to it makes the common case fail. Parity is paths, verbs, bodies and status codes — the port is a deployment detail the client already supplies. `FIRMWARE_HTTP_PORT` is exported | `--port 80` |
| **D3** | **Binds `127.0.0.1`; a remote bind throws** unless opted in | §5 | `allowRemote: true` / `--allow-remote`, with a loud warning |
| **D4** | **Request bodies capped at 64 KiB → 413** | The ESP32 is capped by its heap. A Node process is not, and an unbounded `arg("plain")` is a free denial of service | `maxBodyBytes` |
| **D5** | **`Cache-Control: no-store` and `X-Content-Type-Options: nosniff`** on every response | The ESP32 sends neither. A control API should not be cached or content-sniffed. Invisible to a non-browser client | — |
| **D6** | **A backend failure becomes a 500** (`/cmd?motor=` → 500 `Servo write failed`; anything else → 500) | Upstream has no failure path because `setServoAngle()` cannot fail. A backend can. A hung socket would be worse | — |

Two further divergences are **off by default** and exist only as hardening for someone
deploying this somewhere less friendly:

- `methodPolicy: 'strict'` (`--strict-methods`) — reject verbs the README does not
  document. This rejects requests the real robot accepts, which is why `'any'` is the
  default. Upstream's own two in-handler 405s are always present in both modes.
- `commandVocabulary: 'strict'` (`--strict-commands`) — 400 on an unrecognised word
  instead of the sink.
- `browserGuard: true` (`--browser-guard`) — reject a cross-origin `Origin` header. See §5.

### 3.4 Modelled rather than reproduced, because the thing does not exist here

| Area | What is reproduced | What is not | Why |
|---|---|---|---|
| `GET /` | status, content type, and the captive-portal 200-on-anything behaviour | the ~40 KB `index_html` PROGMEM UI (`captive-portal.h:9`) | Copying a UI is not implementing a contract, and the browser UI is V3's job. **The stub says on the page that it is a stub.** `portalHtml` replaces it |
| `/api/wifi/*` | the three states, the response shapes, the 405/400/409 ladder, the two-step scan | any actual 802.11 | There is no radio. The default provider's `lastError` says exactly that rather than imitating an RF failure. A backend with a radio supplies a `WifiProvider` and the handlers do not change |
| `apIP` | the field, always present | `WiFi.softAPIP()` | There is no SoftAP. The default is the address the proxy is actually reachable at — the truthful analogue. `apIp` overrides it for a client that hard-codes `192.168.4.1` (which is itself only a core default — F4 §2.6) |
| `/setSettings` | the round trip, the `faceFps` floor, the absent validation | pushing the values into the backend | `SesameRobot` has no settings surface, and `SimulatedRobotOptions` is resolved once at construction. The adapter holds the four values and forwards them **only** if the backend implements the optional `SettingsCapableRobot` extension (`getSesameSettings`/`setSesameSettings`). That is the seam a real robot plugs into |
| `recordInput()` | — | the 30 s inactivity timer it feeds | It drives the OLED Wi-Fi-info scroll (`ino:1098`), which V1 does not model and V4 will |
| `motorSpeed` | — | — | The portal sends it and the API has never read it (F4 §1.12). Asserted absent, so the inertness is pinned rather than accidental |

### 3.5 One thing the transport changes, stated precisely

On the robot, `server.handleClient()` is pumped from inside `delayWithFace()`, which runs
after **every** servo write — so an HTTP request really is accepted mid-pose (F4 §2.4).

With `SimulatedSesameRobot` in its default `timeMode: 'virtual'`, a movement is drained
synchronously, so the Node event loop is not entered until it finishes and requests are
serviced at movement boundaries. In `timeMode: 'realtime'` the pacer awaits at every pump
and the event loop gets exactly the window the firmware's pumps give it.
`http-routes.test.ts` asserts the realtime case: `/api/status` is answered mid-pose and
reports `currentCommand: "stand"` while the pose is still running.

`stop` is never queued behind an in-flight command — it is dispatched immediately, which is
what makes it land inside a gait the way `/cmd?stop=` does on the robot. V1's `onPump()`
seam is not used: Node's I/O is asynchronous and cannot be serviced from inside a
synchronous generator drain. `timeMode: 'realtime'` is the honest way to get the firmware's
timing, and the divergence in virtual time is a scheduling artefact, not a contract change.

---

## 4. The contract suite

`describeRobotContract(() => robot, { runner })` — the report's shape, exported from
`@sesame-lab/sesame-api/contract`.

### Design

- **15 cases**, each a `{ id, title, requirement, provenance, run }` record. They are
  exported as data (`ROBOT_CONTRACT_CASES`), so a report or a UI can list what a backend
  is being held to, with the `file:line` or ISSUE id that makes it a requirement.
- **No test-framework import.** The suite asserts with `node:assert/strict` and takes
  `describe`/`it` structurally. Vitest, Jest and `node:test` all work, and `dist/` carries
  no dev dependency.
- **No backend import.** The factory is the only injection point. The suite covers both
  levels — the `SesameRobot` calls *and* the HTTP surface, by building a
  `SesameApiAdapter` over whatever the factory returned — because "the same command
  semantics through either URL" is a claim about the pair, not about the robot alone.
- **A fresh robot per case**, so a case that wedges the backend cannot leak.
- The robot is wrapped in a transparent `RecordingRobot` decorator, which is how the
  sanitisation case can assert on *what crossed the boundary* rather than on the event
  stream. That distinction matters: a faithful backend swallows an unknown face silently
  (ISSUE-20260823-004), so an event-only assertion would pass vacuously.

### Plugging in a second backend

```ts
import { describe, it } from 'vitest';
import { describeRobotContract } from '@sesame-lab/sesame-api/contract';

describeRobotContract(() => new QemuSesameRobot({ … }), {
  name: 'QemuSesameRobot',
  runner: { describe, it },
});
```

That is the whole integration. **No case changes.** A backend that cannot satisfy a case
fails it — including the two that assert an upstream bug is still present, because a
backend that quietly fixed ISSUE-20260823-004 would show a face the real robot cannot show.

### The cases

| id | Requirement | Provenance |
|---|---|---|
| C01 | `stand` reaches the eight targets `R1=135 R2=45 L1=45 L2=135 R4=0 R3=180 L3=0 L4=180` | `movement-sequences.h:77`–`:89` |
| C02 | `wave` opens with a full stand pose, then `R4=80, L3=180, L2=90, R1=100` | `movement-sequences.h:92`ff |
| C03 | `setFace("rest")` emits a face event and sets the face state | `ino:903`, `:904` |
| C04 | **`setFace("stand")` emits nothing at all**, and the name is rewritten away from `stand` | **ISSUE-20260823-004**, `face-bitmaps.h:52` |
| C05 | An invalid command does not move the robot — rejection *or* the firmware sink, both legal | `commands.dispatchNote` |
| C06 | `getState()` is a canonical `RobotState`: eight joints, clamped angles, **`measuredDeg` null**, 128×64 face, enum-valid mode and network state | `sesame-model/state.ts` |
| C07 | `/api/status` carries the firmware key set; `networkIP` only when connected | `ino:289`–`:301` |
| C08 | `POST /api/command` answers 200 *before* the movement finishes, and the movement happens | `ino:375`–`:386`, `:231` |
| C09 | **`/api/status` reports a face that is not on screen** after a pose | ISSUE-20260823-004, F4 §1.6 |
| C10 | Every route answers any verb; exactly two answer 405 | F4 §1.9 |
| C11 | Unmatched: JSON 404 under `/api/`, portal 200 elsewhere | `ino:643`–`:649` |
| C12 | `?stop` is Bad Args, `?stop=` is a stop | `Parsing.cpp:335`–`:342` |
| C13 | Hostile face and command names are sanitised **at the boundary**, and `/api/status` stays parseable JSON | R6-R7 findings, patch `:105` |
| C14 | **The server binds `127.0.0.1` by default** and refuses `0.0.0.0` without the opt-in | plan §3 V5 |
| C15 | The settings round-trip; `faceFps` floored at 1; an absent key is left alone | `ino:270`–`:286` |

C01 and C02's expected values are transcribed **by hand** from
`firmware/movement-sequences.h`, not derived from `hardware-map.json` — a suite that read
the same extraction `sesame-sim` is generated from would agree with the simulator by
construction and could never catch it being wrong. `stand-pose-parity.test.ts` then
cross-checks the literals against the extraction, so a typo cannot pass either. Two
independent readings, mutually checked.

---

## 5. Security posture

The firmware serves this API over plain HTTP on port 80 with **no TLS and no
authentication** (`network.http.tls`/`authentication`, both `false`), on a SoftAP whose
password is the literal `12345678` (`ino:16`). On a toy on a trusted LAN that is a
defensible trade. Replicating it as a remotely-bound default on a general-purpose computer
is not.

1. **Bind `127.0.0.1` by default.** A non-loopback host **throws**
   `RemoteBindRefusedError` rather than warning; `allowRemote: true` / `--allow-remote` is
   required, and prints a boxed multi-line warning naming what is being exposed. The whole
   127.0.0.0/8 range plus `localhost` and `::1` count as loopback. Asserted by contract
   `C14` and `security.test.ts`.
2. **Sanitise at the boundary** — divergence D1, no opt-out. `sesameSafeToken()` is the
   firmware patch's rule character for character, so a name that survives here also
   survives the firmware's and the two cannot disagree.
3. **Cap the request body** at 64 KiB, 413 above it.
4. **No TLS and no auth here either** — and that is *only* acceptable because of (1). If
   anyone ever wants (3) relaxed or the bind opened, authentication has to come first;
   this package deliberately does not offer a "just expose it" mode without the warning.

### The residual risk, named rather than waved at

A loopback-bound, unauthenticated HTTP service is still reachable from any web page the
user visits — a form post, a `no-cors` `fetch`, or DNS rebinding. Upstream has no CSRF
defence and neither does this **by default**, because adding one changes the contract a
compatibility proxy exists to preserve. `browserGuard: true` / `--browser-guard` is the
opt-in: it rejects any request carrying an `Origin` that is not this server's own, which
blocks the browser-driven cases while leaving `curl`, the lab tooling and the bundled
portal page working. Both states are tested.

### A finding for the orchestrator

**Upstream `handleGetStatus()` has a network-reachable JSON-injection bug**
(`ino:291`–`:292`): `currentCommand` and `currentFaceName` are concatenated into the
response without `jsonEscape()`, which upstream *does* apply to SSIDs at `:389`.
`GET /cmd?pose=%22` is enough to make the next `/api/status` emit invalid JSON, and a
longer payload injects attacker-chosen keys into a response other tools parse. The same
unescaped path also feeds `currentFaceName` from `POST /api/command`'s `face` field.

This is not covered by any existing ISSUE id — 004 is the weak bitmaps, 005 is
documentation drift. It belongs with them in the single upstream report ISSUE-20260823-004
already plans (`docs/issues.yaml:174`), and I have not filed it myself because
`docs/issues.yaml` is not this task's to edit. Severity is low on the robot (it needs LAN
access to an already-unauthenticated control API) and the fix is one call:
`json += "\"currentCommand\":\"" + jsonEscape(currentCommand) + "\",";`

---

## 6. Where `hardware-map.json`'s `network` block was not enough

It carried the whole route table — ten paths, handler symbols, registration lines, the
`HTTP_ANY` note, the `methodEnforcedInHandler` flags, the argument names and prose
descriptions of every status code. That is most of a route table and it was enough to
build one. Four gaps had to be closed from source.

1. **The response bodies are prose, not data.** `routes[].description` says *"Responds 200
   'OK' immediately … 400 'Invalid motor or angle' or 400 'Bad Args'"*. Those are the exact
   bytes a compatibility proxy must emit, and they are inside an English sentence. Every
   status/body pair in §2 had to be re-read out of `ino:226`–`:649`.
   *Suggested:* `routes[].responses: [{ status, contentType, body | bodyShape, when,
   source }]`. The handlers are short enough that this is mechanical.

2. **The `/api/command` body grammar is not represented at all.** The description says
   *"parsed with manual indexOf/substring string scanning (no JSON library)"* and names the
   three accepted shapes. It does not encode the strict `> 0`, the two recognised
   spellings, the whole-body grep for `"command":`, or the two distinct 400s — and those
   are the difference between a proxy that is compatible and one that merely looks it.
   Four of the thirteen reproduced quirks live in those forty lines.
   *Suggested:* the same `steps[]` treatment `servos.servoConfig.setServoAngle` already
   gets. It is exactly the right shape for this.

3. **Nothing records that the request parser is part of the contract.** `args: ["pose",
   "go", …]` implies a normal query parser. The actual behaviour — a valueless token is
   *discarded*, so `?stop` is a 400 — lives in Arduino-ESP32's `Parsing.cpp`, and the core
   version is `unresolved[library-versions]`. The core happens to be vendored in this repo
   at 3.3.11 (`tools/arduino-data/`), which is what made this recoverable at all.
   *Suggested:* either pin the core version in the map (it is on disk and F3 already builds
   against it — this looks closable now, not blocked), or add a
   `network.http.requestParsing` block naming the behaviours the handlers depend on.
   `arduino-parsing.test.ts` states all of them as assertions in the meantime, so a core
   bump fails a test rather than changing behaviour quietly.

4. **`/api/status`' key set is prose and its escaping is unrecorded.** *"JSON status:
   currentCommand, currentFace, networkConnected, apIP, and networkIP only when
   connected"* is accurate and complete about the keys. It does not record that the values
   are interpolated unescaped, which is §5's finding.
   *Suggested:* an `escaped: true|false` flag per emitted field, or simply the
   `responses[]` shape from (1) with the concatenation recorded.

One smaller note: `routes[].contentType` for the catch-all is the string
`"application/json | text/html"`. Readable, but it is two content types in one field, and
the status code differs between them (404 vs 200) — which the field cannot say. The
`responses[]` shape would fix that too.

---

## 7. What V5 deliberately does not do

- **No browser app and no OLED canvas.** V3 and V4.
- **No captive-portal UI.** §3.4. The stub is labelled.
- **No DNS server, no mDNS, no SoftAP.** There is no radio, and the plan's whole point is
  that API parity does not need Wi-Fi emulation. `/api/wifi/*` reproduces the shapes.
- **No serial CLI.** The map's 26 CLI forms are not exposed over HTTP because they are not
  exposed over HTTP on the robot either.
- **No authentication.** Adding it would diverge from the contract; the answer is the
  loopback default, not a login form.
- **No measurement of anything.** Every response is derived from a backend whose every
  event carries `provenance: "simulated"`. `/api/status` does not expose joint angles at
  all — the firmware's does not either — and contract `C06` holds every backend, present
  and future, to `measuredDeg === null`, because no Sesame that exists has a sensor that
  could fill it in.
