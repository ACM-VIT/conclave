import { CompactEncrypt, compactDecrypt } from "jose";

const ELEVENLABS_API_BASE = "https://api.elevenlabs.io/v1";
const VOICE_TOKEN_ISSUER = "conclave-web";
const VOICE_TOKEN_AUDIENCE = "conclave-tts";
const VOICE_TOKEN_TTL_SECONDS = 365 * 24 * 60 * 60;

export const MAX_TTS_TEXT_LENGTH = 500;
export const MAX_VOICE_SAMPLE_BYTES = 8 * 1024 * 1024;
export const MIN_VOICE_SAMPLE_SECONDS = 10;
export const MAX_VOICE_SAMPLE_SECONDS = 25;

interface VoiceTokenPayload {
  voiceId: string;
  voiceName: string;
  ownerId: string;
}

const requireVoiceTokenSecret = (): Uint8Array => {
  const value =
    process.env.TTS_VOICE_TOKEN_SECRET?.trim() ||
    process.env.SFU_SECRET?.trim();
  if (!value) {
    throw new Error("TTS voice tokens are not configured.");
  }
  return new TextEncoder().encode(value);
};

const createVoiceTokenKey = async (): Promise<Uint8Array> => {
  const secret = requireVoiceTokenSecret();
  const buffer = secret.buffer.slice(
    secret.byteOffset,
    secret.byteOffset + secret.byteLength,
  ) as ArrayBuffer;
  return new Uint8Array(await crypto.subtle.digest("SHA-256", buffer));
};

const requireElevenLabsApiKey = (): string => {
  const value = process.env.ELEVENLABS_API_KEY?.trim();
  if (!value) {
    throw new Error("Voice cloning is not configured.");
  }
  return value;
};

const providerError = async (
  response: Response,
  fallback: string,
): Promise<Error> => {
  let detail = "";
  try {
    const body = (await response.json()) as {
      detail?: string | { message?: string };
      message?: string;
    };
    detail =
      typeof body.detail === "string"
        ? body.detail
        : body.detail?.message || body.message || "";
  } catch {}
  return new Error(detail || `${fallback} (${response.status})`);
};

export const createVoiceToken = async ({
  voiceId,
  voiceName,
  ownerId,
}: VoiceTokenPayload): Promise<string> => {
  const now = Math.floor(Date.now() / 1000);
  const payload = new TextEncoder().encode(JSON.stringify({
    voiceId,
    voiceName,
    ownerId,
    purpose: "cloned-voice",
    iss: VOICE_TOKEN_ISSUER,
    aud: VOICE_TOKEN_AUDIENCE,
    sub: ownerId,
    iat: now,
    exp: now + VOICE_TOKEN_TTL_SECONDS,
  }));
  return new CompactEncrypt(payload)
    .setProtectedHeader({ alg: "dir", enc: "A256GCM", typ: "JWT" })
    .encrypt(await createVoiceTokenKey());
};

export const verifyVoiceToken = async (
  token: string,
  options: { allowExpired?: boolean } = {},
): Promise<VoiceTokenPayload> => {
  const decrypted = await compactDecrypt(token, await createVoiceTokenKey());
  const payload = JSON.parse(
    new TextDecoder().decode(decrypted.plaintext),
  ) as Record<string, unknown>;
  const now = Math.floor(Date.now() / 1000);
  if (
    payload.purpose !== "cloned-voice" ||
    payload.iss !== VOICE_TOKEN_ISSUER ||
    payload.aud !== VOICE_TOKEN_AUDIENCE ||
    typeof payload.exp !== "number" ||
    (!options.allowExpired && payload.exp <= now) ||
    typeof payload.voiceId !== "string" ||
    !payload.voiceId ||
    typeof payload.voiceName !== "string" ||
    !payload.voiceName ||
    typeof payload.ownerId !== "string" ||
    !payload.ownerId
  ) {
    throw new Error("Invalid cloned voice token.");
  }
  return {
    voiceId: payload.voiceId,
    voiceName: payload.voiceName,
    ownerId: payload.ownerId,
  };
};

export const createInstantVoiceClone = async ({
  audio,
  name,
}: {
  audio: File;
  name: string;
}): Promise<{ voiceId: string; requiresVerification: boolean }> => {
  const formData = new FormData();
  formData.append("name", name.slice(0, 100));
  formData.append(
    "description",
    "Created by its owner in Conclave for meeting text-to-speech.",
  );
  formData.append("remove_background_noise", "false");
  formData.append("files", audio, audio.name || "conclave-voice-sample.webm");

  const response = await fetch(`${ELEVENLABS_API_BASE}/voices/add`, {
    method: "POST",
    headers: { "xi-api-key": requireElevenLabsApiKey() },
    body: formData,
  });
  if (!response.ok) {
    throw await providerError(response, "Voice cloning failed");
  }
  const body = (await response.json()) as {
    voice_id?: string;
    requires_verification?: boolean;
  };
  if (!body.voice_id) {
    throw new Error("The voice provider did not return a voice ID.");
  }
  return {
    voiceId: body.voice_id,
    requiresVerification: Boolean(body.requires_verification),
  };
};

export const synthesizeClonedSpeech = async ({
  voiceId,
  text,
}: {
  voiceId: string;
  text: string;
}): Promise<Response> => {
  const modelId =
    process.env.ELEVENLABS_TTS_MODEL?.trim() || "eleven_multilingual_v2";
  const response = await fetch(
    `${ELEVENLABS_API_BASE}/text-to-speech/${encodeURIComponent(voiceId)}?output_format=mp3_44100_128`,
    {
      method: "POST",
      headers: {
        "xi-api-key": requireElevenLabsApiKey(),
        "content-type": "application/json",
        accept: "audio/mpeg",
      },
      body: JSON.stringify({
        text,
        model_id: modelId,
        voice_settings: {
          stability: 0.5,
          similarity_boost: 0.75,
        },
      }),
    },
  );
  if (!response.ok) {
    throw await providerError(response, "Speech generation failed");
  }
  return response;
};

export const deleteInstantVoiceClone = async (voiceId: string): Promise<void> => {
  const response = await fetch(
    `${ELEVENLABS_API_BASE}/voices/${encodeURIComponent(voiceId)}`,
    {
      method: "DELETE",
      headers: { "xi-api-key": requireElevenLabsApiKey() },
    },
  );
  if (!response.ok) {
    throw await providerError(response, "Voice deletion failed");
  }
};
