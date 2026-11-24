export const SHARED_BROWSER_SERVICE = "conclave-shared-browser";

const BROWSER_PROVIDERS = new Set(["chromium", "kitesurf"]);

type HealthBody = { service?: unknown; deployId?: unknown; status?: unknown; capabilities?: { provider?: unknown } | null };

export type BindAddress = { host: string; port: number };

export type PreviousManagedContainer = { id: string; addresses: BindAddress[]; deployId: string | null };

const WILDCARD_HOSTS = new Set(["", "0.0.0.0", "::", "*"]);

const bareHost = (host: string): string => host.trim().replace(/^\[(.*)\]$/, "$1").toLowerCase();

const parseBindAddress = (entry: string): BindAddress | null => {
    const separator = entry.lastIndexOf(":");
    if (separator < 0) return null;
    const port = entry.slice(separator + 1).trim();
    if (!/^\d+$/.test(port)) return null;
    return { host: bareHost(entry.slice(0, separator)), port: Number(port) };
};

const covers = (bound: BindAddress, wanted: BindAddress): boolean =>
    bound.port === wanted.port && (WILDCARD_HOSTS.has(bound.host) || bound.host === bareHost(wanted.host));

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
    const addresses = (env.BROWSER_SERVICE_PREVIOUS_ADDRESSES ?? "")
        .split(",")
        .map(parseBindAddress)
        .filter((address): address is BindAddress => address !== null);
    return { id, addresses, deployId: env.BROWSER_SERVICE_PREVIOUS_DEPLOY_ID?.trim() || null };
};

export const isHeldByPreviousContainer = (body: unknown, listener: BindAddress, previous: PreviousManagedContainer | null): boolean => {
    if (!previous) return false;
    if (previous.deployId !== null && isCurrentSharedBrowserHealth(body) && asHealth(body).deployId === previous.deployId) return true;
    return (isCurrentSharedBrowserHealth(body) || isEarlierSharedBrowserHealth(body)) && previous.addresses.some((bound) => covers(bound, listener));
};
