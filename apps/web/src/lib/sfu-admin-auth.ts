import { auth } from "@/lib/auth";

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
  if (!hasAllowlistEntries) {
    return !isAllowlistRequired;
  }

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

export const resolveSfuUrl = (): string =>
  process.env.SFU_URL || process.env.NEXT_PUBLIC_SFU_URL || "http://localhost:3031";

export const resolveSfuSecret = (): string =>
  process.env.SFU_SECRET || "development-secret";

export const resolveSfuClientId = (
  request: Request,
  options?: { fallback?: string },
): string => {
  const fromQuery = new URL(request.url).searchParams.get("clientId")?.trim() || "";
  const fromHeader = request.headers.get("x-sfu-client")?.trim() || "";
  const fromEnv =
    process.env.SFU_CLIENT_ID?.trim() ||
    process.env.NEXT_PUBLIC_SFU_CLIENT_ID?.trim() ||
    "";
  return fromQuery || fromHeader || fromEnv || options?.fallback || "";
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

  if (isAllowlistRequired && !hasAllowlistEntries) {
    return {
      ok: false,
      status: 503,
      error:
        "SFU admin allowlist is required but not configured. Set SFU_ADMIN_ALLOWLIST_* env vars.",
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
