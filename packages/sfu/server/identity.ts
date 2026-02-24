export const normalizeDisplayName = (value?: string): string => {
  if (!value) return "";
  return value.trim().replace(/\s+/g, " ");
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
  const baseId = user?.email || user?.userId;
  if (!baseId) {
    return null;
  }

  const effectiveSessionId = user?.sessionId || sessionId || socketId;
  return {
    userKey: baseId,
    userId: `${baseId}#${effectiveSessionId}`,
    displayName: displayNameOverride?.trim() || user?.name || baseId,
  };
};
