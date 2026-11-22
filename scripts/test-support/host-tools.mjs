import { execFileSync } from "node:child_process";
import { chmod, mkdir, readdir, symlink, writeFile } from "node:fs/promises";
import path from "node:path";

// flock(1) for hosts without util-linux, such as macOS. Python's fcntl.flock
// takes the same kernel lock on the descriptor the shell hands down, so a
// test locks the way the VM does. Only the forms the scripts use: flock [-n] FD.
const flockStandIn = `#!/usr/bin/env python3
import fcntl, sys
flags, fd = fcntl.LOCK_EX, None
for arg in sys.argv[1:]:
    if arg in ("-n", "--nonblock"):
        flags |= fcntl.LOCK_NB
    elif arg.isdigit():
        fd = int(arg)
    else:
        sys.exit("flock stand-in: unsupported argument " + arg)
if fd is None:
    sys.exit("flock stand-in: needs a file descriptor")
try:
    fcntl.flock(fd, flags)
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
