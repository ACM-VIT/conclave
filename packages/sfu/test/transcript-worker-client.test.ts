import { afterEach, describe, expect, it, vi } from "vitest";
import type { TranscriptSpeaker } from "../types.js";
import { TranscriptWorkerRelayClient } from "../server/transcript/workerClient.js";

class FakeWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  static readonly instances: FakeWebSocket[] = [];

  readyState = FakeWebSocket.CONNECTING;
  readonly sent: string[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: { data?: unknown }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: (() => void) | null = null;

  constructor(readonly url: string) {
    FakeWebSocket.instances.push(this);
  }

  open(): void {
    this.readyState = FakeWebSocket.OPEN;
    this.onopen?.();
  }

  serverClose(): void {
    this.readyState = FakeWebSocket.CLOSED;
    this.onclose?.();
  }

  send(serialized: string): void {
    if (this.readyState !== FakeWebSocket.OPEN) {
      throw new Error("socket is not open");
    }
    this.sent.push(serialized);
  }

  close(): void {
    if (this.readyState === FakeWebSocket.CLOSED) return;
    this.readyState = FakeWebSocket.CLOSED;
    this.onclose?.();
  }
}

const speaker: TranscriptSpeaker = {
  userId: "u1",
  displayName: "Ada",
  source: "remote",
};

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  FakeWebSocket.instances.length = 0;
});

describe("TranscriptWorkerRelayClient recovery", () => {
  it("reconnects after a heartbeat write failure in a silent meeting", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("WebSocket", FakeWebSocket);
    const client = new TranscriptWorkerRelayClient({ workerUrl: "https://worker.test", roomId: "room-a", token: "fixture" });
    const connected = client.connect();
    const first = FakeWebSocket.instances[0];
    first.open();
    await connected;
    first.send = () => { throw new Error("write failed"); };
    first.close = () => { first.readyState = FakeWebSocket.CLOSED; };
    await vi.advanceTimersByTimeAsync(20250);
    expect(FakeWebSocket.instances).toHaveLength(2);
    FakeWebSocket.instances[1].open();
    await Promise.resolve();
    expect(client.sendAudioChunk("resumed", speaker)).toBe(true);
    client.close();
  });
  it("retries a failed replacement handshake even when error is not followed by close", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("WebSocket", FakeWebSocket);
    const client = new TranscriptWorkerRelayClient({ workerUrl: "https://worker.test", roomId: "room-a", token: "fixture" });
    const initial = client.connect();
    FakeWebSocket.instances[0].open();
    await initial;
    FakeWebSocket.instances[0].serverClose();
    await vi.advanceTimersByTimeAsync(250);
    const failed = FakeWebSocket.instances[1];
    failed.close = () => { failed.readyState = FakeWebSocket.CLOSED; };
    failed.onerror?.();
    await vi.advanceTimersByTimeAsync(500);
    expect(FakeWebSocket.instances).toHaveLength(3);
    FakeWebSocket.instances[2].open();
    await Promise.resolve();
    expect(client.sendAudioChunk("recovered", speaker)).toBe(true);
    failed.open();
    expect(client.sendAudioChunk("still current", speaker)).toBe(true);
    expect(FakeWebSocket.instances[2].sent.some((raw) => raw.includes("still current"))).toBe(true);
    client.close();
  });
  it("reconnects a dropped worker socket and flushes audio queued during the gap", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("WebSocket", FakeWebSocket);
    const onClose = vi.fn();
    const client = new TranscriptWorkerRelayClient({
      workerUrl: "https://worker.test",
      roomId: "room-a",
      token: "token-a",
      onClose,
    });

    const initialConnect = client.connect();
    const initialSocket = FakeWebSocket.instances[0];
    initialSocket.open();
    await initialConnect;

    expect(client.sendAudioChunk("first", speaker)).toBe(true);
    initialSocket.serverClose();
    expect(client.sendAudioChunk("buffered", speaker)).toBe(true);
    expect(onClose).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(250);
    const replacementSocket = FakeWebSocket.instances[1];
    replacementSocket.open();
    await Promise.resolve();

    expect(
      replacementSocket.sent.map(
        (serialized): unknown => JSON.parse(serialized) as unknown,
      ),
    ).toContainEqual({
      type: "audio.chunk",
      audio: "buffered",
      speaker,
    });
    expect(onClose).not.toHaveBeenCalled();
    client.close();
  });
});
