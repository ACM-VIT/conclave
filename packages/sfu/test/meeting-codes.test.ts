import { describe, expect, it } from "vitest";
import {
  createScheduledMeeting,
  createScheduledMeetingStore,
} from "../server/scheduledMeetings.js";

describe("scheduled meeting codes", () => {
  it("gives a meeting without a chosen code a long Meet-style one", () => {
    const store = createScheduledMeetingStore();
    const codes = Array.from({ length: 200 }, (_, index) =>
      createScheduledMeeting(
        store,
        { title: `Meeting ${index}`, scheduledStartAt: Date.now() + 60_000 },
        {
          clientId: "conclave",
          createdBy: "host@example.com",
          defaultHostEmail: "host@example.com",
          defaultHostUserId: null,
        },
      ).roomCode,
    );
    for (const code of codes) expect(code).toMatch(/^[a-z]{3}-[a-z]{4}-[a-z]{3}$/);
    expect(new Set(codes).size).toBe(codes.length);
  });
});
