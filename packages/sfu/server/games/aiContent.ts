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
const WEB_SEARCH_REQUEST_TIMEOUT_MS = 60_000;
const GAME_AI_WEB_SEARCH_TOOL: WebSearchTool = {
  type: "web_search",
  search_context_size: sfuConfig.gameAi.webSearchContextSize,
};

const GAME_CONTENT_SYSTEM_INSTRUCTIONS = [
  "You create high-quality party-game content for people playing together in a live video meeting.",
  "Follow the requested game, topic, task instructions, and response schema exactly. Return only content that belongs in the schema; do not add commentary, citations, URLs, source lists, or extra fields unless the schema explicitly requests them.",
  "Interpret the topic according to the user's likely intent and the mechanics of the named game. Make every item immediately understandable, playable, distinct from the other items, and concise enough to read aloud or display in a compact game interface.",
  "Prefer concrete, vivid, broadly recognizable ideas over vague wording. Preserve useful variety across difficulty, framing, subject, and answer shape without drifting away from the requested topic.",
  "Avoid duplicates, near-duplicates, answer leakage, ambiguous wording, impossible tasks, trick questions that depend on unstated assumptions, and content that requires participants to reveal private or sensitive information.",
  "The audience may be mixed in age, background, culture, and familiarity with the topic. Keep the content welcoming and suitable for a general social setting. Do not generate hateful, harassing, sexually explicit, graphically violent, dangerous, humiliating, or targeted personal content.",
  "When factual claims matter, favor accuracy over novelty. Do not fabricate events, people, quotations, statistics, titles, or other details. If reliable specificity is unavailable, use a sounder and more timeless alternative that still fits the topic.",
  "Treat the supplied output schema as a strict contract. Satisfy every required field, respect all stated limits and types, and ensure the complete response is valid JSON matching that schema.",
].join("\n");

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

  const now = new Date();
  const currentDate = now.toISOString().slice(0, 10);
  const currentDay = new Intl.DateTimeFormat("en-US", {
    weekday: "long",
    timeZone: "UTC",
  }).format(now);
  const systemInstructions = [
    GAME_CONTENT_SYSTEM_INSTRUCTIONS,
    sfuConfig.gameAi.webSearchEnabled
      ? [
          "You have access to web search. Decide for yourself whether searching would materially improve the accuracy, freshness, specificity, relevance, or safety of the requested game content.",
          "Search whenever it is useful, including when the request depends on information you are not confident is correct or complete. Do not search when the task can be answered reliably without it.",
          "When you search, use the retrieved information to produce the requested game content, reconcile conflicting or uncertain details conservatively, and never invent unsupported facts.",
        ].join("\n")
      : "Web search is unavailable. Do not imply that uncertain or time-sensitive information has been verified; prefer reliable, timeless alternatives when necessary.",
    `Current date and day (UTC): ${currentDate}, ${currentDay}.`,
  ].join("\n\n");
  const input = [
    `Game: ${gameName}`,
    `Topic: ${cleanTopic}`,
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
      resolveRequestTimeoutMs(),
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

const resolveRequestTimeoutMs = (): number => {
  if (!sfuConfig.gameAi.webSearchEnabled) {
    return sfuConfig.gameAi.timeoutMs;
  }
  return Math.max(sfuConfig.gameAi.timeoutMs, WEB_SEARCH_REQUEST_TIMEOUT_MS);
};

const parseStrictJson = (value: string): unknown | null => {
  try {
    return JSON.parse(value) as unknown;
  } catch (_error) {
    return null;
  }
};
