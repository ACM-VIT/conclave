export const resolveSnapshotViewerConnectionId = (
  currentViewerConnectionId: string | null,
  snapshot: { viewerConnectionId?: string | null },
): string | null => {
  if (Object.prototype.hasOwnProperty.call(snapshot, "viewerConnectionId")) {
    return snapshot.viewerConnectionId ?? null;
  }
  return currentViewerConnectionId;
};
