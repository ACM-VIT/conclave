import { parseUnfurlableUrl } from "./unfurl-html";

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const MAX_REDIRECTS = 5;

export interface UnfurlFetchResult {
  response: Response;
  finalUrl: URL;
}

export async function fetchUnfurlResource(
  target: URL,
  init: RequestInit = {},
  fetcher: typeof fetch = fetch,
): Promise<UnfurlFetchResult | null> {
  let currentUrl = parseUnfurlableUrl(target.href);
  if (!currentUrl) return null;

  let redirectCount = 0;
  while (true) {
    const response = await fetcher(currentUrl, {
      ...init,
      redirect: "manual",
    });
    if (!REDIRECT_STATUSES.has(response.status)) {
      return { response, finalUrl: currentUrl };
    }

    const location = response.headers.get("location");
    response.body?.cancel().catch(() => {});
    if (!location || redirectCount >= MAX_REDIRECTS) return null;

    let redirectUrl: URL;
    try {
      redirectUrl = new URL(location, currentUrl);
    } catch {
      return null;
    }
    currentUrl = parseUnfurlableUrl(redirectUrl.href);
    if (!currentUrl) return null;
    redirectCount += 1;
  }
}
