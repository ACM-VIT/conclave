import React from "react";
import { Stack, useLocalSearchParams } from "expo-router";
import { MeetScreen } from "@/features/meets/components/meet-screen";

export default function WebinarRoomPage() {
  const { roomId, wt } = useLocalSearchParams<{ roomId?: string; wt?: string }>();
  const resolvedRoomId = Array.isArray(roomId) ? roomId[0] : roomId;
  const resolvedToken = Array.isArray(wt) ? wt[0] : wt;

  return (
    <>
      <Stack.Screen options={{ gestureEnabled: false }} />
      <MeetScreen
        initialRoomId={resolvedRoomId ?? ""}
        joinMode="webinar_attendee"
        webinarSignedToken={resolvedToken}
        autoJoinOnMount
        hideJoinUI
      />
    </>
  );
}
