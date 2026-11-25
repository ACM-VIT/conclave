import { z } from "zod";

export interface RejoinMedia {
  isMicOn: boolean;
  isCameraOn: boolean;
  isAudioOnly: boolean;
}

export type RejoinTarget = { roomId: string; clientId: string };

const REJOIN_STORAGE_KEY = "conclave:rejoin";
export const REJOIN_MAX_AGE_MS = 10 * 60 * 1000;

const RejoinIntent = z.object({
  roomId: z.string(),
  clientId: z.string(),
  savedAt: z.number(),
  isMicOn: z.boolean(),
  isCameraOn: z.boolean(),
  isAudioOnly: z.boolean(),
});

type RejoinStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

const sessionStore = (): RejoinStorage | null => {
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
};

const sameRoom = (a: string, b: string) =>
  a.trim().toLowerCase() === b.trim().toLowerCase() && a.trim().length > 0;

export function saveRejoinIntent(
  target: RejoinTarget,
  media: RejoinMedia,
  storage: RejoinStorage | null = sessionStore(),
  now = Date.now(),
): void {
  try {
    storage?.setItem(
      REJOIN_STORAGE_KEY,
      JSON.stringify({ ...target, savedAt: now, ...media }),
    );
  } catch {}
}

export function readRejoinIntent(
  target: RejoinTarget,
  storage: RejoinStorage | null = sessionStore(),
  now = Date.now(),
): RejoinMedia | null {
  let value: unknown;
  try {
    const raw = storage?.getItem(REJOIN_STORAGE_KEY);
    if (!raw) return null;
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  const parsed = RejoinIntent.safeParse(value);
  if (!parsed.success) return null;
  const intent = parsed.data;
  const age = now - intent.savedAt;
  if (age < 0 || age > REJOIN_MAX_AGE_MS) return null;
  if (!sameRoom(intent.roomId, target.roomId) || intent.clientId !== target.clientId) return null;
  return {
    isMicOn: intent.isMicOn,
    isCameraOn: intent.isCameraOn && !intent.isAudioOnly,
    isAudioOnly: intent.isAudioOnly,
  };
}

export function clearRejoinIntent(storage: RejoinStorage | null = sessionStore()): void {
  try {
    storage?.removeItem(REJOIN_STORAGE_KEY);
  } catch {}
}

export type RejoinMediaControls = {
  userChoices: () => number;
  isAudioOnly: () => boolean;
  isMicOn: () => boolean;
  isCameraOn: () => boolean;
  turnOnAudioOnly: () => void;
  turnOnMic: () => Promise<unknown>;
  turnOnCamera: () => Promise<unknown>;
};

export async function applyRejoinMedia(
  media: RejoinMedia,
  controls: RejoinMediaControls,
): Promise<void> {
  const choicesAtStart = controls.userChoices();
  const untouched = () => controls.userChoices() === choicesAtStart;
  if (media.isAudioOnly && untouched() && !controls.isAudioOnly()) controls.turnOnAudioOnly();
  if (media.isMicOn && untouched() && !controls.isMicOn()) await controls.turnOnMic();
  if (media.isCameraOn && untouched() && !controls.isAudioOnly() && !controls.isCameraOn()) {
    await controls.turnOnCamera();
  }
}
