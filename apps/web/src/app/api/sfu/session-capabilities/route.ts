import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { isSfuAllowlistedUser } from "@/lib/sfu-admin-auth";

export async function GET(request: Request) {
  const session = await auth.api
    .getSession({
      headers: request.headers,
    })
    .catch(() => null);

  const user = session?.user;
  if (!user?.id) {
    return NextResponse.json({ canGhostJoin: false });
  }

  return NextResponse.json({
    canGhostJoin: isSfuAllowlistedUser({
      id: user.id,
      email: user.email,
    }),
  });
}
