import { execFileSync, spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { readFileSync } from "node:fs";
import { availableParallelism, totalmem } from "node:os";
import { createWorker } from "mediasoup";
import type { WebRtcServer, Worker } from "mediasoup/types";
import { beforeEach, expect, it, vi } from "vitest";
import { config } from "../config/config.js";
import { readWorkerSizing } from "../config/workerSettings.mjs";
import createWorkers, { getWorkerWebRtcServer } from "../utilities/createWorkers.js";
import { planWorkers } from "../utilities/workerPlan.js";

// Error reports go through the real reporter, rate limit included, to a
// client that collects them. Moving the clock on starts a new limit window.
const collector = vi.hoisted(() => ({
  reports: [] as Array<{ error: Error; properties: Record<string, unknown> }>,
  clockOffsetMs: 0,
}));
vi.mock("../server/analytics/posthog.js", async () => {
  const { createErrorReporter } = await import("../server/analytics/errorReporter.js");
  const reporter = createErrorReporter({
    getClient: () => ({
      captureException: (error, { properties }) =>
        collector.reports.push({ error: error as Error, properties }),
      captureExceptionImmediate: async () => {},
      flush: async () => {},
    }),
    instanceId: "sfu-test",
    hashKey: "test-instance-key",
    region: null,
    version: "test",
    now: () => Date.now() + collector.clockOffsetMs,
  });
  return { captureServerException: reporter.report };
});
vi.mock("mediasoup", () => ({ createWorker: vi.fn() }));
vi.mock("node:fs", () => ({ readFileSync: vi.fn() }));
vi.mock("node:os", () => {
  const availableParallelism = vi.fn(() => 8);
  const totalmem = vi.fn(() => 8 * 1024 ** 3);
  return { availableParallelism, totalmem, default: { availableParallelism, totalmem } };
});
vi.mock("../config/config.js", () => ({
  config: {
    workerSettings: {
      workerCount: 1,
      hostInstanceCount: 1,
      webRtcPortBudget: undefined,
      appDocumentWorkerCount: 1,
      rtcMinPort: 42001,
      rtcMaxPort: 42200,
    },
    webRtcTransport: { enableUdp: true, enableTcp: true, listenIps: [{ ip: "127.0.0.1" }] },
  },
}));

beforeEach(() => {
  vi.mocked(readFileSync).mockImplementation(() => { throw new Error("no cgroup limit"); });
});

const start = async (options: { onWorkerDied?: (worker: Worker, label: string) => void; signal?: AbortSignal } = {}) => {
  const settings = config.workerSettings;
  return createWorkers({ plan: planWorkers(settings), settings, transport: config.webRtcTransport, ...options });
};

const makeWorker = () => Object.assign(new EventEmitter(), {
  createWebRtcServer: vi.fn<Worker["createWebRtcServer"]>(),
  close: vi.fn(),
});

it.each([
  { name: "18 CPUs behind the Compose firewall budget", affinity: 18, instances: 2, ports: 200, expected: 4 },
  { name: "six ports with the browser relay reserve", affinity: 18, instances: 1, ports: 6, expected: 2 },
  { name: "the smallest range that supports the browser relay", affinity: 18, instances: 1, ports: 5, expected: 1 },
  { name: "one worker with the full firewall budget reserved", affinity: 2, instances: 2, ports: 200, expected: 1 },
])("respects the port budget for $name", async ({ affinity, instances, ports, expected }) => {
  const settings = config.workerSettings;
  const previous = { ...settings };
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  Object.assign(settings, {
    workerCount: undefined,
    hostInstanceCount: instances,
    webRtcPortBudget: 4,
    rtcMaxPort: settings.rtcMinPort + ports - 1,
  });
  vi.mocked(availableParallelism).mockReturnValue(affinity);
  vi.mocked(readFileSync).mockImplementation(() => { throw new Error("no cgroup limit"); });
  vi.mocked(createWorker).mockReset().mockImplementation(async () => {
    const worker = makeWorker();
    worker.createWebRtcServer.mockResolvedValue({} as WebRtcServer);
    return worker as unknown as Worker;
  });
  try {
    expect(await start()).toHaveLength(expected);
    expect(createWorker).toHaveBeenCalledWith(expect.objectContaining({
      rtcMinPort: settings.rtcMinPort + Math.min(4, ports - 4),
      rtcMaxPort: settings.rtcMaxPort,
    }));
    if (Math.floor(affinity / instances) > expected) {
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("WebRTC port budget"));
    }
  } finally {
    Object.assign(settings, previous);
    warn.mockRestore();
    vi.mocked(createWorker).mockReset();
    vi.mocked(readFileSync).mockReset();
  }
});

it.each([
  { ports: 6, workers: 3 },
  { ports: 200, workers: 5 },
])("rejects $workers configured workers with a $ports-port RTC range and a four-port budget", async ({ ports, workers }) => {
  const settings = config.workerSettings;
  const previous = { ...settings };
  Object.assign(settings, {
    workerCount: workers,
    webRtcPortBudget: 4,
    rtcMaxPort: settings.rtcMinPort + ports - 1,
  });
  vi.mocked(createWorker).mockClear();
  try {
    await expect(start()).rejects.toThrow("SFU_WORKER_COUNT");
    expect(createWorker).not.toHaveBeenCalled();
  } finally {
    Object.assign(settings, previous);
  }
});

it.each([
  { name: "affinity shared by two instances", affinity: 8, files: {}, instances: 2, override: undefined, appDocuments: 1, expected: 3 },
  { name: "two app document workers", affinity: 8, files: {}, instances: 1, override: undefined, appDocuments: 2, expected: 6 },
  { name: "a 4-CPU share with one app document worker", affinity: 4, files: {}, instances: 1, override: undefined, appDocuments: 1, expected: 3 },
  { name: "a 4-CPU share with two app document workers", affinity: 4, files: {}, instances: 1, override: undefined, appDocuments: 2, expected: 2 },
  { name: "a 2-CPU share", affinity: 2, files: {}, instances: 1, override: undefined, appDocuments: 1, expected: 1 },
  { name: "2-vCPU host shared by three instances", affinity: 2, files: {}, instances: 3, override: undefined, appDocuments: 1, expected: 1 },
  {
    name: "nested cgroup quota shared by two instances",
    affinity: 8,
    files: { "/proc/self/cgroup": "0::/sfu/current", "/sys/fs/cgroup/sfu/cpu.max": "350000 100000" },
    instances: 2, override: undefined, appDocuments: 1, expected: 1,
  },
  {
    name: "legacy CPU quota",
    affinity: 8,
    files: { "/sys/fs/cgroup/cpu/cpu.cfs_quota_us": "250000", "/sys/fs/cgroup/cpu/cpu.cfs_period_us": "100000" },
    instances: 1, override: undefined, appDocuments: 1, expected: 1,
  },
  {
    name: "explicit worker count",
    affinity: 8,
    files: { "/sys/fs/cgroup/cpu.max": "75000 100000" },
    instances: 3, override: 3, appDocuments: 1, expected: 3,
  },
])("chooses the worker count for $name", async ({ affinity, files, instances, override, appDocuments, expected }) => {
  const settings = config.workerSettings;
  const oldCount = settings.workerCount;
  const oldInstances = settings.hostInstanceCount;
  const oldAppDocuments = settings.appDocumentWorkerCount;
  settings.workerCount = override;
  settings.hostInstanceCount = instances;
  settings.appDocumentWorkerCount = appDocuments;
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
    expect(await start()).toHaveLength(expected);
  } finally {
    settings.workerCount = oldCount;
    settings.hostInstanceCount = oldInstances;
    settings.appDocumentWorkerCount = oldAppDocuments;
    vi.mocked(createWorker).mockReset();
    vi.mocked(readFileSync).mockReset();
  }
});

it.each([
  { affinity: 2, instances: 1, mediasoup: 2, warns: true },
  { affinity: 2, instances: 1, mediasoup: 1, warns: false },
  { affinity: 2, instances: 3, mediasoup: undefined, warns: false },
])("warns when $mediasoup configured mediasoup workers and the app document worker exceed $affinity CPUs for $instances instances: $warns", async ({ affinity, instances, mediasoup, warns }) => {
  const settings = config.workerSettings;
  const previous = { ...settings };
  Object.assign(settings, { workerCount: mediasoup, hostInstanceCount: instances, appDocumentWorkerCount: 1 });
  vi.mocked(availableParallelism).mockReturnValue(affinity);
  vi.mocked(readFileSync).mockImplementation(() => { throw new Error("no cgroup limit"); });
  vi.mocked(createWorker).mockReset().mockImplementation(async () => {
    const worker = makeWorker();
    worker.createWebRtcServer.mockResolvedValue({} as WebRtcServer);
    return worker as unknown as Worker;
  });
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  try {
    await start();
    if (warns) expect(warn).toHaveBeenCalledWith(expect.stringContaining("SFU_WORKER_COUNT=2"));
    else expect(warn).not.toHaveBeenCalledWith(expect.stringContaining("SFU_WORKER_COUNT"));
  } finally {
    Object.assign(settings, previous);
    warn.mockRestore();
    vi.mocked(createWorker).mockReset();
    vi.mocked(readFileSync).mockReset();
  }
});

it.each([
  { memoryMiB: 256, warns: true },
  { memoryMiB: 8192, warns: false },
])("says when the app document heap floor is above the worker's share of $memoryMiB MiB: $warns", async ({ memoryMiB, warns }) => {
  vi.mocked(totalmem).mockReturnValue(memoryMiB * 1024 * 1024);
  vi.mocked(readFileSync).mockImplementation(() => { throw new Error("no cgroup limit"); });
  vi.mocked(createWorker).mockReset().mockImplementation(async () => {
    const worker = makeWorker();
    worker.createWebRtcServer.mockResolvedValue({} as WebRtcServer);
    return worker as unknown as Worker;
  });
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  try {
    await start();
    if (warns) expect(warn).toHaveBeenCalledWith(expect.stringContaining("below the minimum heap"));
    else expect(warn).not.toHaveBeenCalledWith(expect.stringContaining("below the minimum heap"));
  } finally {
    warn.mockRestore();
    vi.mocked(totalmem).mockReturnValue(8 * 1024 ** 3);
    vi.mocked(createWorker).mockReset();
    vi.mocked(readFileSync).mockReset();
  }
});

it("uses the inherited Compose budget for staging WebRTC and plain RTP", { timeout: 30_000 }, async ({ skip }) => {
  if (spawnSync("docker", ["compose", "version"], { stdio: "ignore" }).status !== 0) {
    skip("Docker Compose is not installed");
    return;
  }
  const stagingCompose = `services:
  sfu-staging:
    extends:
      file: docker-compose.sfu.yml
      service: sfu-a
    environment:
      RTC_MIN_PORT: "42001"
      RTC_MAX_PORT: "42200"
      SFU_WORKER_COUNT: "1"
`;
  const rendered = execFileSync("docker", [
    "compose", "--env-file", "/dev/null", "-f", "-", "config", "--format", "json",
  ], {
    cwd: new URL("../../../", import.meta.url),
    env: {
      HOME: process.env.HOME,
      PATH: process.env.PATH,
      ANNOUNCED_IP: "127.0.0.1",
      SFU_SECRET: "staging-fixture",
    },
    input: stagingCompose,
    encoding: "utf8",
  });
  const compose = JSON.parse(rendered) as {
    services: { "sfu-staging": { environment: Record<string, string | null> } };
  };
  const { environment } = compose.services["sfu-staging"];
  const settings = config.workerSettings;
  const previous = { ...settings };
  Object.assign(settings, readWorkerSizing(environment), {
    rtcMinPort: Number(environment.RTC_MIN_PORT),
    rtcMaxPort: Number(environment.RTC_MAX_PORT),
  });
  const worker = makeWorker();
  worker.createWebRtcServer.mockResolvedValue({} as WebRtcServer);
  vi.mocked(createWorker).mockClear().mockResolvedValueOnce(worker as unknown as Worker);
  try {
    expect(await start()).toHaveLength(1);
    expect(worker.createWebRtcServer).toHaveBeenCalledWith({
      listenInfos: [
        expect.objectContaining({ protocol: "udp", port: 42001 }),
        expect.objectContaining({ protocol: "tcp", port: 42001 }),
      ],
    });
    expect(createWorker).toHaveBeenCalledWith(expect.objectContaining({
      rtcMinPort: 42005,
      rtcMaxPort: 42200,
    }));
  } finally {
    Object.assign(settings, previous);
  }
});

it("rejects a range that leaves no port for plain RTP", async () => {
  const settings = config.workerSettings;
  const originalMax = settings.rtcMaxPort;
  vi.mocked(createWorker).mockClear();
  settings.rtcMaxPort = settings.rtcMinPort;
  try {
    await expect(start()).rejects.toThrow("plain RTP");
    expect(createWorker).not.toHaveBeenCalled();
  } finally {
    settings.rtcMaxPort = originalMax;
  }
});

it("points occupied WebRTC ports to the Linux ephemeral port reservation", async () => {
  const worker = makeWorker();
  const bindError = new Error("uv_udp_bind() failed: address already in use");
  worker.createWebRtcServer.mockRejectedValue(bindError);
  vi.mocked(createWorker).mockReset().mockResolvedValueOnce(worker as unknown as Worker);
  try {
    await expect(start()).rejects.toThrow(/42001.*net\.ipv4\.ip_local_reserved_ports/);
    expect(worker.close).toHaveBeenCalledOnce();
  } finally {
    vi.mocked(createWorker).mockReset();
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
  const workers = await start({ onWorkerDied });
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
    const workers = await start({ signal: shutdown.signal, onWorkerDied });
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

it("reports a slot's failed respawns while its port stays taken", async () => {
  const original = makeWorker();
  original.createWebRtcServer.mockResolvedValue({} as WebRtcServer);
  const shutdown = new AbortController();
  let portTaken = true;
  let failedBinds = 0;
  vi.mocked(createWorker).mockClear()
    .mockResolvedValueOnce(original as unknown as Worker)
    .mockImplementation(async () => {
      const worker = makeWorker();
      worker.createWebRtcServer.mockImplementation(async () => {
        if (!portTaken) return {} as WebRtcServer;
        failedBinds++;
        throw new Error("uv_udp_bind() failed: address already in use");
      });
      return worker as unknown as Worker;
    });
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  collector.reports.length = 0;
  collector.clockOffsetMs += 120_000;
  try {
    const workers = await start({ signal: shutdown.signal });
    original.emit("died");
    await vi.waitFor(() => expect(failedBinds).toBeGreaterThanOrEqual(5), { timeout: 4000 });
    portTaken = false;
    await vi.waitFor(() => expect(workers[0]).not.toBe(original), { timeout: 3000 });

    const respawnReports = collector.reports.filter(
      ({ properties }) => properties.source === "worker_respawn_failed",
    );
    expect(respawnReports.map(({ properties }) => properties.respawn_attempt)).toEqual(
      [1, 2, 4, 8, 16].filter((attempt) => attempt <= failedBinds),
    );
    for (const { properties, error } of respawnReports) {
      expect(properties).toMatchObject({ worker_label: "0" });
      expect(properties.sfu_instance_id).toMatch(/^sfu_[0-9a-f]{16}$/);
      expect(error.message).toBe("[message withheld]");
    }
  } finally {
    shutdown.abort();
    warn.mockRestore();
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
    await start({ signal: shutdown.signal });
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
    const workers = await start({ signal: shutdown.signal });
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
