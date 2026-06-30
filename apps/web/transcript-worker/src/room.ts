import type {
  TranscriptMinutesSnapshot,
  TranscriptMinutesStatus,
  TranscriptSegment,
  TranscriptSegmentDelta,
  TranscriptSfuRelayStartToken,
  TranscriptSessionState,
  TranscriptSpeaker,
} from "@conclave/meeting-core/transcript-types";
import {
  getTranscriptTranscriptionProvider,
  normalizeRealtimeTranscriptModel,
  type TranscriptProviderKeyAvailability,
  type TranscriptTranscriptionProvider,
} from "@conclave/meeting-core/transcript-models";
import {
  DEFAULT_MAX_SEGMENTS,
  DEFAULT_QA_MODEL,
  DEFAULT_TRANSCRIPT_MODEL,
  DEFAULT_IDLE_TTL_MS,
  MAX_AUDIO_CHUNK_BASE64_BYTES,
  MAX_CLIENT_MESSAGE_BYTES,
  MIN_OPENAI_COMMIT_AUDIO_SAMPLES,
  MINUTES_QUIET_DEBOUNCE_MS,
  MINUTES_MAX_WAIT_MS,
  MINUTES_MIN_WORDS,
} from "./constants";
import {
  signTranscriptSfuRelayStartToken,
  verifyTranscriptRoomToken,
} from "./auth";
import {
  canCommitPendingAudioForSpeaker,
  isSameTranscriptAudioSpeaker,
} from "./audio-speaker";
import {
  createEmptyMinutes,
  fallbackMinutes,
} from "./minutes";
import {
  getGlobalTranscriptProviderKeyAvailability,
  hasGlobalOpenAiApiKey,
  resolveTranscriptProviderApiKey,
} from "./key-policy";
import {
  generateMinutes,
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
  shouldDropPausedTranscriptAudio,
  shouldRequestControllerHandoff,
  shouldRequestSfuRelayHandoff,
} from "./session-policy";
import type {
  ClientEnvelope,
  Env,
  PersistedSnapshot,
  QaAskEnvelope,
  SessionStartEnvelope,
  Viewer,
} from "./types";
import {
  connectLiveTranscriptionProvider,
  type LiveTranscriptionSession,
} from "./transcription";
import {
  json,
  normalizeDelay,
  normalizeLanguage,
  normalizeLocale,
  normalizeModel,
  normalizeRoomIdFromPath,
  normalizeSpeaker,
  normalizeTransportMode,
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
  transportMode: "browser",
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
  private responseApiKey: string | null = null;
  private transcriptionSession: LiveTranscriptionSession | null = null;
  private lastMinutesRefreshAt = 0;
  // Auto-minutes scheduler state. We debounce regeneration so AI minutes are
  // never clobbered mid-conversation; the crude fallback is only ever a seed.
  private minutesTimer: ReturnType<typeof setTimeout> | null = null;
  private minutesDirtySince = 0;
  private minutesGenerating = false;
  private minutesRerunRequested = false;
  private hasAiMinutes = false;
  private minutesStatus: TranscriptMinutesStatus = "idle";
  // When the controller pauses, we keep the session + OpenAI socket alive but
  // gate audio so nothing is transcribed until they resume.
  private audioPaused = false;
  private suppressSfuRelayDisconnectsUntil = 0;
  private suppressSfuRelayDisconnectCount = 0;

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
      clientId: payload.clientId,
      channelId: payload.channelId,
      capabilities: {
        start: payload.capabilities?.start !== false,
        takeover: payload.capabilities?.takeover !== false,
        stop: payload.capabilities?.stop === true,
        ask: payload.capabilities?.ask !== false,
        relayAudio: payload.capabilities?.relayAudio === true,
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
      globalProviderKeysAvailable: this.globalProviderKeysAvailable(),
      serviceVersion: this.serviceVersion(),
      segments: this.segments,
      partials: Array.from(this.partialSegments.values()),
      minutes: this.minutes,
      minutesStatus: this.minutesStatus,
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

    if (
      this.session?.status === "live" ||
      this.session?.status === "starting" ||
      this.session?.status === "paused"
    ) {
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
      globalProviderKeysAvailable: this.globalProviderKeysAvailable(),
      serviceVersion: this.serviceVersion(),
    });
  }

  private hasGlobalOpenAiKey(): boolean {
    return hasGlobalOpenAiApiKey(this.env);
  }

  private globalProviderKeysAvailable(): TranscriptProviderKeyAvailability {
    return getGlobalTranscriptProviderKeyAvailability(this.env);
  }

  private resolveTranscriptionKey(
    provider: TranscriptTranscriptionProvider,
    providedApiKey: string | undefined,
  ) {
    return resolveTranscriptProviderApiKey({
      provider,
      providedApiKey,
      globalApiKey:
        provider === "sarvam" ? this.env.SARVAM_API_KEY : this.env.OPENAI_API_KEY,
    });
  }

  private resolveResponseKey(
    transcriptionProvider: TranscriptTranscriptionProvider,
    transcriptionApiKey: string | undefined,
    assistantApiKey: string | undefined,
  ) {
    return resolveTranscriptProviderApiKey({
      provider: "openai",
      providedApiKey:
        transcriptionProvider === "openai"
          ? (transcriptionApiKey ?? assistantApiKey)
          : assistantApiKey,
      globalApiKey: this.env.OPENAI_API_KEY,
      missingMessage:
        transcriptionProvider === "sarvam"
          ? "A valid OpenAI API key is required for Ask and Minutes when Sarvam transcription is selected."
          : "A valid OpenAI API key is required.",
      misconfiguredMessage: "The shared OpenAI API key is misconfigured.",
    });
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
    if (
      shouldDropPausedTranscriptAudio({
        audioPaused: this.audioPaused,
        viewerCanRelayAudio: this.canRelayAudio(viewer),
        messageType: message.type,
      })
    ) {
      return;
    }

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
      case "session.pause":
        await this.setPaused(viewer, true);
        return;
      case "session.resume":
        await this.setPaused(viewer, false);
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
        await this.forceRefreshMinutes();
        return;
      case "export.snapshot":
        this.send(viewer.socket, {
          type: "snapshot",
          viewerConnectionId: viewer.id,
          session: this.session,
          globalOpenAiKeyAvailable: this.hasGlobalOpenAiKey(),
          globalProviderKeysAvailable: this.globalProviderKeysAvailable(),
          serviceVersion: this.serviceVersion(),
          segments: this.segments,
          partials: Array.from(this.partialSegments.values()),
          minutes: this.minutes,
          minutesStatus: this.minutesStatus,
        });
        return;
      case "relay.handoff.prepare":
        this.prepareSfuRelayHandoff(viewer, message.id);
        return;
      default:
        this.sendError(viewer, "Unsupported transcript message.");
    }
  }

  private async handleClose(viewer: Viewer): Promise<void> {
    this.viewers.delete(viewer.socket);
    if (
      shouldRequestSfuRelayHandoff({
        closingViewerCanRelayAudio: viewer.capabilities.relayAudio === true,
        sessionStatus: this.session?.status,
        transportMode: this.session?.transportMode,
      })
    ) {
      if (this.consumeSuppressedSfuRelayDisconnect()) {
        await this.armCleanupAlarm();
        return;
      }
      this.markTakeoverNeeded("Transcript SFU relay disconnected.");
      this.broadcast({
        type: "handoff.requested",
        session: this.session,
        globalOpenAiKeyAvailable: this.hasGlobalOpenAiKey(),
        globalProviderKeysAvailable: this.globalProviderKeysAvailable(),
        serviceVersion: this.serviceVersion(),
      });
      await this.persist();
      await this.armCleanupAlarm();
      return;
    }
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
        globalProviderKeysAvailable: this.globalProviderKeysAvailable(),
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

    const roomId = this.session?.roomId || "unknown";
    const now = Date.now();
    const transcriptModel = normalizeRealtimeTranscriptModel(
      normalizeModel(message.transcriptModel, DEFAULT_TRANSCRIPT_MODEL),
      DEFAULT_TRANSCRIPT_MODEL,
    );
    const transcriptionProvider =
      getTranscriptTranscriptionProvider(transcriptModel);
    const transcriptionKey = this.resolveTranscriptionKey(
      transcriptionProvider,
      message.apiKey,
    );
    if (!transcriptionKey.ok) {
      this.sendError(viewer, transcriptionKey.message);
      return;
    }
    const responseKey = this.resolveResponseKey(
      transcriptionProvider,
      message.apiKey,
      message.assistantApiKey,
    );
    if (!responseKey.ok) {
      this.sendError(viewer, responseKey.message);
      return;
    }

    const qaModel = normalizeModel(message.qaModel, DEFAULT_QA_MODEL);
    const transportMode = normalizeTransportMode(message.transportMode);
    const wasIdle = existingStatus === "idle" || existingStatus === "error";
    this.responseApiKey = responseKey.apiKey;
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
      transportMode,
      keySource: transcriptionKey.source,
      startedAt: wasIdle ? now : (this.session?.startedAt ?? now),
      updatedAt: now,
      error: null,
    };
    this.resetTranscriptionAudioState();
    this.audioPaused = false;
    if (wasIdle) {
      this.segments = [];
      this.sequence = 0;
      this.minutes = createEmptyMinutes(qaModel);
      this.lastMinutesRefreshAt = 0;
      this.resetMinutesScheduler();
    }
    this.broadcastSession();
    await this.persist();

    try {
      await this.connectTranscriptionProvider({
        apiKey: transcriptionKey.apiKey,
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
      await this.sendSfuRelayStartToken(viewer);
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

    this.closeTranscriptionProvider();
    const roomId = this.session?.roomId || "unknown";
    this.responseApiKey = null;
    this.session = {
      ...createIdleSession(roomId),
      transcriptModel: this.session?.transcriptModel ?? DEFAULT_TRANSCRIPT_MODEL,
      qaModel: this.session?.qaModel ?? DEFAULT_QA_MODEL,
    };
    this.segments = [];
    this.resetTranscriptionAudioState();
    this.resetMinutesScheduler();
    this.audioPaused = false;
    this.sequence = 0;
    this.lastMinutesRefreshAt = 0;
    this.minutes = createEmptyMinutes(this.session.qaModel);
    await this.state.storage.delete("snapshot");
    this.broadcast({
      type: "snapshot",
      session: this.session,
      globalOpenAiKeyAvailable: this.hasGlobalOpenAiKey(),
      globalProviderKeysAvailable: this.globalProviderKeysAvailable(),
      serviceVersion: this.serviceVersion(),
      segments: [],
      partials: [],
      minutes: this.minutes,
      minutesStatus: this.minutesStatus,
    });
  }

  // Pause/resume transcription without ending the session: the OpenAI socket
  // and accumulated transcript stay intact, we just stop feeding audio. Only
  // the controller (or a host/admin who could stop it) may toggle this.
  private async setPaused(viewer: Viewer, paused: boolean): Promise<void> {
    if (!this.session) {
      this.sendError(viewer, "No transcript session is running.");
      return;
    }
    if (
      !canStopTranscriptSession({
        controllerUserId: this.session.controller?.userId,
        viewerCanStop: viewer.capabilities.stop,
        viewerUserId: viewer.userId,
      })
    ) {
      this.sendError(viewer, "Only the controller, host, or admin can pause.");
      return;
    }
    const status = this.session.status;
    if (paused && status !== "live") {
      this.sendError(viewer, "Transcript must be live to pause.");
      return;
    }
    if (!paused && status !== "paused") {
      return;
    }
    if (paused) {
      // Flush whatever is buffered so the last utterance finalizes cleanly.
      if (this.hasPendingAudio && this.latestSpeaker) {
        this.commitTranscriptionBuffer(
          this.latestSpeaker,
          "Transcript audio commit failed.",
        );
      }
      this.audioPaused = true;
    } else {
      this.audioPaused = false;
    }
    this.session = {
      ...this.session,
      status: paused ? "paused" : "live",
      updatedAt: Date.now(),
      error: null,
    };
    this.broadcastSession();
    await this.persist();
  }

  private appendAudio(
    viewer: Viewer,
    audio: string | undefined,
    speaker: Partial<TranscriptSpeaker> | undefined,
  ): void {
    if (this.audioPaused) return;
    if (!this.canRelayAudio(viewer)) return;
    if (!audio || !this.transcriptionSession) return;
    const sampleCount = estimatePcm16Base64SampleCount(audio);
    if (sampleCount <= 0) return;
    const normalizedSpeaker = normalizeSpeaker(speaker, viewer);
    if (
      this.hasPendingAudio &&
      this.latestSpeaker &&
      !isSameTranscriptAudioSpeaker(this.latestSpeaker, normalizedSpeaker) &&
      !this.commitTranscriptionBuffer(
        this.latestSpeaker,
        "Transcript speaker handoff failed.",
      )
    ) {
      return;
    }
    try {
      this.transcriptionSession.appendAudio(audio);
      this.latestSpeaker = normalizedSpeaker;
      this.hasPendingAudio = true;
      this.pendingAudioSamples += sampleCount;
      if (this.isController(viewer) && this.session?.controller) {
        this.session.controller.lastSeenAt = Date.now();
      }
    } catch {
      void this.handleTranscriptionFailure("Transcript audio stream failed.");
    }
  }

  private commitAudio(
    viewer: Viewer,
    speaker: Partial<TranscriptSpeaker> | undefined,
  ): void {
    if (
      this.audioPaused ||
      !this.canRelayAudio(viewer) ||
      !this.transcriptionSession ||
      !this.hasPendingAudio
    ) {
      return;
    }
    const normalizedSpeaker = normalizeSpeaker(
      speaker,
      this.latestSpeaker ?? viewer,
    );
    if (
      !canCommitPendingAudioForSpeaker(this.latestSpeaker, normalizedSpeaker)
    ) {
      return;
    }
    this.latestSpeaker = normalizedSpeaker;
    this.commitTranscriptionBuffer(
      normalizedSpeaker,
      "Transcript audio commit failed.",
    );
  }

  private commitTranscriptionBuffer(
    speaker: TranscriptSpeaker,
    failureMessage: string,
  ): boolean {
    if (!this.transcriptionSession || !this.hasPendingAudio) return false;
    try {
      if (this.transcriptionSession.provider === "openai") {
        const paddingSamples =
          MIN_OPENAI_COMMIT_AUDIO_SAMPLES - this.pendingAudioSamples;
        if (paddingSamples > 0) {
          this.transcriptionSession.appendAudio(
            createSilentPcm16Base64(paddingSamples),
          );
        }
      }
      this.transcriptionSession.commitAudio();
      this.speakerAttribution.enqueueCommit(speaker);
      this.hasPendingAudio = false;
      this.pendingAudioSamples = 0;
      return true;
    } catch {
      void this.handleTranscriptionFailure(failureMessage);
      return false;
    }
  }

  private clearAudio(viewer: Viewer): void {
    if (!this.canRelayAudio(viewer) || !this.transcriptionSession) return;
    if (this.hasPendingAudio && this.latestSpeaker) {
      this.commitTranscriptionBuffer(
        this.latestSpeaker,
        "Transcript audio commit failed.",
      );
      return;
    }
    try {
      this.transcriptionSession.clearAudio();
    } catch {
      void this.handleTranscriptionFailure("Transcript audio clear failed.");
      return;
    }
    this.hasPendingAudio = false;
    this.pendingAudioSamples = 0;
  }

  private isController(viewer: Viewer): boolean {
    const controller = this.session?.controller;
    if (!controller) return false;
    if (controller.connectionId) return controller.connectionId === viewer.id;
    return controller.userId === viewer.userId;
  }

  private canRelayAudio(viewer: Viewer): boolean {
    if (this.isController(viewer)) return true;
    return (
      this.session?.transportMode === "sfu" &&
      viewer.capabilities.relayAudio === true
    );
  }

  private async sendSfuRelayStartToken(viewer: Viewer): Promise<void> {
    if (
      this.session?.status !== "live" ||
      this.session.transportMode !== "sfu" ||
      this.session.controller?.userId !== viewer.userId ||
      this.session.controller.connectionId !== viewer.id
    ) {
      return;
    }

    const relayToken = await signTranscriptSfuRelayStartToken(
      {
        userId: viewer.userId,
        displayName: viewer.displayName,
        roomId: this.session.roomId,
        clientId: viewer.clientId,
        channelId: viewer.channelId,
        connectionId: viewer.id,
      },
      this.env.TRANSCRIPT_TOKEN_SECRET,
    );
    this.send(viewer.socket, {
      type: "sfu.relayStartToken",
      ...relayToken,
    } satisfies { type: "sfu.relayStartToken" } & TranscriptSfuRelayStartToken);
  }

  private prepareSfuRelayHandoff(viewer: Viewer, id?: string): void {
    if (!this.canRelayAudio(viewer)) return;
    this.suppressSfuRelayDisconnectsUntil = Date.now() + 5000;
    this.suppressSfuRelayDisconnectCount += 1;
    this.send(viewer.socket, {
      type: "relay.handoff.ready",
      id: trimText(id ?? "", 120),
    });
  }

  private consumeSuppressedSfuRelayDisconnect(): boolean {
    if (
      this.suppressSfuRelayDisconnectCount <= 0 ||
      Date.now() > this.suppressSfuRelayDisconnectsUntil
    ) {
      this.suppressSfuRelayDisconnectCount = 0;
      return false;
    }
    this.suppressSfuRelayDisconnectCount -= 1;
    return true;
  }

  private async connectTranscriptionProvider(options: {
    apiKey: string;
    transcriptModel: string;
    language: string;
    delay: string;
    locale: string;
    localizationPrompt?: string;
  }): Promise<void> {
    this.closeTranscriptionProvider();
    this.transcriptionSession = await connectLiveTranscriptionProvider({
      env: this.env,
      ...options,
      callbacks: {
        onCommitted: (itemId) => this.handleTranscriptItemCommitted(itemId),
        onDelta: (itemId, delta) => this.applyTranscriptDelta(itemId, delta),
        onFinal: (itemId, transcript) =>
          this.applyTranscriptFinal(itemId, transcript),
        onFailure: (message) => this.handleTranscriptionFailure(message),
      },
    });
  }

  private closeTranscriptionProvider(): void {
    const session = this.transcriptionSession;
    this.transcriptionSession = null;
    this.resetTranscriptionAudioState();
    try {
      session?.close();
    } catch {}
  }

  private resetTranscriptionAudioState(): void {
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

  private handleTranscriptItemCommitted(itemId: string): void {
    const speaker = this.speakerAttribution.bindCommittedItem(itemId);
    if (speaker) {
      this.reassignSegmentSpeaker(itemId, speaker);
    }
  }

  private async handleTranscriptionFailure(message: string): Promise<void> {
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
    await this.persist();
    this.scheduleMinutes();
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
    this.closeTranscriptionProvider();
    this.responseApiKey = null;
    this.resetTranscriptionAudioState();
    this.audioPaused = false;
    if (this.minutesTimer !== null) {
      clearTimeout(this.minutesTimer);
      this.minutesTimer = null;
    }
    this.minutesGenerating = false;
    if (this.minutesStatus !== "idle") this.minutesStatus = "live";
    if (!this.session) return;
    this.session = {
      ...this.session,
      status: "takeover_needed",
      updatedAt: Date.now(),
      error: redactSensitiveText(error),
    };
  }

  private hasMinutesContent(minutes: TranscriptMinutesSnapshot): boolean {
    return Boolean(
      minutes.summary.trim() ||
        minutes.topics.length ||
        minutes.decisions.length ||
        minutes.actionItems.length ||
        minutes.openQuestions.length ||
        minutes.followUps.length,
    );
  }

  // There's no point summarizing two words of small talk — wait until there's
  // enough spoken content that minutes are meaningful.
  private hasEnoughContentForMinutes(): boolean {
    let words = 0;
    for (const segment of this.segments) {
      if (!segment.isFinal) continue;
      const text = segment.text.trim();
      if (!text) continue;
      words += text.split(/\s+/).length;
      if (words >= MINUTES_MIN_WORDS) return true;
    }
    return false;
  }

  private setMinutesStatus(status: TranscriptMinutesStatus): void {
    if (this.minutesStatus === status) return;
    this.minutesStatus = status;
    this.broadcast({
      type: "minutes.status",
      status: this.minutesStatus,
      updatedAt: this.minutes.updatedAt,
    });
  }

  private resetMinutesScheduler(): void {
    if (this.minutesTimer !== null) {
      clearTimeout(this.minutesTimer);
      this.minutesTimer = null;
    }
    this.minutesDirtySince = 0;
    this.minutesGenerating = false;
    this.minutesRerunRequested = false;
    this.hasAiMinutes = false;
    this.minutesStatus = "idle";
  }

  // Debounced auto-refresh: regenerate after the room is quiet for the quiet
  // window, but never wait longer than the hard cap during continuous talk.
  private scheduleMinutes(): void {
    if (!this.responseApiKey || this.segments.length === 0) return;
    if (!this.hasAiMinutes && !this.hasEnoughContentForMinutes()) return;
    if (this.minutesGenerating) {
      this.minutesRerunRequested = true;
      return;
    }
    const now = Date.now();
    if (this.minutesDirtySince === 0) this.minutesDirtySince = now;
    const elapsed = now - this.minutesDirtySince;
    const delay = Math.max(
      0,
      Math.min(MINUTES_QUIET_DEBOUNCE_MS, MINUTES_MAX_WAIT_MS - elapsed),
    );
    if (this.minutesTimer !== null) clearTimeout(this.minutesTimer);
    this.setMinutesStatus("pending");
    this.minutesTimer = setTimeout(() => {
      this.minutesTimer = null;
      void this.regenerateMinutes();
    }, delay);
  }

  // Manual "refresh now" from a viewer: skip the debounce and run immediately.
  private async forceRefreshMinutes(): Promise<void> {
    if (this.minutesTimer !== null) {
      clearTimeout(this.minutesTimer);
      this.minutesTimer = null;
    }
    this.minutesDirtySince = this.minutesDirtySince || Date.now();
    await this.regenerateMinutes();
  }

  private async regenerateMinutes(): Promise<void> {
    if (!this.responseApiKey || this.segments.length === 0 || !this.session) {
      this.minutesDirtySince = 0;
      this.setMinutesStatus("idle");
      return;
    }
    if (this.minutesGenerating) {
      this.minutesRerunRequested = true;
      return;
    }
    this.minutesGenerating = true;
    this.minutesDirtySince = 0;
    this.lastMinutesRefreshAt = Date.now();
    this.setMinutesStatus("generating");

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
        apiKey: this.responseApiKey,
        model: this.session.qaModel,
        transcript,
        fallback,
      });
      if (minutes) {
        this.minutes = minutes;
        this.hasAiMinutes = true;
        this.broadcast({ type: "minutes.updated", minutes: this.minutes });
        await this.persist();
      }
    } catch {
      // Only fall back to the heuristic when the AI pass fails AND there's
      // enough content to be worth it — never echo a few words of small talk.
      if (
        !this.hasAiMinutes &&
        !this.hasMinutesContent(this.minutes) &&
        this.hasEnoughContentForMinutes()
      ) {
        this.minutes = fallback;
        this.broadcast({ type: "minutes.updated", minutes: this.minutes });
      }
    } finally {
      this.minutesGenerating = false;
      this.setMinutesStatus("live");
      if (this.minutesRerunRequested) {
        this.minutesRerunRequested = false;
        this.scheduleMinutes();
      }
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
    if (!this.responseApiKey || !this.session) {
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
        apiKey: this.responseApiKey,
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
      case "relay.handoff.prepare":
      case "session.start":
      case "session.stop":
      case "session.pause":
      case "session.resume":
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
    this.closeTranscriptionProvider();
    this.responseApiKey = null;
    this.segments = [];
    this.resetTranscriptionAudioState();
    this.resetMinutesScheduler();
    this.audioPaused = false;
    this.sequence = 0;
    this.lastMinutesRefreshAt = 0;
    this.session = {
      ...createIdleSession(roomId),
      qaModel,
    };
    this.minutes = createEmptyMinutes(qaModel);
  }
}
