import type { AiEnvironment } from "@conclave/ai/models";
import {
  decisionModel,
  hasDecisionCredential,
  readDecisionCredentials,
  runDecisionBatches,
} from "@conclave/ai/decisions";
import {
  resolveAiFeatureSettings,
  roomAiFeatureSettingsFromEnvironment,
} from "@conclave/ai/room-settings";
import type { GameDecider } from "./types.js";

export type GameDeciderOptions = {
  fetchImpl?: typeof fetch;
  disabled?: boolean;
};

export const createGameDecider = (
  env: AiEnvironment,
  options: GameDeciderOptions = {},
): GameDecider | null => {
  const disabled = options.disabled ?? /^(0|false)$/i.test(process.env.SFU_GAME_DECISIONS_ENABLED || "");
  if (disabled) return null;
  const settings = resolveAiFeatureSettings(env, "answers", roomAiFeatureSettingsFromEnvironment(env));
  if (!settings.enabled) return null;
  const model = decisionModel(settings.model);
  if (!model) return null;
  const credentials = readDecisionCredentials(env);
  if (!hasDecisionCredential(credentials, model.provider)) return null;
  return ({ state, questions, signal }) =>
    runDecisionBatches({
      model: model.id,
      credentials,
      state,
      questions,
      signal,
      timeoutMs: settings.timeoutMs,
      fetchImpl: options.fetchImpl,
    });
};
