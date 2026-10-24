// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { useMeetingTranscript } from "../src/app/hooks/useMeetingTranscript";

class FakeSocket {
  static OPEN = 1;
  static sockets: FakeSocket[] = [];
  readyState = 0;
  onopen?: () => void;
  onclose?: () => void;
  onerror?: () => void;
  onmessage?: (event: { data: string }) => void;
  constructor(readonly url: string) { FakeSocket.sockets.push(this); }
  open() { this.readyState = 1; this.onopen?.(); }
  close() { this.readyState = 3; this.onclose?.(); }
  send() {}
}
const token = () => ({ roomId: "room", workerUrl: "https://worker.test", token: "fixture", expiresAt: Date.now() + 60000, capabilities: { ask: true, start: true, stop: true, takeover: true } });
const participants = new Map();
const displayName = () => "Ada";
let unmount: (() => Promise<void>) | null = null;
afterEach(async () => {
  await unmount?.();
  unmount = null;
  vi.unstubAllGlobals();
  vi.useRealTimers();
  FakeSocket.sockets = [];
});
async function fixture(getToken = vi.fn(async () => token())) {
  vi.useFakeTimers();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("WebSocket", FakeSocket);
  vi.stubGlobal("fetch", vi.fn(async () => Response.json({ id: "fixture" })));
  let controller!: ReturnType<typeof useMeetingTranscript>;
  function Harness({ joined = true, userId = "alice" }: { joined?: boolean; userId?: string }) {
    controller = useMeetingTranscript({ roomId: "room", isJoined: joined, currentUserId: userId, currentDisplayName: "Alice", isMuted: true, localStream: null, participants, activeSpeakerId: null, resolveDisplayName: displayName, getTranscriptToken: getToken });
    return null;
  }
  const root = createRoot(document.createElement("div"));
  unmount = async () => { await act(async () => root.unmount()); };
  await act(async () => root.render(<Harness />));
  return {
    current: () => controller,
    leave: async () => { await act(async () => root.render(<Harness joined={false} />)); },
    switchIdentity: async () => { await act(async () => root.render(<Harness userId="bob" />)); },
  };
}

it("recovers after error-only disconnects and ignores late events from the replaced socket", async () => {
  const { current } = await fixture();
  const old = FakeSocket.sockets[0];
  await act(async () => old.open());
  await act(async () => { old.onerror?.(); await vi.advanceTimersByTimeAsync(500); });
  expect(FakeSocket.sockets).toHaveLength(2);
  await act(async () => FakeSocket.sockets[1].open());
  expect(current().connectionStatus).toBe("connected");
  await act(async () => {
    old.open();
    old.onmessage?.({ data: JSON.stringify({ type: "error", message: "stale failure" }) });
    old.onerror?.();
    await vi.advanceTimersByTimeAsync(2000);
  });
  expect(current().error).not.toBe("stale failure");
  expect(current().connectionStatus).toBe("connected");
  expect(FakeSocket.sockets).toHaveLength(2);
});

it("does not open a socket when a token resolves after leaving the meeting", async () => {
  let resolve!: (value: ReturnType<typeof token>) => void;
  const pending = new Promise<ReturnType<typeof token>>((done) => { resolve = done; });
  const { leave, current } = await fixture(vi.fn(() => pending));
  await leave();
  await act(async () => resolve(token()));
  expect(FakeSocket.sockets).toHaveLength(0);
  expect(current().connectionStatus).toBe("idle");
});

it("resubscribes after an identity update even when the token callback stays stable", async () => {
  const { current, switchIdentity } = await fixture();
  await act(async () => FakeSocket.sockets[0].open());
  await switchIdentity();
  expect(FakeSocket.sockets[0].readyState).toBe(3);
  expect(FakeSocket.sockets).toHaveLength(2);
  await act(async () => FakeSocket.sockets[1].open());
  expect(current().connectionStatus).toBe("connected");
});

it("retries token lookup failures without unhandled rejections", async () => {
  const getToken = vi.fn(async () => token()).mockRejectedValueOnce(new Error("temporary token failure"));
  const { current } = await fixture(getToken);
  expect(FakeSocket.sockets).toHaveLength(0);
  await act(async () => { await vi.advanceTimersByTimeAsync(500); });
  await act(async () => FakeSocket.sockets[0].open());
  expect(current().connectionStatus).toBe("connected");
  expect(getToken).toHaveBeenCalledTimes(2);
});

it("keeps the new connection when an obsolete token lookup completes later", async () => {
  let resolveOld!: (value: ReturnType<typeof token>) => void;
  const old = new Promise<ReturnType<typeof token>>((done) => { resolveOld = done; });
  const getToken = vi.fn(async () => token()).mockReturnValueOnce(old);
  const { current } = await fixture(getToken);
  let reconnect!: Promise<boolean>;
  await act(async () => { reconnect = current().reconnect(); });
  await act(async () => FakeSocket.sockets[0].open());
  expect(await reconnect).toBe(true);
  await act(async () => resolveOld(token()));
  expect(FakeSocket.sockets).toHaveLength(1);
  expect(current().connectionStatus).toBe("connected");
});
