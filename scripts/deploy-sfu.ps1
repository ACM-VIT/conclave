#!/usr/bin/env pwsh
Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

function Assert-PowerShellVersion {
  $version = $PSVersionTable.PSVersion
  if ($version.Major -lt 7 -or ($version.Major -eq 7 -and $version.Minor -lt 4)) {
    [Console]::Error.WriteLine("deploy-sfu.ps1 needs PowerShell 7.4 or later; this is PowerShell $version. Nothing was changed.")
    exit 1
  }
}

Assert-PowerShellVersion

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

function Get-KeyedPoolUrl {
  param(
    [AllowNull()][string]$Pool,
    [string]$Id
  )

  if (-not [string]::IsNullOrWhiteSpace($Pool)) {
    $entries = $Pool.Split(",")
    foreach ($entry in $entries) {
      $trimmed = $entry.Trim()
      if ($trimmed.StartsWith("$Id=")) {
        return $trimmed.Substring($Id.Length + 1)
      }
    }
  }
  return ""
}

function Get-ListPoolUrl {
  param(
    [AllowNull()][string]$Pool,
    [int]$Index
  )

  if ([string]::IsNullOrWhiteSpace($Pool)) {
    return ""
  }
  $current = 0
  foreach ($entry in $Pool.Split(",")) {
    $trimmed = $entry.Trim()
    if ([string]::IsNullOrWhiteSpace($trimmed) -or $trimmed.Contains("=")) {
      continue
    }
    $current += 1
    if ($current -eq $Index) {
      return $trimmed
    }
  }
  return ""
}

function Get-DeployUrl {
  param([string]$Id)

  $pooled = Get-KeyedPoolUrl -Pool $env:SFU_DEPLOY_POOL -Id $Id
  if ([string]::IsNullOrWhiteSpace($pooled)) {
    $pooled = Get-KeyedPoolUrl -Pool $env:SFU_POOL -Id $Id
  }
  if (-not [string]::IsNullOrWhiteSpace($pooled)) {
    return $pooled
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

function Test-LocalUrl {
  param([string]$Url)

  try {
    $parsed = [Uri]$Url
    return $parsed.Host -eq "localhost" -or $parsed.Host -eq "127.0.0.1" -or $parsed.Host -eq "::1"
  } catch {
    return $false
  }
}

function Get-PublicUrl {
  param(
    [string]$Id,
    [string]$DeployUrl,
    [int]$ListIndex
  )

  $pooled = Get-KeyedPoolUrl -Pool $env:SFU_PUBLIC_POOL -Id $Id
  if ([string]::IsNullOrWhiteSpace($pooled)) {
    $pooled = Get-KeyedPoolUrl -Pool $env:SFU_PUBLIC_URLS -Id $Id
  }
  if ([string]::IsNullOrWhiteSpace($pooled)) {
    $pooled = Get-KeyedPoolUrl -Pool $env:SFU_URLS -Id $Id
  }
  if ([string]::IsNullOrWhiteSpace($pooled)) {
    $pooled = Get-ListPoolUrl -Pool $env:SFU_PUBLIC_URLS -Index $ListIndex
  }
  if ([string]::IsNullOrWhiteSpace($pooled)) {
    $pooled = Get-ListPoolUrl -Pool $env:SFU_URLS -Index $ListIndex
  }
  if (-not [string]::IsNullOrWhiteSpace($pooled)) {
    return $pooled
  }

  if ($Id -eq "sfu-a" -and -not [string]::IsNullOrWhiteSpace($env:SFU_A_PUBLIC_URL)) {
    return $env:SFU_A_PUBLIC_URL
  }
  if ($Id -eq "sfu-b" -and -not [string]::IsNullOrWhiteSpace($env:SFU_B_PUBLIC_URL)) {
    return $env:SFU_B_PUBLIC_URL
  }
  if (-not (Test-LocalUrl -Url $DeployUrl)) {
    return $DeployUrl
  }
  return ""
}

# The SFU image runs as the unprivileged node user. Containers from earlier
# images ran as root and left root-owned files (the SQLite database among them)
# in the recordings volume. Hand anything node does not own over before a new
# container starts. Safe to repeat; it only touches mismatched files.
# Older images fell back to JSON files in the container layer when SQLite was
# locked. Before the old container stops, its files are copied out, sent to the
# folder the new image names (CONCLAVE_FALLBACK_IMPORT_DIR) and checked there
# by SHA-256; after the stop they are copied again and resent if they changed.
function Send-FileToCommand {
  param([string]$Path, [string]$Command, [string[]]$Arguments)

  $start = [System.Diagnostics.ProcessStartInfo]::new($Command)
  foreach ($argument in $Arguments) {
    $start.ArgumentList.Add($argument)
  }
  $start.UseShellExecute = $false
  $start.RedirectStandardInput = $true
  $process = [System.Diagnostics.Process]::Start($start)
  try {
    try {
      $source = [System.IO.File]::OpenRead($Path)
      try {
        $source.CopyTo($process.StandardInput.BaseStream)
      } finally {
        $source.Dispose()
      }
    } finally {
      $process.StandardInput.Close()
    }
    $process.WaitForExit()
    return $process.ExitCode
  } finally {
    $process.Dispose()
  }
}

function ConvertTo-ContainerPath {
  param([string]$Path)

  $kept = New-Object System.Collections.Generic.List[string]
  foreach ($part in $Path.Split("/")) {
    if ($part -eq "" -or $part -eq ".") {
      continue
    }
    if ($part -eq "..") {
      if ($kept.Count -gt 0) {
        $kept.RemoveAt($kept.Count - 1)
      }
      continue
    }
    $kept.Add($part)
  }
  return "/" + ($kept -join "/")
}

function Get-FallbackJsonPaths {
  param([string]$Container)

  $workdir = (@(& docker inspect --format "{{.Config.WorkingDir}}" $Container) -join "").Trim()
  if ($LASTEXITCODE -ne 0) {
    throw "Could not read where the old container kept its stores."
  }
  $envLines = @(& docker inspect --format "{{range .Config.Env}}{{println .}}{{end}}" $Container)
  if ($LASTEXITCODE -ne 0) {
    throw "Could not read where the old container kept its stores."
  }
  $paths = [ordered]@{}
  foreach ($pair in @(@("scheduling.json", "SCHEDULING_PATH"), @("scheduled-meetings.json", "SCHEDULED_MEETINGS_PATH"), @("scheduled-webinars.json", "SCHEDULED_WEBINARS_PATH"))) {
    $name = $pair[0]
    $variable = $pair[1]
    $value = ""
    foreach ($line in $envLines) {
      if ($line.StartsWith("$variable=", [System.StringComparison]::Ordinal)) {
        $value = $line.Substring($variable.Length + 1)
      }
    }
    $value = $value.Trim()
    if (-not $value) {
      $value = "$workdir/data/$name"
    } elseif (-not $value.StartsWith("/")) {
      $value = "$workdir/$value"
    }
    $paths[$name] = ConvertTo-ContainerPath -Path $value
  }
  return $paths
}

function Copy-FallbackJson {
  param([string]$Service, [string]$Container, [string]$Directory)

  New-Item -ItemType Directory -Path $Directory -Force | Out-Null
  if (-not $IsWindows) {
    & chmod 0700 $Directory
  }
  $changes = @(& docker diff $Container)
  if ($LASTEXITCODE -ne 0) {
    throw "Could not list the files the old $Service container wrote."
  }
  $paths = Get-FallbackJsonPaths -Container $Container
  foreach ($name in $paths.Keys) {
    $path = $paths[$name]
    if (-not (($changes -ccontains "A $path") -or ($changes -ccontains "C $path"))) {
      continue
    }
    $target = Join-Path $Directory $name
    & docker cp "${Container}:$path" $target
    if ($LASTEXITCODE -ne 0) {
      throw "Could not copy $name out of the old $Service container."
    }
    if (-not $IsWindows) {
      & chmod 0600 $target
    }
  }
}

function Get-FallbackFingerprint {
  param([string]$Directory)

  $entries = @(Get-ChildItem -LiteralPath $Directory -Filter "*.json" -File -ErrorAction SilentlyContinue | Sort-Object Name | ForEach-Object {
    "$($_.Name) $((Get-FileHash -Algorithm SHA256 -LiteralPath $_.FullName).Hash)"
  })
  return ($entries -join "`n")
}

function Send-FallbackJson {
  param([string]$Service, [string]$Directory)

  $names = @(Get-ChildItem -LiteralPath $Directory -Filter "*.json" -File | Sort-Object Name | ForEach-Object { $_.Name })
  if ($names.Count -eq 0) {
    return
  }
  $archive = "$Directory.tar"
  & tar -C $Directory -cf $archive @names
  if ($LASTEXITCODE -ne 0) {
    throw "Could not pack the old $Service container's JSON fallback files."
  }
  if (-not $IsWindows) {
    & chmod 0600 $archive
  }
  $checksum = (Get-FileHash -Algorithm SHA256 -LiteralPath $archive).Hash.ToLowerInvariant()
  $receive = 'umask 077 && base=${CONCLAVE_FALLBACK_IMPORT_DIR:?} && dest=$base/$1 && incoming=$base/.incoming-$1-$$ && mkdir -p "$dest" "$incoming" && cat > "$incoming/payload.tar" && got=$(sha256sum "$incoming/payload.tar" | cut -d" " -f1) && if [ "$got" != "$2" ]; then echo "The fallback files arrived with checksum $got, not $2." >&2; rm -rf "$incoming"; exit 1; fi && tar -xf "$incoming/payload.tar" -C "$incoming" && rm "$incoming/payload.tar" && mv -f "$incoming"/*.json "$dest"/ && rmdir "$incoming" && chmod 0700 "$base" "$dest" && chmod 0600 "$dest"/*.json && chown -R node:node "$base"'
  $exitCode = Send-FileToCommand -Path $archive -Command "docker" -Arguments ($composeBaseArgs + @(
    "run", "-T", "--rm", "--no-deps", "--user", "root", "--cap-add", "CHOWN", "--cap-add", "DAC_OVERRIDE", "--cap-add", "FOWNER", "--entrypoint", "sh", $Service, "-c",
    $receive, "sh", $Service, $checksum
  ))
  if ($exitCode -ne 0) {
    throw "Could not copy the old $Service container's JSON fallback files onto the volume."
  }
  Write-Host "Copied JSON fallback files from the old $Service container onto the volume and verified them: $($names -join ' ')"
}

function Start-SfuService {
  param([string]$Service)

  Assert-PowerShellVersion
  Invoke-Checked -Command "docker" -Arguments ($composeBaseArgs + @("build", $Service))
  $containers = @(& docker @($composeBaseArgs + @("ps", "-a", "-q", $Service)))
  if ($LASTEXITCODE -ne 0) {
    Exit-WithError "Could not look up the old $Service container. Stopped before replacing $Service; nothing was stopped."
  }
  $container = $containers | Select-Object -First 1
  $hasContainer = -not [string]::IsNullOrWhiteSpace($container)
  $staging = Join-Path ([System.IO.Path]::GetTempPath()) ("conclave-fallback-" + [guid]::NewGuid())
  New-Item -ItemType Directory -Path $staging | Out-Null
  if (-not $IsWindows) {
    & chmod 0700 $staging
  }
  try {
    $before = Join-Path $staging "before"
    $after = Join-Path $staging "after"
    if ($hasContainer) {
      try {
        Copy-FallbackJson -Service $Service -Container $container -Directory $before
        Send-FallbackJson -Service $Service -Directory $before
      } catch {
        Exit-WithError "$($_.Exception.Message) Stopped before replacing $Service; nothing was stopped."
      }
    }
    Invoke-Checked -Command "docker" -Arguments ($composeBaseArgs + @("stop", $Service))
    Invoke-Checked -Command "docker" -Arguments ($composeBaseArgs + @(
      "run", "--rm", "--no-deps", "--user", "root", "--cap-add", "CHOWN", "--cap-add", "DAC_READ_SEARCH", "--entrypoint", "find", $Service,
      "/var/lib/conclave/recordings", "(", "!", "-user", "node", "-o", "!", "-group", "node", ")",
      "-exec", "chown", "node:node", "{}", "+"
    ))
    if ($hasContainer) {
      try {
        Copy-FallbackJson -Service $Service -Container $container -Directory $after
        if ((Get-FallbackFingerprint -Directory $before) -ne (Get-FallbackFingerprint -Directory $after)) {
          Send-FallbackJson -Service $Service -Directory $after
        }
      } catch {
        Exit-WithError "$($_.Exception.Message) Stopped before replacing $Service. Its old container is stopped, not removed; start it again with: docker $($composeBaseArgs -join ' ') start $Service"
      }
    }
  } finally {
    Remove-Item -Recurse -Force -LiteralPath $staging -ErrorAction SilentlyContinue
  }
  Invoke-Checked -Command "docker" -Arguments ($composeBaseArgs + @("up", "-d", $Service))
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
$preflightOnly = $false
$preflightConfigOnly = $false
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

  if ($arg -eq "--preflight-only" -or $arg -eq "--dry-run") {
    $preflightOnly = $true
    continue
  }

  if ($arg -eq "--preflight-config-only") {
    $preflightOnly = $true
    $preflightConfigOnly = $true
    continue
  }
}

if ($forceDrainNoticeMs -notmatch "^[0-9]+$") {
  Exit-WithError "FORCE_DRAIN_NOTICE_MS must be a non-negative integer (milliseconds)."
}

$rootDir = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot ".."))
$envFile = Join-Path $rootDir ".env"
$sfuEnvFile = Join-Path $rootDir "packages/sfu/.env"
$composeFile = Join-Path $rootDir "docker-compose.sfu.yml"

if (-not (Test-Path -Path $envFile -PathType Leaf)) {
  Exit-WithError "Missing .env at $envFile"
}

if (-not (Test-Path -Path $composeFile -PathType Leaf)) {
  Exit-WithError "Missing $composeFile"
}

Import-DotEnv -Path $envFile
if (Test-Path -Path $sfuEnvFile -PathType Leaf) {
  Import-DotEnv -Path $sfuEnvFile
}

if ([string]::IsNullOrWhiteSpace($env:SFU_SECRET)) {
  Exit-WithError "SFU_SECRET is required in .env"
}

$hasUpstash = (-not [string]::IsNullOrWhiteSpace($env:UPSTASH_REDIS_REST_URL)) -and
  (-not [string]::IsNullOrWhiteSpace($env:UPSTASH_REDIS_REST_TOKEN))

if (-not $hasUpstash -and
    [string]::IsNullOrWhiteSpace($env:REDIS_PASSWORD) -and
    [string]::IsNullOrWhiteSpace($env:REDIS_URL) -and
    [string]::IsNullOrWhiteSpace($env:SFU_REDIS_URL)) {
  Exit-WithError "REDIS_PASSWORD, REDIS_URL, or SFU_REDIS_URL is required in .env when not using Upstash"
}

$composeBaseArgs = @("compose", "--env-file", $envFile)
if (Test-Path -Path $sfuEnvFile -PathType Leaf) {
  $composeBaseArgs += @("--env-file", $sfuEnvFile)
}
$composeBaseArgs += @("-f", $composeFile)
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

$sfuAUrl = Get-DeployUrl -Id "sfu-a"
$sfuBUrl = Get-DeployUrl -Id "sfu-b"
$sfuAPublicUrl = Get-PublicUrl -Id "sfu-a" -DeployUrl $sfuAUrl -ListIndex 1
$sfuBPublicUrl = Get-PublicUrl -Id "sfu-b" -DeployUrl $sfuBUrl -ListIndex 2
[Environment]::SetEnvironmentVariable("SFU_A_PUBLIC_URL", $sfuAPublicUrl, "Process")
[Environment]::SetEnvironmentVariable("SFU_B_PUBLIC_URL", $sfuBPublicUrl, "Process")

Write-Host "Using SFU A deploy URL: $sfuAUrl"
Write-Host "Using SFU B deploy URL: $sfuBUrl"
Write-Host "Using SFU A public URL: $(if ($sfuAPublicUrl) { $sfuAPublicUrl } else { '<unset>' })"
Write-Host "Using SFU B public URL: $(if ($sfuBPublicUrl) { $sfuBPublicUrl } else { '<unset>' })"

$composeJsonLines = & docker @($composeBaseArgs + @("config", "--format", "json"))
if ($LASTEXITCODE -ne 0) {
  Exit-WithError "Failed to render $composeFile for deployment preflight"
}
$preflightArguments = @(
  (Join-Path $rootDir "scripts/deploy-sfu-preflight.mjs"),
  "--compose-json",
  "-"
)
if (-not [string]::IsNullOrWhiteSpace($env:SFU_DEPLOY_SERVICES)) {
  $preflightArguments += @("--services", $env:SFU_DEPLOY_SERVICES)
}
# A normal deployment must be able to revive a stopped inactive SFU, so its
# pre-mutation gate validates rendered configuration only. Explicit
# --preflight-only remains the operator-facing live route check.
if ($preflightConfigOnly -or -not $preflightOnly) {
  $preflightArguments += "--config-only"
}

Write-Host "Running fail-closed SFU deployment preflight..."
($composeJsonLines -join [Environment]::NewLine) | & node @preflightArguments
if ($LASTEXITCODE -ne 0) {
  Exit-WithError "SFU deployment preflight failed"
}
if ($deployBrowserLocal) {
  # The browser service deploys last, after both SFUs changed; refuse its
  # configuration now rather than after the SFU swap. It runs in a child
  # process because it imports the root .env, which would replace values that
  # packages/sfu/.env set in this one (SFU_SECRET among them).
  $powershell = (Get-Process -Id $PID).Path
  & $powershell -NoProfile -File (Join-Path $rootDir "scripts/deploy-browser-service.ps1") --check-config
  if ($LASTEXITCODE -ne 0) {
    Exit-WithError "Browser service configuration is invalid."
  }
}
if ($preflightOnly) {
  Write-Host "Preflight-only run complete; no code, container, drain, or DNS changes were made."
  exit 0
}

Write-Host "Pulling latest code..."
Invoke-Checked -Command "git" -Arguments @("-C", $rootDir, "pull")

Write-Host "Installing SFU dependencies..."
Invoke-Checked -Command "npm" -Arguments @("--prefix", (Join-Path $rootDir "packages/sfu"), "install")

if ($hasUpstash) {
  Write-Host "Using Upstash Redis; skipping local Redis container."
} elseif (-not [string]::IsNullOrWhiteSpace($env:SFU_REDIS_URL) -or
          -not [string]::IsNullOrWhiteSpace($env:REDIS_URL)) {
  Write-Host "Using configured external Redis; skipping local Redis container."
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
Start-SfuService -Service $inactiveService

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
Start-SfuService -Service $activeService

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
