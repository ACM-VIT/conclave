#!/usr/bin/env pwsh
Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

function Exit-WithError {
  param([string]$Message)
  [Console]::Error.WriteLine($Message)
  exit 1
}

function Invoke-Checked {
  param(
    [string]$Command,
    [string[]]$Arguments
  )

  & $Command @Arguments
  if ($LASTEXITCODE -ne 0) {
    Exit-WithError "Command failed: $Command $($Arguments -join " ")"
  }
}

function Import-DotEnv {
  param([string]$Path)

  foreach ($line in Get-Content -Path $Path) {
    $trimmed = $line.Trim()
    if ($trimmed.Length -eq 0 -or $trimmed.StartsWith("#")) {
      continue
    }

    $separatorIndex = $trimmed.IndexOf("=")
    if ($separatorIndex -lt 1) {
      continue
    }

    $key = $trimmed.Substring(0, $separatorIndex).Trim()
    $value = $trimmed.Substring($separatorIndex + 1)

    if ($value.StartsWith("'") -and $value.EndsWith("'") -and $value.Length -ge 2) {
      $value = $value.Substring(1, $value.Length - 2)
    } elseif ($value.StartsWith('"') -and $value.EndsWith('"') -and $value.Length -ge 2) {
      $value = $value.Substring(1, $value.Length - 2)
    }

    [Environment]::SetEnvironmentVariable($key, $value, "Process")
  }
}

$buildRuntimeImage = $true
foreach ($arg in $args) {
  switch ($arg) {
    "--skip-runtime-image" {
      $buildRuntimeImage = $false
      continue
    }
    default {
      Exit-WithError "Unknown argument: $arg`nUsage: .\deploy-browser-service.ps1 [--skip-runtime-image]"
    }
  }
}

$rootDir = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot ".."))
$envFile = Join-Path $rootDir ".env"
$composeFile = Join-Path $rootDir "docker-compose.browser.yml"

if (-not (Test-Path -Path $composeFile -PathType Leaf)) {
  Exit-WithError "Missing $composeFile"
}

$composeArgs = @("compose")
if (Test-Path -Path $envFile -PathType Leaf) {
  Import-DotEnv -Path $envFile
  $composeArgs += @("--env-file", $envFile)
}
$composeArgs += @("-f", $composeFile)

$runtimeImageName = if (-not [string]::IsNullOrWhiteSpace($env:BROWSER_IMAGE_NAME)) {
  $env:BROWSER_IMAGE_NAME
} else {
  "conclave-browser:latest"
}

if ($buildRuntimeImage) {
  $browserDockerDir = Join-Path $rootDir "packages/shared-browser/docker"
  if (-not (Test-Path -Path $browserDockerDir -PathType Container)) {
    Exit-WithError "Missing browser runtime Docker context at $browserDockerDir"
  }

  Write-Host "Building browser runtime image ($runtimeImageName)..."
  Invoke-Checked -Command "docker" -Arguments @("build", "-t", $runtimeImageName, $browserDockerDir)
}

Write-Host "Deploying shared browser service..."
Invoke-Checked -Command "docker" -Arguments ($composeArgs + @("up", "-d", "--build", "browser-service"))

$browserServicePort = if (-not [string]::IsNullOrWhiteSpace($env:BROWSER_SERVICE_PORT)) {
  $env:BROWSER_SERVICE_PORT
} else {
  "3040"
}
$novncPortStart = if (-not [string]::IsNullOrWhiteSpace($env:NOVNC_PORT_START)) {
  $env:NOVNC_PORT_START
} else {
  "6080"
}
$novncPortEnd = if (-not [string]::IsNullOrWhiteSpace($env:NOVNC_PORT_END)) {
  $env:NOVNC_PORT_END
} else {
  "6100"
}
$browserHostAddress = if (-not [string]::IsNullOrWhiteSpace($env:BROWSER_HOST_ADDRESS)) {
  $env:BROWSER_HOST_ADDRESS
} else {
  "localhost"
}

Write-Host ""
Write-Host "Shared browser service deployed."
Write-Host "Control API: http://<browser-host>:$browserServicePort/health"
Write-Host "noVNC ports: $novncPortStart-$novncPortEnd"

if ([string]::IsNullOrWhiteSpace($env:BROWSER_PUBLIC_BASE_URL) -and ($browserHostAddress -eq "localhost")) {
  Write-Host ""
  Write-Host "Warning: BROWSER_PUBLIC_BASE_URL is unset and BROWSER_HOST_ADDRESS=localhost."
  Write-Host "Clients will receive localhost noVNC URLs unless you set one of these values."
}

if ([string]::IsNullOrWhiteSpace($env:BROWSER_RTP_TARGET_HOST) -and
    [string]::IsNullOrWhiteSpace($env:BROWSER_AUDIO_TARGET_HOST) -and
    [string]::IsNullOrWhiteSpace($env:BROWSER_VIDEO_TARGET_HOST) -and
    [string]::IsNullOrWhiteSpace($env:SFU_HOST)) {
  Write-Host ""
  Write-Host "Note: No explicit RTP target host override is set."
  Write-Host "Ensure SFU sets PLAIN_TRANSPORT_ANNOUNCED_IP to a browser-host-reachable IP."
}
