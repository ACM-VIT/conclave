import type {
  ResponseCreateParamsNonStreaming,
  WebSearchTool,
} from "openai/resources/responses/responses";
import { config as sfuConfig } from "../../config/config.js";
import { Logger } from "../../utilities/loggers.js";
import { getOpenAiClient } from "../openaiClient.js";
import { textOption } from "./config.js";
import type { GameConfig, GameOptionSpec } from "./types.js";

type GeneratedContentRequest<T> = {
  gameName: string;
  topic: string;
  instructions: string;
  schemaName: string;
  schema: Record<string, unknown>;
  maxOutputTokens?: number;
  parse: (payload: unknown) => T | null;
};

const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f]/g;
const MAX_GENERATED_TEXT_LENGTH = 240;
const CURRENT_TOPIC_TIMEOUT_MS = 60_000;
const CURRENT_TOPIC_PATTERN =
  /\b(latest|recent|current|news|today|this week|this month|this year|breaking|new)\b/i;
const GAME_AI_WEB_SEARCH_TOOL: WebSearchTool = {
  type: "web_search",
  search_context_size: sfuConfig.gameAi.webSearchContextSize,
};

export const GAME_CONTENT_TOPIC_OPTION: GameOptionSpec = {
  id: "topic",
  type: "text",
  label: "Topic",
  default: "",
  placeholder: "Movies, space, team lore",
  maxLength: sfuConfig.gameAi.topicMaxLength,
};

const sanitizeTopic = (
  topic: string,
  maxLength = sfuConfig.gameAi.topicMaxLength,
): string =>
  topic
    .replace(CONTROL_CHARACTER_PATTERN, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLength)
    .trim();

export const gameContentTopic = (gameConfig: GameConfig): string =>
  sanitizeTopic(textOption(gameConfig, GAME_CONTENT_TOPIC_OPTION.id, ""));

export const cleanGeneratedText = (
  value: unknown,
  maxLength = MAX_GENERATED_TEXT_LENGTH,
): string | null => {
  if (typeof value !== "string") return null;
  const text = value
    .replace(CONTROL_CHARACTER_PATTERN, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLength)
    .trim();
  return text || null;
};

export const normalizeGeneratedKey = (text: string): string =>
  text.toLocaleLowerCase("en-US").replace(/[^a-z0-9]+/g, " ").trim();

export const cleanGeneratedStringArray = (
  value: unknown,
  options: { maxItems: number; maxLength?: number },
): string[] => {
  if (!Array.isArray(value)) return [];
  const strings: string[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    const text = cleanGeneratedText(item, options.maxLength);
    if (!text) continue;
    const key = normalizeGeneratedKey(text);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    strings.push(text);
    if (strings.length >= options.maxItems) break;
  }
  return strings;
};

export const generateStructuredGameContent = async <T>({
  gameName,
  topic,
  instructions,
  schemaName,
  schema,
  maxOutputTokens,
  parse,
}: GeneratedContentRequest<T>): Promise<T | null> => {
  const cleanTopic = sanitizeTopic(topic);
  if (!cleanTopic || !sfuConfig.gameAi.enabled) return null;

  const currentDate = new Date().toISOString().slice(0, 10);
  const needsCurrentContext = CURRENT_TOPIC_PATTERN.test(cleanTopic);
  const systemInstructions = [
    "Generate concise, safe party-game content for a live video meeting.",
    `Current date: ${currentDate}.`,
    sfuConfig.gameAi.webSearchEnabled
      ? "Web search is available. Use current web information whenever the topic asks for latest, recent, current, or news-based content."
      : "Do not invent time-sensitive facts when current information is unavailable.",
  ].join(" ");
  const input = [
    `Game: ${gameName}`,
    `Topic: ${cleanTopic}`,
    needsCurrentContext
      ? [
          "This is a current-news topic. Use fresh web context before answering.",
          "Prefer recent, verifiable developments over evergreen facts.",
          "Do not use outdated examples unless the topic asks for historical context.",
        ].join(" ")
      : null,
    instructions,
    "Keep text short, original, and appropriate for a mixed group.",
  ]
    .filter((line): line is string => Boolean(line))
    .join("\n\n");

  try {
    const payload = await runOpenAiJson(
      systemInstructions,
      input,
      schemaName,
      schema,
      maxOutputTokens ?? sfuConfig.gameAi.maxOutputTokens,
      resolveRequestTimeoutMs(needsCurrentContext),
    );
    if (payload == null) {
      Logger.warn(`[Games AI] ${gameName} returned an empty structured response`);
      return null;
    }
    const parsed = parse(payload);
    if (parsed == null) {
      Logger.warn(`[Games AI] ${gameName} response failed validation`);
    }
    return parsed;
  } catch (error) {
    Logger.warn(`[Games AI] ${gameName} generation failed`, error);
    return null;
  }
};

const runOpenAiJson = async (
  instructions: string,
  input: string,
  schemaName: string,
  schema: Record<string, unknown>,
  maxOutputTokens: number,
  timeoutMs: number,
): Promise<unknown | null> => {
  const request: ResponseCreateParamsNonStreaming = {
    model: sfuConfig.gameAi.model,
    instructions,
    input,
    max_output_tokens: Math.min(
      maxOutputTokens,
      sfuConfig.gameAi.maxOutputTokens,
    ),
    reasoning: { effort: sfuConfig.gameAi.reasoningEffort },
    store: sfuConfig.gameAi.storeResponses,
    text: {
      format: {
        type: "json_schema",
        name: schemaName,
        schema,
        strict: true,
      },
    },
  };
  if (sfuConfig.gameAi.webSearchEnabled) {
    request.tools = [GAME_AI_WEB_SEARCH_TOOL];
  }

  const response = await getOpenAiClient().responses.create(request, {
    timeout: timeoutMs,
  });
  return parseStrictJson(response.output_text);
};

const resolveRequestTimeoutMs = (needsCurrentContext: boolean): number => {
  if (!needsCurrentContext || !sfuConfig.gameAi.webSearchEnabled) {
    return sfuConfig.gameAi.timeoutMs;
  }
  return Math.max(sfuConfig.gameAi.timeoutMs, CURRENT_TOPIC_TIMEOUT_MS);
};

const parseStrictJson = (value: string): unknown | null => {
  try {
    return JSON.parse(value) as unknown;
  } catch (_error) {
    return null;
  }
};
