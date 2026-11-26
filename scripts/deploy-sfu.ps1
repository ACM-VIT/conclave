# Starts the SFU deploy from PowerShell. The deploy is scripts/deploy-sfu.sh,
# which runs where the SFU containers run (the production VM runs it directly).
# This wrapper hands it the same arguments and returns its exit code, so there
# is one implementation of the drain, canary and rollback rules. It runs where
# PowerShell runs on Linux or macOS, with bash, flock and Docker on PATH.
# On Windows it stops: WSL's bash.exe cannot open this script's Windows path,
# and Git Bash has no flock. Run deploy-sfu.sh from a WSL shell instead.
# Runbook: docs/ops/sfu-deploys.md.
$ErrorActionPreference = "Stop"

if ($PSVersionTable.PSVersion -lt [version]"7.4") {
  [Console]::Error.WriteLine("deploy-sfu.ps1 needs PowerShell 7.4 or later. Nothing was changed.")
  exit 1
}

if ($env:OS -eq "Windows_NT") {
  [Console]::Error.WriteLine("deploy-sfu.ps1 does not run on Windows: deploy-sfu.sh needs Linux bash with flock. Open a WSL shell in the checkout and run ./scripts/deploy-sfu.sh there.")
  exit 1
}

$bash = Get-Command bash -ErrorAction SilentlyContinue
if (-not $bash) {
  [Console]::Error.WriteLine("deploy-sfu.ps1 runs scripts/deploy-sfu.sh, which needs bash on PATH.")
  exit 1
}

& $bash.Source (Join-Path $PSScriptRoot "deploy-sfu.sh") @args
exit $LASTEXITCODE
