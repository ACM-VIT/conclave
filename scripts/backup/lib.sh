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

# Prints the database the SFU opens, relative to the state dir, whatever its
# name: CONCLAVE_SQLITE_PATH as the compose file passes it to its containers,
# or the compose default (conclave.sqlite in the state dir) when that is
# unset. Fails when it is outside the state dir.
configured_database() {
  local state_dir="${1%/}" configured="${CONCLAVE_SQLITE_PATH:-${CONTAINER_STATE_DIR}/conclave.sqlite}"
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

# Resolves a path below the state dir one component at a time, following
# every symlink on the way, a directory link as much as a file link, to the
# database it reaches. Prints "link<TAB><path><TAB><target as written>" for
# each link, at the real place it sits, and "file<TAB><path>" for the
# database, all relative to the state dir, so a restore can bring back the
# whole chain and write the database where it really lives. An absolute
# target may name the container's mount of the state dir. Fails when the path
# leaves the state dir, loops, or ends anywhere but a regular file.
sqlite_link_chain() {
  STATE_IN="$1" LINK_IN="$2" CONTAINER_IN="$3" python3 -c '
import os, sys
state = os.path.realpath(os.environ["STATE_IN"])
mounts = [os.environ["CONTAINER_IN"].rstrip("/"), os.environ["STATE_IN"].rstrip("/"), state]
pending = os.environ["LINK_IN"].split("/")
real = []
links = []
hops = 0
while pending:
    part = pending.pop(0)
    if part in ("", "."):
        continue
    if part == "..":
        if not real:
            sys.exit(1)
        real.pop()
        continue
    rel = "/".join(real + [part])
    path = os.path.join(state, rel)
    if not os.path.islink(path):
        real.append(part)
        continue
    hops += 1
    if hops > 40:
        sys.exit(1)
    target = os.readlink(path)
    if (rel, target) not in links:
        links.append((rel, target))
    if os.path.isabs(target):
        mount = next((m for m in mounts if target == m or target.startswith(m + "/")), None)
        if mount is None:
            sys.exit(1)
        real = []
        target = target[len(mount):]
    pending = target.split("/") + pending
rel = "/".join(real)
if not rel or not os.path.isfile(os.path.join(state, rel)):
    sys.exit(1)
for link, target in links:
    print(f"link\t{link}\t{target}")
print(f"file\t{rel}")
'
}

# Checks every place a restore will write, before it writes any, on one
# model whatever is already in the state dir:
# - where a file or link is written, its directory, with the links on the way
#   followed on this host as the OS will follow them, must be inside the real
#   state dir. The destination itself is never followed: what is there is
#   moved aside or replaced.
# - a recorded link's target is read as the SFU reads it: a container (or
#   host) path to the state dir maps to it, and links on disk on the way are
#   followed the same way. It must stay inside.
# - every member of the other-files archive is a plain relative path (no
#   absolute name, no "..", nothing that normalises to another name) naming a
#   regular file or a directory: the only links a restore makes are the
#   recorded database links. One bad member refuses the whole archive.
# Prints why for each that would not, and fails.
#   check_restore_targets STATE_DIR CONTAINER_DIR TAR_OR_EMPTY LINKS_OR_EMPTY DB_REL...
check_restore_targets() {
  python3 -c '
import os, sys, tarfile
state_in, container, tar_path, links_path, *databases = sys.argv[1:]
state = os.path.realpath(state_in)
mounts = [container.rstrip("/"), state_in.rstrip("/"), state]
def inside(real):
    return real == state or real.startswith(state + os.sep)
def clean(rel):
    rel = os.path.normpath(rel)
    return None if os.path.isabs(rel) or rel == ".." or rel.startswith(".." + os.sep) else rel
def written_inside(rel, whole=False):
    rel = clean(rel)
    if rel is None:
        return False
    probe = os.path.join(state, rel)
    if not whole:
        probe = os.path.dirname(probe)
    while not os.path.lexists(probe):
        probe = os.path.dirname(probe)
    return inside(os.path.realpath(probe))
def mapped(target, link_dir):
    if os.path.isabs(target):
        mount = next((m for m in mounts if target == m or target.startswith(m + "/")), None)
        return None if mount is None else clean(target[len(mount):].lstrip("/") or ".")
    return clean(os.path.join(link_dir, target))
def reaches_inside(rel):
    pending, real, hops = [p for p in rel.split("/") if p not in ("", ".")], [], 0
    while pending:
        part = pending.pop(0)
        if part == "..":
            if not real:
                return False
            real.pop()
            continue
        here = os.path.join(state, *real, part)
        if os.path.islink(here):
            hops += 1
            target = mapped(os.readlink(here), "/".join(real))
            if hops > 40 or target is None:
                return False
            pending, real = [p for p in target.split("/") if p not in ("", ".")] + pending, []
            continue
        real.append(part)
    return True
problems = []
for rel in databases:
    if not written_inside(rel):
        problems.append(f"{rel} would land outside the state dir")
if links_path:
    for line in open(links_path):
        link, _, target = line.rstrip("\n").partition("\t")
        if not link:
            continue
        if not written_inside(link):
            problems.append(f"the recorded link {link} would land outside the state dir")
            continue
        leads = mapped(target, os.path.dirname(clean(link) or ""))
        if leads is None or not reaches_inside(leads):
            problems.append(f"the recorded link {link} leads outside the state dir ({target})")
def plain(name):
    name = name[2:] if name.startswith("./") else name
    parts = name.split("/")
    if name == "." or not name:
        return "."
    if name.startswith("/") or ".." in parts or os.path.normpath(name) != name:
        return None
    return name
if tar_path:
    with tarfile.open(tar_path) as tar:
        for member in tar.getmembers():
            name = plain(member.name)
            shown = member.name[2:] if member.name.startswith("./") else member.name
            if name is None:
                problems.append(f"{shown} is not a plain path inside the archive")
            elif member.issym() or member.islnk():
                problems.append(f"{name} is a link, and the only links a restore makes are the recorded database links")
            elif not (member.isfile() or member.isdir()):
                problems.append(f"{name} is not a file or directory")
            elif name == ".":
                continue
            elif member.isfile() and not written_inside(name):
                problems.append(f"{name} would land outside the state dir")
            elif member.isdir() and not written_inside(name, whole=True):
                problems.append(f"{name}/ would land outside the state dir")
            elif member.isfile() and os.path.isdir(os.path.join(state, name)) and not os.path.islink(os.path.join(state, name)):
                problems.append(f"{name} is a file in the archive but a directory in the state dir")
            elif member.isdir() and os.path.lexists(os.path.join(state, name)) and not os.path.isdir(os.path.join(state, name)):
                problems.append(f"{name} is a directory in the archive but not in the state dir")
for problem in problems:
    print(problem, file=sys.stderr)
sys.exit(1 if problems else 0)
' "$@"
}

# Restores the archive's other files into the state dir, already checked by
# check_restore_targets. They are extracted with tarfile's data filter into a
# fresh staging dir made here (inside the state dir, so on its filesystem),
# checked there to be plain files and directories only, and only then moved
# into place by rename. Nothing in the live state dir is unlinked, and no
# path from the archive is used before it has been checked.
extract_state_files() {
  python3 -c '
import os, shutil, sys, tarfile, tempfile
state, tar_path = os.path.realpath(sys.argv[1]), sys.argv[2]
staging = tempfile.mkdtemp(prefix=".restore-", dir=state)
try:
    with tarfile.open(tar_path) as tar:
        tar.extractall(staging, filter="data")
    for root, dirs, files in os.walk(staging):
        for entry in dirs + files:
            full = os.path.join(root, entry)
            if os.path.islink(full) or not (os.path.isdir(full) or os.path.isfile(full)):
                sys.exit(f"{os.path.relpath(full, staging)} came out of the archive as neither a file nor a directory; nothing was moved in")
    for root, dirs, files in os.walk(staging):
        rel = os.path.relpath(root, staging)
        target = state if rel == "." else os.path.join(state, rel)
        os.makedirs(target, exist_ok=True)
        for name in files:
            os.replace(os.path.join(root, name), os.path.join(target, name))
finally:
    shutil.rmtree(staging, ignore_errors=True)
' "$@"
}

# Orders archive names oldest first by the stamp in them
# (conclave-<host>-<YYYYMMDDTHHMMSSZ>.tar.gz.age), never by the whole name: a
# renamed host must not make an older archive look newer.
by_stamp() {
  sed -nE 's/^(.*-([0-9]{8}T[0-9]{6}Z)\.tar\.gz\.age)$/\2 \1/p' | LC_ALL=C sort | cut -d' ' -f2-
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
# their image runs as. Names are never handed to chown.
sfu_file_owner() {
  local explicit="$1" state_dir="$2" containers id status port instance spec image ids
  if [[ -n "$explicit" ]]; then
    [[ "$explicit" == ?*:?* ]] || return 1
    host_ids "$explicit"
    return
  fi
  command -v docker >/dev/null 2>&1 || return 0
  containers="$(sfu_containers "$state_dir")" || return 1
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
# BACKUP_DEPLOY_LOCK_WAIT_SECONDS for a deploy already under way. The file is
# made readable by every user that deploys.
take_sfu_host_lock() {
  local lock="${SFU_DEPLOY_LOCK_FILE:-}" wait="${BACKUP_DEPLOY_LOCK_WAIT_SECONDS:-900}"
  if [[ -z "$lock" ]]; then
    if [[ -d /run/lock ]]; then lock=/run/lock/conclave-sfu-deploy.lock; else lock=/tmp/conclave-sfu-deploy.lock; fi
  fi
  [[ -e "$lock" ]] || (umask 0111 && : >> "$lock") || die "cannot create the host deploy lock ${lock}"
  exec 7<"$lock" || die "cannot open the host deploy lock ${lock}"
  if ! flock -n 7; then
    log "An SFU deploy holds ${lock}; waiting up to ${wait}s for it"
    flock -w "$wait" 7 || die "an SFU deploy held ${lock} for ${wait}s, so nothing was copied or replaced; rerun once the deploy ends"
  fi
  locked_file_is 7 "$lock"
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

# Prints the containers that mount the state dir, one per line as
# "<container>|<state>|<SFU_PORT>|<SFU_INSTANCE_ID>|<user>|<image>" (empty
# fields stay in place, which a tab separator would not do for read).
# Paths are compared once every symlink is resolved on both sides, so a state
# dir named through a link still finds the containers that mount its target.
# An SFU container (one with SFU_INSTANCE_ID) with a mount that does not
# resolve is listed with the state "unknown": nobody can say whether it
# writes here. When the state dir itself does not exist, paths are compared
# as written instead. Fails when Docker cannot list or inspect the containers.
sfu_containers() {
  local state_dir="$1" ids
  command -v docker >/dev/null 2>&1 || return 1
  ids="$(docker ps -aq)" || return 1
  [[ -n "$ids" ]] || return 0
  # shellcheck disable=SC2086
  docker inspect $ids | STATE_IN="$state_dir" python3 -c '
import json, os, sys
def real(path):
    try:
        return os.path.realpath(path, strict=True)
    except OSError:
        return None
given = os.path.normpath(os.path.abspath(os.environ["STATE_IN"]))
state = real(given)
for container in json.load(sys.stdin):
    config = container.get("Config") or {}
    env = dict(entry.split("=", 1) for entry in config.get("Env") or [] if "=" in entry)
    raw = [mount["Source"] for mount in container.get("Mounts") or [] if mount.get("Source")]
    sources = [real(source) for source in raw] if state else [os.path.normpath(source) for source in raw]
    if (state or given) in sources:
        status = (container.get("State") or {}).get("Status") or "unknown"
    elif state and "SFU_INSTANCE_ID" in env and None in sources:
        status = "unknown"
    else:
        continue
    print("|".join([container["Id"][:12], status, env.get("SFU_PORT", ""), env.get("SFU_INSTANCE_ID", ""), config.get("User") or "", container.get("Image") or ""]))
'
}

# Succeeds only when no SFU can write unseen: every SFU container that mounts
# the state dir and is not exited, dead or created holds this backup's fence,
# and each health URL that gave no fence answer belongs to a container Docker
# reports stopped. Silence proves nothing (a wrong URL, a proxy, a hung
# process), and what Docker cannot report counts as running. Says why on
# stderr when it fails.
#   writers_fenced STATE_DIR "HELD_INSTANCE_IDS" UNANSWERED_HEALTH_URL...
writers_fenced() {
  local state_dir="$1" held=" $2 " containers id status port instance url url_port stopped
  shift 2
  if ! containers="$(sfu_containers "$state_dir")"; then
    echo "Docker cannot list the SFU containers, so a running SFU could go unseen" >&2
    return 1
  fi
  while IFS='|' read -r id status port instance _; do
    [[ -n "$id" ]] || continue
    case "$status" in
      exited|dead|created) ;;
      unknown)
        if [[ "$held" != *" ${instance} "* ]]; then
          echo "Docker cannot tell whether the SFU container ${id} (${instance}) mounts the state dir, since one of its mounts does not resolve, and it does not hold the write fence" >&2
          return 1
        fi
        ;;
      *)
        if [[ "$held" != *" ${instance} "* ]]; then
          echo "the SFU container ${id} (${instance:-no SFU_INSTANCE_ID}) is ${status} but does not hold the write fence" >&2
          return 1
        fi
        ;;
    esac
  done <<< "$containers"
  for url in "$@"; do
    url_port="${url#*://}"
    url_port="${url_port%%/*}"
    url_port="${url_port##*:}"
    stopped=""
    while IFS='|' read -r id status port instance _; do
      [[ -n "$id" && "$port" == "$url_port" ]] || continue
      case "$status" in
        exited|dead|created) stopped="$id" ;;
        *)
          echo "${url} gave no fence answer, but Docker reports its container ${id} ${status}" >&2
          return 1
          ;;
      esac
    done <<< "$containers"
    if [[ -z "$stopped" ]]; then
      echo "${url} gave no fence answer, and Docker lists no stopped SFU container on port ${url_port}, so that SFU may still write" >&2
      return 1
    fi
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
