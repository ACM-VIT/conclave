import { expect, it } from "vitest";
import { hasUnseenMeetingQuestion } from "../src/app/hooks/useMeetingQa";
import type { WebinarQaEntry } from "../src/app/lib/types";

const question = (overrides: Partial<WebinarQaEntry> = {}): WebinarQaEntry => ({
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

const state = (overrides: Partial<Parameters<typeof hasUnseenMeetingQuestion>[0]> = {}) => ({
  isAvailable: true,
  isOpen: false,
  entries: [question()],
  currentUserId: "ben#1",
  seenIds: new Set<string>(),
  ...overrides,
});

it("asks for attention when someone else's question has not been seen", () => {
  expect(hasUnseenMeetingQuestion(state())).toBe(true);
});

it("stays quiet in a webinar, where Apps has no Q&A entry to open", () => {
  expect(hasUnseenMeetingQuestion(state({ isAvailable: false }))).toBe(false);
});

it("stays quiet for the viewer's own, hidden and already seen questions, and while Q&A is open", () => {
  expect(
    hasUnseenMeetingQuestion(state({ entries: [question({ userId: "ben#1" })] })),
  ).toBe(false);
  expect(
    hasUnseenMeetingQuestion(state({ entries: [question({ status: "dismissed" })] })),
  ).toBe(false);
  expect(hasUnseenMeetingQuestion(state({ seenIds: new Set(["q1"]) }))).toBe(false);
  expect(hasUnseenMeetingQuestion(state({ isOpen: true }))).toBe(false);
});
