//! All of the desktop shell's logic, such as it is.
//!
//! `main.rs` is a thin passthrough into [`run`] and nothing else. That is not a
//! style preference: on mobile Tauri replaces `main()` with the
//! `mobile_entry_point` attribute below, so anything that lives in `main.rs`
//! simply does not run there. We ship desktop only, but the split costs nothing
//! today and is the difference between "mobile was never wanted" and "mobile is
//! a rewrite".
//!
//! ## What is deliberately NOT here
//!
//! No emulator. T1 proved the existing web app renders in a WebView2 window
//! with its honesty surfaces intact; T2 makes the files that emulator will need
//! locatable from a packaged executable, and proves it. Neither spawns a
//! process or opens a socket.
//!
//! T3 adds `spawn_emulator` / `stop_emulator` / `send_command` and a
//! `Channel<Vec<u8>>` carrying UART0 bytes — resolving its two paths through
//! [`resources::QEMU_EXE`] and [`resources::FLASH_IMAGE`]; T4 adds the
//! `TauriSesameRobot` that consumes them. Until then the frontend selects the
//! **behavioural simulator** and says so — see
//! `apps/web/src/backends/default-backend.ts`.

pub mod resources;

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
/// sesame-lab-desktop.exe --resource-report [out.json]
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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let report_to = report_destination(std::env::args().skip(1));

    let mut context = tauri::generate_context!();
    if report_to.is_some() {
        for window in context.config_mut().app.windows.iter_mut() {
            window.create = false;
        }
    }

    let app = tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![resources::resource_report])
        .build(context)
        .expect("error while building tauri application");

    if let Some(destination) = report_to {
        std::process::exit(write_resource_report(&app, &destination));
    }

    app.run(|_, _| {});
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
