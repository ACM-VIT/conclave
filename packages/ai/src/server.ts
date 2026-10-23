import { getResponseProvider } from "@conclave/ai/models";
import { createOpenAiTextSession, generateOpenAiText } from "#openai";
import { createAnthropicTextSession, generateAnthropicText } from "#anthropic";
import type { AiTextOptions, AiTextSession } from "#types";

export type * from "#types";
export { createOpenAiClient } from "#openai";
export { describeAiError } from "#errors";

export const generateAiText = (
  options: AiTextOptions & { input: string },
): Promise<string> => {
  const signal = options.timeoutMs
    ? AbortSignal.any([
        ...(options.signal ? [options.signal] : []),
        AbortSignal.timeout(options.timeoutMs),
      ])
    : options.signal;
  const request = { ...options, signal };
  return getResponseProvider(options.model) === "anthropic"
    ? generateAnthropicText(request)
    : generateOpenAiText(request);
};

export const createAiTextSession = (options: AiTextOptions): AiTextSession =>
  getResponseProvider(options.model) === "anthropic"
    ? createAnthropicTextSession(options)
    : createOpenAiTextSession(options);
