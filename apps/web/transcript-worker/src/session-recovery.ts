import type {
  TranscriptServiceVersion,
  TranscriptSessionState,
} from "@conclave/meeting-core/transcript-types";

export const TRANSCRIPT_WORKER_UPDATED_MESSAGE =
  "Transcript worker updated. Resume or take over to keep transcription running.";

export const TRANSCRIPT_RELAY_RECOVERED_MESSAGE =
  "Transcript relay recovered. Resume or take over to keep transcription running.";

const ACTIVE_RECOVERY_STATUSES = new Set<TranscriptSessionState["status"]>([
  "live",
  "starting",
  "stopping",
]);

const shouldTreatAsServiceUpdate = (
  snapshotVersion: TranscriptServiceVersion | undefined,
  currentVersion: TranscriptServiceVersion,
): boolean => !snapshotVersion?.id || snapshotVersion.id !== currentVersion.id;

const isLegacyControllerDisconnect = (message: string | null | undefined) =>
  !message || /controller disconnected|recovered without/i.test(message);

export const recoverPersistedTranscriptSession = (
  session: TranscriptSessionState,
  snapshotVersion: TranscriptServiceVersion | undefined,
  currentVersion: TranscriptServiceVersion,
): TranscriptSessionState => {
  const recoveredSession: TranscriptSessionState = {
    ...session,
    transportMode:
      session.transportMode === "sfu" || session.transportMode === "browser"
        ? session.transportMode
        : "browser",
  };
  const serviceUpdated = shouldTreatAsServiceUpdate(
    snapshotVersion,
    currentVersion,
  );

  if (ACTIVE_RECOVERY_STATUSES.has(recoveredSession.status)) {
    return {
      ...recoveredSession,
      status: "takeover_needed",
      updatedAt: Date.now(),
      error: serviceUpdated
        ? TRANSCRIPT_WORKER_UPDATED_MESSAGE
        : TRANSCRIPT_RELAY_RECOVERED_MESSAGE,
    };
  }

  if (
    recoveredSession.status === "takeover_needed" &&
    serviceUpdated &&
    isLegacyControllerDisconnect(recoveredSession.error)
  ) {
    return {
      ...recoveredSession,
      updatedAt: Date.now(),
      error: TRANSCRIPT_WORKER_UPDATED_MESSAGE,
    };
  }

  return recoveredSession;
};
