# Shared helpers for backup.sh and restore.sh. Source it; do not run it.
# shellcheck shell=bash

BACKUP_SCRIPTS="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

die() {
  echo "error: $*" >&2
  exit 1
}

log() {
  echo "[$(date -u +%H:%M:%SZ)] $*"
}

# Reads the repo's .env files (for the Redis URL and the state directory the
# SFU containers mount), then /etc/conclave/backup.env, which wins.
load_backup_config() {
  local config="${BACKUP_CONFIG:-/etc/conclave/backup.env}"
  [[ -f "$config" ]] || die "missing ${config} (copy scripts/backup/backup.env.example)"
  local repo
  repo="$(sed -nE 's/^CONCLAVE_REPO=//p' "$config" | tail -n 1 | tr -d '"')"
  set -a
  local env_file
  for env_file in "${repo}/.env" "${repo}/packages/sfu/.env"; do
    # shellcheck disable=SC1090
    [[ -n "$repo" && -f "$env_file" ]] && source "$env_file"
  done
  # shellcheck disable=SC1090
  source "$config"
  set +a

  # These are read by the scripts that source this file. The SFU containers
  # mount the state dir at CONTAINER_STATE_DIR (the compose files'
  # /var/lib/conclave/recordings unless CONCLAVE_CONTAINER_STATE_DIR says).
  CONTAINER_STATE_DIR="${CONCLAVE_CONTAINER_STATE_DIR:-/var/lib/conclave/recordings}"
  # shellcheck disable=SC2034
  STATE_DIR="${CONCLAVE_STATE_DIR:-${RECORDING_STORAGE_PATH:-/var/lib/conclave/recordings}}"
  BACKUP_LOCAL_DIR="${BACKUP_LOCAL_DIR:-/var/backups/conclave}"
  # shellcheck disable=SC2034
  REDIS_SOURCE_URL="${SFU_PERSISTENCE_REDIS_URL:-${SFU_REDIS_URL:-${REDIS_URL:-}}}"
  # shellcheck disable=SC2034
  REDIS_KEY_PATTERN="${BACKUP_REDIS_PATTERN:-$(redis_key_pattern)}"
}

redis_key_pattern() {
  PREFIX_IN="${SFU_PERSISTENCE_REDIS_KEY_PREFIX:-}" python3 -c '
import os, re
blank = "\t\n\v\f\r \u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff"
prefix = (os.environ["PREFIX_IN"].strip(blank) or "conclave:sfu:persistence").rstrip(":")
print(re.sub(r"([*?\[\]\\])", r"\\\1", prefix) + ":*")
'
}

# Splits a redis:// URL into REDIS_HOST, REDIS_PORT, REDIS_DB, REDIS_USER,
# REDIS_PASS and REDIS_TLS. The URL travels in the environment, not argv.
parse_redis_url() {
  local fields
  fields="$(REDIS_URL_IN="$1" python3 -c '
import os, urllib.parse as u
p = u.urlsplit(os.environ["REDIS_URL_IN"])
print(p.hostname or "127.0.0.1")
print(p.port or 6379)
print(p.path.strip("/") or "0")
print(u.unquote(p.username or ""))
print(u.unquote(p.password or ""))
print("1" if p.scheme == "rediss" else "0")
')"
  {
    read -r REDIS_HOST
    read -r REDIS_PORT
    read -r REDIS_DB
    read -r REDIS_USER
    read -r REDIS_PASS
    read -r REDIS_TLS
  } <<< "$fields"
}

# redis-cli against the parsed URL. The password goes through REDISCLI_AUTH so
# it never shows up in the process list. An empty REDISCLI_AUTH still sends
# AUTH, which a Redis without a password rejects, so it is only set when there
# is one.
redis_cli() (
  args=(-h "$REDIS_HOST" -p "$REDIS_PORT" -n "$REDIS_DB")
  [[ -n "$REDIS_USER" ]] && args+=(--user "$REDIS_USER")
  [[ "$REDIS_TLS" == "1" ]] && args+=(--tls)
  unset REDISCLI_AUTH
  [[ -n "$REDIS_PASS" ]] && export REDISCLI_AUTH="$REDIS_PASS"
  exec redis-cli "${args[@]}" --no-auth-warning "$@"
)

# Orders archive names oldest first by the stamp in them
# (conclave-<host>-<YYYYMMDDTHHMMSSZ>.tar.gz.age), never by the whole name: a
# renamed host must not make an older archive look newer.
by_stamp() {
  sed -nE 's/^(.*-([0-9]{8}T[0-9]{6}Z)\.tar\.gz\.age)$/\2 \1/p' | LC_ALL=C sort | cut -d' ' -f2-
}

# Prints the id of a "user" or "group" name on this host. BACKUP_ID_LOOKUP,
# when set, is asked instead (`$BACKUP_ID_LOOKUP user|group NAME`), so the
# tests do not depend on the accounts of the host they run on.
host_id() {
  if [[ -n "${BACKUP_ID_LOOKUP:-}" ]]; then
    "$BACKUP_ID_LOOKUP" "$1" "$2"
    return
  fi
  KIND_IN="$1" NAME_IN="$2" python3 -c '
import grp, os, pwd
kind, name = os.environ["KIND_IN"], os.environ["NAME_IN"]
print(pwd.getpwnam(name).pw_uid if kind == "user" else grp.getgrnam(name).gr_gid)
' 2>/dev/null
}

# Resolves an explicit user:group to numeric uid:gid on this host, which is
# where the files are chowned.
host_ids() {
  local user="${1%%:*}" group="${1#*:}" uid gid
  if [[ "$user" =~ ^[0-9]+$ ]]; then uid="$user"; else uid="$(host_id user "$user")" || return 1; fi
  if [[ "$group" =~ ^[0-9]+$ ]]; then gid="$group"; else gid="$(host_id group "$group")" || return 1; fi
  [[ "$uid" =~ ^[0-9]+$ && "$gid" =~ ^[0-9]+$ ]] || return 1
  printf '%s:%s\n' "$uid" "$gid"
}

# Resolves a container's user ("name", "name:group", "uid" or "uid:gid") to
# numeric uid:gid inside its image, since the host may have no such accounts.
image_ids() {
  local image="$1" spec="$2" user="${2%%:*}" group="" uid gid
  [[ "$spec" == *:* ]] && group="${spec#*:}"
  if [[ "$user" =~ ^[0-9]+$ ]]; then
    uid="$user"
  else
    uid="$(docker run --rm --entrypoint id "$image" -u "$user" 2>/dev/null)" || return 1
  fi
  if [[ "$group" =~ ^[0-9]+$ ]]; then
    gid="$group"
  elif [[ -n "$group" ]]; then
    gid="$(docker run --rm --entrypoint getent "$image" group "$group" 2>/dev/null | cut -d: -f3)"
  else
    gid="$(docker run --rm --entrypoint id "$image" -g "$user" 2>/dev/null)"
  fi
  [[ "$uid" =~ ^[0-9]+$ && "$gid" =~ ^[0-9]+$ ]] || return 1
  printf '%s:%s\n' "$uid" "$gid"
}

# Prints the numeric uid:gid the SFU runs as, or nothing to leave files owned
# by root. An explicit user:group (from --owner or BACKUP_RESTORE_OWNER) wins.
# Otherwise the SFU containers that mount the state dir are asked for the user
# their image runs as. Only numeric ids reach restore_state.py, which gives
# them to the entries it creates and nothing else.
sfu_file_owner() {
  local explicit="$1" state_dir="$2" containers id status port instance spec image ids
  if [[ -n "$explicit" ]]; then
    [[ "$explicit" == ?*:?* ]] || return 1
    host_ids "$explicit"
    return
  fi
  containers="$(python3 -I "${BACKUP_SCRIPTS}/backup_state.py" containers "$state_dir")" || return 1
  while IFS='|' read -r id status port instance spec image; do
    [[ -n "$id" && "$status" != unknown ]] || continue
    [[ -n "$spec" ]] || return 0
    ids="$(image_ids "$image" "$spec")" || return 1
    [[ "${ids%%:*}" == 0 ]] || printf '%s\n' "$ids"
    return 0
  done <<< "$containers"
}

# One backup or restore at a time on this host. The lock lives in the local
# backup dir, which the systemd unit (whose /tmp is private) and a manual run
# share, and the kernel drops it however the run exits.
take_backup_lock() {
  command -v flock >/dev/null 2>&1 || die "flock is not installed (apt-get install util-linux)"
  mkdir -p "$BACKUP_LOCAL_DIR" || die "cannot create ${BACKUP_LOCAL_DIR} for the backup lock; set BACKUP_LOCAL_DIR"
  exec 8>>"${BACKUP_LOCAL_DIR}/.backup.lock"
  flock -n 8 || die "another backup or restore is running on this host (${BACKUP_LOCAL_DIR}/.backup.lock)"
  locked_file_is 8 "${BACKUP_LOCAL_DIR}/.backup.lock"
}

# A lock counts only on the file its path names now: the file can be
# replaced while a run waits, and the old one then guards nothing. Locks are
# always opened by path here, never inherited or taken on a flag's word, and
# checked by device and inode once held.
locked_file_is() {
  python3 -c 'import os, sys
held, named = os.fstat(int(sys.argv[1])), os.stat(sys.argv[2])
sys.exit(0 if (held.st_dev, held.st_ino) == (named.st_dev, named.st_ino) else 1)' "$1" "$2" ||
    die "${2} was replaced while this run waited for it; rerun it"
}

# No deploy may start or replace an SFU while a backup copies or a restore
# replaces files, so both hold the host's deploy lock (the one deploy-sfu.sh
# takes, in /run/lock, which the backup's systemd unit sees despite its
# private /tmp) for their whole run, waiting up to
# BACKUP_DEPLOY_LOCK_WAIT_SECONDS for a deploy already under way. The lock
# file is made and checked by scripts/host_lock.py, the same rules
# deploy-sfu.sh follows: a regular file no other user can open.
take_sfu_host_lock() {
  local lock="${SFU_DEPLOY_LOCK_FILE:-}" wait="${BACKUP_DEPLOY_LOCK_WAIT_SECONDS:-900}"
  if [[ -z "$lock" ]]; then
    if [[ -d /run/lock ]]; then lock=/run/lock/conclave-sfu-deploy.lock; else lock=/tmp/conclave-sfu-deploy.lock; fi
  fi
  python3 -I "${BACKUP_SCRIPTS}/../host_lock.py" prepare "$lock" || die "cannot use the host deploy lock ${lock}"
  exec 7<"$lock" || die "cannot open the host deploy lock ${lock}"
  if ! flock -n 7; then
    log "An SFU deploy holds ${lock}; waiting up to ${wait}s for it"
    flock -w "$wait" 7 || die "an SFU deploy held ${lock} for ${wait}s, so nothing was copied or replaced; rerun once the deploy ends"
  fi
  python3 -I "${BACKUP_SCRIPTS}/../host_lock.py" check 7 "$lock" || die "the host deploy lock ${lock} cannot be trusted (see above); nothing was copied or replaced"
}

# Prints one string or integer field of a JSON object read from stdin, or
# nothing.
json_field() {
  python3 -c 'import json, sys
try:
    value = json.load(sys.stdin).get(sys.argv[1], "")
except Exception:
    value = ""
print(value if isinstance(value, str) or (isinstance(value, int) and not isinstance(value, bool)) else "")' "$1"
}

# The time in milliseconds, the precision the SFU's fence deadlines use.
now_ms() {
  python3 -c 'import time; print(int(time.time() * 1000))'
}

# --- Azure Blob Storage over REST, authenticated by the VM's managed identity.

blob_base_url() {
  local endpoint="${AZURE_BLOB_ENDPOINT:-https://${AZURE_STORAGE_ACCOUNT:?AZURE_STORAGE_ACCOUNT is not set}.blob.core.windows.net}"
  printf "%s/%s" "${endpoint%/}" "${AZURE_STORAGE_CONTAINER:?AZURE_STORAGE_CONTAINER is not set}"
}

# Prints the request headers, bearer token included. Callers pipe them into
# curl -H @-, so the token never reaches argv or a file.
blob_auth_headers() {
  local imds="${AZURE_IMDS_ENDPOINT:-http://169.254.169.254}"
  local url="${imds%/}/metadata/identity/oauth2/token?api-version=2018-02-01&resource=https%3A%2F%2Fstorage.azure.com%2F"
  [[ -n "${AZURE_CLIENT_ID:-}" ]] && url+="&client_id=${AZURE_CLIENT_ID}"
  local token
  token="$(curl -fsS --max-time 10 --retry 3 -H "Metadata: true" "$url" | sed -nE 's/.*"access_token" *: *"([^"]+)".*/\1/p')"
  [[ -n "$token" ]] || die "the managed identity returned no storage token (is an identity assigned to this VM?)"
  printf 'Authorization: Bearer %s\nx-ms-version: 2021-08-06\n' "$token"
}

# Uploads a file. If-None-Match makes an existing blob an error rather than
# an overwrite, and Content-MD5 has the service reject a corrupted upload.
blob_put() {
  local file="$1" blob="$2" headers md5 status
  headers="$(blob_auth_headers)"
  md5="$(openssl dgst -md5 -binary "$file" | openssl base64)"
  status="$(curl -sS --max-time 900 -o /dev/null -w '%{http_code}' -X PUT -H @- \
    -H "x-ms-blob-type: BlockBlob" -H "If-None-Match: *" -H "Content-MD5: ${md5}" \
    -H "Content-Type: application/octet-stream" --data-binary @"$file" "$(blob_base_url)/${blob}" <<< "$headers" || true)"
  [[ "$status" == "201" ]] || die "upload of ${blob} failed with HTTP ${status}"
}

blob_get() {
  local blob="$1" out="$2" headers
  headers="$(blob_auth_headers)"
  curl -fsS --max-time 900 -H @- -o "$out" "$(blob_base_url)/${blob}" <<< "$headers" ||
    die "download of ${blob} failed"
}

# Prints blob names under a prefix, oldest name first (names sort by time).
blob_list() {
  local prefix="$1" headers listing
  headers="$(blob_auth_headers)"
  listing="$(curl -fsS --max-time 60 -H @- "$(blob_base_url)?restype=container&comp=list&prefix=${prefix}" <<< "$headers")" ||
    die "listing ${prefix} failed"
  { grep -oE '<Name>[^<]+</Name>' <<< "$listing" || true; } | sed -E 's#</?Name>##g' | sort
}
