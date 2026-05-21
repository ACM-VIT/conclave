import { createReadStream } from "node:fs";
import { extname } from "node:path";
import type { Express, Request, Response } from "express";
import type { RecordingManager } from "../recording/recordingManager.js";
import type { SfuState } from "../state.js";
import {
  getScheduledWebinarById,
} from "../scheduledWebinars.js";

type RegisterOptions = {
  state: SfuState;
  sfuSecret: string;
  recordings: RecordingManager;
};

const hasValidSecret = (req: Request, secret: string): boolean =>
  Boolean(req.header("x-sfu-secret") && req.header("x-sfu-secret") === secret);

const resolveUserContext = (
  req: Request,
): {
  email: string | null;
  isAdmin: boolean;
} => {
  const email = req.header("x-user-email")?.trim().toLowerCase() || null;
  const isAdmin = req.header("x-user-is-admin") === "1";
  return { email, isAdmin };
};

const ensureWebinarAccess = (
  options: RegisterOptions,
  req: Request,
  res: Response,
  webinarId: string,
): boolean => {
  if (!hasValidSecret(req, options.sfuSecret)) {
    res.status(401).json({ error: "Unauthorized" });
    return false;
  }
  const user = resolveUserContext(req);
  if (user.isAdmin) return true;
  const webinar = getScheduledWebinarById(
    options.state.scheduledWebinars,
    webinarId,
  );
  if (!webinar) {
    res.status(404).json({ error: "Scheduled webinar not found" });
    return false;
  }
  if (!user.email) {
    res.status(401).json({ error: "User context required" });
    return false;
  }
  if (
    webinar.hostEmail !== user.email &&
    !webinar.coHosts.some((entry) => entry.email === user.email)
  ) {
    res.status(403).json({ error: "Not authorized for this recording" });
    return false;
  }
  return true;
};

const ensureRoomRecordingAccess = (
  options: RegisterOptions,
  req: Request,
  res: Response,
): boolean => {
  if (!hasValidSecret(req, options.sfuSecret)) {
    res.status(401).json({ error: "Unauthorized" });
    return false;
  }
  return true;
};

const guessContentType = (filename: string): string => {
  const ext = extname(filename).toLowerCase();
  switch (ext) {
    case ".mp4":
      return "video/mp4";
    case ".m4a":
      return "audio/mp4";
    case ".webm":
      return "video/webm";
    case ".json":
      return "application/json";
    case ".sdp":
      return "application/sdp";
    default:
      return "application/octet-stream";
  }
};

export const registerRecordingRoutes = (
  app: Express,
  options: RegisterOptions,
): void => {
  app.get("/rooms/:id/recordings", (req, res) => {
    const roomId = String(req.params.id || "");
    if (!ensureRoomRecordingAccess(options, req, res)) return;
    const recordings = options.recordings.listRecordingsForKey(roomId);
    res.json({ recordings });
  });

  app.get(
    "/rooms/:id/recordings/:sessionId",
    (req, res) => {
      const roomId = String(req.params.id || "");
      const sessionId = String(req.params.sessionId || "");
      if (!ensureRoomRecordingAccess(options, req, res)) return;
      const recording = options.recordings.getRecording(roomId, sessionId);
      if (!recording) {
        res.status(404).json({ error: "Recording not found" });
        return;
      }
      res.json({ recording });
    },
  );

  app.get(
    "/rooms/:id/recordings/:sessionId/files/:filename",
    (req, res) => {
      const roomId = String(req.params.id || "");
      const sessionId = String(req.params.sessionId || "");
      const filename = String(req.params.filename || "");
      if (!ensureRoomRecordingAccess(options, req, res)) return;
      const path = options.recordings.resolveArtifactPath(
        roomId,
        sessionId,
        filename,
      );
      if (!path) {
        res.status(404).json({ error: "Recording artifact not found" });
        return;
      }
      res.setHeader("Content-Type", guessContentType(filename));
      res.setHeader(
        "Content-Disposition",
        `attachment; filename="${filename}"`,
      );
      res.setHeader("Cache-Control", "no-store");
      const stream = createReadStream(path);
      stream.on("error", () => res.end());
      stream.pipe(res);
    },
  );

  app.get("/scheduled-webinars/:id/recordings", (req, res) => {
    const webinarId = String(req.params.id || "");
    if (!ensureWebinarAccess(options, req, res, webinarId)) return;
    const recordings = options.recordings.listRecordingsForKey(webinarId);
    res.json({ recordings });
  });

  app.get(
    "/scheduled-webinars/:id/recordings/:sessionId",
    (req, res) => {
      const webinarId = String(req.params.id || "");
      const sessionId = String(req.params.sessionId || "");
      if (!ensureWebinarAccess(options, req, res, webinarId)) return;
      const recording = options.recordings.getRecording(webinarId, sessionId);
      if (!recording) {
        res.status(404).json({ error: "Recording not found" });
        return;
      }
      res.json({ recording });
    },
  );

  app.get(
    "/scheduled-webinars/:id/recordings/:sessionId/files/:filename",
    (req, res) => {
      const webinarId = String(req.params.id || "");
      const sessionId = String(req.params.sessionId || "");
      const filename = String(req.params.filename || "");
      if (!ensureWebinarAccess(options, req, res, webinarId)) return;
      const path = options.recordings.resolveArtifactPath(
        webinarId,
        sessionId,
        filename,
      );
      if (!path) {
        res.status(404).json({ error: "Recording artifact not found" });
        return;
      }
      res.setHeader("Content-Type", guessContentType(filename));
      res.setHeader(
        "Content-Disposition",
        `attachment; filename="${filename}"`,
      );
      res.setHeader("Cache-Control", "no-store");
      const stream = createReadStream(path);
      stream.on("error", () => res.end());
      stream.pipe(res);
    },
  );
};
