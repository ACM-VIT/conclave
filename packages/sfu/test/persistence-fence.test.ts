import { createServer, type Server } from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { config } from "../config/config.js";
import { createSfuApp } from "../server/http/createApp.js";
import {
  createPersistenceFence,
  MAX_PERSISTENCE_FENCE_MS,
  fenceScheduledMeetingPersistence,
  fenceScheduledWebinarPersistence,
  fenceSchedulingPersistence,
} from "../server/persistenceFence.js";
import { persistScheduledMeetingChanges, type ScheduledMeetingPersistence } from "../server/scheduledMeetings.js";
import { persistScheduledWebinarChanges } from "../server/scheduledWebinars.js";
import { createSfuState } from "../server/state.js";
import type { ScheduledMeeting, ScheduledWebinar } from "../types.js";

const meeting = (id: string) => ({ id }) as unknown as ScheduledMeeting;
const store = { byId: new Map() } as never;

// Like the Redis persistence: a write is queued and lands a moment later,
// each write's promise carries its own result or error, flush() waits for the
// queue without failing, and a reminder claim reads what has landed.
const queuedStore = ({ failWrites = false } = {}) => {
  const stored = new Map<string, ScheduledMeeting>([["m1", meeting("m1")]]);
  const log: string[] = [];
  let pending: Promise<void> = Promise.resolve();
  const queue = (label: string, write: () => void): Promise<void> => {
    const landed = pending.then(async () => {
      await delay(5);
      if (failWrites) throw new Error(`OOM command not allowed (${label})`);
      write();
      log.push(label);
    });
    pending = landed.catch(() => undefined);
    return landed;
  };
  const persistence: ScheduledMeetingPersistence = {
    save: () => undefined,
    saveChanged: (meetings) => queue("saveChanged", () => meetings.forEach((m) => stored.set(m.id, m))),
    deleteIds: (ids) => queue("deleteIds", () => ids.forEach((id) => stored.delete(id))),
    claimEmailReminder: async (claim) => {
      log.push("claim");
      return stored.get(claim.meetingId) ?? null;
    },
    flush: () => pending,
    load: () => [],
  };
  return { stored, log, persistence };
};

describe("persistence fence", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("runs a reminder claim made during a hold only after the cancellation made before it has landed", async () => {
    const fence = createPersistenceFence();
    const redis = queuedStore();
    const meetings = fenceScheduledMeetingPersistence(redis.persistence, fence);

    await fence.hold("backup-one", 10_000);
    const cancel = meetings.deleteIds!(["m1"]);
    const claim = meetings.claimEmailReminder!({ meetingId: "m1" } as never);
    expect(redis.log).toEqual([]);

    fence.release("backup-one");
    await cancel;
    await expect(claim).resolves.toBeNull();
    expect(redis.log).toEqual(["deleteIds", "claim"]);
  });

  it("hands a write that fails after the hold to its caller, so nothing reaches the process", async () => {
    const fence = createPersistenceFence();
    const redis = queuedStore({ failWrites: true });
    const meetings = fenceScheduledMeetingPersistence(redis.persistence, fence);
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", onUnhandled);
    try {
      await fence.hold("backup-one", 10_000);
      const persisted = persistScheduledMeetingChanges(store, meetings, [meeting("m2")]);
      // The backup releases seconds later; the caller's flush() runs first.
      await delay(10);
      fence.release("backup-one");
      await expect(persisted).rejects.toThrow(/OOM command not allowed/);
      await delay(20);
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  it("reports a hold only after a reminder claim already writing Redis and then SQLite has finished", async () => {
    const fence = createPersistenceFence();
    const writes: string[] = [];
    const meetings = fenceScheduledMeetingPersistence(
      {
        save: () => undefined,
        claimEmailReminder: async () => {
          await delay(10);
          writes.push("claim wrote Redis");
          await delay(10);
          writes.push("claim wrote SQLite");
          return null;
        },
        load: () => [],
      },
      fence,
    );
    const claim = meetings.claimEmailReminder!({ meetingId: "m1" } as never);
    await delay(2);
    expect(writes).toEqual([]);
    await fence.hold("backup-one", 5_000);
    expect(writes).toEqual(["claim wrote Redis", "claim wrote SQLite"]);
    fence.release("backup-one");
    await claim;
  });

  it("reports a hold only after a load already under way has finished, since a load can migrate records", async () => {
    const fence = createPersistenceFence();
    let migrated = false;
    const meetings = fenceScheduledMeetingPersistence(
      {
        save: () => undefined,
        load: async () => {
          await delay(10);
          migrated = true;
          return [];
        },
      },
      fence,
    );
    const loading = meetings.load();
    await fence.hold("backup-one", 5_000);
    expect(migrated).toBe(true);
    fence.release("backup-one");
    await loading;
  });

  it("starts the calls made during a hold in the order they were made once it lifts, after the earlier ones landed", async () => {
    const fence = createPersistenceFence();
    const events: string[] = [];
    const call = (name: string) =>
      fence.run(async () => {
        events.push(`${name} start`);
        await delay(3);
        events.push(`${name} end`);
        return name;
      });

    const first = call("first");
    await fence.hold("backup-one", 10_000);
    const during = [call("second"), call("third")];
    expect(events).toEqual(["first start", "first end"]);
    fence.release("backup-one");
    const after = call("fourth");
    expect(events).toEqual(["first start", "first end", "second start", "third start", "fourth start"]);
    await expect(Promise.all([first, ...during, after])).resolves.toEqual(["first", "second", "third", "fourth"]);
  });

  it("never holds a SQLite webinar save behind a Redis write that has not answered", async () => {
    const fence = createPersistenceFence();
    let answer: () => void = () => {};
    const redis = new Promise<void>((resolve) => (answer = resolve));
    const meetings = fenceScheduledMeetingPersistence(
      { save: () => undefined, saveChanged: () => undefined, flush: () => redis, load: () => [] },
      fence,
    );
    const saved: string[] = [];
    const webinars = fenceScheduledWebinarPersistence(
      { save: () => void saved.push("webinars"), saveChanged: () => void saved.push("webinar w1"), load: () => [] },
      fence,
    );

    const meetingWrite = meetings.saveChanged!([meeting("m1")]);
    await persistScheduledWebinarChanges(store, webinars, [{ id: "w1" } as never]);
    await Promise.resolve(webinars.save([]));
    expect(saved).toEqual(["webinar w1", "webinars"]);

    answer();
    await meetingWrite;
  });

  it("answers a hold only once the call already under way has landed", async () => {
    const fence = createPersistenceFence();
    let landed = false;
    const inFlight = fence.run(async () => {
      await delay(20);
      landed = true;
    });
    const held = fence.hold("backup-one", 5_000).then(() => landed);
    await expect(held).resolves.toBe(true);
    await inFlight;
  });

  it("lets only the owner renew or release a hold, and refuses a second backup's hold", async () => {
    const fence = createPersistenceFence();
    expect(await fence.hold("backup-one", 5_000)).not.toBeNull();
    expect(await fence.hold("backup-two", 5_000)).toBeNull();
    expect(fence.renew("backup-two", 5_000)).toBeNull();
    expect(fence.release("backup-two")).toBe(false);
    expect(fence.holder()).toBe("backup-one");

    const write = fence.run(() => "written");
    await delay(10);
    expect(fence.holder()).toBe("backup-one");
    expect(fence.renew("backup-one", 5_000)).not.toBeNull();
    expect(fence.release("backup-one")).toBe(true);
    await expect(write).resolves.toBe("written");
  });

  it("lifts itself at its deadline when the backup never comes back, and the lapsed hold cannot be renewed", async () => {
    vi.useFakeTimers();
    const fence = createPersistenceFence();
    await fence.hold("backup-one", 1_000);
    const written = vi.fn();
    const write = fence.run(written);
    await vi.advanceTimersByTimeAsync(999);
    expect(written).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await write;
    expect(written).toHaveBeenCalledOnce();
    expect(fence.holder()).toBeNull();
    expect(fence.renew("backup-one", 1_000)).toBeNull();
  });

  it("never lets renewals keep writers waiting past the hard limit from when the hold was taken", async () => {
    vi.useFakeTimers();
    const fence = createPersistenceFence();
    const taken = Date.now();
    await fence.hold("backup-one", 20_000);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(fence.renew("backup-one", 20_000)).toEqual({ until: taken + MAX_PERSISTENCE_FENCE_MS });
    const write = fence.run(() => "written");
    await vi.advanceTimersByTimeAsync(15_000);
    await expect(write).resolves.toBe("written");
    expect(fence.holder()).toBeNull();
  });

  it("leaves the event loop to everything else while calls wait on a hold", async () => {
    const fence = createPersistenceFence();
    await fence.hold("backup-one", 10_000);
    let settled = 0;
    const waiting = [fence.run(() => "a"), fence.run(() => "b")].map((call) => call.finally(() => (settled += 1)));
    for (let turn = 0; turn < 20; turn += 1) await new Promise((done) => setImmediate(done));
    const server = createServer((_req, res) => res.end("pong"));
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    try {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("no port");
      expect(await (await fetch(`http://127.0.0.1:${address.port}`)).text()).toBe("pong");
    } finally {
      await new Promise((done) => server.close(done));
    }
    expect(settled).toBe(0);
    fence.release("backup-one");
    await expect(Promise.all(waiting)).resolves.toEqual(["a", "b"]);
  });

  it("routes scheduling and webinar writes through the same gate, and a webinar write's error reaches its caller", async () => {
    const fence = createPersistenceFence();
    const order: string[] = [];
    const scheduling = fenceSchedulingPersistence(
      { save: () => void order.push("scheduling"), load: () => ({}) as never },
      fence,
    );
    const webinars = fenceScheduledWebinarPersistence(
      {
        save: () => void order.push("webinars.save"),
        saveChanged: () => {
          throw new Error("SQLITE_FULL");
        },
        load: () => [],
      },
      fence,
    );
    await fence.hold("backup-one", 10_000);
    const writes = [Promise.resolve(scheduling.save({} as never)), Promise.resolve(webinars.save([]))];
    const failed = persistScheduledWebinarChanges(store, webinars, [{ id: "w1" } as never]);
    expect(order).toEqual([]);
    fence.release("backup-one");
    await Promise.all(writes);
    await expect(failed).rejects.toThrow("SQLITE_FULL");
    expect(order).toEqual(["scheduling", "webinars.save"]);
  });

  it("queues a copy of every write made during a hold, so later edits to the same records cannot change it", async () => {
    const fence = createPersistenceFence();
    const webinarSaves: string[] = [];
    const meetingSaves: string[] = [];
    const webinars = fenceScheduledWebinarPersistence(
      {
        save: () => undefined,
        saveChanged: (list) => void webinarSaves.push(list.map((w) => `${w.id}->${w.linkSlug}`).join(",")),
        load: () => [],
      },
      fence,
    );
    const meetings = fenceScheduledMeetingPersistence(
      {
        save: () => undefined,
        saveChanged: (list) => void meetingSaves.push(list.map((m) => `${m.id}->${m.title}`).join(",")),
        load: () => [],
      },
      fence,
    );
    const a = { id: "A", linkSlug: "a" } as ScheduledWebinar;
    const b = { id: "B", linkSlug: "b" } as ScheduledWebinar;
    const m = { id: "M", title: "first" } as ScheduledMeeting;
    await fence.hold("backup-one", 10_000);
    a.linkSlug = "c";
    const writes = [webinars.saveChanged!([a])];
    b.linkSlug = "a";
    writes.push(webinars.saveChanged!([b]));
    a.linkSlug = "b";
    writes.push(webinars.saveChanged!([a]));
    writes.push(meetings.saveChanged!([m]));
    m.title = "second";
    fence.release("backup-one");
    await Promise.all(writes.map((write) => Promise.resolve(write)));
    expect(webinarSaves).toEqual(["A->c", "B->a", "A->b"]);
    expect(meetingSaves).toEqual(["M->first"]);
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

  it("holds for its owner until a deadline, renews for that owner, and releases only for it", async () => {
    const { state, url } = await start();
    const held = await call(url, "POST", { owner: "backup-one", holdMs: 5_000 });
    expect(held.status).toBe(200);
    const body = (await held.json()) as { until: number; instanceId: string; owner: string };
    expect(body).toMatchObject({ instanceId: config.instanceId, owner: "backup-one" });
    expect(body.until).toBeGreaterThan(Date.now());

    expect((await call(url, "POST", { owner: "backup-two", holdMs: 5_000 })).status).toBe(409);
    expect((await call(url, "POST", { owner: "backup-two", holdMs: 5_000, renew: true })).status).toBe(409);
    expect((await call(url, "DELETE", { owner: "backup-two" })).status).toBe(409);
    expect(state.persistenceFence.holder()).toBe("backup-one");

    expect((await call(url, "POST", { owner: "backup-one", holdMs: 5_000, renew: true })).status).toBe(200);
    const released = await call(url, "DELETE", { owner: "backup-one" });
    expect(released.status).toBe(200);
    expect(await released.json()).toMatchObject({ released: true });
    expect(state.persistenceFence.holder()).toBeNull();
    expect((await call(url, "POST", { owner: "backup-one", holdMs: 5_000, renew: true })).status).toBe(409);
  });

  it("refuses a missing secret, a missing owner and a hold longer than its hard limit", async () => {
    const { state, url } = await start();
    expect((await call(url, "POST", { owner: "backup-one", holdMs: 5_000 }, "wrong")).status).toBe(401);
    expect((await call(url, "DELETE", { owner: "backup-one" }, "wrong")).status).toBe(401);
    expect((await call(url, "POST", { holdMs: 5_000 })).status).toBe(400);
    expect((await call(url, "POST", { owner: "backup-one", holdMs: 120_000 })).status).toBe(400);
    expect(state.persistenceFence.holder()).toBeNull();
  });
});
