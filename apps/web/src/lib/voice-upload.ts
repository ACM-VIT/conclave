import { declaredContentLength, readBoundedBody } from "./bounded-request-body";
import { MAX_VOICE_SAMPLE_BYTES } from "./tts-voice";

// Room for the multipart boundaries and the small text fields next to the audio.
const MULTIPART_OVERHEAD_BYTES = 64 * 1024;
export const MAX_VOICE_UPLOAD_BYTES = MAX_VOICE_SAMPLE_BYTES + MULTIPART_OVERHEAD_BYTES;

export type VoiceUpload =
  | { ok: true; form: FormData; audio: File }
  | { ok: false; status: 400 | 411 | 413; error: string };

const ascii = (bytes: Uint8Array, offset: number, text: string): boolean =>
  [...text].every((character, index) => bytes[offset + index] === character.charCodeAt(0));

/** True when the bytes start like an audio container ElevenLabs accepts. */
export const hasAudioSignature = (bytes: Uint8Array): boolean =>
  (bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3) || // WebM / Matroska
  ascii(bytes, 4, "ftyp") || // MP4 / M4A
  ascii(bytes, 0, "OggS") ||
  (ascii(bytes, 0, "RIFF") && ascii(bytes, 8, "WAVE")) ||
  ascii(bytes, 0, "fLaC") ||
  ascii(bytes, 0, "ID3") ||
  (bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0); // MPEG audio / ADTS frame sync

const tooLarge: VoiceUpload = { ok: false, status: 413, error: "The voice recording is too large." };
const invalid: VoiceUpload = { ok: false, status: 400, error: "Invalid voice sample upload." };

/**
 * Reads a voice sample upload without ever holding more than the size cap:
 * the declared length is checked before reading, and the body stream is
 * cancelled as soon as it passes the cap, whatever the header said.
 */
export const readVoiceUpload = async (request: Request): Promise<VoiceUpload> => {
  const contentType = request.headers.get("content-type") ?? "";
  if (!/^multipart\/form-data\s*;/i.test(contentType)) return invalid;

  const declaredLength = declaredContentLength(request);
  if (declaredLength === null) {
    return { ok: false, status: 411, error: "Voice uploads need a Content-Length header." };
  }
  if (declaredLength > MAX_VOICE_UPLOAD_BYTES) return tooLarge;

  const body = await readBoundedBody(request, MAX_VOICE_UPLOAD_BYTES);
  if (!body.ok) return body.reason === "too-large" ? tooLarge : invalid;

  let form: FormData;
  try {
    form = await new Response(body.bytes, { headers: { "content-type": contentType } }).formData();
  } catch {
    return invalid;
  }

  const audio = form.get("audio");
  if (!(audio instanceof File) || !audio.type.startsWith("audio/") || audio.size <= 0) {
    return { ok: false, status: 400, error: "An audio recording is required." };
  }
  if (audio.size > MAX_VOICE_SAMPLE_BYTES) return tooLarge;
  if (!hasAudioSignature(new Uint8Array(await audio.slice(0, 12).arrayBuffer()))) {
    return { ok: false, status: 400, error: "The recording is not a supported audio file." };
  }
  return { ok: true, form, audio };
};
