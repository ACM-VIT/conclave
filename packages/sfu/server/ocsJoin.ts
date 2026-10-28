import type { SfuAuthPayload } from "./socket/auth.js";

/** Ordinary meetings pass through. OCS rooms require a web-minted, role-bound SFU token. */
export const authorizedOcsSfuJoin = (
  roomId: string,
  user: SfuAuthPayload | undefined,
): boolean => {
  const ocs = user?.ocs;
  if (!roomId.startsWith("ocs27-") && user?.clientId !== "ocs27" && !ocs)
    return true;
  if (!user || !ocs) return false;
  return (
    user.clientId === "ocs27" &&
      /^ocs27-[a-z0-9-]{8,58}$/.test(roomId) &&
      ocs.roomId === roomId &&
      ["candidate", "interviewer", "ghost"].includes(ocs.role) &&
      typeof ocs.bookingId === "string" && ocs.bookingId.length > 0 && ocs.bookingId.length <= 128 &&
      typeof ocs.profileId === "string" && ocs.profileId.length > 0 && ocs.profileId.length <= 128 &&
      user.userId === `ocs27:${ocs.role}:${ocs.profileId}` &&
      user.email === undefined &&
      user.isSuperAdmin !== true
  );
};
