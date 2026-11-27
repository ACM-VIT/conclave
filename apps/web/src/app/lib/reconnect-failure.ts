/** What telemetry records about a reconnect failure, in place of its message. */
export type ReconnectFailureKind =
  | "no_reason"
  | "timeout"
  | "permission"
  | "local_media"
  | "missing_room"
  | "network"
  | "other";

const KIND_PATTERNS: Array<[RegExp, ReconnectFailureKind]> = [
  [/timeout/i, "timeout"],
  [/permission|notallowed/i, "permission"],
  [/missing live local media/i, "local_media"],
  [/missing room id/i, "missing_room"],
  [/xhr poll|websocket|transport|socket|network|fetch/i, "network"],
];

const DESCRIPTIONS: Record<Exclude<ReconnectFailureKind, "other">, string> = {
  no_reason: "The meeting server did not return an error reason.",
  timeout: "The meeting server did not respond before the timeout.",
  permission: "Browser permission is blocking camera or microphone access.",
  local_media:
    "Local media was not ready yet. We will rejoin the room first and retry your devices.",
  missing_room: "The meeting room could not be found for reconnect.",
  network: "The browser could not reach the meeting server.",
};

export const reconnectErrorMessage = (error: unknown): string => {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  return "";
};

export function reconnectFailureKind(error: unknown): ReconnectFailureKind {
  const message = reconnectErrorMessage(error).trim();
  if (!message) return "no_reason";
  return KIND_PATTERNS.find(([pattern]) => pattern.test(message))?.[1] ?? "other";
}

/** Text for the reconnect screen. Any other message is shown as the server wrote it. */
export function describeReconnectFailure(error: unknown): string {
  const kind = reconnectFailureKind(error);
  return kind === "other"
    ? reconnectErrorMessage(error).trim()
    : DESCRIPTIONS[kind];
}
