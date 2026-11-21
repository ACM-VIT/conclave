import type { Socket } from "socket.io-client";

const ADMIT_ALL_ACK_TIMEOUT_MS = 10000;

type AdmissionAck = { success?: boolean; error?: string } | undefined;

const readAckError = (response: unknown, fallback: string): string | null => {
  if (!response || typeof response !== "object") return fallback;
  const result = response as { success?: unknown; error?: unknown };
  if (typeof result.error === "string" && result.error.trim()) {
    return result.error;
  }
  return result.success === true ? null : fallback;
};

// A request the server no longer has (already admitted, denied or gone) is
// stale; the caller drops it from its list.
export const admitPendingUser = (
  socket: Socket,
  userId: string,
  onStale?: (userId: string) => void,
) => {
  socket.emit("admitUser", { userId }, (response: AdmissionAck) => {
    if (response?.error) onStale?.(userId);
  });
};

export const denyPendingUser = (
  socket: Socket,
  userId: string,
  onStale?: (userId: string) => void,
) => {
  socket.emit("rejectUser", { userId }, (response: AdmissionAck) => {
    if (response?.error) onStale?.(userId);
  });
};

export const admitAllPendingUsers = (
  socket: Socket,
  onDone: (error: string | null) => void,
) => {
  socket
    .timeout(ADMIT_ALL_ACK_TIMEOUT_MS)
    .emit(
      "admin:admitAllPending",
      (timeoutError: Error | null, response: unknown) => {
        onDone(
          timeoutError
            ? "Couldn’t admit everyone."
            : readAckError(response, "Couldn’t admit everyone."),
        );
      },
    );
};
