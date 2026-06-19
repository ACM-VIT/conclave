"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type { Socket } from "socket.io-client";
import {
  formatDisplayName,
  isSystemUserId,
  normalizeDisplayName,
  sanitizeInstitutionDisplayName,
} from "../lib/utils";
import type { JoinMode } from "../lib/types";

interface UseMeetDisplayNameOptions {
  user?: {
    name?: string | null;
    email?: string | null;
  };
  userId: string;
  isAdmin: boolean;
  ghostEnabled: boolean;
  socketRef: React.MutableRefObject<Socket | null>;
  joinOptionsRef: React.MutableRefObject<{
    displayName?: string;
    isGhost: boolean;
    isRecorder?: boolean;
    joinMode: JoinMode;
    webinarInviteCode?: string;
    meetingInviteCode?: string;
  }>;
}

const getDisplayNameFallback = (
  targetUserId: string,
  localUserId: string,
): string => {
  const stableKey = targetUserId.split("#")[0] || targetUserId;
  if (stableKey.startsWith("guest-")) {
    return targetUserId === localUserId ? "You" : "Guest";
  }
  return formatDisplayName(targetUserId);
};

export function useMeetDisplayName({
  user,
  userId,
  isAdmin,
  ghostEnabled,
  socketRef,
  joinOptionsRef,
}: UseMeetDisplayNameOptions) {
  const [displayNames, setDisplayNames] = useState<Map<string, string>>(
    new Map()
  );
  const [displayNameInput, setDisplayNameInput] = useState("");
  const [displayNameStatus, setDisplayNameStatus] = useState<{
    type: "success" | "error";
    message: string;
  } | null>(null);
  const [isDisplayNameUpdating, setIsDisplayNameUpdating] = useState(false);
  const preferredLocalDisplayName = useMemo(() => {
    const sanitizedName = user?.name
      ? sanitizeInstitutionDisplayName(user.name, user.email)
      : "";
    if (sanitizedName) return sanitizedName;
    return user?.email?.trim() || "";
  }, [user?.name, user?.email]);
  const localIdFallbackName = useMemo(
    () => getDisplayNameFallback(userId, userId),
    [userId],
  );

  const resolveDisplayName = useCallback(
    (targetUserId: string) => {
      if (isSystemUserId(targetUserId)) {
        return "Shared Browser";
      }
      const storedName = displayNames.get(targetUserId);
      if (storedName && storedName.trim()) {
        return storedName.trim();
      }
      if (targetUserId === userId && preferredLocalDisplayName) {
        return preferredLocalDisplayName;
      }
      return getDisplayNameFallback(targetUserId, userId);
    },
    [displayNames, preferredLocalDisplayName, userId]
  );

  const currentUserDisplayName = resolveDisplayName(userId);

  const canUpdateDisplayName = useMemo(() => {
    const normalizedInput = normalizeDisplayName(displayNameInput);
    const normalizedCurrent = normalizeDisplayName(currentUserDisplayName);
    return normalizedInput.length > 0 && normalizedInput !== normalizedCurrent;
  }, [displayNameInput, currentUserDisplayName]);

  useEffect(() => {
    if (!preferredLocalDisplayName) return;
    setDisplayNames((prev) => {
      const existing = prev.get(userId)?.trim();
      const isGeneratedFallback =
        existing !== undefined && existing === localIdFallbackName;
      if (existing && !isGeneratedFallback) return prev;
      const next = new Map(prev);
      next.set(userId, preferredLocalDisplayName);
      return next;
    });
  }, [localIdFallbackName, preferredLocalDisplayName, userId]);

  useEffect(() => {
    if (!preferredLocalDisplayName && currentUserDisplayName === "You") {
      setDisplayNameInput("");
      return;
    }
    setDisplayNameInput(currentUserDisplayName);
  }, [currentUserDisplayName, preferredLocalDisplayName]);

  useEffect(() => {
    const normalized = normalizeDisplayName(displayNameInput);
    joinOptionsRef.current = {
      ...joinOptionsRef.current,
      displayName: isAdmin ? normalized || undefined : undefined,
      isGhost: ghostEnabled,
    };
  }, [displayNameInput, ghostEnabled, isAdmin, joinOptionsRef]);

  useEffect(() => {
    if (!displayNameStatus) return;
    const timer = setTimeout(() => setDisplayNameStatus(null), 3000);
    return () => clearTimeout(timer);
  }, [displayNameStatus]);

  const handleDisplayNameSubmit = useCallback(() => {
    if (!isAdmin || !canUpdateDisplayName) return;
    const socket = socketRef.current;
    if (!socket) return;

    const nextName = normalizeDisplayName(displayNameInput);
    if (!nextName) {
      setDisplayNameStatus({
        type: "error",
        message: "Display name cannot be empty.",
      });
      return;
    }

    setIsDisplayNameUpdating(true);
    socket.emit(
      "updateDisplayName",
      { displayName: nextName },
      (res: { success?: boolean; error?: string }) => {
        setIsDisplayNameUpdating(false);
        if (res?.error) {
          setDisplayNameStatus({ type: "error", message: res.error });
          return;
        }
        setDisplayNameStatus({
          type: "success",
          message: "Display name updated.",
        });
      }
    );
  }, [isAdmin, canUpdateDisplayName, displayNameInput, socketRef]);

  return {
    displayNames,
    setDisplayNames,
    displayNameInput,
    setDisplayNameInput,
    displayNameStatus,
    isDisplayNameUpdating,
    handleDisplayNameSubmit,
    resolveDisplayName,
    currentUserDisplayName,
    canUpdateDisplayName,
  };
}
