// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import MeetingAnnouncer from "../src/app/components/MeetingAnnouncer";
import type { ChatMessage, Participant } from "../src/app/lib/types";

let container: HTMLDivElement;
let root: Root;

const person = (userId: string, isHandRaised = false): Participant => ({
  userId,
  videoStream: null,
  audioStream: null,
  screenShareStream: null,
  screenShareAudioStream: null,
  audioProducerId: null,
  videoProducerId: null,
  screenShareProducerId: null,
  screenShareAudioProducerId: null,
  isMuted: true,
  isCameraOff: true,
  isVideoAdaptivelyPaused: false,
  isHandRaised,
});

const message = (id: string, userId: string, content: string): ChatMessage => ({
  id,
  userId,
  displayName: userId,
  content,
  timestamp: 0,
});

const names = (userId: string) => userId;

async function show(
  people: Participant[],
  chat: ChatMessage[] = [],
  isLive = true,
) {
  await act(async () =>
    root.render(
      <MeetingAnnouncer
        isLive={isLive}
        participants={new Map(people.map((p) => [p.userId, p]))}
        chatMessages={chat}
        currentUserId="me"
        resolveDisplayName={names}
      />,
    ),
  );
}

const announced = () =>
  container.querySelector('[role="status"]')?.textContent?.replace(/\u00a0/g, "") ?? "";

const wait = (ms: number) => act(async () => vi.advanceTimersByTime(ms));

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

it("stays quiet about the people already in the room when you arrive", async () => {
  await show([person("Ann")]);
  await show([person("Ann"), person("Ben")]);
  await wait(5000);

  expect(announced()).toBe("");
});

it("announces a join and a leave once the room has settled", async () => {
  await show([person("Ann")]);
  await wait(3500);

  await show([person("Ann"), person("Ben")]);
  await wait(1300);
  expect(announced()).toBe("Ben joined");

  await wait(3000);
  await show([person("Ben")]);
  await wait(1300);
  expect(announced()).toBe("Ann left");
});

it("folds a burst of joins into one sentence", async () => {
  await show([]);
  await wait(3500);

  await show([person("Ann")]);
  await show([person("Ann"), person("Ben")]);
  await show([person("Ann"), person("Ben"), person("Cy")]);
  await wait(1300);

  expect(announced()).toBe("Ann and 2 others joined");
});

it("announces raised hands and other people's chat, never your own", async () => {
  await show([person("Ann")]);
  await wait(3500);

  await show([person("Ann", true)], [message("1", "me", "hello all")]);
  await wait(1300);
  expect(announced()).toBe("Ann raised a hand");

  await wait(3000);
  await show([person("Ann", true)], [
    message("1", "me", "hello all"),
    message("2", "Ann", "hi there"),
  ]);
  await wait(1300);
  expect(announced()).toBe("Ann says: hi there");
});

it("does not read out chat history loaded in one go", async () => {
  await show([person("Ann")]);
  await wait(3500);

  await show([person("Ann")], [
    message("1", "Ann", "earlier one"),
    message("2", "Ann", "earlier two"),
    message("3", "Ann", "earlier three"),
  ]);
  await wait(3000);

  expect(announced()).toBe("");
});

it("drops a queued announcement when the connection drops before it is read", async () => {
  await show([person("Ann")]);
  await wait(3500);

  await show([person("Ann"), person("Ben")]);
  await show([person("Ann"), person("Ben")], [], false);
  await wait(3000);

  expect(announced()).toBe("");
});

it("does not read out a reconnect as everyone leaving and joining", async () => {
  await show([person("Ann"), person("Ben")]);
  await wait(3500);

  await show([], [], false);
  await show([person("Ann"), person("Ben")]);
  await wait(5000);

  expect(announced()).toBe("");
});
