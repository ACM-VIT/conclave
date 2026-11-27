import {
  AUTHORITY_EVENTS,
  isAuthorityName,
  type ActRequest,
  type AuthorityFailure,
  type CapabilitiesRequest,
  type QueryRequest,
  type SubscribeRequest,
} from "@conclave/apps-sdk/authority";
import {
  getRoomAuthority,
  peekRoomAuthority,
} from "../../apps/authority/index.js";
import { parseOperationId } from "../../apps/authority/receipts.js";
import type { ConnectionContext } from "../context.js";
import { RATE_LIMITS, takeToken } from "../rateLimit.js";
import { respond } from "./ack.js";

const ID_PATTERN = /^[A-Za-z0-9._-]{1,96}$/;

const fail = (code: AuthorityFailure["code"]): AuthorityFailure => ({
  ok: false,
  code,
});

const record = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

const id = (value: unknown): string | null =>
  typeof value === "string" && ID_PATTERN.test(value) ? value : null;

// The rule a contract's own action and query names are held to.
const name = (value: unknown): string | null =>
  isAuthorityName(value) ? value : null;

const generation = (value: unknown): number | null =>
  typeof value === "number" && Number.isSafeInteger(value) && value > 0
    ? value
    : null;

const parseCapabilities = (data: unknown): CapabilitiesRequest | null => {
  const protocols = record(data)?.protocols;
  if (!Array.isArray(protocols) || protocols.length > 8) return null;
  return protocols.every((value) => Number.isSafeInteger(value))
    ? { protocols: protocols as number[] }
    : null;
};

const parseSubscribe = (data: unknown): SubscribeRequest | null => {
  const input = record(data);
  const roomEpoch = id(input?.roomEpoch);
  const instance = id(input?.instance);
  const app = id(input?.app);
  const subscription = id(input?.subscription);
  const major = generation(input?.major);
  return roomEpoch && instance && app && subscription && major
    ? { roomEpoch, instance, app, major, subscription }
    : null;
};

const parseAct = (data: unknown): ActRequest | null => {
  const input = record(data);
  const roomEpoch = id(input?.roomEpoch);
  const subscription = id(input?.subscription);
  const action = name(input?.action);
  const operation = parseOperationId(input?.operation);
  const current = generation(input?.generation);
  return roomEpoch && subscription && action && operation && current
    ? {
        roomEpoch,
        subscription,
        generation: current,
        operation,
        action,
        input: input?.input,
      }
    : null;
};

const parseQuery = (data: unknown): QueryRequest | null => {
  const input = record(data);
  const roomEpoch = id(input?.roomEpoch);
  const subscription = id(input?.subscription);
  const query = name(input?.query);
  const request = id(input?.request);
  const current = generation(input?.generation);
  return roomEpoch && subscription && query && request && current
    ? {
        roomEpoch,
        subscription,
        generation: current,
        request,
        query,
        input: input?.input,
      }
    : null;
};

/**
 * The authority transport. Registered only when this SFU runs authority
 * apps, so with the flag off these events have no listener and a client's
 * capability request simply goes unanswered, exactly as on an older SFU.
 *
 * Handlers only parse the envelope and apply the per-socket rate limit. Who
 * the caller is and what they may do is decided by the room's authority,
 * against the room as it is at that moment.
 */
export const registerAuthorityHandlers = (context: ConnectionContext): void => {
  const { socket, state } = context;

  const authority = () =>
    context.currentRoom ? getRoomAuthority(state, context.currentRoom) : null;

  socket.on(AUTHORITY_EVENTS.capabilities, (data: unknown, callback?: (response: unknown) => void) => {
    if (!takeToken(socket, "apps:authority:capabilities", RATE_LIMITS.appsAuthorityControl)) {
      respond(callback, fail("rate-limited"));
      return;
    }
    const request = parseCapabilities(data);
    if (!request) {
      respond(callback, fail("invalid-input"));
      return;
    }
    const room = authority();
    respond(callback, room ? room.capabilities(context, request) : fail("not-in-room"));
  });

  socket.on(AUTHORITY_EVENTS.subscribe, (data: unknown, callback?: (response: unknown) => void) => {
    if (!takeToken(socket, "apps:authority:subscribe", RATE_LIMITS.appsAuthorityControl)) {
      respond(callback, fail("rate-limited"));
      return;
    }
    const request = parseSubscribe(data);
    if (!request) {
      respond(callback, fail("invalid-input"));
      return;
    }
    const room = authority();
    respond(callback, room ? room.subscribe(context, request) : fail("not-in-room"));
  });

  socket.on(AUTHORITY_EVENTS.unsubscribe, (data: unknown) => {
    const subscription = id(record(data)?.subscription);
    if (!subscription || !context.currentRoom) return;
    peekRoomAuthority(context.currentRoom)?.unsubscribe(context, subscription);
  });

  socket.on(AUTHORITY_EVENTS.act, (data: unknown, callback?: (response: unknown) => void) => {
    if (!takeToken(socket, "apps:authority:act", RATE_LIMITS.appsAuthorityAct)) {
      respond(callback, fail("rate-limited"));
      return;
    }
    const request = parseAct(data);
    if (!request) {
      respond(callback, fail("invalid-input"));
      return;
    }
    const room = authority();
    respond(callback, room ? room.act(context, request) : fail("not-in-room"));
  });

  socket.on(AUTHORITY_EVENTS.query, (data: unknown, callback?: (response: unknown) => void) => {
    if (!takeToken(socket, "apps:authority:query", RATE_LIMITS.appsAuthorityQuery)) {
      respond(callback, fail("rate-limited"));
      return;
    }
    const request = parseQuery(data);
    if (!request) {
      respond(callback, fail("invalid-input"));
      return;
    }
    const room = authority();
    respond(callback, room ? room.query(context, request) : fail("not-in-room"));
  });

  socket.on("disconnect", () => {
    if (context.currentRoom) {
      peekRoomAuthority(context.currentRoom)?.dropSocket(socket.id);
    }
  });
};
