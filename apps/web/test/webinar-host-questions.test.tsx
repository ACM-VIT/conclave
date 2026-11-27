// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import ParticipantsPanel from "../src/app/components/ParticipantsPanel";
import type { WebinarQaEntry, WebinarQaModerateRequest } from "../src/app/lib/types";

let root: Root;
let container: HTMLDivElement;

const entry = (overrides: Partial<WebinarQaEntry>): WebinarQaEntry => ({
  id: "q1",
  userId: "",
  displayName: "Gia",
  question: "Is this recorded?",
  status: "pending",
  askedAt: 1,
  updatedAt: 1,
  upvotes: 0,
  ...overrides,
});

const render = async (
  entries: WebinarQaEntry[],
  onModerate: (request: WebinarQaModerateRequest) => Promise<{ ok: boolean }>,
) => {
  await act(async () =>
    root.render(
      <ParticipantsPanel
        participants={new Map()}
        currentUserId="asha#1"
        onClose={() => {}}
        getDisplayName={(userId) => userId}
        socket={null}
        isAdmin
        webinarEnabled
        webinarQaEntries={entries}
        onModerateWebinarQuestion={onModerate}
      />,
    ),
  );
};

/** The Questions section's card for a question, and the buttons on it. */
const card = (question: string) =>
  Array.from(container.querySelectorAll<HTMLElement>('[data-testid="webinar-host-question"]')).find(
    (element) => element.textContent?.includes(question),
  );
const buttonsOf = (question: string) =>
  Array.from(card(question)?.querySelectorAll("button") ?? []).map((button) =>
    button.textContent?.trim(),
  );

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

it("keeps a question the host hid in the webinar host's Questions section, with Unhide", async () => {
  const onModerate = vi.fn(async () => ({ ok: true }));
  await render(
    [
      entry({ id: "open", question: "When do the slides go out?", upvotes: 3 }),
      entry({ id: "hidden", question: "Off-topic: who is getting lunch?", status: "dismissed" }),
    ],
    onModerate,
  );

  const hidden = card("Off-topic: who is getting lunch?");
  expect(hidden).toBeDefined();
  expect(hidden?.textContent).toContain("Hidden");
  expect(buttonsOf("Off-topic: who is getting lunch?")).toEqual(["Unhide"]);
  // The open question is listed before it and keeps its own actions.
  const cards = Array.from(container.querySelectorAll('[data-testid="webinar-host-question"]'));
  expect(cards.map((element) => element.textContent?.includes("slides"))).toEqual([true, false]);
  expect(buttonsOf("When do the slides go out?")).toEqual(["Answer live", "Mark answered", "Hide"]);
  // The count is of questions still open.
  expect(container.textContent).toMatch(/Questions\s*1/);

  const unhide = card("Off-topic: who is getting lunch?")?.querySelector("button");
  await act(async () => unhide?.click());

  expect(onModerate).toHaveBeenCalledWith({ id: "hidden", action: "reopen" });
});

it("shows a webinar host their hidden questions when nothing else is open", async () => {
  await render(
    [entry({ id: "hidden", question: "Off-topic: who is getting lunch?", status: "dismissed" })],
    vi.fn(async () => ({ ok: true })),
  );

  expect(buttonsOf("Off-topic: who is getting lunch?")).toEqual(["Unhide"]);
  expect(container.textContent).not.toContain("Attendee questions land here");
});
