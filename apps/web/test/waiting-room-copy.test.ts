import { describe, expect, it } from "vitest";
import { describeWaitingRoom } from "../src/app/components/MeetsWaitingScreen";

describe("what a knocking guest reads", () => {
  it("asks to join a meeting that makes people knock", () => {
    expect(
      describeWaitingRoom("This meeting is locked. Waiting for the host to let you in."),
    ).toEqual({
      title: "Asking to join…",
      detail: "You'll join the call when someone lets you in.",
    });
  });

  it("says when no host is there to let anyone in", () => {
    expect(describeWaitingRoom("No one to let you in.").title).toBe(
      "No one can let you in yet",
    );
  });

  it("says when a host is back", () => {
    expect(describeWaitingRoom("A host is available to let you in.").detail).toBe(
      "A host is here now and can let you in.",
    );
  });

  it("says the meeting ended under them, and that they can still be let in", () => {
    expect(
      describeWaitingRoom(
        "The meeting ended when everyone left. No one to let you in until it starts again.",
      ),
    ).toEqual({
      title: "This meeting has ended",
      detail: "Everyone left. Stay on this page and a host can let you in when it starts again.",
    });
  });

  it("asks to join before the server has said anything", () => {
    expect(describeWaitingRoom(null).title).toBe("Asking to join…");
  });
});
