import express, { type Express } from "express";
import cors from "cors";
import { ContainerManager } from "./ContainerManager.js";
import { defaultConfig } from "./types.js";

const app: Express = express();
const containerManager = new ContainerManager();

app.use(cors());
app.use(express.json());

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

app.post("/launch", async (req, res) => {
    const { roomId, url, controllerUserId, audioTarget, videoTarget } = req.body;

    if (!roomId || !url) {
        res.status(400).json({ error: "roomId and url are required" });
        return;
    }

    const result = await containerManager.launchBrowser({
        roomId,
        url,
        controllerUserId,
        audioTarget,
        videoTarget,
    });

    if (result.success) {
        res.json(result);
    } else {
        res.status(400).json(result);
    }
});

app.post("/navigate", async (req, res) => {
    const { roomId, url, audioTarget, videoTarget } = req.body;

    if (!roomId || !url) {
        res.status(400).json({ error: "roomId and url are required" });
        return;
    }

    const result = await containerManager.navigateTo({ roomId, url, audioTarget, videoTarget });

    if (result.success) {
        res.json(result);
    } else {
        res.status(400).json(result);
    }
});

app.post("/close", async (req, res) => {
    const { roomId } = req.body;

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
    const { roomId } = req.body;

    if (!roomId) {
        res.status(400).json({ error: "roomId is required" });
        return;
    }

    containerManager.markActivity(roomId);
    res.json({ success: true });
});

const gracefulShutdown = async () => {
    console.log("\n[Server] Received shutdown signal, cleaning up...");
    await containerManager.shutdown();
    process.exit(0);
};

process.on("SIGTERM", gracefulShutdown);
process.on("SIGINT", gracefulShutdown);

const port = defaultConfig.port;
app.listen(port, () => {
    console.log(`[Server] Shared Browser Service running on port ${port}`);
    console.log(`[Server] noVNC port range: ${defaultConfig.noVncPortStart}-${defaultConfig.noVncPortEnd}`);
});

export { app, containerManager };
