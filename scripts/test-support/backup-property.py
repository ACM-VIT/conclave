"""Property check for backup and restore over random small state dirs.

  python3 backup-property.py WORK_DIR SEED COUNT

Each tree mixes directories, files, SQLite databases and links (relative,
absolute through the containers' mount path, through the state dir's own
path and its real path, ".." steps, links that leave the state dir, links
that dangle), sometimes with the state dir named through a link and
sometimes with the containers' mount path overlapping it. Every database
holds one row naming it.

For each tree, the real backup steps run (plan, SQLite copies, pack,
validate, seal) and the real restore runs twice: into an empty state dir,
and over the original. Each one either refuses or reproduces, for every path
the SFU would open (the configured one and every *.sqlite entry), exactly the
database it opened at backup time, read back by the kernel through the
restored links. Nothing outside the state dir may change, and the outside dir
holds databases a crafted link would love to reach.

The oracle for "what the SFU opens" is the kernel itself wherever it can
see what the container sees: the containers' mount path is a link to the
state dir, so an absolute link naming it resolves on this host as it does
in the container. Where the mount path overlaps the state dir, the container
view differs from the host's, and the backup's own resolution (container
first) is what the restore must reproduce.
"""
import argparse
import hashlib
import io
import os
import random
import shutil
import sqlite3
import stat
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
# Root runs these from the checkout; no bytecode is left beside them.
sys.dont_write_bytecode = True
sys.path.insert(0, os.path.join(HERE, "..", "backup"))

import backup_state  # noqa: E402
import restore_state  # noqa: E402
import statelib  # noqa: E402

NAMES = ["a", "b", "data", "conclave.sqlite", "x.sqlite", "live.db", "notes.json"]


def no_containers():
    return []


backup_state.docker_containers = no_containers
restore_state.docker_containers = no_containers
restore_state.holders = lambda path: []


def make_db(path, ident):
    connection = sqlite3.connect(path)
    connection.execute("CREATE TABLE who (id TEXT)")
    connection.execute("INSERT INTO who VALUES (?)", (ident,))
    connection.commit()
    connection.close()


def read_db(path):
    try:
        connection = sqlite3.connect(f"file:{path}?mode=ro", uri=True)
        try:
            return connection.execute("SELECT id FROM who").fetchone()[0]
        finally:
            connection.close()
    except sqlite3.Error:
        return None


def snapshot(root):
    seen = {}
    for base, dirs, files in os.walk(root):
        for name in dirs + files:
            full = os.path.join(base, name)
            info = os.lstat(full)
            rel = os.path.relpath(full, root)
            if stat.S_ISLNK(info.st_mode):
                seen[rel] = ("link", os.readlink(full))
            elif stat.S_ISREG(info.st_mode):
                with open(full, "rb") as handle:
                    seen[rel] = ("file", info.st_mode & 0o7777, hashlib.sha256(handle.read()).hexdigest())
            else:
                seen[rel] = ("dir", info.st_mode & 0o7777)
    return seen


class Tree:
    def __init__(self, rng, base):
        self.rng = rng
        self.base = base
        self.real_state = os.path.join(base, "real-state")
        self.outside = os.path.join(base, "outside")
        os.makedirs(self.real_state)
        os.makedirs(os.path.join(self.outside, "data"))
        make_db(os.path.join(self.outside, "conclave.sqlite"), "outside-1")
        make_db(os.path.join(self.outside, "data", "live.db"), "outside-2")
        self.state = self.real_state
        if rng.random() < 0.3:
            self.state = os.path.join(base, "state-link")
            os.symlink(self.real_state, self.state)
        self.overlap = rng.random() < 0.2
        if self.overlap:
            inner = self.rng.choice(["a", "data"])
            os.makedirs(os.path.join(self.real_state, inner), exist_ok=True)
            self.container = os.path.join(self.real_state, inner)
        else:
            self.container = os.path.join(base, "container-root")
            os.symlink(self.real_state, self.container)
        self.count = 0
        self.dbs = []
        self.fill("", 0)
        self.configured = self.rng.choice(["conclave.sqlite", "data/live.db", "a/x.sqlite", "live.db"])
        # Most trees hold the configured database, so most backups go ahead.
        full = os.path.join(self.real_state, self.configured)
        parent = os.path.dirname(full)
        if not os.path.lexists(full) and os.path.isdir(parent) and not os.path.islink(parent) and rng.random() < 0.8:
            self.count += 1
            make_db(full, f"db-{self.count}")

    def random_path(self):
        parts = [self.rng.choice(NAMES + ["..", "."]) for _ in range(self.rng.randint(1, 3))]
        return "/".join(parts)

    def link_target(self, rel):
        roll = self.rng.random()
        if self.dbs and rel.endswith(".sqlite") and self.rng.random() < 0.6:
            # Mostly a database link that works, written any of the ways an
            # operator might: relative with ".." steps, or absolute.
            target = self.rng.choice(self.dbs)
            depth = rel.count("/")
            return self.rng.choice([
                "/".join([".."] * depth + [target]),
                f"{self.container}/{target}",
                f"{self.state}/{target}",
                f"{self.real_state}/{target}",
            ])
        if roll < 0.35:
            return self.random_path()
        if roll < 0.55:
            return f"{self.container}/{self.random_path()}"
        if roll < 0.65:
            return f"{self.state}/{self.random_path()}"
        if roll < 0.75:
            return f"{self.real_state}/{self.random_path()}"
        if roll < 0.9:
            return f"{self.outside}/{self.rng.choice(['conclave.sqlite', 'data', 'data/live.db'])}"
        return "missing/" + self.rng.choice(NAMES)

    def fill(self, rel_dir, depth):
        for _ in range(self.rng.randint(1, 4)):
            name = self.rng.choice(NAMES)
            rel = f"{rel_dir}/{name}" if rel_dir else name
            full = os.path.join(self.real_state, rel)
            if os.path.lexists(full):
                continue
            roll = self.rng.random()
            if roll < 0.25 and depth < 2:
                os.mkdir(full)
                self.fill(rel, depth + 1)
            elif roll < 0.5 or (roll >= 0.85 and name.endswith(".sqlite")):
                self.count += 1
                make_db(full, f"db-{self.count}")
                self.dbs.append(rel)
            elif roll < 0.85:
                os.symlink(self.link_target(rel), full)
            else:
                with open(full, "w") as handle:
                    handle.write(f"file {rel}")


def starts_of(tree):
    found = set()
    for base, dirs, files in os.walk(tree.real_state):
        for name in dirs + files:
            if name.endswith(".sqlite"):
                full = os.path.join(base, name)
                info = os.lstat(full)
                if stat.S_ISREG(info.st_mode) or stat.S_ISLNK(info.st_mode):
                    found.add(os.path.relpath(full, tree.real_state))
    found.add(tree.configured)
    return sorted(found)


def mutate(rng, tree):
    """What can happen to the live state dir between the backup and the
    restore: a directory or a database swapped for a link that leads out,
    or a pivot link added where the archive's paths go."""
    entries = []
    for base, dirs, files in os.walk(tree.real_state):
        for name in dirs + files:
            entries.append(os.path.relpath(os.path.join(base, name), tree.real_state))
    victim = rng.choice(entries) if entries else "pivot"
    full = os.path.join(tree.real_state, victim)
    if os.path.lexists(full):
        os.rename(full, full + ".moved")
    os.symlink(rng.choice([os.path.join(tree.outside, "data"), os.path.join(tree.outside, "conclave.sqlite"), tree.outside]), full)


def run_backup(tree, payload, archive):
    os.makedirs(os.path.join(payload, "sqlite"))
    with open(os.path.join(payload, "MANIFEST"), "w") as handle:
        handle.write("created_at=property\n")
    os.environ["CONCLAVE_SQLITE_PATH"] = f"{tree.container}/{tree.configured}"
    for variable in statelib.STORE_VARIABLES:
        os.environ.pop(variable, None)
    backup_state.copy_command(tree.state, tree.container, payload)
    backup_state.pack_command(tree.state, payload)
    if backup_state.validate_command(tree.state, tree.container, payload) != 0:
        raise statelib.Refused("validate refused the payload")
    stdout = sys.stdout
    with open(archive, "wb") as out:
        sys.stdout = io.TextIOWrapper(out)
        try:
            backup_state.seal_command(payload)
            sys.stdout.flush()
        finally:
            sys.stdout.detach()
            sys.stdout = stdout


def run_restore(archive, work, state, container, stamp):
    if os.path.exists(work):
        shutil.rmtree(work)
    os.mkdir(work, 0o700)
    args = argparse.Namespace(archive=archive, work=work, state=state, container=container, only="sqlite,files",
                              apply=True, stamp=stamp, owner="")
    restore_state.restore(args)


def check_tree(seed, index, root):
    rng = random.Random(f"{seed}-{index}")
    base = os.path.join(root, f"tree-{index}")
    os.makedirs(base)
    tree = Tree(rng, base)
    starts = starts_of(tree)
    opened = {}
    state_fd = os.open(tree.real_state, statelib.DIR_FLAGS)
    for start in starts:
        try:
            _, reached = statelib.resolve(statelib.Tree(state_fd), start, statelib.mount_roots(tree.state, tree.container))
            opened[start] = read_db(os.path.join(tree.real_state, reached))
        except (statelib.Unresolved, statelib.Refused):
            opened[start] = None
        if not tree.overlap and opened[start] is not None:
            # Where the host sees what the container sees, the kernel agrees.
            assert read_db(os.path.join(tree.real_state, start)) == opened[start], (seed, index, start, "resolver and kernel disagree")
    os.close(state_fd)
    outside_before = snapshot(tree.outside)
    payload = os.path.join(base, "payload")
    archive = os.path.join(base, "archive.tar.gz")
    outcome = []
    with open(os.devnull, "w") as quiet:
        stdout = sys.stdout
        sys.stdout = quiet
        try:
            run_backup(tree, payload, archive)
        except (statelib.Refused, sqlite3.Error):
            sys.stdout = stdout
            assert snapshot(tree.outside) == outside_before, (seed, index, "the backup changed the outside dir")
            return "backup refused"
        finally:
            sys.stdout = stdout
    archived = statelib.Archive(payload)
    chains = dict(archived.chains)
    if rng.random() < 0.5:
        mutate(rng, tree)
    for target_name, state_dir in (("empty", os.path.join(base, "restored", "state")), ("live", tree.state)):
        with open(os.devnull, "w") as quiet:
            stdout = sys.stdout
            sys.stdout = quiet
            try:
                run_restore(archive, os.path.join(base, f"work-{target_name}"), state_dir, tree.container if target_name == "live" else os.path.join(base, "restored", "container"), f"20260101T00000{len(outcome)}Z")
                result = "restored"
            except (statelib.Refused, sqlite3.Error):
                result = "refused"
            finally:
                sys.stdout = stdout
        assert snapshot(tree.outside) == outside_before, (seed, index, target_name, "the restore changed the outside dir")
        if result == "restored":
            for rel in archived.databases:
                assert read_db(os.path.join(state_dir, rel)) == read_db(os.path.join(payload, "sqlite", rel)), (seed, index, target_name, rel)
            for start, reached in chains.items():
                got = read_db(os.path.join(state_dir, start))
                assert got == opened.get(start, read_db(os.path.join(payload, "sqlite", reached))), (seed, index, target_name, start, got, opened.get(start))
                assert got == read_db(os.path.join(payload, "sqlite", reached)), (seed, index, target_name, start)
        outcome.append(f"{target_name} {result}")
    return ", ".join(outcome)


def main():
    root, seed, count = os.path.abspath(sys.argv[1]), sys.argv[2], int(sys.argv[3])
    tally = {}
    for index in range(count):
        outcome = check_tree(seed, index, root)
        tally[outcome] = tally.get(outcome, 0) + 1
    for outcome, n in sorted(tally.items()):
        print(f"{n:4d}  {outcome}")
    restored = sum(n for outcome, n in tally.items() if "restored" in outcome)
    if restored == 0:
        sys.exit("no tree restored at all, so the property says nothing")


if __name__ == "__main__":
    main()
