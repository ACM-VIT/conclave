"use client";

import { useCallback, useState } from "react";
import type { RoomInfo } from "@/lib/sfu-types";

interface UseMeetRoomsOptions {
  // Kept for call-site compatibility; occupancy is now fetched for everyone so
  // guests can see who's already in a room before joining.
  isAdmin?: boolean;
  getRooms?: () => Promise<RoomInfo[]>;
}

export function useMeetRooms({ getRooms }: UseMeetRoomsOptions) {
  const [availableRooms, setAvailableRooms] = useState<RoomInfo[]>([]);
  const [roomsStatus, setRoomsStatus] = useState<"idle" | "loading" | "error">(
    "idle"
  );

  const refreshRooms = useCallback(async () => {
    if (!getRooms) return;
    setRoomsStatus("loading");

    try {
      const rooms = await getRooms();
      setAvailableRooms(Array.isArray(rooms) ? rooms : []);
      setRoomsStatus("idle");
    } catch (_error) {
      setRoomsStatus("error");
      setAvailableRooms([]);
    }
  }, [getRooms]);

  return {
    availableRooms,
    roomsStatus,
    refreshRooms,
  };
}
