import { AI_ENDPOINTS } from "@conclave/ai/models";
import { DEFAULT_TRANSCRIPTION_LOCALE } from "../constants";
import { normalizeLocale, safeJsonParse, trimText } from "../utils";
import type { TranscriptSpeaker } from "@conclave/meeting-core/transcript-types";
import { VoiceActivity } from "./voice-activity";
import type {
  LiveTranscriptionCallbacks,
  LiveTranscriptionConnectOptions,
  LiveTranscriptionSession,
} from "./types";

const SARVAM_STT_WS_URL = AI_ENDPOINTS.sarvam.transcription;
const SARVAM_SAMPLE_RATE = 16_000;
const SARVAM_SAMPLE_RATE_PARAM = String(SARVAM_SAMPLE_RATE);
const SARVAM_AUDIO_ENCODING = "audio/wav";
const SARVAM_INPUT_AUDIO_CODEC = "pcm_s16le";
const SARVAM_DEFAULT_LANGUAGE_CODE = "unknown";
const SARVAM_DEFAULT_MODE = "codemix";
/** How long before Sarvam's speech signal our own speech onset may be, given its detection and network delay. */
const SARVAM_SIGNAL_LOOKBACK_MS = 1_500;
export const SARVAM_SUPPORTED_LANGUAGE_CODES = new Set([
  "unknown",
  "en-IN",
  "hi-IN",
  "bn-IN",
  "gu-IN",
  "kn-IN",
  "ml-IN",
  "mr-IN",
  "od-IN",
  "pa-IN",
  "ta-IN",
  "te-IN",
  "as-IN",
  "ur-IN",
  "ne-IN",
  "kok-IN",
  "ks-IN",
  "sd-IN",
  "sa-IN",
  "sat-IN",
  "mni-IN",
  "brx-IN",
  "mai-IN",
  "doi-IN",
]);
const SARVAM_SUPPORTED_MODES = new Set([
  "transcribe",
  "translate",
  "verbatim",
  "translit",
  "codemix",
]);

type SarvamResponse = {
  type?: string;
  data?: unknown;
  request_id?: unknown;
  text?: unknown;
  transcript?: unknown;
  error?: unknown;
  message?: unknown;
};

type ParsedSarvamEvent =
  | { type: "final"; itemId: string; transcript: string }
  | { type: "speech_start" }
  | { type: "error"; message: string }
  | { type: "ignore" };

const normalizeSarvamLanguageCode = (
  language: string,
  fallbackLocale: string,
): string => {
  const candidate = language.trim();
  if (SARVAM_SUPPORTED_LANGUAGE_CODES.has(candidate)) return candidate;
  const locale = fallbackLocale.trim();
  if (SARVAM_SUPPORTED_LANGUAGE_CODES.has(locale)) return locale;
  return SARVAM_DEFAULT_LANGUAGE_CODE;
};

const baseLanguage = (language: string): string =>
  language.trim().toLowerCase().split("-")[0] ?? "";

// A picked language gets its regional code. With no pick, as from clients
// that send no language, the code resolves exactly as it did before picks:
// the operator's code or the language, else the deployment locale.
const supportedSarvamLanguageCode = (
  language: string,
  languageChosen: boolean,
  env: LiveTranscriptionConnectOptions["env"],
  locale = normalizeLocale(env.TRANSCRIPT_TRANSCRIPTION_LOCALE),
): string | null => {
  if (!languageChosen) {
    return normalizeSarvamLanguageCode(
      env.TRANSCRIPT_SARVAM_LANGUAGE_CODE ?? language,
      locale || DEFAULT_TRANSCRIPTION_LOCALE,
    );
  }
  const regional = `${baseLanguage(language)}-IN`;
  return SARVAM_SUPPORTED_LANGUAGE_CODES.has(regional) ? regional : null;
};

export const sarvamCanTranscribe = (
  language: string,
  languageChosen: boolean,
  env: LiveTranscriptionConnectOptions["env"],
): boolean => supportedSarvamLanguageCode(language, languageChosen, env) !== null;

/** The exact language-code a Sarvam connection is sent; "unknown" auto-detects. */
export const sarvamProviderLanguage = (options: {
  language: string;
  languageChosen?: boolean;
  locale: string;
  env: LiveTranscriptionConnectOptions["env"];
}): string =>
  normalizeSarvamLanguageCode(
    supportedSarvamLanguageCode(
      options.language,
      options.languageChosen === true,
      options.env,
      options.locale,
    ) ??
      options.env.TRANSCRIPT_SARVAM_LANGUAGE_CODE ??
      options.language,
    options.locale || DEFAULT_TRANSCRIPTION_LOCALE,
  );

const normalizeSarvamMode = (value: string | undefined): string => {
  const candidate = value?.trim() || SARVAM_DEFAULT_MODE;
  return SARVAM_SUPPORTED_MODES.has(candidate) ? candidate : SARVAM_DEFAULT_MODE;
};

export const sarvamEndpoint = (options: {
  baseUrl?: string;
  model: string;
  language: string;
  locale?: string;
  mode?: string;
}): string => {
  const base = (options.baseUrl || SARVAM_STT_WS_URL).replace(/\/+$/, "");
  const url = new URL(base);
  if (url.protocol === "wss:") {
    url.protocol = "https:";
  } else if (url.protocol === "ws:") {
    url.protocol = "http:";
  }
  url.searchParams.set(
    "language-code",
    normalizeSarvamLanguageCode(
      options.language,
      options.locale || DEFAULT_TRANSCRIPTION_LOCALE,
    ),
  );
  url.searchParams.set("model", options.model || "saaras:v3");
  url.searchParams.set("mode", normalizeSarvamMode(options.mode));
  url.searchParams.set("sample_rate", SARVAM_SAMPLE_RATE_PARAM);
  url.searchParams.set("input_audio_codec", SARVAM_INPUT_AUDIO_CODEC);
  url.searchParams.set("flush_signal", "true");
  url.searchParams.set("high_vad_sensitivity", "true");
  url.searchParams.set("vad_signals", "true");
  return url.toString();
};

const decodePcm16Base64 = (base64: string): Int16Array => {
  const binary = atob(base64.replace(/\s+/g, ""));
  const sampleCount = Math.floor(binary.length / 2);
  const samples = new Int16Array(sampleCount);
  for (let index = 0; index < sampleCount; index += 1) {
    const byteOffset = index * 2;
    const lo = binary.charCodeAt(byteOffset) & 0xff;
    const hi = binary.charCodeAt(byteOffset + 1) & 0xff;
    const value = lo | (hi << 8);
    samples[index] = value >= 0x8000 ? value - 0x10000 : value;
  }
  return samples;
};

const encodePcm16Base64 = (samples: Int16Array): string => {
  let binary = "";
  const chunkSize = 0x4000;
  for (let index = 0; index < samples.length; index += chunkSize) {
    const chunk = samples.subarray(index, index + chunkSize);
    let part = "";
    for (let sampleIndex = 0; sampleIndex < chunk.length; sampleIndex += 1) {
      const value = chunk[sampleIndex] ?? 0;
      const unsigned = value < 0 ? value + 0x10000 : value;
      part += String.fromCharCode(unsigned & 0xff, (unsigned >> 8) & 0xff);
    }
    binary += part;
  }
  return btoa(binary);
};

export class Pcm24To16Downsampler {
  private carry = new Int16Array(0);

  downsample(base64: string): string {
    return this.downsampleSamples(decodePcm16Base64(base64));
  }

  downsampleSamples(input: Int16Array): string {
    if (input.length === 0) return "";

    const samples =
      this.carry.length === 0
        ? input
        : (() => {
            const merged = new Int16Array(this.carry.length + input.length);
            merged.set(this.carry, 0);
            merged.set(input, this.carry.length);
            return merged;
          })();

    const groupCount = Math.floor(samples.length / 3);
    const consumed = groupCount * 3;
    this.carry = samples.slice(consumed);
    if (groupCount === 0) return "";

    const output = new Int16Array(groupCount * 2);
    for (let group = 0; group < groupCount; group += 1) {
      const inputOffset = group * 3;
      const outputOffset = group * 2;
      const first = samples[inputOffset] ?? 0;
      const second = samples[inputOffset + 1] ?? 0;
      const third = samples[inputOffset + 2] ?? 0;
      output[outputOffset] = first;
      output[outputOffset + 1] = Math.round((second + third) / 2);
    }

    return encodePcm16Base64(output);
  }

  reset(): void {
    this.carry = new Int16Array(0);
  }
}

export const buildSarvamAudioMessage = (audioBase64: string): string =>
  JSON.stringify({
    audio: {
      data: audioBase64,
      sample_rate: SARVAM_SAMPLE_RATE,
      encoding: SARVAM_AUDIO_ENCODING,
    },
  });

const buildSarvamFlushMessage = (): string => JSON.stringify({ type: "flush" });

const buildSarvamEndOfStreamMessage = (): string =>
  JSON.stringify({
    type: "end_of_stream",
    audio: {
      data: "",
      sample_rate: SARVAM_SAMPLE_RATE,
      encoding: SARVAM_AUDIO_ENCODING,
    },
  });

export const createSarvamSegmentItemId = (
  baseItemId: string,
  sequence: number,
): string => `${baseItemId}-${Math.max(1, sequence).toString(36)}`;

export const parseSarvamEvent = (raw: string): ParsedSarvamEvent => {
  const parsed = safeJsonParse(raw);
  if (!parsed || typeof parsed !== "object") return { type: "ignore" };
  const response = parsed as SarvamResponse;
  const data =
    response.data && typeof response.data === "object"
      ? (response.data as Record<string, unknown>)
      : {};

  const errorText =
    typeof data.error === "string"
      ? data.error
      : typeof response.error === "string"
        ? response.error
        : typeof response.message === "string"
          ? response.message
          : "";
  if (response.type === "error" || errorText) {
    return {
      type: "error",
      message: trimText(
        errorText || "Sarvam transcription error.",
        500,
      ),
    };
  }

  const responseType = response.type ?? "";
  if (
    responseType === "speech_start" ||
    (responseType === "events" && data.signal_type === "START_SPEECH")
  ) {
    return { type: "speech_start" };
  }
  if (
    responseType !== "data" &&
    responseType !== "transcript" &&
    responseType !== "translation"
  ) {
    return { type: "ignore" };
  }
  const transcript =
    typeof data.transcript === "string"
      ? data.transcript.trim()
      : typeof data.text === "string"
        ? data.text.trim()
        : typeof response.transcript === "string"
          ? response.transcript.trim()
          : typeof response.text === "string"
            ? response.text.trim()
            : "";
  const requestId =
    typeof data.request_id === "string" && data.request_id.trim()
      ? data.request_id.trim()
      : typeof response.request_id === "string" && response.request_id.trim()
        ? response.request_id.trim()
        : crypto.randomUUID();
  return {
    type: "final",
    itemId: `sarvam-${requestId}`,
    transcript,
  };
};

/**
 * Sarvam names no utterance until its final, so this connection names them.
 * An utterance is accepted when Sarvam signals speech started, or, before
 * Sarvam has sent any speech signal, when our own voice check first hears
 * speech in a turn; bare audio is never enough. Finals answer accepted
 * utterances oldest first.
 */
class SarvamTranscriptionSession implements LiveTranscriptionSession {
  readonly provider = "sarvam" as const;

  private closed = false;
  private readonly downsampler = new Pcm24To16Downsampler();
  private readonly voice = new VoiceActivity();
  private readonly connectionId = crypto.randomUUID();
  private utteranceCount = 0;
  private readonly awaitingFinal: string[] = [];
  private openedByVoice: string[] = [];
  private onsets: Array<{ at: number; speaker: TranscriptSpeaker | null }> = [];
  private unheardSignals: Array<{ itemId: string; at: number }> = [];
  private resolveTimer: ReturnType<typeof setTimeout> | null = null;
  private lastSpeaker: TranscriptSpeaker | null = null;
  private signalsSpeech = false;
  private turnAccepted = false;

  constructor(
    private readonly socket: WebSocket,
    private readonly callbacks: LiveTranscriptionCallbacks,
  ) {}

  appendAudio(audioBase64: string, speaker?: TranscriptSpeaker): void {
    const samples = decodePcm16Base64(audioBase64);
    const downsampled = this.downsampler.downsampleSamples(samples);
    if (downsampled) this.socket.send(buildSarvamAudioMessage(downsampled));
    this.lastSpeaker = speaker ?? this.lastSpeaker;
    const now = Date.now();
    const voice = this.voice.push(samples, now);
    if (voice === "quiet") return;
    if (!this.signalsSpeech) {
      if (!this.turnAccepted) {
        this.turnAccepted = true;
        this.openedByVoice.push(this.acceptUtterance(speaker ?? null, true));
      }
      return;
    }
    if (voice !== "onset") return;
    this.onsets = this.onsets.filter(({ at }) => now - at <= 2 * SARVAM_SIGNAL_LOOKBACK_MS);
    this.onsets.push({ at: now, speaker: speaker ?? null });
    this.scheduleResolve();
  }

  commitAudio(): void {
  }

  clearAudio(): void {
    this.socket.send(buildSarvamFlushMessage());
    this.downsampler.reset();
    this.endTurn();
  }

  finishAudio(): void {
    this.socket.send(buildSarvamFlushMessage());
    this.endTurn();
  }

  private endTurn(): void {
    this.turnAccepted = false;
    this.voice.restart();
  }

  private nextUtteranceId(): string {
    this.utteranceCount += 1;
    return createSarvamSegmentItemId(`sarvam-${this.connectionId}`, this.utteranceCount);
  }

  private acceptUtterance(speaker: TranscriptSpeaker | null, heard: boolean): string {
    const itemId = this.nextUtteranceId();
    this.awaitingFinal.push(itemId);
    this.callbacks.onAccepted?.(itemId, { heard, speaker });
    return itemId;
  }

  /**
   * A speech signal takes the oldest utterance our voice check opened before
   * Sarvam signalled anything. Otherwise it opens one, heard when our check
   * found a speech onset just before it or speech is still going; a signal
   * with neither is a false start, which ends with nothing shown, unless our
   * check hears an onset soon after that no newer signal takes.
   */
  private handleSpeechStart(): void {
    this.signalsSpeech = true;
    const now = Date.now();
    this.resolveUnheardSignals(now);
    if (this.openedByVoice.shift()) return;
    this.onsets = this.onsets.filter(({ at }) => now - at <= SARVAM_SIGNAL_LOOKBACK_MS);
    const onset = this.onsets.shift();
    const heard = Boolean(onset) || this.voice.speakingAt(now);
    const itemId = this.acceptUtterance(onset?.speaker ?? this.lastSpeaker, heard);
    if (!heard) this.unheardSignals.push({ itemId, at: now });
  }

  /**
   * An onset belongs to the newest signal near it, so it is held until no
   * newer signal can take it; then it shows an earlier unheard signal was
   * speech our check heard late.
   */
  private resolveUnheardSignals(now: number): void {
    for (const signal of [...this.unheardSignals]) {
      const onset = this.onsets.find(
        ({ at }) =>
          at > signal.at &&
          at - signal.at <= SARVAM_SIGNAL_LOOKBACK_MS &&
          now - at > SARVAM_SIGNAL_LOOKBACK_MS,
      );
      if (onset) {
        this.onsets.splice(this.onsets.indexOf(onset), 1);
        this.unheardSignals.splice(this.unheardSignals.indexOf(signal), 1);
        this.callbacks.onHeard?.(signal.itemId);
      } else if (now - signal.at > 2 * SARVAM_SIGNAL_LOOKBACK_MS) {
        this.unheardSignals.splice(this.unheardSignals.indexOf(signal), 1);
      }
    }
  }

  private scheduleResolve(): void {
    if (this.resolveTimer !== null || this.unheardSignals.length === 0) return;
    this.resolveTimer = setTimeout(() => {
      this.resolveTimer = null;
      if (this.closed) return;
      this.resolveUnheardSignals(Date.now());
      if (this.onsets.length > 0) this.scheduleResolve();
    }, SARVAM_SIGNAL_LOOKBACK_MS + 1);
  }

  close(): void {
    this.closed = true;
    if (this.resolveTimer !== null) clearTimeout(this.resolveTimer);
    try {
      this.socket.send(buildSarvamFlushMessage());
      this.socket.send(buildSarvamEndOfStreamMessage());
      this.socket.close();
    } catch {}
  }

  attach(): void {
    this.socket.addEventListener("message", (event) => {
      void this.handleEvent(String(event.data ?? ""));
    });
    this.socket.addEventListener("close", () => {
      if (!this.closed) {
        void this.callbacks.onFailure("Sarvam transcription disconnected.");
      }
    });
    this.socket.addEventListener("error", () => {
      if (!this.closed) {
        void this.callbacks.onFailure("Sarvam transcription connection errored.");
      }
    });
  }

  private async handleEvent(raw: string): Promise<void> {
    const event = parseSarvamEvent(raw);
    if (event.type === "ignore") {
      return;
    }
    if (event.type === "error") {
      await this.callbacks.onFailure(event.message);
      return;
    }
    if (event.type === "speech_start") {
      this.handleSpeechStart();
      return;
    }
    const answered = this.awaitingFinal.shift();
    if (!answered && !event.transcript) return;
    const itemId = answered ?? this.nextUtteranceId();
    if (!answered) this.callbacks.onAccepted?.(itemId, { heard: true, speaker: this.lastSpeaker });
    this.openedByVoice = this.openedByVoice.filter((opened) => opened !== itemId);
    this.unheardSignals = this.unheardSignals.filter((signal) => signal.itemId !== itemId);
    this.callbacks.onCommitted(itemId);
    await this.callbacks.onFinal(itemId, event.transcript);
  }
}

export const connectSarvamTranscription = async (
  options: LiveTranscriptionConnectOptions,
): Promise<LiveTranscriptionSession> => {
  const response = await fetch(
    sarvamEndpoint({
      baseUrl: options.env.SARVAM_STT_WS_URL,
      model: options.transcriptModel,
      language: options.providerLanguage ?? sarvamProviderLanguage(options),
      locale: options.locale,
      mode: options.env.TRANSCRIPT_SARVAM_MODE,
    }),
    {
      headers: {
        "Api-Subscription-Key": options.apiKey,
        Upgrade: "websocket",
      },
      signal: options.signal,
    },
  );
  const socket = response.webSocket;
  if (!socket) {
    throw new Error(
      `Sarvam transcription connection failed (${response.status}).`,
    );
  }

  socket.accept();
  const session = new SarvamTranscriptionSession(socket, options.callbacks);
  session.attach();
  return session;
};
