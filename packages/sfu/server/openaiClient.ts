import { readAiEnvironment } from "@conclave/ai/models";
import type OpenAI from "openai";
import { createOpenAiClient } from "@conclave/ai/server";
import { config } from "../config/config.js";

let openAiClient: OpenAI | null = null;

export const getOpenAiClient = (): OpenAI => {
  if (!config.openAi.apiKey) {
    throw new Error("OpenAI is not configured.");
  }
  if (openAiClient) return openAiClient;

  openAiClient = createOpenAiClient(
    readAiEnvironment(process.env),
    config.openAi.apiKey,
  );
  return openAiClient;
};
