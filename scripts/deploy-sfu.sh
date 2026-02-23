#!/usr/bin/env bash
set -euo pipefail

DEPLOY_BROWSER_LOCAL="false"
FORCE_DRAIN="false"
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
  esac
done

if ! [[ "$FORCE_DRAIN_NOTICE_MS" =~ ^[0-9]+$ ]]; then
  echo "FORCE_DRAIN_NOTICE_MS must be a non-negative integer (milliseconds)." >&2
  exit 1
fi

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="${ROOT_DIR}/.env"
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
set +a

if [[ -z "${SFU_SECRET:-}" ]]; then
  echo "SFU_SECRET is required in .env" >&2
  exit 1
fi

HAS_UPSTASH="false"
if [[ -n "${UPSTASH_REDIS_REST_URL:-}" && -n "${UPSTASH_REDIS_REST_TOKEN:-}" ]]; then
  HAS_UPSTASH="true"
fi

if [[ "$HAS_UPSTASH" != "true" && -z "${REDIS_PASSWORD:-}" ]]; then
  echo "REDIS_PASSWORD is required in .env when not using Upstash" >&2
  exit 1
fi

COMPOSE=(docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE")
HAS_REDIS_SERVICE="false"
if "${COMPOSE[@]}" config --services | rg -x "redis" >/dev/null 2>&1; then
  HAS_REDIS_SERVICE="true"
fi

trim() {
  local value="$1"
  value="${value#"${value%%[![:space:]]*}"}"
  value="${value%"${value##*[![:space:]]}"}"
  printf "%s" "$value"
}

get_pool_url() {
  local id="$1"
  local pool="${SFU_POOL:-}"
  if [[ -n "$pool" ]]; then
    IFS=',' read -ra entries <<< "$pool"
    for entry in "${entries[@]}"; do
      entry="$(trim "$entry")"
      if [[ "$entry" == "$id="* ]]; then
        printf "%s" "${entry#*=}"
        return 0
      fi
    done
  fi

  if [[ "$id" == "sfu-a" ]]; then
    printf "%s" "${SFU_A_URL:-http://127.0.0.1:3031}"
  else
    printf "%s" "${SFU_B_URL:-http://127.0.0.1:3032}"
  fi
}

json_field() {
  local field="$1"
  node -e "const fs=require('fs');const data=JSON.parse(fs.readFileSync(0,'utf8'));const val=data['$field'];if(typeof val==='boolean'){console.log(val?'true':'false');}else if(val===undefined||val===null){console.log('');}else{console.log(val);}"
}

status_json() {
  local url="$1"
  curl -fsS --connect-timeout 3 --max-time 5 -H "x-sfu-secret: ${SFU_SECRET}" "${url}/status" 2>/dev/null || true
}

SFU_A_URL="$(get_pool_url "sfu-a")"
SFU_B_URL="$(get_pool_url "sfu-b")"

echo "Using SFU A: ${SFU_A_URL}"
echo "Using SFU B: ${SFU_B_URL}"

echo "Pulling latest code..."
git -C "$ROOT_DIR" pull

echo "Installing SFU dependencies..."
npm -C "${ROOT_DIR}/packages/sfu" install

if [[ "$HAS_UPSTASH" == "true" ]]; then
  echo "Using Upstash Redis; skipping local Redis container."
elif [[ "$HAS_REDIS_SERVICE" == "true" ]]; then
  echo "Ensuring Redis is running..."
  "${COMPOSE[@]}" up -d redis
else
  echo "Redis service not present in ${COMPOSE_FILE}; skipping local Redis container."
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

echo "Building and starting ${INACTIVE_SERVICE}..."
"${COMPOSE[@]}" up -d --build "$INACTIVE_SERVICE"

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
"${COMPOSE[@]}" up -d --build "$ACTIVE_SERVICE"

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
