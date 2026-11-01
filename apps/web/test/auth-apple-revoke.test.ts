import { describe, expect, it, vi } from "vitest";
import {
  APPLE_REVOKE_URL,
  revokeAppleAuthorizationForDeletion,
} from "../src/lib/apple-token-revocation";

const okFetch = () => vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 200 }));

describe("Apple token revocation on account deletion", () => {
  it("revokes the stored refresh token with the configured client credentials", async () => {
    const fetchImpl = okFetch();
    const outcome = await revokeAppleAuthorizationForDeletion({
      clientId: "in.acmvit.conclave.web",
      clientSecret: "client-secret-jwt",
      loadRefreshToken: async () => " refresh-token ",
      fetchImpl,
    });
    expect(outcome).toBe("revoked");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe(APPLE_REVOKE_URL);
    expect(init?.method).toBe("POST");
    expect(new Headers(init?.headers).get("content-type")).toBe("application/x-www-form-urlencoded");
    expect(Object.fromEntries(new URLSearchParams(String(init?.body)))).toEqual({
      client_id: "in.acmvit.conclave.web",
      client_secret: "client-secret-jwt",
      token: "refresh-token",
      token_type_hint: "refresh_token",
    });
  });

  it("does nothing when Apple sign-in is not configured", async () => {
    const fetchImpl = okFetch();
    const loadRefreshToken = vi.fn(async () => "refresh-token");
    expect(await revokeAppleAuthorizationForDeletion({
      clientId: undefined, clientSecret: "secret", loadRefreshToken, fetchImpl,
    })).toBe("not-configured");
    expect(loadRefreshToken).not.toHaveBeenCalled();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("skips the call when the account holds no Apple refresh token", async () => {
    const fetchImpl = okFetch();
    for (const loadRefreshToken of [
      async () => null,
      async () => "  ",
      async () => { throw new Error("REFRESH_TOKEN_NOT_FOUND"); },
    ]) {
      expect(await revokeAppleAuthorizationForDeletion({
        clientId: "id", clientSecret: "secret", loadRefreshToken, fetchImpl,
      })).toBe("no-apple-token");
    }
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("logs and resolves when Apple rejects or the network fails, so deletion continues", async () => {
    const log = vi.fn();
    const rejected = vi.fn<typeof fetch>().mockResolvedValue(new Response("invalid_client", { status: 400 }));
    expect(await revokeAppleAuthorizationForDeletion({
      clientId: "id", clientSecret: "secret", loadRefreshToken: async () => "apple-refresh-secret", fetchImpl: rejected, log,
    })).toBe("failed");
    expect(log).toHaveBeenLastCalledWith("[auth] Apple token revocation failed", { status: 400 });

    const offline = vi.fn<typeof fetch>().mockRejectedValue(new TypeError("fetch failed"));
    expect(await revokeAppleAuthorizationForDeletion({
      clientId: "id", clientSecret: "secret", loadRefreshToken: async () => "apple-refresh-secret", fetchImpl: offline, log,
    })).toBe("failed");
    expect(log).toHaveBeenLastCalledWith("[auth] Apple token revocation failed", { error: "TypeError" });
    expect(JSON.stringify(log.mock.calls)).not.toContain("apple-refresh-secret");
  });
});
