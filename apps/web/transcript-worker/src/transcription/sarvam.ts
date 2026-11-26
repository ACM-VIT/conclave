import { AI_ENDPOINTS } from "@conclave/ai/models";
import {
  DEFAULT_TRANSCRIPTION_LOCALE,
  SARVAM_HUM_MS,
  SARVAM_HUM_RETRY_MS,
  SARVAM_LANE_IDLE_MS,
  SARVAM_MAX_LANES,
  SARVAM_RETRY_WAITS_MS,
  SARVAM_WINDOW_QUIET_MS,
  TRANSCRIPTION_CONNECT_TIMEOUT_MS,
  TRANSCRIPTION_GAP_MARKER,
  TRANSCRIPTION_LINE_DEADLINE_MS,
} from "../constants";
import { isRetryableTranscriptionFailure } from "../transcription-recovery";
import { normalizeLocale, safeJsonParse, speakerKey, trimText } from "../utils";
import type { TranscriptSpeaker } from "@conclave/meeting-core/transcript-types";
import {
  AudioNotSent,
  type AudioContext,
  type LiveTranscriptionCallbacks,
  type LiveTranscriptionConnectOptions,
  type LiveTranscriptionSession,
} from "./types";
import { SocketBudget, type SocketBudgetMember } from "./socket-budget";
import type { VoiceReading } from "./voice-activity";

const SARVAM_STT_WS_URL = AI_ENDPOINTS.sarvam.transcription;
const SARVAM_SAMPLE_RATE = 16_000;
const SARVAM_SAMPLE_RATE_PARAM = String(SARVAM_SAMPLE_RATE);
const SARVAM_AUDIO_ENCODING = "audio/wav";
const SARVAM_INPUT_AUDIO_CODEC = "pcm_s16le";
const SARVAM_DEFAULT_LANGUAGE_CODE = "unknown";
const SARVAM_DEFAULT_MODE = "codemix";
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

type LaneEvent = "message" | "close" | "error";
type LaneListener = (event: { data?: unknown }) => void;

type TurnWindow = {
  readonly itemId: string;
  heard: boolean;
  flushedAt: number | null;
  starts: number;
  speaking: boolean;
  finals: number;
  readonly words: string[];
  reported: boolean;
};

class LaneSocket {
  private socket: WebSocket | null = null;
  private readonly listeners: [LaneEvent, LaneListener][] = [];
  private readonly opening = new AbortController();
  private closed = false;
  private broken = false;

  constructor(
    opened: WebSocket | ((signal: AbortSignal) => Promise<WebSocket>),
    onOpen: () => void,
    onOpenFailed: (message: string) => void,
  ) {
    if (typeof opened !== "function") {
      this.socket = opened;
      return;
    }
    opened(this.opening.signal).then(
      (socket) => {
        if (this.closed) {
          try {
            socket.close();
          } catch {}
          return;
        }
        this.socket = socket;
        for (const [type, listener] of this.listeners) socket.addEventListener(type, listener as EventListener);
        onOpen();
      },
      (error: unknown) => {
        if (!this.closed) onOpenFailed(error instanceof Error ? error.message : "Sarvam transcription connection failed.");
      },
    );
  }

  get open(): boolean {
    return this.socket !== null && !this.closed && !this.broken;
  }

  send(raw: string): void {
    if (!this.socket || !this.open) throw new AudioNotSent();
    try {
      this.socket.send(raw);
    } catch {
      this.broken = true;
      queueMicrotask(() => {
        if (this.closed) return;
        for (const [type, listener] of this.listeners) if (type === "error") listener({});
      });
      throw new AudioNotSent();
    }
  }

  close(): void {
    this.closed = true;
    this.opening.abort();
    try {
      this.socket?.close();
    } catch {}
  }

  addEventListener(type: LaneEvent, listener: LaneListener): void {
    this.listeners.push([type, listener]);
    this.socket?.addEventListener(type, listener as EventListener);
  }
}

type TurnHost = {
  turnFlushed(turn: SarvamTurn): void;
  turnDone(turn: SarvamTurn): void;
  turnLost(turn: SarvamTurn, message: string, fromProvider: boolean): void;
  turnAlive(turn: SarvamTurn): void;
  turnSpoke(turn: SarvamTurn): void;
  turnFree(): void;
};

class SarvamTurn {
  private closed = false;
  private readonly downsampler = new Pcm24To16Downsampler();
  private readonly connectionId = crypto.randomUUID();
  private window: TurnWindow | null = null;
  private lastAnswer: { itemId: string; transcript: string } | null = null;
  private quietTimer: ReturnType<typeof setTimeout> | null = null;
  private holdTimer: ReturnType<typeof setTimeout> | null = null;
  key: string | null;
  alive = false;

  constructor(
    key: string | null,
    readonly socket: LaneSocket,
    private speaker: TranscriptSpeaker | null,
    private readonly callbacks: LiveTranscriptionCallbacks,
    private readonly host: TurnHost,
  ) {
    this.key = key;
    this.armHold(SARVAM_LANE_IDLE_MS);
  }

  claim(key: string, speaker: TranscriptSpeaker): void {
    this.key = key;
    this.speaker = speaker;
    this.armHold(SARVAM_LANE_IDLE_MS);
  }

  get ready(): boolean {
    return !this.closed && this.socket.open && this.window?.flushedAt == null;
  }

  get flushedAt(): number | null {
    return this.window?.flushedAt ?? null;
  }

  get evictable(): boolean {
    const window = this.window;
    if (this.closed) return false;
    if (!window) return this.key === null;
    if (window.flushedAt === null || window.finals < window.starts) return false;
    return window.reported || (!window.heard && window.starts === 0);
  }

  get itemId(): string | null {
    return this.window?.itemId ?? null;
  }

  get reported(): boolean {
    return this.window?.reported ?? false;
  }

  get owing(): boolean {
    const window = this.window;
    return !this.closed && window !== null && window.reported && window.words.length > 0 && window.finals < window.starts;
  }

  appendAudio(audioBase64: string, context?: AudioContext): string | null {
    if (!this.ready || !this.speaker) throw new AudioNotSent();
    const downsampled = this.downsampler.downsample(audioBase64);
    if (downsampled) this.socket.send(buildSarvamAudioMessage(downsampled));
    this.armQuiet();
    if (!context) return null;
    const heard = context.voice !== "quiet";
    const open = this.window;
    if (!open) {
      this.stopHold();
      const window: TurnWindow = {
        itemId: createSarvamSegmentItemId(`sarvam-${this.connectionId}`, 1),
        heard,
        flushedAt: null,
        starts: 0,
        speaking: false,
        finals: 0,
        words: [],
        reported: false,
      };
      this.window = window;
      this.callbacks.onAccepted?.(window.itemId, {
        heard,
        speaker: this.speaker,
        fromSequence: context.sequence,
        untilSequence: context.sequence + 1,
        place: { order: context.order, startMs: context.createdAt },
        lineId: context.lineId,
      });
      return window.itemId;
    }
    if (heard && !open.heard) {
      open.heard = true;
      this.callbacks.onHeard?.(open.itemId, {
        speaker: this.speaker,
        fromSequence: context.sequence,
        untilSequence: context.sequence + 1,
      });
    }
    return open.itemId;
  }

  flush(): void {
    this.stopQuiet();
    this.downsampler.reset();
    const window = this.window;
    if (!window || window.flushedAt !== null || this.closed) return;
    try {
      this.socket.send(buildSarvamFlushMessage());
    } catch {
      return;
    }
    window.flushedAt = Date.now();
    this.host.turnFlushed(this);
    this.armHold(TRANSCRIPTION_LINE_DEADLINE_MS);
    this.evaluate();
  }

  finish(): void {
    if (this.closed) return;
    const window = this.window;
    this.close();
    if (!window) return;
    const words = window.words.join(" ");
    const missing = window.finals < Math.max(window.starts, window.heard ? 1 : 0);
    const text = words && missing ? `${words} ${TRANSCRIPTION_GAP_MARKER}` : words;
    if (!window.reported) {
      window.reported = true;
      this.callbacks.onCommitted(window.itemId);
      void this.callbacks.onFinal(window.itemId, text);
    } else if (missing && words) {
      void this.callbacks.onFinal(window.itemId, text);
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.stopQuiet();
    this.stopHold();
    if (this.socket.open) {
      try {
        this.socket.send(buildSarvamFlushMessage());
        this.socket.send(buildSarvamEndOfStreamMessage());
      } catch {}
    }
    this.socket.close();
  }

  attach(): void {
    this.socket.addEventListener("message", (event) => {
      void this.handleEvent(String(event.data ?? ""));
    });
    this.socket.addEventListener("close", () => {
      if (!this.closed) this.host.turnLost(this, "Sarvam transcription disconnected.", false);
    });
    this.socket.addEventListener("error", () => {
      if (!this.closed) this.host.turnLost(this, "Sarvam transcription connection errored.", false);
    });
  }

  private evaluate(): void {
    const window = this.window;
    if (!window || window.flushedAt === null || this.closed) return;
    if (!window.reported && window.finals >= Math.max(window.starts, 1)) {
      window.reported = true;
      this.callbacks.onCommitted(window.itemId);
      void this.callbacks.onFinal(window.itemId, window.words.join(" "));
    }
    if (this.evictable) this.host.turnFree();
  }

  private armQuiet(): void {
    this.stopQuiet();
    this.quietTimer = setTimeout(() => {
      this.quietTimer = null;
      try {
        this.flush();
      } catch {}
    }, SARVAM_WINDOW_QUIET_MS);
  }

  private stopQuiet(): void {
    if (this.quietTimer !== null) clearTimeout(this.quietTimer);
    this.quietTimer = null;
  }

  private armHold(delay: number): void {
    this.stopHold();
    this.holdTimer = setTimeout(() => {
      this.holdTimer = null;
      if (this.closed) return;
      this.finish();
      this.host.turnDone(this);
    }, delay);
  }

  private stopHold(): void {
    if (this.holdTimer !== null) clearTimeout(this.holdTimer);
    this.holdTimer = null;
  }

  private async handleEvent(raw: string): Promise<void> {
    if (this.closed) return;
    const event = parseSarvamEvent(raw);
    if (event.type === "ignore") return;
    if (event.type === "error") {
      this.host.turnLost(this, event.message, true);
      return;
    }
    if (!this.alive) {
      this.alive = true;
      this.host.turnAlive(this);
    }
    const window = this.window;
    if (!window) return;
    if (event.type !== "final" || event.transcript.trim()) this.host.turnSpoke(this);
    if (event.type === "speech_end") {
      window.speaking = false;
      return;
    }
    if (event.type === "speech_start") {
      if (window.speaking) return;
      window.speaking = true;
      this.lastAnswer = null;
      window.starts += 1;
      return;
    }
    window.speaking = false;
    if (!event.generatedId && this.lastAnswer?.itemId === event.itemId && this.lastAnswer.transcript === event.transcript) {
      return;
    }
    this.lastAnswer = event.generatedId ? null : { itemId: event.itemId, transcript: event.transcript };
    window.finals += 1;
    const words = event.transcript.trim();
    if (words) {
      if (window.reported) {
        window.words.push(words);
        await this.callbacks.onFinal(window.itemId, window.words.join(" "));
      } else {
        this.callbacks.onDelta(window.itemId, window.words.length > 0 ? ` ${words}` : words);
        window.words.push(words);
      }
    }
    this.evaluate();
  }
}

class SarvamTranscriptionSession implements LiveTranscriptionSession, SocketBudgetMember {
  readonly provider = "sarvam" as const;
  private readonly turns = new Set<SarvamTurn>();
  private readonly accepting = new Map<string, SarvamTurn>();
  private readonly backoff = new Map<string, { attempts: number; until: number }>();
  private readonly quiet = new Map<string, { sentSince: number | null; lastAt: number; sarvamSpoke: boolean; withheldUntil: number }>();
  private spare: SarvamTurn | null = null;
  private heardFromSarvam = false;
  private closed = false;

  constructor(
    socket: WebSocket,
    private readonly openSocket: (signal: AbortSignal) => Promise<WebSocket>,
    private readonly callbacks: LiveTranscriptionCallbacks,
    private readonly budget: SocketBudget,
  ) {
    budget.join(this);
    const spare = new SarvamTurn(null, new LaneSocket(socket, () => {}, () => {}), null, callbacks, this);
    spare.attach();
    this.spare = spare;
    this.turns.add(spare);
  }

  releaseSpare(): boolean {
    const candidates = Array.from(this.turns).filter((turn) => turn.evictable);
    const oldest = candidates.sort((left, right) => (left.flushedAt ?? -1) - (right.flushedAt ?? -1))[0];
    if (!oldest) return false;
    oldest.finish();
    this.forget(oldest);
    return true;
  }

  wake(): void {
    if (!this.closed) this.callbacks.onReady?.();
  }

  turnFlushed(turn: SarvamTurn): void {
    this.stopAccepting(turn);
  }

  turnDone(turn: SarvamTurn): void {
    this.forget(turn);
    this.wake();
  }

  turnAlive(turn: SarvamTurn): void {
    this.heardFromSarvam = true;
    if (turn.key !== null) this.backoff.delete(turn.key);
  }

  turnSpoke(turn: SarvamTurn): void {
    const run = turn.key === null ? undefined : this.quiet.get(turn.key);
    if (run) run.sarvamSpoke = true;
  }

  turnFree(): void {
    this.budget.offer();
  }

  turnLost(turn: SarvamTurn, message: string, fromProvider: boolean): void {
    if (this.closed) return;
    if (!isRetryableTranscriptionFailure(message) || (fromProvider && !this.heardFromSarvam)) {
      void this.callbacks.onFailure(message);
      return;
    }
    const itemId = turn.itemId;
    const key = turn.key;
    const reported = turn.reported;
    if (reported) turn.finish();
    else turn.close();
    this.forget(turn);
    if (key !== null && !turn.alive) this.backOff(key);
    if (itemId && !reported) void this.callbacks.onItemLost?.(itemId);
    this.wake();
  }

  ready(speaker: TranscriptSpeaker): boolean {
    return this.turnFor(speaker)?.ready ?? false;
  }

  withholds(speaker: TranscriptSpeaker, voice: VoiceReading, at: number): boolean {
    const key = speakerKey(speaker);
    if (voice !== "quiet") {
      this.quiet.delete(key);
      return false;
    }
    const now = Date.now();
    let run = this.quiet.get(key);
    if (!run || at - run.lastAt > SARVAM_WINDOW_QUIET_MS) {
      run = { sentSince: null, lastAt: at, sarvamSpoke: false, withheldUntil: 0 };
      this.quiet.set(key, run);
    }
    run.lastAt = at;
    if (now < run.withheldUntil) return true;
    const offeredAgain = run.withheldUntil > 0;
    if (!offeredAgain && (run.sentSince === null || now - run.sentSince < SARVAM_HUM_MS)) return false;
    const hum = !offeredAgain && !run.sarvamSpoke;
    if (!offeredAgain) this.accepting.get(key)?.flush();
    run.sentSince = null;
    run.sarvamSpoke = false;
    run.withheldUntil = hum ? now + SARVAM_HUM_RETRY_MS : 0;
    return hum;
  }

  owes(): boolean {
    return Array.from(this.turns).some((turn) => turn.owing);
  }

  settle(): void {
    for (const turn of Array.from(this.turns)) {
      if (!turn.owing) continue;
      turn.finish();
      this.forget(turn);
    }
  }

  appendAudio(audioBase64: string, speaker?: TranscriptSpeaker, context?: AudioContext): string | null {
    if (!speaker) return null;
    const turn = this.turnFor(speaker);
    if (!turn) throw new AudioNotSent();
    const itemId = turn.appendAudio(audioBase64, context);
    const run = context?.voice === "quiet" ? this.quiet.get(speakerKey(speaker)) : undefined;
    if (run) run.sentSince ??= Date.now();
    return itemId;
  }

  private turnFor(speaker: TranscriptSpeaker): SarvamTurn | null {
    const key = speakerKey(speaker);
    const current = this.accepting.get(key);
    if (current || this.closed) return current ?? null;
    const waiting = this.backoff.get(key);
    if (waiting && Date.now() < waiting.until) return null;
    let turn = this.spare;
    if (turn?.ready) {
      this.spare = null;
      turn.claim(key, speaker);
    } else {
      if (!this.budget.take(this)) return null;
      turn = new SarvamTurn(
        key,
        new LaneSocket(
          this.openSocket,
          () => this.wake(),
          (message) => this.turnLost(turn!, message, false),
        ),
        speaker,
        this.callbacks,
        this,
      );
      turn.attach();
      this.turns.add(turn);
    }
    this.accepting.set(key, turn);
    return turn;
  }

  private stopAccepting(turn: SarvamTurn): void {
    if (turn.key !== null && this.accepting.get(turn.key) === turn) this.accepting.delete(turn.key);
  }

  private backOff(key: string): void {
    const known = this.backoff.get(key);
    if (known && Date.now() < known.until) return;
    const attempts = (known?.attempts ?? 0) + 1;
    const delay = SARVAM_RETRY_WAITS_MS[Math.min(attempts, SARVAM_RETRY_WAITS_MS.length) - 1];
    this.backoff.set(key, { attempts, until: Date.now() + delay });
    setTimeout(() => this.wake(), delay);
  }

  private forget(turn: SarvamTurn): void {
    if (!this.turns.delete(turn)) return;
    if (this.spare === turn) this.spare = null;
    this.stopAccepting(turn);
    turn.close();
    this.budget.give();
  }

  fence(providerItemId: string): void {
    for (const turn of Array.from(this.turns)) {
      if (turn.itemId === providerItemId) this.forget(turn);
    }
    this.wake();
  }

  commitAudio(): void {}

  clearAudio(speaker?: TranscriptSpeaker): void {
    const turns = speaker ? [this.accepting.get(speakerKey(speaker))] : Array.from(this.accepting.values());
    for (const turn of turns) turn?.flush();
  }

  finishAudio(): void {
    this.clearAudio();
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const turn of Array.from(this.turns)) this.forget(turn);
    this.budget.leave(this);
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
  const budget = options.socketBudget ?? new SocketBudget(SARVAM_MAX_LANES);
  await budget.acquire(options.signal);
  let socket: WebSocket;
  try {
    socket = await openSarvamSocket(options, options.signal);
  } catch (error) {
    budget.give();
    throw error;
  }
  return new SarvamTranscriptionSession(
    socket,
    (signal) => openSarvamSocket(options, AbortSignal.any([signal, AbortSignal.timeout(TRANSCRIPTION_CONNECT_TIMEOUT_MS)])),
    options.callbacks,
    budget,
  );
};
