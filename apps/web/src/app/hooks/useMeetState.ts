"use client";

import { useCallback, useReducer, useState, type SetStateAction } from "react";
import { participantReducer } from "../lib/participant-reducer";
import { clampMeetVolume, DEFAULT_MEET_VOLUME } from "../lib/meet-volume";
import type {
  AdminNoticeNotification,
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
    new Map<string, Participant>(),
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
  const [isReactionsDisabled, setIsReactionsDisabled] = useState(false);
  const [isBrowserAudioMuted, setIsBrowserAudioMuted] = useState(false);
  const [meetVolume, setMeetVolumeValue] = useState(DEFAULT_MEET_VOLUME);
  const setMeetVolume = useCallback((value: SetStateAction<number>) => {
    setMeetVolumeValue((current) =>
      clampMeetVolume(
        typeof value === "function" ? value(current) : value,
      ),
    );
  }, []);
  const [hostUserId, setHostUserId] = useState<string | null>(null);
  const [hostUserIds, setHostUserIds] = useState<string[]>([]);
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
  const [adminNotice, setAdminNotice] =
    useState<AdminNoticeNotification | null>(null);

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
    isReactionsDisabled,
    setIsReactionsDisabled,
    isBrowserAudioMuted,
    setIsBrowserAudioMuted,
    meetVolume,
    setMeetVolume,
    hostUserId,
    setHostUserId,
    hostUserIds,
    setHostUserIds,
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
    adminNotice,
    setAdminNotice,
  };
}
