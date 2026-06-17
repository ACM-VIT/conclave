export interface BrowserSession {
    roomId: string;
    containerId: string;
    noVncUrl: string;
    currentUrl: string;
    createdAt: Date;
    controllerUserId?: string;
    audioTarget?: AudioTarget;
    videoTarget?: VideoTarget;
}

export interface AudioTarget {
    ip: string;
    port: number;
    rtcpPort: number;
    payloadType: number;
    ssrc: number;
}

export type VideoTarget = AudioTarget;

export interface LaunchBrowserOptions {
    roomId: string;
    url: string;
    controllerUserId?: string;
    audioTarget?: AudioTarget | null;
    videoTarget?: VideoTarget | null;
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
    videoTarget?: VideoTarget | null;
}

export interface BrowserServiceConfig {
    port: number;
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

export const defaultConfig: BrowserServiceConfig = {
    port: servicePort,
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
};
