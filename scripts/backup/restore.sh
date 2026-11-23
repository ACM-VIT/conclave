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
#
# This script only fetches and decrypts the archive and takes the host's
# locks. Everything that reads or writes what is inside the archive runs in
# scripts/backup/restore_state.py, which never hands a path from it to a
# shell: it verifies the archive in a private work dir, builds the restored
# tree beside the state dir and renames it in (see docs/ops/backups.md).
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
# The work dir is this user's alone (umask 077) and outside the state dir;
# restore_state.py checks both before it writes there.
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
age --decrypt -i "$identity" -o "${work}/backup.tar.gz" "$archive" || die "cannot decrypt the archive with ${identity}"
rm -f "$archive"

restore_args=(--archive "${work}/backup.tar.gz" --work "$work" --state "$STATE_DIR" --container "$CONTAINER_STATE_DIR" --only "$only")
if [[ "$apply" == "true" ]]; then
  # A backup taken while files are being replaced would archive a
  # half-restored state dir, and a deploy could start an SFU on them.
  take_backup_lock
  take_sfu_host_lock
  # Restored files go to the user the SFU runs as, or an image that drops
  # root could not read them. Settled before the first file changes.
  restore_owner="$(sfu_file_owner "${owner:-${BACKUP_RESTORE_OWNER:-}}" "$STATE_DIR")" ||
    die "cannot tell which user the SFU runs as; rerun with --owner user:group"
  if [[ -n "$restore_owner" && "$EUID" != 0 && "$restore_owner" != "$(id -u):$(id -g)" ]]; then
    die "only root can give the restored files to ${restore_owner}; rerun restore.sh as root"
  fi
  restore_args+=(--apply --stamp "$(date -u +%Y%m%dT%H%M%SZ)")
  [[ -n "$restore_owner" ]] && restore_args+=(--owner "$restore_owner")
fi

REDIS_SOURCE_URL="$REDIS_SOURCE_URL" REDIS_KEY_PATTERN="$REDIS_KEY_PATTERN" \
  SFU_HEALTH_URLS="${CONCLAVE_SFU_HEALTH_URLS:-http://127.0.0.1:3031/health http://127.0.0.1:3032/health}" \
  python3 -I "${SCRIPT_DIR}/restore_state.py" "${restore_args[@]}"
