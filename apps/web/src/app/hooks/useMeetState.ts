"use client";

import { useReducer, useState } from "react";
import { participantReducer } from "../lib/participant-reducer";
import type {
  ConnectionState,
  MeetError,
  Participant,
  WebinarConfigSnapshot,
} from "../lib/types";

interface UseMeetStateOptions {
  initialRoomId?: string;
}

export function useMeetState({ initialRoomId }: UseMeetStateOptions) {
  const [connectionState, setConnectionState] =
    useState<ConnectionState>("disconnected");
  const [roomId, setRoomId] = useState(initialRoomId ?? "default-room");
  const [isMuted, setIsMuted] = useState(true);
  const [isCameraOff, setIsCameraOff] = useState(true);
  const [isScreenSharing, setIsScreenSharing] = useState(false);
  const [isHandRaised, setIsHandRaised] = useState(false);
  const [isGhostMode, setIsGhostMode] = useState(false);
  const [activeScreenShareId, setActiveScreenShareId] = useState<string | null>(
    null,
  );
  const [participants, dispatchParticipants] = useReducer(
    participantReducer,
    new Map(),
  );
  const [localStream, setLocalStream] = useState<MediaStream | null>(null);
  const [activeSpeakerId, setActiveSpeakerId] = useState<string | null>(null);
  const [meetError, setMeetError] = useState<MeetError | null>(null);
  const [waitingMessage, setWaitingMessage] = useState<string | null>(null);
  const [pendingUsers, setPendingUsers] = useState<Map<string, string>>(
    new Map(),
  );
  const [isParticipantsOpen, setIsParticipantsOpen] = useState(false);
  const [isRoomLocked, setIsRoomLocked] = useState(false);
  const [isNoGuests, setIsNoGuests] = useState(false);
  const [isChatLocked, setIsChatLocked] = useState(false);
  const [isTtsDisabled, setIsTtsDisabled] = useState(false);
  const [isDmEnabled, setIsDmEnabled] = useState(true);
  const [isBrowserAudioMuted, setIsBrowserAudioMuted] = useState(false);
  const [hostUserId, setHostUserId] = useState<string | null>(null);
  const [isNetworkOffline, setIsNetworkOffline] = useState(false);
  const [meetingRequiresInviteCode, setMeetingRequiresInviteCode] =
    useState(false);
  const [webinarConfig, setWebinarConfig] =
    useState<WebinarConfigSnapshot | null>(null);
  const [webinarRole, setWebinarRole] = useState<
    "attendee" | "participant" | "host" | null
  >(null);
  const [webinarLink, setWebinarLink] = useState<string | null>(null);
  const [webinarSpeakerUserId, setWebinarSpeakerUserId] = useState<string | null>(
    null,
  );
  const [serverRestartNotice, setServerRestartNotice] = useState<string | null>(
    null,
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
    isDmEnabled,
    setIsDmEnabled,
    isBrowserAudioMuted,
    setIsBrowserAudioMuted,
    hostUserId,
    setHostUserId,
    isNetworkOffline,
    setIsNetworkOffline,
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
