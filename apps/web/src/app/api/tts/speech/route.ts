import { NextResponse } from "next/server";
import { roomAiAccess } from "@/lib/room-ai-access";
import { roomAiFeatureSettingsFromEnvironment } from "@conclave/ai/room-settings";
import { AI_DEFAULT_MODELS } from "@conclave/ai/models";
import {
  MAX_TTS_TEXT_LENGTH,
  synthesizeClonedSpeech,
  verifyVoiceToken,
} from "@/lib/tts-voice";

interface CachedSpeech {
  audio: ArrayBuffer;
  contentType: string;
  expiresAt: number;
}

const CACHE_TTL_MS = 5 * 60 * 1000;
const MAX_CACHE_ENTRIES = 64;
const speechCache = new Map<string, CachedSpeech>();
const speechInFlight = new Map<string, Promise<CachedSpeech>>();

const pruneSpeechCache = (): void => {
  const now = Date.now();
  for (const [key, value] of speechCache) {
    if (value.expiresAt <= now) speechCache.delete(key);
  }
  while (speechCache.size >= MAX_CACHE_ENTRIES) {
    const oldestKey = speechCache.keys().next().value;
    if (!oldestKey) break;
    speechCache.delete(oldestKey);
  }
};

const getSpeech = async (
  cacheKey: string,
  voiceId: string,
  text: string,
  options: {model?: string; timeoutMs?: number},
): Promise<CachedSpeech> => {
  const cached = speechCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached;
  const active = speechInFlight.get(cacheKey);
  if (active) return active;

  const request = (async () => {
    const providerResponse = await synthesizeClonedSpeech({ voiceId, text, ...options });
    const result: CachedSpeech = {
      audio: await providerResponse.arrayBuffer(),
      contentType: providerResponse.headers.get("content-type") || "audio/mpeg",
      expiresAt: Date.now() + CACHE_TTL_MS,
    };
    pruneSpeechCache();
    speechCache.set(cacheKey, result);
    return result;
  })();
  speechInFlight.set(cacheKey, request);
  try {
    return await request;
  } finally {
    speechInFlight.delete(cacheKey);
  }
};

export async function POST(request: Request): Promise<Response> {
  try {
    const body = (await request.json()) as { token?: string; text?: string; roomAiToken?: string };
    const token = body.token?.trim();
    const text = body.text?.trim();
    if (!token || !text) {
      return NextResponse.json(
        { error: "A cloned voice token and text are required." },
        { status: 400 },
      );
    }
    if (text.length > MAX_TTS_TEXT_LENGTH) {
      return NextResponse.json(
        { error: `TTS text is limited to ${MAX_TTS_TEXT_LENGTH} characters.` },
        { status: 400 },
      );
    }

    const voice = await verifyVoiceToken(token);
    const profile = body.roomAiToken ? await roomAiAccess(body.roomAiToken, "speech") : null;
    const options = {
      model: (profile ? roomAiFeatureSettingsFromEnvironment(profile.env).speech?.model : undefined) || process.env.ELEVENLABS_TTS_MODEL?.trim() || AI_DEFAULT_MODELS.tts,
      timeoutMs: profile?.settings.timeoutMs,
    };
    const speech = await getSpeech(`${token}\u0000${options.model || "deployment"}\u0000${text}`, voice.voiceId, text, options);
    return new Response(speech.audio.slice(0), {
      status: 200,
      headers: {
        "content-type": speech.contentType,
        "cache-control": "private, no-store",
        "x-content-type-options": "nosniff",
      },
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Speech generation failed." },
      { status: 400 },
    );
  }
}
