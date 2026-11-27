// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it } from "vitest";
import {
  usePrewarmSocket,
  type PrewarmModules,
} from "../src/app/hooks/usePrewarmSocket";
import {
  holdJoinInfo,
  planJoinInfo,
  type JoinGrant,
} from "../src/app/lib/held-join-info";

const HOUR_MS = 60 * 60_000;
const grant: JoinGrant = { joinMode: "meeting", userId: "guest", isHost: false };

const tokenExpiringIn = (ms: number): string => {
  const encode = (value: object) =>
    btoa(JSON.stringify(value))
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
  return [
    encode({ alg: "HS256", typ: "JWT" }),
    encode({ userId: "guest", exp: Math.floor((Date.now() + ms) / 1000) }),
    "signature",
  ].join(".");
};

let container: HTMLDivElement;
let root: Root;
let prewarm: PrewarmModules | null = null;

function Harness() {
  prewarm = usePrewarmSocket();
  return null;
}

beforeEach(async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
    true;
  container = document.createElement("div");
  root = createRoot(container);
  await act(async () => root.render(<Harness />));
});

afterEach(async () => {
  await act(async () => root.unmount());
  prewarm = null;
});

it("keeps a prefetched answer's TURN lifetime, so it is not reused after it", async () => {
  const answer = {
    token: tokenExpiringIn(12 * HOUR_MS),
    sfuUrl: "https://sfu.example",
    iceServers: [{ urls: "turn:turn.example", username: "u", credential: "c" }],
    iceServersTtlSeconds: 60 * 60,
  };
  await act(async () => {
    prewarm?.prefetchToken("room", "session", async () => answer);
  });

  const cached = prewarm?.getCachedToken("room");
  expect(cached).toBeTruthy();
  const receivedAt = Date.now();
  const held = holdJoinInfo(cached!, { roomId: "room", grant, receivedAt });

  const plan = (now: number) =>
    planJoinInfo({ held, roomId: "room", grant, now, isFirstReconnectAttempt: true });

  expect(held.relayExpiresAt).toBe(receivedAt + HOUR_MS);
  expect(plan(receivedAt + 10 * 60_000).source).toBe("held");
  expect(plan(receivedAt + 2 * HOUR_MS).source).toBe("fresh");
});
