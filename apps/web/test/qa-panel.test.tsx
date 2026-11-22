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

it("tells a viewer without a verified identity to sign in, in place of the composer", async () => {
  await render({ askNeedsIdentity: true, onSubmit: undefined });

  expect(container.querySelector('[data-testid="qa-sign-in"]')?.textContent).toBe(
    "Sign in to ask a question.",
  );
  expect(container.querySelector('[data-testid="qa-input"]')).toBeNull();
});
