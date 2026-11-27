"""The rules backup_state.py and restore_state.py share.

What a path in an archive may be, how the SFU resolves a path below the state
dir, what an archive may hold, and which containers can see the state dir.

One resolver follows a path the way the SFU opens it: one component at a
time from the state dir, every link followed where it sits (a directory link
as much as a file link), ".." stepping back up the real path reached so far,
and an absolute target read against the mount roots in one order, the
containers' mount path first. It never normalises across a link.

Every walk of the state dir goes through open directory fds with O_NOFOLLOW,
so no path component is ever followed, and fails closed: a listing or stat
error refuses the run instead of quietly leaving something out.
"""
import errno
import json
import os
import posixpath
import re
import shutil
import stat
import subprocess
import tarfile
import time
import unicodedata
import urllib.parse

SIDE_SUFFIXES = ("-wal", "-shm", "-journal")
LONGEST_SIDE = max(len(suffix) for suffix in SIDE_SUFFIXES)
NAME_MAX = 255
MAX_HOPS = 40
DIR_FLAGS = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC
READ_FLAGS = os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC | os.O_NONBLOCK
STOPPED = ("exited", "dead", "created")
LEGACY_MODE_VARIABLES = ("SCHEDULING_PERSISTENCE", "SCHEDULED_MEETINGS_PERSISTENCE", "SCHEDULED_WEBINARS_PERSISTENCE")
CONTROL_PLANE_MODES = ("memory", "json", "sqlite", "redis")

PAYLOAD_FILES = ("MANIFEST", "SHA256SUMS", "sqlite-databases", "sqlite-links", "sqlite-chains", "sqlite-dirs", "state-files.tar", "redis/dump.rdb", "redis/database")


class Refused(Exception):
    pass


class Unresolved(Exception):
    def __init__(self, message, missing=False):
        super().__init__(message)
        self.missing = missing


def log(message):
    print(time.strftime("[%H:%M:%SZ]", time.gmtime()), message, flush=True)


def plain(name):
    """The name as a plain relative path, "." for the root, or None. Plain
    means printable UTF-8, never absolute, no empty, "." or ".." component,
    and no component longer than a file system allows."""
    if name.startswith("./"):
        name = name[2:]
    name = name.rstrip("/")
    if name in ("", "."):
        return "."
    try:
        encoded = name.encode("utf-8")
    except UnicodeEncodeError:
        return None
    if any(byte < 32 or byte == 127 for byte in encoded):
        return None
    parts = name.split("/")
    if name.startswith("/") or any(part in ("", ".", "..") for part in parts):
        return None
    if any(len(part.encode("utf-8")) > NAME_MAX for part in parts):
        return None
    return name


def plain_target(target):
    """Whether a relative link target can be recorded and recreated as
    written: printable UTF-8, and no component longer than a file system
    allows. ".." and "." components are kept as they are."""
    if not target or target.startswith("/"):
        return False
    try:
        encoded = target.encode("utf-8")
    except UnicodeEncodeError:
        return False
    if any(byte < 32 or byte == 127 for byte in encoded):
        return False
    return all(len(part.encode("utf-8")) <= NAME_MAX for part in target.split("/"))


def folded(rel):
    """The form two names share when a case-insensitive or normalising file
    system would store them as one."""
    return unicodedata.normalize("NFC", rel).casefold()


def within(child, parent):
    return parent == "/" or child == parent or child.startswith(parent + "/")


def mount_roots(state, container):
    """The roots an absolute link target is read against, in one order: the
    containers' mount path first, then the state dir as configured, then its
    real path."""
    roots = []
    for root in (container.rstrip("/"), os.path.abspath(state).rstrip("/"), os.path.realpath(state)):
        if root and root not in roots:
            roots.append(root)
    return roots


def under_root(target, roots):
    """What an absolute target names below the state dir, read against the
    first root it falls under, or None when it falls under none."""
    for root in roots:
        if target == root or target.startswith(root + "/"):
            return target[len(root):].lstrip("/")
    return None


def relative_target(link, target, roots):
    """The target a link is recorded with: as written when relative, and for
    an absolute one, the same path counted from the link's own directory, so
    it means the same in the container and on any host. Components stay as
    written: nothing is normalised. None when it falls under no root."""
    if not target.startswith("/"):
        return target
    rest = under_root(target, roots)
    if rest is None:
        return None
    depth = len(link.split("/")) - 1
    return "/".join([".."] * depth + ([rest] if rest else [])) or "."


def at(dir_fd, name, shown):
    """The lstat of name in dir_fd, or None when there is nothing there."""
    try:
        return os.stat(name, dir_fd=dir_fd, follow_symlinks=False)
    except FileNotFoundError:
        return None
    except OSError as error:
        raise Refused(f"cannot read {shown}: {error.strerror}")


def open_dir(dir_fd, name, shown):
    """Opens the real directory name in dir_fd. A link, a file or anything
    else there is refused, never followed."""
    try:
        return os.open(name, DIR_FLAGS, dir_fd=dir_fd)
    except FileNotFoundError:
        raise
    except OSError as error:
        if error.errno in (errno.ELOOP, errno.ENOTDIR, errno.EMLINK):
            raise Refused(f"{shown} is a link or not a directory, and nothing here is ever followed")
        raise Refused(f"cannot open {shown}: {error.strerror}")


def open_parts(root_fd, parts, shown_root=""):
    """An fd for the directory the parts name below root_fd, every step a
    real directory. FileNotFoundError when one is missing. It starts from a
    fresh open of root_fd's directory, never a dup: listing a dup of a
    directory fd comes back empty on Linux."""
    fd = os.open(".", DIR_FLAGS, dir_fd=root_fd)
    walked = []
    try:
        for part in parts:
            walked.append(part)
            child = open_dir(fd, part, posixpath.join(shown_root, *walked) if shown_root else "/".join(walked))
            os.close(fd)
            fd = child
        return fd
    except BaseException:
        os.close(fd)
        raise


def walk(dir_fd, shown, prefix=""):
    """Every entry below dir_fd as (relative path, lstat), names sorted, a
    directory before what it holds. Descends only into real directories, each
    opened without following and checked to be the entry listed."""
    try:
        names = sorted(os.listdir(dir_fd))
    except OSError as error:
        raise Refused(f"cannot list {posixpath.join(shown, prefix) if prefix else shown}: {error.strerror}")
    for name in names:
        rel = f"{prefix}/{name}" if prefix else name
        info = at(dir_fd, name, f"{shown}/{rel}")
        if info is None:
            raise Refused(f"{shown}/{rel} went away while it was read")
        yield rel, info
        if stat.S_ISDIR(info.st_mode):
            child = open_dir(dir_fd, name, f"{shown}/{rel}")
            try:
                opened = os.fstat(child)
                if (opened.st_dev, opened.st_ino) != (info.st_dev, info.st_ino):
                    raise Refused(f"{shown}/{rel} changed while it was read")
                yield from walk(child, shown, rel)
            finally:
                os.close(child)


class Tree:
    """The state dir as the SFU will see it: what is on disk below root_fd
    (nothing when it is None), with planned links, files and directories
    laid over it."""

    def __init__(self, root_fd=None, links=None, files=(), dirs=()):
        self.root_fd = root_fd
        self.links = dict(links or {})
        self.files = set(files)
        self.dirs = set(dirs)

    def kind(self, rel):
        if rel in self.links:
            return ("link", self.links[rel])
        if rel in self.files:
            return ("file",)
        if rel in self.dirs:
            return ("dir",)
        if self.root_fd is None:
            return None
        parts = rel.split("/")
        try:
            parent = open_parts(self.root_fd, parts[:-1])
        except FileNotFoundError:
            return None
        try:
            info = at(parent, parts[-1], rel)
            if info is None:
                return None
            if stat.S_ISLNK(info.st_mode):
                return ("link", os.readlink(parts[-1], dir_fd=parent))
        finally:
            os.close(parent)
        if stat.S_ISDIR(info.st_mode):
            return ("dir",)
        if stat.S_ISREG(info.st_mode):
            return ("file",)
        return ("other",)


def resolve(tree, start, roots, final="file", visited=None):
    """Follows start the way the SFU opens it. Returns the links it passes,
    as (path, target as written), and the real path it reaches, both relative
    to the state dir. final="file" wants a regular file there; final="any"
    accepts a file or a directory. Every real directory it steps through is
    added to visited, when given."""
    pending = start.split("/")
    real = []
    passed = []
    hops = 0
    while pending:
        part = pending.pop(0)
        if part in ("", "."):
            continue
        if part == "..":
            if not real:
                raise Unresolved(f"{start} climbs out of the state dir")
            real.pop()
            continue
        rel = "/".join(real + [part])
        kind = tree.kind(rel)
        if kind is None:
            raise Unresolved(f"{start} reaches {rel}, which does not exist", missing=True)
        if kind[0] == "link":
            hops += 1
            if hops > MAX_HOPS:
                raise Unresolved(f"{start} loops through its links")
            target = kind[1]
            passed.append((rel, target))
            if target.startswith("/"):
                rest = under_root(target, roots)
                if rest is None:
                    raise Unresolved(f"{rel} leads outside the state dir ({target})")
                real = []
                pending = rest.split("/") + pending
            else:
                pending = target.split("/") + pending
            continue
        if kind[0] == "other":
            raise Unresolved(f"{start} reaches {rel}, which is not a file or directory")
        real.append(part)
        if kind[0] == "dir" and visited is not None and "/".join(real) not in visited:
            visited.append("/".join(real))
        if kind[0] == "file" and any(p not in ("", ".") for p in pending):
            raise Unresolved(f"{start} goes through {rel}, which is a file")
    if not real:
        raise Unresolved(f"{start} reaches the state dir itself")
    reached = "/".join(real)
    if final == "file" and tree.kind(reached) != ("file",):
        raise Unresolved(f"{start} reaches {reached}, which is not a regular file")
    return passed, reached


def side_files(paths):
    return {path + suffix for path in paths for suffix in SIDE_SUFFIXES}


def is_database_name(rel):
    return rel.endswith(".sqlite") or rel.endswith(tuple(".sqlite" + suffix for suffix in SIDE_SUFFIXES))


def name_room(rel):
    """Why SQLite could not keep its side files beside this database, or
    None when it can."""
    if len(rel.split("/")[-1].encode("utf-8")) + LONGEST_SIDE > NAME_MAX:
        return f"the database name {rel} leaves no room for SQLite's {'/'.join(SIDE_SUFFIXES)} files ({NAME_MAX} bytes at most with them)"
    return None


def read_lines(path):
    if not os.path.isfile(path):
        return []
    with open(path, encoding="utf-8") as handle:
        return [line.rstrip("\n") for line in handle if line.rstrip("\n")]


def read_pairs(path):
    pairs = []
    for line in read_lines(path):
        first, sep, second = line.partition("\t")
        pairs.append((first, second if sep else None))
    return pairs


class Archive:
    """What a payload holds, read from a directory only this run writes:
    the databases it copies, the links on their chains (relative targets),
    each chain from its start to the database it reaches, and the other
    files as (path, "file" or "dir")."""

    def __init__(self, payload):
        self.payload = payload
        self.databases = read_lines(os.path.join(payload, "sqlite-databases"))
        self.links = read_pairs(os.path.join(payload, "sqlite-links"))
        self.chains = read_pairs(os.path.join(payload, "sqlite-chains"))
        self.dirs = read_lines(os.path.join(payload, "sqlite-dirs"))
        self.has_redis = os.path.isfile(os.path.join(payload, "redis", "dump.rdb"))
        source_db = read_lines(os.path.join(payload, "redis", "database"))
        self.redis_db = source_db[0] if len(source_db) == 1 else None
        self.members = []
        tar_path = os.path.join(payload, "state-files.tar")
        if os.path.isfile(tar_path):
            try:
                with tarfile.open(tar_path) as tar:
                    self.members = tar.getmembers()
            except (tarfile.TarError, OSError) as error:
                raise Refused(f"state-files.tar in the archive cannot be read: {error}")


def archive_problems(archive):
    """What an archive holds, checked on its own, before anything is
    written: plain names, files and directories only, every database copy
    listed exactly once, nothing under a recorded link, no side file of a
    database, no path twice or once under two spellings."""
    problems = []
    payload = archive.payload
    for name in sorted(os.listdir(payload)):
        full = os.path.join(payload, name)
        if name in ("sqlite", "redis") and os.path.isdir(full) and not os.path.islink(full):
            continue
        if name not in PAYLOAD_FILES or not os.path.isfile(full) or os.path.islink(full):
            problems.append(f"{name} in the archive is not part of a backup")
    redis_root = os.path.join(payload, "redis")
    if os.path.isdir(redis_root) and sorted(os.listdir(redis_root)) not in ([], ["database", "dump.rdb"]):
        problems.append("redis/ in the archive must hold dump.rdb and the database it was taken from, and nothing else")
    if archive.has_redis and not (archive.redis_db or "").isdigit():
        problems.append("the backup's Redis snapshot does not say which database it was taken from")
    sqlite_root = os.path.join(payload, "sqlite")
    copies = set()
    if os.path.isdir(sqlite_root):
        for root, dirs, files in os.walk(sqlite_root, onerror=walk_error):
            for name in dirs + files:
                full = os.path.join(root, name)
                rel = os.path.relpath(full, sqlite_root)
                if os.path.islink(full) or not (os.path.isdir(full) or os.path.isfile(full)):
                    problems.append(f"sqlite/{rel} in the archive is not a plain file or directory")
                elif os.path.isfile(full):
                    copies.add(rel)
    listed = set()
    for rel in archive.databases:
        if plain(rel) in (None, "."):
            problems.append(f"the database {rel} is not a plain path inside the archive")
        elif rel in listed:
            problems.append(f"the database {rel} is listed twice")
        else:
            listed.add(rel)
            room = name_room(rel)
            if room:
                problems.append(room)
    for rel in sorted(copies - listed):
        problems.append(f"sqlite/{rel} in the archive is no database the backup listed")
    for rel in sorted(listed - copies):
        problems.append(f"the database {rel} has no copy in the archive")

    targets = {}
    # Every recorded link path, the refused ones too, so nothing in the
    # archive is ever written below one.
    link_paths = {link for link, _ in archive.links if plain(link) not in (None, ".")}
    for link, target in archive.links:
        if plain(link) in (None, ".") or not target:
            problems.append(f"the recorded link {link} is not a plain path with a target")
        elif target.startswith("/"):
            problems.append(f"the recorded link {link} leads outside the state dir ({target}): a backup records every link relative")
        elif not plain_target(target):
            problems.append(f"the recorded link {link} has a target a restore cannot write as it is")
        elif link in targets:
            problems.append(f"the recorded link {link} is listed twice")
        else:
            targets[link] = target
    starts = set()
    for start, reached in archive.chains:
        if plain(start) in (None, ".") or start in starts:
            problems.append(f"the chain from {start} is not a plain path listed once")
        elif reached not in listed:
            problems.append(f"the chain from {start} ends at {reached}, which the archive does not restore")
        starts.add(start)
    if targets and not archive.chains:
        problems.append("the archive records links but no chains to check them against")
    for rel in archive.dirs:
        if plain(rel) in (None, "."):
            problems.append(f"the chain directory {rel} is not a plain path inside the archive")

    database_like = set(listed) | set(targets) | starts
    sides = side_files(set(listed))
    for rel in sorted(listed):
        if rel in side_files(set(listed) - {rel}):
            problems.append(f"the database {rel} has the name of another database's SQLite side file")
    writes = [(rel, "file") for rel in listed] + [(rel, "link") for rel in sorted(link_paths)]
    member_dirs = {plain(member.name) for member in archive.members if member.isdir()}
    writes += [(rel, "dir") for rel in archive.dirs if plain(rel) not in (None, ".") and rel not in member_dirs]
    for member in archive.members:
        name = plain(member.name)
        shown = member.name[2:] if member.name.startswith("./") else member.name
        if name is None:
            problems.append(f"{shown} is not a plain path inside the archive")
        elif member.issym() or member.islnk():
            problems.append(f"{name} is a link, and the only links a restore makes are the recorded database links")
        elif not (member.isreg() or member.isdir()) or member.issparse():
            problems.append(f"{name} is not a file or directory")
        elif name == ".":
            if not member.isdir():
                problems.append("the root of state-files.tar is not a directory")
        elif name in sides:
            problems.append(f"{name} is a SQLite side file, and a restore never takes one from the archive: it would replay onto the restored database")
        elif name in database_like or (member.isreg() and is_database_name(name)):
            problems.append(f"{name} is a database path, and databases come back only from their SQLite copies")
        else:
            writes.append((name, "dir" if member.isdir() else "file"))
    problems.extend(write_problems(writes, link_paths))
    return problems


def write_problems(writes, links):
    """Every path a restore writes holds one thing under one spelling, and
    nothing sits below a file or a link."""
    problems = []
    explicit = {}
    for rel, kind in writes:
        explicit.setdefault(rel, []).append(kind)
    every = set(explicit)
    for rel in explicit:
        parts = rel.split("/")
        every.update("/".join(parts[:i]) for i in range(1, len(parts)))
    for rel, kinds in sorted(explicit.items()):
        if len(kinds) > 1:
            problems.append(f"{rel} is in the archive more than once, as {' and '.join(sorted(set(kinds)))}")
    spellings = {}
    for rel in sorted(every):
        spelling = spellings.setdefault(folded(rel), rel)
        if spelling != rel:
            problems.append(f"{rel} and {spelling} differ only in case or Unicode form, so one would overwrite the other")
    for rel in sorted(explicit):
        parts = rel.split("/")
        for i in range(1, len(parts)):
            prefix = "/".join(parts[:i])
            if prefix in links:
                problems.append(f"{rel} sits under the recorded link {prefix}, and a restore never writes through a link")
                break
            if any(kind != "dir" for kind in explicit.get(prefix, [])):
                problems.append(f"{rel} sits under {prefix}, which the archive also holds as a file")
                break
    return problems


def chain_problems(tree, archive, roots):
    """Every recorded chain must reach, over tree, the very database it
    reached when it was backed up, and every recorded link must lead inside
    and lie on a chain."""
    problems = []
    on_chain = set()
    for start, reached in archive.chains:
        try:
            passed, got = resolve(tree, start, roots)
        except Unresolved as unresolved:
            problems.append(f"the chain from {start} would not reach {reached}: {unresolved}")
            continue
        if got != reached:
            problems.append(f"the chain from {start} would reach {got}, not {reached} as when it was backed up")
        on_chain.update(link for link, _ in passed)
    for link, _ in archive.links:
        try:
            resolve(tree, link, roots, final="any")
        except Unresolved as unresolved:
            problems.append(f"the recorded link {link} leads outside the state dir ({unresolved})")
            continue
        if link not in on_chain:
            problems.append(f"the recorded link {link} is on no recorded chain")
    return problems


def restore_writes(archive, sqlite=True, files=True):
    """(path, kind) for every entry a restore writes: "db" and "link" for
    --sqlite, "file" and "dir" for --files."""
    writes = []
    if sqlite:
        writes += [(rel, "db") for rel in archive.databases]
        writes += [(rel, "link") for rel, _ in archive.links]
        writes += [(rel, "dir") for rel in archive.dirs]
    if files:
        chain_dirs = set(archive.dirs) if sqlite else set()
        for member in archive.members:
            name = plain(member.name)
            if name not in (None, ".") and name not in chain_dirs:
                writes.append((name, "dir" if member.isdir() else "file"))
    return writes


def overlay(root_fd, archive, writes):
    """The state dir once the writes land: recorded links as written, files
    where they go, and every directory on their way."""
    targets = dict(archive.links)
    links = {rel: targets[rel] for rel, kind in writes if kind == "link"}
    files = {rel for rel, kind in writes if kind in ("db", "file")}
    dirs = {rel for rel, kind in writes if kind == "dir"}
    for rel, _ in writes:
        parts = rel.split("/")
        dirs.update("/".join(parts[:i]) for i in range(1, len(parts)))
    return Tree(root_fd, links, files, dirs)


def database_paths(archive):
    """Every path SQLite may keep side files beside: the databases, the
    recorded links and the chain starts."""
    return set(archive.databases) | {rel for rel, _ in archive.links} | {start for start, _ in archive.chains}


def database_files(archive):
    return set(archive.databases)


def is_sfu(found):
    return bool(found["env"].get("SFU_INSTANCE_ID"))


JS_SPACE = "\t\n\v\f\r \u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff"


def redis_source_url(env):
    for name in ("SFU_PERSISTENCE_REDIS_URL", "SFU_REDIS_URL", "REDIS_URL"):
        value = (env.get(name) or "").strip(JS_SPACE)
        if value:
            return value
    return ""


def redis_key_prefix(env):
    return ((env.get("SFU_PERSISTENCE_REDIS_KEY_PREFIX") or "").strip(JS_SPACE) or "conclave:sfu:persistence").rstrip(":")


def redis_where(url):
    try:
        parts = urllib.parse.urlsplit(url)
        return f"{(parts.hostname or '127.0.0.1').lower()}:{parts.port or 6379}/{parts.path.strip('/') or '0'}"
    except ValueError:
        return "an unreadable URL"


def redis_target(url):
    try:
        parts = urllib.parse.urlsplit(url)
        return (parts.scheme.lower(), (parts.hostname or "127.0.0.1").lower(), parts.port or 6379, parts.path.strip("/") or "0")
    except ValueError:
        return ("unreadable", url)


def sfu_containers(containers):
    return [found for found in containers if found["relation"] in ("exact", "related") and is_sfu(found)]


def control_plane_mode(env):
    # Keep in step with resolveControlPlaneMode in controlPlane/open.ts.
    def as_mode(value, name):
        mode = "json" if value == "file" else value
        if mode not in CONTROL_PLANE_MODES:
            raise Refused(f"{name} must name memory, json, sqlite or redis")
        return mode

    explicit = (env.get("CONTROL_PLANE_PERSISTENCE") or "").strip(JS_SPACE).lower()
    if explicit:
        return as_mode(explicit, "CONTROL_PLANE_PERSISTENCE")
    derived = "redis" if redis_source_url(env) else "sqlite"
    legacy = [(name, (env.get(name) or "").strip(JS_SPACE).lower()) for name in LEGACY_MODE_VARIABLES]
    modes = [as_mode(value, name) for name, value in legacy if value]
    if all(mode == derived for mode in modes):
        return derived
    if len(modes) == len(LEGACY_MODE_VARIABLES) and len(set(modes)) == 1:
        return modes[0]
    raise Refused("the SFU cannot pick separate persistence modes; set CONTROL_PLANE_PERSISTENCE")


def redis_key_pattern(env):
    return re.sub(r"([*?\[\]\\])", r"\\\1", redis_key_prefix(env)) + ":*"


def redis_revision_key(env):
    return redis_key_prefix(env) + ":{control-plane}:rev"


def sfu_redis_source(env, containers):
    sfus = sfu_containers(containers)
    redis = [found for found in sfus if control_plane_mode(found["env"]) == "redis"]
    if not redis and (sfus or control_plane_mode(env) != "redis"):
        return ""
    url = redis_source_url(env)
    prefix = redis_key_prefix(env)
    pattern = env.get("BACKUP_REDIS_PATTERN")
    if pattern and pattern not in ("*", redis_key_pattern(env)):
        raise Refused("BACKUP_REDIS_PATTERN must include the entire control-plane namespace; leave it unset or use the configured prefix followed by :*")
    for found in redis:
        theirs = redis_source_url(found["env"])
        name = found["env"]["SFU_INSTANCE_ID"]
        if not theirs:
            raise Refused(f"the SFU {name} uses Redis control-plane persistence without a Redis URL")
        if not url or redis_target(theirs) != redis_target(url):
            named = redis_where(url) if url else "no Redis"
            raise Refused(f"the SFU {name} keeps its state in the Redis at {redis_where(theirs)}, and the backup config names {named}; set SFU_PERSISTENCE_REDIS_URL in the backup config to that Redis, as this host reaches it")
        if redis_key_prefix(found["env"]) != prefix:
            raise Refused(f"the SFU {name} keeps its state under the Redis key prefix {redis_key_prefix(found['env'])}, not {prefix}; set SFU_PERSISTENCE_REDIS_KEY_PREFIX in the backup config to it")
    if not url:
        raise Refused("Redis control-plane persistence requires SFU_PERSISTENCE_REDIS_URL, SFU_REDIS_URL, or REDIS_URL")
    return url


def state_path(path, mounts, state, allow_root=False):
    """Where a container path lies in the state dir, read through the
    container's mount whose destination holds it most closely, or None when
    no mount does or it lands outside the state dir."""
    best = None
    for mount in mounts:
        destination = mount.get("destination") or ""
        if destination.startswith("/") and within(path, destination.rstrip("/") or "/"):
            if best is None or len(destination) > len(best["destination"]):
                best = mount
    if best is None:
        return None
    destination = best["destination"].rstrip("/") or "/"
    rest = path[len(destination):].lstrip("/") if destination != "/" else path.lstrip("/")
    # Both sides resolved as far as they exist, so a lost state dir still
    # matches the mount that names it.
    for source in (os.path.realpath(best["source"]), os.path.normpath(best["source"])):
        host = os.path.join(source, rest) if rest else source
        for base in (os.path.realpath(state), os.path.normpath(os.path.abspath(state))):
            if within(host, base) and (allow_root or host != base):
                return host[len(base):].lstrip("/")
    return None


def state_view_problems(state, containers):
    """A container sees the state dir where a mount of it, or of a dir above
    it, lands. Another mount inside that view shows it other files than the
    host has there, so what the SFU opens is not what a backup reads or a
    restore writes."""
    problems = []
    state_real = os.path.realpath(state)
    for found in containers:
        if found["relation"] not in ("exact", "related") or not is_sfu(found):
            continue
        mounts = [mount for mount in found["mounts"] if (mount.get("destination") or "").startswith("/")]
        views = []
        for mount in mounts:
            source = os.path.realpath(mount["source"])
            if within(state_real, source):
                rest = state_real[len(source):].lstrip("/") if source != "/" else state_real.lstrip("/")
                views.append(posixpath.join(mount["destination"], rest).rstrip("/") or "/")
        for view in views:
            for mount in mounts:
                destination = mount["destination"].rstrip("/") or "/"
                if destination == view or not within(destination, view):
                    continue
                expected = os.path.join(state_real, destination[len(view):].lstrip("/"))
                if os.path.realpath(mount["source"]) != os.path.realpath(expected):
                    problems.append(f"the container {found['id']} mounts {mount['source']} at {mount['destination']}, inside its view of the state dir ({view}), so what it opens there is not what the backup reads; mount it outside {view}, or from the state dir itself")
    return problems


def configured_stores(state, container, containers, mode, env=None):
    """Active file stores seen from Docker. When no SFU is available to
    inspect, the backup config uses the Compose volume defaults."""
    env = os.environ if env is None else env
    problems = state_view_problems(state, containers)
    if problems:
        raise Refused("\n".join(problems))
    sfus = sfu_containers(containers)
    sources = [(found["env"], found["working_dir"],
                f"the container {found['id']}", found["mounts"]) for found in sfus]
    if not sfus:
        sources.append((env, container, "the backup config", None))
    stores = []
    for settings, cwd, where, mounts in sources:
        if control_plane_mode(settings) != mode:
            continue
        if mode == "sqlite":
            variable = "CONCLAVE_SQLITE_PATH"
            default_dir = (settings.get("RECORDING_STORAGE_PATH") or "").strip(JS_SPACE)
            default_dir = (default_dir or "data") if mounts is not None else container
            default = posixpath.join(default_dir, "conclave.sqlite")
        else:
            variable = "CONTROL_PLANE_JSON_PATH"
            default = "data/control-plane.json" if mounts is not None else posixpath.join(container, "control-plane.json")
        value = (settings.get(variable) or "").strip(JS_SPACE) or default
        resolved = "/" + posixpath.normpath(posixpath.join(cwd, value)).lstrip("/")
        rel = (state_path(resolved, mounts, state) if mounts is not None
               else under_root(resolved, mount_roots(state, container)))
        if not rel:
            raise Refused(f"{variable}={resolved} ({where}) is outside the state dir, so it is not on the volume; move it under {container}")
        if rel not in [store["rel"] for store in stores]:
            stores.append({"rel": rel, "variable": variable, "where": where})
    return stores


def json_coverage_problems(archive, state, container):
    files = {rel for rel, kind in restore_writes(archive, False, True) if kind == "file"}
    stores = configured_stores(state, container, state_mounts(docker_containers(), state), "json")
    return [f"the backup has no copy of {store['rel']}, the JSON file {store['variable']} ({store['where']}) names"
            for store in stores if store["rel"] not in files]


def fallback_import_dirs(state, container):
    containers = state_mounts(docker_containers(), state)
    problems = state_view_problems(state, containers)
    if problems:
        raise Refused("\n".join(problems))
    sfus = sfu_containers(containers)
    variable = "CONCLAVE_FALLBACK_IMPORT_DIR"
    sources = [(found["env"], found["working_dir"], found["mounts"]) for found in sfus]
    if not sfus:
        sources.append((os.environ, container, None))
    dirs = set()
    for env, cwd, mounts in sources:
        default = posixpath.join(container, "json-fallback-import") if mounts is None else ""
        value = env.get(variable, default).strip(JS_SPACE)
        if not value or control_plane_mode(env) == "memory":
            continue
        resolved = "/" + posixpath.normpath(posixpath.join(cwd, value)).lstrip("/")
        rel = (state_path(resolved, mounts, state, allow_root=True) if mounts is not None
               else under_root(resolved, mount_roots(state, container)))
        if rel is None:
            raise Refused(f"{variable}={resolved} is outside the state dir, so the restore cannot reconcile its snapshots")
        dirs.add(rel)
    return dirs


def walk_error(error):
    raise Refused(f"cannot list {error.filename}: {error.strerror}")


def real_or_none(path):
    try:
        return os.path.realpath(path, strict=True)
    except OSError:
        return None


def docker_containers():
    """Every container Docker lists, read from docker inspect. A host with
    no Docker CLI and no Docker socket has none; anything Docker cannot
    answer refuses the run."""
    if shutil.which("docker") is None:
        if os.path.exists("/var/run/docker.sock") or os.environ.get("DOCKER_HOST"):
            raise Refused("Docker cannot list the SFU containers (no docker CLI, but a Docker daemon is configured), so a running SFU could go unseen")
        return []
    listing = subprocess.run(["docker", "ps", "-aq"], capture_output=True, text=True)
    if listing.returncode != 0:
        raise Refused("Docker cannot list the SFU containers, so a running SFU could go unseen")
    ids = listing.stdout.split()
    if not ids:
        return []
    inspected = subprocess.run(["docker", "inspect", *ids], capture_output=True, text=True)
    try:
        if inspected.returncode != 0:
            raise ValueError
        raw = json.loads(inspected.stdout)
    except ValueError:
        raise Refused("Docker cannot inspect the SFU containers, so a running SFU could go unseen")
    containers = []
    for entry in raw:
        config = entry.get("Config") or {}
        env = dict(item.split("=", 1) for item in config.get("Env") or [] if "=" in item)
        containers.append({
            "id": str(entry.get("Id", ""))[:12],
            "status": (entry.get("State") or {}).get("Status") or "unknown",
            "env": env,
            "user": config.get("User") or "",
            "working_dir": config.get("WorkingDir") or "/",
            "image": entry.get("Image") or "",
            "mounts": [
                {"source": mount["Source"], "destination": mount.get("Destination") or "", "rw": mount.get("RW", True) is not False}
                for mount in entry.get("Mounts") or []
                if mount.get("Source")
            ],
        })
    return containers


def state_mounts(containers, state):
    """Each container with what its mounts have to do with the state dir:
    "exact" when one is the state dir, "related" when one holds it or lies
    inside it, "unknown" when it is an SFU container with a mount that does
    not resolve (nobody can say where it writes), or None. Paths are compared
    once every link is resolved on both sides; when the state dir does not
    exist, as written."""
    given = os.path.normpath(os.path.abspath(state))
    real = real_or_none(given)
    target = real or given
    found = []
    for container in containers:
        relation = None
        writable = False
        destinations = []
        unresolved = False
        for mount in container["mounts"]:
            source = real_or_none(mount["source"]) if real else os.path.normpath(mount["source"])
            if source is None:
                unresolved = True
                continue
            if source == target:
                relation = "exact"
                writable = writable or mount["rw"]
                if mount["destination"]:
                    destinations.append(mount["destination"])
            elif within(target, source) or within(source, target):
                relation = relation or "related"
                writable = writable or mount["rw"]
        if relation is None and unresolved and "SFU_INSTANCE_ID" in container["env"]:
            relation = "unknown"
        if relation:
            found.append(dict(container, relation=relation, writable=writable or relation == "unknown", destinations=destinations))
    return found


def running(container):
    return container["status"] not in STOPPED
