import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer, type AddressInfo, type Server } from "node:net";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createApp } from "../src/app.js";
import { ContainerManager } from "../src/ContainerManager.js";
import { resolveServiceSecurity, ServiceSecurityError } from "../src/serviceSecurity.js";
import type { BrowserManager, BrowserSession } from "../src/types.js";
import { fakeDocker, fakeDockerEngine, freePort, hardenedImage } from "./support/docker.js";

const STRONG_TOKEN = randomBytes(32).toString("hex");
const packageDir = fileURLToPath(new URL("..", import.meta.url));

const fakeManager = (): BrowserManager => ({
    capabilities: { provider: "chromium", audio: true, video: true, agentic: false },
    checkHealth: async () => undefined,
    launchBrowser: async () => ({ success: false, error: "not used" }),
    navigateTo: async () => ({ success: false, error: "not used" }),
    closeBrowser: async () => ({ success: true }),
    getSession: async () => undefined,
    getAllSessions: () => [],
    markActivity: async () => undefined,
    shutdown: async () => undefined,
});

const listen = async (server: Server): Promise<number> => {
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    return (server.address() as AddressInfo).port;
};

const withApp = async (
    security: Parameters<typeof createApp>[1],
    run: (baseUrl: string) => Promise<void>,
) => {
    const server = createApp(fakeManager(), security).listen(0, "127.0.0.1");
    await once(server, "listening");
    try {
        await run(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
    } finally {
        server.close();
    }
};

test("the control API rejects requests without the service token", async () => {
    await withApp({ token: STRONG_TOKEN, listenHost: "127.0.0.1", listenPort: 3040, corsOrigins: [] }, async (baseUrl) => {
        assert.equal((await fetch(`${baseUrl}/sessions`)).status, 401);
        assert.equal(
            (await fetch(`${baseUrl}/launch`, {
                method: "POST",
                headers: { "content-type": "application/json", "x-browser-service-token": `${STRONG_TOKEN}x` },
                body: JSON.stringify({ roomId: "room", url: "https://example.com" }),
            })).status,
            401,
        );
        assert.equal(
            (await fetch(`${baseUrl}/sessions`, { headers: { "x-browser-service-token": STRONG_TOKEN } })).status,
            200,
        );
        assert.equal(
            (await fetch(`${baseUrl}/sessions`, { headers: { authorization: `Bearer ${STRONG_TOKEN}` } })).status,
            200,
        );
        assert.equal((await fetch(`${baseUrl}/health`)).status, 200);
    });
});

test("the control API authenticates before it reads a request body", async () => {
    await withApp({ token: STRONG_TOKEN, listenHost: "127.0.0.1", listenPort: 3040, corsOrigins: [] }, async (baseUrl) => {
        const malformed = { method: "POST", headers: { "content-type": "application/json" }, body: "{not json" };
        assert.equal((await fetch(`${baseUrl}/launch`, malformed)).status, 401);
        const authorized = await fetch(`${baseUrl}/launch`, {
            ...malformed,
            headers: { ...malformed.headers, "x-browser-service-token": STRONG_TOKEN },
        });
        assert.equal(authorized.status, 400);
    });
});

test("CORS answers only the configured web origins", async () => {
    await withApp(
        { token: STRONG_TOKEN, listenHost: "127.0.0.1", listenPort: 3040, corsOrigins: ["https://conclave.example"] },
        async (baseUrl) => {
            const headers = { "x-browser-service-token": STRONG_TOKEN };
            const untrusted = await fetch(`${baseUrl}/sessions`, {
                headers: { ...headers, origin: "https://attacker.example" },
            });
            assert.equal(untrusted.headers.get("access-control-allow-origin"), null);
            const trusted = await fetch(`${baseUrl}/sessions`, {
                headers: { ...headers, origin: "https://conclave.example" },
            });
            assert.equal(trusted.headers.get("access-control-allow-origin"), "https://conclave.example");
        },
    );
    await withApp({ token: STRONG_TOKEN, listenHost: "127.0.0.1", listenPort: 3040, corsOrigins: [] }, async (baseUrl) => {
        const response = await fetch(`${baseUrl}/health`, { headers: { origin: "https://conclave.example" } });
        assert.equal(response.headers.get("access-control-allow-origin"), null);
    });
});

test("startup configuration fails closed", () => {
    const refuses = (env: NodeJS.ProcessEnv) =>
        assert.throws(() => resolveServiceSecurity(env), ServiceSecurityError);

    refuses({});
    refuses({ BROWSER_SERVICE_TOKEN: "short-token" });
    refuses({ BROWSER_SERVICE_TOKEN: "a".repeat(48) });
    // The SFU sends the token as an HTTP header, which carries visible ASCII only.
    refuses({ BROWSER_SERVICE_TOKEN: `${STRONG_TOKEN}\u0100` });
    refuses({ BROWSER_SERVICE_TOKEN: `${STRONG_TOKEN.slice(0, 16)} ${STRONG_TOKEN.slice(16)}` });
    // The SFU sends the raw value; fetch strips only tab, space, CR and LF from the ends.
    refuses({ BROWSER_SERVICE_TOKEN: `${STRONG_TOKEN}\u2003` });
    refuses({ BROWSER_SERVICE_TOKEN: `\u00a0${STRONG_TOKEN}` });
    refuses({ BROWSER_SERVICE_TOKEN: STRONG_TOKEN, BROWSER_SERVICE_HOST: "0.0.0.0" });
    refuses({ BROWSER_SERVICE_TOKEN: STRONG_TOKEN, BROWSER_SERVICE_HOST: "::" });
    refuses({ BROWSER_SERVICE_TOKEN: STRONG_TOKEN, BROWSER_SERVICE_HOST: "203.0.113.54" });
    // fd0::12 is 0fd0::12, outside the fc00::/7 unique-local range.
    refuses({ BROWSER_SERVICE_TOKEN: STRONG_TOKEN, BROWSER_SERVICE_HOST: "fd0::12" });
    refuses({ BROWSER_SERVICE_TOKEN: STRONG_TOKEN, BROWSER_SERVICE_HOST: "fc::1" });
    refuses({ BROWSER_SERVICE_TOKEN: STRONG_TOKEN, BROWSER_SERVICE_CORS_ORIGINS: "*" });
    // The deploy builds its health URL from BROWSER_SERVICE_PORT as written.
    refuses({ BROWSER_SERVICE_TOKEN: STRONG_TOKEN, BROWSER_SERVICE_PORT: " 3040" });
    refuses({ BROWSER_SERVICE_TOKEN: STRONG_TOKEN, BROWSER_SERVICE_PORT: "70000" });
    refuses({ BROWSER_SERVICE_TOKEN: STRONG_TOKEN, BROWSER_SERVICE_PORT: "0" });
    refuses({ BROWSER_SERVICE_TOKEN: STRONG_TOKEN, BROWSER_SERVICE_PORT: "00" });
    for (const host of [" 127.0.0.1 ", "127.0.0.1 ", "\t10.0.4.7", " "]) {
        assert.throws(() => resolveServiceSecurity({ BROWSER_SERVICE_TOKEN: STRONG_TOKEN, BROWSER_SERVICE_HOST: host }), /BROWSER_SERVICE_HOST=.*no spaces/, JSON.stringify(host));
    }
    assert.equal(resolveServiceSecurity({ BROWSER_SERVICE_TOKEN: STRONG_TOKEN, BROWSER_SERVICE_PORT: "43109" }).listenPort, 43109);

    assert.equal(resolveServiceSecurity({ BROWSER_SERVICE_TOKEN: ` ${STRONG_TOKEN}\n` }).token, STRONG_TOKEN);
    assert.deepEqual(resolveServiceSecurity({ BROWSER_SERVICE_TOKEN: STRONG_TOKEN }), {
        token: STRONG_TOKEN,
        listenHost: "127.0.0.1",
        listenPort: 3040,
        corsOrigins: [],
    });
    assert.deepEqual(
        resolveServiceSecurity({
            BROWSER_SERVICE_TOKEN: STRONG_TOKEN,
            BROWSER_SERVICE_HOST: "10.0.4.7",
            BROWSER_SERVICE_CORS_ORIGINS: "https://conclave.example/meet, https://conclave.example",
        }),
        { token: STRONG_TOKEN, listenHost: "10.0.4.7", listenPort: 3040, corsOrigins: ["https://conclave.example"] },
    );
    assert.equal(
        resolveServiceSecurity({ BROWSER_SERVICE_TOKEN: STRONG_TOKEN, BROWSER_SERVICE_HOST: "fd00::12" }).listenHost,
        "fd00::12",
    );
});

const startService = (env: NodeJS.ProcessEnv, args: string[] = []) => {
    const child = spawn(process.execPath, ["--import", "tsx", "src/server.ts", ...args], {
        cwd: packageDir,
        env: { PATH: process.env.PATH, ...env },
        stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.on("data", (chunk) => (output += chunk));
    child.stderr.on("data", (chunk) => (output += chunk));
    return { child, output: () => output };
};

test("the service process exits instead of starting without a strong token", async () => {
    const { child, output } = startService({ BROWSER_SERVICE_TOKEN: "" });
    const [code] = await once(child, "close");
    assert.equal(code, 1);
    assert.match(output(), /BROWSER_SERVICE_TOKEN is required/);
});

test("--check-config applies the startup checks and exits without listening", async () => {
    const check = async (env: NodeJS.ProcessEnv) => {
        const { child, output } = startService(env, ["--check-config"]);
        const [code] = await once(child, "close");
        return { code, output: output() };
    };
    const refused = [
        { BROWSER_SERVICE_TOKEN: STRONG_TOKEN, BROWSER_SERVICE_HOST: "0.0.0.0" },
        { BROWSER_SERVICE_TOKEN: STRONG_TOKEN, BROWSER_SERVICE_CORS_ORIGINS: "*" },
        { BROWSER_SERVICE_TOKEN: "short-token" },
    ];
    for (const env of refused) {
        const result = await check(env);
        assert.equal(result.code, 1, JSON.stringify(env));
        assert.match(result.output, /refused to start/);
    }
    const engine = await fakeDockerEngine({ "conclave-browser:latest": hardenedImage });
    const valid = await check({ BROWSER_SERVICE_TOKEN: STRONG_TOKEN, BROWSER_SERVICE_HOST: "127.0.0.1", BROWSER_SERVICE_PORT: String(await freePort()), DOCKER_HOST: engine.host }).finally(engine.close);
    assert.equal(valid.code, 0, valid.output);
    assert.match(valid.output, /configuration is valid/i);
    assert.doesNotMatch(valid.output, /listening/);
});

test("--check-config runs the same provider and bind checks as startup", async () => {
    const run = async (env: NodeJS.ProcessEnv, args: string[]) => {
        const { child, output } = startService({ BROWSER_SERVICE_TOKEN: STRONG_TOKEN, BROWSER_SERVICE_PORT: "43109", ...env }, args);
        const [code] = await once(child, "close");
        return { code, output: output() };
    };
    // Each of these passed the old check and then stopped the service at startup.
    for (const env of [
        { BROWSER_PROVIDER: "kitesurf" },
        { BROWSER_SERVICE_HOST: "10.254.254.254" },
        { BROWSER_SERVICE_PORT: " 43109" },
    ]) {
        const checked = await run(env, ["--check-config"]);
        assert.equal(checked.code, 1, `${JSON.stringify(env)}: ${checked.output}`);
        assert.match(checked.output, /refused to start/);
    }
    const started = await run({ BROWSER_PROVIDER: "kitesurf" }, []);
    assert.equal(started.code, 1);
    assert.match(started.output, /refused to start[\s\S]*Kitesurf requires CLOUDFLARE_ACCOUNT_ID/);
});

test("the service process listens on loopback and requires the token", async () => {
    const probe = createServer();
    const port = await listen(probe);
    probe.close();
    const engine = await fakeDockerEngine({ "conclave-browser:latest": hardenedImage });
    const { child, output } = startService({
        BROWSER_SERVICE_TOKEN: STRONG_TOKEN,
        BROWSER_SERVICE_PORT: String(port),
        DOCKER_HOST: engine.host,
    });
    try {
        const deadline = Date.now() + 20_000;
        while (!output().includes(`listening on 127.0.0.1:${port}`)) {
            assert.ok(Date.now() < deadline, `service did not start: ${output()}`);
            await new Promise((resolve) => setTimeout(resolve, 100));
        }
        assert.equal((await fetch(`http://127.0.0.1:${port}/sessions`)).status, 401);
    } finally {
        child.kill("SIGKILL");
        await engine.close();
    }
});

type CreatedContainer = { Env: string[]; HostConfig: { PortBindings: Record<string, Array<{ HostIp: string }>> } };

test("each Chromium session gets its own VNC password, carried only in the URL fragment", async () => {
    const created: CreatedContainer[] = [];
    const manager = new ContainerManager(
        { noVncPortStart: 6080, noVncPortEnd: 6081, noVncBindAddress: "127.0.0.1", publicBaseUrl: "https://browser.example" },
        fakeDocker(hardenedImage, created),
    );
    try {
        const sessions: BrowserSession[] = [];
        for (const roomId of ["room-a", "room-b"]) {
            const result = await manager.launchBrowser({ roomId, url: "https://example.com" });
            assert.ok(result.success && result.session);
            sessions.push(result.session);
        }

        // The lookup noVNC 1.3's vnc_lite.html performs on page load.
        const noVncReadsPassword = (href: string) =>
            "".concat(href, new URL(href).hash).match(/.*[?&]password=([^&#]*)/)?.[1];

        const passwords = sessions.map((session, index) => {
            const url = new URL(session.noVncUrl);
            const password = new URLSearchParams(url.hash.slice(1)).get("password") ?? "";
            assert.match(password, /^[A-Za-z0-9]{8}$/);
            assert.equal(noVncReadsPassword(session.noVncUrl), password);
            assert.equal(url.searchParams.get("password"), null);
            assert.ok(created[index].Env.includes(`VNC_PASSWORD=${password}`));
            assert.equal(created[index].HostConfig.PortBindings["6080/tcp"][0].HostIp, "127.0.0.1");
            return password;
        });
        assert.notEqual(passwords[0], passwords[1]);
    } finally {
        await manager.shutdown();
    }
});
