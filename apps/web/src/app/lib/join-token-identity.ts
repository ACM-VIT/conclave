/**
 * The user key a join token names, read the way the SFU reads it.
 *
 * The join route decides who a guest is, and it decides per room. A guest's
 * client therefore takes its identity from the token it was issued instead
 * of deriving one. Nothing here verifies the token: the SFU does that, and a
 * client that misreads its own token only confuses itself.
 */
export const readJoinTokenUserKey = (token: string): string | null => {
  const payload = token.split(".")[1];
  if (!payload) return null;
  try {
    const base64 = payload.replace(/-/g, "+").replace(/_/g, "/");
    const bytes = Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));
    const claims = JSON.parse(new TextDecoder().decode(bytes)) as {
      email?: unknown;
      userId?: unknown;
    };
    const email =
      typeof claims.email === "string" ? claims.email.trim().toLowerCase() : "";
    const userId = typeof claims.userId === "string" ? claims.userId.trim() : "";
    return email || userId || null;
  } catch {
    return null;
  }
};
