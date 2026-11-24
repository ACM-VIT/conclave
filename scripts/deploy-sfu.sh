#!/usr/bin/env bash
set -euo pipefail

DEPLOY_BROWSER_LOCAL="false"
FORCE_DRAIN="false"
PREFLIGHT_ONLY="false"
PREFLIGHT_CONFIG_ONLY="false"
FORCE_DRAIN_NOTICE_MS="${FORCE_DRAIN_NOTICE_MS:-4000}"
for arg in "$@"; do
  case $arg in
    --with-browser|--with-browser-local)
      DEPLOY_BROWSER_LOCAL="true"
      ;;
    --force-drain)
      FORCE_DRAIN="true"
      ;;
    --force-drain-notice-ms=*)
      FORCE_DRAIN="true"
      FORCE_DRAIN_NOTICE_MS="${arg#*=}"
      ;;
    --preflight-only|--dry-run)
      PREFLIGHT_ONLY="true"
      ;;
    --preflight-config-only)
      PREFLIGHT_ONLY="true"
      PREFLIGHT_CONFIG_ONLY="true"
      ;;
  esac
done

if ! [[ "$FORCE_DRAIN_NOTICE_MS" =~ ^[0-9]+$ ]]; then
  echo "FORCE_DRAIN_NOTICE_MS must be a non-negative integer (milliseconds)." >&2
  exit 1
fi

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="${ROOT_DIR}/.env"
SFU_ENV_FILE="${ROOT_DIR}/packages/sfu/.env"
COMPOSE_FILE="${ROOT_DIR}/docker-compose.sfu.yml"

if [[ ! -f "$ENV_FILE" ]]; then
  echo "Missing .env at ${ENV_FILE}" >&2
  exit 1
fi

if [[ ! -f "$COMPOSE_FILE" ]]; then
  echo "Missing ${COMPOSE_FILE}" >&2
  exit 1
fi

set -a
# shellcheck disable=SC1090
source "$ENV_FILE"
if [[ -f "$SFU_ENV_FILE" ]]; then
  # shellcheck disable=SC1090
  source "$SFU_ENV_FILE"
fi
set +a

if [[ -z "${SFU_SECRET:-}" ]]; then
  echo "SFU_SECRET is required in .env" >&2
  exit 1
fi

HAS_UPSTASH="false"
if [[ -n "${UPSTASH_REDIS_REST_URL:-}" && -n "${UPSTASH_REDIS_REST_TOKEN:-}" ]]; then
  HAS_UPSTASH="true"
fi

if [[ "$HAS_UPSTASH" != "true" && -z "${REDIS_PASSWORD:-}" && -z "${REDIS_URL:-}" && -z "${SFU_REDIS_URL:-}" ]]; then
  echo "REDIS_PASSWORD, REDIS_URL, or SFU_REDIS_URL is required in .env when not using Upstash" >&2
  exit 1
fi

trim() {
  local value="$1"
  value="${value#"${value%%[![:space:]]*}"}"
  value="${value%"${value##*[![:space:]]}"}"
  printf "%s" "$value"
}

get_pool_entry() {
  local pool="$1"
  local id="$2"
  if [[ -n "$pool" ]]; then
    IFS=',' read -ra entries <<< "$pool"
    for entry in "${entries[@]}"; do
      entry="$(trim "$entry")"
      if [[ "$entry" == "$id="* ]]; then
        trim "${entry#*=}"
        return 0
      fi
    done
  fi
  return 1
}

get_pool_list_entry() {
  local pool="$1"
  local index="$2"
  local current_index=0
  if [[ -n "$pool" ]]; then
    IFS=',' read -ra entries <<< "$pool"
    for entry in "${entries[@]}"; do
      entry="$(trim "$entry")"
      if [[ -z "$entry" || "$entry" == *"="* ]]; then
        continue
      fi
      current_index=$((current_index + 1))
      if [[ "$current_index" == "$index" ]]; then
        printf "%s" "$entry"
        return 0
      fi
    done
  fi
  return 1
}

get_deploy_url() {
  local id="$1"
  local pooled=""
  pooled="$(get_pool_entry "${SFU_DEPLOY_POOL:-}" "$id" || true)"
  if [[ -z "$pooled" ]]; then
    pooled="$(get_pool_entry "${SFU_POOL:-}" "$id" || true)"
  fi
  if [[ -n "$pooled" ]]; then
    printf "%s" "$pooled"
    return 0
  fi

  if [[ "$id" == "sfu-a" ]]; then
    printf "%s" "${SFU_A_URL:-http://127.0.0.1:3031}"
  else
    printf "%s" "${SFU_B_URL:-http://127.0.0.1:3032}"
  fi
}

is_local_url() {
  local url="$1"
  [[ "$url" =~ ^https?://(127\.0\.0\.1|localhost)(:|/|$) ]]
}

get_public_url() {
  local id="$1"
  local deploy_url="$2"
  local pooled=""
  local list_index="1"
  if [[ "$id" == "sfu-b" ]]; then
    list_index="2"
  fi
  pooled="$(get_pool_entry "${SFU_PUBLIC_POOL:-}" "$id" || true)"
  if [[ -z "$pooled" ]]; then
    pooled="$(get_pool_entry "${SFU_PUBLIC_URLS:-}" "$id" || true)"
  fi
  if [[ -z "$pooled" ]]; then
    pooled="$(get_pool_entry "${SFU_URLS:-}" "$id" || true)"
  fi
  if [[ -z "$pooled" ]]; then
    pooled="$(get_pool_list_entry "${SFU_PUBLIC_URLS:-}" "$list_index" || true)"
  fi
  if [[ -z "$pooled" ]]; then
    pooled="$(get_pool_list_entry "${SFU_URLS:-}" "$list_index" || true)"
  fi
  if [[ -n "$pooled" ]]; then
    printf "%s" "$pooled"
    return 0
  fi

  if [[ "$id" == "sfu-a" && -n "${SFU_A_PUBLIC_URL:-}" ]]; then
    printf "%s" "${SFU_A_PUBLIC_URL}"
    return 0
  fi
  if [[ "$id" == "sfu-b" && -n "${SFU_B_PUBLIC_URL:-}" ]]; then
    printf "%s" "${SFU_B_PUBLIC_URL}"
    return 0
  fi

  if ! is_local_url "$deploy_url"; then
    printf "%s" "$deploy_url"
  fi
}

json_field() {
  local field="$1"
  node -e "const fs=require('fs');const data=JSON.parse(fs.readFileSync(0,'utf8'));const val=data['$field'];if(typeof val==='boolean'){console.log(val?'true':'false');}else if(val===undefined||val===null){console.log('');}else{console.log(val);}"
}

redis_url_host() {
  node -e "try{const value=process.env.SFU_REDIS_URL||process.env.REDIS_URL||'';const url=new URL(value);console.log(url.host||'configured Redis');}catch{console.log('configured Redis');}"
}

status_json() {
  local url="$1"
  curl -fsS --connect-timeout 3 --max-time 5 -H "x-sfu-secret: ${SFU_SECRET}" "${url}/status" 2>/dev/null || true
}

validate_public_route() {
  local id="$1"
  local url="$2"
  if [[ -z "$url" ]]; then
    echo "No public URL configured for ${id}; cross-SFU join redirects will omit redirectUrl." >&2
    return 0
  fi

  local status=""
  status="$(status_json "$url")"
  if [[ -z "$status" ]]; then
    echo "Public URL for ${id} is not reachable yet: ${url}" >&2
    return 0
  fi

  local instance_id=""
  instance_id="$(printf "%s" "$status" | json_field instanceId || true)"
  if [[ "$instance_id" != "$id" ]]; then
    echo "Public URL for ${id} returned instance '${instance_id:-unknown}': ${url}" >&2
  fi
}

SFU_A_URL="$(get_deploy_url "sfu-a")"
SFU_B_URL="$(get_deploy_url "sfu-b")"
SFU_A_PUBLIC_URL="$(get_public_url "sfu-a" "$SFU_A_URL")"
SFU_B_PUBLIC_URL="$(get_public_url "sfu-b" "$SFU_B_URL")"
export SFU_A_PUBLIC_URL
export SFU_B_PUBLIC_URL

COMPOSE_ENV_FILES=(--env-file "$ENV_FILE")
if [[ -f "$SFU_ENV_FILE" ]]; then
  COMPOSE_ENV_FILES+=(--env-file "$SFU_ENV_FILE")
fi
COMPOSE=(docker compose "${COMPOSE_ENV_FILES[@]}" -f "$COMPOSE_FILE")
# The SFU image runs as the unprivileged node user. Containers from earlier
# images ran as root and left root-owned files (the SQLite database among them)
# in the recordings volume. Hand anything node does not own over before a new
# container starts. Safe to repeat; it only touches mismatched files.
# Compose drops every capability, so root also needs DAC_READ_SEARCH to walk
# directories it does not own.
#
# Older images fell back to JSON files in the container layer when SQLite was
# locked. Before the old container stops, its files are copied out, sent to the
# folder the new image names (CONCLAVE_FALLBACK_IMPORT_DIR) and checked there
# by SHA-256; after the stop they are copied again and resent if they changed.
sha256_file() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | cut -d' ' -f1
  else
    shasum -a 256 "$1" | cut -d' ' -f1
  fi
}

normalize_container_path() {
  local part
  local -a parts=() kept=()
  IFS='/' read -r -a parts <<<"$1"
  for part in "${parts[@]}"; do
    case "$part" in
      "" | .) ;;
      ..) (( ${#kept[@]} > 0 )) && kept=("${kept[@]:0:${#kept[@]}-1}") ;;
      *) kept+=("$part") ;;
    esac
  done
  local IFS=/
  printf '/%s\n' "${kept[*]}"
}

container_setting() {
  local value
  value="$(sed -n "s/^$2=//p" <<<"$1" | tail -n 1)"
  value="${value#"${value%%[![:space:]]*}"}"
  printf '%s' "${value%"${value##*[![:space:]]}"}"
}

container_file_path() {
  if [[ "$2" == /* ]]; then
    normalize_container_path "$2"
  else
    normalize_container_path "$1/$2"
  fi
}

store_file_paths() {
  local container="$1" workdir env_lines entry store prefix value shared recordings
  workdir="$(docker inspect --format '{{.Config.WorkingDir}}' "$container")" || return 1
  env_lines="$(docker inspect --format '{{range .Config.Env}}{{println .}}{{end}}' "$container")" || return 1
  shared="$(container_setting "$env_lines" CONCLAVE_SQLITE_PATH)"
  recordings="$(container_setting "$env_lines" RECORDING_STORAGE_PATH)"
  for entry in scheduling:SCHEDULING scheduled-meetings:SCHEDULED_MEETINGS scheduled-webinars:SCHEDULED_WEBINARS; do
    store="${entry%%:*}"
    prefix="${entry#*:}"
    value="$(container_setting "$env_lines" "${prefix}_PATH")"
    printf 'json %s.json %s\n' "$store" "$(container_file_path "$workdir" "${value:-data/${store}.json}")"
    value="$(container_setting "$env_lines" "${prefix}_SQLITE_PATH")"
    value="${value:-$shared}"
    if [[ -z "$value" && -n "$recordings" ]]; then
      value="${recordings}/conclave.sqlite"
    fi
    printf 'sqlite %s %s\n' "$store" "$(container_file_path "$workdir" "${value:-data/conclave.sqlite}")"
  done
}

collect_fallback_json() {
  local service="$1" container="$2" dir="$3" changes paths name path
  mkdir -p "$dir"
  if ! changes="$(docker diff "$container")"; then
    echo "Could not list the files the old ${service} container wrote." >&2
    return 1
  fi
  if ! paths="$(store_file_paths "$container")"; then
    echo "Could not read where the old ${service} container kept its stores." >&2
    return 1
  fi
  while read -r kind name path; do
    [[ "$kind" == json ]] || continue
    grep -qxF -e "A ${path}" -e "C ${path}" <<<"$changes" || continue
    if ! docker cp "${container}:${path}" "${dir}/${name}"; then
      echo "Could not copy ${name} out of the old ${service} container." >&2
      return 1
    fi
    chmod 0600 "${dir}/${name}"
  done <<<"$paths"
}

fallback_fingerprint() {
  local file
  for file in "$1"/*.json; do
    [[ -e "$file" ]] && printf '%s %s\n' "${file##*/}" "$(sha256_file "$file")"
  done
  return 0
}

fallback_receiver() {
  printf '%s' 'umask 077 && own() { chown node:node "$@" && chmod 0700 "$@"; } && base=${CONCLAVE_FALLBACK_IMPORT_DIR:?} && case "$3" in ""|.*|*[!A-Za-z0-9._-]*) echo "The archive name $3 is not safe to use." >&2; exit 1;; esac && case "$4" in ""|*[!A-Za-z0-9]*) echo "The transfer id $4 is not safe to use." >&2; exit 1;; esac && folder=$base/$1 && dest=$folder/$3 && incoming=$base/.incoming-$1-$3-$4 && mkdir -p "$base" && own "$base" && mkdir -p "$folder" && own "$folder" && find "$base" -mindepth 1 -maxdepth 1 -type d -name ".incoming-*" -mmin +30 -exec rm -rf {} + && if [ -e "$dest" ]; then echo "$dest already exists, and a saved copy is never replaced." >&2; exit 1; fi && mkdir "$incoming" && own "$incoming" && trap '"'"'rm -rf "$incoming"'"'"' EXIT && cat > "$incoming/payload.tar" && got=$(sha256sum "$incoming/payload.tar" | cut -d" " -f1) && if [ "$got" != "$2" ]; then echo "The fallback files arrived with checksum $got, not $2." >&2; rm -rf "$incoming"; exit 1; fi && mkdir "$incoming/files" && own "$incoming/files" && tar -xf "$incoming/payload.tar" -C "$incoming/files" && rm "$incoming/payload.tar" && chown node:node "$incoming/files"/*.json && chmod 0600 "$incoming/files"/*.json && mv "$incoming/files" "$dest" && rmdir "$incoming" && chown -R node:node "$base"'
}

archive_stamp() {
  node -e 'process.stdout.write(new Date().toISOString().replace(/[-:.]/g, ""))'
}

send_fallback_json() {
  local service="$1" dir="$2" archive checksum file name transfer
  local -a names=()
  for file in "$dir"/*.json; do
    [[ -e "$file" ]] && names+=("${file##*/}")
  done
  (( ${#names[@]} > 0 )) || return 0
  archive="${dir}.tar"
  tar -C "$dir" -cf "$archive" "${names[@]}" || return 1
  checksum="$(sha256_file "$archive")"
  name="$(archive_stamp)-${SFU_DEPLOY_ID:?}"
  transfer="$(od -An -N6 -tx1 /dev/urandom | tr -d ' \n')"
  if ! "${COMPOSE[@]}" run -T --rm --no-deps --user root --cap-add CHOWN --cap-add DAC_OVERRIDE --cap-add FOWNER --entrypoint sh "$service" -c \
    "$(fallback_receiver)" sh "$service" "$checksum" "$name" "$transfer" < "$archive"; then
    echo "Could not copy the old ${service} container's JSON fallback files onto the volume." >&2
    return 1
  fi
  echo "Saved the old ${service} container's JSON fallback files on the volume as ${name} and verified them: ${names[*]}"
}

layer_sqlite_databases() {
  local container="$1" changes paths kind store path
  changes="$(docker diff "$container")" || return 1
  paths="$(store_file_paths "$container")" || return 1
  while read -r kind store path; do
    [[ "$kind" == sqlite ]] || continue
    if grep -qxF -e "A ${path}" -e "C ${path}" <<<"$changes"; then
      printf '%s %s\n' "$store" "$path"
    fi
  done <<<"$paths"
}

sqlite_target_probe() {
  printf '%s' 'lines=$(node --import tsx server/storePaths.ts) || exit 1; printf "%s\n" "$lines" | while read -r kind store target; do [ "$kind" = sqlite ] || continue; dir=$(dirname "$target"); if [ -e "$target" ] || [ -e "$target-wal" ] || [ -e "$target-journal" ]; then state=taken; elif [ -d "$dir" ] && check=$(mktemp "$dir/.conclave-write-check-XXXXXX" 2>/dev/null) && rm -f "$check"; then state=free; else state=unwritable; fi; printf "%s %s %s\n" "$store" "$state" "$target"; done'
}

sqlite_receiver() {
  printf '%s' 'umask 077 && target=$1 && case "$target" in /*) ;; *) echo "The database path $target is not absolute." >&2; exit 1;; esac && case "$3" in ""|*[!A-Za-z0-9]*) echo "The transfer id $3 is not safe to use." >&2; exit 1;; esac && dir=$(dirname "$target") && incoming=$dir/.incoming-sqlite-$3 && find "$dir" -mindepth 1 -maxdepth 1 -type d -name ".incoming-sqlite-*" -mmin +30 -exec rm -rf {} + && for existing in "$target" "$target-wal" "$target-journal"; do if [ -e "$existing" ]; then echo "$existing already exists, and a database is never replaced." >&2; exit 1; fi; done && mkdir "$incoming" && chown node:node "$incoming" && trap '"'"'rm -rf "$incoming"'"'"' EXIT && cat > "$incoming/payload.tar" && got=$(sha256sum "$incoming/payload.tar" | cut -d" " -f1) && if [ "$got" != "$2" ]; then echo "The database arrived with checksum $got, not $2." >&2; exit 1; fi && tar -xf "$incoming/payload.tar" -C "$incoming" && rm "$incoming/payload.tar" && chown node:node "$incoming"/db* && chmod 0600 "$incoming"/db* && for part in -wal -journal; do if [ -e "$incoming/db$part" ]; then mv "$incoming/db$part" "$target$part" || exit 1; fi; done && mv "$incoming/db" "$target" && rmdir "$incoming"'
}

plan_layer_sqlite() {
  local service="$1" container="$2" plan="$3" layer targets store old name state target found_state found_target
  : > "$plan"
  if ! layer="$(layer_sqlite_databases "$container")"; then
    echo "Could not list the databases the old ${service} container kept." >&2
    return 1
  fi
  [[ -n "$layer" ]] || return 0
  if ! targets="$("${COMPOSE[@]}" run -T --rm --no-deps --user root --cap-add DAC_OVERRIDE --entrypoint sh "$service" -c "$(sqlite_target_probe)")"; then
    echo "Could not check where the new ${service} keeps its databases." >&2
    return 1
  fi
  while read -r store old; do
    found_state=""
    found_target=""
    while read -r name state target; do
      if [[ "$name" == "$store" ]]; then
        found_state="$state"
        found_target="$target"
      fi
    done <<<"$targets"
    case "$found_state" in
      free) printf '%s\t%s\n' "$old" "$found_target" >> "$plan" ;;
      taken)
        echo "The old ${service} container keeps the ${store} database at ${old} inside the container, not on the volume, and ${found_target} on the volume already holds a database, so a copy cannot carry it over. Copy it out with: docker cp ${container}:${old} <file>, merge it into ${found_target}, then deploy again." >&2
        return 1 ;;
      unwritable)
        echo "The old ${service} container keeps the ${store} database at ${old} inside the container, not on the volume, and the new image would keep it at ${found_target}, which the new container cannot write. Point CONCLAVE_SQLITE_PATH (or the store's own *_SQLITE_PATH) at the recordings volume, then deploy again." >&2
        return 1 ;;
      *)
        echo "Could not tell where the new ${service} keeps the ${store} database." >&2
        return 1 ;;
    esac
  done <<<"$layer"
  sort -u -o "$plan" "$plan"
  target="$(cut -f2 "$plan" | sort | uniq -d | head -n 1)"
  if [[ -n "$target" ]]; then
    echo "The old ${service} container keeps more than one database inside the container that the new image would keep at ${target}, so a copy cannot carry them over. Merge them into ${target}, then deploy again." >&2
    return 1
  fi
}

carry_layer_sqlite() {
  local service="$1" container="$2" dir="$3" plan="$4" changes layer store old target part folder archive checksum transfer index=0
  [[ -s "$plan" ]] || return 0
  if ! changes="$(docker diff "$container")" || ! layer="$(layer_sqlite_databases "$container")"; then
    echo "Could not list the databases the old ${service} container kept." >&2
    return 1
  fi
  while read -r store old; do
    if ! cut -f1 "$plan" | grep -qxF -e "$old"; then
      echo "The old ${service} container started keeping a database at ${old} after the deploy checked it." >&2
      return 1
    fi
  done <<<"$layer"
  while IFS=$'\t' read -r old target; do
    index=$((index + 1))
    folder="${dir}/${index}"
    mkdir -p "$folder"
    local -a parts=()
    for part in "" -wal -journal; do
      if [[ -n "$part" ]] && ! grep -qxF -e "A ${old}${part}" -e "C ${old}${part}" <<<"$changes"; then
        continue
      fi
      if ! docker cp "${container}:${old}${part}" "${folder}/db${part}"; then
        echo "Could not copy ${old}${part} out of the old ${service} container." >&2
        return 1
      fi
      chmod 0600 "${folder}/db${part}"
      parts+=("db${part}")
    done
    archive="${folder}.tar"
    tar -C "$folder" -cf "$archive" "${parts[@]}" || return 1
    checksum="$(sha256_file "$archive")"
    transfer="$(od -An -N6 -tx1 /dev/urandom | tr -d ' \n')"
    if ! "${COMPOSE[@]}" run -T --rm --no-deps --user root --cap-add CHOWN --cap-add DAC_OVERRIDE --cap-add FOWNER --entrypoint sh "$service" -c \
      "$(sqlite_receiver)" sh "$target" "$checksum" "$transfer" < "$archive"; then
      echo "Could not copy the old ${service} container's database ${old} to ${target} on the volume." >&2
      return 1
    fi
    echo "Copied the old ${service} container's database ${old} to ${target} on the volume and verified it: ${parts[*]}"
  done < "$plan"
}

sfu_answers_as_deployed() {
  local service="$1" url="$2" health
  health="$(curl -fsS --connect-timeout 2 --max-time 5 "${url}/health" 2>/dev/null)" || return 1
  printf '%s' "$health" | SERVICE="$service" DEPLOY_ID="${SFU_DEPLOY_ID:?}" node -e 'let body = ""; process.stdin.on("data", (chunk) => (body += chunk)).on("end", () => { let health = null; try { health = JSON.parse(body); } catch {} process.exit(health?.status === "healthy" && health.instanceId === process.env.SERVICE && health.deployId === process.env.DEPLOY_ID ? 0 : 1); });'
}

wait_for_sfu() {
  local service="$1" url="$2" deadline
  deadline=$(( $(date +%s) + ${SFU_HEALTH_TIMEOUT_SECONDS:-180} ))
  until sfu_answers_as_deployed "$service" "$url"; do
    if (( $(date +%s) >= deadline )); then
      return 1
    fi
    sleep "${SFU_HEALTH_POLL_SECONDS:-2}"
  done
}

build_and_start() (
  local service="$1" url="$2" container staging
  umask 077
  "${COMPOSE[@]}" build "$service"
  container="$("${COMPOSE[@]}" ps -a -q "$service" | head -n 1)"
  staging="$(mktemp -d)"
  trap 'rm -rf "$staging"' EXIT
  if [[ -n "$container" ]] && ! { plan_layer_sqlite "$service" "$container" "$staging/sqlite-plan" && collect_fallback_json "$service" "$container" "$staging/before" && send_fallback_json "$service" "$staging/before"; }; then
    echo "Stopped before replacing ${service}; nothing was stopped." >&2
    exit 1
  fi
  "${COMPOSE[@]}" stop "$service"
  "${COMPOSE[@]}" run --rm --no-deps --user root --cap-add CHOWN --cap-add DAC_READ_SEARCH --entrypoint find "$service" \
    /var/lib/conclave/recordings \( ! -user node -o ! -group node \) -exec chown node:node {} +
  if [[ -n "$container" ]]; then
    if ! collect_fallback_json "$service" "$container" "$staging/after" ||
      { [[ "$(fallback_fingerprint "$staging/before")" != "$(fallback_fingerprint "$staging/after")" ]] && ! send_fallback_json "$service" "$staging/after"; } ||
      ! carry_layer_sqlite "$service" "$container" "$staging/sqlite" "$staging/sqlite-plan"; then
      echo "Stopped before replacing ${service}. Its old container is stopped, not removed; start it again with: ${COMPOSE[*]} start ${service}" >&2
      exit 1
    fi
  fi
  "${COMPOSE[@]}" up -d "$service"
  echo "Waiting for the new ${service} to answer healthy at ${url} as deploy ${SFU_DEPLOY_ID}..."
  if ! wait_for_sfu "$service" "$url"; then
    echo "The new ${service} did not answer healthy at ${url} as deploy ${SFU_DEPLOY_ID} within ${SFU_HEALTH_TIMEOUT_SECONDS:-180} seconds. Stopping it; nothing was drained, and the other SFU keeps serving." >&2
    "${COMPOSE[@]}" stop "$service" || true
    exit 1
  fi
)

refuse_divided_layer_databases() {
  local service container layer
  local -a holders=()
  for service in "$@"; do
    container="$("${COMPOSE[@]}" ps -a -q "$service" | head -n 1)"
    [[ -n "$container" ]] || continue
    if ! layer="$(layer_sqlite_databases "$container")"; then
      echo "Could not list the databases the old ${service} container kept. Nothing was changed." >&2
      return 1
    fi
    [[ -n "$layer" ]] && holders+=("$service")
  done
  if (( ${#holders[@]} > 1 )); then
    echo "The old ${holders[*]} containers each keep their own database inside the container, not on the volume. A copy can carry over only one of them, so nothing was changed. Merge them into one database on the recordings volume, then deploy again." >&2
    return 1
  fi
}

HAS_REDIS_SERVICE="false"
if "${COMPOSE[@]}" config --services | rg -x "redis" >/dev/null 2>&1; then
  HAS_REDIS_SERVICE="true"
fi

echo "Using SFU A deploy URL: ${SFU_A_URL}"
echo "Using SFU B deploy URL: ${SFU_B_URL}"
echo "Using SFU A public URL: ${SFU_A_PUBLIC_URL:-<unset>}"
echo "Using SFU B public URL: ${SFU_B_PUBLIC_URL:-<unset>}"

run_deploy_preflight() {
  local preflight=(node "${ROOT_DIR}/scripts/deploy-sfu-preflight.mjs" --compose-json -)
  if [[ -n "${SFU_DEPLOY_SERVICES:-}" ]]; then
    preflight+=(--services "${SFU_DEPLOY_SERVICES}")
  fi
  # A normal deployment must be able to revive a stopped inactive SFU, so its
  # pre-mutation gate validates rendered configuration only. Explicit
  # --preflight-only remains the operator-facing live route check.
  if [[ "$PREFLIGHT_CONFIG_ONLY" == "true" || "$PREFLIGHT_ONLY" != "true" ]]; then
    preflight+=(--config-only)
  fi

  # `docker compose config` only renders local configuration. In explicit live
  # preflight mode, the Node probe makes GET-only health/status requests.
  "${COMPOSE[@]}" config --format json | "${preflight[@]}"
}

echo "Running fail-closed SFU deployment preflight..."
run_deploy_preflight
if [[ "$DEPLOY_BROWSER_LOCAL" == "true" ]]; then
  # The browser service deploys last, after both SFUs changed; refuse its
  # configuration now rather than after the SFU swap.
  "${ROOT_DIR}/scripts/deploy-browser-service.sh" --check-config
fi
if [[ "$PREFLIGHT_ONLY" == "true" ]]; then
  echo "Preflight-only run complete; no code, container, drain, or DNS changes were made."
  exit 0
fi

echo "Pulling latest code..."
git -C "$ROOT_DIR" pull

SFU_DEPLOY_ID="sfu-$(date -u +%Y%m%dT%H%M%SZ)-$(od -An -N4 -tx1 /dev/urandom | tr -d ' \n')"
export SFU_DEPLOY_ID
echo "Deploy id: ${SFU_DEPLOY_ID}"

# SFU dependencies are installed inside the Docker image; the host does not need them.
# (Previously this step tried `npm -C packages/sfu install` on the host, which fails on
#  hosts without Node and is unnecessary because the build context COPYs the source in.)

if [[ "$HAS_UPSTASH" == "true" ]]; then
  echo "Using Upstash Redis; skipping local Redis container."
elif [[ -n "${SFU_REDIS_URL:-}" || -n "${REDIS_URL:-}" ]]; then
  echo "Using Redis at $(redis_url_host); skipping compose Redis container."
elif [[ "$HAS_REDIS_SERVICE" == "true" ]]; then
  echo "Ensuring Redis is running..."
  "${COMPOSE[@]}" up -d redis
else
  echo "Redis service not present in ${COMPOSE_FILE}; using host Redis credentials from .env."
fi

STATUS_A="$(status_json "$SFU_A_URL")"
STATUS_B="$(status_json "$SFU_B_URL")"

ROOMS_A="0"
ROOMS_B="0"
DRAINING_A="unknown"
DRAINING_B="unknown"
HAS_STATUS_A="false"
HAS_STATUS_B="false"

if [[ -n "$STATUS_A" ]]; then
  HAS_STATUS_A="true"
  ROOMS_A="$(printf "%s" "$STATUS_A" | json_field rooms || echo "0")"
  DRAINING_A="$(printf "%s" "$STATUS_A" | json_field draining || echo "unknown")"
fi

if [[ -n "$STATUS_B" ]]; then
  HAS_STATUS_B="true"
  ROOMS_B="$(printf "%s" "$STATUS_B" | json_field rooms || echo "0")"
  DRAINING_B="$(printf "%s" "$STATUS_B" | json_field draining || echo "unknown")"
fi

ACTIVE_SERVICE=""
ACTIVE_URL=""

if [[ "$HAS_STATUS_A" == "true" && "$HAS_STATUS_B" == "true" ]]; then
  if (( ROOMS_A > 0 && ROOMS_B == 0 )); then
    ACTIVE_SERVICE="sfu-a"
    ACTIVE_URL="$SFU_A_URL"
  elif (( ROOMS_B > 0 && ROOMS_A == 0 )); then
    ACTIVE_SERVICE="sfu-b"
    ACTIVE_URL="$SFU_B_URL"
  elif [[ "$DRAINING_A" == "false" && "$DRAINING_B" == "true" ]]; then
    ACTIVE_SERVICE="sfu-a"
    ACTIVE_URL="$SFU_A_URL"
  elif [[ "$DRAINING_B" == "false" && "$DRAINING_A" == "true" ]]; then
    ACTIVE_SERVICE="sfu-b"
    ACTIVE_URL="$SFU_B_URL"
  else
    ACTIVE_SERVICE="sfu-a"
    ACTIVE_URL="$SFU_A_URL"
  fi
elif [[ "$HAS_STATUS_A" == "true" ]]; then
  ACTIVE_SERVICE="sfu-a"
  ACTIVE_URL="$SFU_A_URL"
elif [[ "$HAS_STATUS_B" == "true" ]]; then
  ACTIVE_SERVICE="sfu-b"
  ACTIVE_URL="$SFU_B_URL"
else
  ACTIVE_SERVICE="sfu-a"
  ACTIVE_URL="$SFU_A_URL"
fi

if [[ "$ACTIVE_SERVICE" == "sfu-a" ]]; then
  INACTIVE_SERVICE="sfu-b"
  INACTIVE_URL="$SFU_B_URL"
  ACTIVE_ROOMS="$ROOMS_A"
else
  INACTIVE_SERVICE="sfu-a"
  INACTIVE_URL="$SFU_A_URL"
  ACTIVE_ROOMS="$ROOMS_B"
fi

echo "Active service: ${ACTIVE_SERVICE}"
echo "Inactive service: ${INACTIVE_SERVICE}"

refuse_divided_layer_databases sfu-a sfu-b || exit 1

echo "Building and starting ${INACTIVE_SERVICE}..."
build_and_start "$INACTIVE_SERVICE" "$INACTIVE_URL"
if [[ "$INACTIVE_SERVICE" == "sfu-a" ]]; then
  validate_public_route "sfu-a" "$SFU_A_PUBLIC_URL"
else
  validate_public_route "sfu-b" "$SFU_B_PUBLIC_URL"
fi

FORCED_DRAIN_ACTIVE="false"
if [[ "$ACTIVE_SERVICE" == "sfu-a" && "$HAS_STATUS_A" != "true" ]]; then
  echo "Active SFU not reachable; skipping drain."
elif [[ "$ACTIVE_SERVICE" == "sfu-b" && "$HAS_STATUS_B" != "true" ]]; then
  echo "Active SFU not reachable; skipping drain."
elif [[ -n "$ACTIVE_URL" ]]; then
  echo "Draining ${ACTIVE_SERVICE}..."
  DRAIN_PAYLOAD='{"draining": true}'
  if [[ "$FORCE_DRAIN" == "true" ]]; then
    if [[ "$ACTIVE_ROOMS" =~ ^[0-9]+$ && "$ACTIVE_ROOMS" -gt 0 ]]; then
      echo "Force drain enabled; notifying clients before disconnecting active rooms."
    else
      echo "Force drain enabled; no active rooms detected at pre-check."
    fi
    DRAIN_PAYLOAD="{\"draining\": true, \"force\": true, \"noticeMs\": ${FORCE_DRAIN_NOTICE_MS}}"
  fi
  DRAIN_RESPONSE=""
  if DRAIN_RESPONSE="$(curl -fsS -X POST "${ACTIVE_URL}/drain" \
    -H "x-sfu-secret: ${SFU_SECRET}" \
    -H "content-type: application/json" \
    -d "${DRAIN_PAYLOAD}")"; then
    if [[ "$FORCE_DRAIN" == "true" ]]; then
      forced_result="$(printf "%s" "$DRAIN_RESPONSE" | json_field forced || echo "false")"
      if [[ "$forced_result" == "true" ]]; then
        FORCED_DRAIN_ACTIVE="true"
      else
        echo "Force drain was requested but was not applied by ${ACTIVE_SERVICE}."
      fi
    fi
  else
    echo "Failed to drain ${ACTIVE_SERVICE}; continuing." >&2
  fi
fi

DRAIN_TIMEOUT_SECONDS="${DRAIN_TIMEOUT_SECONDS:-3600}"
DRAIN_POLL_SECONDS="${DRAIN_POLL_SECONDS:-10}"

if [[ "$FORCED_DRAIN_ACTIVE" == "true" ]]; then
  echo "Force drain requested; skipping room-drain wait."
elif [[ -n "$ACTIVE_URL" && "$HAS_STATUS_A" == "true" && "$ACTIVE_SERVICE" == "sfu-a" ]] || \
   [[ -n "$ACTIVE_URL" && "$HAS_STATUS_B" == "true" && "$ACTIVE_SERVICE" == "sfu-b" ]]; then
  echo "Waiting for ${ACTIVE_SERVICE} rooms to drain..."
  start_ts="$(date +%s)"
  while true; do
    status="$(status_json "$ACTIVE_URL")"
    rooms="0"
    if [[ -n "$status" ]]; then
      rooms="$(printf "%s" "$status" | json_field rooms || echo "0")"
    fi
    echo "Active rooms: ${rooms}"
    if [[ "$rooms" == "0" ]]; then
      break
    fi
    now_ts="$(date +%s)"
    if (( now_ts - start_ts > DRAIN_TIMEOUT_SECONDS )); then
      echo "Timed out waiting for rooms to drain." >&2
      exit 1
    fi
    sleep "$DRAIN_POLL_SECONDS"
  done
fi

echo "Rebuilding and starting ${ACTIVE_SERVICE}..."
build_and_start "$ACTIVE_SERVICE" "$ACTIVE_URL"
if [[ "$ACTIVE_SERVICE" == "sfu-a" ]]; then
  validate_public_route "sfu-a" "$SFU_A_PUBLIC_URL"
else
  validate_public_route "sfu-b" "$SFU_B_PUBLIC_URL"
fi

if [[ "$DEPLOY_BROWSER_LOCAL" == "true" ]]; then
  echo ""
  echo "=== Deploying Browser Service (local) ==="
  "${ROOT_DIR}/scripts/deploy-browser-service.sh"
fi

echo ""
echo "SFU deploy complete."
if [[ "$DEPLOY_BROWSER_LOCAL" == "true" ]]; then
  echo "Browser service deploy complete."
fi
