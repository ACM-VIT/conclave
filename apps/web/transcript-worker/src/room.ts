import { resolveAiFeatureSettings, roomAiFeatureSettingsFromEnvironment } from "@conclave/ai/room-settings";
import { describeRoomAiLookupFailure, fetchRoomAiEnvironment, roomAiEnvironment } from "@conclave/ai/room-server";
import { getProviderApiKey, type AiEnvironment } from "@conclave/ai/models";
import {
  getResponseProvider,
  isResponseModel,
} from "@conclave/ai/models";
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
  TRANSCRIPTION_DRAIN_SEQUENCE_BLOCK,
  TRANSCRIPTION_GAP_MARKER,
  TRANSCRIPTION_LINE_DEADLINE_MS,
  TRANSCRIPTION_PROVIDER_DRAIN_MS,
  TRANSCRIPTION_RECOVERY_MAX_AUDIO_BYTES,
  UNOWNED_AUDIO_KEPT_MS,
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
  resolveTranscriptResponseApiKey,
} from "./key-policy";
import { compactMinutes, generateMinutes, streamQuestionAnswer } from "./ai";
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
import {
  CaptionLedger,
  ProviderConnection,
  isActive,
  type AudioChunk,
  type CaptionLine,
  type LinePlace,
} from "./caption-ledger";
import { VoiceActivity } from "./transcription/voice-activity";
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
  canTranscribeLanguage,
  isTranscriptionProviderLanguage,
  shownTranscriptionLanguage,
  transcriptionProviderLanguage,
  connectLiveTranscriptionProvider,
  type LiveTranscriptionSession,
} from "./transcription";
import type { AcceptedUtterance, HeardSpeech } from "./transcription/types";
import {
  TranscriptRecoveryAudioBuffer,
  isRetryableTranscriptionFailure,
  transcriptionRecoveryDelayMs,
  type BufferedTranscriptAudioEvent,
} from "./transcription-recovery";
import {
  json,
  normalizeDelay,
  normalizeLanguage,
  normalizeRequestId,
  normalizeLocale,
  normalizeModel,
  normalizeRoomIdFromPath,
  normalizeSpeaker,
  normalizeTransportMode,
  parsePositiveInt,
  redactSensitiveText,
  safeJsonParse,
  createSilentPcm16Base64,
  decodePcm16Base64,
  estimatePcm16Base64SampleCount,
  speakerKey,
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
  // Every caption line of the session, each with one public itemId for life.
  private readonly ledger = new CaptionLedger();
  private liveConnection: ProviderConnection | null = null;
  // Audio sent to the live provider that no line owns yet, per speaker.
  private readonly uncommittedAudio = new Map<string, { speaker: TranscriptSpeaker; chunks: AudioChunk[] }>();
  // Sarvam: the line each speaker's new audio belongs to until the turn ends.
  private readonly speakingLine = new Map<string, string>();
  private readonly voiceChecks = new Map<string, VoiceActivity>();
  private audioTurn = 0;
  private lineTimer: ReturnType<typeof setTimeout> | null = null;
  // Set from accepting a switch until its provider opens, so audio meanwhile is kept.
  private switchingProvider = false;
  private latestSpeaker: TranscriptSpeaker | null = null;
  private lastAudioAt = 0;
  private hasPendingAudio = false;
  private pendingAudioSamples = 0;
  private session: TranscriptSessionState | null = null;
  private sessionRevision = 0;
  private segments: TranscriptSegment[] = [];
  private minutes: TranscriptMinutesSnapshot = createEmptyMinutes();
  private sequence = 0;
  // The exact language code this session's provider is sent, fixed when the
  // session is accepted and saved with it, so a restore resends it unchanged.
  private sessionProviderLanguage: string | undefined;
  private responseApiKey: string | null = null;
  private responseEnvironment: Env | null = null;
  private responseAbort = new AbortController();
  private responseRoute: {sfuUrl: string; identity: {userId: string; roomId: string; clientId: string; channelId: string}} | null = null;
  private personalResponseKeys: Partial<Record<"openai" | "anthropic", string>> = {};
  private transcriptionSession: LiveTranscriptionSession | null = null;
  private readonly providerDrains = new Map<number, ProviderConnection>();
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
  private transcriptionCommitWatchdogTimer: ReturnType<typeof setTimeout> | null =
    null;
  private readonly transcriptionRecoveryAudio =
    new TranscriptRecoveryAudioBuffer();
  private lastMinutesRefreshAt = 0;
  private lastMinutesCompactionAt = 0;
  private minutesTimer: ReturnType<typeof setTimeout> | null = null;
  private minutesDirtySince = 0;
  private minutesGenerating = false;
  private minutesRerunRequested = false;
  private hasAiMinutes = false;
  private minutesStatus: TranscriptMinutesStatus = "idle";
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
      sfuUrl: payload.sfuUrl,
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
      supportsCaptionLanguage: true,
      captionLanguageDefaults: this.captionLanguageDefaults(),
      segments: this.segments,
      partials: this.visiblePartials(),
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
    const { providerLanguage } = this.savedTranscription(snapshot);
    this.sessionProviderLanguage = providerLanguage;
    this.session = {
      ...this.session,
      language: shownTranscriptionLanguage(providerLanguage),
      providerLanguage,
    };
    if (shouldRecoverAutomatically) {
      this.state.waitUntil(this.restorePersistedGlobalSession(snapshot));
    }
  }

  /**
   * What a saved session was connected with, from any snapshot layout: the
   * exact provider code on the session (current), at the snapshot root
   * (earlier builds of this change), or, for staging's snapshots that saved
   * none, the code staging itself resolves from the saved connection.
   */
  private savedTranscription(snapshot: PersistedSnapshot) {
    const provider = getTranscriptTranscriptionProvider(
      normalizeRealtimeTranscriptModel(snapshot.session.transcriptModel, DEFAULT_TRANSCRIPT_MODEL),
    );
    const savedConfig = snapshot.transcriptionConfig;
    // A pick resumes as picked, the session's newest one first. Without one,
    // resume exactly as before picks existed: the saved connection's
    // language, else the deployment's, never the language the session reports.
    const languageChosen = snapshot.session.language
      ? snapshot.session.languageChosen === true
      : savedConfig?.languageChosen === true;
    const config = {
      language: normalizeLanguage(
        (languageChosen
          ? snapshot.session.language ?? savedConfig?.language
          : savedConfig?.language) ?? this.env.TRANSCRIPT_TRANSCRIPTION_LANGUAGE,
      ),
      languageChosen,
      delay: savedConfig?.delay ?? normalizeDelay(undefined),
      locale:
        savedConfig?.locale ??
        normalizeLocale(this.env.TRANSCRIPT_TRANSCRIPTION_LOCALE),
    };
    const providerLanguage =
      snapshot.session.providerLanguage ??
      snapshot.providerLanguage ??
      transcriptionProviderLanguage(provider, { ...config, env: this.env });
    return { config, providerLanguage };
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
    const responseKey = this.resolveResponseKey(
      snapshot.session.qaModel,
      provider,
      undefined,
      undefined,
    );
    if (!transcriptionKey.ok || !responseKey.ok) return;

    const wasPaused = snapshot.session.status === "paused";
    const revision = this.sessionRevision;
    // A saved session resends the code it was sent, whatever the environment
    // is now; only a snapshot without one resolves it from its saved config.
    const { config, providerLanguage } = this.savedTranscription(snapshot);
    this.sessionProviderLanguage = providerLanguage;
    this.responseApiKey = responseKey.apiKey;
    this.session = {
      ...snapshot.session,
      status: "starting",
      language: shownTranscriptionLanguage(providerLanguage),
      providerLanguage,
      languageChosen: config.languageChosen,
      updatedAt: Date.now(),
      error: null,
    };
    try {
      await this.connectTranscriptionProvider({
        apiKey: transcriptionKey.apiKey,
        transcriptModel,
        ...config,
        providerLanguage,
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
      // A session someone started meanwhile is theirs, not this restore's to fail.
      if (revision !== this.sessionRevision || this.session.status !== "starting") return;
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
      if (this.viewers.get(socket)?.sfuUrl && data && typeof data === "object" && "globalProviderKeysAvailable" in data) {
        data = { ...data, globalOpenAiKeyAvailable: false, globalProviderKeysAvailable: { openai: false, anthropic: false, sarvam: false } };
      }
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
    env: AiEnvironment = this.env,
  ) {
    return resolveTranscriptProviderApiKey({
      provider,
      providedApiKey,
      globalApiKey:
        provider === "sarvam" ? env.SARVAM_API_KEY : env.OPENAI_API_KEY,
    });
  }

  private resolveResponseKey(
    model: string,
    transcriptionProvider: TranscriptTranscriptionProvider,
    transcriptionApiKey: string | undefined,
    assistantApiKey: string | undefined,
    env: AiEnvironment = this.env,
  ) {
    return resolveTranscriptResponseApiKey({
      env,
      model,
      transcriptionProvider,
      transcriptionApiKey,
      assistantApiKey,
    });
  }

  private serviceVersion() {
    return getTranscriptServiceVersion(this.env);
  }

  /** Per provider, the exact code its provider is sent when nobody picks a language. */
  private captionLanguageDefaults(): Record<"openai" | "sarvam", string> {
    const unpicked = {
      language: normalizeLanguage(this.env.TRANSCRIPT_TRANSCRIPTION_LANGUAGE),
      languageChosen: false,
      locale: normalizeLocale(this.env.TRANSCRIPT_TRANSCRIPTION_LOCALE),
      env: this.env,
    };
    return {
      openai: transcriptionProviderLanguage("openai", unpicked),
      sarvam: transcriptionProviderLanguage("sarvam", unpicked),
    };
  }

  private sendError(viewer: Viewer, message: string, requestId?: string): void {
    this.send(viewer.socket, {
      type: "error",
      message: redactSensitiveText(message),
      ...(requestId ? { requestId } : {}),
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
        this.clearAudio(viewer, message.speaker);
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
          supportsCaptionLanguage: true,
          captionLanguageDefaults: this.captionLanguageDefaults(),
          segments: this.segments,
          partials: this.visiblePartials(),
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
        remainingUserIds: Array.from(
          this.viewers.values(),
          (item) => item.userId,
        ),
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
    const requestId = normalizeRequestId(message.requestId);
    const refuse = (text: string) => this.sendError(viewer, text, requestId);
    const permission = resolveTranscriptStartPermission({
      canStart: viewer.capabilities.start,
      canTakeover: viewer.capabilities.takeover,
      controllerUserId: this.session?.controller?.userId,
      existingStatus,
      isTakeover: takeover,
      viewerUserId: viewer.userId,
    });
    if (!permission.ok) {
      refuse(permission.message);
      return;
    }

    const revision = this.sessionRevision;
    const roomId = this.session?.roomId || "unknown";
    const now = Date.now();
    let transcriptModel = normalizeRealtimeTranscriptModel(
      normalizeModel(message.transcriptModel, DEFAULT_TRANSCRIPT_MODEL),
      DEFAULT_TRANSCRIPT_MODEL,
    );
    let transcriptionProvider =
      getTranscriptTranscriptionProvider(transcriptModel);
    let qaModel = isResponseModel(message.qaModel || "")
      ? message.qaModel!
      : DEFAULT_QA_MODEL;
    const assistantKeyProvider = getResponseProvider(qaModel);
    const providers = ["openai", "anthropic", "sarvam"] as const;
    const routedRoom = Boolean(viewer.sfuUrl && viewer.clientId && viewer.channelId);
    let effectiveEnv: AiEnvironment = routedRoom ? roomAiEnvironment(this.env, {}) : { ...this.env };
    let usesRoomKey = false;
    if (
      viewer.sfuUrl &&
      viewer.clientId &&
      viewer.channelId
    ) {
      try {
        const roomEnv = await fetchRoomAiEnvironment({
          sfuUrl: viewer.sfuUrl,
          secret: this.env.TRANSCRIPT_TOKEN_SECRET,
          identity: {
            userId: viewer.userId,
            roomId,
            clientId: viewer.clientId,
            channelId: viewer.channelId,
          },
          providers: [...providers],
        });
        effectiveEnv = roomAiEnvironment(this.env, roomEnv);
        usesRoomKey = providers.some((provider) => Boolean(getProviderApiKey(roomEnv, provider)));
      } catch (error) {
        console.warn("[Transcript] room AI lookup failed:", JSON.stringify(describeRoomAiLookupFailure(error)));
        refuse("Room AI settings could not be loaded. Please reconnect and try again.");
        return;
      }
      if (
        revision !== this.sessionRevision ||
        !this.viewers.has(viewer.socket) ||
        (this.session?.status ?? "idle") !== existingStatus
      ) {
        refuse("Notes changed while connecting. Please try again.");
        return;
      }
    }
    const featureSettings = roomAiFeatureSettingsFromEnvironment(effectiveEnv);
    transcriptModel = featureSettings.transcription?.model ?? transcriptModel;
    transcriptionProvider = getTranscriptTranscriptionProvider(transcriptModel);
    qaModel = featureSettings.questions?.model ?? qaModel;
    if (!resolveAiFeatureSettings(effectiveEnv, "transcription").enabled) {
      refuse("Transcription is disabled in Room AI settings.");
      return;
    }
    const transcriptionKey = this.resolveTranscriptionKey(
      transcriptionProvider,
      message.apiKey,
      effectiveEnv,
    );
    if (!transcriptionKey.ok) {
      refuse(transcriptionKey.message);
      return;
    }
    const personalResponseKeys: typeof this.personalResponseKeys = {};
    if (transcriptionProvider === "openai" && message.apiKey?.trim()) {
      personalResponseKeys.openai = message.apiKey.trim();
    }
    if (message.assistantApiKey?.trim()) {
      personalResponseKeys[assistantKeyProvider] = message.assistantApiKey.trim();
    }
    const responseKey = this.resolveResponseKey(
      qaModel,
      transcriptionProvider,
      message.apiKey,
      personalResponseKeys[getResponseProvider(qaModel)],
      effectiveEnv,
    );
    const separateTextProfiles = Boolean(featureSettings.minutes || featureSettings.questions);
    for (const feature of ["minutes", "questions"] as const) {
      const settings = resolveAiFeatureSettings(feature === "minutes" && separateTextProfiles ? effectiveEnv : {...effectiveEnv, CONCLAVE_ASSISTANT_MODEL: qaModel}, feature);
      if (!settings.enabled) continue;
      const key = this.resolveResponseKey(settings.model, transcriptionProvider, message.apiKey, personalResponseKeys[getResponseProvider(settings.model)], effectiveEnv);
      if (!key.ok) { refuse(key.message); return; }
    }

    const providerEnv = { ...this.env, ...effectiveEnv };
    const deploymentLanguage = normalizeLanguage(
      this.env.TRANSCRIPT_TRANSCRIPTION_LANGUAGE,
    );
    // Only a pick names a language: this request's, or the resumed session's.
    // Without one the provider gets exactly what it did before picks existed,
    // the deployment language, never the language the session reports.
    const keepsPick =
      message.language === undefined && takeover && this.session?.languageChosen === true;
    const pickedLanguage = message.language || (keepsPick ? this.session?.language : undefined);
    const requestedLanguage = normalizeLanguage(pickedLanguage || deploymentLanguage);
    const requestedLanguageChosen = Boolean(pickedLanguage);
    const canCaption = canTranscribeLanguage(
      transcriptionProvider,
      requestedLanguage,
      requestedLanguageChosen,
      providerEnv,
    );
    if (!canCaption && message.language) {
      refuse("This room's transcription model can't caption in that language.");
      return;
    }
    const locale = normalizeLocale(this.env.TRANSCRIPT_TRANSCRIPTION_LOCALE);
    // A client that shows a language sends the exact code it shows, and that
    // code is used as it is; only a request with none resolves one here.
    const sentProviderLanguage = message.providerLanguage?.trim();
    if (
      sentProviderLanguage &&
      !isTranscriptionProviderLanguage(transcriptionProvider, sentProviderLanguage)
    ) {
      refuse("This room's transcription model can't caption in that language.");
      return;
    }
    const keepsSessionCode =
      takeover && Boolean(sentProviderLanguage) && sentProviderLanguage === this.session?.providerLanguage;
    const language = sentProviderLanguage
      ? normalizeLanguage(sentProviderLanguage)
      : canCaption ? requestedLanguage : deploymentLanguage;
    const languageChosen = sentProviderLanguage
      ? message.language !== null &&
        (Boolean(message.language) || (keepsSessionCode && this.session?.languageChosen === true))
      : canCaption && requestedLanguageChosen;
    const providerLanguage =
      sentProviderLanguage ??
      transcriptionProviderLanguage(transcriptionProvider, {
        language,
        languageChosen,
        locale,
        env: providerEnv,
      });

    this.responseAbort.abort();
    this.responseAbort = new AbortController();
    const acceptedRevision = ++this.sessionRevision;
    this.responseEnvironment = providerEnv;
    const transportMode = normalizeTransportMode(message.transportMode);
    const wasIdle = existingStatus === "idle" || existingStatus === "error";
    this.responseApiKey = responseKey.ok ? responseKey.apiKey : null;
    this.responseRoute = viewer.sfuUrl && viewer.clientId && viewer.channelId ? {sfuUrl: viewer.sfuUrl, identity: {userId: viewer.userId, roomId, clientId: viewer.clientId, channelId: viewer.channelId}} : null;
    this.personalResponseKeys = personalResponseKeys;
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
      language: shownTranscriptionLanguage(providerLanguage),
      providerLanguage,
      languageChosen,
      requestId,
      keySource:
        !usesRoomKey && transcriptionKey.source === "global" && (!responseKey.ok || responseKey.source === "global")
          ? "global"
          : "controller",
      startedAt: wasIdle ? now : (this.session?.startedAt ?? now),
      updatedAt: now,
      error: null,
    };
    this.sessionProviderLanguage = providerLanguage;
    if (!wasIdle) {
      this.drainTranscriptionProvider();
      this.switchingProvider = true;
    }
    this.resetTranscriptionAudioState();
    this.audioPaused = false;
    this.resetMinutesScheduler(!wasIdle);
    if (wasIdle) {
      this.forgetAllLines();
      this.segments = [];
      this.sequence = 0;
      this.minutes = createEmptyMinutes(qaModel);
      this.lastMinutesRefreshAt = 0;
      this.lastMinutesCompactionAt = now;
    }
    this.broadcastSession();
    try {
      await this.persist();
    } catch (error) {
      if (acceptedRevision === this.sessionRevision) this.switchingProvider = false;
      throw error;
    }

    if (acceptedRevision !== this.sessionRevision) return;
    try {
      const delay = normalizeDelay(message.delay);
      this.switchingProvider = false;
      await this.connectTranscriptionProvider({
        apiKey: transcriptionKey.apiKey,
        transcriptModel,
        language,
        languageChosen,
        providerLanguage,
        delay,
        locale,
        localizationPrompt: this.env.TRANSCRIPT_TRANSCRIPTION_PROMPT,
      });
      if (acceptedRevision !== this.sessionRevision) return;
      this.session = {
        ...this.session,
        status: "live",
        updatedAt: Date.now(),
        error: null,
      };
      this.broadcastSession();
      if (!wasIdle) this.scheduleMinutes();
      await this.sendSfuRelayStartToken(viewer);
      await this.persist();
    } catch (error) {
      if (acceptedRevision !== this.sessionRevision || this.session?.status !== "starting") return;
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

    this.sessionRevision += 1;
    this.suppressSfuRelayDisconnectsUntil =
      Date.now() + SFU_RELAY_DISCONNECT_SUPPRESSION_MS;
    this.suppressSfuRelayDisconnectCount += 1;
    this.cancelControllerReconnect();
    this.cancelSfuRelayRecovery();
    this.forgetAllLines();
    const roomId = this.session?.roomId || "unknown";
    this.responseApiKey = null;
    this.responseAbort.abort();
    this.responseAbort = new AbortController();
    this.responseEnvironment = null;
    this.responseRoute = null;
    this.personalResponseKeys = {};
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
      supportsCaptionLanguage: true,
      captionLanguageDefaults: this.captionLanguageDefaults(),
      segments: [],
      partials: [],
      minutes: this.minutes,
      minutesStatus: this.minutesStatus,
    });
  }

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
    const session = this.transcriptionSession;
    if (!session) return false;
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
    const now = Date.now();
    const key = speakerKey(speaker);
    const voice = this.voiceCheckFor(key).push(decodePcm16Base64(audio), now);
    try {
      session.appendAudio(audio, speaker, { voice, turn: this.audioTurn });
    } catch {
      if (reportFailure) {
        void this.handleTranscriptionFailure(
          "Transcript audio stream failed.",
          captureFailedEvent
            ? [{ type: "chunk", audio, speaker, sampleCount, createdAt: now }]
            : [],
        );
      }
      return false;
    }
    this.keepAudio(session.provider, speaker, { audio, sampleCount, createdAt: now, voice, turn: this.audioTurn });
    this.latestSpeaker = speaker;
    this.lastAudioAt = now;
    this.hasPendingAudio = true;
    this.pendingAudioSamples += sampleCount;
    return true;
  }

  /**
   * Keeps a chunk for a replay with the line it belongs to: a Sarvam
   * speaker's open line, which then waits 30 s from this chunk, else that
   * speaker's audio no line owns yet, which a line accepted for it adopts.
   * Sarvam's unowned audio is kept only as long as a late speech signal
   * could still claim it, and is never replayed on its own.
   */
  private keepAudio(provider: string, speaker: TranscriptSpeaker, chunk: AudioChunk): void {
    const key = speakerKey(speaker);
    const owner = provider === "sarvam" ? this.ledger.get(this.speakingLine.get(key) ?? "") : undefined;
    if (owner?.state === "open") {
      owner.audio.push(chunk);
      owner.deadlineAt = Math.max(owner.deadlineAt, chunk.createdAt + TRANSCRIPTION_LINE_DEADLINE_MS);
    } else {
      const pending = this.uncommittedAudio.get(key) ?? { speaker, chunks: [] };
      pending.chunks.push(chunk);
      if (provider === "sarvam") {
        pending.chunks = pending.chunks.filter(({ createdAt }) => chunk.createdAt - createdAt <= UNOWNED_AUDIO_KEPT_MS);
      }
      this.uncommittedAudio.set(key, pending);
    }
    this.keepReplayAudioWithinLimit();
  }

  /**
   * Replay audio, owned by a line or by no line yet, stays within one
   * limit for the whole room, so a relay that never commits cannot grow
   * it without end. The oldest chunks go first.
   */
  private keepReplayAudioWithinLimit(): void {
    const lines = this.ledger.activeUnordered();
    const holders = [...lines.map(({ audio }) => audio), ...Array.from(this.uncommittedAudio.values(), ({ chunks }) => chunks)];
    let total = 0;
    for (const chunks of holders) for (const { audio } of chunks) total += audio.length;
    if (total <= TRANSCRIPTION_RECOVERY_MAX_AUDIO_BYTES) return;
    const kept = new Set<AudioChunk>();
    let bytes = 0;
    for (const chunk of holders.flat().sort((left, right) => right.createdAt - left.createdAt)) {
      if (bytes + chunk.audio.length > TRANSCRIPTION_RECOVERY_MAX_AUDIO_BYTES) break;
      bytes += chunk.audio.length;
      kept.add(chunk);
    }
    for (const line of lines) line.audio = line.audio.filter((chunk) => kept.has(chunk));
    for (const [key, pending] of this.uncommittedAudio) {
      pending.chunks = pending.chunks.filter((chunk) => kept.has(chunk));
      if (pending.chunks.length === 0) this.uncommittedAudio.delete(key);
    }
  }

  private voiceCheckFor(key: string): VoiceActivity {
    let check = this.voiceChecks.get(key);
    if (!check) {
      check = new VoiceActivity();
      this.voiceChecks.set(key, check);
    }
    return check;
  }

  /** A speaker's audio no line owns yet, from `since` in the turn it began, for the line just accepted. */
  private adoptAudio(speaker: TranscriptSpeaker, since: number, turn: number | undefined): AudioChunk[] {
    const key = speakerKey(speaker);
    const pending = this.uncommittedAudio.get(key);
    if (!pending || turn === undefined) return [];
    const adopted = pending.chunks.filter((chunk) => chunk.createdAt >= since && chunk.turn === turn);
    pending.chunks = pending.chunks.filter((chunk) => !adopted.includes(chunk));
    if (pending.chunks.length === 0) this.uncommittedAudio.delete(key);
    return adopted;
  }

  /**
   * A new utterance in a turn an older line took keeps its own audio from
   * where it began, and the older line's wait goes back to its own audio.
   */
  private takeFromSpeakingLine(speaker: TranscriptSpeaker, since: number, turn: number | undefined): AudioChunk[] {
    const older = this.ledger.get(this.speakingLine.get(speakerKey(speaker)) ?? "");
    if (!older || turn === undefined) return [];
    const taken = older.audio.filter((chunk) => chunk.createdAt >= since && chunk.turn === turn);
    older.audio = older.audio.filter((chunk) => !taken.includes(chunk));
    if (taken.length > 0 && isActive(older)) older.deadlineAt = this.ownAudioDeadline(older);
    return taken;
  }

  /** A live Sarvam line waits 30 s from when it was accepted or from its last own chunk, whichever is later. */
  private ownAudioDeadline(line: CaptionLine): number {
    const lastAudioAt = line.audio.reduce((latest, { createdAt }) => Math.max(latest, createdAt), line.place.startMs);
    return lastAudioAt + TRANSCRIPTION_LINE_DEADLINE_MS;
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

  /**
   * Commits the pending audio. For OpenAI that audio becomes a line now,
   * awaiting its ack, with its speaker, its place and its audio; Sarvam
   * accepts utterances on its own, so its commit only sends the audio on.
   */
  private commitTranscriptionBuffer(
    speaker: TranscriptSpeaker,
    failureMessage: string,
    reportFailure = true,
  ): boolean {
    const live = this.liveConnection;
    const session = this.transcriptionSession;
    if (!session || !live || !this.hasPendingAudio) return false;
    try {
      if (session.provider === "openai") {
        const paddingSamples =
          MIN_OPENAI_COMMIT_AUDIO_SAMPLES - this.pendingAudioSamples;
        if (paddingSamples > 0) {
          session.appendAudio(createSilentPcm16Base64(paddingSamples));
        }
      }
      session.commitAudio();
    } catch {
      if (reportFailure) {
        void this.handleTranscriptionFailure(failureMessage);
      }
      return false;
    }
    this.hasPendingAudio = false;
    this.pendingAudioSamples = 0;
    if (session.provider !== "openai") return true;
    const key = speakerKey(speaker);
    const audio = this.uncommittedAudio.get(key)?.chunks ?? [];
    this.uncommittedAudio.delete(key);
    const line = this.newLine(live, {
      state: "pending_ack",
      speaker,
      heard: audio.some(({ voice }) => voice !== "quiet"),
      audio,
    });
    live.commitQueue.push({ lineId: line.id, committedAt: Date.now() });
    this.armTranscriptionCommitWatchdog();
    this.armLineTimer();
    if (line.heard) void this.persist();
    return true;
  }

  private clearAudio(viewer: Viewer, speaker: Partial<TranscriptSpeaker> | undefined): void {
    if (!this.canRelayAudio(viewer)) return;
    if (!this.transcriptionSession && this.shouldBufferTranscriptionAudio()) {
      this.transcriptionRecoveryAudio.enqueue({
        type: "clear",
        speaker: normalizeSpeaker(speaker, viewer),
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
    this.endAudioTurn();
    this.hasPendingAudio = false;
    this.pendingAudioSamples = 0;
  }

  /** A turn ended: new audio starts a new turn, and no line owns it yet. */
  private endAudioTurn(): void {
    this.audioTurn += 1;
    this.speakingLine.clear();
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
      this.switchingProvider ||
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
    languageChosen?: boolean;
    providerLanguage?: string;
    delay: string;
    locale: string;
    localizationPrompt?: string;
  }): Promise<void> {
    this.closeTranscriptionProvider(true);
    const generation = this.transcriptionRecoveryGeneration;
    this.transcriptionConnectionOptions = options;
    this.transcriptionProviderOpeningGeneration = generation;
    try {
      try {
        const connection = await this.openTranscriptionProvider(options);
        if (generation !== this.transcriptionRecoveryGeneration) {
          connection.session.close();
          throw new Error("Transcript provider connection was superseded.");
        }
        this.useLiveConnection(connection);
        const owed = this.owedLineIds();
        const bufferedEvents = this.transcriptionRecoveryAudio.drain();
        if (
          !this.replayOwedLines(connection) ||
          (bufferedEvents.length > 0 &&
            !this.replayBufferedTranscriptionAudio(bufferedEvents, false))
        ) {
          this.abandonReplacement(connection, owed);
          this.transcriptionRecoveryAudio.enqueueMany(bufferedEvents);
          throw new Error(
            "Buffered transcript audio replay connection failed.",
          );
        }
        this.settleReplayedLines(connection);
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
    languageChosen?: boolean;
    providerLanguage?: string;
    delay: string;
    locale: string;
    localizationPrompt?: string;
  }): Promise<ProviderConnection> {
    const epoch = this.transcriptionConnectionEpoch + 1;
    this.transcriptionConnectionEpoch = epoch;
    const controller = new AbortController();
    const timeout = setTimeout(() => {
      controller.abort("Transcript provider connection timed out.");
    }, resolveAiFeatureSettings(this.responseEnvironment ?? this.env, "transcription").timeoutMs);
    try {
      const session = await connectLiveTranscriptionProvider({
        env: { ...this.env, ...(this.responseEnvironment ?? {}) },
        ...options,
        signal: controller.signal,
        callbacks: {
          onAccepted: (itemId, utterance) => {
            const connection = this.connectionFor(epoch);
            if (connection) this.acceptLine(connection, itemId, utterance);
          },
          onHeard: (itemId, heard) => {
            const connection = this.connectionFor(epoch);
            if (connection) this.markLineHeard(connection, itemId, heard);
          },
          onCommitted: (itemId) => {
            const connection = this.connectionFor(epoch);
            if (connection) this.acknowledgeLine(connection, itemId);
          },
          onDelta: (itemId, delta) => {
            const connection = this.connectionFor(epoch);
            if (connection) this.applyLineDelta(connection, itemId, delta);
          },
          onFinal: (itemId, transcript) => {
            const connection = this.connectionFor(epoch);
            if (connection) return this.applyLineFinal(connection, itemId, transcript);
          },
          onItemFailed: (itemId) => {
            const connection = this.connectionFor(epoch);
            if (connection) return this.applyLineFailure(connection, itemId);
          },
          onFailure: (message) => {
            if (this.liveConnection?.epoch === epoch) {
              return this.handleTranscriptionFailure(message);
            }
            const drain = this.providerDrains.get(epoch);
            if (drain) return this.endDrain(drain, "failed");
          },
        },
      });
      return new ProviderConnection(epoch, session);
    } catch (error) {
      if (controller.signal.aborted) {
        throw new Error("Transcript provider connection timed out.");
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }

  private connectionFor(epoch: number): ProviderConnection | null {
    if (this.liveConnection?.epoch === epoch) return this.liveConnection;
    return this.providerDrains.get(epoch) ?? null;
  }

  private useLiveConnection(connection: ProviderConnection): void {
    this.liveConnection = connection;
    this.transcriptionSession = connection.session;
  }

  /**
   * Stops the live provider. Lines still owed and audio buffered while it
   * was reconnecting stay for the next connection when it is replaced, and
   * go when notes stop.
   */
  private closeTranscriptionProvider(keepOwed: boolean): void {
    this.transcriptionRecoveryGeneration += 1;
    this.transcriptionProviderOpeningGeneration = null;
    this.transcriptionRecoveryPromise = null;
    this.pendingTranscriptionRecoveryFailure = null;
    this.transcriptionConnectionEpoch += 1;
    const live = this.liveConnection;
    this.liveConnection = null;
    this.transcriptionSession = null;
    this.transcriptionConnectionOptions = null;
    if (!keepOwed) this.transcriptionRecoveryAudio.reset();
    this.resetTranscriptionAudioState();
    if (!live) return;
    for (const line of this.ledger.active()) {
      if (line.epoch === live.epoch) this.awaitReplacement(line);
    }
    this.ledger.forgetEnded(live.epoch);
    try {
      live.session.close();
    } catch {}
  }

  /**
   * Keeps a provider that is being replaced open until every line it owes
   * ends, or, for Sarvam, 10 seconds after its last audio, in case it
   * reports more speech; it drains on its own and never replays, so its
   * lines let their audio go.
   */
  private drainTranscriptionProvider(): void {
    const live = this.liveConnection;
    if (!live) return;
    if (this.hasPendingAudio && this.latestSpeaker) {
      this.commitTranscriptionBuffer(
        this.latestSpeaker,
        "Transcript audio commit failed.",
        false,
      );
    }
    const now = Date.now();
    try {
      live.session.finishAudio();
    } catch {}
    live.role = "draining";
    live.quietAt = live.session.provider === "sarvam" ? this.lastAudioAt + TRANSCRIPTION_PROVIDER_DRAIN_MS : 0;
    live.block = { next: this.sequence, end: this.sequence + TRANSCRIPTION_DRAIN_SEQUENCE_BLOCK };
    this.sequence += TRANSCRIPTION_DRAIN_SEQUENCE_BLOCK;
    for (const line of this.ledger.active()) {
      if (line.epoch !== live.epoch) continue;
      line.audio = [];
    }
    this.providerDrains.set(live.epoch, live);
    this.liveConnection = null;
    this.transcriptionSession = null;
    this.uncommittedAudio.clear();
    this.speakingLine.clear();
    this.settleDrain(live);
    this.armLineTimer();
  }

  /** Lets a drain go once it owes nothing, else wakes it when Sarvam's quiet window ends. */
  private settleDrain(drain: ProviderConnection): void {
    if (this.providerDrains.get(drain.epoch) !== drain) return;
    if (drain.timer !== null) clearTimeout(drain.timer);
    drain.timer = null;
    const owesLines = this.ledger.active().some(({ epoch }) => epoch === drain.epoch);
    const now = Date.now();
    if (!owesLines && now >= drain.quietAt) {
      this.closeDrain(drain);
      return;
    }
    if (!owesLines) {
      drain.timer = setTimeout(() => this.settleDrain(drain), drain.quietAt - now);
    }
  }

  private closeDrain(drain: ProviderConnection): void {
    if (this.providerDrains.get(drain.epoch) !== drain) return;
    this.providerDrains.delete(drain.epoch);
    if (drain.timer !== null) clearTimeout(drain.timer);
    drain.timer = null;
    this.ledger.forgetEnded(drain.epoch);
    try {
      drain.session.close();
    } catch {}
  }

  private closeDrains(): void {
    for (const drain of Array.from(this.providerDrains.values())) this.closeDrain(drain);
  }

  /** A replaced provider failed: every line it owed ends now, in one snapshot write. */
  private async endDrain(drain: ProviderConnection, reason: string): Promise<void> {
    if (this.providerDrains.get(drain.epoch) !== drain) return;
    const owed = this.ledger.active().filter(({ epoch }) => epoch === drain.epoch);
    if (this.endUnfinishedLines(owed, `A replaced provider ${reason}`, drain)) {
      await this.persist();
      this.scheduleMinutes();
    }
    this.closeDrain(drain);
  }

  private nextPlace(connection: ProviderConnection | null): LinePlace {
    const block = connection?.role === "draining" ? connection.block : null;
    const sequence = block && block.next < block.end ? block.next++ : this.sequence++;
    return { sequence, startMs: Date.now() };
  }

  private newLine(
    connection: ProviderConnection | null,
    init: Pick<CaptionLine, "state" | "speaker" | "heard" | "audio">,
  ): CaptionLine {
    const now = Date.now();
    return this.ledger.add({
      ...init,
      place: this.nextPlace(connection),
      epoch: connection?.epoch ?? null,
      deadlineAt: init.state === "replaying" ? Number.POSITIVE_INFINITY : now + TRANSCRIPTION_LINE_DEADLINE_MS,
    });
  }

  /** A line whose connection failed waits for a replacement, keeping its audio and words. */
  private awaitReplacement(line: CaptionLine): void {
    line.state = "replaying";
    line.epoch = null;
    line.deadlineAt = Number.POSITIVE_INFINITY;
  }

  /**
   * Sarvam accepted an utterance: heard in a line's replayed audio, it is
   * that line; otherwise it is a new line in its place, with the speaker
   * of the audio that started it and that speaker's audio from where it
   * began in its turn. Saved at once, so a restart still shows it.
   */
  private acceptLine(
    connection: ProviderConnection,
    providerItemId: string,
    utterance: AcceptedUtterance,
  ): void {
    if (connection.providerToLine.has(providerItemId)) return;
    const replayed = utterance.lineId ? this.ledger.get(utterance.lineId) : undefined;
    const isLive = connection === this.liveConnection;
    let line: CaptionLine;
    if (replayed?.state === "replaying" && replayed.epoch === connection.epoch) {
      line = replayed;
      line.state = "open";
      line.freshText = true;
      line.deadlineAt = Date.now() + TRANSCRIPTION_LINE_DEADLINE_MS;
    } else {
      const speaker = utterance.speaker ?? this.controllerSpeaker();
      line = this.newLine(connection, {
        state: "open",
        speaker,
        heard: utterance.heard,
        audio: isLive ? this.adoptAudio(speaker, utterance.since, utterance.turn) : [],
      });
      if (isLive) line.audio.unshift(...this.takeFromSpeakingLine(speaker, utterance.since, utterance.turn));
    }
    connection.bind(providerItemId, line.id);
    if (utterance.ownsNewAudio && isLive && line !== replayed) {
      this.speakingLine.set(speakerKey(line.speaker), line.id);
    }
    if (line.heard) void this.persist();
    this.armLineTimer();
  }

  /**
   * Our check heard speech for a line after Sarvam signalled it: the line
   * takes that speaker's audio from the signal on, in that turn, so a
   * replay sends it as this line and its end lets that audio go; while the
   * turn goes on, newer audio is the line's too.
   */
  private markLineHeard(connection: ProviderConnection, providerItemId: string, heard: HeardSpeech): void {
    const line = this.ledger.get(connection.providerToLine.get(providerItemId) ?? "");
    if (!line || !isActive(line)) return;
    line.heard = true;
    if (heard.speaker) this.setLineSpeaker(line, heard.speaker);
    if (connection === this.liveConnection && !heard.lineId) {
      const taken = [
        ...this.takeFromSpeakingLine(line.speaker, heard.since, heard.turn),
        ...this.adoptAudio(line.speaker, heard.since, heard.turn),
      ];
      line.audio = [...line.audio, ...taken].sort((left, right) => left.createdAt - right.createdAt);
      line.deadlineAt = Math.max(line.deadlineAt, this.ownAudioDeadline(line));
      if (heard.ownsNewAudio) this.speakingLine.set(speakerKey(line.speaker), line.id);
    }
    void this.persist();
  }

  /**
   * A provider named a line: the line of exactly that commit's audio, by
   * OpenAI's ack order, or the one it already named. A line that ended
   * keeps its place, so its late final fills it under the same itemId; one
   * whose segment was trimmed shows nothing.
   */
  private acknowledgeLine(connection: ProviderConnection, providerItemId: string): CaptionLine | null {
    const known = connection.providerToLine.get(providerItemId);
    if (known) return this.ledger.get(known) ?? null;
    const committed = connection.session.provider === "openai" ? connection.commitQueue.shift() : undefined;
    if (committed !== undefined && connection === this.liveConnection) this.armTranscriptionCommitWatchdog();
    const lineId =
      committed?.lineId ??
      this.newLine(connection, { state: "open", speaker: this.controllerSpeaker(), heard: true, audio: [] }).id;
    connection.bind(providerItemId, lineId);
    const line = this.ledger.get(lineId);
    if (!line) return null;
    if (line.state === "pending_ack" || line.state === "replaying") {
      line.state = "open";
      line.epoch = connection.epoch;
      line.deadlineAt = Math.min(line.deadlineAt, Date.now() + TRANSCRIPTION_LINE_DEADLINE_MS);
    }
    this.armLineTimer();
    return line;
  }

  /**
   * The line a delta, final or failure names. OpenAI names only items it
   * acknowledged, so one it no longer has a line for, such as a trimmed
   * line's late final, shows nothing and never takes another line's commit.
   */
  private namedLine(connection: ProviderConnection, providerItemId: string): CaptionLine | null {
    if (connection.session.provider === "openai" && !connection.providerToLine.has(providerItemId)) return null;
    return this.acknowledgeLine(connection, providerItemId);
  }

  private applyLineDelta(connection: ProviderConnection, providerItemId: string, delta: string): void {
    const line = this.namedLine(connection, providerItemId);
    if (!line || line.state !== "open") return;
    const now = Date.now();
    line.text = line.freshText ? delta : `${line.text}${delta}`;
    line.freshText = false;
    const segment = this.lineSegment(line, now);
    // A replaced provider's words are saved as they arrive, and the output
    // gate holds this delta until a restarted worker would still have them.
    if (connection.role === "draining") void this.persist();
    this.broadcast({
      type: "segment.delta",
      delta: this.toSegmentDelta(segment, delta, now),
    });
  }

  /** A final ends its line with its words, or fills the gap a late final was owed. */
  private async applyLineFinal(
    connection: ProviderConnection,
    providerItemId: string,
    transcript: string,
  ): Promise<void> {
    const line = this.namedLine(connection, providerItemId);
    if (!line) return;
    const words = transcript.trim();
    let changed = false;
    if (isActive(line)) {
      const text = words || line.text.trim();
      this.forgetSpeakingLine(line);
      this.ledger.end(line, text ? "final" : "dropped", text);
      changed = text ? this.recordFinalSegment(this.lineSegment(line), text) : true;
    } else if (words && words !== line.text) {
      this.ledger.end(line, "final", words);
      changed = this.recordFinalSegment(this.lineSegment(line), words);
    }
    if (connection.role === "draining") this.settleDrain(connection);
    if (!changed) return;
    await this.persist();
    this.scheduleMinutes();
  }

  /** One item a provider could not transcribe: only that line ends, as its words or a gap. */
  private async applyLineFailure(connection: ProviderConnection, providerItemId: string): Promise<void> {
    const line = this.namedLine(connection, providerItemId);
    if (!line || !isActive(line)) return;
    const changed = this.endUnfinishedLines([line], "A provider failed one line", connection);
    if (connection.role === "draining") this.settleDrain(connection);
    if (changed) {
      await this.persist();
      this.scheduleMinutes();
    }
  }

  /**
   * Ends lines their provider will not finish: words already on screen stay
   * as the line, a line our side heard speech in becomes a gap, and one it
   * never heard ends with nothing shown. True when the transcript changed.
   */
  private endUnfinishedLines(
    lines: CaptionLine[],
    context: string,
    connection: ProviderConnection | null,
  ): boolean {
    let changed = false;
    let gaps = 0;
    for (const line of lines) {
      if (!isActive(line)) continue;
      this.forgetSpeakingLine(line);
      for (const providerItemId of connection?.providerIdsOf(line.id) ?? []) {
        connection?.session.retire?.(providerItemId);
      }
      const words = line.text.trim();
      if (words) {
        this.ledger.end(line, "final", words);
        changed = this.recordFinalSegment(this.lineSegment(line), words) || changed;
      } else if (line.heard) {
        this.ledger.end(line, "gap", TRANSCRIPTION_GAP_MARKER);
        changed = this.recordFinalSegment(this.lineSegment(line), TRANSCRIPTION_GAP_MARKER) || changed;
        gaps += 1;
      } else {
        this.ledger.end(line, "dropped", "");
        changed = true;
      }
    }
    if (gaps > 0) {
      console.warn(
        `[Transcript] ${context} with ${gaps} line(s) heard but not captioned; recorded a gap.`,
        JSON.stringify({ provider: connection?.session.provider ?? "none" }),
      );
    }
    return changed;
  }

  private forgetSpeakingLine(line: CaptionLine): void {
    for (const [key, id] of this.speakingLine) {
      if (id === line.id) this.speakingLine.delete(key);
    }
  }

  /** One timer for every owed line's deadline, live or draining. */
  private armLineTimer(): void {
    if (this.lineTimer !== null) clearTimeout(this.lineTimer);
    this.lineTimer = null;
    const deadlines = this.ledger
      .active()
      .map(({ deadlineAt }) => deadlineAt)
      .filter(Number.isFinite);
    if (deadlines.length === 0) return;
    this.lineTimer = setTimeout(() => {
      this.lineTimer = null;
      void this.endOverdueLines();
    }, Math.max(0, Math.min(...deadlines) - Date.now()));
  }

  private async endOverdueLines(): Promise<void> {
    const now = Date.now();
    let changed = false;
    for (const connection of [this.liveConnection, ...this.providerDrains.values(), null]) {
      const owed = this.ledger
        .active()
        .filter((line) => line.deadlineAt <= now && line.epoch === (connection?.epoch ?? null));
      changed =
        this.endUnfinishedLines(owed, "A provider did not finish in time", connection) || changed;
    }
    for (const drain of Array.from(this.providerDrains.values())) this.settleDrain(drain);
    this.armLineTimer();
    if (changed) {
      await this.persist();
      this.scheduleMinutes();
    }
  }

  private resetTranscriptionAudioState(): void {
    this.lastAudioAt = 0;
    this.latestSpeaker = null;
    this.hasPendingAudio = false;
    this.pendingAudioSamples = 0;
    this.uncommittedAudio.clear();
    this.speakingLine.clear();
    this.voiceChecks.clear();
    if (this.transcriptionCommitWatchdogTimer !== null) {
      clearTimeout(this.transcriptionCommitWatchdogTimer);
      this.transcriptionCommitWatchdogTimer = null;
    }
  }

  private armTranscriptionCommitWatchdog(): void {
    if (this.transcriptionCommitWatchdogTimer !== null) {
      clearTimeout(this.transcriptionCommitWatchdogTimer);
      this.transcriptionCommitWatchdogTimer = null;
    }
    const oldest = this.liveConnection?.commitQueue[0];
    if (!oldest) return;
    const delay = Math.max(
      0,
      oldest.committedAt + TRANSCRIPTION_COMMIT_ACK_TIMEOUT_MS - Date.now(),
    );
    this.transcriptionCommitWatchdogTimer = setTimeout(() => {
      this.transcriptionCommitWatchdogTimer = null;
      const current = this.liveConnection?.commitQueue[0];
      if (!current) return;
      if (current.committedAt + TRANSCRIPTION_COMMIT_ACK_TIMEOUT_MS > Date.now()) {
        this.armTranscriptionCommitWatchdog();
        return;
      }
      void this.handleTranscriptionFailure(
        "Transcription provider acknowledgment timed out.",
      );
    }, delay);
  }

  /**
   * A live connection failed: every line it owed waits for a replacement
   * with its own audio and words, and speech no line owns yet that our check
   * heard becomes a line of its own. Words stay on screen meanwhile.
   */
  private handOffLiveLines(live: ProviderConnection): void {
    for (const line of this.ledger.active()) {
      if (line.epoch === live.epoch) this.awaitReplacement(line);
    }
    for (const { speaker, chunks } of this.uncommittedAudio.values()) {
      if (!chunks.some(({ voice }) => voice !== "quiet")) continue;
      this.awaitReplacement(this.newLine(null, { state: "replaying", speaker, heard: true, audio: chunks }));
    }
    this.uncommittedAudio.clear();
    this.speakingLine.clear();
    this.ledger.forgetEnded(live.epoch);
  }

  /**
   * Sends a replacement every owed line's own audio, in place order: OpenAI
   * gets it as one commit per line, queued for that line's ack; Sarvam gets
   * it as one turn per line, each chunk naming its line. False when a send
   * fails, after putting every line back to wait for the next replacement.
   */
  private replayOwedLines(connection: ProviderConnection): boolean {
    const owed = this.ledger.active().filter(({ state, epoch }) => state === "replaying" && epoch === null);
    try {
      for (const line of owed) {
        line.epoch = connection.epoch;
        if (line.audio.length === 0) continue;
        if (connection.session.provider === "openai") {
          const samples = line.audio.reduce((sum, chunk) => sum + chunk.sampleCount, 0);
          for (const chunk of line.audio) connection.session.appendAudio(chunk.audio);
          if (samples < MIN_OPENAI_COMMIT_AUDIO_SAMPLES) {
            connection.session.appendAudio(createSilentPcm16Base64(MIN_OPENAI_COMMIT_AUDIO_SAMPLES - samples));
          }
          connection.session.commitAudio();
          line.state = "pending_ack";
          line.freshText = true;
          connection.commitQueue.push({ lineId: line.id, committedAt: Date.now() });
        } else {
          for (const chunk of line.audio) {
            connection.session.appendAudio(chunk.audio, line.speaker, {
              voice: chunk.voice,
              turn: chunk.turn,
              lineId: line.id,
            });
          }
          connection.session.clearAudio();
        }
      }
    } catch {
      return false;
    }
    return true;
  }

  private owedLineIds(): Set<string> {
    return new Set(
      this.ledger
        .active()
        .filter(({ state, epoch }) => state === "replaying" && epoch === null)
        .map(({ id }) => id),
    );
  }

  /**
   * A replacement that failed gives back every owed line it was given, in
   * one pass; lines it started from buffered audio go, since that audio is
   * queued again for the next replacement.
   */
  private abandonReplacement(connection: ProviderConnection, owed: ReadonlySet<string>): void {
    for (const line of this.ledger.active()) {
      if (line.epoch !== connection.epoch) continue;
      if (owed.has(line.id)) this.awaitReplacement(line);
      else this.ledger.remove(line.id);
    }
    connection.commitQueue.length = 0;
    connection.providerToLine.clear();
    if (this.liveConnection === connection) {
      this.liveConnection = null;
      this.transcriptionSession = null;
    }
    this.transcriptionConnectionEpoch += 1;
    try {
      connection.session.close();
    } catch {}
    this.resetTranscriptionAudioState();
  }

  /** Once a replacement has every owed line's audio, a line it never takes ends at a deadline. */
  private settleReplayedLines(connection: ProviderConnection): void {
    const deadline = Date.now() + TRANSCRIPTION_LINE_DEADLINE_MS;
    for (const line of this.ledger.active()) {
      if (line.epoch === connection.epoch && line.deadlineAt > deadline) line.deadlineAt = deadline;
    }
    this.armTranscriptionCommitWatchdog();
    this.armLineTimer();
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

    const failed = this.liveConnection;
    this.liveConnection = null;
    this.transcriptionSession = null;
    this.transcriptionConnectionEpoch += 1;
    if (failed) {
      this.handOffLiveLines(failed);
      failed.commitQueue.length = 0;
      try {
        failed.session.close();
      } catch {}
    }
    this.resetTranscriptionAudioState();
    this.transcriptionRecoveryAudio.enqueueMany(failedEvents);

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

      let replacement: ProviderConnection | null = null;
      let owed: ReadonlySet<string> = new Set();
      let bufferedEvents: BufferedTranscriptAudioEvent[] = [];
      try {
        replacement = await this.openTranscriptionProvider(options);
        if (generation !== this.transcriptionRecoveryGeneration) {
          replacement.session.close();
          return;
        }
        this.useLiveConnection(replacement);
        owed = this.owedLineIds();
        if (!this.replayOwedLines(replacement)) {
          throw new Error("Owed caption audio replay connection failed.");
        }
        bufferedEvents = this.transcriptionRecoveryAudio.drain();
        if (!this.replayBufferedTranscriptionAudio(bufferedEvents, false)) {
          throw new Error(
            "Buffered transcript audio replay connection failed.",
          );
        }
        this.settleReplayedLines(replacement);
      } catch (error) {
        if (replacement && this.liveConnection === replacement) {
          this.pendingTranscriptionRecoveryFailure = null;
          this.abandonReplacement(replacement, owed);
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
          },
        );
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
        provider: replacement.session.provider,
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
          this.endAudioTurn();
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

  private controllerSpeaker(): TranscriptSpeaker {
    return normalizeSpeaker(undefined, {
      userId: this.session?.controller?.userId || "unknown",
      displayName: this.session?.controller?.displayName || "Unknown",
    });
  }

  private createSegment(
    itemId: string,
    speaker: TranscriptSpeaker,
    placement?: { sequence: number; startMs: number },
  ): TranscriptSegment {
    const now = Date.now();
    const segment: TranscriptSegment = {
      id: itemId,
      itemId,
      sequence: placement?.sequence ?? this.sequence++,
      speakerUserId: speaker.userId,
      speakerDisplayName: speaker.displayName,
      source: speaker.source,
      text: "",
      startMs: placement?.startMs ?? now,
      endMs: null,
      isFinal: false,
      updatedAt: now,
    };
    return segment;
  }

  /** Stopping notes: every connection closes and nothing a line held stays. */
  private forgetAllLines(): void {
    this.switchingProvider = false;
    this.closeTranscriptionProvider(false);
    this.closeDrains();
    this.ledger.clear();
    if (this.lineTimer !== null) clearTimeout(this.lineTimer);
    this.lineTimer = null;
  }

  /** Nothing will finish the owed lines: each ends as its words, a gap if heard, or nothing, and replaced providers close. */
  private endEveryOwedLine(context: string): void {
    for (const connection of [this.liveConnection, ...this.providerDrains.values(), null]) {
      const owed = this.ledger.active().filter(({ epoch }) => epoch === (connection?.epoch ?? null));
      this.endUnfinishedLines(owed, context, connection);
    }
    this.closeDrains();
    this.armLineTimer();
  }

  /**
   * Finals plus every line still owed, saved as finals: its words so far, or
   * a gap while it has none but was heard. A restarted or rolled-back worker
   * cannot resume a provider connection, so this is how those lines end
   * there, in a form older workers read too.
   */
  private segmentsForSnapshot(): TranscriptSegment[] {
    const owed = this.ledger.active().flatMap((line) => {
      const words = line.text.trim();
      if (!words && !line.heard) return [];
      const segment = this.lineSegment(line);
      return [{
        ...segment,
        text: words ? line.text : TRANSCRIPTION_GAP_MARKER,
        isFinal: true,
        endMs: segment.updatedAt,
      }];
    });
    if (owed.length === 0) return this.segments;
    return [...this.segments, ...owed].sort(
      (left, right) => left.sequence - right.sequence,
    );
  }

  /** Words of every owed line, live, draining or waiting for a replacement. */
  private visiblePartials(): TranscriptSegment[] {
    return this.ledger.active().flatMap((line) => (line.text ? [this.lineSegment(line)] : []));
  }

  /** A line as viewers see it, under its own itemId in its own place. */
  private lineSegment(line: CaptionLine, now = Date.now()): TranscriptSegment {
    return {
      ...this.createSegment(line.id, line.speaker, line.place),
      text: line.text,
      updatedAt: now,
    };
  }

  /** A line's speaker is the speaker of its own audio; its words and any final follow it. */
  private setLineSpeaker(line: CaptionLine, speaker: TranscriptSpeaker): void {
    if (
      line.speaker.userId === speaker.userId &&
      line.speaker.displayName === speaker.displayName &&
      line.speaker.source === speaker.source
    ) {
      return;
    }
    line.speaker = speaker;
    const now = Date.now();
    if (isActive(line) && line.text) {
      this.broadcast({
        type: "segment.delta",
        delta: this.toSegmentDelta(this.lineSegment(line, now), "", now),
      });
    }
    const finalIndex = this.segments.findIndex(({ itemId }) => itemId === line.id);
    const finalSegment = finalIndex >= 0 ? this.segments[finalIndex] : undefined;
    if (!finalSegment || this.hasSegmentSpeaker(finalSegment, speaker)) return;
    const nextFinal: TranscriptSegment = {
      ...finalSegment,
      speakerUserId: speaker.userId,
      speakerDisplayName: speaker.displayName,
      source: speaker.source,
      updatedAt: now,
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

  /** Puts a final in its place and shows it; false when nothing changed. */
  private recordFinalSegment(
    segment: TranscriptSegment,
    transcript: string,
  ): boolean {
    const text = transcript.trim() || segment.text.trim();
    if (!text) return false;
    const existingIndex = this.segments.findIndex(
      (candidate) => candidate.itemId === segment.itemId,
    );
    const existing = existingIndex >= 0 ? this.segments[existingIndex] : null;
    // A repeated final changes nothing; a corrected one keeps its place.
    if (existing?.text === text) return false;

    const now = Date.now();
    const finalSegment: TranscriptSegment = {
      ...(existing ?? segment),
      text,
      endMs: now,
      isFinal: true,
      updatedAt: now,
    };
    if (existingIndex >= 0) {
      this.segments[existingIndex] = finalSegment;
    } else {
      this.segments.push(finalSegment);
    }
    this.segments.sort((left, right) => left.sequence - right.sequence);
    this.trimSegments();
    this.broadcast({ type: "segment.final", segment: finalSegment });
    return true;
  }

  private trimSegments(): void {
    const maxSegments = parsePositiveInt(
      this.env.TRANSCRIPT_MAX_SEGMENTS,
      DEFAULT_MAX_SEGMENTS,
    );
    if (this.segments.length <= maxSegments) return;
    this.segments.splice(0, this.segments.length - maxSegments);
    const kept = new Set(this.segments.map(({ itemId }) => itemId));
    this.ledger.forgetEndedExcept(kept);
    for (const connection of [this.liveConnection, ...this.providerDrains.values()]) {
      connection?.forgetLinesExcept((lineId) => this.ledger.get(lineId) !== undefined);
    }
  }

  private markTakeoverNeeded(error: string): void {
    this.sessionRevision += 1;
    this.cancelControllerReconnect();
    this.cancelSfuRelayRecovery();
    this.endEveryOwedLine("Transcription stopped for a takeover");
    this.switchingProvider = false;
    this.closeTranscriptionProvider(false);
    this.responseApiKey = null;
    this.responseAbort.abort();
    this.responseAbort = new AbortController();
    this.responseEnvironment = null;
    this.responseRoute = null;
    this.personalResponseKeys = {};
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

  private resetMinutesScheduler(preserveMinutes = false): void {
    if (this.minutesTimer !== null) {
      clearTimeout(this.minutesTimer);
      this.minutesTimer = null;
    }
    this.minutesDirtySince = 0;
    this.minutesGenerating = false;
    this.minutesRerunRequested = false;
    if (!preserveMinutes) this.hasAiMinutes = false;
    this.minutesStatus = "idle";
  }

  private scheduleMinutes(): void {
    if (!this.session || this.segments.length === 0) return;
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

  private async forceRefreshMinutes(): Promise<void> {
    if (this.minutesTimer !== null) {
      clearTimeout(this.minutesTimer);
      this.minutesTimer = null;
    }
    this.minutesDirtySince = this.minutesDirtySince || Date.now();
    await this.regenerateMinutes();
  }

  private async responseProfile(feature: "minutes" | "questions", viewer?: Viewer, requestedModel?: string) {
    let env: Env = this.responseEnvironment ?? this.env;
    const route = viewer?.sfuUrl && viewer.clientId && viewer.channelId ? {sfuUrl: viewer.sfuUrl, identity: {userId: viewer.userId, roomId: this.session!.roomId, clientId: viewer.clientId, channelId: viewer.channelId}} : this.responseRoute;
    if (route) {
      const room = await fetchRoomAiEnvironment({...route, secret: this.env.TRANSCRIPT_TOKEN_SECRET, providers: ["openai", "anthropic", "sarvam"]});
      env = {...this.env, ...roomAiEnvironment(this.env, room)};
    }
    const features = roomAiFeatureSettingsFromEnvironment(env);
    const separateTextProfiles = Boolean(features.minutes || features.questions);
    const settings = resolveAiFeatureSettings(feature === "minutes" && separateTextProfiles ? env : {...env, CONCLAVE_ASSISTANT_MODEL: requestedModel || this.session?.qaModel}, feature);
    const provider = getResponseProvider(settings.model);
    const apiKey = this.personalResponseKeys[provider] || getProviderApiKey(env, provider) || (!route && provider === getResponseProvider(this.session?.qaModel || DEFAULT_QA_MODEL) ? this.responseApiKey : "");
    if (settings.enabled && !apiKey) throw new Error("Add a key for this feature in Room AI settings.");
    return {env, model: settings.model, apiKey: apiKey || "", enabled: settings.enabled};
  }

  private async regenerateMinutes(): Promise<void> {
    if (this.segments.length === 0 || !this.session) {
      this.minutesDirtySince = 0;
      this.setMinutesStatus("idle");
      return;
    }
    if (this.minutesGenerating) {
      this.minutesRerunRequested = true;
      return;
    }
    const revision = this.sessionRevision;
    const signal = this.responseAbort.signal;
    let disabled = false;
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
      const profile = await this.responseProfile("minutes");
      if (signal.aborted || revision !== this.sessionRevision) return;
      if (!profile.enabled) { disabled = true; return; }
      const minutes = await generateMinutes({
        signal,
        env: profile.env,
        apiKey: profile.apiKey,
        model: profile.model,
        transcript,
        current: this.minutes,
        fallback: this.hasMinutesContent(this.minutes) ? this.minutes : fallback,
      });
      if (signal.aborted || revision !== this.sessionRevision) return;
      if (minutes) {
        minutes.model = profile.model;
        const compactionDue =
          minutesNeedCompaction(minutes) ||
          Date.now() - this.lastMinutesCompactionAt >=
            MINUTES_COMPACTION_INTERVAL_MS;
        if (compactionDue) {
          try {
            const compacted = await compactMinutes({
              signal,
              env: profile.env,
              apiKey: profile.apiKey,
              model: profile.model,
              current: minutes,
            });
            if (signal.aborted || revision !== this.sessionRevision) return;
            this.minutes = compacted;
          } catch (error) {
            if (signal.aborted || revision !== this.sessionRevision) return;
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
      if (signal.aborted || revision !== this.sessionRevision) return;
      if (
        !this.hasAiMinutes &&
        !this.hasMinutesContent(this.minutes) &&
        this.hasEnoughContentForMinutes()
      ) {
        this.minutes = fallback;
        this.broadcast({ type: "minutes.updated", minutes: this.minutes });
      }
    } finally {
      if (revision === this.sessionRevision) {
        this.minutesGenerating = false;
        this.setMinutesStatus(disabled ? "idle" : "live");
        if (this.minutesRerunRequested) {
          this.minutesRerunRequested = false;
          this.scheduleMinutes();
        }
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
    if (!this.session) {
      this.sendError(viewer, "Transcript AI is waiting for a controller key.");
      return;
    }
    const question = trimText(message.question || "", 800);
    if (!question) return;

    const revision = this.sessionRevision;
    const signal = this.responseAbort.signal;
    const id = message.id || crypto.randomUUID();
    this.send(viewer.socket, {
      type: "qa.delta",
      id,
      question,
      delta: "",
      answer: "",
      status: "streaming",
    });

    try {
      const profile = await this.responseProfile("questions", viewer, message.model);
      if (signal.aborted || revision !== this.sessionRevision || !this.viewers.has(viewer.socket)) return;
      if (!profile.enabled) throw new Error("Transcript questions are disabled in Room AI settings.");
      let answer = "";
      for await (const delta of streamQuestionAnswer({
        signal,
        env: profile.env,
        apiKey: profile.apiKey,
        model: profile.model,
        question,
        segments: [...this.segments, ...this.visiblePartials()],
      })) {
        if (signal.aborted || revision !== this.sessionRevision) return;
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
      if (signal.aborted || revision !== this.sessionRevision || !this.viewers.has(viewer.socket)) return;
      this.send(viewer.socket, {
        type: "qa.final",
        id,
        question,
        answer: answer.trim() || "I could not find that in the transcript yet.",
        status: "done",
      });
    } catch (error) {
      if (signal.aborted || revision !== this.sessionRevision || !this.viewers.has(viewer.socket)) return;
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
          languageChosen: this.transcriptionConnectionOptions.languageChosen,
          delay: this.transcriptionConnectionOptions.delay,
          locale: this.transcriptionConnectionOptions.locale,
        }
      : undefined;
    await this.state.storage.put("snapshot", {
      session: this.session,
      segments: this.segmentsForSnapshot(),
      minutes: this.minutes,
      minutesCompactedAt: this.lastMinutesCompactionAt,
      sequence: this.sequence,
      serviceVersion: this.serviceVersion(),
      transcriptionConfig,
      providerLanguage: this.sessionProviderLanguage,
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

  private resetInMemorySession(
    roomId: string,
    qaModel = DEFAULT_QA_MODEL,
  ): void {
    this.sessionRevision += 1;
    this.cancelControllerReconnect();
    this.cancelSfuRelayRecovery();
    this.forgetAllLines();
    this.responseApiKey = null;
    this.responseAbort.abort();
    this.responseAbort = new AbortController();
    this.responseEnvironment = null;
    this.responseRoute = null;
    this.personalResponseKeys = {};
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
