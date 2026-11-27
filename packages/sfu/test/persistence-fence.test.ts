import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { config } from "../config/config.js";
import { done } from "../server/controlPlane/model.js";
import type { ControlPlaneStore } from "../server/controlPlane/store.js";
import { createSfuApp } from "../server/http/createApp.js";
import { createPersistenceFence, MAX_PERSISTENCE_FENCE_MS } from "../server/persistenceFence.js";
import { createSfuState } from "../server/state.js";

describe("control-plane write fence", () => {
  afterEach(() => vi.useRealTimers());

  it("drains an in-flight commit, leaves reads open and returns the queued commit's own result", async () => {
    let finish = () => {};
    const pending = new Promise<void>((resolve) => { finish = resolve; });
    const failure = new Error("store write failed");
    const commit = vi.fn().mockImplementationOnce(async () => {
      await pending;
      return { ok: true, value: "committed", rev: 1 };
    }).mockRejectedValueOnce(failure);
    const store: ControlPlaneStore = { ...createSfuState().controlPlane, commit };
    const state = createSfuState({ controlPlane: store });
    const before = state.controlPlane.commit(() => done("before"));
    let held = false;
    const hold = state.persistenceFence.hold("backup-one", 10_000).then((lease) => {
      held = true;
      return lease;
    });
    const during = state.controlPlane.commit(() => done("during"));
    await expect(state.controlPlane.read(() => "read while held")).resolves.toBe("read while held");
    expect(held).toBe(false);
    expect(commit).toHaveBeenCalledTimes(1);

    finish();
    await expect(before).resolves.toMatchObject({ value: "committed" });
    expect(await hold).not.toBeNull();
    expect(commit).toHaveBeenCalledTimes(1);
    state.persistenceFence.release("backup-one");
    await expect(during).rejects.toBe(failure);
    expect(commit).toHaveBeenCalledTimes(2);
  });

  it("releases queued work at the original hard deadline even if the holder renews", async () => {
    vi.useFakeTimers();
    const fence = createPersistenceFence();
    const start = Date.now();
    await fence.hold("backup-one", MAX_PERSISTENCE_FENCE_MS);
    const commit = vi.fn(() => "written");
    const pending = fence.run(commit);
    await vi.advanceTimersByTimeAsync(MAX_PERSISTENCE_FENCE_MS - 1);
    expect(fence.renew("backup-one", MAX_PERSISTENCE_FENCE_MS)).toEqual({ until: start + MAX_PERSISTENCE_FENCE_MS });
    expect(commit).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await expect(pending).resolves.toBe("written");
    expect(fence.renew("backup-one", 10_000)).toBeNull();
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
