#!/usr/bin/env python3
# The path rules for backup.sh and restore.sh, in one place.
#
# One validator checks what an archive holds: every database copy, recorded
# link and file is a plain relative path; every recorded link maps inside the
# state dir; the files are regular files and directories only; and nothing is
# written under a recorded link. backup.sh runs it on a fresh payload before
# the backup counts, and restore.sh runs it, with the checks on the live state
# dir it will write into, before the first write.
#
# The restore's writes then go through an open state dir, one directory at a
# time with O_NOFOLLOW, so no path component is ever followed: a link
# anywhere on the way stops the write. Recorded links are made relative, so
# no link to a literal host path is ever created.
#
#   restore_paths.py pack STATE OUT_TAR [--db REL...] [--link REL...]
#   restore_paths.py validate PAYLOAD STATE CONTAINER
#   restore_paths.py check PAYLOAD STATE CONTAINER [--sqlite] [--files]
#   restore_paths.py apply PAYLOAD STATE CONTAINER STAMP [--sqlite] [--files]
import os
import shutil
import stat
import sys
import tarfile
import tempfile
import time

SIDE_SUFFIXES = ("-wal", "-shm", "-journal")
NO_FOLLOW_DIR = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW


class Refused(Exception):
    pass


def log(message):
    print(time.strftime("[%H:%M:%SZ]", time.gmtime()), message, flush=True)


def plain(name):
    """The name as a plain relative path, "." for the root, or None."""
    if name.startswith("./"):
        name = name[2:]
    if name in ("", "."):
        return "."
    if any(ord(char) < 32 or ord(char) == 127 for char in name):
        return None
    if name.startswith("/") or ".." in name.split("/") or os.path.normpath(name) != name:
        return None
    return name


def mounts_for(state, container):
    return {path for path in (container.rstrip("/"), state.rstrip("/"), os.path.realpath(state)) if path}


def mapped(target, link, mounts):
    """A recorded link's target relative to the state dir, read the way the
    SFU reads it (its mount path stands for the state dir), or None when it
    leads out."""
    if os.path.isabs(target):
        mount = next((m for m in mounts if target == m or target.startswith(m + "/")), None)
        if mount is None:
            return None
        rel = target[len(mount):].lstrip("/") or "."
    else:
        rel = os.path.join(os.path.dirname(link), target)
    rel = os.path.normpath(rel)
    if os.path.isabs(rel) or rel == ".." or rel.startswith(".." + os.sep):
        return None
    return rel


def read_payload(payload):
    databases, links, members = [], [], []
    sqlite_dir = os.path.join(payload, "sqlite")
    for root, dirs, files in os.walk(sqlite_dir):
        for name in files:
            if not name.endswith(SIDE_SUFFIXES):
                databases.append(os.path.relpath(os.path.join(root, name), sqlite_dir))
    links_path = os.path.join(payload, "sqlite-links")
    if os.path.isfile(links_path):
        with open(links_path, encoding="utf-8", errors="surrogateescape") as handle:
            for line in handle:
                line = line.rstrip("\n")
                if line:
                    link, sep, target = line.partition("\t")
                    links.append((link, target if sep else None))
    tar_path = os.path.join(payload, "state-files.tar")
    if os.path.isfile(tar_path):
        with tarfile.open(tar_path) as tar:
            members = tar.getmembers()
    return sorted(databases), links, members


def archive_problems(payload, mounts):
    problems = []
    databases, links, members = read_payload(payload)
    for root, dirs, files in os.walk(os.path.join(payload, "sqlite")):
        for name in dirs + files:
            full = os.path.join(root, name)
            if os.path.islink(full) or not (os.path.isdir(full) or os.path.isfile(full)):
                problems.append(f"sqlite/{os.path.relpath(full, os.path.join(payload, 'sqlite'))} in the archive is not a plain file")
    writes = []
    link_paths = set()
    for rel in databases:
        if plain(rel) in (None, "."):
            problems.append(f"{rel} is not a plain path inside the archive")
        else:
            writes.append((rel, "db"))
    for link, target in links:
        rel = plain(link)
        if rel in (None, "."):
            problems.append(f"the recorded link {link} is not a plain path inside the archive")
        elif target is None or mapped(target, rel, mounts) is None:
            problems.append(f"the recorded link {link} leads outside the state dir ({target})")
        else:
            link_paths.add(rel)
            writes.append((rel, "link"))
    for member in members:
        name = plain(member.name)
        shown = member.name[2:] if member.name.startswith("./") else member.name
        if name is None:
            problems.append(f"{shown} is not a plain path inside the archive")
        elif member.issym() or member.islnk():
            problems.append(f"{name} is a link, and the only links a restore makes are the recorded database links")
        elif not (member.isfile() or member.isdir()):
            problems.append(f"{name} is not a file or directory")
        elif name != ".":
            writes.append((name, "dir" if member.isdir() else "file"))
    kinds = {}
    for rel, kind in writes:
        kinds.setdefault(rel, set()).add(kind)
    for rel, found in kinds.items():
        if len(found) > 1:
            problems.append(f"{rel} is in the archive more than once, as {' and '.join(sorted(found))}")
    for rel, _ in writes:
        parts = rel.split("/")
        for i in range(1, len(parts)):
            prefix = "/".join(parts[:i])
            if prefix in link_paths:
                problems.append(f"{rel} sits under the recorded link {prefix}, and a restore never writes through a link")
                break
    return problems, databases, links, writes


def live_problems(state, writes):
    """Checks the live state dir: no link and no file on the way to any
    write, and no write that would replace a directory."""
    problems = []
    for rel, kind in writes:
        parts = rel.split("/")
        here, blocked = state, False
        for i, part in enumerate(parts[:-1]):
            here = os.path.join(here, part)
            shown = "/".join(parts[: i + 1])
            if os.path.islink(here):
                problems.append(f"{shown} is a link in the state dir, and a restore never writes through a link")
                blocked = True
                break
            if not os.path.lexists(here):
                break
            if not os.path.isdir(here):
                problems.append(f"{shown} is not a directory in the state dir")
                blocked = True
                break
        if blocked:
            continue
        final = os.path.join(state, rel)
        is_dir = os.path.isdir(final) and not os.path.islink(final)
        if kind in ("db", "file", "link") and is_dir:
            problems.append(f"{rel} is a directory in the state dir")
        if kind == "dir" and os.path.lexists(final) and not is_dir:
            problems.append(f"{rel} is a directory in the archive but not in the state dir")
    return problems


def planned(writes, sqlite, files):
    """The writes this restore makes: database copies and recorded links for
    --sqlite, the other files and directories for --files."""
    return [(rel, kind) for rel, kind in writes if (kind in ("db", "link") and sqlite) or (kind in ("file", "dir") and files)]


def open_dirs(state_fd, parts):
    """An fd for the directory parts name below the state dir, made where
    missing; a link or a file anywhere on the way is refused, never
    followed."""
    fd = os.dup(state_fd)
    walked = []
    try:
        for part in parts:
            walked.append(part)
            try:
                child = os.open(part, NO_FOLLOW_DIR, dir_fd=fd)
            except FileNotFoundError:
                os.mkdir(part, dir_fd=fd)
                child = os.open(part, NO_FOLLOW_DIR, dir_fd=fd)
            except OSError:
                raise Refused(f"{'/'.join(walked)} is a link or not a directory, and a restore never writes through a link")
            os.close(fd)
            fd = child
        return fd
    except BaseException:
        os.close(fd)
        raise


def exists(name, dir_fd):
    try:
        os.stat(name, dir_fd=dir_fd, follow_symlinks=False)
        return True
    except FileNotFoundError:
        return False


def move_aside(name, dir_fd, stamp):
    if exists(name, dir_fd):
        os.rename(name, f"{name}.pre-restore-{stamp}", src_dir_fd=dir_fd, dst_dir_fd=dir_fd)


def restore_database(state_fd, state, payload, rel, stamp):
    parts = rel.split("/")
    parent = open_dirs(state_fd, parts[:-1])
    try:
        base = parts[-1]
        temporary = f".{base}.restore-{os.getpid()}"
        out = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=parent)
        with open(os.path.join(payload, "sqlite", rel), "rb") as source, os.fdopen(out, "wb") as target:
            shutil.copyfileobj(source, target)
            target.flush()
            os.fsync(target.fileno())
        # The live database and its WAL move aside together, so they stay a
        # consistent pair if this restore has to be undone.
        for suffix in ("", "-wal", "-shm"):
            move_aside(base + suffix, parent, stamp)
        os.rename(temporary, base, src_dir_fd=parent, dst_dir_fd=parent)
    finally:
        os.close(parent)
    log(f"Restored {state}/{rel} (previous copy kept as {state}/{rel}.pre-restore-{stamp})")


def restore_link(state_fd, state, link, target, mounts, stamp):
    rel = plain(link)
    relative = os.path.relpath(mapped(target, rel, mounts), os.path.dirname(rel) or ".")
    parts = rel.split("/")
    parent = open_dirs(state_fd, parts[:-1])
    try:
        base = parts[-1]
        try:
            current = os.readlink(base, dir_fd=parent)
        except OSError:
            current = None
        if current == relative:
            return
        move_aside(base, parent, stamp)
        os.symlink(relative, base, dir_fd=parent)
    finally:
        os.close(parent)
    log(f"Restored the link {state}/{rel} -> {relative}")


def restore_files(state_fd, state, tar_path):
    staging = tempfile.mkdtemp(prefix=".restore-", dir=os.path.realpath(state))
    try:
        with tarfile.open(tar_path) as tar:
            tar.extractall(staging, filter="data")
        for root, dirs, files in os.walk(staging):
            for name in dirs + files:
                full = os.path.join(root, name)
                if os.path.islink(full) or not (os.path.isdir(full) or os.path.isfile(full)):
                    raise Refused(f"{os.path.relpath(full, staging)} came out of the archive as neither a file nor a directory; nothing more was moved in")
        for root, dirs, files in os.walk(staging):
            rel = os.path.relpath(root, staging)
            target = open_dirs(state_fd, [] if rel == "." else rel.split("/"))
            source = os.open(root, NO_FOLLOW_DIR)
            try:
                for name in files:
                    os.rename(name, name, src_dir_fd=source, dst_dir_fd=target)
            finally:
                os.close(source)
                os.close(target)
    finally:
        shutil.rmtree(staging, ignore_errors=True)
    log(f"Restored the other files in {state}")


def pack(state, out, skip_databases, skip_links):
    """The state dir's other files as a tar: files and directories only, hard
    links stored as whole files (as tar --hard-dereference does), and the
    databases, their side files, the recorded links, copies a restore moved
    aside and a restore's staging dirs left out. Any other link or special
    file is left out and logged."""
    skip = set(skip_links) | {db + suffix for db in skip_databases for suffix in ("",) + SIDE_SUFFIXES}
    with tarfile.open(out, "w", format=tarfile.PAX_FORMAT) as tar:
        for root, dirs, files in os.walk(state):
            dirs.sort()
            rel_root = os.path.relpath(root, state)
            kept = []
            for name in dirs:
                rel = name if rel_root == "." else f"{rel_root}/{name}"
                full = os.path.join(root, name)
                if rel in skip or ".pre-restore-" in name or (rel_root == "." and name.startswith(".restore-")):
                    continue
                if os.path.islink(full):
                    log(f"Left out {state}/{rel}: only files, directories and the database links are backed up")
                    continue
                kept.append(name)
                tar.add(full, arcname=rel, recursive=False)
            dirs[:] = kept
            for name in sorted(files):
                rel = name if rel_root == "." else f"{rel_root}/{name}"
                full = os.path.join(root, name)
                if rel in skip or ".pre-restore-" in name or name.endswith((".sqlite", ".sqlite-wal", ".sqlite-shm")):
                    continue
                info = os.lstat(full)
                if not stat.S_ISREG(info.st_mode):
                    log(f"Left out {state}/{rel}: only files, directories and the database links are backed up")
                    continue
                member = tar.gettarinfo(full, arcname=rel)
                if member.islnk():
                    member.type, member.linkname, member.size = tarfile.REGTYPE, "", info.st_size
                with open(full, "rb") as handle:
                    tar.addfile(member, handle)


def flags(args):
    return "--sqlite" in args, "--files" in args


def main(argv):
    command, args = argv[1], argv[2:]
    if command == "pack":
        state, out = args[0], args[1]
        skipped, mode = {"--db": [], "--link": []}, None
        for arg in args[2:]:
            if arg in skipped:
                mode = arg
            elif mode:
                skipped[mode].append(arg)
        pack(state, out, skipped["--db"], skipped["--link"])
        return 0
    if command == "validate":
        payload, state, container = args[:3]
        problems = archive_problems(payload, mounts_for(state, container))[0]
    elif command in ("check", "apply"):
        payload, state, container = args[:3]
        mounts = mounts_for(state, container)
        sqlite, files = flags(args)
        problems, databases, links, writes = archive_problems(payload, mounts)
        if not problems:
            problems = live_problems(os.path.realpath(state), planned(writes, sqlite, files))
        if command == "apply" and not problems:
            stamp = args[3]
            state_fd = os.open(os.path.realpath(state), os.O_RDONLY | os.O_DIRECTORY)
            try:
                if sqlite:
                    for rel in databases:
                        restore_database(state_fd, state, payload, rel, stamp)
                    for link, target in links:
                        restore_link(state_fd, state, link, target, mounts, stamp)
                tar_path = os.path.join(payload, "state-files.tar")
                if files and os.path.isfile(tar_path):
                    restore_files(state_fd, state, tar_path)
            except Refused as refused:
                print(refused, file=sys.stderr)
                return 1
            finally:
                os.close(state_fd)
    else:
        print(f"unknown command {command}", file=sys.stderr)
        return 2
    for problem in problems:
        print(problem, file=sys.stderr)
    return 1 if problems else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
