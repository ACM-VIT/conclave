// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { PollsPanel, type PollsPanelProps } from "../src/app/components/polls/PollsPanel";
import type { PollView } from "../src/app/lib/types";

let root: Root;
let container: HTMLDivElement;
const ok = async () => ({ ok: true as const });

const poll = (overrides: Partial<PollView> = {}): PollView => ({
  id: "p1",
  question: "Ship on Friday?",
  choiceMode: "single",
  status: "open",
  resultsShared: false,
  options: [
    { id: "o1", text: "Yes" },
    { id: "o2", text: "No" },
  ],
  createdAt: 1,
  createdByName: "Hana",
  ...overrides,
});

const render = async (props: Partial<PollsPanelProps>) => {
  const full: PollsPanelProps = {
    polls: [],
    isHost: false,
    onClose: () => {},
    onCreate: ok,
    onVote: ok,
    onEnd: ok,
    onShare: ok,
    onExport: ok,
    ...props,
  };
  await act(async () => root.render(<PollsPanel {...full} />));
};

const byTestId = (id: string) =>
  container.querySelector<HTMLElement>(`[data-testid="${id}"]`);
const button = (label: string) =>
  Array.from(container.querySelectorAll("button")).find(
    (element) => element.textContent?.trim() === label,
  );
const optionInput = (text: string) =>
  Array.from(container.querySelectorAll("label"))
    .find((label) => label.textContent?.includes(text))
    ?.querySelector("input");
const type = async (input: HTMLInputElement, value: string) => {
  const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  await act(async () => {
    setValue?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
};
const click = async (element: HTMLElement | null | undefined) => {
  if (!element) throw new Error("missing element");
  await act(async () => element.click());
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

it("lets a participant pick an option and vote", async () => {
  const onVote = vi.fn(ok);
  await render({ polls: [poll()], onVote });

  const vote = byTestId("poll-vote") as HTMLButtonElement;
  expect(vote.disabled).toBe(true);
  await click(optionInput("No"));
  expect(vote.disabled).toBe(false);
  await click(vote);

  expect(onVote).toHaveBeenCalledWith("p1", ["o2"]);
});

it("hides results from a participant until the host shares them", async () => {
  await render({ polls: [poll({ myVote: ["o1"] })] });
  expect(byTestId("poll-vote")).toBeNull();
  expect(byTestId("poll-result-bar")).toBeNull();
  expect(byTestId("poll-footnote")?.textContent).toBe(
    "Vote submitted. The host can share results.",
  );

  await render({
    polls: [
      poll({
        myVote: ["o1"],
        resultsShared: true,
        voterCount: 4,
        options: [
          { id: "o1", text: "Yes", votes: 3 },
          { id: "o2", text: "No", votes: 1 },
        ],
      }),
    ],
  });
  expect(container.querySelectorAll('[data-testid="poll-result-bar"]')).toHaveLength(2);
  expect(container.textContent).toContain("3 · 75%");
  expect(byTestId("poll-footnote")?.textContent).toBe("4 votes");
});

it("tells a participant who missed an ended poll that it is over", async () => {
  await render({ polls: [poll({ status: "ended", myVote: [] })] });
  expect(byTestId("poll-vote")).toBeNull();
  expect(byTestId("poll-footnote")?.textContent).toBe("This poll has ended.");
});

it("lets a host launch a poll once it has a question and two options", async () => {
  const onCreate = vi.fn(ok);
  await render({ isHost: true, onCreate });

  await click(byTestId("poll-start"));
  const launch = byTestId("poll-launch") as HTMLButtonElement;
  expect(launch.disabled).toBe(true);

  await type(byTestId("poll-question-input") as HTMLInputElement, "Lunch?");
  const [first, second] = container.querySelectorAll<HTMLInputElement>(
    '[data-testid="poll-option-input"]',
  );
  await type(first, "Tacos");
  expect(launch.disabled).toBe(true);
  await type(second, "Ramen");
  await click(button("Allow multiple answers"));
  await click(launch);

  expect(onCreate).toHaveBeenCalledWith({
    question: "Lunch?",
    options: ["Tacos", "Ramen"],
    choiceMode: "multiple",
  });
  expect(byTestId("poll-composer")).toBeNull();
});

it("gives the host live tallies and the end, share and export controls", async () => {
  const onEnd = vi.fn(ok);
  const onShare = vi.fn(ok);
  const onExport = vi.fn(ok);
  await render({
    isHost: true,
    onEnd,
    onShare,
    onExport,
    polls: [
      poll({
        voterCount: 2,
        options: [
          { id: "o1", text: "Yes", votes: 2 },
          { id: "o2", text: "No", votes: 0 },
        ],
      }),
    ],
  });

  expect(container.textContent).toContain("2 · 100%");
  expect(byTestId("poll-footnote")?.textContent).toBe("2 votes · Only hosts see results");

  await click(button("Show results to everyone"));
  expect(onShare).toHaveBeenCalledWith("p1", true);
  await click(byTestId("poll-end"));
  expect(onEnd).toHaveBeenCalledWith("p1");
  await click(byTestId("poll-export"));
  expect(onExport).toHaveBeenCalledWith("p1");
});
