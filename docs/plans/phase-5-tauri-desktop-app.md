# Sesame Lab — Phase 5: Rust + Tauri Desktop Application

**Status:** proposed, awaiting approval — **one architecture decision needs your call (§4)**
**Opened:** 2026-09-02
**Goal:** a double-clickable app for the user's nephew, **while keeping `just dev` / the local web
server exactly as it is** for development and debugging.

---

## 1. The constraint that shapes everything

The web app is pure browser code and already runs in a webview unchanged. **Two things are not**,
and they are the entire problem:

| Capability | Why it cannot run in a webview |
|---|---|
| Spawning `qemu-system-xtensa.exe` | `child_process` |
| Reading UART0 | a raw TCP socket to QEMU's `-serial tcp:` server |

Everything else — the protocol parser, the behaviour model, the API adapter, the 3D scene, the
lessons — is already isomorphic to a browser. Today those two capabilities live in
`apps/web/server/lab-host.mjs` (Node) fronting `packages/sesame-qemu`.

**So Phase 5 is not "port the app to Tauri". It is "replace ~two Node capabilities with Rust, and
change nothing else."**

## 2. Prerequisites — all already present

Verified on this machine 2026-09-02:

| | |
|---|---|
| `rustc` / `cargo` | 1.95.0 |
| `x86_64-pc-windows-msvc` target | installed |
| MSVC `link.exe` | on PATH |
| WebView2 runtime | 152.0.4191.53 |
| `tauri-cli` | **2.6.2** |

Nothing to install. That is unusual and worth stating, because it removes the usual first week.

## 3. What actually has to ship, measured

| Item | On disk | In the bundle | Note |
|---|---:|---:|---|
| `tools/qemu/` | 174 MB | **73 MB** | `qemu-system-xtensa.exe` is 71.7 MB and is duplicated as `…xtensaw.exe`; `include/` and `lib/` are build headers |
| QEMU `share/` (BIOS, ROMs) | 1.7 MB | 1.7 MB | required at runtime |
| Flash images | 21 MB (5) | **4 MB** (1) | only `distro-v1-esp32-cli-oled` is the default |
| `apps/web/dist` | 3.8 MB | 3.8 MB | already includes the GLB and the four annotated firmware files |
| `hardware/*.json` | ~1 MB | ~1 MB | hardware-map 301 KB, source-annotations 182 KB, lessons, joint/calibration/assembly maps |
| `firmware/upstream/` | 221 MB | **0** | the Vite build already publishes only the four annotated files into `dist/upstream/` |

**Realistic payload ≈ 83 MB + the Tauri runtime.** The 221 MB upstream tree and 100 MB of duplicate
QEMU binary do **not** ship — that is worth knowing before anyone panics at `du -sh`.

## 4. The decision — how much moves to Rust

Three options. **I recommend C.**

### A — Node sidecar
Bundle `node.exe` plus the existing lab host as a Tauri `externalBin`.

*Zero rewrite; ships in days.* But it adds **~50–80 MB** for a second runtime, keeps a localhost HTTP
server inside a desktop app, and means the nephew's machine runs a web server that must not be
reachable. It also leaves two code paths that can drift.

### B — Full Rust backend
Reimplement `QemuSesameRobot` in Rust: process supervision, TCP, **the `@SESAME` parser**, the
serial-CLI encoder, the capability record.

*Cleanest artifact, smallest bundle.* But it re-implements the single most carefully verified module
in the project. The parser's invariant — *output depends only on the concatenated byte stream, never
on chunking* — was proven across ~1,500 split offsets and 255 tests. Porting it means re-earning
that, and a subtly different parser is exactly the bug this project is worst at seeing.

### C — Rust supervisor, TypeScript parser  ← recommended
Rust does **only** what a browser cannot:

```text
Rust (Tauri commands + Channel)          TypeScript (webview, unchanged)
────────────────────────────────         ──────────────────────────────
spawn qemu-system-xtensa      ──┐
TCP connect to UART0            ├──► raw bytes ──► SesameTelemetryParser (255 tests)
stream bytes on a Channel     ──┘                  SimulatedSesameRobot
write serial-CLI bytes        ◄──── encodeCommand() (the prefix-sensitive model)
boot-panic retry (~28%)                            the whole UI
stamp TelemetryOrigin
```

The parser, the protocol, the sim, the lessons and the UI are reused **byte for byte**. Rust owns
process lifetime, the socket, and the retry loop — the things it is genuinely better at, and the
things that are small enough to get right.

**Bundle ≈ 83 MB. Rust surface ≈ 400–600 lines.**

The one property to preserve deliberately: V7 chose the HTTP adapter so the **origin claim comes
from the backend rather than the app asserting it**. In Tauri, Rust stamps `TelemetryOrigin` on the
session and the frontend reads it — same property, no HTTP.

## 5. Workstreams

### T1 · Scaffold and prove the webview
`src-tauri/` with `main.rs` as a thin passthrough and all logic in `lib.rs` (required for the mobile
entry point even though we are desktop-only). `devUrl` → Vite; `frontendDist` → `apps/web/dist`.
Capabilities start at `core:default` and grow only as needed — v2 denies by default.

**Done when:** the existing app renders in the Tauri window against the **simulator** backend, with
no QEMU involved. That isolates "does the webview work" from "does the emulator work".

### T2 · Resource bundling
`qemu-system-xtensa.exe` + `share/` + one flash image + `hardware/*.json` as Tauri resources,
resolved at runtime through `app.path()` — **never a hardcoded path**, which will otherwise work in
dev and break in the installer.

**Done when:** a built `.exe` on a machine with no repo checkout can locate every resource, verified
by running it from a directory that contains nothing else.

### T3 · The Rust supervisor
`spawn_emulator` / `stop_emulator` / `send_command` commands, plus a `Channel<Vec<u8>>` streaming
UART bytes. Port the retry loop for ISSUE-20260823-022's ~28% boot panic — Q2 measured 0 failures in
25 connects with a budget of 12 attempts, worst case 7.

**Must not regress:** no orphaned `qemu-system-xtensa.exe` on window close, on app crash, or on
repeated start/stop. Windows needs a job object or explicit tree-kill; `dev-lab.mjs` already learned
this the hard way with `taskkill /T`.

### T4 · `TauriSesameRobot` + the contract suite
A `SesameRobot` implementation over T3's commands, selected when `window.__TAURI__` is present and
falling back to the existing HTTP path otherwise.

**Acceptance is `describeRobotContract`** — the same 15-case suite QEMU had to pass, as one more
call. No weakened cases. That is what makes this a backend rather than a special case.

### T5 · Honesty surfaces in the packaged app
Everything Phase 2–4 built about provenance must survive packaging, and packaging is exactly where
it would be quietly lost:

- `SYSTEM: QEMU EMULATOR · PHYSICAL HARDWARE: NONE` still visible
- `isPhysicallyObserved()` still permanently false
- `TelemetryOrigin` stamped by **Rust**, not asserted by the frontend
- `distro-v1-esp32` still named as the **legacy V1 board, not the S2 Mini**
- the OLED framebuffer still `observed` only when the capability says so

**Assert these in the packaged build, not only in dev.** A release artifact that quietly drops the
provenance line would be the worst regression this project could ship — a child would be told an
emulator is a robot.

### T6 · Installer and first-run
Windows MSI/NSIS via `tauri build`. Icon, product name, version. First run must work with **no
Node, no pnpm, no repo** — the actual deliverable.

**Done when:** it is installed on a machine that has never seen this project and the nephew can
double-click, press **wave**, and watch the robot move.

### T7 · Keep the dev path intact — verified, not assumed
`just dev`, `just dev-sim`, `just run`, the 41-capture harness and all 1,031 tests keep working
unchanged. Add `just tauri-dev` and `just tauri-build`.

**Done when:** the harness passes against the web build *and* a smoke test passes against the Tauri
build, in the same run. Two targets that are never tested together will diverge.

## 6. Sequence

```text
T1 scaffold ──► T2 resources ──► T3 supervisor ──► T4 contract ──► T6 installer
                                                        │
T5 honesty ─────────────────────────────────────────────┘  (alongside T4, not after)
T7 dev-path guard ── continuous
```

One agent per workstream, sequential — they share `src-tauri/` and `apps/web/`, and concurrent
agents in one tree is a data-loss risk this project has already established.

## 7. Risks, named

| Risk | Mitigation |
|---|---|
| **Orphaned QEMU processes** | Job object / tree-kill; assert no stray process after close, crash and repeat cycles |
| **Hardcoded paths that work in dev** | `app.path()` only; T2's done-criterion is an empty directory |
| **The ~28% boot panic looks like a broken app** | Port Q2's retry *and* its visible attempt counter — a silent 17 s freeze reads as a hang |
| **Provenance lost in packaging** | T5, asserted against the packaged artifact |
| **Bundle mistaken for 400 MB** | §3: only 83 MB ships; `du -sh` on the working tree is misleading |
| **Windows Defender / SmartScreen on an unsigned exe** | Expect it. Signing is a separate decision; note it rather than discovering it on the nephew's machine |
| **Two backends drifting** | T4's contract suite and T7's joint verification |

## 8. Explicitly out of scope

- **Mobile.** `lib.rs` keeps the mobile entry point because it costs nothing, but no iOS/Android.
- **macOS/Linux builds.** Structure portably; ship Windows.
- **Auto-update.** Needs signing and a hosted endpoint; revisit if this goes past one nephew.
- **Rewriting the parser, the sim, the lessons or the UI.** Option C exists precisely to avoid it.
- **Removing the web server.** It stays the development path, by explicit requirement.

## 9. Definition of done

- [ ] Installer produced by `just tauri-build`; runs on a machine with no Node, no pnpm, no repo
- [ ] Simulator backend works in the packaged app
- [ ] QEMU backend works in the packaged app, with the boot-retry counter visible
- [ ] `TauriSesameRobot` passes all 15 contract cases unweakened
- [ ] Every provenance surface asserted **in the packaged build**
- [ ] No orphaned QEMU process after close, crash, or repeated start/stop
- [ ] `just dev` and the 41-capture harness unchanged and green
- [ ] Bundle ≈ 83 MB, itemised
- [ ] Zero new frontend dependencies
