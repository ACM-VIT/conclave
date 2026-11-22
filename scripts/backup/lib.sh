# Shared helpers for backup.sh and restore.sh. Source it; do not run it.
# shellcheck shell=bash

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

  # These are read by the scripts that source this file.
  # shellcheck disable=SC2034
  STATE_DIR="${CONCLAVE_STATE_DIR:-${RECORDING_STORAGE_PATH:-/var/lib/conclave/recordings}}"
  BACKUP_LOCAL_DIR="${BACKUP_LOCAL_DIR:-/var/backups/conclave}"
  # shellcheck disable=SC2034
  REDIS_SOURCE_URL="${SFU_PERSISTENCE_REDIS_URL:-${SFU_REDIS_URL:-${REDIS_URL:-}}}"
  # shellcheck disable=SC2034
  REDIS_KEY_PATTERN="${BACKUP_REDIS_PATTERN:-${SFU_PERSISTENCE_REDIS_KEY_PREFIX:-conclave:sfu:persistence}*}"
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

# Where the compose file mounts the state dir inside the SFU containers.
CONTAINER_STATE_DIR=/var/lib/conclave/recordings

# Prints the database the SFU is configured to open (CONCLAVE_SQLITE_PATH, the
# one the compose file passes to its containers) relative to the state dir,
# whatever its name, or nothing when it is unset. Fails when it is outside the
# state dir.
configured_database() {
  local state_dir="${1%/}" configured="${CONCLAVE_SQLITE_PATH:-}"
  [[ -n "$configured" ]] || return 0
  case "$configured" in
    "${CONTAINER_STATE_DIR}/"*) printf '%s\n' "${configured#"${CONTAINER_STATE_DIR}/"}" ;;
    "${state_dir}/"*) printf '%s\n' "${configured#"${state_dir}/"}" ;;
    *) return 1 ;;
  esac
}

# Prints every SQLite database under a directory, at any depth, as a path
# relative to it.
sqlite_files() {
  [[ -d "$1" ]] || return 0
  (cd "$1" && find . -type f -name '*.sqlite' | sed 's#^\./##' | LC_ALL=C sort)
}

# Prints the database copies in an archive's sqlite/ dir, relative to it:
# every file but SQLite's side files, since a database reached through a
# link need not end in .sqlite.
sqlite_copies() {
  [[ -d "$1" ]] || return 0
  (cd "$1" && find . -type f ! -name '*-wal' ! -name '*-shm' ! -name '*-journal' | sed 's#^\./##' | LC_ALL=C sort)
}

# Prints each *.sqlite symlink under a directory as "<path relative to
# it><TAB><target as written>".
sqlite_links() {
  [[ -d "$1" ]] || return 0
  (cd "$1" && find . -type l -name '*.sqlite' | sed 's#^\./##' | LC_ALL=C sort | while IFS= read -r link; do
    printf '%s\t%s\n' "$link" "$(readlink "$link")"
  done)
}

# Prints the file a symlink below the state dir reaches, relative to the state
# dir. An absolute target may name the container's mount of the state dir.
# Fails when the target is missing or outside the state dir.
sqlite_link_target() {
  STATE_IN="$1" LINK_IN="$2" CONTAINER_IN="$3" python3 -c '
import os, sys
state = os.path.realpath(os.environ["STATE_IN"])
link = os.path.join(state, os.environ["LINK_IN"])
target = os.readlink(link)
container = os.environ["CONTAINER_IN"].rstrip("/")
if target == container or target.startswith(container + "/"):
    target = state + target[len(container):]
path = os.path.realpath(os.path.join(os.path.dirname(link), target))
rel = os.path.relpath(path, state)
if rel == ".." or rel.startswith("../") or not os.path.isfile(path):
    sys.exit(1)
print(rel)
'
}

# redis-cli's own quoting for commands sent on stdin: double quotes with \\
# and \" escapes.
quote_args() {
  local arg
  for arg in "$@"; do
    arg="${arg//\\/\\\\}"
    printf '"%s" ' "${arg//\"/\\\"}"
  done
}

# Resolves an explicit user:group to numeric uid:gid on this host, which is
# where the files are chowned.
host_ids() {
  OWNER_IN="$1" python3 -c '
import grp, os, pwd
user, _, group = os.environ["OWNER_IN"].partition(":")
uid = int(user) if user.isdigit() else pwd.getpwnam(user).pw_uid
gid = int(group) if group.isdigit() else grp.getgrnam(group).gr_gid
print(f"{uid}:{gid}")
' 2>/dev/null
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
# their image runs as. Names are never handed to chown.
sfu_file_owner() {
  local explicit="$1" state_dir="${2%/}" id spec ids
  if [[ -n "$explicit" ]]; then
    [[ "$explicit" == ?*:?* ]] || return 1
    host_ids "$explicit"
    return
  fi
  command -v docker >/dev/null 2>&1 || return 0
  for id in $(docker ps -aq 2>/dev/null); do
    docker inspect -f '{{range .Mounts}}{{println .Source}}{{end}}' "$id" 2>/dev/null | grep -qxF "$state_dir" || continue
    spec="$(docker inspect -f '{{.Config.User}}' "$id")"
    [[ -n "$spec" ]] || return 0
    ids="$(image_ids "$(docker inspect -f '{{.Image}}' "$id")" "$spec")" || return 1
    [[ "${ids%%:*}" == 0 ]] || printf '%s\n' "$ids"
    return 0
  done
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
