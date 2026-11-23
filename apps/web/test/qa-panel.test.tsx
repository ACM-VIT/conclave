// @vitest-environment happy-dom
import { act, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { QaPanel } from "../src/app/components/qa/QaPanel";
import type { WebinarQaEntry } from "../src/app/lib/types";

let root: Root;
let container: HTMLDivElement;

const entry = (overrides: Partial<WebinarQaEntry>): WebinarQaEntry => ({
  id: "q1",
  userId: "gia#1",
  displayName: "Gia",
  question: "Is this recorded?",
  status: "pending",
  askedAt: 1,
  updatedAt: 1,
  upvotes: 0,
  ...overrides,
});

const render = async (props: Partial<ComponentProps<typeof QaPanel>>) => {
  await act(async () =>
    root.render(
      <QaPanel
        audience="meeting"
        entries={[]}
        qaEnabled
        currentUserId="ben#1"
        onClose={() => {}}
        {...props}
      />,
    ),
  );
};

const entryCard = (question: string) =>
  Array.from(container.querySelectorAll<HTMLElement>('[data-testid="qa-entry"]')).find(
    (card) => card.textContent?.includes(question),
  );
const actionsOf = (question: string) =>
  Array.from(entryCard(question)?.querySelectorAll("button") ?? [])
    .map((button) => button.textContent?.trim())
    .filter((label) => label && !/^\d+$/.test(label));

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

it("gives a meeting host moderation actions that fit each question", async () => {
  const onModerate = vi.fn(async () => ({ ok: true }));
  await render({
    onModerate,
    entries: [
      entry({ id: "q1", question: "Is this recorded?" }),
      entry({ id: "q2", question: "Slides?", status: "answered" }),
      entry({ id: "q3", question: "Off topic", status: "dismissed" }),
    ],
  });

  expect(actionsOf("Is this recorded?")).toEqual(["Answer live", "Mark answered", "Hide"]);
  expect(actionsOf("Slides?")).toEqual(["Reopen", "Hide"]);
  expect(actionsOf("Off topic")).toEqual(["Unhide"]);

  const hide = Array.from(entryCard("Is this recorded?")!.querySelectorAll("button")).find(
    (button) => button.textContent === "Hide",
  );
  await act(async () => hide?.click());
  expect(onModerate).toHaveBeenCalledWith({ id: "q1", action: "dismissed" });
});

it("shows participants public questions without moderation controls", async () => {
  await render({
    entries: [
      entry({ id: "q1", question: "Is this recorded?" }),
      entry({ id: "q3", question: "Off topic", status: "dismissed" }),
    ],
  });

  expect(entryCard("Is this recorded?")).toBeDefined();
  expect(entryCard("Off topic")).toBeUndefined();
  expect(actionsOf("Is this recorded?")).toEqual([]);
  expect(container.textContent).toContain("Everyone in the meeting can see questions.");
});

it("shows a hidden question to nobody but a host, its asker included", async () => {
  // The server sends a participant no hidden question. If one were ever on
  // hand, the panel would still not draw it, nor any word that it was hidden.
  await render({
    entries: [
      entry({ id: "q1", question: "Mine, hidden by a host", status: "dismissed", userId: "ben#1" }),
      entry({ id: "q2", question: "Someone else's, hidden", status: "dismissed" }),
      entry({ id: "q3", question: "Still here", userId: "ben#1" }),
    ],
    onUpvote: () => {},
  });

  expect(entryCard("Mine, hidden by a host")).toBeUndefined();
  expect(entryCard("Someone else's, hidden")).toBeUndefined();
  expect(entryCard("Still here")).toBeDefined();
  expect(container.textContent).not.toContain("Hidden");
});

it("keeps a hidden question in a host's list, marked, with a way to bring it back", async () => {
  await render({
    onModerate: vi.fn(async () => ({ ok: true })),
    entries: [entry({ id: "q1", question: "Off topic", status: "dismissed" })],
  });

  expect(entryCard("Off topic")?.textContent).toContain("Hidden");
  expect(actionsOf("Off topic")).toEqual(["Unhide"]);
});

it("tells a viewer without a verified identity to sign in, in place of the composer", async () => {
  await render({ askNeedsIdentity: true, onSubmit: undefined });

  expect(container.querySelector('[data-testid="qa-sign-in"]')?.textContent).toBe(
    "Sign in to ask a question.",
  );
  expect(container.querySelector('[data-testid="qa-input"]')).toBeNull();
});

it("keeps the draft and every control in place but sends nothing while the view comes back", async () => {
  const onSubmit = vi.fn(async () => ({ ok: true }));
  const onUpvote = vi.fn(async () => ({ ok: true }));
  const onModerate = vi.fn(async () => ({ ok: true }));
  await render({
    waiting: true,
    onSubmit,
    onUpvote,
    onModerate,
    entries: [entry({ id: "q1", question: "Is this recorded?", hasUpvoted: true, upvotes: 1 })],
  });
  const input = container.querySelector<HTMLTextAreaElement>('[data-testid="qa-input"]')!;
  const setValue = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
  await act(async () => {
    setValue?.call(input, "Will the slides be shared?");
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(async () => {
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  });
  const send = container.querySelector<HTMLButtonElement>('[data-testid="qa-send"]')!;
  const upvote = container.querySelector<HTMLButtonElement>('[data-testid="qa-upvote"]')!;
  const moderation = Array.from(entryCard("Is this recorded?")!.querySelectorAll("button")).filter(
    (button) => button !== upvote,
  );
  await act(async () => {
    for (const button of [send, upvote, ...moderation]) button.click();
  });

  expect(onSubmit).not.toHaveBeenCalled();
  expect(onUpvote).not.toHaveBeenCalled();
  expect(onModerate).not.toHaveBeenCalled();
  expect([send, upvote, ...moderation].every((button) => button.disabled)).toBe(true);
  expect(input.value).toBe("Will the slides be shared?");
  expect(input.disabled).toBe(false);
  expect(actionsOf("Is this recorded?")).toEqual(["Answer live", "Mark answered", "Hide"]);
});
