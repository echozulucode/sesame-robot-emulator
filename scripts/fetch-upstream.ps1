#Requires -Version 7.0
<#
.SYNOPSIS
  Materialise the pinned upstream Sesame checkout into firmware/upstream/.

.DESCRIPTION
  Reads the pin from firmware/upstream.pin.json ({repoUrl, commit, resolvedAt}).

  Idempotent: every run produces a byte-identical tree, regardless of what the
  previous run (or the ambient git config) left behind. Safe if
  firmware/upstream/ already exists. Never touches reference/sesame-robot-main/.

  firmware/upstream/ is a READ-ONLY source of truth. Instrumentation belongs in
  firmware/patches/, applied at build time.
#>
[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$RepoRoot = Split-Path -Parent $PSScriptRoot
$PinFile  = Join-Path $RepoRoot 'firmware/upstream.pin.json'
$Dest     = Join-Path $RepoRoot 'firmware/upstream'

if (-not (Test-Path -LiteralPath $PinFile)) {
    throw "Pin file not found: $PinFile"
}

$pin = Get-Content -LiteralPath $PinFile -Raw | ConvertFrom-Json
if (-not $pin.repoUrl -or -not $pin.commit) {
    throw "Pin file is missing repoUrl or commit: $PinFile"
}
if ($pin.commit -notmatch '^[0-9a-f]{40}$') {
    throw "Pin commit is not a full 40-character SHA: $($pin.commit)"
}

$RepoUrl = $pin.repoUrl
$Commit  = $pin.commit

# Byte-reproducibility. Windows commonly has core.autocrlf=true system-wide,
# which rewrites LF->CRLF on checkout for text blobs stored with LF. That would
# make firmware/upstream/ differ byte-for-byte between a Windows and a Linux
# clone of the SAME commit, and would silently poison any SHA-256 recorded
# against it. Pin the working tree to the blobs exactly as committed.
$GitCfg = @('-c', 'core.autocrlf=false', '-c', 'core.eol=lf', '-c', 'core.symlinks=false')

function Invoke-GitRaw {
    param([Parameter(ValueFromRemainingArguments = $true)][string[]]$GitArgs)
    $all = $GitCfg + $GitArgs
    $out = & git @all
    if ($LASTEXITCODE -ne 0) {
        throw "git $($GitArgs -join ' ') failed with exit code $LASTEXITCODE"
    }
    return $out
}

function Invoke-GitIn {
    param([Parameter(ValueFromRemainingArguments = $true)][string[]]$GitArgs)
    return Invoke-GitRaw (@('-C', $Dest) + $GitArgs)
}

Write-Host "upstream repo   : $RepoUrl"
Write-Host "upstream commit : $Commit"
Write-Host "destination     : $Dest"

if (Test-Path -LiteralPath (Join-Path $Dest '.git')) {
    Write-Host '-- existing checkout found, reusing'
    Invoke-GitIn remote set-url origin $RepoUrl | Out-Null
}
elseif (Test-Path -LiteralPath $Dest) {
    throw "$Dest exists but is not a git checkout. Refusing to clobber it. Remove it manually and re-run."
}
else {
    Write-Host '-- cloning'
    $parent = Split-Path -Parent $Dest
    if (-not (Test-Path -LiteralPath $parent)) {
        New-Item -ItemType Directory -Path $parent -Force | Out-Null
    }
    Invoke-GitRaw init --quiet $Dest | Out-Null
    Invoke-GitIn remote add origin $RepoUrl | Out-Null
}

# Only hit the network if we do not already have the commit. This keeps
# re-runs fast and lets the script work offline once the pin is fetched.
& git @GitCfg -C $Dest cat-file -e "$Commit^{commit}" 2>$null
if ($LASTEXITCODE -eq 0) {
    Write-Host '-- commit already present locally, skipping fetch'
}
else {
    Invoke-GitIn fetch --depth 1 origin $Commit | Out-Null
}
Invoke-GitIn checkout --detach --force $Commit | Out-Null

# Defeat git's stat cache. If a previous run checked out under a different
# core.autocrlf, git recorded that run's on-disk size/mtime in the index and
# will report the tree "clean" even though the bytes differ from the blobs --
# `git status`, `git diff` and even `update-index --really-refresh` all
# short-circuit on the matching stat. The only reliable fix is to delete the
# tracked files and re-materialise them under the pinned config.
Write-Host '-- re-materialising tracked files from blobs (guarantees byte-identical tree)'
$tracked = Invoke-GitIn ls-files
foreach ($rel in $tracked) {
    if ([string]::IsNullOrWhiteSpace($rel)) { continue }
    $abs = Join-Path $Dest $rel
    if (Test-Path -LiteralPath $abs) { Remove-Item -LiteralPath $abs -Force }
}
Invoke-GitIn checkout --force -- . | Out-Null
Invoke-GitIn clean -xdff | Out-Null

$actual = (Invoke-GitIn rev-parse HEAD)
if ($actual -ne $Commit) {
    throw "Checkout HEAD $actual does not match pinned $Commit"
}

# Verify no file was line-ending-converted on the way out.
$converted = @()
foreach ($line in (Invoke-GitIn ls-files --eol)) {
    if ($line -match '^i/(lf|crlf)\s+w/(lf|crlf)\s') {
        if ($Matches[1] -ne $Matches[2]) { $converted += $line }
    }
}
if ($converted.Count -gt 0) {
    Write-Error "These files were line-ending-converted on checkout; the tree is not byte-exact:`n$($converted -join "`n")"
    exit 1
}

Write-Host "OK: firmware/upstream/ is at $actual (byte-exact, no EOL conversion)"
Write-Host '    read-only source of truth - never edit; instrumentation lives in firmware/patches/'
