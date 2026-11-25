import { AI_ENDPOINTS } from "@conclave/ai/models";
import {
  DEFAULT_TRANSCRIPTION_LOCALE,
  SARVAM_ANSWER_QUIET_MS,
  TRANSCRIPTION_LINE_DEADLINE_MS,
  SARVAM_LANE_IDLE_MS,
  SARVAM_MAX_LANES,
  SARVAM_WINDOW_QUIET_MS,
  SARVAM_WINDOW_ROTATE_MS,
  SARVAM_WINDOW_SETTLE_MS,
  TRANSCRIPTION_CONNECT_TIMEOUT_MS,
} from "../constants";
import { normalizeLocale, safeJsonParse, speakerKey, trimText } from "../utils";
import type { TranscriptSpeaker } from "@conclave/meeting-core/transcript-types";
import type {
  AudioContext,
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

type LaneWindow = {
  readonly itemId: string;
  heard: boolean;
  flushedAt: number | null;
  starts: number;
  finals: number;
  readonly words: string[];
};

class LaneSocket {
  private socket: WebSocket | null = null;
  private readonly listeners: [LaneEvent, LaneListener][] = [];
  private closed = false;

  constructor(opened: WebSocket | Promise<WebSocket>, onOpen: () => void) {
    if (!(opened instanceof Promise)) {
      this.socket = opened;
      return;
    }
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
        onOpen();
      },
      () => {
        if (this.closed) return;
        for (const [type, listener] of this.listeners) if (type === "error") listener({});
      },
    );
  }

  get open(): boolean {
    return this.socket !== null && !this.closed;
  }

  send(raw: string): void {
    if (!this.socket || this.closed) throw new Error("Sarvam lane is not open.");
    this.socket.send(raw);
  }

  close(): void {
    this.closed = true;
    try {
      this.socket?.close();
    } catch {}
  }

  addEventListener(type: LaneEvent, listener: LaneListener): void {
    this.listeners.push([type, listener]);
    this.socket?.addEventListener(type, listener as EventListener);
  }
}

class SarvamLane {
  private closed = false;
  private readonly downsampler = new Pcm24To16Downsampler();
  private readonly connectionId = crypto.randomUUID();
  private windowCount = 0;
  private window: LaneWindow | null = null;
  private last: { itemId: string; words: string[] } | null = null;
  private tailOwed = 0;
  private lastAnswer: { itemId: string; transcript: string } | null = null;
  private lastEventAt = Number.NEGATIVE_INFINITY;
  private settleTimer: ReturnType<typeof setTimeout> | null = null;
  private quietTimer: ReturnType<typeof setTimeout> | null = null;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  lastActiveAt = Date.now();
  draining = false;

  constructor(
    readonly key: string,
    private readonly socket: LaneSocket,
    private readonly speaker: TranscriptSpeaker,
    private readonly callbacks: LiveTranscriptionCallbacks,
    private readonly onIdle: (lane: SarvamLane) => void,
  ) {
    this.armIdle();
  }

  get busy(): boolean {
    return this.window !== null;
  }

  get spareable(): boolean {
    return this.windowCount > 0 && this.window === null;
  }

  get ready(): boolean {
    return !this.closed && this.socket.open && this.window?.flushedAt == null && (this.window !== null || this.tailOwed === 0);
  }

  get stalled(): boolean {
    const flushedAt = this.window?.flushedAt;
    return this.tailOwed > 0 || (flushedAt != null && Date.now() >= flushedAt + SARVAM_WINDOW_ROTATE_MS);
  }

  drain(): void {
    this.draining = true;
    this.stopIdle();
    if (this.window || this.tailOwed === 0) return;
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null;
      if (!this.closed) this.onIdle(this);
    }, TRANSCRIPTION_LINE_DEADLINE_MS);
  }

  owns(itemId: string): boolean {
    return this.window?.itemId === itemId || this.last?.itemId === itemId;
  }

  appendAudio(audioBase64: string, context?: AudioContext): string | null {
    if (!this.ready) throw new Error("Sarvam lane is waiting for its answer.");
    const downsampled = this.downsampler.downsample(audioBase64);
    if (downsampled) this.socket.send(buildSarvamAudioMessage(downsampled));
    this.lastActiveAt = Date.now();
    this.stopIdle();
    this.armQuiet();
    if (!context) return null;
    const heard = context.voice !== "quiet";
    const open = this.window;
    if (!open) {
      this.windowCount += 1;
      const window: LaneWindow = {
        itemId: createSarvamSegmentItemId(`sarvam-${this.connectionId}`, this.windowCount),
        heard,
        flushedAt: null,
        starts: 0,
        finals: 0,
        words: [],
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
    if (!window || window.flushedAt !== null) return;
    this.socket.send(buildSarvamFlushMessage());
    window.flushedAt = Date.now();
    this.armSettle();
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.settleTimer !== null) clearTimeout(this.settleTimer);
    this.stopQuiet();
    this.stopIdle();
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
      if (!this.closed) void this.callbacks.onFailure("Sarvam transcription disconnected.");
    });
    this.socket.addEventListener("error", () => {
      if (!this.closed) void this.callbacks.onFailure("Sarvam transcription connection errored.");
    });
  }

  private settleAt(window: LaneWindow): number {
    return Math.max((window.flushedAt ?? Date.now()) + SARVAM_WINDOW_SETTLE_MS, this.lastEventAt + SARVAM_ANSWER_QUIET_MS);
  }

  private armSettle(): void {
    const window = this.window;
    if (!window || window.flushedAt === null || this.closed) return;
    if (this.settleTimer !== null) clearTimeout(this.settleTimer);
    const flushedAt = window.flushedAt;
    this.settleTimer = setTimeout(() => {
      this.settleTimer = null;
      void this.settle().then(() => {
        if (this.window !== window || this.closed || this.settleTimer !== null) return;
        this.settleTimer = setTimeout(() => {
          this.settleTimer = null;
          if (this.window === window && !this.closed) this.callbacks.onReady?.();
        }, Math.max(0, flushedAt + SARVAM_WINDOW_ROTATE_MS - Date.now()));
      });
    }, Math.max(0, this.settleAt(window) - Date.now()));
  }

  finishIfAnswered(): void {
    const window = this.window;
    if (!this.closed && window && window.flushedAt !== null && this.answered(window)) void this.complete(window);
  }

  private answered(window: LaneWindow): boolean {
    return window.finals >= Math.max(window.starts, window.heard ? 1 : 0);
  }

  private async settle(): Promise<void> {
    const window = this.window;
    if (this.closed || !window || window.flushedAt === null) return;
    if (Date.now() < this.settleAt(window)) return;
    if (!this.answered(window)) return;
    await this.complete(window);
  }

  private async complete(window: LaneWindow): Promise<void> {
    if (this.settleTimer !== null) clearTimeout(this.settleTimer);
    this.settleTimer = null;
    this.window = null;
    this.last = { itemId: window.itemId, words: window.words };
    this.callbacks.onCommitted(window.itemId);
    await this.callbacks.onFinal(window.itemId, window.words.join(" "));
    if (this.closed) return;
    if (this.draining) {
      this.onIdle(this);
      return;
    }
    this.armIdle();
    this.callbacks.onReady?.();
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

  private armIdle(): void {
    this.stopIdle();
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null;
      if (!this.closed && !this.busy) this.onIdle(this);
    }, SARVAM_LANE_IDLE_MS);
  }

  private stopIdle(): void {
    if (this.idleTimer !== null) clearTimeout(this.idleTimer);
    this.idleTimer = null;
  }

  private async handleEvent(raw: string): Promise<void> {
    if (this.closed) return;
    const event = parseSarvamEvent(raw);
    if (event.type === "ignore") return;
    if (event.type === "error") {
      await this.callbacks.onFailure(event.message);
      return;
    }
    this.lastEventAt = Date.now();
    if (event.type === "speech_start") {
      this.lastAnswer = null;
      if (this.window) this.window.starts += 1;
      else {
        this.tailOwed += 1;
        this.callbacks.onReady?.();
      }
      this.armSettle();
      return;
    }
    if (event.type === "speech_end") {
      this.armSettle();
      return;
    }
    if (!event.generatedId && this.lastAnswer?.itemId === event.itemId && this.lastAnswer.transcript === event.transcript) {
      return;
    }
    this.lastAnswer = event.generatedId ? null : { itemId: event.itemId, transcript: event.transcript };
    const words = event.transcript.trim();
    const window = this.window;
    if (!window || this.tailOwed > 0) {
      this.tailOwed = Math.max(0, this.tailOwed - 1);
      const last = this.last;
      if (words && last) {
        last.words.push(words);
        await this.callbacks.onFinal(last.itemId, last.words.join(" "));
      }
      if (this.tailOwed === 0 && !this.window && this.draining && !this.closed) this.onIdle(this);
      else if (this.tailOwed === 0 && !this.window) this.callbacks.onReady?.();
      return;
    }
    window.finals += 1;
    if (words) {
      this.callbacks.onDelta(window.itemId, window.words.length > 0 ? ` ${words}` : words);
      window.words.push(words);
    }
    this.armSettle();
  }
}

class SarvamTranscriptionSession implements LiveTranscriptionSession {
  readonly provider = "sarvam" as const;
  private readonly lanes = new Map<string, SarvamLane>();
  private readonly draining = new Set<SarvamLane>();
  private spare: WebSocket | null;
  private closed = false;

  constructor(
    socket: WebSocket,
    private readonly openSocket: () => Promise<WebSocket>,
    private readonly callbacks: LiveTranscriptionCallbacks,
  ) {
    this.spare = socket;
  }

  ready(speaker: TranscriptSpeaker): boolean {
    return this.laneFor(speaker)?.ready ?? false;
  }

  appendAudio(audioBase64: string, speaker?: TranscriptSpeaker, context?: AudioContext): string | null {
    if (!speaker) return null;
    const lane = this.laneFor(speaker);
    if (!lane) throw new Error("No Sarvam lane is free for this speaker.");
    return lane.appendAudio(audioBase64, context);
  }

  private laneFor(speaker: TranscriptSpeaker): SarvamLane | null {
    const key = speakerKey(speaker);
    const known = this.lanes.get(key);
    if (this.closed) return known ?? null;
    if (known && (known.ready || !known.stalled || this.lanes.size + this.draining.size >= SARVAM_MAX_LANES)) return known;
    if (known) {
      known.drain();
      this.lanes.delete(key);
      this.draining.add(known);
    }
    if (this.lanes.size + this.draining.size >= SARVAM_MAX_LANES) {
      const idle = Array.from(this.lanes.values())
        .filter(({ spareable }) => spareable)
        .sort((left, right) => left.lastActiveAt - right.lastActiveAt)[0];
      if (!idle) return null;
      this.retire(idle);
    }
    const socket = new LaneSocket(this.spare ?? this.openSocket(), () => {
      if (!this.closed) this.callbacks.onReady?.();
    });
    this.spare = null;
    const lane = new SarvamLane(key, socket, speaker, this.callbacks, (done) => {
      this.retire(done);
      this.callbacks.onReady?.();
    });
    lane.attach();
    this.lanes.set(key, lane);
    return lane;
  }

  private retire(lane: SarvamLane): void {
    if (this.lanes.get(lane.key) === lane) this.lanes.delete(lane.key);
    this.draining.delete(lane);
    lane.close();
  }

  finishAnswered(): void {
    for (const lane of [...this.lanes.values(), ...this.draining]) lane.finishIfAnswered();
  }

  fence(providerItemId: string): void {
    for (const lane of [...this.lanes.values(), ...this.draining]) {
      if (lane.owns(providerItemId)) this.retire(lane);
    }
  }

  commitAudio(): void {}

  clearAudio(speaker?: TranscriptSpeaker): void {
    if (speaker) {
      this.lanes.get(speakerKey(speaker))?.flush();
      return;
    }
    for (const lane of this.lanes.values()) lane.flush();
  }

  finishAudio(): void {
    for (const lane of this.lanes.values()) lane.flush();
  }

  close(): void {
    this.closed = true;
    try {
      this.spare?.close();
    } catch {}
    this.spare = null;
    for (const lane of [...this.lanes.values(), ...this.draining]) lane.close();
    this.lanes.clear();
    this.draining.clear();
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
