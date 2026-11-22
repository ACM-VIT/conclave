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
for tool in age sqlite3 sha256sum openssl tar python3; do
  command -v "$tool" >/dev/null || die "${tool} is not installed"
done
# A second backup could release this one's fence or copy around it.
take_backup_lock

stamp="$(date -u +%Y%m%dT%H%M%SZ)"
name="conclave-${BACKUP_NAME:-$(hostname -s)}-${stamp}"
mkdir -p "$BACKUP_LOCAL_DIR"
work="$(mktemp -d "${BACKUP_LOCAL_DIR}/.work.XXXXXX")"
fenced=()
trap 'release_fences; rm -rf "$work"' EXIT
payload="${work}/payload"
mkdir -p "${payload}/sqlite" "${payload}/redis"
manifest="${payload}/MANIFEST"
{
  echo "created_at=${stamp}"
  echo "host=$(hostname)"
  echo "state_dir=${STATE_DIR}"
  [[ -n "${CONCLAVE_REPO:-}" ]] && echo "repo_commit=$(git -C "$CONCLAVE_REPO" rev-parse HEAD 2>/dev/null || echo unknown)"
} > "$manifest"

sources=0

# The compose file hands the SFU its database as CONCLAVE_SQLITE_PATH. A
# database outside the mounted state dir lives in the container, is lost on
# every deploy, and cannot be backed up from the host.
configured="$(configured_database "$STATE_DIR")" ||
  die "CONCLAVE_SQLITE_PATH=${CONCLAVE_SQLITE_PATH} is outside the state dir, so it is not on the volume; move it under ${CONTAINER_STATE_DIR}"

# One point in time for SQLite and Redis: every SFU holds its durable writes
# behind a short fence while both are copied, and the release lets them
# through. The hold belongs to this run's owner token: only it renews or
# releases the hold, and the SFU lifts it at its deadline if this run dies.
# Every configured SFU must hold the fence or be one Docker reports stopped;
# an SFU that answers but will not hold it stops the backup.
FENCE_HOLD_MS="${BACKUP_FENCE_HOLD_MS:-20000}"
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
# A renewal succeeds only while this run's hold has never lapsed: an SFU that
# restarted, or whose hold ran out, has no hold for this owner. The Docker
# check runs again too, for an SFU that started meanwhile.
renew_fences() {
  local base
  for base in "${fenced[@]}"; do
    [[ "$(fence_request POST "$base" "{\"owner\": \"${owner}\", \"holdMs\": ${FENCE_HOLD_MS}, \"renew\": true}" | tail -n 1)" == 200 ]] ||
      die "the SFU at ${base} no longer holds this backup's write fence (it lapsed or the SFU restarted), so the copies may not be from one point in time; rerun the backup"
  done
  writers_fenced "$STATE_DIR" "${held_ids[*]}" "${unanswered[@]}" || die "an SFU could write while the backup copies; nothing was archived"
}
held_ids=()
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
  held_ids+=("$instance")
done
writers_fenced "$STATE_DIR" "${held_ids[*]}" "${unanswered[@]}" || die "an SFU could write while the backup copies; nothing was archived"
(( ${#fenced[@]} > 0 )) && log "Holding the write fence on ${#fenced[@]} SFU(s)"

# SQLite: the online backup API copies a consistent snapshot while the SFUs
# keep writing; copying the file (or its WAL) directly would not. Each
# database keeps its path below the state dir, so restore.sh puts it back
# where the SFU opens it. A database the SFU opens through a symlink is
# copied once, at the path the link reaches, and the link is recorded so
# restore.sh can recreate it. Every link on the way to the database belongs to
# the database, so the chain comes back with it and never on its own. The
# configured database gets the same, whatever it is named.
mapfile -t databases < <(sqlite_files "$STATE_DIR")
mapfile -t starts < <(sqlite_links "$STATE_DIR" | cut -f1)
if [[ -n "$configured" && -L "${STATE_DIR}/${configured}" ]]; then
  starts+=("$configured")
elif [[ -n "$configured" && -f "${STATE_DIR}/${configured}" ]]; then
  databases+=("$configured")
fi
links=()
: > "${payload}/sqlite-links"
for start in "${starts[@]}"; do
  chain="$(sqlite_link_chain "$STATE_DIR" "$start" "$CONTAINER_STATE_DIR")" ||
    die "${STATE_DIR}/${start} does not lead to a file inside the state dir"
  while IFS=$'\t' read -r kind rel target; do
    if [[ "$kind" == file ]]; then
      databases+=("$rel")
    elif ! printf '%s\n' "${links[@]}" | grep -qxF "$rel"; then
      links+=("$rel")
      printf '%s\t%s\n' "$rel" "$target" >> "${payload}/sqlite-links"
      echo "sqlite.link.${rel}=${target}" >> "$manifest"
    fi
  done <<< "$chain"
done
mapfile -t databases < <(printf '%s\n' "${databases[@]}" | grep -v '^$' | LC_ALL=C sort -u)
for rel in "${databases[@]}"; do
  db="${STATE_DIR}/${rel}"
  copy="${payload}/sqlite/${rel}"
  mkdir -p "$(dirname "$copy")"
  log "SQLite online backup of ${db}"
  sqlite3 -bail "$db" ".timeout 15000" ".backup '${copy}'"
  integrity="$(sqlite3 "$copy" "PRAGMA integrity_check;")"
  [[ "$integrity" == "ok" ]] || die "integrity check of the ${db} copy failed: ${integrity}"
  while read -r table; do
    echo "sqlite.${rel}.${table}=$(sqlite3 "$copy" "SELECT count(*) FROM \"${table}\";")" >> "$manifest"
  done < <(sqlite3 "$copy" "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name;")
  sources=$((sources + 1))
done

renew_fences

# Redis: redis-cli --rdb asks the server for a fresh point-in-time snapshot
# (the same fork as BGSAVE) and streams it here, so it works whether Redis
# runs from a package or a container, and never reads a dump file mid-write.
if [[ -n "$REDIS_SOURCE_URL" ]]; then
  command -v redis-cli >/dev/null || die "redis-cli is not installed"
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
  sources=$((sources + 1))
fi

(( sources > 0 )) || die "found no SQLite database in ${STATE_DIR} and no Redis URL; check the config"

renew_fences
if (( ${#fenced[@]} > 0 )); then
  release_fences
  log "Released the write fence"
fi

# Everything else in the state directory (JSON stores and the like).
# A database reached through a link need not end in .sqlite, so each one is
# excluded by its path as well.
if [[ -d "$STATE_DIR" ]]; then
  excludes=(--exclude='*.sqlite' --exclude='*.sqlite-wal' --exclude='*.sqlite-shm' --exclude='*.pre-restore-*')
  for rel in "${databases[@]}"; do
    excludes+=(--exclude="./${rel}" --exclude="./${rel}-wal" --exclude="./${rel}-shm" --exclude="./${rel}-journal")
  done
  for rel in "${links[@]}"; do
    excludes+=(--exclude="./${rel}")
  done
  tar -C "$STATE_DIR" "${excludes[@]}" -cf "${payload}/state-files.tar" .
fi

sums="$(cd "$payload" && find . -type f | sort | xargs sha256sum)"
printf '%s\n' "$sums" > "${payload}/SHA256SUMS"

tar -C "$payload" -czf - . | age --encrypt -R "$recipients" -o "${work}/${name}.tar.gz.age"
# The finished archive is kept on the VM before the upload, so an Azure or
# identity outage still leaves tonight's backup here. The job still fails, and
# the heartbeat is not sent.
mv "${work}/${name}.tar.gz.age" "${BACKUP_LOCAL_DIR}/"
archive="${BACKUP_LOCAL_DIR}/${name}.tar.gz.age"
# From here every exit keeps only the newest BACKUP_LOCAL_KEEP archives, so
# nights whose upload failed cannot fill the disk.
keep="${BACKUP_LOCAL_KEEP:-3}"
prune_local_archives() {
  local archives i
  mapfile -t archives < <(find "$BACKUP_LOCAL_DIR" -maxdepth 1 -name 'conclave-*.tar.gz.age' | by_stamp)
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
