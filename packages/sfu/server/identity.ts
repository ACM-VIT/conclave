import { MAX_DISPLAY_NAME_LENGTH } from "./constants.js";

const MAX_USER_KEY_LENGTH = 320;
const MAX_SESSION_ID_LENGTH = 128;
const MAX_USER_ID_LENGTH = MAX_USER_KEY_LENGTH + MAX_SESSION_ID_LENGTH + 1;
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f]/;

export const normalizeDisplayName = (value?: string): string => {
  if (!value) return "";
  return value.trim().replace(/\s+/g, " ").slice(0, MAX_DISPLAY_NAME_LENGTH);
};

export const isGuestUserKey = (userKey?: string | null): boolean => {
  if (!userKey) return false;
  return userKey.startsWith("guest-");
};

export const buildUserIdentity = (
  user: { email?: string; userId?: string; name?: string; sessionId?: string },
  sessionId: string | undefined,
  socketId: string,
  displayNameOverride?: string,
): { userKey: string; userId: string; displayName: string } | null => {
  const email =
    typeof user?.email === "string"
      ? normalizeIdentityPart(user.email, MAX_USER_KEY_LENGTH)?.toLowerCase()
      : null;
  const tokenUserId =
    typeof user?.userId === "string"
      ? normalizeIdentityPart(user.userId, MAX_USER_KEY_LENGTH)
      : null;
  const baseId = email || tokenUserId;
  if (!baseId) {
    return null;
  }

  const effectiveSessionId =
    normalizeIdentityPart(user?.sessionId, MAX_SESSION_ID_LENGTH) ||
    normalizeIdentityPart(sessionId, MAX_SESSION_ID_LENGTH) ||
    normalizeIdentityPart(socketId, MAX_SESSION_ID_LENGTH);
  if (!effectiveSessionId) {
    return null;
  }
  const userId = `${baseId}#${effectiveSessionId}`;
  if (userId.length > MAX_USER_ID_LENGTH) {
    return null;
  }

  return {
    userKey: baseId,
    userId,
    displayName:
      normalizeDisplayName(displayNameOverride) ||
      normalizeDisplayName(user?.name) ||
      baseId,
  };
};

const normalizeIdentityPart = (
  value: unknown,
  maxLength: number,
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
