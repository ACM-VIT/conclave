import cors from "cors";
import express from "express";
import type { Express, Request } from "express";
import { config as defaultConfig } from "../../config/config.js";
import { Logger } from "../../utilities/loggers.js";
import type { SfuState } from "../state.js";
import {
  getRoomChannelId,
  popCachedMinutes,
  popCachedTranscript,
} from "../rooms.js";
import { stopRoomTranscriber } from "../recording/roomTranscriber.js";
import { summarizeTranscript } from "../recording/summarizeTranscript.js";
import { buildMinutesPdf } from "../recording/minutesPdf.js";

export type CreateSfuAppOptions = {
  state: SfuState;
  config?: typeof defaultConfig;
};

const hasValidSecret = (req: Request, secret: string): boolean => {
  const provided = req.header("x-sfu-secret");
  return Boolean(provided && provided === secret);
};

export const createSfuApp = ({
  state,
  config = defaultConfig,
}: CreateSfuAppOptions): Express => {
  const app = express();
  app.use(cors());
  app.use(express.json());

  app.get("/health", (_req, res) => {
    const healthyWorkers = state.workers.filter((worker) => !worker.closed);
    const isHealthy = healthyWorkers.length > 0;

    const healthData = {
      status: isHealthy ? "healthy" : "unhealthy",
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
      port: config.port,
      workers: {
        total: state.workers.length,
        healthy: healthyWorkers.length,
        closed: state.workers.length - healthyWorkers.length,
      },
    };

    if (!isHealthy) {
      Logger.error("Health check failed: No healthy workers available");
      return res.status(503).json(healthData);
    }

    res.json(healthData);
  });

  app.get("/rooms", (req, res) => {
    if (!hasValidSecret(req, config.sfuSecret)) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const clientId = req.header("x-sfu-client") || "default";
    const roomDetails = Array.from(state.rooms.values())
      .filter((room) => room.clientId === clientId)
      .map((room) => ({
        id: room.id,
        clients: room.clientCount,
      }));

    return res.json({ rooms: roomDetails });
  });

  app.get("/status", (req, res) => {
    if (!hasValidSecret(req, config.sfuSecret)) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    return res.json({
      instanceId: config.instanceId,
      version: config.version,
      draining: state.isDraining,
      rooms: state.rooms.size,
      uptime: process.uptime(),
    });
  });

  app.post("/drain", (req, res) => {
    if (!hasValidSecret(req, config.sfuSecret)) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const { draining } = req.body ?? {};
    if (typeof draining !== "boolean") {
      return res.status(400).json({ error: "Invalid draining flag" });
    }

    state.isDraining = draining;
    Logger.info(`Draining mode ${state.isDraining ? "enabled" : "disabled"}`);
    return res.json({ draining: state.isDraining });
  });

  app.post("/minutes", async (req, res) => {
    if (!hasValidSecret(req, config.sfuSecret)) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const { roomId, clientId = "default" } = req.body ?? {};
    if (!roomId || typeof roomId !== "string") {
      return res.status(400).json({ error: "roomId required" });
    }

    const channelId = getRoomChannelId(clientId, roomId);
    // Try cached minutes first
    const cached = popCachedMinutes(channelId);
    if (cached) {
      res.setHeader("Content-Type", "application/pdf");
      res.setHeader(
        "Content-Disposition",
        `attachment; filename="minutes-${roomId}.pdf"`,
      );
      return res.end(cached);
    }

    let transcript = stopRoomTranscriber(channelId);
    if (!transcript.length) {
      transcript = popCachedTranscript(channelId);
    }

    if (!transcript.length) {
      const summary =
        "No transcript available. Speech-to-text was not configured or no audio was captured.";
      try {
        const pdf = await buildMinutesPdf({ roomId, summary, transcript: [] });
        res.setHeader("Content-Type", "application/pdf");
        res.setHeader(
          "Content-Disposition",
          `attachment; filename="minutes-${roomId}.pdf"`,
        );
        return res.end(pdf);
      } catch (err) {
        Logger.warn("Failed to build empty minutes PDF", err);
        return res
          .status(500)
          .json({ error: "Failed to generate minutes (no transcript)" });
      }
    }

    try {
      const summary = await summarizeTranscript(transcript);
      const pdf = await buildMinutesPdf({ roomId, summary, transcript });
      res.setHeader("Content-Type", "application/pdf");
      res.setHeader(
        "Content-Disposition",
        `attachment; filename="minutes-${roomId}.pdf"`,
      );
      return res.end(pdf);
    } catch (err) {
      Logger.warn("Failed to build minutes PDF", err);
      return res.status(500).json({ error: "Failed to generate minutes" });
    }
  });

  return app;
};
