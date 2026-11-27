"use client";

import { useCallback, useState } from "react";
import type { RoomInfo } from "@/lib/sfu-types";

interface UseMeetRoomsOptions {
  isAdmin?: boolean;
  getRooms?: () => Promise<RoomInfo[]>;
  getRoom?: (roomId: string) => Promise<RoomInfo | null>;
}

export function useMeetRooms({
  isAdmin = false,
  getRooms,
  getRoom,
}: UseMeetRoomsOptions) {
  const [availableRooms, setAvailableRooms] = useState<RoomInfo[]>([]);

  const refreshRooms = useCallback(async (roomId?: string) => {
    const normalizedRoomId = roomId?.trim();
    if (normalizedRoomId && !getRoom) return;
    if (!normalizedRoomId && (!isAdmin || !getRooms)) return;

    try {
      if (normalizedRoomId) {
        const room = await getRoom?.(normalizedRoomId);
        setAvailableRooms(room ? [room] : []);
      } else {
        const rooms = await getRooms?.();
        setAvailableRooms(Array.isArray(rooms) ? rooms : []);
      }
    } catch (_error) {
      setAvailableRooms([]);
    }
  }, [getRoom, getRooms, isAdmin]);

  return {
    availableRooms,
    refreshRooms,
  };
}
