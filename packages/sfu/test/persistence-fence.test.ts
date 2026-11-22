import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { config } from "../config/config.js";
import { createSfuApp } from "../server/http/createApp.js";
import {
  createPersistenceFence,
  fenceScheduledMeetingPersistence,
  fenceScheduledWebinarPersistence,
  fenceSchedulingPersistence,
} from "../server/persistenceFence.js";
import type { ScheduledMeeting } from "../types.js";
import { createSfuState } from "../server/state.js";

const meeting = (id: string) => ({ id }) as unknown as ScheduledMeeting;

const recordingStore = () => {
  const writes: string[] = [];
  return {
    writes,
    meetings: {
      save: (snapshot: ScheduledMeeting[]) => void writes.push(`meetings.save ${snapshot.map((m) => m.id).join(",")}`),
      saveChanged: (changed: ScheduledMeeting[]) => void writes.push(`meetings.saveChanged ${changed.map((m) => m.id).join(",")}`),
      deleteIds: (ids: string[]) => void writes.push(`meetings.deleteIds ${ids.join(",")}`),
      claimEmailReminder: async () => {
        writes.push("meetings.claimEmailReminder");
        return null;
      },
      load: () => [],
    },
    webinars: {
      save: () => void writes.push("webinars.save"),
      load: () => [],
    },
    scheduling: {
      save: () => void writes.push("scheduling.save"),
      load: () => ({ profiles: [], availability: [], eventTypes: [], calendars: [], tombstones: [] }) as never,
    },
  };
};

describe("persistence fence", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("holds every durable write until it is released, then runs them in order", async () => {
    const fence = createPersistenceFence();
    const store = recordingStore();
    const meetings = fenceScheduledMeetingPersistence(store.meetings, fence);
    const webinars = fenceScheduledWebinarPersistence(store.webinars, fence);
    const scheduling = fenceSchedulingPersistence(store.scheduling, fence);

    await fence.hold(10_000);
    webinars.save([]);
    void meetings.saveChanged?.([meeting("m1")]);
    void scheduling.save({} as never);
    void meetings.deleteIds?.(["m0"]);
    const claim = meetings.claimEmailReminder?.({} as never);
    expect(store.writes).toEqual([]);

    fence.release();
    await claim;
    expect(store.writes).toEqual([
      "webinars.save",
      "meetings.saveChanged m1",
      "scheduling.save",
      "meetings.deleteIds m0",
      "meetings.claimEmailReminder",
    ]);
  });

  it("writes straight through while no backup holds it", async () => {
    const fence = createPersistenceFence();
    const store = recordingStore();
    await fenceScheduledMeetingPersistence(store.meetings, fence).save([meeting("m1")]);
    expect(store.writes).toEqual(["meetings.save m1"]);
  });

  it("lifts itself at its hard timeout when the backup never comes back", async () => {
    vi.useFakeTimers();
    const fence = createPersistenceFence();
    const store = recordingStore();
    await fence.hold(1_000);
    fenceScheduledWebinarPersistence(store.webinars, fence).save([]);
    expect(store.writes).toEqual([]);
    vi.advanceTimersByTime(1_000);
    expect(store.writes).toEqual(["webinars.save"]);
  });

  it("answers a hold only once writes already in flight have landed", async () => {
    const fence = createPersistenceFence();
    let landed = false;
    let land: () => void = () => {};
    const inFlight = new Promise<void>((resolve) => {
      land = () => {
        landed = true;
        resolve();
      };
    });
    fenceScheduledMeetingPersistence({ ...recordingStore().meetings, flush: () => inFlight }, fence);
    const held = fence.hold(5_000).then(() => landed);
    land();
    await expect(held).resolves.toBe(true);
  });
});

describe("persistence fence endpoint", () => {
  const servers: Server[] = [];
  afterEach(async () => {
    await Promise.all(servers.splice(0).map((server) => new Promise((done) => server.close(done))));
  });

  const start = async () => {
    const state = createSfuState({ isDraining: false });
    const app = createSfuApp({ state, config });
    const server = createServer(app);
    servers.push(server);
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("no port");
    return { state, url: `http://127.0.0.1:${address.port}` };
  };
  const call = (url: string, method: string, body?: object, secret = config.sfuSecret) =>
    fetch(`${url}/admin/persistence-fence`, {
      method,
      headers: { "x-sfu-secret": secret, "content-type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
    });

  it("holds for a bounded time, says until when and which instance, and releases", async () => {
    const { state, url } = await start();
    const held = await call(url, "POST", { holdMs: 5_000 });
    expect(held.status).toBe(200);
    const body = (await held.json()) as { until: number; instanceId: string };
    expect(body.instanceId).toBe(config.instanceId);
    expect(body.until).toBeGreaterThan(Date.now());
    expect(state.persistenceFence.held()).toBe(true);

    expect((await call(url, "DELETE")).status).toBe(200);
    expect(state.persistenceFence.held()).toBe(false);
  });

  it("refuses a missing secret and a hold longer than its hard limit", async () => {
    const { state, url } = await start();
    expect((await call(url, "POST", { holdMs: 5_000 }, "wrong")).status).toBe(401);
    expect((await call(url, "POST", { holdMs: 120_000 })).status).toBe(400);
    expect(state.persistenceFence.held()).toBe(false);
  });
});
