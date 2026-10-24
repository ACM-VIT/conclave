import {
  AI_ENDPOINTS,
  readAiEnvironment,
  type AiEnvironment,
} from "@conclave/ai/models";
import type { RoomAiIdentity, RoomAiProvider, RoomAiState } from "@conclave/ai/room";
import { AI_FEATURES, resolveAiFeatureSettings, type AiFeature, type AiFeatureSettings } from "@conclave/ai/room-settings";

export const ROOM_AI_ENV_FIELDS = [
  "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
  "SARVAM_API_KEY",
  "OPENAI_BASE_URL",
  "CLOUDFLARE_AI_GATEWAY_OPENAI_URL",
  "ANTHROPIC_BASE_URL",
  "CLOUDFLARE_AI_GATEWAY_ANTHROPIC_URL",
  "CONCLAVE_ASSISTANT_MODEL",
  "CONCLAVE_AI_SETTINGS",
] as const;

// Routed rooms share one account and endpoint for discovery and execution.
// Missing room settings must never fall back to a different Worker's account.
export function roomAiEnvironment(
  local: AiEnvironment,
  room: AiEnvironment,
): AiEnvironment {
  const result = readAiEnvironment(local);
  for (const field of ROOM_AI_ENV_FIELDS) result[field] = "";
  return {
    ...result,
    OPENAI_BASE_URL: AI_ENDPOINTS.openai.apiBase,
    ANTHROPIC_BASE_URL: AI_ENDPOINTS.anthropic.apiBase,
    ...room,
  };
}

// Called only by trusted servers. The shared secret never comes from a client.
export const fetchRoomAiEnvironment = async (options: {
  sfuUrl: string;
  secret: string;
  identity: RoomAiIdentity;
  providers: RoomAiProvider[];
  requireHost?: boolean;
  signal?: AbortSignal;
}): Promise<AiEnvironment> => {
  const url = new URL(options.sfuUrl);
  if (
    !["https:", "http:"].includes(url.protocol) ||
    url.username ||
    url.password
  )
    throw new Error("Invalid SFU URL.");
  const response = await fetch(new URL("/internal/ai/credentials", url), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-room-ai-secret": options.secret,
    },
    body: JSON.stringify({ ...options.identity, providers: options.providers, ...(options.requireHost ? {requireHost: true} : {}) }),
    signal: AbortSignal.any([
      ...(options.signal ? [options.signal] : []),
      AbortSignal.timeout(5000),
    ]),
    cache: "no-store",
    // Workers supports manual redirects; never forward this secret to Location.
    redirect: "manual",
  });
  if (!response.ok)
    throw Object.assign(new Error("Room AI settings could not be loaded."), {
      status: response.status,
    });
  const data: unknown = await response.json();
  if (!data || typeof data !== "object")
    throw new Error("Invalid room AI settings.");
  const result: AiEnvironment = {};
  const record = data as Record<string, unknown>;
  for (const name of ROOM_AI_ENV_FIELDS) {
    if (typeof record[name] === "string") result[name] = record[name];
  }
  return result;
};

// Log only stable diagnostics, never request headers, identities or response bodies.
export const describeRoomAiLookupFailure = (error: unknown) => {
  const detail =
    error && typeof error === "object"
      ? (error as Record<string, unknown>)
      : {};
  const name = error instanceof Error ? error.name : "Error";
  return {
    name: ["TypeError", "AbortError", "TimeoutError", "Error"].includes(name)
      ? name
      : "Error",
    ...(typeof detail.status === "number" ? { status: detail.status } : {}),
  };
};

export async function requestRoomAiSettings(options: {
  sfuUrl: string;
  secret: string;
  identity: RoomAiIdentity;
  feature?: AiFeature;
  settings?: Partial<AiFeatureSettings>;
  signal?: AbortSignal;
}): Promise<unknown> {
  const url = new URL(options.sfuUrl);
  if (!["https:", "http:"].includes(url.protocol) || url.username || url.password) throw new Error("Invalid SFU URL.");
  const response = await fetch(new URL("/internal/ai/settings", url), {
    method: "POST", headers: {"content-type": "application/json", "x-room-ai-secret": options.secret},
    body: JSON.stringify({...options.identity, ...(options.feature ? {feature: options.feature, settings: options.settings} : {})}),
    signal: AbortSignal.any([...(options.signal ? [options.signal] : []), AbortSignal.timeout(8000)]), cache: "no-store", redirect: "manual",
  });
  const result = await response.json() as {error?: string; state?: RoomAiState};
  if (!response.ok) throw new Error(result.error || "Room AI settings could not be loaded.");
  // Return configuration only. Credentials and transport data never enter a prompt.
  return Object.fromEntries((Object.keys(AI_FEATURES) as AiFeature[]).map(feature => [feature, resolveAiFeatureSettings({CONCLAVE_ASSISTANT_MODEL: result.state?.assistantModel ?? undefined}, feature, result.state?.features)]));
}
