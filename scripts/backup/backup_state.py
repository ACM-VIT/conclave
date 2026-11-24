#!/usr/bin/env python3
"""The backup's work on the state dir and the payload, for backup.sh.

  backup_state.py preflight STATE CONTAINER LOCAL_DIR
  backup_state.py copy STATE CONTAINER PAYLOAD
  backup_state.py pack STATE PAYLOAD
  backup_state.py validate STATE CONTAINER PAYLOAD
  backup_state.py seal PAYLOAD            the archive, a gzipped tar, on stdout
  backup_state.py fenced STATE            FENCE_HELD: "URL INSTANCE" lines,
                                          FENCE_UNANSWERED: health URLs
  backup_state.py containers STATE        "id|status|port|instance|user|image"

The databases are found the way the SFU finds them: every *.sqlite file and
link below the state dir, and each store's configured path (its own
variable, else CONCLAVE_SQLITE_PATH, else the compose default). Each is
copied with SQLite's online backup API, so no path or name ever passes
through a shell. Links are recorded relative.
"""
import hashlib
import os
import sqlite3
import stat
import sys
import tarfile
import urllib.parse

# Root runs these from the checkout; no bytecode is left beside them.
sys.dont_write_bytecode = True
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from statelib import (  # noqa: E402
    DIR_FLAGS,
    READ_FLAGS,
    Archive,
    Refused,
    Tree,
    Unresolved,
    archive_problems,
    chain_problems,
    configured_stores,
    database_files,
    database_paths,
    docker_containers,
    is_database_name,
    log,
    mount_roots,
    name_room,
    open_parts,
    overlay,
    relative_target,
    resolve,
    restore_writes,
    running,
    side_files,
    state_mounts,
    walk,
    within,
)


def open_state(state):
    real = os.path.realpath(state)
    try:
        return real, os.open(real, DIR_FLAGS)
    except FileNotFoundError:
        raise Refused(f"the state dir {state} does not exist, so there is nothing to back up; check CONCLAVE_STATE_DIR")
    except OSError as error:
        raise Refused(f"cannot open the state dir {state}: {error.strerror}")


def plan(state_fd, state, roots, configured):
    """The databases to copy, the links on their chains (relative), and each
    chain from its start to the database it reaches."""
    databases, link_starts = [], []
    for rel, info in walk(state_fd, state):
        if not rel.endswith(".sqlite"):
            continue
        if stat.S_ISREG(info.st_mode):
            databases.append(rel)
        elif stat.S_ISLNK(info.st_mode):
            link_starts.append(rel)
    tree = Tree(state_fd)
    links, chains, dirs = [], [], []
    for start in link_starts + [rel for rel in configured if rel not in link_starts]:
        try:
            passed, reached = resolve(tree, start, roots, visited=dirs)
        except Unresolved as unresolved:
            if start in configured and unresolved.missing:
                raise Refused(f"the configured database {state}/{start} is missing (a store's own SQLite path, CONCLAVE_SQLITE_PATH, or the compose default conclave.sqlite): {unresolved}")
            raise Refused(f"{state}/{start} does not lead to a file inside the state dir: {unresolved}")
        chains.append((start, reached))
        databases.append(reached)
        for link, target in passed:
            recorded = (link, relative_target(link, target, roots))
            if recorded not in links:
                links.append(recorded)
    databases = sorted(set(databases))
    for rel in databases:
        room = name_room(rel)
        if room:
            raise Refused(room)
    as_recorded = Tree(state_fd, links=dict(links))
    for start, reached in chains:
        try:
            _, again = resolve(as_recorded, start, roots)
        except Unresolved as unresolved:
            again = str(unresolved)
        if again != reached:
            raise Refused(f"{state}/{start} reaches {reached}, but not once its links are written relative ({again})")
    return databases, links, chains, sorted(dirs)


def file_id(state_fd, rel, state):
    """The device and inode of the regular file rel, every step on its way a
    real directory."""
    parts = rel.split("/")
    parent = open_parts(state_fd, parts[:-1], state)
    try:
        fd = os.open(parts[-1], READ_FLAGS, dir_fd=parent)
    except OSError as error:
        raise Refused(f"cannot open {state}/{rel}: {error.strerror}")
    finally:
        os.close(parent)
    try:
        info = os.fstat(fd)
    finally:
        os.close(fd)
    if not stat.S_ISREG(info.st_mode):
        raise Refused(f"{state}/{rel} is not a regular file")
    return info.st_dev, info.st_ino


def uri(path, query):
    return f"file:{urllib.parse.quote(path, safe='/')}?{query}"


def copy_database(source, target):
    """SQLite's online backup of source into target: a consistent snapshot
    while other connections keep writing. mode=rw never creates a missing
    database."""
    reader = sqlite3.connect(uri(source, "mode=rw"), uri=True, timeout=15)
    try:
        writer = sqlite3.connect(target)
        try:
            reader.backup(writer)
        finally:
            writer.close()
    finally:
        reader.close()


def describe_copy(path):
    """PRAGMA integrity_check, then the row count of each table, read without
    writing anything beside the copy."""
    reader = sqlite3.connect(uri(path, "mode=ro&immutable=1"), uri=True)
    try:
        integrity = [row[0] for row in reader.execute("PRAGMA integrity_check")]
        if integrity != ["ok"]:
            raise Refused(f"the integrity check of the {path} copy failed: {'; '.join(map(str, integrity))}")
        counts = []
        for (table,) in reader.execute("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").fetchall():
            quoted = '"' + table.replace('"', '""') + '"'
            counts.append((table, reader.execute(f"SELECT count(*) FROM {quoted}").fetchone()[0]))
        return counts
    finally:
        reader.close()


def shown_name(value):
    return value.encode("unicode_escape").decode("ascii")


def write_lines(path, lines):
    with open(path, "w", encoding="utf-8") as out:
        out.writelines(f"{line}\n" for line in lines)


def copy_command(state, container, payload):
    real, state_fd = open_state(state)
    try:
        roots = mount_roots(state, container)
        configured = [store["rel"] for store in configured_stores(state, container, state_mounts(docker_containers(), state))]
        databases, links, chains, dirs = plan(state_fd, state, roots, configured)
        write_lines(os.path.join(payload, "sqlite-databases"), databases)
        write_lines(os.path.join(payload, "sqlite-links"), [f"{link}\t{target}" for link, target in links])
        write_lines(os.path.join(payload, "sqlite-chains"), [f"{start}\t{reached}" for start, reached in chains])
        # The real directories a chain steps through come back with the
        # databases, so a restore of --sqlite alone still lets every chain
        # reach its database.
        write_lines(os.path.join(payload, "sqlite-dirs"), dirs)
        manifest = [f"sqlite.link.{shown_name(link)}={shown_name(target)}" for link, target in links]
        for rel in databases:
            log(f"SQLite online backup of {state}/{rel}")
            before = file_id(state_fd, rel, state)
            copy = os.path.join(payload, "sqlite", rel)
            os.makedirs(os.path.dirname(copy), mode=0o700, exist_ok=True)
            copy_database(os.path.join(real, rel), copy)
            if file_id(state_fd, rel, state) != before:
                raise Refused(f"{state}/{rel} was replaced while it was copied; rerun the backup")
            for table, count in describe_copy(copy):
                manifest.append(f"sqlite.{shown_name(rel)}.{shown_name(table)}={count}")
        with open(os.path.join(payload, "MANIFEST"), "a", encoding="utf-8") as out:
            out.writelines(f"{line}\n" for line in manifest)
    finally:
        os.close(state_fd)


def preflight_command(state, container, local_dir):
    real, state_fd = open_state(state)
    try:
        local = os.path.realpath(local_dir)
        if within(local, real) or within(real, local):
            raise Refused(f"BACKUP_LOCAL_DIR ({local_dir}) and the state dir ({state}) overlap; keep the archives outside the state dir")
        configured = [store["rel"] for store in configured_stores(state, container, state_mounts(docker_containers(), state))]
        plan(state_fd, state, mount_roots(state, container), configured)
    finally:
        os.close(state_fd)


def pack_command(state, payload):
    """The state dir's other files as a tar: files and directories only, a
    hard link stored as a whole file, and every database, recorded link,
    chain start and SQLite side file left out. Any other link or special file
    is left out and logged. Each file is opened without following and checked
    to be the entry listed."""
    archive = Archive(payload)
    skip = database_paths(archive) | side_files(database_files(archive))
    real, state_fd = open_state(state)
    try:
        with tarfile.open(os.path.join(payload, "state-files.tar"), "w", format=tarfile.PAX_FORMAT) as tar:
            for rel, info in walk(state_fd, state):
                if stat.S_ISDIR(info.st_mode):
                    member = tarfile.TarInfo(rel)
                    member.type, member.mode, member.mtime = tarfile.DIRTYPE, info.st_mode & 0o7777, int(info.st_mtime)
                    tar.addfile(member)
                    continue
                if rel in skip or is_database_name(rel):
                    continue
                if not stat.S_ISREG(info.st_mode):
                    log(f"Left out {state}/{rel}: only files, directories and the database links are backed up")
                    continue
                parts = rel.split("/")
                parent = open_parts(state_fd, parts[:-1], state)
                try:
                    fd = os.open(parts[-1], READ_FLAGS, dir_fd=parent)
                except OSError as error:
                    raise Refused(f"cannot open {state}/{rel}: {error.strerror}")
                finally:
                    os.close(parent)
                with os.fdopen(fd, "rb") as handle:
                    opened = os.fstat(fd)
                    if (opened.st_dev, opened.st_ino) != (info.st_dev, info.st_ino):
                        raise Refused(f"{state}/{rel} changed while it was read")
                    member = tarfile.TarInfo(rel)
                    member.size, member.mode, member.mtime = opened.st_size, opened.st_mode & 0o7777, int(opened.st_mtime)
                    tar.addfile(member, handle)
    finally:
        os.close(state_fd)


def validate_command(state, container, payload):
    """The restore's own checks over the payload, into an empty state dir:
    a backup counts only if it would restore."""
    archive = Archive(payload)
    problems = archive_problems(archive)
    if not problems:
        roots = mount_roots(state, container)
        problems = chain_problems(overlay(None, archive, restore_writes(archive)), archive, roots)
    for problem in problems:
        print(problem, file=sys.stderr)
    return 1 if problems else 0


def seal_command(payload):
    """SHA256SUMS over every other file, then the payload as a gzipped tar on
    stdout, files and directories only."""
    files, dirs = [], []
    for root, names, filenames in os.walk(payload):
        names.sort()
        for name in names:
            dirs.append(os.path.relpath(os.path.join(root, name), payload))
        for name in sorted(filenames):
            rel = os.path.relpath(os.path.join(root, name), payload)
            if rel != "SHA256SUMS":
                files.append(rel)
    sums = []
    for rel in sorted(files):
        digest = hashlib.sha256()
        with open(os.path.join(payload, rel), "rb") as handle:
            for chunk in iter(lambda: handle.read(1 << 20), b""):
                digest.update(chunk)
        sums.append(f"{digest.hexdigest()}  ./{rel}")
    write_lines(os.path.join(payload, "SHA256SUMS"), sums)
    with tarfile.open(fileobj=sys.stdout.buffer, mode="w|gz", format=tarfile.PAX_FORMAT) as tar:
        root = tarfile.TarInfo(".")
        root.type, root.mode = tarfile.DIRTYPE, 0o700
        tar.addfile(root)
        for rel in sorted(dirs + files + ["SHA256SUMS"]):
            full = os.path.join(payload, rel)
            info = os.lstat(full)
            member = tarfile.TarInfo(f"./{rel}")
            member.mode, member.mtime = info.st_mode & 0o700, int(info.st_mtime)
            if stat.S_ISDIR(info.st_mode):
                member.type = tarfile.DIRTYPE
                tar.addfile(member)
            elif stat.S_ISREG(info.st_mode):
                member.size = info.st_size
                with open(full, "rb") as handle:
                    tar.addfile(member, handle)
            else:
                raise Refused(f"{rel} in the payload is not a file or directory")


def url_port(url):
    parsed = urllib.parse.urlsplit(url)
    return str(parsed.port if parsed.port is not None else (443 if parsed.scheme == "https" else 80))


def env_lines(name):
    return [line.strip() for line in os.environ.get(name, "").splitlines() if line.strip()]


def fenced_command(state):
    """Succeeds only when no container can write the state dir unseen:
    every one that is not stopped and mounts the state dir, a dir above it or
    one inside it, writable, is an SFU that holds this backup's fence, alone
    under its SFU_INSTANCE_ID and on the port that answered for it; and each
    health URL that gave no fence answer belongs to a container Docker
    reports stopped. What Docker cannot report counts as running."""
    held = {}
    for line in env_lines("FENCE_HELD"):
        url, _, instance = line.partition(" ")
        port = url_port(url)
        if instance in held:
            raise Refused(f"two fence answers came from SFU instance {instance}, so one of them stands for an SFU that is not the one it names")
        held[instance] = port
    containers = state_mounts(docker_containers(), state)
    by_instance = {}
    for found in containers:
        if not running(found) or not found["writable"]:
            continue
        instance = found["env"].get("SFU_INSTANCE_ID", "")
        port = found["env"].get("SFU_PORT", "")
        if found["relation"] == "unknown" and instance not in held:
            raise Refused(f"Docker cannot tell whether the SFU container {found['id']} ({instance}) mounts the state dir, since one of its mounts does not resolve, and it does not hold the write fence")
        if not instance:
            raise Refused(f"the container {found['id']} is {found['status']} and can write the state dir, but has no SFU_INSTANCE_ID, so no fence answer can stand for it")
        if instance not in held:
            raise Refused(f"the SFU container {found['id']} ({instance}) is {found['status']} but does not hold the write fence")
        if port != held[instance]:
            raise Refused(f"the SFU container {found['id']} ({instance}) listens on port {port or 'unknown'}, but the fence answer for {instance} came from port {held[instance]}")
        by_instance.setdefault(instance, []).append(found["id"])
        if len(by_instance[instance]) > 1:
            raise Refused(f"the containers {' and '.join(by_instance[instance])} both run as SFU instance {instance}, so one fence answer cannot stand for both")
    for url in env_lines("FENCE_UNANSWERED"):
        port = url_port(url)
        stopped = None
        for found in containers:
            if found["env"].get("SFU_PORT", "") != port:
                continue
            if running(found):
                raise Refused(f"{url} gave no fence answer, but Docker reports its container {found['id']} {found['status']}")
            stopped = found["id"]
        if stopped is None:
            raise Refused(f"{url} gave no fence answer, and Docker lists no stopped SFU container on port {port}, so that SFU may still write")


def containers_command(state):
    """The SFU containers that see the state dir, the ones that mount it
    first, then those that mount a dir above or inside it."""
    found_all = state_mounts(docker_containers(), state)
    sfus = [found for found in found_all if found["env"].get("SFU_INSTANCE_ID")]
    ordered = [found for found in sfus if found["relation"] == "exact"]
    ordered += [found for found in sfus if found["relation"] == "related"]
    for found in ordered:
        env = found["env"]
        print("|".join([found["id"], found["status"], env.get("SFU_PORT", ""), env.get("SFU_INSTANCE_ID", ""), found["user"], found["image"]]))


def main(argv):
    command, args = argv[1], argv[2:]
    try:
        if command == "preflight":
            preflight_command(*args)
        elif command == "copy":
            copy_command(*args)
        elif command == "pack":
            pack_command(*args)
        elif command == "validate":
            return validate_command(*args)
        elif command == "seal":
            seal_command(*args)
        elif command == "fenced":
            fenced_command(*args)
        elif command == "containers":
            containers_command(*args)
        else:
            print(f"unknown command {command}", file=sys.stderr)
            return 2
    except Refused as refused:
        print(refused, file=sys.stderr)
        return 1
    except sqlite3.Error as error:
        print(f"SQLite: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
