import cors from "cors";
import express from "express";
import type { Express, Request } from "express";
import type { Server as SocketIOServer } from "socket.io";
import { config as defaultConfig } from "../../config/config.js";
import { Logger } from "../../utilities/loggers.js";
import type { SfuState } from "../state.js";
import {
  getCachedMinutes,
  getCachedTranscript,
  getRoomChannelId,
  setCachedMinutes,
  setCachedTranscript,
} from "../rooms.js";
import {
  getRoomTranscriptSnapshot,
  stopRoomTranscriber,
} from "../recording/roomTranscriber.js";
import { summarizeTranscript } from "../recording/summarizeTranscript.js";
import { buildMinutesPdf } from "../recording/minutesPdf.js";

export type CreateSfuAppOptions = {
  state: SfuState;
  config?: typeof defaultConfig;
  getIo?: () => SocketIOServer | null;
};

const hasValidSecret = (req: Request, secret: string): boolean => {
  const provided = req.header("x-sfu-secret");
  return Boolean(provided && provided === secret);
};

const DEFAULT_SERVER_RESTART_NOTICE =
  "Meeting server is restarting. You will be reconnected automatically.";
const DEFAULT_SERVER_RESTART_NOTICE_MS = 4000;
const MAX_SERVER_RESTART_NOTICE_MS = 30000;

const parseRestartNoticeMs = (value: unknown): number => {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return DEFAULT_SERVER_RESTART_NOTICE_MS;
  }
  if (value <= 0) {
    return 0;
  }
  return Math.min(Math.floor(value), MAX_SERVER_RESTART_NOTICE_MS);
};

const parseRestartNotice = (value: unknown): string => {
  if (typeof value !== "string") {
    return DEFAULT_SERVER_RESTART_NOTICE;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : DEFAULT_SERVER_RESTART_NOTICE;
};

export const createSfuApp = ({
  state,
  config = defaultConfig,
  getIo,
}: CreateSfuAppOptions): Express => {
  const app = express();
  const minutesGenerationInFlight = new Map<string, Promise<Buffer>>();
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

  app.post("/drain", async (req, res) => {
    if (!hasValidSecret(req, config.sfuSecret)) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const { draining, force, notice, noticeMs } = req.body ?? {};
    if (typeof draining !== "boolean") {
      return res.status(400).json({ error: "Invalid draining flag" });
    }

    state.isDraining = draining;
    Logger.info(`Draining mode ${state.isDraining ? "enabled" : "disabled"}`);

    const shouldForceDrain = state.isDraining && force === true;
    if (!shouldForceDrain) {
      return res.json({ draining: state.isDraining, forced: false });
    }

    const io = getIo?.() ?? null;
    if (!io) {
      Logger.warn("Force drain requested before socket server was ready.");
      return res
        .status(503)
        .json({ error: "Socket server unavailable for force drain" });
    }

    const rooms = Array.from(state.rooms.values());
    const restartNotice = parseRestartNotice(notice);
    const restartNoticeMs = parseRestartNoticeMs(noticeMs);
    const connectedClients = rooms.reduce(
      (total, room) => total + room.clients.size,
      0,
    );

    const pendingSockets = new Set<{
      emit: (event: string, payload: unknown) => void;
      disconnect: (close?: boolean) => void;
    }>();

    for (const room of rooms) {
      io.to(room.channelId).emit("serverRestarting", {
        roomId: room.id,
        message: restartNotice,
        reconnecting: true,
      });

      for (const pending of room.pendingClients.values()) {
        const pendingSocket = pending.socket as
          | {
              emit: (event: string, payload: unknown) => void;
              disconnect: (close?: boolean) => void;
            }
          | undefined;
        if (pendingSocket) {
          pendingSockets.add(pendingSocket);
        }
      }
    }

    for (const pendingSocket of pendingSockets) {
      pendingSocket.emit("serverRestarting", {
        message: restartNotice,
        reconnecting: true,
      });
    }

    if (restartNoticeMs > 0) {
      await new Promise((resolve) => {
        setTimeout(resolve, restartNoticeMs);
      });
    }

    for (const room of rooms) {
      io.in(room.channelId).disconnectSockets(true);
    }
    for (const pendingSocket of pendingSockets) {
      pendingSocket.disconnect(true);
    }

    Logger.warn(
      `Forced drain executed for ${rooms.length} room(s), disconnecting ${connectedClients} active client(s).`,
    );

    return res.json({
      draining: state.isDraining,
      forced: true,
      rooms: rooms.length,
      clients: connectedClients,
      noticeMs: restartNoticeMs,
    });
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
    const activeRoom = state.rooms.get(channelId);
    const isRoomActive = Boolean(activeRoom && !activeRoom.isEmpty());

    // For finalized rooms, serve pre-generated cache.
    if (!isRoomActive) {
      const cached = getCachedMinutes(channelId);
      if (cached) {
        Logger.info(`Minutes cache hit for channel=${channelId}`);
        res.setHeader("Content-Type", "application/pdf");
        res.setHeader(
          "Content-Disposition",
          `attachment; filename="minutes-${roomId}.pdf"`,
        );
        return res.end(cached);
      }
    }

    const inFlight = minutesGenerationInFlight.get(channelId);
    if (inFlight) {
      Logger.info(
        `Minutes request joined existing generation for channel=${channelId}`,
      );
      try {
        const pdf = await inFlight;
        res.setHeader("Content-Type", "application/pdf");
        res.setHeader(
          "Content-Disposition",
          `attachment; filename="minutes-${roomId}.pdf"`,
        );
        return res.end(pdf);
      } catch (err) {
        Logger.warn("Joined minutes generation failed", err);
        return res.status(500).json({ error: "Failed to generate minutes" });
      }
    }

    const generation = (async (): Promise<Buffer> => {
      let transcript = isRoomActive
        ? getRoomTranscriptSnapshot(channelId)
        : stopRoomTranscriber(channelId);
      Logger.info(
        `Minutes request: channel=${channelId} transcriptAfter${
          isRoomActive ? "Snapshot" : "Stop"
        }=${transcript.length}`,
      );
      if (!transcript.length && !isRoomActive) {
        transcript = getCachedTranscript(channelId);
        Logger.info(
          `Minutes request: channel=${channelId} transcriptAfterCache=${transcript.length}`,
        );
      }

      if (!transcript.length) {
        const summary =
          "No transcript available. Speech-to-text was not configured or no audio was captured.";
        Logger.warn(
          `Minutes request has empty transcript for channel=${channelId}`,
        );
        const pdf = await buildMinutesPdf({ roomId, summary, transcript: [] });
        if (!isRoomActive) {
          setCachedMinutes(channelId, pdf);
        }
        return pdf;
      }

      const summary = await summarizeTranscript(transcript);
      const pdf = await buildMinutesPdf({ roomId, summary, transcript });
      if (!isRoomActive) {
        setCachedTranscript(channelId, transcript);
        setCachedMinutes(channelId, pdf);
      }
      Logger.info(
        `Minutes generated for channel=${channelId} transcriptChunks=${transcript.length}`,
      );
      return pdf;
    })();

    minutesGenerationInFlight.set(channelId, generation);

    try {
      const pdf = await generation;
      res.setHeader("Content-Type", "application/pdf");
      res.setHeader(
        "Content-Disposition",
        `attachment; filename="minutes-${roomId}.pdf"`,
      );
      return res.end(pdf);
    } catch (err) {
      const fallbackPdf = isRoomActive ? null : getCachedMinutes(channelId);
      if (fallbackPdf) {
        res.setHeader("Content-Type", "application/pdf");
        res.setHeader(
          "Content-Disposition",
          `attachment; filename="minutes-${roomId}.pdf"`,
        );
        return res.end(fallbackPdf);
      }
      Logger.warn("Failed to build minutes PDF", err);
      return res.status(500).json({ error: "Failed to generate minutes" });
    } finally {
      if (minutesGenerationInFlight.get(channelId) === generation) {
        minutesGenerationInFlight.delete(channelId);
      }
    }
  });

  return app;
};
