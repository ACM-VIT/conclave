export type BrowserProvider = "chromium" | "kitesurf";

export interface BrowserCapabilities {
    provider: BrowserProvider;
    audio: boolean;
    video: boolean;
    agentic: boolean;
}

export interface BrowserAgentElement {
    id: string;
    tag: string;
    role?: string;
    text?: string;
    label?: string;
    href?: string;
    inputType?: string;
    formMethod?: string;
    isSearchForm?: boolean;
}

export interface BrowserAgentObservation {
    url: string;
    title: string;
    text: string;
    elements: BrowserAgentElement[];
}

export type BrowserAgentAction =
    | { type: "click"; elementId: string }
    | { type: "type"; elementId: string; text: string; submit?: boolean }
    | { type: "scroll"; direction: "up" | "down" }
    | { type: "navigate"; url: string }
    | { type: "wait"; durationMs?: number };

export interface BrowserSession {
    roomId: string;
    containerId: string;
    noVncUrl: string;
    currentUrl: string;
    createdAt: Date;
    provider: BrowserProvider;
    controllerUserId?: string;
    audioTarget?: AudioTarget;
    videoTarget?: AudioTarget;
}

export interface AudioTarget {
    ip: string;
    port: number;
    rtcpPort: number;
    payloadType: number;
    ssrc: number;
}

export interface LaunchBrowserOptions {
    roomId: string;
    url: string;
    controllerUserId?: string;
    audioTarget?: AudioTarget | null;
    videoTarget?: AudioTarget | null;
}

export interface LaunchBrowserResult {
    success: boolean;
    session?: BrowserSession;
    error?: string;
}

export interface NavigateOptions {
    roomId: string;
    url: string;
    audioTarget?: AudioTarget | null;
    videoTarget?: AudioTarget | null;
}

export interface BrowserServiceConfig {
    port: number;
    provider: BrowserProvider;
    dockerImageName: string;
    noVncPortStart: number;
    noVncPortEnd: number;
    hostAddress: string;
    publicBaseUrl?: string;
    containerIdleTimeoutMs: number;
    rtpTargetHost?: string;
    audioTargetHost?: string;
    videoTargetHost?: string;
    serviceToken?: string;
    cloudflareAccountId?: string;
    cloudflareApiToken?: string;
    cloudflareBrowserRunBaseUrl?: string;
    cloudflareRequestTimeoutMs: number;
    kitesurfKeepAliveMs: number;
    kitesurfViewportWidth: number;
    kitesurfViewportHeight: number;
}

export interface BrowserManager {
    readonly capabilities: BrowserCapabilities;
    checkHealth(): Promise<void>;
    launchBrowser(options: LaunchBrowserOptions): Promise<LaunchBrowserResult>;
    navigateTo(options: NavigateOptions): Promise<LaunchBrowserResult>;
    closeBrowser(roomId: string): Promise<{ success: boolean; error?: string }>;
    getSession(roomId: string): Promise<BrowserSession | undefined>;
    getAllSessions(): BrowserSession[];
    markActivity(roomId: string): Promise<void>;
    observeForAgent?(roomId: string): Promise<BrowserAgentObservation>;
    performAgentAction?(roomId: string, action: BrowserAgentAction): Promise<void>;
    shutdown(): Promise<void>;
}

type IntegerEnvOptions = {
    min?: number;
    max?: number;
};

const parseIntegerEnv = (
    name: string,
    fallback: number,
    options: IntegerEnvOptions = {},
): number => {
    const rawValue = process.env[name]?.trim();
    if (!rawValue) {
        return fallback;
    }

    const value = Number(rawValue);
    const { min, max } = options;
    if (
        !Number.isInteger(value) ||
        (typeof min === "number" && value < min) ||
        (typeof max === "number" && value > max)
    ) {
        console.warn(
            `[Config] Ignoring invalid ${name}=${JSON.stringify(rawValue)}; using ${fallback}`,
        );
        return fallback;
    }

    return value;
};

const servicePort = parseIntegerEnv("BROWSER_SERVICE_PORT", 3040, {
    min: 1,
    max: 65535,
});
const noVncPortStart = parseIntegerEnv("NOVNC_PORT_START", 6080, {
    min: 1,
    max: 65535,
});
const parsedNoVncPortEnd = parseIntegerEnv("NOVNC_PORT_END", 6100, {
    min: 1,
    max: 65535,
});
const noVncPortEnd =
    parsedNoVncPortEnd >= noVncPortStart
        ? parsedNoVncPortEnd
        : noVncPortStart;
if (parsedNoVncPortEnd < noVncPortStart) {
    console.warn(
        `[Config] NOVNC_PORT_END is lower than NOVNC_PORT_START; using ${noVncPortEnd}`,
    );
}

const parseBrowserProvider = (): BrowserProvider => {
    const value = process.env.BROWSER_PROVIDER?.trim().toLowerCase();
    if (!value || value === "chromium") {
        return "chromium";
    }
    if (value === "kitesurf") {
        return "kitesurf";
    }
    console.warn(
        `[Config] Ignoring invalid BROWSER_PROVIDER=${JSON.stringify(value)}; using chromium`,
    );
    return "chromium";
};

export const defaultConfig: BrowserServiceConfig = {
    port: servicePort,
    provider: parseBrowserProvider(),
    dockerImageName: process.env.BROWSER_IMAGE_NAME || "conclave-browser:latest",
    noVncPortStart,
    noVncPortEnd,
    hostAddress: process.env.BROWSER_HOST_ADDRESS || "localhost",
    publicBaseUrl:
        process.env.BROWSER_PUBLIC_BASE_URL ||
        process.env.BROWSER_PUBLIC_URL ||
        undefined,
    containerIdleTimeoutMs: parseIntegerEnv("CONTAINER_IDLE_TIMEOUT", 1800000, {
        min: 1000,
    }),
    rtpTargetHost: process.env.BROWSER_RTP_TARGET_HOST || process.env.SFU_HOST || undefined,
    audioTargetHost:
        process.env.BROWSER_AUDIO_TARGET_HOST ||
        process.env.BROWSER_RTP_TARGET_HOST ||
        process.env.SFU_HOST ||
        undefined,
    videoTargetHost:
        process.env.BROWSER_VIDEO_TARGET_HOST ||
        process.env.BROWSER_RTP_TARGET_HOST ||
        process.env.BROWSER_AUDIO_TARGET_HOST ||
        process.env.SFU_HOST ||
        undefined,
    serviceToken: process.env.BROWSER_SERVICE_TOKEN || undefined,
    cloudflareAccountId: process.env.CLOUDFLARE_ACCOUNT_ID || undefined,
    cloudflareApiToken:
        process.env.CLOUDFLARE_BROWSER_RUN_TOKEN ||
        process.env.CLOUDFLARE_API_TOKEN ||
        undefined,
    cloudflareBrowserRunBaseUrl:
        process.env.CLOUDFLARE_BROWSER_RUN_BASE_URL || undefined,
    cloudflareRequestTimeoutMs: parseIntegerEnv(
        "CLOUDFLARE_BROWSER_RUN_TIMEOUT_MS",
        15000,
        { min: 1000, max: 120000 },
    ),
    kitesurfKeepAliveMs: parseIntegerEnv("KITESURF_KEEP_ALIVE_MS", 600000, {
        min: 60000,
        max: 600000,
    }),
    kitesurfViewportWidth: parseIntegerEnv("KITESURF_VIEWPORT_WIDTH", 1920, {
        min: 800,
        max: 3840,
    }),
    kitesurfViewportHeight: parseIntegerEnv("KITESURF_VIEWPORT_HEIGHT", 1080, {
        min: 600,
        max: 2160,
    }),
};
