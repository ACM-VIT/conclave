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

function Get-ContainerSetting {
  param([string[]]$EnvLines, [string]$Name)

  $value = ""
  foreach ($line in $EnvLines) {
    if ($line.StartsWith("$Name=", [System.StringComparison]::Ordinal)) {
      $value = $line.Substring($Name.Length + 1)
    }
  }
  return $value.Trim()
}

function ConvertTo-ContainerFilePath {
  param([string]$Workdir, [string]$Path)

  if ($Path.StartsWith("/")) {
    return ConvertTo-ContainerPath -Path $Path
  }
  return ConvertTo-ContainerPath -Path "$Workdir/$Path"
}

function Get-StoreFilePaths {
  param([string]$Container)

  $workdir = (@(& docker inspect --format "{{.Config.WorkingDir}}" $Container) -join "").Trim()
  if ($LASTEXITCODE -ne 0) {
    throw "Could not read where the old container kept its stores."
  }
  $envLines = @(& docker inspect --format "{{range .Config.Env}}{{println .}}{{end}}" $Container)
  if ($LASTEXITCODE -ne 0) {
    throw "Could not read where the old container kept its stores."
  }
  $shared = Get-ContainerSetting -EnvLines $envLines -Name "CONCLAVE_SQLITE_PATH"
  $recordings = Get-ContainerSetting -EnvLines $envLines -Name "RECORDING_STORAGE_PATH"
  $paths = New-Object System.Collections.Generic.List[object]
  foreach ($pair in @(@("scheduling", "SCHEDULING"), @("scheduled-meetings", "SCHEDULED_MEETINGS"), @("scheduled-webinars", "SCHEDULED_WEBINARS"))) {
    $store = $pair[0]
    $prefix = $pair[1]
    $value = Get-ContainerSetting -EnvLines $envLines -Name "${prefix}_PATH"
    if (-not $value) {
      $value = "data/$store.json"
    }
    $paths.Add([pscustomobject]@{ Kind = "json"; Name = "$store.json"; Path = (ConvertTo-ContainerFilePath -Workdir $workdir -Path $value) })
    $value = Get-ContainerSetting -EnvLines $envLines -Name "${prefix}_SQLITE_PATH"
    if (-not $value) {
      $value = $shared
    }
    if (-not $value -and $recordings) {
      $value = "$recordings/conclave.sqlite"
    }
    if (-not $value) {
      $value = "data/conclave.sqlite"
    }
    $paths.Add([pscustomobject]@{ Kind = "sqlite"; Name = $store; Path = (ConvertTo-ContainerFilePath -Workdir $workdir -Path $value) })
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
  foreach ($entry in @(Get-StoreFilePaths -Container $Container | Where-Object { $_.Kind -eq "json" })) {
    $name = $entry.Name
    $path = $entry.Path
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


function Get-ArchiveStamp {
  return [DateTime]::UtcNow.ToString("yyyyMMdd'T'HHmmssfff'Z'")
}

function Send-FallbackJson {
  param([string]$Service, [string]$Directory)

  $names = @(Get-ChildItem -LiteralPath $Directory -Filter "*.json" -File | Sort-Object Name | ForEach-Object { $_.Name })
  if ($names.Count -eq 0) {
    return
  }
  $archive = "$Directory.tar"
  $env:COPYFILE_DISABLE = "1"
  & tar -C $Directory -cf $archive @names
  if ($LASTEXITCODE -ne 0) {
    throw "Could not pack the old $Service container's JSON fallback files."
  }
  if (-not $IsWindows) {
    & chmod 0600 $archive
  }
  $checksum = (Get-FileHash -Algorithm SHA256 -LiteralPath $archive).Hash.ToLowerInvariant()
  if ([string]::IsNullOrWhiteSpace($env:SFU_DEPLOY_ID)) {
    throw "SFU_DEPLOY_ID is not set, so the saved copy would have no deploy id."
  }
  $name = "$(Get-ArchiveStamp)-$($env:SFU_DEPLOY_ID)"
  $transfer = [guid]::NewGuid().ToString("N").Substring(0, 12)
  $receive = 'umask 077 && own() { chown node:node "$@" && chmod 0700 "$@"; } && base=${CONCLAVE_FALLBACK_IMPORT_DIR:?} && case "$3" in ""|.*|*[!A-Za-z0-9._-]*) echo "The archive name $3 is not safe to use." >&2; exit 1;; esac && case "$4" in ""|*[!A-Za-z0-9]*) echo "The transfer id $4 is not safe to use." >&2; exit 1;; esac && folder=$base/$1 && dest=$folder/$3 && incoming=$base/.incoming-$1-$3-$4 && mkdir -p "$base" && own "$base" && mkdir -p "$folder" && own "$folder" && find "$base" -mindepth 1 -maxdepth 1 -type d -name ".incoming-*" -mmin +30 -exec rm -rf {} + && if [ -e "$dest" ]; then echo "$dest already exists, and a saved copy is never replaced." >&2; exit 1; fi && mkdir "$incoming" && own "$incoming" && trap ''rm -rf "$incoming"'' EXIT && cat > "$incoming/payload.tar" && got=$(sha256sum "$incoming/payload.tar" | cut -d" " -f1) && if [ "$got" != "$2" ]; then echo "The fallback files arrived with checksum $got, not $2." >&2; rm -rf "$incoming"; exit 1; fi && mkdir "$incoming/files" && own "$incoming/files" && tar -xf "$incoming/payload.tar" -C "$incoming/files" && rm "$incoming/payload.tar" && chown node:node "$incoming/files"/*.json && chmod 0600 "$incoming/files"/*.json && mv "$incoming/files" "$dest" && rmdir "$incoming" && chown -R node:node "$base"'
  $exitCode = Send-FileToCommand -Path $archive -Command "docker" -Arguments ($composeBaseArgs + @(
    "run", "-T", "--rm", "--no-deps", "--user", "root", "--cap-add", "CHOWN", "--cap-add", "DAC_OVERRIDE", "--cap-add", "FOWNER", "--entrypoint", "sh", $Service, "-c",
    $receive, "sh", $Service, $checksum, $name, $transfer
  ))
  if ($exitCode -ne 0) {
    throw "Could not copy the old $Service container's JSON fallback files onto the volume."
  }
  Write-Host "Saved the old $Service container's JSON fallback files on the volume as $name and verified them: $($names -join ' ')"
}

function Get-LayerSqliteDatabases {
  param([string]$Container)

  $changes = @(& docker diff $Container)
  if ($LASTEXITCODE -ne 0) {
    throw "Could not list the files the old container wrote."
  }
  $found = @()
  foreach ($entry in @(Get-StoreFilePaths -Container $Container | Where-Object { $_.Kind -eq "sqlite" })) {
    if (($changes -ccontains "A $($entry.Path)") -or ($changes -ccontains "C $($entry.Path)")) {
      $found += [pscustomobject]@{ Store = $entry.Name; Path = $entry.Path }
    }
  }
  return $found
}

function Get-SqliteTargetProbe {
  return 'exec node --import tsx server/layerDatabase.ts probe /var/lib/conclave/recordings'
}

function Get-SqliteReceiver {
  return 'umask 077 && target=$1 && case "$target" in /*) ;; *) echo "The database path $target is not absolute." >&2; exit 1;; esac && case "$3" in ""|*[!A-Za-z0-9]*) echo "The transfer id $3 is not safe to use." >&2; exit 1;; esac && dir=$(dirname "$target") && incoming=$dir/.incoming-sqlite-$3 && node --import tsx server/layerDatabase.ts prepare-folder "$dir" /var/lib/conclave/recordings node:node && node --import tsx server/layerDatabase.ts check-place "$target" /var/lib/conclave/recordings && find "$dir" -mindepth 1 -maxdepth 1 -type d -name ".incoming-sqlite-*" -mmin +30 -exec rm -rf {} + && if [ -n "$6" ]; then node --import tsx server/layerDatabase.ts check-mark "$target" "$4" "$6"; else for existing in "$target" "$target-wal" "$target-journal"; do if [ -e "$existing" ] || [ -L "$existing" ]; then echo "$existing already exists, and a database is never replaced." >&2; exit 1; fi; done; fi && mkdir "$incoming" && chown node:node "$incoming" && trap ''rm -rf "$incoming"'' EXIT && cat > "$incoming/payload.tar" && got=$(sha256sum "$incoming/payload.tar" | cut -d" " -f1) && if [ "$got" != "$2" ]; then echo "The database arrived with checksum $got, not $2." >&2; exit 1; fi && tar -xf "$incoming/payload.tar" -C "$incoming" && rm "$incoming/payload.tar" && node --import tsx server/layerDatabase.ts consolidate "$incoming/db" "$4" "$5" && chown node:node "$incoming/db" && chmod 0600 "$incoming/db" && node --import tsx server/layerDatabase.ts check-place "$target" /var/lib/conclave/recordings && if [ -n "$6" ]; then node --import tsx server/layerDatabase.ts check-mark "$target" "$4" "$6" && mv -f "$incoming/db" "$target"; else ln "$incoming/db" "$target"; fi'
}

function Get-LayerSqlitePlan {
  param([string]$Service, [string]$Container, [string]$Started)

  $layer = @(Get-LayerSqliteDatabases -Container $Container)
  if ($layer.Count -eq 0) {
    return @()
  }
  $started = $Started
  if (-not $started) {
    throw "Could not read when the old $Service container last started and stopped."
  }
  $targets = @($null | & docker @($composeBaseArgs + @("run", "-T", "--rm", "--no-deps", "--user", "root", "--cap-add", "DAC_OVERRIDE", "--entrypoint", "sh", $Service, "-c", (Get-SqliteTargetProbe))))
  if ($LASTEXITCODE -ne 0) {
    throw "Could not check where the new $Service keeps its databases."
  }
  $plan = @()
  foreach ($entry in $layer) {
    $found = $null
    foreach ($line in $targets) {
      $fields = @("$line" -split "`t")
      if ($fields.Count -eq 5 -and $fields[0] -ceq $entry.Store) {
        $found = [pscustomobject]@{ State = $fields[1]; Target = $fields[2]; Container = $fields[3]; Started = $fields[4] }
      }
    }
    if (-not $found) {
      throw "Could not tell where the new $Service keeps the $($entry.Store) database."
    }
    $action = $null
    if ($found.State -ceq "carried" -and $found.Container -ceq $Container -and $found.Started -ceq $started) {
      $action = "done"
    } elseif ($found.State -ceq "carried" -and $found.Container -ceq $Container) {
      $action = "replace"
    } elseif ($found.State -ceq "free") {
      $action = "carry"
    } elseif ($found.State -ceq "taken" -or $found.State -ceq "carried") {
      $origin = if ($found.Container) { " carried from container $($found.Container) as it was at $($found.Started)" } else { "" }
      throw "The old $Service container keeps the $($entry.Store) database at $($entry.Path) inside the container, not on the volume, and $($found.Target) on the volume already holds a database$origin, so a copy cannot carry it over. Copy it out with: docker cp ${Container}:$($entry.Path) <file>, merge it into $($found.Target), then deploy again."
    } elseif ($found.State -ceq "unwritable") {
      throw "The old $Service container keeps the $($entry.Store) database at $($entry.Path) inside the container, not on the volume, and the new image would keep it at $($found.Target), where the nearest folder that exists cannot take new files. Make that folder writable, then deploy again."
    } elseif ($found.State -ceq "outside") {
      throw "The old $Service container keeps the $($entry.Store) database at $($entry.Path) inside the container, not on the volume, and the new image would keep it at $($found.Target), which does not resolve onto the recordings volume (/var/lib/conclave/recordings), so it would be lost with the container. Point CONCLAVE_SQLITE_PATH (or the store's own *_SQLITE_PATH) at a real folder on the recordings volume, then deploy again."
    } else {
      throw "Could not tell where the new $Service keeps the $($entry.Store) database."
    }
    if (-not ($plan | Where-Object { $_.Old -ceq $entry.Path -and $_.Target -ceq $found.Target })) {
      $expected = if ($action -ceq "replace") { $found.Started } else { "" }
      $plan += [pscustomobject]@{ Old = $entry.Path; Target = $found.Target; Action = $action; Started = $started; Expected = $expected }
    }
  }
  $shared = @($plan | Group-Object -Property Target -CaseSensitive | Where-Object { $_.Count -gt 1 } | Select-Object -First 1)
  if ($shared.Count -gt 0) {
    throw "The old $Service container keeps more than one database inside the container that the new image would keep at $($shared[0].Name), so a copy cannot carry them over. Merge them into $($shared[0].Name), then deploy again."
  }
  return $plan
}

function Copy-LayerSqlite {
  param([string]$Service, [string]$Container, [string]$Directory, [object[]]$Plan)

  if ($Plan.Count -eq 0) {
    return
  }
  $changes = @(& docker diff $Container)
  if ($LASTEXITCODE -ne 0) {
    throw "Could not list the databases the old $Service container kept."
  }
  New-Item -ItemType Directory -Path $Directory -Force | Out-Null
  if (-not $IsWindows) {
    & chmod 0700 $Directory
  }
  $index = 0
  foreach ($step in $Plan) {
    if ($step.Action -ceq "done") {
      Write-Host "The old $Service container's database $($step.Old) is already at $($step.Target) on the volume, copied from this container as it is now."
      continue
    }
    $index++
    $folder = Join-Path $Directory "$index"
    New-Item -ItemType Directory -Path $folder -Force | Out-Null
    $parts = @()
    foreach ($part in @("", "-wal", "-journal")) {
      $source = "$($step.Old)$part"
      if ($part -and -not (($changes -ccontains "A $source") -or ($changes -ccontains "C $source"))) {
        continue
      }
      $copy = Join-Path $folder "db$part"
      & docker cp "${Container}:$source" $copy
      if ($LASTEXITCODE -ne 0) {
        throw "Could not copy $source out of the old $Service container."
      }
      if (-not $IsWindows) {
        & chmod 0600 $copy
      }
      $parts += "db$part"
    }
    $archive = "$folder.tar"
    $env:COPYFILE_DISABLE = "1"
    & tar -C $folder -cf $archive @parts
    if ($LASTEXITCODE -ne 0) {
      throw "Could not pack the old $Service container's database $($step.Old)."
    }
    if (-not $IsWindows) {
      & chmod 0600 $archive
    }
    $checksum = (Get-FileHash -Algorithm SHA256 -LiteralPath $archive).Hash.ToLowerInvariant()
    $transfer = [guid]::NewGuid().ToString("N").Substring(0, 12)
    $exitCode = Send-FileToCommand -Path $archive -Command "docker" -Arguments ($composeBaseArgs + @(
      "run", "-T", "--rm", "--no-deps", "--user", "root", "--cap-add", "CHOWN", "--cap-add", "DAC_OVERRIDE", "--cap-add", "FOWNER", "--entrypoint", "sh", $Service, "-c",
      (Get-SqliteReceiver), "sh", $step.Target, $checksum, $transfer, $Container, $step.Started, $step.Expected
    ))
    if ($exitCode -ne 0) {
      throw "Could not copy the old $Service container's database $($step.Old) to $($step.Target) on the volume."
    }
    if ($step.Action -ceq "replace") {
      Write-Host "Replaced the copy of $($step.Old) that an earlier attempt left at $($step.Target), because the old $Service container ran again after it; folded its $($parts -join ' ') into one file and verified it."
    } else {
      Write-Host "Copied the old $Service container's database $($step.Old) to $($step.Target) on the volume, folded its $($parts -join ' ') into one file and verified it."
    }
  }
}

function Get-ContainerState {
  param([string]$Container)

  $line = (@(& docker inspect --format "{{.State.Running}} {{.State.StartedAt}} {{.State.FinishedAt}}" $Container) -join "").Trim()
  if ($LASTEXITCODE -ne 0) {
    throw "Could not read the old container's state."
  }
  $fields = @($line -split " ")
  if ($fields.Count -ne 3 -or -not $fields[1] -or -not $fields[2]) {
    throw "Could not read the old container's state."
  }
  return [pscustomobject]@{ Running = ($fields[0] -ceq "true"); Identity = "$($fields[1])_$($fields[2])" }
}

function Get-RestartPolicy {
  param([string]$Container)

  $policy = (@(& docker inspect --format "{{.HostConfig.RestartPolicy.Name}}{{if .HostConfig.RestartPolicy.MaximumRetryCount}}:{{.HostConfig.RestartPolicy.MaximumRetryCount}}{{end}}" $Container) -join "").Trim()
  if ($LASTEXITCODE -ne 0 -or -not $policy) {
    throw "Could not read the old container's restart policy."
  }
  return $policy
}

function Set-RestartPolicy {
  param([string]$Container, [string]$Policy)

  & docker update "--restart=$Policy" $Container | Out-Null
  return $LASTEXITCODE -eq 0
}

function Get-FrozenIdentity {
  param([string]$Service, [string]$Container)

  $state = Get-ContainerState -Container $Container
  if ($state.Running) {
    throw "The old $Service container is running again after the stop."
  }
  return $state.Identity
}

function Assert-StillFrozen {
  param([string]$Service, [string]$Container, [string]$Frozen)

  $state = Get-ContainerState -Container $Container
  if ($state.Running -or $state.Identity -cne $Frozen) {
    throw "The old $Service container started again while its files were being copied (it was stopped as $Frozen; now running=$($state.Running.ToString().ToLowerInvariant()), $($state.Identity)), so the copy may be missing its later saves."
  }
}

function Test-ContainerRunning {
  param([string]$Container)

  $running = (@(& docker inspect --format "{{.State.Running}}" $Container) -join "").Trim()
  if ($LASTEXITCODE -ne 0) {
    throw "Could not read whether the old container is running."
  }
  return $running -ceq "true"
}


function Get-LayerSlotState {
  param([string]$Service)

  $container = @(& docker @($composeBaseArgs + @("ps", "-a", "-q", $Service))) | Select-Object -First 1
  if ($LASTEXITCODE -ne 0) {
    throw "Could not look up the old $Service container."
  }
  if ([string]::IsNullOrWhiteSpace($container)) {
    return "none"
  }
  $layer = @(Get-LayerSqliteDatabases -Container $container)
  if ($layer.Count -eq 0) {
    return "clean"
  }
  if (Test-ContainerRunning -Container $container) {
    return "layer-running"
  }
  return "layer-stopped"
}

function Test-SfuDeployed {
  param([string]$Service, [string]$Url)

  try {
    $health = Invoke-RestMethod -Uri "$Url/health" -Method Get -TimeoutSec 5
    return ($health.status -eq "healthy") -and ($health.instanceId -eq $Service) -and (-not [string]::IsNullOrWhiteSpace($env:SFU_DEPLOY_ID)) -and ($health.deployId -eq $env:SFU_DEPLOY_ID)
  } catch {
    return $false
  }
}

function Wait-SfuDeployed {
  param([string]$Service, [string]$Url, [int]$TimeoutSeconds)

  $pollSeconds = Get-Int -Value $env:SFU_HEALTH_POLL_SECONDS -DefaultValue 2
  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  while (-not (Test-SfuDeployed -Service $Service -Url $Url)) {
    if ((Get-Date) -ge $deadline) {
      return $false
    }
    Start-Sleep -Seconds $pollSeconds
  }
  return $true
}

function Start-SfuService {
  param([string]$Service, [string]$Url)

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
  $policy = ""
  try {
    if ($hasContainer) {
      try {
        $identity = (Get-ContainerState -Container $container).Identity
        $null = @(Get-LayerSqlitePlan -Service $Service -Container $container -Started $identity)
        $policy = Get-RestartPolicy -Container $container
      } catch {
        Exit-WithError "$($_.Exception.Message) Stopped before replacing $Service; nothing was stopped."
      }
      if (-not (Set-RestartPolicy -Container $container -Policy "no")) {
        Exit-WithError "Could not keep the old $Service container from restarting while it is copied. Stopped before replacing $Service; nothing was stopped."
      }
    }
    & docker @($composeBaseArgs + @("stop", $Service))
    if ($LASTEXITCODE -ne 0) {
      if ($hasContainer) {
        $null = Set-RestartPolicy -Container $container -Policy $policy
      }
      Exit-WithError "Could not stop the old $Service."
    }
    Invoke-Checked -Command "docker" -Arguments ($composeBaseArgs + @(
      "run", "--rm", "--no-deps", "--user", "root", "--cap-add", "CHOWN", "--cap-add", "DAC_READ_SEARCH", "--entrypoint", "find", $Service,
      "/var/lib/conclave/recordings", "(", "!", "-user", "node", "-o", "!", "-group", "node", ")",
      "-exec", "chown", "node:node", "{}", "+"
    ))
    if ($hasContainer) {
      try {
        $frozen = Get-FrozenIdentity -Service $Service -Container $container
        $json = Join-Path $staging "json"
        Copy-FallbackJson -Service $Service -Container $container -Directory $json
        Send-FallbackJson -Service $Service -Directory $json
        Assert-StillFrozen -Service $Service -Container $container -Frozen $frozen
        $sqlitePlan = @(Get-LayerSqlitePlan -Service $Service -Container $container -Started $frozen)
        Assert-StillFrozen -Service $Service -Container $container -Frozen $frozen
        Copy-LayerSqlite -Service $Service -Container $container -Directory (Join-Path $staging "sqlite") -Plan $sqlitePlan
        Assert-StillFrozen -Service $Service -Container $container -Frozen $frozen
      } catch {
        $message = $_.Exception.Message
        if (-not (Set-RestartPolicy -Container $container -Policy $policy)) {
          [Console]::Error.WriteLine("Could not restore the old $Service container's restart policy ($policy); set it with: docker update --restart=$policy $container")
        }
        Exit-WithError "$message Stopped before replacing $Service. Its old container is stopped, not removed, with its restart policy ($policy) restored; start it again with: docker $($composeBaseArgs -join ' ') start $Service"
      }
      if (-not (Set-RestartPolicy -Container $container -Policy $policy)) {
        Exit-WithError "Could not restore the old $Service container's restart policy ($policy) before replacing it; set it with: docker update --restart=$policy $container, then deploy again."
      }
    }
  } finally {
    Remove-Item -Recurse -Force -LiteralPath $staging -ErrorAction SilentlyContinue
  }
  Invoke-Checked -Command "docker" -Arguments ($composeBaseArgs + @("up", "-d", $Service))
  $timeoutSeconds = Get-Int -Value $env:SFU_HEALTH_TIMEOUT_SECONDS -DefaultValue 180
  Write-Host "Waiting for the new $Service to answer healthy at $Url as deploy $($env:SFU_DEPLOY_ID)..."
  if (-not (Wait-SfuDeployed -Service $Service -Url $Url -TimeoutSeconds $timeoutSeconds)) {
    & docker @($composeBaseArgs + @("stop", $Service))
    Exit-WithError "The new $Service did not answer healthy at $Url as deploy $($env:SFU_DEPLOY_ID) within $timeoutSeconds seconds. Stopped it; nothing was drained, and the other SFU keeps serving."
  }
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

$deployId = "sfu-" + [DateTime]::UtcNow.ToString("yyyyMMdd'T'HHmmss'Z'") + "-" + [guid]::NewGuid().ToString("N").Substring(0, 8)
[Environment]::SetEnvironmentVariable("SFU_DEPLOY_ID", $deployId, "Process")
Write-Host "Deploy id: $deployId"

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

try {
  $activeLayer = Get-LayerSlotState -Service $activeService
  $inactiveLayer = Get-LayerSlotState -Service $inactiveService
} catch {
  Exit-WithError "Could not list the databases the old SFU containers kept. Nothing was changed."
}
$activeAnswers = if ($activeService -eq "sfu-a") { $hasStatusA } else { $hasStatusB }
if ($activeLayer.StartsWith("layer-") -and $inactiveLayer.StartsWith("layer-")) {
  Exit-WithError "The old $activeService and $inactiveService containers each keep their own database inside the container, not on the volume. A copy can carry over only one of them, so nothing was changed. Merge them into one database on the recordings volume, then deploy again."
}
if ($activeLayer -ceq "layer-running" -or ($activeLayer -ceq "layer-stopped" -and $activeAnswers)) {
  Exit-WithError "The serving $activeService container keeps its database inside the container, not on the volume. $inactiveService is replaced first, and its new container would create a new database on the volume before $activeService's could be carried over, so nothing was changed. In a maintenance window, stop $activeService (docker $($composeBaseArgs -join ' ') stop $activeService) and deploy again: a stopped SFU that keeps its database inside its container is replaced first, and its database is carried."
}
if ($activeLayer -ceq "layer-stopped") {
  Write-Host "$activeService is stopped and keeps its database inside its container, so it is replaced first."
  $swapService = $activeService
  $swapUrl = $activeUrl
  $activeService = $inactiveService
  $activeUrl = $inactiveUrl
  $inactiveService = $swapService
  $inactiveUrl = $swapUrl
  $activeRooms = if ($activeService -eq "sfu-a") { $roomsA } else { $roomsB }
}

Write-Host "Building and starting $inactiveService..."
Start-SfuService -Service $inactiveService -Url $inactiveUrl

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
Start-SfuService -Service $activeService -Url $activeUrl

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
