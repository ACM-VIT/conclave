import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { createServer as createHttpServer } from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createApp } from "../src/app.js";
import type { BrowserManager } from "../src/types.js";
import { fakeDockerEngine, freePort, hardenedImage } from "./support/docker.js";

const TOKEN = randomBytes(32).toString("hex");
const packageDir = fileURLToPath(new URL("..", import.meta.url));

const runService = async (env: NodeJS.ProcessEnv, args: string[]) => {
    const child = spawn(process.execPath, ["--import", "tsx", "src/server.ts", ...args], {
        cwd: packageDir,
        env: { PATH: process.env.PATH, BROWSER_SERVICE_TOKEN: TOKEN, ...env },
        stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.on("data", (chunk) => (output += chunk));
    child.stderr.on("data", (chunk) => (output += chunk));
    const deadline = setTimeout(() => child.kill("SIGKILL"), 20_000);
    const [code] = await once(child, "close");
    clearTimeout(deadline);
    return { code, output };
};

const holdPort = async (port: number, body: unknown, status = 200) => {
    const server = createHttpServer((_req, res) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(body));
    });
    server.listen(port, "127.0.0.1");
    await once(server, "listening");
    return () =>
        new Promise<void>((resolve) => {
            server.closeAllConnections();
            server.close(() => resolve());
        });
};

const manager = (healthy: boolean): BrowserManager => ({
    capabilities: { provider: "chromium", audio: true, video: true, agentic: false },
    checkHealth: async () => {
        if (!healthy) throw new Error("down");
    },
    launchBrowser: async () => ({ success: false, error: "not used" }),
    navigateTo: async () => ({ success: false, error: "not used" }),
    closeBrowser: async () => ({ success: true }),
    getSession: async () => undefined,
    getAllSessions: () => [],
    markActivity: async () => undefined,
    shutdown: async () => undefined,
});

test("/health names the shared browser service and the deploy it came from, healthy or not", async () => {
    process.env.BROWSER_SERVICE_DEPLOY_ID = "deploy-1234";
    try {
        for (const healthy of [true, false]) {
            const server = createApp(manager(healthy), { token: TOKEN, listenHost: "127.0.0.1", listenPort: 0, corsOrigins: [] }).listen(0, "127.0.0.1");
            await once(server, "listening");
            try {
                const response = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/health`);
                assert.equal(response.status, healthy ? 200 : 503);
                const body = (await response.json()) as { service?: string; deployId?: string };
                assert.equal(body.service, "conclave-shared-browser");
                assert.equal(body.deployId, "deploy-1234");
            } finally {
                server.close();
            }
        }
    } finally {
        delete process.env.BROWSER_SERVICE_DEPLOY_ID;
    }
});

test("--check-config accepts a port held only by the browser service the deploy is replacing", async () => {
    const engine = await fakeDockerEngine({ "conclave-browser:latest": hardenedImage });
    try {
        const check = async (holder: { body: unknown; status?: number } | undefined, previousContainer = "") => {
            const port = await freePort();
            const release = holder ? await holdPort(port, holder.body, holder.status) : async () => undefined;
            try {
                return await runService(
                    { BROWSER_SERVICE_PORT: String(port), DOCKER_HOST: engine.host, BROWSER_SERVICE_PREVIOUS_CONTAINER: previousContainer },
                    ["--check-config"],
                );
            } finally {
                await release();
            }
        };
        const sfu = { body: { status: "healthy", timestamp: new Date().toISOString(), uptime: 12, port: 3031 } };
        const earlierHealthy = { body: { status: "ok", sessions: 0, capabilities: { provider: "kitesurf", audio: true, video: true, agentic: true } } };
        const earlierUnhealthy = { body: { status: "unavailable" }, status: 503 };
        const current = { body: { service: "conclave-shared-browser", deployId: "older", status: "unavailable" }, status: 503 };

        const outcomes = {
            "free port": (await check(undefined)).code,
            "current service, unhealthy": (await check(current)).code,
            "earlier service, unhealthy, managed container named": (await check(earlierUnhealthy, "4f2c1d")).code,
            "earlier service, healthy, managed container named": (await check(earlierHealthy, "4f2c1d")).code,
            "earlier service shape, no managed container": (await check(earlierUnhealthy)).code,
            "SFU, managed container named": (await check(sfu, "4f2c1d")).code,
            "empty answer, managed container named": (await check({ body: {} }, "4f2c1d")).code,
        };
        assert.deepEqual(outcomes, {
            "free port": 0,
            "current service, unhealthy": 0,
            "earlier service, unhealthy, managed container named": 0,
            "earlier service, healthy, managed container named": 0,
            "earlier service shape, no managed container": 1,
            "SFU, managed container named": 1,
            "empty answer, managed container named": 1,
        });
        const refused = await check(sfu, "4f2c1d");
        assert.match(refused.output, /refused to start[\s\S]*BROWSER_SERVICE_PORT=\d+[\s\S]*not the shared browser service/);
    } finally {
        await engine.close();
    }
});

test("the service exits nonzero when it cannot bind its port", async () => {
    const engine = await fakeDockerEngine({ "conclave-browser:latest": hardenedImage });
    const port = await freePort();
    const release = await holdPort(port, { status: "healthy" });
    try {
        const started = await runService({ BROWSER_SERVICE_PORT: String(port), DOCKER_HOST: engine.host }, []);
        assert.notEqual(started.code, 0, started.output);
        assert.notEqual(started.code, null, `the service kept running: ${started.output}`);
    } finally {
        await release();
        await engine.close();
    }
});
