import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync } from "node:fs";
import { createServer as createHttpServer } from "node:http";
import test from "node:test";
import { fileURLToPath } from "node:url";
import puppeteer from "puppeteer-core";
import { ContainerManager, VNC_AUTH_IMAGE_LABEL } from "../src/ContainerManager.js";
import { fakeDocker, fakeDockerEngine, freePort, hardenedImage as hardened, listenHttp } from "./support/docker.js";

const STRONG_TOKEN = randomBytes(32).toString("hex");
const packageDir = fileURLToPath(new URL("..", import.meta.url));

const runService = async (env: NodeJS.ProcessEnv, args: string[]) => {
    const child = spawn(process.execPath, ["--import", "tsx", "src/server.ts", ...args], {
        cwd: packageDir,
        env: { PATH: process.env.PATH, BROWSER_SERVICE_TOKEN: STRONG_TOKEN, BROWSER_SERVICE_PORT: String(await freePort()), ...env },
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

test("a Chromium image without the per-session password label is never launched or reported healthy", async () => {
    for (const image of [null, { Labels: {} }, { Labels: { [VNC_AUTH_IMAGE_LABEL]: "none" } }]) {
        const created: unknown[] = [];
        const manager = new ContainerManager({ noVncPortStart: 6080, noVncPortEnd: 6081 }, fakeDocker(image, created));
        try {
            const launched = await manager.launchBrowser({ roomId: "room-a", url: "https://example.com" });
            assert.equal(launched.success, false, JSON.stringify(image));
            assert.match(launched.error ?? "", /per-session VNC password/);
            assert.deepEqual(created, []);
            await assert.rejects(manager.checkHealth(), /per-session VNC password/);
        } finally {
            await manager.shutdown();
        }
    }

    const created: unknown[] = [];
    const manager = new ContainerManager({ noVncPortStart: 6080, noVncPortEnd: 6081 }, fakeDocker(hardened, created));
    try {
        await manager.checkHealth();
        assert.equal((await manager.launchBrowser({ roomId: "room-a", url: "https://example.com" })).success, true);
        assert.equal(created.length, 1);
    } finally {
        await manager.shutdown();
    }
});

test("a session starts from the exact image that passed the check, even if the tag moves", async () => {
    const created: Array<{ Image: string }> = [];
    let inspected = 0;
    const docker = fakeDocker(hardened, created) as unknown as Record<string, unknown>;
    docker.getImage = () => ({
        inspect: async () => {
            inspected += 1;
            return inspected === 1
                ? { Id: "sha256:checked", Config: { Labels: hardened?.Labels } }
                : { Id: "sha256:moved", Config: { Labels: {} } };
        },
    });
    const manager = new ContainerManager({ noVncPortStart: 6080, noVncPortEnd: 6081 }, docker as never);
    try {
        const launched = await manager.launchBrowser({ roomId: "room-a", url: "https://example.com" });
        assert.equal(launched.success, true, launched.error);
        assert.deepEqual(created.map((options) => options.Image), ["sha256:checked"]);
    } finally {
        await manager.shutdown();
    }
});

test("the service refuses to start, and --check-config refuses, unless the configured image carries the label", async () => {
    const engine = await fakeDockerEngine({ "hardened:1": hardened, "stale:1": { Labels: {} } });
    try {
        for (const args of [["--check-config"], []]) {
            for (const image of ["stale:1", "missing:1"]) {
                const refused = await runService({ DOCKER_HOST: engine.host, BROWSER_IMAGE_NAME: image }, args);
                assert.equal(refused.code, 1, `${image} ${args.join(" ")}: ${refused.output}`);
                assert.match(refused.output, /refused to start[\s\S]*per-session VNC password/);
            }
        }
        const unreachable = await runService({ DOCKER_HOST: "tcp://127.0.0.1:9", BROWSER_IMAGE_NAME: "hardened:1" }, ["--check-config"]);
        assert.equal(unreachable.code, 1, unreachable.output);
        const valid = await runService({ DOCKER_HOST: engine.host, BROWSER_IMAGE_NAME: "hardened:1" }, ["--check-config"]);
        assert.equal(valid.code, 0, valid.output);
        assert.match(valid.output, /configuration is valid/i);
    } finally {
        await engine.close();
    }
});

test("consecutive sessions on the same port get viewer URLs that differ outside the fragment", async () => {
    const manager = new ContainerManager(
        { noVncPortStart: 6080, noVncPortEnd: 6080, hostAddress: "127.0.0.1", publicBaseUrl: "" },
        fakeDocker(hardened),
    );
    try {
        const urls: URL[] = [];
        for (let index = 0; index < 2; index += 1) {
            const launched = await manager.launchBrowser({ roomId: "room-a", url: "https://example.com" });
            assert.ok(launched.success && launched.session);
            urls.push(new URL(launched.session.noVncUrl));
            await manager.closeBrowser("room-a");
        }
        assert.equal(urls[0].port, urls[1].port);
        const withoutFragment = urls.map((url) => `${url.origin}${url.pathname}${url.search}`);
        assert.notEqual(withoutFragment[0], withoutFragment[1]);
        for (const url of urls) {
            const password = new URLSearchParams(url.hash.slice(1)).get("password") ?? "";
            assert.ok(password);
            assert.equal(url.search.includes(password), false);
        }
    } finally {
        await manager.shutdown();
    }
});

const chromePath = [
    process.env.CHROME_PATH,
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
].find((path): path is string => Boolean(path && existsSync(path)));

test("an open viewer loads a fresh page when its session is replaced on the same port", { skip: chromePath ? false : "no Chrome or Chromium on this machine" }, async () => {
    const loads: string[] = [];
    const viewer = createHttpServer((req, res) => {
        if (req.url?.startsWith("/vnc_lite.html")) loads.push(req.url);
        res.writeHead(200, { "content-type": "text/html" });
        res.end("<!doctype html><title>viewer</title>");
    });
    const port = await listenHttp(viewer);
    const manager = new ContainerManager(
        { noVncPortStart: port, noVncPortEnd: port, hostAddress: "127.0.0.1", publicBaseUrl: "" },
        fakeDocker(hardened),
    );
    const browser = await puppeteer.launch({ executablePath: chromePath, headless: true, args: ["--no-sandbox"] });
    try {
        const first = await manager.launchBrowser({ roomId: "room-a", url: "https://example.com" });
        assert.ok(first.success && first.session);
        await manager.closeBrowser("room-a");
        const second = await manager.launchBrowser({ roomId: "room-a", url: "https://example.org" });
        assert.ok(second.success && second.session);
        assert.equal(new URL(first.session.noVncUrl).port, new URL(second.session.noVncUrl).port);

        const page = await browser.newPage();
        await page.setContent(`<iframe id="viewer" src="${first.session.noVncUrl}"></iframe>`);
        const waitForLoads = async (count: number) => {
            const deadline = Date.now() + 5_000;
            while (loads.length < count && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 50));
        };
        await waitForLoads(1);
        assert.equal(loads.length, 1);
        await page.evaluate((url) => {
            (document.getElementById("viewer") as HTMLIFrameElement).src = url;
        }, second.session.noVncUrl);
        await waitForLoads(2);
        assert.equal(loads.length, 2, "the viewer kept the old page, so noVNC would keep the old password");
    } finally {
        await browser.close();
        await manager.shutdown();
        viewer.closeAllConnections();
        viewer.close();
    }
});
