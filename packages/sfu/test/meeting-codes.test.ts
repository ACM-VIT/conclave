import { describe, expect, it } from "vitest";
import { createMeeting } from "../server/controlPlane/meetingCommands.js";
import { createSfuState } from "../server/state.js";

describe("scheduled meeting codes", () => {
  it("gives a meeting without a chosen code a long Meet-style one", async () => {
    const { controlPlane } = createSfuState();
    const codes: string[] = [];
    for (let index = 0; index < 200; index += 1) {
      const result = await controlPlane.commit(createMeeting(
        { title: `Meeting ${index}`, scheduledStartAt: Date.now() + 60_000 },
        {
          clientId: "conclave",
          createdBy: "host@example.com",
          defaultHostEmail: "host@example.com",
          defaultHostUserId: null,
        },
      ));
      if (!result.ok) throw Error(result.message ?? result.reason);
      codes.push(result.value.roomCode);
    }
    for (const code of codes) expect(code).toMatch(/^[a-z]{3}-[a-z]{4}-[a-z]{3}$/);
    expect(new Set(codes).size).toBe(codes.length);
  });
});
