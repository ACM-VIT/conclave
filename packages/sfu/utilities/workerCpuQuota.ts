import { readFileSync } from "node:fs";
import { availableParallelism } from "node:os";
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

export const getWorkerCpuQuota = (): number => {
  const groups = read("/proc/self/cgroup").split("\n");
  let unifiedGroup = "/";
  let legacyCpuGroup = "/";
  for (const line of groups) {
    const match = line.match(/^\d+:([^:]*):(\/.*)$/);
    if (!match) continue;
    const [, controllers, group] = match;
    if (controllers === "") unifiedGroup = group;
    if (controllers.split(",").includes("cpu")) legacyCpuGroup = group;
  }

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

export const resolveAppDocumentWorkerCount = ({
  appDocumentWorkerCount,
  hostInstanceCount,
  workerCount,
}: {
  appDocumentWorkerCount: number;
  hostInstanceCount: number;
  workerCount: number | undefined;
}): number => {
  const cpus = instanceCpuCount(hostInstanceCount);
  const mediasoupWorkers = workerCount ?? 1;
  const allowed = Math.max(1, cpus - mediasoupWorkers);
  if (appDocumentWorkerCount > allowed) {
    throw new Error(
      `SFU_APP_DOC_WORKERS=${appDocumentWorkerCount} leaves no CPU for ${mediasoupWorkers} mediasoup worker(s) in this instance's share of ${cpus} CPU(s); use at most ${allowed}`,
    );
  }
  return appDocumentWorkerCount;
};
