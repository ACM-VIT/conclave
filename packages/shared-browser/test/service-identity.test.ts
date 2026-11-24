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

const holdPort = async (port: number, body: unknown) => {
    const server = createHttpServer((_req, res) => {
        res.writeHead(200, { "content-type": "application/json" });
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

test("--check-config refuses a configured port that another program holds", async () => {
    const engine = await fakeDockerEngine({ "conclave-browser:latest": hardenedImage });
    try {
        const check = async (holder: unknown) => {
            const port = await freePort();
            const release = holder === undefined ? async () => undefined : await holdPort(port, holder);
            try {
                return await runService({ BROWSER_SERVICE_PORT: String(port), DOCKER_HOST: engine.host }, ["--check-config"]);
            } finally {
                await release();
            }
        };
        const sfu = await check({ status: "healthy", timestamp: new Date().toISOString(), uptime: 12, port: 3031 });
        assert.equal(sfu.code, 1, sfu.output);
        assert.match(sfu.output, /refused to start[\s\S]*BROWSER_SERVICE_PORT=\d+[\s\S]*not the shared browser service/);
        const empty = await check({});
        assert.equal(empty.code, 1, empty.output);

        for (const previous of [
            { status: "ok", service: "conclave-shared-browser", deployId: "older" },
            { status: "ok", sessions: 0, capabilities: { provider: "chromium", audio: true, video: true, agentic: false } },
        ]) {
            const replaced = await check(previous);
            assert.equal(replaced.code, 0, replaced.output);
        }
        const free = await check(undefined);
        assert.equal(free.code, 0, free.output);
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
