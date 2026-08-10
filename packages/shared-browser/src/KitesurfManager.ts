import type {
    BrowserAgentAction,
    BrowserAgentObservation,
    BrowserCapabilities,
    BrowserManager,
    BrowserServiceConfig,
    BrowserSession,
    LaunchBrowserOptions,
    LaunchBrowserResult,
    NavigateOptions,
} from "./types.js";
import { defaultConfig } from "./types.js";
import puppeteer, { type Browser, type Page } from "puppeteer-core";

type FetchLike = typeof fetch;

type CloudflareSession = {
    sessionId?: string;
    webSocketDebuggerUrl?: string;
};

type CloudflareTarget = {
    id?: string;
    type?: string;
    url?: string;
    devtoolsFrontendUrl?: string;
    webSocketDebuggerUrl?: string;
};

type KitesurfSession = BrowserSession & {
    targetId: string;
    webSocketDebuggerUrl: string;
};

class CloudflareBrowserRunError extends Error {
    constructor(
        message: string,
        readonly status: number,
    ) {
        super(message);
        this.name = "CloudflareBrowserRunError";
    }
}

const readErrorMessage = (payload: unknown, fallback: string): string => {
    if (typeof payload !== "object" || payload === null) return fallback;
    const record = payload as Record<string, unknown>;
    if (typeof record.error === "string" && record.error) return record.error;
    if (typeof record.message === "string" && record.message) return record.message;
    if (Array.isArray(record.errors)) {
        const message = record.errors
            .map((error) =>
                typeof error === "object" && error !== null
                    ? (error as Record<string, unknown>).message
                    : undefined,
            )
            .find((value): value is string => typeof value === "string" && Boolean(value));
        if (message) return message;
    }
    return fallback;
};

const unwrapResult = (payload: unknown): unknown => {
    if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
        return payload;
    }
    const record = payload as Record<string, unknown>;
    return record.result ?? payload;
};

const isPrivateIpv4 = (ipv4: number[]): boolean =>
    ipv4[0] === 0 ||
    ipv4[0] === 10 ||
    ipv4[0] === 127 ||
    (ipv4[0] === 169 && ipv4[1] === 254) ||
    (ipv4[0] === 172 && ipv4[1] >= 16 && ipv4[1] <= 31) ||
    (ipv4[0] === 192 && ipv4[1] === 168);

const mappedIpv4Address = (hostname: string): number[] | null => {
    const dottedMatch = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(hostname);
    if (dottedMatch) {
        const ipv4 = dottedMatch[1].split(".").map(Number);
        return ipv4.every((part) => part >= 0 && part <= 255) ? ipv4 : null;
    }

    const hexadecimalMatch = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(hostname);
    if (!hexadecimalMatch) return null;
    const high = Number.parseInt(hexadecimalMatch[1], 16);
    const low = Number.parseInt(hexadecimalMatch[2], 16);
    return [high >> 8, high & 0xff, low >> 8, low & 0xff];
};

const isPrivateHostname = (rawHostname: string): boolean => {
    const hostname = rawHostname.toLowerCase().replace(/^\[|\]$/g, "");
    if (
        hostname === "localhost" ||
        hostname.endsWith(".localhost") ||
        hostname.endsWith(".local")
    ) {
        return true;
    }

    const ipv4 = hostname.split(".").map(Number);
    if (
        ipv4.length === 4 &&
        ipv4.every((part) => Number.isInteger(part) && part >= 0 && part <= 255)
    ) {
        return isPrivateIpv4(ipv4);
    }

    const mappedIpv4 = mappedIpv4Address(hostname);
    if (mappedIpv4) return isPrivateIpv4(mappedIpv4);

    return (
        hostname === "::" ||
        hostname === "::1" ||
        hostname.startsWith("fc") ||
        hostname.startsWith("fd") ||
        hostname.startsWith("fe8") ||
        hostname.startsWith("fe9") ||
        hostname.startsWith("fea") ||
        hostname.startsWith("feb")
    );
};

export const validateAgentNavigationUrl = (value: string): URL => {
    if (value.length > 2048) throw new Error("The browser agent URL is too long");
    const target = new URL(value);
    if (target.protocol !== "http:" && target.protocol !== "https:") {
        throw new Error("The browser agent can only open HTTP or HTTPS URLs");
    }
    if (target.username || target.password) {
        throw new Error("The browser agent cannot put credentials in a URL");
    }
    if (isPrivateHostname(target.hostname)) {
        throw new Error("The browser agent cannot open private network addresses");
    }
    return target;
};

const SEARCH_FORM_LANDMARK_SELECTOR = "search, [role='search']";

// Keep this as a string rather than a transpiled callback. Development
// runners such as tsx/esbuild can inject helpers (for example `__name`) into
// function bodies; those helpers do not exist when Puppeteer serializes the
// callback into the remote browser isolate.
const AGENT_OBSERVATION_SCRIPT = `(() => {
    const MAX_TEXT_LENGTH = 12000;
    const MAX_ELEMENTS = 120;
    const interactiveSelector = [
        "a[href]",
        "button",
        "input",
        "textarea",
        "select",
        "[role='button']",
        "[role='link']",
        "[contenteditable='true']"
    ].join(",");
    const isVisible = (element) => {
        const rect = element.getBoundingClientRect();
        const style = window.getComputedStyle(element);
        return rect.width > 0 && rect.height > 0 &&
            style.visibility !== "hidden" && style.display !== "none";
    };
    const clean = (value, max = 180) =>
        value?.replace(/\\s+/g, " ").trim().slice(0, max) || undefined;
    const stateKey = Symbol.for("@conclave/shared-browser/agent-elements");
    let agentState = globalThis[stateKey];
    if (!agentState || !(agentState.ids instanceof WeakMap)) {
        agentState = { ids: new WeakMap(), nextId: 1 };
        globalThis[stateKey] = agentState;
    }

    const elements = Array.from(document.querySelectorAll(interactiveSelector))
        .filter(isVisible)
        .slice(0, MAX_ELEMENTS)
        .map((element) => {
            let id = agentState.ids.get(element);
            if (!id) {
                id = \`e\${agentState.nextId++}\`;
                agentState.ids.set(element, id);
            }
            element.setAttribute("data-conclave-agent-id", id);
            const form = element.form || element.closest("form");
            const isSearchForm = Boolean(
                form?.closest(${JSON.stringify(SEARCH_FORM_LANDMARK_SELECTOR)})
            );
            return {
                id,
                tag: element.tagName.toLowerCase(),
                role: clean(element.getAttribute("role"), 60),
                text: clean(element.innerText || element.textContent),
                label: clean(
                    element.getAttribute("aria-label") ||
                    element.getAttribute("placeholder") ||
                    element.getAttribute("title")
                ),
                href: clean(element.href, 500),
                inputType: clean(element.type, 40),
                formMethod: clean(form?.method?.toLowerCase(), 16),
                isSearchForm
            };
        });

    return {
        url: window.location.href,
        title: document.title,
        text: (document.body?.innerText || "")
            .replace(/\\s+/g, " ")
            .trim()
            .slice(0, MAX_TEXT_LENGTH),
        elements
    };
})()`;

const agentNavigationLinkScript = (selector: string): string => `(() => {
    const element = document.querySelector(${JSON.stringify(selector)});
    if (!element || element.tagName?.toLowerCase() !== "a") return null;
    const href = element.href;
    if (!href || element.hasAttribute("download")) return null;
    return { href };
})()`;

type AgentNavigationLink = {
    href: string;
};

export const validateAgentNavigationLink = (value: unknown): URL => {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        throw new Error("The browser agent can only follow navigation links");
    }
    const candidate = value as Partial<AgentNavigationLink>;
    if (typeof candidate.href !== "string") {
        throw new Error("The browser agent can only follow navigation links");
    }
    return validateAgentNavigationUrl(candidate.href);
};

type AgentSearchSubmission = {
    pageUrl: string;
    action: string;
    method: string;
    fieldName: string;
    inputType: string;
    role: string;
    isSearchForm: boolean;
};

const agentSearchSubmissionScript = (selector: string): string => `(() => {
    const element = document.querySelector(${JSON.stringify(selector)});
    if (!element) return null;
    const form = element.form || element.closest("form");
    if (!form) return null;
    return {
        pageUrl: window.location.href,
        action: form.getAttribute("action") || "",
        method: (form.getAttribute("method") || "get").toLowerCase(),
        fieldName: element.getAttribute("name") || "",
        inputType: (element.getAttribute("type") || "").toLowerCase(),
        role: (element.getAttribute("role") || "").toLowerCase(),
        isSearchForm: Boolean(
            form.closest(${JSON.stringify(SEARCH_FORM_LANDMARK_SELECTOR)})
        )
    };
})()`;

export const buildAgentSearchUrl = (value: unknown, query: string): URL => {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        throw new Error("The browser agent can only submit a GET search form");
    }
    const submission = value as Partial<AgentSearchSubmission>;
    const isSearchField =
        submission.inputType === "search" ||
        submission.role === "searchbox";
    if (
        submission.method !== "get" ||
        typeof submission.pageUrl !== "string" ||
        typeof submission.action !== "string" ||
        typeof submission.fieldName !== "string" ||
        !submission.fieldName ||
        submission.isSearchForm !== true ||
        !isSearchField
    ) {
        throw new Error("The browser agent can only submit a semantic GET search form");
    }
    if (query.length > 2000) throw new Error("The browser agent search query is too long");

    const pageUrl = validateAgentNavigationUrl(submission.pageUrl);
    const target = validateAgentNavigationUrl(
        new URL(submission.action || pageUrl.toString(), pageUrl).toString(),
    );
    if (target.origin !== pageUrl.origin) {
        throw new Error("The browser agent cannot submit a search to another site");
    }
    target.searchParams.set(submission.fieldName, query);
    return validateAgentNavigationUrl(target.toString());
};

export class KitesurfManager implements BrowserManager {
    readonly capabilities: BrowserCapabilities = {
        provider: "kitesurf",
        audio: false,
        video: false,
        agentic: true,
    };

    private readonly config: BrowserServiceConfig;
    private readonly fetchImpl: FetchLike;
    private readonly apiBaseUrl: string;
    private readonly sessions = new Map<string, KitesurfSession>();
    private readonly idleTimers = new Map<string, NodeJS.Timeout>();
    private readonly launchingRooms = new Set<string>();
    private readonly navigatingRooms = new Set<string>();

    constructor(
        config: Partial<BrowserServiceConfig> = {},
        fetchImpl: FetchLike = fetch,
    ) {
        this.config = { ...defaultConfig, ...config, provider: "kitesurf" };
        this.fetchImpl = fetchImpl;

        const accountId = this.config.cloudflareAccountId?.trim();
        const apiToken = this.config.cloudflareApiToken?.trim();
        if (!accountId || !apiToken) {
            throw new Error(
                "Kitesurf requires CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_BROWSER_RUN_TOKEN",
            );
        }

        this.apiBaseUrl = (
            this.config.cloudflareBrowserRunBaseUrl ||
            `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(accountId)}/browser-run`
        ).replace(/\/+$/, "");
    }

    private resetIdleTimer(roomId: string): void {
        const current = this.idleTimers.get(roomId);
        if (current) clearTimeout(current);
        const timer = setTimeout(() => {
            void this.closeBrowser(roomId);
        }, this.config.containerIdleTimeoutMs);
        this.idleTimers.set(roomId, timer);
    }

    private clearIdleTimer(roomId: string): void {
        const timer = this.idleTimers.get(roomId);
        if (timer) clearTimeout(timer);
        this.idleTimers.delete(roomId);
    }

    private async request(path: string, init: RequestInit): Promise<unknown> {
        const controller = new AbortController();
        const timeout = setTimeout(
            () => controller.abort(),
            this.config.cloudflareRequestTimeoutMs,
        );
        try {
            const response = await this.fetchImpl(`${this.apiBaseUrl}${path}`, {
                ...init,
                headers: {
                    Authorization: `Bearer ${this.config.cloudflareApiToken}`,
                    Accept: "application/json",
                    ...init.headers,
                },
                signal: controller.signal,
            });
            const payload = (await response.json().catch(() => null)) as unknown;
            if (!response.ok) {
                throw new CloudflareBrowserRunError(
                    readErrorMessage(
                        payload,
                        `Cloudflare Browser Run returned HTTP ${response.status}`,
                    ),
                    response.status,
                );
            }
            return unwrapResult(payload);
        } finally {
            clearTimeout(timeout);
        }
    }

    private sessionPath(sessionId: string): string {
        return `/devtools/browser/${encodeURIComponent(sessionId)}`;
    }

    private liveViewUrl(target: CloudflareTarget): string {
        if (!target.devtoolsFrontendUrl) {
            throw new Error("Cloudflare Browser Run did not return a Live View URL");
        }
        const url = new URL(target.devtoolsFrontendUrl);
        if (url.protocol !== "https:" || url.hostname !== "live.browser.run") {
            throw new Error("Cloudflare Browser Run returned an invalid Live View URL");
        }
        url.searchParams.set("mode", "tab");
        return url.toString();
    }

    private async createTarget(sessionId: string, url: string): Promise<CloudflareTarget> {
        const payload = await this.request(
            `${this.sessionPath(sessionId)}/json/new?url=${encodeURIComponent(url)}`,
            { method: "PUT" },
        );
        if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
            throw new Error("Cloudflare Browser Run returned an invalid target");
        }
        const target = payload as CloudflareTarget;
        if (!target.id) {
            throw new Error("Cloudflare Browser Run target is missing an id");
        }
        return target;
    }

    private async listTargets(sessionId: string): Promise<CloudflareTarget[]> {
        const payload = await this.request(`${this.sessionPath(sessionId)}/json/list`, {
            method: "GET",
        });
        if (!Array.isArray(payload)) {
            throw new Error("Cloudflare Browser Run returned an invalid target list");
        }
        return payload.filter(
            (target): target is CloudflareTarget =>
                typeof target === "object" && target !== null && !Array.isArray(target),
        );
    }

    private async closeTarget(sessionId: string, targetId: string): Promise<void> {
        await this.request(
            `${this.sessionPath(sessionId)}/json/close/${encodeURIComponent(targetId)}`,
            { method: "GET" },
        );
    }

    async checkHealth(): Promise<void> {
        const payload = await this.request("/devtools/session", { method: "GET" });
        if (!Array.isArray(payload)) {
            throw new Error("Cloudflare Browser Run returned an invalid session list");
        }
    }

    async launchBrowser(options: LaunchBrowserOptions): Promise<LaunchBrowserResult> {
        const { roomId, url, controllerUserId } = options;
        if (this.sessions.has(roomId) || this.launchingRooms.has(roomId)) {
            return { success: false, error: "Browser session already exists for this room" };
        }
        this.launchingRooms.add(roomId);

        let cloudflareSessionId: string | undefined;
        try {
            const payload = await this.request(
                `/devtools/browser?browser=kitesurf&keep_alive=${this.config.kitesurfKeepAliveMs}`,
                { method: "POST" },
            );
            if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
                throw new Error("Cloudflare Browser Run returned an invalid session");
            }
            const cloudflareSession = payload as CloudflareSession;
            cloudflareSessionId = cloudflareSession.sessionId;
            if (!cloudflareSessionId) {
                throw new Error("Cloudflare Browser Run session is missing an id");
            }
            if (!cloudflareSession.webSocketDebuggerUrl) {
                throw new Error("Cloudflare Browser Run session is missing a CDP endpoint");
            }

            const target = await this.createTarget(cloudflareSessionId, url);
            const session: KitesurfSession = {
                roomId,
                containerId: cloudflareSessionId,
                targetId: target.id!,
                webSocketDebuggerUrl: cloudflareSession.webSocketDebuggerUrl,
                noVncUrl: this.liveViewUrl(target),
                currentUrl: url,
                createdAt: new Date(),
                provider: "kitesurf",
                controllerUserId,
            };
            this.sessions.set(roomId, session);
            this.resetIdleTimer(roomId);
            return { success: true, session };
        } catch (error) {
            if (cloudflareSessionId) {
                await this.request(this.sessionPath(cloudflareSessionId), {
                    method: "DELETE",
                }).catch(() => undefined);
            }
            return {
                success: false,
                error: error instanceof Error ? error.message : "Failed to launch Kitesurf",
            };
        } finally {
            this.launchingRooms.delete(roomId);
        }
    }

    async navigateTo(options: NavigateOptions): Promise<LaunchBrowserResult> {
        const session = this.sessions.get(options.roomId);
        if (!session) {
            return { success: false, error: "No browser session found for this room" };
        }
        if (this.navigatingRooms.has(options.roomId)) {
            return { success: false, error: "Browser navigation is already in progress" };
        }
        this.navigatingRooms.add(options.roomId);
        let target: CloudflareTarget | undefined;
        try {
            target = await this.createTarget(session.containerId, options.url);
            if (this.sessions.get(options.roomId) !== session) {
                throw new Error("Browser session was closed or replaced during navigation");
            }
            const nextSession: KitesurfSession = {
                ...session,
                targetId: target.id!,
                noVncUrl: this.liveViewUrl(target),
                currentUrl: options.url,
            };
            this.sessions.set(options.roomId, nextSession);
            this.resetIdleTimer(options.roomId);
            await this.closeTarget(session.containerId, session.targetId).catch(() => undefined);
            return { success: true, session: nextSession };
        } catch (error) {
            if (target?.id) {
                await this.closeTarget(session.containerId, target.id).catch(() => undefined);
            }
            return {
                success: false,
                error: error instanceof Error ? error.message : "Failed to navigate Kitesurf",
            };
        } finally {
            this.navigatingRooms.delete(options.roomId);
        }
    }

    async closeBrowser(roomId: string): Promise<{ success: boolean; error?: string }> {
        const session = this.sessions.get(roomId);
        if (!session) {
            return { success: false, error: "No browser session found for this room" };
        }
        try {
            await this.request(this.sessionPath(session.containerId), { method: "DELETE" });
        } catch (error) {
            if (!(error instanceof CloudflareBrowserRunError) || error.status !== 404) {
                return {
                    success: false,
                    error: error instanceof Error ? error.message : "Failed to close Kitesurf",
                };
            }
        }
        this.clearIdleTimer(roomId);
        this.sessions.delete(roomId);
        return { success: true };
    }

    async getSession(roomId: string): Promise<BrowserSession | undefined> {
        for (;;) {
            const session = this.sessions.get(roomId);
            if (!session) return undefined;
            let targets: CloudflareTarget[];
            try {
                targets = await this.listTargets(session.containerId);
            } catch (error) {
                if (this.sessions.get(roomId) !== session) continue;
                if (!(error instanceof CloudflareBrowserRunError) || error.status !== 404) {
                    throw error;
                }
                this.clearIdleTimer(roomId);
                this.sessions.delete(roomId);
                return undefined;
            }
            if (this.sessions.get(roomId) !== session) continue;

            const target = targets.find((candidate) => candidate.id === session.targetId);
            if (!target) {
                this.clearIdleTimer(roomId);
                this.sessions.delete(roomId);
                return undefined;
            }
            session.noVncUrl = this.liveViewUrl(target);
            if (target.url) session.currentUrl = target.url;
            this.resetIdleTimer(roomId);
            return session;
        }
    }

    getAllSessions(): BrowserSession[] {
        return Array.from(this.sessions.values());
    }

    async markActivity(roomId: string): Promise<void> {
        if (!this.sessions.has(roomId)) return;
        await this.getSession(roomId);
    }

    private async withPage<T>(
        roomId: string,
        operation: (page: Page) => Promise<T>,
    ): Promise<T> {
        const session = this.sessions.get(roomId);
        if (!session) throw new Error("No browser session found for this room");

        let browser: Browser | undefined;
        try {
            browser = await puppeteer.connect({
                browserWSEndpoint: session.webSocketDebuggerUrl,
                headers: { Authorization: `Bearer ${this.config.cloudflareApiToken}` },
            });
            const pages = await browser.pages();
            const page =
                pages.find((candidate) => candidate.url() === session.currentUrl) ||
                [...pages].reverse().find((candidate) => candidate.url() !== "about:blank") ||
                pages.at(-1);
            if (!page) throw new Error("Kitesurf has no active page");
            const result = await operation(page);
            session.currentUrl = page.url() || session.currentUrl;
            this.resetIdleTimer(roomId);
            return result;
        } finally {
            await browser?.disconnect();
        }
    }

    async observeForAgent(roomId: string): Promise<BrowserAgentObservation> {
        return this.withPage(roomId, async (page) => {
            const observation = await page.evaluate(AGENT_OBSERVATION_SCRIPT);
            return observation as BrowserAgentObservation;
        });
    }

    async performAgentAction(roomId: string, action: BrowserAgentAction): Promise<void> {
        await this.withPage(roomId, async (page) => {
            const selectorFor = (elementId: string) =>
                `[data-conclave-agent-id="${elementId.replace(/[^a-zA-Z0-9_-]/g, "")}"]`;

            if (action.type === "navigate") {
                const target = validateAgentNavigationUrl(action.url);
                await page.goto(target.toString(), {
                    waitUntil: "domcontentloaded",
                    timeout: 20000,
                });
                return;
            }
            if (action.type === "click") {
                const selector = selectorFor(action.elementId);
                const element = await page.$(selector);
                if (!element) throw new Error("The selected page element is no longer available");
                const link = await page.evaluate(agentNavigationLinkScript(selector));
                const target = validateAgentNavigationLink(link);
                await page.goto(target.toString(), {
                    waitUntil: "domcontentloaded",
                    timeout: 20000,
                });
            } else if (action.type === "type") {
                const selector = selectorFor(action.elementId);
                const element = await page.$(selector);
                if (!element) throw new Error("The selected page element is no longer available");
                if (!action.submit) {
                    throw new Error("The browser agent cannot safely stage text without submitting");
                }
                const submission = await page.evaluate(agentSearchSubmissionScript(selector));
                const target = buildAgentSearchUrl(submission, action.text);
                await page.goto(target.toString(), {
                    waitUntil: "domcontentloaded",
                    timeout: 20000,
                });
            } else if (action.type === "scroll") {
                const sign = action.direction === "down" ? 1 : -1;
                await page.evaluate(
                    `window.scrollBy({ top: ${sign} * window.innerHeight * 0.75, behavior: "smooth" })`,
                );
            } else if (action.type === "wait") {
                const durationMs = Math.max(100, Math.min(action.durationMs ?? 800, 5000));
                await new Promise((resolve) => setTimeout(resolve, durationMs));
            }

            if (action.type !== "wait") {
                await new Promise((resolve) => setTimeout(resolve, 650));
            }
        });
    }

    async shutdown(): Promise<void> {
        await Promise.all(
            Array.from(this.sessions.keys()).map((roomId) => this.closeBrowser(roomId)),
        );
    }
}
