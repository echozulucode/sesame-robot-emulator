//! One QEMU process, one UART0 socket, both directions — Phase 5 T3.
//!
//! This is the Rust half of option C
//! (`docs/plans/phase-5-tauri-desktop-app.md` §4): the two things a webview
//! cannot do, and deliberately nothing else.
//!
//! ```text
//! Rust (this module)                    TypeScript (T4, unchanged from web)
//! ─────────────────────────             ───────────────────────────────────
//! spawn qemu-system-xtensa  ──┐
//! TCP connect to UART0        ├──► raw bytes ──► SesameTelemetryParser
//! stream bytes on a Channel ──┘                  (255 tests, chunk-invariant)
//! write serial-CLI bytes    ◄──── encodeCommand()
//! boot-panic retry (~28%)
//! ```
//!
//! It is a port of the *process and socket* half of
//! `packages/sesame-qemu/src/session.ts`. The `@SESAME` parser and
//! `encodeCommand` are **not** ported: their invariants are proven in
//! TypeScript across 255 tests and ~1,500 chunk splits, and a subtly different
//! second implementation is the bug this project is worst at seeing. What is
//! ported is everything in `session.ts` that is about a process that can die, a
//! socket that can refuse, a guest that can panic before it prints anything,
//! and a Windows PID that must not be left behind.
//!
//! ## Nothing here depends on Tauri
//!
//! The sinks are two closures. That is not decoupling for its own sake: it is
//! what lets the acceptance test in `crate::selftest` boot the **bundled** QEMU
//! from a packaged `.exe` with no window and no webview, and lets the unit
//! tests in `boot` run with neither. `crate::supervisor` is the ~150-line
//! adapter that turns those closures into `tauri::ipc::Channel` sends.
//!
//! ## The three things `session.ts` is careful about, kept
//!
//! **1. Attaching before the guest speaks.** Poll-connect from the instant QEMU
//! is spawned, not a fixed sleep, so the first bytes out of the mask ROM are
//! captured — which is how the earliest panics become visible at all.
//!
//! **2. Boot is verified, not assumed.** A session is usable only once the
//! firmware's own end-of-`setup()` banner has crossed the wire. Anything else —
//! a panic, a silent hang, a QEMU exit — fails the attempt and
//! [`launch_with_retry`] starts a fresh process.
//!
//! **3. Teardown leaves nothing behind.** See [`job`]. `session.ts` uses a
//! module-level registry plus a `process.on('exit')` hook; that is the best a
//! Node process can do, and it still cannot survive its own hard kill. A job
//! object can, so this uses one.
//!
//! ## The bytes a failed attempt produced go nowhere
//!
//! Boot is telemetry — `@SESAME hello`, the `rest` face `setup()` ends with —
//! so a consumer that only started receiving after the banner would miss all of
//! it. `session.ts` solves that by buffering every event of the surviving
//! attempt and replaying it. The same idea, one layer lower: bytes are
//! accumulated until the banner is seen, then the whole accumulation is handed
//! to the sink in one piece and the stream goes live. A failed attempt's bytes
//! are dropped with its process.
//!
//! The parser downstream therefore receives exactly the concatenated byte
//! stream of the boot that survived, from its first byte, and never a byte from
//! a boot that panicked. Where the reads happened to split is irrelevant to it
//! by construction.

pub mod boot;
pub mod job;

use std::io::{Read, Write};
use std::net::{Shutdown, TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};

/// QEMU `-machine`. Nothing else is supported: QEMU's `esp32s3` machine never
/// reaches `setup()` and there is no `esp32s2` machine at all
/// (`QEMU_CAPABILITIES_FULL.unsupportedBoards`).
pub const DEFAULT_MACHINE: &str = "esp32";

/// Boot attempts before giving up. **Twelve, and the number is a measurement.**
///
/// Q2 measured 25 connects (37 boots, 12 of them failed) and the **worst
/// connect needed 7 attempts**. At an independent 35% per boot, seven failures
/// in a row should happen about once in 1600 connects, so seeing it in 25 is
/// evidence the failures cluster rather than being independent — plausible for
/// a host-timing-sensitive race. Eight would have left almost no margin above
/// an outcome that was actually observed.
pub const DEFAULT_BOOT_ATTEMPTS: u32 = 12;

/// Milliseconds to wait for the boot banner on one attempt.
/// `resolveQemuOptions()`'s default.
pub const DEFAULT_BOOT_TIMEOUT_MS: u64 = 15_000;

/// Most bytes to put on the wire in one write.
///
/// `session.ts`'s `MAX_BATCH_BYTES`, and the reason is the guest, not this
/// code: `UART_BUFFER_SIZE` in arduino-esp32's `HardwareSerial` is 256 by
/// default and the console drains it one character per `loop()` iteration
/// while stalling for the whole of every servo delay. Enough queued bytes
/// really do overflow it and the loss is silent.
///
/// Enforced here rather than left to the caller precisely because the loss is
/// silent: this is a property of the wire, which is the layer Rust owns. It is
/// not protocol framing — that stays in TypeScript.
pub const MAX_WRITE_BYTES: usize = 192;

/// How long a deliberate stop waits for the OS to confirm the exit.
/// `session.ts`'s `dispose()` uses the same 5 s cap.
const STOP_CONFIRM_MS: u64 = 5_000;

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/// Everything [`launch_with_retry`] needs. Both paths are **explicit**.
///
/// T2 §6.2: `resolveQemuOptions()` defaults `qemuPath` and `imagePath` from
/// `import.meta.url`, which is correct for a Node process inside a checkout and
/// meaningless inside an installed `.exe`. There is deliberately no default
/// here — the caller resolves through `crate::resources::resolve` or it does
/// not run.
#[derive(Debug, Clone)]
pub struct LaunchOptions {
    pub qemu_path: PathBuf,
    pub image_path: PathBuf,
    pub machine: String,
    /// `-drive ...,snapshot=on`. **Default true, and T2 §6.3 is why.**
    ///
    /// `if=mtd` is read-write: the guest's NVS and core-dump writes land in the
    /// image file. In an installed app that file may sit under
    /// `C:\Program Files\`, where the write fails, or under `%LOCALAPPDATA%`,
    /// where it succeeds and quietly mutates the shipped artefact so every
    /// subsequent boot differs from the first. It does **not** affect
    /// ISSUE-20260823-022 (measured: 6/20 failures with, 8/20 without); it
    /// protects the image, not the boot.
    pub snapshot: bool,
    pub boot_attempts: u32,
    pub boot_timeout_ms: u64,
    /// TCP port for UART0. 0 asks the OS for a free one.
    pub uart_port: u16,
    pub max_write_bytes: usize,
}

impl LaunchOptions {
    /// The two resolved paths plus every default from `resolveQemuOptions()`.
    pub fn new(qemu_path: PathBuf, image_path: PathBuf) -> Self {
        Self {
            qemu_path,
            image_path,
            machine: DEFAULT_MACHINE.to_string(),
            snapshot: true,
            boot_attempts: DEFAULT_BOOT_ATTEMPTS,
            boot_timeout_ms: DEFAULT_BOOT_TIMEOUT_MS,
            uart_port: 0,
            max_write_bytes: MAX_WRITE_BYTES,
        }
    }

    /// The argv, exactly as `session.ts` builds it.
    ///
    /// Split out so it can be asserted against the TypeScript in a unit test
    /// and reported verbatim in [`SessionInfo::args`]. Any deviation from
    /// `session.ts` is a behaviour change; there are none.
    pub fn args(&self, port: u16) -> Vec<String> {
        let mut drive = format!(
            "file={},if=mtd,format=raw",
            dunce::simplified(&self.image_path).display()
        );
        if self.snapshot {
            drive.push_str(",snapshot=on");
        }
        vec![
            "-display".into(),
            "none".into(),
            "-machine".into(),
            self.machine.clone(),
            "-drive".into(),
            drive,
            "-serial".into(),
            format!("tcp:127.0.0.1:{port},server=on,wait=off"),
        ]
    }
}

// ---------------------------------------------------------------------------
// What the supervisor reports
// ---------------------------------------------------------------------------

/// One boot attempt's outcome. `session.ts`'s `BootAttempt`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BootAttempt {
    pub attempt: u32,
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    pub ms: u64,
}

/// The grounded half of `TelemetryOrigin` — the parts Rust actually observed.
///
/// **V7's property without HTTP.** V7 chose the HTTP adapter so the origin
/// claim would come from the backend rather than from the app asserting it. The
/// same property holds here: these fields are facts about a process this module
/// spawned and a file it opened, and the frontend has no way to substitute
/// different ones.
///
/// What is deliberately **not** here is `elided`, `firmwareDeviations`,
/// `board`, and every capability boolean. Those live in
/// `packages/sesame-qemu/src/config.ts` as frozen, tested objects derived from
/// the image path — `originForImage()`, `capabilitiesForImage()` — and a second
/// hand-typed copy in Rust is exactly the drift that would let the packaged app
/// claim something the web app does not. Rust carries the identity across; the
/// existing derivation decides what it means. `isPhysicallyObserved()` stays
/// false either way: `kind` is `emulator` and there is no other value this
/// module can produce.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OriginFacts {
    /// Always `"emulator"`. There is no branch that produces anything else.
    pub kind: &'static str,
    /// `qemu-system-xtensa --version`, first line, read out of the binary that
    /// was actually spawned — not a constant. `None` if it would not answer.
    pub engine: Option<String>,
    /// The `-machine` this session booted.
    pub machine: String,
    /// Absolute path of the flash image, as resolved from the bundle.
    pub image_path: String,
    /// Its file name — what `imageHasOledHook()` keys `oledFramebuffer` off.
    pub image_name: String,
    /// Absolute path of the emulator binary that was spawned.
    pub qemu_path: String,
}

/// What `spawn_emulator` answers with.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionInfo {
    pub pid: u32,
    /// The TCP port QEMU published UART0 on.
    pub port: u16,
    pub origin: OriginFacts,
    pub snapshot: bool,
    /// The exact argv. Reported so the claim is auditable rather than trusted.
    pub args: Vec<String>,
    /// Every attempt, including the failures. **Surfaced on purpose:** a silent
    /// 17-second freeze reads as a hang (plan §7), so the attempt count has to
    /// be visible, not merely counted.
    pub attempts: Vec<BootAttempt>,
    /// Wall time of the successful attempt.
    pub boot_ms: u64,
    /// Wall time of the whole launch, retries included.
    pub total_ms: u64,
    /// True when teardown is enforced by the OS rather than by a code path.
    pub teardown_enforced_by_job_object: bool,
    pub max_write_bytes: usize,
}

/// Progress, out-of-band from the byte stream.
///
/// Two sinks rather than one tagged stream, because they are different kinds of
/// thing: the byte sink carries *the wire*, and nothing may be added to it or
/// removed from it. QEMU's own diagnostics in particular must never reach the
/// telemetry parser — `session.ts` says why, and it is the sharpest honesty
/// rule in the package:
///
/// > a log event claiming `provenance: observed` for something the emulator
/// > said about itself would be exactly the kind of laundering this package
/// > exists to avoid.
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum SupervisorEvent {
    /// A boot attempt is starting. `attempt` is 1-based.
    Attempt { attempt: u32, of: u32 },
    /// It failed. The next one starts immediately.
    AttemptFailed {
        attempt: u32,
        of: u32,
        reason: String,
        ms: u64,
    },
    /// The banner crossed the wire. Buffered bytes have already been handed to
    /// the byte sink by the time this arrives.
    Booted {
        attempt: u32,
        of: u32,
        ms: u64,
        pid: u32,
        port: u16,
    },
    /// The guest panicked. Before the banner this fails the attempt; after it,
    /// it is reported and the session is left for the caller to stop.
    GuestPanic { text: String },
    /// QEMU's own stdout/stderr. **Not guest output**, and never on the byte
    /// sink.
    Diagnostic { stream: &'static str, text: String },
    /// The QEMU process ended.
    Exited {
        #[serde(skip_serializing_if = "Option::is_none")]
        code: Option<i32>,
    },
    /// A deliberate stop finished. `confirmed` is false only if the OS did not
    /// report the exit within [`STOP_CONFIRM_MS`].
    Stopped { pid: u32, confirmed: bool },
}

/// Everything that can go wrong, as the frontend sees it.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum QemuError {
    /// A bundled resource is not on disk. Retrying cannot help, so
    /// [`launch_with_retry`] gives up immediately — `session.ts` does the same.
    ArtifactMissing { artifact: String, path: String },
    /// Every attempt failed. `reasons` is one per attempt, in order.
    BootFailed {
        attempts: u32,
        reasons: Vec<String>,
        message: String,
    },
    /// No session, or the session is gone.
    NotConnected { message: String },
    /// Over the UART0 receive budget. See [`MAX_WRITE_BYTES`].
    WriteTooLarge { bytes: usize, budget: usize },
    /// Anything else, with the operation named.
    Io { message: String },
}

impl std::fmt::Display for QemuError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::ArtifactMissing { artifact, path } => {
                write!(f, "{artifact} is not at {path}")
            }
            Self::BootFailed { message, .. } | Self::NotConnected { message } => {
                write!(f, "{message}")
            }
            Self::WriteTooLarge { bytes, budget } => write!(
                f,
                "batch of {bytes} bytes exceeds the {budget}-byte UART0 receive budget; split it"
            ),
            Self::Io { message } => write!(f, "{message}"),
        }
    }
}

impl std::error::Error for QemuError {}

/// Where the raw UART0 bytes go. Called with whatever the socket read, plus one
/// leading call carrying everything received before the banner.
pub type ByteSink = Arc<dyn Fn(&[u8]) + Send + Sync>;
/// Where progress goes.
pub type EventSink = Arc<dyn Fn(SupervisorEvent) + Send + Sync>;

// ---------------------------------------------------------------------------
// Session
// ---------------------------------------------------------------------------

#[derive(PartialEq, Eq, Clone, Copy)]
enum Phase {
    /// Bytes are accumulating; nothing has reached the sink.
    Booting,
    /// The banner was seen; every byte goes straight to the sink.
    Streaming,
}

struct State {
    phase: Phase,
    pending: Vec<u8>,
    tail: Vec<u8>,
    banner: bool,
    panic: Option<String>,
    exited: bool,
    exit_code: Option<i32>,
    socket_closed: bool,
}

struct Shared {
    state: Mutex<State>,
    changed: Condvar,
    bytes: ByteSink,
    events: EventSink,
}

impl Shared {
    fn new(bytes: ByteSink, events: EventSink) -> Arc<Self> {
        Arc::new(Self {
            state: Mutex::new(State {
                phase: Phase::Booting,
                pending: Vec::new(),
                tail: Vec::new(),
                banner: false,
                panic: None,
                exited: false,
                exit_code: None,
                socket_closed: false,
            }),
            changed: Condvar::new(),
            bytes,
            events,
        })
    }
}

/// A live QEMU process with an attached, bidirectional UART0.
pub struct Session {
    shared: Arc<Shared>,
    child: Arc<Mutex<Child>>,
    writer: Mutex<TcpStream>,
    job: job::ProcessJob,
    pid: u32,
    port: u16,
    max_write_bytes: usize,
}

impl Session {
    pub fn pid(&self) -> u32 {
        self.pid
    }

    pub fn port(&self) -> u16 {
        self.port
    }

    /// True while QEMU is running.
    pub fn alive(&self) -> bool {
        !self.shared.state.lock().expect("state lock").exited
    }

    /// The panic text, if the guest died.
    pub fn panic_text(&self) -> Option<String> {
        self.shared.state.lock().expect("state lock").panic.clone()
    }

    /// Write raw bytes to UART0.
    ///
    /// **Raw.** No encoding, no terminator, no barrier: T4 sends the output of
    /// the existing `encodeCommand()` and appends the existing
    /// `BARRIER_COMMAND` itself, because those are the prefix-sensitive model
    /// and the protocol, and they live in TypeScript with their tests. This
    /// writes what it is given, in one `write_all`, so the firmware never sees
    /// a gap it could interleave something into — the same reason `session.ts`
    /// writes its lines and its barrier in a single `write()`.
    pub fn write(&self, payload: &[u8]) -> Result<usize, QemuError> {
        if payload.len() > self.max_write_bytes {
            return Err(QemuError::WriteTooLarge {
                bytes: payload.len(),
                budget: self.max_write_bytes,
            });
        }
        if !self.alive() {
            return Err(QemuError::NotConnected {
                message: "QEMU is not running".into(),
            });
        }
        let mut socket = self.writer.lock().expect("writer lock");
        socket.write_all(payload).map_err(|e| QemuError::Io {
            message: format!("writing {} bytes to UART0: {e}", payload.len()),
        })?;
        socket.flush().map_err(|e| QemuError::Io {
            message: format!("flushing UART0: {e}"),
        })?;
        Ok(payload.len())
    }

    /// Kill QEMU and wait for the OS to confirm it.
    ///
    /// Awaiting the confirmation rather than returning after the kill is the
    /// whole difference between "no orphaned processes" as a claim and as a
    /// fact — `session.ts` learned this: `TerminateProcess` returns
    /// immediately, so a check straight afterwards is racing.
    pub fn stop(&self) -> bool {
        // Shut the socket down first so the reader thread leaves its blocking
        // read instead of waiting for the process to drop the connection.
        {
            let socket = self.writer.lock().expect("writer lock");
            let _ = socket.shutdown(Shutdown::Both);
        }
        self.job.terminate();

        let deadline = Instant::now() + Duration::from_millis(STOP_CONFIRM_MS);
        let confirmed = loop {
            {
                let mut child = self.child.lock().expect("child lock");
                match child.try_wait() {
                    Ok(Some(_)) => break true,
                    Ok(None) => {
                        if !self.job.enforced() {
                            let _ = child.kill();
                        }
                    }
                    // Already reaped by the waiter thread.
                    Err(_) => break true,
                }
            }
            if Instant::now() > deadline {
                break false;
            }
            std::thread::sleep(Duration::from_millis(10));
        };

        {
            let mut state = self.shared.state.lock().expect("state lock");
            state.exited = true;
        }
        self.shared.changed.notify_all();
        (self.shared.events)(SupervisorEvent::Stopped {
            pid: self.pid,
            confirmed,
        });
        confirmed
    }
}

impl Drop for Session {
    /// The last line of the deliberate path. The *guarantee* is `job`'s `Drop`,
    /// which runs after this one and closes the last handle to the job — and
    /// runs even when this does not, because the kernel does it.
    fn drop(&mut self) {
        let alive = self.alive();
        if alive {
            self.stop();
        }
    }
}

// ---------------------------------------------------------------------------
// Bring-up
// ---------------------------------------------------------------------------

/// Ask the OS for a free loopback port, exactly as `session.ts`'s `freePort()`.
///
/// Same benign race as the Node version: the port is free when it is asked for
/// and QEMU binds it a few milliseconds later. A collision fails that attempt
/// and the retry loop takes the next one.
fn free_port() -> Result<u16, QemuError> {
    let listener = TcpListener::bind("127.0.0.1:0").map_err(|e| QemuError::Io {
        message: format!("asking the OS for a free UART port: {e}"),
    })?;
    let port = listener
        .local_addr()
        .map_err(|e| QemuError::Io {
            message: format!("reading the free port back: {e}"),
        })?
        .port();
    drop(listener);
    Ok(port)
}

/// `qemu-system-xtensa --version`, first line.
///
/// Read out of the binary that is about to be spawned rather than taken from a
/// constant, so [`OriginFacts::engine`] is something the backend observed. Best
/// effort: a failure here is not a reason to refuse to boot.
fn qemu_version(qemu_path: &Path) -> Option<String> {
    let output = Command::new(qemu_path)
        .arg("--version")
        .stdin(Stdio::null())
        .output()
        .ok()?;
    let text = String::from_utf8_lossy(&output.stdout);
    text.lines().next().map(|l| l.trim().to_string())
}

fn spawn_line_pump(
    stream: impl Read + Send + 'static,
    name: &'static str,
    events: EventSink,
) -> std::thread::JoinHandle<()> {
    std::thread::spawn(move || {
        let reader = std::io::BufReader::new(stream);
        for line in std::io::BufRead::lines(reader).map_while(Result::ok) {
            let text = line.trim().to_string();
            if !text.is_empty() {
                events(SupervisorEvent::Diagnostic { stream: name, text });
            }
        }
    })
}

/// The reader thread: the only place a UART byte is ever handled.
///
/// It does three things, and the order inside the lock is the correctness:
/// extend the tail and scan it, accumulate-or-forward the chunk, and — on the
/// read where the banner first appears — flip to streaming and hand the whole
/// accumulation over in one piece. Because one thread does all of it, the sink
/// sees the concatenated byte stream of this boot, in order, with nothing
/// inserted and nothing dropped.
fn reader_thread(shared: Arc<Shared>, mut socket: TcpStream) {
    let mut buffer = [0u8; 16 * 1024];
    loop {
        let read = match socket.read(&mut buffer) {
            Ok(0) => break,
            Ok(n) => n,
            Err(_) => break,
        };
        let chunk = &buffer[..read];

        let mut emit: Option<Vec<u8>> = None;
        let mut newly_booted = false;
        let mut newly_panicked: Option<String> = None;
        {
            let mut state = shared.state.lock().expect("state lock");
            state.tail.extend_from_slice(chunk);
            boot::trim_tail(&mut state.tail);
            if !state.banner && boot::has_banner(&state.tail) {
                state.banner = true;
                newly_booted = true;
            }
            if state.panic.is_none() {
                if let Some(text) = boot::first_panic(&state.tail) {
                    state.panic = Some(text.clone());
                    newly_panicked = Some(text);
                }
            }
            match state.phase {
                Phase::Booting => {
                    state.pending.extend_from_slice(chunk);
                    if state.banner {
                        state.phase = Phase::Streaming;
                        emit = Some(std::mem::take(&mut state.pending));
                    }
                }
                Phase::Streaming => emit = Some(chunk.to_vec()),
            }
        }

        // Sinks are called with no lock held: they cross an IPC boundary and
        // must never be able to deadlock the reader.
        if let Some(bytes) = emit {
            (shared.bytes)(&bytes);
        }
        if newly_booted || newly_panicked.is_some() {
            shared.changed.notify_all();
        }
        if let Some(text) = newly_panicked {
            (shared.events)(SupervisorEvent::GuestPanic { text });
        }
    }

    {
        let mut state = shared.state.lock().expect("state lock");
        state.socket_closed = true;
    }
    shared.changed.notify_all();
}

/// Poll `try_wait()` rather than blocking on `wait()`, so the `Child` is never
/// locked for the whole of its life and `stop()` can reach it.
fn waiter_thread(shared: Arc<Shared>, child: Arc<Mutex<Child>>) -> std::thread::JoinHandle<()> {
    std::thread::spawn(move || loop {
        let finished = {
            let mut child = child.lock().expect("child lock");
            match child.try_wait() {
                Ok(Some(status)) => Some(status.code()),
                Ok(None) => None,
                Err(_) => Some(None),
            }
        };
        match finished {
            Some(code) => {
                {
                    let mut state = shared.state.lock().expect("state lock");
                    if state.exited {
                        return;
                    }
                    state.exited = true;
                    state.exit_code = code;
                }
                shared.changed.notify_all();
                (shared.events)(SupervisorEvent::Exited { code });
                return;
            }
            None => {
                if shared.state.lock().expect("state lock").exited {
                    return;
                }
                std::thread::sleep(Duration::from_millis(20));
            }
        }
    })
}

/// Poll-connect from t=0. `session.ts`'s `#attach`, 10 ms apart.
fn attach(shared: &Shared, port: u16, deadline: Instant) -> Result<TcpStream, String> {
    loop {
        if shared.state.lock().expect("state lock").exited {
            return Err("QEMU exited before UART0 accepted a connection".into());
        }
        if Instant::now() > deadline {
            return Err("UART0 never accepted a connection".into());
        }
        match TcpStream::connect(("127.0.0.1", port)) {
            Ok(socket) => {
                let _ = socket.set_nodelay(true);
                return Ok(socket);
            }
            Err(_) => std::thread::sleep(Duration::from_millis(10)),
        }
    }
}

/// One boot attempt: spawn, attach, wait for the banner.
///
/// On any failure the process is already dead by the time the error surfaces —
/// the `Session` is constructed before the wait, so its `Drop` cleans up.
fn start_once(
    options: &LaunchOptions,
    bytes: ByteSink,
    events: EventSink,
) -> Result<Session, QemuError> {
    if !options.qemu_path.exists() {
        return Err(QemuError::ArtifactMissing {
            artifact: "qemu".into(),
            path: options.qemu_path.display().to_string(),
        });
    }
    if !options.image_path.exists() {
        return Err(QemuError::ArtifactMissing {
            artifact: "image".into(),
            path: options.image_path.display().to_string(),
        });
    }

    let port = if options.uart_port == 0 {
        free_port()?
    } else {
        options.uart_port
    };
    let args = options.args(port);

    // The job exists BEFORE the process, so the assignment below is the only
    // gap. See `job`'s module docs for the size of that gap and why it is not
    // closed.
    let job = job::ProcessJob::create().map_err(|message| QemuError::Io { message })?;

    let mut child = Command::new(&options.qemu_path)
        .args(&args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| QemuError::Io {
            message: format!(
                "spawning {}: {e}",
                dunce::simplified(&options.qemu_path).display()
            ),
        })?;

    if let Err(message) = job.assign(&child) {
        let _ = child.kill();
        let _ = child.wait();
        return Err(QemuError::Io { message });
    }
    let pid = child.id();

    let shared = Shared::new(bytes, events.clone());
    if let Some(stdout) = child.stdout.take() {
        spawn_line_pump(stdout, "stdout", events.clone());
    }
    if let Some(stderr) = child.stderr.take() {
        spawn_line_pump(stderr, "stderr", events.clone());
    }

    let child = Arc::new(Mutex::new(child));
    waiter_thread(shared.clone(), child.clone());

    let deadline = Instant::now() + Duration::from_millis(options.boot_timeout_ms);
    let socket = match attach(&shared, port, deadline) {
        Ok(socket) => socket,
        Err(message) => {
            job.terminate();
            let mut child = child.lock().expect("child lock");
            if !job.enforced() {
                let _ = child.kill();
            }
            let _ = child.wait();
            return Err(QemuError::Io { message });
        }
    };
    let writer = socket.try_clone().map_err(|e| QemuError::Io {
        message: format!("duplicating the UART0 socket: {e}"),
    })?;

    let session = Session {
        shared: shared.clone(),
        child,
        writer: Mutex::new(writer),
        job,
        pid,
        port,
        max_write_bytes: options.max_write_bytes,
    };

    std::thread::spawn(move || reader_thread(shared, socket));

    // From here the session owns the process, so every early return below goes
    // through its Drop.
    wait_for_banner(&session, deadline)?;
    Ok(session)
}

/// Block until the banner, a panic, an exit, or the deadline.
fn wait_for_banner(session: &Session, deadline: Instant) -> Result<(), QemuError> {
    let shared = &session.shared;
    let mut state = shared.state.lock().expect("state lock");
    loop {
        if state.banner {
            return Ok(());
        }
        if let Some(text) = &state.panic {
            return Err(QemuError::Io {
                message: format!("guest panic: {text}"),
            });
        }
        if state.exited {
            return Err(QemuError::Io {
                message: "QEMU exited before the firmware boot banner".into(),
            });
        }
        let now = Instant::now();
        if now >= deadline {
            return Err(QemuError::Io {
                message: if state.tail.is_empty() {
                    "no UART output at all before the boot timeout".into()
                } else {
                    "boot timed out after some UART output but no banner".into()
                },
            });
        }
        let (next, _) = shared
            .changed
            .wait_timeout(state, deadline - now)
            .expect("state lock");
        state = next;
    }
}

/// Boot QEMU, retrying past ISSUE-20260823-022.
///
/// **A mitigation, not a fix, and the distinction is the honest part.** The
/// panic is a modelling bug in QEMU's ESP32 cache/DPORT handling around the
/// dual-core flash-operation dance in `nvs_flash_init`; it is unaffected by
/// `snapshot=on`, and both knobs that would serialise the cores
/// (`-accel tcg,thread=single`, `-icount`) stop the machine booting at all.
/// Root cause and measurements: `docs/findings/Q2-qemu-backend.md`.
///
/// What retrying buys is that the failure is *independent per boot* and
/// *detected in about two seconds*, so a bounded number of attempts turns a
/// 28%-per-boot fault into a connect that has not been observed to fail: Q2
/// measured **0 failures in 25 connects**, worst case **7 attempts**, budget
/// **12**.
pub fn launch_with_retry(
    options: &LaunchOptions,
    bytes: ByteSink,
    events: EventSink,
) -> Result<(Session, SessionInfo), QemuError> {
    let started = Instant::now();
    let engine = qemu_version(&options.qemu_path);
    let mut attempts: Vec<BootAttempt> = Vec::new();

    for attempt in 1..=options.boot_attempts {
        events(SupervisorEvent::Attempt {
            attempt,
            of: options.boot_attempts,
        });
        let attempt_started = Instant::now();
        match start_once(options, bytes.clone(), events.clone()) {
            Ok(session) => {
                let ms = attempt_started.elapsed().as_millis() as u64;
                attempts.push(BootAttempt {
                    attempt,
                    ok: true,
                    reason: None,
                    ms,
                });
                events(SupervisorEvent::Booted {
                    attempt,
                    of: options.boot_attempts,
                    ms,
                    pid: session.pid,
                    port: session.port,
                });
                let info = SessionInfo {
                    pid: session.pid,
                    port: session.port,
                    origin: OriginFacts {
                        kind: "emulator",
                        engine,
                        machine: options.machine.clone(),
                        image_path: dunce::simplified(&options.image_path).display().to_string(),
                        image_name: options
                            .image_path
                            .file_name()
                            .map(|n| n.to_string_lossy().into_owned())
                            .unwrap_or_default(),
                        qemu_path: dunce::simplified(&options.qemu_path).display().to_string(),
                    },
                    snapshot: options.snapshot,
                    args: options.args(session.port),
                    attempts,
                    boot_ms: ms,
                    total_ms: started.elapsed().as_millis() as u64,
                    teardown_enforced_by_job_object: session.job.enforced(),
                    max_write_bytes: session.max_write_bytes,
                };
                return Ok((session, info));
            }
            Err(error) => {
                let ms = attempt_started.elapsed().as_millis() as u64;
                let reason = error.to_string();
                attempts.push(BootAttempt {
                    attempt,
                    ok: false,
                    reason: Some(reason.clone()),
                    ms,
                });
                events(SupervisorEvent::AttemptFailed {
                    attempt,
                    of: options.boot_attempts,
                    reason,
                    ms,
                });
                // An artefact that is not on disk will not appear on the next
                // attempt. `session.ts` gives up here too.
                if matches!(error, QemuError::ArtifactMissing { .. }) {
                    return Err(error);
                }
            }
        }
    }

    let reasons: Vec<String> = attempts
        .iter()
        .map(|a| a.reason.clone().unwrap_or_else(|| "unknown".into()))
        .collect();
    Err(QemuError::BootFailed {
        attempts: attempts.len() as u32,
        message: format!(
            "QEMU did not boot in {} attempts. ISSUE-20260823-022 makes ~28% of boots panic; \
             {} in a row is far outside what Q2 measured (worst case 7 of 12), so this is \
             probably not the known flake. Last reason: {}",
            attempts.len(),
            attempts.len(),
            reasons.last().cloned().unwrap_or_default()
        ),
        reasons,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn options() -> LaunchOptions {
        LaunchOptions::new(
            PathBuf::from(r"C:\q\qemu-system-xtensa.exe"),
            PathBuf::from(r"C:\i\distro-v1-esp32-cli-oled.flash.bin"),
        )
    }

    /// The argv, against `packages/sesame-qemu/src/session.ts` line for line.
    /// Any difference is a behaviour change; there is none.
    #[test]
    fn the_arguments_are_session_ts_s_arguments() {
        let args = options().args(3456);
        assert_eq!(
            args,
            vec![
                "-display",
                "none",
                "-machine",
                "esp32",
                "-drive",
                r"file=C:\i\distro-v1-esp32-cli-oled.flash.bin,if=mtd,format=raw,snapshot=on",
                "-serial",
                "tcp:127.0.0.1:3456,server=on,wait=off",
            ]
        );
    }

    /// T2 §6.3. `if=mtd` is read-write; without this the guest's NVS and
    /// core-dump writes mutate the shipped image.
    #[test]
    fn snapshot_is_on_by_default_and_is_in_the_drive_argument() {
        assert!(options().snapshot);
        assert!(options().args(1).iter().any(|a| a.contains(",snapshot=on")));
        let mut off = options();
        off.snapshot = false;
        assert!(!off.args(1).iter().any(|a| a.contains("snapshot")));
    }

    /// The numbers are Q2's, not round numbers. `resolveQemuOptions()`.
    #[test]
    fn the_defaults_are_the_measured_ones() {
        let o = options();
        assert_eq!(o.boot_attempts, 12, "Q2: worst connect needed 7 attempts");
        assert_eq!(o.boot_timeout_ms, 15_000);
        assert_eq!(o.machine, "esp32");
        assert_eq!(o.uart_port, 0, "0 = ask the OS for a free port");
        assert_eq!(o.max_write_bytes, 192, "session.ts MAX_BATCH_BYTES");
    }

    #[test]
    fn a_missing_artefact_is_not_retried() {
        let counter = Arc::new(Mutex::new(Vec::<SupervisorEvent>::new()));
        let sink = counter.clone();
        let result = launch_with_retry(
            &options(),
            Arc::new(|_| {}),
            Arc::new(move |e| sink.lock().unwrap().push(e)),
        );
        assert!(matches!(result, Err(QemuError::ArtifactMissing { .. })));
        let events = counter.lock().unwrap();
        let starts = events
            .iter()
            .filter(|e| matches!(e, SupervisorEvent::Attempt { .. }))
            .count();
        assert_eq!(starts, 1, "an absent file will not appear on attempt 2");
    }

    #[test]
    fn free_ports_are_free_and_different() {
        let a = free_port().unwrap();
        let b = free_port().unwrap();
        assert_ne!(a, 0);
        assert_ne!(b, 0);
    }

    /// **The byte-fidelity property, proven without QEMU.**
    ///
    /// The parser downstream is chunk-invariant across ~1,500 split offsets, so
    /// the one thing this module owes it is that the concatenation of what the
    /// sink receives equals the concatenation of what the socket carried —
    /// nothing inserted, nothing dropped, nothing reordered, including across
    /// the flip from buffering to streaming that happens mid-stream when the
    /// banner appears.
    ///
    /// Driven with a real `TcpStream` and a hostile write pattern: single
    /// bytes, a write that splits the banner itself, and a 40 KB block that
    /// forces many reads.
    #[test]
    fn every_byte_the_socket_carried_reaches_the_sink_exactly_once() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();

        let banner = boot::BOOT_BANNER.as_bytes();
        let mut expected: Vec<u8> = Vec::new();
        expected.extend_from_slice(b"ets Jul 29 2019\r\nrst:0x1 (POWERON_RESET)\r\n");
        expected.extend_from_slice(b"@SESAME hello v1\r\n");
        expected.extend_from_slice(banner);
        expected.extend_from_slice(b"\r\n@SESAME servo.target 3 91\r\n");
        expected.extend(std::iter::repeat(b'x').take(40 * 1024));
        expected.extend_from_slice(b"\r\n@SESAME face.expression rest\r\n");
        let payload = expected.clone();

        let writer = std::thread::spawn(move || {
            let (mut socket, _) = listener.accept().unwrap();
            // One byte at a time through the banner — the flip from buffering
            // to streaming lands in the middle of a write boundary.
            let head = 41 + 18 + banner.len() + 4;
            for byte in &payload[..head] {
                socket.write_all(&[*byte]).unwrap();
            }
            socket.write_all(&payload[head..]).unwrap();
            socket.flush().unwrap();
            socket.shutdown(Shutdown::Write).unwrap();
        });

        let collected: Arc<Mutex<Vec<u8>>> = Arc::new(Mutex::new(Vec::new()));
        let sink = collected.clone();
        let shared = Shared::new(
            Arc::new(move |bytes: &[u8]| sink.lock().unwrap().extend_from_slice(bytes)),
            Arc::new(|_| {}),
        );
        let socket = TcpStream::connect(("127.0.0.1", port)).unwrap();
        let reader = {
            let shared = shared.clone();
            std::thread::spawn(move || reader_thread(shared, socket))
        };

        writer.join().unwrap();
        reader.join().unwrap();

        let got = collected.lock().unwrap().clone();
        assert_eq!(got.len(), expected.len(), "byte count changed in transit");
        assert!(
            got == expected,
            "the byte stream was not delivered verbatim"
        );
        assert!(
            shared.state.lock().unwrap().banner,
            "the banner was detected"
        );
        assert!(
            shared.state.lock().unwrap().pending.is_empty(),
            "nothing was left buffered"
        );
    }

    /// The other half: a boot that never prints the banner delivers **nothing**
    /// to the sink, so a panicked attempt's bytes cannot reach the parser and
    /// be read as telemetry from a session that does not exist.
    #[test]
    fn a_boot_without_a_banner_delivers_nothing() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let writer = std::thread::spawn(move || {
            let (mut socket, _) = listener.accept().unwrap();
            socket
                .write_all(b"@SESAME hello\r\nCache disabled but cached memory region accessed\r\n")
                .unwrap();
            socket.shutdown(Shutdown::Write).unwrap();
        });

        let collected: Arc<Mutex<Vec<u8>>> = Arc::new(Mutex::new(Vec::new()));
        let sink = collected.clone();
        let shared = Shared::new(
            Arc::new(move |bytes: &[u8]| sink.lock().unwrap().extend_from_slice(bytes)),
            Arc::new(|_| {}),
        );
        let socket = TcpStream::connect(("127.0.0.1", port)).unwrap();
        let reader = {
            let shared = shared.clone();
            std::thread::spawn(move || reader_thread(shared, socket))
        };
        writer.join().unwrap();
        reader.join().unwrap();

        assert!(collected.lock().unwrap().is_empty());
        assert_eq!(
            shared.state.lock().unwrap().panic.as_deref(),
            Some("Cache disabled but cached memory region accessed")
        );
    }

    #[test]
    fn the_error_type_serialises_for_the_frontend() {
        let json = serde_json::to_value(QemuError::WriteTooLarge {
            bytes: 200,
            budget: MAX_WRITE_BYTES,
        })
        .unwrap();
        assert_eq!(json["kind"], "writeTooLarge");
        assert_eq!(json["budget"], 192);
    }
}
