# Starts the SFU deploy from PowerShell. The deploy is scripts/deploy-sfu.sh,
# which runs where the SFU containers run (the production VM runs it directly).
# This wrapper hands it the same arguments and returns its exit code, so there
# is one implementation of the drain, canary and rollback rules. It needs bash
# on PATH, with Docker reachable from it (WSL or Git Bash on Windows).
# Runbook: docs/ops/sfu-deploys.md.
$ErrorActionPreference = "Stop"

$bash = Get-Command bash -ErrorAction SilentlyContinue
if (-not $bash) {
  [Console]::Error.WriteLine("deploy-sfu.ps1 runs scripts/deploy-sfu.sh, which needs bash on PATH (WSL or Git Bash on Windows).")
  exit 1
}

& $bash.Source (Join-Path $PSScriptRoot "deploy-sfu.sh") @args
exit $LASTEXITCODE
