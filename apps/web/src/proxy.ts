import { NextResponse, type NextRequest } from "next/server";
import { guestPassCookieForNewBrowser } from "@/lib/guest-pass";

/**
 * Gives a browser its guest pass with the first page it loads, so a tab
 * carries the pass before it makes any join call and every tab of the
 * browser shares it. Two page loads that race in a browser with no pass can
 * still each be given one. The browser keeps the last, and the join route
 * moves the other tab over to it (see `formerSeatOf` in lib/guest-pass).
 */
export function proxy(request: NextRequest) {
  const response = NextResponse.next();
  // Only a top-level page load. A frame on another site does not send the
  // SameSite=Lax pass, so answering it with a new pass would be noise.
  const destination = request.headers.get("sec-fetch-dest");
  if (destination && destination !== "document") return response;
  const setCookie = guestPassCookieForNewBrowser(
    process.env.SFU_SECRET || "development-secret",
    request.headers.get("cookie"),
  );
  if (setCookie) response.headers.append("Set-Cookie", setCookie);
  return response;
}

export const config = {
  // Pages only: not the API, not build output, not files.
  matcher: "/((?!api/|_next/|.*\\.[a-zA-Z0-9]+$).*)",
};
