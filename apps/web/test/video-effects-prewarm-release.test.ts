// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { prewarmVideoEffectsRuntime } from "../src/app/hooks/useVideoEffects";
import { releaseAllCaptures } from "../src/app/lib/media-captures";

class FakeGenerator {
  readonly kind = "video";
  readyState: MediaStreamTrackState = "live";
  stop() {
    this.readyState = "ended";
  }
}

class FakeWorker {
  static created: FakeWorker[] = [];
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  terminated = false;
  constructor() {
    FakeWorker.created.push(this);
  }
  postMessage() {}
  terminate() {
    this.terminated = true;
  }
  addEventListener() {}
  removeEventListener() {}
}

beforeEach(() => {
  vi.useFakeTimers();
  FakeWorker.created = [];
  vi.stubGlobal("MediaStreamTrackGenerator", FakeGenerator);
  vi.stubGlobal("Worker", FakeWorker);
  vi.stubGlobal("fetch", vi.fn(async () => new Response("", { status: 404 })));
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "info").mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("the effects output writer warmed up before a call ends", () => {
  it("is shut down instead of kept for later when it reports ready after the call ended", async () => {
    const warming = prewarmVideoEffectsRuntime({ reason: "test" });
    await vi.waitFor(() => {
      if (FakeWorker.created.length === 0) throw new Error("the writer worker has not started");
    });
    const [writer] = FakeWorker.created;

    releaseAllCaptures();
    writer!.onmessage?.({
      data: { type: "READY", hasVideoFrame: true, hasWritableStream: true, hasOffscreenCanvas: true, renderer: "2d" },
    } as MessageEvent);
    await vi.advanceTimersByTimeAsync(10_000);
    await warming;

    expect(writer!.terminated).toBe(true);
  });
});
