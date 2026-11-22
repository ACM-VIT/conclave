import { afterEach, describe, expect, it, vi } from "vitest";

const loadIdentity = async (secret: string | undefined) => {
  vi.resetModules();
  if (secret === undefined) vi.stubEnv("SFU_SECRET", "");
  else vi.stubEnv("SFU_SECRET", secret);
  return import("../server/analytics/identity.js");
};

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("analytics identity", () => {
  it("turns email-like identities into stable opaque distinct ids", async () => {
    const { analyticsDistinctId } = await loadIdentity("a-real-deployment-secret");
    const first = analyticsDistinctId("alice@example.com");

    expect(analyticsDistinctId("alice@example.com")).toBe(first);
    expect(first).toMatch(/^user_[a-f0-9]{32}$/);
    expect(first).not.toContain("alice");
    expect(first).not.toContain("example.com");
  });

  it("turns a room channel id into a stable key that does not reveal the code", async () => {
    const { analyticsDistinctId, analyticsRoomKey } = await loadIdentity("a-real-deployment-secret");
    const channel = "conclave:lime-pear-plum";
    const key = analyticsRoomKey(channel);

    expect(analyticsRoomKey(channel)).toBe(key);
    expect(key).toMatch(/^room_[a-f0-9]{32}$/);
    expect(key).not.toMatch(/lime|pear|plum|conclave/);
    expect(key?.slice(5)).not.toBe(analyticsDistinctId(channel).slice(5));
    expect(analyticsRoomKey("conclave:other-room")).not.toBe(key);
  });

  it("groups no rooms and uses a process-only key when SFU_SECRET is not set", async () => {
    const withoutSecret = await loadIdentity(undefined);
    expect(withoutSecret.analyticsRoomKey("conclave:lime-pear-plum")).toBeNull();

    // The public fallback key would let anyone hash a guess and compare.
    const fallback = await loadIdentity("development-secret");
    expect(fallback.analyticsRoomKey("conclave:lime-pear-plum")).toBeNull();
    const id = fallback.analyticsDistinctId("alice@example.com");
    expect(id).toMatch(/^user_[a-f0-9]{32}$/);
    const { createHmac } = await import("node:crypto");
    const publicKeyHash = createHmac("sha256", "development-secret")
      .update("alice@example.com")
      .digest("hex")
      .slice(0, 32);
    expect(id).not.toBe(`user_${publicKeyHash}`);
  });
});
