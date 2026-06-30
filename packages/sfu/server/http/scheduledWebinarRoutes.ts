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
  acceptScheduledWebinarCoHostInvite,
  buildCoHostInviteLink,
  createScheduledWebinarCoHostInvite,
  createScheduledWebinar,
  deleteScheduledWebinar,
  getScheduledWebinarById,
  getScheduledWebinarBySlug,
  getScheduledWebinarForRoom,
  listScheduledWebinars,
  persistScheduledWebinarChanges,
  persistScheduledWebinarDeletes,
  updateScheduledWebinar,
} from "../scheduledWebinars.js";
import { clearWebinarLinkSlug } from "../webinar.js";
import type { SfuState } from "../state.js";
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
  fallback =
    process.env.SFU_CLIENT_ID?.trim() ||
    process.env.NEXT_PUBLIC_SFU_CLIENT_ID?.trim() ||
    "conclave",
): string => {
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
  "coHostInviteTokenHash" | "coHostInviteTokenCreatedAt"
>;

const serializeScheduledWebinar = (
  webinar: ScheduledWebinar,
): SafeScheduledWebinar => {
  const {
    coHostInviteTokenHash: _coHostInviteTokenHash,
    coHostInviteTokenCreatedAt: _coHostInviteTokenCreatedAt,
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

  const persistChanged = (webinar: ScheduledWebinar): void => {
    if (state.scheduledWebinarPersistence) {
      try {
        persistScheduledWebinarChanges(
          state.scheduledWebinars,
          state.scheduledWebinarPersistence,
          [webinar],
        );
      } catch (error) {
        Logger.warn("Failed to persist scheduled webinars", error);
      }
    }
  };

  const persistDeleted = (id: string): void => {
    if (state.scheduledWebinarPersistence) {
      try {
        persistScheduledWebinarDeletes(
          state.scheduledWebinars,
          state.scheduledWebinarPersistence,
          [id],
        );
      } catch (error) {
        Logger.warn("Failed to delete scheduled webinar", error);
      }
    }
  };

  app.get("/scheduled-webinars", (req, res) => {
    if (!requireSecret(req, res)) return;
    const user = resolveUserContext(req);
    const clientId = resolveClientId(req);
    const includeAll = req.query.scope === "all" && user.isAdmin;
    const statusFilter = parseStatusFilter(req.query.status);

    const list = listScheduledWebinars(state.scheduledWebinars, {
      clientId,
      ownerEmail: user.email || undefined,
      includeAll,
      status: statusFilter,
    });

    res.json({ scheduledWebinars: list.map(serializeScheduledWebinar) });
  });

  app.post("/scheduled-webinars", (req, res) => {
    if (!requireSecret(req, res)) return;
    const user = resolveUserContext(req);
    if (!user.email) {
      res.status(400).json({ error: "User context required" });
      return;
    }
    const clientId = resolveClientId(req);

    try {
      const body = (req.body ?? {}) as CreateScheduledWebinarRequest;
      const { webinar, inviteCodeHash } = createScheduledWebinar(
        state.scheduledWebinars,
        body,
        {
          clientId,
          createdBy: user.userId || user.email,
          defaultHostEmail: user.email,
          defaultHostName: user.name || undefined,
          defaultHostUserId: user.userId,
        },
      );

      ensureWebinarRoomConfig(state, webinar, inviteCodeHash);
      persistChanged(webinar);
      Logger.info(
        `Scheduled webinar created ${webinar.id} (${webinar.linkSlug}) by ${user.email}`,
      );
      res.status(201).json({ scheduledWebinar: serializeScheduledWebinar(webinar) });
    } catch (error) {
      res.status(400).json({ error: (error as Error).message });
    }
  });

  app.get("/scheduled-webinars/by-slug/:slug", (req, res) => {
    if (!requireSecret(req, res)) return;
    const slug = normalizeIdentifier(req.params.slug);
    if (!slug) {
      res.status(400).json({ error: "Webinar link code is required" });
      return;
    }
    const webinar = getScheduledWebinarBySlug(state.scheduledWebinars, slug);
    if (!webinar) {
      res.status(404).json({ error: "Scheduled webinar not found" });
      return;
    }
    res.json({ scheduledWebinar: serializeScheduledWebinar(webinar) });
  });

  app.get("/scheduled-webinars/by-room/:clientId/:roomId", (req, res) => {
    if (!requireSecret(req, res)) return;
    const clientId = normalizeIdentifier(req.params.clientId);
    const roomId = normalizeIdentifier(req.params.roomId);
    if (!clientId || !roomId) {
      res.status(400).json({ error: "Missing clientId or roomId" });
      return;
    }
    const webinar = getScheduledWebinarForRoom(
      state.scheduledWebinars,
      clientId,
      roomId,
    );
    if (!webinar) {
      res.status(404).json({ error: "Scheduled webinar not found" });
      return;
    }
    res.json({ scheduledWebinar: serializeScheduledWebinar(webinar) });
  });

  const requireWebinarAccess = (
    req: Request,
    res: Response,
  ): ReturnType<typeof getScheduledWebinarById> => {
    const id = normalizeIdentifier(req.params.id);
    if (!id) {
      res.status(400).json({ error: "Scheduled webinar ID is required" });
      return null;
    }
    const webinar = getScheduledWebinarById(state.scheduledWebinars, id);
    if (!webinar) {
      res.status(404).json({ error: "Scheduled webinar not found" });
      return null;
    }
    const user = resolveUserContext(req);
    if (!user.isAdmin) {
      if (
        !user.email ||
        (webinar.hostEmail !== user.email &&
          !webinar.coHosts.some((entry) => entry.email === user.email))
      ) {
        res.status(403).json({ error: "Not authorized for this webinar" });
        return null;
      }
    }
    return webinar;
  };

  app.get("/scheduled-webinars/:id", (req, res) => {
    if (!requireSecret(req, res)) return;
    const webinar = requireWebinarAccess(req, res);
    if (!webinar) return;
    res.json({ scheduledWebinar: serializeScheduledWebinar(webinar) });
  });

  app.patch("/scheduled-webinars/:id", (req, res) => {
    if (!requireSecret(req, res)) return;
    const target = requireWebinarAccess(req, res);
    if (!target) return;

    try {
      const body = (req.body ?? {}) as UpdateScheduledWebinarRequest;
      const { webinar, inviteCodeHashChange } = updateScheduledWebinar(
        state.scheduledWebinars,
        target.id,
        body,
      );

      ensureWebinarRoomConfig(state, webinar, inviteCodeHashChange?.value ?? null);

      const io = getIo?.() ?? null;
      const channelId = getRoomChannelId(webinar.clientId, webinar.roomId);
      const room = state.rooms.get(channelId);
      if (io && room) {
        emitWebinarConfigChanged(io, state, room);
        emitWebinarAttendeeCountChanged(io, state, room);
      }
      persistChanged(webinar);

      res.json({ scheduledWebinar: serializeScheduledWebinar(webinar) });
    } catch (error) {
      res.status(400).json({ error: (error as Error).message });
    }
  });

  app.delete("/scheduled-webinars/:id", (req, res) => {
    if (!requireSecret(req, res)) return;
    const target = requireWebinarAccess(req, res);
    if (!target) return;

    const webinar = deleteScheduledWebinar(state.scheduledWebinars, target.id);
    if (!webinar) {
      res.status(404).json({ error: "Scheduled webinar not found" });
      return;
    }

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
      const io = getIo?.() ?? null;
      const room = state.rooms.get(channelId);
      if (io && room) emitWebinarConfigChanged(io, state, room);
    }

    persistDeleted(webinar.id);
    res.json({ success: true, id: webinar.id });
  });

  app.post("/scheduled-webinars/:id/start", (req, res) => {
    if (!requireSecret(req, res)) return;
    const target = requireWebinarAccess(req, res);
    if (!target) return;

    try {
      const { webinar } = updateScheduledWebinar(
        state.scheduledWebinars,
        target.id,
        { status: "live" },
      );
      ensureWebinarRoomConfig(state, webinar, null);
      persistChanged(webinar);
      res.json({ scheduledWebinar: serializeScheduledWebinar(webinar) });
    } catch (error) {
      res.status(400).json({ error: (error as Error).message });
    }
  });

  app.post("/scheduled-webinars/:id/end", (req, res) => {
    if (!requireSecret(req, res)) return;
    const target = requireWebinarAccess(req, res);
    if (!target) return;

    try {
      const { webinar } = updateScheduledWebinar(
        state.scheduledWebinars,
        target.id,
        { status: "ended" },
      );
      const channelId = getRoomChannelId(webinar.clientId, webinar.roomId);
      const cfg = state.webinarConfigs.get(channelId);
      if (cfg) cfg.locked = true;
      persistChanged(webinar);
      res.json({ scheduledWebinar: serializeScheduledWebinar(webinar) });
    } catch (error) {
      res.status(400).json({ error: (error as Error).message });
    }
  });

  app.post("/scheduled-webinars/:id/cancel", (req, res) => {
    if (!requireSecret(req, res)) return;
    const target = requireWebinarAccess(req, res);
    if (!target) return;

    try {
      const { webinar } = updateScheduledWebinar(
        state.scheduledWebinars,
        target.id,
        { status: "cancelled" },
      );
      const channelId = getRoomChannelId(webinar.clientId, webinar.roomId);
      const cfg = state.webinarConfigs.get(channelId);
      if (cfg) {
        cfg.enabled = false;
        cfg.locked = true;
      }
      persistChanged(webinar);
      res.json({ scheduledWebinar: serializeScheduledWebinar(webinar) });
    } catch (error) {
      res.status(400).json({ error: (error as Error).message });
    }
  });

  app.post("/scheduled-webinars/:id/cohost-invite", (req, res) => {
    if (!requireSecret(req, res)) return;
    const target = requireWebinarAccess(req, res);
    if (!target) return;

    try {
      const { webinar, token } = createScheduledWebinarCoHostInvite(
        state.scheduledWebinars,
        target.id,
      );
      persistChanged(webinar);
      res.json({
        coHostInviteLink: buildCoHostInviteLink(token),
        scheduledWebinar: serializeScheduledWebinar(webinar),
      });
    } catch (error) {
      res.status(400).json({ error: (error as Error).message });
    }
  });

  app.post("/scheduled-webinars/cohost-invites/:token/accept", (req, res) => {
    if (!requireSecret(req, res)) return;
    const user = resolveUserContext(req);
    if (!user.email) {
      res.status(400).json({ error: "Signed-in email required" });
      return;
    }

    try {
      const token = normalizeIdentifier(
        req.params.token,
        MAX_COHOST_INVITE_TOKEN_LENGTH,
      );
      if (!token) {
        res.status(400).json({ error: "Co-host invite token is required" });
        return;
      }
      const webinar = acceptScheduledWebinarCoHostInvite(
        state.scheduledWebinars,
        token,
        {
          email: user.email,
          name: user.name,
        },
      );
      ensureWebinarRoomConfig(state, webinar, null);
      persistChanged(webinar);
      const io = getIo?.() ?? null;
      const channelId = getRoomChannelId(webinar.clientId, webinar.roomId);
      const room = state.rooms.get(channelId);
      if (io && room) {
        emitWebinarConfigChanged(io, state, room);
        emitWebinarAttendeeCountChanged(io, state, room);
      }
      res.json({ scheduledWebinar: serializeScheduledWebinar(webinar) });
    } catch (error) {
      res.status(400).json({ error: (error as Error).message });
    }
  });
};
