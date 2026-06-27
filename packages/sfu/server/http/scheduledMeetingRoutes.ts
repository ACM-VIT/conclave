import type { Express, Request, Response } from "express";
import { Logger } from "../../utilities/loggers.js";
import { secretsMatch } from "../secret.js";
import {
  createScheduledMeeting,
  deleteScheduledMeeting,
  getScheduledMeetingById,
  getScheduledMeetingByRoomCode,
  listScheduledMeetings,
  persistScheduledMeetingChanges,
  persistScheduledMeetingDeletes,
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

const MAX_ID_LENGTH = 256;
const MAX_ROOM_CODE_LENGTH = 64;
const MAX_EMAIL_LENGTH = 320;
const MAX_NAME_LENGTH = 120;
const MAX_STATUS_FILTER_LENGTH = 128;
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f]/;

const hasValidSecret = (req: Request, secret: string): boolean => {
  const provided = req.header("x-sfu-secret");
  return Boolean(provided && secretsMatch(provided, secret));
};

const normalizeIdentifier = (
  value: unknown,
  maxLength = MAX_ID_LENGTH,
): string | null => {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  if (
    !normalized ||
    normalized.length > maxLength ||
    CONTROL_CHARACTER_PATTERN.test(normalized)
  ) {
    return null;
  }
  return normalized;
};

const normalizeEmail = (value: unknown): string | null => {
  const normalized = normalizeIdentifier(value, MAX_EMAIL_LENGTH)?.toLowerCase();
  return normalized || null;
};

const resolveClientId = (req: Request, fallback = "default"): string => {
  const fromQuery = normalizeIdentifier(req.query.clientId) || "";
  const fromHeader = normalizeIdentifier(req.header("x-sfu-client")) || "";
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
  const email = normalizeEmail(req.header("x-user-email"));
  const name = normalizeIdentifier(req.header("x-user-name"), MAX_NAME_LENGTH);
  const userId = normalizeIdentifier(req.header("x-user-id"));
  const isAdmin = req.header("x-user-is-admin") === "1";
  return { email: email || null, name, userId, isAdmin };
};

const parseStatusFilter = (
  value: unknown,
): ScheduledMeetingStatus[] | undefined => {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    value.length > MAX_STATUS_FILTER_LENGTH
  ) {
    return undefined;
  }
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

  const persistChanged = async (meeting: ScheduledMeeting): Promise<void> => {
    if (state.scheduledMeetingPersistence) {
      try {
        await persistScheduledMeetingChanges(
          state.scheduledMeetings,
          state.scheduledMeetingPersistence,
          [meeting],
        );
      } catch (error) {
        Logger.warn("Failed to persist scheduled meetings", error);
      }
    }
  };

  const persistDeleted = async (id: string): Promise<void> => {
    if (state.scheduledMeetingPersistence) {
      try {
        await persistScheduledMeetingDeletes(
          state.scheduledMeetings,
          state.scheduledMeetingPersistence,
          [id],
        );
      } catch (error) {
        Logger.warn("Failed to delete scheduled meeting", error);
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

  app.post("/scheduled-meetings", async (req, res) => {
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

      await persistChanged(meeting);
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
    const roomCode = normalizeIdentifier(
      req.params.roomCode,
      MAX_ROOM_CODE_LENGTH,
    )?.toLowerCase();
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
    const roomCode = normalizeIdentifier(
      req.params.roomCode,
      MAX_ROOM_CODE_LENGTH,
    )?.toLowerCase();
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
    const id = normalizeIdentifier(req.params.id);
    if (!id) {
      res.status(400).json({ error: "Scheduled meeting ID is required" });
      return null;
    }
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

  app.patch("/scheduled-meetings/:id", async (req, res) => {
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
      await persistChanged(meeting);
      res.json({ scheduledMeeting: serializeMeeting(meeting) });
    } catch (error) {
      res.status(400).json({ error: (error as Error).message });
    }
  });

  app.delete("/scheduled-meetings/:id", async (req, res) => {
    if (!requireSecret(req, res)) return;
    const target = requireMeetingAccess(req, res);
    if (!target) return;
    const meeting = deleteScheduledMeeting(state.scheduledMeetings, target.id);
    if (!meeting) {
      res.status(404).json({ error: "Scheduled meeting not found" });
      return;
    }
    await persistDeleted(meeting.id);
    res.json({ success: true, id: meeting.id });
  });

  app.post("/scheduled-meetings/:id/start", async (req, res) => {
    if (!requireSecret(req, res)) return;
    const target = requireMeetingAccess(req, res);
    if (!target) return;
    try {
      const meeting = updateScheduledMeeting(
        state.scheduledMeetings,
        target.id,
        { status: "live" },
      );
      await persistChanged(meeting);
      res.json({ scheduledMeeting: serializeMeeting(meeting) });
    } catch (error) {
      res.status(400).json({ error: (error as Error).message });
    }
  });

  app.post("/scheduled-meetings/:id/cancel", async (req, res) => {
    if (!requireSecret(req, res)) return;
    const target = requireMeetingAccess(req, res);
    if (!target) return;
    try {
      const meeting = updateScheduledMeeting(
        state.scheduledMeetings,
        target.id,
        { status: "cancelled" },
      );
      await persistChanged(meeting);
      res.json({ scheduledMeeting: serializeMeeting(meeting) });
    } catch (error) {
      res.status(400).json({ error: (error as Error).message });
    }
  });
};
