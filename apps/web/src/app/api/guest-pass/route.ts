import { NextResponse } from "next/server";
import { guestPassCookieForNewBrowser } from "@/lib/guest-pass";

/**
 * Gives a browser its guest pass when it has none. Pages call this as they
 * load, so a tab carries the pass before its first join call. The join route
 * still issues one for a client that never asked.
 */
export async function POST(request: Request) {
  const response = new NextResponse(null, { status: 204 });
  const setCookie = guestPassCookieForNewBrowser(
    process.env.SFU_SECRET || "development-secret",
    request,
  );
  if (setCookie) response.headers.append("Set-Cookie", setCookie);
  return response;
}
