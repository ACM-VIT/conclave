import { readFileSync } from "node:fs";
import { afterAll, describe, expect, it, vi } from "vitest";

// The SFU as an operator configured it: analytics on, and a release name in
// SFU_VERSION that no build of ours carries.
vi.hoisted(() => {
  process.env.SFU_VERSION = "facade00";
});
vi.mock("../server/analytics/settings.js", () => ({
  analyticsSettings: {
    enabled: true,
    projectApiKey: "phc_test_key",
    host: "http://127.0.0.1:9",
    flushAt: 1,
    flushIntervalMs: 0,
    requestTimeoutMs: 100,
    shutdownTimeoutMs: 100,
    instanceId: "sfu-a",
    region: "eu-west-1",
    secret: null,
  },
}));

const sent = vi.hoisted(() => [] as Array<{ properties: Record<string, unknown> }>);
vi.mock("posthog-node", () => ({
  PostHog: class {
    captureException(_error: unknown, options: { properties: Record<string, unknown> }) {
      sent.push(options);
    }
  },
}));

afterAll(() => {
  delete process.env.SFU_VERSION;
});

describe("the SFU's release", () => {
  it("comes from its own package, never from SFU_VERSION", async () => {
    const { version } = JSON.parse(
      readFileSync(new URL("../package.json", import.meta.url), "utf8"),
    ) as { version: string };
    const { captureServerException } = await import("../server/analytics/posthog.js");

    captureServerException(new Error("x"), { source: "socket_handler" });

    expect(sent).toHaveLength(1);
    expect(sent[0].properties.sfu_version).toBe(version);
    expect(JSON.stringify(sent)).not.toContain("facade00");
  });
});
