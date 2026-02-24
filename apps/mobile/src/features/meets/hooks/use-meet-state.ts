import { useReducer, useState } from "react";
import { participantReducer } from "../participant-reducer";
import type {
  ConnectionState,
  MeetError,
  Participant,
  WebinarConfigSnapshot,
} from "../types";

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
  const [screenShareStream, setScreenShareStream] =
    useState<MediaStream | null>(null);
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
  const [isNoGuests, setIsNoGuests] = useState(false);
  const [isChatLocked, setIsChatLocked] = useState(false);
  const [isTtsDisabled, setIsTtsDisabled] = useState(false);
  const [hostUserId, setHostUserId] = useState<string | null>(null);
  const [hostUserIds, setHostUserIds] = useState<string[]>([]);
  const [meetingRequiresInviteCode, setMeetingRequiresInviteCode] =
    useState(false);
  const [webinarConfig, setWebinarConfig] =
    useState<WebinarConfigSnapshot | null>(null);
  const [webinarRole, setWebinarRole] = useState<
    "attendee" | "participant" | "host" | null
  >(null);
  const [webinarLink, setWebinarLink] = useState<string | null>(null);
  const [webinarSpeakerUserId, setWebinarSpeakerUserId] = useState<string | null>(
    null
  );
  const [serverRestartNotice, setServerRestartNotice] = useState<string | null>(
    null
  );

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
    screenShareStream,
    setScreenShareStream,
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
    isNoGuests,
    setIsNoGuests,
    isChatLocked,
    setIsChatLocked,
    isTtsDisabled,
    setIsTtsDisabled,
    hostUserId,
    setHostUserId,
    hostUserIds,
    setHostUserIds,
    meetingRequiresInviteCode,
    setMeetingRequiresInviteCode,
    webinarConfig,
    setWebinarConfig,
    webinarRole,
    setWebinarRole,
    webinarLink,
    setWebinarLink,
    webinarSpeakerUserId,
    setWebinarSpeakerUserId,
    serverRestartNotice,
    setServerRestartNotice,
  };
}
