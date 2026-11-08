const SAME_ORIGIN_BASE = "https://next-path.invalid";

/**
 * A same-origin path to send the user to after sign-in, or null.
 *
 * Checking only for a leading "/" and no leading "//" is not enough: browsers
 * treat a backslash like a slash ("/\evil.com" is "//evil.com") and drop tabs
 * and newlines ("/\t/evil.com"), so both would leave the site. Backslashes
 * and control characters are refused, and the URL parser confirms the result
 * stays on this origin.
 */
export const toSafeNextPath = (
  value: string | null | undefined,
): string | null => {
  const raw = value?.trim();
  if (!raw || !raw.startsWith("/") || raw.startsWith("//")) return null;
  if (/[\\\u0000-\u001f\u007f]/.test(raw)) return null;
  try {
    const url = new URL(raw, SAME_ORIGIN_BASE);
    if (url.origin !== SAME_ORIGIN_BASE) return null;
    return `${url.pathname}${url.search}${url.hash}`;
  } catch {
    return null;
  }
};
