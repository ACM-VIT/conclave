import type {
  CreateScheduledWebinarRequest,
  ScheduledWebinar,
  UpdateScheduledWebinarRequest,
} from "../../types.js";
import { clientIdCandidates, clientsServedAs, servedClientId } from "../clientIds.js";
import {
  RANDOM_WEBINAR_SLUG_BYTES,
  acceptCoHostInvite,
  advanceScheduledWebinar,
  applyScheduledWebinarUpdate,
  buildScheduledWebinar,
  filterScheduledWebinars,
  isWebinarHostOrCoHost,
  randomWebinarSlug,
  webinarRoomId,
  withCoHostInvite,
  withWebinarJoin,
  type CreateScheduledWebinarOptions,
  type ScheduledWebinarFilter,
  type WebinarSlugContext,
} from "../scheduledWebinars.js";
import { normalizeHostEmail } from "../webinar.js";
import { done, fail, tags, uniqueKeys, type Outcome, type Stored } from "./model.js";
import type { Command, Query, Tx, TxRead } from "./tx.js";

export type WebinarAccess = { email: string | null; isAdmin: boolean };

export const WEBINAR_NOT_FOUND = "Scheduled webinar not found";

const slugContext = (tx: Tx): WebinarSlugContext => ({
  isSlugTaken: (slug) => tx.owner("webinarSlug", uniqueKeys.webinarSlug(slug)) !== null,
  randomSlug: () => randomWebinarSlug(tx.entropy.bytes(RANDOM_WEBINAR_SLUG_BYTES)),
});

const served = (webinar: ScheduledWebinar): ScheduledWebinar => {
  const clientId = servedClientId(webinar.clientId);
  return clientId === webinar.clientId ? webinar : { ...webinar, clientId };
};

const servedOrNull = (webinar: ScheduledWebinar | null | undefined): ScheduledWebinar | null =>
  webinar ? served(webinar) : null;

export const webinarById =
  (id: string): Query<ScheduledWebinar | null> =>
  (view) =>
    servedOrNull(view.get("webinar", id)?.value);

export const webinarBySlug =
  (slug: string): Query<ScheduledWebinar | null> =>
  (view) =>
    servedOrNull(
      view.lookup("webinar", "webinarSlug", uniqueKeys.webinarSlug(slug.trim().toLowerCase()))?.value,
    );

const webinarInRoom = (view: TxRead, clients: readonly string[], roomId: string): ScheduledWebinar | null => {
  for (const clientId of clients) {
    const webinar = view.lookup("webinar", "webinarRoom", uniqueKeys.webinarRoom(clientId, roomId))?.value;
    if (webinar) return served(webinar);
  }
  return null;
};

export const webinarForRoom =
  (clientId: string, roomId: string): Query<ScheduledWebinar | null> =>
  (view) =>
    webinarInRoom(view, clientsServedAs(clientId), roomId);

export const webinarForRoomInClients =
  (clientId: string, roomId: string): Query<ScheduledWebinar | null> =>
  (view) =>
    webinarInRoom(view, clientIdCandidates(clientId), roomId);

export const listWebinars =
  (filter: ScheduledWebinarFilter & { clientId: string }): Query<ScheduledWebinar[]> =>
  (view) => {
    const all = view.all("webinar").map((stored) => stored.value);
    const byId = new Map<string, ScheduledWebinar>();
    const seenRoomIds = new Set<string>();
    for (const candidate of clientIdCandidates(filter.clientId)) {
      for (const webinar of filterScheduledWebinars(all, { ...filter, clientId: candidate })) {
        if (seenRoomIds.has(webinar.roomId)) continue;
        seenRoomIds.add(webinar.roomId);
        byId.set(webinar.id, served(webinar));
      }
    }
    return [...byId.values()].sort((a, b) => a.scheduledStartAt - b.scheduledStartAt);
  };

export const webinarsByIds =
  (ids: readonly string[]): Query<Map<string, Stored<"webinar">>> =>
  (view) => {
    const found = new Map<string, Stored<"webinar">>();
    for (const id of new Set(ids)) {
      const stored = view.get("webinar", id);
      if (stored) found.set(id, { ...stored, value: served(stored.value) });
    }
    return found;
  };

export const allWebinars: Query<ScheduledWebinar[]> = (view) =>
  view.all("webinar").map((stored) => served(stored.value));

export const openWebinars: Query<ScheduledWebinar[]> = (view) =>
  view.tagged("webinar", tags.openWebinars).map((stored) => served(stored.value));

const withAccess = <T>(
  tx: Tx,
  id: string,
  access: WebinarAccess,
  run: (webinar: ScheduledWebinar) => Outcome<T>,
): Outcome<T> => {
  const current = tx.get("webinar", id);
  if (!current) return fail("not_found", WEBINAR_NOT_FOUND);
  if (!access.isAdmin && !isWebinarHostOrCoHost(current.value, access.email)) {
    return fail("forbidden", "Not authorized for this webinar");
  }
  return run(current.value);
};

export const webinarForHost =
  (id: string, access: WebinarAccess): Command<ScheduledWebinar> =>
  (tx) =>
    withAccess(tx, id, access, (webinar) => done(served(webinar)));

export const createWebinar =
  (
    request: CreateScheduledWebinarRequest,
    options: CreateScheduledWebinarOptions,
  ): Command<{ webinar: ScheduledWebinar; inviteCodeHash: string | null }> =>
  (tx) => {
    const created = buildScheduledWebinar(request, options, {
      ...slugContext(tx),
      id: tx.entropy.uuid(),
      roomId: webinarRoomId(tx.entropy.bytes(4)),
      now: tx.now,
    });
    tx.put("webinar", created.webinar);
    return done({ ...created, webinar: served(created.webinar) });
  };

export const updateWebinar =
  (
    id: string,
    patch: UpdateScheduledWebinarRequest,
    access: WebinarAccess,
  ): Command<{ webinar: ScheduledWebinar; inviteCodeHashChange: { value: string | null } | null }> =>
  (tx) =>
    withAccess(tx, id, access, (webinar) => {
      const updated = applyScheduledWebinarUpdate(webinar, patch, {
        ...slugContext(tx),
        now: tx.now,
      });
      tx.put("webinar", updated.webinar);
      return done({ ...updated, webinar: served(updated.webinar) });
    });

export const deleteWebinar =
  (id: string, access: WebinarAccess): Command<ScheduledWebinar> =>
  (tx) =>
    withAccess(tx, id, access, (webinar) => {
      tx.remove("webinar", id);
      return done(served(webinar));
    });

export const createWebinarCoHostInvite =
  (id: string, access: WebinarAccess, tokenHash: string): Command<ScheduledWebinar> =>
  (tx) =>
    withAccess(tx, id, access, (webinar) => {
      const next = withCoHostInvite(webinar, tokenHash, tx.now);
      tx.put("webinar", next);
      return done(served(next));
    });

export const acceptWebinarCoHostInvite =
  (tokenHash: string, user: { email: string; name?: string | null }): Command<ScheduledWebinar> =>
  (tx) => {
    const email = normalizeHostEmail(user.email);
    if (!email || !email.includes("@")) {
      return fail("invalid", "A signed-in account with an email is required.");
    }
    const current = tx.lookup("webinar", "cohostToken", uniqueKeys.cohostToken(tokenHash));
    if (!current) return fail("invalid", "Invalid or expired co-host invite.");
    const next = acceptCoHostInvite(current.value, user, tx.now);
    if (!next) return done(served(current.value));
    tx.put("webinar", next);
    return done(served(next));
  };

export const recordWebinarJoin =
  (id: string, currentAttendeeCount: number): Command<ScheduledWebinar> =>
  (tx) => {
    const current = tx.get("webinar", id);
    if (!current) return fail("not_found", WEBINAR_NOT_FOUND);
    const next = withWebinarJoin(current.value, currentAttendeeCount, tx.now);
    tx.put("webinar", next);
    return done(served(next));
  };

export const advanceWebinars: Command<ScheduledWebinar[]> = (tx) => {
  const changed: ScheduledWebinar[] = [];
  for (const stored of tx.tagged("webinar", tags.openWebinars)) {
    const next = advanceScheduledWebinar(stored.value, tx.now);
    if (!next) continue;
    tx.put("webinar", next);
    changed.push(served(next));
  }
  return done(changed);
};
