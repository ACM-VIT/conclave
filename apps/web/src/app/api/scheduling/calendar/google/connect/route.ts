import { SignJWT } from "jose";
import { NextResponse } from "next/server";
import { requireSfuSessionUser } from "@/lib/sfu-user-auth";

export const runtime = "nodejs";

const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const STATE_COOKIE = "conclave_google_calendar_state";
const SCOPES = [
  "openid",
  "email",
  "https://www.googleapis.com/auth/calendar.freebusy",
  "https://www.googleapis.com/auth/calendar.events",
];

const signingKey = (): Uint8Array =>
  new TextEncoder().encode(
    process.env.BETTER_AUTH_SECRET ||
      process.env.AUTH_SECRET ||
      "development-better-auth-secret",
  );

const getGoogleConfig = (): { clientId: string; clientSecret: string } => {
  const clientId = process.env.GOOGLE_CLIENT_ID?.trim();
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET?.trim();
  if (!clientId || !clientSecret) {
    throw new Error("Google OAuth is not configured.");
  }
  return { clientId, clientSecret };
};

export async function GET(request: Request) {
  const authResult = await requireSfuSessionUser(request);
  if (!authResult.ok) {
    return NextResponse.redirect(new URL("/sign-in?next=/schedule", request.url));
  }

  let config: { clientId: string; clientSecret: string };
  try {
    config = getGoogleConfig();
  } catch {
    return NextResponse.redirect(
      new URL("/schedule?calendar=not-configured", request.url),
    );
  }

  const origin = new URL(request.url).origin;
  const state = await new SignJWT({
    userId: authResult.user.id,
    clientId:
      request.headers.get("x-sfu-client") ||
      process.env.SFU_CLIENT_ID ||
      process.env.NEXT_PUBLIC_SFU_CLIENT_ID ||
      "default",
  })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime("10m")
    .setJti(crypto.randomUUID())
    .sign(signingKey());

  const authUrl = new URL(GOOGLE_AUTH_URL);
  authUrl.searchParams.set("client_id", config.clientId);
  authUrl.searchParams.set(
    "redirect_uri",
    `${origin}/api/scheduling/calendar/google/callback`,
  );
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("access_type", "offline");
  authUrl.searchParams.set("prompt", "consent");
  authUrl.searchParams.set("include_granted_scopes", "true");
  authUrl.searchParams.set("scope", SCOPES.join(" "));
  authUrl.searchParams.set("state", state);

  const response = NextResponse.redirect(authUrl);
  response.cookies.set(STATE_COOKIE, state, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    maxAge: 10 * 60,
    path: "/",
  });
  return response;
}

