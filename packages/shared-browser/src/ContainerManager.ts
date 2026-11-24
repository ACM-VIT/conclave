import Docker from "dockerode";
import { randomInt, randomUUID } from "node:crypto";
import type {
    BrowserCapabilities,
    BrowserManager,
    BrowserServiceConfig,
    BrowserSession,
    LaunchBrowserOptions,
    LaunchBrowserResult,
    NavigateOptions,
} from "./types.js";
import { defaultConfig } from "./types.js";

export const VNC_AUTH_IMAGE_LABEL = "org.conclave.browser.vnc-auth";
export const VNC_AUTH_IMAGE_LABEL_VALUE = "per-session-password";

export class ContainerManager implements BrowserManager {
    readonly capabilities: BrowserCapabilities = {
        provider: "chromium",
        audio: true,
        video: true,
        agentic: false,
    };
    private docker: Docker;
    private config: BrowserServiceConfig;
    private sessions: Map<string, BrowserSession> = new Map();
    private usedPorts: Set<number> = new Set();
    private idleTimers: Map<string, NodeJS.Timeout> = new Map();

    constructor(config: Partial<BrowserServiceConfig> = {}, docker: Docker = new Docker()) {
        this.config = { ...defaultConfig, ...config };
        this.docker = docker;
    }

    private sanitizeContainerName(roomId: string): string {
        return roomId.replace(/[^a-zA-Z0-9_.-]/g, "-");
    }

    private isLoopbackTarget(ip: string): boolean {
        return (
            ip === "127.0.0.1" ||
            ip === "0.0.0.0" ||
            ip === "::1" ||
            ip === "localhost"
        );
    }

    private resolveRtpTargetIp(kind: "audio" | "video", ip: string): string {
        const overrideHost =
            kind === "audio"
                ? this.config.audioTargetHost || this.config.rtpTargetHost
                : this.config.videoTargetHost ||
                    this.config.rtpTargetHost ||
                    this.config.audioTargetHost;

        if (overrideHost) {
            return overrideHost;
        }

        if (this.isLoopbackTarget(ip)) {
            return "host.docker.internal";
        }

        return ip;
    }

    private getAvailablePort(): number | null {
        for (let port = this.config.noVncPortStart; port <= this.config.noVncPortEnd; port++) {
            if (!this.usedPorts.has(port)) {
                this.usedPorts.add(port);
                return port;
            }
        }
        return null;
    }

    private releasePort(port: number): void {
        this.usedPorts.delete(port);
    }

    private getPortFromUrl(url: string): number | null {
        try {
            const parsed = new URL(url);
            const pathMatch = parsed.pathname.match(/\/novnc\/(\d+)(?:\/|$)/);
            if (pathMatch) {
                return parseInt(pathMatch[1], 10);
            }
            return parsed.port ? parseInt(parsed.port, 10) : null;
        } catch {
            const pathMatch = url.match(/\/novnc\/(\d+)(?:\/|$)/);
            if (pathMatch) {
                return parseInt(pathMatch[1], 10);
            }
            const match = url.match(/:(\d+)/);
            return match ? parseInt(match[1], 10) : null;
        }
    }

    /**
     * VNC authentication reads only the first 8 password characters. A fresh
     * random one per session (about 47 bits) means a participant of one room
     * cannot open another room's display.
     */
    private createVncPassword(): string {
        const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
        return Array.from({ length: 8 }, () => alphabet[randomInt(alphabet.length)]).join("");
    }

    /**
     * The password travels in the URL fragment, which browsers never send to a
     * server or proxy log. noVNC's vnc_lite.html only matches `[?&]password=`,
     * so the fragment starts with `&`.
     */
    private buildNoVncUrl(port: number, vncPassword: string, sessionId: string): string {
        const params = new URLSearchParams({
            session: sessionId,
            autoconnect: "true",
            resize: "scale",
            reconnect: "true",
            show_control_bar: "0",
            show_dot: "0",
            path: this.config.publicBaseUrl
                ? `novnc/${port}/websockify`
                : "websockify",
        }).toString();
        const fragment = `&${new URLSearchParams({ password: vncPassword })}`;
        if (this.config.publicBaseUrl) {
            const base = this.config.publicBaseUrl.replace(/\/+$/, "");
            return `${base}/novnc/${port}/vnc_lite.html?${params}#${fragment}`;
        }
        return `http://${this.config.hostAddress}:${port}/vnc_lite.html?${params}#${fragment}`;
    }

    private resetIdleTimer(roomId: string): void {
        const existingTimer = this.idleTimers.get(roomId);
        if (existingTimer) {
            clearTimeout(existingTimer);
        }

        const timer = setTimeout(() => {
            console.log(`[ContainerManager] Session ${roomId} timed out due to inactivity`);
            this.closeBrowser(roomId).catch(console.error);
        }, this.config.containerIdleTimeoutMs);

        this.idleTimers.set(roomId, timer);
    }

    private clearIdleTimer(roomId: string): void {
        const timer = this.idleTimers.get(roomId);
        if (timer) {
            clearTimeout(timer);
            this.idleTimers.delete(roomId);
        }
    }

    private async verifyImage(): Promise<void> {
        const name = this.config.dockerImageName;
        let labels: Record<string, string> | undefined;
        try {
            labels = (await this.docker.getImage(name).inspect()).Config?.Labels ?? undefined;
        } catch (error) {
            const reason = error instanceof Error ? error.message : String(error);
            throw new Error(`The browser image ${name} could not be inspected (${reason}), so it is not known to enforce a per-session VNC password.`);
        }
        if (labels?.[VNC_AUTH_IMAGE_LABEL] !== VNC_AUTH_IMAGE_LABEL_VALUE) {
            throw new Error(
                `The browser image ${name} is not known to enforce a per-session VNC password: it lacks the ${VNC_AUTH_IMAGE_LABEL}=${VNC_AUTH_IMAGE_LABEL_VALUE} label. Rebuild it from packages/shared-browser/docker, or deploy without --skip-runtime-image.`,
            );
        }
    }

    async assertReady(): Promise<void> {
        await this.verifyImage();
    }

    async checkHealth(): Promise<void> {
        await this.docker.ping();
        await this.verifyImage();
    }

    async launchBrowser(options: LaunchBrowserOptions): Promise<LaunchBrowserResult> {
        const { roomId, url, controllerUserId, audioTarget, videoTarget } = options;

        if (this.sessions.has(roomId)) {
            return {
                success: false,
                error: "Browser session already exists for this room",
            };
        }

        try {
            await this.verifyImage();
        } catch (error) {
            return { success: false, error: error instanceof Error ? error.message : String(error) };
        }

        const port = this.getAvailablePort();
        if (!port) {
            return {
                success: false,
                error: "No available ports for browser sessions",
            };
        }

        let container: Docker.Container | null = null;

        try {
            const containerName = `conclave-browser-${this.sanitizeContainerName(roomId)}`;

            try {
                const existingContainer = this.docker.getContainer(containerName);
                await existingContainer.remove({ force: true });
            } catch {
            }

            const vncPassword = this.createVncPassword();
            const containerEnv = [
                `START_URL=${url}`,
                "RESOLUTION=1280x720x24",
                `VNC_PASSWORD=${vncPassword}`,
            ];

            if (audioTarget?.ip && audioTarget?.port) {
                const targetIp = this.resolveRtpTargetIp("audio", audioTarget.ip);
                containerEnv.push(`AUDIO_TARGET_IP=${targetIp}`);
                containerEnv.push(`AUDIO_TARGET_PORT=${audioTarget.port}`);
                containerEnv.push(`AUDIO_RTCP_PORT=${audioTarget.rtcpPort}`);
                containerEnv.push(`AUDIO_PAYLOAD_TYPE=${audioTarget.payloadType}`);
                containerEnv.push(`AUDIO_SSRC=${audioTarget.ssrc}`);
            }

            if (videoTarget?.ip && videoTarget?.port) {
                const targetIp = this.resolveRtpTargetIp("video", videoTarget.ip);
                containerEnv.push(`VIDEO_TARGET_IP=${targetIp}`);
                containerEnv.push(`VIDEO_TARGET_PORT=${videoTarget.port}`);
                containerEnv.push(`VIDEO_RTCP_PORT=${videoTarget.rtcpPort}`);
                containerEnv.push(`VIDEO_PAYLOAD_TYPE=${videoTarget.payloadType}`);
                containerEnv.push(`VIDEO_SSRC=${videoTarget.ssrc}`);
            }

            container = await this.docker.createContainer({
                Image: this.config.dockerImageName,
                name: containerName,
                Env: containerEnv,
                HostConfig: {
                    PortBindings: {
                        "6080/tcp": [{ HostIp: this.config.noVncBindAddress, HostPort: port.toString() }],
                    },
                    AutoRemove: true,
                    ExtraHosts: ["host.docker.internal:host-gateway"],
                    CapAdd: ["SYS_ADMIN"],
                    SecurityOpt: ["seccomp=unconfined"],
                },
                ExposedPorts: {
                    "6080/tcp": {},
                },
            });

            await container.start();

            const noVncUrl = this.buildNoVncUrl(port, vncPassword, randomUUID());

            const session: BrowserSession = {
                roomId,
                containerId: container.id,
                noVncUrl,
                currentUrl: url,
                createdAt: new Date(),
                provider: "chromium",
                controllerUserId,
                audioTarget: audioTarget ?? undefined,
                videoTarget: videoTarget ?? undefined,
            };

            this.sessions.set(roomId, session);
            this.resetIdleTimer(roomId);

            console.log(`[ContainerManager] Launched browser for room ${roomId} on port ${port}`);

            return {
                success: true,
                session,
            };
        } catch (error) {
            this.releasePort(port);
            if (container) {
                await container.remove({ force: true }).catch(() => {
                });
            }
            console.error(`[ContainerManager] Failed to launch browser for room ${roomId}:`, error);
            return {
                success: false,
                error: error instanceof Error ? error.message : "Failed to launch browser",
            };
        }
    }

    async navigateTo(options: NavigateOptions): Promise<LaunchBrowserResult> {
        const { roomId, url, audioTarget, videoTarget } = options;
        const session = this.sessions.get(roomId);

        if (!session) {
            return {
                success: false,
                error: "No browser session found for this room",
            };
        }

        const controllerUserId = session.controllerUserId;

        await this.closeBrowser(roomId);
        return this.launchBrowser({ roomId, url, controllerUserId, audioTarget, videoTarget });
    }

    async closeBrowser(roomId: string): Promise<{ success: boolean; error?: string }> {
        const session = this.sessions.get(roomId);

        if (!session) {
            return {
                success: false,
                error: "No browser session found for this room",
            };
        }

        try {
            const container = this.docker.getContainer(session.containerId);

            await container.stop().catch(() => {
            });

            const port = this.getPortFromUrl(session.noVncUrl);
            if (port) {
                this.releasePort(port);
            }

            this.clearIdleTimer(roomId);
            this.sessions.delete(roomId);

            console.log(`[ContainerManager] Closed browser for room ${roomId}`);

            return { success: true };
        } catch (error) {
            console.error(`[ContainerManager] Failed to close browser for room ${roomId}:`, error);
            return {
                success: false,
                error: error instanceof Error ? error.message : "Failed to close browser",
            };
        }
    }

    async getSession(roomId: string): Promise<BrowserSession | undefined> {
        const session = this.sessions.get(roomId);
        if (session) {
            this.resetIdleTimer(roomId);
        }
        return session;
    }

    getAllSessions(): BrowserSession[] {
        return Array.from(this.sessions.values());
    }

    async markActivity(roomId: string): Promise<void> {
        if (this.sessions.has(roomId)) {
            this.resetIdleTimer(roomId);
        }
    }

    async shutdown(): Promise<void> {
        console.log("[ContainerManager] Shutting down all browser sessions...");

        const closePromises = Array.from(this.sessions.keys()).map((roomId) =>
            this.closeBrowser(roomId)
        );

        await Promise.all(closePromises);
        console.log("[ContainerManager] All sessions closed");
    }
}
