# ADR-0002 — Renode 1.16.1+ installed as a portable in-repo sidecar

- **Status:** Accepted
- **Date:** 2026-08-23
- **Deciders:** Sesame Lab Phase-0 team
- **Source:** `docs/plans/phase-0-foundations-and-renode-research.md` §2 (ground truth probed on this machine, 2026-08-23)

---

## Context

Phase-0 workstream R needs a Renode instance to probe Xtensa execution, the
ESP32 UART model, and Arduino-ESP32 startup.

Ground truth probed on this machine on 2026-08-23:

| Fact | Value |
|---|---|
| Existing Renode install | **v1.15.3** at `C:\Program Files\Renode` (machine-wide, user-installed) |
| Xtensa assets present in that install | `platforms/cpus/xtensa-sample-controller.repl` — the only Xtensa file |
| ESP32 assets present in that install | **zero** ESP32 `.repl` / board files |
| `builds.renode.io` reachable | yes (HTTP 200) |

The research report states that **Renode 1.16.1 added an ESP32 UART model**. The
installed version predates that.

This creates a sharp risk. Workstream R's probes (R1–R4) are explicitly designed
to produce trustworthy negative results — "Renode cannot do X, here is the exact
register that faulted" is a deliverable that feeds Gate A and a costed Phase-1
estimate. A probe run against 1.15.3 would report "no ESP32 UART model" and
"unsupported peripheral", and that report would be **wrong about the tool rather
than right about the problem**. A false negative here does not merely waste the
spike; it would propagate into the gate decision.

Three options were considered:

1. **Probe on the existing 1.15.3 install.** Cheapest, but yields a false
   negative on the one capability the report specifically flags as new. Rejected.
2. **Upgrade `C:\Program Files\Renode` in place to 1.16.x.** Correct version, but
   mutates a machine-wide install that this project does not own, that the user
   may depend on for unrelated work, and that is awkward to revert. It also
   destroys the ability to A/B a finding against the version the user actually
   had. Rejected.
3. **Install 1.16.1+ portable, side-by-side, inside the repo.** Chosen.

## Decision

**Install Renode 1.16.1 or newer as a portable Windows build under `tools/renode/`,
side by side with the existing system install. Do not modify, upgrade, uninstall,
or otherwise touch `C:\Program Files\Renode`.**

Specifics:

- The portable distribution is fetched from `builds.renode.io` / the GitHub
  release assets and unpacked into `tools/renode/`.
- `tools/` is **gitignored**. The binary distribution is never committed; the
  *version* is committed, in `reproducibility.json` → `renodeVersion`.
- All Phase-0 Renode scripts invoke the sidecar by explicit path. No script may
  resolve Renode from `PATH`, because `PATH` may reach the 1.15.3 system install
  and silently invalidate a probe result.
- Any finding that reports a Renode capability or limitation **must state the
  exact version it was observed on**, so a future reader can tell a genuine
  limitation from a version artifact.
- This follows the project-wide rule: no machine-wide installs; every toolchain
  is portable and lives under `tools/` (the same rule governs the portable
  `arduino-cli` in F3).

## Consequences

### Positive

- Workstream R probes run against the version that actually contains the ESP32
  UART model, so a negative result is a real finding about ESP32 emulation rather
  than an artifact of an outdated tool.
- The user's environment is unchanged. Nothing this project does needs to be
  undone later.
- The Renode version is pinned and recorded per artifact, making a probe result
  reproducible and re-checkable against a future Renode release.
- Both versions remain available, so a capability difference between 1.15.3 and
  1.16.x can be demonstrated directly rather than argued from release notes.

### Negative / costs

- Disk cost: a second full Renode distribution (hundreds of MB) inside the repo
  working tree.
- Every invocation must use an explicit path. A script that forgets and falls
  through to `PATH` will produce a plausible-looking but invalid result — this is
  a real footgun and is called out in the workstream rules.
- A clean clone does not have Renode; it must be fetched. This is accepted, and
  is the same trade already made for `arduino-cli` and the upstream firmware
  checkout.

### Neutral

- If a future Renode release makes ESP32 support official and packaged, the
  sidecar is simply re-pointed at the newer version; nothing about the decision
  needs revisiting beyond bumping `renodeVersion`.

## Related

- ADR-0001 — behavioral-simulator-first (why Renode is a research track, not the foundation)
- `docs/plans/phase-0-foundations-and-renode-research.md` §5 (workstream R)
- `docs/findings/R1-renode-capability-audit.md` (to be produced by R1)
