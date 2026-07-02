import { readResponseError } from "../lib/utils";
import type { RequestMethod } from "./types";

/**
 * One-shot admin commands ride the authenticated HTTP proxy (the server holds
 * the SFU secret and the operator allowlist). Their effects come back over
 * the live socket within a tick, so callers never re-fetch.
 */
export const adminRequest = async <T,>(
  path: string,
  options?: {
    clientId?: string;
    method?: RequestMethod;
    body?: unknown;
    /** Target a specific pool instance; the proxy validates it. */
    instanceUrl?: string;
  },
): Promise<T> => {
  const normalizedPath = path.replace(/^\/+/, "");
  const query = new URLSearchParams();
  if (options?.clientId?.trim()) {
    query.set("clientId", options.clientId.trim());
  }
  if (options?.instanceUrl?.trim()) {
    query.set("instance", options.instanceUrl.trim());
  }
  const url = query.toString()
    ? `/api/sfu/admin/${normalizedPath}?${query.toString()}`
    : `/api/sfu/admin/${normalizedPath}`;

  const response = await fetch(url, {
    method: options?.method || "POST",
    headers: options?.body ? { "Content-Type": "application/json" } : undefined,
    body: options?.body ? JSON.stringify(options.body) : undefined,
    cache: "no-store",
  });

  if (!response.ok) {
    throw new Error(
      await readResponseError(response, `Request failed (${response.status})`),
    );
  }

  return (await response.json()) as T;
};
