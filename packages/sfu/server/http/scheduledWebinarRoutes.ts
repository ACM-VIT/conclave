import type { Express, Request, Response } from "express";
import type { Server as SocketIOServer } from "socket.io";
import { Logger } from "../../utilities/loggers.js";
import { secretsMatch } from "../secret.js";
import {
  emitWebinarAttendeeCountChanged,
  emitWebinarConfigChanged,
} from "../webinarNotifications.js";
import { ensureWebinarRoomConfig } from "../scheduledWebinarScheduler.js";
import { getRoomChannelId } from "../rooms.js";
import {
  buildCoHostInviteLink,
  generateCoHostInviteToken,
  hashCoHostInviteToken,
  isWebinarHostOrCoHost,
} from "../scheduledWebinars.js";
import {
  acceptWebinarCoHostInvite,
  createWebinar,
  createWebinarCoHostInvite,
  deleteWebinar,
  listWebinars,
  updateWebinar,
  webinarById,
  webinarBySlug,
  webinarForRoomInClients,
  type WebinarAccess,
} from "../controlPlane/webinarCommands.js";
import { clearWebinarLinkSlug } from "../webinar.js";
import type { SfuState } from "../state.js";
import { canonicalizeClientId, resolveDefaultClientId } from "../clientIds.js";
import { controlPlaneRoute, sendFailure } from "./controlPlaneReplies.js";
import type {
  CreateScheduledWebinarRequest,
  ScheduledWebinar,
  ScheduledWebinarStatus,
  UpdateScheduledWebinarRequest,
} from "../../types.js";

type RegisterOptions = {
  state: SfuState;
  sfuSecret: string;
  getIo?: () => SocketIOServer | null;
};

const MAX_ID_LENGTH = 256;
const MAX_EMAIL_LENGTH = 320;
const MAX_NAME_LENGTH = 120;
const MAX_STATUS_FILTER_LENGTH = 128;
const MAX_COHOST_INVITE_TOKEN_LENGTH = 256;
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
): ScheduledWebinarStatus[] | undefined => {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    value.length > MAX_STATUS_FILTER_LENGTH
  ) {
    return undefined;
  }
  const tokens = value
    .split(",")
    .map((token) => token.trim())
    .filter(Boolean) as ScheduledWebinarStatus[];
  const valid: ScheduledWebinarStatus[] = [
    "scheduled",
    "live",
    "ended",
    "cancelled",
  ];
  const filtered = tokens.filter((token) => valid.includes(token));
  return filtered.length ? filtered : undefined;
};

type SafeScheduledWebinar = Omit<
  ScheduledWebinar,
  "coHostInviteTokenHash" | "coHostInviteTokenCreatedAt" | "inviteCodeHash"
>;

const serializeScheduledWebinar = (
  webinar: ScheduledWebinar,
): SafeScheduledWebinar => {
  const {
    coHostInviteTokenHash: _coHostInviteTokenHash,
    coHostInviteTokenCreatedAt: _coHostInviteTokenCreatedAt,
    inviteCodeHash: _inviteCodeHash,
    ...safe
  } = webinar;
  return safe;
};

export const registerScheduledWebinarRoutes = (
  app: Express,
  options: RegisterOptions,
): void => {
  const { state, sfuSecret, getIo } = options;

  const requireSecret = (req: Request, res: Response): boolean => {
    if (hasValidSecret(req, sfuSecret)) return true;
    res.status(401).json({ error: "Unauthorized" });
    return false;
  };

  const accessOf = (req: Request): WebinarAccess => {
    const user = resolveUserContext(req);
    return { email: user.email, isAdmin: user.isAdmin };
  };

  const webinarId = (req: Request, res: Response): string | null => {
    const id = normalizeIdentifier(req.params.id);
    if (!id) res.status(400).json({ error: "Scheduled webinar ID is required" });
    return id;
  };

  const notifyRoom = (webinar: ScheduledWebinar, attendees: boolean): void => {
    const io = getIo?.() ?? null;
    const room = state.rooms.get(getRoomChannelId(webinar.clientId, webinar.roomId));
    if (!io || !room) return;
    emitWebinarConfigChanged(io, state, room);
    if (attendees) emitWebinarAttendeeCountChanged(io, state, room);
  };

  const changeStatus = async (
    req: Request,
    res: Response,
    status: "live" | "ended" | "cancelled",
  ): Promise<void> => {
    const id = webinarId(req, res);
    if (!id) return;
    const result = await state.controlPlane.commit(updateWebinar(id, { status }, accessOf(req)));
    if (!result.ok) {
      sendFailure(res, result);
      return;
    }
    const { webinar } = result.value;
    if (status === "live" || state.webinarConfigs.has(getRoomChannelId(webinar.clientId, webinar.roomId))) {
      ensureWebinarRoomConfig(state, webinar);
    }
    res.json({ scheduledWebinar: serializeScheduledWebinar(webinar) });
  };

  app.get(
    "/scheduled-webinars",
    controlPlaneRoute("list scheduled webinars", async (req, res) => {
      if (!requireSecret(req, res)) return;
      const user = resolveUserContext(req);
      const list = await state.controlPlane.read(
        listWebinars({
          clientId: resolveClientId(req),
          ownerEmail: user.email || undefined,
          includeAll: req.query.scope === "all" && user.isAdmin,
          status: parseStatusFilter(req.query.status),
        }),
      );
      res.json({ scheduledWebinars: list.map(serializeScheduledWebinar) });
    }),
  );

  app.post(
    "/scheduled-webinars",
    controlPlaneRoute("create a scheduled webinar", async (req, res) => {
      if (!requireSecret(req, res)) return;
      const user = resolveUserContext(req);
      if (!user.email) {
        res.status(400).json({ error: "User context required" });
        return;
      }
      const body = (req.body ?? {}) as CreateScheduledWebinarRequest;
      const result = await state.controlPlane.commit(
        createWebinar(body, {
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
      const { webinar } = result.value;
      ensureWebinarRoomConfig(state, webinar);
      Logger.info(`Scheduled webinar created ${webinar.id} (${webinar.linkSlug}) by ${user.email}`);
      res.status(201).json({ scheduledWebinar: serializeScheduledWebinar(webinar) });
    }),
  );

  app.get(
    "/scheduled-webinars/by-slug/:slug",
    controlPlaneRoute("find a scheduled webinar", async (req, res) => {
      if (!requireSecret(req, res)) return;
      const slug = normalizeIdentifier(req.params.slug);
      if (!slug) {
        res.status(400).json({ error: "Webinar link code is required" });
        return;
      }
      const webinar = await state.controlPlane.read(webinarBySlug(slug));
      if (!webinar) {
        res.status(404).json({ error: "Scheduled webinar not found" });
        return;
      }
      res.json({ scheduledWebinar: serializeScheduledWebinar(webinar) });
    }),
  );

  app.get(
    "/scheduled-webinars/by-room/:clientId/:roomId",
    controlPlaneRoute("find a room's scheduled webinar", async (req, res) => {
      if (!requireSecret(req, res)) return;
      const clientId = normalizeIdentifier(req.params.clientId);
      const roomId = normalizeIdentifier(req.params.roomId);
      if (!clientId || !roomId) {
        res.status(400).json({ error: "Missing clientId or roomId" });
        return;
      }
      const webinar = await state.controlPlane.read(
        webinarForRoomInClients(canonicalizeClientId(clientId), roomId),
      );
      if (!webinar) {
        res.status(404).json({ error: "Scheduled webinar not found" });
        return;
      }
      res.json({ scheduledWebinar: serializeScheduledWebinar(webinar) });
    }),
  );

  app.get(
    "/scheduled-webinars/:id",
    controlPlaneRoute("read a scheduled webinar", async (req, res) => {
      if (!requireSecret(req, res)) return;
      const id = webinarId(req, res);
      if (!id) return;
      const webinar = await state.controlPlane.read(webinarById(id));
      if (!webinar) {
        res.status(404).json({ error: "Scheduled webinar not found" });
        return;
      }
      const access = accessOf(req);
      if (!access.isAdmin && !isWebinarHostOrCoHost(webinar, access.email)) {
        res.status(403).json({ error: "Not authorized for this webinar" });
        return;
      }
      res.json({ scheduledWebinar: serializeScheduledWebinar(webinar) });
    }),
  );

  app.patch(
    "/scheduled-webinars/:id",
    controlPlaneRoute("update a scheduled webinar", async (req, res) => {
      if (!requireSecret(req, res)) return;
      const id = webinarId(req, res);
      if (!id) return;
      const body = (req.body ?? {}) as UpdateScheduledWebinarRequest;
      const result = await state.controlPlane.commit(updateWebinar(id, body, accessOf(req)));
      if (!result.ok) {
        sendFailure(res, result);
        return;
      }
      const { webinar } = result.value;
      ensureWebinarRoomConfig(state, webinar);
      notifyRoom(webinar, true);
      res.json({ scheduledWebinar: serializeScheduledWebinar(webinar) });
    }),
  );

  app.delete(
    "/scheduled-webinars/:id",
    controlPlaneRoute("delete a scheduled webinar", async (req, res) => {
      if (!requireSecret(req, res)) return;
      const id = webinarId(req, res);
      if (!id) return;
      const result = await state.controlPlane.commit(deleteWebinar(id, accessOf(req)));
      if (!result.ok) {
        sendFailure(res, result);
        return;
      }
      const webinar = result.value;
      const channelId = getRoomChannelId(webinar.clientId, webinar.roomId);
      const cfg = state.webinarConfigs.get(channelId);
      if (cfg) {
        clearWebinarLinkSlug({
          webinarConfig: cfg,
          webinarLinks: state.webinarLinks,
          roomChannelId: channelId,
        });
        cfg.enabled = false;
        cfg.forcedHostEmails = new Set();
        cfg.scheduledWebinarId = null;
        notifyRoom(webinar, false);
      }
      res.json({ success: true, id: webinar.id });
    }),
  );

  app.post(
    "/scheduled-webinars/:id/start",
    controlPlaneRoute("start a scheduled webinar", async (req, res) => {
      if (!requireSecret(req, res)) return;
      await changeStatus(req, res, "live");
    }),
  );

  app.post(
    "/scheduled-webinars/:id/end",
    controlPlaneRoute("end a scheduled webinar", async (req, res) => {
      if (!requireSecret(req, res)) return;
      await changeStatus(req, res, "ended");
    }),
  );

  app.post(
    "/scheduled-webinars/:id/cancel",
    controlPlaneRoute("cancel a scheduled webinar", async (req, res) => {
      if (!requireSecret(req, res)) return;
      await changeStatus(req, res, "cancelled");
    }),
  );

  app.post(
    "/scheduled-webinars/:id/cohost-invite",
    controlPlaneRoute("create a co-host invite", async (req, res) => {
      if (!requireSecret(req, res)) return;
      const id = webinarId(req, res);
      if (!id) return;
      const token = generateCoHostInviteToken();
      const result = await state.controlPlane.commit(
        createWebinarCoHostInvite(id, accessOf(req), hashCoHostInviteToken(token)),
      );
      if (!result.ok) {
        sendFailure(res, result);
        return;
      }
      res.json({
        coHostInviteLink: buildCoHostInviteLink(token),
        scheduledWebinar: serializeScheduledWebinar(result.value),
      });
    }),
  );

  app.post(
    "/scheduled-webinars/cohost-invites/:token/accept",
    controlPlaneRoute("accept a co-host invite", async (req, res) => {
      if (!requireSecret(req, res)) return;
      const user = resolveUserContext(req);
      if (!user.email) {
        res.status(400).json({ error: "Signed-in email required" });
        return;
      }
      const token = normalizeIdentifier(req.params.token, MAX_COHOST_INVITE_TOKEN_LENGTH);
      if (!token) {
        res.status(400).json({ error: "Co-host invite token is required" });
        return;
      }
      const result = await state.controlPlane.commit(
        acceptWebinarCoHostInvite(hashCoHostInviteToken(token), {
          email: user.email,
          name: user.name,
        }),
      );
      if (!result.ok) {
        sendFailure(res, result);
        return;
      }
      ensureWebinarRoomConfig(state, result.value);
      notifyRoom(result.value, true);
      res.json({ scheduledWebinar: serializeScheduledWebinar(result.value) });
    }),
  );
};
