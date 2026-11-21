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
    printf "%s" "${SFU_A_URL:-http://127.0.0.1:${SFU_A_PORT:-3031}}"
  elif [[ "$id" == "sfu-b" ]]; then
    printf "%s" "${SFU_B_URL:-http://127.0.0.1:${SFU_B_PORT:-3032}}"
  else
    printf "http://127.0.0.1:%s" "$(compose_service_env "$id" SFU_PORT)"
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

# Reads one environment value of one service from the rendered compose file.
compose_service_env() {
  printf "%s" "$COMPOSE_JSON" | node -e "const c=JSON.parse(require('fs').readFileSync(0,'utf8'));const env=c.services?.[process.argv[1]]?.environment??{};const v=Array.isArray(env)?(env.find((e)=>e.startsWith(process.argv[2]+'='))??'').slice(process.argv[2].length+1):env[process.argv[2]];console.log(v??'');" "$1" "$2"
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

SFU_A_PUBLIC_URL="$(get_public_url "sfu-a" "$(get_deploy_url "sfu-a")")"
SFU_B_PUBLIC_URL="$(get_public_url "sfu-b" "$(get_deploy_url "sfu-b")")"
export SFU_A_PUBLIC_URL
export SFU_B_PUBLIC_URL

COMPOSE_ENV_FILES=(--env-file "$ENV_FILE")
if [[ -f "$SFU_ENV_FILE" ]]; then
  COMPOSE_ENV_FILES+=(--env-file "$SFU_ENV_FILE")
fi
COMPOSE=(docker compose "${COMPOSE_ENV_FILES[@]}" -f "$COMPOSE_FILE")
HAS_REDIS_SERVICE="false"
if "${COMPOSE[@]}" config --services | rg -x "redis" >/dev/null 2>&1; then
  HAS_REDIS_SERVICE="true"
fi

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
if [[ "$PREFLIGHT_ONLY" == "true" ]]; then
  echo "Preflight-only run complete; no code, container, drain, or DNS changes were made."
  exit 0
fi

echo "Pulling latest code..."
git -C "$ROOT_DIR" pull
TARGET_COMMIT="$(git -C "$ROOT_DIR" rev-parse --short=12 HEAD)"

# SFU dependencies are installed inside the Docker image; the host does not need them.

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

# The pulled compose file decides the services, ports and image names.
COMPOSE_JSON="$("${COMPOSE[@]}" config --format json)"
if [[ -n "${SFU_DEPLOY_SERVICES:-}" ]]; then
  IFS=',' read -ra SERVICES <<< "${SFU_DEPLOY_SERVICES// /}"
else
  read -ra SERVICES <<< "$(printf "%s" "$COMPOSE_JSON" | node -e "const c=JSON.parse(require('fs').readFileSync(0,'utf8'));const env=(s)=>Array.isArray(s.environment)?Object.fromEntries(s.environment.map((e)=>e.split('='))):(s.environment??{});console.log(Object.entries(c.services).filter(([,s])=>env(s).SFU_INSTANCE_ID).map(([n])=>n).join(' '));")"
fi

DRAIN_TIMEOUT_SECONDS="${DRAIN_TIMEOUT_SECONDS:-3600}"
DRAIN_POLL_SECONDS="${DRAIN_POLL_SECONDS:-10}"
HEALTH_TIMEOUT_SECONDS="${HEALTH_TIMEOUT_SECONDS:-120}"
# Exit code when a meeting outlasts the drain deadline: nothing was rebuilt
# under it, and rerunning the deploy later finishes the job.
EXIT_BLOCKED_BY_ROOMS=3

service_url() {
  get_deploy_url "$1"
}

service_public_url() {
  case "$1" in
    sfu-a) printf "%s" "$SFU_A_PUBLIC_URL" ;;
    sfu-b) printf "%s" "$SFU_B_PUBLIC_URL" ;;
    *) compose_service_env "$1" SFU_PUBLIC_URL ;;
  esac
}

service_image_name() {
  "${COMPOSE[@]}" config --images "$1" | head -n 1
}

service_container() {
  "${COMPOSE[@]}" ps -aq "$1" 2>/dev/null | head -n 1
}

service_rooms() {
  local status
  status="$(status_json "$(service_url "$1")")"
  if [[ -z "$status" ]]; then
    echo "0"
  else
    printf "%s" "$status" | json_field rooms
  fi
}

set_draining() {
  local url="$1"
  local payload="{\"draining\": $2}"
  if [[ "$2" == "true" && "$FORCE_DRAIN" == "true" ]]; then
    payload="{\"draining\": true, \"force\": true, \"noticeMs\": ${FORCE_DRAIN_NOTICE_MS}}"
  fi
  curl -fsS --connect-timeout 3 --max-time 10 -X POST "${url}/drain" \
    -H "x-sfu-secret: ${SFU_SECRET}" \
    -H "content-type: application/json" \
    -d "$payload"
}

# Waits for an instance to report zero rooms. Returns 1 at the deadline.
wait_for_empty() {
  local svc="$1"
  local url="$2"
  local start_ts
  start_ts="$(date +%s)"
  while true; do
    local status rooms
    status="$(status_json "$url")"
    rooms="0"
    if [[ -n "$status" ]]; then
      rooms="$(printf "%s" "$status" | json_field rooms || echo "0")"
    fi
    echo "${svc} active rooms: ${rooms}"
    if [[ "$rooms" == "0" ]]; then
      return 0
    fi
    if (( $(date +%s) - start_ts >= DRAIN_TIMEOUT_SECONDS )); then
      return 1
    fi
    sleep "$DRAIN_POLL_SECONDS"
  done
}

wait_for_healthy() {
  local url="$1"
  local start_ts
  start_ts="$(date +%s)"
  until curl -fsS --connect-timeout 2 --max-time 3 "${url}/health" 2>/dev/null | json_field status | grep -qx healthy; do
    if (( $(date +%s) - start_ts >= HEALTH_TIMEOUT_SECONDS )); then
      return 1
    fi
    sleep 1
  done
}

# Moves one instance onto TARGET_IMAGE without cutting a call: drain it, wait
# for its rooms to finish (or give up at the deadline and put it back), and
# only then recreate it.
deploy_service() {
  local svc="$1"
  local url image_name container status
  url="$(service_url "$svc")"
  image_name="$(service_image_name "$svc")"
  container="$(service_container "$svc")"
  status="$(status_json "$url")"

  if [[ -n "$container" && -n "$status" ]] &&
     [[ "$(docker inspect -f '{{.Image}}' "$container")" == "$TARGET_IMAGE" ]] &&
     [[ "$(docker inspect -f '{{index .Config.Labels "com.docker.compose.config-hash"}}' "$container")" == "$("${COMPOSE[@]}" config --hash "$svc" | awk '{print $2}')" ]]; then
    echo "${svc} already runs ${TARGET_COMMIT} with the current config; leaving it alone."
    return 0
  fi

  if [[ -n "$status" ]]; then
    local was_draining
    was_draining="$(printf "%s" "$status" | json_field draining || echo "false")"
    echo "Draining ${svc}..."
    local drain_response=""
    if ! drain_response="$(set_draining "$url" true)"; then
      echo "Failed to drain ${svc}; not rebuilding it." >&2
      return 1
    fi
    if [[ "$FORCE_DRAIN" == "true" && "$(printf "%s" "$drain_response" | json_field forced || echo false)" == "true" ]]; then
      echo "Force drain applied to ${svc}; skipping the room wait."
    elif ! wait_for_empty "$svc" "$url"; then
      if [[ "$was_draining" != "true" ]]; then
        set_draining "$url" false >/dev/null || true
      fi
      echo "" >&2
      echo "Deploy paused: ${svc} still hosts a meeting after ${DRAIN_TIMEOUT_SECONDS}s." >&2
      echo "${svc} was not rebuilt and keeps serving its calls. Rerun this script once the meeting ends." >&2
      return "$EXIT_BLOCKED_BY_ROOMS"
    fi
  else
    echo "${svc} is not reachable; rebuilding it without a drain."
  fi

  echo "Starting ${svc} on ${TARGET_COMMIT}..."
  docker tag "$TARGET_IMAGE" "$image_name"
  "${COMPOSE[@]}" up -d --no-build --no-deps --force-recreate "$svc"
  if ! wait_for_healthy "$url"; then
    echo "${svc} did not report healthy within ${HEALTH_TIMEOUT_SECONDS}s." >&2
    return 1
  fi
  validate_public_route "$svc" "$(service_public_url "$svc")"
}

# Emptiest instance first, so the first drain usually has nothing to wait for.
ORDERED_SERVICES=()
while read -r _rooms svc; do
  ORDERED_SERVICES+=("$svc")
done < <(for svc in "${SERVICES[@]}"; do echo "$(service_rooms "$svc") $svc"; done | sort -n -k1,1 -k2,2)
echo "Deploy order: ${ORDERED_SERVICES[*]}"

echo "Building the SFU image for ${TARGET_COMMIT}..."
"${COMPOSE[@]}" build "${ORDERED_SERVICES[0]}"
TARGET_IMAGE="$(docker image inspect -f '{{.Id}}' "$(service_image_name "${ORDERED_SERVICES[0]}")")"

for svc in "${ORDERED_SERVICES[@]}"; do
  deploy_service "$svc"
done

if [[ "$DEPLOY_BROWSER_LOCAL" == "true" ]]; then
  echo ""
  echo "=== Deploying Browser Service (local) ==="
  "${ROOT_DIR}/scripts/deploy-browser-service.sh"
fi

echo ""
echo "SFU deploy complete: ${ORDERED_SERVICES[*]} on ${TARGET_COMMIT}."
if [[ "$DEPLOY_BROWSER_LOCAL" == "true" ]]; then
  echo "Browser service deploy complete."
fi
