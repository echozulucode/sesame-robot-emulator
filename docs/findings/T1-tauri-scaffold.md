---
task: "T1 — scaffold Tauri and prove the webview"
phase: 5
status: complete
date: 2026-09-02
owns: src-tauri, justfile, .gitignore, apps/web (backend-selection seam only)
plan: docs/plans/phase-5-tauri-desktop-app.md §5 T1
follows: docs/findings/W8-four-pieces-of-feedback.md §2
---

# T1 — the window works, and it says what is behind it

**Done when:** the existing app renders in a Tauri window against the
**simulator**, with no lab host and no emulator involved. It does. The proof is
in §4: the running window with every provenance surface in it, after a `wave`
the behavioural simulator actually ran.

`docs/findings/` is gitignored but tracked files inside it still commit, exactly
as every finding above did. This file is meant to be committed.

---

## 1. Where `src-tauri/` lives, and why it is not `apps/desktop/`

**Repo root.** `src-tauri/`.

`apps/desktop/src-tauri/` was the tidier-looking option and it is the wrong one,
for three reasons in descending order of weight:

1. **`pnpm-workspace.yaml` globs `apps/*`.** A directory under `apps/` is a
   workspace package, and `pnpm -r build`, `pnpm -r test` and `pnpm -r typecheck`
   — which are `just build`, `just test`, `just typecheck` and three quarters of
   `just check` — would start visiting it. The one hard constraint on this
   workstream is *1,031 tests, 41 captures, 0 problems, and the dev path
   untouched*. Putting a Rust crate inside the glob that drives all of it, to
   gain a directory name, is a trade nobody would take twice.
2. **`frontendDist` is a relative path and it is load-bearing.** From the root it
   is `../apps/web/dist`, which reads as what it is. From
   `apps/desktop/src-tauri` it is `../../../apps/web/dist`, which reads as
   nothing — and T2 would then re-derive that offset for every bundled resource
   (`tools/qemu/`, `hardware/*.json`, the flash image), all of which live at the
   root.
3. **The Tauri CLI defaults to `./src-tauri` from the current directory.** At the
   root, `just tauri-dev` is `pnpm exec tauri dev` and nothing else — one
   command, which is what `set windows-shell := ["powershell.exe", ...]` requires
   of every recipe in this justfile. Anywhere else it needs a `cd` or a
   `--config`.

The repository already has top-level domain directories — `apps/`, `packages/`,
`emulator/`, `firmware/`, `hardware/`, `scripts/`, `tools/`. `src-tauri/` is the
desktop shell and the only Rust in the tree; it sits with them.

## 2. The configuration, and the values that were decided rather than defaulted

| Key | Value | Why |
|---|---|---|
| `build.devUrl` | `http://127.0.0.1:5173` | Vite's default port, and `vite.config.ts` already pins `server.host` to `127.0.0.1` rather than `localhost` |
| `build.frontendDist` | `../apps/web/dist` | The existing build output. Not a copy, not a second target |
| `build.beforeDevCommand` | `pnpm dev:web` | The **existing** root script. Deliberately not `pnpm dev` — that is `dev-lab.mjs`, which starts a lab host and QEMU, and T1 is defined by their absence |
| `build.beforeBuildCommand` | `pnpm --filter @sesame-lab/web build` | The existing package script, the same one `just build-web` runs |
| `app.withGlobalTauri` | `true` | So `window.__TAURI__` exists, which is what the seam in §3 keys on. Detection reads `__TAURI_INTERNALS__` **too**, so T4 can turn this off when it imports `@tauri-apps/api` properly without silently disabling the seam |
| `app.security.csp` | `null` | **Stated rather than smoothed over.** A guessed CSP that breaks an R3F worker or a `blob:` texture at *package* time and not at dev time is precisely the class of defect T5 exists to catch. Choosing one belongs with T6, against a packaged artifact, not here |
| `app.windows[0]` | 1200 × 760, min 880 × 640 | Measured, not picked — see below |
| `bundle.targets` | `all` (⇒ MSI + NSIS on Windows) | T6's decision to narrow |
| `capabilities/default.json` | `["core:default"]` | v2 denies by default. T1 needs nothing else and asks for nothing else |
| `identifier` | `com.sesamelab.desktop` | `tauri init` writes `com.tauri.dev`, which the bundler refuses |

### The window size is the one thing I got wrong first

`tauri init` writes 800 × 600, below this shell's own reasoning about width, so I
set 1440 × 900 — a window from W8's sweep table. On the machine this was verified
on (1920 × 1080 at **125 %** scaling, so a 1536 × 816 *logical* work area) that
window is 900 + 31 = 931 logical tall, and its bottom sat under the taskbar. The
bottom 34 px of this app is the **status line**, which carries
`SYSTEM: … · PHYSICAL HARDWARE: NONE` and is on the harness's
correctness-surface list. A default window whose first paint hides a correctness
surface is not a cosmetic default.

1200 × 760 fits with 25 logical px to spare on that display. `minWidth: 880` is
W8's sheet breakpoint; `minHeight: 640` is a floor, not a measurement.

### What `tauri init` seeded that was removed

`log` + `tauri-plugin-log`, and the `setup()` hook that installed them. T1 logs
nothing, and a plugin is a permission surface — the point of starting at
`core:default` is that additions are deliberate. `serde` / `serde_json` stayed:
they are data, not capability, and T3's commands need them immediately.

`Cargo.lock` **is** committed (`.gitignore` says why): `src-tauri` is a binary
crate and T6 ships an installer built from it. `src-tauri/target/` and
`src-tauri/gen/schemas/` are ignored.

`main.rs` is four lines and calls `sesame_lab_desktop_lib::run()`. Everything is
in `lib.rs` behind `#[cfg_attr(mobile, tauri::mobile_entry_point)]`, and
`[lib] crate-type = ["staticlib", "cdylib", "rlib"]`. We ship desktop only; the
split costs nothing and is the difference between "mobile was never wanted" and
"mobile is a rewrite".

## 3. The seam — the simulator is selected, and the selection is announced

### The problem, restated so it is not lost

W8 made QEMU the default and made one rule about it that this workstream had no
business touching:

> a `/lab/session` probe that fails leaves the app on **QEMU** and reports
> `labHost: 'absent'`. It does **not** fall back to the simulator, because
> quietly substituting a host model for the emulator is the one thing this
> project refuses everywhere.

Inside Tauri there is no lab host. Out of the box T1 therefore renders the
"no lab host is answering — here is how to start one" guidance, in a window
where that advice cannot be acted on.

### The fix is a third case, not a weakened rule

`apps/web/src/backends/default-backend.ts` — the module that already owns
"what does this app open on" — gains a desktop branch beside the probe:

```text
window.__TAURI__ absent   ->  probe /lab/session  ->  W8's table, byte for byte
window.__TAURI__ present  ->  no probe at all     ->  sim, ANNOUNCED
```

The desktop shell is not an unreachable lab host. It is an arrangement with no
origin to probe and none coming, and the branch cannot fire anywhere else —
`detectDesktopShell(browser).selectsSimulator` is `false` for every value of the
constant, which `desktop-simulator.test.ts` asserts precisely so nobody can
reach the simulator through the new door instead of the old rule.

### The announcement is the price of choosing on the reader's behalf

`labHost: 'desktop'` is a **new fifth value**, not `'absent'`, and the
distinction is the whole design. `'absent'` is the state that renders *"No lab
host on this origin — how to start one"*; `'desktop'` renders its own line on the
trust panel, at every width, above every disclosure:

> This desktop build has no emulator yet, so the scene is driven by the
> **behavioural simulator** — a host model, not the emulator and not hardware.

`[data-testid="panel-desktop-simulator"]`, in the same box as
`panel-no-lab-host`, and the two are mutually exclusive by construction. The
status line independently reads `SYSTEM: HOST MODEL` because
`environmentSystemName()` derives it from the driving origin — nothing was told
to say "host model", it says so because that is what is driving.

### The seam T4 replaces

```ts
export const TAURI_EMULATOR_BACKEND: BackendId | null = null;
```

One constant. T4 sets it to `TauriSesameRobot`'s id and everything follows:
`selectsSimulator` goes false, `initialBackend()` returns the emulator, and the
announcement stops rendering because it stops being true. Nothing to unpick.
Four of the fourteen new tests drive that with the constant **injected**, so the
seam is exercised before the backend on the other side of it exists.

`App.tsx` decides this synchronously in the `useState` initialiser rather than
in the probe effect, for W8's own reason: the frame before a correction is a
claim, and a frame of `SYSTEM: QEMU EMULATOR` in a build with no emulator is the
wrong claim in the other direction.

## 4. The honesty surfaces, in the running window rather than in a test

`just tauri-dev`, then `wave` from the status line. Read off the window:

| Surface | In the Tauri window |
|---|---|
| provenance badge | `SIMULATED` |
| origin badge | `HOST MODEL (@SESAME-LAB/SESAME-SIM)` |
| `measurementVerdict()` | **"Not a measurement."** |
| trust panel | `PHYSICAL HARDWARE: NONE` |
| status line | `SYSTEM: HOST MODEL · PHYSICAL HARDWARE: NONE` |
| `isPhysicallyObserved()` | `0 physically observed`, at 37 events |
| backend | `sim`, with `SIM` lit in the rail — not `QEM` |
| the new line | present, on the panel, not inside a popover |
| `panel-no-lab-host` | **absent**, which is the point |

Before the `wave` the same window read `NOTHING YET` / `ORIGIN NOT STATED` /
*"Nothing has driven this scene yet"* / `PHYSICAL HARDWARE: NONE` — the app is as
careful about the state where nothing has happened as about the state where
something has, and packaging did not cost it either.

The GLB loads, the 3D scene renders, the OLED face animates `rest → idle`, the
architecture graph draws its causal path from `hardware-map.json`, and the
source explorer resolves — everything W1–W8 earned is in the window, because the
webview is running the same bytes Vite serves the browser.

## 5. What did not change

- `just dev`, `just dev-sim`, `just run`, `scripts/dev-lab.mjs`,
  `apps/web/server/lab-host.mjs`, `vite.config.ts` and its two plugins:
  untouched.
- W8's `DEFAULT_BACKEND = 'qemu'`, `backendFromSession()`, `labHostAbsent()` and
  `probeLabHost()`: untouched. `default-backend.test.ts` passes unmodified.
- `hardware/`, `packages/`, `emulator/`, `firmware/`, `reference/`: not touched.
- Tests: **1,045 passing + 1 skipped**, up from 1,031 + 1. The 14 new ones are
  `apps/web/src/__tests__/desktop-simulator.test.ts`; nothing existing moved.
- Dependencies: `@tauri-apps/cli` (root devDependency) and the Rust crates.
  `@tauri-apps/api` was deliberately **not** added — T1 detects two globals and
  invokes nothing, so the package would be an unused import until T4 needs it.

## 6. Awkward things, named

- **`pnpm-workspace.yaml`'s `apps/*` glob is the reason `src-tauri` is at the
  root.** Worth knowing before someone "tidies" it into `apps/desktop/`.
- **Vite does not pin its port.** `devUrl` hard-codes `5173`; if something else
  holds it, Vite takes 5174 and the Tauri window is blank with no error — the
  documented white-screen failure, with no guard yet. `dev-lab.mjs` already
  learned the equivalent lesson for `:8099` and refuses to start on a busy port.
  `tauri-dev` deserves the same and does not have it.
- **DPI.** Tauri window sizes are logical; the taskbar is physical. §2 explains
  what that cost. Anyone changing the default size on a 100 %-scaled monitor
  should check it on a scaled one.
- **`csp: null`.** An explicit deferral, not an oversight. It is the loosest
  setting in this config and T6 should not inherit it silently.
- **The two targets are still never tested together.** T7's criterion — the
  harness against the web build *and* a smoke test against the Tauri build, in
  one run — is not met by T1, and the verification in §4 was done by hand.
