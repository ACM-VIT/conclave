import { createServer } from "node:net";
import { createApp } from "./app.js";
import { createBrowserManager } from "./createBrowserManager.js";
import { canonicalLiteral, resolveBindings, resolveListenHost, urlHost, type ResolvedHost } from "./bindAddress.js";
import { isLoopbackOrPrivateHost, resolveServiceSecurity, ServiceSecurityError } from "./serviceSecurity.js";
import { isHeldByPreviousContainer, previousManagedContainer } from "./serviceIdentity.js";
import { defaultConfig } from "./types.js";

const resolveSecurityOrExit = () => {
    try {
        return resolveServiceSecurity(process.env);
    } catch (error) {
        if (!(error instanceof ServiceSecurityError)) throw error;
        console.error(`[Server] ${error.message}`);
        process.exit(1);
    }
};

const refuseToStart = (reason: string): never => {
    console.error(`[Server] Shared browser service refused to start:\n- ${reason}`);
    process.exit(1);
};

const security = resolveSecurityOrExit();
const browserManager = (() => {
    try {
        return createBrowserManager();
    } catch (error) {
        return refuseToStart(error instanceof Error ? error.message : String(error));
    }
})();
const app = createApp(browserManager, security);
const listenAddress: Promise<ResolvedHost> = resolveListenHost(security.listenHost, isLoopbackOrPrivateHost).then((resolved) =>
    resolved.ok ? resolved.address : refuseToStart(resolved.problem),
);
const healthUrl = (address: ResolvedHost, port: number) => `http://${urlHost(address)}:${port}/health`;
const resolvedFrom = canonicalLiteral(security.listenHost) === null ? ` (BROWSER_SERVICE_HOST=${security.listenHost})` : "";

const checkListenAddress = (host: string, port: number): Promise<void> =>
    new Promise((resolve, reject) => {
        const probe = createServer();
        probe.once("error", reject);
        probe.listen(port, host, () => probe.close(() => resolve()));
    });

const heldBySharedBrowser = async (host: ResolvedHost, port: number): Promise<boolean> => {
    try {
        const response = await fetch(healthUrl(host, port), { signal: AbortSignal.timeout(3_000) });
        const body: unknown = await response.json();
        const previous = previousManagedContainer();
        const resolved = previous && { ...previous, bindings: await resolveBindings(previous.bindings) };
        return isHeldByPreviousContainer(body, { host, port }, resolved);
    } catch {
        return false;
    }
};

const assertReady = (): Promise<void> =>
    Promise.resolve(browserManager.assertReady?.()).catch((error: unknown) =>
        refuseToStart(error instanceof Error ? error.message : String(error)),
    );

let isShuttingDown = false;

const gracefulShutdown = async () => {
    if (isShuttingDown) {
        return;
    }
    isShuttingDown = true;

    console.log("\n[Server] Received shutdown signal, cleaning up...");
    try {
        await browserManager.shutdown();
        process.exit(0);
    } catch (error) {
        console.error("[Server] Failed to clean up browser sessions:", error);
        process.exit(1);
    }
};

process.on("SIGTERM", () => void gracefulShutdown());
process.on("SIGINT", () => void gracefulShutdown());

const listen = (address: ResolvedHost) => app.listen(security.listenPort, address, (error?: Error) => {
    if (error) {
        console.error(`[Server] Could not listen on ${address}:${security.listenPort}${resolvedFrom}:`, error);
        process.exit(1);
    }
    console.log(`[Server] Shared Browser Service listening on ${address}:${security.listenPort}${resolvedFrom}`);
    console.log(`[Server] Browser provider: ${browserManager.capabilities.provider}`);
    if (browserManager.capabilities.provider === "chromium") {
        console.log(`[Server] noVNC port range: ${defaultConfig.noVncPortStart}-${defaultConfig.noVncPortEnd}`);
    }
});

// The deploy scripts run --check-config in the new image before replacing the
// service: every startup check above, short of listening on the real port.
if (process.argv.includes("--check-config")) {
    void listenAddress.then((address) => {
        const reportValid = () =>
            assertReady().then(() => {
                console.log(`[Server] Shared browser service configuration is valid (control API on ${address}:${security.listenPort}${resolvedFrom}).`);
                console.log(`BROWSER_SERVICE_HEALTH_URL=${healthUrl(address, security.listenPort)}`);
                process.exit(0);
            });
        return checkListenAddress(address, security.listenPort).then(reportValid, async (error: NodeJS.ErrnoException) => {
            if (error.code !== "EADDRINUSE") {
                return refuseToStart(`BROWSER_SERVICE_HOST=${security.listenHost} (${address}) cannot be bound on this host (${error.code ?? error.message}).`);
            }
            if (await heldBySharedBrowser(address, security.listenPort)) return reportValid();
            return refuseToStart(
                `BROWSER_SERVICE_PORT=${security.listenPort} on ${address}${resolvedFrom} is in use by a program that is not the shared browser service this deploy replaces. Free the port or choose another one.`,
            );
        });
    });
} else {
    void Promise.all([listenAddress, assertReady()]).then(([address]) => listen(address));
}
