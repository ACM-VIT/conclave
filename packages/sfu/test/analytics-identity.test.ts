import { describe, expect, it } from "vitest";
import { analyticsDistinctId } from "../server/analytics/identity.js";

describe("analytics identity", () => {
  it("turns email-like identities into stable opaque distinct ids", () => {
    const first = analyticsDistinctId("alice@example.com");
    const second = analyticsDistinctId("alice@example.com");

    expect(first).toBe(second);
    expect(first).toMatch(/^user_[a-f0-9]{32}$/);
    expect(first).not.toContain("alice");
    expect(first).not.toContain("example.com");
  });
});
