import { asRecord } from "../../utilities/untrusted.js";
import type { ScheduledMeeting } from "../../types.js";

export type InviteeDecision = { removed: boolean; at: number };

export type InviteeState = {
  meetingId: string;
  decisions: Record<string, InviteeDecision>;
  endedAt: number | null;
  generation: number | null;
};

export const emptyInviteeState = (meetingId: string): InviteeState => ({
  meetingId,
  decisions: {},
  endedAt: null,
  generation: null,
});

export const storedNumber = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;

const decodeDecisions = (raw: unknown): InviteeState["decisions"] =>
  Object.fromEntries(
    Object.entries(asRecord(raw)).flatMap(([email, value]) => {
      const { removed, at } = asRecord(value);
      const stamp = storedNumber(at);
      return typeof removed === "boolean" && stamp !== null ? [[email, { removed, at: stamp }]] : [];
    }),
  );

export const decodeInviteeState = (raw: unknown): InviteeState | null => {
  const { meetingId, decisions, endedAt, generation } = asRecord(raw);
  if (typeof meetingId !== "string") return null;
  return {
    meetingId,
    decisions: decodeDecisions(decisions),
    endedAt: storedNumber(endedAt),
    generation: storedNumber(generation),
  };
};

export const legacyInviteeState = (meeting: ScheduledMeeting, raw: unknown): InviteeState => {
  const record = asRecord(raw);
  const decisions = record.readmissionDecisions !== null && typeof record.readmissionDecisions === "object"
    ? decodeDecisions(record.readmissionDecisions)
    : Object.fromEntries(
        (Array.isArray(record.readmissionRequiredEmails) ? record.readmissionRequiredEmails : [])
          .filter((email): email is string => typeof email === "string")
          .map((email) => [email, { removed: true, at: Math.max(0, meeting.updatedAt - 1) }]),
      );
  return {
    meetingId: meeting.id,
    decisions,
    endedAt: storedNumber(record.readmissionEndedAt),
    generation: storedNumber(record.readmissionWriteGeneration),
  };
};

export const mergeInviteeState = (current: InviteeState, incoming: InviteeState): InviteeState => {
  const endedAt = Math.max(current.endedAt ?? -1, incoming.endedAt ?? -1);
  const generation = Math.max(current.generation ?? -1, incoming.generation ?? -1);
  const decisions = new Map(Object.entries(current.decisions));
  for (const [email, next] of Object.entries(incoming.decisions)) {
    const held = decisions.get(email);
    if (!held || next.at > held.at || (next.at === held.at && next.removed && !held.removed)) {
      decisions.set(email, next);
    }
  }
  return {
    meetingId: current.meetingId,
    decisions: Object.fromEntries([...decisions].filter(([, decision]) => decision.at > endedAt)),
    endedAt: endedAt < 0 ? null : endedAt,
    generation: generation < 0 ? null : generation,
  };
};

export const removedInvitees = (state: InviteeState | null): string[] =>
  Object.entries(state?.decisions ?? {})
    .filter(([, decision]) => decision.removed && decision.at > (state?.endedAt ?? -1))
    .map(([email]) => email);
