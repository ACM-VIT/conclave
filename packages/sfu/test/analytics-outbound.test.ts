import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { gunzipSync } from "node:zlib";
import { PostHog } from "posthog-node";
import { afterEach, describe, expect, it } from "vitest";
import { createErrorReporter, SFU_RELEASE } from "../server/analytics/errorReporter.js";
import { createFramePath, createOutboundEvent, SFU_ROOT } from "../server/analytics/outbound.js";
import { getGameCatalog } from "../server/games/registry.js";

const RELEASE = SFU_RELEASE;
const beforeSend = createOutboundEvent({
  release: RELEASE,
  framePath: createFramePath({ root: SFU_ROOT, cwd: () => process.cwd() }),
  games: getGameCatalog,
  isSocketEvent: (name) => name === "joinRoom",
});
const SFU_ID = "sfu_0123456789abcdef";
const USER_ID = "user_0123456789abcdef0123456789abcdef";
const ROOM = "room_fedcba9876543210fedcba9876543210";
const OWN_FILE = path.resolve(import.meta.dirname, "../server/analytics/errorReporter.ts");

type Message = Parameters<typeof beforeSend>[0];

const servers: Server[] = [];
const clients: PostHog[] = [];
const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.shutdown(200)));
  const open = servers.splice(0);
  open.forEach((server) => server.closeAllConnections());
  await Promise.all(open.map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true }));
});

const startFakePostHog = async () => {
  const bodies: string[] = [];
  const record = async (request: IncomingMessage) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk as Buffer);
    const raw = Buffer.concat(chunks);
    bodies.push((raw[0] === 0x1f && raw[1] === 0x8b ? gunzipSync(raw) : raw).toString("utf8"));
  };
  const server = createServer((request, response) => {
    void record(request).finally(() => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end('{"status":1}');
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  servers.push(server);
  const { port } = server.address() as AddressInfo;
  const client = new PostHog("phc_test_key", {
    host: `http://127.0.0.1:${port}`,
    flushAt: 1,
    flushInterval: 0,
    captureMaxRetries: 0,
    enableExceptionAutocapture: false,
    beforeSend,
  });
  clients.push(client);
  return { client, bodies };
};

const waitFor = async (check: () => boolean, timeoutMs = 3000) => {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("timed out waiting");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};

describe("the SFU's outbound schema", () => {
  it("keeps a frame's function only where it keeps the frame's path: our own source", async () => {
    const outside = mkdtempSync(path.join(tmpdir(), "Review Operator-"));
    dirs.push(outside);
    const fixture = path.join(outside, "roster.mjs");
    writeFileSync(fixture, "export function operatorRosterFixture() { throw new Error('fixture exception'); }\n");
    const { operatorRosterFixture } = (await import(pathToFileURL(fixture).href)) as { operatorRosterFixture: () => void };
    const { client, bodies } = await startFakePostHog();
    const reporter = createErrorReporter({
      getClient: () => client,
      instanceId: "sfu-a",
      hashKey: "test-instance-key",
      region: "eu-west-1",
      version: RELEASE,
    });

    const ownCaller = (fixture: () => void) => fixture();
    try {
      ownCaller(operatorRosterFixture);
    } catch (error) {
      reporter.report(error, { source: "startup_failed" });
    }
    await waitFor(() => bodies.some((body) => body.includes("$exception")));

    const body = bodies.find((sent) => sent.includes("$exception"))!;
    const frames = (JSON.parse(body) as { batch: Array<{ properties: { $exception_list: Array<{ stacktrace: { frames: Array<{ filename: string; function: string }> } }> } }> })
      .batch[0].properties.$exception_list[0].stacktrace.frames;
    expect(frames.length).toBeGreaterThan(1);
    for (const frame of frames) {
      if (frame.filename === "[path]") expect(frame.function).toBe("?");
    }
    expect(frames).toContainEqual(
      expect.objectContaining({ filename: "test/analytics-outbound.test.ts", function: "ownCaller", in_app: true }),
    );
    expect(body).not.toMatch(/operatorRosterFixture|Review Operator|roster\.mjs/);
  });

  it("drops every field the schema does not list, at any depth, and any value not in its form", () => {
    const message = {
      distinctId: SFU_ID,
      event: "$exception",
      uuid: "0196f0a1-0000-7000-8000-0000000000aa",
      groups: { secret: "UnknownGroupCanary" },
      options: { process_person_profile: false, extra: "UnknownOptionCanary" },
      sendFeatureFlags: true,
      properties: {
        $exception_list: [
          {
            type: "TypeError",
            value: "UnknownMessageCanary",
            module: "UnknownModuleCanary",
            mechanism: { type: "generic", handled: true, data: "UnknownMechanismCanary" },
            stacktrace: {
              type: "raw",
              extra: "UnknownStacktraceCanary",
              frames: [
                {
                  platform: "node:javascript",
                  filename: OWN_FILE,
                  function: "report",
                  lineno: 1,
                  colno: 2,
                  in_app: true,
                  module: "UnknownModuleCanary",
                  context_line: "UnknownContextCanary",
                  pre_context: ["UnknownPreCanary"],
                  vars: { x: "UnknownVarsCanary" },
                },
              ],
            },
          },
        ],
        $exception_level: "error",
        source: "socket_handler",
        sfu_instance_id: SFU_ID,
        sfu_region: "eu-west-1",
        sfu_version: RELEASE,
        $process_person_profile: false,
        $lib: "posthog-node",
        $lib_version: "6.0.5",
        $is_server: true,
        $geoip_disable: true,
        $service_name: "UnknownServiceCanary",
        $trace_id: "UnknownTraceCanary",
        $release_id: "UnknownReleaseCanary",
        unknown_app_field: "UnknownAppCanary",
        socket_event: "UnknownSocketEventCanary",
        worker_label: "UnknownLabelCanary",
        $set: { email: "mira@example.com" },
      },
    };

    expect(beforeSend(message as unknown as Message)).toEqual({
      distinctId: SFU_ID,
      event: "$exception",
      uuid: "0196f0a1-0000-7000-8000-0000000000aa",
      options: { process_person_profile: false },
      properties: {
        $exception_list: [
          {
            type: "TypeError",
            value: "[message withheld]",
            mechanism: { type: "generic", handled: true },
            stacktrace: {
              type: "raw",
              frames: [
                {
                  platform: "node:javascript",
                  filename: "server/analytics/errorReporter.ts",
                  function: "report",
                  lineno: 1,
                  colno: 2,
                  in_app: true,
                },
              ],
            },
          },
        ],
        $exception_level: "error",
        source: "socket_handler",
        sfu_instance_id: SFU_ID,
        sfu_region: "eu-west-1",
        sfu_version: RELEASE,
        $process_person_profile: false,
        $lib: "posthog-node",
        $lib_version: "6.0.5",
        $is_server: true,
        $geoip_disable: true,
      },
    });
  });

  it("drops every game field the schema does not list, and any config the game does not offer", () => {
    const message = {
      distinctId: USER_ID,
      event: "game_started",
      groups: { room: ROOM },
      properties: {
        instance_id: "0196f0a1-0000-7000-8000-0000000000ab",
        game_id: "trivia",
        player_count: 3,
        has_leaderboard: true,
        config_questions: 7,
        config_pace: "fast",
        config_secret: "UnknownConfigCanary",
        has_topic: true,
        note: "UnknownNoteCanary",
        $groups: { room: ROOM, other: "UnknownGroupCanary" },
        $lib: "posthog-node",
        $lib_version: "6.0.5",
        $is_server: true,
        $geoip_disable: true,
      },
    };

    expect(beforeSend(message as unknown as Message)).toEqual({
      distinctId: USER_ID,
      event: "game_started",
      groups: { room: ROOM },
      properties: {
        instance_id: "0196f0a1-0000-7000-8000-0000000000ab",
        game_id: "trivia",
        player_count: 3,
        has_leaderboard: true,
        config_questions: 7,
        config_pace: "fast",
        has_topic: true,
        $groups: { room: ROOM },
        $lib: "posthog-node",
        $lib_version: "6.0.5",
        $is_server: true,
        $geoip_disable: true,
      },
    });
    const outOfRange = { ...message, properties: { ...message.properties, config_questions: 99, config_pace: "Meet Mira", game_id: "Meet Mira" } };
    expect(JSON.stringify(beforeSend(outOfRange as unknown as Message))).not.toMatch(/Mira|99|config_questions|game_id/);
  });

  it("sends only the events on the list", () => {
    for (const event of ["$identify", "$pageview", "$set", "game_secret", "Meet Mira joined"]) {
      expect(beforeSend({ distinctId: SFU_ID, event, properties: { $lib: "posthog-node" } })).toBeNull();
    }
  });
});
