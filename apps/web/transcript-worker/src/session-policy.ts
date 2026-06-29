import type {
  TranscriptSessionStatus,
  TranscriptTransportMode,
} from "@conclave/meeting-core/transcript-types";

export type TranscriptStartPermissionInput = {
  canStart: boolean;
  canTakeover: boolean;
  controllerUserId: string | null | undefined;
  existingStatus: TranscriptSessionStatus | "unknown";
  isTakeover: boolean;
  viewerUserId: string;
};

export type TranscriptPermissionResult =
  | { ok: true }
  | { ok: false; message: string };

export const resolveTranscriptStartPermission = ({
  canStart,
  canTakeover,
  controllerUserId,
  existingStatus,
  isTakeover,
  viewerUserId,
}: TranscriptStartPermissionInput): TranscriptPermissionResult => {
  if (isTakeover && !canTakeover) {
    return { ok: false, message: "You cannot take over this transcript." };
  }
  if (!isTakeover && !canStart) {
    return { ok: false, message: "You cannot start this transcript." };
  }
  if (
    !isTakeover &&
    (existingStatus === "live" || existingStatus === "starting")
  ) {
    return { ok: false, message: "Transcript is already running." };
  }
  if (
    isTakeover &&
    existingStatus !== "takeover_needed" &&
    existingStatus !== "error" &&
    existingStatus !== "idle" &&
    controllerUserId !== viewerUserId
  ) {
    return { ok: false, message: "Transcript is already controlled." };
  }
  return { ok: true };
};

export const canStopTranscriptSession = (options: {
  controllerUserId: string | null | undefined;
  viewerCanStop: boolean;
  viewerUserId: string;
}): boolean =>
  options.viewerCanStop || options.controllerUserId === options.viewerUserId;

export const canRefreshTranscriptMinutes = (options: {
  viewerCanAsk: boolean;
}): boolean => options.viewerCanAsk;

export const shouldRequestControllerHandoff = (options: {
  closingConnectionId?: string;
  closingUserId: string;
  controllerConnectionId?: string | null;
  controllerUserId: string | null | undefined;
  remainingUserIds: Iterable<string>;
}): boolean => {
  if (options.controllerConnectionId) {
    return options.controllerConnectionId === options.closingConnectionId;
  }
  if (options.controllerUserId !== options.closingUserId) return false;
  for (const userId of options.remainingUserIds) {
    if (userId === options.closingUserId) return false;
  }
  return true;
};

export const shouldRequestSfuRelayHandoff = (options: {
  closingViewerCanRelayAudio: boolean;
  sessionStatus: TranscriptSessionStatus | null | undefined;
  transportMode: TranscriptTransportMode | null | undefined;
}): boolean =>
  options.closingViewerCanRelayAudio &&
  options.transportMode === "sfu" &&
  (options.sessionStatus === "live" || options.sessionStatus === "starting");
