import { afterEach, describe, expect, it, vi } from "vitest";
import type { Room } from "../config/classes/Room.js";
import { createTranscriptRelayRegistry } from "../server/transcript/relayRegistry.js";
import { TranscriptWorkerRelayClient } from "../server/transcript/workerClient.js";

const room = {
  id: "room-a",
  clientId: "client-a",
  channelId: "client-a:room-a",
} as Room;

const otherClientRoom = {
  id: "room-a",
  clientId: "client-b",
  channelId: "client-b:room-a",
} as Room;

const createRegistry = (registryOptions: {
  failStartFor?: Set<string>;
  handoffFailsFor?: Set<string>;
} = {}) => {
  const closed: string[] = [];
  const handoffsPrepared: string[] = [];
  const closeOptions: Array<{
    controllerUserId: string;
    flushBufferedAudio?: boolean;
  }> = [];
  const relays = new Map<string, { onClosed?: (message: string) => void }>();
  const registry = createTranscriptRelayRegistry({
    enabled: true,
    createRelay: (options) => {
      relays.set(options.controllerUserId, {
        onClosed: options.onClosed,
      });
      return {
        controllerUserId: options.controllerUserId,
        start: async () => {
          if (registryOptions.failStartFor?.has(options.controllerUserId)) {
            throw new Error("start failed");
          }
        },
        prepareHandoff: async () => {
          handoffsPrepared.push(options.controllerUserId);
          return !registryOptions.handoffFailsFor?.has(options.controllerUserId);
        },
        syncProducers: async () => {},
        close: (closeOption?: { flushBufferedAudio?: boolean }) => {
          closed.push(options.controllerUserId);
          closeOptions.push({
            controllerUserId: options.controllerUserId,
            flushBufferedAudio: closeOption?.flushBufferedAudio,
          });
        },
      };
    },
    });
  return { closed, closeOptions, handoffsPrepared, registry, relays };
};

describe("TranscriptRelayRegistry", () => {
  it("blocks ordinary participants from replacing another active relay", async () => {
    const { closed, registry } = createRegistry();

    expect(
      await registry.start({
        room,
        workerUrl: "http://worker.test",
        workerToken: "token-a",
        controllerUserId: "u1",
        controllerDisplayName: "Ada",
        canReplaceExistingRelay: false,
      }),
    ).toMatchObject({ success: true });

    expect(
      await registry.start({
        room,
        workerUrl: "http://worker.test",
        workerToken: "token-b",
        controllerUserId: "u2",
        controllerDisplayName: "Grace",
        canReplaceExistingRelay: false,
      }),
    ).toMatchObject({
      success: false,
      reason: "An SFU transcript relay is already controlled by another participant.",
    });
    expect(closed).toEqual([]);
  });

  it("allows host/admin replacement and cleans up stale relays after close callbacks", async () => {
    const { closed, registry, relays } = createRegistry();

    await registry.start({
      room,
      workerUrl: "http://worker.test",
      workerToken: "token-a",
      controllerUserId: "u1",
      controllerDisplayName: "Ada",
      canReplaceExistingRelay: false,
    });
    expect(
      await registry.start({
        room,
        workerUrl: "http://worker.test",
        workerToken: "token-b",
        controllerUserId: "u2",
        controllerDisplayName: "Grace",
        canReplaceExistingRelay: true,
      }),
    ).toMatchObject({ success: true });
    expect(closed).toEqual(["u1"]);

    relays.get("u2")?.onClosed?.("worker relay closed");
    expect(
      await registry.start({
        room,
        workerUrl: "http://worker.test",
        workerToken: "token-c",
        controllerUserId: "u3",
        controllerDisplayName: "Lin",
        canReplaceExistingRelay: false,
      }),
    ).toMatchObject({ success: true });
  });

  it("keeps relays isolated by room channel id", async () => {
    const { closed, registry } = createRegistry();

    await expect(
      registry.start({
        room,
        workerUrl: "http://worker.test",
        workerToken: "token-a",
        controllerUserId: "u1",
        controllerDisplayName: "Ada",
        canReplaceExistingRelay: false,
      }),
    ).resolves.toMatchObject({ success: true });

    await expect(
      registry.start({
        room: otherClientRoom,
        workerUrl: "http://worker.test",
        workerToken: "token-b",
        controllerUserId: "u2",
        controllerDisplayName: "Grace",
        canReplaceExistingRelay: false,
      }),
    ).resolves.toMatchObject({ success: true });
    expect(closed).toEqual([]);
  });

  it("restores the existing relay if replacement startup fails", async () => {
    const { closed, registry } = createRegistry({
      failStartFor: new Set(["u2"]),
    });

    await registry.start({
      room,
      workerUrl: "http://worker.test",
      workerToken: "token-a",
      controllerUserId: "u1",
      controllerDisplayName: "Ada",
      canReplaceExistingRelay: false,
    });

    await expect(
      registry.start({
        room,
        workerUrl: "http://worker.test",
        workerToken: "token-b",
        controllerUserId: "u2",
        controllerDisplayName: "Grace",
        canReplaceExistingRelay: true,
      }),
    ).resolves.toMatchObject({ success: false, reason: "start failed" });

    expect(closed).toEqual(["u2"]);
    await expect(
      registry.start({
        room,
        workerUrl: "http://worker.test",
        workerToken: "token-c",
        controllerUserId: "u3",
        controllerDisplayName: "Lin",
        canReplaceExistingRelay: false,
      }),
    ).resolves.toMatchObject({
      success: false,
      reason: "An SFU transcript relay is already controlled by another participant.",
    });
  });

  it("keeps the existing relay when replacement handoff cannot be prepared", async () => {
    const { closed, registry } = createRegistry({
      handoffFailsFor: new Set(["u2"]),
    });

    await registry.start({
      room,
      workerUrl: "http://worker.test",
      workerToken: "token-a",
      controllerUserId: "u1",
      controllerDisplayName: "Ada",
      canReplaceExistingRelay: false,
    });

    await expect(
      registry.start({
        room,
        workerUrl: "http://worker.test",
        workerToken: "token-b",
        controllerUserId: "u2",
        controllerDisplayName: "Grace",
        canReplaceExistingRelay: true,
      }),
    ).resolves.toMatchObject({
      success: false,
      reason: "Transcript worker did not prepare SFU relay handoff.",
    });
    expect(closed).toEqual(["u2"]);
  });

  it("flushes buffered audio when the controller intentionally stops the relay", async () => {
    const { closeOptions, handoffsPrepared, registry } = createRegistry();

    await registry.start({
      room,
      workerUrl: "http://worker.test",
      workerToken: "token-a",
      controllerUserId: "u1",
      controllerDisplayName: "Ada",
      canReplaceExistingRelay: false,
    });

    await expect(
      registry.stopRoomForUser({
        roomKey: room.channelId,
        userId: "u1",
        canStopAnyRelay: false,
      }),
    ).resolves.toEqual({ success: true });

    expect(handoffsPrepared).toEqual(["u1"]);
    expect(closeOptions).toEqual([
      { controllerUserId: "u1", flushBufferedAudio: true },
    ]);
  });

  it("does not orphan a replacement relay started while a stop awaits its handoff", async () => {
    const closed: string[] = [];
    let releaseHandoff!: () => void;
    const handoffGate = new Promise<void>((resolve) => { releaseHandoff = resolve; });
    const registry = createTranscriptRelayRegistry({
      enabled: true,
      createRelay: (options) => ({
        controllerUserId: options.controllerUserId,
        start: async () => {},
        prepareHandoff: async () => {
          if (options.controllerUserId === "u1") await handoffGate;
          return true;
        },
        syncProducers: async () => {},
        close: () => { closed.push(options.controllerUserId); },
      }),
    });
    const start = (controllerUserId: string, canReplaceExistingRelay: boolean) =>
      registry.start({
        room,
        workerUrl: "http://worker.test",
        workerToken: `token-${controllerUserId}`,
        controllerUserId,
        controllerDisplayName: controllerUserId,
        canReplaceExistingRelay,
      });

    await start("u1", false);
    const stopping = registry.stopRoomForUser({
      roomKey: room.channelId,
      userId: "u1",
      canStopAnyRelay: false,
    });
    // A host replaces the relay while u1's stop is still preparing handoff.
    await expect(start("u2", true)).resolves.toMatchObject({ success: true });
    releaseHandoff();
    await expect(stopping).resolves.toEqual({ success: true });

    // u1's late stop must leave the replacement running; only the room stops it.
    expect(closed).toEqual(["u1"]);
    registry.stopRoom(room.channelId);
    expect(closed).toEqual(["u1", "u2"]);
  });

  it("leaves only the newest relay open when replacements overlap, and stop closes it", async () => {
    const opened: Array<{ closed: boolean; finishStart: () => void }> = [];
    const registry = createTranscriptRelayRegistry({
      enabled: true,
      createRelay: () => {
        let finishStart!: () => void;
        const started = new Promise<void>((resolve) => {
          finishStart = resolve;
        });
        const relay = { closed: false, finishStart: () => finishStart() };
        opened.push(relay);
        return {
          controllerUserId: "u1",
          start: () => started,
          prepareHandoff: async () => true,
          syncProducers: async () => {},
          close: () => {
            relay.closed = true;
          },
        };
      },
    });
    const start = () =>
      registry.start({
        room,
        workerUrl: "http://worker.test",
        workerToken: "token",
        controllerUserId: "u1",
        controllerDisplayName: "Ada",
        canReplaceExistingRelay: true,
      });

    const live = start();
    opened[0].finishStart();
    await live;
    const replacements = [start(), start()];
    opened[1].finishStart();
    opened[2].finishStart();
    await Promise.all(replacements);

    expect(opened.map(({ closed }) => closed)).toEqual([true, true, false]);
    registry.stopRoom(room.channelId);
    expect(opened.every(({ closed }) => closed)).toBe(true);
  });

  it("keeps a replacement that started while an older relay's stop was waiting", async () => {
    const opened: Array<{ closed: boolean; finishHandoff: () => void }> = [];
    const registry = createTranscriptRelayRegistry({
      enabled: true,
      createRelay: () => {
        let finishHandoff!: () => void;
        const handoff = new Promise<boolean>((resolve) => {
          finishHandoff = () => resolve(true);
        });
        const relay = { closed: false, finishHandoff: () => finishHandoff() };
        const first = opened.length === 0;
        opened.push(relay);
        return {
          controllerUserId: "u1",
          start: async () => {},
          prepareHandoff: () => (first ? handoff : Promise.resolve(true)),
          syncProducers: async () => {},
          close: () => {
            relay.closed = true;
          },
        };
      },
    });
    const start = () =>
      registry.start({
        room,
        workerUrl: "http://worker.test",
        workerToken: "token",
        controllerUserId: "u1",
        controllerDisplayName: "Ada",
        canReplaceExistingRelay: true,
      });
    await start();

    const stopping = registry.stopRoomForUser({
      roomKey: room.channelId,
      userId: "u1",
      canStopAnyRelay: true,
    });
    await start();
    opened[0].finishHandoff();
    await stopping;

    expect(opened.map(({ closed }) => closed)).toEqual([true, false]);
  });
});


describe("relay handoffs that overlap", () => {
  const overlapping = () => {
    const closed: string[] = [];
    const handoffs = new Map<string, Promise<boolean>>();
    const registry = createTranscriptRelayRegistry({
      enabled: true,
      createRelay: ({ workerToken, controllerUserId }) => ({
        controllerUserId,
        start: async () => {},
        prepareHandoff: async () => handoffs.get(workerToken) ?? true,
        syncProducers: async () => {},
        close: () => {
          closed.push(workerToken);
        },
      }),
    });
    const start = (workerToken: string) =>
      registry.start({
        room,
        workerUrl: "http://worker.test",
        workerToken,
        controllerUserId: "host",
        controllerDisplayName: "Host",
        canReplaceExistingRelay: true,
      });
    const stop = () =>
      registry.stopRoomForUser({ roomKey: room.channelId, userId: "host", canStopAnyRelay: true });
    const holdHandoff = (workerToken: string) => {
      let release!: () => void;
      handoffs.set(workerToken, new Promise<boolean>((resolve) => {
        release = () => resolve(true);
      }));
      return release;
    };
    return { closed, start, stop, holdHandoff };
  };

  it("a stop waiting on one relay never closes the three started after it", async () => {
    const { closed, start, stop, holdHandoff } = overlapping();
    await start("A");
    const release = holdHandoff("A");
    const stopping = stop();
    for (const workerToken of ["B", "C", "D"]) {
      expect((await start(workerToken)).success).toBe(true);
    }
    release();
    await stopping;

    expect(closed).toEqual(["A", "B", "C"]);
    await stop();
    expect(closed).toEqual(["A", "B", "C", "D"]);
  });

  it("closes a relay overtaken during its handoff and keeps the newer one open", async () => {
    const { closed, start, stop, holdHandoff } = overlapping();
    await start("A");
    const release = holdHandoff("B");
    const overtaken = start("B");
    await Promise.resolve();
    expect((await start("C")).success).toBe(true);
    release();
    await overtaken;

    expect(closed).toEqual(["A", "B"]);
    await stop();
    expect(closed).toEqual(["A", "B", "C"]);
  });
});

class FakeWorkerSocket {
  static OPEN = 1;
  static sockets: FakeWorkerSocket[] = [];
  static answering = new Set<string>();
  static opening = new Map<string, Promise<void>>();
  static failing = new Set<string>();
  readyState = 0;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: (() => void) | null = null;
  readonly token: string;

  constructor(url: string) {
    this.token = new URL(url).searchParams.get("token") ?? "";
    FakeWorkerSocket.sockets.push(this);
    void (FakeWorkerSocket.opening.get(this.token) ?? Promise.resolve()).then(() => {
      if (FakeWorkerSocket.failing.has(this.token)) {
        this.onerror?.();
        return;
      }
      this.readyState = 1;
      this.onopen?.();
    });
  }

  send(raw: string) {
    const message = JSON.parse(raw) as { type?: string; id?: string };
    if (message.type === "relay.handoff.prepare" && FakeWorkerSocket.answering.has(this.token)) {
      queueMicrotask(() =>
        this.onmessage?.({ data: JSON.stringify({ type: "relay.handoff.ready", id: message.id }) }),
      );
    }
  }

  close() {
    this.readyState = 3;
  }
}

describe("relay handoffs through the real worker client", () => {
  afterEach(() => {
    FakeWorkerSocket.sockets = [];
    FakeWorkerSocket.answering.clear();
    FakeWorkerSocket.opening.clear();
    FakeWorkerSocket.failing.clear();
    vi.unstubAllGlobals();
  });

  const workerFixture = () => {
    vi.stubGlobal("WebSocket", FakeWorkerSocket);
    const closed = new Set<string>();
    const synced: string[] = [];
    const registry = createTranscriptRelayRegistry({
      enabled: true,
      createRelay: ({ workerToken, controllerUserId }) => {
        const client = new TranscriptWorkerRelayClient({
          workerUrl: "http://worker.test",
          roomId: "room-a",
          token: workerToken,
        });
        return {
          controllerUserId,
          start: () => client.connect(),
          prepareHandoff: () => client.prepareHandoff(),
          syncProducers: async () => {
            synced.push(workerToken);
          },
          close: () => {
            closed.add(workerToken);
            client.close();
          },
        };
      },
    });
    const start = (workerToken: string) =>
      registry.start({
        room,
        workerUrl: "http://worker.test",
        workerToken,
        controllerUserId: "host",
        controllerDisplayName: "Host",
        canReplaceExistingRelay: true,
      });
    // The browser retries a failed start, and each start gets a new relay.
    const startLikeTheBrowser = async (workerToken: string) => {
      const first = await start(workerToken);
      if (first.success) return first;
      FakeWorkerSocket.answering.add(`${workerToken}-retry`);
      return start(`${workerToken}-retry`);
    };
    const stop = () => registry.stopRoom(room.channelId);
    const roomRelay = async () => {
      synced.length = 0;
      await registry.syncRoom(room);
      return synced[0];
    };
    return { closed, start, startLikeTheBrowser, stop, roomRelay };
  };

  it("reports an overtaken handoff as the room's relay, so the browser's retry never closes the winner", async () => {
    const { closed, start, startLikeTheBrowser, stop } = workerFixture();
    for (const token of ["C", "D"]) FakeWorkerSocket.answering.add(token);
    await start("A");
    const b = startLikeTheBrowser("B");
    await vi.waitFor(() => expect(FakeWorkerSocket.sockets.some(({ token }) => token === "B")).toBe(true));
    await Promise.resolve();

    const c = start("C");
    const d = start("D");
    const results = await Promise.all([b, c, d]);

    expect(results.map(({ success }) => success)).toEqual([true, true, true]);
    expect(closed.has("D")).toBe(false);
    expect([...closed].sort()).toEqual(["A", "B", "C"]);
    stop();
  });

  it("keeps the older start's relay running when the newer overlapping start fails to connect", async () => {
    const { closed, start, stop, roomRelay } = workerFixture();
    FakeWorkerSocket.answering.add("B");
    await start("A");
    let failC!: () => void;
    FakeWorkerSocket.opening.set("C", new Promise<void>((resolve) => { failC = resolve; }));
    FakeWorkerSocket.failing.add("C");
    const b = start("B");
    const c = start("C");
    await vi.waitFor(() => expect(FakeWorkerSocket.sockets.some(({ token }) => token === "B")).toBe(true));
    await new Promise((resolve) => setTimeout(resolve, 0));
    failC();
    const [fromB, fromC] = await Promise.all([b, c]);

    expect(fromC.success).toBe(false);
    expect(fromB.success).toBe(true);
    const running = await roomRelay();
    expect(running).toBe("B");
    expect(closed.has("B")).toBe(false);
    stop();
  });

  it("still fails a start that a stop overtook, so it never reports a stopped room's relay", async () => {
    const { closed, start, stop } = workerFixture();
    let openA!: () => void;
    FakeWorkerSocket.opening.set("A", new Promise<void>((resolve) => { openA = resolve; }));
    const a = start("A");
    await Promise.resolve();
    stop();
    openA();

    expect((await a).success).toBe(false);
    expect(closed.has("A")).toBe(true);
  });

  it("reports a start overtaken before its handoff as the room's relay", async () => {
    const { closed, startLikeTheBrowser, start, stop } = workerFixture();
    FakeWorkerSocket.answering.add("C");
    let openB!: () => void;
    FakeWorkerSocket.opening.set("B", new Promise<void>((resolve) => { openB = resolve; }));
    await start("A");
    const b = startLikeTheBrowser("B");
    await Promise.resolve();
    expect((await start("C")).success).toBe(true);
    openB();

    expect((await b).success).toBe(true);
    expect(closed.has("C")).toBe(false);
    stop();
  });
});

describe("a start reports success only while a relay runs", () => {
  const controlled = () => {
    const closed = new Set<string>();
    const synced: string[] = [];
    const starts = new Map<string, { finish: () => void; fail: () => void }>();
    const registry = createTranscriptRelayRegistry({
      enabled: true,
      createRelay: ({ workerToken, controllerUserId }) => ({
        controllerUserId,
        start: () =>
          new Promise<void>((resolve, reject) => {
            starts.set(workerToken, { finish: resolve, fail: () => reject(new Error("start failed")) });
          }),
        prepareHandoff: async () => true,
        syncProducers: async () => {
          synced.push(workerToken);
        },
        close: () => {
          closed.add(workerToken);
        },
      }),
    });
    const start = (workerToken: string) =>
      registry.start({
        room,
        workerUrl: "http://worker.test",
        workerToken,
        controllerUserId: "host",
        controllerDisplayName: "Host",
        canReplaceExistingRelay: true,
      });
    const roomRelay = async () => {
      synced.length = 0;
      await registry.syncRoom(room);
      return synced[0];
    };
    return { closed, starts, start, roomRelay, registry };
  };

  it("never reports success with no relay running when the newer of two overlapping starts fails", async () => {
    const { closed, starts, start, roomRelay, registry } = controlled();
    const b = start("B");
    const c = start("C");
    starts.get("B")!.finish();
    await Promise.resolve();
    await Promise.resolve();
    starts.get("C")!.fail();
    const results = await Promise.all([b, c]);

    const running = await roomRelay();
    if (results.some(({ success }) => success)) {
      expect(running).toBeDefined();
      expect(closed.has(running!)).toBe(false);
    }
    expect(results.map(({ success }) => success)).toEqual([true, false]);
    registry.closeAll();
  });

  it("lets the older start report the newer one's success once it runs", async () => {
    const { closed, starts, start, roomRelay, registry } = controlled();
    const b = start("B");
    const c = start("C");
    starts.get("B")!.finish();
    await Promise.resolve();
    starts.get("C")!.finish();
    const results = await Promise.all([b, c]);

    expect(results.map(({ success }) => success)).toEqual([true, true]);
    expect(await roomRelay()).toBe("C");
    expect(closed.has("C")).toBe(false);
    expect(closed.has("B")).toBe(true);
    registry.closeAll();
  });
});
