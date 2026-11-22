import { EventEmitter } from "node:events";
import { createWorker } from "mediasoup";
import type { Worker } from "mediasoup/types";
import { afterEach, describe, expect, it, vi } from "vitest";
import { config } from "../config/config.js";
import { createSfuServer } from "../server/createSfuServer.js";
import { initMediaSoup } from "../server/init.js";
import type { AppDocumentPool } from "../server/apps/documents/pool.js";
import { createSfuState } from "../server/state.js";
import { planWorkers } from "../utilities/workerPlan.js";

vi.mock("mediasoup", () => ({ createWorker: vi.fn() }));

const settings = (overrides: Partial<Parameters<typeof planWorkers>[0]> = {}) => ({
  workerCount: undefined,
  hostInstanceCount: 1,
  webRtcPortBudget: undefined,
  appDocumentWorkerCount: 1,
  rtcMinPort: 40_000,
  rtcMaxPort: 40_999,
  ...overrides,
});

const pools: AppDocumentPool[] = [];
afterEach(async () => {
  await Promise.all(pools.splice(0).map((pool) => pool.close()));
});

describe("worker plan", () => {
  it("gives each extra app document worker a CPU the mediasoup count would have used", () => {
    expect(planWorkers(settings({ appDocumentWorkerCount: 1 }), 4)).toMatchObject({ mediasoupWorkers: 3, appDocumentWorkers: 1 });
    expect(planWorkers(settings({ appDocumentWorkerCount: 2 }), 4)).toMatchObject({ mediasoupWorkers: 2, appDocumentWorkers: 2 });
    expect(planWorkers(settings({ appDocumentWorkerCount: 3 }), 4)).toMatchObject({ mediasoupWorkers: 1, appDocumentWorkers: 3 });
  });

  it("never plans more workers than the CPU share, except one of each on a one-CPU share", () => {
    for (let cpus = 1; cpus <= 16; cpus += 1) {
      for (let app = 1; app <= Math.max(1, cpus - 1); app += 1) {
        const plan = planWorkers(settings({ appDocumentWorkerCount: app }), cpus);
        expect(plan.mediasoupWorkers).toBeGreaterThanOrEqual(1);
        expect(plan.appDocumentWorkers).toBe(app);
        expect(plan.mediasoupWorkers + plan.appDocumentWorkers).toBe(Math.max(cpus, 2));
      }
    }
  });

  it.each([1, 2])("plans one mediasoup and one app document worker on a %i-CPU share", (cpus) => {
    expect(planWorkers(settings(), cpus)).toMatchObject({ mediasoupWorkers: 1, appDocumentWorkers: 1 });
  });

  it.each([
    { cpus: 1, app: 2 },
    { cpus: 2, app: 2 },
    { cpus: 4, app: 4 },
  ])("refuses $app app document workers on a $cpus-CPU share", ({ cpus, app }) => {
    expect(() => planWorkers(settings({ appDocumentWorkerCount: app }), cpus)).toThrow(`SFU_APP_DOC_WORKERS=${app}`);
  });

  it("refuses app document workers that leave no CPU for a configured mediasoup count", () => {
    expect(planWorkers(settings({ workerCount: 6, appDocumentWorkerCount: 2 }), 8)).toMatchObject({ mediasoupWorkers: 6, appDocumentWorkers: 2 });
    expect(() => planWorkers(settings({ workerCount: 6, appDocumentWorkerCount: 3 }), 8)).toThrow("SFU_APP_DOC_WORKERS=3");
  });

  it("keeps a configured mediasoup count and says when it oversubscribes the share", () => {
    expect(planWorkers(settings({ workerCount: 2 }), 2)).toMatchObject({ mediasoupWorkers: 2, oversubscribed: true });
    expect(planWorkers(settings({ workerCount: 1 }), 2)).toMatchObject({ mediasoupWorkers: 1, oversubscribed: false });
  });

  it.each([
    { memoryMiB: 1024, instances: 1, app: 1, oldMb: 224, youngMb: 32 },
    { memoryMiB: 2048, instances: 1, app: 2, oldMb: 224, youngMb: 32 },
    { memoryMiB: 8192, instances: 3, app: 1, oldMb: 650, youngMb: 32 },
    { memoryMiB: 768, instances: 1, app: 1, oldMb: 168, youngMb: 24 },
    { memoryMiB: 65536, instances: 1, app: 1, oldMb: 1024, youngMb: 32 },
  ])("fits both heap generations of each app document worker in a quarter of $memoryMiB MiB split across $instances instance(s) and $app worker(s)", ({ memoryMiB, instances, app, oldMb, youngMb }) => {
    const plan = planWorkers(settings({ hostInstanceCount: instances, appDocumentWorkerCount: app }), 8, memoryMiB * 1024 * 1024);
    expect(plan.appDocumentHeap).toMatchObject({ oldMb, youngMb });
    expect(oldMb + youngMb).toBeLessThanOrEqual(plan.appDocumentHeap.shareMb);
  });

  it("gives an app document worker the 128 MiB old-generation floor when its share is smaller", () => {
    const plan = planWorkers(settings(), 8, 256 * 1024 * 1024);
    expect(plan.appDocumentHeap).toEqual({ shareMb: 64, oldMb: 128, youngMb: 8 });
    for (let memoryMiB = 584; memoryMiB <= 8192; memoryMiB += 8) {
      const { shareMb, oldMb, youngMb } = planWorkers(settings(), 8, memoryMiB * 1024 * 1024).appDocumentHeap;
      expect(oldMb + youngMb).toBeLessThanOrEqual(shareMb);
    }
  });

  it("caps the derived mediasoup count at the WebRTC port budget", () => {
    expect(planWorkers(settings({ webRtcPortBudget: 2 }), 8)).toMatchObject({
      mediasoupWorkers: 2,
      cpuMediasoupWorkers: 7,
      appDocumentWorkers: 1,
    });
  });

  it("starts the mediasoup workers that the plan from the injected config asks for", async () => {
    vi.mocked(createWorker).mockImplementation(async () =>
      Object.assign(new EventEmitter(), { createWebRtcServer: vi.fn(async () => ({})), close: vi.fn() }) as unknown as Worker,
    );
    const injected = {
      ...config,
      workerSettings: { ...config.workerSettings, workerCount: 2, webRtcPortBudget: undefined, rtcMinPort: 47_000, rtcMaxPort: 47_100 },
    };
    const state = createSfuState({ config: injected });
    const shutdown = new AbortController();
    pools.push(state.appDocuments);

    await initMediaSoup(state, injected, () => null, shutdown.signal);
    shutdown.abort();

    expect(state.workers).toHaveLength(state.workerPlan.mediasoupWorkers);
    expect(state.workers).toHaveLength(2);
    expect(createWorker).toHaveBeenCalledWith(expect.objectContaining({ rtcMinPort: 47_002, rtcMaxPort: 47_100 }));
  });

  it("takes every port from the plan, even when the settings change before start", async () => {
    const created: { createWebRtcServer: ReturnType<typeof vi.fn> }[] = [];
    vi.mocked(createWorker).mockReset().mockImplementation(async () => {
      const worker = Object.assign(new EventEmitter(), { createWebRtcServer: vi.fn(async () => ({})), close: vi.fn() });
      created.push(worker);
      return worker as unknown as Worker;
    });
    const injected = {
      ...config,
      workerSettings: { ...config.workerSettings, workerCount: 1, webRtcPortBudget: undefined, rtcMinPort: 47_000, rtcMaxPort: 47_100 },
    };
    const state = createSfuState({ config: injected });
    pools.push(state.appDocuments);
    injected.workerSettings.rtcMinPort = 47_001;
    const shutdown = new AbortController();

    await initMediaSoup(state, injected, () => null, shutdown.signal);
    shutdown.abort();

    const [{ listenInfos }] = created[0].createWebRtcServer.mock.calls[0] as [{ listenInfos: { port: number }[] }];
    expect(new Set(listenInfos.map((info) => info.port))).toEqual(new Set([47_000]));
    expect(createWorker).toHaveBeenCalledWith(expect.objectContaining({ rtcMinPort: 47_001, rtcMaxPort: 47_100 }));
  });

  it("builds the plan the server uses from the config passed to createSfuServer", () => {
    const server = createSfuServer({
      config: { ...config, workerSettings: { ...config.workerSettings, workerCount: 1, appDocumentWorkerCount: 1 } },
    });
    pools.push(server.state.appDocuments);

    expect(server.state.workerPlan).toMatchObject({ mediasoupWorkers: 1, appDocumentWorkers: 1, sizing: "configured" });
  });
});
