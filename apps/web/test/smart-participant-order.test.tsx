// @vitest-environment happy-dom
import { act, startTransition, StrictMode, useEffect, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useSmartParticipantOrder } from "../src/app/hooks/useSmartParticipantOrder";

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function Prejoin() {
  const [guest, setGuest] = useState({ name: "" });
  useEffect(() => {
    startTransition(() => setGuest({ name: "Stored guest" }));
    setGuest((previous) => ({ ...previous, name: "Bob" }));
  }, []);
  const participants = useSmartParticipantOrder([], null);
  return guest.name && participants.length === 0 ? <button>Join</button> : null;
}

it("renders Join when pre-join setup updates state alongside an empty roster", async () => {
  const reportError = console.error;
  vi.spyOn(console, "error").mockImplementation((message, ...args) => {
    if (String(message).includes("Maximum update depth exceeded")) {
      throw new Error(String(message));
    }
    reportError(message, ...args);
  });
  await act(async () => root.render(<StrictMode><Prejoin /></StrictMode>));
  expect(container.querySelector("button")?.textContent).toBe("Join");
});

function ParticipantList({ raised }: { raised: string[] }) {
  const participants = useSmartParticipantOrder(
    ["Ada", "Bo", "Chen", "Dev"].map((userId) => ({
      userId,
      isHandRaised: raised.includes(userId),
    })),
    null,
  );
  return <ol>{participants.map(({ userId }) => <li key={userId}>{userId}</li>)}</ol>;
}

it("keeps hands in raise order when the roster is rebuilt and a hand is raised again", async () => {
  const show = async (raised: string[]) => {
    await act(async () => root.render(<StrictMode><ParticipantList raised={raised} /></StrictMode>));
    return Array.from(container.querySelectorAll("li"), (element) => element.textContent);
  };

  expect(await show(["Chen"])).toEqual(["Chen", "Ada", "Bo", "Dev"]);
  expect(await show(["Chen", "Ada"])).toEqual(["Chen", "Ada", "Bo", "Dev"]);
  expect(await show(["Ada"])).toEqual(["Ada", "Chen", "Bo", "Dev"]);
  expect(await show(["Ada", "Chen"])).toEqual(["Ada", "Chen", "Bo", "Dev"]);
});
