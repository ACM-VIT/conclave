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
# --redis-pattern 'glob'      Redis keys to make match the backup (default: the SFU persistence prefix)
# --owner user:group          who owns the restored files (default: the user the
#                             SFU image runs as, found from its containers; root
#                             when it runs as root or none is found)
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
owner=""
while (( $# > 0 )); do
  case "$1" in
    --identity) identity="$2"; shift ;;
    --file) source_file="$2"; shift ;;
    --blob) source_blob="$2"; shift ;;
    --latest) latest="true" ;;
    --list) list="true" ;;
    --only) only="$2"; shift ;;
    --redis-pattern) pattern="$2"; shift ;;
    --owner) owner="$2"; shift ;;
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
    source_blob="$(blob_list "daily/" | by_stamp | tail -n 1)"
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
mapfile -t databases < <(sqlite_copies "${payload}/sqlite")
for rel in "${databases[@]}"; do
  [[ "$(sqlite3 "${payload}/sqlite/${rel}" "PRAGMA integrity_check;")" == "ok" ]] || die "${rel} failed its integrity check"
done
log "Archive verified. Manifest:"
sed 's/^/  /' "${payload}/MANIFEST"

# The Redis step runs last, so anything that would stop it is checked before
# the first file changes. MIGRATE runs inside the scratch server, which has no
# TLS client setup, so it cannot reach a rediss:// destination.
restore_redis="false"
if wants redis && [[ -f "${payload}/redis/dump.rdb" ]]; then
  restore_redis="true"
  [[ -n "$REDIS_SOURCE_URL" ]] || die "no Redis URL configured to restore into; set one, or pass --only sqlite,files"
  parse_redis_url "$REDIS_SOURCE_URL"
  [[ "$REDIS_TLS" != "1" ]] || die "cannot restore Redis keys into a TLS (rediss://) Redis; pass --only sqlite,files"
fi

if [[ "$apply" != "true" ]]; then
  echo ""
  echo "Dry run: nothing changed. Rerun with --yes to restore ${only} into ${STATE_DIR}."
  exit 0
fi

# A backup taken while files are being replaced would archive a half-restored
# state dir.
take_backup_lock

# Any HTTP answer, a 503 included, means an SFU process still holds the files.
for url in ${CONCLAVE_SFU_HEALTH_URLS:-http://127.0.0.1:3031/health http://127.0.0.1:3032/health}; do
  if [[ "$(curl -s -o /dev/null -w '%{http_code}' --max-time 3 "$url" || true)" != "000" ]]; then
    die "an SFU still answers at ${url}; stop the SFU containers before restoring"
  fi
done
# Silence is not proof: a wrong health URL misses a running SFU. An SFU holds
# its databases open for as long as it runs, in a container or not.
command -v fuser >/dev/null || die "fuser is not installed (apt-get install psmisc)"
# A link's path reaches the file it points to, whatever that file is named.
mapfile -t live_databases < <(sqlite_files "$STATE_DIR"; sqlite_links "$STATE_DIR" | cut -f1; configured_database "$STATE_DIR" || true)
for rel in "${live_databases[@]}"; do
  holders="$(fuser "${STATE_DIR}/${rel}" 2>/dev/null | xargs || true)"
  [[ -z "$holders" ]] || die "PID ${holders} still holds ${STATE_DIR}/${rel} open; stop the SFU containers before restoring"
done

# A lost state dir is the case a restore is for. It is created first, so the
# SFU containers that mount it are found again by its path.
mkdir -p "$STATE_DIR"

# Restored files go to the user the SFU runs as, or an image that drops root
# could not read them. Settled before the first file changes.
restore_owner="$(sfu_file_owner "${owner:-${BACKUP_RESTORE_OWNER:-}}" "$STATE_DIR")" ||
  die "cannot tell which user the SFU runs as; rerun with --owner user:group"
if [[ -n "$restore_owner" && "$EUID" != 0 && "$restore_owner" != "$(id -u):$(id -g)" ]]; then
  die "only root can give the restored files to ${restore_owner}; rerun restore.sh as root"
fi

stamp="$(date -u +%Y%m%dT%H%M%SZ)"

if wants sqlite; then
  for rel in "${databases[@]}"; do
    dest="${STATE_DIR}/${rel}"
    mkdir -p "$(dirname "$dest")"
    # The live database and its WAL move aside together, so they stay a
    # consistent pair if this restore has to be undone.
    for suffix in "" "-wal" "-shm"; do
      [[ -e "${dest}${suffix}" ]] && mv "${dest}${suffix}" "${dest}${suffix}.pre-restore-${stamp}"
    done
    cp "${payload}/sqlite/${rel}" "${dest}.restore-tmp"
    mv "${dest}.restore-tmp" "$dest"
    log "Restored ${dest} (previous copy kept as ${dest}.pre-restore-${stamp})"
  done
  # The links the SFU opens its databases through, as they were.
  if [[ -f "${payload}/sqlite-links" ]]; then
    while IFS=$'\t' read -r link target; do
      dest="${STATE_DIR}/${link}"
      [[ -L "$dest" && "$(readlink "$dest")" == "$target" ]] && continue
      mkdir -p "$(dirname "$dest")"
      if [[ -e "$dest" || -L "$dest" ]]; then
        mv "$dest" "${dest}.pre-restore-${stamp}"
      fi
      ln -s "$target" "$dest"
      log "Restored the link ${dest} -> ${target}"
    done < "${payload}/sqlite-links"
  fi
fi

if wants files && [[ -f "${payload}/state-files.tar" ]]; then
  tar -C "$STATE_DIR" -xf "${payload}/state-files.tar"
  log "Restored the other files in ${STATE_DIR}"
fi

if [[ -n "$restore_owner" ]] && { wants sqlite || wants files; }; then
  find "$STATE_DIR" \( ! -user "${restore_owner%%:*}" -o ! -group "${restore_owner##*:}" \) -exec chown -h "$restore_owner" {} + ||
    die "could not give ${STATE_DIR} to ${restore_owner}; the SFU cannot read files it does not own"
  log "Gave the files in ${STATE_DIR} to ${restore_owner}, the user the SFU runs as"
fi

# Redis: load the snapshot into a throwaway server, copy the matching keys
# into the live one with MIGRATE COPY REPLACE, then delete the live keys in
# that pattern the snapshot does not have. The SFUs prefer a Redis key over
# the restored SQLite copy, so a key written after the backup would otherwise
# outlive the restore. Keys outside the pattern, such as room leases and
# presence, are left alone.
if [[ "$restore_redis" == "true" ]]; then
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

  redis-cli -s "$socket" -n "$REDIS_DB" --scan --pattern "$REDIS_KEY_PATTERN" | LC_ALL=C sort -u > "${scratch}/backup-keys"
  redis_cli --scan --pattern "$REDIS_KEY_PATTERN" | LC_ALL=C sort -u > "${scratch}/live-keys"
  LC_ALL=C comm -13 "${scratch}/backup-keys" "${scratch}/live-keys" > "${scratch}/stale-keys"
  removed=0
  while mapfile -t -n 200 batch && (( ${#batch[@]} > 0 )); do
    reply="$({ quote_args DEL "${batch[@]}"; echo; } | redis_cli)"
    [[ "$reply" =~ ^[0-9]+$ ]] || die "deleting keys the backup does not have failed: ${reply}"
    removed=$((removed + ${#batch[@]}))
  done < "${scratch}/stale-keys"
  log "Deleted ${removed} Redis keys matching ${REDIS_KEY_PATTERN} that the backup does not have"
  redis-cli -s "$socket" SHUTDOWN NOSAVE >/dev/null 2>&1 || true
fi

echo ""
echo "Restore applied. Start the SFUs again (docker compose -f docker-compose.sfu.yml up -d sfu-a sfu-b)"
echo "and check that the scheduled meetings and webinars are back."
