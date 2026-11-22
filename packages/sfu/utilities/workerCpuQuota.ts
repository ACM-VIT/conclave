import { readFileSync } from "node:fs";
import { availableParallelism, totalmem } from "node:os";
import { posix } from "node:path";

const read = (file: string): string => {
  try {
    return readFileSync(file, "utf8");
  } catch {
    return "";
  }
};

const cpuRatio = (quota: string, period: string): number => {
  const limit = Number(quota);
  const interval = Number(period);
  return Number.isFinite(limit) && limit > 0 &&
    Number.isFinite(interval) && interval > 0
    ? limit / interval
    : Infinity;
};

const cgroupDirectories = (root: string, group: string): string[] => {
  const directories = [];
  let current = posix.resolve("/", group);
  while (current !== "/") {
    directories.push(posix.join(root, current));
    current = posix.dirname(current);
  }
  directories.push(root);
  return directories;
};

const cgroupsOf = (legacyController: string): { unifiedGroup: string; legacyGroup: string } => {
  let unifiedGroup = "/";
  let legacyGroup = "/";
  for (const line of read("/proc/self/cgroup").split("\n")) {
    const match = line.match(/^\d+:([^:]*):(\/.*)$/);
    if (!match) continue;
    const [, controllers, group] = match;
    if (controllers === "") unifiedGroup = group;
    if (controllers.split(",").includes(legacyController)) legacyGroup = group;
  }
  return { unifiedGroup, legacyGroup };
};

const byteLimit = (value: string): number => {
  const bytes = Number(value.trim());
  return Number.isFinite(bytes) && bytes > 0 ? bytes : Infinity;
};

export const getMemoryLimitBytes = (): number => {
  const { unifiedGroup, legacyGroup } = cgroupsOf("memory");
  const unified = cgroupDirectories("/sys/fs/cgroup", unifiedGroup).map((directory) =>
    byteLimit(read(`${directory}/memory.max`)),
  );
  const legacy = cgroupDirectories("/sys/fs/cgroup/memory", legacyGroup).map((directory) =>
    byteLimit(read(`${directory}/memory.limit_in_bytes`)),
  );
  return Math.min(totalmem(), ...unified, ...legacy);
};

export const getWorkerCpuQuota = (): number => {
  const { unifiedGroup, legacyGroup: legacyCpuGroup } = cgroupsOf("cpu");

  // A cgroup can be throttled by its parent even when its own quota is unlimited.
  const unified = cgroupDirectories("/sys/fs/cgroup", unifiedGroup).map((directory) => {
    const [quota = "", period = ""] = read(`${directory}/cpu.max`).trim().split(/\s+/);
    return cpuRatio(quota, period);
  });
  const legacy = ["cpu", "cpu,cpuacct"].flatMap((mount) =>
    cgroupDirectories(`/sys/fs/cgroup/${mount}`, legacyCpuGroup).map((directory) =>
      cpuRatio(read(`${directory}/cpu.cfs_quota_us`), read(`${directory}/cpu.cfs_period_us`)),
    ),
  );
  return Math.min(...unified, ...legacy);
};

export const instanceCpuCount = (hostInstanceCount: number): number =>
  Math.max(1, Math.floor(Math.min(availableParallelism(), getWorkerCpuQuota()) / hostInstanceCount));
