import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  diffOccupancy,
  verifyAdminSocketToken,
  type RoomOccupancy,
} from "../server/admin/adminGateway.js";

const SECRET = "test-secret";

const mint = (payload: Record<string, unknown>, secret = SECRET): string => {
  const encoded = Buffer.from(JSON.stringify(payload), "utf8").toString(
    "base64url",
  );
  const signature = createHmac("sha256", secret)
    .update(encoded)
    .digest("base64url");
  return `${encoded}.${signature}`;
};

describe("verifyAdminSocketToken", () => {
  it("accepts a validly signed, unexpired token", () => {
    const token = mint({ sub: "ops@example.com", exp: Date.now() + 60_000 });
    const result = verifyAdminSocketToken(token, SECRET);
    expect(result).toEqual({ ok: true, subject: "ops@example.com" });
  });

  it("rejects an expired token", () => {
    const token = mint({ sub: "ops@example.com", exp: Date.now() - 1_000 });
    expect(verifyAdminSocketToken(token, SECRET).ok).toBe(false);
  });

  it("rejects a token signed with the wrong secret", () => {
    const token = mint(
      { sub: "ops@example.com", exp: Date.now() + 60_000 },
      "some-other-secret",
    );
    expect(verifyAdminSocketToken(token, SECRET).ok).toBe(false);
  });

  it("rejects a tampered payload even with the original signature", () => {
    const token = mint({ sub: "ops@example.com", exp: Date.now() + 60_000 });
    const [, signature] = token.split(".");
    const forgedPayload = Buffer.from(
      JSON.stringify({ sub: "attacker", exp: Date.now() + 60_000 }),
      "utf8",
    ).toString("base64url");
    expect(
      verifyAdminSocketToken(`${forgedPayload}.${signature}`, SECRET).ok,
    ).toBe(false);
  });

  it("rejects malformed input and missing secrets", () => {
    expect(verifyAdminSocketToken(undefined, SECRET).ok).toBe(false);
    expect(verifyAdminSocketToken("not-a-token", SECRET).ok).toBe(false);
    expect(verifyAdminSocketToken("a.b", SECRET).ok).toBe(false);
    const token = mint({ sub: "x", exp: Date.now() + 60_000 });
    expect(verifyAdminSocketToken(token, "").ok).toBe(false);
  });

  it("falls back to a generic subject when sub is missing", () => {
    const token = mint({ exp: Date.now() + 60_000 });
    const result = verifyAdminSocketToken(token, SECRET);
    expect(result).toEqual({ ok: true, subject: "operator" });
  });
});

const occupancy = (
  roomId: string,
  users: Array<[string, string]>,
  overrides?: Partial<RoomOccupancy>,
): RoomOccupancy => ({
  roomId,
  users: new Map(users),
  screen: false,
  locked: false,
  pendingCount: 0,
  ...overrides,
});

describe("diffOccupancy", () => {
  const AT = 1_000;

  it("reports a new room and its occupants", () => {
    const events = diffOccupancy(
      new Map(),
      new Map([["c:r1", occupancy("r1", [["u1", "Alice"]])]]),
      AT,
    );
    expect(events.map((event) => event.type)).toEqual([
      "room-opened",
      "user-joined",
    ]);
    expect(events[1].message).toBe("Alice joined r1");
  });

  it("reports joins and leaves within an existing room", () => {
    const before = new Map([
      ["c:r1", occupancy("r1", [["u1", "Alice"], ["u2", "Bob"]])],
    ]);
    const after = new Map([
      ["c:r1", occupancy("r1", [["u1", "Alice"], ["u3", "Cara"]])],
    ]);
    const events = diffOccupancy(before, after, AT);
    expect(events).toHaveLength(2);
    expect(events.find((event) => event.type === "user-joined")?.message).toBe(
      "Cara joined r1",
    );
    expect(events.find((event) => event.type === "user-left")?.message).toBe(
      "Bob left r1",
    );
  });

  it("reports screen, lock, waiting, and close transitions", () => {
    const before = new Map([
      ["c:r1", occupancy("r1", [["u1", "Alice"]])],
      ["c:r2", occupancy("r2", [["u2", "Bob"]])],
    ]);
    const after = new Map([
      [
        "c:r1",
        occupancy("r1", [["u1", "Alice"]], {
          screen: true,
          locked: true,
          pendingCount: 2,
        }),
      ],
    ]);
    const events = diffOccupancy(before, after, AT);
    const types = events.map((event) => event.type).sort();
    expect(types).toEqual([
      "room-closed",
      "room-locked",
      "screen-started",
      "waiting",
    ]);
    expect(events.find((event) => event.type === "waiting")?.message).toBe(
      "2 people are waiting to join r1",
    );
  });

  it("is silent when nothing changed", () => {
    const view = new Map([["c:r1", occupancy("r1", [["u1", "Alice"]])]]);
    expect(diffOccupancy(view, view, AT)).toEqual([]);
  });
});
