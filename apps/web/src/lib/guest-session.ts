import { cookies } from "next/headers";
import type { GuestSession } from "@/lib/guest-identity";
import { guestPassCookieName, resolveGuestSession } from "@/lib/guest-pass";
import { resolveSfuSecret } from "@/lib/sfu-admin-auth";

/**
 * The guest identity of the browser this page is rendered for. A render
 * cannot set cookies, so a browser without a pass gets a grant with its new
 * identity and the first join call plants the cookie.
 */
export const readGuestSession = async (): Promise<GuestSession | undefined> => {
  try {
    const cookieStore = await cookies();
    const sfuSecret = resolveSfuSecret();
    return resolveGuestSession(
      sfuSecret,
      cookieStore.get(guestPassCookieName(sfuSecret))?.value,
    );
  } catch {
    return undefined;
  }
};
