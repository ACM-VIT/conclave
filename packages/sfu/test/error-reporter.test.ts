import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { gunzipSync } from "node:zlib";
import { PostHog } from "posthog-node";
import { afterEach, describe, expect, it } from "vitest";
import {
  createErrorReporter,
  scrubExceptionEvent,
  type ExceptionClient,
} from "../server/analytics/errorReporter.js";

type CapturedEvent = {
  event: string;
  distinct_id?: string;
  properties: Record<string, unknown>;
};

const readBody = async (request: IncomingMessage): Promise<Buffer> => {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  const raw = Buffer.concat(chunks);
  return raw[0] === 0x1f && raw[1] === 0x8b ? gunzipSync(raw) : raw;
};

const eventsIn = (payload: unknown): CapturedEvent[] => {
  if (Array.isArray(payload)) return payload as CapturedEvent[];
  const record = payload as { batch?: CapturedEvent[] };
  if (Array.isArray(record.batch)) return record.batch;
  return [payload as CapturedEvent];
};

const startFakePostHog = async () => {
  const events: CapturedEvent[] = [];
  const record = async (request: IncomingMessage) => {
    if (request.method !== "POST") return;
    const body = await readBody(request);
    try {
      events.push(...eventsIn(JSON.parse(body.toString("utf8"))));
    } catch {}
  };
  const server = createServer((request, response) => {
    void record(request).finally(() => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end('{"status":1}');
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return { server, events, host: `http://127.0.0.1:${port}` };
};

/** Accepts connections and never answers, like a host behind a dead route. */
const startBlackhole = async () => {
  const server = createServer(() => {});
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return { server, host: `http://127.0.0.1:${port}` };
};

const servers: Server[] = [];
const clients: PostHog[] = [];

afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.shutdown(200)));
  const open = servers.splice(0);
  open.forEach((server) => server.closeAllConnections());
  await Promise.all(
    open.map(
      (server) => new Promise<void>((resolve) => server.close(() => resolve())),
    ),
  );
});

const posthogClient = (host: string): PostHog => {
  const client = new PostHog("phc_test_key", {
    host,
    flushAt: 1,
    flushInterval: 0,
    requestTimeout: 500,
    captureMaxRetries: 0,
    enableExceptionAutocapture: false,
    beforeSend: scrubExceptionEvent,
  });
  clients.push(client);
  return client;
};

const waitFor = async (check: () => boolean, timeoutMs = 3000) => {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("timed out waiting");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};

const reporterFor = (client: ExceptionClient | null, now = Date.now) =>
  createErrorReporter({
    getClient: () => client,
    instanceId: "sfu-a",
    region: "in-south",
    version: "v2",
    now,
  });

describe("SFU error reporter", () => {
  it("sends a scrubbed exception with its stack and instance tags", async () => {
    const fake = await startFakePostHog();
    servers.push(fake.server);
    const reporter = reporterFor(posthogClient(fake.host));

    const failure = new TypeError(
      "Cannot read joinRoom for alice@example.com at https://conclave.test/x?token=secret",
    );
    reporter.report(failure, {
      source: "socket_handler",
      properties: { socket_event: "joinRoom" },
    });

    await waitFor(() => fake.events.some((event) => event.event === "$exception"));
    const exception = fake.events.find((event) => event.event === "$exception")!;
    const [entry] = exception.properties.$exception_list as Array<{
      type: string;
      value: string;
      stacktrace: { frames: Array<{ filename?: string }> };
    }>;

    expect(exception.distinct_id).toBe("sfu_sfu-a");
    expect(exception.properties).toMatchObject({
      source: "socket_handler",
      socket_event: "joinRoom",
      sfu_instance_id: "sfu-a",
      sfu_region: "in-south",
      sfu_version: "v2",
      $exception_level: "error",
    });
    expect(entry.type).toBe("TypeError");
    expect(entry.value).toBe(
      "Cannot read joinRoom for [email] at https://conclave.test/x",
    );
    expect(
      entry.stacktrace.frames.some((frame) =>
        frame.filename?.endsWith("error-reporter.test.ts"),
      ),
    ).toBe(true);
  });

  it("delivers a fatal exception before resolving", async () => {
    const fake = await startFakePostHog();
    servers.push(fake.server);
    const reporter = reporterFor(posthogClient(fake.host));

    await reporter.reportFatal(
      new Error("worker pool exhausted"),
      { source: "uncaught_exception" },
      2000,
    );

    const exception = fake.events.find((event) => event.event === "$exception");
    expect(exception?.properties).toMatchObject({
      source: "uncaught_exception",
      $exception_level: "fatal",
    });
  });

  it("never throws or stalls the event loop when PostHog does not answer", async () => {
    const blackhole = await startBlackhole();
    servers.push(blackhole.server);
    const reporter = reporterFor(posthogClient(blackhole.host));

    let timerFiredAt = 0;
    const scheduledAt = Date.now();
    setTimeout(() => {
      timerFiredAt = Date.now();
    }, 20);

    const reportStartedAt = Date.now();
    for (let index = 0; index < 50; index += 1) {
      expect(() =>
        reporter.report(new Error(`handler failed ${index}`), {
          source: "socket_handler",
        }),
      ).not.toThrow();
    }
    expect(Date.now() - reportStartedAt).toBeLessThan(250);

    const fatalStartedAt = Date.now();
    await expect(
      reporter.reportFatal(
        new Error("crash"),
        { source: "uncaught_exception" },
        300,
      ),
    ).resolves.toBeUndefined();
    expect(Date.now() - fatalStartedAt).toBeLessThan(1500);

    await waitFor(() => timerFiredAt > 0);
    expect(timerFiredAt - scheduledAt).toBeLessThan(250);
  });

  it("caps repeats of one error and recovers after the window", () => {
    const sent: unknown[] = [];
    const fakeClient: ExceptionClient = {
      captureException: (error) => sent.push(error),
      captureExceptionImmediate: async (error) => {
        sent.push(error);
      },
      flush: async () => {},
    };
    let now = 0;
    const reporter = reporterFor(fakeClient, () => now);

    for (let index = 0; index < 20; index += 1) {
      reporter.report(new Error("Producer not found"), { source: "socket_handler" });
    }
    reporter.report(new Error("Transport closed"), { source: "socket_handler" });
    expect(sent).toHaveLength(6);

    now += 60_000;
    reporter.report(new Error("Producer not found"), { source: "socket_handler" });
    expect(sent).toHaveLength(7);
  });

  it("never throws even when logging the failure throws", async () => {
    const brokenClient: ExceptionClient = {
      captureException: () => {
        throw new Error("queue full");
      },
      captureExceptionImmediate: () => Promise.reject(new Error("queue full")),
      flush: () => Promise.reject(new Error("queue full")),
    };
    const reporter = createErrorReporter({
      getClient: () => brokenClient,
      instanceId: "sfu-a",
      region: null,
      version: "v2",
      onReportFailure: () => {
        throw new Error("stdout closed");
      },
    });

    expect(() =>
      reporter.report(new Error("boom"), { source: "socket_handler" }),
    ).not.toThrow();
    await expect(
      reporter.reportFatal(new Error("boom"), { source: "uncaught_exception" }, 200),
    ).resolves.toBeUndefined();
  });

  it("does nothing when analytics is off", async () => {
    const reporter = reporterFor(null);
    expect(() =>
      reporter.report(new Error("boom"), { source: "worker_died" }),
    ).not.toThrow();
    const startedAt = Date.now();
    await expect(
      reporter.reportFatal(new Error("boom"), { source: "uncaught_exception" }, 5000),
    ).resolves.toBeUndefined();
    expect(Date.now() - startedAt).toBeLessThan(100);
  });
});
