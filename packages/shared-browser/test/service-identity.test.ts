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
        type Previous = { address?: "this" | "this, IPv4-mapped" | "wildcard" | "wildcard, spelled in full" | "moved" | "another port"; deployId?: string };
        const check = async (holder: { body: unknown; status?: number } | undefined, previous?: Previous) => {
            const port = await freePort();
            const release = holder ? await holdPort(port, holder.body, holder.status) : async () => undefined;
            const bindings = {
                this: `127.0.0.1|${port}`,
                "this, IPv4-mapped": `::ffff:127.0.0.1|${port}`,
                wildcard: `0.0.0.0|${port}`,
                "wildcard, spelled in full": `0:0:0:0:0:0:0:0|${port}`,
                moved: `10.0.4.7|${port}`,
                "another port": `127.0.0.1|${await freePort()}`,
            };
            try {
                return await runService(
                    {
                        BROWSER_SERVICE_HOST: "127.0.0.1",
                        BROWSER_SERVICE_PORT: String(port),
                        DOCKER_HOST: engine.host,
                        BROWSER_SERVICE_PREVIOUS_CONTAINER: previous ? "4f2c1d" : "",
                        BROWSER_SERVICE_PREVIOUS_BINDINGS: previous?.address ? bindings[previous.address] : "",
                        BROWSER_SERVICE_PREVIOUS_DEPLOY_ID: previous?.deployId ?? "",
                    },
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
            "current service with the replaced container's deploy id, bound elsewhere": (await check(current, { address: "moved", deployId: "older" })).code,
            "current service, replaced container bound to this address": (await check(current, { address: "this" })).code,
            "earlier service, unhealthy, replaced container bound to this address": (await check(earlierUnhealthy, { address: "this" })).code,
            "earlier service, unhealthy, replaced container bound to this address spelled IPv4-mapped": (await check(earlierUnhealthy, { address: "this, IPv4-mapped" })).code,
            "earlier service, unhealthy, replaced container bound to every address spelled in full": (await check(earlierUnhealthy, { address: "wildcard, spelled in full" })).code,
            "earlier service, healthy, replaced container bound to every address on this port": (await check(earlierHealthy, { address: "wildcard" })).code,
            "earlier service, unhealthy, replaced container bound to every address on this port": (await check(earlierUnhealthy, { address: "wildcard" })).code,
            "earlier service shape, replaced container bound to another host on this port": (await check(earlierUnhealthy, { address: "moved" })).code,
            "current service, another deploy id, replaced container bound to another host": (await check(current, { address: "moved", deployId: "newer" })).code,
            "earlier service shape, replaced container on another port": (await check(earlierUnhealthy, { address: "another port" })).code,
            "earlier service shape, no address or deploy id for the replaced container": (await check(earlierUnhealthy, {})).code,
            "earlier service shape, no managed container": (await check(earlierUnhealthy)).code,
            "current service, no managed container": (await check(current)).code,
            "SFU, replaced container bound to this address": (await check(sfu, { address: "this" })).code,
            "empty answer, replaced container bound to this address": (await check({ body: {} }, { address: "this" })).code,
        };
        assert.deepEqual(outcomes, {
            "free port": 0,
            "current service with the replaced container's deploy id, bound elsewhere": 0,
            "current service, replaced container bound to this address": 0,
            "earlier service, unhealthy, replaced container bound to this address": 0,
            "earlier service, unhealthy, replaced container bound to this address spelled IPv4-mapped": 0,
            "earlier service, unhealthy, replaced container bound to every address spelled in full": 0,
            "earlier service, healthy, replaced container bound to every address on this port": 0,
            "earlier service, unhealthy, replaced container bound to every address on this port": 0,
            "earlier service shape, replaced container bound to another host on this port": 1,
            "current service, another deploy id, replaced container bound to another host": 1,
            "earlier service shape, replaced container on another port": 1,
            "earlier service shape, no address or deploy id for the replaced container": 1,
            "earlier service shape, no managed container": 1,
            "current service, no managed container": 1,
            "SFU, replaced container bound to this address": 1,
            "empty answer, replaced container bound to this address": 1,
        });
        const refused = await check(earlierUnhealthy, { address: "moved" });
        assert.match(refused.output, /refused to start[\s\S]*BROWSER_SERVICE_PORT=\d+[\s\S]*not the shared browser service this deploy replaces/);
    } finally {
        await engine.close();
    }
});

const ipv6Loopback = await new Promise<boolean>((resolve) => {
    const probe = createHttpServer();
    probe.once("error", () => resolve(false));
    probe.listen(0, "::1", () => probe.close(() => resolve(true)));
});

test("--check-config accepts the replaced service on ::1 however its address was spelled", { skip: ipv6Loopback ? false : "no IPv6 loopback on this machine" }, async () => {
    const engine = await fakeDockerEngine({ "conclave-browser:latest": hardenedImage });
    try {
        const outcomes: Record<string, unknown> = {};
        for (const spelling of ["::1", "0:0:0:0:0:0:0:1", "[0000:0000:0000:0000:0000:0000:0000:0001]"]) {
            const port = await freePort();
            const server = createHttpServer((_req, res) => {
                res.writeHead(503, { "content-type": "application/json" });
                res.end(JSON.stringify({ service: "conclave-shared-browser", deployId: null, status: "unavailable" }));
            });
            server.listen(port, "::1");
            await once(server, "listening");
            try {
                const checked = await runService(
                    {
                        BROWSER_SERVICE_HOST: "::1",
                        BROWSER_SERVICE_PORT: String(port),
                        DOCKER_HOST: engine.host,
                        BROWSER_SERVICE_PREVIOUS_CONTAINER: "4f2c1d",
                        BROWSER_SERVICE_PREVIOUS_BINDINGS: `${spelling}|${port}`,
                        BROWSER_SERVICE_PREVIOUS_DEPLOY_ID: "",
                    },
                    ["--check-config"],
                );
                outcomes[spelling] = checked.code;
            } finally {
                server.closeAllConnections();
                await new Promise<void>((resolve) => server.close(() => resolve()));
            }
        }
        assert.deepEqual(outcomes, { "::1": 0, "0:0:0:0:0:0:0:1": 0, "[0000:0000:0000:0000:0000:0000:0000:0001]": 0 });
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
