import { spawn } from "node:child_process";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { gunzipSync } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";

const SFU_DIR = path.resolve(import.meta.dirname, "..");
const servers: Server[] = [];

afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

const startFakePostHog = async () => {
  const events: Array<{ event: string; properties: Record<string, unknown> }> = [];
  const record = async (request: IncomingMessage) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk as Buffer);
    const raw = Buffer.concat(chunks);
    try {
      const body = JSON.parse((raw[0] === 0x1f && raw[1] === 0x8b ? gunzipSync(raw) : raw).toString("utf8")) as {
        batch?: typeof events;
      };
      events.push(...(body.batch ?? []));
    } catch {}
  };
  const server = createServer((request, response) => {
    void record(request).finally(() => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end('{"status":1}');
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  servers.push(server);
  return { events, host: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
};

describe("an SFU whose configuration fails as it loads", () => {
  it("reports the startup failure before it exits", async () => {
    const fake = await startFakePostHog();
    // Only what the run needs, so no developer setting leaks in; the .env
    // files the SFU reads cannot override these.
    const env = {
      PATH: process.env.PATH ?? "",
      HOME: process.env.HOME ?? "",
      SFU_WEBRTC_ENABLE_UDP: "0",
      SFU_WEBRTC_ENABLE_TCP: "0",
      SFU_POSTHOG_ENABLED: "1",
      SFU_POSTHOG_KEY: "phc_test_key",
      SFU_POSTHOG_HOST: fake.host,
      SFU_SECRET: "startup-config-crash-test-secret",
      SFU_INSTANCE_ID: "sfu-config-crash",
      SFU_DEBUG_SECRET: "0",
      SFU_PORT: "0",
    };
    const child = spawn(process.execPath, ["--import", "tsx", "server.ts"], { cwd: SFU_DIR, env, stdio: "pipe" });
    let output = "";
    child.stdout.on("data", (chunk: Buffer) => (output += chunk.toString()));
    child.stderr.on("data", (chunk: Buffer) => (output += chunk.toString()));
    const code = await new Promise<number | null>((resolve) => child.on("exit", resolve));

    expect(code, output).toBe(1);
    expect(output).toContain("At least one of SFU_WEBRTC_ENABLE_UDP or SFU_WEBRTC_ENABLE_TCP must be enabled");
    const exceptions = fake.events.filter((event) => event.event === "$exception");
    expect(exceptions.map((event) => [event.properties.source, event.properties.$exception_level])).toEqual([
      ["startup_failed", "fatal"],
    ]);
  }, 30_000);
});
