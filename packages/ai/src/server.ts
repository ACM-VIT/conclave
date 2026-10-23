import {
  getResponseProvider,
  isBuiltInResponseModel,
} from "@conclave/ai/models";
import { fetchAiModelCatalog } from "#catalog-server";
import { createOpenAiTextSession, generateOpenAiText } from "#openai";
import { createAnthropicTextSession, generateAnthropicText } from "#anthropic";
import type { AiTextOptions, AiTextSession } from "#types";

export type * from "#types";
export { createOpenAiClient } from "#openai";
export { AiTaskLimitError, describeAiError } from "#errors";
export { fetchAiModelCatalog };

async function resolveDiscoveredOptions(
  options: AiTextOptions,
): Promise<AiTextOptions> {
  if (isBuiltInResponseModel(options.model)) return options;
  const catalog = await fetchAiModelCatalog({
    ...options,
    provider: getResponseProvider(options.model),
  });
  if (catalog.source !== "live")
    throw Object.assign(
      new Error(
        "Could not verify the selected model. Refresh models and retry.",
      ),
      catalog.status === 401 ? { status: 401 } : {},
    );
  const model = catalog.models.find((entry) => entry.id === options.model);
  if (!model)
    throw Object.assign(
      new Error("The selected model is unavailable for this account."),
      { status: 404 },
    );
  return {
    ...options,
    maxOutputTokens: Math.min(
      options.maxOutputTokens,
      Math.max(model.minutesMaxOutputTokens, model.qaMaxOutputTokens),
    ),
  };
}

export const generateAiText = async (
  options: AiTextOptions & { input: string },
): Promise<string> => {
  const signal = options.timeoutMs
    ? AbortSignal.any([
        ...(options.signal ? [options.signal] : []),
        AbortSignal.timeout(options.timeoutMs),
      ])
    : options.signal;
  const request = {
    ...options,
    ...(await resolveDiscoveredOptions({ ...options, signal })),
    signal,
  };
  return getResponseProvider(options.model) === "anthropic"
    ? generateAnthropicText(request)
    : generateOpenAiText(request);
};

const createProviderSession = (options: AiTextOptions): AiTextSession =>
  getResponseProvider(options.model) === "anthropic"
    ? createAnthropicTextSession(options)
    : createOpenAiTextSession(options);

export const createAiTextSession = (options: AiTextOptions): AiTextSession => {
  let session: AiTextSession | undefined;
  return {
    async *stream(input) {
      session ??= createProviderSession(
        await resolveDiscoveredOptions(options),
      );
      yield* session.stream(input);
    },
  };
};
