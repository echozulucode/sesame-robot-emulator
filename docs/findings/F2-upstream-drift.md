# F2 — Upstream drift: pinned checkout vs. vendored reference copy

**Task:** F2 · **Agent:** `repo-foundation` · **Date:** 2026-08-23
**Plan:** `docs/plans/phase-0-foundations-and-renode-research.md` §4 (F2)

---

## Result

**No drift. All 129 files are byte-for-byte identical.**

The research report was written against `reference/sesame-robot-main/`. That copy
is an exact snapshot of the commit we have now pinned, so the report's firmware
claims can be trusted as a description of the pinned source. F4 still extracts
from source rather than from the report — this finding only removes the risk that
the two disagree about *which* source.

## What was pinned

| | |
|---|---|
| Upstream repository | `https://github.com/dorianborian/sesame-robot.git` |
| Pinned commit | `401730514cefed738710d22303e84b0dcd6b76d0` |
| Ref it came from | `refs/heads/main` (default-branch HEAD at resolve time) |
| Commit subject | `Merge pull request #69 from m0rg0t/feature/wifi-web-setup` |
| Commit author / date | Dorian · `2026-08-14T14:43:00-07:00` |
| Root tree object | `f4fac4d27a29db476164165a512e764f77b74b02` |
| Resolved at | 2026-08-23 (via `git ls-remote`) |
| Recorded in | `firmware/upstream.pin.json`, `reproducibility.json` |

### How the remote was identified

The URL was **derived, not guessed**. Evidence in the vendored copy:

- `reference/sesame-robot-main/README.md:7-8` — shields.io badges
  `img.shields.io/github/stars/dorianborian/sesame-robot` and
  `.../github/forks/dorianborian/sesame-robot`.
- `reference/sesame-robot-main/README.md:110` and `software/README.md:26` — links
  to the sibling repository `https://github.com/dorianborian/sesame-companion-app`.

`git ls-remote https://github.com/dorianborian/sesame-robot.git` resolved
successfully, and the resulting tree matched the vendored copy exactly — which is
itself the strongest available confirmation that this is the correct upstream.

The commit date (`2026-08-14`) also matches the file mtimes on the vendored copy
(`Aug 14 16:43` local), consistent with it being a source archive of this commit.

## Method

1. `scripts/fetch-upstream.sh` shallow-fetched the pinned commit into
   `firmware/upstream/` (gitignored).
2. Every regular file in both trees was hashed with SHA-256 (`.git/` excluded),
   then compared by relative path.
3. The comparison was run twice, with a re-run of the fetch script in between, to
   confirm idempotency.

## Comparison

| Metric | Count |
|---|---:|
| Files in pinned `firmware/upstream/` | 129 |
| Files in `reference/sesame-robot-main/` | 129 |
| **Byte-identical** | **129** |
| Only in pinned checkout | 0 |
| Only in reference copy | 0 |
| Content differs | 0 |

Per-directory: `docs/` 65, `hardware/` 46, `software/` 9, `firmware/` 6, root 3.

### `firmware/*` content diff summary

All six firmware files are byte-identical between the two trees. Their SHA-256
digests at the pinned commit:

| File | SHA-256 | Bytes |
|---|---|---:|
| `firmware/sesame-firmware-main.ino` | `24a00b44091c686e1a6803028ce3108c95bcf8cc738061ebdb249fe4add96982` | 39 969 |
| `firmware/movement-sequences.h` | `f77d713703e361dff2458f4fd02356ed397b8f47d83bd7a87587e8f6e899d2f1` | 13 903 |
| `firmware/face-bitmaps.h` | `722692894402d9eccf5c022ed7b4eb090c2de6b171b7872cedce55609dac1f06` | 297 211 |
| `firmware/captive-portal.h` | `f28273df29c4f38cce3005604f883ad161f920ae25168b1a62aa986886a5e8a4` | 33 710 |
| `firmware/debugging-firmware/sesame-motor-tester.ino` | `04f7043de7ba6b24d8346b635720f1d557e3134a8ff8d674e18377c90b974f18` | 4 227 |
| `firmware/README.md` | `d7232999c065f38adfeda932fadd0bf277d0f191c768463adb318b7e1b997fd6` | 37 336 |

There is no content diff to summarise: the diff is empty.

Downstream consequence for F3/F4: the pins in `firmware/README.md` — notably
**ESP32Servo v3.0.9**, called out at `firmware/README.md:47` and `:175` because
newer releases have a known multi-servo command leak
([madhephaestus/ESP32Servo#103](https://github.com/madhephaestus/ESP32Servo/issues/103))
— are present at the pinned commit and are the versions F3 must install.

---

## Incidental finding — `core.autocrlf=true` silently breaks byte-reproducibility

This did not change the drift verdict, but it produced a **false positive** on the
first comparison run and is worth recording, because the same trap will bite F3's
determinism check and anything else that hashes a checked-out file.

**What happened.** This machine has `core.autocrlf=true` in system git config. On
the first checkout, git rewrote LF→CRLF in the working tree for the six blobs
stored with LF endings, so those six files differed from the vendored copy by
exactly one byte per line:

| File | Blob EOL | Worktree EOL after naive checkout |
|---|---|---|
| `LICENSE` | LF | CRLF |
| `docs/README.md` | LF | CRLF |
| `docs/images/README.md` | LF | CRLF |
| `hardware/cad/README.md` | LF | CRLF |
| `hardware/pcb/distro-v2/SCH_Sesame-Distro-Board-V2_2026-03-06.json` | LF | CRLF |
| `software/README.md` | LF | CRLF |

The upstream repository has **mixed committed line endings**: 20 text files are
stored with CRLF (including all of `firmware/*`), 6 with LF, and 103 are binary.
Only the LF-stored six were affected. **No firmware source file was touched** —
they are all `i/crlf w/crlf` — so the build inputs were never at risk. But the
same checkout on Linux, or on a Windows host with `core.autocrlf=false`, would
produce a different tree for the same commit.

**Second trap: git's stat cache hides it.** After changing the config and
re-running, `git status`, `git diff`, and even
`git update-index --really-refresh` all reported the tree **clean** while three
files still had the wrong bytes on disk. Git had recorded the CRLF file's size and
mtime in the index during the first checkout; both still matched, so git
short-circuited and never compared content. A verification that trusts
`git status` here reports success on a tree that is objectively wrong.

**Fix applied**, in both `scripts/fetch-upstream.ps1` and `scripts/fetch-upstream.sh`:

1. All git invocations run under `-c core.autocrlf=false -c core.eol=lf
   -c core.symlinks=false`, so the working tree is the blobs exactly as committed.
2. After checkout, tracked files are **deleted and re-materialised** from the
   object store. This is the only reliable way past the stat cache.
3. A post-checkout assertion fails the script if `git ls-files --eol` shows any
   file whose worktree EOL differs from its index EOL.

**Carry-forward for other workstreams:** any process that hashes a file out of
`firmware/upstream/` must go through these scripts, and no verification step
should treat a clean `git status` as proof that a working tree matches its blobs.

## Idempotency verification

The plan requires re-running to produce a byte-identical tree.

- Run 1 → full SHA-256 manifest of `firmware/upstream/` captured.
- Fetch script re-run.
- Run 2 → manifest captured again.
- **Manifests identical.** Re-run wall time 3.3 s (the local-object guard skips
  the network when the pinned commit is already present, so the script also works
  offline once fetched).

The scripts are also safe against a pre-existing directory: a non-git directory at
`firmware/upstream/` causes a refusal rather than a clobber.

## Risks

None outstanding from F2. The fallback path in the plan (promote the vendored copy
with an unknown SHA) was **not** needed — a real remote was resolved, a real
commit was pinned, and the tree was verified.

One standing note: the pin is the default branch's HEAD *as of 2026-08-23*, not a
tagged release. Upstream is actively developed, so `firmware/upstream/` will drift
from upstream `main` over time. That is intended — the whole point is that lessons
cite a fixed commit. Re-pinning is a deliberate act: edit
`firmware/upstream.pin.json`, re-run the fetch script, re-run this comparison.
