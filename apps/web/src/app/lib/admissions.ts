import type { Socket } from "socket.io-client";

const ADMISSION_ACK_TIMEOUT_MS = 10000;

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
    .timeout(ADMISSION_ACK_TIMEOUT_MS)
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

const emitAdmissionChange = (socket: Socket, event: string, userKey: string) =>
  new Promise<void>((resolve, reject) => {
    socket
      .timeout(ADMISSION_ACK_TIMEOUT_MS)
      .emit(
        event,
        { userKeys: [userKey] },
        (timeoutError: Error | null, response: unknown) => {
          const error = timeoutError
            ? "The meeting did not answer."
            : readAckError(response, "The meeting refused.");
          if (error) {
            reject(new Error(error));
            return;
          }
          resolve();
        },
      );
  });

// Lets a participant this host is bringing in, such as the voice agent, join
// a locked meeting without knocking. The SFU takes this from hosts only, and
// it admits that one key and nobody else.
export const admitBeforeJoin = (socket: Socket, userKey: string) =>
  emitAdmissionChange(socket, "admin:allowUsers", userKey);

// Once that participant is gone its key must not stay a way in. Rejects when
// the SFU did not take it, so the caller can send it again.
export const revokeAdmission = (socket: Socket, userKey: string) =>
  emitAdmissionChange(socket, "admin:revokeAllowedUsers", userKey);
