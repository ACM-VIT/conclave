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
}

export const defaultConfig: BrowserServiceConfig = {
    port: parseInt(process.env.BROWSER_SERVICE_PORT || "3040", 10),
    dockerImageName: process.env.BROWSER_IMAGE_NAME || "conclave-browser:latest",
    noVncPortStart: parseInt(process.env.NOVNC_PORT_START || "6080", 10),
    noVncPortEnd: parseInt(process.env.NOVNC_PORT_END || "6100", 10),
    hostAddress: process.env.BROWSER_HOST_ADDRESS || "localhost",
    publicBaseUrl:
        process.env.BROWSER_PUBLIC_BASE_URL ||
        process.env.BROWSER_PUBLIC_URL ||
        undefined,
    containerIdleTimeoutMs: parseInt(process.env.CONTAINER_IDLE_TIMEOUT || "1800000", 10), // 30 min default
};
