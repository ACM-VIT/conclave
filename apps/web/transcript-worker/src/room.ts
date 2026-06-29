import type {
  TranscriptMinutesSnapshot,
  TranscriptSegment,
  TranscriptSegmentDelta,
  TranscriptSessionState,
  TranscriptSpeaker,
} from "@conclave/meeting-core/transcript-types";
import { normalizeRealtimeTranscriptModel } from "@conclave/meeting-core/transcript-models";
import {
  DEFAULT_MAX_SEGMENTS,
  DEFAULT_QA_MODEL,
  DEFAULT_TRANSCRIPT_MODEL,
  DEFAULT_IDLE_TTL_MS,
  MAX_AUDIO_CHUNK_BASE64_BYTES,
  MAX_CLIENT_MESSAGE_BYTES,
  MIN_OPENAI_COMMIT_AUDIO_SAMPLES,
  MIN_MINUTES_REFRESH_MS,
} from "./constants";
import { verifyTranscriptRoomToken } from "./auth";
import {
  createEmptyMinutes,
  fallbackMinutes,
} from "./minutes";
import {
  hasGlobalOpenAiApiKey,
  resolveTranscriptOpenAiApiKey,
} from "./key-policy";
import {
  buildRealtimeTranscriptionConfig,
  generateMinutes,
  realtimeEndpoint,
  streamQuestionAnswer,
} from "./openai";
import {
  takeTranscriptRateLimit,
  type TranscriptRateBucketName,
} from "./rate-limit";
import { getTranscriptServiceVersion } from "./service-version";
import { recoverPersistedTranscriptSession } from "./session-recovery";
import { TranscriptSpeakerAttribution } from "./speaker-attribution";
import {
  canRefreshTranscriptMinutes,
  canStopTranscriptSession,
  resolveTranscriptStartPermission,
  shouldRequestControllerHandoff,
} from "./session-policy";
import type {
  ClientEnvelope,
  Env,
  OpenAiRealtimeEvent,
  PersistedSnapshot,
  QaAskEnvelope,
  SessionStartEnvelope,
  Viewer,
} from "./types";
import {
  json,
  normalizeDelay,
  normalizeLanguage,
  normalizeLocale,
  normalizeModel,
  normalizeRoomIdFromPath,
  normalizeSpeaker,
  parsePositiveInt,
  redactSensitiveText,
  safeJsonParse,
  createSilentPcm16Base64,
  estimatePcm16Base64SampleCount,
  trimText,
} from "./utils";

const createIdleSession = (roomId: string): TranscriptSessionState => ({
  roomId,
  status: "idle",
  controller: null,
  transcriptModel: DEFAULT_TRANSCRIPT_MODEL,
  qaModel: DEFAULT_QA_MODEL,
  keySource: null,
  startedAt: null,
  updatedAt: Date.now(),
  error: null,
});

export class TranscriptRoom {
  private readonly state: DurableObjectState;
  private readonly env: Env;
  private readonly loaded: Promise<void>;
  private readonly viewers = new Map<WebSocket, Viewer>();
  private readonly partialSegments = new Map<string, TranscriptSegment>();
  private readonly speakerAttribution = new TranscriptSpeakerAttribution();
  private latestSpeaker: TranscriptSpeaker | null = null;
  private hasPendingAudio = false;
  private pendingAudioSamples = 0;
  private session: TranscriptSessionState | null = null;
  private segments: TranscriptSegment[] = [];
  private minutes: TranscriptMinutesSnapshot = createEmptyMinutes();
  private sequence = 0;
  private apiKey: string | null = null;
  private openAiSocket: WebSocket | null = null;
  private openAiGeneration = 0;
  private lastMinutesRefreshAt = 0;

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;
    this.loaded = this.load();
  }

  async fetch(request: Request): Promise<Response> {
    await this.loaded;

    const url = new URL(request.url);
    const roomId = normalizeRoomIdFromPath(url.pathname);
    if (!roomId) return json({ error: "Not found" }, { status: 404 });

    const payload = await verifyTranscriptRoomToken(
      url.searchParams.get("token") || "",
      this.env.TRANSCRIPT_TOKEN_SECRET,
      roomId,
    );
    if (!payload) {
      return json({ error: "Invalid transcript token" }, { status: 401 });
    }

    const allowedOrigin = this.env.TRANSCRIPT_ALLOWED_ORIGIN?.trim();
    const origin = request.headers.get("origin") || "";
    if (allowedOrigin && origin && origin !== allowedOrigin) {
      return json({ error: "Origin not allowed" }, { status: 403 });
    }

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    const viewer: Viewer = {
      id: crypto.randomUUID(),
      socket: server,
      userId: payload.userId!,
      displayName: payload.displayName || payload.userId!,
      capabilities: {
        start: payload.capabilities?.start !== false,
        takeover: payload.capabilities?.takeover !== false,
        stop: payload.capabilities?.stop === true,
        ask: payload.capabilities?.ask !== false,
      },
      connectedAt: Date.now(),
      rateLimits: {},
    };

    server.accept();
    this.viewers.set(server, viewer);
    this.ensureSession(roomId);
    this.send(server, {
      type: "snapshot",
      viewerConnectionId: viewer.id,
      session: this.session,
      globalOpenAiKeyAvailable: this.hasGlobalOpenAiKey(),
      serviceVersion: this.serviceVersion(),
      segments: this.segments,
      partials: Array.from(this.partialSegments.values()),
      minutes: this.minutes,
    });
    this.broadcastSession();

    server.addEventListener("message", (event) => {
      void this.handleMessage(viewer, String(event.data ?? ""));
    });
    server.addEventListener("close", () => {
      void this.handleClose(viewer);
    });
    server.addEventListener("error", () => {
      void this.handleClose(viewer);
    });

    await this.armCleanupAlarm();
    return new Response(null, { status: 101, webSocket: client });
  }

  async alarm(): Promise<void> {
    await this.loaded;
    if (this.viewers.size !== 0) return;

    if (this.session?.status === "live" || this.session?.status === "starting") {
      this.markTakeoverNeeded("Transcript controller disconnected.");
    }
    if (
      this.session?.status === "idle" ||
      this.session?.status === "takeover_needed" ||
      this.session?.status === "error"
    ) {
      await this.state.storage.delete("snapshot");
      this.resetInMemorySession(this.session.roomId, this.session.qaModel);
    }
  }

  private async load(): Promise<void> {
    const snapshot = await this.state.storage.get<PersistedSnapshot>("snapshot");
    if (!snapshot) return;
    this.session = recoverPersistedTranscriptSession(
      snapshot.session,
      snapshot.serviceVersion,
      this.serviceVersion(),
    );
    this.segments = snapshot.segments ?? [];
    this.minutes = snapshot.minutes ?? createEmptyMinutes(this.session.qaModel);
    this.sequence = snapshot.sequence ?? this.segments.length;
  }

  private ensureSession(roomId: string): TranscriptSessionState {
    if (!this.session) {
      this.session = createIdleSession(roomId);
      this.minutes = createEmptyMinutes();
    }
    return this.session;
  }

  private send(socket: WebSocket, data: unknown): void {
    try {
      socket.send(JSON.stringify(data));
    } catch {
      this.viewers.delete(socket);
    }
  }

  private broadcast(data: unknown): void {
    for (const viewer of this.viewers.values()) {
      this.send(viewer.socket, data);
    }
  }

  private broadcastSession(): void {
    this.broadcast({
      type: "session.state",
      session: this.session,
      globalOpenAiKeyAvailable: this.hasGlobalOpenAiKey(),
      serviceVersion: this.serviceVersion(),
    });
  }

  private hasGlobalOpenAiKey(): boolean {
    return hasGlobalOpenAiApiKey(this.env);
  }

  private serviceVersion() {
    return getTranscriptServiceVersion(this.env);
  }

  private sendError(viewer: Viewer, message: string): void {
    this.send(viewer.socket, {
      type: "error",
      message: redactSensitiveText(message),
    });
  }

  private async handleMessage(viewer: Viewer, raw: string): Promise<void> {
    if (raw.length > MAX_CLIENT_MESSAGE_BYTES) {
      this.sendError(viewer, "Transcript message is too large.");
      return;
    }

    const parsed = safeJsonParse(raw);
    if (!parsed || typeof parsed !== "object") {
      this.sendError(viewer, "Invalid transcript message.");
      return;
    }

    const message = parsed as ClientEnvelope;
    const rateBucket = this.rateBucketForMessage(message);
    if (
      rateBucket &&
      !takeTranscriptRateLimit(viewer.rateLimits, rateBucket)
    ) {
      this.sendError(viewer, "Transcript message rate limit exceeded.");
      return;
    }

    switch (message.type) {
      case "session.start":
      case "session.takeover":
        await this.startSession(viewer, message);
        return;
      case "session.stop":
        await this.stopSession(viewer);
        return;
      case "audio.chunk":
        if ((message.audio?.length ?? 0) > MAX_AUDIO_CHUNK_BASE64_BYTES) {
          this.sendError(viewer, "Transcript audio chunk is too large.");
          return;
        }
        this.appendAudio(viewer, message.audio, message.speaker);
        return;
      case "audio.commit":
        this.commitAudio(viewer, message.speaker);
        return;
      case "audio.clear":
        this.clearAudio(viewer);
        return;
      case "qa.ask":
        await this.answerQuestion(viewer, message);
        return;
      case "minutes.refresh":
        if (
          !canRefreshTranscriptMinutes({
            viewerCanAsk: viewer.capabilities.ask,
          })
        ) {
          this.sendError(viewer, "You cannot refresh transcript minutes.");
          return;
        }
        await this.refreshMinutes({ force: true });
        return;
      case "export.snapshot":
        this.send(viewer.socket, {
          type: "snapshot",
          viewerConnectionId: viewer.id,
          session: this.session,
          globalOpenAiKeyAvailable: this.hasGlobalOpenAiKey(),
          serviceVersion: this.serviceVersion(),
          segments: this.segments,
          partials: Array.from(this.partialSegments.values()),
          minutes: this.minutes,
        });
        return;
      default:
        this.sendError(viewer, "Unsupported transcript message.");
    }
  }

  private async handleClose(viewer: Viewer): Promise<void> {
    this.viewers.delete(viewer.socket);
    if (
      shouldRequestControllerHandoff({
        closingConnectionId: viewer.id,
        closingUserId: viewer.userId,
        controllerConnectionId: this.session?.controller?.connectionId,
        controllerUserId: this.session?.controller?.userId,
        remainingUserIds: Array.from(this.viewers.values(), (item) => item.userId),
      })
    ) {
      this.markTakeoverNeeded("Transcript controller disconnected.");
      this.broadcast({
        type: "handoff.requested",
        session: this.session,
        globalOpenAiKeyAvailable: this.hasGlobalOpenAiKey(),
        serviceVersion: this.serviceVersion(),
      });
      await this.persist();
    }
    await this.armCleanupAlarm();
  }

  private async startSession(
    viewer: Viewer,
    message: SessionStartEnvelope,
  ): Promise<void> {
    const existingStatus = this.session?.status ?? "idle";
    const takeover = message.type === "session.takeover";
    const permission = resolveTranscriptStartPermission({
      canStart: viewer.capabilities.start,
      canTakeover: viewer.capabilities.takeover,
      controllerUserId: this.session?.controller?.userId,
      existingStatus,
      isTakeover: takeover,
      viewerUserId: viewer.userId,
    });
    if (!permission.ok) {
      this.sendError(viewer, permission.message);
      return;
    }

    const keyResolution = resolveTranscriptOpenAiApiKey({
      providedApiKey: message.apiKey,
      globalApiKey: this.env.OPENAI_API_KEY,
    });
    if (!keyResolution.ok) {
      this.sendError(viewer, keyResolution.message);
      return;
    }

    const roomId = this.session?.roomId || "unknown";
    const now = Date.now();
    const transcriptModel = normalizeRealtimeTranscriptModel(
      normalizeModel(message.transcriptModel, DEFAULT_TRANSCRIPT_MODEL),
      DEFAULT_TRANSCRIPT_MODEL,
    );
    const qaModel = normalizeModel(message.qaModel, DEFAULT_QA_MODEL);
    const wasIdle = existingStatus === "idle" || existingStatus === "error";
    this.apiKey = keyResolution.apiKey;
    this.session = {
      roomId,
      status: "starting",
      controller: {
        userId: viewer.userId,
        displayName: viewer.displayName,
        connectionId: viewer.id,
        startedAt: wasIdle ? now : (this.session?.startedAt ?? now),
        lastSeenAt: now,
      },
      transcriptModel,
      qaModel,
      keySource: keyResolution.source,
      startedAt: wasIdle ? now : (this.session?.startedAt ?? now),
      updatedAt: now,
      error: null,
    };
    this.resetOpenAiAudioState();
    if (wasIdle) {
      this.segments = [];
      this.sequence = 0;
      this.minutes = createEmptyMinutes(qaModel);
      this.lastMinutesRefreshAt = 0;
    }
    this.broadcastSession();
    await this.persist();

    try {
      await this.connectOpenAi({
        apiKey: keyResolution.apiKey,
        transcriptModel,
        language: normalizeLanguage(
          message.language ?? this.env.TRANSCRIPT_TRANSCRIPTION_LANGUAGE,
        ),
        delay: normalizeDelay(message.delay),
        locale: normalizeLocale(this.env.TRANSCRIPT_TRANSCRIPTION_LOCALE),
        localizationPrompt: this.env.TRANSCRIPT_TRANSCRIPTION_PROMPT,
      });
      this.session = {
        ...this.session,
        status: "live",
        updatedAt: Date.now(),
        error: null,
      };
      this.broadcastSession();
      await this.persist();
    } catch (error) {
      this.markTakeoverNeeded(
        error instanceof Error
          ? error.message
          : "Failed to connect transcription model.",
      );
      this.broadcastSession();
      await this.persist();
    }
  }

  private async stopSession(viewer: Viewer): Promise<void> {
    const controllerId = this.session?.controller?.userId;
    if (
      !canStopTranscriptSession({
        controllerUserId: controllerId,
        viewerCanStop: viewer.capabilities.stop,
        viewerUserId: viewer.userId,
      })
    ) {
      this.sendError(viewer, "Only the controller, host, or admin can stop.");
      return;
    }

    this.closeOpenAi();
    const roomId = this.session?.roomId || "unknown";
    this.apiKey = null;
    this.session = {
      ...createIdleSession(roomId),
      transcriptModel: this.session?.transcriptModel ?? DEFAULT_TRANSCRIPT_MODEL,
      qaModel: this.session?.qaModel ?? DEFAULT_QA_MODEL,
    };
    this.segments = [];
    this.resetOpenAiAudioState();
    this.sequence = 0;
    this.lastMinutesRefreshAt = 0;
    this.minutes = createEmptyMinutes(this.session.qaModel);
    await this.state.storage.delete("snapshot");
    this.broadcast({
      type: "snapshot",
      session: this.session,
      globalOpenAiKeyAvailable: this.hasGlobalOpenAiKey(),
      serviceVersion: this.serviceVersion(),
      segments: [],
      partials: [],
      minutes: this.minutes,
    });
  }

  private appendAudio(
    viewer: Viewer,
    audio: string | undefined,
    speaker: Partial<TranscriptSpeaker> | undefined,
  ): void {
    if (!this.isController(viewer)) return;
    if (!audio || !this.openAiSocket) return;
    const sampleCount = estimatePcm16Base64SampleCount(audio);
    if (sampleCount <= 0) return;
    const normalizedSpeaker = normalizeSpeaker(speaker, viewer);
    if (
      this.hasPendingAudio &&
      this.latestSpeaker &&
      !this.isSameAudioSpeaker(this.latestSpeaker, normalizedSpeaker) &&
      !this.commitOpenAiBuffer(
        this.latestSpeaker,
        "Transcript speaker handoff failed.",
      )
    ) {
      return;
    }
    try {
      this.openAiSocket.send(
        JSON.stringify({ type: "input_audio_buffer.append", audio }),
      );
      this.latestSpeaker = normalizedSpeaker;
      this.hasPendingAudio = true;
      this.pendingAudioSamples += sampleCount;
      if (this.session?.controller) {
        this.session.controller.lastSeenAt = Date.now();
      }
    } catch {
      void this.handleOpenAiFailure("Transcript audio stream failed.");
    }
  }

  private commitAudio(
    viewer: Viewer,
    speaker: Partial<TranscriptSpeaker> | undefined,
  ): void {
    if (
      !this.isController(viewer) ||
      !this.openAiSocket ||
      !this.hasPendingAudio
    ) {
      return;
    }
    const normalizedSpeaker = normalizeSpeaker(
      speaker,
      this.latestSpeaker ?? viewer,
    );
    this.latestSpeaker = normalizedSpeaker;
    this.commitOpenAiBuffer(normalizedSpeaker, "Transcript audio commit failed.");
  }

  private commitOpenAiBuffer(
    speaker: TranscriptSpeaker,
    failureMessage: string,
  ): boolean {
    if (!this.openAiSocket || !this.hasPendingAudio) return false;
    try {
      const paddingSamples =
        MIN_OPENAI_COMMIT_AUDIO_SAMPLES - this.pendingAudioSamples;
      if (paddingSamples > 0) {
        this.openAiSocket.send(
          JSON.stringify({
            type: "input_audio_buffer.append",
            audio: createSilentPcm16Base64(paddingSamples),
          }),
        );
      }
      this.openAiSocket.send(
        JSON.stringify({ type: "input_audio_buffer.commit" }),
      );
      this.speakerAttribution.enqueueCommit(speaker);
      this.hasPendingAudio = false;
      this.pendingAudioSamples = 0;
      return true;
    } catch {
      void this.handleOpenAiFailure(failureMessage);
      return false;
    }
  }

  private clearAudio(viewer: Viewer): void {
    if (!this.isController(viewer) || !this.openAiSocket) return;
    if (this.hasPendingAudio && this.latestSpeaker) {
      this.commitOpenAiBuffer(
        this.latestSpeaker,
        "Transcript audio commit failed.",
      );
      return;
    }
    try {
      this.openAiSocket.send(
        JSON.stringify({ type: "input_audio_buffer.clear" }),
      );
    } catch {
      void this.handleOpenAiFailure("Transcript audio clear failed.");
      return;
    }
    this.hasPendingAudio = false;
    this.pendingAudioSamples = 0;
  }

  private isSameAudioSpeaker(
    left: TranscriptSpeaker,
    right: TranscriptSpeaker,
  ): boolean {
    return left.userId === right.userId && left.source === right.source;
  }

  private isController(viewer: Viewer): boolean {
    const controller = this.session?.controller;
    if (!controller) return false;
    if (controller.connectionId) return controller.connectionId === viewer.id;
    return controller.userId === viewer.userId;
  }

  private async connectOpenAi(options: {
    apiKey: string;
    transcriptModel: string;
    language: string;
    delay: string;
    locale: string;
    localizationPrompt?: string;
  }): Promise<void> {
    this.closeOpenAi();
    const response = await fetch(
      realtimeEndpoint(this.env),
      {
        headers: {
          Authorization: `Bearer ${options.apiKey}`,
          Upgrade: "websocket",
        },
      },
    );
    const socket = response.webSocket;
    if (!socket) {
      throw new Error(
        `Realtime transcription connection failed (${response.status}).`,
      );
    }

    socket.accept();
    const generation = this.openAiGeneration + 1;
    this.openAiGeneration = generation;
    this.openAiSocket = socket;
    socket.addEventListener("message", (event) => {
      if (!this.isCurrentOpenAiSocket(socket, generation)) return;
      void this.handleOpenAiEvent(String(event.data ?? ""));
    });
    socket.addEventListener("close", () => {
      if (!this.isCurrentOpenAiSocket(socket, generation)) return;
      if (
        this.session?.status === "live" ||
        this.session?.status === "starting"
      ) {
        void this.handleOpenAiFailure("Transcription model disconnected.");
      }
    });
    socket.addEventListener("error", () => {
      if (!this.isCurrentOpenAiSocket(socket, generation)) return;
      void this.handleOpenAiFailure("Transcription model connection errored.");
    });

    const transcription = buildRealtimeTranscriptionConfig({
      model: options.transcriptModel,
      language: options.language,
      delay: options.delay,
      locale: options.locale,
      localizationPrompt: options.localizationPrompt,
    });

    socket.send(
      JSON.stringify({
        type: "session.update",
        session: {
          type: "transcription",
          audio: {
            input: {
              format: {
                type: "audio/pcm",
                rate: 24000,
              },
              transcription,
              turn_detection: null,
            },
          },
        },
      }),
    );
  }

  private closeOpenAi(): void {
    const socket = this.openAiSocket;
    this.openAiGeneration += 1;
    this.openAiSocket = null;
    this.resetOpenAiAudioState();
    try {
      socket?.close();
    } catch {}
  }

  private isCurrentOpenAiSocket(socket: WebSocket, generation: number): boolean {
    return this.openAiSocket === socket && this.openAiGeneration === generation;
  }

  private resetOpenAiAudioState(): void {
    const hadPartials = this.partialSegments.size > 0;
    this.partialSegments.clear();
    this.speakerAttribution.reset();
    this.latestSpeaker = null;
    this.hasPendingAudio = false;
    this.pendingAudioSamples = 0;
    if (hadPartials) {
      this.broadcast({ type: "partials.reset" });
    }
  }

  private async handleOpenAiEvent(raw: string): Promise<void> {
    const parsed = safeJsonParse(raw);
    if (!parsed || typeof parsed !== "object") return;
    const event = parsed as OpenAiRealtimeEvent;
    if (event.type === "error") {
      await this.handleOpenAiFailure(
        event.error?.message || "Realtime transcription error.",
      );
      return;
    }
    if (event.type === "input_audio_buffer.committed" && event.item_id) {
      const speaker = this.speakerAttribution.bindCommittedItem(event.item_id);
      if (speaker) {
        this.reassignSegmentSpeaker(event.item_id, speaker);
      }
      return;
    }
    if (
      event.type === "conversation.item.input_audio_transcription.delta" &&
      event.item_id &&
      event.delta
    ) {
      this.applyTranscriptDelta(event.item_id, event.delta);
      return;
    }
    if (
      event.type === "conversation.item.input_audio_transcription.completed" &&
      event.item_id
    ) {
      void this.applyTranscriptFinal(event.item_id, event.transcript || "");
    }
  }

  private async handleOpenAiFailure(message: string): Promise<void> {
    const redactedMessage = redactSensitiveText(message);
    this.broadcast({
      type: "error",
      message: redactedMessage,
    });

    if (
      this.session?.status !== "live" &&
      this.session?.status !== "starting"
    ) {
      return;
    }

    this.markTakeoverNeeded(redactedMessage);
    this.broadcastSession();
    await this.persist();
  }

  private allocateSegment(itemId: string): TranscriptSegment {
    const existing = this.partialSegments.get(itemId);
    if (existing) return existing;
    const speaker =
      this.speakerAttribution.getItemSpeaker(itemId) ??
      this.speakerAttribution.peekPendingSpeaker() ??
      this.latestSpeaker ??
      normalizeSpeaker(undefined, {
        userId: this.session?.controller?.userId || "unknown",
        displayName: this.session?.controller?.displayName || "Unknown",
      });
    const now = Date.now();
    const segment: TranscriptSegment = {
      id: itemId,
      itemId,
      sequence: this.sequence,
      speakerUserId: speaker.userId,
      speakerDisplayName: speaker.displayName,
      source: speaker.source,
      text: "",
      startMs: now,
      endMs: null,
      isFinal: false,
      updatedAt: now,
    };
    this.sequence += 1;
    this.partialSegments.set(itemId, segment);
    return segment;
  }

  private reassignSegmentSpeaker(
    itemId: string,
    speaker: TranscriptSpeaker,
  ): void {
    const partial = this.partialSegments.get(itemId);
    if (partial && !this.hasSegmentSpeaker(partial, speaker)) {
      const now = Date.now();
      const next: TranscriptSegment = {
        ...partial,
        speakerUserId: speaker.userId,
        speakerDisplayName: speaker.displayName,
        source: speaker.source,
        updatedAt: now,
      };
      this.partialSegments.set(itemId, next);
      this.broadcast({
        type: "segment.delta",
        delta: this.toSegmentDelta(next, "", now),
      });
    }

    const finalIndex = this.segments.findIndex(
      (candidate) => candidate.itemId === itemId,
    );
    if (finalIndex < 0) return;

    const finalSegment = this.segments[finalIndex];
    if (!finalSegment || this.hasSegmentSpeaker(finalSegment, speaker)) return;
    const nextFinal: TranscriptSegment = {
      ...finalSegment,
      speakerUserId: speaker.userId,
      speakerDisplayName: speaker.displayName,
      source: speaker.source,
      updatedAt: Date.now(),
    };
    this.segments[finalIndex] = nextFinal;
    this.broadcast({ type: "segment.final", segment: nextFinal });
  }

  private hasSegmentSpeaker(
    segment: TranscriptSegment,
    speaker: TranscriptSpeaker,
  ): boolean {
    return (
      segment.speakerUserId === speaker.userId &&
      segment.speakerDisplayName === speaker.displayName &&
      segment.source === speaker.source
    );
  }

  private toSegmentDelta(
    segment: TranscriptSegment,
    delta: string,
    updatedAt: number,
  ): TranscriptSegmentDelta {
    return {
      id: segment.id,
      itemId: segment.itemId,
      sequence: segment.sequence,
      speaker: {
        userId: segment.speakerUserId,
        displayName: segment.speakerDisplayName,
        source: segment.source,
      },
      text: segment.text,
      delta,
      startMs: segment.startMs,
      updatedAt,
    };
  }

  private applyTranscriptDelta(itemId: string, delta: string): void {
    const segment = this.allocateSegment(itemId);
    const now = Date.now();
    const next: TranscriptSegment = {
      ...segment,
      text: `${segment.text}${delta}`,
      updatedAt: now,
    };
    this.partialSegments.set(itemId, next);
    this.broadcast({
      type: "segment.delta",
      delta: this.toSegmentDelta(next, delta, now),
    });
  }

  private async applyTranscriptFinal(
    itemId: string,
    transcript: string,
  ): Promise<void> {
    const segment = this.allocateSegment(itemId);
    const text = transcript.trim() || segment.text.trim();
    this.partialSegments.delete(itemId);
    if (!text) return;

    const now = Date.now();
    const finalSegment: TranscriptSegment = {
      ...segment,
      text,
      endMs: now,
      isFinal: true,
      updatedAt: now,
    };
    const existingIndex = this.segments.findIndex(
      (candidate) => candidate.itemId === itemId,
    );
    if (existingIndex >= 0) {
      this.segments[existingIndex] = finalSegment;
    } else {
      this.segments.push(finalSegment);
    }
    this.segments.sort((left, right) => left.sequence - right.sequence);
    this.trimSegments();
    this.broadcast({ type: "segment.final", segment: finalSegment });
    this.minutes = fallbackMinutes(
      this.segments,
      this.session?.qaModel || DEFAULT_QA_MODEL,
    );
    this.broadcast({ type: "minutes.updated", minutes: this.minutes });
    await this.persist();
    void this.refreshMinutes({ force: false });
  }

  private trimSegments(): void {
    const maxSegments = parsePositiveInt(
      this.env.TRANSCRIPT_MAX_SEGMENTS,
      DEFAULT_MAX_SEGMENTS,
    );
    if (this.segments.length <= maxSegments) return;
    this.segments.splice(0, this.segments.length - maxSegments);
  }

  private markTakeoverNeeded(error: string): void {
    this.closeOpenAi();
    this.apiKey = null;
    this.resetOpenAiAudioState();
    if (!this.session) return;
    this.session = {
      ...this.session,
      status: "takeover_needed",
      updatedAt: Date.now(),
      error: redactSensitiveText(error),
    };
  }

  private async refreshMinutes(options: { force: boolean }): Promise<void> {
    if (!this.apiKey || this.segments.length === 0 || !this.session) return;
    const now = Date.now();
    if (
      !options.force &&
      now - this.lastMinutesRefreshAt < MIN_MINUTES_REFRESH_MS
    ) {
      return;
    }
    this.lastMinutesRefreshAt = now;

    const transcript = this.segments
      .slice(-80)
      .map((segment) => {
        const timestamp = new Date(segment.startMs).toISOString().slice(11, 19);
        return `[${timestamp}] ${segment.speakerDisplayName}: ${trimText(
          segment.text,
          900,
        )}`;
      })
      .join("\n");
    const fallback = fallbackMinutes(this.segments, this.session.qaModel);

    try {
      const minutes = await generateMinutes({
        env: this.env,
        apiKey: this.apiKey,
        model: this.session.qaModel,
        transcript,
        fallback,
      });
      if (!minutes) return;
      this.minutes = minutes;
      this.broadcast({ type: "minutes.updated", minutes: this.minutes });
      await this.persist();
    } catch {
      this.minutes = fallback;
      this.broadcast({ type: "minutes.updated", minutes: this.minutes });
    }
  }

  private async answerQuestion(
    viewer: Viewer,
    message: QaAskEnvelope,
  ): Promise<void> {
    if (!viewer.capabilities.ask) {
      this.sendError(viewer, "You cannot ask transcript questions.");
      return;
    }
    if (!this.apiKey || !this.session) {
      this.sendError(viewer, "Transcript AI is waiting for a controller key.");
      return;
    }
    const question = trimText(message.question || "", 800);
    if (!question) return;

    const id = message.id || crypto.randomUUID();
    const model = normalizeModel(message.model, this.session.qaModel);
    this.send(viewer.socket, {
      type: "qa.delta",
      id,
      question,
      delta: "",
      answer: "",
      status: "streaming",
    });

    try {
      let answer = "";
      for await (const delta of streamQuestionAnswer({
        env: this.env,
        apiKey: this.apiKey,
        model,
        question,
        segments: [
          ...this.segments,
          ...Array.from(this.partialSegments.values()),
        ],
      })) {
        answer += delta;
        this.send(viewer.socket, {
          type: "qa.delta",
          id,
          question,
          delta,
          answer,
          status: "streaming",
        });
      }
      this.send(viewer.socket, {
        type: "qa.final",
        id,
        question,
        answer: answer.trim() || "I could not find that in the transcript yet.",
        status: "done",
      });
    } catch (error) {
      this.send(viewer.socket, {
        type: "qa.final",
        id,
        question,
        answer: "",
        status: "error",
        error:
          error instanceof Error
            ? redactSensitiveText(error.message)
            : "Transcript question failed.",
      });
    }
  }

  private rateBucketForMessage(
    message: ClientEnvelope,
  ): TranscriptRateBucketName | null {
    switch (message.type) {
      case "audio.chunk":
      case "audio.commit":
      case "audio.clear":
        return "audio";
      case "export.snapshot":
        return "export";
      case "minutes.refresh":
        return "minutes";
      case "qa.ask":
        return "qa";
      case "session.start":
      case "session.stop":
      case "session.takeover":
        return "session";
      default:
        return null;
    }
  }

  private async persist(): Promise<void> {
    if (!this.session) return;
    await this.state.storage.put("snapshot", {
      session: this.session,
      segments: this.segments,
      minutes: this.minutes,
      sequence: this.sequence,
      serviceVersion: this.serviceVersion(),
    } satisfies PersistedSnapshot);
    await this.armCleanupAlarm();
  }

  private async armCleanupAlarm(): Promise<void> {
    const ttlMs = parsePositiveInt(
      this.env.TRANSCRIPT_IDLE_TTL_MS,
      DEFAULT_IDLE_TTL_MS,
    );
    await this.state.storage.setAlarm(Date.now() + ttlMs);
  }

  private resetInMemorySession(roomId: string, qaModel = DEFAULT_QA_MODEL): void {
    this.closeOpenAi();
    this.apiKey = null;
    this.segments = [];
    this.resetOpenAiAudioState();
    this.sequence = 0;
    this.lastMinutesRefreshAt = 0;
    this.session = {
      ...createIdleSession(roomId),
      qaModel,
    };
    this.minutes = createEmptyMinutes(qaModel);
  }
}
