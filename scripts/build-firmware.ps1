<#
.SYNOPSIS
    F3 - build a Sesame firmware profile reproducibly.

.DESCRIPTION
    Thin wrapper around scripts/build-firmware.mjs, which holds the real logic
    (scratch copy -> patch -> verify against hardware-map.json -> arduino-cli
    compile -> artifacts + build-manifest.json). The logic lives in Node so the
    PowerShell and POSIX entry points cannot drift apart; JSON manifests and
    SHA-256 hashing are also considerably less error-prone there.

    firmware/upstream/ is never modified. Nothing is installed machine-wide:
    arduino-cli, the ESP32 core, its toolchains and all libraries live under
    tools/ and are addressed through tools/arduino-cli/arduino-cli.yaml.

.PARAMETER Profile
    s2mini | distro-v3-s3 | distro-v1-esp32

.PARAMETER Clean
    Wipe the scratch sketch and the arduino-cli build cache before building.
    Used by the determinism check.

.EXAMPLE
    ./scripts/build-firmware.ps1 s2mini
.EXAMPLE
    ./scripts/build-firmware.ps1 distro-v3-s3 -Clean
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true, Position = 0)]
    [ValidateSet('s2mini', 'distro-v3-s3', 'distro-v1-esp32')]
    [string]$Profile,

    [switch]$Clean
)

$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    throw 'node is required on PATH (the build driver is scripts/build-firmware.mjs).'
}

$cli = Join-Path $repo 'tools/arduino-cli/arduino-cli.exe'
if (-not (Test-Path $cli)) {
    throw "Portable arduino-cli not found at $cli. Run scripts/setup-firmware-toolchain.ps1 first."
}

$argv = @((Join-Path $PSScriptRoot 'build-firmware.mjs'), $Profile)
if ($Clean) { $argv += '--clean' }

& node @argv
exit $LASTEXITCODE
