# PUBLIC-RELEASE-CHECKLIST

Ordered. Full reasoning in `docs/findings/LICENSE-AUDIT.md` (section refs below).
**[YOU]** marks something needing your decision, not just your keystrokes.

Not legal advice — an engineering checklist built from what the licences say.

---

## Stage 1 — before the repo goes public (do all of these)

- [ ] **1.1 Remove the leaked installation secret.** §5a
      `Projectssesame-robot-emulatortoolsarduino-datadata/inventory.yaml` is
      tracked, is **not** gitignored, and contains an arduino-cli
      `installation.secret`. The directory name is also a mangled copy of your
      local repo path.
      ```
      git rm -r --cached "Projectssesame-robot-emulatortoolsarduino-datadata"
      rm -rf "Projectssesame-robot-emulatortoolsarduino-datadata"
      ```
      Then add to `.gitignore`:
      ```
      # Guard: a script once wrote the tools path with the separators eaten.
      Projectssesame-robot-emulator*/
      **/inventory.yaml
      ```
      **[YOU]** It is already in git history. Rotating costs nothing: delete
      `tools/arduino-data/data/inventory.yaml` and let arduino-cli regenerate a
      new id/secret on next run. Recommended.

- [ ] **1.2 Redact the five Renode logs.** §5a
      `emulator/renode/tests/logs/r4-{asm,regs,resetstate,setreg,cpu-help}.log`,
      lines 4–5, contain `<local-path>`.
      The only tracked occurrences of `<user>` in the repo. Replace the path with
      `<scratch>/asm.resc` (etc.) and add a one-line inline note that the path
      was redacted, so the evidence stays honest.
      Verify with: `git grep -l <user>` → must return nothing.

- [ ] **1.3 Commit `LICENSE`.** §2a — drafted at the repo root; canonical
      Apache-2.0 text, byte-identical to upstream's
      (sha256 `c71d239d…`). Nothing to edit.

- [ ] **1.4 Review and commit `NOTICE`.** §2b–2e — drafted at the repo root.
      **[YOU]** Confirm two things: the copyright line
      (`Copyright 2026 Eric Zimmerman`) is how you want to be credited, and the
      trademark / non-endorsement paragraph reads acceptably to you.

- [ ] **1.5 Review and commit `THIRD-PARTY-NOTICES.md`.** §4 — drafted at the
      repo root. It is the reference the installer work in Stage 2 draws on.

- [ ] **1.6 Write a root `README.md`.** §5e — there is none. It is where a
      stranger learns what this is, that it derives from
      https://github.com/dorianborian/sesame-robot, that it is Apache-2.0, and
      that the desktop app bundles GPL-2.0 QEMU. Link `NOTICE` and
      `THIRD-PARTY-NOTICES.md`.

- [ ] **1.7 Force-add the audit docs** (`docs/findings/` is gitignored-but-tracked):
      ```
      git add -f docs/findings/LICENSE-AUDIT.md docs/findings/PUBLIC-RELEASE-CHECKLIST.md
      ```

- [ ] **1.8 [YOU] Decide on the name.** §2e — "Sesame Lab", `@sesame-lab/*`,
      `com.sesamelab.desktop`. Apache-2.0 §6 grants no trademark rights;
      `NOTICE` relies on the "describing the origin of the Work" allowance.
      Recommended: a courtesy note to the upstream author before you flip the
      switch. Renaming is cheap today and expensive once the app is installed.

- [ ] **1.9 [YOU] Decide on "the user's nephew".** §5c —
      `docs/plans/phase-5-tauri-desktop-app.md:5,63,151,182,189` and
      `docs/findings/T2-tauri-resources.md:346`. Harmless; nothing identifies
      the child. Keep, or generalise to "a young learner".

---

## Stage 2 — before the installer reaches anyone (including your nephew)

Independent of Stage 1. Publishing the repo triggers none of this; handing
someone a `.exe` triggers all of it. **Decision taken: bundle QEMU rather than
fetch at first run** — §3f, on install-reliability grounds.

- [ ] **2.1 Create `licenses/` at the repo root** containing:
      - `QEMU-GPL-2.0.txt` — verbatim GPL-2.0 text
      - `QEMU-LICENSE.txt` — QEMU's own `LICENSE` from tag `esp-develop-9.2.2-20260417`
      - `QEMU-SOURCE-OFFER.txt` — the §3(b) written offer (draft in
        `THIRD-PARTY-NOTICES.md` §C1)
      - `LGPL-2.1.txt` — for arduino-esp32 core and ESP32Servo in the flash image
      - `LICENSE`, `NOTICE`, `THIRD-PARTY-NOTICES.md` — copies of the root files
      - `js-attribution.txt` — generated MIT/ISC/BSD notices for the web bundle
      - `rust-attribution.txt` — from `cargo about generate` (2.6)

- [ ] **2.2 [YOU] Supply the written offer's two blanks.** §3d.3
      A contact address you will still read **three years** from each recipient's
      receipt, and the permanent URL of the source archive. The three-year duty
      runs to *any third party who asks*, not only to your users.

- [ ] **2.3 [T4] Ship `licenses/` in the installer.** §3d.5
      Add `"../licenses": "licenses"` to `bundle.resources` in
      `src-tauri/tauri.conf.json`. *(T4 owns `src-tauri/` — hand this over.)*

- [ ] **2.4 [T4] Make the licences reachable from the UI.** §3d.6
      An "Open-source licences" affordance;
      `apps/web/src/desktop/DesktopResources.tsx` already enumerates bundled
      resources and is the natural home. A licence the user cannot find is not
      accompanying the binary.

- [ ] **2.5 [T4] Make it an invariant, not an intention.** §3d.7
      Extend `src-tauri/src/resources.rs` and
      `apps/web/src/__tests__/desktop-resources.test.ts` so a missing licence
      file fails the build exactly as a missing ROM does. This project already
      enforces everything else this way.

- [ ] **2.6 Generate the two attribution files.**
      - JS: a licence-aggregator over the pnpm tree → `licenses/js-attribution.txt`.
        (153 packages, all permissive, but MIT requires the notice to travel.)
      - Rust: `cargo about generate` **against the Windows target** →
        `licenses/rust-attribution.txt`. §4 — this is the one category the audit
        did not enumerate package-by-package; 431 lockfile entries, direct deps
        all MIT/Apache-2.0, but confirm rather than assume.

- [ ] **2.7 Publish the QEMU source alongside the installer.** §3e
      Attach `qemu-source-esp-develop-9.2.2-20260417.tar.gz` to the **same
      GitHub release** as the installer — same page, same act of distribution.
      Keep your own copy too; the written offer outlives GitHub's URL scheme.

- [ ] **2.8 [YOU] Decide on the flash image.** §3g
      `emulator/qemu/images/distro-v1-esp32-cli-oled.flash.bin` statically links
      **LGPL-2.1-or-later** code (arduino-esp32 Arduino layer, ESP32Servo 3.0.9).
      LGPL §6 wants a relink path. You already have a complete one —
      `firmware/upstream.pin.json` + `firmware/build/sketch.yaml` +
      `firmware/patches/*` + `scripts/build-firmware.*` reproduce the image
      exactly. `THIRD-PARTY-NOTICES.md` §C3 states that explicitly.
      Recommended: bundle and document. Escape hatch if you disagree: build the
      image at first run instead.

- [ ] **2.9 [YOU] Accept the ESP boot-ROM uncertainty.** §3g
      `share/qemu/{esp32-v3-rom,esp32-v3-rom-app,esp32c3-rom,esp32s3_rev0_rom}.bin`
      are Espressif mask-ROM dumps with **no stated redistribution terms** —
      QEMU's licence explicitly carves firmware blobs out of the GPL. I could not
      resolve this. Mitigating: unmodified, from Espressif's own release, for
      their only intended use. Ask Espressif if you want certainty; I would not
      hold the release for it.

- [ ] **2.10 [YOU] Optional: build QEMU yourself.** §3c
      The only way to be certain your binary's corresponding source is exactly
      the tag. Not recommended at this project's size; the SHA-256 check in
      `emulator/qemu/fetch-qemu.mjs` already proves which release you have.

---

## Stage 3 — optional polish

- [ ] **3.1 [YOU] Per-file attribution in the generated modules.** §2c
      The `GENERATED FILE` headers document *provenance* but not *licence*. With
      the root `NOTICE` in place the obligation is met; a one-line
      "Derived from the Sesame Robot Project … Apache-2.0. See NOTICE." makes it
      unambiguous. Affects `apps/web/src/generated/*.ts` **[T4]**,
      `packages/sesame-sim/src/generated/choreography.ts`, and a
      `meta.attribution` field in the three `hardware/*.json`.
      **These are generated** — edit the generators and regenerate, or the
      `--check` modes fail. Lighter alternative: one `README.md` per `generated/`
      directory.

- [ ] **3.2 Leave the machine paths alone.** §5b — `C:\Projects\...` and
      `C:\Program Files\Renode` appear across `reproducibility.json` and the
      emulator logs. No username, no hostname; cosmetic only. These are evidence
      artifacts whose value is that they are unedited. Recommended: no change.

- [ ] **3.3 Add `CONTRIBUTING.md` / `CODE_OF_CONDUCT.md`** if you expect anyone
      else to touch this.

---

## Verification before flipping public

```
test -f LICENSE && test -f NOTICE && test -f THIRD-PARTY-NOTICES.md
git grep -l <user>                 # must be empty
git ls-files | grep -i inventory  # must be empty
git ls-files | grep -i '^Projectssesame'  # must be empty
```

---

## Reference — what was checked and found clean

No emails in tracked files. No hostnames, MAC addresses, API keys or tokens. No
SSIDs or Wi-Fi passwords (upstream's `.ino` is gitignored, so they were never
here). Private-IP hits are all legitimate subject matter. `pnpm-lock.yaml` and
`src-tauri/Cargo.lock` carry no private registries or local path deps. All 49
screenshots are headless-browser viewport captures with no browser chrome, no OS
chrome, no local paths and no username. `reference/`, `firmware/upstream/`,
`firmware/artifacts/` and `tools/` are gitignored with zero tracked files — no
upstream source, no CAD, no compiled firmware, no QEMU, no Renode is in git.

---

## History rewrite — decided 2026-09-02, run AFTER T7

The user chose option **B**: one targeted `git filter-repo` pass, then publish.
**Keep the current screenshots; drop the 494 historical revisions.**

### Remove from all commits
| Path | Why |
|---|---|
| `Projectssesame-robot-emulatortoolsarduino-datadata/` | arduino-cli `installation.secret`; the directory name is a local path with its separators eaten by an early script bug |
| home-directory paths + session UUID in `emulator/renode/tests/logs/r4-*.log` | Renode echoes the full path of every script it includes |
| `docs/findings/assets/**` | 494 blob revisions; the harness rewrites 20–49 PNGs per run and every run was committed |

### Keep
Every commit, message, author and date. The narrative is the point — six hollow
assertions found, four wrong numbers corrected, decisions reversed with the
arithmetic that reversed them.

### The screenshots specifically
`docs/findings/assets/` is stripped from **history**, then the **current** files
are re-added as a fresh commit. They are ~11 MB and several are the evidence
behind claims in the findings, so the files stay while the churn does not.

### Order of operations
1. Finish T5–T7. **Do not rewrite under a running agent.**
2. `pip install git-filter-repo` (pin the version; record it).
3. Back up: `git bundle create ../sesame-pre-rewrite.bundle --all`.
4. `git filter-repo --invert-paths` for the three path sets above.
5. Re-add the current `docs/findings/assets/` as one commit.
6. Apply the `docs/findings` tracking decision in the same pass — the rule at
   `.gitignore:11` currently matches nothing that is already tracked.
7. Fix any findings that reference an asset path the rewrite moved.
8. Verify: no tracked file contains the username or the secret; measure `.git`
   before and after; confirm the working tree still builds and tests green.
9. Force-push to `echozulucode/sesame-robot-emulator`.

**Expected:** ~110 MB → ~15–20 MB. Every SHA changes; safe because this is the
only clone.
