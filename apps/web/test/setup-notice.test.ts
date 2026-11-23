import { describe, expect, it } from "vitest";
import {
  JOIN_REJECTED_MESSAGE,
  endedNotice,
  hiddenSetupView,
  joinRejectedUpdate,
  type SetupNotice,
} from "../src/app/lib/setup-notice";

const dismiss = (): SetupNotice | null => null;

describe("a waiting guest the host rejects", () => {
  it("shows the reason on setup until it is dismissed", () => {
    const rejected = joinRejectedUpdate();
    expect(rejected.connectionState).toBe("error");
    expect(rejected.waitingMessage).toBeNull();
    expect(rejected.meetError.code).toBe("JOIN_REJECTED");
    let notice: SetupNotice | null = rejected.setupNotice;
    expect(notice).toEqual({ kind: "rejected", message: JOIN_REJECTED_MESSAGE });
    notice = dismiss();
    expect(notice).toBeNull();
  });

  it("is a rejection, not an ending", () => {
    expect(joinRejectedUpdate().setupNotice.kind).toBe("rejected");
    expect(endedNotice("The host ended the meeting.")).toEqual({
      kind: "ended",
      message: "The host ended the meeting.",
    });
  });

  it("shows the rejection with Try again when setup is hidden, not an ending", () => {
    const rejected = joinRejectedUpdate();
    const view = hiddenSetupView({
      notice: rejected.setupNotice,
      errorMessage: rejected.meetError.message,
      isLoading: false,
    });
    expect(view.headline).not.toMatch(/ended/i);
    expect(view.body).toBe(JOIN_REJECTED_MESSAGE);
    expect(view.action).toBe("retry");
    expect(view.busy).toBe(false);
  });

  it("keeps Webinar ended and Back to home for the ended kind only", () => {
    expect(
      hiddenSetupView({ notice: endedNotice("The webinar has ended."), errorMessage: "", isLoading: false }),
    ).toMatchObject({ headline: "Webinar ended", body: "The webinar has ended.", action: "home" });
  });
});
