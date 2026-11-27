import { z } from "zod";

export const ROOM_RECOVERY_PASS_USE = "room-recovery";

const roomRecoveryPassClaims = z.object({
  tokenUse: z.literal(ROOM_RECOVERY_PASS_USE),
  channelId: z.string(),
  userKey: z.string(),
  incarnationId: z.string(),
  issuedAtMs: z.number(),
  generation: z.number().optional(),
});

export type RoomRecoveryPassClaims = z.infer<typeof roomRecoveryPassClaims>;

export const parseRoomRecoveryPassClaims = (value: unknown): RoomRecoveryPassClaims | null => {
  const parsed = roomRecoveryPassClaims.safeParse(value);
  return parsed.success ? parsed.data : null;
};
