import { NextResponse } from "next/server";
import { requireSfuAdminUser } from "@/lib/sfu-admin-auth";

export async function GET(request: Request) {
  const authResult = await requireSfuAdminUser(request);
  if (!authResult.ok) {
    return NextResponse.json(
      { error: authResult.error },
      { status: authResult.status },
    );
  }

  return NextResponse.json({
    authorized: true,
    user: authResult.user,
  });
}
