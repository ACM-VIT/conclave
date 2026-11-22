#!/usr/bin/env bash
# Blue-green SFU deploy. Builds one image, then moves each instance onto it in
# turn: drain, wait for its calls to end, recreate, run a real two-client
# canary call against it, and put it back into service. A failed canary rolls
# that instance back to the image it ran before, and the instances not yet
# touched keep serving. Runbook: docs/ops/sfu-deploys.md.
#
# Exit codes: 0 deployed, 3 a meeting outlasted the drain deadline (rerun
# later), 4 the canary failed and the instance was rolled back.
set -euo pipefail

DEPLOY_BROWSER_LOCAL="false"
ROLLBACK="false"
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
    --rollback)
      ROLLBACK="true"
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
# Staging deploys its single instance with docker-compose.sfu-staging.yml.
COMPOSE_FILE="${ROOT_DIR}/${SFU_COMPOSE_FILE:-docker-compose.sfu.yml}"

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

# Returns 0 once the instance's public URL reaches it, after up to
# HEALTH_TIMEOUT_SECONDS. A route that never does is a failed deploy, not a
# warning: the next drain would send new meetings to an unreachable instance.
validate_public_route() {
  local id="$1"
  local url="$2"
  if [[ -z "$url" ]]; then
    echo "No public URL configured for ${id}, so clients cannot be shown to reach it." >&2
    return 1
  fi
  local start_ts status instance_id
  start_ts="$(date +%s)"
  while true; do
    status="$(status_json "$url")"
    instance_id=""
    if [[ -n "$status" ]]; then
      instance_id="$(printf "%s" "$status" | json_field instanceId || true)"
    fi
    [[ "$instance_id" == "$id" ]] && return 0
    if (( $(date +%s) - start_ts >= HEALTH_TIMEOUT_SECONDS )); then
      if [[ -z "$status" ]]; then
        echo "Public URL for ${id} does not answer: ${url}" >&2
      else
        echo "Public URL for ${id} reaches instance '${instance_id:-unknown}' instead: ${url}" >&2
      fi
      return 1
    fi
    sleep 1
  done
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

run_deploy_preflight() {
  # Every service, whatever SFU_DEPLOY_SERVICES selects: the checks across
  # services (overlapping RTC ranges, shared secrets) need all of them.
  local preflight=(node "${ROOT_DIR}/scripts/deploy-sfu-preflight.mjs" --compose-json -)
  # A normal deployment must be able to revive a stopped inactive SFU, so its
  # pre-mutation gate validates rendered configuration only. Explicit
  # --preflight-only remains the operator-facing live route check.
  if [[ "$PREFLIGHT_CONFIG_ONLY" == "true" || "$PREFLIGHT_ONLY" != "true" ]]; then
    preflight+=(--config-only)
  fi

  # `docker compose config` only renders local configuration. In explicit live
  # preflight mode, the Node probe makes GET-only health/status requests. Only
  # its explicit pass line counts: a preflight that printed nothing has not
  # checked anything.
  local result
  result="$("${COMPOSE[@]}" config --format json | "${preflight[@]}")" || {
    [[ -n "$result" ]] && printf '%s\n' "$result"
    echo "SFU deployment preflight failed." >&2
    return 1
  }
  printf '%s\n' "$result"
  if ! grep -q '^SFU deployment preflight passed' <<< "$result"; then
    echo "SFU deployment preflight reported no result, so the deploy stops." >&2
    return 1
  fi
}

if [[ "$PREFLIGHT_ONLY" == "true" ]]; then
  echo "Running fail-closed SFU deployment preflight..."
  run_deploy_preflight || exit 1
  echo "Preflight-only run complete; no code, container, drain, or DNS changes were made."
  exit 0
fi

# One deploy at a time on this host: two runs against different instances can
# each find the other serving and drain both. A host job that must not
# overlap a deploy, such as the nightly backup, can hold the same lock, so no
# deploy starts or replaces an SFU under it; a deploy waits for it a while
# (SFU_DEPLOY_LOCK_WAIT_SECONDS). The lock lives in /run/lock, which a systemd
# unit with a private /tmp sees too. The kernel holds the flock on fd 9 until
# this process, and the re-exec
# below that inherits the fd, exit, however they exit.
if [[ -d /run/lock ]]; then
  DEPLOY_LOCK="${SFU_DEPLOY_LOCK_FILE:-/run/lock/conclave-sfu-deploy.lock}"
else
  DEPLOY_LOCK="${SFU_DEPLOY_LOCK_FILE:-/tmp/conclave-sfu-deploy.lock}"
fi
if ! command -v flock >/dev/null 2>&1; then
  echo "deploy-sfu.sh needs flock (util-linux) so two deploys cannot run at once; install it and rerun." >&2
  exit 1
fi
# The device and inode of a path, or of an open fd given by number.
file_id() {
  node -e 'const fs=require("fs");const a=process.argv[1];const s=/^[0-9]+$/.test(a)?fs.fstatSync(Number(a)):fs.statSync(a);console.log(s.dev+":"+s.ino)' "$1"
}
# Readable by every user that deploys or backs up, whoever made it.
[[ -e "$DEPLOY_LOCK" ]] || (umask 0111 && : >> "$DEPLOY_LOCK")
lock_id="$(file_id "$DEPLOY_LOCK")"
# A restarted run inherits fd 9; SFU_DEPLOY_LOCK_HELD only says to look at
# it, whatever value an older release put there. What decides is the file:
# when the inherited fd is this very lock (same device and inode), the lock is
# already held and is used in place. When it is another file (an older
# release locked elsewhere), that lock is kept on fd 10 until this run ends,
# so deploys of either version stay out, and this one is taken too.
inherited=""
if [[ -n "${SFU_DEPLOY_LOCK_HELD:-}" ]] && { : <&9; } 2>/dev/null; then
  inherited="$(file_id 9 2>/dev/null || true)"
fi
if [[ "$inherited" != "$lock_id" ]]; then
  [[ -n "$inherited" ]] && exec 10<&9
  exec 9<"$DEPLOY_LOCK"
fi
if ! flock -n 9 2>/dev/null; then
  lock_wait="${SFU_DEPLOY_LOCK_WAIT_SECONDS:-120}"
  echo "Another SFU deploy or a backup holds ${DEPLOY_LOCK}; waiting up to ${lock_wait}s for it..."
  if ! flock -w "$lock_wait" 9 2>/dev/null; then
    echo "Another SFU deploy or a backup still holds ${DEPLOY_LOCK} after ${lock_wait}s; not starting a second one." >&2
    exit 1
  fi
fi
# The file can be replaced while a run waits; the lock counts only on the
# file the path names now.
[[ "$(file_id 9)" == "$(file_id "$DEPLOY_LOCK")" ]] || {
  echo "${DEPLOY_LOCK} was replaced while this deploy waited for it; rerun it." >&2
  exit 1
}
export SFU_DEPLOY_LOCK_HELD="$lock_id"

if [[ "$ROLLBACK" == "true" ]]; then
  echo "Rollback: the checkout stays at $(git -C "$ROOT_DIR" rev-parse --short=12 HEAD); no pull, no build."
else
  echo "Pulling latest code..."
  before_pull="$(git -C "$ROOT_DIR" rev-parse HEAD)"
  git -C "$ROOT_DIR" pull
  # bash keeps running the file it opened, so a pull that changed this script
  # would deploy with the old logic. Start over with the new one.
  if [[ -z "${SFU_DEPLOY_REEXEC:-}" ]] &&
     ! git -C "$ROOT_DIR" diff --quiet "$before_pull" HEAD -- scripts/deploy-sfu.sh; then
    echo "This pull changed deploy-sfu.sh; restarting with the new version."
    SFU_DEPLOY_REEXEC=1 exec "${BASH_SOURCE[0]}" "$@"
  fi
fi

# The revision about to be built checks its own compose file against the env,
# before anything is built or changed, so an older preflight cannot approve a
# config the new SFU rejects.
echo "Running fail-closed SFU deployment preflight on $(git -C "$ROOT_DIR" rev-parse --short=12 HEAD)..."
run_deploy_preflight || exit 1

HAS_REDIS_SERVICE="false"
if "${COMPOSE[@]}" config --services 2>/dev/null | grep -x "redis" >/dev/null; then
  HAS_REDIS_SERVICE="true"
fi

# SFU dependencies are installed inside the Docker image; the host does not need them.

# A compose file that defines its own Redis (staging) gets it started; the
# production file has none and uses the host Redis from .env.
if [[ "$HAS_UPSTASH" == "true" ]]; then
  echo "Using Upstash Redis; skipping local Redis container."
elif [[ "$HAS_REDIS_SERVICE" == "true" ]]; then
  echo "Ensuring Redis is running..."
  "${COMPOSE[@]}" up -d redis
elif [[ -n "${SFU_REDIS_URL:-}" || -n "${REDIS_URL:-}" ]]; then
  echo "Using Redis at $(redis_url_host); skipping compose Redis container."
else
  echo "Redis service not present in ${COMPOSE_FILE}; using host Redis credentials from .env."
fi

# The pulled compose file decides the services, ports and image names.
COMPOSE_JSON="$("${COMPOSE[@]}" config --format json)"
read -ra ALL_SFU_SERVICES <<< "$(printf "%s" "$COMPOSE_JSON" | node -e "const c=JSON.parse(require('fs').readFileSync(0,'utf8'));const env=(s)=>Array.isArray(s.environment)?Object.fromEntries(s.environment.map((e)=>e.split('='))):(s.environment??{});console.log(Object.entries(c.services).filter(([,s])=>env(s).SFU_INSTANCE_ID).map(([n])=>n).join(' '));")"
if [[ -n "${SFU_DEPLOY_SERVICES:-}" ]]; then
  IFS=',' read -ra SERVICES <<< "${SFU_DEPLOY_SERVICES// /}"
else
  SERVICES=("${ALL_SFU_SERVICES[@]}")
fi

DRAIN_TIMEOUT_SECONDS="${DRAIN_TIMEOUT_SECONDS:-3600}"
DRAIN_POLL_SECONDS="${DRAIN_POLL_SECONDS:-10}"
HEALTH_TIMEOUT_SECONDS="${HEALTH_TIMEOUT_SECONDS:-120}"
# A placement reserved just before a drain can still turn into a room on that
# instance until it expires (the SFU's placement TTL is 20 s), so an instance
# only counts as empty once that long has passed since its drain.
PLACEMENT_SETTLE_SECONDS="${PLACEMENT_SETTLE_SECONDS:-25}"
# Exit code when a meeting outlasts the drain deadline: nothing was rebuilt
# under it, and rerunning the deploy later finishes the job.
EXIT_BLOCKED_BY_ROOMS=3
EXIT_CANARY_FAILED=4

PROJECT="$(printf "%s" "$COMPOSE_JSON" | json_field name)"
IMAGE_REPO="${PROJECT}-sfu"
# The last two deploys whose canaries passed on every instance, so --rollback
# can return to the one before the current release without a rebuild.
DEPLOY_STATE_DIR="${SFU_DEPLOY_STATE_DIR:-${HOME}/.local/state/conclave-sfu-deploy}"
DEPLOY_STATE_FILE="${DEPLOY_STATE_DIR}/${PROJECT}.env"
LAST_GOOD_COMMIT=""
LAST_GOOD_IMAGE=""
PREVIOUS_GOOD_COMMIT=""
PREVIOUS_GOOD_IMAGE=""
# The image whose canary passed most recently, saved at the moment it passed,
# so a rerun after an interruption can still record the release.
VERIFIED_IMAGE=""
# Set while a rollback has reached some instances but not all, so a later
# --rollback finishes it rather than choosing a new target.
ROLLBACK_TARGET_COMMIT=""
ROLLBACK_TARGET_IMAGE=""
if [[ -f "$DEPLOY_STATE_FILE" ]]; then
  # shellcheck disable=SC1090
  source "$DEPLOY_STATE_FILE"
fi

save_deploy_state() {
  mkdir -p "$DEPLOY_STATE_DIR"
  local tmp="${DEPLOY_STATE_FILE}.tmp"
  printf 'LAST_GOOD_COMMIT=%q\nLAST_GOOD_IMAGE=%q\nPREVIOUS_GOOD_COMMIT=%q\nPREVIOUS_GOOD_IMAGE=%q\nVERIFIED_IMAGE=%q\nROLLBACK_TARGET_COMMIT=%q\nROLLBACK_TARGET_IMAGE=%q\n' \
    "$LAST_GOOD_COMMIT" "$LAST_GOOD_IMAGE" "$PREVIOUS_GOOD_COMMIT" "$PREVIOUS_GOOD_IMAGE" "$VERIFIED_IMAGE" \
    "$ROLLBACK_TARGET_COMMIT" "$ROLLBACK_TARGET_IMAGE" > "$tmp"
  mv "$tmp" "$DEPLOY_STATE_FILE"
  # The tags keep both images safe from docker image prune.
  [[ -n "$LAST_GOOD_IMAGE" ]] && docker tag "$LAST_GOOD_IMAGE" "${IMAGE_REPO}:last-good"
  if [[ -n "$PREVIOUS_GOOD_IMAGE" ]]; then
    docker tag "$PREVIOUS_GOOD_IMAGE" "${IMAGE_REPO}:previous-good"
  else
    docker rmi "${IMAGE_REPO}:previous-good" >/dev/null 2>&1 || true
  fi
}

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

# The image tag compose runs for one service: its own image key, or the
# <project>-<service> name compose gives a build. (config --images also lists
# a service's dependencies, in no fixed order.)
service_image_name() {
  printf "%s" "$COMPOSE_JSON" | node -e "const c=JSON.parse(require('fs').readFileSync(0,'utf8'));const name=process.argv[1];console.log(c.services[name].image||c.name+'-'+name);" "$1"
}

# The build context and the Dockerfile compose uses for a service, one per line.
service_build() {
  printf "%s" "$COMPOSE_JSON" | node -e "const c=JSON.parse(require('fs').readFileSync(0,'utf8'));const b=c.services[process.argv[1]].build||{};const p=require('path');const ctx=p.resolve(process.argv[2],b.context||'.');console.log(ctx);console.log(p.resolve(ctx,b.dockerfile||'Dockerfile'));" "$1" "$ROOT_DIR"
}

service_container() {
  local ids
  ids="$("${COMPOSE[@]}" ps -aq "$1" 2>/dev/null)" || return 1
  printf "%s" "${ids%%$'\n'*}"
}

# An instance's /status, only when it answers as that instance: a management
# URL that reaches another instance reports that one's rooms. Returns 1 when
# nothing can be read and 2 when another instance answers.
instance_status() {
  local svc="$1" url status expected id
  url="$(service_url "$svc")"
  status="$(status_json "$url")"
  [[ -n "$status" ]] || return 1
  expected="$(compose_service_env "$svc" SFU_INSTANCE_ID)"
  id="$(printf "%s" "$status" | json_field instanceId || true)"
  if [[ "$id" != "$expected" ]]; then
    echo "${svc}'s management URL ${url} answers as '${id:-unknown}', not ${expected}; fix that URL." >&2
    return 2
  fi
  printf "%s" "$status"
}

# What Docker reports for a service's container, from two samples a moment
# apart: "running" when it runs steadily, so it may carry calls however silent
# it is; "stopped" when it is exited, dead, created or restarting, or its
# restart count moves (crash-looping), so it carries none; "absent" when
# compose has no container for it; "unknown" when compose or Docker cannot
# say. Only stopped and absent may be rebuilt without a drain: unknown is busy.
container_state() {
  local container first second
  container="$(service_container "$1")" || { echo unknown; return; }
  [[ -n "$container" ]] || { echo absent; return; }
  first="$(docker inspect -f '{{.State.Status}}:{{.RestartCount}}' "$container" 2>/dev/null)" || { echo unknown; return; }
  sleep "${CONTAINER_SAMPLE_SECONDS:-2}"
  second="$(docker inspect -f '{{.State.Status}}:{{.RestartCount}}' "$container" 2>/dev/null)" || { echo unknown; return; }
  case "${second%%:*}" in
    exited|dead|created|restarting) echo stopped ;;
    running)
      case "${first%%:*}" in
        running|exited|dead|created|restarting)
          if [[ "${first#*:}" != "${second#*:}" ]]; then echo stopped; else echo running; fi ;;
        *) echo unknown ;;
      esac ;;
    *) echo unknown ;;
  esac
}

# An instance's place in the deploy order, as "<class> <rooms>". Instances
# that take no new meetings go first, since rebuilding them costs no
# capacity: 0 when its container is down or crash-looping, 1 when it is
# draining. Serving
# instances follow as class 2, emptiest first. Class 3, last, is one whose
# /status cannot be read: its rooms are unknown, so it is never taken for
# the idle instance.
deploy_rank() {
  local svc="$1" url status="" rooms draining container
  url="$(service_url "$svc")"
  status="$(instance_status "$svc" 2>/dev/null)" || status=""
  if [[ -n "$status" ]]; then
    rooms="$(printf "%s" "$status" | json_field rooms || true)"
    draining="$(printf "%s" "$status" | json_field draining || true)"
    if [[ ! "$rooms" =~ ^[0-9]+$ ]]; then
      echo "3 0"
    elif [[ "$draining" == "true" ]]; then
      echo "1 ${rooms}"
    else
      echo "2 ${rooms}"
    fi
    return
  fi
  if ! answers_http "$url" && [[ "$(container_state "$svc")" =~ ^(stopped|absent)$ ]]; then
    echo "0 0"
  else
    echo "3 0"
  fi
}

set_draining() {
  local payload="{\"draining\": $2}"
  if [[ "$2" == "true" && "$FORCE_DRAIN" == "true" ]]; then
    payload="{\"draining\": true, \"force\": true, \"noticeMs\": ${FORCE_DRAIN_NOTICE_MS}}"
  fi
  curl -fsS --connect-timeout 3 --max-time 10 -X POST "${1}/drain" \
    -H "x-sfu-secret: ${SFU_SECRET}" \
    -H "content-type: application/json" \
    -d "$payload"
}

# Waits for an instance to report zero rooms, and not before settle_until (a
# Unix time). An unreadable status is not zero: it keeps waiting. Returns 1 at
# the deadline.
wait_for_empty() {
  local svc="$1"
  local url="$2"
  local settle_until="${3:-0}"
  local start_ts
  start_ts="$(date +%s)"
  while true; do
    local status="" rooms="unknown"
    status="$(instance_status "$svc")" || status=""
    if [[ -n "$status" ]]; then
      rooms="$(printf "%s" "$status" | json_field rooms || echo "unknown")"
    fi
    echo "${svc} active rooms: ${rooms}"
    if [[ "$rooms" == "0" ]]; then
      (( $(date +%s) >= settle_until )) && return 0
      echo "${svc} waiting for placements reserved before the drain to expire"
    elif (( $(date +%s) - start_ts >= DRAIN_TIMEOUT_SECONDS )); then
      return 1
    fi
    sleep "$DRAIN_POLL_SECONDS"
  done
}

is_healthy() {
  local health
  health="$(curl -fsS --connect-timeout 2 --max-time 3 "${1}/health" 2>/dev/null)" &&
    [[ "$(printf "%s" "$health" | json_field status)" == "healthy" ]]
}

wait_for_healthy() {
  local url="$1"
  local start_ts
  start_ts="$(date +%s)"
  until is_healthy "$url"; do
    if (( $(date +%s) - start_ts >= HEALTH_TIMEOUT_SECONDS )); then
      return 1
    fi
    sleep 1
  done
}

# A drain sends an instance's new meetings to the others, so each of them must
# be serving first: healthy, a readable /status from that instance saying it
# is not draining, and a public URL that reaches it. /health stays healthy
# while an instance drains, so a status that cannot be read within
# HEALTH_TIMEOUT_SECONDS is unknown, and unknown is unsafe. Every SFU counts,
# whatever SFU_DEPLOY_SERVICES selects.
peers_serving() {
  local svc="$1" peer url status start_ts code
  for peer in "${ALL_SFU_SERVICES[@]}"; do
    [[ "$peer" == "$svc" ]] && continue
    url="$(service_url "$peer")"
    if ! is_healthy "$url"; then
      echo "Not draining ${svc}: ${peer} does not report healthy at ${url}, so new meetings would have nowhere to go." >&2
      return 1
    fi
    start_ts="$(date +%s)"
    while true; do
      code=0
      status="$(instance_status "$peer")" || code=$?
      (( code == 0 )) && break
      if (( code == 2 )) || (( $(date +%s) - start_ts >= HEALTH_TIMEOUT_SECONDS )); then
        echo "Not draining ${svc}: ${peer}'s /status cannot be read at ${url}, so whether it takes new meetings is unknown." >&2
        return 1
      fi
      sleep 1
    done
    if [[ "$(printf "%s" "$status" | json_field draining || true)" != "false" ]]; then
      echo "Not draining ${svc}: ${peer} is draining too, so new meetings would have nowhere to go." >&2
      return 1
    fi
    if ! validate_public_route "$peer" "$(service_public_url "$peer")"; then
      echo "Not draining ${svc}: clients cannot reach ${peer} at its public URL, so new meetings would have nowhere to go." >&2
      return 1
    fi
  done
}

# A run that was interrupted can leave every instance drained, and then none
# takes new meetings. Holding the deploy lock, no other run is midway, so an
# instance that is healthy and was drained while serving (its container did
# not boot drained, as an unverified build does) goes back into service before
# this run drains anything.
restore_service_when_none_serves() {
  local svc status container
  for svc in "${ALL_SFU_SERVICES[@]}"; do
    status="$(instance_status "$svc" 2>/dev/null)" || continue
    [[ "$(printf "%s" "$status" | json_field draining)" == "false" ]] && is_healthy "$(service_url "$svc")" && return 0
  done
  for svc in "${ALL_SFU_SERVICES[@]}"; do
    status="$(instance_status "$svc" 2>/dev/null)" || continue
    [[ "$(printf "%s" "$status" | json_field draining)" == "true" ]] || continue
    is_healthy "$(service_url "$svc")" || continue
    container="$(service_container "$svc")"
    [[ -n "$container" ]] || continue
    docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' "$container" | grep -qx 'SFU_DRAINING=true' && continue
    echo "No SFU is taking new meetings; putting ${svc} back into service before this deploy drains anything."
    set_draining "$(service_url "$svc")" false >/dev/null || true
  done
}

# True when every SFU instance, deployed in this run or not, runs the image.
all_on_image() {
  local svc container
  for svc in "${ALL_SFU_SERVICES[@]}"; do
    container="$(service_container "$svc")"
    [[ -n "$container" && "$(docker inspect -f '{{.Image}}' "$container")" == "$1" ]] || return 1
  done
}

# Any HTTP answer, even an error, means the process is up.
answers_http() {
  [[ "$(curl -s -o /dev/null -w '%{http_code}' --connect-timeout 2 --max-time 3 "${1}/health" || true)" != "000" ]]
}

# Two clients join a room on the instance, publish audio and must hear each
# other through it. The canary is the checkout's (CANARY_IMAGE), bundled into
# one file at build time so it needs none of the SFU's dev dependencies.
run_canary() {
  echo "Running the canary call against ${1}..."
  docker run --rm --network host -e SFU_SECRET --entrypoint node "$CANARY_IMAGE" \
    dist/canary-call.mjs --url "$2"
}

# Puts an instance back on the image it ran before this deploy. With no
# previous image there is nothing known-good to return to, so it is stopped
# rather than left serving a build that failed its canary.
rollback_service() {
  local svc="$1" url="$2" image_name="$3" previous_image="$4"
  if [[ -z "$previous_image" ]]; then
    "${COMPOSE[@]}" stop "$svc"
    echo "${svc} had no previous image; it is stopped." >&2
    return
  fi
  echo "Rolling ${svc} back to its previous image..." >&2
  docker tag "$previous_image" "$image_name"
  if ! "${COMPOSE[@]}" up -d --no-build --no-deps --force-recreate "$svc"; then
    echo "ERROR: compose could not restart ${svc} on its previous image; it is down. Check it now." >&2
    return
  fi
  if wait_for_healthy "$url"; then
    echo "${svc} is serving on its previous image again." >&2
  else
    echo "WARNING: ${svc} did not report healthy after the rollback; check it now." >&2
  fi
}

# Moves one instance onto TARGET_IMAGE without cutting a call: drain it, wait
# for its rooms to finish (or give up at the deadline and put it back), and
# only then recreate it. The new container boots drained, takes the canary
# call, and is recreated undrained from the same image only once it passes.
deploy_service() {
  local svc="$1"
  local url image_name container status="" previous_image="" settle_until=0
  url="$(service_url "$svc")"
  image_name="$(service_image_name "$svc")"
  container="$(service_container "$svc")"
  local status_code=1
  for _ in 1 2 3; do
    status_code=0
    status="$(instance_status "$svc")" || status_code=$?
    (( status_code == 1 )) || break
    sleep 5
  done
  if (( status_code == 2 )); then
    echo "${svc} was not drained or rebuilt." >&2
    return 1
  fi
  if [[ -n "$container" ]]; then
    previous_image="$(docker inspect -f '{{.Image}}' "$container")"
  fi
  # A container already on the target image that is not serving normally was
  # left by an interrupted run, so it is not a known-good fallback; use what
  # ran before that run.
  if [[ "$previous_image" == "$TARGET_IMAGE" ]]; then
    previous_image="$(docker image inspect -f '{{.Id}}' "${IMAGE_REPO}:rollback-${svc}" 2>/dev/null || true)"
  fi
  # A stopped container can outlive its image; there is nothing to return to.
  if [[ -n "$previous_image" ]] && ! docker image inspect "$previous_image" >/dev/null 2>&1; then
    previous_image=""
  fi

  # Deployed means serving: the status, from this instance, says healthy.
  if [[ -n "$container" && -n "$status" ]] &&
     [[ "$(printf "%s" "$status" | json_field healthy)" == "true" ]] &&
     [[ "$(printf "%s" "$status" | json_field draining)" == "false" ]] &&
     [[ "$(docker inspect -f '{{.Image}}' "$container")" == "$TARGET_IMAGE" ]] &&
     [[ "$(docker inspect -f '{{index .Config.Labels "com.docker.compose.config-hash"}}' "$container")" == "$("${COMPOSE[@]}" config --hash "$svc" | awk '{print $2}')" ]]; then
    # An earlier run may have stopped here because clients could not reach
    # it, so the skip holds only while its public route still does.
    if ! validate_public_route "$svc" "$(service_public_url "$svc")"; then
      echo "" >&2
      echo "Deploy stopped: ${svc} already runs ${TARGET_COMMIT}, but clients cannot reach it at its public URL." >&2
      echo "The instances after it were not drained. Fix the route, then rerun this script." >&2
      return 1
    fi
    echo "${svc} already runs ${TARGET_COMMIT} with the current config; leaving it alone."
    return 0
  fi

  if [[ -n "$status" ]]; then
    local was_draining
    was_draining="$(printf "%s" "$status" | json_field draining || echo "false")"
    if ! peers_serving "$svc"; then
      echo "${svc} was not drained or rebuilt. Bring the other instance back, then rerun this script." >&2
      return 1
    fi
    echo "Draining ${svc}..."
    local drain_response=""
    if ! drain_response="$(set_draining "$url" true)"; then
      echo "Failed to drain ${svc}; not rebuilding it." >&2
      return 1
    fi
    settle_until=$(( $(date +%s) + PLACEMENT_SETTLE_SECONDS ))
    if [[ "$FORCE_DRAIN" == "true" && "$(printf "%s" "$drain_response" | json_field forced || echo false)" == "true" ]]; then
      echo "Force drain applied to ${svc}; skipping the room wait."
    elif ! wait_for_empty "$svc" "$url" "$settle_until"; then
      if [[ "$was_draining" != "true" ]]; then
        set_draining "$url" false >/dev/null || true
      fi
      echo "" >&2
      echo "Deploy paused: ${svc} did not drain within ${DRAIN_TIMEOUT_SECONDS}s; a meeting is still running on it." >&2
      echo "${svc} was not rebuilt and keeps serving its calls. Rerun this script once the meeting ends." >&2
      return "$EXIT_BLOCKED_BY_ROOMS"
    fi
  elif answers_http "$url"; then
    # Up but its status is unreadable: its rooms are unknown, so leave it.
    echo "${svc} answers but its /status cannot be read; not rebuilding it." >&2
    return 1
  else
    # Silent is not stopped: a wrong URL or proxy hides a container that may
    # still carry calls, however recently it started.
    case "$(container_state "$svc")" in
      stopped|absent)
        echo "${svc} is not running; starting it without a drain."
        settle_until=$(( $(date +%s) + PLACEMENT_SETTLE_SECONDS ))
        ;;
      running)
        echo "${svc}'s container is running but nothing answers at ${url}; check that URL, or stop ${svc} if it is hung. Not rebuilding it." >&2
        return 1
        ;;
      *)
        echo "Docker could not report the state of ${svc}'s container, so it may still carry calls; not rebuilding it." >&2
        return 1
        ;;
    esac
  fi

  if [[ -n "$previous_image" ]]; then
    docker tag "$previous_image" "${IMAGE_REPO}:rollback-${svc}"
  fi
  echo "Starting ${svc} on ${TARGET_COMMIT}, out of rotation until its canary passes..."
  docker tag "$TARGET_IMAGE" "$image_name"
  local failure=""
  if ! SFU_START_DRAINING=true "${COMPOSE[@]}" up -d --no-build --no-deps --force-recreate "$svc"; then
    failure="compose could not start ${svc} on ${TARGET_COMMIT}"
  elif ! wait_for_healthy "$url"; then
    failure="${svc} did not report healthy within ${HEALTH_TIMEOUT_SECONDS}s"
  elif ! run_canary "$svc" "$url"; then
    failure="the canary call against ${svc} failed"
  elif ! wait_for_empty "$svc" "$url" "$settle_until"; then
    # The build passed, but a call reached it while it was out of rotation.
    # The recreate below would cut that call, so the instance stays drained
    # on the new image until a rerun finds it empty.
    VERIFIED_IMAGE="$TARGET_IMAGE"
    save_deploy_state
    echo "" >&2
    echo "Deploy paused: ${svc} passed its canary, but a call is running on it while it is out of rotation." >&2
    echo "Rerun this script once that call ends." >&2
    return "$EXIT_BLOCKED_BY_ROOMS"
  else
    # Same image, normal config: the serving container boots undrained and
    # stays that way across restarts.
    if ! "${COMPOSE[@]}" up -d --no-build --no-deps --force-recreate "$svc"; then
      failure="compose could not recreate ${svc} after its canary"
    elif ! wait_for_healthy "$url"; then
      failure="${svc} did not come back healthy after its canary"
    fi
  fi
  if [[ -n "$failure" ]]; then
    echo "" >&2
    echo "Deploy stopped: ${failure}." >&2
    rollback_service "$svc" "$url" "$image_name" "$previous_image"
    echo "Instances not yet deployed were left untouched and keep serving." >&2
    return "$EXIT_CANARY_FAILED"
  fi
  VERIFIED_IMAGE="$TARGET_IMAGE"
  save_deploy_state
  echo "${svc} passed its canary on ${TARGET_COMMIT} and is serving."
  if ! validate_public_route "$svc" "$(service_public_url "$svc")"; then
    echo "" >&2
    echo "Deploy stopped: ${svc} serves ${TARGET_COMMIT}, but clients cannot reach it at its public URL." >&2
    echo "The instances after it were not drained. Fix the route, then rerun this script." >&2
    return 1
  fi
}

restore_service_when_none_serves

ORDERED_SERVICES=()
while read -r _class _rooms svc; do
  ORDERED_SERVICES+=("$svc")
done < <(for svc in "${SERVICES[@]}"; do echo "$(deploy_rank "$svc") $svc"; done | sort -n -k1,1 -k2,2 -k3,3)
echo "Deploy order: ${ORDERED_SERVICES[*]}"

# --rollback goes to the last release that served on every instance: the one
# before the current release when every instance runs it, the current one when
# a rollout reached only some of them, or the target of a rollback that is not
# finished yet.
if [[ "$ROLLBACK" == "true" ]]; then
  if [[ -n "$ROLLBACK_TARGET_IMAGE" ]]; then
    TARGET_IMAGE="$ROLLBACK_TARGET_IMAGE"
    TARGET_COMMIT="$ROLLBACK_TARGET_COMMIT"
    echo "Finishing the rollback to ${TARGET_COMMIT}."
  elif all_on_image "$LAST_GOOD_IMAGE"; then
    TARGET_IMAGE="$PREVIOUS_GOOD_IMAGE"
    TARGET_COMMIT="$PREVIOUS_GOOD_COMMIT"
    echo "Rolling every instance back to ${TARGET_COMMIT}, the release before ${LAST_GOOD_COMMIT}."
  else
    TARGET_IMAGE="$LAST_GOOD_IMAGE"
    TARGET_COMMIT="$LAST_GOOD_COMMIT"
    echo "Not every instance runs ${LAST_GOOD_COMMIT}; rolling them all back to it, the last release that served on every instance."
  fi
  if [[ -z "$TARGET_IMAGE" ]] || ! docker image inspect "$TARGET_IMAGE" >/dev/null 2>&1; then
    echo "No canary-verified release to roll back to is recorded in ${DEPLOY_STATE_FILE}; revert the commit and deploy instead." >&2
    exit 1
  fi
  # Recorded before any instance changes, so a rerun after an interruption or
  # an exit 3 finishes this rollback instead of choosing again from a mixed
  # state.
  ROLLBACK_TARGET_COMMIT="$TARGET_COMMIT"
  ROLLBACK_TARGET_IMAGE="$TARGET_IMAGE"
  save_deploy_state
else
  TARGET_COMMIT="$(git -C "$ROOT_DIR" rev-parse --short=12 HEAD)"
  # A rebuild of the same commit gets a new image ID even when every layer is
  # cached, which would defeat the skip check on a rerun. So the commit's
  # image is reused, and only a build from a clean build context (no edited
  # or untracked files) is ever tagged as the commit's image.
  build_inputs_clean="false"
  if [[ -z "$(git -C "$ROOT_DIR" status --porcelain -- .dockerignore package.json pnpm-lock.yaml pnpm-workspace.yaml patches packages)" ]]; then
    build_inputs_clean="true"
  fi
  if [[ "$build_inputs_clean" == "true" ]] &&
     TARGET_IMAGE="$(docker image inspect -f '{{.Id}}' "${IMAGE_REPO}:${TARGET_COMMIT}" 2>/dev/null)"; then
    echo "Reusing the image already built for ${TARGET_COMMIT}."
  else
    # Built under its own candidate tag, never as a service's compose image: an
    # instance's image moves to the build only once that instance has
    # drained, right before its canary, so a deploy paused by a call leaves
    # nothing untested for a later compose up to start.
    echo "Building the SFU image for ${TARGET_COMMIT}..."
    mapfile -t target_build < <(service_build "${ORDERED_SERVICES[0]}")
    docker build -t "${IMAGE_REPO}:${TARGET_COMMIT}-candidate" -f "${target_build[1]}" "${target_build[0]}"
    TARGET_IMAGE="$(docker image inspect -f '{{.Id}}' "${IMAGE_REPO}:${TARGET_COMMIT}-candidate")"
    if [[ "$build_inputs_clean" == "true" ]]; then
      docker tag "$TARGET_IMAGE" "${IMAGE_REPO}:${TARGET_COMMIT}"
    else
      echo "The checkout has local changes; this build is not recorded as ${TARGET_COMMIT}'s image."
    fi
  fi
fi

# The canary comes from this checkout, never from the image under test: a
# release built before the bundle existed has none to run, and the check
# should not change with the build it checks. A deploy has just built the
# checkout. A rollback uses the checkout's image; when no deploy built it, it
# is built under its own canary tag, so no service image is ever rebuilt or
# retagged for it, and a rerun reuses it.
if [[ "$ROLLBACK" == "true" ]]; then
  checkout_commit="$(git -C "$ROOT_DIR" rev-parse --short=12 HEAD)"
  canary_tag="${IMAGE_REPO}-canary:${checkout_commit}"
  if ! CANARY_IMAGE="$(docker image inspect -f '{{.Id}}' "${IMAGE_REPO}:${checkout_commit}" 2>/dev/null)" &&
     ! CANARY_IMAGE="$(docker image inspect -f '{{.Id}}' "$canary_tag" 2>/dev/null)"; then
    mapfile -t canary_build < <(service_build "${ORDERED_SERVICES[0]}")
    echo "Building ${checkout_commit} as ${canary_tag} for its canary; the instances still go back to ${TARGET_COMMIT}."
    docker build -t "$canary_tag" -f "${canary_build[1]}" "${canary_build[0]}"
    CANARY_IMAGE="$(docker image inspect -f '{{.Id}}' "$canary_tag")"
  fi
else
  CANARY_IMAGE="$TARGET_IMAGE"
fi

for svc in "${ORDERED_SERVICES[@]}"; do
  deploy_service "$svc"
done

# The release record moves only once every instance runs the target, so a
# deploy or rollback of some instances (SFU_DEPLOY_SERVICES) keeps what the
# others still need: a partial rollback keeps its target for the rest.
if [[ "$ROLLBACK" == "true" ]] && ! all_on_image "$TARGET_IMAGE"; then
  echo "Not every instance runs ${TARGET_COMMIT} yet; --rollback continues to it until every instance is back on it."
elif [[ "$ROLLBACK" == "true" ]]; then
  # Back past the current release, one step only: a second --rollback has
  # nothing older to go to. Undoing a partial rollout leaves the record as is.
  if [[ "$TARGET_IMAGE" != "$LAST_GOOD_IMAGE" ]]; then
    LAST_GOOD_COMMIT="$TARGET_COMMIT"
    LAST_GOOD_IMAGE="$TARGET_IMAGE"
    PREVIOUS_GOOD_COMMIT=""
    PREVIOUS_GOOD_IMAGE=""
  fi
  ROLLBACK_TARGET_COMMIT=""
  ROLLBACK_TARGET_IMAGE=""
  save_deploy_state
elif [[ "$TARGET_IMAGE" != "$LAST_GOOD_IMAGE" && "$VERIFIED_IMAGE" == "$TARGET_IMAGE" ]] && all_on_image "$TARGET_IMAGE"; then
  PREVIOUS_GOOD_COMMIT="$LAST_GOOD_COMMIT"
  PREVIOUS_GOOD_IMAGE="$LAST_GOOD_IMAGE"
  LAST_GOOD_COMMIT="$TARGET_COMMIT"
  LAST_GOOD_IMAGE="$TARGET_IMAGE"
  ROLLBACK_TARGET_COMMIT=""
  ROLLBACK_TARGET_IMAGE=""
  save_deploy_state
fi
echo "Last good release: ${LAST_GOOD_COMMIT}${PREVIOUS_GOOD_COMMIT:+ (--rollback returns to ${PREVIOUS_GOOD_COMMIT})}."

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
