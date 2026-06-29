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
        prepareHandoff: async () =>
          !registryOptions.handoffFailsFor?.has(options.controllerUserId),
        syncProducers: async () => {},
        close: () => {
          closed.push(options.controllerUserId);
        },
      };
    },
    });
  return { closed, registry, relays };
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
});
