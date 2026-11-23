#!/usr/bin/env bash
# Nightly backup of the SFU host's durable state: every SQLite database in the
# state directory (scheduled meetings, scheduling, webinars), a Redis RDB
# snapshot, and the other files in that directory. The archive is encrypted
# to the age public key in BACKUP_AGE_RECIPIENTS_FILE, so this host can write
# backups but cannot read them, then uploaded to Azure Blob Storage with the
# VM's managed identity. See docs/ops/backups.md.
#
#   backup.sh               back up and upload
#   backup.sh --local-only  back up into BACKUP_LOCAL_DIR without uploading
set -euo pipefail
umask 077

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/backup/lib.sh
source "${SCRIPT_DIR}/lib.sh"

UPLOAD="true"
for arg in "$@"; do
  case "$arg" in
    --local-only) UPLOAD="false" ;;
    *) die "unknown argument: ${arg}" ;;
  esac
done

load_backup_config
recipients="${BACKUP_AGE_RECIPIENTS_FILE:-/etc/conclave/backup-recipients.txt}"
[[ -s "$recipients" ]] || die "no age recipients in ${recipients}"
for tool in age openssl python3; do
  command -v "$tool" >/dev/null || die "${tool} is not installed"
done
# Every file operation on the state dir and the payload runs in Python, so no
# path or name from the state dir passes through a shell.
state_py() {
  python3 -I "${SCRIPT_DIR}/backup_state.py" "$@"
}
# A second backup could release this one's fence or copy around it, and a
# deploy could start an SFU between the copies.
take_backup_lock
take_sfu_host_lock
# Nothing to back up is a failure, never an empty success.
[[ -d "$STATE_DIR" ]] || die "the state dir ${STATE_DIR} does not exist, so there is nothing to back up; check CONCLAVE_STATE_DIR"

stamp="$(date -u +%Y%m%dT%H%M%SZ)"
name="conclave-${BACKUP_NAME:-$(hostname -s)}-${stamp}"
mkdir -p "$BACKUP_LOCAL_DIR"
work="$(mktemp -d "${BACKUP_LOCAL_DIR}/.work.XXXXXX")"
fenced=()
trap 'release_fences; rm -rf "$work"' EXIT
payload="${work}/payload"
mkdir -p "${payload}/sqlite"
manifest="${payload}/MANIFEST"
{
  echo "created_at=${stamp}"
  echo "host=$(hostname)"
  echo "state_dir=${STATE_DIR}"
  [[ -n "${CONCLAVE_REPO:-}" ]] && echo "repo_commit=$(git -C "$CONCLAVE_REPO" rev-parse HEAD 2>/dev/null || echo unknown)"
} > "$manifest"

# Settled before the fence: every database a store opens (its own SQLite
# path, CONCLAVE_SQLITE_PATH or the compose default, as this host's config
# and each SFU container's env set them) is inside the state dir, exists, and
# leads to a regular file there.
state_py preflight "$STATE_DIR" "$CONTAINER_STATE_DIR" "$BACKUP_LOCAL_DIR" || die "nothing was archived"

# One point in time for SQLite and Redis: every SFU holds its durable writes
# behind a short fence while both are copied, and the release lets them
# through. The hold belongs to this run's owner token: only it renews or
# releases the hold, and the SFU lifts it at its deadline if this run dies.
# Every configured SFU must hold the fence or be one Docker reports stopped;
# an SFU that answers but will not hold it stops the backup.
FENCE_HOLD_MS="${BACKUP_FENCE_HOLD_MS:-20000}"
# A copy must finish with this much of the hold left, so a deadline that
# lapses while the copy wraps up never passes.
FENCE_MARGIN_MS=2000
fence_until=0
owner="backup-$(od -An -tx1 -N12 /dev/urandom | tr -d ' \n')"
fence_request() {
  curl -s --max-time 30 -w $'\n%{http_code}' -X "$1" -H "x-sfu-secret: ${SFU_SECRET:-}" \
    -H "content-type: application/json" -d "$3" "${2}/admin/persistence-fence" || true
}
release_fences() {
  local base
  for base in "${fenced[@]}"; do
    fence_request DELETE "$base" "{\"owner\": \"${owner}\"}" >/dev/null
  done
  fenced=()
}
# The earliest deadline among the held fences, in milliseconds.
note_until() {
  local until
  until="$(json_field until <<< "$1")"
  [[ "$until" =~ ^[0-9]+$ ]] || die "the SFU at ${2} answered the fence without a deadline"
  (( fence_until == 0 || until < fence_until )) && fence_until="$until"
  return 0
}
# Runs after each copy. The hold that covered it must still have
# FENCE_MARGIN_MS left, and a renewal must succeed, which it does only while
# this run's hold has never lapsed: an SFU that restarted, or whose hold ran
# out, has no hold for this owner. The Docker check runs again too, for an
# SFU that started meanwhile.
writers_fenced() {
  FENCE_HELD="$(printf '%s\n' "${held[@]}")" FENCE_UNANSWERED="$(printf '%s\n' "${unanswered[@]}")" state_py fenced "$STATE_DIR" ||
    die "an SFU could write while the backup copies; nothing was archived"
}
renew_fences() {
  local base reply left
  if (( ${#fenced[@]} == 0 )); then
    writers_fenced
    return 0
  fi
  left=$(( fence_until - $(now_ms) ))
  (( left >= FENCE_MARGIN_MS )) ||
    die "only ${left} ms of the write fence was left when the copy finished (at least ${FENCE_MARGIN_MS} ms needed); raise BACKUP_FENCE_HOLD_MS"
  fence_until=0
  for base in "${fenced[@]}"; do
    reply="$(fence_request POST "$base" "{\"owner\": \"${owner}\", \"holdMs\": ${FENCE_HOLD_MS}, \"renew\": true}")"
    [[ "${reply##*$'\n'}" == 200 ]] ||
      die "the SFU at ${base} no longer holds this backup's write fence (it lapsed or the SFU restarted), so the copies may not be from one point in time; rerun the backup"
    note_until "${reply%$'\n'*}" "$base"
  done
  writers_fenced
}
held=()
unanswered=()
for health in ${CONCLAVE_SFU_HEALTH_URLS:-http://127.0.0.1:3031/health http://127.0.0.1:3032/health}; do
  base="${health%/health}"
  reply="$(fence_request POST "$base" "{\"owner\": \"${owner}\", \"holdMs\": ${FENCE_HOLD_MS}}")"
  code="${reply##*$'\n'}"
  if [[ "$code" == 000 ]]; then
    unanswered+=("$health")
    continue
  fi
  instance="$(json_field instanceId <<< "${reply%$'\n'*}")"
  if [[ "$code" != 200 || -z "$instance" ]]; then
    die "the SFU at ${base} did not hold the write fence (HTTP ${code}); deploy an SFU with /admin/persistence-fence before backing up"
  fi
  fenced+=("$base")
  held+=("${base} ${instance}")
  note_until "${reply%$'\n'*}" "$base"
done
writers_fenced
(( ${#fenced[@]} > 0 )) && log "Holding the write fence on ${#fenced[@]} SFU(s)"

# SQLite: the online backup API copies a consistent snapshot while the SFUs
# keep writing; copying the file (or its WAL) directly would not. Each
# database keeps its path below the state dir, so a restore puts it back
# where the SFU opens it. A database the SFU opens through a link is copied
# once, at the path the link reaches, and every link on the way is recorded
# relative, so the chain comes back with it and never on its own.
state_py copy "$STATE_DIR" "$CONTAINER_STATE_DIR" "$payload" || die "the SQLite copies failed; nothing was archived"

renew_fences

# Redis: redis-cli --rdb asks the server for a fresh point-in-time snapshot
# (the same fork as BGSAVE) and streams it here, so it works whether Redis
# runs from a package or a container, and never reads a dump file mid-write.
if [[ -n "$REDIS_SOURCE_URL" ]]; then
  command -v redis-cli >/dev/null || die "redis-cli is not installed"
  mkdir -p "${payload}/redis"
  parse_redis_url "$REDIS_SOURCE_URL"
  log "Redis snapshot from ${REDIS_HOST}:${REDIS_PORT}"
  redis_cli --rdb "${payload}/redis/dump.rdb" >/dev/null
  if command -v redis-check-rdb >/dev/null; then
    redis-check-rdb "${payload}/redis/dump.rdb" >/dev/null || die "redis-check-rdb rejected the snapshot"
  fi
  {
    echo "redis.version=$(redis_cli INFO server | sed -nE 's/^redis_version:([^[:space:]]+).*/\1/p')"
    echo "redis.pattern=${REDIS_KEY_PATTERN}"
    echo "redis.keys=$(redis_cli --scan --pattern "$REDIS_KEY_PATTERN" | wc -l | tr -d ' ')"
  } >> "$manifest"
fi

if [[ -n "$REDIS_SOURCE_URL" ]]; then
  [[ -s "${payload}/redis/dump.rdb" ]] || die "the Redis snapshot is missing from the backup; nothing was archived"
fi

# Everything else in the state directory (JSON stores and the like), inside
# the fence, so it is from the same point in time as the databases: files and
# directories only, a hard link stored whole, and any other link or special
# file left out. Every database, recorded link and SQLite side file is left
# out by its path.
state_py pack "$STATE_DIR" "$payload" || die "could not archive the other files in ${STATE_DIR}; nothing was archived"

renew_fences
if (( ${#fenced[@]} > 0 )); then
  release_fences
  log "Released the write fence"
fi

# A backup counts only if it would restore: the restore's own checks run
# over the payload first, so a failure keeps the previous archives.
state_py validate "$STATE_DIR" "$CONTAINER_STATE_DIR" "$payload" ||
  die "this backup would not restore (see above), so it was not kept; the previous archives are untouched"

state_py seal "$payload" | age --encrypt -R "$recipients" -o "${work}/${name}.tar.gz.age" ||
  die "could not write the encrypted archive; nothing was rotated"
# The finished archive is kept on the VM before the upload, so an Azure or
# identity outage still leaves tonight's backup here. The job still fails, and
# the heartbeat is not sent.
mv "${work}/${name}.tar.gz.age" "${BACKUP_LOCAL_DIR}/"
archive="${BACKUP_LOCAL_DIR}/${name}.tar.gz.age"
if [[ ! -s "$archive" || "$(head -c 21 "$archive")" != "age-encryption.org/v1" ]]; then
  rm -f "$archive"
  die "the encrypted archive was not written whole; nothing was rotated"
fi
# Only now, with tonight's archive complete and checked, does every exit keep
# just the newest BACKUP_LOCAL_KEEP archives, so nights whose upload failed
# cannot fill the disk and no run ever rotates away the last complete one.
keep="${BACKUP_LOCAL_KEEP:-3}"
(( keep >= 1 )) || keep=1
prune_local_archives() {
  local archives i
  mapfile -t archives < <(shopt -s nullglob; for found in "${BACKUP_LOCAL_DIR}"/conclave-*.tar.gz.age; do printf '%s\n' "$found"; done | by_stamp)
  for ((i = 0; i < ${#archives[@]} - keep; i++)); do
    rm -f "${archives[i]}"
  done
}
trap 'release_fences; rm -rf "$work"; prune_local_archives' EXIT
size="$(wc -c < "$archive" | tr -d ' ')"
log "Encrypted archive ${archive} (${size} bytes)"

if [[ "$UPLOAD" == "true" ]]; then
  year="${stamp:0:4}"
  month="${stamp:4:2}"
  blob_put "$archive" "daily/${year}/${month}/${name}.tar.gz.age"
  log "Uploaded daily/${year}/${month}/${name}.tar.gz.age"
  # The first successful backup of each month is also kept as a monthly one,
  # so a failed run on the 1st does not lose the month.
  if [[ -z "$(blob_list "monthly/${year}-${month}/")" ]]; then
    blob_put "$archive" "monthly/${year}-${month}/${name}.tar.gz.age"
    log "Uploaded monthly/${year}-${month}/${name}.tar.gz.age"
  fi
fi

if [[ -n "${BACKUP_HEARTBEAT_URL:-}" ]]; then
  curl -fsS --max-time 10 --retry 3 "$BACKUP_HEARTBEAT_URL" >/dev/null || log "warning: heartbeat ping failed"
fi
log "Backup ${name} complete"
