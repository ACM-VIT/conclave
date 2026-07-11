import OpenAI from "openai";
import { config } from "../config/config.js";

let openAiClient: OpenAI | null = null;

export const getOpenAiClient = (): OpenAI => {
  if (!config.openAi.apiKey) {
    throw new Error("OpenAI is not configured.");
  }
  if (openAiClient) return openAiClient;

  openAiClient = new OpenAI({
    apiKey: config.openAi.apiKey,
    maxRetries: config.openAi.maxRetries,
  });
  return openAiClient;
};
