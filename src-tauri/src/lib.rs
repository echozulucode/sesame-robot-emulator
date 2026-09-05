//! All of the desktop shell's logic, such as it is.
//!
//! `main.rs` is a thin passthrough into [`run`] and nothing else. That is not a
//! style preference: on mobile Tauri replaces `main()` with the
//! `mobile_entry_point` attribute below, so anything that lives in `main.rs`
//! simply does not run there. We ship desktop only, but the split costs nothing
//! today and is the difference between "mobile was never wanted" and "mobile is
//! a rewrite".
//!
//! ## What is here, and what is deliberately not
//!
//! T1 proved the existing web app renders in a WebView2 window with its honesty
//! surfaces intact. T2 made the files locatable from a packaged executable and
//! proved it. **T3 adds the supervisor**: [`qemu`] spawns
//! `qemu-system-xtensa.exe`, holds the UART0 socket and owns the boot-retry
//! loop; [`supervisor`] exposes that as `spawn_emulator` / `stop_emulator` /
//! `send_command` / `emulator_status` over two IPC channels.
//!
//! What is still **not** here, on purpose: the `@SESAME` parser, the serial-CLI
//! encoder, the capability record and the behaviour model. Those are the most
//! carefully verified modules in the project — 255 tests, an invariant proven
//! across ~1,500 chunk splits — and option C
//! (`docs/plans/phase-5-tauri-desktop-app.md` §4) exists precisely so they are
//! reused byte for byte rather than reimplemented. Rust ships raw bytes.
//!
//! T4 adds the `TauriSesameRobot` that consumes these commands. Until it lands,
//! the frontend still selects the **behavioural simulator** and says so — see
//! `apps/web/src/backends/default-backend.ts`, which T3 does not touch.

pub mod qemu;
pub mod resources;
pub mod selftest;
pub mod stdio;
pub mod supervisor;

use std::sync::Arc;

use tauri::Manager;

/// The flag that turns this GUI app into a one-shot resource check.
///
/// ## Why a flag exists at all
///
/// T2's done-criterion is *"a built `.exe`, run from a directory containing
/// nothing else, resolves every resource"*. Verifying that by opening the
/// window and reading a panel is verification by screenshot, which this project
/// does not accept anywhere else and should not start accepting for the one
/// property that fails on somebody else's machine. So:
///
/// ```text
/// sesame-robot-emulator.exe --resource-report [out.json]
/// ```
///
/// writes the same document [`resources::resource_report`] returns to the
/// webview, and exits **1** if any resource is missing or the wrong size. That
/// is an assertion a script can make, and `just tauri-resources` makes it.
///
/// The window is suppressed rather than opened-and-closed: Tauri creates
/// `app.windows` during `build()`, before anything else runs, so the
/// `create: false` below is the only way not to flash a WebView2 window at
/// whoever is running the check.
const REPORT_FLAG: &str = "--resource-report";

/// Default destination when `--resource-report` is given no path. Beside the
/// executable, because that directory is by definition writable in `target/`
/// and by definition the thing being tested in an install.
const REPORT_DEFAULT: &str = "resource-report.json";

/// The same idea for T3: boot the **bundled** QEMU from a packaged executable,
/// receive bytes, stop, and count survivors — with no window and no webview.
/// See [`selftest`].
const SELFTEST_FLAG: &str = "--emulator-selftest";

/// T4's version of the same idea, and the reason it exists is worth stating
/// where the other two flags are.
///
/// `describeRobotContract` is Node code — `node:assert`, and C14 opens a real
/// `node:http` listener — so it cannot run inside a WebView2 window, and a
/// `TauriSesameRobot` verified against a *fake* supervisor would be measuring
/// the fake. This flag lets the suite drive **this binary**: the bundled paths,
/// the bundled QEMU, the same retry loop, the same write budget, the same job
/// object. See [`stdio`] for the frame format and for the two alternatives that
/// were rejected.
const STDIO_FLAG: &str = "--supervisor-stdio";

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let report_to = report_destination(std::env::args().skip(1));
    let selftest = selftest::parse_args(std::env::args().skip(1), SELFTEST_FLAG);
    let stdio = stdio::requested(std::env::args().skip(1), STDIO_FLAG);
    let headless = report_to.is_some() || selftest.is_some() || stdio;

    let mut context = tauri::generate_context!();
    if headless {
        for window in context.config_mut().app.windows.iter_mut() {
            window.create = false;
        }
    }

    let app = tauri::Builder::default()
        .manage(Arc::new(supervisor::Supervisor::default()))
        .invoke_handler(tauri::generate_handler![
            resources::resource_report,
            supervisor::spawn_emulator,
            supervisor::stop_emulator,
            supervisor::send_command,
            supervisor::emulator_status,
        ])
        .build(context)
        .expect("error while building tauri application");

    if let Some(destination) = report_to {
        std::process::exit(write_resource_report(&app, &destination));
    }
    if let Some(args) = selftest {
        std::process::exit(selftest::run(&app, &args));
    }
    if stdio {
        std::process::exit(stdio::run(&app));
    }

    // The deliberate teardown path. The *guarantee* is the job object in
    // `qemu::job` — it is what covers a hard kill, where no callback runs at
    // all — but a normal window close should stop QEMU promptly and visibly
    // rather than leave it to a handle closing during process teardown.
    //
    // `ExitRequested` fires when the last window closes and before the event
    // loop ends; `Exit` fires on the way out, including `AppHandle::exit()`.
    // Both are handled because a user closing the window and an app asking to
    // quit are different paths to the same requirement.
    app.run(|handle, event| {
        if matches!(
            event,
            tauri::RunEvent::ExitRequested { .. } | tauri::RunEvent::Exit
        ) {
            if let Some(state) = handle.try_state::<Arc<supervisor::Supervisor>>() {
                state.clear();
            }
        }
    });
}

/// `Some(path)` when `--resource-report` was passed, with its optional argument.
///
/// Split out and taking an iterator so it is testable without a process: the
/// only branch that matters is that an ordinary launch — no arguments, or the
/// arguments Windows adds when a file is dragged onto the exe — does **not**
/// turn the app into a headless check.
fn report_destination<I: Iterator<Item = String>>(mut args: I) -> Option<std::path::PathBuf> {
    let flag = args.find(|a| a == REPORT_FLAG)?;
    debug_assert_eq!(flag, REPORT_FLAG);
    let next = args.next();
    Some(match next {
        Some(path) if !path.starts_with("--") => std::path::PathBuf::from(path),
        _ => std::path::PathBuf::from(REPORT_DEFAULT),
    })
}

/// Write the report and return the process exit code.
///
/// Also printed to stderr, which the `windows_subsystem = "windows"` release
/// build discards — hence the file being the contract and the print being a
/// convenience for the debug build.
fn write_resource_report(app: &tauri::App, destination: &std::path::Path) -> i32 {
    let report = resources::report(app);
    let json = serde_json::to_string_pretty(&report).expect("the report is plain data");
    eprintln!("{json}");
    if let Err(error) = std::fs::write(destination, &json) {
        eprintln!("cannot write {}: {error}", destination.display());
        return 2;
    }
    if report.ok {
        0
    } else {
        1
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn destination(args: &[&str]) -> Option<std::path::PathBuf> {
        report_destination(args.iter().map(|a| (*a).to_string()))
    }

    #[test]
    fn an_ordinary_launch_is_not_a_report() {
        assert_eq!(destination(&[]), None);
        assert_eq!(destination(&["--some-other-flag"]), None);
    }

    #[test]
    fn the_flag_takes_an_optional_path() {
        assert_eq!(
            destination(&["--resource-report"]),
            Some(std::path::PathBuf::from(REPORT_DEFAULT))
        );
        assert_eq!(
            destination(&["--resource-report", "out.json"]),
            Some(std::path::PathBuf::from("out.json"))
        );
        assert_eq!(
            destination(&["--resource-report", "--verbose"]),
            Some(std::path::PathBuf::from(REPORT_DEFAULT))
        );
    }

    /// The manifest is generated from `tauri.conf.json`; these are the two
    /// entries T3 will ask for by name, and a rename in the config that did not
    /// reach `resources.rs` would otherwise only show up as a spawn failure.
    #[test]
    fn the_two_paths_t3_needs_are_in_the_manifest() {
        for target in [resources::QEMU_EXE, resources::FLASH_IMAGE] {
            assert!(
                resources::BUNDLED.iter().any(|r| r.target == target),
                "{target} is not in bundle.resources"
            );
        }
    }

    /// `capabilitiesForImage()` keys `oledFramebuffer` off the file name, and
    /// an unrecognised name gets the conservative answer — `false`, panel
    /// elided. A bundled image whose name lost `cli-oled` would downgrade a
    /// correctness surface silently, so the name is asserted here rather than
    /// left to be noticed in T4.
    #[test]
    fn the_bundled_image_still_classifies_as_an_oled_build() {
        let name = resources::FLASH_IMAGE.rsplit('/').next().unwrap();
        assert!(
            name.contains("cli-oled"),
            "packages/sesame-qemu/src/config.ts: imageHasOledHook() is \
             basename(path).includes('cli-oled'); {name} would report oledFramebuffer: false"
        );
    }
}
