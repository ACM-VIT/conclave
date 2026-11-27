import type { AppsSyncError, AppsSyncResponse } from "../types/index";

// An SFU from before retryable refusals sends only this when a socket's sync
// budget is spent, with no `retryable` field. It is worth retrying.
const LEGACY_RATE_LIMIT_ERROR = "Too many app sync requests";

export type SyncReply =
  | { kind: "synced"; response: AppsSyncResponse }
  | { kind: "retry"; afterMs: number }
  | { kind: "final" };

// What a sync run does with the answer to one `apps:yjs:sync`, or with no
// answer before its timeout. A retry waits at least `afterMs`, and never less
// than the run's own backoff.
export const classifySyncReply = (
  response: AppsSyncResponse | AppsSyncError | undefined,
): SyncReply => {
  if (!response) return { kind: "retry", afterMs: 0 };
  if (!("error" in response)) return { kind: "synced", response };
  if (response.retryable === true) {
    const hint = response.retryAfterMs;
    const afterMs = typeof hint === "number" && Number.isFinite(hint) ? Math.max(hint, 0) : 0;
    return { kind: "retry", afterMs };
  }
  if (!("retryable" in response) && response.error === LEGACY_RATE_LIMIT_ERROR) {
    return { kind: "retry", afterMs: 0 };
  }
  return { kind: "final" };
};
