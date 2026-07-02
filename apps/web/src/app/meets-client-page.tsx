"use client";

import { useCallback } from "react";
import MeetsClient from "./meets-client";
import type { JoinMode } from "./lib/types";
import type { RoomInfo } from "@/lib/sfu-types";
import {
  canonicalizeSfuClientId,
  resolveBrowserSfuClientId,
} from "@/lib/sfu-client-id";
import { readResponseError } from "./lib/utils";

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
const JOIN_INFO_REQUEST_TIMEOUT_MS = 15000;

const fetchJoinInfoWithTimeout = async (
  init: RequestInit,
): Promise<Response> => {
  const controller = new AbortController();
  const timeoutId = window.setTimeout(
    () => controller.abort(),
    JOIN_INFO_REQUEST_TIMEOUT_MS,
  );
  try {
    return await fetch("/api/sfu/join", {
      ...init,
      signal: controller.signal,
    });
  } catch (error) {
    if (controller.signal.aborted) {
      throw new Error("Join info request timeout");
    }
    throw error;
  } finally {
    window.clearTimeout(timeoutId);
  }
};

type MeetsClientPageProps = {
  initialRoomId?: string;
  forceJoinOnly?: boolean;
  bypassMediaPermissions?: boolean;
  sfuClientId?: string;
  joinMode?: JoinMode;
  autoJoinOnMount?: boolean;
  hideJoinUI?: boolean;
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
  user,
  isAdmin = false,
}: MeetsClientPageProps) {
  const defaultUser = user;
  const resolvedIsAdmin = isAdmin;
  const resolvedClientId =
    canonicalizeSfuClientId(sfuClientId) || defaultClientId;
  const usesRoomRouting = resolvedClientId === "conclave";

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
      const response = await fetchJoinInfoWithTimeout({
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
        const error = new Error(await readError(response)) as Error & {
          responseStatus?: number;
        };
        error.responseStatus = response.status;
        throw error;
      }

      // Our own join API; the SFU socket layer re-validates on connect.
      return (await response.json()) as {
        token: string;
        sfuUrl: string;
        iceServers?: RTCIceServer[];
      };
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
    // Our own rooms API; shape is owned by the SFU admin routes.
    return (Array.isArray(data.rooms) ? data.rooms : []) as RoomInfo[];
  }, [resolvedClientId]);

  const getRoom = useCallback(async (roomId: string) => {
    const normalizedRoomId = roomId.trim();
    if (!normalizedRoomId) return null;

    const response = await fetch(
      `/api/sfu/rooms/${encodeURIComponent(normalizedRoomId)}`,
      {
        cache: "no-store",
        headers: { "x-sfu-client": resolvedClientId },
      },
    );
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
