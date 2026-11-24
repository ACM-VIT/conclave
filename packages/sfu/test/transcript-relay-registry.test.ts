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

    expect(new Set(closed)).toEqual(new Set(["A", "B", "C"]));
    await stop();
    expect(new Set(closed)).toEqual(new Set(["A", "B", "C", "D"]));
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

    expect(new Set(closed)).toEqual(new Set(["A", "B"]));
    await stop();
    expect(new Set(closed)).toEqual(new Set(["A", "B", "C"]));
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
      expect(closed.has(running)).toBe(false);
    }
    expect(results.map(({ success }) => success)).toEqual([false, false]);
    expect(running).toBeUndefined();
    registry.closeAll();
  });

});

describe("a start's outcome is decided when it is returned", () => {
  it("fails an overtaken start when a room stop closes the winner before the start returns", async () => {
    const relays: { ready: () => void; rejectClosed: () => void; open: boolean }[] = [];
    const registry = createTranscriptRelayRegistry({
      enabled: true,
      createRelay: () => {
        let ready!: () => void;
        let rejectClosed!: () => void;
        const started = new Promise<void>((resolve, reject) => {
          ready = resolve;
          rejectClosed = () => reject(new Error("Transcript SFU relay was closed before it started."));
        });
        const relay = { ready, rejectClosed, open: true };
        relays.push(relay);
        return {
          controllerUserId: "host",
          start: () => started,
          prepareHandoff: async () => true,
          syncProducers: async () => {},
          close: () => {
            relay.open = false;
          },
        };
      },
    });
    const start = () =>
      registry.start({
        room,
        workerUrl: "http://worker.test",
        workerToken: "token",
        controllerUserId: "host",
        controllerDisplayName: "Host",
        canReplaceExistingRelay: true,
      });
    const older = start();
    const newer = start();
    relays[1].ready();
    expect((await newer).success).toBe(true);
    expect(relays[0].open).toBe(false);

    relays[0].rejectClosed();
    queueMicrotask(() => registry.stopRoom(room.channelId));
    const result = await older;

    expect(relays.some(({ open }) => open)).toBe(false);
    expect(result.success).toBe(false);
  });
});

describe("a stop clears the room whatever handoffs are pending", () => {
  it("lets another participant start after a stop lands while a replacement awaits its handoff", async () => {
    const closed = new Set<string>();
    const synced: string[] = [];
    const pendingHandoffs: { workerToken: string; settle: (ok: boolean) => void }[] = [];
    const registry = createTranscriptRelayRegistry({
      enabled: true,
      createRelay: ({ workerToken, controllerUserId }) => ({
        controllerUserId,
        start: async () => {},
        prepareHandoff: () =>
          new Promise<boolean>((settle) => {
            pendingHandoffs.push({ workerToken, settle });
          }),
        syncProducers: async () => {
          synced.push(workerToken);
        },
        close: () => {
          closed.add(workerToken);
        },
      }),
    });
    const start = (workerToken: string, controllerUserId: string, canReplaceExistingRelay: boolean) =>
      registry.start({
        room,
        workerUrl: "http://worker.test",
        workerToken,
        controllerUserId,
        controllerDisplayName: controllerUserId,
        canReplaceExistingRelay,
      });
    const settleNext = async (ok: boolean) => {
      await vi.waitFor(() => expect(pendingHandoffs.length).toBeGreaterThan(0));
      pendingHandoffs.shift()!.settle(ok);
      for (let tick = 0; tick < 10; tick += 1) await Promise.resolve();
    };

    expect((await start("A", "participant-1", false)).success).toBe(true);
    const replacement = start("B", "host", true);
    await vi.waitFor(() => expect(pendingHandoffs).toHaveLength(1));
    const stopping = registry.stopRoomForUser({ roomKey: room.channelId, userId: "host", canStopAnyRelay: true });
    await vi.waitFor(() => expect(pendingHandoffs).toHaveLength(2));
    await settleNext(false);
    await settleNext(false);

    expect((await replacement).success).toBe(false);
    expect(await stopping).toEqual({ success: true });
    expect([...closed].sort()).toEqual(["A", "B"]);
    synced.length = 0;
    await registry.syncRoom(room);
    expect(synced, "no relay is left recorded for the room").toEqual([]);

    const next = start("C", "participant-2", false);
    expect((await next).success).toBe(true);
    await registry.syncRoom(room);
    expect(synced).toEqual(["C"]);
    registry.closeAll();
  });
});

describe("a start's success always comes with a running relay", () => {
  type FakeRelay = {
    token: string;
    open: boolean;
    started: boolean;
    settled: boolean;
    finishStart: () => void;
    failStart: () => void;
    handoffs: ((ok: boolean) => void)[];
  };
  const harness = ({ holdHandoffs = false } = {}) => {
    const made: FakeRelay[] = [];
    const synced: string[] = [];
    const registry = createTranscriptRelayRegistry({
      enabled: true,
      createRelay: ({ workerToken, controllerUserId }) => {
        let finishStart!: () => void;
        let failStart!: () => void;
        const started = new Promise<void>((resolve, reject) => {
          finishStart = resolve;
          failStart = () => reject(new Error("Transcript SFU relay was closed before it started."));
        });
        const relay: FakeRelay = {
          token: workerToken,
          open: true,
          started: false,
          settled: false,
          finishStart: () => {
            relay.settled = true;
            finishStart();
          },
          failStart: () => {
            relay.settled = true;
            failStart();
          },
          handoffs: [],
        };
        void started.then(
          () => {
            relay.started = true;
          },
          () => {},
        );
        made.push(relay);
        return {
          controllerUserId,
          start: () => started,
          prepareHandoff: () =>
            holdHandoffs
              ? new Promise<boolean>((settle) => {
                  relay.handoffs.push(settle);
                })
              : Promise.resolve(true),
          syncProducers: async () => {
            synced.push(workerToken);
          },
          close: () => {
            relay.open = false;
            for (const settle of relay.handoffs.splice(0)) settle(false);
          },
        };
      },
    });
    let nextToken = 0;
    const violations: string[] = [];
    const start = () => {
      const workerToken = `relay-${nextToken++}`;
      const result = registry.start({
        room,
        workerUrl: "http://worker.test",
        workerToken,
        controllerUserId: "host",
        controllerDisplayName: "Host",
        canReplaceExistingRelay: true,
      });
      const checked = result.then((response) => {
        if (!response.success) return response;
        synced.length = 0;
        void registry.syncRoom(room);
        const current = made.find(({ token }) => token === synced[0]);
        if (!current || !current.open || !current.started) {
          violations.push(`${workerToken} reported success with ${current?.token ?? "no relay"} not running`);
        }
        return response;
      });
      return checked;
    };
    return { made, registry, start, violations };
  };
  const flush = async () => {
    for (let tick = 0; tick < 20; tick += 1) await Promise.resolve();
  };

  it("fails an overtaken start when the winner is stopped and a third start is still pending", async () => {
    const { made, registry } = harness();
    const options = {
      room,
      workerUrl: "http://worker.test",
      workerToken: "relay",
      controllerUserId: "host",
      controllerDisplayName: "Host",
      canReplaceExistingRelay: true,
    };
    const older = registry.start(options);
    const newer = registry.start(options);
    made[1].finishStart();
    expect((await newer).success).toBe(true);
    expect(made[0].open).toBe(false);

    made[0].failStart();
    let third!: Promise<unknown>;
    queueMicrotask(() => {
      registry.stopRoom(room.channelId);
      third = registry.start(options);
    });
    const result = await older;

    expect(made.slice(0, 2).every(({ open }) => !open)).toBe(true);
    expect(made[2].started).toBe(false);
    expect(result.success).toBe(false);
    made[2].failStart();
    await third;
  });

  it.each(Array.from({ length: 300 }, (_, index) => index + 1))("random starts and stops, seed %i", async (seed) => {
    let state = seed;
    const random = () => {
      state = (state + 0x6d2b79f5) | 0;
      let value = Math.imul(state ^ (state >>> 15), state | 1);
      value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
      return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
    };
    const { made, registry, start, violations } = harness({ holdHandoffs: seed % 2 === 0 });
    const results: Promise<unknown>[] = [];
    for (let step = 0; step < 14; step += 1) {
      const roll = random();
      const pending = made.filter((relay) => !relay.settled);
      const awaitingHandoff = made.filter((relay) => relay.handoffs.length > 0);
      if (roll < 0.3) results.push(start());
      else if (roll < 0.5 && pending.length) pending[Math.floor(random() * pending.length)].finishStart();
      else if (roll < 0.6 && pending.length) pending[Math.floor(random() * pending.length)].failStart();
      else if (roll < 0.75 && awaitingHandoff.length) {
        const relay = awaitingHandoff[Math.floor(random() * awaitingHandoff.length)];
        relay.handoffs.shift()!(random() < 0.7);
      } else if (roll < 0.83) registry.stopRoom(room.channelId);
      else if (roll < 0.9) {
        if (pending.length) pending[Math.floor(random() * pending.length)].failStart();
        queueMicrotask(() => {
          registry.stopRoom(room.channelId);
          results.push(start());
        });
      } else void registry.stopRoomForUser({ roomKey: room.channelId, userId: "host", canStopAnyRelay: true });
      await flush();
    }
    for (const relay of made) {
      if (!relay.settled) (relay.open ? relay.finishStart : relay.failStart)();
      for (const settle of relay.handoffs.splice(0)) settle(true);
    }
    await flush();
    for (const relay of made) for (const settle of relay.handoffs.splice(0)) settle(true);
    await Promise.all(results);

    expect(violations).toEqual([]);
    registry.closeAll();
  });
});

describe("who controls the relay when a replacement races its controller's seat (Daybreak, Greptile)", () => {
  type Starter = "owner" | "host" | "admin";
  type Timing = "before" | "while it starts" | "while it hands off" | "after";
  type Outcome = "starts" | "fails to start" | "cannot hand off";
  const lostControl: unknown = { error: expect.any(String) as unknown };
  const turns = async () => {
    for (let turn = 0; turn < 20; turn += 1) await Promise.resolve();
  };

  const rig = (outcome: Outcome, timing: Timing) => {
    const made: Array<{ closed: boolean }> = [];
    let release = () => {};
    const hold = () =>
      new Promise<void>((resolve) => {
        release = resolve;
      });
    const registry = createTranscriptRelayRegistry({
      enabled: true,
      createRelay: (options) => {
        const relay = { closed: false };
        const replacement = made.push(relay) === 2;
        let handedOff = false;
        return {
          controllerUserId: options.controllerUserId,
          start: async () => {
            if (replacement && timing === "while it starts") await hold();
            if (replacement && outcome === "fails to start") throw new Error("start failed");
          },
          prepareHandoff: async () => {
            if (replacement && timing === "while it hands off" && !handedOff) {
              handedOff = true;
              await hold();
            }
            return !(replacement && outcome === "cannot hand off");
          },
          syncProducers: async () => {},
          close: () => {
            relay.closed = true;
          },
        };
      },
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
    const stopAs = (userId: string, canStopAnyRelay = false) =>
      registry.stopRoomForUser({ roomKey: room.channelId, userId, canStopAnyRelay });
    const open = () => made.flatMap((relay, index) => (relay.closed ? [] : [index]));
    return { registry, start, stopAs, open, release: () => release() };
  };

  const starters: Starter[] = ["owner", "host", "admin"];
  const midway = (timing: Timing) => timing === "while it starts" || timing === "while it hands off";
  const fits = (timing: Timing, outcome: Outcome) =>
    !(timing === "while it hands off" && outcome === "fails to start");

  it.each(
    starters.flatMap((starter) =>
      (["before", "while it starts", "while it hands off", "after"] as Timing[]).flatMap((timing) =>
        (["starts", "fails to start", "cannot hand off"] as Outcome[])
          .filter((outcome) => fits(timing, outcome))
          .map((outcome) => [starter, timing, outcome] as const),
      ),
    ),
  )("a replacement by the %s, the controller back under a new seat %s, and one that %s", async (starter, timing, outcome) => {
    const relays = rig(outcome, timing);
    await relays.start("seat-a", false);
    const rejoin = () =>
      relays.registry.handOver({ roomKey: room.channelId, fromUserId: "seat-a", toUserId: "seat-b" });

    if (timing === "before") rejoin();
    const starterId = starter === "owner" ? (timing === "before" ? "seat-b" : "seat-a") : starter;
    const replacing = relays.start(starterId, starter !== "owner");
    await turns();
    if (midway(timing)) rejoin();
    relays.release();
    const result = await replacing;
    if (timing === "after") rejoin();

    const replaced = outcome === "starts";
    expect(result).toMatchObject({ success: replaced });
    expect(relays.open()).toEqual([replaced ? 1 : 0]);
    const owner = replaced && starter !== "owner" ? starter : "seat-b";
    expect(await relays.stopAs("seat-a")).toEqual(lostControl);
    if (owner !== "seat-b") expect(await relays.stopAs("seat-b")).toEqual(lostControl);
    expect(await relays.stopAs(owner)).toEqual({ success: true });
    expect(relays.open()).toEqual([]);
  });

  it.each(
    starters.flatMap((starter) =>
      (["before", "while it starts", "while it hands off", "after"] as Timing[])
        .filter((timing) => starter !== "owner" || timing !== "before")
        .flatMap((timing) =>
          (["starts", "fails to start", "cannot hand off"] as Outcome[])
            .filter((outcome) => fits(timing, outcome))
            .map((outcome) => [starter, timing, outcome] as const),
        ),
    ),
  )("a replacement by the %s, the controller's seat ending %s, and one that %s", async (starter, timing, outcome) => {
    const relays = rig(outcome, timing);
    await relays.start("seat-a", false);
    const leave = () => relays.registry.releaseSeat({ roomKey: room.channelId, userId: "seat-a" });

    if (timing === "before") await leave();
    const starterId = starter === "owner" ? "seat-a" : starter;
    const replacing = relays.start(starterId, starter !== "owner");
    await turns();
    if (midway(timing)) {
      await leave();
      expect(relays.open()).toEqual(starter === "owner" ? [] : [1]);
    }
    relays.release();
    await replacing;
    if (timing === "after") await leave();

    const kept =
      starter !== "owner" &&
      (outcome === "starts" || (outcome === "cannot hand off" && timing !== "after"));
    expect(relays.open()).toEqual(kept ? [1] : []);
    expect(await relays.stopAs("seat-a")).toEqual(kept ? lostControl : { success: true });
    if (kept) {
      expect(await relays.stopAs(starter)).toEqual({ success: true });
      expect(relays.open()).toEqual([]);
    }
  });

  it.each(
    (["owner", "host"] as const).flatMap((starter) =>
      (["its starter stops it", "the room closes", "the server shuts down"] as const).flatMap((stop) =>
        (["while it starts", "while it hands off"] as Timing[]).map((timing) => [starter, stop, timing] as const),
      ),
    ),
  )("a replacement by the %s that ends because %s %s leaves nothing running", async (starter, stop, timing) => {
    const relays = rig("starts", timing);
    await relays.start("seat-a", false);
    const starterId = starter === "owner" ? "seat-a" : "host";
    const replacing = relays.start(starterId, starter !== "owner");
    await turns();

    if (stop === "its starter stops it") {
      expect(await relays.stopAs(starterId, starter !== "owner")).toEqual({ success: true });
    } else if (stop === "the room closes") {
      relays.registry.stopRoom(room.channelId);
    } else {
      relays.registry.closeAll();
    }

    expect(relays.open()).toEqual([]);
    relays.release();
    expect(await replacing).toMatchObject({ success: false });
    expect(relays.open()).toEqual([]);
    expect(await relays.start("seat-c", false)).toMatchObject({ success: true });
    expect(relays.open()).toEqual([2]);
  });
});
