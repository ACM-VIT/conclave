import express, { type Express } from "express";
import cors from "cors";
import { ContainerManager } from "./ContainerManager.js";
import { defaultConfig, type AudioTarget } from "./types.js";

const app: Express = express();
const containerManager = new ContainerManager();

// Express types `req.body` as `any`; narrow it once at the boundary so every
// field is validated before it reaches the container manager.
const requestBody = (req: { body?: unknown }): Record<string, unknown> =>
    typeof req.body === "object" && req.body !== null && !Array.isArray(req.body)
        ? (req.body as Record<string, unknown>)
        : {};

const readString = (record: Record<string, unknown>, key: string): string | undefined => {
    const value = record[key];
    return typeof value === "string" && value ? value : undefined;
};

/** Decode an RTP forward target ({ip, port, rtcpPort, payloadType, ssrc}). */
const readRtpTarget = (record: Record<string, unknown>, key: string): AudioTarget | undefined => {
    const value = record[key];
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        return undefined;
    }
    const target = value as Record<string, unknown>;
    const { ip, port, rtcpPort, payloadType, ssrc } = target;
    if (
        typeof ip !== "string" ||
        typeof port !== "number" ||
        typeof rtcpPort !== "number" ||
        typeof payloadType !== "number" ||
        typeof ssrc !== "number"
    ) {
        return undefined;
    }
    return { ip, port, rtcpPort, payloadType, ssrc };
};

app.use(cors());
app.use(express.json());

app.use((req, res, next) => {
    const expectedToken = defaultConfig.serviceToken;
    if (!expectedToken) {
        next();
        return;
    }

    if (req.path === "/health" || req.path === "/health/") {
        next();
        return;
    }

    const tokenFromHeader = req.headers["x-browser-service-token"];
    const headerToken = Array.isArray(tokenFromHeader) ? tokenFromHeader[0] : tokenFromHeader;
    const authHeader = req.headers.authorization;
    const bearerToken = authHeader?.startsWith("Bearer ")
        ? authHeader.slice("Bearer ".length)
        : undefined;

    if (headerToken === expectedToken || bearerToken === expectedToken) {
        next();
        return;
    }

    res.status(401).json({ error: "Unauthorized" });
});

app.get("/health", (_req, res) => {
    res.json({ status: "ok", sessions: containerManager.getAllSessions().length });
});

app.get("/sessions", (_req, res) => {
    const sessions = containerManager.getAllSessions();
    res.json({ sessions });
});

app.get("/sessions/:roomId", (req, res) => {
    const session = containerManager.getSession(req.params.roomId);
    if (session) {
        res.json({ session });
    } else {
        res.status(404).json({ error: "Session not found" });
    }
});

/**
 * RTP targets are optional, but a present-and-malformed one must fail loudly:
 * silently dropping it would "successfully" launch a browser that forwards no
 * audio/video.
 */
const decodeRtpTargets = (
    body: Record<string, unknown>,
):
    | { ok: true; audioTarget?: AudioTarget; videoTarget?: AudioTarget }
    | { ok: false; error: string } => {
    const audioTarget = readRtpTarget(body, "audioTarget");
    if (body.audioTarget !== undefined && !audioTarget) {
        return { ok: false, error: "Invalid audioTarget" };
    }
    const videoTarget = readRtpTarget(body, "videoTarget");
    if (body.videoTarget !== undefined && !videoTarget) {
        return { ok: false, error: "Invalid videoTarget" };
    }
    return { ok: true, audioTarget, videoTarget };
};

app.post("/launch", async (req, res) => {
    const body = requestBody(req);
    const roomId = readString(body, "roomId");
    const url = readString(body, "url");

    if (!roomId || !url) {
        res.status(400).json({ error: "roomId and url are required" });
        return;
    }

    const targets = decodeRtpTargets(body);
    if (!targets.ok) {
        res.status(400).json({ error: targets.error });
        return;
    }

    const result = await containerManager.launchBrowser({
        roomId,
        url,
        controllerUserId: readString(body, "controllerUserId"),
        audioTarget: targets.audioTarget,
        videoTarget: targets.videoTarget,
    });

    if (result.success) {
        res.json(result);
    } else {
        res.status(400).json(result);
    }
});

app.post("/navigate", async (req, res) => {
    const body = requestBody(req);
    const roomId = readString(body, "roomId");
    const url = readString(body, "url");

    if (!roomId || !url) {
        res.status(400).json({ error: "roomId and url are required" });
        return;
    }

    const targets = decodeRtpTargets(body);
    if (!targets.ok) {
        res.status(400).json({ error: targets.error });
        return;
    }

    const result = await containerManager.navigateTo({
        roomId,
        url,
        audioTarget: targets.audioTarget,
        videoTarget: targets.videoTarget,
    });

    if (result.success) {
        res.json(result);
    } else {
        res.status(400).json(result);
    }
});

app.post("/close", async (req, res) => {
    const roomId = readString(requestBody(req), "roomId");

    if (!roomId) {
        res.status(400).json({ error: "roomId is required" });
        return;
    }

    const result = await containerManager.closeBrowser(roomId);

    if (result.success) {
        res.json(result);
    } else {
        res.status(400).json(result);
    }
});

app.post("/activity", (req, res) => {
    const roomId = readString(requestBody(req), "roomId");

    if (!roomId) {
        res.status(400).json({ error: "roomId is required" });
        return;
    }

    containerManager.markActivity(roomId);
    res.json({ success: true });
});

let isShuttingDown = false;

const gracefulShutdown = async () => {
    if (isShuttingDown) {
        return;
    }
    isShuttingDown = true;

    console.log("\n[Server] Received shutdown signal, cleaning up...");
    try {
        await containerManager.shutdown();
        process.exit(0);
    } catch (error) {
        console.error("[Server] Failed to clean up browser sessions:", error);
        process.exit(1);
    }
};

process.on("SIGTERM", () => void gracefulShutdown());
process.on("SIGINT", () => void gracefulShutdown());

const port = defaultConfig.port;
app.listen(port, "0.0.0.0", () => {
    console.log(`[Server] Shared Browser Service running on port ${port}`);
    console.log(`[Server] noVNC port range: ${defaultConfig.noVncPortStart}-${defaultConfig.noVncPortEnd}`);
});

export { app, containerManager };
