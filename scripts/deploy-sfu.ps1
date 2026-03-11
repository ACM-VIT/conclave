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

function Get-Int {
  param(
    [AllowNull()]$Value,
    [int]$DefaultValue
  )

  if ($null -eq $Value) {
    return $DefaultValue
  }

  $parsed = 0
  if ([int]::TryParse([string]$Value, [ref]$parsed)) {
    return $parsed
  }
  return $DefaultValue
}

function Get-BoolText {
  param(
    [AllowNull()]$Value,
    [string]$DefaultValue = "unknown"
  )

  if ($null -eq $Value) {
    return $DefaultValue
  }

  if ($Value -is [bool]) {
    if ($Value) {
      return "true"
    }
    return "false"
  }

  $text = [string]$Value
  if ($text -match "^(?i:true|false)$") {
    return $text.ToLowerInvariant()
  }

  return $DefaultValue
}

function Get-PoolUrl {
  param([string]$Id)

  if (-not [string]::IsNullOrWhiteSpace($env:SFU_POOL)) {
    $entries = $env:SFU_POOL.Split(",")
    foreach ($entry in $entries) {
      $trimmed = $entry.Trim()
      if ($trimmed.StartsWith("$Id=")) {
        return $trimmed.Substring($Id.Length + 1)
      }
    }
  }

  if ($Id -eq "sfu-a") {
    if (-not [string]::IsNullOrWhiteSpace($env:SFU_A_URL)) {
      return $env:SFU_A_URL
    }
    return "http://127.0.0.1:3031"
  }

  if (-not [string]::IsNullOrWhiteSpace($env:SFU_B_URL)) {
    return $env:SFU_B_URL
  }
  return "http://127.0.0.1:3032"
}

function Get-StatusJson {
  param([string]$Url)

  try {
    $headers = @{ "x-sfu-secret" = $env:SFU_SECRET }
    return Invoke-RestMethod -Uri "$Url/status" -Headers $headers -Method Get -TimeoutSec 5
  } catch {
    return $null
  }
}

$deployBrowserLocal = $false
$forceDrain = $false
$forceDrainNoticeMs = if (-not [string]::IsNullOrWhiteSpace($env:FORCE_DRAIN_NOTICE_MS)) {
  $env:FORCE_DRAIN_NOTICE_MS
} else {
  "4000"
}

foreach ($arg in $args) {
  if ($arg -eq "--with-browser" -or $arg -eq "--with-browser-local") {
    $deployBrowserLocal = $true
    continue
  }

  if ($arg -eq "--force-drain") {
    $forceDrain = $true
    continue
  }

  if ($arg.StartsWith("--force-drain-notice-ms=")) {
    $forceDrain = $true
    $forceDrainNoticeMs = $arg.Substring("--force-drain-notice-ms=".Length)
    continue
  }
}

if ($forceDrainNoticeMs -notmatch "^[0-9]+$") {
  Exit-WithError "FORCE_DRAIN_NOTICE_MS must be a non-negative integer (milliseconds)."
}

$rootDir = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot ".."))
$envFile = Join-Path $rootDir ".env"
$composeFile = Join-Path $rootDir "docker-compose.sfu.yml"

if (-not (Test-Path -Path $envFile -PathType Leaf)) {
  Exit-WithError "Missing .env at $envFile"
}

if (-not (Test-Path -Path $composeFile -PathType Leaf)) {
  Exit-WithError "Missing $composeFile"
}

Import-DotEnv -Path $envFile

if ([string]::IsNullOrWhiteSpace($env:SFU_SECRET)) {
  Exit-WithError "SFU_SECRET is required in .env"
}

$hasUpstash = (-not [string]::IsNullOrWhiteSpace($env:UPSTASH_REDIS_REST_URL)) -and
  (-not [string]::IsNullOrWhiteSpace($env:UPSTASH_REDIS_REST_TOKEN))

if (-not $hasUpstash -and [string]::IsNullOrWhiteSpace($env:REDIS_PASSWORD)) {
  Exit-WithError "REDIS_PASSWORD is required in .env when not using Upstash"
}

$composeBaseArgs = @("compose", "--env-file", $envFile, "-f", $composeFile)
$servicesOutput = & docker @($composeBaseArgs + @("config", "--services")) 2>$null
if ($LASTEXITCODE -ne 0) {
  Exit-WithError "Failed to read services from $composeFile"
}

$hasRedisService = $false
foreach ($service in $servicesOutput) {
  if ($service -eq "redis") {
    $hasRedisService = $true
    break
  }
}

$sfuAUrl = Get-PoolUrl -Id "sfu-a"
$sfuBUrl = Get-PoolUrl -Id "sfu-b"

Write-Host "Using SFU A: $sfuAUrl"
Write-Host "Using SFU B: $sfuBUrl"

Write-Host "Pulling latest code..."
Invoke-Checked -Command "git" -Arguments @("-C", $rootDir, "pull")

Write-Host "Installing SFU dependencies..."
Invoke-Checked -Command "npm" -Arguments @("--prefix", (Join-Path $rootDir "packages/sfu"), "install")

if ($hasUpstash) {
  Write-Host "Using Upstash Redis; skipping local Redis container."
} elseif ($hasRedisService) {
  Write-Host "Ensuring Redis is running..."
  Invoke-Checked -Command "docker" -Arguments ($composeBaseArgs + @("up", "-d", "redis"))
} else {
  Write-Host "Redis service not present in $composeFile; skipping local Redis container."
}

$statusA = Get-StatusJson -Url $sfuAUrl
$statusB = Get-StatusJson -Url $sfuBUrl

$roomsA = 0
$roomsB = 0
$drainingA = "unknown"
$drainingB = "unknown"
$hasStatusA = $false
$hasStatusB = $false

if ($null -ne $statusA) {
  $hasStatusA = $true
  $roomsA = Get-Int -Value $statusA.rooms -DefaultValue 0
  $drainingA = Get-BoolText -Value $statusA.draining -DefaultValue "unknown"
}

if ($null -ne $statusB) {
  $hasStatusB = $true
  $roomsB = Get-Int -Value $statusB.rooms -DefaultValue 0
  $drainingB = Get-BoolText -Value $statusB.draining -DefaultValue "unknown"
}

$activeService = ""
$activeUrl = ""

if ($hasStatusA -and $hasStatusB) {
  if ($roomsA -gt 0 -and $roomsB -eq 0) {
    $activeService = "sfu-a"
    $activeUrl = $sfuAUrl
  } elseif ($roomsB -gt 0 -and $roomsA -eq 0) {
    $activeService = "sfu-b"
    $activeUrl = $sfuBUrl
  } elseif ($drainingA -eq "false" -and $drainingB -eq "true") {
    $activeService = "sfu-a"
    $activeUrl = $sfuAUrl
  } elseif ($drainingB -eq "false" -and $drainingA -eq "true") {
    $activeService = "sfu-b"
    $activeUrl = $sfuBUrl
  } else {
    $activeService = "sfu-a"
    $activeUrl = $sfuAUrl
  }
} elseif ($hasStatusA) {
  $activeService = "sfu-a"
  $activeUrl = $sfuAUrl
} elseif ($hasStatusB) {
  $activeService = "sfu-b"
  $activeUrl = $sfuBUrl
} else {
  $activeService = "sfu-a"
  $activeUrl = $sfuAUrl
}

if ($activeService -eq "sfu-a") {
  $inactiveService = "sfu-b"
  $inactiveUrl = $sfuBUrl
  $activeRooms = $roomsA
} else {
  $inactiveService = "sfu-a"
  $inactiveUrl = $sfuAUrl
  $activeRooms = $roomsB
}

Write-Host "Active service: $activeService"
Write-Host "Inactive service: $inactiveService"

Write-Host "Building and starting $inactiveService..."
Invoke-Checked -Command "docker" -Arguments ($composeBaseArgs + @("up", "-d", "--build", $inactiveService))

$forcedDrainActive = $false
if ($activeService -eq "sfu-a" -and -not $hasStatusA) {
  Write-Host "Active SFU not reachable; skipping drain."
} elseif ($activeService -eq "sfu-b" -and -not $hasStatusB) {
  Write-Host "Active SFU not reachable; skipping drain."
} elseif (-not [string]::IsNullOrWhiteSpace($activeUrl)) {
  Write-Host "Draining $activeService..."
  $drainPayload = @{ draining = $true }
  if ($forceDrain) {
    if ($activeRooms -gt 0) {
      Write-Host "Force drain enabled; notifying clients before disconnecting active rooms."
    } else {
      Write-Host "Force drain enabled; no active rooms detected at pre-check."
    }
    $drainPayload = @{
      draining = $true
      force = $true
      noticeMs = (Get-Int -Value $forceDrainNoticeMs -DefaultValue 4000)
    }
  }

  try {
    $headers = @{ "x-sfu-secret" = $env:SFU_SECRET }
    $drainResponse = Invoke-RestMethod `
      -Uri "$activeUrl/drain" `
      -Method Post `
      -Headers $headers `
      -ContentType "application/json" `
      -Body ($drainPayload | ConvertTo-Json -Compress) `
      -TimeoutSec 10

    if ($forceDrain) {
      $forcedResult = Get-BoolText -Value $drainResponse.forced -DefaultValue "false"
      if ($forcedResult -eq "true") {
        $forcedDrainActive = $true
      } else {
        Write-Host "Force drain was requested but was not applied by $activeService."
      }
    }
  } catch {
    Write-Warning "Failed to drain $activeService; continuing."
  }
}

$drainTimeoutSeconds = Get-Int -Value $env:DRAIN_TIMEOUT_SECONDS -DefaultValue 3600
$drainPollSeconds = Get-Int -Value $env:DRAIN_POLL_SECONDS -DefaultValue 10

if ($forcedDrainActive) {
  Write-Host "Force drain requested; skipping room-drain wait."
} elseif ((-not [string]::IsNullOrWhiteSpace($activeUrl) -and $hasStatusA -and $activeService -eq "sfu-a") -or
          (-not [string]::IsNullOrWhiteSpace($activeUrl) -and $hasStatusB -and $activeService -eq "sfu-b")) {
  Write-Host "Waiting for $activeService rooms to drain..."
  $startTime = Get-Date
  while ($true) {
    $status = Get-StatusJson -Url $activeUrl
    $rooms = 0
    if ($null -ne $status) {
      $rooms = Get-Int -Value $status.rooms -DefaultValue 0
    }

    Write-Host "Active rooms: $rooms"
    if ($rooms -eq 0) {
      break
    }

    $elapsed = (Get-Date) - $startTime
    if ($elapsed.TotalSeconds -gt $drainTimeoutSeconds) {
      Exit-WithError "Timed out waiting for rooms to drain."
    }

    Start-Sleep -Seconds $drainPollSeconds
  }
}

Write-Host "Rebuilding and starting $activeService..."
Invoke-Checked -Command "docker" -Arguments ($composeBaseArgs + @("up", "-d", "--build", $activeService))

if ($deployBrowserLocal) {
  Write-Host ""
  Write-Host "=== Deploying Browser Service (local) ==="
  $browserScript = Join-Path $rootDir "scripts/deploy-browser-service.ps1"
  if (-not (Test-Path -Path $browserScript -PathType Leaf)) {
    Exit-WithError "Missing $browserScript"
  }
  & $browserScript
  if ($LASTEXITCODE -ne 0) {
    Exit-WithError "Browser service deployment failed."
  }
}

Write-Host ""
Write-Host "SFU deploy complete."
if ($deployBrowserLocal) {
  Write-Host "Browser service deploy complete."
}
