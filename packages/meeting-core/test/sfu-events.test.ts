import { describe, expect, it } from "vitest";
import { SFU_EVENTS } from "../src/sfu-events";

describe("SFU_EVENTS", () => {
  it("keeps join-time snapshot events in the shared server event registry", () => {
    const serverEvents = new Set(Object.values(SFU_EVENTS.serverToClient));

    expect(Array.from(serverEvents)).toEqual(
      expect.arrayContaining([
        "displayNameSnapshot",
        "handRaisedSnapshot",
        "chatHistorySnapshot",
        "pendingUsersSnapshot",
      ]),
    );
  });

  it("keeps terminal room lifecycle events in the shared server event registry", () => {
    const serverEvents = new Set(Object.values(SFU_EVENTS.serverToClient));

    expect(Array.from(serverEvents)).toEqual(
      expect.arrayContaining([
        "kicked",
        "roomClosed",
        "roomEnded",
        "serverRestarting",
        "redirect",
      ]),
    );
  });
});
