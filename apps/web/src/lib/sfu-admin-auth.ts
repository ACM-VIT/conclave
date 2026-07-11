import { createHmac } from "node:crypto";
import { auth } from "@/lib/auth";
import {
  canonicalizeSfuClientId,
  resolveServerSfuClientId,
} from "@/lib/sfu-client-id";
export { resolveSfuUrl } from "@/lib/sfu-url";

const firstNonEmpty = (...values: Array<string | undefined>): string | undefined => {
  for (const value of values) {
    const normalized = value?.trim();
    if (normalized) {
      return normalized;
    }
  }
  return undefined;
};

const parseCsv = (value: string | undefined): string[] => {
  if (!value) return [];
  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
};

const normalizeEmail = (value: string | null | undefined): string | null => {
  const normalized = value?.trim().toLowerCase();
  return normalized || null;
};

const normalizeDomain = (value: string): string | null => {
  const normalized = value.trim().toLowerCase().replace(/^@/, "");
  return normalized || null;
};

const parseBoolean = (value: string | undefined): boolean =>
  ["1", "true", "yes", "on"].includes((value || "").trim().toLowerCase());

const allowlistedEmails = new Set(
  parseCsv(
    firstNonEmpty(
      process.env.SFU_ADMIN_ALLOWLIST_EMAILS,
      process.env.SFU_ADMIN_ALLOWED_EMAILS,
      process.env.SFU_DASHBOARD_ALLOWLIST_EMAILS,
    ),
  )
    .map((email) => normalizeEmail(email))
    .filter((email): email is string => Boolean(email)),
);

const allowlistedUserIds = new Set(
  parseCsv(
    firstNonEmpty(
      process.env.SFU_ADMIN_ALLOWLIST_USER_IDS,
      process.env.SFU_ADMIN_ALLOWED_USER_IDS,
      process.env.SFU_DASHBOARD_ALLOWLIST_USER_IDS,
    ),
  ),
);

const allowlistedDomains = new Set(
  parseCsv(
    firstNonEmpty(
      process.env.SFU_ADMIN_ALLOWLIST_DOMAINS,
      process.env.SFU_ADMIN_ALLOWED_DOMAINS,
      process.env.SFU_DASHBOARD_ALLOWLIST_DOMAINS,
    ),
  )
    .map((domain) => normalizeDomain(domain))
    .filter((domain): domain is string => Boolean(domain)),
);

const isAllowlistRequired = parseBoolean(process.env.SFU_ADMIN_REQUIRE_ALLOWLIST);
const hasAllowlistEntries =
  allowlistedEmails.size > 0 ||
  allowlistedUserIds.size > 0 ||
  allowlistedDomains.size > 0;

export type AuthorizedSfuAdminUser = {
  id: string;
  email: string | null;
  name: string | null;
};

const isAllowlisted = (user: AuthorizedSfuAdminUser): boolean => {
  if (allowlistedUserIds.has(user.id)) {
    return true;
  }

  const normalizedEmail = normalizeEmail(user.email);
  if (normalizedEmail && allowlistedEmails.has(normalizedEmail)) {
    return true;
  }

  if (normalizedEmail) {
    const [, domain = ""] = normalizedEmail.split("@");
    if (domain && allowlistedDomains.has(domain)) {
      return true;
    }
  }

  return false;
};

const getAllowlistConfigurationError = (): string | null => {
  if (hasAllowlistEntries) {
    return null;
  }

  if (isAllowlistRequired) {
    return "SFU admin allowlist is required but not configured. Set SFU_ADMIN_ALLOWLIST_* env vars.";
  }

  return "SFU admin access is disabled until an allowlist is configured. Set SFU_ADMIN_ALLOWLIST_* env vars.";
};

export const resolveSfuSecret = (): string =>
  process.env.SFU_SECRET || "development-secret";

export const resolveSfuClientId = (
  request: Request,
  options?: { fallback?: string },
): string => {
  const fromQuery = canonicalizeSfuClientId(
    new URL(request.url).searchParams.get("clientId"),
  );
  const fromHeader = canonicalizeSfuClientId(
    request.headers.get("x-sfu-client"),
  );
  return (
    fromQuery ||
    fromHeader ||
    resolveServerSfuClientId() ||
    canonicalizeSfuClientId(options?.fallback) ||
    ""
  );
};

export const requireSfuAdminUser = async (
  request: Request,
): Promise<
  | { ok: true; user: AuthorizedSfuAdminUser }
  | { ok: false; status: number; error: string }
> => {
  const session = await auth.api
    .getSession({
      headers: request.headers,
    })
    .catch(() => null);

  const user = session?.user;
  if (!user?.id) {
    return { ok: false, status: 401, error: "Authentication required" };
  }

  const allowlistConfigurationError = getAllowlistConfigurationError();
  if (allowlistConfigurationError) {
    return {
      ok: false,
      status: 503,
      error: allowlistConfigurationError,
    };
  }

  const normalizedUser: AuthorizedSfuAdminUser = {
    id: user.id,
    email: normalizeEmail(user.email),
    name: user.name || null,
  };

  if (!isAllowlisted(normalizedUser)) {
    return { ok: false, status: 403, error: "You are not authorized for SFU admin access" };
  }

  return { ok: true, user: normalizedUser };
};

/**
 * Mint a short-lived HMAC token for the SFU admin socket namespace. The
 * browser can never hold the SFU secret, so the server signs a small payload
 * with it and the SFU gateway verifies the signature on the socket handshake.
 * Format: base64url(payload).base64url(hmacSha256(payload, secret)).
 */
export const mintSfuAdminSocketToken = (
  subject: string,
  ttlMs = 5 * 60_000,
): string => {
  const payload = Buffer.from(
    JSON.stringify({ sub: subject, exp: Date.now() + ttlMs }),
    "utf8",
  ).toString("base64url");
  const signature = createHmac("sha256", resolveSfuSecret())
    .update(payload)
    .digest("base64url");
  return `${payload}.${signature}`;
};
