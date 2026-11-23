import { describe, expect, it } from "vitest";
import {
  JOIN_REJECTED_MESSAGE,
  hiddenSetupView,
  joinRejectedUpdate,
  setupNotice,
} from "../src/app/lib/join-rejection";

describe("a waiting guest the host rejects", () => {
  it("shows the reason on setup until it is dismissed", () => {
    const rejected = joinRejectedUpdate();
    expect(rejected.connectionState).toBe("error");
    expect(rejected.waitingMessage).toBeNull();
    expect(rejected.meetError.code).toBe("JOIN_REJECTED");
    expect(setupNotice(rejected.joinRejection, null)).toEqual({
      kind: "rejected",
      message: JOIN_REJECTED_MESSAGE,
    });
    const dismissed = null;
    expect(setupNotice(dismissed, null)).toBeNull();
  });

  it("keeps the rejection apart from a meeting that ended", () => {
    const rejected = joinRejectedUpdate();
    expect(setupNotice(rejected.joinRejection, "The host ended the meeting.")?.kind).toBe("rejected");
    expect(setupNotice(null, "The host ended the meeting.")).toEqual({
      kind: "ended",
      message: "The host ended the meeting.",
    });
  });

  it("shows the rejection with Try again when setup is hidden, not an ending", () => {
    const rejected = joinRejectedUpdate();
    const view = hiddenSetupView({
      joinRejection: rejected.joinRejection,
      meetingEndedNotice: null,
      errorMessage: rejected.meetError.message,
      isLoading: false,
    });
    expect(view.headline).not.toMatch(/ended/i);
    expect(view.body).toBe(JOIN_REJECTED_MESSAGE);
    expect(view.action).toBe("retry");
    expect(view.busy).toBe(false);
  });

  it("still shows a webinar ending with Back to home when setup is hidden", () => {
    expect(
      hiddenSetupView({ joinRejection: null, meetingEndedNotice: "The webinar has ended.", errorMessage: "", isLoading: false }),
    ).toMatchObject({ headline: "Webinar ended", action: "home" });
  });
});
