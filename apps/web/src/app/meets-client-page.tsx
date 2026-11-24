"use client";

import { useCallback, useEffect, useState } from "react";
import MeetsClient from "./meets-client";
import {
  createGuestPassSession,
  guestPassRequestFor,
} from "./lib/guest-pass-session";
import type { JoinMode } from "./lib/types";
import type { RoomInfo } from "@/lib/sfu-types";
import {
  canonicalizeSfuClientId,
  resolveBrowserSfuClientId,
} from "@/lib/sfu-client-id";
import { requestJoinInfo } from "./lib/join-info";
import { getOrCreateSessionId, readResponseError } from "./lib/utils";

const reactionAssets = [
  "aura.gif",
  "crycry.gif",
  "goblin.gif",
  "phone.gif",
  "sixseven.gif",
  "yawn.gif",
];

const readError = readResponseError;

const defaultClientId = resolveBrowserSfuClientId();
type MeetsClientPageProps = {
  initialRoomId?: string;
  forceJoinOnly?: boolean;
  // A join may open the room when the code is known to be real (a scheduled
  // meeting). Otherwise only hosts and tabs that were in the room create it.
  allowRoomCreation?: boolean;
  bypassMediaPermissions?: boolean;
  sfuClientId?: string;
  joinMode?: JoinMode;
  autoJoinOnMount?: boolean;
  hideJoinUI?: boolean;
  webinarTitle?: string;
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
  allowRoomCreation = false,
  bypassMediaPermissions = false,
  sfuClientId,
  joinMode = "meeting",
  autoJoinOnMount = false,
  hideJoinUI = false,
  webinarTitle,
  user,
  isAdmin = false,
}: MeetsClientPageProps) {
  const [guestPass] = useState(() =>
    createGuestPassSession(guestPassRequestFor(user)),
  );
  useEffect(() => guestPass.pageLoaded(), [guestPass]);
  const defaultUser = user;
  const resolvedIsAdmin = isAdmin;
  const resolvedClientId =
    canonicalizeSfuClientId(sfuClientId) || defaultClientId;
  const usesRoomRouting = resolvedClientId === "conclave";

  const getJoinInfo = useCallback(
    (
      roomId: string,
      sessionId: string,
      options?: {
        user?: { id?: string; email?: string | null; name?: string | null };
        isHost?: boolean;
        joinMode?: JoinMode;
      }
    ) =>
      guestPass.join((guestFields) =>
        requestJoinInfo({
          roomId,
          sessionId,
          user: options?.user ?? defaultUser,
          isHost: Boolean(options?.isHost),
          isKnownMeeting: allowRoomCreation,
          clientId: resolvedClientId,
          joinMode: options?.joinMode ?? joinMode,
          guestFields,
        }),
      ),
    [allowRoomCreation, joinMode, defaultUser, resolvedClientId, guestPass]
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
    return (Array.isArray(data.rooms) ? data.rooms : []) as RoomInfo[];
  }, [resolvedClientId]);

  const getRoom = useCallback(async (roomId: string) => {
    const normalizedRoomId = roomId.trim();
    if (!normalizedRoomId) return null;

    // The headcount is only for people in or let into the room; the server
    // answers 403 to everyone else, which shows nothing.
    const query = new URLSearchParams({ sessionId: getOrCreateSessionId() });
    const response = await fetch(
      `/api/sfu/rooms/${encodeURIComponent(normalizedRoomId)}?${query}`,
      {
        cache: "no-store",
        headers: { "x-sfu-client": resolvedClientId },
      },
    );
    if (response.status === 403) return null;
    if (!response.ok) {
      throw new Error(await readError(response));
    }

    const data = (await response.json()) as { room?: unknown };
    const room = data.room;
    if (!room || typeof room !== "object") return null;
    const id = (room as { id?: unknown }).id;
    const userCount = (room as { userCount?: unknown }).userCount;
    if (typeof id !== "string" || typeof userCount !== "number") {
      return null;
    }
    return { id, userCount };
  }, [resolvedClientId]);

  const resolvedInitialRoomId =
    initialRoomId ?? (usesRoomRouting ? "" : "default-room");

  return (
    <div className="w-full h-full min-h-[100dvh] bg-[#0a0a0b] overflow-auto relative">
      <MeetsClient
        initialRoomId={resolvedInitialRoomId}
        enableRoomRouting={usesRoomRouting}
        forceJoinOnly={forceJoinOnly}
        bypassMediaPermissions={bypassMediaPermissions}
        joinMode={joinMode}
        autoJoinOnMount={autoJoinOnMount}
        hideJoinUI={hideJoinUI}
        webinarTitle={webinarTitle}
        getJoinInfo={getJoinInfo}
        getRooms={getRooms}
        getRoom={getRoom}
        reactionAssets={reactionAssets}
        user={defaultUser}
        isAdmin={resolvedIsAdmin}
      />
    </div>
  );
}
