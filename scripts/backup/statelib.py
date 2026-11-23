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
import shutil
import stat
import subprocess
import tarfile
import time
import unicodedata

SIDE_SUFFIXES = ("-wal", "-shm", "-journal")
LONGEST_SIDE = max(len(suffix) for suffix in SIDE_SUFFIXES)
NAME_MAX = 255
MAX_HOPS = 40
DIR_FLAGS = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC
READ_FLAGS = os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC | os.O_NONBLOCK
STOPPED = ("exited", "dead", "created")
STORE_VARIABLES = ("SCHEDULING_SQLITE_PATH", "SCHEDULED_MEETINGS_SQLITE_PATH", "SCHEDULED_WEBINARS_SQLITE_PATH")

PAYLOAD_FILES = ("MANIFEST", "SHA256SUMS", "sqlite-databases", "sqlite-links", "sqlite-chains", "sqlite-dirs", "state-files.tar", "redis/dump.rdb")


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
    if os.path.isdir(redis_root) and sorted(os.listdir(redis_root)) not in ([], ["dump.rdb"]):
        problems.append("redis/ in the archive holds more than dump.rdb")
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
    sides = side_files(database_like)
    for rel in sorted(listed):
        if rel in side_files(database_like - {rel}):
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
