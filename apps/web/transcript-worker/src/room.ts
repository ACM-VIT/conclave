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
  DEFAULT_RECOVERY_RETENTION_MS,
  DEFAULT_TRANSCRIPT_MODEL,
  DEFAULT_IDLE_TTL_MS,
  MAX_AUDIO_CHUNK_BASE64_BYTES,
  MAX_CLIENT_MESSAGE_BYTES,
  MIN_OPENAI_COMMIT_AUDIO_SAMPLES,
  MINUTES_COMPACTION_INTERVAL_MS,
  MINUTES_QUIET_DEBOUNCE_MS,
  MINUTES_MAX_WAIT_MS,
  MINUTES_MIN_WORDS,
  SFU_RELAY_DISCONNECT_SUPPRESSION_MS,
  TRANSCRIPT_CONTROLLER_RECONNECT_GRACE_MS,
  TRANSCRIPT_SFU_RELAY_RECOVERY_ATTEMPTS,
  TRANSCRIPT_SFU_RELAY_RECOVERY_GRACE_MS,
  TRANSCRIPTION_COMMIT_ACK_TIMEOUT_MS,
  TRANSCRIPTION_CONNECT_TIMEOUT_MS,
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
  boundMinutesSnapshot,
  createEmptyMinutes,
  fallbackMinutes,
  minutesNeedCompaction,
} from "./minutes";
import {
  getGlobalTranscriptProviderKeyAvailability,
  hasGlobalOpenAiApiKey,
  resolveTranscriptProviderApiKey,
} from "./key-policy";
import {
  compactMinutes,
  generateMinutes,
  streamQuestionAnswer,
} from "./openai";
import {
  takeTranscriptRateLimit,
  type TranscriptRateBucketName,
} from "./rate-limit";
import { getTranscriptServiceVersion } from "./service-version";
import {
  recoverPersistedTranscriptSession,
  shouldAutomaticallyRecoverPersistedTranscriptSession,
  shouldRetainRecoverableTranscriptSnapshot,
} from "./session-recovery";
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
  PersistedTranscriptionConfig,
  QaAskEnvelope,
  SessionStartEnvelope,
  Viewer,
} from "./types";
import {
  connectLiveTranscriptionProvider,
  type LiveTranscriptionSession,
} from "./transcription";
import {
  TranscriptAudioReplayJournal,
  TranscriptRecoveryAudioBuffer,
  isRetryableTranscriptionFailure,
  transcriptionRecoveryDelayMs,
  type BufferedTranscriptAudioEvent,
} from "./transcription-recovery";
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
  private transcriptionConnectionOptions:
    | (PersistedTranscriptionConfig & {
        apiKey: string;
        transcriptModel: string;
        localizationPrompt?: string;
      })
    | null = null;
  private transcriptionConnectionEpoch = 0;
  private transcriptionRecoveryGeneration = 0;
  private transcriptionProviderOpeningGeneration: number | null = null;
  private transcriptionRecoveryPromise: Promise<void> | null = null;
  private pendingTranscriptionRecoveryFailure: string | null = null;
  private pendingTranscriptionCommitAcks: number[] = [];
  private transcriptionCommitWatchdogTimer: ReturnType<typeof setTimeout> | null =
    null;
  private readonly transcriptionRecoveryAudio =
    new TranscriptRecoveryAudioBuffer();
  private readonly transcriptionReplayJournal =
    new TranscriptAudioReplayJournal();
  private lastMinutesRefreshAt = 0;
  private lastMinutesCompactionAt = 0;
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
  private controllerReconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private sfuRelayRecoveryTimer: ReturnType<typeof setTimeout> | null = null;
  private sfuRelayRecoveryAttempts = 0;

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
    if (viewer.capabilities.relayAudio === true) {
      this.cancelSfuRelayRecovery();
    }
    const controllerRebound = this.rebindControllerAfterReconnect(viewer);
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

    if (
      controllerRebound &&
      this.session?.status === "live" &&
      this.session.transportMode === "sfu" &&
      !this.hasSfuRelayViewer()
    ) {
      await this.sendSfuRelayStartToken(viewer, true);
      await this.persist();
    }
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
      await this.persist();
      return;
    }
    if (!this.session) return;
    const recoveryRetentionMs = parsePositiveInt(
      this.env.TRANSCRIPT_RECOVERY_RETENTION_MS,
      DEFAULT_RECOVERY_RETENTION_MS,
    );
    if (
      shouldRetainRecoverableTranscriptSnapshot(
        this.session,
        Date.now(),
        recoveryRetentionMs,
      )
    ) {
      await this.state.storage.setAlarm(
        this.session.updatedAt + recoveryRetentionMs,
      );
      return;
    }
    if (
      this.session.status === "idle" ||
      this.session.status === "takeover_needed" ||
      this.session.status === "error"
    ) {
      await this.state.storage.delete("snapshot");
      this.resetInMemorySession(this.session.roomId, this.session.qaModel);
    }
  }

  private async load(): Promise<void> {
    const snapshot = await this.state.storage.get<PersistedSnapshot>("snapshot");
    if (!snapshot) return;
    const shouldRecoverAutomatically =
      shouldAutomaticallyRecoverPersistedTranscriptSession(snapshot.session);
    this.session = recoverPersistedTranscriptSession(
      snapshot.session,
      snapshot.serviceVersion,
      this.serviceVersion(),
    );
    this.segments = snapshot.segments ?? [];
    this.minutes = snapshot.minutes ?? createEmptyMinutes(this.session.qaModel);
    this.lastMinutesCompactionAt =
      snapshot.minutesCompactedAt ??
      snapshot.session.startedAt ??
      this.minutes.updatedAt ??
      Date.now();
    this.sequence = snapshot.sequence ?? this.segments.length;
    if (shouldRecoverAutomatically) {
      this.state.waitUntil(this.restorePersistedGlobalSession(snapshot));
    }
  }

  private ensureSession(roomId: string): TranscriptSessionState {
    if (!this.session) {
      this.session = createIdleSession(roomId);
      this.minutes = createEmptyMinutes();
    }
    return this.session;
  }

  private async restorePersistedGlobalSession(
    snapshot: PersistedSnapshot,
  ): Promise<void> {
    const transcriptModel = normalizeRealtimeTranscriptModel(
      snapshot.session.transcriptModel,
      DEFAULT_TRANSCRIPT_MODEL,
    );
    const provider = getTranscriptTranscriptionProvider(transcriptModel);
    const transcriptionKey = this.resolveTranscriptionKey(provider, undefined);
    const responseKey = this.resolveResponseKey(provider, undefined, undefined);
    if (!transcriptionKey.ok || !responseKey.ok) return;

    const wasPaused = snapshot.session.status === "paused";
    const config = snapshot.transcriptionConfig ?? {
      language: normalizeLanguage(this.env.TRANSCRIPT_TRANSCRIPTION_LANGUAGE),
      delay: normalizeDelay(undefined),
      locale: normalizeLocale(this.env.TRANSCRIPT_TRANSCRIPTION_LOCALE),
    };
    this.responseApiKey = responseKey.apiKey;
    this.session = {
      ...snapshot.session,
      status: "starting",
      updatedAt: Date.now(),
      error: null,
    };
    try {
      await this.connectTranscriptionProvider({
        apiKey: transcriptionKey.apiKey,
        transcriptModel,
        ...config,
        localizationPrompt: this.env.TRANSCRIPT_TRANSCRIPTION_PROMPT,
      });
      this.audioPaused = wasPaused;
      this.session = {
        ...this.session,
        status: wasPaused ? "paused" : "live",
        updatedAt: Date.now(),
        error: null,
      };
      console.info("[TranscriptWorker] restored persisted live session", {
        roomId: this.session.roomId,
        transportMode: this.session.transportMode,
        provider,
      });
      this.broadcastSession();
      if (this.session.transportMode === "sfu") {
        const controllerViewer = Array.from(this.viewers.values()).find(
          (viewer) =>
            viewer.id === this.session?.controller?.connectionId,
        );
        if (controllerViewer && !this.hasSfuRelayViewer()) {
          await this.sendSfuRelayStartToken(controllerViewer, true);
        }
      }
      await this.persist();
    } catch (error) {
      if (this.session.status !== "starting") return;
      const message =
        error instanceof Error
          ? error.message
          : "Failed to restore the transcription model.";
      console.warn("[TranscriptWorker] persisted session restore failed", {
        roomId: this.session.roomId,
        transportMode: this.session.transportMode,
        provider,
        message: redactSensitiveText(message),
      });
      this.markTakeoverNeeded(message);
      this.broadcastSession();
      await this.persist();
    }
  }

  private rebindControllerAfterReconnect(viewer: Viewer): boolean {
    const controller = this.session?.controller;
    if (!controller || controller.userId !== viewer.userId) return false;
    if (
      Array.from(this.viewers.values()).some(
        (candidate) =>
          candidate.id === controller.connectionId && candidate !== viewer,
      )
    ) {
      return false;
    }
    if (controller.connectionId === viewer.id) return false;
    this.cancelControllerReconnect();
    this.session = {
      ...this.session!,
      controller: {
        ...controller,
        connectionId: viewer.id,
        lastSeenAt: Date.now(),
      },
      updatedAt: Date.now(),
    };
    return true;
  }

  private send(socket: WebSocket, data: unknown): void {
    try {
      socket.send(JSON.stringify(data));
    } catch {
      const viewer = this.viewers.get(socket);
      if (viewer) void this.handleClose(viewer);
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
      case "session.relayFailed":
        await this.failSfuRelaySession(viewer, message.message);
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
      case "relay.ping":
        this.handleSfuRelayPing(viewer, message.id);
        return;
      case "relay.handoff.prepare":
        this.prepareSfuRelayHandoff(viewer, message.id);
        return;
      default:
        this.sendError(viewer, "Unsupported transcript message.");
    }
  }

  private async handleClose(viewer: Viewer): Promise<void> {
    if (!this.viewers.delete(viewer.socket)) return;
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
      await this.beginSfuRelayRecovery();
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
      const replacement = Array.from(this.viewers.values()).find(
        (candidate) => candidate.userId === viewer.userId,
      );
      if (replacement && this.rebindControllerAfterReconnect(replacement)) {
        this.broadcastSession();
        if (
          this.session?.status === "live" &&
          this.session.transportMode === "sfu" &&
          !this.hasSfuRelayViewer()
        ) {
          await this.sendSfuRelayStartToken(replacement, true);
        }
        await this.persist();
      } else {
        this.scheduleControllerReconnectGrace(viewer);
      }
    }
    await this.armCleanupAlarm();
  }

  private scheduleControllerReconnectGrace(viewer: Viewer): void {
    this.cancelControllerReconnect();
    const connectionId = viewer.id;
    const userId = viewer.userId;
    this.controllerReconnectTimer = setTimeout(() => {
      this.controllerReconnectTimer = null;
      if (
        this.session?.controller?.connectionId !== connectionId ||
        this.session.controller.userId !== userId ||
        Array.from(this.viewers.values()).some(
          (candidate) => candidate.userId === userId,
        )
      ) {
        return;
      }
      // SFU audio is room-scoped and can continue without the controller's UI.
      // Keep it live so a brief app sleep or a controller changing networks is
      // invisible to the rest of the meeting.
      if (
        this.session.status === "live" &&
        this.session.transportMode === "sfu" &&
        this.hasSfuRelayViewer()
      ) {
        return;
      }
      this.markTakeoverNeeded("Transcript controller disconnected.");
      this.broadcastHandoffRequested();
      void this.persist();
    }, TRANSCRIPT_CONTROLLER_RECONNECT_GRACE_MS);
  }

  private cancelControllerReconnect(): void {
    if (this.controllerReconnectTimer !== null) {
      clearTimeout(this.controllerReconnectTimer);
      this.controllerReconnectTimer = null;
    }
  }

  private async beginSfuRelayRecovery(): Promise<void> {
    if (
      this.session?.status !== "live" ||
      this.session.transportMode !== "sfu" ||
      this.hasSfuRelayViewer()
    ) {
      return;
    }
    if (this.sfuRelayRecoveryTimer !== null) return;

    this.sfuRelayRecoveryAttempts += 1;
    const controller = this.session.controller;
    const controllerViewer = controller
      ? Array.from(this.viewers.values()).find(
          (candidate) => candidate.id === controller.connectionId,
        )
      : undefined;
    if (controllerViewer) {
      await this.sendSfuRelayStartToken(controllerViewer, true);
    }

    this.sfuRelayRecoveryTimer = setTimeout(() => {
      this.sfuRelayRecoveryTimer = null;
      if (this.hasSfuRelayViewer()) {
        this.cancelSfuRelayRecovery();
        return;
      }
      if (
        this.sfuRelayRecoveryAttempts <
        TRANSCRIPT_SFU_RELAY_RECOVERY_ATTEMPTS
      ) {
        void this.beginSfuRelayRecovery();
        return;
      }
      this.markTakeoverNeeded(
        "Transcript audio relay could not reconnect automatically.",
      );
      this.broadcastHandoffRequested();
      void this.persist();
    }, TRANSCRIPT_SFU_RELAY_RECOVERY_GRACE_MS);
  }

  private cancelSfuRelayRecovery(): void {
    if (this.sfuRelayRecoveryTimer !== null) {
      clearTimeout(this.sfuRelayRecoveryTimer);
      this.sfuRelayRecoveryTimer = null;
    }
    this.sfuRelayRecoveryAttempts = 0;
  }

  private hasSfuRelayViewer(): boolean {
    return Array.from(this.viewers.values()).some(
      (viewer) => viewer.capabilities.relayAudio === true,
    );
  }

  private broadcastHandoffRequested(): void {
    this.broadcast({
      type: "handoff.requested",
      session: this.session,
      globalOpenAiKeyAvailable: this.hasGlobalOpenAiKey(),
      globalProviderKeysAvailable: this.globalProviderKeysAvailable(),
      serviceVersion: this.serviceVersion(),
    });
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
      this.lastMinutesCompactionAt = now;
      this.resetMinutesScheduler();
    }
    this.broadcastSession();
    await this.persist();

    try {
      const language = normalizeLanguage(
        message.language ?? this.env.TRANSCRIPT_TRANSCRIPTION_LANGUAGE,
      );
      const delay = normalizeDelay(message.delay);
      const locale = normalizeLocale(this.env.TRANSCRIPT_TRANSCRIPTION_LOCALE);
      await this.connectTranscriptionProvider({
        apiKey: transcriptionKey.apiKey,
        transcriptModel,
        language,
        delay,
        locale,
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
      if (this.session?.status !== "starting") return;
      this.markTakeoverNeeded(
        error instanceof Error
          ? error.message
          : "Failed to connect transcription model.",
      );
      this.broadcastSession();
      await this.persist();
    }
  }

  private async failSfuRelaySession(
    viewer: Viewer,
    message: string | undefined,
  ): Promise<void> {
    if (
      !this.session ||
      this.session.transportMode !== "sfu" ||
      !canStopTranscriptSession({
        controllerUserId: this.session.controller?.userId,
        viewerCanStop: viewer.capabilities.stop,
        viewerUserId: viewer.userId,
      })
    ) {
      this.sendError(viewer, "You cannot report a transcript relay failure.");
      return;
    }
    console.warn("[TranscriptWorker] SFU relay start failed; recovering", {
      roomId: this.session.roomId,
      controllerUserId: viewer.userId,
      message: redactSensitiveText(
        trimText(message || "Transcript audio relay could not start.", 500),
      ),
    });
    this.session = {
      ...this.session,
      updatedAt: Date.now(),
      error: null,
    };
    await this.beginSfuRelayRecovery();
    await this.persist();
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

    this.suppressSfuRelayDisconnectsUntil =
      Date.now() + SFU_RELAY_DISCONNECT_SUPPRESSION_MS;
    this.suppressSfuRelayDisconnectCount += 1;
    this.cancelControllerReconnect();
    this.cancelSfuRelayRecovery();
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
    this.lastMinutesCompactionAt = 0;
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
    if (
      !paused &&
      this.session.transportMode === "sfu" &&
      !this.hasSfuRelayViewer()
    ) {
      await this.beginSfuRelayRecovery();
    }
  }

  private appendAudio(
    viewer: Viewer,
    audio: string | undefined,
    speaker: Partial<TranscriptSpeaker> | undefined,
  ): void {
    if (this.audioPaused) return;
    if (!this.canRelayAudio(viewer)) return;
    if (!audio) return;
    const sampleCount = estimatePcm16Base64SampleCount(audio);
    if (sampleCount <= 0) return;
    const normalizedSpeaker = normalizeSpeaker(speaker, viewer);
    if (!this.transcriptionSession) {
      if (this.shouldBufferTranscriptionAudio()) {
        this.transcriptionRecoveryAudio.enqueue({
          type: "chunk",
          audio,
          speaker: normalizedSpeaker,
          sampleCount,
          createdAt: Date.now(),
        });
      }
      return;
    }
    this.appendNormalizedAudio(audio, normalizedSpeaker, sampleCount);
    if (this.isController(viewer) && this.session?.controller) {
      this.session.controller.lastSeenAt = Date.now();
    }
  }

  private appendNormalizedAudio(
    audio: string,
    speaker: TranscriptSpeaker,
    sampleCount: number,
    captureFailedEvent = true,
    reportFailure = true,
  ): boolean {
    if (!this.transcriptionSession) return false;
    if (
      this.hasPendingAudio &&
      this.latestSpeaker &&
      !isSameTranscriptAudioSpeaker(this.latestSpeaker, speaker) &&
      !this.commitTranscriptionBuffer(
        this.latestSpeaker,
        "Transcript speaker handoff failed.",
        reportFailure,
      )
    ) {
      if (captureFailedEvent && this.shouldBufferTranscriptionAudio()) {
        this.transcriptionRecoveryAudio.enqueue({
          type: "chunk",
          audio,
          speaker,
          sampleCount,
          createdAt: Date.now(),
        });
      }
      return false;
    }
    try {
      this.transcriptionSession.appendAudio(audio);
      this.transcriptionReplayJournal.append(audio, speaker, sampleCount);
      this.latestSpeaker = speaker;
      this.hasPendingAudio = true;
      this.pendingAudioSamples += sampleCount;
      return true;
    } catch {
      if (reportFailure) {
        void this.handleTranscriptionFailure(
          "Transcript audio stream failed.",
          captureFailedEvent
            ? [
                {
                  type: "chunk",
                  audio,
                  speaker,
                  sampleCount,
                  createdAt: Date.now(),
                },
              ]
            : [],
        );
      }
      return false;
    }
  }

  private commitAudio(
    viewer: Viewer,
    speaker: Partial<TranscriptSpeaker> | undefined,
  ): void {
    if (
      this.audioPaused ||
      !this.canRelayAudio(viewer) ||
      (!this.transcriptionSession && !this.shouldBufferTranscriptionAudio())
    ) {
      return;
    }
    const normalizedSpeaker = normalizeSpeaker(
      speaker,
      this.latestSpeaker ?? viewer,
    );
    if (!this.transcriptionSession && this.shouldBufferTranscriptionAudio()) {
      this.transcriptionRecoveryAudio.enqueue({
        type: "commit",
        speaker: normalizedSpeaker,
        createdAt: Date.now(),
      });
      return;
    }
    if (!this.hasPendingAudio) return;
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
    reportFailure = true,
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
      this.transcriptionReplayJournal.commit(speaker);
      if (this.transcriptionSession.provider === "openai") {
        this.trackPendingTranscriptionCommit();
      }
      this.hasPendingAudio = false;
      this.pendingAudioSamples = 0;
      return true;
    } catch {
      if (reportFailure) {
        void this.handleTranscriptionFailure(failureMessage);
      }
      return false;
    }
  }

  private clearAudio(viewer: Viewer): void {
    if (!this.canRelayAudio(viewer)) return;
    if (!this.transcriptionSession && this.shouldBufferTranscriptionAudio()) {
      this.transcriptionRecoveryAudio.enqueue({
        type: "clear",
        speaker: normalizeSpeaker(undefined, viewer),
        createdAt: Date.now(),
      });
      return;
    }
    if (!this.transcriptionSession) return;
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

  private shouldBufferTranscriptionAudio(): boolean {
    return (
      this.transcriptionProviderOpeningGeneration !== null ||
      this.transcriptionRecoveryPromise !== null
    );
  }

  private async sendSfuRelayStartToken(
    viewer: Viewer,
    automatic = false,
  ): Promise<void> {
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
      automatic,
    } satisfies { type: "sfu.relayStartToken" } & TranscriptSfuRelayStartToken);
  }

  private prepareSfuRelayHandoff(viewer: Viewer, id?: string): void {
    if (!this.canRelayAudio(viewer)) return;
    this.suppressSfuRelayDisconnectsUntil =
      Date.now() + SFU_RELAY_DISCONNECT_SUPPRESSION_MS;
    this.suppressSfuRelayDisconnectCount += 1;
    this.send(viewer.socket, {
      type: "relay.handoff.ready",
      id: trimText(id ?? "", 120),
    });
  }

  private handleSfuRelayPing(viewer: Viewer, id?: string): void {
    if (!this.canRelayAudio(viewer)) return;
    this.send(viewer.socket, {
      type: "relay.pong",
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
    const generation = this.transcriptionRecoveryGeneration;
    this.transcriptionConnectionOptions = options;
    this.transcriptionProviderOpeningGeneration = generation;
    try {
      try {
        const connection = await this.openTranscriptionProvider(options);
        if (generation !== this.transcriptionRecoveryGeneration) {
          connection.close();
          throw new Error("Transcript provider connection was superseded.");
        }
        this.transcriptionSession = connection;

        const bufferedEvents = this.transcriptionRecoveryAudio.drain();
        if (
          bufferedEvents.length > 0 &&
          !this.replayBufferedTranscriptionAudio(bufferedEvents, false)
        ) {
          this.transcriptionSession = null;
          this.transcriptionConnectionEpoch += 1;
          try {
            connection.close();
          } catch {}
          this.resetTranscriptionAudioState();
          this.transcriptionRecoveryAudio.enqueueMany(bufferedEvents);
          throw new Error(
            "Buffered transcript audio replay connection failed.",
          );
        }
      } catch (error) {
        if (generation !== this.transcriptionRecoveryGeneration) throw error;
        const message = redactSensitiveText(
          error instanceof Error
            ? error.message
            : "Transcription provider connection failed.",
        );
        if (isRetryableTranscriptionFailure(message)) {
          await this.handleTranscriptionFailure(message);
          if (this.transcriptionSession) return;
        }
        throw error;
      }
    } finally {
      if (this.transcriptionProviderOpeningGeneration === generation) {
        this.transcriptionProviderOpeningGeneration = null;
      }
    }
  }

  private async openTranscriptionProvider(options: {
    apiKey: string;
    transcriptModel: string;
    language: string;
    delay: string;
    locale: string;
    localizationPrompt?: string;
  }): Promise<LiveTranscriptionSession> {
    const epoch = this.transcriptionConnectionEpoch + 1;
    this.transcriptionConnectionEpoch = epoch;
    const controller = new AbortController();
    const timeout = setTimeout(() => {
      controller.abort("Transcript provider connection timed out.");
    }, TRANSCRIPTION_CONNECT_TIMEOUT_MS);
    try {
      return await connectLiveTranscriptionProvider({
        env: this.env,
        ...options,
        signal: controller.signal,
        callbacks: {
          onCommitted: (itemId) => {
            if (epoch === this.transcriptionConnectionEpoch) {
              this.handleTranscriptItemCommitted(itemId);
            }
          },
          onDelta: (itemId, delta) => {
            if (epoch === this.transcriptionConnectionEpoch) {
              this.applyTranscriptDelta(itemId, delta);
            }
          },
          onFinal: (itemId, transcript) => {
            if (epoch !== this.transcriptionConnectionEpoch) return;
            return this.applyTranscriptFinal(itemId, transcript);
          },
          onFailure: (message) => {
            if (epoch !== this.transcriptionConnectionEpoch) return;
            return this.handleTranscriptionFailure(message);
          },
        },
      });
    } catch (error) {
      if (controller.signal.aborted) {
        throw new Error("Transcript provider connection timed out.");
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }

  private closeTranscriptionProvider(): void {
    this.transcriptionRecoveryGeneration += 1;
    this.transcriptionProviderOpeningGeneration = null;
    this.transcriptionRecoveryPromise = null;
    this.pendingTranscriptionRecoveryFailure = null;
    this.transcriptionConnectionEpoch += 1;
    const session = this.transcriptionSession;
    this.transcriptionSession = null;
    this.transcriptionConnectionOptions = null;
    this.transcriptionRecoveryAudio.reset();
    this.resetTranscriptionAudioState();
    try {
      session?.close();
    } catch {}
  }

  private resetTranscriptionAudioState(): void {
    const hadPartials = this.partialSegments.size > 0;
    this.partialSegments.clear();
    this.speakerAttribution.reset();
    this.transcriptionReplayJournal.reset();
    this.latestSpeaker = null;
    this.hasPendingAudio = false;
    this.pendingAudioSamples = 0;
    this.pendingTranscriptionCommitAcks = [];
    if (this.transcriptionCommitWatchdogTimer !== null) {
      clearTimeout(this.transcriptionCommitWatchdogTimer);
      this.transcriptionCommitWatchdogTimer = null;
    }
    if (hadPartials) {
      this.broadcast({ type: "partials.reset" });
    }
  }

  private handleTranscriptItemCommitted(itemId: string): void {
    this.acknowledgeTranscriptionCommit();
    this.transcriptionReplayJournal.bindCommittedItem(itemId);
    const speaker = this.speakerAttribution.bindCommittedItem(itemId);
    if (speaker) {
      this.reassignSegmentSpeaker(itemId, speaker);
    }
  }

  private trackPendingTranscriptionCommit(): void {
    this.pendingTranscriptionCommitAcks.push(Date.now());
    this.armTranscriptionCommitWatchdog();
  }

  private acknowledgeTranscriptionCommit(): void {
    this.pendingTranscriptionCommitAcks.shift();
    this.armTranscriptionCommitWatchdog();
  }

  private armTranscriptionCommitWatchdog(): void {
    if (this.transcriptionCommitWatchdogTimer !== null) {
      clearTimeout(this.transcriptionCommitWatchdogTimer);
      this.transcriptionCommitWatchdogTimer = null;
    }
    const oldestCommitAt = this.pendingTranscriptionCommitAcks[0];
    if (oldestCommitAt === undefined) return;
    const delay = Math.max(
      0,
      oldestCommitAt + TRANSCRIPTION_COMMIT_ACK_TIMEOUT_MS - Date.now(),
    );
    this.transcriptionCommitWatchdogTimer = setTimeout(() => {
      this.transcriptionCommitWatchdogTimer = null;
      const currentOldestCommitAt = this.pendingTranscriptionCommitAcks[0];
      if (currentOldestCommitAt === undefined) return;
      if (
        currentOldestCommitAt + TRANSCRIPTION_COMMIT_ACK_TIMEOUT_MS >
        Date.now()
      ) {
        this.armTranscriptionCommitWatchdog();
        return;
      }
      void this.handleTranscriptionFailure(
        "Transcription provider acknowledgment timed out.",
      );
    }, delay);
  }

  private async handleTranscriptionFailure(
    message: string,
    failedEvents: BufferedTranscriptAudioEvent[] = [],
  ): Promise<void> {
    const redactedMessage = redactSensitiveText(message);
    console.warn("[TranscriptWorker] transcription provider failure", {
      roomId: this.session?.roomId,
      status: this.session?.status,
      transportMode: this.session?.transportMode,
      provider: this.transcriptionSession?.provider ?? null,
      message: redactedMessage,
    });
    if (
      this.session?.status !== "live" &&
      this.session?.status !== "starting" &&
      this.session?.status !== "paused"
    ) {
      return;
    }
    if (this.transcriptionRecoveryPromise) {
      this.transcriptionRecoveryAudio.enqueueMany(failedEvents);
      this.pendingTranscriptionRecoveryFailure = redactedMessage;
      return;
    }
    if (
      !this.transcriptionConnectionOptions ||
      !isRetryableTranscriptionFailure(redactedMessage)
    ) {
      await this.failTranscriptionPermanently(redactedMessage);
      return;
    }

    const replayEvents = this.transcriptionReplayJournal.takeRecoveryEvents();
    const failedSession = this.transcriptionSession;
    this.transcriptionSession = null;
    this.transcriptionConnectionEpoch += 1;
    try {
      failedSession?.close();
    } catch {}
    this.resetTranscriptionAudioState();
    this.transcriptionRecoveryAudio.enqueueMany([
      ...replayEvents,
      ...failedEvents,
    ]);

    const generation = this.transcriptionRecoveryGeneration + 1;
    this.transcriptionRecoveryGeneration = generation;
    const recovery = this.recoverTranscriptionProvider(
      generation,
      redactedMessage,
    );
    this.transcriptionRecoveryPromise = recovery;
    try {
      await recovery;
    } finally {
      if (this.transcriptionRecoveryPromise === recovery) {
        this.transcriptionRecoveryPromise = null;
      }
    }
    const pendingFailure = this.pendingTranscriptionRecoveryFailure;
    this.pendingTranscriptionRecoveryFailure = null;
    if (
      pendingFailure &&
      generation === this.transcriptionRecoveryGeneration
    ) {
      await this.handleTranscriptionFailure(pendingFailure);
    }
  }

  private async recoverTranscriptionProvider(
    generation: number,
    initialMessage: string,
  ): Promise<void> {
    const options = this.transcriptionConnectionOptions;
    if (!options) return;

    let lastMessage = initialMessage;
    for (let attempt = 0; ; attempt += 1) {
      const delay = transcriptionRecoveryDelayMs(attempt);
      if (delay > 0) {
        await new Promise<void>((resolve) => setTimeout(resolve, delay));
      }
      if (generation !== this.transcriptionRecoveryGeneration) return;

      let replacement: LiveTranscriptionSession | null = null;
      let bufferedEvents: BufferedTranscriptAudioEvent[] = [];
      try {
        replacement = await this.openTranscriptionProvider(options);
        if (generation !== this.transcriptionRecoveryGeneration) {
          replacement.close();
          return;
        }
        this.transcriptionSession = replacement;
        bufferedEvents = this.transcriptionRecoveryAudio.drain();
        if (!this.replayBufferedTranscriptionAudio(bufferedEvents, false)) {
          throw new Error(
            "Buffered transcript audio replay connection failed.",
          );
        }
      } catch (error) {
        if (replacement && this.transcriptionSession === replacement) {
          this.pendingTranscriptionRecoveryFailure = null;
          this.transcriptionSession = null;
          this.transcriptionConnectionEpoch += 1;
          try {
            replacement.close();
          } catch {}
          this.resetTranscriptionAudioState();
          this.transcriptionRecoveryAudio.enqueueMany(bufferedEvents);
        }
        lastMessage = redactSensitiveText(
          error instanceof Error
            ? error.message
            : "Transcription provider reconnect failed.",
        );
        console.warn("[TranscriptWorker] transcription reconnect attempt failed", {
          roomId: this.session?.roomId,
          transportMode: this.session?.transportMode,
          attempt: attempt + 1,
          message: lastMessage,
        });
        if (!isRetryableTranscriptionFailure(lastMessage)) {
          if (generation !== this.transcriptionRecoveryGeneration) return;
          await this.failTranscriptionPermanently(lastMessage);
          return;
        }
        continue;
      }

      const droppedEvents =
        this.transcriptionRecoveryAudio.consumeDroppedEventCount();
      console.info("[TranscriptWorker] transcription provider recovered", {
        roomId: this.session?.roomId,
        transportMode: this.session?.transportMode,
        provider: replacement.provider,
        attempt: attempt + 1,
        bufferedEvents: bufferedEvents.length,
        droppedEvents,
      });
      if (this.session) {
        this.session = {
          ...this.session,
          updatedAt: Date.now(),
          error: null,
        };
        this.broadcastSession();
        try {
          await this.persist();
        } catch (error) {
          console.warn("[TranscriptWorker] recovered session persist failed", {
            roomId: this.session.roomId,
            message: redactSensitiveText(
              error instanceof Error ? error.message : "Snapshot write failed.",
            ),
          });
        }
      }
      return;
    }
  }

  private replayBufferedTranscriptionAudio(
    events: BufferedTranscriptAudioEvent[],
    reportFailure = true,
  ): boolean {
    for (const event of events) {
      if (!this.transcriptionSession) return false;
      if (event.type === "chunk") {
        if (
          !this.appendNormalizedAudio(
            event.audio,
            event.speaker,
            event.sampleCount,
            false,
            reportFailure,
          )
        ) {
          return false;
        }
        continue;
      }
      if (event.type === "commit") {
        if (
          this.hasPendingAudio &&
          canCommitPendingAudioForSpeaker(this.latestSpeaker, event.speaker)
        ) {
          if (
            !this.commitTranscriptionBuffer(
              event.speaker,
              "Recovered transcript audio commit failed.",
              reportFailure,
            )
          ) {
            return false;
          }
        }
        continue;
      }
      if (this.hasPendingAudio && this.latestSpeaker) {
        if (
          !this.commitTranscriptionBuffer(
            this.latestSpeaker,
            "Recovered transcript audio commit failed.",
            reportFailure,
          )
        ) {
          return false;
        }
      } else {
        try {
          this.transcriptionSession.clearAudio();
        } catch {
          if (reportFailure) {
            void this.handleTranscriptionFailure(
              "Recovered transcript audio clear failed.",
            );
          }
          return false;
        }
      }
    }
    return true;
  }

  private async failTranscriptionPermanently(message: string): Promise<void> {
    const redactedMessage = redactSensitiveText(message);
    this.broadcast({ type: "error", message: redactedMessage });
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
    if (this.transcriptionSession?.provider === "sarvam") {
      // Sarvam is a continuous stream and its final items do not map 1:1 to
      // the room's periodic commit markers. A final acknowledges everything
      // sent through the current VAD boundary, so begin a fresh recovery window.
      this.transcriptionReplayJournal.reset();
    } else {
      this.transcriptionReplayJournal.finalizeItem(itemId);
    }
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
    this.cancelControllerReconnect();
    this.cancelSfuRelayRecovery();
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
        current: this.minutes,
        fallback: this.hasMinutesContent(this.minutes) ? this.minutes : fallback,
      });
      if (minutes) {
        const compactionDue =
          minutesNeedCompaction(minutes) ||
          Date.now() - this.lastMinutesCompactionAt >=
            MINUTES_COMPACTION_INTERVAL_MS;
        if (compactionDue) {
          try {
            this.minutes = await compactMinutes({
              env: this.env,
              apiKey: this.responseApiKey,
              model: this.session.qaModel,
              current: minutes,
            });
          } catch (error) {
            // Keep the live minutes usable even if the background compaction
            // request fails. The hard bound prevents prompt/persistence growth
            // and the next interval can try a semantic compaction again.
            console.warn("[TranscriptWorker] minutes compaction failed", {
              roomId: this.session.roomId,
              message: redactSensitiveText(
                error instanceof Error ? error.message : String(error),
              ),
            });
            this.minutes = boundMinutesSnapshot(minutes);
          }
          this.lastMinutesCompactionAt = Date.now();
        } else {
          this.minutes = boundMinutesSnapshot(minutes);
        }
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
      case "relay.handoff.prepare":
      case "relay.ping":
        return "control";
      case "export.snapshot":
        return "export";
      case "minutes.refresh":
        return "minutes";
      case "qa.ask":
        return "qa";
      case "session.start":
      case "session.stop":
      case "session.relayFailed":
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
    const transcriptionConfig = this.transcriptionConnectionOptions
      ? {
          language: this.transcriptionConnectionOptions.language,
          delay: this.transcriptionConnectionOptions.delay,
          locale: this.transcriptionConnectionOptions.locale,
        }
      : undefined;
    await this.state.storage.put("snapshot", {
      session: this.session,
      segments: this.segments,
      minutes: this.minutes,
      minutesCompactedAt: this.lastMinutesCompactionAt,
      sequence: this.sequence,
      serviceVersion: this.serviceVersion(),
      transcriptionConfig,
    } satisfies PersistedSnapshot);
    await this.armCleanupAlarm();
  }

  private async armCleanupAlarm(): Promise<void> {
    const ttlMs =
      this.session?.status === "takeover_needed" ||
      this.session?.status === "error"
        ? parsePositiveInt(
            this.env.TRANSCRIPT_RECOVERY_RETENTION_MS,
            DEFAULT_RECOVERY_RETENTION_MS,
          )
        : parsePositiveInt(
            this.env.TRANSCRIPT_IDLE_TTL_MS,
            DEFAULT_IDLE_TTL_MS,
          );
    await this.state.storage.setAlarm(Date.now() + ttlMs);
  }

  private resetInMemorySession(roomId: string, qaModel = DEFAULT_QA_MODEL): void {
    this.cancelControllerReconnect();
    this.cancelSfuRelayRecovery();
    this.closeTranscriptionProvider();
    this.responseApiKey = null;
    this.segments = [];
    this.resetTranscriptionAudioState();
    this.resetMinutesScheduler();
    this.audioPaused = false;
    this.sequence = 0;
    this.lastMinutesRefreshAt = 0;
    this.lastMinutesCompactionAt = 0;
    this.session = {
      ...createIdleSession(roomId),
      qaModel,
    };
    this.minutes = createEmptyMinutes(qaModel);
  }
}
