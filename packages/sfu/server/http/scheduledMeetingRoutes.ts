import type { Express, Request, Response } from "express";
import { Logger } from "../../utilities/loggers.js";
import { secretsMatch } from "../secret.js";
import {
  createMeeting,
  deleteMeeting,
  listMeetings,
  meetingById,
  meetingByRoomCode,
  updateMeeting,
  type MeetingAccess,
} from "../controlPlane/meetingCommands.js";
import type { SfuState } from "../state.js";
import { canonicalizeClientId, resolveDefaultClientId } from "../clientIds.js";
import { controlPlaneRoute, sendFailure } from "./controlPlaneReplies.js";
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

const resolveClientId = (
  req: Request,
  fallback = resolveDefaultClientId(),
): string => {
  const fromQuery = normalizeIdentifier(req.query.clientId) || "";
  const fromHeader = normalizeIdentifier(req.header("x-sfu-client")) || "";
  return canonicalizeClientId(fromQuery || fromHeader || fallback);
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

  const accessOf = (req: Request): MeetingAccess => {
    const user = resolveUserContext(req);
    return { email: user.email, isAdmin: user.isAdmin };
  };

  const meetingId = (req: Request, res: Response): string | null => {
    const id = normalizeIdentifier(req.params.id);
    if (!id) res.status(400).json({ error: "Scheduled meeting ID is required" });
    return id;
  };

  const roomCodeOf = (req: Request, res: Response): string | null => {
    const roomCode = normalizeIdentifier(req.params.roomCode, MAX_ROOM_CODE_LENGTH)?.toLowerCase();
    if (!roomCode) res.status(400).json({ error: "Room code is required" });
    return roomCode ?? null;
  };

  const changeMeeting = async (
    req: Request,
    res: Response,
    request: UpdateScheduledMeetingRequest,
  ): Promise<void> => {
    const id = meetingId(req, res);
    if (!id) return;
    const result = await state.controlPlane.commit(updateMeeting(id, request, accessOf(req)));
    if (!result.ok) {
      sendFailure(res, result);
      return;
    }
    res.json({ scheduledMeeting: serializeMeeting(result.value) });
  };

  app.get(
    "/scheduled-meetings",
    controlPlaneRoute("list scheduled meetings", async (req, res) => {
      if (!requireSecret(req, res)) return;
      const user = resolveUserContext(req);
      const list = await state.controlPlane.read(
        listMeetings({
          clientId: resolveClientId(req),
          ownerEmail: user.email || undefined,
          includeAll: req.query.scope === "all" && user.isAdmin,
          status: parseStatusFilter(req.query.status),
        }),
      );
      res.json({ scheduledMeetings: list.map(serializeMeeting) });
    }),
  );

  app.post(
    "/scheduled-meetings",
    controlPlaneRoute("create a scheduled meeting", async (req, res) => {
      if (!requireSecret(req, res)) return;
      const user = resolveUserContext(req);
      if (!user.email) {
        res.status(400).json({ error: "User context required" });
        return;
      }
      const body = (req.body ?? {}) as CreateScheduledMeetingRequest;
      const result = await state.controlPlane.commit(
        createMeeting(body, {
          clientId: resolveClientId(req),
          createdBy: user.userId || user.email,
          defaultHostEmail: user.email,
          defaultHostName: user.name || undefined,
          defaultHostUserId: user.userId,
        }),
      );
      if (!result.ok) {
        sendFailure(res, result);
        return;
      }
      Logger.info(
        `Scheduled meeting created ${result.value.id} (${result.value.roomCode}) by ${user.email}`,
      );
      res.status(201).json({ scheduledMeeting: serializeMeeting(result.value) });
    }),
  );

  app.get(
    "/scheduled-meetings/by-room/:roomCode",
    controlPlaneRoute("find a scheduled meeting", async (req, res) => {
      if (!requireSecret(req, res)) return;
      const roomCode = roomCodeOf(req, res);
      if (!roomCode) return;
      const meeting = await state.controlPlane.read(
        meetingByRoomCode(resolveClientId(req), roomCode),
      );
      if (!meeting) {
        res.status(404).json({ error: "Scheduled meeting not found" });
        return;
      }
      res.json({ scheduledMeeting: serializeMeeting(meeting) });
    }),
  );

  app.get(
    "/scheduled-meetings/public/by-room/:roomCode",
    controlPlaneRoute("find a public scheduled meeting", async (req, res) => {
      if (!requireSecret(req, res)) return;
      const roomCode = roomCodeOf(req, res);
      if (!roomCode) return;
      const meeting = await state.controlPlane.read(
        meetingByRoomCode(resolveClientId(req), roomCode),
      );
      if (!meeting) {
        res.status(404).json({ error: "Scheduled meeting not found" });
        return;
      }
      res.json({ scheduledMeeting: publicMeetingView(meeting) });
    }),
  );

  app.get(
    "/scheduled-meetings/:id",
    controlPlaneRoute("read a scheduled meeting", async (req, res) => {
      if (!requireSecret(req, res)) return;
      const id = meetingId(req, res);
      if (!id) return;
      const meeting = await state.controlPlane.read(meetingById(id));
      if (!meeting) {
        res.status(404).json({ error: "Scheduled meeting not found" });
        return;
      }
      const access = accessOf(req);
      if (!access.isAdmin && (!access.email || meeting.hostEmail !== access.email)) {
        res.status(403).json({ error: "Not authorized for this meeting" });
        return;
      }
      res.json({ scheduledMeeting: serializeMeeting(meeting) });
    }),
  );

  app.patch(
    "/scheduled-meetings/:id",
    controlPlaneRoute("update a scheduled meeting", async (req, res) => {
      if (!requireSecret(req, res)) return;
      await changeMeeting(req, res, (req.body ?? {}) as UpdateScheduledMeetingRequest);
    }),
  );

  app.delete(
    "/scheduled-meetings/:id",
    controlPlaneRoute("delete a scheduled meeting", async (req, res) => {
      if (!requireSecret(req, res)) return;
      const id = meetingId(req, res);
      if (!id) return;
      const result = await state.controlPlane.commit(deleteMeeting(id, accessOf(req)));
      if (!result.ok) {
        sendFailure(res, result);
        return;
      }
      res.json({ success: true, id: result.value.id });
    }),
  );

  app.post(
    "/scheduled-meetings/:id/start",
    controlPlaneRoute("start a scheduled meeting", async (req, res) => {
      if (!requireSecret(req, res)) return;
      await changeMeeting(req, res, { status: "live" });
    }),
  );

  app.post(
    "/scheduled-meetings/:id/cancel",
    controlPlaneRoute("cancel a scheduled meeting", async (req, res) => {
      if (!requireSecret(req, res)) return;
      await changeMeeting(req, res, { status: "cancelled" });
    }),
  );
};
