import {
  KitesurfManager,
  type BrowserAgentAction,
  type BrowserManager,
  type BrowserServiceConfig,
} from "@conclave/shared-browser/kitesurf";

const externalServiceUrl = (): string =>
  (process.env.BROWSER_SERVICE_URL || "http://localhost:3040").replace(/\/+$/, "");

const externalServiceToken = (): string => process.env.BROWSER_SERVICE_TOKEN || "";

const MAX_BACKEND_REQUEST_TIMEOUT_MS = 20000;
const BROWSER_CAPABILITIES_CACHE_TTL_MS = 60000;

const requestTimeoutMs = (): number => {
  const parsed = Number(process.env.BROWSER_SERVICE_TIMEOUT_MS || "15000");
  const configured = Number.isFinite(parsed) && parsed > 0 ? parsed : 15000;
  return Math.min(configured, MAX_BACKEND_REQUEST_TIMEOUT_MS);
};

export interface BrowserServiceCapabilities {
  provider: "chromium" | "kitesurf";
  audio: boolean;
  video: boolean;
  agentic: boolean;
}

type BrowserBackendMode = "kitesurf" | "service";

export class BrowserServiceHttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "BrowserServiceHttpError";
  }
}

export const isMissingBrowserSessionError = (error: unknown): boolean =>
  error instanceof BrowserServiceHttpError && error.status === 404;

const cloudflareCredentials = (): { accountId: string; apiToken: string } | null => {
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID?.trim() || "";
  const apiToken =
    process.env.CLOUDFLARE_BROWSER_RUN_TOKEN?.trim() ||
    process.env.CLOUDFLARE_API_TOKEN?.trim() ||
    "";
  return accountId && apiToken ? { accountId, apiToken } : null;
};

const resolveBackendMode = (): BrowserBackendMode => {
  const configured = process.env.SFU_BROWSER_BACKEND?.trim().toLowerCase();
  if (configured === "service" || configured === "chromium") return "service";
  if (configured === "kitesurf") return "kitesurf";

  // Preserve the earlier BROWSER_PROVIDER switch, but make the default truly
  // zero-service: valid Cloudflare credentials are enough to embed Kitesurf in
  // the SFU. Chromium remains available through the external service.
  if (process.env.BROWSER_PROVIDER?.trim().toLowerCase() === "kitesurf") {
    return "kitesurf";
  }
  return cloudflareCredentials() ? "kitesurf" : "service";
};

let embeddedKitesurf: BrowserManager | null = null;
let cachedCapabilities:
  | { capabilities: BrowserServiceCapabilities; expiresAt: number }
  | undefined;
let pendingCapabilities: Promise<BrowserServiceCapabilities> | undefined;

const parseInteger = (
  value: string | undefined,
  fallback: number,
  maximum = Number.POSITIVE_INFINITY,
): number => {
  const parsed = Number(value);
  const configured = Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
  return Math.min(configured, maximum);
};

const getEmbeddedKitesurf = (): BrowserManager => {
  if (embeddedKitesurf) return embeddedKitesurf;
  const credentials = cloudflareCredentials();
  if (!credentials) {
    throw new Error(
      "Kitesurf is not configured. Set CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_BROWSER_RUN_TOKEN.",
    );
  }

  const config: Partial<BrowserServiceConfig> = {
    provider: "kitesurf",
    cloudflareAccountId: credentials.accountId,
    cloudflareApiToken: credentials.apiToken,
    cloudflareBrowserRunBaseUrl:
      process.env.CLOUDFLARE_BROWSER_RUN_BASE_URL?.trim() || undefined,
    cloudflareRequestTimeoutMs: parseInteger(
      process.env.CLOUDFLARE_BROWSER_RUN_TIMEOUT_MS,
      15000,
      MAX_BACKEND_REQUEST_TIMEOUT_MS,
    ),
    kitesurfKeepAliveMs: parseInteger(process.env.KITESURF_KEEP_ALIVE_MS, 600000),
    kitesurfViewportWidth: parseInteger(
      process.env.KITESURF_VIEWPORT_WIDTH,
      1920,
      3840,
    ),
    kitesurfViewportHeight: parseInteger(
      process.env.KITESURF_VIEWPORT_HEIGHT,
      1080,
      2160,
    ),
    containerIdleTimeoutMs: parseInteger(
      process.env.KITESURF_IDLE_TIMEOUT_MS || process.env.CONTAINER_IDLE_TIMEOUT,
      1800000,
    ),
  };
  embeddedKitesurf = new KitesurfManager(config);
  return embeddedKitesurf;
};

const requireString = (value: unknown, label: string): string => {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${label} is required`);
  }
  return value;
};

const callEmbeddedKitesurf = async <T>(
  path: string,
  payload: Record<string, unknown> = {},
): Promise<T> => {
  const manager = getEmbeddedKitesurf();
  let result: unknown;

  if (path === "/capabilities") {
    result = { capabilities: manager.capabilities };
  } else if (path === "/launch") {
    result = await manager.launchBrowser({
      roomId: requireString(payload.roomId, "roomId"),
      url: requireString(payload.url, "url"),
      controllerUserId:
        typeof payload.controllerUserId === "string" ? payload.controllerUserId : undefined,
    });
  } else if (path === "/navigate") {
    result = await manager.navigateTo({
      roomId: requireString(payload.roomId, "roomId"),
      url: requireString(payload.url, "url"),
    });
  } else if (path === "/close") {
    result = await manager.closeBrowser(requireString(payload.roomId, "roomId"));
  } else if (path === "/activity") {
    await manager.markActivity(requireString(payload.roomId, "roomId"));
    result = { success: true };
  } else if (path === "/agent/observe") {
    if (!manager.observeForAgent) throw new Error("Kitesurf agent inspection is unavailable");
    result = {
      observation: await manager.observeForAgent(requireString(payload.roomId, "roomId")),
    };
  } else if (path === "/agent/action") {
    if (!manager.performAgentAction) throw new Error("Kitesurf agent control is unavailable");
    if (typeof payload.action !== "object" || payload.action === null) {
      throw new Error("A browser action is required");
    }
    await manager.performAgentAction(
      requireString(payload.roomId, "roomId"),
      payload.action as BrowserAgentAction,
    );
    result = { success: true };
  } else if (path.startsWith("/sessions/")) {
    const roomId = decodeURIComponent(path.slice("/sessions/".length));
    result = { session: await manager.getSession(roomId) };
  } else {
    throw new Error(`Unsupported embedded Kitesurf operation: ${path}`);
  }

  return result as T;
};

const callExternalBrowserService = async <T>(
  path: string,
  options: { method?: "GET" | "POST"; payload?: Record<string, unknown> },
): Promise<T> => {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), requestTimeoutMs());
  const headers: Record<string, string> = {};
  if (options.payload) headers["Content-Type"] = "application/json";
  const token = externalServiceToken();
  if (token) headers["x-browser-service-token"] = token;

  try {
    const response = await fetch(`${externalServiceUrl()}${path}`, {
      method: options.method ?? (options.payload ? "POST" : "GET"),
      headers,
      body: options.payload ? JSON.stringify(options.payload) : undefined,
      signal: controller.signal,
    });
    const result = (await response.json().catch(() => ({}))) as T & { error?: string };
    if (!response.ok) {
      throw new BrowserServiceHttpError(
        result.error || `Browser service request failed with HTTP ${response.status}`,
        response.status,
      );
    }
    return result;
  } finally {
    clearTimeout(timeout);
  }
};

export const callBrowserService = async <T>(
  path: string,
  options: { method?: "GET" | "POST"; payload?: Record<string, unknown> } = {},
): Promise<T> =>
  resolveBackendMode() === "kitesurf"
    ? callEmbeddedKitesurf<T>(path, options.payload)
    : callExternalBrowserService<T>(path, options);

export const getBrowserServiceCapabilities = async (
  options: { verifyBackend?: boolean } = {},
): Promise<BrowserServiceCapabilities> => {
  if (resolveBackendMode() === "kitesurf") {
    const manager = getEmbeddedKitesurf();
    if (options.verifyBackend !== false) await manager.checkHealth();
    return manager.capabilities;
  }
  try {
    const response = await callExternalBrowserService<{
      capabilities?: BrowserServiceCapabilities;
    }>("/capabilities", {});
    if (response.capabilities) return response.capabilities;
    throw new Error("Browser service returned an invalid capabilities response");
  } catch (error) {
    // Older browser-service deployments do not expose capabilities. Preserve
    // the legacy Chromium behavior during rolling deployments.
    if (!(error instanceof BrowserServiceHttpError) || error.status !== 404) throw error;
  }
  return { provider: "chromium", audio: true, video: true, agentic: false };
};

export const getCachedBrowserServiceCapabilities = async (): Promise<BrowserServiceCapabilities> => {
  const now = Date.now();
  if (cachedCapabilities && cachedCapabilities.expiresAt > now) {
    return cachedCapabilities.capabilities;
  }
  if (pendingCapabilities) return pendingCapabilities;

  pendingCapabilities = getBrowserServiceCapabilities()
    .then((capabilities) => {
      cachedCapabilities = {
        capabilities,
        expiresAt: Date.now() + BROWSER_CAPABILITIES_CACHE_TTL_MS,
      };
      return capabilities;
    })
    .finally(() => {
      pendingCapabilities = undefined;
    });
  return pendingCapabilities;
};

export const describeBrowserServiceError = (error: unknown): string => {
  const message = error instanceof Error ? error.message : "";
  if (resolveBackendMode() === "kitesurf") {
    if (message.includes("not configured")) {
      return "Kitesurf is not configured on this meeting server.";
    }
    if (error instanceof Error && error.name === "AbortError") {
      return "Kitesurf did not respond in time. Try again.";
    }
    return "Kitesurf could not start this shared browser.";
  }
  return "The Chromium browser service is offline.";
};

export const shutdownBrowserBackend = async (): Promise<void> => {
  const manager = embeddedKitesurf;
  embeddedKitesurf = null;
  cachedCapabilities = undefined;
  pendingCapabilities = undefined;
  await manager?.shutdown();
};
