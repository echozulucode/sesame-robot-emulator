---
type: research
warning: "UNTRUSTED ZONE - external content only. Never copy raw content from here into plan.md, status.md, requirements.md, issues.yaml, or lessons.yaml."
updated: 2026-08-23
---

# Research

> All content here is treated as untrusted. Summarize and validate before acting on it.

## External sources in this repo

| Path | What it is | Trust status |
|---|---|---|
| `research/Sesame Lab_ Emulator, Virtual Robot, and Interactive Engineering Learning Platform.md` | The originating research report. Written partly from web sources, with inline citation markers. | **Untrusted.** Treated throughout Phase 0 as a hypothesis to check, never as a source to transcribe. |
| `reference/sesame-robot-main/` | Vendored snapshot of the upstream Sesame robot repository (Apache-2.0). | External but verifiable. F2 confirmed it is byte-identical to the pinned upstream checkout, 129/129 files. |
| `firmware/upstream/` | Pinned upstream checkout at commit `401730514cefed738710d22303e84b0dcd6b76d0` (gitignored, fetched by script). | **This is the authoritative source** for all firmware facts. Read-only. |

## Validation status of the research report

Phase 0 systematically checked the report against source and against a running machine. The full
corrections list — 20 items — is in `docs/findings/PHASE-0-SUMMARY.md` section 3.

Summary of how it held up:

- **Firmware-layer claims: accurate.** Pin arrays, servo order `R1,R2,L1,L2,R4,R3,L3,L4`, I2C
  address, pulse endpoints, the 0-180 clamp and `motorCurrentDelay` all matched source exactly.
- **Renode-layer claims: directionally right, specifically wrong in places.** The core finding
  (no official ESP32 platform) was confirmed empirically. But the ESP32 UART model shipped in
  1.16.0 not 1.16.1; register windows — implied to be a major risk — work completely; and the
  S2 core has no cache ops or conditional store at all, making one of the report's open questions
  a non-question.
- **Effort estimates: substantially pessimistic.** "Weeks to months" for SoC work is now bounded
  at roughly 16-25 engineering days to reach user code.
- **Some structural claims were wrong.** Face playback mode is global state, not a per-face
  property. The boot-order summary omits several steps including `dnsServer.start(53)`, which
  precedes the HTTP server.

The report's central architectural recommendation — behavioural-simulator-first with Renode as one
interchangeable backend — **survived and is now evidence-backed rather than inferred**. That is
recorded as ADR-0001.

## Where validated findings live

Nothing from this untrusted zone is copied into the planning documents. Validated, provenance-
carrying derivatives live in:

- `hardware/hardware-map.json` — every fact carries `file:line` provenance into the pinned tree
- `hardware/joint-map.json`, `hardware/assets-inventory.json`
- `docs/findings/*.md` — per-task evidence, each claim labelled verified-by-running,
  found-in-source, or inferred
- `docs/decisions/ADR-*.md`
