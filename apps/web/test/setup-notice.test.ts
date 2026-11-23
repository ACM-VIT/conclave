import { describe, expect, it } from "vitest";
import {
  JOIN_REJECTED_MESSAGE,
  endedNotice,
  hiddenSetupView,
  joinRejectedUpdate,
  type SetupNotice,
} from "../src/app/lib/setup-notice";

const dismiss = (): SetupNotice | null => null;

const PROPER_NOUNS = new Set<string>();

const isSentenceCase = (text: string) => {
  const words = text.split(" ");
  if (!text.trim() || words.some((word) => !word)) return false;
  const [first, ...rest] = words;
  const firstOk = first.charAt(0) === first.charAt(0).toUpperCase() && first.charAt(0) !== first.charAt(0).toLowerCase() && first.slice(1) === first.slice(1).toLowerCase();
  return firstOk && rest.every((word) => PROPER_NOUNS.has(word) || word === word.toLowerCase());
};

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
    expect(view.headline).toBe("You weren't let in");
    expect(view.body).toBe(JOIN_REJECTED_MESSAGE);
    expect(view.action).toBe("retry");
    expect(view.busy).toBe(false);
  });

  it("keeps Webinar ended and Back to home for the ended kind only", () => {
    expect(
      hiddenSetupView({ notice: endedNotice("The webinar has ended."), errorMessage: "", isLoading: false }),
    ).toMatchObject({ headline: "Webinar ended", body: "The webinar has ended.", action: "home" });
  });

  it("uses sentence case for every hidden setup heading", () => {
    const headlines = [
      hiddenSetupView({ notice: joinRejectedUpdate().setupNotice, errorMessage: "", isLoading: false }).headline,
      hiddenSetupView({ notice: endedNotice("The webinar has ended."), errorMessage: "", isLoading: false }).headline,
      hiddenSetupView({ notice: null, errorMessage: "Something broke", isLoading: false }).headline,
      hiddenSetupView({ notice: null, errorMessage: "Room is not live yet", isLoading: false }).headline,
      hiddenSetupView({ notice: null, errorMessage: "", isLoading: true }).headline,
      hiddenSetupView({ notice: null, errorMessage: "", isLoading: false }).headline,
    ];
    for (const headline of headlines) expect(isSentenceCase(headline)).toBe(true);
  });

  it("tells sentence case apart from empty, title case and all caps headings", () => {
    expect(isSentenceCase("You weren't let in")).toBe(true);
    expect(isSentenceCase("")).toBe(false);
    expect(isSentenceCase("you weren't let in")).toBe(false);
    expect(isSentenceCase("You Weren't Let In")).toBe(false);
    expect(isSentenceCase("WEBINAR ENDED")).toBe(false);
  });
});
