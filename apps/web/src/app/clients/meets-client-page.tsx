"use client";

import { useCallback, useMemo, useRef } from "react";
import MeetsClient from "./meets-client";

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

export default function MeetsClientPage() {
  const userIdRef = useRef(
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID()
      : `guest-${Math.random().toString(36).slice(2, 10)}`
  );

  const user = useMemo(
    () => ({
      id: userIdRef.current,
      name: "Guest",
    }),
    []
  );

  const isAdmin = true;

  const getJoinInfo = useCallback(
    async (roomId: string, sessionId: string) => {
      const response = await fetch("/api/sfu/join", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ roomId, sessionId, user, isAdmin }),
      });

      if (!response.ok) {
        throw new Error(await readError(response));
      }

      return response.json();
    },
    [user]
  );

  const getRooms = useCallback(async () => {
    const response = await fetch("/api/sfu/rooms", { cache: "no-store" });
    if (!response.ok) {
      throw new Error(await readError(response));
    }
    const data = (await response.json()) as { rooms?: unknown };
    return Array.isArray(data?.rooms) ? data.rooms : [];
  }, []);

  const getRoomsForRedirect = useCallback(
    async (_roomId: string) => getRooms(),
    [getRooms]
  );

  return (
    <div className="w-full h-full bg-[#1a1a1a] overflow-auto relative">
      <MeetsClient
        getJoinInfo={getJoinInfo}
        getRooms={getRooms}
        getRoomsForRedirect={getRoomsForRedirect}
        reactionAssets={reactionAssets}
        user={user}
        isAdmin={isAdmin}
      />
    </div>
  );
}
