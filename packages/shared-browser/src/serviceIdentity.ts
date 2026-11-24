import { bindingCovers, parseBindings, type BindAddress } from "./bindAddress.js";
import { DEFAULT_LISTEN_PORT } from "./serviceSecurity.js";

export const SHARED_BROWSER_SERVICE = "conclave-shared-browser";

const BROWSER_PROVIDERS = new Set(["chromium", "kitesurf"]);

type HealthBody = { service?: unknown; deployId?: unknown; status?: unknown; capabilities?: { provider?: unknown } | null };

export type PreviousManagedContainer = { id: string; bindings: BindAddress[]; deployId: string | null };

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
    const bindings = parseBindings(env.BROWSER_SERVICE_PREVIOUS_BINDINGS ?? "", DEFAULT_LISTEN_PORT);
    return { id, bindings, deployId: env.BROWSER_SERVICE_PREVIOUS_DEPLOY_ID?.trim() || null };
};

export const isHeldByPreviousContainer = (body: unknown, listener: BindAddress, previous: PreviousManagedContainer | null): boolean => {
    if (!previous) return false;
    if (previous.deployId !== null && isCurrentSharedBrowserHealth(body) && asHealth(body).deployId === previous.deployId) return true;
    return (isCurrentSharedBrowserHealth(body) || isEarlierSharedBrowserHealth(body)) && previous.bindings.some((bound) => bindingCovers(bound, listener));
};
