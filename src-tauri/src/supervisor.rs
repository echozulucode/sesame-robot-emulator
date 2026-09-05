//! The Tauri adapter over [`crate::qemu`] — Phase 5 T3's command surface.
//!
//! Thin on purpose. Everything that is hard — the process, the socket, the
//! retry loop, the job object — is in `qemu`, which knows nothing about Tauri
//! and can therefore be tested from a plain binary. This file resolves two
//! paths, turns two closures into two IPC channels, and holds the one live
//! session.
//!
//! ## The channel shape, and why there are two of them
//!
//! ```text
//! uart   : Channel<tauri::ipc::Response>   raw bytes, ArrayBuffer in JS
//! events : Channel<SupervisorEvent>        JSON progress, never bytes
//! ```
//!
//! The byte channel carries **the wire and nothing else**. Nothing is added to
//! it, nothing is removed from it, and no framing is applied — the
//! `SesameTelemetryParser` on the other side is proven chunk-invariant across
//! ~1,500 split offsets and must see exactly what the socket carried.
//!
//! That is also why QEMU's own stdout/stderr goes on the *event* channel as
//! `Diagnostic` and never on the byte channel. `session.ts` states the rule and
//! it is the sharpest honesty rule in the package: a log event claiming
//! `provenance: observed` for something the emulator said *about itself* would
//! be exactly the laundering the whole design exists to avoid.
//!
//! `tauri::ipc::Response::new(Vec<u8>)` produces an `InvokeResponseBody::Raw`,
//! which reaches JavaScript as an `ArrayBuffer` — a JSON array of 4,096 numbers
//! per OLED frame would be neither honest nor fast. Ordering is preserved by
//! `Channel` itself: every message carries an index and the JS side reassembles
//! in order, which matters because a reordered byte stream is a corrupted one.
//!
//! ## The paths are not parameters
//!
//! `spawn_emulator` takes no image path and no QEMU path. They come from
//! [`crate::resources::resolve`] and nowhere else — T2 §6.2 — and making them
//! un-overridable from the webview is the same property V7 chose the HTTP
//! adapter for: the app cannot assert what it is talking to. A frontend that
//! could hand in an arbitrary image could change what
//! `capabilitiesForImage()` reports about pixels it did not observe.

use std::sync::{Arc, Mutex};

use serde::{Deserialize, Serialize};
use tauri::ipc::{Channel, Response};
use tauri::{AppHandle, Manager};

use crate::qemu::{self, LaunchOptions, QemuError, Session, SessionInfo, SupervisorEvent};
use crate::resources;

/// The one live session, if there is one.
///
/// Managed as an `Arc` so a command can clone it out of the state and move it
/// into `spawn_blocking`: a boot is up to 12 attempts of up to 15 s and must
/// not run on the thread that draws the window.
#[derive(Default)]
pub struct Supervisor {
    session: Mutex<Option<Session>>,
}

impl Supervisor {
    /// Stop and forget the current session, if any. Idempotent.
    pub fn clear(&self) -> Option<u32> {
        let taken = self.session.lock().expect("session lock").take();
        taken.map(|session| {
            let pid = session.pid();
            session.stop();
            drop(session);
            pid
        })
    }
}

/// The knobs a caller may turn. Owned types only — an async command cannot
/// borrow its arguments.
///
/// Deliberately absent: `qemuPath` and `imagePath`. See the module docs.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct SpawnOptions {
    /// Boot attempts. Default 12 — Q2's measured budget, not a round number.
    pub boot_attempts: Option<u32>,
    /// Milliseconds for one attempt's banner. Default 15000.
    pub boot_timeout_ms: Option<u64>,
    /// UART0 TCP port. Default 0 = ask the OS for a free one.
    pub uart_port: Option<u16>,
    /// `-drive ...,snapshot=on`. Default true and there is no good reason to
    /// turn it off; see [`LaunchOptions::snapshot`]. Exposed only so a test can
    /// state that it deliberately wants a writable image.
    pub snapshot: Option<bool>,
}

impl SpawnOptions {
    fn apply(self, mut options: LaunchOptions) -> LaunchOptions {
        if let Some(attempts) = self.boot_attempts {
            options.boot_attempts = attempts.max(1);
        }
        if let Some(timeout) = self.boot_timeout_ms {
            options.boot_timeout_ms = timeout;
        }
        if let Some(port) = self.uart_port {
            options.uart_port = port;
        }
        if let Some(snapshot) = self.snapshot {
            options.snapshot = snapshot;
        }
        options
    }
}

/// What `stop_emulator` answers with.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StopReport {
    /// False when there was nothing to stop — not an error.
    pub was_running: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pid: Option<u32>,
}

/// What `emulator_status` answers with. Cheap; safe to poll.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StatusReport {
    pub running: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pid: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub port: Option<u16>,
    /// The panic text, if the guest died under us.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub guest_panic: Option<String>,
}

/// Build [`LaunchOptions`] from the bundle. The only place paths come from.
pub fn options_from_resources(app: &AppHandle) -> Result<LaunchOptions, QemuError> {
    let qemu_path = resources::resolve(app, resources::QEMU_EXE)
        .map_err(|message| QemuError::Io { message })?;
    let image_path = resources::resolve(app, resources::FLASH_IMAGE)
        .map_err(|message| QemuError::Io { message })?;
    Ok(LaunchOptions::new(qemu_path, image_path))
}

fn supervisor(app: &AppHandle) -> Arc<Supervisor> {
    app.state::<Arc<Supervisor>>().inner().clone()
}

/// Boot the bundled QEMU and start streaming UART0.
///
/// Any session already running is stopped first, so a double-invoke leaks
/// nothing — that is one of the three repeat cases §7 of the plan names.
#[tauri::command]
pub async fn spawn_emulator(
    app: AppHandle,
    options: SpawnOptions,
    uart: Channel<Response>,
    events: Channel<SupervisorEvent>,
) -> Result<SessionInfo, QemuError> {
    let launch = options.apply(options_from_resources(&app)?);
    let state = supervisor(&app);
    state.clear();

    let byte_sink: qemu::ByteSink = Arc::new(move |bytes: &[u8]| {
        // A send failure means the webview is gone. There is nothing useful to
        // do about it here; the session is torn down by the exit hook.
        let _ = uart.send(Response::new(bytes.to_vec()));
    });
    let event_sink: qemu::EventSink = Arc::new(move |event| {
        let _ = events.send(event);
    });

    // Up to 12 × 15 s of blocking work. Off the UI thread, on Tauri's own
    // runtime — no second async runtime is introduced.
    let launched = tauri::async_runtime::spawn_blocking(move || {
        qemu::launch_with_retry(&launch, byte_sink, event_sink)
    })
    .await
    .map_err(|e| QemuError::Io {
        message: format!("the boot task did not finish: {e}"),
    })??;

    let (session, info) = launched;
    *state.session.lock().expect("session lock") = Some(session);
    Ok(info)
}

/// Kill QEMU and wait for the OS to confirm it.
#[tauri::command]
pub async fn stop_emulator(app: AppHandle) -> Result<StopReport, QemuError> {
    let state = supervisor(&app);
    let stopped = tauri::async_runtime::spawn_blocking(move || state.clear())
        .await
        .map_err(|e| QemuError::Io {
            message: format!("the stop task did not finish: {e}"),
        })?;
    Ok(StopReport {
        was_running: stopped.is_some(),
        pid: stopped,
    })
}

/// Write raw bytes to UART0.
///
/// **Raw.** T4 hands down the output of the existing `encodeCommand()` with the
/// existing `BARRIER_COMMAND` already appended; nothing here encodes, terminates
/// or frames anything. The one rule applied is the wire's own: at most
/// [`qemu::MAX_WRITE_BYTES`] per write, because arduino-esp32's 256-byte UART
/// ring buffer drains one character per `loop()` and overflows silently.
#[tauri::command]
pub async fn send_command(app: AppHandle, bytes: Vec<u8>) -> Result<usize, QemuError> {
    let state = supervisor(&app);
    tauri::async_runtime::spawn_blocking(move || {
        let guard = state.session.lock().expect("session lock");
        let session = guard.as_ref().ok_or_else(|| QemuError::NotConnected {
            message: "no emulator session; call spawn_emulator first".into(),
        })?;
        session.write(&bytes)
    })
    .await
    .map_err(|e| QemuError::Io {
        message: format!("the write task did not finish: {e}"),
    })?
}

/// Is anything running, and did it die?
#[tauri::command]
pub fn emulator_status(app: AppHandle) -> StatusReport {
    let state = supervisor(&app);
    let guard = state.session.lock().expect("session lock");
    match guard.as_ref() {
        None => StatusReport {
            running: false,
            pid: None,
            port: None,
            guest_panic: None,
        },
        Some(session) => StatusReport {
            running: session.alive(),
            pid: Some(session.pid()),
            port: Some(session.port()),
            guest_panic: session.panic_text(),
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_defaults_survive_an_empty_options_object() {
        let base = LaunchOptions::new("q".into(), "i".into());
        let applied = SpawnOptions::default().apply(base.clone());
        assert_eq!(applied.boot_attempts, base.boot_attempts);
        assert_eq!(applied.boot_timeout_ms, base.boot_timeout_ms);
        assert!(applied.snapshot, "snapshot=on must survive; T2 §6.3");
    }

    #[test]
    fn zero_attempts_is_still_one_attempt() {
        let applied = SpawnOptions {
            boot_attempts: Some(0),
            ..Default::default()
        }
        .apply(LaunchOptions::new("q".into(), "i".into()));
        assert_eq!(applied.boot_attempts, 1);
    }

    /// The frontend cannot choose what it is talking to. If this ever gains a
    /// path field, `capabilitiesForImage()` becomes something the app asserts
    /// rather than something the backend reports.
    #[test]
    fn spawn_options_carry_no_paths() {
        let json = serde_json::json!({
            "qemuPath": "C:/evil/qemu.exe",
            "imagePath": "C:/evil/anything.flash.bin",
            "bootAttempts": 3
        });
        let parsed: SpawnOptions = serde_json::from_value(json).unwrap();
        assert_eq!(parsed.boot_attempts, Some(3));
        let applied = parsed.apply(LaunchOptions::new("real-qemu".into(), "real-image".into()));
        assert_eq!(applied.qemu_path, std::path::PathBuf::from("real-qemu"));
        assert_eq!(applied.image_path, std::path::PathBuf::from("real-image"));
    }

    #[test]
    fn clearing_an_empty_supervisor_is_not_an_error() {
        let supervisor = Supervisor::default();
        assert_eq!(supervisor.clear(), None);
        assert_eq!(supervisor.clear(), None);
    }
}
