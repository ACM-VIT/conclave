// The meeting this tab was last let into. A rejoin (a reconnect, or a join
// after a reload) may reopen that room if it closed under the call, and the
// SFU's recovery pass gets the tab back in without knocking. It is per tab,
// and survives a reload: sessionStorage, with memory for when that is blocked.

const STORAGE_KEY = "conclave:joined-room";

export type JoinedRoom = {
  roomId: string;
  recoveryPass: string | null;
};

let cached: JoinedRoom | null | undefined;

const readStored = (): JoinedRoom | null => {
  try {
    const parsed = JSON.parse(
      window.sessionStorage.getItem(STORAGE_KEY) ?? "null",
    ) as Partial<JoinedRoom> | null;
    if (typeof parsed?.roomId !== "string" || !parsed.roomId) return null;
    return {
      roomId: parsed.roomId,
      recoveryPass:
        typeof parsed.recoveryPass === "string" ? parsed.recoveryPass : null,
    };
  } catch {
    return null;
  }
};

export const rememberJoinedRoom = (
  roomId: string,
  recoveryPass: string | null | undefined,
): void => {
  cached = { roomId, recoveryPass: recoveryPass ?? null };
  try {
    window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify(cached));
  } catch {}
};

// The tab was put out for good: removed, or the meeting ended.
export const forgetJoinedRoom = (): void => {
  cached = null;
  try {
    window.sessionStorage.removeItem(STORAGE_KEY);
  } catch {}
};

export const getJoinedRoom = (roomId: string): JoinedRoom | null => {
  if (typeof window === "undefined") return null;
  if (cached === undefined) cached = readStored();
  return cached?.roomId === roomId ? cached : null;
};
