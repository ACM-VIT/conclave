import { readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { gunzipSync } from "node:zlib";
import { PostHog } from "posthog-node";
import { afterEach, describe, expect, it } from "vitest";
import {
  createErrorReporter,
  scrubErrorText,
  scrubExceptionEvent,
  type ExceptionClient,
} from "../server/analytics/errorReporter.js";
import { ConfigError } from "../server/configError.js";

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
  const bodies: string[] = [];
  const record = async (request: IncomingMessage) => {
    if (request.method !== "POST") return;
    const body = await readBody(request);
    bodies.push(body.toString("utf8"));
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
  return { server, events, bodies, host: `http://127.0.0.1:${port}` };
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

// One request to an unanswering host costs this long before it gives up.
const REQUEST_TIMEOUT_MS = 500;

const posthogClient = (host: string): PostHog => {
  const client = new PostHog("phc_test_key", {
    host,
    flushAt: 1,
    flushInterval: 0,
    requestTimeout: REQUEST_TIMEOUT_MS,
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
    expect(entry.value).toBe("[message withheld]");
    expect(
      entry.stacktrace.frames.some((frame) =>
        frame.filename?.endsWith("error-reporter.test.ts"),
      ),
    ).toBe(true);
  });

  it("sends a fatal exception without the room code in its URL", async () => {
    const fake = await startFakePostHog();
    servers.push(fake.server);
    const reporter = reporterFor(posthogClient(fake.host));

    await reporter.reportFatal(
      new Error("Join failed at https://conclave.test/lime-pear-plum?invite=private"),
      { source: "uncaught_exception" },
      2000,
    );

    const exception = fake.events.find((event) => event.event === "$exception");
    const list = exception?.properties.$exception_list as Array<{ value: string }>;
    expect(list[0].value).toBe("[message withheld]");
    expect(fake.bodies.join("\n")).not.toMatch(/lime-pear-plum|private/);
  });

  it("sends no source lines and no credentials, whatever the URI scheme", async () => {
    const fake = await startFakePostHog();
    servers.push(fake.server);
    const reporter = reporterFor(posthogClient(fake.host));

    reporter.report(
      new Error(
        "Startup failed: redis://:review-secret@127.0.0.1:6379/0 postgres://app:pg-pass@db.internal/main " +
          "https://deploy-token@git.conclave.test/x password=hunter2 api_key: sk-live-0123 " +
          "Authorization: Bearer abc.def.ghi for alice@example.com?token=secret",
      ),
      { source: "startup_failed" },
    );

    await waitFor(() => fake.events.some((event) => event.event === "$exception"));
    const request = fake.bodies.join("\n");
    expect(request).not.toMatch(
      /review-secret|pg-pass|deploy-token|hunter2|sk-live|abc\.def|alice@example|token=secret/,
    );
    expect(request).not.toMatch(/pre_context|context_line|post_context/);
  });

  it("redacts whole credential headers and home folders in the request", async () => {
    const fake = await startFakePostHog();
    servers.push(fake.server);
    const reporter = reporterFor(posthogClient(fake.host));

    reporter.report(
      new Error(
        "Upstream rejected the request\nCookie: theme=dark; session=second_private\n" +
          "Set-Cookie: sid=set_private; Path=/\nAuthorization: Bearer short_private\n" +
          "Proxy-Authorization: Basic cHJveHk\n" +
          "ENOENT: no such file or directory, open '/Users/operator_private/config/tls.crt' " +
          "and /home/deploy_private/conclave/.env",
      ),
      { source: "startup_failed" },
    );

    await waitFor(() => fake.events.some((event) => event.event === "$exception"));
    const request = fake.bodies.join("\n");
    expect(request).not.toMatch(
      /theme=dark|second_private|set_private|short_private|cHJveHk|operator_private|deploy_private/,
    );
  });

  it("keeps only the errno code of a system error", async () => {
    const fake = await startFakePostHog();
    servers.push(fake.server);
    const reporter = reporterFor(posthogClient(fake.host));
    let failure: unknown;
    try {
      readFileSync("/Users/Review GivenName/config/tls.crt");
    } catch (error) {
      failure = error;
    }

    reporter.report(failure, { source: "startup_failed" });

    await waitFor(() => fake.events.some((event) => event.event === "$exception"));
    const [entry] = fake.events.find((event) => event.event === "$exception")!.properties
      .$exception_list as Array<{ value: string }>;
    expect(entry.value).toBe("ENOENT: [message withheld]");
    expect(fake.bodies.join("\n")).not.toMatch(/GivenName|tls\.crt/);
  });

  it.each([
    ["a rejected string", "Meet Mira in sample-room at seven", "non-Error string thrown or rejected"],
    ["a rejected {name, message} object", { name: "Meet Mira", message: "ReviewMessageCanary" }, "non-Error object thrown or rejected"],
  ])("normalizes %s to a NonErrorValue", async (_case, value, message) => {
    const fake = await startFakePostHog();
    servers.push(fake.server);
    const reporter = reporterFor(posthogClient(fake.host));

    await reporter.reportFatal(value, { source: "unhandled_rejection" }, 2000);

    const [entry] = fake.events.find((event) => event.event === "$exception")!.properties
      .$exception_list as Array<{ type: string; value: string }>;
    expect(entry).toMatchObject({ type: "NonErrorValue", value: message });
    expect(fake.bodies.join("\n")).not.toMatch(/Mira|sample-room|ReviewMessageCanary/);
  });

  it("keeps the message of a ConfigError, which names the variable only", async () => {
    const fake = await startFakePostHog();
    servers.push(fake.server);
    const reporter = reporterFor(posthogClient(fake.host));

    reporter.report(new ConfigError("Invalid SFU_CORS_ORIGINS entry at index 1"), {
      source: "startup_failed",
    });

    await waitFor(() => fake.events.some((event) => event.event === "$exception"));
    const [entry] = fake.events.find((event) => event.event === "$exception")!.properties
      .$exception_list as Array<{ type: string; value: string }>;
    expect(entry).toMatchObject({
      type: "ConfigError",
      value: "Invalid SFU_CORS_ORIGINS entry at index 1",
    });
  });

  it("withholds unknown types and keeps a stackless TypeError's type", () => {
    const scrubbed = scrubExceptionEvent({
      event: "$exception",
      properties: {
        $exception_list: [
          { type: "Meet Mira", value: "ReviewMessageCanary", mechanism: { synthetic: true } },
          { type: "TypeError", value: "ReviewTypeCanary is not a function", mechanism: { synthetic: true } },
        ],
      },
    });

    expect(scrubbed.properties?.$exception_list).toEqual([
      { type: "[type withheld]", value: "[message withheld]", mechanism: { synthetic: true } },
      { type: "TypeError", value: "[message withheld]", mechanism: { synthetic: true } },
    ]);
  });

  it("strips home folders from stack frame paths", () => {
    const scrubbed = scrubExceptionEvent({
      event: "$exception",
      properties: {
        $exception_list: [
          {
            value: "boom",
            stacktrace: {
              frames: [
                { filename: "/Users/operator_private/conclave/packages/sfu/server.ts", lineno: 1 },
                { filename: "/home/Review GivenName/conclave/packages/sfu/server.ts", lineno: 4 },
                { filename: "C:\\Users\\operator_private\\sfu\\server.js", lineno: 2 },
                { filename: "server/socket/joinRoom.ts", lineno: 3 },
              ],
            },
          },
        ],
      },
    });

    expect(JSON.stringify(scrubbed)).not.toMatch(/operator_private|Review|GivenName/);
    expect(JSON.stringify(scrubbed)).toContain("~/conclave/packages/sfu/server.ts");
    expect(JSON.stringify(scrubbed)).toContain("server/socket/joinRoom.ts");
  });

  it.each([
    ["webinar https://conclave.test/w/spring-demo?x=1", "webinar https://conclave.test/w/[code]"],
    ["api https://sfu.conclave.test/rooms/lime-pear-plum/state", "api https://sfu.conclave.test/[path]"],
    ["home https://conclave.test/", "home https://conclave.test/"],
    ["bad https://[ url", "bad [url] url"],
  ])("scrubs %s to %s", (input, expected) => {
    expect(scrubErrorText(input)).toBe(expected);
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

    // Waiting on the network even once would cost a full request timeout, so
    // every bound below sits under one; plain CPU time stays well clear.
    const reportStartedAt = Date.now();
    for (let index = 0; index < 5; index += 1) {
      expect(() =>
        reporter.report(new Error(`handler failed ${index}`), {
          source: "socket_handler",
        }),
      ).not.toThrow();
    }
    expect(Date.now() - reportStartedAt).toBeLessThan(REQUEST_TIMEOUT_MS);

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
    expect(timerFiredAt - scheduledAt).toBeLessThan(REQUEST_TIMEOUT_MS);
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

  it("still sends and flushes a crash that follows a burst of errors", async () => {
    const sent: Array<{ error: unknown; level: string }> = [];
    let flushes = 0;
    const fakeClient: ExceptionClient = {
      captureException: (error, options) => sent.push({ error, level: options.level }),
      captureExceptionImmediate: async (error, options) => {
        sent.push({ error, level: options.level });
      },
      flush: async () => {
        flushes += 1;
      },
    };
    const reporter = reporterFor(fakeClient, () => 0);

    for (let index = 0; index < 80; index += 1) {
      reporter.report(new Error(`handler failed ${index}`), { source: "socket_handler" });
    }
    const crash = new Error("worker pool exhausted");
    await reporter.reportFatal(crash, { source: "uncaught_exception" }, 200);

    expect(sent.filter((entry) => entry.level === "error")).toHaveLength(60);
    expect(sent.at(-1)).toEqual({ error: crash, level: "fatal" });
    expect(flushes).toBe(1);
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
