import type { Express, Request, Response } from "express";
import { Logger } from "../../utilities/loggers.js";
import {
  createScheduledMeeting,
  deleteScheduledMeeting,
  getScheduledMeetingById,
  getScheduledMeetingByRoomCode,
  listScheduledMeetings,
  persistScheduledMeetings,
  updateScheduledMeeting,
} from "../scheduledMeetings.js";
import type { SfuState } from "../state.js";
import type {
  CreateScheduledMeetingRequest,
  ScheduledMeeting,
  ScheduledMeetingStatus,
  UpdateScheduledMeetingRequest,
} from "../../types.js";

type RegisterOptions = {
  state: SfuState;
  sfuSecret: string;
};

const hasValidSecret = (req: Request, secret: string): boolean =>
  Boolean(req.header("x-sfu-secret") && req.header("x-sfu-secret") === secret);

const resolveClientId = (req: Request, fallback = "default"): string => {
  const fromQuery =
    typeof req.query.clientId === "string" ? req.query.clientId.trim() : "";
  const fromHeader = req.header("x-sfu-client")?.trim() || "";
  return fromQuery || fromHeader || fallback;
};

const resolveUserContext = (
  req: Request,
): {
  email: string | null;
  name: string | null;
  userId: string | null;
  isAdmin: boolean;
} => {
  const email = req.header("x-user-email")?.trim().toLowerCase() || null;
  const name = req.header("x-user-name")?.trim() || null;
  const userId = req.header("x-user-id")?.trim() || null;
  const isAdmin = req.header("x-user-is-admin") === "1";
  return { email: email || null, name, userId, isAdmin };
};

const parseStatusFilter = (
  value: unknown,
): ScheduledMeetingStatus[] | undefined => {
  if (typeof value !== "string" || !value.trim()) return undefined;
  const tokens = value
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean) as ScheduledMeetingStatus[];
  const valid: ScheduledMeetingStatus[] = [
    "scheduled",
    "live",
    "ended",
    "cancelled",
  ];
  const filtered = tokens.filter((t) => valid.includes(t));
  return filtered.length ? filtered : undefined;
};

const serializeMeeting = (meeting: ScheduledMeeting): ScheduledMeeting => meeting;

const publicMeetingView = (meeting: ScheduledMeeting) => ({
  id: meeting.id,
  roomCode: meeting.roomCode,
  title: meeting.title,
  hostName: meeting.hostName,
  scheduledStartAt: meeting.scheduledStartAt,
  scheduledEndAt: meeting.scheduledEndAt,
  status: meeting.status,
  startedAt: meeting.startedAt,
  endedAt: meeting.endedAt,
});

export const registerScheduledMeetingRoutes = (
  app: Express,
  options: RegisterOptions,
): void => {
  const { state, sfuSecret } = options;

  const requireSecret = (req: Request, res: Response): boolean => {
    if (hasValidSecret(req, sfuSecret)) return true;
    res.status(401).json({ error: "Unauthorized" });
    return false;
  };

  const persist = (): void => {
    if (state.scheduledMeetingPersistence) {
      try {
        persistScheduledMeetings(
          state.scheduledMeetings,
          state.scheduledMeetingPersistence,
        );
      } catch (error) {
        Logger.warn("Failed to persist scheduled meetings", error);
      }
    }
  };

  app.get("/scheduled-meetings", (req, res) => {
    if (!requireSecret(req, res)) return;
    const user = resolveUserContext(req);
    const clientId = resolveClientId(req);
    const includeAll = req.query.scope === "all" && user.isAdmin;
    const statusFilter = parseStatusFilter(req.query.status);

    const list = listScheduledMeetings(state.scheduledMeetings, {
      clientId,
      ownerEmail: user.email || undefined,
      includeAll,
      status: statusFilter,
    });

    res.json({ scheduledMeetings: list.map(serializeMeeting) });
  });

  app.post("/scheduled-meetings", (req, res) => {
    if (!requireSecret(req, res)) return;
    const user = resolveUserContext(req);
    if (!user.email) {
      res.status(400).json({ error: "User context required" });
      return;
    }
    const clientId = resolveClientId(req);

    try {
      const body = (req.body ?? {}) as CreateScheduledMeetingRequest;
      const meeting = createScheduledMeeting(state.scheduledMeetings, body, {
        clientId,
        createdBy: user.userId || user.email,
        defaultHostEmail: user.email,
        defaultHostName: user.name || undefined,
        defaultHostUserId: user.userId,
      });

      persist();
      Logger.info(
        `Scheduled meeting created ${meeting.id} (${meeting.roomCode}) by ${user.email}`,
      );
      res.status(201).json({ scheduledMeeting: serializeMeeting(meeting) });
    } catch (error) {
      res.status(400).json({ error: (error as Error).message });
    }
  });

  app.get("/scheduled-meetings/by-room/:roomCode", (req, res) => {
    if (!requireSecret(req, res)) return;
    const clientId = resolveClientId(req);
    const roomCode = String(req.params.roomCode || "").trim().toLowerCase();
    if (!roomCode) {
      res.status(400).json({ error: "Room code is required" });
      return;
    }
    const meeting = getScheduledMeetingByRoomCode(
      state.scheduledMeetings,
      clientId,
      roomCode,
    );
    if (!meeting) {
      res.status(404).json({ error: "Scheduled meeting not found" });
      return;
    }
    res.json({ scheduledMeeting: serializeMeeting(meeting) });
  });

  app.get("/scheduled-meetings/public/by-room/:roomCode", (req, res) => {
    if (!requireSecret(req, res)) return;
    const clientId = resolveClientId(req);
    const roomCode = String(req.params.roomCode || "").trim().toLowerCase();
    if (!roomCode) {
      res.status(400).json({ error: "Room code is required" });
      return;
    }
    const meeting = getScheduledMeetingByRoomCode(
      state.scheduledMeetings,
      clientId,
      roomCode,
    );
    if (!meeting) {
      res.status(404).json({ error: "Scheduled meeting not found" });
      return;
    }
    res.json({ scheduledMeeting: publicMeetingView(meeting) });
  });

  const requireMeetingAccess = (
    req: Request,
    res: Response,
  ): ScheduledMeeting | null => {
    const id = String(req.params.id || "");
    const meeting = getScheduledMeetingById(state.scheduledMeetings, id);
    if (!meeting) {
      res.status(404).json({ error: "Scheduled meeting not found" });
      return null;
    }
    const user = resolveUserContext(req);
    if (!user.isAdmin) {
      if (!user.email || meeting.hostEmail !== user.email) {
        res.status(403).json({ error: "Not authorized for this meeting" });
        return null;
      }
    }
    return meeting;
  };

  app.get("/scheduled-meetings/:id", (req, res) => {
    if (!requireSecret(req, res)) return;
    const meeting = requireMeetingAccess(req, res);
    if (!meeting) return;
    res.json({ scheduledMeeting: serializeMeeting(meeting) });
  });

  app.patch("/scheduled-meetings/:id", (req, res) => {
    if (!requireSecret(req, res)) return;
    const target = requireMeetingAccess(req, res);
    if (!target) return;
    try {
      const body = (req.body ?? {}) as UpdateScheduledMeetingRequest;
      const meeting = updateScheduledMeeting(
        state.scheduledMeetings,
        target.id,
        body,
      );
      persist();
      res.json({ scheduledMeeting: serializeMeeting(meeting) });
    } catch (error) {
      res.status(400).json({ error: (error as Error).message });
    }
  });

  app.delete("/scheduled-meetings/:id", (req, res) => {
    if (!requireSecret(req, res)) return;
    const target = requireMeetingAccess(req, res);
    if (!target) return;
    const meeting = deleteScheduledMeeting(state.scheduledMeetings, target.id);
    if (!meeting) {
      res.status(404).json({ error: "Scheduled meeting not found" });
      return;
    }
    persist();
    res.json({ success: true, id: meeting.id });
  });

  app.post("/scheduled-meetings/:id/start", (req, res) => {
    if (!requireSecret(req, res)) return;
    const target = requireMeetingAccess(req, res);
    if (!target) return;
    try {
      const meeting = updateScheduledMeeting(
        state.scheduledMeetings,
        target.id,
        { status: "live" },
      );
      persist();
      res.json({ scheduledMeeting: serializeMeeting(meeting) });
    } catch (error) {
      res.status(400).json({ error: (error as Error).message });
    }
  });

  app.post("/scheduled-meetings/:id/cancel", (req, res) => {
    if (!requireSecret(req, res)) return;
    const target = requireMeetingAccess(req, res);
    if (!target) return;
    try {
      const meeting = updateScheduledMeeting(
        state.scheduledMeetings,
        target.id,
        { status: "cancelled" },
      );
      persist();
      res.json({ scheduledMeeting: serializeMeeting(meeting) });
    } catch (error) {
      res.status(400).json({ error: (error as Error).message });
    }
  });
};
