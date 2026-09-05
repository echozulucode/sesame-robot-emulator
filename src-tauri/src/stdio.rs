//! `sesame-lab-desktop.exe --supervisor-stdio` — the same supervisor, driven
//! from a process that is not a webview.
//!
//! ## Why this exists, stated plainly, because it is the awkward part of T4
//!
//! T4's acceptance is `describeRobotContract` — the same fifteen cases
//! `QemuSesameRobot` had to clear, unweakened. Those cases are Node code: they
//! `import assert from 'node:assert/strict'`, and **C14 constructs a real
//! `SesameApiServer` and calls `listen()`**, which is `node:http`. There is no
//! arrangement in which that suite runs inside a WebView2 window.
//!
//! So the suite runs where it has always run — in vitest, on Node — and the
//! question becomes what `TauriSesameRobot` talks to there. Three answers were
//! available and two of them are worse:
//!
//! 1. **A fake supervisor.** Fails the point of the exercise: C01 and C02
//!    assert the firmware's own choreography, so nothing short of real firmware
//!    can satisfy them, and a suite that passed against a fake would be
//!    measuring the fake.
//! 2. **A second supervisor in Node**, spawning QEMU with `child_process` and
//!    reading the socket with `net`. That is a *second implementation* of the
//!    thing T3 built — the exact drift T3 §7 refused for the capability record —
//!    and it would prove nothing about the Rust the app actually ships.
//! 3. **This.** The contract drives the shipped binary, which resolves the
//!    bundled paths through `app.path()`, boots the bundled QEMU through the
//!    same [`crate::qemu::launch_with_retry`] `spawn_emulator` calls, enforces
//!    the same 192-byte budget through the same [`crate::qemu::Session::write`],
//!    and tears down through the same job object.
//!
//! The only thing that differs from the app's own path is the *carrier*: an
//! IPC `Channel` there, a pipe here. Which is why the carrier is designed to be
//! transparent — see below.
//!
//! ## The frame, and why it is a length prefix rather than base64
//!
//! ```text
//! [u8 kind][u32 little-endian length][length bytes of payload]
//!
//! kind 0  UART0 bytes, exactly as the socket carried them
//! kind 1  UTF-8 JSON: one reply or one SupervisorEvent
//! ```
//!
//! stdout has to carry two things that must not be confused, which is the same
//! problem the app solves with two channels. A length prefix keeps the byte
//! stream **byte-identical** — `stdio_frames_round_trip_bytes_unchanged` asserts
//! that over a payload containing every value 0..=255, newlines and a `@SESAME`
//! marker included. base64 would have put an encoding between the socket and
//! the parser, which is the one thing this whole workstream must not do.
//!
//! QEMU's own stdout/stderr still travels as a `diagnostic` **event** (kind 1)
//! and never as kind 0, so the honesty rule T3 §2 states survives the change of
//! carrier unaltered.
//!
//! stdin is one JSON object per line:
//!
//! ```text
//! {"id":1,"op":"spawn","options":{...}}   -> reply: SessionInfo
//! {"id":2,"op":"send","bytes":[115,...]}  -> reply: bytes written
//! {"id":3,"op":"status"}                  -> reply: StatusReport
//! {"id":4,"op":"stop"}                    -> reply: StopReport
//! {"id":5,"op":"quit"}                    -> reply, then exit
//! ```
//!
//! EOF on stdin is a quit: a test runner that dies takes the emulator with it
//! even if it never got to say so. The job object covers the case where this
//! process dies too.
//!
//! **This is a test harness and it is not reachable from the app.** It requires
//! a command-line flag the window never passes, and it is the only thing in the
//! crate that reads stdin.

use std::io::{BufRead, Write};
use std::sync::{Arc, Mutex};

use serde::{Deserialize, Serialize};

use crate::qemu::{self, Session, SessionInfo, SupervisorEvent};
use crate::supervisor::{SpawnOptions, StatusReport, StopReport};

/// Frame kind: raw UART0 bytes.
pub const KIND_BYTES: u8 = 0;
/// Frame kind: UTF-8 JSON.
pub const KIND_JSON: u8 = 1;

/// One request from the driving process.
#[derive(Debug, Deserialize)]
struct Request {
    id: u64,
    op: String,
    #[serde(default)]
    options: Option<SpawnOptions>,
    #[serde(default)]
    bytes: Option<Vec<u8>>,
}

/// One reply. `result` is whatever the op produced; `error` is a [`qemu::QemuError`]
/// serialized exactly as the IPC command would serialize it, so the JavaScript
/// side has one error shape rather than two.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct Reply<'a> {
    #[serde(rename = "type")]
    kind: &'a str,
    id: u64,
    ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    result: Option<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<serde_json::Value>,
}

/// A `SupervisorEvent` on its way out, wrapped so the JS side can tell a
/// progress event from a reply on the one JSON frame kind.
#[derive(Debug, Serialize)]
struct EventEnvelope<'a> {
    #[serde(rename = "type")]
    kind: &'a str,
    event: SupervisorEvent,
}

/// Everything that writes to stdout, behind one lock.
///
/// A frame must never interleave with another frame — a reply written into the
/// middle of a UART chunk would corrupt both — and the byte sink is called from
/// the socket reader thread while the main thread is answering a request.
#[derive(Clone)]
struct Out(Arc<Mutex<std::io::Stdout>>);

impl Out {
    fn frame(&self, kind: u8, payload: &[u8]) {
        let mut stdout = self.0.lock().expect("stdout lock");
        let len = u32::try_from(payload.len()).unwrap_or(u32::MAX);
        // Any of these failing means the driving process is gone. There is
        // nothing useful to do about it here; EOF on stdin will end the loop.
        let _ = stdout.write_all(&[kind]);
        let _ = stdout.write_all(&len.to_le_bytes());
        let _ = stdout.write_all(payload);
        let _ = stdout.flush();
    }

    fn json<T: Serialize>(&self, value: &T) {
        match serde_json::to_vec(value) {
            Ok(bytes) => self.frame(KIND_JSON, &bytes),
            Err(error) => eprintln!("[stdio] cannot serialize a frame: {error}"),
        }
    }
}

/// `true` when `--supervisor-stdio` is on the command line.
pub fn requested<I: Iterator<Item = String>>(args: I, flag: &str) -> bool {
    args.into_iter().any(|a| a == flag)
}

/// Read requests until stdin ends, then stop whatever is running.
///
/// Returns the process exit code. Blocking throughout and deliberately so:
/// there is no window to keep responsive, and a boot is up to twelve attempts.
pub fn run(app: &tauri::App) -> i32 {
    let out = Out(Arc::new(Mutex::new(std::io::stdout())));
    let mut session: Option<Session> = None;
    let stdin = std::io::stdin();
    let mut line = String::new();

    eprintln!("[stdio] supervisor ready");
    loop {
        line.clear();
        match stdin.lock().read_line(&mut line) {
            Ok(0) => break, // EOF: the driver is gone.
            Ok(_) => {}
            Err(error) => {
                eprintln!("[stdio] stdin: {error}");
                break;
            }
        }
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        let request: Request = match serde_json::from_str(trimmed) {
            Ok(request) => request,
            Err(error) => {
                eprintln!("[stdio] not a request: {error}");
                continue;
            }
        };
        if request.op == "quit" {
            reply_ok(&out, request.id, serde_json::json!({ "quit": true }));
            break;
        }
        dispatch(app, &out, &mut session, request);
    }

    if let Some(session) = session.take() {
        session.stop();
    }
    eprintln!("[stdio] supervisor exiting");
    0
}

fn dispatch(app: &tauri::App, out: &Out, session: &mut Option<Session>, request: Request) {
    match request.op.as_str() {
        "spawn" => match spawn(app, out, session, request.options.unwrap_or_default()) {
            Ok(info) => reply_ok(out, request.id, to_value(&info)),
            Err(error) => reply_err(out, request.id, &error),
        },
        "send" => {
            let bytes = request.bytes.unwrap_or_default();
            match session.as_ref() {
                None => reply_err(
                    out,
                    request.id,
                    &qemu::QemuError::NotConnected {
                        message: "no emulator session; spawn first".into(),
                    },
                ),
                Some(live) => match live.write(&bytes) {
                    Ok(written) => reply_ok(out, request.id, serde_json::json!(written)),
                    Err(error) => reply_err(out, request.id, &error),
                },
            }
        }
        "status" => {
            let report = match session.as_ref() {
                None => StatusReport {
                    running: false,
                    pid: None,
                    port: None,
                    guest_panic: None,
                },
                Some(live) => StatusReport {
                    running: live.alive(),
                    pid: Some(live.pid()),
                    port: Some(live.port()),
                    guest_panic: live.panic_text(),
                },
            };
            reply_ok(out, request.id, to_value(&report));
        }
        "stop" => {
            let stopped = session.take().map(|live| {
                let pid = live.pid();
                live.stop();
                pid
            });
            let report = StopReport {
                was_running: stopped.is_some(),
                pid: stopped,
            };
            reply_ok(out, request.id, to_value(&report));
        }
        other => {
            eprintln!("[stdio] unknown op {other}");
            reply_err(
                out,
                request.id,
                &qemu::QemuError::Io {
                    message: format!("unknown op {other}"),
                },
            );
        }
    }
}

/// The one place a session is created, and it goes through exactly what
/// `spawn_emulator` goes through: the bundled paths, the retry loop, the job
/// object. Any live session is stopped first, as the command does.
fn spawn(
    app: &tauri::App,
    out: &Out,
    session: &mut Option<Session>,
    options: SpawnOptions,
) -> Result<SessionInfo, qemu::QemuError> {
    if let Some(previous) = session.take() {
        previous.stop();
    }
    let launch = options.apply(crate::supervisor::options_from_resources(
        &app.handle().clone(),
    )?);

    let byte_out = out.clone();
    let event_out = out.clone();
    let (live, info) = qemu::launch_with_retry(
        &launch,
        // The byte channel: the wire, and nothing else.
        Arc::new(move |bytes: &[u8]| byte_out.frame(KIND_BYTES, bytes)),
        // The event channel: progress, and QEMU's own diagnostics.
        Arc::new(move |event| {
            event_out.json(&EventEnvelope {
                kind: "event",
                event,
            })
        }),
    )?;
    *session = Some(live);
    Ok(info)
}

fn to_value<T: Serialize>(value: &T) -> serde_json::Value {
    serde_json::to_value(value).unwrap_or(serde_json::Value::Null)
}

fn reply_ok(out: &Out, id: u64, result: serde_json::Value) {
    out.json(&Reply {
        kind: "reply",
        id,
        ok: true,
        result: Some(result),
        error: None,
    });
}

fn reply_err(out: &Out, id: u64, error: &qemu::QemuError) {
    out.json(&Reply {
        kind: "reply",
        id,
        ok: false,
        result: None,
        error: Some(to_value(error)),
    });
}

/// Read one frame from a reader. Used only by the round-trip test — the
/// production reader is the TypeScript one in
/// `apps/web/src/backends/tauri/stdio-supervisor.ts`, and this exists so the
/// framing has a Rust-side assertion of its own.
#[cfg(test)]
fn read_frame<R: std::io::Read>(reader: &mut R) -> Option<(u8, Vec<u8>)> {
    let mut head = [0u8; 5];
    reader.read_exact(&mut head).ok()?;
    let len = u32::from_le_bytes([head[1], head[2], head[3], head[4]]) as usize;
    let mut payload = vec![0u8; len];
    reader.read_exact(&mut payload).ok()?;
    Some((head[0], payload))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_flag_is_not_an_ordinary_launch() {
        let args = |v: &[&str]| v.iter().map(|s| (*s).to_string()).collect::<Vec<_>>();
        assert!(!requested(args(&[]).into_iter(), "--supervisor-stdio"));
        assert!(!requested(
            args(&["--resource-report"]).into_iter(),
            "--supervisor-stdio"
        ));
        assert!(requested(
            args(&["--supervisor-stdio"]).into_iter(),
            "--supervisor-stdio"
        ));
    }

    /// The property the whole carrier rests on: what goes in is what comes out.
    ///
    /// Every byte value, a `@SESAME` marker, embedded newlines and a length
    /// that needs more than one byte of the prefix — because a framing that is
    /// only tested on ASCII is untested for the OLED framebuffer, which is
    /// 1,024 arbitrary bytes.
    #[test]
    fn stdio_frames_round_trip_bytes_unchanged() {
        let mut payload: Vec<u8> = (0u8..=255).collect();
        payload.extend_from_slice(b"\n@SESAME servo R1 90\n");
        payload.extend(std::iter::repeat_n(0xAAu8, 4096));

        let mut wire = Vec::new();
        wire.push(KIND_BYTES);
        wire.extend_from_slice(&(payload.len() as u32).to_le_bytes());
        wire.extend_from_slice(&payload);
        wire.push(KIND_JSON);
        let json = br#"{"type":"reply","id":1,"ok":true}"#;
        wire.extend_from_slice(&(json.len() as u32).to_le_bytes());
        wire.extend_from_slice(json);

        let mut cursor = std::io::Cursor::new(wire);
        let (kind, first) = read_frame(&mut cursor).expect("a byte frame");
        assert_eq!(kind, KIND_BYTES);
        assert_eq!(first, payload, "the byte channel must be byte-identical");
        let (kind, second) = read_frame(&mut cursor).expect("a json frame");
        assert_eq!(kind, KIND_JSON);
        assert_eq!(second, json);
        assert!(read_frame(&mut cursor).is_none(), "exactly two frames");
    }

    /// A request with no options must not become a request with different
    /// options — the defaults are Q2's measured numbers.
    #[test]
    fn a_request_parses_without_optional_fields() {
        let request: Request = serde_json::from_str(r#"{"id":7,"op":"stop"}"#).unwrap();
        assert_eq!(request.id, 7);
        assert_eq!(request.op, "stop");
        assert!(request.options.is_none());
        assert!(request.bytes.is_none());
    }
}
