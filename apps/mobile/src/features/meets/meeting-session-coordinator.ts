import type { ConnectionState } from "./types";

type HandoffReason = "takeover";

type SessionSnapshot = {
  roomId: string | null;
  connectionState: ConnectionState;
  hasActiveCall: boolean;
};

type SessionController = {
  getSnapshot: () => SessionSnapshot;
  relinquish: (reason: HandoffReason) => Promise<void> | void;
};

type SessionOwner = SessionSnapshot & { sessionId: string };

type ClaimMeetingSessionOptions = {
  confirmTakeover?: (owner: SessionOwner) => Promise<boolean> | boolean;
};

const sessions = new Map<string, SessionController>();
const engagedStates = new Set<ConnectionState>([
  "connecting",
  "connected",
  "joining",
  "joined",
  "reconnecting",
  "waiting",
]);

let ownerSessionId: string | null = null;
let queue = Promise.resolve();

const isSessionEngaged = (session: SessionController) => {
  const snapshot = session.getSnapshot();
  return snapshot.hasActiveCall || engagedStates.has(snapshot.connectionState);
};

const runQueued = async <T>(task: () => Promise<T>): Promise<T> => {
  const previous = queue;
  let release: (() => void) | null = null;
  queue = new Promise<void>((resolve) => {
    release = resolve;
  });

  await previous;
  try {
    return await task();
  } finally {
    release?.();
  }
};

export const registerMeetingSession = (
  sessionId: string,
  controller: SessionController
) => {
  sessions.set(sessionId, controller);
  if (!ownerSessionId) {
    ownerSessionId = sessionId;
  }

  return () => {
    sessions.delete(sessionId);

    if (ownerSessionId !== sessionId) {
      return;
    }

    ownerSessionId = null;
    for (const [candidateId, candidate] of sessions.entries()) {
      if (isSessionEngaged(candidate)) {
        ownerSessionId = candidateId;
        return;
      }
    }

    const firstAvailable = sessions.keys().next();
    ownerSessionId = firstAvailable.done ? null : firstAvailable.value;
  };
};

export const claimMeetingSession = async (
  sessionId: string,
  options?: ClaimMeetingSessionOptions
): Promise<boolean> => {
  return runQueued(async () => {
    const currentOwnerId = ownerSessionId;
    if (currentOwnerId && currentOwnerId !== sessionId) {
      const ownerSession = sessions.get(currentOwnerId);
      if (ownerSession && isSessionEngaged(ownerSession)) {
        const ownerSnapshot: SessionOwner = {
          sessionId: currentOwnerId,
          ...ownerSession.getSnapshot(),
        };
        if (options?.confirmTakeover) {
          const approved = await options.confirmTakeover(ownerSnapshot);
          if (!approved) {
            return false;
          }
        }
        try {
          await ownerSession.relinquish("takeover");
        } catch (error) {
          console.error("[MeetSessionCoordinator] Handoff failed:", error);
        }
      }
    }

    ownerSessionId = sessionId;
    return true;
  });
};
