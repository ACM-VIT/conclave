// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useMeetingTranscript } from "../src/app/hooks/useMeetingTranscript";

type Sent = { type: string; language?: string; requestId?: string };

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

describe("overlapping notes requests", () => {
  const requestIdFor = (socket: FakeSocket, language: string) =>
    socket.sent.find((message) => message.language === language)?.requestId;

  it("starts one relay, for the switch the worker accepted", async () => {
    const socket = await mount();
    await act(async () => socket.frame({ type: "session.state", session: liveSession }));

    let hindi!: Promise<boolean>;
    let tamil!: Promise<boolean>;
    await act(async () => {
      hindi = controller.takeover({ language: "hi" });
      tamil = controller.takeover({ language: "ta" });
    });
    const hindiId = requestIdFor(socket, "hi");
    const tamilId = requestIdFor(socket, "ta");
    expect(hindiId).toBeTruthy();
    expect(tamilId).not.toBe(hindiId);
    await act(async () =>
      socket.frame({
        type: "session.state",
        session: { ...liveSession, status: "starting", language: "hi", requestId: hindiId },
      }),
    );
    await act(async () =>
      socket.frame({ type: "error", message: "Notes changed while connecting.", requestId: tamilId }),
    );
    await act(async () =>
      socket.frame({
        type: "session.state",
        session: { ...liveSession, language: "hi", requestId: hindiId, updatedAt: 2 },
      }),
    );
    await act(async () =>
      socket.frame({ type: "sfu.relayStartToken", token: "relay", expiresAt: Date.now() + 60_000 }),
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(6_000);
    });

    expect([await hindi, await tamil]).toEqual([true, false]);
    expect(startRelay).toHaveBeenCalledTimes(1);
  });

  it("finishes a start whose acceptance was lost when the socket reconnected", async () => {
    const socket = await mount();
    await act(async () =>
      socket.frame({ type: "snapshot", session: { ...liveSession, status: "idle" } }),
    );

    let result!: Promise<boolean>;
    await act(async () => {
      result = controller.start({ language: "hi", transportMode: "sfu" });
    });
    const requestId = socket.sent.find((message) => message.type === "session.start")?.requestId;
    expect(requestId).toBeTruthy();
    await act(async () => socket.close());
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });
    const reconnected = FakeSocket.instances.at(-1)!;
    expect(reconnected).not.toBe(socket);
    await act(async () =>
      reconnected.frame({
        type: "snapshot",
        session: { ...liveSession, language: "hi", requestId },
      }),
    );
    await act(async () =>
      reconnected.frame({ type: "sfu.relayStartToken", token: "relay", expiresAt: Date.now() + 60_000 }),
    );

    expect(await result).toBe(true);
    expect(controller.error).toBeNull();
  });

  it("does not let an older worker's single acceptance settle two overlapping requests", async () => {
    const socket = await mount();
    await act(async () => socket.frame({ type: "session.state", session: liveSession }));

    let hindi!: Promise<boolean>;
    let tamil!: Promise<boolean>;
    await act(async () => {
      hindi = controller.takeover({ language: "hi" });
      tamil = controller.takeover({ language: "ta" });
    });
    await act(async () =>
      socket.frame({ type: "session.state", session: { ...liveSession, status: "starting", language: "hi" } }),
    );
    await act(async () =>
      socket.frame({ type: "session.state", session: { ...liveSession, language: "hi", updatedAt: 2 } }),
    );
    await act(async () =>
      socket.frame({ type: "sfu.relayStartToken", token: "relay", expiresAt: Date.now() + 60_000 }),
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(31_000);
    });

    expect([await hindi, await tamil]).toEqual([false, false]);
    expect(startRelay.mock.calls.length).toBeLessThanOrEqual(1);
  });
});

describe("requests that are replaced or recovered", () => {
  const requestIdFor = (socket: FakeSocket, language: string) =>
    socket.sent.find((message) => message.language === language)?.requestId;
  const token = (automatic?: boolean) => ({
    type: "sfu.relayStartToken",
    token: "relay",
    expiresAt: Date.now() + 60_000,
    ...(automatic ? { automatic: true } : {}),
  });
  // The worker rebinds the controller to the new connection on reconnect.
  const rebound = { userId: "host", connectionId: "conn-2" };
  const dropAndReconnect = async (socket: FakeSocket) => {
    await act(async () => socket.close());
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });
    const reconnected = FakeSocket.instances.at(-1)!;
    expect(reconnected).not.toBe(socket);
    return reconnected;
  };

  it("settles a switch replaced by a newer one from the same controller without an error", async () => {
    const socket = await mount();
    await act(async () => socket.frame({ type: "session.state", session: liveSession }));

    let hindi!: Promise<boolean>;
    await act(async () => {
      hindi = controller.takeover({ language: "hi" });
    });
    const hindiId = requestIdFor(socket, "hi");
    await act(async () =>
      socket.frame({ type: "session.state", session: { ...liveSession, status: "starting", language: "hi", requestId: hindiId } }),
    );
    let tamil!: Promise<boolean>;
    await act(async () => {
      tamil = controller.takeover({ language: "ta" });
    });
    const tamilId = requestIdFor(socket, "ta");
    await act(async () =>
      socket.frame({ type: "session.state", session: { ...liveSession, status: "starting", language: "ta", requestId: tamilId } }),
    );
    await act(async () =>
      socket.frame({ type: "session.state", session: { ...liveSession, language: "ta", requestId: tamilId, updatedAt: 3 } }),
    );
    await act(async () => socket.frame(token()));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(31_000);
    });

    expect([await hindi, await tamil]).toEqual([false, true]);
    expect(controller.error).toBeNull();
    expect(startRelay).toHaveBeenCalledTimes(1);
  });

  it("counts an older worker's recovered start as a success after a socket drop", async () => {
    const socket = await mount();
    await act(async () => socket.frame({ type: "snapshot", session: { ...liveSession, status: "idle" } }));

    let result!: Promise<boolean>;
    await act(async () => {
      result = controller.start({ language: "hi", transportMode: "sfu" });
    });
    const reconnected = await dropAndReconnect(socket);
    await act(async () =>
      reconnected.frame({
        type: "snapshot",
        viewerConnectionId: "conn-2",
        session: { ...liveSession, language: "hi", controller: rebound },
      }),
    );
    await act(async () => reconnected.frame(token(true)));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(6_000);
    });

    expect(await result).toBe(true);
    expect(controller.error).toBeNull();
    expect(startRelay).toHaveBeenCalledTimes(1);
  });

  it("keeps the running relay when a reconnect shows the switch live and brings no new token", async () => {
    const socket = await mount();
    await act(async () => socket.frame({ type: "session.state", session: liveSession }));

    let result!: Promise<boolean>;
    await act(async () => {
      result = controller.takeover({ language: "hi" });
    });
    const requestId = requestIdFor(socket, "hi");
    const reconnected = await dropAndReconnect(socket);
    await act(async () =>
      reconnected.frame({
        type: "snapshot",
        viewerConnectionId: "conn-2",
        session: { ...liveSession, language: "hi", requestId, controller: rebound },
      }),
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(6_000);
    });

    expect(await result).toBe(true);
    expect(reconnected.sent.map(({ type }) => type)).not.toContain("session.relayFailed");
    expect(startRelay).not.toHaveBeenCalled();
  });

  it("starts the relay once for an automatic recovery token", async () => {
    const socket = await mount();
    await act(async () => socket.frame({ type: "session.state", session: liveSession }));

    let result!: Promise<boolean>;
    await act(async () => {
      result = controller.takeover({ language: "hi" });
    });
    const requestId = requestIdFor(socket, "hi");
    const reconnected = await dropAndReconnect(socket);
    await act(async () =>
      reconnected.frame({
        type: "snapshot",
        viewerConnectionId: "conn-2",
        session: { ...liveSession, language: "hi", requestId, controller: rebound },
      }),
    );
    await act(async () => reconnected.frame(token(true)));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(6_000);
    });

    expect(await result).toBe(true);
    expect(startRelay).toHaveBeenCalledTimes(1);
  });
});

describe("restarting notes", () => {
  it("starts a fresh relay when notes restart within a second with the same token", async () => {
    const socket = await mount();
    await act(async () => socket.frame({ type: "snapshot", session: { ...liveSession, status: "idle" } }));
    const runNotes = async () => {
      let result!: Promise<boolean>;
      await act(async () => {
        result = controller.start({ language: "hi", transportMode: "sfu" });
      });
      const requestId = socket.sent.filter((message) => message.type === "session.start").at(-1)?.requestId;
      await act(async () =>
        socket.frame({ type: "session.state", session: { ...liveSession, status: "starting", requestId } }),
      );
      await act(async () =>
        socket.frame({ type: "session.state", session: { ...liveSession, requestId, updatedAt: 5 } }),
      );
      await act(async () =>
        socket.frame({ type: "sfu.relayStartToken", token: "same-second-token", expiresAt: Date.now() + 60_000 }),
      );
      return result;
    };

    expect(await runNotes()).toBe(true);
    await act(async () => {
      await controller.stop();
    });
    await act(async () =>
      socket.frame({ type: "session.state", session: { ...liveSession, status: "idle", requestId: undefined } }),
    );
    expect(await runNotes()).toBe(true);

    expect(startRelay).toHaveBeenCalledTimes(2);
  });
});

describe("caption language support", () => {
  it("follows what the worker says it supports", async () => {
    const socket = await mount();
    await act(async () =>
      socket.frame({ type: "snapshot", session: { ...liveSession, status: "idle" } }),
    );
    expect(controller.supportsCaptionLanguage).toBe(false);

    await act(async () =>
      socket.frame({
        type: "snapshot",
        session: { ...liveSession, status: "idle" },
        supportsCaptionLanguage: true,
      }),
    );
    expect(controller.supportsCaptionLanguage).toBe(true);
  });
});
