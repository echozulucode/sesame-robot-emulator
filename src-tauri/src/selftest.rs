//! `sesame-robot-emulator.exe --emulator-selftest` — T3's acceptance test, in the
//! form that can be re-run against a **packaged** build.
//!
//! T2 set the precedent and the reason has not changed: verifying that the
//! emulator boots by opening the window and watching it is verification by
//! screenshot, which this project does not accept anywhere else and should not
//! start accepting for the one property that fails on somebody else's machine.
//!
//! ```text
//! sesame-robot-emulator.exe --emulator-selftest [out.json] [--cycles N] [--hold-ms N]
//! ```
//!
//! Each cycle boots the **bundled** QEMU through the same
//! [`crate::qemu::launch_with_retry`] the `spawn_emulator` command uses,
//! collects every UART0 byte, stops, and then asks the operating system —
//! `tasklist`, not this process's own bookkeeping — whether the PID is still
//! there. Exit code 0 only if every cycle booted, every byte assertion held and
//! **no PID survived**.
//!
//! `--cycles 10` is the "repeated start/stop" case from the plan's §7 risk
//! table. `--hold-ms` keeps a session alive so an external script can kill this
//! process outright and then count survivors — the case no code path inside
//! this process can test, because the point of it is that no code path runs.

use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde::Serialize;

use crate::qemu::{self, boot, SupervisorEvent};

/// How the selftest was invoked.
#[derive(Debug, Clone)]
pub struct SelftestArgs {
    pub destination: std::path::PathBuf,
    pub cycles: u32,
    pub hold_ms: u64,
}

/// Default destination when `--emulator-selftest` is given no path.
const DEFAULT_OUT: &str = "emulator-selftest.json";

/// One boot/stop cycle.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CycleReport {
    pub cycle: u32,
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pid: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub port: Option<u16>,
    pub attempts: u32,
    pub boot_ms: u64,
    pub total_ms: u64,
    /// Bytes that reached the byte sink — what the parser would have seen.
    pub uart_bytes: usize,
    /// The banner is in the stream. If it is not, the stream is not the boot.
    pub banner_in_stream: bool,
    /// Informational, and deliberately **not** a pass/fail condition.
    ///
    /// QEMU's `-serial tcp:...,server=on,wait=off` starts the machine
    /// immediately and discards output while no client is attached, so whether
    /// the mask ROM's own first line survives is a race with how fast the
    /// poll-connect wins — not a property of this code. `session.ts` attaches
    /// the same way and inherits the same race. Measured here so the race is
    /// visible rather than assumed either way.
    pub rom_banner_in_stream: bool,
    /// Offset of the boot banner within the stream.
    ///
    /// **This is the buffering assertion.** Everything before this offset was
    /// received while the session was still deciding whether the boot had
    /// worked, and reached the sink only because the pre-banner accumulation is
    /// flushed on success. A banner at offset 0 would mean the boot telemetry
    /// that precedes it — `@SESAME hello`, the `rest` face `setup()` ends with
    /// — had been thrown away.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub banner_offset: Option<usize>,
    /// `@SESAME` markers that arrived BEFORE the banner. Must be non-zero:
    /// `hello` is emitted three statements into `setup()` and the parser
    /// downstream has to see it.
    pub sesame_markers_before_banner: usize,
    /// `@SESAME` occurrences. Not parsed here — counted, so the number is
    /// evidence that telemetry is on the wire without this file pretending to
    /// understand it.
    pub sesame_markers: usize,
    /// QEMU's own diagnostics must NEVER appear on the byte channel. This is
    /// the laundering check, run against the actual stream.
    pub qemu_diagnostics_in_stream: bool,
    /// Diagnostic lines seen on the *event* channel, where they belong.
    pub diagnostics_on_event_channel: usize,
    /// The PID was still in `tasklist` after the stop returned.
    pub survived: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub problem: Option<String>,
    /// The exact argv, so a reader can see `snapshot=on` rather than trust it.
    pub args: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub engine: Option<String>,
    pub image_name: String,
    pub teardown_enforced_by_job_object: bool,
}

/// The whole run.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SelftestReport {
    pub ok: bool,
    pub cycles: Vec<CycleReport>,
    /// `qemu-system-xtensa.exe` PIDs before the first cycle, from `tasklist`.
    /// Non-empty is not a failure — a developer may have `just dev` running —
    /// but it is why the survivor check is per-PID rather than per-count.
    pub qemu_pids_before: Vec<u32>,
    pub qemu_pids_after: Vec<u32>,
    pub survivors: Vec<u32>,
}

/// Parse `--emulator-selftest [path] [--cycles N] [--hold-ms N]`.
pub fn parse_args<I: Iterator<Item = String>>(args: I, flag: &str) -> Option<SelftestArgs> {
    let args: Vec<String> = args.collect();
    let at = args.iter().position(|a| a == flag)?;
    let mut destination = std::path::PathBuf::from(DEFAULT_OUT);
    if let Some(next) = args.get(at + 1) {
        if !next.starts_with("--") {
            destination = std::path::PathBuf::from(next);
        }
    }
    let number = |name: &str, fallback: u64| -> u64 {
        args.iter()
            .position(|a| a == name)
            .and_then(|i| args.get(i + 1))
            .and_then(|v| v.parse::<u64>().ok())
            .unwrap_or(fallback)
    };
    Some(SelftestArgs {
        destination,
        cycles: number("--cycles", 1).max(1) as u32,
        hold_ms: number("--hold-ms", 0),
    })
}

/// Every `qemu-system-xtensa.exe` the OS currently knows about.
///
/// Deliberately `tasklist` and not this process's own records: the whole claim
/// under test is that nothing survives, and a process this code has forgotten
/// about is exactly the thing that would.
pub fn qemu_pids() -> Vec<u32> {
    let output = std::process::Command::new("tasklist")
        .args([
            "/FI",
            "IMAGENAME eq qemu-system-xtensa.exe",
            "/FO",
            "CSV",
            "/NH",
        ])
        .stdin(std::process::Stdio::null())
        .output();
    let Ok(output) = output else {
        return Vec::new();
    };
    String::from_utf8_lossy(&output.stdout)
        .lines()
        .filter_map(|line| line.split("\",\"").nth(1))
        .filter_map(|pid| pid.trim_matches('"').trim().parse::<u32>().ok())
        .collect()
}

/// Run the selftest and return the process exit code.
pub fn run(app: &tauri::App, args: &SelftestArgs) -> i32 {
    eprintln!("[selftest] enumerating existing qemu processes");
    let before = qemu_pids();
    eprintln!("[selftest] {} already running: {before:?}", before.len());
    let mut cycles = Vec::new();

    for cycle in 1..=args.cycles {
        let dump = args
            .destination
            .with_extension(format!("cycle{cycle}.uart.bin"));
        cycles.push(one_cycle(app, cycle, args.hold_ms, Some(&dump)));
    }

    let after = qemu_pids();
    let survivors: Vec<u32> = cycles
        .iter()
        .filter_map(|c| c.pid)
        .filter(|pid| after.contains(pid))
        .collect();
    let report = SelftestReport {
        ok: cycles.iter().all(|c| c.ok) && survivors.is_empty(),
        cycles,
        qemu_pids_before: before,
        qemu_pids_after: after,
        survivors,
    };

    let json = serde_json::to_string_pretty(&report).expect("the report is plain data");
    eprintln!("{json}");
    if let Err(error) = std::fs::write(&args.destination, &json) {
        eprintln!("cannot write {}: {error}", args.destination.display());
        return 2;
    }
    if report.ok {
        0
    } else {
        1
    }
}

fn one_cycle(
    app: &tauri::App,
    cycle: u32,
    hold_ms: u64,
    uart_dump: Option<&std::path::Path>,
) -> CycleReport {
    let started = Instant::now();
    let options = match crate::supervisor::options_from_resources(&app.handle().clone()) {
        Ok(options) => options,
        Err(error) => return failed(cycle, started, format!("resources: {error}")),
    };

    let collected: Arc<Mutex<Vec<u8>>> = Arc::new(Mutex::new(Vec::new()));
    let diagnostics: Arc<Mutex<usize>> = Arc::new(Mutex::new(0));
    let sink = collected.clone();
    let counter = diagnostics.clone();

    eprintln!(
        "[selftest] cycle {cycle}: {} + {}",
        options.qemu_path.display(),
        options.image_path.display()
    );
    let launched = qemu::launch_with_retry(
        &options,
        Arc::new(move |bytes: &[u8]| sink.lock().expect("sink").extend_from_slice(bytes)),
        Arc::new(move |event| {
            // Progress, live. A boot can take up to 12 attempts and a silent
            // wait reads as a hang - the same reason the attempt counter is on
            // the event channel in the app.
            match &event {
                SupervisorEvent::Diagnostic { .. } => *counter.lock().expect("counter") += 1,
                SupervisorEvent::Attempt { attempt, of } => {
                    eprintln!("[selftest]   boot attempt {attempt}/{of}")
                }
                SupervisorEvent::AttemptFailed { reason, ms, .. } => {
                    eprintln!("[selftest]   failed after {ms} ms: {reason}")
                }
                SupervisorEvent::Booted { pid, port, ms, .. } => {
                    eprintln!("[selftest]   booted pid {pid} on port {port} in {ms} ms")
                }
                _ => {}
            }
        }),
    );

    let (session, info) = match launched {
        Ok(pair) => pair,
        Err(error) => return failed(cycle, started, error.to_string()),
    };

    if hold_ms > 0 {
        eprintln!(
            "[selftest] holding pid {} on port {} for {hold_ms} ms — kill this process now to \
             test the crash path",
            info.pid, info.port
        );
        std::thread::sleep(Duration::from_millis(hold_ms));
    }

    let pid = session.pid();
    let port = session.port();
    session.stop();
    drop(session);

    // `tasklist` needs a moment to stop listing a process the kernel has
    // already signalled; `stop()` has confirmed the exit, so this is only
    // giving the enumeration a chance to agree.
    std::thread::sleep(Duration::from_millis(250));
    let survived = qemu_pids().contains(&pid);

    let bytes = collected.lock().expect("sink").clone();
    // The stream, on disk, unaltered. A report that says "1484 bytes, banner
    // present" is a summary; this is the thing itself, so anyone can check the
    // summary rather than believe it.
    if let Some(path) = uart_dump {
        if let Err(error) = std::fs::write(path, &bytes) {
            eprintln!("[selftest] cannot write {}: {error}", path.display());
        }
    }
    let banner_offset = boot::find(&bytes, boot::BOOT_BANNER.as_bytes());
    let banner_in_stream = banner_offset.is_some();
    let rom_banner_in_stream =
        boot::find(&bytes, b"rst:0x").is_some() || boot::find(&bytes, b"ets ").is_some();
    let sesame_markers = count(&bytes, b"@SESAME");
    let sesame_markers_before_banner = match banner_offset {
        Some(at) => count(&bytes[..at], b"@SESAME"),
        None => 0,
    };
    // Two strings QEMU itself prints on stdout/stderr and the guest never does.
    let qemu_diagnostics_in_stream = boot::find(&bytes, b"Adding SPI flash device").is_some()
        || boot::find(&bytes, b"qemu-system-xtensa:").is_some();

    let diagnostic_lines = *diagnostics.lock().expect("counter");
    let mut problems: Vec<String> = Vec::new();
    if !banner_in_stream {
        problems.push("the boot banner is not in the byte stream".into());
    }
    if sesame_markers_before_banner == 0 {
        problems.push(
            "no @SESAME marker arrived before the boot banner: the bytes buffered while the boot \
             was still being decided were lost, so the parser downstream would miss hello and the \
             rest face that setup() ends with"
                .into(),
        );
    }
    if sesame_markers == 0 {
        problems.push("no @SESAME marker on the wire".into());
    }
    if qemu_diagnostics_in_stream {
        problems.push(
            "QEMU's own diagnostics reached the BYTE channel. They are not guest output and a \
             telemetry event claiming provenance:observed for them would be laundering."
                .into(),
        );
    }
    if survived {
        problems.push(format!("pid {pid} is still in tasklist after stop"));
    }

    CycleReport {
        cycle,
        ok: problems.is_empty(),
        pid: Some(pid),
        port: Some(port),
        attempts: info.attempts.len() as u32,
        boot_ms: info.boot_ms,
        total_ms: info.total_ms,
        uart_bytes: bytes.len(),
        banner_in_stream,
        rom_banner_in_stream,
        banner_offset,
        sesame_markers_before_banner,
        sesame_markers,
        qemu_diagnostics_in_stream,
        diagnostics_on_event_channel: diagnostic_lines,
        survived,
        problem: (!problems.is_empty()).then(|| problems.join("; ")),
        args: info.args,
        engine: info.origin.engine,
        image_name: info.origin.image_name,
        teardown_enforced_by_job_object: info.teardown_enforced_by_job_object,
    }
}

fn count(haystack: &[u8], needle: &[u8]) -> usize {
    let mut total = 0;
    let mut from = 0;
    while let Some(at) = boot::find(&haystack[from..], needle) {
        total += 1;
        from += at + 1;
    }
    total
}

fn failed(cycle: u32, started: Instant, problem: String) -> CycleReport {
    CycleReport {
        cycle,
        ok: false,
        pid: None,
        port: None,
        attempts: 0,
        boot_ms: 0,
        total_ms: started.elapsed().as_millis() as u64,
        uart_bytes: 0,
        banner_in_stream: false,
        rom_banner_in_stream: false,
        banner_offset: None,
        sesame_markers_before_banner: 0,
        sesame_markers: 0,
        qemu_diagnostics_in_stream: false,
        diagnostics_on_event_channel: 0,
        survived: false,
        problem: Some(problem),
        args: Vec::new(),
        engine: None,
        image_name: String::new(),
        teardown_enforced_by_job_object: cfg!(windows),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse(args: &[&str]) -> Option<SelftestArgs> {
        parse_args(args.iter().map(|a| (*a).to_string()), "--emulator-selftest")
    }

    #[test]
    fn an_ordinary_launch_is_not_a_selftest() {
        assert!(parse(&[]).is_none());
        assert!(parse(&["--resource-report"]).is_none());
    }

    #[test]
    fn the_flag_takes_an_optional_path_and_two_numbers() {
        let one = parse(&["--emulator-selftest"]).unwrap();
        assert_eq!(one.destination, std::path::PathBuf::from(DEFAULT_OUT));
        assert_eq!(one.cycles, 1);
        assert_eq!(one.hold_ms, 0);

        let ten = parse(&["--emulator-selftest", "out.json", "--cycles", "10"]).unwrap();
        assert_eq!(ten.destination, std::path::PathBuf::from("out.json"));
        assert_eq!(ten.cycles, 10);

        let held = parse(&["--emulator-selftest", "--hold-ms", "60000"]).unwrap();
        assert_eq!(held.destination, std::path::PathBuf::from(DEFAULT_OUT));
        assert_eq!(held.hold_ms, 60000);
    }

    #[test]
    fn zero_cycles_is_one_cycle() {
        assert_eq!(
            parse(&["--emulator-selftest", "--cycles", "0"])
                .unwrap()
                .cycles,
            1
        );
    }

    #[test]
    fn counting_is_overlapping_safe() {
        assert_eq!(count(b"aaaa", b"aa"), 3);
        assert_eq!(count(b"@SESAME x\n@SESAME y\n", b"@SESAME"), 2);
        assert_eq!(count(b"nothing", b"@SESAME"), 0);
    }

    /// `qemu_pids()` must answer with a list rather than panic, whether or not
    /// anything is running and whether or not `tasklist` exists.
    #[test]
    fn enumerating_processes_never_panics() {
        let _ = qemu_pids();
    }
}
