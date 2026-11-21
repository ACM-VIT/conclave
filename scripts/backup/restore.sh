#!/usr/bin/env bash
# Restores a backup made by backup.sh. Without --yes it only downloads,
# decrypts and verifies the archive and prints what it would change.
#
#   restore.sh --list
#   restore.sh --identity key.txt --latest [--yes]
#   restore.sh --identity key.txt --blob daily/2026/11/conclave-...tar.gz.age [--yes]
#   restore.sh --identity key.txt --file /var/backups/conclave/conclave-...tar.gz.age [--yes]
#
# --only sqlite,redis,files   restore a subset (default: all three)
# --redis-pattern 'glob'      Redis keys to restore (default: the SFU persistence prefix)
#
# Stop the SFU containers first: the SFUs hold the databases open and keep
# their state in memory, so they must start fresh on the restored data.
set -euo pipefail
umask 077

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/backup/lib.sh
source "${SCRIPT_DIR}/lib.sh"

identity=""
source_file=""
source_blob=""
latest="false"
list="false"
apply="false"
only="sqlite,redis,files"
pattern=""
while (( $# > 0 )); do
  case "$1" in
    --identity) identity="$2"; shift ;;
    --file) source_file="$2"; shift ;;
    --blob) source_blob="$2"; shift ;;
    --latest) latest="true" ;;
    --list) list="true" ;;
    --only) only="$2"; shift ;;
    --redis-pattern) pattern="$2"; shift ;;
    --yes) apply="true" ;;
    *) die "unknown argument: $1" ;;
  esac
  shift
done

load_backup_config
[[ -n "$pattern" ]] && REDIS_KEY_PATTERN="$pattern"
wants() { [[ ",${only}," == *",$1,"* ]]; }

if [[ "$list" == "true" ]]; then
  blob_list "monthly/"
  blob_list "daily/"
  exit 0
fi

[[ -f "$identity" ]] || die "--identity must point at the age private key file"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
archive="${work}/backup.tar.gz.age"
if [[ -n "$source_file" ]]; then
  cp "$source_file" "$archive"
elif [[ -n "$source_blob" || "$latest" == "true" ]]; then
  if [[ "$latest" == "true" ]]; then
    source_blob="$(blob_list "daily/" | tail -n 1)"
    [[ -n "$source_blob" ]] || die "no daily backups found"
  fi
  log "Downloading ${source_blob}"
  blob_get "$source_blob" "$archive"
else
  die "pick a backup with --file, --blob or --latest"
fi

payload="${work}/payload"
mkdir -p "$payload"
age --decrypt -i "$identity" "$archive" | tar -C "$payload" -xzf -
(cd "$payload" && sha256sum -c --quiet SHA256SUMS) || die "checksums do not match; the archive is damaged"
shopt -s nullglob
for db in "${payload}"/sqlite/*.sqlite; do
  [[ "$(sqlite3 "$db" "PRAGMA integrity_check;")" == "ok" ]] || die "$(basename "$db") failed its integrity check"
done
shopt -u nullglob
log "Archive verified. Manifest:"
sed 's/^/  /' "${payload}/MANIFEST"

if [[ "$apply" != "true" ]]; then
  echo ""
  echo "Dry run: nothing changed. Rerun with --yes to restore ${only} into ${STATE_DIR}."
  exit 0
fi

for url in ${CONCLAVE_SFU_HEALTH_URLS:-http://127.0.0.1:3031/health http://127.0.0.1:3032/health}; do
  if curl -fsS --max-time 3 "$url" >/dev/null 2>&1; then
    die "an SFU still answers at ${url}; stop the SFU containers before restoring"
  fi
done

stamp="$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -p "$STATE_DIR"

if wants sqlite; then
  shopt -s nullglob
  for db in "${payload}"/sqlite/*.sqlite; do
    dest="${STATE_DIR}/$(basename "$db")"
    # The live database and its WAL move aside together, so they stay a
    # consistent pair if this restore has to be undone.
    for suffix in "" "-wal" "-shm"; do
      [[ -e "${dest}${suffix}" ]] && mv "${dest}${suffix}" "${dest}${suffix}.pre-restore-${stamp}"
    done
    cp "$db" "${dest}.restore-tmp"
    mv "${dest}.restore-tmp" "$dest"
    log "Restored ${dest} (previous copy kept as ${dest}.pre-restore-${stamp})"
  done
  shopt -u nullglob
fi

if wants files && [[ -f "${payload}/state-files.tar" ]]; then
  tar -C "$STATE_DIR" -xf "${payload}/state-files.tar"
  log "Restored the other files in ${STATE_DIR}"
fi

# Redis: load the snapshot into a throwaway server, then copy the matching
# keys into the live one with MIGRATE COPY REPLACE. Only the durable keys come
# back; room leases and presence from the night before stay gone.
if wants redis && [[ -f "${payload}/redis/dump.rdb" ]]; then
  [[ -n "$REDIS_SOURCE_URL" ]] || die "no Redis URL configured to restore into"
  parse_redis_url "$REDIS_SOURCE_URL"
  scratch="${work}/redis"
  mkdir -p "$scratch"
  mv "${payload}/redis/dump.rdb" "${scratch}/dump.rdb"
  socket="${scratch}/redis.sock"
  if command -v redis-server >/dev/null; then
    redis-server --port 0 --unixsocket "$socket" --dir "$scratch" --dbfilename dump.rdb \
      --save "" --appendonly no --daemonize no > "${scratch}/server.log" 2>&1 &
    scratch_pid=$!
    trap 'kill "$scratch_pid" 2>/dev/null || true; rm -rf "$work"' EXIT
  else
    # Same major.minor as the live server, so its RDB format loads.
    version="$(redis_cli INFO server | sed -nE 's/^redis_version:([0-9]+\.[0-9]+).*/\1/p')"
    # Host networking lets it dial the live Redis; it listens on the socket only.
    docker run --rm -d --name "conclave-restore-redis-$$" --network host -v "${scratch}:/data" \
      "redis:${version}" redis-server --port 0 --unixsocket /data/redis.sock --unixsocketperm 777 \
      --dir /data --dbfilename dump.rdb --save "" --appendonly no >/dev/null
    trap 'docker rm -f "conclave-restore-redis-$$" >/dev/null 2>&1 || true; rm -rf "$work"' EXIT
  fi
  for _ in $(seq 1 60); do
    [[ -S "$socket" ]] && redis-cli -s "$socket" PING 2>/dev/null | grep -qx PONG && break
    sleep 0.5
  done
  redis-cli -s "$socket" PING 2>/dev/null | grep -qx PONG || die "the snapshot did not load; see ${scratch}/server.log"

  auth=()
  if [[ -n "$REDIS_USER" ]]; then
    auth=(AUTH2 "$REDIS_USER" "$REDIS_PASS")
  elif [[ -n "$REDIS_PASS" ]]; then
    auth=(AUTH "$REDIS_PASS")
  fi
  # redis-cli's own quoting: double quotes with \\ and \" escapes.
  quote_args() {
    local arg
    for arg in "$@"; do
      arg="${arg//\\/\\\\}"
      printf '"%s" ' "${arg//\"/\\\"}"
    done
  }
  # The scratch server dials the live one itself; "localhost" can resolve to
  # ::1 first while Redis listens on 127.0.0.1 only.
  target_host="$REDIS_HOST"
  [[ "$target_host" == "localhost" ]] && target_host="127.0.0.1"
  total=0
  while mapfile -t -n 200 batch && (( ${#batch[@]} > 0 )); do
    # Commands go over stdin so the password never reaches argv.
    reply="$({ quote_args MIGRATE "$target_host" "$REDIS_PORT" "" "$REDIS_DB" 10000 COPY REPLACE "${auth[@]}" KEYS "${batch[@]}"; echo; } |
      redis-cli -s "$socket" -n "$REDIS_DB")"
    [[ "$reply" == "OK" ]] || die "MIGRATE into ${target_host}:${REDIS_PORT} failed: ${reply}"
    total=$((total + ${#batch[@]}))
  done < <(redis-cli -s "$socket" -n "$REDIS_DB" --scan --pattern "$REDIS_KEY_PATTERN")
  log "Restored ${total} Redis keys matching ${REDIS_KEY_PATTERN}"
  redis-cli -s "$socket" SHUTDOWN NOSAVE >/dev/null 2>&1 || true
fi

echo ""
echo "Restore applied. Start the SFUs again (docker compose -f docker-compose.sfu.yml up -d sfu-a sfu-b)"
echo "and check that the scheduled meetings and webinars are back."
