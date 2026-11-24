import { describe, expect, it } from "vitest";
import { readJoinTokenUserKey } from "../src/app/lib/join-token-identity";

const tokenWith = (claims: Record<string, unknown>): string =>
  [
    Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url"),
    Buffer.from(JSON.stringify(claims)).toString("base64url"),
    "signature",
  ].join(".");

describe("the identity a client reads from its join token", () => {
  it("is the seat key the join route issued a guest", () => {
    const token = tokenWith({
      userId: "guest-gp_AAAAAAAAAAAAAAAAAAAAAA",
      sessionId: "tab-1",
      name: "Zoë 🎧",
    });

    expect(readJoinTokenUserKey(token)).toBe("guest-gp_AAAAAAAAAAAAAAAAAAAAAA");
  });

  it("is the account's email, as the SFU keys it", () => {
    const token = tokenWith({ userId: "u1", email: " Alex@Example.com " });

    expect(readJoinTokenUserKey(token)).toBe("alex@example.com");
  });

  it.each(["", "not-a-token", "a.%%%.c", tokenWith({ name: "nobody" })])(
    "is nothing for %j",
    (token) => {
      expect(readJoinTokenUserKey(token)).toBeNull();
    },
  );
});
