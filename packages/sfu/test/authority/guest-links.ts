import { expect } from "vitest";
import {
  AUTHORITY_EVENTS,
  type AuthorityContract,
  type AuthorityResult,
  type Json,
} from "@conclave/apps-sdk/authority";
import { person, type Harness, type Tab } from "./harness.js";

type Emit = (event: string, payload?: unknown, ack?: (reply: unknown) => void) => void;

export const field = (value: Json | null | undefined, name: string): Json | null =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? ((value as { readonly [key: string]: Json })[name] ?? null)
    : null;

export const guestTab = <C extends AuthorityContract>(
  room: Harness,
  contract: C,
  pass: string,
  session: string,
  role: "participant" | "attendee" = "participant",
) => {
  const userKey = `guest-gp_gita-${pass}-${session}`;
  room.room.setUserIdentity(`${userKey}#${session}`, userKey, "Gita", { guestProof: pass });
  return room.open(person(userKey, "Gita", role), contract, { session });
};

export const linkPasses = (room: Harness, joining: string, shown: string) => {
  const link = room.room.planGuestLink([{ guestProof: shown }], joining);
  if (link) room.room.commitGuestLink(link);
  return link;
};

export const allViewsIn = async (room: Harness) => {
  await room.deliver();
  for (let turn = 0; turn < 200 && room.tabs.some((tab) => tab.state.kind !== "ready"); turn += 1) {
    await room.advance(50);
  }
  await room.deliver();
};

export const sameGuest = (room: Harness, one: Tab, other: Tab) =>
  room.room.guestIdentityOf(one.who.userKey) === room.room.guestIdentityOf(other.who.userKey);

export const startWithLostAnswer = async (
  room: Harness,
  tab: Tab,
  action: string,
  input: Json,
): Promise<{ answer: Promise<AuthorityResult<Json>> }> => {
  const socket = tab.socket as unknown as { emit: Emit };
  const send = socket.emit;
  let ran = false;
  socket.emit = (event, payload, ack) => {
    if (event !== AUTHORITY_EVENTS.act) return send.call(socket, event, payload, ack);
    socket.emit = send;
    ran = true;
    return send.call(socket, event, payload, () => undefined);
  };
  const pending = tab.session.act(action, input) as Promise<AuthorityResult<Json>>;
  await room.idle();
  expect(ran).toBe(true);
  return { answer: pending };
};
