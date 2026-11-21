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
# it never shows up in the process list.
redis_cli() {
  local args=(-h "$REDIS_HOST" -p "$REDIS_PORT" -n "$REDIS_DB")
  [[ -n "$REDIS_USER" ]] && args+=(--user "$REDIS_USER")
  [[ "$REDIS_TLS" == "1" ]] && args+=(--tls)
  REDISCLI_AUTH="$REDIS_PASS" redis-cli "${args[@]}" --no-auth-warning "$@"
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
