import { afterEach, describe, expect, it, vi } from "vitest";
import { telemetryFetch } from "../src/app/lib/telemetry-fetch";

const calls: Array<{ url: string; init: RequestInit }> = [];

const stubFetch = () => {
  calls.length = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response("{}", { status: 200 });
    }),
  );
};

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("the one fetch telemetry makes requests with", () => {
  it("sends without cookies, a referrer or the HTTP cache, with the caller's method, body, headers and keepalive", async () => {
    stubFetch();
    await telemetryFetch("/ingest/e/", {
      method: "POST",
      body: "{}",
      headers: { "content-type": "application/json" },
      keepalive: true,
      deadlineMs: 15_000,
    });

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("/ingest/e/");
    expect(calls[0].init).toMatchObject({
      method: "POST",
      body: "{}",
      headers: { "content-type": "application/json" },
      keepalive: true,
      credentials: "omit",
      referrerPolicy: "no-referrer",
      cache: "no-store",
    });
  });

  it("ends the request at its deadline through the request's own AbortSignal.timeout", async () => {
    stubFetch();
    const deadline = new AbortController();
    const timeout = vi.spyOn(AbortSignal, "timeout").mockReturnValue(deadline.signal);
    await telemetryFetch("/_next/static/posthog-chunk-ids/0b2d3b4.json", { deadlineMs: 5000 });

    expect(timeout).toHaveBeenCalledWith(5000);
    expect(calls[0].init.signal?.aborted).toBe(false);
    deadline.abort();
    expect(calls[0].init.signal?.aborted).toBe(true);
  });

  it("ends the request when the caller's own signal aborts, before its deadline", async () => {
    stubFetch();
    const caller = new AbortController();
    await telemetryFetch("/ingest/e/", { method: "POST", body: "{}", signal: caller.signal, deadlineMs: 15_000 });

    expect(calls[0].init.signal?.aborted).toBe(false);
    caller.abort();
    expect(calls[0].init.signal?.aborted).toBe(true);
  });

  it("still ends the request at its deadline where AbortSignal.timeout is missing", async () => {
    stubFetch();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const original = Object.getOwnPropertyDescriptor(AbortSignal, "timeout");
    Object.defineProperty(AbortSignal, "timeout", { configurable: true, value: undefined });
    try {
      await telemetryFetch("/ingest/e/", { method: "POST", body: "{}", deadlineMs: 15_000 });
      vi.advanceTimersByTime(14_999);
      expect(calls[0].init.signal?.aborted).toBe(false);
      vi.advanceTimersByTime(1);
      expect(calls[0].init.signal?.aborted).toBe(true);
    } finally {
      if (original) Object.defineProperty(AbortSignal, "timeout", original);
    }
  });
});
