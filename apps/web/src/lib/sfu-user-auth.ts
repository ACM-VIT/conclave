import { auth } from "@/lib/auth";
import {
  resolveSfuClientId,
  resolveSfuSecret,
  resolveSfuUrl,
} from "@/lib/sfu-admin-auth";

export type SfuAuthenticatedUser = {
  id: string;
  email: string | null;
  name: string | null;
  isAdmin: boolean;
};

const parseCsv = (value: string | undefined): string[] => {
  if (!value) return [];
  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
};

const allowlistedAdminEmails = new Set(
  parseCsv(
    process.env.SFU_ADMIN_ALLOWLIST_EMAILS ||
      process.env.SFU_ADMIN_ALLOWED_EMAILS,
  ).map((entry) => entry.toLowerCase()),
);

const allowlistedAdminDomains = new Set(
  parseCsv(
    process.env.SFU_ADMIN_ALLOWLIST_DOMAINS ||
      process.env.SFU_ADMIN_ALLOWED_DOMAINS,
  ).map((entry) => entry.toLowerCase().replace(/^@/, "")),
);

const allowlistedAdminUserIds = new Set(
  parseCsv(
    process.env.SFU_ADMIN_ALLOWLIST_USER_IDS ||
      process.env.SFU_ADMIN_ALLOWED_USER_IDS,
  ),
);

const isAdmin = (user: SfuAuthenticatedUser): boolean => {
  if (allowlistedAdminUserIds.has(user.id)) return true;
  if (user.email) {
    const normalized = user.email.toLowerCase();
    if (allowlistedAdminEmails.has(normalized)) return true;
    const domain = normalized.split("@")[1] ?? "";
    if (domain && allowlistedAdminDomains.has(domain)) return true;
  }
  return false;
};

export const requireSfuSessionUser = async (
  request: Request,
): Promise<
  | { ok: true; user: SfuAuthenticatedUser }
  | { ok: false; status: number; error: string }
> => {
  const session = await auth.api
    .getSession({ headers: request.headers })
    .catch(() => null);
  const user = session?.user;
  if (!user?.id) {
    return { ok: false, status: 401, error: "Authentication required" };
  }
  if (!user.email) {
    return {
      ok: false,
      status: 403,
      error: "Email is required on your account to manage Conclave sessions",
    };
  }
  const normalized: SfuAuthenticatedUser = {
    id: user.id,
    email: user.email.trim().toLowerCase(),
    name: user.name || null,
    isAdmin: false,
  };
  normalized.isAdmin = isAdmin(normalized);
  return { ok: true, user: normalized };
};

export const buildScheduledWebinarHeaders = (
  user: SfuAuthenticatedUser,
  request: Request,
): Headers => {
  const headers = new Headers();
  headers.set("x-sfu-secret", resolveSfuSecret());
  headers.set("accept", "application/json");
  headers.set("content-type", "application/json");
  const clientId = resolveSfuClientId(request);
  if (clientId) {
    headers.set("x-sfu-client", clientId);
  }
  if (user.email) headers.set("x-user-email", user.email);
  if (user.name) headers.set("x-user-name", user.name);
  headers.set("x-user-id", user.id);
  headers.set("x-user-is-admin", user.isAdmin ? "1" : "0");
  return headers;
};

export const resolveScheduledWebinarsBase = (): string => {
  const base = resolveSfuUrl().replace(/\/$/, "");
  return `${base}/scheduled-webinars`;
};

export type ScheduledWebinarHostInfo = {
  id: string;
  roomId: string;
  hostEmail: string;
  coHostEmails: string[];
  status: string;
};

export const lookupScheduledWebinarByRoomId = async (
  clientId: string,
  roomId: string,
): Promise<ScheduledWebinarHostInfo | null> => {
  try {
    const base = resolveScheduledWebinarsBase();
    const response = await fetch(
      `${base}/by-room/${encodeURIComponent(clientId)}/${encodeURIComponent(roomId)}`,
      {
        method: "GET",
        headers: {
          "x-sfu-secret": resolveSfuSecret(),
          accept: "application/json",
        },
        cache: "no-store",
      },
    );
    if (!response.ok) return null;
    const data = (await response.json()) as {
      scheduledWebinar?: {
        id?: string;
        roomId?: string;
        hostEmail?: string;
        coHosts?: Array<{ email?: string }>;
        status?: string;
      };
    };
    const w = data?.scheduledWebinar;
    if (!w?.id || !w?.roomId) return null;
    const coHostEmails = (w.coHosts ?? [])
      .map((entry) => (entry?.email || "").trim().toLowerCase())
      .filter(Boolean);
    return {
      id: w.id,
      roomId: w.roomId,
      hostEmail: (w.hostEmail || "").trim().toLowerCase(),
      coHostEmails,
      status: w.status || "",
    };
  } catch {
    return null;
  }
};
