import type { MeetError } from "./types";
import {
  blockedMediaDirections,
  type MediaPathHealth,
} from "./media-path-recovery";

/**
 * The alerts shown over a call. Blocked media comes only from the per
 * direction media health, so clearing or replacing the shared error (an
 * unmute, a device change) can never hide it.
 */
export const deriveInCallAlerts = ({
  meetError,
  mediaPathHealth,
}: {
  meetError: MeetError | null;
  mediaPathHealth: MediaPathHealth;
}): { mediaBlocked: boolean; error: MeetError | null } => ({
  mediaBlocked: blockedMediaDirections(mediaPathHealth).length > 0,
  error: meetError?.code === "NETWORK_BLOCKED" ? null : meetError,
});
