#!/usr/bin/env python3
"""Restores a decrypted backup archive, for restore.sh. Without --apply it
verifies the archive and checks the live state dir, and changes nothing.

  restore_state.py --archive TAR_GZ --work DIR --state STATE --container PATH
                   [--only sqlite,redis,files] [--apply --stamp STAMP [--owner UID:GID]]

Nothing in the archive passes through a shell. The archive is read here and
written into the work dir (this user's, 0700, outside the state dir) entry by
entry: plain relative names, regular files and directories only, nothing
followed, and an exact SHA256SUMS that names every other file once.

The restored tree is built in full in a private staging dir beside the state
dir, on its file system, and moved in only once every check passes and no
running container mounts the state dir, a dir above it or one inside it.
Each entry moves by rename between open directories; whatever it replaces
moves into a pre-restore dir beside the state dir, so no restored name gets a
suffix, and a failure undoes every rename made. Ownership goes only to the
entries the restore created, set through their own fds as they are made.
"""
import argparse
import hashlib
import os
import re
import secrets
import shutil
import signal
import socket
import sqlite3
import stat
import subprocess
import sys
import tarfile
import time
import urllib.error
import urllib.parse
import urllib.request
import zlib
from contextlib import contextmanager

# Root runs these from the checkout; no bytecode is left beside them.
sys.dont_write_bytecode = True
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from statelib import (  # noqa: E402
    DIR_FLAGS,
    NAME_MAX,
    Archive,
    Refused,
    Tree,
    archive_problems,
    at,
    chain_problems,
    configured_stores,
    redis_revision_key,
    redis_key_pattern,
    database_files,
    database_paths,
    docker_containers,
    fallback_import_dirs,
    folded,
    json_coverage_problems,
    log,
    mount_roots,
    open_dir,
    open_parts,
    overlay,
    plain,
    restore_writes,
    running,
    side_files,
    state_mounts,
    walk,
    within,
)

PARTS = ("sqlite", "redis", "files")

# Keep in step with the input names in controlPlane/legacy.ts.
IMPORT_COPY = re.compile(r"(?:scheduled-meetings|scheduled-webinars|scheduling)\.json(?:\.claimed-[0-9]+-[0-9]+)?")


class Builder:
    """Writes a tree below root_fd, a directory only this run can reach,
    entry by entry through directory fds, never following anything and
    refusing any path twice or under a second spelling. Entries are given to
    owner through their own fds as they are made; directories stay 0700
    until set_modes."""

    def __init__(self, root_fd, owner=None):
        self.root_fd = root_fd
        self.owner = owner
        self.kinds = {}
        self.spellings = {}
        self.dirs = {}

    def claim(self, rel, kind):
        known = self.kinds.get(rel)
        if known == "dir" and kind == "dir":
            return False
        if known:
            raise Refused(f"{rel} is in the archive more than once")
        spelling = self.spellings.setdefault(folded(rel), rel)
        if spelling != rel:
            raise Refused(f"{rel} and {spelling} differ only in case or Unicode form, so one would overwrite the other")
        self.kinds[rel] = kind
        return True

    def parent(self, rel):
        parts = rel.split("/")
        for i in range(1, len(parts)):
            prefix = "/".join(parts[:i])
            if self.kinds.get(prefix, "dir") != "dir":
                raise Refused(f"{rel} sits under {prefix}, which the archive also holds as a file")
            self.dir(prefix)
        return open_parts(self.root_fd, parts[:-1]), parts[-1]

    def own(self, fd):
        if self.owner:
            os.fchown(fd, *self.owner)

    def dir(self, rel, mode=None):
        if self.claim(rel, "dir"):
            parent, base = self.parent(rel)
            try:
                os.mkdir(base, 0o700, dir_fd=parent)
                fd = os.open(base, DIR_FLAGS, dir_fd=parent)
                try:
                    self.own(fd)
                    info = os.fstat(fd)
                finally:
                    os.close(fd)
            finally:
                os.close(parent)
            self.dirs[rel] = [0o700, (info.st_dev, info.st_ino)]
        if mode is not None:
            self.dirs[rel][0] = (mode & 0o755) | 0o700

    def file(self, rel, source, mode):
        self.claim(rel, "file")
        parent, base = self.parent(rel)
        digest = hashlib.sha256()
        try:
            fd = os.open(base, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC, 0o600, dir_fd=parent)
        finally:
            os.close(parent)
        try:
            for chunk in iter(lambda: source.read(1 << 20), b""):
                digest.update(chunk)
                view = memoryview(chunk)
                while view:
                    view = view[os.write(fd, view):]
            os.fsync(fd)
            info = os.fstat(fd)
            if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1:
                raise Refused(f"{rel} gained a second name while it was written, so it is not given to the SFU's user")
            self.own(fd)
            os.fchmod(fd, mode & 0o755)
        finally:
            os.close(fd)
        return digest.hexdigest()

    def link(self, rel, target):
        self.claim(rel, "link")
        parent, base = self.parent(rel)
        try:
            os.symlink(target, base, dir_fd=parent)
            if self.owner:
                os.chown(base, *self.owner, dir_fd=parent, follow_symlinks=False)
        finally:
            os.close(parent)

    def set_modes(self, root_fd, rels):
        """Gives the directories their archived modes once they are in place,
        each opened through root_fd and checked to be the one made here."""
        for rel in sorted(rels, key=lambda r: r.count("/"), reverse=True):
            mode, made = self.dirs[rel]
            fd = open_parts(root_fd, rel.split("/"))
            try:
                opened = os.fstat(fd)
                if (opened.st_dev, opened.st_ino) != made:
                    raise Refused(f"{rel} is not the directory the restore made")
                os.fchmod(fd, mode)
            finally:
                os.close(fd)


def extract_archive(archive_path, payload_fd, payload):
    """The outer archive into payload, checked against its SHA256SUMS."""
    builder = Builder(payload_fd)
    hashes = {}
    try:
        with tarfile.open(archive_path, "r|gz") as tar:
            for member in tar:
                name = plain(member.name)
                shown = member.name[2:] if member.name.startswith("./") else member.name
                if name is None:
                    raise Refused(f"{shown} in the archive is not a plain path inside it")
                if name == ".":
                    if not member.isdir():
                        raise Refused("the archive's root is not a directory")
                elif member.isdir():
                    builder.dir(name)
                elif member.isreg() and not member.issparse():
                    hashes[name] = builder.file(name, tar.extractfile(member), 0o600)
                else:
                    raise Refused(f"{name} in the archive is not a regular file or directory")
    except (tarfile.TarError, EOFError, zlib.error) as error:
        raise Refused(f"the archive cannot be read: {error}")
    if "SHA256SUMS" not in hashes:
        raise Refused("the archive has no SHA256SUMS")
    hashes.pop("SHA256SUMS")
    listed = {}
    with open(os.path.join(payload, "SHA256SUMS"), encoding="utf-8") as handle:
        for line in handle:
            match = re.fullmatch(r"([0-9a-f]{64}) [ *](.+)", line.rstrip("\n"))
            if not match:
                raise Refused("SHA256SUMS has a line that is not a checksum and a plain path")
            rel = plain(match.group(2))
            if rel in (None, "."):
                raise Refused(f"SHA256SUMS lists {match.group(2)}, which is not a plain path inside the archive")
            if rel in listed:
                raise Refused(f"SHA256SUMS lists {rel} twice")
            listed[rel] = match.group(1)
    unlisted = sorted(set(hashes) - set(listed))
    absent = sorted(set(listed) - set(hashes))
    changed = sorted(rel for rel in set(hashes) & set(listed) if hashes[rel] != listed[rel])
    if unlisted or absent or changed:
        details = [f"{rel} is not in SHA256SUMS" for rel in unlisted] + [f"{rel} is missing" for rel in absent] + [f"{rel} does not match" for rel in changed]
        raise Refused("checksums do not match; the archive is damaged: " + "; ".join(details))


def check_copies(archive):
    for rel in archive.databases:
        path = os.path.join(archive.payload, "sqlite", rel)
        reader = sqlite3.connect(f"file:{urllib.parse.quote(path, safe='/')}?mode=ro&immutable=1", uri=True)
        try:
            result = [row[0] for row in reader.execute("PRAGMA integrity_check")]
        finally:
            reader.close()
        if result != ["ok"]:
            raise Refused(f"{rel} failed its integrity check")


def check_work(work, state):
    real = os.path.realpath(work)
    info = os.lstat(real)
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.geteuid() or info.st_mode & 0o077:
        raise Refused(f"the work dir {work} must be a directory only this user can open")
    state_real = os.path.realpath(state)
    if within(real, state_real) or within(state_real, real):
        raise Refused(f"the work dir {work} must be outside the state dir {state}")
    return os.open(real, DIR_FLAGS), real


def can_write(info):
    """Whether this user can add and remove entries in the directory."""
    if os.geteuid() == 0:
        return True
    if info.st_uid == os.geteuid():
        bits = 0o300
    elif info.st_gid == os.getegid() or info.st_gid in os.getgroups():
        bits = 0o030
    else:
        bits = 0o003
    return info.st_mode & bits == bits


class StateDir:
    """The state dir, its real path read once, then reached only through
    open directory fds."""

    def __init__(self, given):
        self.given = given
        self.real = os.path.realpath(given)
        self.parent_real, self.base = os.path.split(self.real)
        self.fd = None
        self.dev = None
        try:
            self.fd = os.open(self.real, DIR_FLAGS)
        except FileNotFoundError:
            return
        except OSError as error:
            raise Refused(f"the state dir {given} cannot be opened as a directory: {error.strerror}")
        self.dev = os.fstat(self.fd).st_dev

    def live_problems(self, writes, retire):
        """The live state dir can take the writes: every directory on their
        way is a real directory on the state dir's file system that this user
        can change, nothing a restore replaces is a directory, and nothing a
        directory goes is anything else."""
        if self.fd is None:
            return []
        problems = []
        dirs = {rel for rel, kind in writes if kind == "dir"}
        for rel, _ in writes:
            parts = rel.split("/")
            dirs.update("/".join(parts[:i]) for i in range(1, len(parts)))
        paths = {rel for rel, _ in writes} | dirs | retire
        seen = {}

        def look(rel):
            """(info, holder): the entry's lstat or None, and the lstat of the
            directory that holds it, None when that directory is missing or
            no real directory."""
            if rel not in seen:
                parts = rel.split("/")
                try:
                    parent = open_parts(self.fd, parts[:-1])
                except (FileNotFoundError, Refused):
                    seen[rel] = (None, None)
                    return seen[rel]
                try:
                    seen[rel] = (at(parent, parts[-1], f"{self.given}/{rel}"), os.fstat(parent))
                finally:
                    os.close(parent)
            return seen[rel]

        for rel in sorted(paths, key=lambda r: (r.count("/"), r)):
            info, holder = look(rel)
            if holder is None:
                continue
            if rel in dirs:
                if info is None:
                    if not can_write(holder):
                        problems.append(f"the directory that holds {rel} is not writable by this user; rerun the restore as root")
                elif stat.S_ISLNK(info.st_mode):
                    problems.append(f"{rel} is a link in the state dir, and a restore never writes through a link")
                elif not stat.S_ISDIR(info.st_mode):
                    problems.append(f"{rel} is a directory in the archive but not in the state dir")
                elif info.st_dev != self.dev:
                    problems.append(f"{rel} is a mount point inside the state dir, and a restore moves files by rename, which cannot cross it")
                continue
            if info is not None and stat.S_ISDIR(info.st_mode):
                problems.append(f"{rel} is a directory in the state dir")
            elif info is not None and not (stat.S_ISREG(info.st_mode) or stat.S_ISLNK(info.st_mode)):
                problems.append(f"{rel} is not a file or link in the state dir")
            elif (info is not None or rel not in retire) and not can_write(holder):
                problems.append(f"the directory that holds {rel} is not writable by this user; rerun the restore as root")
        return sorted(set(problems))


def live_imports_to_retire(state, dirs, writes):
    """Live importer inputs to move aside before placing archived copies."""
    if state.fd is None:
        return set()
    def entries(rel):
        try:
            fd = open_parts(state.fd, rel.split("/") if rel else [], state.given)
        except FileNotFoundError:
            return []
        try:
            with os.scandir(fd) as scan:
                return [(entry.name, entry.is_dir(follow_symlinks=False)) for entry in scan]
        except OSError as error:
            raise Refused(f"cannot list {state.given}/{rel}: {error.strerror}")
        finally:
            os.close(fd)

    # A live-only .source would change the lineage of a restored snapshot.
    archived_groups = {os.path.dirname(rel) for rel, kind in writes
                       if kind != "dir" and IMPORT_COPY.fullmatch(os.path.basename(rel))}
    retire = set()
    for root in dirs:
        for name, is_dir in entries(root):
            if not is_dir or name.startswith("."):
                continue
            service = f"{root}/{name}" if root else name
            for leaf, is_dir in entries(service):
                if IMPORT_COPY.fullmatch(leaf):
                    retire.add(f"{service}/{leaf}")
                if not is_dir or leaf.startswith("."):
                    continue
                group = f"{service}/{leaf}"
                for file, _ in entries(group):
                    if IMPORT_COPY.fullmatch(file) or (file == ".source" and group in archived_groups):
                        retire.add(f"{group}/{file}")
    return retire - {rel for rel, kind in writes if kind == "dir"}


def http_answers(url):
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    try:
        opener.open(url, timeout=3).close()
        return True
    except urllib.error.HTTPError:
        return True
    except (urllib.error.URLError, OSError, ValueError):
        return False


def holders(path):
    result = subprocess.run(["fuser", path], capture_output=True, text=True)
    return result.stdout.split()


def refuse_live_sfus(state, archive):
    """Nothing may hold the state dir: an SFU that answers, a container that
    is not stopped and mounts the state dir, a dir above it or one inside
    it, or a process with a database open."""
    for url in os.environ.get("SFU_HEALTH_URLS", "").split():
        if http_answers(url):
            raise Refused(f"an SFU still answers at {url}; stop the SFU containers before restoring")
    for found in state_mounts(docker_containers(), state.given):
        if running(found):
            how = {"exact": "the state dir", "related": "a dir that holds the state dir or lies inside it", "unknown": "a path Docker cannot resolve"}[found["relation"]]
            raise Refused(f"the container {found['id']} ({found['env'].get('SFU_INSTANCE_ID') or 'not an SFU'}) is {found['status']} and mounts {how}; stop it before restoring")
    if state.fd is None:
        return
    if shutil.which("fuser") is None:
        raise Refused("fuser is not installed (apt-get install psmisc)")
    candidates = database_paths(archive)
    for rel, info in walk(state.fd, state.given):
        if rel.endswith(".sqlite") and (stat.S_ISREG(info.st_mode) or stat.S_ISLNK(info.st_mode)):
            candidates.add(rel)
    for rel in sorted(candidates):
        path = os.path.join(state.real, rel)
        if os.path.lexists(path):
            found = holders(path)
            if found:
                raise Refused(f"PID {' '.join(found)} still holds {state.given}/{rel} open; stop the SFU containers before restoring")


class Swap:
    """Moves the staged tree into the state dir by rename, entry by entry,
    each live entry it replaces first moved into the aside dir. Every rename
    is journaled, so undo puts back exactly what was there."""

    STOPS = (signal.SIGTERM, signal.SIGHUP, signal.SIGINT)

    def __init__(self, state_fd, staging_fd, aside_fd):
        self.state_fd = state_fd
        self.staging_fd = staging_fd
        self.aside_fd = aside_fd
        self.journal = []
        self.placed_dirs = []
        self.stopped = []
        self.handlers = {}

    def __enter__(self):
        for number in self.STOPS:
            self.handlers[number] = signal.signal(number, lambda received, frame: self.stopped.append(received))
        return self

    def __exit__(self, *exc):
        for number, handler in self.handlers.items():
            signal.signal(number, handler)
        return False

    def stop_after(self, kept):
        if self.stopped:
            where = f", the entries they replaced are in {kept}" if kept else ""
            raise Refused(f"stopped by {signal.Signals(self.stopped[0]).name} once every rename was done; the files are restored{where} and nothing after them ran")
        return kept

    def check_stop(self):
        if self.stopped:
            raise Refused(f"stopped by {signal.Signals(self.stopped[0]).name} before every rename was done; undoing them")

    @staticmethod
    def rename(src_root, dst_root, rel, make_dst=False):
        parts = rel.split("/")
        src = open_parts(src_root, parts[:-1])
        try:
            dst = Swap.aside_parent(dst_root, parts[:-1]) if make_dst else open_parts(dst_root, parts[:-1])
            try:
                if at(dst, parts[-1], rel) is not None:
                    raise Refused(f"{rel} appeared during the restore")
                os.rename(parts[-1], parts[-1], src_dir_fd=src, dst_dir_fd=dst)
            finally:
                os.close(dst)
        finally:
            os.close(src)

    @staticmethod
    def aside_parent(root, parts):
        fd = os.open(".", DIR_FLAGS, dir_fd=root)
        try:
            for part in parts:
                if at(fd, part, part) is None:
                    os.mkdir(part, 0o700, dir_fd=fd)
                child = open_dir(fd, part, part)
                os.close(fd)
                fd = child
            return fd
        except BaseException:
            os.close(fd)
            raise

    def aside(self, rel):
        self.check_stop()
        self.rename(self.state_fd, self.aside_fd, rel, make_dst=True)
        self.journal.append(("aside", rel))

    def place(self, rel):
        self.check_stop()
        self.rename(self.staging_fd, self.state_fd, rel)
        self.journal.append(("placed", rel))

    def merge(self, rel_dir=""):
        parts = rel_dir.split("/") if rel_dir else []
        staged_dir = open_parts(self.staging_fd, parts)
        live_dir = open_parts(self.state_fd, parts)
        try:
            entries = []
            for name in sorted(os.listdir(staged_dir)):
                entries.append((name, at(staged_dir, name, name), at(live_dir, name, name)))
        finally:
            os.close(staged_dir)
            os.close(live_dir)
        for name, staged, live in entries:
            rel = f"{rel_dir}/{name}" if rel_dir else name
            if stat.S_ISDIR(staged.st_mode) and live is not None and stat.S_ISDIR(live.st_mode):
                self.merge(rel)
                continue
            if live is not None:
                if stat.S_ISDIR(live.st_mode) or stat.S_ISDIR(staged.st_mode) or not (stat.S_ISREG(live.st_mode) or stat.S_ISLNK(live.st_mode)):
                    raise Refused(f"{rel} in the state dir changed during the restore")
                self.aside(rel)
            self.place(rel)
            if stat.S_ISDIR(staged.st_mode):
                self.placed_dirs.append(rel)

    def undo(self):
        while self.journal:
            kind, rel = self.journal.pop()
            if kind == "placed":
                self.rename(self.state_fd, self.staging_fd, rel)
            else:
                self.rename(self.aside_fd, self.state_fd, rel)


def remove_tree(parent_fd, name):
    """Removes a directory this run made and only it can reach."""
    fd = open_dir(parent_fd, name, name)
    try:
        for entry in os.listdir(fd):
            info = at(fd, entry, entry)
            if info is not None and stat.S_ISDIR(info.st_mode):
                remove_tree(fd, entry)
            elif info is not None:
                os.unlink(entry, dir_fd=fd)
    finally:
        os.close(fd)
    os.rmdir(name, dir_fd=parent_fd)


def holds_files(parent_fd, name):
    fd = open_dir(parent_fd, name, name)
    try:
        return any(not stat.S_ISDIR(info.st_mode) for _, info in walk(fd, name))
    finally:
        os.close(fd)


def is_empty(parent_fd, name):
    fd = open_dir(parent_fd, name, name)
    try:
        return not os.listdir(fd)
    finally:
        os.close(fd)


def apply_restore(state, archive, writes, retire, roots, stamp, owner, sqlite):
    """Builds the restored tree beside the state dir, checks again, and swaps
    it in; any failure from the first rename on undoes them all."""
    os.makedirs(state.parent_real, mode=0o755, exist_ok=True)
    parent_fd = os.open(state.parent_real, DIR_FLAGS)
    try:
        parent = os.fstat(parent_fd)
        if parent.st_uid not in (0, os.geteuid()) or parent.st_mode & 0o022:
            raise Refused(f"{state.parent_real} can be changed by users other than its owner, so the restore cannot keep its staging copy private there")
        if state.fd is not None:
            entry = at(parent_fd, state.base, state.real)
            here = os.fstat(state.fd)
            if entry is None or (entry.st_dev, entry.st_ino) != (here.st_dev, here.st_ino):
                raise Refused(f"the state dir {state.given} moved while the restore checked it")
            if here.st_dev != parent.st_dev:
                raise Refused(f"the state dir {state.given} is a file system of its own (a mount point), so the restore cannot build the restored tree beside it on the same one and rename it in; mount the volume one level up, or restore into a new dir and move it")
        staging_name = f".conclave-restore-{stamp}-{secrets.token_hex(4)}"
        aside_base = f"{state.base}.pre-restore-{stamp}"
        if len(aside_base.encode("utf-8")) + 4 > NAME_MAX:
            aside_base = f".conclave-pre-restore-{stamp}"
        # Two restores in one second get their own dirs.
        aside_name = next((name for name in [aside_base] + [f"{aside_base}-{n}" for n in range(2, 100)] if at(parent_fd, name, name) is None), None)
        if aside_name is None:
            raise Refused(f"{state.parent_real}/{aside_base} and 98 more like it already exist; clear them out")
        os.mkdir(staging_name, 0o700, dir_fd=parent_fd)
        staging_fd = open_dir(parent_fd, staging_name, staging_name)
        try:
            if os.fstat(staging_fd).st_dev != parent.st_dev:
                raise Refused("the staging dir is not on the state dir's file system")
            builder = build(staging_fd, archive, writes, owner)
            if state.fd is None:
                if owner:
                    os.fchown(staging_fd, *owner)
                os.rename(staging_name, state.base, src_dir_fd=parent_fd, dst_dir_fd=parent_fd)
                staging_name = None
                state_fd = open_dir(parent_fd, state.base, state.real)
                try:
                    problems = chain_problems(Tree(state_fd), archive, roots) if sqlite else []
                    if problems:
                        os.rename(state.base, ".conclave-restore-failed-" + stamp, src_dir_fd=parent_fd, dst_dir_fd=parent_fd)
                        raise Refused("after the restore, " + "; ".join(problems) + f"; the restored tree was moved to {state.parent_real}/.conclave-restore-failed-{stamp}")
                    builder.set_modes(state_fd, list(builder.dirs))
                finally:
                    os.close(state_fd)
                return None
            problems = state.live_problems(writes, retire)
            if problems:
                raise Refused("; ".join(problems))
            os.mkdir(aside_name, 0o700, dir_fd=parent_fd)
            aside_fd = open_dir(parent_fd, aside_name, aside_name)
            try:
                with Swap(state.fd, staging_fd, aside_fd) as swap:
                    try:
                        # Retire old journal files and live importer inputs
                        # before any restored checkpoint can become visible.
                        for rel in sorted(retire):
                            parts = rel.split("/")
                            try:
                                holder = open_parts(state.fd, parts[:-1])
                            except FileNotFoundError:
                                continue
                            try:
                                present = at(holder, parts[-1], rel) is not None
                            finally:
                                os.close(holder)
                            if present:
                                swap.aside(rel)
                        swap.merge()
                        problems = chain_problems(Tree(state.fd), archive, roots) if sqlite else []
                        if problems:
                            raise Refused("after the restore, " + "; ".join(problems))
                    except BaseException:
                        try:
                            swap.undo()
                        except BaseException:
                            log(f"Could not undo every rename; the entries the restore replaced are in {state.parent_real}/{aside_name}")
                            raise
                        log("Undid every rename: the state dir is as it was")
                        os.close(aside_fd)
                        aside_fd = None
                        if not holds_files(parent_fd, aside_name):
                            remove_tree(parent_fd, aside_name)
                        raise
                placed = [rel for rel in builder.dirs if any(rel == top or rel.startswith(top + "/") for top in swap.placed_dirs)]
                builder.set_modes(state.fd, placed)
            finally:
                if aside_fd is not None:
                    os.close(aside_fd)
            if is_empty(parent_fd, aside_name):
                os.rmdir(aside_name, dir_fd=parent_fd)
                return swap.stop_after(None)
            return swap.stop_after(f"{state.parent_real}/{aside_name}")
        finally:
            os.close(staging_fd)
            if staging_name is not None:
                remove_tree(parent_fd, staging_name)
    finally:
        os.close(parent_fd)


def build(staging_fd, archive, writes, owner):
    builder = Builder(staging_fd, owner)
    kinds = dict(writes)
    targets = dict(archive.links)
    for rel, kind in writes:
        if kind == "db":
            with open(os.path.join(archive.payload, "sqlite", rel), "rb") as source:
                builder.file(rel, source, 0o600)
        elif kind == "link":
            builder.link(rel, targets[rel])
        elif kind == "dir":
            builder.dir(rel)
    if any(kind in ("file", "dir") for kind in kinds.values()):
        with tarfile.open(os.path.join(archive.payload, "state-files.tar")) as tar:
            for member in tar:
                name = plain(member.name)
                if name in (None, ".") or kinds.get(name) not in ("file", "dir"):
                    continue
                if member.isdir():
                    builder.dir(name, member.mode)
                else:
                    builder.file(name, tar.extractfile(member), member.mode)
    return builder


def redis_target():
    url = os.environ.get("REDIS_SOURCE_URL", "")
    if not url:
        raise Refused("no Redis URL configured to restore into; set one, or pass --only sqlite,files")
    parsed = urllib.parse.urlsplit(url)
    if parsed.scheme == "rediss":
        raise Refused("cannot restore Redis keys into a TLS (rediss://) Redis; pass --only sqlite,files")
    return {
        "host": parsed.hostname or "127.0.0.1",
        "port": parsed.port or 6379,
        "db": parsed.path.strip("/") or "0",
        "user": urllib.parse.unquote(parsed.username or ""),
        "password": urllib.parse.unquote(parsed.password or ""),
    }


def run_cli(args, password=""):
    env = dict(os.environ)
    env.pop("REDISCLI_AUTH", None)
    if password:
        env["REDISCLI_AUTH"] = password
    result = subprocess.run(["redis-cli", *args], capture_output=True, text=True, env=env)
    if result.returncode != 0:
        raise Refused(f"redis-cli {args[-1] if args else ''} failed: {result.stderr.strip() or result.stdout.strip()}")
    return result.stdout


def redis_reply(stream):
    line = stream.readline()
    if not line.endswith(b"\r\n"):
        raise Refused("incomplete Redis reply")
    kind, value = line[:1], line[1:-2]
    if kind == b"+":
        return value
    if kind == b"-":
        raise Refused(value.decode("utf-8", errors="replace"))
    if kind == b":":
        return int(value)
    if kind in (b"$", b"*"):
        count = int(value)
        if count == -1:
            return None
        if count < 0:
            raise Refused("invalid Redis reply length")
        if kind == b"*":
            return [redis_reply(stream) for _ in range(count)]
        data = stream.read(count)
        if len(data) != count or stream.read(2) != b"\r\n":
            raise Refused("incomplete Redis bulk reply")
        return data
    raise Refused("unexpected Redis reply type")


@contextmanager
def redis_commands(address, db, user="", password=""):
    try:
        if isinstance(address, str):
            connection = socket.socket(socket.AF_UNIX)
        else:
            connection = socket.create_connection(address, timeout=15)
        with connection:
            if isinstance(address, str):
                connection.settimeout(15)
                connection.connect(address)
            with connection.makefile("rb") as stream:
                def command(*args):
                    fields = [arg if isinstance(arg, bytes) else str(arg).encode("utf-8") for arg in args]
                    frame = [f"*{len(fields)}\r\n".encode("ascii")]
                    for field in fields:
                        frame.extend((f"${len(field)}\r\n".encode("ascii"), field, b"\r\n"))
                    connection.sendall(b"".join(frame))
                    return redis_reply(stream)
                if user or password:
                    command("AUTH", *((user, password) if user else (password,)))
                if int(db) != 0:
                    command("SELECT", db)
                yield command
    except (OSError, ValueError) as error:
        raise Refused(f"Redis connection failed: {error}") from error


def scan_redis_keys(command, pattern):
    keys = set()
    cursor = b"0"
    while True:
        result = command("SCAN", cursor, "MATCH", pattern, "COUNT", 200)
        if not isinstance(result, list) or len(result) != 2:
            raise Refused("unexpected Redis SCAN reply")
        cursor, batch = result
        if (not isinstance(cursor, bytes) or not cursor.isdigit() or not isinstance(batch, list)
                or any(not isinstance(key, bytes) for key in batch)):
            raise Refused("unexpected Redis SCAN reply")
        keys.update(batch)
        if cursor == b"0":
            return keys


class RedisRestore:
    """The Redis step in two halves. prepare(), before the first rename:
    the live Redis answers and takes this restore's credentials, and the
    snapshot loads into a throwaway server and both key sets are read.
    migrate(), after the files: the
    matching keys are copied into the live Redis with MIGRATE COPY REPLACE,
    and the live keys in that pattern the snapshot does not have are deleted.
    The SFUs prefer a Redis key over the restored SQLite copy, so a key
    written after the backup would otherwise outlive the restore. Keys outside
    the pattern are left alone."""

    def __init__(self, work_real, archive, target, pattern):
        self.target = target
        self.pattern = pattern
        if target is not None:
            self.where = f"{target['host']}:{target['port']}"
            self.live = ["-h", target["host"], "-p", str(target["port"]), "-n", target["db"], "--no-auth-warning"]
            if target["user"]:
                self.live += ["--user", target["user"]]
        self.source_version = manifest_value(archive, "redis.version")
        self.revision = manifest_value(archive, "redis.control_plane_revision")
        self.work = os.path.join(work_real, "redis")
        self.dump = os.path.join(archive.payload, "redis", "dump.rdb")
        # The snapshot is read from the database it was taken from, and
        # written into the one the target URL names.
        self.source_db = archive.redis_db
        self.scratch = None
        self.socket = None
        self.keys = []
        self.stale = []
        self.server = None
        self.container = None
        self.server_log = None

    def prepare(self):
        env = dict(os.environ)
        env.pop("REDISCLI_AUTH", None)
        if self.target["password"]:
            env["REDISCLI_AUTH"] = self.target["password"]
        try:
            answer = subprocess.run(["redis-cli", *self.live, "PING"], capture_output=True, text=True, env=env, timeout=15)
            said = (answer.stdout + answer.stderr).strip()
        except subprocess.TimeoutExpired:
            said = "no answer in 15 s"
        if said != "PONG":
            if any(word in said for word in ("NOAUTH", "WRONGPASS", "NOPERM", "invalid password")):
                raise Refused(f"the Redis at {self.where} refused this restore ({said}); check the user and password in its URL; nothing was changed")
            raise Refused(f"cannot reach the Redis at {self.where} ({said or 'no answer'}); nothing was changed")
        self.load_snapshot()

        try:
            with redis_commands(self.socket, self.source_db) as snapshot:
                backed_up = scan_redis_keys(snapshot, self.pattern)
                self.check_revision(snapshot)
            with self.live_commands() as live:
                current = scan_redis_keys(live, self.pattern)
        except Refused as refused:
            raise Refused(f"cannot scan Redis keys for restore: {refused}; nothing was changed") from refused
        self.keys = sorted(backed_up)
        self.stale = sorted(current - backed_up)

    def load_snapshot(self):
        os.mkdir(self.work, 0o700)
        # The host's redis-server first, then the live server's version in
        # Docker: an older host package must not stop a dump it cannot read.
        loaders = [name for name, tool in (("this host's redis-server", "redis-server"), ("Docker", "docker")) if shutil.which(tool)]
        failures = []
        for loader in loaders:
            try:
                self.load(loader)
                break
            except Refused as refused:
                failures.append(f"{loader}: {refused}")
                self.stop()
        else:
            raise Refused(f"the Redis snapshot in the backup does not load ({'; '.join(failures) or 'no redis-server or Docker on this host to load it with'}); nothing was changed")

    def check_revision(self, snapshot):
        value = snapshot("GET", redis_revision_key(os.environ))
        if not isinstance(value, bytes) or not value.isdigit() or int(value) < 1:
            raise Refused("the Redis snapshot is missing the control-plane store revision")
        if self.revision is not None and value != self.revision.encode():
            raise Refused("the Redis snapshot does not contain the revision read under the write fence")

    def live_commands(self):
        target = self.target
        return redis_commands((target["host"], target["port"]), target["db"], target["user"], target["password"])

    def load(self, loader):
        self.scratch = os.path.join(self.work, "docker" if loader == "Docker" else "local")
        os.mkdir(self.scratch, 0o700)
        shutil.copyfile(self.dump, os.path.join(self.scratch, "dump.rdb"))
        self.socket = os.path.join(self.scratch, "redis.sock")
        if not str(self.source_db).isdigit():
            raise Refused(f"the backup names Redis database {self.source_db!r}, which is not a database number")
        databases = str(max(16, int(self.source_db) + 1))
        self.server_log = open(os.path.join(self.scratch, "server.log"), "w")
        if loader != "Docker":
            self.server = subprocess.Popen(
                ["redis-server", "--port", "0", "--unixsocket", self.socket, "--dir", self.scratch, "--dbfilename", "dump.rdb",
                 "--save", "", "--appendonly", "no", "--daemonize", "no", "--databases", databases],
                stdout=self.server_log, stderr=subprocess.STDOUT)
        else:
            version = re.match(r"^(\d+\.\d+)", self.source_version or "")
            if not version and self.target:
                info = run_cli(self.live + ["INFO", "server"], password=self.target["password"])
                version = re.search(r"^redis_version:(\d+\.\d+)", info, re.M)
            if not version:
                raise Refused("cannot tell the Redis version to load the snapshot with")
            self.container = f"conclave-snapshot-redis-{os.getpid()}"
            started = subprocess.run(
                ["docker", "run", "--rm", "-d", "--name", self.container, "--network", "host", "-v", f"{self.scratch}:/data",
                 f"redis:{version.group(1)}", "redis-server", "--port", "0", "--unixsocket", "/data/redis.sock",
                 "--unixsocketperm", "777", "--dir", "/data", "--dbfilename", "dump.rdb", "--save", "", "--appendonly", "no",
                 "--databases", databases],
                capture_output=True, text=True)
            if started.returncode != 0:
                raise Refused(f"docker run redis:{version.group(1)} failed: {started.stderr.strip()[-300:]}")
        for _ in range(60):
            if self.server is not None and self.server.poll() is not None:
                break
            if os.path.exists(self.socket) and subprocess.run(["redis-cli", "-s", self.socket, "PING"], capture_output=True, text=True).stdout.strip() == "PONG":
                return
            time.sleep(0.5)
        self.server_log.flush()
        with open(os.path.join(self.scratch, "server.log"), encoding="utf-8", errors="replace") as handle:
            tail = " ".join(handle.read().split())[-600:]
        raise Refused(tail or "the scratch server never answered")

    def migrate(self):
        target = self.target
        auth = ["AUTH2", target["user"], target["password"]] if target["user"] else (["AUTH", target["password"]] if target["password"] else [])
        host = "127.0.0.1" if target["host"] == "localhost" else target["host"]
        if self.keys:
            with redis_commands(self.socket, self.source_db) as snapshot:
                for i in range(0, len(self.keys), 200):
                    reply = snapshot("MIGRATE", host, target["port"], b"", target["db"], "10000",
                                     "COPY", "REPLACE", *auth, "KEYS", *self.keys[i:i + 200])
                    if reply != b"OK":
                        raise Refused(f"MIGRATE into {host}:{target['port']} failed: {reply!r}")
        log(f"Restored {len(self.keys)} Redis keys matching {self.pattern}")
        if self.stale:
            with self.live_commands() as live:
                for i in range(0, len(self.stale), 200):
                    reply = live("DEL", *self.stale[i:i + 200])
                    if not isinstance(reply, int):
                        raise Refused(f"deleting keys the backup does not have failed: {reply!r}")
        log(f"Deleted {len(self.stale)} Redis keys matching {self.pattern} that the backup does not have")
        subprocess.run(["redis-cli", "-s", self.socket, "SHUTDOWN", "NOSAVE"], capture_output=True)

    def stop(self):
        if self.server is not None and self.server.poll() is None:
            self.server.terminate()
            self.server.wait(10)
        if self.container is not None:
            subprocess.run(["docker", "rm", "-f", self.container], capture_output=True)
        if self.server_log is not None:
            self.server_log.close()
        self.server = self.container = self.server_log = None


def coverage_problems(archive, state, container):
    """Every store's database (by its precedence, from the host config and
    each SFU container's env) must be in the archive, or that store would
    come back empty while the others are restored."""
    covered = {start for start, _ in archive.chains} | set(archive.databases)
    stores = configured_stores(state, container, state_mounts(docker_containers(), state), "sqlite")
    return [f"the backup has no copy of {store['rel']}, the database {store['variable']} ({store['where']}) names, so that store would come back empty"
            for store in stores if store["rel"] not in covered]


def manifest_value(archive, key):
    prefix = key + "="
    with open(os.path.join(archive.payload, "MANIFEST"), encoding="utf-8") as manifest:
        recorded = [line[len(prefix):].rstrip("\n") for line in manifest if line.startswith(prefix)]
    return recorded[0] if len(recorded) == 1 and recorded[0] else None


def require_redis_pattern(archive, pattern):
    recorded = manifest_value(archive, "redis.pattern")
    if not recorded:
        raise Refused("the backup does not record exactly one Redis key pattern; nothing was changed")
    if recorded != pattern:
        raise Refused(f"the backup's Redis key pattern {recorded!r} does not match the requested pattern {pattern!r}; use a backup for the configured prefix or leave Redis out; nothing was changed")
    if pattern not in ("*", redis_key_pattern(os.environ)):
        raise Refused("the Redis key pattern does not cover the entire control-plane namespace; nothing was changed")


def validate_redis_snapshot(archive):
    snapshot = RedisRestore(os.path.dirname(archive.payload), archive, target=None, pattern=None)
    try:
        snapshot.load_snapshot()
        with redis_commands(snapshot.socket, snapshot.source_db) as command:
            snapshot.check_revision(command)
    finally:
        snapshot.stop()


def parse_owner(value):
    if not value:
        return None
    match = re.fullmatch(r"(\d+):(\d+)", value)
    if not match:
        raise Refused(f"--owner must be numeric uid:gid, not {value}")
    return int(match.group(1)), int(match.group(2))


def restore(args):
    wants = [part for part in args.only.split(",") if part]
    unknown = [part for part in wants if part not in PARTS]
    if unknown or not wants:
        raise Refused(f"--only takes sqlite, redis and files, not {args.only}")
    roots = mount_roots(args.state, args.container)
    work_fd, work_real = check_work(args.work, args.state)
    try:
        os.mkdir("payload", 0o700, dir_fd=work_fd)
        payload_fd = open_dir(work_fd, "payload", "payload")
    finally:
        os.close(work_fd)
    try:
        extract_archive(args.archive, payload_fd, os.path.join(work_real, "payload"))
    finally:
        os.close(payload_fd)
    archive = Archive(os.path.join(work_real, "payload"))
    problems = archive_problems(archive)
    if not problems:
        problems = chain_problems(overlay(None, archive, restore_writes(archive)), archive, roots)
    if problems:
        raise Refused("\n".join(problems + ["the archive is not one this restore can apply; nothing was changed"]))
    check_copies(archive)
    print("Archive verified. Manifest:")
    with open(os.path.join(archive.payload, "MANIFEST"), encoding="utf-8", errors="replace") as handle:
        for line in handle:
            print(f"  {line.rstrip()}")

    # Everything the restore needs is settled here or before the first rename
    # below: what a store opens that the archive lacks, and whether Redis can
    # take the snapshot, refuse before anything changes.
    sqlite = "sqlite" in wants
    if sqlite:
        missing = coverage_problems(archive, args.state, args.container)
        if missing:
            raise Refused("\n".join(missing + ["use a backup that has it, or leave SQLite out with --only redis,files (or --only files); nothing was changed"]))
    if "files" in wants:
        missing = json_coverage_problems(archive, args.state, args.container)
        if missing:
            raise Refused("\n".join(missing + ["use a backup that has the configured JSON files or leave files out; nothing was changed"]))
    redis = None
    redis_pattern = os.environ.get("REDIS_KEY_PATTERN", "conclave:sfu:persistence:*")
    if "redis" in wants:
        if os.environ.get("REDIS_SOURCE_URL") and not archive.has_redis:
            raise Refused("Redis is configured (REDIS_SOURCE_URL) but this backup has no Redis snapshot, so the persistence keys written since it was taken would outlive the restore and shadow the restored databases; pass --only sqlite,files to leave Redis out; nothing was changed")
        if archive.has_redis:
            require_redis_pattern(archive, redis_pattern)
            redis = redis_target()
    writes = restore_writes(archive, sqlite, "files" in wants)
    retire = side_files(database_files(archive)) if sqlite else set()
    state = StateDir(args.state)
    redis_step = None
    try:
        if "files" in wants:
            retire.update(live_imports_to_retire(state, fallback_import_dirs(args.state, args.container), writes))
        problems = state.live_problems(writes, retire)
        if sqlite and not problems:
            problems = chain_problems(overlay(state.fd, archive, writes), archive, roots)
        if problems:
            raise Refused("\n".join(problems + [f"the restore would write outside {args.state} or through a link; nothing was changed"]))
        if not args.apply:
            print("")
            print(f"Dry run: nothing changed. Rerun with --yes to restore {args.only} into {args.state}.")
            return
        refuse_live_sfus(state, archive)
        owner = parse_owner(args.owner)
        if redis:
            redis_step = RedisRestore(work_real, archive, redis, redis_pattern)
            redis_step.prepare()
        if writes or retire:
            aside = apply_restore(state, archive, writes, retire, roots, args.stamp, owner, sqlite)
            for rel, kind in writes:
                if kind == "db":
                    log(f"Restored {args.state}/{rel}")
                elif kind == "link":
                    log(f"Restored the link {args.state}/{rel} -> {dict(archive.links)[rel]}")
            if "files" in wants:
                log(f"Restored the other files in {args.state}")
            if aside:
                log(f"The entries the restore replaced are kept in {aside}")
            if owner:
                log(f"Gave the restored files in {args.state} to {owner[0]}:{owner[1]}, the user the SFU runs as")
        if redis_step:
            try:
                redis_step.migrate()
            except Refused as refused:
                raise Refused(f"the files are restored, but the Redis step failed after its checks passed: {refused}; rerun with --only redis once that is fixed")
    finally:
        if state.fd is not None:
            os.close(state.fd)
        if redis_step:
            redis_step.stop()
    print("")
    print("Restore applied. Start the SFUs again (docker compose -f docker-compose.sfu.yml up -d sfu-a sfu-b)")
    print("and check that the scheduled meetings and webinars are back.")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--archive", required=True)
    parser.add_argument("--work", required=True)
    parser.add_argument("--state", required=True)
    parser.add_argument("--container", required=True)
    parser.add_argument("--only", default="sqlite,redis,files")
    parser.add_argument("--apply", action="store_true")
    parser.add_argument("--stamp", default=time.strftime("%Y%m%dT%H%M%SZ", time.gmtime()))
    parser.add_argument("--owner", default="")
    args = parser.parse_args()
    try:
        restore(args)
    except Refused as refused:
        print(f"error: {refused}", file=sys.stderr)
        return 1
    except sqlite3.Error as error:
        print(f"error: SQLite: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
