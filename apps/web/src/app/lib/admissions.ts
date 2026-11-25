import type { Socket } from "socket.io-client";
import { z } from "zod";
import { WAITING_REQUEST_GONE_ERROR } from "@conclave/meeting-core/host-commands";
import { hostDecisionLimitNotice } from "./host-decision-limit";

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

export type AdmitOutcome = { kind: "notice" | "error"; text: string } | null;

// A request the server no longer has (already admitted, denied or gone) is
// stale; the caller drops it from its list.
export const admitPendingUser = (
  socket: Socket,
  userId: string,
  handlers: { onStale?: (userId: string) => void; onNotice?: (text: string) => void } = {},
) => {
  socket.emit("admitUser", { userId }, (response: AdmissionAck) => {
    const notice = hostDecisionLimitNotice(response, "admit");
    if (notice) {
      handlers.onNotice?.(notice);
      return;
    }
    settleDecision(response, userId, handlers);
  });
};

const settleDecision = (
  response: AdmissionAck,
  userId: string,
  handlers: { onStale?: (userId: string) => void; onNotice?: (text: string) => void },
) => {
  if (!response?.error) return;
  if (response.error === WAITING_REQUEST_GONE_ERROR) handlers.onStale?.(userId);
  else handlers.onNotice?.(response.error);
};

export const denyPendingUser = (
  socket: Socket,
  userId: string,
  handlers: { onStale?: (userId: string) => void; onNotice?: (text: string) => void } = {},
) => {
  socket.emit("rejectUser", { userId }, (response: AdmissionAck) => {
    settleDecision(response, userId, handlers);
  });
};

export const admitAllPendingUsers = (
  socket: Socket,
  onDone: (outcome: AdmitOutcome) => void,
) => {
  socket
    .timeout(ADMISSION_ACK_TIMEOUT_MS)
    .emit(
      "admin:admitAllPending",
      (timeoutError: Error | null, response: unknown) => {
        const notice = timeoutError ? null : hostDecisionLimitNotice(response, "admit");
        if (notice) {
          onDone({ kind: "notice", text: notice });
          return;
        }
        const error = timeoutError
          ? "Couldn’t admit everyone."
          : readAckError(response, "Couldn’t admit everyone.");
        onDone(error ? { kind: "error", text: error } : null);
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

const CreatedAdmission = z.object({ admissionCode: z.string().min(1) });

export const createAdmission = (socket: Socket) =>
  new Promise<string>((resolve, reject) => {
    socket
      .timeout(ADMISSION_ACK_TIMEOUT_MS)
      .emit(
        "admin:createAdmission",
        {},
        (timeoutError: Error | null, response: unknown) => {
          const created = timeoutError ? undefined : CreatedAdmission.safeParse(response).data;
          if (created) {
            resolve(created.admissionCode);
            return;
          }
          reject(
            new Error(
              timeoutError
                ? "The meeting did not answer."
                : (readAckError(response, "The meeting refused.") ?? "The meeting refused."),
            ),
          );
        },
      );
  });

// Once that participant is gone its key must not stay a way in. Rejects when
// the SFU did not take it, so the caller can send it again.
export const revokeAdmission = (socket: Socket, userKey: string) =>
  emitAdmissionChange(socket, "admin:revokeAllowedUsers", userKey);
