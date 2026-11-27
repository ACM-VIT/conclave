import { describe, expect, it } from "vitest";
import { buildSchedulingMeetingLink } from "../server/schedulingLinks.js";
import { publicMeetingView } from "../server/http/scheduledMeetingRoutes.js";
import type { ScheduledMeeting } from "../types.js";

describe("booking links", () => {
  it.each([
    ["conclave", "conclave"],
    ["default", "conclave"],
    ["acme", "acme"],
  ])(
    "name the %s booking's tenant, since the web app's own default may differ",
    (clientId, linkedClientId) => {
      const link = new URL(
        buildSchedulingMeetingLink("https://conclave.test", { clientId, roomCode: "intro-1234" }),
      );

      expect(link.pathname).toBe("/intro-1234");
      expect(link.searchParams.get("clientId")).toBe(linkedClientId);
    },
  );
});

describe("the public view of a booking", () => {
  it("tells the web app which tenant the booking belongs to", () => {
    const view = publicMeetingView({
      id: "meeting-1",
      clientId: "conclave",
      roomCode: "intro-1234",
      title: "Intro",
      hostName: "Host",
      hostEmail: "host@example.com",
      scheduledStartAt: 1,
      scheduledEndAt: 2,
      status: "scheduled",
      startedAt: null,
      endedAt: null,
    } as unknown as ScheduledMeeting);

    expect(view).toMatchObject({ clientId: "conclave", roomCode: "intro-1234" });
    expect(view).not.toHaveProperty("hostEmail");
  });
});
