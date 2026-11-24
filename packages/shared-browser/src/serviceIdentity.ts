export const SHARED_BROWSER_SERVICE = "conclave-shared-browser";

const BROWSER_PROVIDERS = new Set(["chromium", "kitesurf"]);

type HealthBody = { service?: unknown; deployId?: unknown; status?: unknown; capabilities?: { provider?: unknown } | null };

export type PreviousManagedContainer = { id: string; ports: number[]; deployId: string | null };

const asHealth = (body: unknown): HealthBody =>
    body && typeof body === "object" && !Array.isArray(body) ? body : {};

export const isCurrentSharedBrowserHealth = (body: unknown): boolean => asHealth(body).service === SHARED_BROWSER_SERVICE;

export const isEarlierSharedBrowserHealth = (body: unknown): boolean => {
    const health = asHealth(body);
    if (BROWSER_PROVIDERS.has(String(health.capabilities?.provider))) return true;
    return Object.keys(health).length === 1 && health.status === "unavailable";
};

export const currentDeployId = (): string | null => process.env.BROWSER_SERVICE_DEPLOY_ID?.trim() || null;

export const previousManagedContainer = (env: NodeJS.ProcessEnv = process.env): PreviousManagedContainer | null => {
    const id = env.BROWSER_SERVICE_PREVIOUS_CONTAINER?.trim();
    if (!id) return null;
    const ports = (env.BROWSER_SERVICE_PREVIOUS_PORTS ?? "")
        .split(/[\s,]+/)
        .filter((port) => /^\d+$/.test(port))
        .map(Number);
    return { id, ports, deployId: env.BROWSER_SERVICE_PREVIOUS_DEPLOY_ID?.trim() || null };
};

export const isHeldByPreviousContainer = (body: unknown, port: number, previous: PreviousManagedContainer | null): boolean => {
    if (!previous || !(isCurrentSharedBrowserHealth(body) || isEarlierSharedBrowserHealth(body))) return false;
    return previous.ports.includes(port) || (previous.deployId !== null && asHealth(body).deployId === previous.deployId);
};
