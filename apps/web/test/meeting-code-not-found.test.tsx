// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MotionGlobalConfig } from "motion/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import MeetingEnterOverlay from "../src/app/components/MeetingEnterOverlay";
import { createMeetError } from "../src/app/lib/utils";

vi.mock("../src/app/components/ConclaveLottie", () => ({ default: () => null }));
vi.mock("../src/app/lib/conclaveSound", () => ({ playConclaveLock: () => {} }));

let root: Root;
let host: HTMLDivElement;

const buttons = () =>
  Array.from(host.querySelectorAll("button")).map((button) => button.textContent);
const clickButton = async (label: string) => {
  const button = Array.from(host.querySelectorAll("button")).find(
    (candidate) => candidate.textContent === label,
  );
  if (!button) throw new Error(`No button "${label}" in ${buttons().join(", ")}`);
  await act(async () => button.click());
};

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  MotionGlobalConfig.skipAnimations = true;
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

describe("joining a meeting code that does not exist", () => {
  it("classifies the SFU's reply as a missing room", () => {
    expect(createMeetError(new Error("No room found."))).toEqual({
      code: "ROOM_NOT_FOUND",
      message: "No room found.",
      recoverable: true,
    });
  });

  it("asks the visitor to check the code before anyone becomes host", async () => {
    const onDismiss = vi.fn();
    const onStartNewMeeting = vi.fn();
    await act(async () =>
      root.render(
        <MeetingEnterOverlay
          show
          action="join"
          roomId="qwe-rtyu-iop"
          error={createMeetError(new Error("No room found."))}
          dismissLabel="Return to home screen"
          onDismiss={onDismiss}
          onStartNewMeeting={onStartNewMeeting}
        />,
      ),
    );

    expect(host.textContent).toContain("Check your meeting code");
    expect(host.textContent).toContain("There's no meeting at qwe-rtyu-iop");
    expect(host.textContent).not.toContain("Something went wrong");
    expect(buttons()).toEqual([
      "Return to home screen",
      "Start a new meeting instead",
    ]);

    await clickButton("Start a new meeting instead");
    expect(onStartNewMeeting).toHaveBeenCalledTimes(1);
    await clickButton("Return to home screen");
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it("keeps other join failures on the retry path", async () => {
    await act(async () =>
      root.render(
        <MeetingEnterOverlay
          show
          action="join"
          roomId="abc-mnop-xyz"
          error={createMeetError(new Error("Connection lost"))}
          onRetry={() => {}}
          onDismiss={() => {}}
        />,
      ),
    );

    expect(host.textContent).toContain("Couldn't join the meeting");
    expect(buttons()).toEqual(["Try again", "Back to setup"]);
  });
});
