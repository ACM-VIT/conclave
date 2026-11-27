import { expect, it } from "vitest";
import { qaListForConfig, withQaChange } from "../src/app/lib/webinarQaList";
import type { WebinarConfigSnapshot, WebinarQaEntry } from "../src/app/lib/types";

const question: WebinarQaEntry = {
  id: "q1",
  userId: "u1",
  displayName: "Gia",
  question: "Is this recorded?",
  status: "pending",
  askedAt: 1,
  updatedAt: 1,
  upvotes: 0,
};

const config = (enabled: boolean) => ({ enabled }) as WebinarConfigSnapshot;

it("takes a change into a connection that was sent no list yet, as into an empty one", () => {
  expect(withQaChange(null, { roomId: "room", entry: question })).toEqual([question]);
  expect(withQaChange(null, { roomId: "room", removedId: "q1" })).toEqual([]);
});

it("keeps no webinar Q&A once webinar mode ends", () => {
  expect(qaListForConfig([question], config(false))).toEqual([]);
  expect(qaListForConfig(null, config(false))).toEqual([]);
  const held = [question];
  expect(qaListForConfig(held, config(true))).toBe(held);
  expect(qaListForConfig(null, config(true))).toBeNull();
});
