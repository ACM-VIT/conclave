import { z } from "zod";

export type PrejoinMedia = { isMicOn: boolean; isCameraOn: boolean; isAudioOnly: boolean };
export type PrejoinTarget = { roomCode: string; clientId: string };

const PREJOIN_HANDOFF_KEY = "conclave:prejoin-handoff";
export const PREJOIN_HANDOFF_MAX_AGE_MS = 60_000;

const PrejoinHandoff = z.object({
  roomCode: z.string().min(1),
  clientId: z.string().min(1),
  savedAt: z.number(),
  isMicOn: z.boolean(),
  isCameraOn: z.boolean(),
  isAudioOnly: z.boolean(),
});

type HandoffStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

const sessionStore = (): HandoffStorage | null => {
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
};

export function savePrejoinHandoff(
  target: PrejoinTarget,
  media: PrejoinMedia,
  storage: HandoffStorage | null = sessionStore(),
  now = Date.now(),
): void {
  try {
    storage?.setItem(
      PREJOIN_HANDOFF_KEY,
      JSON.stringify({ ...target, savedAt: now, ...media }),
    );
  } catch {}
}

export function takePrejoinHandoff(
  target: PrejoinTarget,
  storage: HandoffStorage | null = sessionStore(),
  now = Date.now(),
): PrejoinMedia | null {
  let raw: string | null = null;
  try {
    raw = storage?.getItem(PREJOIN_HANDOFF_KEY) ?? null;
    storage?.removeItem(PREJOIN_HANDOFF_KEY);
  } catch {
    return null;
  }
  if (!raw) return null;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  const parsed = PrejoinHandoff.safeParse(value);
  if (!parsed.success) return null;
  const handoff = parsed.data;
  const age = now - handoff.savedAt;
  if (age < 0 || age > PREJOIN_HANDOFF_MAX_AGE_MS) return null;
  if (handoff.roomCode !== target.roomCode || handoff.clientId !== target.clientId) return null;
  return {
    isMicOn: handoff.isMicOn,
    isCameraOn: handoff.isCameraOn && !handoff.isAudioOnly,
    isAudioOnly: handoff.isAudioOnly,
  };
}
