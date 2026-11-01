export const APPLE_REVOKE_URL = "https://appleid.apple.com/auth/revoke";
const APPLE_REVOKE_TIMEOUT_MS = 5_000;

export type AppleRevocationOutcome =
  | "revoked"
  | "not-configured"
  | "no-apple-token"
  | "failed";

export interface AppleRevocationInput {
  clientId: string | undefined;
  clientSecret: string | undefined;
  loadRefreshToken: () => Promise<string | null>;
  fetchImpl?: typeof fetch;
  log?: (message: string, detail?: unknown) => void;
}

export const revokeAppleAuthorizationForDeletion = async ({
  clientId,
  clientSecret,
  loadRefreshToken,
  fetchImpl = fetch,
  log = (message, detail) => console.warn(message, detail),
}: AppleRevocationInput): Promise<AppleRevocationOutcome> => {
  if (!clientId || !clientSecret) return "not-configured";

  let refreshToken: string | null;
  try {
    refreshToken = (await loadRefreshToken())?.trim() || null;
  } catch {
    return "no-apple-token";
  }
  if (!refreshToken) return "no-apple-token";

  try {
    const response = await fetchImpl(APPLE_REVOKE_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        token: refreshToken,
        token_type_hint: "refresh_token",
      }),
      signal: AbortSignal.timeout(APPLE_REVOKE_TIMEOUT_MS),
    });
    if (response.ok) return "revoked";
    log("[auth] Apple token revocation failed", { status: response.status });
    return "failed";
  } catch (error) {
    log("[auth] Apple token revocation failed", {
      error: error instanceof Error ? error.name : "unknown",
    });
    return "failed";
  }
};
