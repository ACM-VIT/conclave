#!/usr/bin/env python3
"""The host's SFU deploy lock file, for deploy-sfu.sh, backup.sh and
restore.sh, so all three hold one lock under the same rules.

  host_lock.py prepare PATH   creates the lock when it is missing: a regular
                              file, mode 0640, group docker where that group
                              exists (every user who deploys is in it)
  host_lock.py check FD PATH  the lock held on FD is the file PATH names now,
                              a regular file and no link, owned by root, this
                              user or a member of the docker group, and no
                              other user can open it

A lock any user can open is one any user can hold, stopping every deploy and
backup, so a lock with other-user or group-write bits is narrowed to 0640 by
its owner or root, and refused by anyone else. It lives in /run/lock, where
any user may create files, so a lock someone else made first is refused
rather than trusted.
"""
import errno
import grp
import os
import pwd
import stat
import sys

MODE = 0o640


def docker_group():
    try:
        return grp.getgrnam(os.environ.get("SFU_DEPLOY_LOCK_GROUP") or "docker")
    except KeyError:
        return None


def trusted(uid):
    if uid in (0, os.geteuid()):
        return True
    group = docker_group()
    if group is None:
        return False
    try:
        user = pwd.getpwuid(uid)
    except KeyError:
        return False
    return user.pw_gid == group.gr_gid or user.pw_name in group.gr_mem


def prepare(path):
    try:
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC, MODE)
    except FileExistsError:
        return
    try:
        group = docker_group()
        if group is not None:
            try:
                os.fchown(fd, -1, group.gr_gid)
            except PermissionError:
                pass
        os.fchmod(fd, MODE)
    finally:
        os.close(fd)


def check(fd, path):
    held = os.fstat(fd)
    try:
        named = os.lstat(path)
    except FileNotFoundError:
        named = None
    if named is not None and stat.S_ISLNK(named.st_mode) or not stat.S_ISREG(held.st_mode):
        sys.exit(f"{path} is a link or not a regular file, so it cannot be the host's deploy lock; remove it and rerun")
    if named is None or (held.st_dev, held.st_ino) != (named.st_dev, named.st_ino):
        sys.exit(f"{path} was replaced while this run waited for it; rerun it")
    if not trusted(held.st_uid):
        sys.exit(f"{path} belongs to uid {held.st_uid}, who is neither root, this user nor in the docker group, so it could be replaced or held by them; remove it and rerun")
    group = docker_group()
    if group is not None and held.st_gid != group.gr_gid:
        try:
            os.fchown(fd, -1, group.gr_gid)
        except PermissionError:
            pass
    if held.st_mode & 0o027:
        try:
            os.fchmod(fd, MODE)
        except OSError as error:
            if error.errno not in (errno.EPERM, errno.EACCES):
                raise
            sys.exit(f"{path} can be opened by every user, so any of them could hold it and stop deploys and backups; its owner or root must chmod 0640 it")


def main(argv):
    if argv[1:2] == ["prepare"] and len(argv) == 3:
        prepare(argv[2])
    elif argv[1:2] == ["check"] and len(argv) == 4:
        check(int(argv[2]), argv[3])
    else:
        sys.exit("usage: host_lock.py prepare PATH | check FD PATH")


if __name__ == "__main__":
    main(sys.argv)
