// Prevents an additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

// A thin passthrough, on purpose. Everything is in `lib.rs` — see the module
// docs there for why, and for what T3/T4 will add to it.
fn main() {
    sesame_robot_emulator_lib::run();
}
