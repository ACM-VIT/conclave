// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useMeetingTranscript } from "../src/app/hooks/useMeetingTranscript";

type Sent = { type: string; language?: string };

class FakeSocket {
  static OPEN = 1;
  static instances: FakeSocket[] = [];
  readyState = 1;
  onopen?: () => void;
  onclose?: () => void;
  onmessage?: (event: { data: string }) => void;
  sent: Sent[] = [];
  constructor() {
    FakeSocket.instances.push(this);
    void Promise.resolve().then(() => this.onopen?.());
  }
  send(raw: string) {
    this.sent.push(JSON.parse(raw));
  }
  close() {
    this.readyState = 3;
    this.onclose?.();
  }
  frame(message: unknown) {
    this.onmessage?.({ data: JSON.stringify(message) });
  }
}

const liveSession = {
  roomId: "room",
  status: "live",
  language: "en",
  transcriptModel: "gpt-live-transcribe",
  qaModel: "gpt-6.1-sol",
  transportMode: "sfu",
  controller: { userId: "host" },
  startedAt: 1,
  updatedAt: 1,
};

let root: Root;
let controller!: ReturnType<typeof useMeetingTranscript>;
let startRelay: ReturnType<typeof vi.fn>;

async function mount() {
  const token = async () => ({
    roomId: "room",
    workerUrl: "https://transcript.test",
    token: "fixture",
    expiresAt: Date.now() + 60_000,
    capabilities: { ask: true, start: true, stop: true, takeover: true },
  });
  const status = vi.fn(async () => ({
    status: "available" as const,
    mode: "sfu" as const,
    available: true,
    updatedAt: Date.now(),
  }));
  const participants = new Map();
  function Harness() {
    controller = useMeetingTranscript({
      roomId: "room",
      isJoined: true,
      currentUserId: "host",
      currentDisplayName: "Host",
      isMuted: true,
      localStream: null,
      participants,
      activeSpeakerId: null,
      resolveDisplayName: () => "Host",
      getTranscriptToken: token,
      getTranscriptSfuRelayStatus: status,
      startTranscriptSfuRelay: startRelay,
    });
    return null;
  }
  root = createRoot(document.createElement("div"));
  await act(async () => root.render(<Harness />));
  return FakeSocket.instances[0];
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("fetch", vi.fn(async () => Response.json({ id: "fixture" })));
  vi.stubGlobal("WebSocket", FakeSocket);
  FakeSocket.instances = [];
  startRelay = vi.fn(async () => ({
    success: true,
    status: "running",
    updatedAt: Date.now(),
  }));
});

afterEach(async () => {
  await act(async () => root.unmount());
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("a live caption language switch", () => {
  it("keeps the worker's reason and the running session when the switch is refused", async () => {
    const socket = await mount();
    await act(async () => socket.frame({ type: "session.state", session: liveSession }));

    let result!: Promise<boolean>;
    await act(async () => {
      result = controller.takeover({ language: "hi" });
    });
    const reason = "Room AI settings could not be loaded. Please reconnect and try again.";
    await act(async () => socket.frame({ type: "error", message: reason }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(6_000);
    });

    expect(await result).toBe(false);
    expect(controller.error).toBe(reason);
    expect(controller.session.language).toBe("en");
    expect(socket.sent.map(({ type }) => type)).not.toContain("session.relayFailed");
    expect(startRelay).not.toHaveBeenCalled();
  });

  it("starts the relay only after the worker accepts the switch", async () => {
    const socket = await mount();
    await act(async () => socket.frame({ type: "session.state", session: liveSession }));

    let result!: Promise<boolean>;
    await act(async () => {
      result = controller.takeover({ language: "hi" });
    });
    expect(startRelay).not.toHaveBeenCalled();
    await act(async () =>
      socket.frame({ type: "session.state", session: { ...liveSession, status: "starting", language: "hi" } }),
    );
    await act(async () =>
      socket.frame({ type: "session.state", session: { ...liveSession, language: "hi", updatedAt: 2 } }),
    );
    await act(async () =>
      socket.frame({ type: "sfu.relayStartToken", token: "relay", expiresAt: Date.now() + 60_000 }),
    );

    expect(await result).toBe(true);
    expect(startRelay).toHaveBeenCalledWith({ relayStartToken: "relay" });
    expect(controller.session.language).toBe("hi");
  });
});
