import { NextResponse } from "next/server";
import {
  mintSfuAdminSocketToken,
  requireSfuAdminUser,
} from "@/lib/sfu-admin-auth";
import { resolveSfuUrls } from "@/lib/sfu-url";

/**
 * Hands an authorized operator what they need to open DIRECT WebSockets to
 * every SFU in the pool: each instance's public url and a short-lived signed
 * token (the pool shares one secret). The dashboard re-requests this on every
 * (re)connection attempt, so expiry never strands a session.
 */
export async function GET(request: Request) {
  const authResult = await requireSfuAdminUser(request);
  if (!authResult.ok) {
    return NextResponse.json(
      { error: authResult.error },
      { status: authResult.status },
    );
  }

  const subject =
    authResult.user.email || authResult.user.id || "operator";

  return NextResponse.json(
    {
      namespace: "/admin",
      instances: resolveSfuUrls().map((url) => ({
        url,
        token: mintSfuAdminSocketToken(subject),
      })),
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
