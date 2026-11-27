import { SFU_EVENTS } from "@conclave/meeting-core/sfu-events";
import { describe, expect, it, vi } from "vitest";
import { createProducerTransportNetworkProfileSetter } from "../src/app/lib/producer-transport-network-profile";

function createRig() {
  type Socket = NonNullable<
    Parameters<typeof createProducerTransportNetworkProfileSetter>[0]["current"]
  >;
  const emit = vi.fn<Socket["emit"]>((_event, payload, acknowledge) => {
    acknowledge({ ...payload, success: true, maxIncomingBitrate: 400_000 });
  });
  const socket = { connected: true, io: { engine: {} }, emit };
  const transportRef = { current: { id: "transport-1", closed: false } };
  const setProfile = createProducerTransportNetworkProfileSetter(
    { current: socket },
    transportRef,
  );
  return { emit, setProfile, socket, transportRef };
}

describe("producer transport network profile", () => {
  it("returns the acknowledged application without emitting the same profile twice", async () => {
    const { emit, setProfile } = createRig();
    const application = {
      transportId: "transport-1",
      profile: "good",
      maxIncomingBitrate: 400_000,
    };

    await expect(setProfile("good")).resolves.toEqual(application);
    await expect(setProfile("good")).resolves.toEqual(application);

    expect(emit).toHaveBeenCalledExactlyOnceWith(
      SFU_EVENTS.clientToServer.setProducerTransportNetworkProfile,
      { transportId: "transport-1", profile: "good" },
      expect.any(Function),
    );
  });

  it("sends again for a changed profile, connection, or transport", async () => {
    const { emit, setProfile, socket, transportRef } = createRig();
    await setProfile("good");
    await setProfile("fair");
    socket.io.engine = {};
    await setProfile("fair");
    transportRef.current = { id: "transport-2", closed: false };
    await setProfile("fair");

    expect(emit.mock.calls.map(([, payload]) => payload)).toEqual([
      { transportId: "transport-1", profile: "good" },
      { transportId: "transport-1", profile: "fair" },
      { transportId: "transport-1", profile: "fair" },
      { transportId: "transport-2", profile: "fair" },
    ]);
  });

  it("resends the previous profile after a failed change", async () => {
    const { emit, setProfile } = createRig();
    await setProfile("good");
    emit.mockImplementationOnce((_event, _payload, acknowledge) => {
      acknowledge({ error: "Change failed" });
    });

    await expect(setProfile("fair")).rejects.toThrow("Change failed");
    await expect(setProfile("good")).resolves.toMatchObject({ profile: "good" });
    expect(emit).toHaveBeenCalledTimes(3);
  });
});
