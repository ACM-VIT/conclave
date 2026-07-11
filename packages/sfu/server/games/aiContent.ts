import { existsSync, readFileSync } from "fs";
import os from "os";
import path from "path";
import { config as sfuConfig } from "../../config/config.js";
import { Logger } from "../../utilities/loggers.js";
import { textOption } from "./config.js";
import type { GameConfig, GameOptionSpec } from "./types.js";

type WorkersAiMessage = {
  role: "system" | "user";
  content: string;
};

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
  const messages: WorkersAiMessage[] = [
    {
      role: "system",
      content: [
        "Generate concise, safe party-game content for a live video meeting.",
        `Current date: ${currentDate}.`,
        sfuConfig.gameAi.webSearchEnabled
          ? "Web search is available. Use current web information whenever the topic asks for latest, recent, current, or news-based content."
          : "Do not invent time-sensitive facts when current information is unavailable.",
      ].join(" "),
    },
    {
      role: "user",
      content: [
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
        .join("\n\n"),
    },
  ];

  try {
    const payload = await runWorkersAiJson(
      messages,
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

const runWorkersAiJson = async (
  messages: WorkersAiMessage[],
  schemaName: string,
  schema: Record<string, unknown>,
  maxOutputTokens: number,
  timeoutMs: number,
): Promise<unknown | null> => {
  const credentials = resolveWorkersAiCredentials();
  if (!credentials) return null;
  const { cloudflareAccountId, apiToken } = credentials;
  const { model } = sfuConfig.gameAi;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const modelPath = normalizeWorkersAiModelPath(model);
  const url = `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(
    cloudflareAccountId,
  )}/ai/run/${modelPath}`;
  const requestBody: Record<string, unknown> = {
    messages,
    stream: false,
    max_completion_tokens: Math.min(
      maxOutputTokens,
      sfuConfig.gameAi.maxOutputTokens,
    ),
    chat_template_kwargs: {
      enable_thinking: false,
    },
    response_format: {
      type: "json_schema",
      json_schema: {
        name: schemaName,
        schema,
        strict: true,
      },
    },
  };
  if (sfuConfig.gameAi.webSearchEnabled) {
    requestBody.web_search_options = {
      search_context_size: sfuConfig.gameAi.webSearchContextSize,
    };
  }

  try {
    const response = await fetch(url, {
      method: "POST",
      signal: controller.signal,
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${apiToken}`,
      },
      body: JSON.stringify(requestBody),
    });

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new Error(
        `Workers AI request failed with ${response.status}${
          body ? `: ${body.slice(0, 200)}` : ""
        }`,
      );
    }
    const body = (await response.json()) as unknown;
    return extractStructuredPayload(body);
  } finally {
    clearTimeout(timeout);
  }
};

const resolveRequestTimeoutMs = (needsCurrentContext: boolean): number => {
  if (!needsCurrentContext || !sfuConfig.gameAi.webSearchEnabled) {
    return sfuConfig.gameAi.timeoutMs;
  }
  return Math.max(sfuConfig.gameAi.timeoutMs, CURRENT_TOPIC_TIMEOUT_MS);
};

const normalizeWorkersAiModelPath = (model: string): string => {
  const modelPath = model.trim().replace(/^\/+/, "");
  return modelPath.startsWith("cf/") ? `@${modelPath}` : modelPath;
};

const extractStructuredPayload = (value: unknown): unknown | null => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;

  if (record.result && typeof record.result === "object") {
    const result = record.result as Record<string, unknown>;
    if (result.response && typeof result.response === "object") {
      return result.response;
    }
    if (result.output && typeof result.output === "object") {
      return result.output;
    }
    if (typeof result.response === "string") {
      return parseStrictJson(result.response);
    }
    const nested = extractStructuredPayload(result);
    if (nested != null) return nested;
  }

  if (record.response && typeof record.response === "object") return record.response;
  if (record.output && typeof record.output === "object") return record.output;

  if (typeof record.response === "string") {
    return parseStrictJson(record.response);
  }

  const choices: readonly unknown[] | null = Array.isArray(record.choices)
    ? record.choices
    : null;
  if (choices && choices.length > 0) {
    const first = choices[0];
    if (first && typeof first === "object" && !Array.isArray(first)) {
      const choice = first as Record<string, unknown>;
      const message = choice.message;
      if (message && typeof message === "object" && !Array.isArray(message)) {
        const content = (message as Record<string, unknown>).content;
        if (content && typeof content === "object") return content;
        if (typeof content === "string") return parseStrictJson(content);
      }
    }
  }

  return null;
};

const parseStrictJson = (value: string): unknown | null => {
  try {
    return JSON.parse(value) as unknown;
  } catch (_error) {
    return null;
  }
};

const resolveWorkersAiCredentials = ():
  | { cloudflareAccountId: string; apiToken: string }
  | null => {
  const cloudflareAccountId = sfuConfig.gameAi.cloudflareAccountId;
  const apiToken = sfuConfig.gameAi.apiToken || readWranglerOauthToken();
  if (!cloudflareAccountId || !apiToken) return null;
  return { cloudflareAccountId, apiToken };
};

const readWranglerOauthToken = (): string => {
  if (process.env.NODE_ENV === "production") return "";
  const home = os.homedir();
  const configPaths = [
    path.join(home, "Library", "Preferences", ".wrangler", "config", "default.toml"),
    path.join(home, ".wrangler", "config", "default.toml"),
    path.join(home, ".config", ".wrangler", "config", "default.toml"),
  ];
  for (const configPath of configPaths) {
    if (!existsSync(configPath)) continue;
    try {
      const text = readFileSync(configPath, "utf8");
      const match = text.match(/^\s*oauth_token\s*=\s*"([^"]+)"\s*$/m);
      const token = match?.[1]?.trim();
      if (token) return token;
    } catch (_error) {
      continue;
    }
  }
  return "";
};
