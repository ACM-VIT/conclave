import React from "react";
import { useLocalSearchParams } from "expo-router";
import { MeetScreen } from "@/features/meets/components/meet-screen";

export default function RoomPage() {
  const { roomId } = useLocalSearchParams<{ roomId?: string }>();
  const resolvedRoomId = Array.isArray(roomId) ? roomId[0] : roomId;
  return <MeetScreen initialRoomId={resolvedRoomId ?? ""} />;
}
