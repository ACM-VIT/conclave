export interface JoinRoomAnswerFields {
  roomId?: string;
  activeSpeakerId?: string | null;
  status?: "waiting" | "joined";
  hostUserId?: string | null;
  hostUserIds?: string[];
  isLocked?: boolean;
  isTtsDisabled?: boolean;
  isChatLocked?: boolean;
  isDmEnabled?: boolean;
  areImageAttachmentsEnabled?: boolean;
  isReactionsDisabled?: boolean;
  isParticipantUnmuteAllowed?: boolean;
  isParticipantVideoAllowed?: boolean;
  meetingRequiresInviteCode?: boolean;
  webinarRole?: "attendee" | "participant" | "host";
  isWebinarEnabled?: boolean;
  webinarLocked?: boolean;
  webinarRequiresInviteCode?: boolean;
  webinarAttendeeCount?: number;
  webinarMaxAttendees?: number;
  webinarQaEnabled?: boolean;
  webinarSpeakerUserId?: string | null;
  reportsSenderPacketCounts?: true;
}
