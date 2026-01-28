import { useReducer, useState } from "react";
import { participantReducer } from "../participant-reducer";
import type { ConnectionState, MeetError, Participant } from "../types";

interface UseMeetStateOptions {
  initialRoomId?: string;
}

export function useMeetState({ initialRoomId }: UseMeetStateOptions) {
  const [connectionState, setConnectionState] =
    useState<ConnectionState>("disconnected");
  const [roomId, setRoomId] = useState(initialRoomId ?? "");
  const [isMuted, setIsMuted] = useState(true);
  const [isCameraOff, setIsCameraOff] = useState(true);
  const [isScreenSharing, setIsScreenSharing] = useState(false);
  const [isHandRaised, setIsHandRaised] = useState(false);
  const [isGhostMode, setIsGhostMode] = useState(false);
  const [activeScreenShareId, setActiveScreenShareId] = useState<
    string | null
  >(null);
  const [participants, dispatchParticipants] = useReducer(
    participantReducer,
    new Map<string, Participant>()
  );
  const [localStream, setLocalStream] = useState<MediaStream | null>(null);
  const [activeSpeakerId, setActiveSpeakerId] = useState<string | null>(null);
  const [meetError, setMeetError] = useState<MeetError | null>(null);
  const [waitingMessage, setWaitingMessage] = useState<string | null>(null);
  const [pendingUsers, setPendingUsers] = useState<Map<string, string>>(
    new Map()
  );
  const [isParticipantsOpen, setIsParticipantsOpen] = useState(false);
  const [isRoomLocked, setIsRoomLocked] = useState(false);

  return {
    connectionState,
    setConnectionState,
    roomId,
    setRoomId,
    isMuted,
    setIsMuted,
    isCameraOff,
    setIsCameraOff,
    isScreenSharing,
    setIsScreenSharing,
    isHandRaised,
    setIsHandRaised,
    isGhostMode,
    setIsGhostMode,
    activeScreenShareId,
    setActiveScreenShareId,
    participants,
    dispatchParticipants,
    localStream,
    setLocalStream,
    activeSpeakerId,
    setActiveSpeakerId,
    meetError,
    setMeetError,
    waitingMessage,
    setWaitingMessage,
    pendingUsers,
    setPendingUsers,
    isParticipantsOpen,
    setIsParticipantsOpen,
    isRoomLocked,
    setIsRoomLocked,
  };
}
