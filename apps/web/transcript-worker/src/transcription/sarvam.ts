import { AI_ENDPOINTS } from "@conclave/ai/models";
import { DEFAULT_TRANSCRIPTION_LOCALE, TRANSCRIPTION_CONNECT_TIMEOUT_MS } from "../constants";
import { normalizeLocale, safeJsonParse, trimText } from "../utils";
import type { TranscriptSpeaker } from "@conclave/meeting-core/transcript-types";
import type {
  AcceptedUtterance,
  AudioContext,
  HeardSpeech,
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
const SARVAM_SIGNAL_LOOKBACK_MS = 1_500;
const SARVAM_SEGMENT_KEPT_MS = 3_000;
const SARVAM_SPEAKER_LOG_LIMIT = 4_096;

type SentChunk = { sequence: number; at: number; order: number; createdAt: number };

type SpeechSegment = {
  speaker: TranscriptSpeaker;
  speakerKey: string;
  heardAt: number;
  turnId: number;
  turn: number;
  leadIn: SentChunk[];
  firstInTurn: boolean;
  startedAt: number;
  first: SentChunk;
  endSequence: number | null;
  afterSignal: number;
  claimed: boolean;
  itemId: string | null;
  answered: boolean;
  continued: SentChunk | null;
  claimedFrom?: number;
};
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
  | { type: "final"; itemId: string; transcript: string; generatedId?: true }
  | { type: "speech_start" }
  | { type: "speech_end" }
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
    responseType === "speech_end" ||
    (responseType === "events" && data.signal_type === "END_SPEECH")
  ) {
    return { type: "speech_end" };
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
        : null;
  if (requestId === null) {
    return { type: "final", itemId: `sarvam-${crypto.randomUUID()}`, transcript, generatedId: true };
  }
  return {
    type: "final",
    itemId: `sarvam-${requestId}`,
    transcript,
  };
};

type UnheardSignal = { itemId: string; at: number; signal: number };

type LaneChunk = { sent: SentChunk; turn: number };

type LaneEvent = "message" | "close" | "error";
type LaneListener = (event: { data?: unknown }) => void;
type LaneSocket = {
  send(raw: string): void;
  close(): void;
  addEventListener(type: LaneEvent, listener: LaneListener): void;
};

class SarvamLane {
  private closed = false;
  private readonly downsampler = new Pcm24To16Downsampler();
  private readonly connectionId = crypto.randomUUID();
  private speaker: TranscriptSpeaker | null = null;
  private utteranceCount = 0;
  private awaitingFinal: string[] = [];
  private lastAnswer: { itemId: string; transcript: string; nextWaiting: string | null } | null = null;
  private openedBeforeSignal: string[] = [];
  private readonly replayedLines = new Set<string>();
  private segments: SpeechSegment[] = [];
  private openSegment: SpeechSegment | null = null;
  private unheardSignals: UnheardSignal[] = [];
  private signalCount = 0;
  private resolveTimer: ReturnType<typeof setTimeout> | null = null;
  private turnCount = 0;
  private turn: {
    id: number;
    first: SentChunk;
    leadIn: SentChunk[];
    ended: boolean;
    accepted: boolean;
    needsOnset: boolean;
    segments: number;
  } | null = null;
  private signalledItem: string | null = null;
  private sentSinceAnswer: LaneChunk[] = [];
  private readonly utteranceStarts = new Map<string, number>();
  private readonly voiceOpened = new Set<string>();
  private nextSequence = 0;

  constructor(
    private readonly socket: LaneSocket,
    private readonly callbacks: LiveTranscriptionCallbacks,
    private readonly signals: { speech: boolean },
  ) {}

  private get signalsSpeech(): boolean {
    return this.signals.speech;
  }

  appendAudio(audioBase64: string, speaker: TranscriptSpeaker, context?: AudioContext): string | null {
    const downsampled = this.downsampler.downsample(audioBase64);
    if (downsampled) this.socket.send(buildSarvamAudioMessage(downsampled));
    if (!context) return null;
    this.speaker = speaker;
    const sent: SentChunk = {
      sequence: context.sequence,
      at: context.at,
      order: context.order,
      createdAt: context.createdAt,
    };
    this.nextSequence = Math.max(this.nextSequence, sent.sequence + 1);
    if (!this.turn || this.turn.ended) {
      this.endOpenSegment(sent.sequence);
      this.turnCount += 1;
      this.turn = { id: this.turnCount, first: sent, leadIn: [], ended: false, accepted: false, needsOnset: false, segments: 0 };
    }
    const voice = context.voice;
    if (this.turn.segments === 0) {
      this.turn.leadIn = [...this.turn.leadIn, sent].filter(({ at }) => sent.at - at <= SARVAM_SIGNAL_LOOKBACK_MS);
    }
    this.sentSinceAnswer.push({ sent, turn: context.turn });
    if (this.sentSinceAnswer.length > SARVAM_SPEAKER_LOG_LIMIT) this.sentSinceAnswer.shift();
    if (voice === "onset") this.endOpenSegment(sent.sequence);
    if (context.lineId) {
      if (!this.replayedLines.has(context.lineId)) {
        this.replayedLines.add(context.lineId);
        this.turn.accepted = true;
        this.openedBeforeSignal.push(
          this.acceptUtterance({
            heard: voice !== "quiet",
            speaker,
            fromSequence: this.turn.first.sequence,
            turn: context.turn,
            lineId: context.lineId,
          }),
        );
      }
      return null;
    }
    if (voice === "quiet") return this.ownerOfOpenSegment();
    if (!this.signalsSpeech && !this.turn.accepted && (!this.turn.needsOnset || voice === "onset")) {
      this.turn.accepted = true;
      const opened = this.beginSegment(speaker, context.turn, sent);
      opened.claimed = true;
      const first = this.turn.first;
      opened.itemId = this.acceptUtterance({
        heard: true,
        speaker,
        fromSequence: first.sequence,
        turn: context.turn,
        place: { order: first.order, startMs: first.createdAt },
      });
      this.openedBeforeSignal.push(opened.itemId);
      this.voiceOpened.add(opened.itemId);
      return opened.itemId;
    }
    const open = this.openSegment;
    if (open && !open.answered && open.endSequence === null && voice !== "onset" && open.turnId === this.turn.id) {
      open.heardAt = sent.at;
      if (open.claimed && open.continued === null) open.continued = sent;
      return this.ownerOfOpenSegment();
    }
    this.beginSegment(speaker, context.turn, sent);
    this.scheduleResolve();
    return null;
  }

  private ownerOfOpenSegment(): string | null {
    const open = this.openSegment;
    if (!open?.claimed || !open.itemId || open.answered || open.endSequence !== null) return null;
    return open.turnId === this.turn?.id ? open.itemId : null;
  }

  private beginSegment(speaker: TranscriptSpeaker, turn: number, sent: SentChunk): SpeechSegment {
    const current = this.turn!;
    this.endOpenSegment(sent.sequence);
    const windowStart = this.sentSinceAnswer[0]?.sent.sequence ?? Number.POSITIVE_INFINITY;
    this.segments = this.segments.filter(
      ({ heardAt, first }) => sent.at - heardAt <= SARVAM_SEGMENT_KEPT_MS || first.sequence >= windowStart,
    );
    const segment: SpeechSegment = {
      speaker,
      speakerKey: `${speaker.userId}:${speaker.source}`,
      heardAt: sent.at,
      turnId: current.id,
      turn,
      leadIn: current.segments === 0 ? current.leadIn : [],
      firstInTurn: current.segments === 0,
      startedAt: sent.at,
      first: sent,
      endSequence: null,
      afterSignal: this.signalCount,
      claimed: false,
      itemId: null,
      answered: false,
      continued: null,
    };
    current.segments += 1;
    this.segments.push(segment);
    this.openSegment = segment;
    return segment;
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
    if (this.turn) this.turn.ended = true;
    this.endOpenSegment(this.nextSequence);
    this.openSegment = null;
  }

  private settleUtterance(itemId: string): void {
    for (const segment of this.segments) {
      if (segment.itemId === itemId) segment.answered = true;
    }
    if (this.openSegment?.itemId === itemId) this.openSegment.answered = true;
    this.awaitingFinal = this.awaitingFinal.filter((awaiting) => awaiting !== itemId);
    this.openedBeforeSignal = this.openedBeforeSignal.filter((opened) => opened !== itemId);
    this.unheardSignals = this.unheardSignals.filter((signal) => signal.itemId !== itemId);
    if (this.signalledItem === itemId) this.signalledItem = null;
    this.voiceOpened.delete(itemId);
  }

  private nextUtteranceId(): string {
    this.utteranceCount += 1;
    return createSarvamSegmentItemId(`sarvam-${this.connectionId}`, this.utteranceCount);
  }

  private acceptUtterance(utterance: AcceptedUtterance): string {
    const itemId = this.nextUtteranceId();
    this.awaitingFinal.push(itemId);
    this.rememberStart(itemId, utterance);
    this.callbacks.onAccepted?.(itemId, utterance);
    return itemId;
  }

  private rememberStart(itemId: string, speech: HeardSpeech): void {
    if (Number.isFinite(speech.fromSequence)) this.utteranceStarts.set(itemId, speech.fromSequence);
  }

  private endOpenSegment(sequence: number): void {
    if (this.openSegment && this.openSegment.endSequence === null) this.openSegment.endSequence = sequence;
  }

  private segmentSpeech(segment: SpeechSegment, from: number): HeardSpeech {
    const index = this.segments.indexOf(segment);
    const next = this.segments.find((_, at) => at > index);
    const leadIn = segment.firstInTurn ? segment.leadIn.find(({ at }) => at >= from) : undefined;
    const first = leadIn && leadIn.sequence < segment.first.sequence ? leadIn : segment.first;
    return {
      speaker: segment.speaker,
      fromSequence: first.sequence,
      turn: segment.turn,
      untilSequence: segment.endSequence ?? next?.first.sequence,
      place: { order: first.order, startMs: first.createdAt },
    };
  }

  private withdrawVoiceOpened(): void {
    for (const itemId of this.voiceOpened) {
      this.awaitingFinal = this.awaitingFinal.filter((awaiting) => awaiting !== itemId);
      this.openedBeforeSignal = this.openedBeforeSignal.filter((opened) => opened !== itemId);
      this.utteranceStarts.delete(itemId);
      for (const segment of [...this.segments, this.openSegment]) {
        if (segment?.itemId !== itemId) continue;
        segment.claimed = false;
        segment.itemId = null;
      }
      this.callbacks.onWithdrawn?.(itemId);
    }
    this.voiceOpened.clear();
  }

  private handleSpeechStart(): void {
    this.withdrawVoiceOpened();
    this.signals.speech = true;
    this.lastAnswer = null;
    const now = Date.now();
    this.resolveUnheardSignals(now);
    this.signalCount += 1;
    const opened = this.openedBeforeSignal.shift();
    if (opened) {
      this.signalledItem = opened;
      return;
    }
    const segment = this.segments.find(({ claimed, heardAt }) => !claimed && now - heardAt <= SARVAM_SIGNAL_LOOKBACK_MS);
    if (segment) {
      segment.claimed = true;
      this.signalledItem = this.acceptUtterance({
        heard: true,
        ...this.segmentSpeech(segment, segment.startedAt - SARVAM_SIGNAL_LOOKBACK_MS),
      });
      segment.itemId = this.signalledItem;
      return;
    }
    const running = this.openSegment;
    if (
      running?.claimed &&
      !running.answered &&
      running.endSequence === null &&
      running.continued !== null &&
      running.turnId === this.turn?.id
    ) {
      const continued = running.continued;
      running.continued = null;
      this.signalledItem = this.acceptUtterance({
        heard: true,
        speaker: running.speaker,
        fromSequence: continued.sequence,
        turn: running.turn,
        fromItem: running.itemId ?? undefined,
        place: { order: continued.order, startMs: continued.createdAt },
      });
      running.itemId = this.signalledItem;
      return;
    }
    const itemId = this.acceptUtterance({ heard: false, speaker: null, fromSequence: Number.POSITIVE_INFINITY });
    this.unheardSignals.push({ itemId, at: now, signal: this.signalCount });
    this.signalledItem = itemId;
  }

  private handleSpeechEnd(): void {
    this.lastAnswer = null;
    const ended = this.signalledItem;
    if (!ended) return;
    this.resolveNow(ended);
    if (this.openSegment?.itemId === ended) this.endOpenSegment(this.nextSequence);
  }

  private resolveNow(itemId: string): void {
    const signal = this.unheardSignals.find((unheard) => unheard.itemId === itemId);
    const segment = signal ? this.segmentAfter(signal) : undefined;
    if (signal && segment) this.resolve(signal, segment);
  }

  private segmentAfter(signal: UnheardSignal): SpeechSegment | undefined {
    return this.segments.find(
      ({ claimed, afterSignal, startedAt }) =>
        !claimed && afterSignal === signal.signal && startedAt - signal.at <= SARVAM_SIGNAL_LOOKBACK_MS,
    );
  }

  private resolve(signal: UnheardSignal, segment: SpeechSegment): void {
    segment.claimed = true;
    segment.itemId = signal.itemId;
    this.unheardSignals.splice(this.unheardSignals.indexOf(signal), 1);
    const speech = this.segmentSpeech(segment, Math.min(signal.at, segment.startedAt) - SARVAM_SIGNAL_LOOKBACK_MS);
    this.rememberStart(signal.itemId, speech);
    this.callbacks.onHeard?.(signal.itemId, speech);
  }

  private firstUnclaimedChunk(): LaneChunk | undefined {
    const claimed = this.segments.filter(({ claimed }) => claimed);
    return this.sentSinceAnswer.find(
      ({ sent }) =>
        !claimed.some(
          ({ first, endSequence }) => sent.sequence >= first.sequence && sent.sequence < (endSequence ?? this.nextSequence),
        ),
    );
  }

  private bindAnswered(itemId: string): void {
    const signal = this.unheardSignals.find((unheard) => unheard.itemId === itemId);
    if (!signal || !this.speaker) return;
    const oldest = this.segments.find(({ claimed }) => !claimed);
    if (oldest) {
      this.resolve(signal, oldest);
      return;
    }
    this.unheardSignals.splice(this.unheardSignals.indexOf(signal), 1);
    const from = this.firstUnclaimedChunk();
    if (from) this.utteranceStarts.set(itemId, from.sent.sequence);
    this.callbacks.onHeard?.(itemId, {
      speaker: this.speaker,
      fromSequence: from?.sent.sequence ?? this.nextSequence,
      untilSequence: this.nextSequence,
      place: from ? { order: from.sent.order, startMs: from.sent.createdAt } : undefined,
    });
  }

  private resolveUnheardSignals(now: number): void {
    for (const signal of [...this.unheardSignals]) {
      const segment = this.segmentAfter(signal);
      if (segment && now - segment.startedAt > SARVAM_SIGNAL_LOOKBACK_MS) {
        this.resolve(signal, segment);
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
      if (this.segments.some(({ claimed }) => !claimed)) this.scheduleResolve();
    }, SARVAM_SIGNAL_LOOKBACK_MS + 1);
  }

  close(): void {
    this.closed = true;
    if (this.resolveTimer !== null) clearTimeout(this.resolveTimer);
    try {
      this.socket.send(buildSarvamFlushMessage());
      this.socket.send(buildSarvamEndOfStreamMessage());
    } catch {}
    try {
      this.socket.close();
    } catch {}
  }

  attach(): void {
    this.socket.addEventListener("message", (event) => {
      void this.handleEvent(String(event.data ?? ""));
    });
    this.socket.addEventListener("close", () => {
      if (!this.closed) void this.callbacks.onFailure("Sarvam transcription disconnected.");
    });
    this.socket.addEventListener("error", () => {
      if (!this.closed) void this.callbacks.onFailure("Sarvam transcription connection errored.");
    });
  }

  private async handleEvent(raw: string): Promise<void> {
    if (this.closed) return;
    const event = parseSarvamEvent(raw);
    if (event.type === "ignore") return;
    if (event.type === "error") {
      await this.callbacks.onFailure(event.message);
      return;
    }
    if (event.type === "speech_start") {
      this.handleSpeechStart();
      return;
    }
    if (event.type === "speech_end") {
      this.handleSpeechEnd();
      return;
    }
    const answered = this.awaitingFinal[0];
    if (
      !event.generatedId &&
      this.lastAnswer?.itemId === event.itemId &&
      this.lastAnswer.transcript === event.transcript &&
      this.lastAnswer.nextWaiting === (answered ?? null)
    ) {
      return;
    }
    if (!answered && !event.transcript) return;
    let itemId = answered;
    if (itemId) {
      this.resolveNow(itemId);
      this.bindAnswered(itemId);
    } else {
      if (!this.speaker) {
        this.rememberAnswer(event);
        return;
      }
      const from = this.firstUnclaimedChunk();
      itemId = this.nextUtteranceId();
      this.callbacks.onAccepted?.(itemId, {
        heard: true,
        speaker: this.speaker,
        fromSequence: from?.sent.sequence ?? this.nextSequence,
        untilSequence: this.nextSequence,
        place: from ? { order: from.sent.order, startMs: from.sent.createdAt } : undefined,
      });
    }
    const answeredFrom = this.utteranceStarts.get(itemId);
    this.utteranceStarts.delete(itemId);
    if (answeredFrom !== undefined) {
      this.sentSinceAnswer = this.sentSinceAnswer.filter(({ sent }) => sent.sequence >= answeredFrom);
    }
    this.settleUtterance(itemId);
    this.rememberAnswer(event);
    if (this.turn) {
      this.turn.accepted = false;
      this.turn.needsOnset = true;
    }
    this.callbacks.onCommitted(itemId);
    await this.callbacks.onFinal(itemId, event.transcript);
  }

  private rememberAnswer(event: { itemId: string; transcript: string }): void {
    this.lastAnswer = {
      itemId: event.itemId,
      transcript: event.transcript,
      nextWaiting: this.awaitingFinal[0] ?? null,
    };
  }
}

class PendingSarvamSocket implements LaneSocket {
  private socket: WebSocket | null = null;
  private pending: string[] = [];
  private readonly listeners: [LaneEvent, LaneListener][] = [];
  private closed = false;

  constructor(opened: Promise<WebSocket>, onOpen: () => void) {
    opened.then(
      (socket) => {
        if (this.closed) {
          try {
            socket.close();
          } catch {}
          return;
        }
        this.socket = socket;
        for (const [type, listener] of this.listeners) socket.addEventListener(type, listener as EventListener);
        for (const raw of this.pending) socket.send(raw);
        this.pending = [];
        onOpen();
      },
      () => {
        if (this.closed) return;
        for (const [type, listener] of this.listeners) if (type === "error") listener({});
      },
    );
  }

  get open(): boolean {
    return this.socket !== null;
  }

  send(raw: string): void {
    if (this.closed) throw new Error("Sarvam lane closed.");
    if (this.socket) this.socket.send(raw);
    else this.pending.push(raw);
  }

  close(): void {
    this.closed = true;
    this.pending = [];
    try {
      this.socket?.close();
    } catch {}
  }

  addEventListener(type: LaneEvent, listener: LaneListener): void {
    this.listeners.push([type, listener]);
    this.socket?.addEventListener(type, listener as EventListener);
  }
}

class SarvamTranscriptionSession implements LiveTranscriptionSession {
  readonly provider = "sarvam" as const;
  private readonly lanes = new Map<string, { lane: SarvamLane; socket: LaneSocket | PendingSarvamSocket }>();
  private unassigned: SarvamLane | null;
  private unassignedSocket: WebSocket | null;
  private closed = false;
  private readonly signals = { speech: false };

  constructor(
    socket: WebSocket,
    private readonly openSocket: () => Promise<WebSocket>,
    private readonly callbacks: LiveTranscriptionCallbacks,
  ) {
    this.unassigned = this.lane(socket);
    this.unassignedSocket = socket;
  }

  ready(speaker: TranscriptSpeaker): boolean {
    const { socket } = this.laneFor(speaker);
    return !(socket instanceof PendingSarvamSocket) || socket.open;
  }

  appendAudio(audioBase64: string, speaker?: TranscriptSpeaker, context?: AudioContext): string | null {
    if (!speaker) return null;
    return this.laneFor(speaker).lane.appendAudio(audioBase64, speaker, context);
  }

  private lane(socket: LaneSocket): SarvamLane {
    const lane = new SarvamLane(socket, this.callbacks, this.signals);
    lane.attach();
    return lane;
  }

  private laneFor(speaker: TranscriptSpeaker): { lane: SarvamLane; socket: LaneSocket | PendingSarvamSocket } {
    const key = `${speaker.userId}:${speaker.source}`;
    let entry = this.lanes.get(key);
    if (!entry) {
      if (this.unassigned && this.unassignedSocket) {
        entry = { lane: this.unassigned, socket: this.unassignedSocket };
      } else {
        const socket = new PendingSarvamSocket(this.openSocket(), () => {
          if (!this.closed) this.callbacks.onReady?.();
        });
        entry = { lane: this.lane(socket), socket };
      }
      this.unassigned = null;
      this.unassignedSocket = null;
      this.lanes.set(key, entry);
    }
    return entry;
  }

  commitAudio(): void {}

  clearAudio(speaker?: TranscriptSpeaker): void {
    if (speaker) {
      this.lanes.get(`${speaker.userId}:${speaker.source}`)?.lane.clearAudio();
      return;
    }
    for (const { lane } of this.lanes.values()) lane.clearAudio();
  }

  finishAudio(): void {
    for (const { lane } of this.lanes.values()) lane.finishAudio();
  }

  close(): void {
    this.closed = true;
    this.unassigned?.close();
    for (const { lane } of this.lanes.values()) lane.close();
  }
}

const openSarvamSocket = async (options: LiveTranscriptionConnectOptions, signal?: AbortSignal): Promise<WebSocket> => {
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
      signal,
    },
  );
  const socket = response.webSocket;
  if (!socket) {
    throw new Error(`Sarvam transcription connection failed (${response.status}).`);
  }
  socket.accept();
  return socket;
};

export const connectSarvamTranscription = async (
  options: LiveTranscriptionConnectOptions,
): Promise<LiveTranscriptionSession> => {
  const socket = await openSarvamSocket(options, options.signal);
  return new SarvamTranscriptionSession(
    socket,
    () => openSarvamSocket(options, AbortSignal.timeout(TRANSCRIPTION_CONNECT_TIMEOUT_MS)),
    options.callbacks,
  );
};
