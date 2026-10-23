import type { AiEnvironment } from "@conclave/ai/models";
import {
  roomAiFeatureSettingsFromEnvironment,
  type RoomAiFeatureSettings,
} from "@conclave/ai/room-settings";
import { config } from "../config/config.js";

// Deployment values establish defaults; explicit room choices override them.
// Discovery, the settings UI and inference must see the same effective profile.
export function roomAiFeatureDefaults(
  env: AiEnvironment,
  features = roomAiFeatureSettingsFromEnvironment(env),
): RoomAiFeatureSettings {
  return {
    ...features,
    images: {
      timeoutMs: config.chatImageModeration.timeoutMs,
      ...features.images,
    },
    games: {
      model:
        env.CONCLAVE_ASSISTANT_MODEL ||
        env.SFU_GAME_AI_MODEL ||
        config.gameAi.model,
      maxOutputTokens: config.gameAi.maxOutputTokens,
      timeoutMs: config.gameAi.timeoutMs,
      searchEnabled: config.gameAi.webSearchEnabled,
      ...features.games,
    },
  };
}
