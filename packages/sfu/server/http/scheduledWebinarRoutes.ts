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
  changeWebinars,
  coHostInviteWebinarId,
  deleteScheduledWebinar,
  getScheduledWebinarById,
  getScheduledWebinarBySlug,
  getScheduledWebinarForRoom,
  listScheduledWebinars,
  moveScheduledWebinarToClient,
  updateScheduledWebinar,
  type ScheduledWebinarStore,
} from "../scheduledWebinars.js";
import { clearWebinarLinkSlug } from "../webinar.js";
import type { ChangeTargets } from "../persistThenApply.js";
import type { SfuState } from "../state.js";
import { AccessRevokedError, answerStoreFailure } from "./persistenceUnavailable.js";
import {
  canonicalizeClientId,
  canMigrateClientNamespace,
  clientIdCandidates,
  resolveDefaultClientId,
} from "../clientIds.js";
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

const hasWebinarAccess = (
  webinar: ScheduledWebinar,
  user: ReturnType<typeof resolveUserContext>,
): boolean =>
  user.isAdmin ||
  (Boolean(user.email) &&
    (webinar.hostEmail === user.email || webinar.coHosts.some((entry) => entry.email === user.email)));

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

  const change = <R>(
    ids: ChangeTargets<ScheduledWebinarStore>,
    mutate: (draft: ScheduledWebinarStore) => R,
  ): Promise<R> =>
    changeWebinars(state.scheduledWebinars, state.scheduledWebinarPersistence, ids, mutate);

  const answerFailure = (res: Response, error: unknown): void => {
    if (answerStoreFailure(res, error)) return;
    res.status(400).json({ error: (error as Error).message });
  };

  const migrateWebinarNamespace = async (
    webinar: ScheduledWebinar,
    clientId: string,
  ): Promise<ScheduledWebinar | null> => {
    if (webinar.clientId === clientId) return webinar;
    if (!canMigrateClientNamespace(webinar.clientId, clientId)) return null;
    try {
      return await change([webinar.id], (draft) =>
        moveScheduledWebinarToClient(draft, webinar.id, clientId),
      );
    } catch (error) {
      Logger.warn(
        `Failed to migrate scheduled webinar ${webinar.id} from ${webinar.clientId} to ${clientId}`,
        error,
      );
      return null;
    }
  };

  const findWebinarForRoom = async (
    clientId: string,
    roomId: string,
  ): Promise<ScheduledWebinar | null> => {
    for (const candidateClientId of clientIdCandidates(clientId)) {
      const webinar = getScheduledWebinarForRoom(
        state.scheduledWebinars,
        candidateClientId,
        roomId,
      );
      if (!webinar) continue;
      if (webinar.clientId === clientId) return webinar;
      return (await migrateWebinarNamespace(webinar, clientId)) ?? webinar;
    }
    return null;
  };

  const listWebinarsForClient = async (options: {
    clientId: string;
    ownerEmail?: string;
    includeAll: boolean;
    status?: ScheduledWebinarStatus[];
  }): Promise<ScheduledWebinar[]> => {
    const byId = new Map<string, ScheduledWebinar>();
    const seenRoomIds = new Set<string>();
    for (const candidateClientId of clientIdCandidates(options.clientId)) {
      const webinars = listScheduledWebinars(state.scheduledWebinars, {
        clientId: candidateClientId,
        ownerEmail: options.ownerEmail,
        includeAll: options.includeAll,
        status: options.status,
      });
      for (const webinar of webinars) {
        if (seenRoomIds.has(webinar.roomId)) continue;
        const normalized =
          webinar.clientId === options.clientId
            ? webinar
            : await migrateWebinarNamespace(webinar, options.clientId);
        if (!normalized) continue;
        seenRoomIds.add(normalized.roomId);
        byId.set(normalized.id, normalized);
      }
    }
    return Array.from(byId.values()).sort(
      (a, b) => a.scheduledStartAt - b.scheduledStartAt,
    );
  };

  app.get("/scheduled-webinars", async (req, res) => {
    if (!requireSecret(req, res)) return;
    const user = resolveUserContext(req);
    const clientId = resolveClientId(req);
    const includeAll = req.query.scope === "all" && user.isAdmin;
    const statusFilter = parseStatusFilter(req.query.status);

    const list = await listWebinarsForClient({
      clientId,
      ownerEmail: user.email || undefined,
      includeAll,
      status: statusFilter,
    });

    res.json({ scheduledWebinars: list.map(serializeScheduledWebinar) });
  });

  app.post("/scheduled-webinars", async (req, res) => {
    if (!requireSecret(req, res)) return;
    const user = resolveUserContext(req);
    if (!user.email) {
      res.status(400).json({ error: "User context required" });
      return;
    }
    const clientId = resolveClientId(req);

    try {
      const body = (req.body ?? {}) as CreateScheduledWebinarRequest;
      const email = user.email;
      const { webinar, inviteCodeHash } = await change([], (draft) =>
        createScheduledWebinar(draft, body, {
          clientId,
          createdBy: user.userId || email,
          defaultHostEmail: email,
          defaultHostName: user.name || undefined,
          defaultHostUserId: user.userId,
        }),
      );
      ensureWebinarRoomConfig(state, webinar, inviteCodeHash);
      Logger.info(
        `Scheduled webinar created ${webinar.id} (${webinar.linkSlug}) by ${user.email}`,
      );
      res.status(201).json({ scheduledWebinar: serializeScheduledWebinar(webinar) });
    } catch (error) {
      answerFailure(res, error);
    }
  });

  app.get("/scheduled-webinars/by-slug/:slug", async (req, res) => {
    if (!requireSecret(req, res)) return;
    const clientId = resolveClientId(req);
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
    const normalizedWebinar =
      webinar.clientId === clientId ||
      clientIdCandidates(clientId).includes(webinar.clientId)
        ? (await migrateWebinarNamespace(webinar, clientId)) ?? webinar
        : webinar;
    res.json({
      scheduledWebinar: serializeScheduledWebinar(normalizedWebinar),
    });
  });

  app.get("/scheduled-webinars/by-room/:clientId/:roomId", async (req, res) => {
    if (!requireSecret(req, res)) return;
    const clientId = normalizeIdentifier(req.params.clientId);
    const roomId = normalizeIdentifier(req.params.roomId);
    if (!clientId || !roomId) {
      res.status(400).json({ error: "Missing clientId or roomId" });
      return;
    }
    const webinar = await findWebinarForRoom(canonicalizeClientId(clientId), roomId);
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
    if (!hasWebinarAccess(webinar, resolveUserContext(req))) {
      res.status(403).json({ error: "Not authorized for this webinar" });
      return null;
    }
    return webinar;
  };

  const changeWithAccess = <R>(
    req: Request,
    id: string,
    mutate: (draft: ScheduledWebinarStore) => R,
  ): Promise<R> => {
    const user = resolveUserContext(req);
    return change([id], (draft) => {
      const current = draft.byId.get(id);
      if (current && !hasWebinarAccess(current, user)) throw new AccessRevokedError("webinar");
      return mutate(draft);
    });
  };

  app.get("/scheduled-webinars/:id", (req, res) => {
    if (!requireSecret(req, res)) return;
    const webinar = requireWebinarAccess(req, res);
    if (!webinar) return;
    res.json({ scheduledWebinar: serializeScheduledWebinar(webinar) });
  });

  app.patch("/scheduled-webinars/:id", async (req, res) => {
    if (!requireSecret(req, res)) return;
    const target = requireWebinarAccess(req, res);
    if (!target) return;

    try {
      const body = (req.body ?? {}) as UpdateScheduledWebinarRequest;
      const { webinar, inviteCodeHashChange } = await changeWithAccess(req, target.id, (draft) =>
        updateScheduledWebinar(draft, target.id, body),
      );

      ensureWebinarRoomConfig(state, webinar, inviteCodeHashChange?.value ?? null);

      const io = getIo?.() ?? null;
      const channelId = getRoomChannelId(webinar.clientId, webinar.roomId);
      const room = state.rooms.get(channelId);
      if (io && room) {
        emitWebinarConfigChanged(io, state, room);
        emitWebinarAttendeeCountChanged(io, state, room);
      }

      res.json({ scheduledWebinar: serializeScheduledWebinar(webinar) });
    } catch (error) {
      answerFailure(res, error);
    }
  });

  app.delete("/scheduled-webinars/:id", async (req, res) => {
    if (!requireSecret(req, res)) return;
    const target = requireWebinarAccess(req, res);
    if (!target) return;

    let webinar: ScheduledWebinar | null;
    try {
      webinar = await changeWithAccess(req, target.id, (draft) => deleteScheduledWebinar(draft, target.id));
    } catch (error) {
      answerFailure(res, error);
      return;
    }
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

    res.json({ success: true, id: webinar.id });
  });

  app.post("/scheduled-webinars/:id/start", async (req, res) => {
    if (!requireSecret(req, res)) return;
    const target = requireWebinarAccess(req, res);
    if (!target) return;

    try {
      const { webinar } = await changeWithAccess(req, target.id, (draft) =>
        updateScheduledWebinar(draft, target.id, { status: "live" }),
      );
      ensureWebinarRoomConfig(state, webinar, null);
      res.json({ scheduledWebinar: serializeScheduledWebinar(webinar) });
    } catch (error) {
      answerFailure(res, error);
    }
  });

  app.post("/scheduled-webinars/:id/end", async (req, res) => {
    if (!requireSecret(req, res)) return;
    const target = requireWebinarAccess(req, res);
    if (!target) return;

    try {
      const { webinar } = await changeWithAccess(req, target.id, (draft) =>
        updateScheduledWebinar(draft, target.id, { status: "ended" }),
      );
      const channelId = getRoomChannelId(webinar.clientId, webinar.roomId);
      // Locks the room through the same path that records the schedule's
      // status, so a later reopen of the schedule reopens the room.
      if (state.webinarConfigs.has(channelId)) {
        ensureWebinarRoomConfig(state, webinar, null);
      }
      res.json({ scheduledWebinar: serializeScheduledWebinar(webinar) });
    } catch (error) {
      answerFailure(res, error);
    }
  });

  app.post("/scheduled-webinars/:id/cancel", async (req, res) => {
    if (!requireSecret(req, res)) return;
    const target = requireWebinarAccess(req, res);
    if (!target) return;

    try {
      const { webinar } = await changeWithAccess(req, target.id, (draft) =>
        updateScheduledWebinar(draft, target.id, { status: "cancelled" }),
      );
      const channelId = getRoomChannelId(webinar.clientId, webinar.roomId);
      // Disables and locks the room (see the /end route).
      if (state.webinarConfigs.has(channelId)) {
        ensureWebinarRoomConfig(state, webinar, null);
      }
      res.json({ scheduledWebinar: serializeScheduledWebinar(webinar) });
    } catch (error) {
      answerFailure(res, error);
    }
  });

  app.post("/scheduled-webinars/:id/cohost-invite", async (req, res) => {
    if (!requireSecret(req, res)) return;
    const target = requireWebinarAccess(req, res);
    if (!target) return;

    try {
      const { webinar, token } = await changeWithAccess(req, target.id, (draft) =>
        createScheduledWebinarCoHostInvite(draft, target.id),
      );
      res.json({
        coHostInviteLink: buildCoHostInviteLink(token),
        scheduledWebinar: serializeScheduledWebinar(webinar),
      });
    } catch (error) {
      answerFailure(res, error);
    }
  });

  app.post("/scheduled-webinars/cohost-invites/:token/accept", async (req, res) => {
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
      const invitee = { email: user.email, name: user.name };
      const webinar = await change(
        (store) => [coHostInviteWebinarId(store, token)].filter((id) => id !== null),
        (draft) => acceptScheduledWebinarCoHostInvite(draft, token, invitee),
      );
      ensureWebinarRoomConfig(state, webinar, null);
      const io = getIo?.() ?? null;
      const channelId = getRoomChannelId(webinar.clientId, webinar.roomId);
      const room = state.rooms.get(channelId);
      if (io && room) {
        emitWebinarConfigChanged(io, state, room);
        emitWebinarAttendeeCountChanged(io, state, room);
      }
      res.json({ scheduledWebinar: serializeScheduledWebinar(webinar) });
    } catch (error) {
      answerFailure(res, error);
    }
  });
};
