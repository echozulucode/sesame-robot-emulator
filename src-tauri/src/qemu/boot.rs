//! Boot detection on the raw UART byte stream — a port of the *scanner* in
//! `packages/sesame-qemu/src/session.ts`, and of nothing else.
//!
//! ## This is not the parser, and the distinction is the whole architecture
//!
//! `docs/plans/phase-5-tauri-desktop-app.md` §4 option C is explicit: the
//! `@SESAME` telemetry parser stays in TypeScript, where its invariant —
//! *output depends only on the concatenated byte stream, never on chunking* —
//! is proven across ~1,500 split offsets and 255 tests. Rust ships raw bytes.
//!
//! What Rust does need is the thing `session.ts` also does *outside* the
//! parser, and for the reason it states:
//!
//! > Scan the raw byte stream for the banner and for panics, independently of
//! > the telemetry parser. These are plain `Serial.println` output, and a panic
//! > dump in particular is not line-shaped in any way the protocol cares about.
//!
//! Without it there is no retry loop, because there is no way to tell a boot
//! that worked from a boot that panicked — and ISSUE-20260823-022 makes that
//! ~28% of boots.
//!
//! ## Byte-for-byte with the TypeScript
//!
//! `session.ts` decodes each chunk as `latin1` and keeps
//! `(tail + text).slice(-4096)`. latin1 is a 1:1 byte↔char mapping, so the last
//! 4096 *characters* are the last 4096 *bytes*, and the scan below over a
//! `Vec<u8>` tail is the same scan on the same window. The four panic patterns
//! are checked in the same order and — as in `firstPanic` — the first *pattern*
//! that matches anywhere wins, not the match at the earliest offset.
//!
//! No regex engine is pulled in for this. Three of the four patterns are string
//! literals and the fourth is a literal with one hex run in the middle; see
//! [`software_reset_at`].

/// The line the firmware prints at the very end of `setup()` —
/// `sesame-firmware-main.ino:749`, `bootOrder` step 20.
///
/// Chosen over `@SESAME hello` for the reason `session.ts` gives: hello is
/// emitted three statements into `setup()`, deliberately, so a boot that dies
/// on the OLED still identifies itself — and the interesting failures happen
/// *after* it. Six of the eight baseline failures printed hello and then
/// panicked.
pub const BOOT_BANNER: &str = "HTTP server & Captive Portal started.";

/// How much raw UART text is kept, so a banner or a panic split across two TCP
/// reads is still matched. `session.ts`'s `.slice(-4096)`.
pub const TAIL_BYTES: usize = 4096;

/// The three literal entries of `session.ts`'s `PANIC_PATTERNS`, in its order.
///
/// The first is ISSUE-20260823-022. The others are the ESP-IDF panic handler's
/// general vocabulary; catching them means a boot that fails some other way
/// fails fast instead of burning the whole boot timeout.
pub const LITERAL_PANIC_PATTERNS: [&str; 3] = [
    "Cache disabled but cached memory region accessed",
    "Guru Meditation Error",
    "assert failed:",
];

/// `haystack.windows(needle.len()).position(..)`, with the degenerate cases
/// answered the way `String.prototype.includes` answers them.
pub fn find(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    if needle.is_empty() {
        return Some(0);
    }
    if haystack.len() < needle.len() {
        return None;
    }
    haystack.windows(needle.len()).position(|w| w == needle)
}

/// True when [`BOOT_BANNER`] is anywhere in `tail`.
pub fn has_banner(tail: &[u8]) -> bool {
    find(tail, BOOT_BANNER.as_bytes()).is_some()
}

/// `/rst:0x[0-9a-f]+ \(SW_CPU_RESET\)/`, by hand.
///
/// Returns the matched text, so the caller reports the same string
/// `firstPanic()` returns from `match[0]`. Lower-case hex only — the
/// TypeScript regex has no `i` flag and the ROM prints lower case. The
/// distinction from `rst:0x1 (POWERON_RESET)`, which every healthy cold boot
/// prints, is the whole reason this is a pattern and not a substring.
pub fn software_reset_at(tail: &[u8]) -> Option<String> {
    const PREFIX: &[u8] = b"rst:0x";
    const SUFFIX: &[u8] = b" (SW_CPU_RESET)";
    let mut from = 0usize;
    while let Some(offset) = find(&tail[from..], PREFIX) {
        let start = from + offset;
        let digits_at = start + PREFIX.len();
        let mut cursor = digits_at;
        while cursor < tail.len()
            && tail[cursor].is_ascii_hexdigit()
            && !tail[cursor].is_ascii_uppercase()
        {
            cursor += 1;
        }
        if cursor > digits_at && tail[cursor..].starts_with(SUFFIX) {
            let end = cursor + SUFFIX.len();
            return Some(String::from_utf8_lossy(&tail[start..end]).into_owned());
        }
        from = start + 1;
    }
    None
}

/// The first panic pattern that matches, in `PANIC_PATTERNS` order.
///
/// Order, not position: `firstPanic()` returns on the first *pattern* that
/// matches anywhere in the tail, so a "Guru Meditation Error" printed before a
/// later "assert failed:" still reports as Guru Meditation. Reproduced
/// deliberately — a different answer here would make the two backends disagree
/// about why the same boot died.
pub fn first_panic(tail: &[u8]) -> Option<String> {
    for pattern in LITERAL_PANIC_PATTERNS {
        if find(tail, pattern.as_bytes()).is_some() {
            return Some(pattern.to_string());
        }
    }
    software_reset_at(tail)
}

/// Keep only the last [`TAIL_BYTES`] bytes. `session.ts`'s `.slice(-4096)`.
pub fn trim_tail(tail: &mut Vec<u8>) {
    if tail.len() > TAIL_BYTES {
        let excess = tail.len() - TAIL_BYTES;
        tail.drain(..excess);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_banner_is_found_wherever_the_reads_happened_to_split() {
        // The property that matters, and the one the parser downstream is
        // tested for at ~1,500 offsets: the scanner sees the CONCATENATION, so
        // where TCP split the stream is irrelevant.
        let full = format!("boot noise\r\n{BOOT_BANNER}\r\nmore output");
        for split in 0..=full.len() {
            let mut tail: Vec<u8> = Vec::new();
            tail.extend_from_slice(&full.as_bytes()[..split]);
            trim_tail(&mut tail);
            tail.extend_from_slice(&full.as_bytes()[split..]);
            trim_tail(&mut tail);
            assert!(has_banner(&tail), "a split at {split} lost the banner");
        }
    }

    #[test]
    fn the_tail_is_bounded_but_still_matches() {
        let mut tail = vec![b'.'; TAIL_BYTES * 3];
        trim_tail(&mut tail);
        assert_eq!(tail.len(), TAIL_BYTES);
        tail.extend_from_slice(BOOT_BANNER.as_bytes());
        trim_tail(&mut tail);
        assert_eq!(tail.len(), TAIL_BYTES);
        assert!(has_banner(&tail));
    }

    #[test]
    fn issue_20260823_022_wins_on_pattern_order_not_position() {
        let text = b"Guru Meditation Error: Cache disabled but cached memory region accessed";
        assert_eq!(
            first_panic(text).as_deref(),
            Some("Cache disabled but cached memory region accessed"),
            "session.ts firstPanic() iterates PANIC_PATTERNS, not offsets"
        );
    }

    #[test]
    fn the_software_reset_pattern_matches_what_the_rom_prints() {
        let line = b"ets Jul 29 2019 12:21:46\r\n\r\nrst:0xc (SW_CPU_RESET),boot:0x13";
        assert_eq!(
            software_reset_at(line).as_deref(),
            Some("rst:0xc (SW_CPU_RESET)")
        );
        assert_eq!(first_panic(line).as_deref(), Some("rst:0xc (SW_CPU_RESET)"));
    }

    #[test]
    fn a_power_on_reset_is_not_a_panic() {
        // Every healthy cold boot prints this. Matching it would fail 100% of
        // boots instead of 28%.
        let line = b"rst:0x1 (POWERON_RESET),boot:0x13 (SPI_FAST_FLASH_BOOT)";
        assert_eq!(first_panic(line), None);
    }

    #[test]
    fn a_truncated_software_reset_is_not_a_panic_yet() {
        // The pattern arriving one byte at a time must not match early.
        let full = b"rst:0xc (SW_CPU_RESET)";
        for take in 0..full.len() {
            assert_eq!(
                first_panic(&full[..take]),
                None,
                "matched after {take} bytes"
            );
        }
        assert!(first_panic(full).is_some());
    }

    #[test]
    fn a_clean_boot_log_has_no_panic_and_no_banner() {
        let line = b"\x1b[0;32mI (0) cpu_start: Pro cpu up.\x1b[0m\r\n@SESAME hello\r\n";
        assert_eq!(first_panic(line), None);
        assert!(!has_banner(line));
    }
}
