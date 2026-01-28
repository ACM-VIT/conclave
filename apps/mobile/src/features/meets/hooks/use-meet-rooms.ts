
import { useCallback, useState } from "react";
import type { RoomInfo } from "@/lib/sfu-types";

interface UseMeetRoomsOptions {
  isAdmin: boolean;
  getRooms?: () => Promise<RoomInfo[]>;
}

export function useMeetRooms({ isAdmin, getRooms }: UseMeetRoomsOptions) {
  const [availableRooms, setAvailableRooms] = useState<RoomInfo[]>([]);
  const [roomsStatus, setRoomsStatus] = useState<"idle" | "loading" | "error">(
    "idle"
  );

  const refreshRooms = useCallback(async () => {
    if (!isAdmin || !getRooms) return;
    setRoomsStatus("loading");

    try {
      const rooms = await getRooms();
      setAvailableRooms(Array.isArray(rooms) ? rooms : []);
      setRoomsStatus("idle");
    } catch (_error) {
      setRoomsStatus("error");
      setAvailableRooms([]);
    }
  }, [getRooms, isAdmin]);

  return {
    availableRooms,
    roomsStatus,
    refreshRooms,
  };
}
