export const resolveSnapshotViewerConnectionId = (
  currentViewerConnectionId: string | null,
  snapshot: { viewerConnectionId?: string | null },
): string | null => {
  if (Object.prototype.hasOwnProperty.call(snapshot, "viewerConnectionId")) {
    return snapshot.viewerConnectionId ?? null;
  }
  return currentViewerConnectionId;
};

const RECOVERED_TRANSCRIPT_ERROR_PATTERN =
  /\brelay\b|transcript(?:ion)? audio|reconnect|controller disconnected|worker updated|resume or take over/i;

export const clearRecoveredTranscriptError = (
  currentError: string | null,
): string | null =>
  currentError && RECOVERED_TRANSCRIPT_ERROR_PATTERN.test(currentError)
    ? null
    : currentError;
