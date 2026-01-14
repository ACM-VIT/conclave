import Docker from "dockerode";
import type {
    BrowserServiceConfig,
    BrowserSession,
    LaunchBrowserOptions,
    LaunchBrowserResult,
    NavigateOptions,
} from "./types.js";
import { defaultConfig } from "./types.js";

export class ContainerManager {
    private docker: Docker;
    private config: BrowserServiceConfig;
    private sessions: Map<string, BrowserSession> = new Map();
    private usedPorts: Set<number> = new Set();
    private idleTimers: Map<string, NodeJS.Timeout> = new Map();

    constructor(config: Partial<BrowserServiceConfig> = {}) {
        this.config = { ...defaultConfig, ...config };
        this.docker = new Docker();
    }

    private sanitizeContainerName(roomId: string): string {
        return roomId.replace(/[^a-zA-Z0-9_.-]/g, "-");
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
            if (parsed.port) {
                return parseInt(parsed.port, 10);
            }
            const pathMatch = parsed.pathname.match(/\/novnc\/(\d+)\//);
            return pathMatch ? parseInt(pathMatch[1], 10) : null;
        } catch {
            const match = url.match(/:(\d+)/);
            if (match) {
                return parseInt(match[1], 10);
            }
            const pathMatch = url.match(/\/novnc\/(\d+)\//);
            return pathMatch ? parseInt(pathMatch[1], 10) : null;
        }
    }

    private buildNoVncUrl(port: number): string {
        const params = new URLSearchParams({
            autoconnect: "true",
            resize: "scale",
            reconnect: "true",
            show_control_bar: "0",
            show_dot: "0",
            path: this.config.publicBaseUrl
                ? `novnc/${port}/websockify`
                : "websockify",
        }).toString();
        if (this.config.publicBaseUrl) {
            const base = this.config.publicBaseUrl.replace(/\/+$/, "");
            return `${base}/novnc/${port}/vnc_lite.html?${params}`;
        }
        return `http://${this.config.hostAddress}:${port}/vnc_lite.html?${params}`;
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

    async launchBrowser(options: LaunchBrowserOptions): Promise<LaunchBrowserResult> {
        const { roomId, url, controllerUserId, audioTarget } = options;

        if (this.sessions.has(roomId)) {
            return {
                success: false,
                error: "Browser session already exists for this room",
            };
        }

        const port = this.getAvailablePort();
        if (!port) {
            return {
                success: false,
                error: "No available ports for browser sessions",
            };
        }

        try {
            const containerName = `conclave-browser-${this.sanitizeContainerName(roomId)}`;
            const containerEnv = [
                `START_URL=${url}`,
                "RESOLUTION=1280x720x24",
            ];

            if (audioTarget?.ip && audioTarget?.port) {
                const isLoopback =
                    audioTarget.ip === "127.0.0.1" ||
                    audioTarget.ip === "0.0.0.0" ||
                    audioTarget.ip === "::1" ||
                    audioTarget.ip === "localhost";
                const overrideHost = process.env.BROWSER_AUDIO_TARGET_HOST;
                const targetIp = overrideHost || (isLoopback ? "host.docker.internal" : audioTarget.ip);
                containerEnv.push(`AUDIO_TARGET_IP=${targetIp}`);
                containerEnv.push(`AUDIO_TARGET_PORT=${audioTarget.port}`);
                containerEnv.push(`AUDIO_PAYLOAD_TYPE=${audioTarget.payloadType}`);
                containerEnv.push(`AUDIO_SSRC=${audioTarget.ssrc}`);
            }

            const container = await this.docker.createContainer({
                Image: this.config.dockerImageName,
                name: containerName,
                Env: containerEnv,
                HostConfig: {
                    PortBindings: {
                        "6080/tcp": [{ HostPort: port.toString() }],
                    },
                    AutoRemove: true,
                    ExtraHosts: ["host.docker.internal:host-gateway"],
                },
                ExposedPorts: {
                    "6080/tcp": {},
                },
            });

            await container.start();

            const noVncUrl = this.buildNoVncUrl(port);

            const session: BrowserSession = {
                roomId,
                containerId: container.id,
                noVncUrl,
                currentUrl: url,
                createdAt: new Date(),
                controllerUserId,
                audioTarget: audioTarget ?? undefined,
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
            console.error(`[ContainerManager] Failed to launch browser for room ${roomId}:`, error);
            return {
                success: false,
                error: error instanceof Error ? error.message : "Failed to launch browser",
            };
        }
    }

    async navigateTo(options: NavigateOptions): Promise<LaunchBrowserResult> {
        const { roomId, url, audioTarget } = options;
        const session = this.sessions.get(roomId);

        if (!session) {
            return {
                success: false,
                error: "No browser session found for this room",
            };
        }

        const controllerUserId = session.controllerUserId;

        await this.closeBrowser(roomId);
        return this.launchBrowser({ roomId, url, controllerUserId, audioTarget });
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

    getSession(roomId: string): BrowserSession | undefined {
        const session = this.sessions.get(roomId);
        if (session) {
            this.resetIdleTimer(roomId);
        }
        return session;
    }

    getAllSessions(): BrowserSession[] {
        return Array.from(this.sessions.values());
    }

    markActivity(roomId: string): void {
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
