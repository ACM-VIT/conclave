import { EventEmitter } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { readFileSync } from "node:fs";
import { availableParallelism } from "node:os";
import { createWorker } from "mediasoup";
import type { WebRtcServer, Worker } from "mediasoup/types";
import { expect, it, vi } from "vitest";
import { config } from "../config/config.js";
import createWorkers, { getWorkerWebRtcServer } from "../utilities/createWorkers.js";

vi.mock("mediasoup", () => ({ createWorker: vi.fn() }));
vi.mock("node:fs", () => ({ readFileSync: vi.fn() }));
vi.mock("node:os", () => {
  const availableParallelism = vi.fn(() => 8);
  return { availableParallelism, default: { availableParallelism } };
});
vi.mock("../config/config.js", () => ({
  config: {
    workerSettings: { workerCount: 1, hostInstanceCount: 1, rtcMinPort: 42001, rtcMaxPort: 42200 },
    webRtcTransport: { enableUdp: true, enableTcp: true, listenIps: [{ ip: "127.0.0.1" }] },
  },
}));

const makeWorker = () => Object.assign(new EventEmitter(), {
  createWebRtcServer: vi.fn<Worker["createWebRtcServer"]>(),
  close: vi.fn(),
});

it.each([
  { name: "affinity shared by two instances", affinity: 8, files: {}, instances: 2, override: 0, expected: 4 },
  { name: "2-vCPU host shared by three instances", affinity: 2, files: {}, instances: 3, override: 0, expected: 1 },
  {
    name: "nested cgroup quota shared by two instances",
    affinity: 8,
    files: { "/proc/self/cgroup": "0::/sfu/current", "/sys/fs/cgroup/sfu/cpu.max": "350000 100000" },
    instances: 2, override: 0, expected: 1,
  },
  {
    name: "legacy CPU quota",
    affinity: 8,
    files: { "/sys/fs/cgroup/cpu/cpu.cfs_quota_us": "250000", "/sys/fs/cgroup/cpu/cpu.cfs_period_us": "100000" },
    instances: 1, override: 0, expected: 2,
  },
  {
    name: "explicit worker count",
    affinity: 8,
    files: { "/sys/fs/cgroup/cpu.max": "75000 100000" },
    instances: 3, override: 3, expected: 3,
  },
])("chooses the worker count for $name", async ({ affinity, files, instances, override, expected }) => {
  const settings = config.workerSettings;
  const oldCount = settings.workerCount;
  const oldInstances = settings.hostInstanceCount;
  settings.workerCount = override;
  settings.hostInstanceCount = instances;
  vi.mocked(availableParallelism).mockReturnValue(affinity);
  const contents: Readonly<Record<string, string | undefined>> = files;
  vi.mocked(readFileSync).mockImplementation((path) => {
    const file = contents[String(path)];
    if (file === undefined) throw new Error("missing test fixture");
    return file;
  });
  vi.mocked(createWorker).mockImplementation(async () => {
    const worker = makeWorker();
    worker.createWebRtcServer.mockResolvedValue({} as WebRtcServer);
    return worker as unknown as Worker;
  });
  try {
    expect(await createWorkers()).toHaveLength(expected);
  } finally {
    settings.workerCount = oldCount;
    settings.hostInstanceCount = oldInstances;
    vi.mocked(createWorker).mockReset();
    vi.mocked(readFileSync).mockReset();
  }
});

it("reserves the first port in the staging range and leaves the rest for plain RTP", async () => {
  const worker = makeWorker();
  worker.createWebRtcServer.mockResolvedValue({} as WebRtcServer);
  vi.mocked(createWorker).mockClear().mockResolvedValueOnce(worker as unknown as Worker);
  await createWorkers();
  expect(worker.createWebRtcServer).toHaveBeenCalledWith({
    listenInfos: [
      expect.objectContaining({ protocol: "udp", port: 42001 }),
      expect.objectContaining({ protocol: "tcp", port: 42001 }),
    ],
  });
  expect(createWorker).toHaveBeenCalledWith(expect.objectContaining({
    rtcMinPort: 42002,
    rtcMaxPort: 42200,
  }));
});

it("rejects a range that leaves no port for plain RTP", async () => {
  const settings = config.workerSettings;
  const originalMax = settings.rtcMaxPort;
  vi.mocked(createWorker).mockClear();
  settings.rtcMaxPort = settings.rtcMinPort;
  try {
    await expect(createWorkers()).rejects.toThrow("plain RTP");
    expect(createWorker).not.toHaveBeenCalled();
  } finally {
    settings.rtcMaxPort = originalMax;
  }
});

it("restores the worker slot on the same WebRTC port after a transient bind failure", async () => {
  const original = makeWorker();
  const failed = makeWorker();
  const replacement = makeWorker();
  const server = {} as WebRtcServer;
  original.createWebRtcServer.mockResolvedValue({} as WebRtcServer);
  failed.createWebRtcServer.mockRejectedValue(new Error("address already in use"));
  replacement.createWebRtcServer.mockResolvedValue(server);
  vi.mocked(createWorker)
    .mockResolvedValueOnce(original as unknown as Worker)
    .mockResolvedValueOnce(failed as unknown as Worker)
    .mockResolvedValueOnce(replacement as unknown as Worker);

  const onWorkerDied = vi.fn();
  const workers = await createWorkers({ onWorkerDied });
  original.emit("died");

  await vi.waitFor(() => expect(workers).toEqual([replacement]));
  expect(failed.close).toHaveBeenCalledOnce();
  expect(onWorkerDied).toHaveBeenCalledOnce();
  expect(getWorkerWebRtcServer(workers[0])).toBe(server);
  expect(replacement.createWebRtcServer.mock.calls).toEqual(
    original.createWebRtcServer.mock.calls,
  );
});

it("recovers a slot when the port becomes available after four failed attempts", async () => {
  const original = makeWorker();
  original.createWebRtcServer.mockResolvedValue({} as WebRtcServer);
  const recoveredServer = {} as WebRtcServer;
  const shutdown = new AbortController();
  const onWorkerDied = vi.fn();
  let portBlocked = true;
  let failedBinds = 0;
  vi.mocked(createWorker).mockClear()
    .mockResolvedValueOnce(original as unknown as Worker)
    .mockImplementation(async () => {
      const worker = makeWorker();
      worker.createWebRtcServer.mockImplementation(async () => {
        if (portBlocked) {
          failedBinds++;
          throw new Error("address already in use");
        }
        return recoveredServer;
      });
      return worker as unknown as Worker;
    });
  try {
    const workers = await createWorkers({ signal: shutdown.signal, onWorkerDied });
    original.emit("died");
    original.emit("died");
    await vi.waitFor(() => expect(failedBinds).toBeGreaterThanOrEqual(4), { timeout: 2000 });
    portBlocked = false;
    await vi.waitFor(() => {
      expect(getWorkerWebRtcServer(workers[0])).toBe(recoveredServer);
    }, { timeout: 2500 });
    expect(workers).toHaveLength(1);
    expect(onWorkerDied).toHaveBeenCalledOnce();
  } finally {
    shutdown.abort();
    vi.mocked(createWorker).mockReset();
  }
});

it("cancels a slot's pending retry when the pool shuts down", async () => {
  const original = makeWorker();
  original.createWebRtcServer.mockResolvedValue({} as WebRtcServer);
  const failed = makeWorker();
  failed.createWebRtcServer.mockRejectedValue(new Error("address already in use"));
  const shutdown = new AbortController();
  vi.mocked(createWorker).mockClear()
    .mockResolvedValueOnce(original as unknown as Worker)
    .mockResolvedValueOnce(failed as unknown as Worker);
  try {
    await createWorkers({ signal: shutdown.signal });
    original.emit("died");
    await vi.waitFor(() => expect(failed.close).toHaveBeenCalledOnce());
    const attempts = vi.mocked(createWorker).mock.calls.length;
    shutdown.abort();
    await delay(200);
    expect(createWorker).toHaveBeenCalledTimes(attempts);
  } finally {
    shutdown.abort();
    vi.mocked(createWorker).mockReset();
  }
});

it("closes a replacement that finishes starting during shutdown", async () => {
  const original = makeWorker();
  original.createWebRtcServer.mockResolvedValue({} as WebRtcServer);
  const replacement = makeWorker();
  let finishStarting!: (worker: Worker) => void;
  const startingWorker = new Promise<Worker>((resolve) => { finishStarting = resolve; });
  const shutdown = new AbortController();
  vi.mocked(createWorker).mockClear()
    .mockResolvedValueOnce(original as unknown as Worker)
    .mockReturnValueOnce(startingWorker);
  try {
    const workers = await createWorkers({ signal: shutdown.signal });
    original.emit("died");
    await vi.waitFor(() => expect(createWorker).toHaveBeenCalledTimes(2));
    shutdown.abort();
    finishStarting(replacement as unknown as Worker);
    await vi.waitFor(() => expect(replacement.close).toHaveBeenCalledOnce());
    expect(workers[0]).toBe(original);
    expect(replacement.createWebRtcServer).not.toHaveBeenCalled();
  } finally {
    shutdown.abort();
    vi.mocked(createWorker).mockReset();
  }
});
