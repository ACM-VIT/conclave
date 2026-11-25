import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { createHmac } from "node:crypto";
import { connect, type AddressInfo } from "node:net";
import { gunzipSync } from "node:zlib";
import { PostHog } from "posthog-node";
import { afterEach, describe, expect, it } from "vitest";
import type { EventMessage } from "posthog-node";
import {
  createErrorReporter,
  scrubErrorText,
  type ExceptionClient,
} from "../server/analytics/errorReporter.js";
import {
  createFramePath,
  createOutboundEvent,
  type FramePathOptions,
  SFU_ROOT,
} from "../server/analytics/outbound.js";
import { ConfigError } from "../server/configError.js";
import { getGameCatalog } from "../server/games/registry.js";

const SFU_ID = "sfu_0123456789abcdef";
const RELEASE = "0b2d3b48";

// The SFU's beforeSend, for a release and the socket events a test registered.
const outboundFor = (frames: FramePathOptions = { root: SFU_ROOT, cwd: () => process.cwd() }) =>
  createOutboundEvent({
    release: RELEASE,
    framePath: createFramePath(frames),
    games: getGameCatalog,
    isSocketEvent: (name) => name === "joinRoom",
  });
const scrubExceptionEvent = outboundFor();
const exception = (properties: Record<string, unknown>): EventMessage => ({
  distinctId: SFU_ID,
  event: "$exception",
  properties,
});

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

const hashedInstance = (instanceId: string) =>
  `sfu_${createHmac("sha256", "test-instance-key").update(`instance:${instanceId}`).digest("hex").slice(0, 16)}`;

const reporterFor = (client: ExceptionClient | null, now = Date.now) =>
  createErrorReporter({
    getClient: () => client,
    instanceId: "sfu-a",
    hashKey: "test-instance-key",
    region: "eu-west-1",
    version: RELEASE,
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

    expect(exception.distinct_id).toBe(hashedInstance("sfu-a"));
    expect(exception.properties).toMatchObject({
      source: "socket_handler",
      socket_event: "joinRoom",
      sfu_instance_id: hashedInstance("sfu-a"),
      sfu_region: "eu-west-1",
      sfu_version: "0b2d3b48",
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

  it.each([
    ["Review Operator laptop", "operator-desk-7", "other"],
    ["sfu-b", "me-central-1", "me-central-1"],
    ["sfu-b", "local", "local"],
  ])(
    "sends instance %s hashed, region %s only from the list, and the release it was given",
    async (instanceId, region, sentRegion) => {
      const sent: Array<{ options: { distinctId: string; properties: Record<string, unknown> } }> = [];
      const reporter = createErrorReporter({
        getClient: () => ({
          captureException: (_error, options) => sent.push({ options }),
          captureExceptionImmediate: async () => {},
          flush: async () => {},
        }),
        instanceId,
        hashKey: "test-instance-key",
        region,
        version: RELEASE,
      });

      reporter.report(new Error("x"), { source: "socket_handler" });

      const [{ options }] = sent;
      expect(options.distinctId).toBe(hashedInstance(instanceId));
      expect(options.properties).toMatchObject({
        sfu_instance_id: hashedInstance(instanceId),
        sfu_region: sentRegion,
        sfu_version: RELEASE,
      });
      expect(JSON.stringify(sent)).not.toMatch(/Review|operator-desk/);
    },
  );

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

  it.each(["ConfigError", "NonErrorValue"])(
    "withholds the message of a plain Error that only calls itself %s",
    async (name) => {
      const fake = await startFakePostHog();
      servers.push(fake.server);
      const reporter = reporterFor(posthogClient(fake.host));

      reporter.report(Object.assign(new Error("Meet Mira in sample-room"), { name }), {
        source: "socket_handler",
      });

      await waitFor(() => fake.events.some((event) => event.event === "$exception"));
      const [entry] = fake.events.find((event) => event.event === "$exception")!.properties
        .$exception_list as Array<{ type: string; value: string }>;
      expect(entry).toMatchObject({ type: "[type withheld]", value: "[message withheld]" });
      expect(fake.bodies.join("\n")).not.toMatch(/Mira|sample-room/);
    },
  );

  it.each(["in order", "reversed"])(
    "keeps the errno code read from each error itself, reported %s",
    async (order) => {
      const fake = await startFakePostHog();
      servers.push(fake.server);
      const reporter = reporterFor(posthogClient(fake.host));
      const closed = createServer();
      await new Promise<void>((resolve) => closed.listen(0, "127.0.0.1", resolve));
      const { port } = closed.address() as AddressInfo;
      await new Promise((resolve) => closed.close(resolve));
      const refused = await new Promise<Error>((resolve) => {
        connect(port, "127.0.0.1").on("error", resolve);
      });
      const reports: Array<[Error, "redis_transient" | "socket_handler" | "startup_failed"]> = [
        [refused, "redis_transient"],
        [Object.assign(new Error("Meet Mira refused us"), { code: "EPIPE" }), "socket_handler"],
        [Object.assign(new Error("ENOENT: Meet Mira"), { code: "Meet_Mira" }), "startup_failed"],
      ];
      if (order === "reversed") reports.reverse();

      for (const [error, source] of reports) reporter.report(error, { source });

      await waitFor(() => fake.events.filter((event) => event.event === "$exception").length === 3);
      const valueBySource = Object.fromEntries(
        fake.events
          .filter((event) => event.event === "$exception")
          .map((event): [string, string] => [
            String(event.properties.source),
            (event.properties.$exception_list as Array<{ value: string }>)[0].value,
          ]),
      );
      expect(refused.message).not.toMatch(/^ECONNREFUSED/);
      expect(valueBySource).toEqual({
        redis_transient: "ECONNREFUSED: [message withheld]",
        socket_handler: "EPIPE: [message withheld]",
        startup_failed: "[message withheld]",
      });
      expect(fake.bodies.join("\n")).not.toMatch(/Mira|127\.0\.0\.1:\d/);
    },
  );

  it("trusts no message by its type name alone", () => {
    const scrubbed = scrubExceptionEvent(
      exception({
        $exception_list: [
          { type: "ConfigError", value: "Meet Mira in sample-room" },
          { type: "NonErrorValue", value: "Meet Mira in sample-room" },
          { type: "Error", value: "ENOENT: Meet Mira" },
        ],
      }),
    );

    expect(JSON.stringify(scrubbed)).not.toMatch(/Mira/);
  });

  it("withholds unknown types and keeps a stackless TypeError's type", () => {
    const scrubbed = scrubExceptionEvent(
      exception({
        $exception_list: [
          { type: "Meet Mira", value: "ReviewMessageCanary", mechanism: { synthetic: true } },
          { type: "TypeError", value: "ReviewTypeCanary is not a function", mechanism: { synthetic: true } },
        ],
      }),
    );

    expect(scrubbed?.properties?.$exception_list).toEqual([
      { type: "[type withheld]", value: "[message withheld]", mechanism: { type: "generic", synthetic: true } },
      { type: "TypeError", value: "[message withheld]", mechanism: { type: "generic", synthetic: true } },
    ]);
  });

  describe("frame paths", () => {
    const root = path.resolve(import.meta.dirname, "..");
    const own = "server/analytics/errorReporter.ts";
    const sentFrame = (cwd: string, filename: string) => {
      const scrub = outboundFor({ root, cwd: () => cwd });
      const scrubbed = scrub(
        exception({
          $exception_list: [
            {
              type: "Error",
              value: "x",
              stacktrace: {
                type: "raw",
                frames: [
                  { platform: "node:javascript", filename, abs_path: filename, module: "Review Operator.service:main", function: "main", lineno: 3, colno: 9, in_app: true },
                ],
              },
            },
          ],
        }),
      );
      return (scrubbed?.properties?.$exception_list as Array<{ stacktrace: { frames: unknown[] } }>)[0]
        .stacktrace.frames[0];
    };

    it("sends a path only for our own source: not under node_modules, and in the app", () => {
      const fixture = mkdtempSync(path.join(tmpdir(), "sfu-root-"));
      try {
        mkdirSync(path.join(fixture, "server"), { recursive: true });
        mkdirSync(path.join(fixture, "node_modules", "Fixture Operator extensions"), { recursive: true });
        writeFileSync(path.join(fixture, "server", "main.ts"), "");
        writeFileSync(path.join(fixture, "node_modules", "Fixture Operator extensions", "local-helper.js"), "");
        const scrub = outboundFor({ root: fixture, cwd: () => fixture });
        const sent = (filename: string, in_app: boolean) =>
          (scrub(
            exception({
              $exception_list: [{ type: "Error", value: "x", stacktrace: { type: "raw", frames: [{ filename, lineno: 1, in_app }] } }],
            }),
          )?.properties?.$exception_list as Array<{ stacktrace: { frames: Array<{ filename: string }> } }>)[0]
            .stacktrace.frames[0].filename;

        expect(sent("server/main.ts", true)).toBe("server/main.ts");
        expect(sent("server/main.ts", false)).toBe("[path]");
        expect(sent("node_modules/Fixture Operator extensions/local-helper.js", true)).toBe("[path]");
        expect(sent(path.join(fixture, "node_modules/Fixture Operator extensions/local-helper.js"), false)).toBe("[path]");
      } finally {
        rmSync(fixture, { recursive: true, force: true });
      }
    });

    it.each([
      ["an absolute path inside the SFU", "/", path.join(root, own), own],
      ["a path relative to the SFU's folder", root, own, own],
      ["a path relative to a folder above the SFU", path.dirname(root), `${path.basename(root)}/${own}`, own],
      ["a home folder the SDK made relative to /", "/", "home/Review Operator/service/main.ts", "[path]"],
      ["the same name under the SFU's folder", root, "home/Review Operator/service/main.ts", "[path]"],
      ["an absolute home folder", root, "/home/Review Operator/service/main.ts", "[path]"],
      ["a Windows path", root, "C:\\Users\\Review Operator\\sfu\\server.js", "[path]"],
      ["a ~ path", root, "~/conclave/packages/sfu/server.ts", "[path]"],
      ["a library file", root, path.resolve(root, "../../node_modules/posthog-node/package.json"), "[path]"],
      ["a Node internal", root, "node:internal/process/task_queues", "[path]"],
    ])("sends %s as its path in the SFU, or [path] and no function", (_case, cwd, filename, sent) => {
      expect(sentFrame(cwd, filename)).toEqual({
        platform: "node:javascript",
        filename: sent,
        function: sent === "[path]" ? "?" : "main",
        lineno: 3,
        colno: 9,
        in_app: true,
      });
    });
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

  describe("the frames it sends", () => {
    const forged = `    at forgedHandler (${path.join(SFU_ROOT, "server/socket/forged.ts")}:1:1)`;
    const sentStack = (error: Error): string => {
      const sent: unknown[] = [];
      const reporter = reporterFor({
        captureException: (reported) => sent.push(reported),
        captureExceptionImmediate: async () => {},
        flush: async () => {},
      });
      reporter.report(error, { source: "socket_handler" });
      return (sent[0] as Error).stack ?? "";
    };
    const realFrame = (error: Error) => error.stack!.split("\n").find((line) => line.includes("error-reporter.test.ts"))!;

    it("never takes a line of a many-line message for a frame", () => {
      const error = new TypeError(`handler failed\n${forged}\nand more`);
      const stack = sentStack(error);

      expect(stack).not.toContain("forgedHandler");
      expect(stack).toContain(realFrame(error));
    });

    it.each([
      ["a message", () => new Error("boom")],
      ["no message", () => new Error()],
      ["a name set after the stack was taken", () => {
        const error = new RangeError("out of range");
        error.name = "CustomFailure";
        return error;
      }],
    ])("keeps the real frames of an error with %s", (_case, make) => {
      const error = make();

      expect(sentStack(error)).toContain(realFrame(error));
    });

    it("sends no frames when the message no longer matches the stack it was read with", () => {
      const error = new Error("first");
      expect(error.stack).toContain("Error: first");
      error.message = `changed\n${forged}`;

      expect(sentStack(error)).not.toMatch(/\n\s+at /);
    });
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
    const fatal = sent.at(-1)!;
    expect(fatal).toMatchObject({ level: "fatal", error: { message: "[message withheld]" } });
    expect((fatal.error as Error).stack).toContain(crash.stack!.split("\n")[1]);
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
      hashKey: "test-instance-key",
      region: null,
      version: RELEASE,
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
