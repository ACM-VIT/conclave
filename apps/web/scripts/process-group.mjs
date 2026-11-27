import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";

/**
 * Whether a process group still has a member that has not exited. A zombie
 * (state Z) has exited; in a container with no init to reap it, it would
 * otherwise keep the group looking alive forever.
 */
export const hasLiveMembers = (groupId, processes) =>
  processes.some((process) => process.pgid === groupId && !process.state.startsWith("Z"));

// Linux: /proc/<pid>/stat is "pid (comm) state ppid pgrp ...", and comm may
// hold spaces or parentheses, so the fields are read after the last ")".
const readProcProcesses = () =>
  readdirSync("/proc")
    .filter((name) => /^\d+$/.test(name))
    .flatMap((pid) => {
      try {
        const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
        const [state, , pgid] = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
        return [{ pgid: Number(pgid), state }];
      } catch {
        return [];
      }
    });

// macOS has no /proc, but always has ps.
const readPsProcesses = () =>
  execFileSync("ps", ["-A", "-o", "pgid=,stat="], { encoding: "utf8" })
    .split("\n")
    .map((line) => line.trim().split(/\s+/))
    .filter(([pgid, state]) => pgid && state)
    .map(([pgid, state]) => ({ pgid: Number(pgid), state }));

const listProcesses = () => (existsSync("/proc/self/stat") ? readProcProcesses() : readPsProcesses());

export const groupAlive = (groupId) => {
  try {
    process.kill(-groupId, 0);
  } catch (error) {
    if (error.code !== "EPERM") return false;
  }
  try {
    return hasLiveMembers(groupId, listProcesses());
  } catch {
    return true;
  }
};

export const signalGroup = (groupId, signal) => {
  try {
    process.kill(-groupId, signal);
  } catch {
  }
};
