export const SHARED_BROWSER_SERVICE = "conclave-shared-browser";

const BROWSER_PROVIDERS = new Set(["chromium", "kitesurf"]);

type HealthBody = { service?: unknown; capabilities?: { provider?: unknown } | null };

export const isSharedBrowserHealth = (body: unknown): boolean => {
    const health = (body ?? {}) as HealthBody;
    return health.service === SHARED_BROWSER_SERVICE || BROWSER_PROVIDERS.has(String(health.capabilities?.provider));
};

export const currentDeployId = (): string | null => process.env.BROWSER_SERVICE_DEPLOY_ID?.trim() || null;
