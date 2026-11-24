import { z } from "zod";

// The SFU answers a host's admission or stage invite with this code when
// the room's decision record could not keep it. Nothing changed: the guest
// still waits, or was not invited.
const DecisionRecordFull = z.object({ code: z.literal("DECISION_RECORD_FULL") });

const NOTICES = {
  admit: "Couldn’t admit: this meeting has reached its limit of host decisions.",
  invite: "Couldn’t invite: this meeting has reached its limit of host decisions.",
} as const;

/** The calm notice for a host action the decision record refused, if it was. */
export const hostDecisionLimitNotice = (
  response: unknown,
  action: keyof typeof NOTICES,
): string | null =>
  DecisionRecordFull.safeParse(response).success ? NOTICES[action] : null;
