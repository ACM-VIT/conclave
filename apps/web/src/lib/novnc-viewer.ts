const LOOPBACK_VIEWER_HOSTS = new Set(["localhost", "127.0.0.1", "0.0.0.0"]);

/** Page hosts on which a loopback viewer address still names this machine. */
export const LOOPBACK_PAGE_HOSTS = ["localhost", "127.0.0.1", "[::1]"];

export const isLoopbackViewerHost = (hostname: string): boolean => LOOPBACK_VIEWER_HOSTS.has(hostname);

/**
 * The browser service links noVNC on the address it knows, often loopback.
 * The client swaps a loopback host for the host the page was opened on, so
 * the viewer resolves to the same machine as the app.
 */
export const resolveViewerUrl = (viewerUrl: string, pageHostname: string): string => {
  try {
    const parsed = new URL(viewerUrl);
    if (isLoopbackViewerHost(parsed.hostname)) parsed.hostname = pageHostname;
    return parsed.toString();
  } catch {
    return viewerUrl;
  }
};
