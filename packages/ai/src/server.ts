import { getResponseProvider } from "@conclave/ai/models";
import { createOpenAiTextSession, generateOpenAiText } from "#openai";
import { createAnthropicTextSession, generateAnthropicText } from "#anthropic";
import type { AiTextOptions, AiTextSession } from "#types";

export type * from "#types";
export { createOpenAiClient } from "#openai";

export const generateAiText = (
  options: AiTextOptions & { input: string },
): Promise<string> =>
  getResponseProvider(options.model) === "anthropic"
    ? generateAnthropicText(options)
    : generateOpenAiText(options);

export const createAiTextSession = (options: AiTextOptions): AiTextSession =>
  getResponseProvider(options.model) === "anthropic"
    ? createAnthropicTextSession(options)
    : createOpenAiTextSession(options);
