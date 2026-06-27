import { jwtVerify } from "jose";
import { NextResponse } from "next/server";
import {
  buildSchedulingHeaders,
  readSchedulingError,
  resolveSchedulingBase,
} from "@/lib/scheduling";
import { requireSfuSessionUser } from "@/lib/sfu-user-auth";

export const runtime = "nodejs";

const STATE_COOKIE = "conclave_google_calendar_state";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GOOGLE_USERINFO_URL = "https://openidconnect.googleapis.com/v1/userinfo";

const signingKey = (): Uint8Array =>
  new TextEncoder().encode(
    process.env.BETTER_AUTH_SECRET ||
      process.env.AUTH_SECRET ||
      "development-better-auth-secret",
  );

const getCookie = (request: Request, name: string): string | null => {
  const cookieHeader = request.headers.get("cookie") || "";
  for (const entry of cookieHeader.split(";")) {
    const [rawKey, ...rawValue] = entry.trim().split("=");
    if (rawKey === name) return rawValue.join("=") || null;
  }
  return null;
};

const getGoogleConfig = (): { clientId: string; clientSecret: string } => {
  const clientId = process.env.GOOGLE_CLIENT_ID?.trim();
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET?.trim();
  if (!clientId || !clientSecret) {
    throw new Error("Google OAuth is not configured.");
  }
  return { clientId, clientSecret };
};

const redirectWithStatus = (request: Request, status: string): NextResponse =>
  NextResponse.redirect(new URL(`/schedule?calendar=${status}`, request.url));

export async function GET(request: Request) {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const storedState = getCookie(request, STATE_COOKIE);
  if (!code || !state || !storedState || storedState !== state) {
    return redirectWithStatus(request, "invalid-state");
  }

  const authResult = await requireSfuSessionUser(request);
  if (!authResult.ok) {
    return NextResponse.redirect(new URL("/sign-in?next=/schedule", request.url));
  }

  let payload: Record<string, unknown>;
  try {
    const verified = await jwtVerify(state, signingKey());
    payload = verified.payload as Record<string, unknown>;
  } catch {
    return redirectWithStatus(request, "invalid-state");
  }
  if (payload.userId !== authResult.user.id) {
    return redirectWithStatus(request, "wrong-user");
  }

  let config: { clientId: string; clientSecret: string };
  try {
    config = getGoogleConfig();
  } catch {
    return redirectWithStatus(request, "not-configured");
  }

  try {
    const origin = url.origin;
    const tokenResponse = await fetch(GOOGLE_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code,
        client_id: config.clientId,
        client_secret: config.clientSecret,
        redirect_uri: `${origin}/api/scheduling/calendar/google/callback`,
        grant_type: "authorization_code",
      }),
    });
    const token = (await tokenResponse.json().catch(() => null)) as
      | {
          access_token?: string;
          refresh_token?: string;
          expires_in?: number;
          scope?: string;
        }
      | null;
    if (!tokenResponse.ok || !token?.access_token) {
      return redirectWithStatus(request, "token-error");
    }

    const userInfoResponse = await fetch(GOOGLE_USERINFO_URL, {
      headers: { Authorization: `Bearer ${token.access_token}` },
      cache: "no-store",
    });
    const userInfo = (await userInfoResponse.json().catch(() => null)) as
      | { email?: string }
      | null;
    const headers = buildSchedulingHeaders(authResult.user, request);
    if (typeof payload.clientId === "string" && payload.clientId.trim()) {
      headers.set("x-sfu-client", payload.clientId.trim());
    }
    headers.set("x-app-origin", origin);
    const response = await fetch(`${resolveSchedulingBase()}/calendar/google`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        email: userInfo?.email || authResult.user.email,
        accessToken: token.access_token,
        refreshToken: token.refresh_token || null,
        accessTokenExpiresAt:
          Date.now() + Math.max(token.expires_in ?? 3600, 60) * 1000,
        scopes: token.scope?.split(/\s+/).filter(Boolean) ?? [],
      }),
      cache: "no-store",
    });
    if (!response.ok) {
      const error = await readSchedulingError(response);
      return redirectWithStatus(
        request,
        error.toLowerCase().includes("configured") ? "not-configured" : "save-error",
      );
    }
    const next = redirectWithStatus(request, "connected");
    next.cookies.delete(STATE_COOKIE);
    return next;
  } catch {
    return redirectWithStatus(request, "error");
  }
}
