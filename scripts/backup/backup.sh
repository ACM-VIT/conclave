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
for tool in age sqlite3 sha256sum openssl tar; do
  command -v "$tool" >/dev/null || die "${tool} is not installed"
done

stamp="$(date -u +%Y%m%dT%H%M%SZ)"
name="conclave-${BACKUP_NAME:-$(hostname -s)}-${stamp}"
mkdir -p "$BACKUP_LOCAL_DIR"
work="$(mktemp -d "${BACKUP_LOCAL_DIR}/.work.XXXXXX")"
trap 'rm -rf "$work"' EXIT
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

# The compose file mounts the state dir at this path and hands the SFU its
# database as CONCLAVE_SQLITE_PATH. A database outside the mount lives in the
# container, is lost on every deploy, and cannot be backed up from the host.
container_state_dir=/var/lib/conclave/recordings
if [[ -n "${CONCLAVE_SQLITE_PATH:-}" && "$CONCLAVE_SQLITE_PATH" != "${container_state_dir}/"* &&
  "$CONCLAVE_SQLITE_PATH" != "${STATE_DIR%/}/"* ]]; then
  die "CONCLAVE_SQLITE_PATH=${CONCLAVE_SQLITE_PATH} is outside the state dir, so it is not on the volume; move it under ${container_state_dir}"
fi

# SQLite: the online backup API copies a consistent snapshot while the SFUs
# keep writing; copying the file (or its WAL) directly would not. Each
# database keeps its path below the state dir, so restore.sh puts it back
# where the SFU opens it.
mapfile -t databases < <(sqlite_files "$STATE_DIR")
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

# Everything else in the state directory (JSON stores and the like).
if [[ -d "$STATE_DIR" ]]; then
  tar -C "$STATE_DIR" --exclude='*.sqlite' --exclude='*.sqlite-wal' --exclude='*.sqlite-shm' \
    --exclude='*.pre-restore-*' -cf "${payload}/state-files.tar" .
fi

sums="$(cd "$payload" && find . -type f | sort | xargs sha256sum)"
printf '%s\n' "$sums" > "${payload}/SHA256SUMS"

archive="${work}/${name}.tar.gz.age"
tar -C "$payload" -czf - . | age --encrypt -R "$recipients" -o "$archive"
size="$(wc -c < "$archive" | tr -d ' ')"
log "Encrypted archive ${name}.tar.gz.age (${size} bytes)"

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

mv "$archive" "${BACKUP_LOCAL_DIR}/"
keep="${BACKUP_LOCAL_KEEP:-3}"
find "$BACKUP_LOCAL_DIR" -maxdepth 1 -name 'conclave-*.tar.gz.age' | sort -r | tail -n "+$((keep + 1))" | while read -r old; do
  rm -f "$old"
done

if [[ -n "${BACKUP_HEARTBEAT_URL:-}" ]]; then
  curl -fsS --max-time 10 --retry 3 "$BACKUP_HEARTBEAT_URL" >/dev/null || log "warning: heartbeat ping failed"
fi
log "Backup ${name} complete"
