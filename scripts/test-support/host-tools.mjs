import { execFileSync } from "node:child_process";
import { chmod, mkdir, readdir, symlink, writeFile } from "node:fs/promises";
import path from "node:path";

// flock(1) for hosts without util-linux, such as macOS. Python's fcntl.flock
// takes the same kernel lock on the descriptor the shell hands down, so a
// test locks the way the VM does. Only the forms the scripts use:
// flock [-n] [-w SECONDS] FD.
const flockStandIn = `#!/usr/bin/env python3
import fcntl, sys, time
args, fd, nonblock, wait = sys.argv[1:], None, False, None
i = 0
while i < len(args):
    if args[i] in ("-n", "--nonblock"):
        nonblock = True
    elif args[i] in ("-w", "--timeout"):
        wait = float(args[i + 1])
        i += 1
    elif args[i].isdigit():
        fd = int(args[i])
    else:
        sys.exit("flock stand-in: unsupported argument " + args[i])
    i += 1
if fd is None:
    sys.exit("flock stand-in: needs a file descriptor")
deadline = None if wait is None else time.monotonic() + wait
while True:
    try:
        fcntl.flock(fd, fcntl.LOCK_EX | (fcntl.LOCK_NB if nonblock or deadline is not None else 0))
        break
    except BlockingIOError:
        if deadline is None or time.monotonic() >= deadline:
            sys.exit(1)
        time.sleep(0.05)
    except OSError:
        sys.exit(1)
`;

export const hasHostTool = (name) => {
  try {
    execFileSync("sh", ["-c", `command -v ${name}`], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
};

// Puts flock in bin when the host has none.
export const provideFlock = async (bin) => {
  if (hasHostTool("flock")) return;
  await writeFile(path.join(bin, "flock"), flockStandIn);
  await chmod(path.join(bin, "flock"), 0o755);
};

// A PATH directory holding every command on this PATH except the named ones,
// so a test can run a script on a host that lacks them.
export const pathWithout = async (dir, names) => {
  await mkdir(dir, { recursive: true });
  const linked = new Set(names);
  for (const entry of (process.env.PATH ?? "").split(path.delimiter)) {
    let files;
    try {
      files = await readdir(entry);
    } catch {
      continue;
    }
    for (const file of files) {
      if (linked.has(file)) continue;
      linked.add(file);
      await symlink(path.join(entry, file), path.join(dir, file));
    }
  }
  return dir;
};
