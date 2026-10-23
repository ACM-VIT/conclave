export const ROOM_AI_PROVIDERS = ["openai", "anthropic", "sarvam"] as const;
export type RoomAiProvider = (typeof ROOM_AI_PROVIDERS)[number];
export type RoomAiState = Record<
  RoomAiProvider,
  {
    source: "deployment" | "room" | null;
    ownerId?: string;
  }
>;
export type RoomAiIdentity = {
  roomId: string;
  channelId: string;
  clientId: string;
  userId: string;
};

export const emptyRoomAiState = (): RoomAiState => ({
  openai: { source: null },
  anthropic: { source: null },
  sarvam: { source: null },
});
export const isRoomAiProvider = (value: unknown): value is RoomAiProvider =>
  typeof value === "string" &&
  ROOM_AI_PROVIDERS.some((provider) => provider === value);
