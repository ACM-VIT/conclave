import { createOpenAiClient } from "@conclave/ai/server";
import { readAiEnvironment } from "@conclave/ai/models";
import { AI_DEFAULT_MODELS } from "@conclave/ai/models";
import type { ModerationCreateParams } from "openai/resources/moderations";
import { getOpenAiClient } from "./openaiClient.js";

export const CHAT_IMAGE_MODERATION_MODEL = AI_DEFAULT_MODELS.moderation;

type ModerationResponse = {
  results: Array<{
    flagged: boolean;
    categories: object;
  }>;
  _request_id?: string | null;
};

export type ChatImageModerationClient = {
  moderations: {
    create(
      body: ModerationCreateParams,
      options?: { timeout?: number },
    ): Promise<ModerationResponse>;
  };
};

export type ChatImageModerationResult = {
  blocked: boolean;
  categories: string[];
  requestId?: string;
};

export type ModerateChatImageOptions = {
  data: Buffer;
  mimeType: string;
  timeoutMs: number;
  client?: ChatImageModerationClient;
  apiKey?: string;
};

export const moderateChatImage = async ({
  data,
  mimeType,
  timeoutMs,
  client,
  apiKey,
}: ModerateChatImageOptions): Promise<ChatImageModerationResult> => {
  const response = await (
    client ??
    (apiKey
      ? createOpenAiClient(readAiEnvironment(process.env), apiKey)
      : getOpenAiClient())
  ).moderations.create(
    {
      model: CHAT_IMAGE_MODERATION_MODEL,
      input: [
        {
          type: "image_url",
          image_url: {
            url: `data:${mimeType};base64,${data.toString("base64")}`,
          },
        },
      ],
    },
    { timeout: timeoutMs },
  );
  const result = response.results[0];
  if (!result) {
    throw new Error("OpenAI image moderation returned an invalid response.");
  }

  const categories = Object.entries(result.categories)
    .filter((entry): entry is [string, true] => entry[1] === true)
    .map(([category]) => category);

  return {
    blocked: result.flagged,
    categories,
    requestId: response._request_id || undefined,
  };
};
