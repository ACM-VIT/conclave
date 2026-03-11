import React from "react";
import { Stack, useLocalSearchParams } from "expo-router";
import { MeetScreen } from "@/features/meets/components/meet-screen";

export default function WebinarRoomPage() {
  const { roomId } = useLocalSearchParams<{ roomId?: string }>();
  const resolvedRoomId = Array.isArray(roomId) ? roomId[0] : roomId;

  return (
    <>
      <Stack.Screen options={{ gestureEnabled: false }} />
      <MeetScreen
        initialRoomId={resolvedRoomId ?? ""}
        joinMode="webinar_attendee"
        autoJoinOnMount
        hideJoinUI
      />
    </>
  );
}
