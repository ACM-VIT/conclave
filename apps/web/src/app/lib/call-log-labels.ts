/**
 * Every label the call code logs a failure under, written as passed to
 * logCallError in lib/call-error-capture.ts. A label is its type: logCallError
 * takes only a CallLogLabel, so an unregistered one does not compile, and a
 * lint rule rejects console.error("[Meets] ...") calls that would bypass it.
 * Only these labels become exceptions, and only they are sent as a message.
 */
export const CALL_LOG_LABELS = [
  "[Meets] Audio play error",
  "[Meets] Audio producer recovery failed",
  "[Meets] Browser layout local video play error",
  "[Meets] Browser video play error",
  "[Meets] Camera producer recovery failed",
  "[Meets] Cannot re-join: missing room ID or local stream",
  "[Meets] Chat error",
  "[Meets] Connection error",
  "[Meets] Consume error",
  "[Meets] Consumer transport ICE restart failed",
  "[Meets] Error joining room",
  "[Meets] Error starting screen share",
  "[Meets] Failed to close stale video producer",
  "[Meets] Failed to close video producer",
  "[Meets] Failed to create consumer",
  "[Meets] Failed to create producer transport",
  "[Meets] Failed to end room",
  "[Meets] Failed to fetch meeting config",
  "[Meets] Failed to fetch transcript SFU relay status",
  "[Meets] Failed to fetch transcript token",
  "[Meets] Failed to fetch webinar config",
  "[Meets] Failed to generate webinar link",
  "[Meets] Failed to produce audio",
  "[Meets] Failed to produce raw fallback video",
  "[Meets] Failed to produce video",
  "[Meets] Failed to publish processed camera track",
  "[Meets] Failed to recover stale consumer",
  "[Meets] Failed to restart audio",
  "[Meets] Failed to restart video",
  "[Meets] Failed to rotate webinar link",
  "[Meets] Failed to set audio output device",
  "[Meets] Failed to set screen share audio output",
  "[Meets] Failed to set system audio output",
  "[Meets] Failed to start transcript SFU relay",
  "[Meets] Failed to stop transcript SFU relay",
  "[Meets] Failed to switch audio input device",
  "[Meets] Failed to switch video input device",
  "[Meets] Failed to sync producers",
  "[Meets] Failed to toggle chat lock",
  "[Meets] Failed to toggle message reaction",
  "[Meets] Failed to toggle no-guests",
  "[Meets] Failed to toggle room lock",
  "[Meets] Failed to update audio output",
  "[Meets] Failed to update meeting config",
  "[Meets] Failed to update participant media permissions",
  "[Meets] Failed to update video quality",
  "[Meets] Failed to update webinar config",
  "[Meets] Grid local video play error",
  "[Meets] Join after approval failed",
  "[Meets] Planned webcam consumer generation reset failed",
  "[Meets] Presentation video play error",
  "[Meets] Producer transport ICE restart failed",
  "[Meets] Raise hand error",
  "[Meets] Raise hand got no acknowledgement",
  "[Meets] Reaction error",
  "[Meets] Screen share audio play error",
  "[Meets] System audio play error",
  "[Meets] Video play error",
] as const;

export type CallLogLabel = (typeof CALL_LOG_LABELS)[number];

const REGISTERED: ReadonlySet<string> = new Set(CALL_LOG_LABELS);

/** Whether a value is one of the registered call-log labels, exactly. */
export const isCallLogLabel = (value: unknown): value is CallLogLabel =>
  typeof value === "string" && REGISTERED.has(value);
