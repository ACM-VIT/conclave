import { NextResponse } from "next/server";
import {
  mintSfuAdminSocketToken,
  requireSfuAdminUser,
} from "@/lib/sfu-admin-auth";
import { resolveSfuUrls } from "@/lib/sfu-url";

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
