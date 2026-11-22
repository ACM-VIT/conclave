import { describe, expect, it } from "vitest";
import { analyticsDistinctId, analyticsRoomKey } from "../server/analytics/identity.js";

describe("analytics identity", () => {
  it("turns email-like identities into stable opaque distinct ids", () => {
    const first = analyticsDistinctId("alice@example.com");
    const second = analyticsDistinctId("alice@example.com");

    expect(first).toBe(second);
    expect(first).toMatch(/^user_[a-f0-9]{32}$/);
    expect(first).not.toContain("alice");
    expect(first).not.toContain("example.com");
  });

  it("turns a room channel id into a stable key that does not reveal the code", () => {
    const channel = "conclave:lime-pear-plum";
    const key = analyticsRoomKey(channel);

    expect(analyticsRoomKey(channel)).toBe(key);
    expect(key).toMatch(/^room_[a-f0-9]{32}$/);
    expect(key).not.toMatch(/lime|pear|plum|conclave/);
    expect(key.slice(5)).not.toBe(analyticsDistinctId(channel).slice(5));
    expect(analyticsRoomKey("conclave:other-room")).not.toBe(key);
  });
});
