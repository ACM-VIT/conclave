import type { AiEnvironment } from "@conclave/ai/models";
import type { RoomAiIdentity, RoomAiProvider } from "@conclave/ai/room";

// Called only by trusted servers. The shared secret never comes from a client.
export const fetchRoomAiEnvironment = async (options: {
  sfuUrl: string;
  secret: string;
  identity: RoomAiIdentity;
  providers: RoomAiProvider[];
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
    body: JSON.stringify({ ...options.identity, providers: options.providers }),
    signal: AbortSignal.any([
      ...(options.signal ? [options.signal] : []),
      AbortSignal.timeout(5000),
    ]),
    cache: "no-store",
    redirect: "error",
  });
  if (!response.ok) throw new Error("Room AI settings could not be loaded.");
  const data: unknown = await response.json();
  if (!data || typeof data !== "object")
    throw new Error("Invalid room AI settings.");
  const result: AiEnvironment = {};
  const record = data as Record<string, unknown>;
  for (const name of [
    "OPENAI_API_KEY",
    "ANTHROPIC_API_KEY",
    "SARVAM_API_KEY",
    "CONCLAVE_ASSISTANT_MODEL",
  ] as const) {
    if (typeof record[name] === "string") result[name] = record[name];
  }
  return result;
};
