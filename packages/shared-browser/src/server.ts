import { createApp } from "./app.js";
import { createBrowserManager } from "./createBrowserManager.js";
import { resolveServiceSecurity, ServiceSecurityError } from "./serviceSecurity.js";
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

const security = resolveSecurityOrExit();
const browserManager = createBrowserManager();
const app = createApp(browserManager, security);

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

const port = defaultConfig.port;
app.listen(port, security.listenHost, (error?: Error) => {
    if (error) {
        console.error(`[Server] Could not listen on ${security.listenHost}:${port}:`, error);
        process.exit(1);
    }
    console.log(`[Server] Shared Browser Service listening on ${security.listenHost}:${port}`);
    console.log(`[Server] Browser provider: ${browserManager.capabilities.provider}`);
    if (browserManager.capabilities.provider === "chromium") {
        console.log(`[Server] noVNC port range: ${defaultConfig.noVncPortStart}-${defaultConfig.noVncPortEnd}`);
    }
});
