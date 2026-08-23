#!/usr/bin/env bash
# Materialise the pinned upstream Sesame checkout into firmware/upstream/.
#
# Contract:
#   - Reads the pin from firmware/upstream.pin.json ({repoUrl, commit, resolvedAt}).
#   - Idempotent: every run produces a byte-identical tree, regardless of what
#     the previous run (or the ambient git config) left behind.
#   - Safe if firmware/upstream/ already exists.
#   - Never touches reference/sesame-robot-main/.
#   - firmware/upstream/ is a READ-ONLY source of truth. Instrumentation belongs
#     in firmware/patches/, applied at build time.
#
# Usage: scripts/fetch-upstream.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
PIN_FILE="$REPO_ROOT/firmware/upstream.pin.json"
DEST="$REPO_ROOT/firmware/upstream"

[[ -f "$PIN_FILE" ]] || { echo "ERROR: pin file not found: $PIN_FILE" >&2; exit 1; }

# Parse the pin with node (already a hard dependency of this repo).
read -r REPO_URL COMMIT < <(node -e '
  const p = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
  if (!p.repoUrl || !p.commit) { console.error("pin file missing repoUrl/commit"); process.exit(1); }
  if (!/^[0-9a-f]{40}$/.test(p.commit)) { console.error("pin commit is not a full 40-char SHA: " + p.commit); process.exit(1); }
  console.log(p.repoUrl + " " + p.commit);
' "$PIN_FILE")

# Byte-reproducibility. This machine has core.autocrlf=true system-wide, which
# rewrites LF->CRLF on checkout for text blobs stored with LF. That would make
# firmware/upstream/ differ byte-for-byte between a Windows and a Linux clone of
# the SAME commit, and would silently poison any SHA-256 recorded against it.
# Pin the working tree to the blobs exactly as committed.
GIT_CFG=(-c core.autocrlf=false -c core.eol=lf -c core.symlinks=false)
git_() { git "${GIT_CFG[@]}" -C "$DEST" "$@"; }

echo "upstream repo   : $REPO_URL"
echo "upstream commit : $COMMIT"
echo "destination     : $DEST"

if [[ -d "$DEST/.git" ]]; then
  echo "-- existing checkout found, reusing"
  git_ remote set-url origin "$REPO_URL"
elif [[ -e "$DEST" ]]; then
  echo "ERROR: $DEST exists but is not a git checkout." >&2
  echo "       Refusing to clobber it. Remove it manually and re-run." >&2
  exit 1
else
  echo "-- cloning"
  mkdir -p "$(dirname "$DEST")"
  git "${GIT_CFG[@]}" init --quiet "$DEST"
  git_ remote add origin "$REPO_URL"
fi

# Only hit the network if we do not already have the commit. This keeps
# re-runs fast and lets the script work offline once the pin is fetched.
if git_ cat-file -e "${COMMIT}^{commit}" 2>/dev/null; then
  echo "-- commit already present locally, skipping fetch"
else
  git_ fetch --depth 1 origin "$COMMIT"
fi
git_ checkout --detach --force "$COMMIT"

# Defeat git's stat cache. If a previous run checked out under a different
# core.autocrlf, git recorded that run's on-disk size/mtime in the index and
# will report the tree "clean" even though the bytes differ from the blobs --
# `git status`, `git diff` and even `update-index --really-refresh` all
# short-circuit on the matching stat. The only reliable fix is to delete the
# tracked files and re-materialise them under the pinned config.
echo "-- re-materialising tracked files from blobs (guarantees byte-identical tree)"
git_ ls-files -z | ( cd "$DEST" && xargs -0 rm -f )
git_ checkout --force -- .
git_ clean -xdff

ACTUAL="$(git_ rev-parse HEAD)"
[[ "$ACTUAL" == "$COMMIT" ]] || { echo "ERROR: checkout HEAD $ACTUAL != pinned $COMMIT" >&2; exit 1; }

# Verify no file was line-ending-converted on the way out.
CONVERTED="$(git_ ls-files --eol | awk '$1 ~ /^i\/(lf|crlf)$/ && $2 ~ /^w\/(lf|crlf)$/ && substr($1,3) != substr($2,3) { print $NF }')"
if [[ -n "$CONVERTED" ]]; then
  echo "ERROR: these files were line-ending-converted on checkout; the tree is not byte-exact:" >&2
  echo "$CONVERTED" >&2
  exit 1
fi

echo "OK: firmware/upstream/ is at $ACTUAL (byte-exact, no EOL conversion)"
echo "    read-only source of truth - never edit; instrumentation lives in firmware/patches/"
