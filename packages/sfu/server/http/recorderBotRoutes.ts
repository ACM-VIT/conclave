import type { Express, Request, Response } from "express";
import express from "express";
import { Logger } from "../../utilities/loggers.js";
import type { RecordingManager } from "../recording/recordingManager.js";
import { verifyRecorderToken } from "../recording/viewRecorder.js";

type RegisterOptions = {
  recordings: RecordingManager;
};

const ensureToken = (
  req: Request,
  res: Response,
): { sessionId: string; roomId: string; clientId: string } | null => {
  const token = req.header("x-recorder-token")?.trim();
  if (!token) {
    res.status(401).json({ error: "Missing recorder token" });
    return null;
  }
  const verification = verifyRecorderToken(token);
  if (!verification.ok) {
    res.status(401).json({ error: `Invalid recorder token: ${verification.error}` });
    return null;
  }
  const requestedSessionId = String(req.params.sessionId || "");
  if (
    requestedSessionId &&
    requestedSessionId !== verification.payload.sessionId
  ) {
    res.status(403).json({ error: "Recorder token does not match session" });
    return null;
  }
  return {
    sessionId: verification.payload.sessionId,
    roomId: verification.payload.roomId,
    clientId: verification.payload.clientId,
  };
};

export const registerRecorderBotRoutes = (
  app: Express,
  options: RegisterOptions,
): void => {
  const rawBinary = express.raw({
    type: ["application/octet-stream", "video/*"],
    limit: "32mb",
  });

  app.post(
    "/recorder/:sessionId/chunk",
    rawBinary,
    async (req, res) => {
      const ctx = ensureToken(req, res);
      if (!ctx) return;
      const sequenceHeader = req.header("x-recorder-sequence");
      const sequenceQuery =
        typeof req.query.seq === "string" ? req.query.seq : "";
      const sequence = Number(sequenceHeader || sequenceQuery || "NaN");
      if (!Number.isFinite(sequence) || sequence < 0) {
        res.status(400).json({ error: "Invalid sequence" });
        return;
      }
      const body = req.body;
      const buffer = Buffer.isBuffer(body) ? body : Buffer.from(body as Uint8Array);
      if (!buffer || buffer.length === 0) {
        res.status(400).json({ error: "Empty chunk" });
        return;
      }
      const result = await options.recordings.acceptChunk(
        ctx.sessionId,
        buffer,
        sequence,
      );
      if (!result.accepted) {
        res
          .status(409)
          .json({ accepted: false, reason: result.reason || "rejected" });
        return;
      }
      res.json({ accepted: true, sequence });
    },
  );

  app.get("/recorder/:sessionId/status", (req, res) => {
    const ctx = ensureToken(req, res);
    if (!ctx) return;
    const state = options.recordings.getRecorderControl(ctx.sessionId);
    if (!state) {
      res.json({ stopRequested: true, reason: "session not found" });
      return;
    }
    res.json({
      stopRequested: state.stopRequested,
      paused: state.paused,
    });
  });

  app.post(
    "/recorder/:sessionId/finalize",
    express.json({ limit: "16kb" }),
    async (req, res) => {
      const ctx = ensureToken(req, res);
      if (!ctx) return;
      const durationMs = Number(req.body?.durationMs) || 0;
      const reason = String(req.body?.reason || "completed");
      const errorMessage = req.body?.errorMessage
        ? String(req.body.errorMessage)
        : null;
      Logger.info(
        `[recorder-bot] finalize for ${ctx.sessionId} (${reason}, ${durationMs} ms)${errorMessage ? ` err=${errorMessage}` : ""}`,
      );
      await options.recordings.finalizeViewRecording(ctx.sessionId, {
        durationMs,
        reason,
        errorMessage,
      });
      res.json({ ok: true });
    },
  );
};
