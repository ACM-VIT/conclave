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

const clientId = process.env.NEXT_PUBLIC_SFU_CLIENT_ID || "public";
const isPublicClient = clientId === "public";

type MeetsClientPageProps = {
  initialRoomId?: string;
  forceJoinOnly?: boolean;
  bypassMediaPermissions?: boolean;
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
  joinMode = "meeting",
  autoJoinOnMount = false,
  hideJoinUI = false,
  fontClassName,
  user,
  isAdmin = false,
}: MeetsClientPageProps) {
  const defaultUser = user;
  const resolvedIsAdmin = isAdmin;

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
          "x-sfu-client": clientId,
        },
        body: JSON.stringify({
          roomId,
          sessionId,
          user: resolvedUser,
          isHost,
          allowRoomCreation: forceJoinOnly,
          clientId,
          joinMode: resolvedJoinMode,
        }),
      });

      if (!response.ok) {
        throw new Error(await readError(response));
      }

      return response.json();
    },
    [forceJoinOnly, joinMode, defaultUser]
  );

  const getRooms = useCallback(async () => {
    const response = await fetch("/api/sfu/rooms", {
      cache: "no-store",
      headers: { "x-sfu-client": clientId },
    });
    if (!response.ok) {
      throw new Error(await readError(response));
    }
    const data = (await response.json()) as { rooms?: unknown };
    return Array.isArray(data?.rooms) ? data.rooms : [];
  }, []);


  const resolvedInitialRoomId =
    initialRoomId ?? (isPublicClient ? "" : "default-room");

  return (
    <div className="w-full h-full min-h-screen bg-[#060606] overflow-auto relative">
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
