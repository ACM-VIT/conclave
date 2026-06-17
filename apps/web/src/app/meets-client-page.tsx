"use client";

import { useCallback } from "react";
import MeetsClient from "./meets-client";
import type { JoinMode } from "./lib/types";

const reactionAssets = [
  "aura.gif",
  "crycry.gif",
  "goblin.gif",
  "phone.gif",
  "sixseven.gif",
  "yawn.gif",
];

const readError = async (response: Response) => {
  const data = await response.json().catch(() => null);
  if (data && typeof data === "object" && "error" in data) {
    return String((data as { error?: string }).error || "Request failed");
  }
  return response.statusText || "Request failed";
};

const defaultClientId = process.env.NEXT_PUBLIC_SFU_CLIENT_ID || "public";
const normalizeClientId = (value: string | undefined): string | null => {
  const normalized = value?.trim();
  if (!normalized) return null;
  return /^[a-zA-Z0-9._:-]{1,64}$/.test(normalized) ? normalized : null;
};

type MeetsClientPageProps = {
  initialRoomId?: string;
  forceJoinOnly?: boolean;
  bypassMediaPermissions?: boolean;
  sfuClientId?: string;
  joinMode?: JoinMode;
  autoJoinOnMount?: boolean;
  hideJoinUI?: boolean;
  fontClassName?: string;
  user?: {
    id?: string;
    email?: string | null;
    name?: string | null;
  };
  isAdmin?: boolean;
};

export default function MeetsClientPage({
  initialRoomId,
  forceJoinOnly = false,
  bypassMediaPermissions = false,
  sfuClientId,
  joinMode = "meeting",
  autoJoinOnMount = false,
  hideJoinUI = false,
  fontClassName,
  user,
  isAdmin = false,
}: MeetsClientPageProps) {
  const defaultUser = user;
  const resolvedIsAdmin = isAdmin;
  const resolvedClientId = normalizeClientId(sfuClientId) || defaultClientId;
  const isPublicClient = resolvedClientId === "public";

  const getJoinInfo = useCallback(
    async (
      roomId: string,
      sessionId: string,
      options?: {
        user?: { id?: string; email?: string | null; name?: string | null };
        isHost?: boolean;
        joinMode?: JoinMode;
      }
    ) => {
      const resolvedUser = options?.user ?? defaultUser;
      const isHost = Boolean(options?.isHost);
      const resolvedJoinMode = options?.joinMode ?? joinMode;
      const response = await fetch("/api/sfu/join", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-sfu-client": resolvedClientId,
        },
        body: JSON.stringify({
          roomId,
          sessionId,
          user: resolvedUser,
          isHost,
          allowRoomCreation: forceJoinOnly,
          clientId: resolvedClientId,
          joinMode: resolvedJoinMode,
        }),
      });

      if (!response.ok) {
        throw new Error(await readError(response));
      }

      return response.json();
    },
    [forceJoinOnly, joinMode, defaultUser, resolvedClientId]
  );

  const getRooms = useCallback(async () => {
    const response = await fetch("/api/sfu/rooms", {
      cache: "no-store",
      headers: { "x-sfu-client": resolvedClientId },
    });
    if (!response.ok) {
      throw new Error(await readError(response));
    }
    const data = (await response.json()) as { rooms?: unknown };
    return Array.isArray(data?.rooms) ? data.rooms : [];
  }, [resolvedClientId]);


  const resolvedInitialRoomId =
    initialRoomId ?? (isPublicClient ? "" : "default-room");

  return (
    <div className="w-full h-full min-h-screen bg-[#0a0a0b] overflow-auto relative">
      <MeetsClient
        initialRoomId={resolvedInitialRoomId}
        enableRoomRouting={isPublicClient}
        forceJoinOnly={forceJoinOnly}
        allowGhostMode={!isPublicClient}
        bypassMediaPermissions={bypassMediaPermissions}
        joinMode={joinMode}
        autoJoinOnMount={autoJoinOnMount}
        hideJoinUI={hideJoinUI}
        getJoinInfo={getJoinInfo}
        getRooms={getRooms}
        reactionAssets={reactionAssets}
        user={defaultUser}
        isAdmin={resolvedIsAdmin}
        fontClassName={fontClassName}
      />
    </div>
  );
}
