#!/usr/bin/env bash
# Blue-green SFU deploy. Builds one image, then moves each instance onto it in
# turn: drain, wait for its calls to end, start the build under its candidate
# tag out of rotation, run a real two-client canary call against it, and only
# then tag it as the service's image and put it back into service. A failed
# canary puts that instance back on its last-known-good image, and the
# instances not yet touched keep serving. Each step is in the instance's
# journal before it is taken, and every run first repairs what a dead one left.
# Runbook: docs/ops/sfu-deploys.md.
#
# Exit codes: 0 deployed, 3 a meeting outlasted the drain deadline (rerun
# later), 4 the canary failed and the instance is serving on its previous
# image again, 5 the canary failed and the instance could not be brought back
# (it is down or stopped; act now).
set -euo pipefail

# mapfile and other bash 4 features run below; macOS ships bash 3.2.
if (( BASH_VERSINFO[0] < 4 )); then
  echo "deploy-sfu.sh needs bash 4 or newer; this is bash ${BASH_VERSION}. On macOS, install a newer bash (brew install bash) and run the script with it." >&2
  exit 1
fi

# How often the waits below look again, and how long a status read that got
# no answer waits before its retry. The tests shorten both.
POLL_SECONDS="${DEPLOY_POLL_SECONDS:-1}"
STATUS_RETRY_SECONDS="${DEPLOY_STATUS_RETRY_SECONDS:-5}"

# A step boundary. SFU_DEPLOY_TEST_STEP_LOG lists each one a run passes, and
# SFU_DEPLOY_TEST_CRASH_AT_STEP=N (or SFU_DEPLOY_TEST_CRASH_AT=<its name>)
# kills the run outright there, as a crash or a closed SSH session would. The
# crash tests use them.
DEPLOY_STEP=0
checkpoint() {
  DEPLOY_STEP=$((DEPLOY_STEP + 1))
  if [[ -n "${SFU_DEPLOY_TEST_STEP_LOG:-}" ]]; then
    printf '%s %s\n' "$DEPLOY_STEP" "$1" >> "$SFU_DEPLOY_TEST_STEP_LOG"
  fi
  if [[ "${SFU_DEPLOY_TEST_CRASH_AT_STEP:-}" == "$DEPLOY_STEP" || "${SFU_DEPLOY_TEST_CRASH_AT:-}" == "$1" ]]; then
    kill -KILL "$$"
  fi
}

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
# The SFU caps a restart notice at 30 s and answers a forced drain only once
# the notice has run, so a longer one would outlast the request.
if (( FORCE_DRAIN_NOTICE_MS > 30000 )); then
  echo "FORCE_DRAIN_NOTICE_MS (--force-drain-notice-ms) is at most 30000, the longest notice the SFU gives." >&2
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

# Written as plain text, never through console.log, which colors a bare number
# when FORCE_COLOR is set (CI sets it), so "0" would not read as 0.
json_field() {
  local field="$1"
  node -e "const fs=require('fs');const data=JSON.parse(fs.readFileSync(0,'utf8'));const val=data['$field'];process.stdout.write((typeof val==='boolean'?(val?'true':'false'):val===undefined||val===null?'':String(val))+'\\n');"
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
    [[ "$instance_id" == "${EXPECTED_ID[$id]:-$id}" ]] && return 0
    if (( $(date +%s) - start_ts >= HEALTH_TIMEOUT_SECONDS )); then
      if [[ -z "$status" ]]; then
        echo "Public URL for ${id} does not answer: ${url}" >&2
      else
        echo "Public URL for ${id} reaches instance '${instance_id:-unknown}' instead: ${url}" >&2
      fi
      return 1
    fi
    sleep "$POLL_SECONDS"
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
# each find the other serving and drain both. The nightly backup holds the
# same lock while it copies, so no deploy starts or replaces an SFU under it;
# a deploy waits for it a while (SFU_DEPLOY_LOCK_WAIT_SECONDS). The lock lives
# in /run/lock, which the backup's systemd unit (with its private /tmp) sees
# too. The kernel holds the flock on fd 9 until this process, and the re-exec
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
# A regular file no other user can open, made and checked by host_lock.py
# under the rules backup.sh and restore.sh follow too: a lock any user can
# open is one any user can hold, stopping every deploy and backup.
python3 -I "${ROOT_DIR}/scripts/host_lock.py" prepare "$DEPLOY_LOCK" || exit 1
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
python3 -I "${ROOT_DIR}/scripts/host_lock.py" check 9 "$DEPLOY_LOCK" || exit 1
export SFU_DEPLOY_LOCK_HELD="$lock_id"
checkpoint "lock held"

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

# A compose file that defines its own Redis (staging) gets it started, whatever
# Upstash settings the shell or a copied .env carries: its SFU reaches only that
# Redis. The production file has none and uses the host Redis from .env.
if [[ "$HAS_REDIS_SERVICE" != "true" && "$HAS_UPSTASH" != "true" && -z "${REDIS_PASSWORD:-}" && -z "${REDIS_URL:-}" && -z "${SFU_REDIS_URL:-}" ]]; then
  echo "REDIS_PASSWORD, REDIS_URL, or SFU_REDIS_URL is required in .env when not using Upstash" >&2
  exit 1
fi
own_redis_check() {
  local container own svc variable url endpoint password answer start_ts checked=0
  local -a auth
  container="$("${COMPOSE[@]}" ps -q redis 2>/dev/null)" || container=""
  container="${container%%$'\n'*}"
  if [[ -z "$container" ]]; then
    echo "${COMPOSE_FILE}'s own Redis has no container after compose started it." >&2
    return 1
  fi
  start_ts="$(date +%s)"
  while true; do
    if [[ "$(docker inspect -f '{{.State.Status}}' "$container" 2>/dev/null)" == "running" ]]; then
      own="$(docker exec "$container" sh -c 'if [ -n "${REDIS_PASSWORD:-}" ]; then export REDISCLI_AUTH="$REDIS_PASSWORD"; fi; exec redis-cli -s /tmp/redis.sock --no-auth-warning INFO server' 2>/dev/null | sed -nE 's/^run_id:([[:alnum:]-]+).*/\1/p')"
      [[ -n "$own" ]] && break
    fi
    if (( $(date +%s) - start_ts >= HEALTH_TIMEOUT_SECONDS )); then
      echo "${COMPOSE_FILE}'s own Redis is not running or does not answer on its socket /tmp/redis.sock, so the SFU could reach another Redis on its port; not starting anything." >&2
      return 1
    fi
    sleep "$POLL_SECONDS"
  done
  for svc in "${ALL_SFU_SERVICES[@]}"; do
    for variable in REDIS_URL SFU_REDIS_URL SFU_PERSISTENCE_REDIS_URL; do
      url="$(compose_service_env "$svc" "$variable")"
      [[ -n "$url" ]] || continue
      endpoint="$(REDIS_URL_IN="$url" node -e 'const u=new URL(process.env.REDIS_URL_IN);process.stdout.write((u.hostname||"127.0.0.1")+" "+(u.port||"6379"))')" || endpoint=""
      password="$(REDIS_URL_IN="$url" node -e 'const u=new URL(process.env.REDIS_URL_IN);process.stdout.write(decodeURIComponent(u.password))')" || password=""
      auth=()
      [[ -n "$password" ]] && auth=(-e REDISCLI_AUTH)
      answer=""
      if [[ -n "$endpoint" ]]; then
        answer="$(REDISCLI_AUTH="$password" docker exec ${auth[@]+"${auth[@]}"} "$container" redis-cli -h "${endpoint% *}" -p "${endpoint#* }" --no-auth-warning INFO server 2>/dev/null | sed -nE 's/^run_id:([[:alnum:]-]+).*/\1/p')"
      fi
      if [[ "$answer" != "$own" ]]; then
        echo "${svc}'s ${variable} reaches a Redis whose run id is ${answer:-unknown}, not ${COMPOSE_FILE}'s own Redis (${own}); another Redis holds that address. Not starting anything." >&2
        return 1
      fi
      checked=$(( checked + 1 ))
    done
  done
  if (( checked == 0 )); then
    echo "No SFU in ${COMPOSE_FILE} names a Redis URL to check against its own Redis; not starting anything." >&2
    return 1
  fi
  echo "Every SFU's Redis URL reaches ${COMPOSE_FILE}'s own Redis (run id ${own})."
}

if [[ "$HAS_REDIS_SERVICE" == "true" ]]; then
  echo "Ensuring Redis is running..."
  "${COMPOSE[@]}" up -d redis
elif [[ "$HAS_UPSTASH" == "true" ]]; then
  echo "Using Upstash Redis; skipping local Redis container."
elif [[ -n "${SFU_REDIS_URL:-}" || -n "${REDIS_URL:-}" ]]; then
  echo "Using Redis at $(redis_url_host); skipping compose Redis container."
else
  echo "Redis service not present in ${COMPOSE_FILE}; using host Redis credentials from .env."
fi

# The pulled compose file decides the services, ports and image names.
COMPOSE_JSON="$("${COMPOSE[@]}" config --format json)"
read -ra ALL_SFU_SERVICES <<< "$(printf "%s" "$COMPOSE_JSON" | node -e "const c=JSON.parse(require('fs').readFileSync(0,'utf8'));const env=(s)=>Array.isArray(s.environment)?Object.fromEntries(s.environment.map((e)=>e.split('='))):(s.environment??{});console.log(Object.entries(c.services).filter(([,s])=>env(s).SFU_INSTANCE_ID).map(([n])=>n).join(' '));")"
if [[ "$HAS_REDIS_SERVICE" == "true" ]]; then
  own_redis_check || exit 1
fi
if [[ -n "${SFU_DEPLOY_SERVICES:-}" ]]; then
  IFS=',' read -ra SERVICES <<< "${SFU_DEPLOY_SERVICES// /}"
else
  SERVICES=("${ALL_SFU_SERVICES[@]}")
fi

DRAIN_TIMEOUT_SECONDS="${DRAIN_TIMEOUT_SECONDS:-3600}"
DRAIN_POLL_SECONDS="${DRAIN_POLL_SECONDS:-10}"
HEALTH_TIMEOUT_SECONDS="${HEALTH_TIMEOUT_SECONDS:-120}"
CONTAINER_SETTLE_SECONDS="${CONTAINER_SETTLE_SECONDS:-3}"
# A placement reserved just before a drain can still turn into a room on that
# instance until it expires (the SFU's placement TTL is 20 s), so an instance
# only counts as empty once that long has passed since its drain.
PLACEMENT_SETTLE_SECONDS="${PLACEMENT_SETTLE_SECONDS:-25}"
# Exit code when a meeting outlasts the drain deadline: nothing was rebuilt
# under it, and rerunning the deploy later finishes the job.
EXIT_BLOCKED_BY_ROOMS=3
EXIT_CANARY_FAILED=4
EXIT_NOT_RESTORED=5

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

# Per-service lookups that only read the rendered compose file, filled once
# below so the polling loops do not ask node again on every pass.
declare -A EXPECTED_ID=() SERVICE_URL=() PUBLIC_URL=() IMAGE_NAME=()

service_url() {
  [[ -n "${SERVICE_URL[$1]:-}" ]] && { printf "%s" "${SERVICE_URL[$1]}"; return; }
  get_deploy_url "$1"
}

service_public_url() {
  [[ -n "${PUBLIC_URL[$1]:-}" ]] && { printf "%s" "${PUBLIC_URL[$1]}"; return; }
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
  [[ -n "${IMAGE_NAME[$1]:-}" ]] && { printf "%s" "${IMAGE_NAME[$1]}"; return; }
  printf "%s" "$COMPOSE_JSON" | node -e "const c=JSON.parse(require('fs').readFileSync(0,'utf8'));const name=process.argv[1];console.log(c.services[name].image||c.name+'-'+name);" "$1"
}

# The build context and the Dockerfile compose uses for a service, one per line.
image_build() {
  "${COMPOSE[@]}" --profile build config --format json | node -e "const c=JSON.parse(require('fs').readFileSync(0,'utf8'));const b=c.services?.['sfu-image']?.build;if(!b)process.exit(1);const p=require('path');const ctx=p.resolve(process.argv[1],b.context||'.');console.log(ctx);console.log(p.resolve(ctx,b.dockerfile||'Dockerfile'));" "$ROOT_DIR"
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
  expected="${EXPECTED_ID[$svc]:-$(compose_service_env "$svc" SFU_INSTANCE_ID)}"
  id="$(printf "%s" "$status" | json_field instanceId || true)"
  if [[ "$id" != "$expected" ]]; then
    echo "${svc}'s management URL ${url} answers as '${id:-unknown}', not ${expected}; fix that URL." >&2
    return 2
  fi
  printf "%s" "$status"
}

container_state() {
  local container state
  container="$(service_container "$1")" || { echo unknown; return; }
  [[ -n "$container" ]] || { echo absent; return; }
  state="$(docker inspect -f '{{.State.Status}}' "$container" 2>/dev/null)" || { echo unknown; return; }
  case "$state" in
    exited|dead|created) echo stopped ;;
    restarting) echo restarting ;;
    running) echo running ;;
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
  if ! answers_http "$url" && [[ "$(container_state "$svc")" =~ ^(stopped|restarting|absent)$ ]]; then
    echo "0 0"
  else
    echo "3 0"
  fi
}

set_draining() {
  local payload="{\"draining\": $2}" max_time=10
  if [[ "$2" == "true" && "$FORCE_DRAIN" == "true" ]]; then
    payload="{\"draining\": true, \"force\": true, \"noticeMs\": ${FORCE_DRAIN_NOTICE_MS}}"
    # The SFU answers once the notice has run.
    max_time=$(( 10 + (FORCE_DRAIN_NOTICE_MS + 999) / 1000 ))
  fi
  curl -fsS --connect-timeout 3 --max-time "$max_time" -X POST "${1}/drain" \
    -H "x-sfu-secret: ${SFU_SECRET}" \
    -H "content-type: application/json" \
    -d "$payload"
}

booted_drained() {
  local container env
  container="$(service_container "$1")" || return 1
  [[ -n "$container" ]] || return 1
  env="$(docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' "$container" 2>/dev/null)" || return 1
  grep -qx 'SFU_DRAINING=true' <<< "$env"
}

hold_down() {
  local svc="$1" container state exited="" start_ts
  container="$(service_container "$svc")" || return 1
  [[ -n "$container" ]] || return 0
  [[ "$(container_state "$svc")" =~ ^(stopped|restarting)$ ]] || return 1
  docker update --restart=no "$container" >/dev/null 2>&1 || return 1
  start_ts="$(date +%s)"
  while (( $(date +%s) - start_ts < HEALTH_TIMEOUT_SECONDS )); do
    state="$(container_state "$svc")"
    case "$state" in
      absent) return 0 ;;
      stopped)
        [[ -n "$exited" ]] && return 0
        exited="yes"
        ;;
      restarting) exited="" ;;
      *) return 1 ;;
    esac
    sleep "$CONTAINER_SETTLE_SECONDS"
  done
  return 1
}

wait_status() {
  local start_ts code
  start_ts="$(date +%s)"
  while true; do
    code=0
    instance_status "$1" >/dev/null 2>&1 || code=$?
    (( code == 0 )) && return 0
    (( code == 2 )) && return 1
    (( $(date +%s) - start_ts >= HEALTH_TIMEOUT_SECONDS )) && return 1
    sleep "$POLL_SECONDS"
  done
}

serving_confirmed() {
  local i
  for i in 1 2 3; do
    serving "$@" && return 0
    (( i < 3 )) && sleep "$STATUS_RETRY_SECONDS"
  done
  return 1
}

DRAIN_WHY=""
drain_and_wait() {
  local svc="$1" url="$2" settle_until="${3:-}" start_ts now status rooms draining unreadable_since="" undrained_since=""
  start_ts="$(date +%s)"
  [[ -n "$settle_until" ]] || settle_until=$(( start_ts + PLACEMENT_SETTLE_SECONDS ))
  DRAIN_WHY=""
  while true; do
    now="$(date +%s)"
    if hold_down "$svc"; then
      echo "${svc}'s container is not running and Docker will not restart it, so it carries no calls."
      return 0
    fi
    status="$(instance_status "$svc" 2>/dev/null)" || status=""
    if [[ -z "$status" ]]; then
      undrained_since=""
      [[ -n "$unreadable_since" ]] || unreadable_since="$now"
      echo "${svc} active rooms: unknown"
      if (( now - unreadable_since >= HEALTH_TIMEOUT_SECONDS )); then
        DRAIN_WHY="its /status has not answered for ${HEALTH_TIMEOUT_SECONDS}s, so whether calls run on it is unknown"
        return 5
      fi
    else
      unreadable_since=""
      draining="$(printf "%s" "$status" | json_field draining || true)"
      rooms="$(printf "%s" "$status" | json_field rooms || echo unknown)"
      echo "${svc} active rooms: ${rooms}"
      if [[ "$draining" != "true" ]]; then
        [[ -n "$undrained_since" ]] || undrained_since="$now"
        if (( now - undrained_since >= HEALTH_TIMEOUT_SECONDS )); then
          DRAIN_WHY="it does not stay drained, so new meetings can still reach it"
          return 5
        fi
        if ! peers_serving "$svc"; then
          DRAIN_WHY="it is taking meetings again and no other instance is serving, so it was not drained again"
          return 5
        fi
        FORCE_DRAIN=false set_draining "$url" true >/dev/null 2>&1 || true
        settle_until=$(( $(date +%s) + PLACEMENT_SETTLE_SECONDS ))
      else
        undrained_since=""
        if [[ "$rooms" == "0" ]]; then
          (( now >= settle_until )) && return 0
          echo "${svc} waiting for placements reserved before the drain to expire"
        elif (( now - start_ts >= DRAIN_TIMEOUT_SECONDS )); then
          DRAIN_WHY="a meeting is still running on it after ${DRAIN_TIMEOUT_SECONDS}s"
          return 3
        fi
      fi
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
    sleep "$POLL_SECONDS"
  done
}

# A drain sends an instance's new meetings to the others, so each of them must
# be serving first: healthy, a readable /status from that instance saying it
# is not draining, and a public URL that reaches it. /health stays healthy
# while an instance drains, so a status that cannot be read within
# HEALTH_TIMEOUT_SECONDS is unknown, and unknown is unsafe. Every SFU counts,
# whatever SFU_DEPLOY_SERVICES selects.
peers_serving() {
  local svc="$1" peer
  for peer in "${ALL_SFU_SERVICES[@]}"; do
    [[ "$peer" == "$svc" ]] && continue
    if ! wait_serving "$peer"; then
      echo "Not draining ${svc}: ${peer} is not serving (${SERVING_WHY}), so new meetings would have nowhere to go." >&2
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
  local svc status container env lkg
  for svc in "${ALL_SFU_SERVICES[@]}"; do
    status="$(instance_status "$svc" 2>/dev/null)" || continue
    [[ "$(printf "%s" "$status" | json_field draining)" == "false" ]] && is_healthy "$(service_url "$svc")" && return 0
  done
  for svc in "${ALL_SFU_SERVICES[@]}"; do
    status="$(instance_status "$svc" 2>/dev/null)" || continue
    [[ "$(printf "%s" "$status" | json_field draining)" == "true" ]] || continue
    is_healthy "$(service_url "$svc")" || continue
    [[ "$(journal_get "$svc" phase)" =~ ^(idle)?$ ]] || continue
    lkg="$(journal_get "$svc" lkg)"
    [[ -z "$lkg" || "$(container_image "$svc")" == "$lkg" ]] || continue
    container="$(service_container "$svc")"
    [[ -n "$container" ]] || continue
    # Only an env Docker could read shows the container did not boot drained.
    env="$(docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' "$container" 2>/dev/null)" || continue
    grep -qx 'SFU_DRAINING=true' <<< "$env" && continue
    echo "No SFU is taking new meetings; putting ${svc} back into service before this deploy drains anything."
    set_draining "$(service_url "$svc")" false >/dev/null || true
  done
}

# True when every SFU instance, deployed in this run or not, runs the image.
all_on_image() {
  local svc
  for svc in "${ALL_SFU_SERVICES[@]}"; do
    [[ -n "$1" && "$(container_image "$svc")" == "$1" ]] || return 1
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

# The image ID a service's container runs, or nothing.
container_image() {
  local container image i
  container="$(service_container "$1")" || return 0
  [[ -n "$container" ]] || return 0
  for i in 1 2 3; do
    image="$(docker inspect -f '{{.Image}}' "$container" 2>/dev/null)" || image=""
    if [[ -n "$image" ]]; then
      printf "%s\n" "$image"
      return 0
    fi
    (( i < 3 )) && sleep "$STATUS_RETRY_SECONDS"
  done
  return 0
}

# Compose starts whatever its own image name for a service points at, so after
# every start the container must run the very image the deploy tagged there;
# anything else (another image name, a compatibility-mode name) fails loudly.
started_on() {
  local svc="$1" image="$2" image_name="$3" running
  running="$(container_image "$svc")"
  [[ "$running" == "$image" ]] && return 0
  echo "compose started ${svc} on ${running:-no image}, not the image tagged for it as ${image_name} (${image}); check that the compose file names ${image_name} for ${svc}" >&2
  return 1
}

# The environment variable a service's image name in the compose file reads,
# such as SFU_IMAGE_SFU_A for sfu-a. Every start below sets it, so compose
# starts exactly the tag this script chose.
image_var() {
  printf 'SFU_IMAGE_%s' "$(printf '%s' "$1" | tr '[:lower:]-' '[:upper:]_')"
}

# A candidate always runs under its own tag. The service's own image name
# only ever names its last-known-good image or a candidate that has passed its
# canary, so a plain `docker compose up`, a restart or a reboot after a crash
# never brings back a build that failed or never finished its canary.
candidate_tag() {
  printf '%s:candidate-%s' "$IMAGE_REPO" "$1"
}

# Starts a service's container on a tag, booting drained ("true") or serving
# ("false"). Both are set on every start, never inherited from the shell or
# .env.
up_service() {
  local svc="$1" tag="$2" drained="$3" restart="unless-stopped"
  [[ "$drained" == "true" ]] && restart="no"
  env "$(image_var "$svc")=${tag}" SFU_START_DRAINING="$drained" SFU_RESTART_POLICY="$restart" \
    "${COMPOSE[@]}" up -d --no-build --no-deps --force-recreate "$svc"
}

# Each instance's deploy journal: its phase (idle, drained, candidate, passed,
# promoting, rollback), its last-known-good image (lkg), the candidate under
# test, the image it served before a promotion (prevLkg), and whether it was
# already draining before this deploy drained it. Each write lands before the
# step it records: whole, fsynced and renamed into place, so a crash leaves the
# old record or the new one, and the next deploy repairs from it.
journal_file() {
  printf '%s/%s.%s.journal.json' "$DEPLOY_STATE_DIR" "$PROJECT" "$1"
}

journal_get() {
  node -e '
const fs = require("fs");
let journal = {};
try {
  journal = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
} catch (error) {
  if (error.code !== "ENOENT") {
    process.stderr.write(`The deploy journal ${process.argv[1]} cannot be read (${error.message}); look at it, then remove it to start over.\n`);
    process.exit(1);
  }
}
const value = journal[process.argv[2]];
process.stdout.write(typeof value === "string" ? value : "");
' "$(journal_file "$1")" "$2"
}

journal_set() {
  local svc="$1"
  shift
  mkdir -p "$DEPLOY_STATE_DIR"
  node -e '
const fs = require("fs");
const path = require("path");
const [file, ...pairs] = process.argv.slice(1);
let journal = {};
try {
  journal = JSON.parse(fs.readFileSync(file, "utf8"));
} catch {}
for (const pair of pairs) {
  const at = pair.indexOf("=");
  journal[pair.slice(0, at)] = pair.slice(at + 1);
}
const tmp = `${file}.tmp`;
const fd = fs.openSync(tmp, "w", 0o600);
fs.writeSync(fd, `${JSON.stringify(journal, null, 1)}\n`);
fs.fsyncSync(fd);
fs.closeSync(fd);
fs.renameSync(tmp, file);
try {
  const dir = fs.openSync(path.dirname(file), "r");
  fs.fsyncSync(dir);
  fs.closeSync(dir);
} catch {}
' "$(journal_file "$svc")" "$@" || {
    echo "ERROR: could not write ${svc}'s deploy journal ($(journal_file "$svc")), so this run stops before the step it records. Fix the state dir, then rerun this script." >&2
    exit 1
  }
  checkpoint "journal ${svc} $*"
}

# The config hash a serving container of this service carries: rendered with
# the very settings its serving start uses, never the shell's or .env's.
serving_config_hash() {
  env "$(image_var "$1")=$2" SFU_START_DRAINING=false SFU_RESTART_POLICY=unless-stopped "${COMPOSE[@]}" config --hash "$1" | awk '{print $2}'
}

# One rule for "serving", used for the last-known-good image, the deploy's
# final check and whether a rollback restored the instance: its container runs
# the image (when one is given) and did not boot drained, /health says
# healthy, its own /status says healthy and not draining, and its public route
# reaches it. One look, no waiting; SERVING_WHY says what failed.
SERVING_WHY=""
SERVING_IMAGE=""
serving() {
  local svc="$1" image="${2:-}" container env url status running
  SERVING_IMAGE=""
  container="$(service_container "$svc")" || container=""
  if [[ -z "$container" ]]; then SERVING_WHY="it has no container"; return 1; fi
  running="$(container_image "$svc")"
  if [[ -z "$running" ]]; then SERVING_WHY="Docker cannot read its container's image"; return 1; fi
  if [[ -n "$image" && "$running" != "$image" ]]; then SERVING_WHY="its container runs ${running:-no image}, not ${image}"; return 1; fi
  if ! env="$(docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' "$container" 2>/dev/null)"; then
    SERVING_WHY="Docker cannot read its container's env"; return 1
  fi
  if grep -qx 'SFU_DRAINING=true' <<< "$env"; then SERVING_WHY="its container booted drained"; return 1; fi
  url="$(service_url "$svc")"
  local health public verdict
  health="$(curl -fsS --connect-timeout 2 --max-time 3 "${url}/health" 2>/dev/null || true)"
  status="$(status_json "$url")"
  public="$(status_json "$(service_public_url "$svc")")"
  # One parse for all three answers: the verdict is empty when it serves.
  verdict="$(HEALTH="$health" STATUS="$status" PUBLIC="$public" node -e '
const read = (name) => { try { return JSON.parse(process.env[name] || "null") || {}; } catch { return {}; } };
const [health, status, publicStatus] = [read("HEALTH"), read("STATUS"), read("PUBLIC")];
const [svc, expected, url, publicUrl] = process.argv.slice(1);
const why =
  health.status !== "healthy" ? `${url}/health does not say healthy` :
  status.instanceId === undefined ? "its /status cannot be read" :
  status.instanceId !== expected ? `its management URL answers as ${status.instanceId}, not ${expected}` :
  status.healthy !== true ? "its /status says unhealthy" :
  status.draining !== false ? "it is draining" :
  publicStatus.instanceId !== expected ? `its public URL ${publicUrl} reaches ${publicStatus.instanceId ?? "nothing"}` :
  publicStatus.healthy !== true ? `its public URL ${publicUrl} does not report healthy` : "";
process.stdout.write(why);
' "$svc" "${EXPECTED_ID[$svc]:-$svc}" "$url" "$(service_public_url "$svc")")"
  if [[ -n "$verdict" ]]; then SERVING_WHY="$verdict"; return 1; fi
  SERVING_WHY=""
  SERVING_IMAGE="$running"
}

# serving, waited for up to HEALTH_TIMEOUT_SECONDS.
wait_serving() {
  local start_ts
  start_ts="$(date +%s)"
  until serving "$@"; do
    if (( $(date +%s) - start_ts >= HEALTH_TIMEOUT_SECONDS )); then
      return 1
    fi
    sleep "$POLL_SECONDS"
  done
}

# Puts an instance back on its last-known-good image, which it counts as
# restored only once it is serving by the rule above. With none there is
# nothing known-good to return to, so it is stopped rather than left serving a
# build that failed its canary. Returns 1 whenever the instance is not serving.
restore_lkg() {
  local svc="$1" url="$2" image_name="$3" lkg="$4"
  if [[ -z "$lkg" ]]; then
    "${COMPOSE[@]}" stop "$svc" || true
    checkpoint "stop ${svc}"
    journal_set "$svc" phase=idle candidate= prevLkg=
    echo "ERROR: ${svc} has no image it last served calls on; it is stopped. Check it now." >&2
    return 1
  fi
  echo "Rolling ${svc} back to its previous image..." >&2
  docker tag "$lkg" "$image_name"
  checkpoint "tag ${svc} back"
  if ! up_service "$svc" "$image_name" false; then
    checkpoint "start ${svc} back"
    echo "ERROR: compose could not restart ${svc} on its previous image; it is down. Check it now." >&2
    return 1
  fi
  checkpoint "start ${svc} back"
  if ! started_on "$svc" "$lkg" "$image_name"; then
    echo "ERROR: ${svc} is not back on its previous image. Check it now." >&2
    return 1
  fi
  if ! wait_serving "$svc" "$lkg"; then
    echo "ERROR: ${svc} is back on its previous image but is not serving (${SERVING_WHY}); check it now." >&2
    return 1
  fi
  journal_set "$svc" phase=idle lkg="$lkg" candidate= prevLkg=
  echo "${svc} is serving on its previous image again." >&2
}

# Puts back the drain state an instance had before this deploy drained it,
# and moves its journal to idle only once its own /status confirms that state.
# Otherwise the journal stays drained, and the next deploy's repair tries
# again.
restore_drain_state() {
  local svc="$1" url="$2" was_draining="$3" status
  if [[ "$was_draining" != "true" ]]; then
    set_draining "$url" false >/dev/null || true
    checkpoint "undrain ${svc}"
  fi
  status="$(instance_status "$svc" 2>/dev/null)" || status=""
  if [[ -n "$status" && "$(printf "%s" "$status" | json_field draining)" == "$was_draining" ]]; then
    journal_set "$svc" phase=idle
    return 0
  fi
  echo "${svc} could not be confirmed back to draining=${was_draining}; the next deploy puts it back before anything else." >&2
  return 1
}

# A service's own image name must exist before anything changes, or a plain
# compose up after a pause or a crash would build the unchecked checkout. On a
# host whose running images carry other names, it is tagged from the
# instance's last-known-good image.
SEEDED=""
seed_service_tag() {
  local svc="$1" lkg="" image_name
  image_name="$(service_image_name "$svc")"
  docker image inspect "$image_name" >/dev/null 2>&1 && return 0
  serving "$svc" && lkg="$SERVING_IMAGE"
  [[ -n "$lkg" ]] || lkg="$(journal_get "$svc" lkg)"
  [[ -n "$lkg" ]] || lkg="$(docker image inspect -f '{{.Id}}' "${IMAGE_REPO}:rollback-${svc}" 2>/dev/null || true)"
  if [[ -z "$lkg" ]] || ! docker image inspect "$lkg" >/dev/null 2>&1; then
    return 1
  fi
  docker tag "$lkg" "$image_name" || return 1
  SEEDED+=" ${svc}"
  echo "Tagged ${svc}'s last-known-good image as ${image_name}, so compose never builds it from the checkout."
}

seed_service_tags() {
  local svc missing=""
  SEEDED=""
  for svc in "${ALL_SFU_SERVICES[@]}"; do
    seed_service_tag "$svc" || missing+=" ${svc}"
  done
  [[ -z "$SEEDED" ]] || checkpoint "seed${SEEDED}"
  if [[ "${1:-}" == "warn" ]]; then
    for svc in $missing; do
      echo "WARNING: $(service_image_name "$svc") does not exist and could not be tagged from a known-good image of ${svc}; a plain compose up would build the checkout." >&2
    done
  fi
  return 0
}

PROMOTE_WHY=""
promote() {
  local svc="$1" url="$2" image_name="$3" image="$4" prev="$5"
  journal_set "$svc" phase=promoting candidate="$image" prevLkg="$prev"
  docker tag "$image" "$image_name"
  checkpoint "tag ${svc}"
  if ! up_service "$svc" "$image_name" false; then
    checkpoint "start ${svc}"
    PROMOTE_WHY="compose could not start ${svc} serving on ${image}"
    return 1
  fi
  checkpoint "start ${svc}"
  if ! started_on "$svc" "$image" "$image_name"; then
    PROMOTE_WHY="${svc} is not running ${image} after it was started serving"
    return 1
  fi
  if ! wait_serving "$svc" "$image"; then
    PROMOTE_WHY="${svc} passed its canary but is not serving on ${image} (${SERVING_WHY})"
    return 1
  fi
  journal_set "$svc" phase=idle lkg="$image" candidate= prevLkg=
  docker tag "$image" "${IMAGE_REPO}:rollback-${svc}"
}

roll_back() {
  local svc="$1" url="$2" image_name="$3" lkg="$4" code=0 status
  [[ "$(journal_get "$svc" phase)" == "rollback" ]] || journal_set "$svc" phase=rollback
  if ! hold_down "$svc"; then
    status="$(instance_status "$svc" 2>/dev/null)" || status=""
    if ! [[ -n "$status" && "$(printf "%s" "$status" | json_field draining)" == "true" ]] && ! peers_serving "$svc"; then
      echo "${svc} may take meetings and no other instance serves, so it is not drained to roll it back now; it keeps running, and the next run of this script rolls it back once another instance serves." >&2
      return 1
    fi
  fi
  drain_and_wait "$svc" "$url" || code=$?
  if (( code == 3 )); then
    echo "Deploy paused: ${svc} is drained, but ${DRAIN_WHY}. It goes back to its previous image once its calls end; rerun this script then." >&2
    return 3
  elif (( code != 0 )); then
    echo "ERROR: ${svc} cannot be rolled back without risking its calls: ${DRAIN_WHY}. It is left as it is, and the next run of this script rolls it back." >&2
    return 5
  fi
  restore_lkg "$svc" "$url" "$image_name" "$lkg" || return 5
}

declare -A REPAIR_CODE=()
repair_interrupted() {
  local svc phase lkg candidate prev url image_name state code first=() rest=()
  for svc in "${ALL_SFU_SERVICES[@]}"; do
    case "$(container_state "$svc")" in
      stopped|restarting|absent) first+=("$svc") ;;
      *) rest+=("$svc") ;;
    esac
  done
  for svc in ${first[@]+"${first[@]}"} ${rest[@]+"${rest[@]}"}; do
    phase="$(journal_get "$svc" phase)"
    [[ -z "$phase" || "$phase" == "idle" ]] && continue
    url="$(service_url "$svc")"
    image_name="$(service_image_name "$svc")"
    lkg="$(journal_get "$svc" lkg)"
    candidate="$(journal_get "$svc" candidate)"
    prev="$(journal_get "$svc" prevLkg)"
    code=0
    echo "A deploy stopped while ${svc} was ${phase}; repairing it before anything else."
    case "$phase" in
      drained)
        state="$(container_state "$svc")"
        if [[ "$state" =~ ^(stopped|restarting|absent)$ ]]; then
          if [[ -n "$lkg" ]]; then
            roll_back "$svc" "$url" "$image_name" "$lkg" || code=$?
          else
            journal_set "$svc" phase=idle
          fi
        elif [[ -n "$lkg" && "$(container_image "$svc")" != "$lkg" ]]; then
          echo "ERROR: ${svc} runs $(container_image "$svc"), not its last-known-good image ${lkg}, so it is left as it is. Check it by hand." >&2
          code=$EXIT_NOT_RESTORED
        elif [[ "$(journal_get "$svc" wasDraining)" == "true" ]]; then
          journal_set "$svc" phase=idle
        else
          restore_drain_state "$svc" "$url" false || code=1
        fi
        ;;
      candidate|rollback)
        if [[ -n "$lkg" ]] && serving_confirmed "$svc" "$lkg"; then
          journal_set "$svc" phase=idle candidate= prevLkg=
        else
          roll_back "$svc" "$url" "$image_name" "$lkg" || code=$?
        fi
        ;;
      passed|promoting)
        [[ "$phase" == "passed" ]] && prev="$lkg"
        if [[ -n "$candidate" ]] && serving_confirmed "$svc" "$candidate"; then
          journal_set "$svc" phase=idle lkg="$candidate" candidate= prevLkg=
          docker tag "$candidate" "${IMAGE_REPO}:rollback-${svc}"
        elif [[ -n "$prev" ]] && serving_confirmed "$svc" "$prev"; then
          journal_set "$svc" phase=idle lkg="$prev" candidate= prevLkg=
        else
          state="$(container_state "$svc")"
          if [[ -n "$candidate" ]] && { [[ "$state" =~ ^(stopped|restarting|absent)$ ]] || { [[ "$(container_image "$svc")" == "$candidate" ]] && booted_drained "$svc"; }; }; then
            drain_and_wait "$svc" "$url" || code=$?
            if (( code == 0 )) && ! promote "$svc" "$url" "$image_name" "$candidate" "$prev"; then
              echo "${PROMOTE_WHY}; rolling ${svc} back." >&2
              roll_back "$svc" "$url" "$image_name" "$prev" || code=$?
            fi
          else
            roll_back "$svc" "$url" "$image_name" "$prev" || code=$?
          fi
        fi
        ;;
      *)
        echo "ERROR: ${svc}'s deploy journal has a phase this script does not know (${phase}); check it by hand." >&2
        code=1
        ;;
    esac
    (( code == 0 )) || REPAIR_CODE[$svc]=$code
  done
}

# Moves one instance onto TARGET_IMAGE without cutting a call: drain it, wait
# for its rooms to finish (or give up at the deadline and put it back), and
# only then start the build under its candidate tag, booting drained, for the
# canary call. Only a build that passed is tagged as the service's own image
# and restarted serving. Every step is in the instance's journal before it is
# taken.
deploy_service() {
  local svc="$1" relooked="${2:-}"
  local url image_name candidate container status="" lkg="" recorded settle_until=0 was_draining="false"
  url="$(service_url "$svc")"
  image_name="$(service_image_name "$svc")"
  candidate="$(candidate_tag "$svc")"
  container="$(service_container "$svc")"
  local phase
  phase="$(journal_get "$svc" phase)"
  if [[ -n "$phase" && "$phase" != "idle" ]]; then
    echo "" >&2
    echo "Deploy stopped: ${svc} is still ${phase} from an interrupted deploy, and the repair above could not finish it, so it was not drained or rebuilt. Rerun this script once that is resolved." >&2
    return "${REPAIR_CODE[$svc]:-1}"
  fi
  local status_code=1
  for _ in 1 2 3; do
    status_code=0
    status="$(instance_status "$svc")" || status_code=$?
    (( status_code == 1 )) || break
    sleep "$STATUS_RETRY_SECONDS"
  done
  if (( status_code == 2 )); then
    echo "${svc} was not drained or rebuilt." >&2
    return 1
  fi

  # The last-known-good image: the one it is serving on now, by the serving
  # rule, else the one its journal recorded the last time it served (or the
  # rollback-<service> tag an older release of this script kept). An image
  # that merely runs is never one.
  recorded="$(journal_get "$svc" lkg)"
  lkg="$recorded"
  [[ -n "$lkg" ]] || lkg="$(docker image inspect -f '{{.Id}}' "${IMAGE_REPO}:rollback-${svc}" 2>/dev/null || true)"
  if serving "$svc"; then
    lkg="$SERVING_IMAGE"
  fi
  if [[ -n "$lkg" ]] && ! docker image inspect "$lkg" >/dev/null 2>&1; then
    lkg=""
  fi

  # Deployed means the target passed its canary here (the journal says it is
  # this instance's last-known-good), with the current config, and serves.
  if [[ -n "$container" && "$recorded" == "$TARGET_IMAGE" && "$(container_image "$svc")" == "$TARGET_IMAGE" ]] &&
     [[ "$(docker inspect -f '{{index .Config.Labels "com.docker.compose.config-hash"}}' "$container")" == "$(serving_config_hash "$svc" "$image_name")" ]]; then
    if serving "$svc" "$TARGET_IMAGE"; then
      echo "${svc} already runs ${TARGET_COMMIT} with the current config; leaving it alone."
      return 0
    fi
    if [[ "$SERVING_WHY" == "its public URL"* ]]; then
      # An earlier run may have stopped here because clients could not reach
      # it; rebuilding it would not fix the route.
      echo "" >&2
      echo "Deploy stopped: ${svc} already runs ${TARGET_COMMIT}, but clients cannot reach it at its public URL." >&2
      echo "The instances after it were not drained. Fix the route, then rerun this script." >&2
      return 1
    fi
  fi

  if [[ -n "$status" ]]; then
    was_draining="$(printf "%s" "$status" | json_field draining || echo "false")"
    # An instance its clients cannot reach can be shown to serve neither
    # before a rebuild nor after one, so it is left as it is.
    if ! validate_public_route "$svc" "$(service_public_url "$svc")"; then
      echo "" >&2
      echo "Deploy stopped: clients cannot reach ${svc} at its public URL, so it was not drained or rebuilt." >&2
      echo "The instances after it were not drained. Fix the route, then rerun this script." >&2
      return 1
    fi
    if ! peers_serving "$svc"; then
      echo "${svc} was not drained or rebuilt. Bring the other instance back, then rerun this script." >&2
      return 1
    fi
    if serving "$svc" || { [[ -z "$lkg" ]] && wait_serving "$svc"; }; then
      lkg="$SERVING_IMAGE"
    elif [[ -z "$lkg" ]]; then
      echo "" >&2
      echo "Deploy stopped: ${svc} is not serving (${SERVING_WHY}) and no image it served on is on record, so a failed canary would leave it nothing to go back to. It was not drained or rebuilt; fix it, then rerun this script." >&2
      return 1
    fi
    journal_set "$svc" phase=drained lkg="$lkg" wasDraining="$was_draining" candidate= prevLkg= commit="$TARGET_COMMIT"
    [[ -n "$lkg" ]] && docker tag "$lkg" "${IMAGE_REPO}:rollback-${svc}"
    echo "Draining ${svc}..."
    local drain_response="" code=0
    if ! peers_serving "$svc"; then
      echo "${svc} was not drained or rebuilt. Bring the other instance back, then rerun this script." >&2
      restore_drain_state "$svc" "$url" "$was_draining" || true
      return 1
    fi
    drain_response="$(set_draining "$url" true)" || drain_response=""
    checkpoint "drain ${svc}"
    settle_until=$(( $(date +%s) + PLACEMENT_SETTLE_SECONDS ))
    if [[ "$FORCE_DRAIN" == "true" && "$(printf "%s" "$drain_response" | json_field forced || echo false)" == "true" ]]; then
      echo "Force drain applied to ${svc}; skipping the room wait."
    else
      drain_and_wait "$svc" "$url" "$settle_until" || code=$?
      if (( code == 3 )); then
        restore_drain_state "$svc" "$url" "$was_draining" || true
        echo "" >&2
        echo "Deploy paused: ${svc} did not drain within ${DRAIN_TIMEOUT_SECONDS}s; a meeting is still running on it." >&2
        echo "${svc} was not rebuilt and keeps serving its calls. Rerun this script once the meeting ends." >&2
        return "$EXIT_BLOCKED_BY_ROOMS"
      elif (( code != 0 )); then
        echo "Failed to drain ${svc} (${DRAIN_WHY}); not rebuilding it." >&2
        restore_drain_state "$svc" "$url" "$was_draining" || true
        return 1
      fi
    fi
  elif answers_http "$url"; then
    # Up but its status is unreadable: its rooms are unknown, so leave it.
    if [[ -z "$relooked" ]] && wait_status "$svc"; then
      deploy_service "$svc" relooked
      return
    fi
    echo "${svc} answers but its /status cannot be read; not rebuilding it." >&2
    return 1
  else
    if [[ -z "$relooked" && -z "$lkg" && "$(container_state "$svc")" =~ ^(stopped|restarting)$ ]]; then
      echo "${svc} is stopped and no image it served on is on record; giving Docker up to ${HEALTH_TIMEOUT_SECONDS}s to bring it back before it is rebuilt."
      if wait_serving "$svc"; then
        deploy_service "$svc" relooked
        return
      fi
    fi
    # Silent is not stopped: a wrong URL or proxy hides a container that may
    # still carry calls, however recently it started.
    case "$(hold_down "$svc" && echo down || container_state "$svc")" in
      down)
        echo "${svc} is not running; starting it without a drain."
        journal_set "$svc" phase=drained lkg="$lkg" wasDraining=true candidate= prevLkg= commit="$TARGET_COMMIT"
        settle_until=$(( $(date +%s) + PLACEMENT_SETTLE_SECONDS ))
        ;;
      stopped|restarting)
        echo "Docker could not keep ${svc}'s stopped container from restarting, so it could take calls while it is rebuilt; not rebuilding it." >&2
        return 1
        ;;
      running)
        if [[ -z "$relooked" ]] && wait_status "$svc"; then
          deploy_service "$svc" relooked
          return
        fi
        echo "${svc}'s container is running but nothing answers at ${url}; check that URL, or stop ${svc} if it is hung. Not rebuilding it." >&2
        return 1
        ;;
      *)
        echo "Docker could not report the state of ${svc}'s container, so it may still carry calls; not rebuilding it." >&2
        return 1
        ;;
    esac
  fi

  echo "Starting ${svc} on ${TARGET_COMMIT} under its candidate tag, out of rotation until its canary passes..."
  local failure="" code=0
  docker tag "$TARGET_IMAGE" "$candidate"
  checkpoint "tag candidate ${svc}"
  journal_set "$svc" phase=candidate candidate="$TARGET_IMAGE"
  up_service "$svc" "$candidate" true || failure="compose could not start ${svc} on ${TARGET_COMMIT}"
  checkpoint "start candidate ${svc}"
  [[ -n "$failure" ]] || started_on "$svc" "$TARGET_IMAGE" "$candidate" || failure="${svc} is not running ${TARGET_COMMIT}'s image"
  [[ -n "$failure" ]] || wait_for_healthy "$url" || failure="${svc} did not report healthy within ${HEALTH_TIMEOUT_SECONDS}s"
  [[ -n "$failure" ]] || run_canary "$svc" "$url" || failure="the canary call against ${svc} failed"
  checkpoint "canary ${svc}"
  if [[ -z "$failure" ]]; then
    drain_and_wait "$svc" "$url" "$settle_until" || code=$?
    if (( code == 3 )); then
      journal_set "$svc" phase=passed
      echo "" >&2
      echo "Deploy paused: ${svc} passed its canary, but a call is running on it while it is out of rotation." >&2
      echo "Rerun this script once that call ends." >&2
      return "$EXIT_BLOCKED_BY_ROOMS"
    elif (( code != 0 )); then
      failure="${svc} passed its canary, but ${DRAIN_WHY}"
    fi
  fi
  if [[ -z "$failure" ]] && ! promote "$svc" "$url" "$image_name" "$TARGET_IMAGE" "$lkg"; then
    failure="$PROMOTE_WHY"
  fi
  if [[ -n "$failure" ]]; then
    echo "" >&2
    echo "Deploy stopped: ${failure}." >&2
    code=0
    roll_back "$svc" "$url" "$image_name" "$lkg" || code=$?
    case "$code" in
      0)
        echo "Instances not yet deployed were left untouched and keep serving." >&2
        return "$EXIT_CANARY_FAILED"
        ;;
      3)
        return "$EXIT_BLOCKED_BY_ROOMS"
        ;;
      1)
        return 1
        ;;
      *)
        echo "${svc} is not serving. Instances not yet deployed were left untouched and keep serving." >&2
        return "$EXIT_NOT_RESTORED"
        ;;
    esac
  fi
  echo "${svc} passed its canary on ${TARGET_COMMIT} and is serving."
}

# Every service's image name must come from its SFU_IMAGE_<SERVICE> variable,
# or a candidate could only run under the service's own tag.
for svc in "${ALL_SFU_SERVICES[@]}"; do
  probe="conclave-deploy-probe:${svc}"
  named="$(env "$(image_var "$svc")=${probe}" SFU_RESTART_POLICY=no "${COMPOSE[@]}" config --format json | node -e "const c=JSON.parse(require('fs').readFileSync(0,'utf8'));const s=c.services[process.argv[1]];process.stdout.write(String(s.image||'')+' '+(s.build?'build':String(s.pull_policy||'missing'))+' '+String(s.restart||''))" "$svc")"
  if [[ "${named%% *}" != "$probe" ]]; then
    echo "${COMPOSE_FILE} must name ${svc}'s image as \${$(image_var "$svc"):-<name>}, so a candidate runs under its own tag and never under ${svc}'s." >&2
    exit 1
  fi
  if [[ "${named##* }" != "no" ]]; then
    echo "${COMPOSE_FILE} must set ${svc}'s restart policy as \${SFU_RESTART_POLICY:-unless-stopped}, so Docker never restarts a candidate that has not passed its canary." >&2
    exit 1
  fi
  pull="${named#* }"
  if [[ "${pull% *}" != "never" ]]; then
    echo "${COMPOSE_FILE} must give ${svc} pull_policy: never and no build, so a plain compose up refuses an image that is not there instead of building or pulling one that never passed a canary; the build belongs to the sfu-image service in the build profile." >&2
    exit 1
  fi
done
if ! image_build >/dev/null; then
  echo "${COMPOSE_FILE} must define the SFU build as the sfu-image service in the build profile." >&2
  exit 1
fi

for svc in "${ALL_SFU_SERVICES[@]}"; do
  EXPECTED_ID[$svc]="$(compose_service_env "$svc" SFU_INSTANCE_ID)"
  SERVICE_URL[$svc]="$(get_deploy_url "$svc")"
  PUBLIC_URL[$svc]="$(service_public_url "$svc")"
  IMAGE_NAME[$svc]="$(service_image_name "$svc")"
done

seed_service_tags
repair_interrupted
restore_service_when_none_serves
seed_service_tags warn

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
    mapfile -t target_build < <(image_build)
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
    mapfile -t canary_build < <(image_build)
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
for svc in "${ALL_SFU_SERVICES[@]}"; do
  if [[ -n "${REPAIR_CODE[$svc]:-}" ]]; then
    echo "" >&2
    echo "Deploy stopped: ${svc} is still being repaired from an interrupted deploy (see above); rerun this script." >&2
    exit "${REPAIR_CODE[$svc]}"
  fi
done
if [[ "$DEPLOY_BROWSER_LOCAL" == "true" ]]; then
  echo ""
  echo "=== Deploying Browser Service (local) ==="
  "${ROOT_DIR}/scripts/deploy-browser-service.sh"
fi

declare -A FINAL_SERVING=()
for svc in "${ALL_SFU_SERVICES[@]}"; do
  if [[ "$(journal_get "$svc" lkg)" != "$TARGET_IMAGE" ]]; then
    FINAL_SERVING[$svc]="its journal does not record ${TARGET_COMMIT} as its last-known-good image"
  elif serving "$svc" "$TARGET_IMAGE"; then
    FINAL_SERVING[$svc]=yes
  else
    FINAL_SERVING[$svc]="$SERVING_WHY"
  fi
done
for svc in "${ORDERED_SERVICES[@]}"; do
  if [[ "${FINAL_SERVING[$svc]}" != yes ]]; then
    echo "" >&2
    echo "Deploy stopped: ${svc} was deployed on ${TARGET_COMMIT} but is not serving now (${FINAL_SERVING[$svc]}). Check it now, then rerun this script." >&2
    exit 1
  fi
done
all_final_serving() {
  local svc
  for svc in "${ALL_SFU_SERVICES[@]}"; do
    [[ "${FINAL_SERVING[$svc]}" == yes ]] || return 1
  done
}

# The release record moves only once every instance runs the target, so a
# deploy or rollback of some instances (SFU_DEPLOY_SERVICES) keeps what the
# others still need: a partial rollback keeps its target for the rest.
if [[ "$ROLLBACK" == "true" ]] && ! all_final_serving; then
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
elif [[ "$TARGET_IMAGE" != "$LAST_GOOD_IMAGE" ]] && all_final_serving; then
  PREVIOUS_GOOD_COMMIT="$LAST_GOOD_COMMIT"
  PREVIOUS_GOOD_IMAGE="$LAST_GOOD_IMAGE"
  LAST_GOOD_COMMIT="$TARGET_COMMIT"
  LAST_GOOD_IMAGE="$TARGET_IMAGE"
  ROLLBACK_TARGET_COMMIT=""
  ROLLBACK_TARGET_IMAGE=""
  save_deploy_state
fi
echo "Last good release: ${LAST_GOOD_COMMIT}${PREVIOUS_GOOD_COMMIT:+ (--rollback returns to ${PREVIOUS_GOOD_COMMIT})}."

echo ""
echo "SFU deploy complete: ${ORDERED_SERVICES[*]} on ${TARGET_COMMIT}."
if [[ "$DEPLOY_BROWSER_LOCAL" == "true" ]]; then
  echo "Browser service deploy complete."
fi
