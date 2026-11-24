export const SHARED_BROWSER_SERVICE = "conclave-shared-browser";

const BROWSER_PROVIDERS = new Set(["chromium", "kitesurf"]);

type HealthBody = { service?: unknown; status?: unknown; capabilities?: { provider?: unknown } | null };

const asHealth = (body: unknown): HealthBody =>
    body && typeof body === "object" && !Array.isArray(body) ? body : {};

export const isCurrentSharedBrowserHealth = (body: unknown): boolean => asHealth(body).service === SHARED_BROWSER_SERVICE;

export const isEarlierSharedBrowserHealth = (body: unknown): boolean => {
    const health = asHealth(body);
    if (BROWSER_PROVIDERS.has(String(health.capabilities?.provider))) return true;
    return Object.keys(health).length === 1 && health.status === "unavailable";
};

export const currentDeployId = (): string | null => process.env.BROWSER_SERVICE_DEPLOY_ID?.trim() || null;

export const previousManagedContainer = (): string | null => process.env.BROWSER_SERVICE_PREVIOUS_CONTAINER?.trim() || null;
