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
//! No `invoke_handler`, no commands, no state. T1's whole job is to prove the
//! existing web app renders in a WebView2 window with its honesty surfaces
//! intact — the provenance badge, `PHYSICAL HARDWARE: NONE`,
//! `isPhysicallyObserved()` permanently false. Packaging is exactly where those
//! get quietly lost, so they are worth isolating from the much harder question
//! of whether the emulator works.
//!
//! T3 adds `spawn_emulator` / `stop_emulator` / `send_command` and a
//! `Channel<Vec<u8>>` carrying UART0 bytes; T4 adds the `TauriSesameRobot` that
//! consumes them. Until then the frontend selects the **behavioural simulator**
//! and says so — see `apps/web/src/backends/default-backend.ts`.

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
