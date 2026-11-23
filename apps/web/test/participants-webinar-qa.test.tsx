// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import ParticipantsPanel from "../src/app/components/ParticipantsPanel";
import type { WebinarQaEntry } from "../src/app/lib/types";

let root: Root;
let container: HTMLDivElement;

const question: WebinarQaEntry = {
  id: "q1",
  userId: "gia#1",
  displayName: "Gia",
  question: "Is this recorded?",
  status: "pending",
  askedAt: 1,
  updatedAt: 1,
  upvotes: 0,
};

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

it("keeps a webinar host's question actions in place but sends nothing while the list comes back", async () => {
  const onModerateWebinarQuestion = vi.fn(async () => ({ ok: true }));
  await act(async () =>
    root.render(
      <ParticipantsPanel
        participants={new Map()}
        currentUserId="host#1"
        onClose={() => {}}
        getDisplayName={(userId) => userId}
        socket={null}
        isAdmin
        webinarEnabled
        webinarQaEntries={[question]}
        onModerateWebinarQuestion={onModerateWebinarQuestion}
        webinarQaWaiting
      />,
    ),
  );
  const card = container.querySelector<HTMLElement>('[data-testid="webinar-host-question"]')!;
  const actions = Array.from(card.querySelectorAll<HTMLButtonElement>("button"));
  await act(async () => {
    for (const button of actions) button.click();
  });

  expect(onModerateWebinarQuestion).not.toHaveBeenCalled();
  expect(actions.map((button) => button.textContent)).toEqual(["Answer live", "Mark answered", "Hide"]);
  expect(actions.every((button) => button.disabled)).toBe(true);
});
