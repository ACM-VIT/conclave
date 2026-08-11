import assert from "node:assert/strict";
import test from "node:test";
import type { Browser } from "puppeteer-core";
import {
    buildAgentSearchUrl,
    KitesurfManager,
    validateAgentNavigationLink,
    validateAgentNavigationUrl,
} from "../src/KitesurfManager.js";

const jsonResponse = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {
        status,
        headers: { "Content-Type": "application/json" },
    });

type RecordedViewport = {
    width: number;
    height: number;
    deviceScaleFactor?: number;
};

const createBrowserConnector = (viewports: RecordedViewport[] = []) =>
    async (): Promise<Browser> =>
        ({
            pages: async () => [
                {
                    url: () => "https://example.com",
                    setViewport: async (viewport: RecordedViewport | null) => {
                        if (viewport) viewports.push(viewport);
                    },
                },
            ],
            disconnect: async () => undefined,
        }) as unknown as Browser;

test("launches, refreshes, navigates, and closes a Kitesurf session", async () => {
    const requests: Array<{ url: string; method: string; authorization: string | null }> = [];
    const configuredViewports: RecordedViewport[] = [];
    let targetNumber = 1;
    const fetchImpl: typeof fetch = async (input, init) => {
        const url = String(input);
        const method = init?.method || "GET";
        const headers = new Headers(init?.headers);
        requests.push({ url, method, authorization: headers.get("Authorization") });

        if (method === "POST" && url.includes("/devtools/browser?")) {
            return jsonResponse({
                sessionId: "session-1",
                webSocketDebuggerUrl: "wss://api.cloudflare.test/session-1",
            });
        }
        if (method === "PUT" && url.includes("/json/new")) {
            const id = `target-${targetNumber++}`;
            return jsonResponse({
                id,
                url: new URL(url).searchParams.get("url"),
                devtoolsFrontendUrl: `https://live.browser.run/ui/view?wss=session-1/${id}`,
            });
        }
        if (method === "GET" && url.endsWith("/json/list")) {
            return jsonResponse([
                {
                    id: "target-1",
                    url: "https://example.com/",
                    devtoolsFrontendUrl:
                        "https://live.browser.run/ui/view?wss=session-1/target-1-refreshed",
                },
            ]);
        }
        if (method === "GET" && url.includes("/json/close/")) {
            return jsonResponse({ status: "closing" });
        }
        if (method === "DELETE") return jsonResponse({ status: "closing" });
        return jsonResponse({ error: "Unexpected request" }, 500);
    };

    const manager = new KitesurfManager(
        {
            cloudflareAccountId: "account-1",
            cloudflareApiToken: "secret-token",
            cloudflareBrowserRunBaseUrl: "https://api.cloudflare.test/browser-run",
            containerIdleTimeoutMs: 60_000,
        },
        fetchImpl,
        createBrowserConnector(configuredViewports),
    );

    const launched = await manager.launchBrowser({
        roomId: "room-1",
        url: "https://example.com/",
        controllerUserId: "host-1",
    });
    assert.equal(launched.success, true);
    assert.equal(launched.session?.provider, "kitesurf");
    assert.match(launched.session?.noVncUrl || "", /mode=tab/);
    assert.equal(manager.capabilities.agentic, true);
    assert.equal(manager.capabilities.audio, false);
    assert.deepEqual(configuredViewports, [
        { width: 1920, height: 1080, deviceScaleFactor: 1 },
    ]);

    const refreshed = await manager.getSession("room-1");
    assert.match(refreshed?.noVncUrl || "", /refreshed/);

    const navigated = await manager.navigateTo({
        roomId: "room-1",
        url: "https://example.org/next",
    });
    assert.equal(navigated.success, true);
    assert.equal(navigated.session?.currentUrl, "https://example.org/next");
    assert.deepEqual(configuredViewports, [
        { width: 1920, height: 1080, deviceScaleFactor: 1 },
        { width: 1920, height: 1080, deviceScaleFactor: 1 },
    ]);

    const closed = await manager.closeBrowser("room-1");
    assert.deepEqual(closed, { success: true });
    assert.equal(manager.getAllSessions().length, 0);
    assert.ok(
        requests.every((request) => request.authorization === "Bearer secret-token"),
    );
    assert.ok(
        requests.some(
            (request) =>
                request.method === "POST" &&
                request.url.includes("browser=kitesurf") &&
                request.url.includes("keep_alive=600000"),
        ),
    );
    assert.ok(
        requests.some(
            (request) =>
                request.method === "GET" && request.url.endsWith("/json/close/target-1"),
        ),
    );
    assert.ok(
        !requests.some(
            (request) =>
                request.method === "DELETE" && request.url.includes("/json/close/"),
        ),
    );
});

test("fails fast when Kitesurf credentials are missing", () => {
    assert.throws(
        () =>
            new KitesurfManager({
                cloudflareAccountId: "",
                cloudflareApiToken: "",
            }),
        /CLOUDFLARE_ACCOUNT_ID/,
    );
});

test("checks Browser Run readiness with the configured credentials", async () => {
    const requests: Array<{ url: string; authorization: string | null }> = [];
    const fetchImpl: typeof fetch = async (input, init) => {
        requests.push({
            url: String(input),
            authorization: new Headers(init?.headers).get("Authorization"),
        });
        return jsonResponse([]);
    };
    const manager = new KitesurfManager(
        {
            cloudflareAccountId: "account-1",
            cloudflareApiToken: "secret-token",
            cloudflareBrowserRunBaseUrl: "https://api.cloudflare.test/browser-run",
        },
        fetchImpl,
        createBrowserConnector(),
    );

    await manager.checkHealth();

    assert.deepEqual(requests, [
        {
            url: "https://api.cloudflare.test/browser-run/devtools/session",
            authorization: "Bearer secret-token",
        },
    ]);
});

test("rejects Browser Run readiness when credentials are refused", async () => {
    const manager = new KitesurfManager(
        {
            cloudflareAccountId: "account-1",
            cloudflareApiToken: "expired-token",
            cloudflareBrowserRunBaseUrl: "https://api.cloudflare.test/browser-run",
        },
        async () => jsonResponse({ errors: [{ message: "Invalid token" }] }, 401),
    );

    await assert.rejects(manager.checkHealth(), /Invalid token/);
});

test("forgets sessions whose Cloudflare target has expired", async () => {
    const fetchImpl: typeof fetch = async (input, init) => {
        const url = String(input);
        const method = init?.method || "GET";
        if (method === "POST") {
            return jsonResponse({
                sessionId: "session-expired",
                webSocketDebuggerUrl: "wss://api.cloudflare.test/session-expired",
            });
        }
        if (method === "PUT") {
            return jsonResponse({
                id: "target-expired",
                devtoolsFrontendUrl: "https://live.browser.run/ui/view?wss=expired",
            });
        }
        if (method === "GET" && url.endsWith("/json/list")) return jsonResponse([]);
        return jsonResponse({ status: "closing" });
    };
    const manager = new KitesurfManager(
        {
            cloudflareAccountId: "account-1",
            cloudflareApiToken: "secret-token",
            cloudflareBrowserRunBaseUrl: "https://api.cloudflare.test/browser-run",
        },
        fetchImpl,
        createBrowserConnector(),
    );

    assert.equal(
        (await manager.launchBrowser({ roomId: "room-expired", url: "https://example.com" }))
            .success,
        true,
    );
    assert.equal(await manager.getSession("room-expired"), undefined);
    assert.equal(manager.getAllSessions().length, 0);
});

test("rejects untrusted Live View origins", async () => {
    const fetchImpl: typeof fetch = async (input, init) => {
        if ((init?.method || "GET") === "POST") {
            return jsonResponse({
                sessionId: "session-unsafe",
                webSocketDebuggerUrl: "wss://api.cloudflare.test/session-unsafe",
            });
        }
        if (String(input).includes("/json/new")) {
            return jsonResponse({
                id: "target-unsafe",
                devtoolsFrontendUrl: "https://attacker.example/live",
            });
        }
        return jsonResponse({ status: "closing" });
    };
    const manager = new KitesurfManager(
        {
            cloudflareAccountId: "account-1",
            cloudflareApiToken: "secret-token",
            cloudflareBrowserRunBaseUrl: "https://api.cloudflare.test/browser-run",
        },
        fetchImpl,
        createBrowserConnector(),
    );
    const result = await manager.launchBrowser({
        roomId: "room-unsafe",
        url: "https://example.com",
    });
    assert.equal(result.success, false);
    assert.match(result.error || "", /invalid Live View URL/);
});

test("agent navigation rejects local networks and credential-bearing URLs", () => {
    assert.throws(
        () => validateAgentNavigationUrl("http://127.0.0.1:3000"),
        /private network/,
    );
    assert.throws(
        () => validateAgentNavigationUrl("http://169.254.169.254/latest/meta-data"),
        /private network/,
    );
    assert.throws(
        () => validateAgentNavigationUrl("http://[::ffff:127.0.0.1]:3000"),
        /private network/,
    );
    assert.throws(
        () => validateAgentNavigationUrl("http://[::ffff:169.254.169.254]/latest/meta-data"),
        /private network/,
    );
    assert.throws(
        () => validateAgentNavigationUrl("https://user:pass@example.com"),
        /credentials/,
    );
    assert.equal(
        validateAgentNavigationUrl("https://example.com/research?q=kitesurf").hostname,
        "example.com",
    );
});

test("agent search builds a validated GET navigation without page input events", () => {
    const target = buildAgentSearchUrl(
        {
            pageUrl: "https://search.example/start",
            action: "/find?source=meeting",
            method: "get",
            fieldName: "q",
            inputType: "search",
            role: "",
            description: "Search",
            isSearchForm: true,
        },
        "Cloudflare Kitesurf",
    );

    assert.equal(target.origin, "https://search.example");
    assert.equal(target.pathname, "/find");
    assert.equal(target.searchParams.get("source"), "meeting");
    assert.equal(target.searchParams.get("q"), "Cloudflare Kitesurf");
});

test("agent search rejects unsafe or malformed form targets", () => {
    const submission = {
        pageUrl: "https://search.example/start",
        action: "/find",
        method: "get",
        fieldName: "q",
        inputType: "search",
        role: "",
        description: "Search",
        isSearchForm: true,
    };

    assert.throws(
        () => buildAgentSearchUrl({ ...submission, action: "http://[::ffff:127.0.0.1]" }, "x"),
        /private network/,
    );
    assert.throws(
        () => buildAgentSearchUrl({ ...submission, method: "post" }, "x"),
        /semantic GET search form/,
    );
    assert.throws(
        () => buildAgentSearchUrl({ ...submission, fieldName: "" }, "x"),
        /semantic GET search form/,
    );
    assert.throws(
        () => buildAgentSearchUrl({ ...submission, isSearchForm: false }, "x"),
        /semantic GET search form/,
    );
    assert.throws(
        () =>
            buildAgentSearchUrl(
                { ...submission, action: "https://attacker.example/search" },
                "x",
            ),
        /another site/,
    );
});

test("failed Kitesurf navigation preserves the active target", async () => {
    const closedTargets: string[] = [];
    let targetNumber = 1;
    const fetchImpl: typeof fetch = async (input, init) => {
        const url = String(input);
        const method = init?.method || "GET";
        if (method === "POST") {
            return jsonResponse({
                sessionId: "session-transactional",
                webSocketDebuggerUrl: "wss://api.cloudflare.test/session-transactional",
            });
        }
        if (method === "PUT") {
            const id = `target-${targetNumber++}`;
            return jsonResponse({
                id,
                devtoolsFrontendUrl:
                    id === "target-1"
                        ? "https://live.browser.run/ui/view?wss=transactional"
                        : "https://attacker.example/live",
            });
        }
        if (method === "GET" && url.includes("/json/close/")) {
            closedTargets.push(url);
            return jsonResponse({ status: "closing" });
        }
        if (method === "DELETE") return jsonResponse({ status: "closing" });
        return jsonResponse({ error: "Unexpected request" }, 500);
    };
    const manager = new KitesurfManager(
        {
            cloudflareAccountId: "account-1",
            cloudflareApiToken: "secret-token",
            cloudflareBrowserRunBaseUrl: "https://api.cloudflare.test/browser-run",
        },
        fetchImpl,
        createBrowserConnector(),
    );

    const launched = await manager.launchBrowser({
        roomId: "room-transactional",
        url: "https://example.com/original",
    });
    assert.equal(launched.success, true);
    const originalLiveViewUrl = launched.session?.noVncUrl;

    const navigated = await manager.navigateTo({
        roomId: "room-transactional",
        url: "https://example.com/next",
    });

    assert.equal(navigated.success, false);
    assert.equal(manager.getAllSessions()[0]?.currentUrl, "https://example.com/original");
    assert.equal(manager.getAllSessions()[0]?.noVncUrl, originalLiveViewUrl);
    assert.ok(closedTargets.some((url) => url.endsWith("/json/close/target-2")));
    assert.ok(!closedTargets.some((url) => url.endsWith("/json/close/target-1")));
    await manager.closeBrowser("room-transactional");
});

test("a stale refresh cannot delete a replacement navigation session", async () => {
    let resolveStaleTargetList: ((response: Response) => void) | undefined;
    const staleTargetList = new Promise<Response>((resolve) => {
        resolveStaleTargetList = resolve;
    });
    let targetNumber = 0;
    let targetListRequestNumber = 0;
    const fetchImpl: typeof fetch = async (input, init) => {
        const url = String(input);
        const method = init?.method || "GET";
        if (method === "POST") {
            return jsonResponse({
                sessionId: "session-refresh-race",
                webSocketDebuggerUrl: "wss://api.cloudflare.test/session-refresh-race",
            });
        }
        if (method === "PUT") {
            targetNumber += 1;
            return jsonResponse({
                id: `target-${targetNumber}`,
                url: new URL(url).searchParams.get("url"),
                devtoolsFrontendUrl:
                    `https://live.browser.run/ui/view?wss=session-refresh-race/target-${targetNumber}`,
            });
        }
        if (method === "GET" && url.endsWith("/json/list")) {
            targetListRequestNumber += 1;
            if (targetListRequestNumber === 1) return staleTargetList;
            return jsonResponse([
                {
                    id: "target-2",
                    url: "https://example.com/next",
                    devtoolsFrontendUrl:
                        "https://live.browser.run/ui/view?wss=session-refresh-race/target-2",
                },
            ]);
        }
        if (method === "GET" && url.includes("/json/close/")) {
            return jsonResponse({ status: "closing" });
        }
        if (method === "DELETE") return jsonResponse({ status: "closing" });
        return jsonResponse({ error: "Unexpected request" }, 500);
    };
    const manager = new KitesurfManager(
        {
            cloudflareAccountId: "account-1",
            cloudflareApiToken: "secret-token",
            cloudflareBrowserRunBaseUrl: "https://api.cloudflare.test/browser-run",
        },
        fetchImpl,
        createBrowserConnector(),
    );
    assert.equal(
        (await manager.launchBrowser({
            roomId: "room-refresh-race",
            url: "https://example.com/original",
        })).success,
        true,
    );

    const refresh = manager.getSession("room-refresh-race");
    const navigation = await manager.navigateTo({
        roomId: "room-refresh-race",
        url: "https://example.com/next",
    });
    assert.equal(navigation.success, true);
    assert.ok(resolveStaleTargetList);
    resolveStaleTargetList(
        jsonResponse([
            {
                id: "target-2",
                url: "https://example.com/next",
                devtoolsFrontendUrl:
                    "https://live.browser.run/ui/view?wss=session-refresh-race/target-2",
            },
        ]),
    );

    const refreshed = await refresh;
    assert.equal(refreshed, navigation.session);
    assert.equal(refreshed?.currentUrl, "https://example.com/next");
    assert.equal(manager.getAllSessions().length, 1);
    assert.equal(targetListRequestNumber, 2);
    await manager.closeBrowser("room-refresh-race");
});

test("serializes Kitesurf navigation within a room", async () => {
    let resolveNavigation: ((response: Response) => void) | undefined;
    const pendingNavigation = new Promise<Response>((resolve) => {
        resolveNavigation = resolve;
    });
    let targetNumber = 0;
    const fetchImpl: typeof fetch = async (input, init) => {
        const url = String(input);
        const method = init?.method || "GET";
        if (method === "POST") {
            return jsonResponse({
                sessionId: "session-serialized",
                webSocketDebuggerUrl: "wss://api.cloudflare.test/session-serialized",
            });
        }
        if (method === "PUT") {
            targetNumber += 1;
            if (targetNumber === 2) return pendingNavigation;
            return jsonResponse({
                id: `target-${targetNumber}`,
                devtoolsFrontendUrl:
                    "https://live.browser.run/ui/view?wss=session-serialized",
            });
        }
        if (method === "GET" && url.includes("/json/close/")) {
            return jsonResponse({ status: "closing", url });
        }
        if (method === "DELETE") return jsonResponse({ status: "closing", url });
        return jsonResponse({ error: "Unexpected request" }, 500);
    };
    const manager = new KitesurfManager(
        {
            cloudflareAccountId: "account-1",
            cloudflareApiToken: "secret-token",
            cloudflareBrowserRunBaseUrl: "https://api.cloudflare.test/browser-run",
        },
        fetchImpl,
        createBrowserConnector(),
    );
    assert.equal(
        (await manager.launchBrowser({
            roomId: "room-serialized",
            url: "https://example.com",
        })).success,
        true,
    );

    const firstNavigation = manager.navigateTo({
        roomId: "room-serialized",
        url: "https://example.com/first",
    });
    const secondNavigation = await manager.navigateTo({
        roomId: "room-serialized",
        url: "https://example.com/second",
    });

    assert.deepEqual(secondNavigation, {
        success: false,
        error: "Browser navigation is already in progress",
    });
    assert.ok(resolveNavigation);
    resolveNavigation(
        jsonResponse({
            id: "target-2",
            devtoolsFrontendUrl:
                "https://live.browser.run/ui/view?wss=session-serialized-next",
        }),
    );
    assert.equal((await firstNavigation).success, true);
    assert.equal(manager.getAllSessions()[0]?.currentUrl, "https://example.com/first");
    assert.equal(targetNumber, 2);
    await manager.closeBrowser("room-serialized");
});

test("does not restore a session closed while navigation is in progress", async () => {
    let resolveNavigation: ((response: Response) => void) | undefined;
    const pendingNavigation = new Promise<Response>((resolve) => {
        resolveNavigation = resolve;
    });
    const closedTargets: string[] = [];
    let targetNumber = 0;
    const fetchImpl: typeof fetch = async (input, init) => {
        const url = String(input);
        const method = init?.method || "GET";
        if (method === "POST") {
            return jsonResponse({
                sessionId: "session-close-race",
                webSocketDebuggerUrl: "wss://api.cloudflare.test/session-close-race",
            });
        }
        if (method === "PUT") {
            targetNumber += 1;
            if (targetNumber === 2) return pendingNavigation;
            return jsonResponse({
                id: "target-1",
                devtoolsFrontendUrl:
                    "https://live.browser.run/ui/view?wss=session-close-race/target-1",
            });
        }
        if (method === "GET" && url.includes("/json/close/")) {
            closedTargets.push(url);
            return jsonResponse({ status: "closing" });
        }
        if (method === "DELETE") return jsonResponse({ status: "closing" });
        return jsonResponse({ error: "Unexpected request" }, 500);
    };
    const manager = new KitesurfManager(
        {
            cloudflareAccountId: "account-1",
            cloudflareApiToken: "secret-token",
            cloudflareBrowserRunBaseUrl: "https://api.cloudflare.test/browser-run",
        },
        fetchImpl,
        createBrowserConnector(),
    );
    assert.equal(
        (await manager.launchBrowser({
            roomId: "room-close-race",
            url: "https://example.com",
        })).success,
        true,
    );

    const navigation = manager.navigateTo({
        roomId: "room-close-race",
        url: "https://example.com/next",
    });
    assert.deepEqual(await manager.closeBrowser("room-close-race"), { success: true });
    assert.equal(manager.getAllSessions().length, 0);

    assert.ok(resolveNavigation);
    resolveNavigation(
        jsonResponse({
            id: "target-2",
            devtoolsFrontendUrl:
                "https://live.browser.run/ui/view?wss=session-close-race/target-2",
        }),
    );

    const result = await navigation;
    assert.equal(result.success, false);
    assert.match(result.error || "", /closed or replaced/);
    assert.equal(manager.getAllSessions().length, 0);
    assert.ok(closedTargets.some((url) => url.endsWith("/json/close/target-2")));
});

test("agent clicks only follow HTTP navigation links", () => {
    assert.equal(
        validateAgentNavigationLink({
            href: "https://example.com/research",
            description: "Read the research",
        }).pathname,
        "/research",
    );
    assert.throws(
        () => validateAgentNavigationLink(null),
        /only follow navigation links/,
    );
    assert.throws(
        () =>
            validateAgentNavigationLink({
                href: "javascript:alert(1)",
                description: "Open",
            }),
        /HTTP or HTTPS/,
    );
});

test("rejects a concurrent launch for the same room", async () => {
    let resolveLaunch: ((response: Response) => void) | undefined;
    const launchResponse = new Promise<Response>((resolve) => {
        resolveLaunch = resolve;
    });
    const fetchImpl: typeof fetch = async (input, init) => {
        const method = init?.method || "GET";
        if (method === "POST") return launchResponse;
        if (method === "PUT") {
            return jsonResponse({
                id: "target-concurrent",
                devtoolsFrontendUrl: "https://live.browser.run/ui/view?wss=concurrent",
            });
        }
        return jsonResponse({ status: "closing" });
    };
    const manager = new KitesurfManager(
        {
            cloudflareAccountId: "account-1",
            cloudflareApiToken: "secret-token",
            cloudflareBrowserRunBaseUrl: "https://api.cloudflare.test/browser-run",
        },
        fetchImpl,
        createBrowserConnector(),
    );

    const firstLaunch = manager.launchBrowser({
        roomId: "room-concurrent",
        url: "https://example.com",
    });
    const secondLaunch = await manager.launchBrowser({
        roomId: "room-concurrent",
        url: "https://example.org",
    });
    assert.deepEqual(secondLaunch, {
        success: false,
        error: "Browser session already exists for this room",
    });

    assert.ok(resolveLaunch);
    resolveLaunch(jsonResponse({
        sessionId: "session-concurrent",
        webSocketDebuggerUrl: "wss://api.cloudflare.test/session-concurrent",
    }));
    assert.equal((await firstLaunch).success, true);
    assert.equal(manager.getAllSessions().length, 1);
    await manager.closeBrowser("room-concurrent");
});
