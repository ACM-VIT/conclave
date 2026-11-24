import { describe, expect, it } from "vitest";
import type { Room } from "../config/classes/Room.js";
import { createTranscriptRelayRegistry } from "../server/transcript/relayRegistry.js";

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

    // The replacement is still registered, so the room can stop it.
    registry.stopRoom(room.channelId);
    expect(closed).toContain("u2");
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
