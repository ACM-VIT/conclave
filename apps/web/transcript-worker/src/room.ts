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
  TRANSCRIPTION_DRAIN_SEQUENCE_BLOCK,
  TRANSCRIPTION_GAP_MARKER,
  TRANSCRIPTION_LINE_DEADLINE_MS,
  TRANSCRIPTION_PROVIDER_DRAIN_MS,
  TRANSCRIPTION_RECOVERY_MAX_AUDIO_BYTES,
  UNOWNED_AUDIO_KEPT_MS,
  SARVAM_MAX_LANES,
  TRANSCRIPT_PERSIST_RETRY_MS,
  TRANSCRIPT_PERSIST_RETRY_MAX_MS,
  TRANSCRIPTION_ENDED_LINE_KEPT_MS,
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
  isPlaced,
  type CaptionLine,
  type LinePlace,
  type ShownLine,
} from "./caption-ledger";
import {
  AudioStore,
  lastHeardSentAt,
  runHeard,
  runsOf,
  type AudioRun,
  type HeldChunk,
  type QueuedEvent,
  type QueuedMarker,
} from "./audio-store";
import { VoiceActivity } from "./transcription/voice-activity";
import { SocketBudget } from "./transcription/socket-budget";
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
import { AudioNotSent, type AcceptedUtterance, type HeardSpeech, type SpeechPlace } from "./transcription/types";
import {
  isRetryableTranscriptionFailure,
  transcriptionRecoveryDelayMs,
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
  parsePcm16Base64,
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
  private readonly ledger = new CaptionLedger({
    maxEnded: () => this.maxSegments(),
    endedKeptMs: TRANSCRIPTION_ENDED_LINE_KEPT_MS,
    shown: () => new Set(this.segments.map(({ itemId }) => itemId)),
    onForget: (lineIds) => {
      const forgotten = new Set(lineIds);
      for (const connection of [this.liveConnection, ...this.providerDrains.values()]) {
        connection?.forgetLinesExcept((lineId) => !forgotten.has(lineId));
      }
    },
    onRelease: (lineId) => this.audio.releaseOwner(lineId),
  });
  private readonly audio = new AudioStore();
  private readonly sarvamSockets = new SocketBudget(SARVAM_MAX_LANES);
  private droppedAudioChunks = 0;
  private liveConnection: ProviderConnection | null = null;
  private audioSequence = 0;
  private readonly voiceChecks = new Map<string, VoiceActivity>();
  private lastProvider: LiveTranscriptionSession["provider"] | null = null;
  private readonly speakerTurns = new Map<string, { speaker: TranscriptSpeaker; turn: number }>();
  private lineTimer: ReturnType<typeof setTimeout> | null = null;
  private switchingProvider = false;
  private persistRetryTimer: ReturnType<typeof setTimeout> | null = null;
  private persistFailures = 0;
  private latestSpeaker: TranscriptSpeaker | null = null;
  private lastAudioAt = 0;
  private hasPendingAudio = false;
  private pendingPlace: SpeechPlace | null = null;
  private pendingAudioSamples = 0;
  private session: TranscriptSessionState | null = null;
  private sessionRevision = 0;
  private segments: TranscriptSegment[] = [];
  private minutes: TranscriptMinutesSnapshot = createEmptyMinutes();
  private sequence = 0;
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
  private transcriptionOpenController: AbortController | null = null;
  private transcriptionRecoveryPromise: Promise<void> | null = null;
  private pendingTranscriptionRecoveryFailure: string | null = null;
  private transcriptionCommitWatchdogTimer: ReturnType<typeof setTimeout> | null =
    null;
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
    this.send(server, this.snapshotMessage(viewer));
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

  private savedTranscription(snapshot: PersistedSnapshot) {
    const provider = getTranscriptTranscriptionProvider(
      normalizeRealtimeTranscriptModel(snapshot.session.transcriptModel, DEFAULT_TRANSCRIPT_MODEL),
    );
    const savedConfig = snapshot.transcriptionConfig;
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
    this.audioPaused = wasPaused;
    try {
      await this.connectTranscriptionProvider({
        apiKey: transcriptionKey.apiKey,
        transcriptModel,
        ...config,
        providerLanguage,
        localizationPrompt: this.env.TRANSCRIPT_TRANSCRIPTION_PROMPT,
      });
      if (revision !== this.sessionRevision) return;
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
          if (revision !== this.sessionRevision) return;
        }
      }
      await this.persist();
    } catch (error) {
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
      this.sendError(
        viewer,
        "Transcript message rate limit exceeded.",
        normalizeRequestId((message as { requestId?: unknown }).requestId),
      );
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
        this.send(viewer.socket, this.snapshotMessage(viewer));
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
      this.persistInBackground();
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
      this.persistInBackground();
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
    if (!wasIdle) this.switchingProvider = true;
    this.supersedeTranscriptionRecovery();
    if (wasIdle) this.resetTranscriptionAudioState();
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
    if (!(await this.persistForRevision(acceptedRevision))) return;

    const connectOptions = {
      apiKey: transcriptionKey.apiKey,
      transcriptModel,
      language,
      languageChosen,
      providerLanguage,
      delay: normalizeDelay(message.delay),
      locale,
      localizationPrompt: this.env.TRANSCRIPT_TRANSCRIPTION_PROMPT,
    };
    try {
      if (wasIdle) {
        await this.connectTranscriptionProvider(connectOptions);
      } else if (!(await this.switchTranscriptionProvider(connectOptions, acceptedRevision))) {
        return;
      }
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
      if (acceptedRevision !== this.sessionRevision) return;
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
    this.cancelPersistRetry();
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
      this.flushToLive();
      this.endRelayTurn(this.latestSpeaker ?? normalizeSpeaker(undefined, viewer), "Transcript audio commit failed.");
      this.audioPaused = true;
    } else {
      this.audioPaused = false;
    }
    this.voiceChecks.clear();
    this.session = {
      ...this.session,
      status: paused ? "paused" : "live",
      updatedAt: Date.now(),
      error: null,
    };
    this.broadcastSession();
    if (!paused) this.flushToLive();
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
    const pcm = parsePcm16Base64(audio);
    if (!pcm) {
      this.sendError(viewer, "Transcript audio chunk is not valid PCM audio.");
      return;
    }
    if (pcm.length <= 0) return;
    const normalizedSpeaker = normalizeSpeaker(speaker, viewer);
    const createdAt = Date.now();
    const chunk: HeldChunk = {
      audio,
      sampleCount: pcm.length,
      speaker: normalizedSpeaker,
      sequence: this.audioSequence++,
      order: this.sequence++,
      createdAt,
      voice: this.voiceCheckFor(speakerKey(normalizedSpeaker)).push(pcm, createdAt),
      turn: this.turnFor(normalizedSpeaker),
      sentAt: null,
      owner: { kind: "queued" },
      savedUnsent: false,
    };
    if (!this.transcriptionSession && !this.shouldBufferTranscriptionAudio()) return;
    this.audio.add(chunk);
    this.flushToLive();
    if (chunk.owner.kind !== "queued" && this.isController(viewer) && this.session?.controller) {
      this.session.controller.lastSeenAt = Date.now();
    }
    this.saveFirstHeardRun(chunk);
    this.enforceAudioBudget();
  }

  private sendChunk(chunk: HeldChunk): "sent" | "wait" | "failed" {
    const session = this.transcriptionSession;
    const live = this.liveConnection;
    if (!session || !live || this.audioPaused) return "failed";
    if (session.withholds?.(chunk.speaker, chunk.voice, chunk.createdAt)) {
      chunk.sentAt = Date.now();
      chunk.owner = { kind: "unowned" };
      return "sent";
    }
    if (session.ready && !session.ready(chunk.speaker)) return "wait";
    if (
      this.hasPendingAudio &&
      this.latestSpeaker &&
      !isSameTranscriptAudioSpeaker(this.latestSpeaker, chunk.speaker) &&
      !this.commitTranscriptionBuffer(this.latestSpeaker, "Transcript speaker handoff failed.", false)
    ) {
      return "failed";
    }
    const sentAt = Date.now();
    chunk.sentAt = sentAt;
    chunk.owner = { kind: "unowned" };
    let ownerItem: string | null;
    try {
      ownerItem = session.appendAudio(chunk.audio, chunk.speaker, {
        voice: chunk.voice,
        turn: chunk.turn,
        at: sentAt,
        sequence: chunk.sequence,
        order: chunk.order,
        createdAt: chunk.createdAt,
      });
    } catch (error) {
      chunk.sentAt = null;
      chunk.owner = { kind: "queued" };
      return error instanceof AudioNotSent ? "wait" : "failed";
    }
    const owner = ownerItem ? this.ledger.get(live.lineOf(ownerItem) ?? "") : undefined;
    if (owner?.state === "open") {
      chunk.owner = { kind: "line", lineId: owner.id };
      owner.deadlineAt = Math.max(owner.deadlineAt, sentAt + TRANSCRIPTION_LINE_DEADLINE_MS);
    }
    if (session.provider === "sarvam") this.forgetStaleUnownedAudio(sentAt);
    this.latestSpeaker = chunk.speaker;
    this.lastAudioAt = sentAt;
    if (!this.hasPendingAudio) this.pendingPlace = { order: chunk.order, startMs: chunk.createdAt };
    this.hasPendingAudio = true;
    this.pendingAudioSamples += chunk.sampleCount;
    return "sent";
  }

  private forgetStaleUnownedAudio(now: number): void {
    const stale = runsOf(this.audio.unowned(), true).filter((run) => {
      const lastSentAt = runHeard(run)
        ? lastHeardSentAt(run)
        : (run.chunks.at(-1)?.sentAt ?? Number.NEGATIVE_INFINITY);
      return now - lastSentAt > UNOWNED_AUDIO_KEPT_MS;
    });
    if (stale.length > 0) this.audio.remove(stale.flatMap(({ chunks }) => chunks));
  }

  private saveFirstHeardRun(chunk: HeldChunk): void {
    if (chunk.voice === "quiet" || chunk.owner.kind === "line") return;
    const before = this.audio.all().find(({ sequence }) => sequence === chunk.sequence - 1);
    const continues =
      before !== undefined &&
      before.voice !== "quiet" &&
      before.owner.kind !== "line" &&
      before.turn === chunk.turn &&
      speakerKey(before.speaker) === speakerKey(chunk.speaker);
    if (!continues) this.persistInBackground();
  }

  private enforceAudioBudget(): void {
    const evicted = this.audio.enforceBudget(TRANSCRIPTION_RECOVERY_MAX_AUDIO_BYTES);
    if (evicted.length === 0) return;
    this.droppedAudioChunks += evicted.length;
    const emptied = new Set<string>();
    for (const { owner } of evicted) {
      if (owner.kind === "line") emptied.add(owner.lineId);
    }
    const ended = Array.from(emptied).flatMap((lineId) => {
      const line = this.ledger.get(lineId);
      return line?.state === "replaying" && !this.audio.owns(lineId) ? [line] : [];
    });
    if (this.endUnfinishedLines(ended, "The audio limit dropped every chunk a waiting line had", null)) {
      this.persistInBackground();
      this.scheduleMinutes();
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

  private claimAudio(connection: ProviderConnection, line: CaptionLine, speech: HeardSpeech): HeldChunk[] {
    if (connection !== this.liveConnection || !line.speaker) return [];
    const key = speakerKey(line.speaker);
    const fromLine = speech.fromItem ? connection.lineOf(speech.fromItem) : undefined;
    const until = speech.untilSequence ?? Number.POSITIVE_INFINITY;
    const claimed = this.audio
      .all()
      .filter(
        (chunk) =>
          chunk.sequence >= speech.fromSequence &&
          chunk.sequence < until &&
          (speech.turn === undefined || chunk.turn === speech.turn) &&
          speakerKey(chunk.speaker) === key &&
          (chunk.owner.kind === "unowned" ||
            (fromLine !== undefined && chunk.owner.kind === "line" && chunk.owner.lineId === fromLine)),
      );
    this.audio.setOwner(claimed, { kind: "line", lineId: line.id });
    const older = fromLine ? this.ledger.get(fromLine) : undefined;
    if (older && isActive(older) && claimed.length > 0) older.deadlineAt = this.ownAudioDeadline(older);
    return claimed;
  }

  private ownAudioDeadline(line: CaptionLine): number {
    const lastAudioAt = this.audio
      .ownedBy(line.id)
      .reduce((latest, { sentAt, createdAt }) => Math.max(latest, sentAt ?? createdAt), line.place?.startMs ?? Date.now());
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
    this.audio.queueMarker({
      type: "commit",
      speaker: normalizeSpeaker(speaker, this.latestSpeaker ?? viewer),
      after: this.audioSequence,
    });
    this.enforceAudioBudget();
    this.flushToLive();
  }

  private commitTranscriptionBuffer(
    speaker: TranscriptSpeaker,
    failureMessage: string,
    reportFailure = true,
  ): boolean {
    const live = this.liveConnection;
    const session = this.transcriptionSession;
    if (!session || !live || !this.hasPendingAudio || this.audioPaused) return false;
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
    const audio = this.audio.unowned();
    const line = this.ledger.add({
      state: "pending_ack",
      speaker,
      heard: audio.some(({ voice }) => voice !== "quiet"),
      place: this.placeFor(live, audio, this.pendingPlace ?? undefined),
      epoch: live.epoch,
      deadlineAt: Number.POSITIVE_INFINITY,
    });
    this.audio.setOwner(audio, { kind: "line", lineId: line.id });
    live.commitQueue.push({ lineId: line.id, committedAt: Date.now() });
    this.armTranscriptionCommitWatchdog();
    this.armLineTimer();
    if (line.heard) this.persistInBackground();
    return true;
  }

  private clearAudio(viewer: Viewer, speaker: Partial<TranscriptSpeaker> | undefined): void {
    if (this.audioPaused || !this.canRelayAudio(viewer)) return;
    if (!this.transcriptionSession && !this.shouldBufferTranscriptionAudio()) return;
    this.audio.queueMarker({
      type: "clear",
      speaker: normalizeSpeaker(speaker, this.latestSpeaker ?? viewer),
      after: this.audioSequence,
    });
    this.enforceAudioBudget();
    this.endTurnOf(normalizeSpeaker(speaker, this.latestSpeaker ?? viewer));
    this.flushToLive();
  }

  private turnFor(speaker: TranscriptSpeaker): number {
    const key = speakerKey(speaker);
    const known = this.speakerTurns.get(key);
    if (known) return known.turn;
    this.speakerTurns.set(key, { speaker, turn: 0 });
    return 0;
  }

  private endTurnOf(speaker: TranscriptSpeaker): void {
    this.speakerTurns.set(speakerKey(speaker), { speaker, turn: this.turnFor(speaker) + 1 });
  }

  private endRelayTurn(speaker: TranscriptSpeaker, failureMessage: string, reportFailure = true): boolean {
    const session = this.transcriptionSession;
    const held = this.audio.hasQueued() || this.hasOwedReplays();
    const known = Array.from(this.speakerTurns.values(), ({ speaker: each }) => each);
    for (const each of known) this.endTurnOf(each);
    if (!this.liveConnection || !session || held) {
      if (!held) return true;
      for (const each of this.lastProvider === "sarvam" ? known : [speaker]) {
        this.audio.queueMarker({ type: "pause", speaker: each, after: this.audioSequence });
      }
      this.enforceAudioBudget();
      this.flushToLive();
      return true;
    }
    if (session.provider === "openai" && this.hasPendingAudio && this.latestSpeaker) {
      return this.commitTranscriptionBuffer(this.latestSpeaker, failureMessage, reportFailure);
    }
    try {
      session.clearAudio();
    } catch {
      if (reportFailure) void this.handleTranscriptionFailure("Transcript audio clear failed.");
      return false;
    }
    this.hasPendingAudio = false;
    this.pendingAudioSamples = 0;
    return true;
  }

  private applyQueuedMarker(marker: QueuedMarker): boolean {
    if (marker.type === "commit") {
      if (!this.hasPendingAudio || !canCommitPendingAudioForSpeaker(this.latestSpeaker, marker.speaker)) return true;
      this.latestSpeaker = marker.speaker;
      return this.commitTranscriptionBuffer(marker.speaker, "Transcript audio commit failed.", false);
    }
    const session = this.transcriptionSession;
    if (!session) return false;
    if (session.provider === "openai" && this.hasPendingAudio && this.latestSpeaker) {
      return this.commitTranscriptionBuffer(this.latestSpeaker, "Transcript audio commit failed.", false);
    }
    try {
      session.clearAudio(marker.type === "pause" && session.provider === "openai" ? undefined : marker.speaker);
    } catch {
      return false;
    }
    this.hasPendingAudio = false;
    this.pendingAudioSamples = 0;
    return true;
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
      this.transcriptionRecoveryPromise !== null ||
      (this.session?.status === "starting" && this.transcriptionSession === null)
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

  private async switchTranscriptionProvider(
    options: Parameters<TranscriptRoom["connectTranscriptionProvider"]>[0],
    revision: number,
  ): Promise<boolean> {
    for (let attempt = 0; ; attempt += 1) {
      if (revision !== this.sessionRevision) return false;
      try {
        await this.connectTranscriptionProvider(options, "switch");
        if (revision === this.sessionRevision) this.switchingProvider = false;
        return revision === this.sessionRevision;
      } catch (error) {
        if (revision !== this.sessionRevision) return false;
        const message = redactSensitiveText(
          error instanceof Error ? error.message : "Transcription provider connection failed.",
        );
        if (!isRetryableTranscriptionFailure(message)) {
          this.switchingProvider = false;
          throw error;
        }
        console.warn("[TranscriptWorker] switch provider open failed; retrying", {
          roomId: this.session?.roomId,
          attempt: attempt + 1,
          message,
        });
      }
      await new Promise((resolve) => setTimeout(resolve, transcriptionRecoveryDelayMs(attempt + 1)));
    }
  }

  private async connectTranscriptionProvider(
    options: {
      apiKey: string;
      transcriptModel: string;
      language: string;
      languageChosen?: boolean;
      providerLanguage?: string;
      delay: string;
      locale: string;
      localizationPrompt?: string;
    },
    mode: "replace" | "switch" = "replace",
  ): Promise<void> {
    if (mode === "replace") this.closeTranscriptionProvider(true);
    const generation = this.transcriptionRecoveryGeneration;
    if (mode === "replace") this.transcriptionConnectionOptions = options;
    this.transcriptionProviderOpeningGeneration = generation;
    try {
      try {
        const connection = await this.openTranscriptionProvider(options);
        if (generation !== this.transcriptionRecoveryGeneration) {
          connection.session.close();
          throw new Error("Transcript provider connection was superseded.");
        }
        if (mode === "switch") {
          this.drainTranscriptionProvider();
          this.resetTranscriptionAudioState();
          this.transcriptionConnectionOptions = options;
        }
        if (!this.installConnection(connection)) {
          throw new Error(
            "Buffered transcript audio replay connection failed.",
          );
        }
      } catch (error) {
        if (mode === "switch" || generation !== this.transcriptionRecoveryGeneration) throw error;
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
    this.transcriptionOpenController = controller;
    const timeout = setTimeout(() => {
      controller.abort("Transcript provider connection timed out.");
    }, resolveAiFeatureSettings(this.responseEnvironment ?? this.env, "transcription").timeoutMs);
    try {
      const session = await connectLiveTranscriptionProvider({
        env: { ...this.env, ...(this.responseEnvironment ?? {}) },
        ...options,
        signal: controller.signal,
        socketBudget: this.sarvamSockets,
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
          onItemLost: (itemId) => {
            const connection = this.connectionFor(epoch);
            if (connection) this.loseLine(connection, itemId);
          },
          onReady: () => {
            if (this.liveConnection?.epoch === epoch) this.flushToLive();
            else this.queueDrainCheck(epoch);
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
        throw new Error(String(controller.signal.reason));
      }
      throw error;
    } finally {
      clearTimeout(timeout);
      if (this.transcriptionOpenController === controller) this.transcriptionOpenController = null;
    }
  }

  private connectionFor(epoch: number): ProviderConnection | null {
    if (this.liveConnection?.epoch === epoch) return this.liveConnection;
    return this.providerDrains.get(epoch) ?? null;
  }

  private useLiveConnection(connection: ProviderConnection): void {
    this.lastProvider = connection.session.provider;
    this.liveConnection = connection;
    this.transcriptionSession = connection.session;
  }

  private supersedeTranscriptionRecovery(): void {
    this.transcriptionRecoveryGeneration += 1;
    this.transcriptionProviderOpeningGeneration = null;
    this.transcriptionRecoveryPromise = null;
    this.pendingTranscriptionRecoveryFailure = null;
    const controller = this.transcriptionOpenController;
    this.transcriptionOpenController = null;
    controller?.abort("Transcript provider connection was superseded.");
  }

  private closeTranscriptionProvider(keepOwed: boolean): void {
    this.supersedeTranscriptionRecovery();
    this.liveConnection?.session.settle?.();
    this.transcriptionConnectionEpoch += 1;
    const live = this.liveConnection;
    this.liveConnection = null;
    this.transcriptionSession = null;
    this.transcriptionConnectionOptions = null;
    if (!keepOwed) this.audio.clear();
    if (live) this.handOffLiveLines(live, false);
    this.resetTranscriptionAudioState();
    if (!live) return;
    try {
      live.session.close();
    } catch {}
  }

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
      this.audio.releaseOwner(line.id);
      if (!Number.isFinite(line.deadlineAt)) line.deadlineAt = now + TRANSCRIPTION_LINE_DEADLINE_MS;
    }
    this.audio.removeUnowned();
    this.providerDrains.set(live.epoch, live);
    this.liveConnection = null;
    this.transcriptionSession = null;
    this.settleDrain(live);
    this.armLineTimer();
  }

  private settleDrain(drain: ProviderConnection): void {
    if (this.providerDrains.get(drain.epoch) !== drain) return;
    if (drain.timer !== null) clearTimeout(drain.timer);
    drain.timer = null;
    const owesLines =
      this.ledger.active().some(({ epoch }) => epoch === drain.epoch) || drain.session.owes?.() === true;
    const now = Date.now();
    if (!owesLines && now >= drain.quietAt) {
      this.closeDrain(drain);
      return;
    }
    if (!owesLines) {
      drain.timer = setTimeout(() => this.settleDrain(drain), drain.quietAt - now);
    }
  }

  private queueDrainCheck(epoch: number): void {
    const drain = this.providerDrains.get(epoch);
    if (!drain) return;
    // Provider callbacks can run before the turn and its socket slot are released.
    queueMicrotask(() => this.settleDrain(drain));
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

  private async endDrain(drain: ProviderConnection, reason: string): Promise<void> {
    if (this.providerDrains.get(drain.epoch) !== drain) return;
    drain.session.settle?.();
    const owed = this.ledger.active().filter(({ epoch }) => epoch === drain.epoch);
    if (this.endUnfinishedLines(owed, `A replaced provider ${reason}`, drain)) {
      this.persistInBackground();
      this.scheduleMinutes();
    }
    this.closeDrain(drain);
  }

  private nextPlace(connection: ProviderConnection | null): LinePlace {
    const block = connection?.role === "draining" ? connection.block : null;
    const sequence = block && block.next < block.end ? block.next++ : this.sequence++;
    return { sequence, startMs: Date.now() };
  }

  private placeFor(
    connection: ProviderConnection | null,
    audio: readonly HeldChunk[],
    hint?: SpeechPlace,
  ): LinePlace {
    const first = audio.reduce<HeldChunk | null>(
      (earliest, chunk) => (earliest === null || chunk.order < earliest.order ? chunk : earliest),
      null,
    );
    const usable = hint && (!first || hint.order < first.order) && !this.placeTaken(hint.order) ? hint : null;
    if (usable) return { sequence: usable.order, startMs: usable.startMs };
    if (first) return { sequence: first.order, startMs: first.createdAt };
    return this.nextPlace(connection);
  }

  private placeTaken(sequence: number): boolean {
    return (
      this.ledger.all().some(({ place }) => place?.sequence === sequence) ||
      this.segments.some((segment) => segment.sequence === sequence)
    );
  }

  private replayLine(run: AudioRun): CaptionLine {
    const line = this.ledger.add({
      state: "replaying",
      speaker: run.speaker,
      heard: runHeard(run),
      place: this.placeFor(null, run.chunks),
      epoch: null,
      deadlineAt: Number.POSITIVE_INFINITY,
    });
    this.audio.setOwner(run.chunks, { kind: "line", lineId: line.id });
    return line;
  }

  private awaitReplacement(line: CaptionLine): void {
    line.state = "replaying";
    line.epoch = null;
    line.deadlineAt = Number.POSITIVE_INFINITY;
  }

  private acceptLine(
    connection: ProviderConnection,
    providerItemId: string,
    utterance: AcceptedUtterance,
  ): void {
    if (connection.providerToLine.has(providerItemId)) return;
    const replayed = utterance.lineId ? this.ledger.get(utterance.lineId) : undefined;
    const now = Date.now();
    let line: CaptionLine;
    if (replayed?.state === "replaying" && replayed.epoch === connection.epoch) {
      line = replayed;
      line.state = "open";
      line.freshText = true;
      line.deadlineAt = now + TRANSCRIPTION_LINE_DEADLINE_MS;
    } else {
      line = this.ledger.add({
        state: "open",
        speaker: utterance.speaker,
        heard: utterance.heard,
        place: null,
        epoch: connection.epoch,
        deadlineAt: now + TRANSCRIPTION_LINE_DEADLINE_MS,
      });
      this.bindSpeech(connection, line, utterance);
    }
    connection.bind(providerItemId, line.id);
    if (line.heard) this.persistInBackground();
    this.armLineTimer();
  }

  private bindSpeech(connection: ProviderConnection, line: CaptionLine, speech: HeardSpeech): void {
    line.speaker ??= speech.speaker;
    if (!line.speaker) return;
    const claimed = this.claimAudio(connection, line, speech);
    line.place ??= this.placeFor(connection, claimed, speech.place);
    if (claimed.length > 0 && isActive(line)) {
      line.deadlineAt = Math.max(line.deadlineAt, this.ownAudioDeadline(line));
    }
  }

  private markLineHeard(connection: ProviderConnection, providerItemId: string, heard: HeardSpeech): void {
    const line = this.ledger.get(connection.lineOf(providerItemId) ?? "");
    if (!line || !isActive(line)) return;
    if (!line.heard && !line.text.trim()) line.place = null;
    line.heard = true;
    this.bindSpeech(connection, line, heard);
    this.persistInBackground();
  }

  private acknowledgeLine(connection: ProviderConnection, providerItemId: string): CaptionLine | null {
    const known = connection.lineOf(providerItemId);
    if (known) return this.ledger.get(known) ?? null;
    if (connection.session.provider !== "openai") return null;
    const committed = connection.commitQueue.shift();
    if (!committed) return null;
    if (connection === this.liveConnection) this.armTranscriptionCommitWatchdog();
    connection.bind(providerItemId, committed.lineId);
    const line = this.ledger.get(committed.lineId);
    if (!line) return null;
    if (line.state === "pending_ack" || line.state === "replaying") {
      line.state = "open";
      line.epoch = connection.epoch;
      line.deadlineAt = Math.min(line.deadlineAt, Date.now() + TRANSCRIPTION_LINE_DEADLINE_MS);
    }
    this.armLineTimer();
    return line;
  }

  private namedLine(connection: ProviderConnection, providerItemId: string): CaptionLine | null {
    if (connection.session.provider === "openai" && !connection.providerToLine.has(providerItemId)) return null;
    return this.acknowledgeLine(connection, providerItemId);
  }

  private applyLineDelta(connection: ProviderConnection, providerItemId: string, delta: string): void {
    const line = this.namedLine(connection, providerItemId);
    if (!line || line.state !== "open" || !isPlaced(line)) return;
    const now = Date.now();
    const shownBefore = line.text;
    line.text = line.freshText ? delta : `${line.text}${delta}`;
    line.freshText = false;
    if (!line.text.trim()) return;
    const segment = this.lineSegment(line, now);
    if (line.text !== shownBefore) this.persistInBackground();
    this.broadcast({
      type: "segment.delta",
      delta: this.toSegmentDelta(segment, delta, now),
    });
  }

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
      if (text && isPlaced(line)) {
        this.ledger.end(line, "final", text);
        changed = this.recordFinalSegment(this.lineSegment(line), text);
      } else if (isPlaced(line) && connection.session.provider === "sarvam" && line.heard) {
        this.ledger.end(line, "gap", TRANSCRIPTION_GAP_MARKER);
        changed = this.recordFinalSegment(this.lineSegment(line), TRANSCRIPTION_GAP_MARKER);
      } else if (isPlaced(line) && connection.session.provider === "sarvam") {
        this.ledger.end(line, "dropped", "");
        changed = true;
      } else {
        this.forgetLine(connection, line);
        changed = true;
      }
    } else if (words && words !== line.text && isPlaced(line)) {
      this.ledger.end(line, "final", words);
      changed = this.recordFinalSegment(this.lineSegment(line), words);
    }
    this.queueDrainCheck(connection.epoch);
    if (!changed) return;
    this.persistInBackground();
    this.scheduleMinutes();
  }

  private async applyLineFailure(connection: ProviderConnection, providerItemId: string): Promise<void> {
    const line = this.namedLine(connection, providerItemId);
    if (!line || !isActive(line)) return;
    const changed = this.endUnfinishedLines([line], "A provider failed one line", connection);
    this.queueDrainCheck(connection.epoch);
    if (changed) {
      this.persistInBackground();
      this.scheduleMinutes();
    }
  }

  private loseLine(connection: ProviderConnection, providerItemId: string): void {
    const line = this.namedLine(connection, providerItemId);
    if (!line || !isActive(line)) return;
    if (!line.text.trim() && line.heard && !line.replayed && this.audio.owns(line.id)) {
      for (const id of connection.providerIdsOf(line.id)) connection.providerToLine.delete(id);
      line.replayed = true;
      this.awaitReplacement(line);
      this.flushToLive();
    } else if (this.endUnfinishedLines([line], "A Sarvam connection dropped one turn", connection)) {
      this.persistInBackground();
      this.scheduleMinutes();
    }
  }

  private endUnfinishedLines(
    lines: CaptionLine[],
    context: string,
    connection: ProviderConnection | null,
  ): boolean {
    let changed = false;
    let gaps = 0;
    for (const line of lines) {
      if (!isActive(line)) continue;
      const words = line.text.trim();
      if (!isPlaced(line)) {
        this.forgetLine(connection, line);
        changed = true;
      } else if (words) {
        const shown = (connection?.session.provider ?? this.lastProvider) === "sarvam" ? `${words} ${TRANSCRIPTION_GAP_MARKER}` : words;
        this.ledger.end(line, "final", shown);
        changed = this.recordFinalSegment(this.lineSegment(line), shown) || changed;
        gaps += shown === words ? 0 : 1;
      } else if (line.heard) {
        this.ledger.end(line, "gap", TRANSCRIPTION_GAP_MARKER);
        changed = this.recordFinalSegment(this.lineSegment(line), TRANSCRIPTION_GAP_MARKER) || changed;
        gaps += 1;
      } else if (connection?.session.provider === "openai") {
        this.ledger.end(line, "dropped", "");
        changed = true;
      } else {
        this.forgetLine(connection, line);
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

  private forgetLine(connection: ProviderConnection | null, line: CaptionLine): void {
    for (const providerItemId of connection?.providerIdsOf(line.id) ?? []) {
      connection?.providerToLine.delete(providerItemId);
    }
    this.ledger.remove(line.id);
  }

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
    const live = this.liveConnection;
    let changed = false;
    for (const connection of [live, ...this.providerDrains.values(), null]) {
      const owed = this.ledger
        .active()
        .filter((line) => line.epoch === (connection?.epoch ?? null) && line.deadlineAt <= now);
      const providerItemIds = owed.flatMap((line) => connection?.providerIdsOf(line.id) ?? []);
      changed = this.endUnfinishedLines(owed, "A provider did not finish in time", connection) || changed;
      for (const providerItemId of providerItemIds) connection?.session.fence?.(providerItemId);
    }
    for (const drain of Array.from(this.providerDrains.values())) this.settleDrain(drain);
    this.armLineTimer();
    if (changed) {
      this.persistInBackground();
      this.scheduleMinutes();
    }
  }

  private resetTranscriptionAudioState(): void {
    this.lastAudioAt = 0;
    this.latestSpeaker = null;
    this.hasPendingAudio = false;
    this.pendingAudioSamples = 0;
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
      void this.handleTranscriptionFailure("Transcription provider acknowledgment timed out.", true);
    }, delay);
  }

  private handOffLiveLines(live: ProviderConnection, ackTimedOut: boolean): void {
    const owed = this.ledger.active().filter(({ epoch }) => epoch === live.epoch);
    const sarvam = live.session.provider === "sarvam";
    const ended = owed.filter(
      (line) =>
        (ackTimedOut && line.state === "pending_ack" && line.replayed) ||
        (sarvam && (line.text.trim() !== "" || !line.heard)) ||
        !this.audio.owns(line.id),
    );
    if (this.endUnfinishedLines(ended, "A line could not be replayed to a replacement", live)) {
      this.persistInBackground();
      this.scheduleMinutes();
    }
    const waiting: CaptionLine[] = [];
    for (const line of owed) {
      if (ended.includes(line)) continue;
      this.awaitReplacement(line);
      waiting.push(line);
    }
    for (const run of this.unownedRuns(live.session.provider === "sarvam")) waiting.push(this.replayLine(run));
    this.audio.removeUnowned();
    for (const line of waiting) this.takeQueuedContinuation(line);
    this.ledger.forgetEnded(live.epoch);
  }

  private takeQueuedContinuation(line: CaptionLine): void {
    const owned = this.audio.ownedBy(line.id);
    let last = owned.at(-1);
    if (!last) return;
    const queued = new Map(this.audio.queued().map((chunk) => [chunk.sequence, chunk]));
    const taken: HeldChunk[] = [];
    for (let next = queued.get(last.sequence + 1); next; next = queued.get(last.sequence + 1)) {
      if (next.turn !== last.turn || speakerKey(next.speaker) !== speakerKey(last.speaker)) break;
      taken.push(next);
      last = next;
    }
    this.audio.setOwner(taken, { kind: "line", lineId: line.id });
    if (taken.some(({ voice }) => voice !== "quiet")) line.heard = true;
  }

  private unownedRuns(sarvam: boolean): AudioRun[] {
    const now = Date.now();
    const runs = runsOf(this.audio.unowned(), true);
    if (!sarvam) return runs;
    return runs.filter((run) => runHeard(run) && now - lastHeardSentAt(run) <= UNOWNED_AUDIO_KEPT_MS);
  }

  private owedReplays(): CaptionLine[] {
    return this.ledger.active().filter(({ state, epoch }) => state === "replaying" && epoch === null);
  }

  private replayOwedLines(connection: ProviderConnection): boolean {
    const sentAt = Date.now();
    try {
      for (const line of this.owedReplays()) {
        const audio = this.audio.ownedBy(line.id);
        if (audio.length === 0) {
          this.endUnfinishedLines([line], "A waiting line had no audio left to replay", null);
          continue;
        }
        line.epoch = connection.epoch;
        const samples = audio.reduce((sum, chunk) => sum + chunk.sampleCount, 0);
        for (const chunk of audio) {
          connection.session.appendAudio(chunk.audio);
          chunk.sentAt = sentAt;
        }
        if (samples < MIN_OPENAI_COMMIT_AUDIO_SAMPLES) {
          connection.session.appendAudio(createSilentPcm16Base64(MIN_OPENAI_COMMIT_AUDIO_SAMPLES - samples));
        }
        connection.session.commitAudio();
        line.state = "pending_ack";
        line.replayed = true;
        line.freshText = true;
        connection.commitQueue.push({ lineId: line.id, committedAt: Date.now() });
      }
    } catch {
      return false;
    }
    return true;
  }

  private replayToLane(connection: ProviderConnection, line: CaptionLine, audio: readonly HeldChunk[]): void {
    const sentAt = Date.now();
    line.epoch = connection.epoch;
    try {
      for (const chunk of audio) {
        connection.session.appendAudio(chunk.audio, chunk.speaker, {
          voice: chunk.voice,
          turn: chunk.turn,
          at: sentAt,
          sequence: chunk.sequence,
          order: chunk.order,
          createdAt: chunk.createdAt,
          lineId: line.id,
        });
        chunk.sentAt = sentAt;
      }
    } catch (error) {
      if (!(error instanceof AudioNotSent)) throw error;
      if (line.state === "replaying") line.epoch = null;
      return;
    }
    connection.session.clearAudio(line.speaker ?? undefined);
  }

  private forwardHeldAudio(connection: ProviderConnection): boolean {
    const forwarded = this.forwardEachSpeaker(connection);
    this.audio.compact();
    return forwarded;
  }

  private forwardEachSpeaker(connection: ProviderConnection): boolean {
    if (this.audioPaused) return true;
    if (connection.session.provider !== "sarvam") {
      if (!this.replayOwedLines(connection)) return false;
      return this.forwardInOrder(this.audio.queuedEvents(), () => true);
    }
    type Held =
      | { arrival: number; speaker: TranscriptSpeaker; line: CaptionLine; audio: HeldChunk[] }
      | { arrival: number; speaker: TranscriptSpeaker; event: QueuedEvent };
    const replays: Held[] = this.owedReplays().flatMap((line) => {
      const audio = this.audio.ownedBy(line.id);
      if (audio.length === 0) {
        this.endUnfinishedLines([line], "A waiting line had no audio left to replay", null);
        return [];
      }
      return [{ arrival: audio[0].sequence - 0.75, speaker: audio[0].speaker, line, audio }];
    });
    const queued: Held[] = this.audio.queuedEvents().map((event) =>
      event.type === "chunk"
        ? { arrival: event.chunk.sequence, speaker: event.chunk.speaker, event }
        : { arrival: event.after - 0.5, speaker: event.speaker, event },
    );
    const waiting = new Set<string>();
    try {
      for (const item of [...replays, ...queued].sort((left, right) => left.arrival - right.arrival)) {
        const key = speakerKey(item.speaker);
        if (waiting.has(key)) continue;
        if ("line" in item) {
          connection.session.clearAudio(item.speaker);
          if (connection.session.ready?.(item.speaker) === false) {
            waiting.add(key);
            continue;
          }
          this.replayToLane(connection, item.line, item.audio);
          if (item.line.state === "replaying") waiting.add(key);
          continue;
        }
        const forwarded = this.forwardInOrder([item.event], () => {
          waiting.add(key);
          return true;
        });
        if (!forwarded) return false;
      }
    } catch {
      return false;
    }
    return true;
  }

  private forwardInOrder(events: readonly QueuedEvent[], onWait: () => boolean): boolean {
    for (const event of events) {
      if (event.type === "chunk") {
        const sent = this.sendChunk(event.chunk);
        if (sent === "wait") return onWait();
        if (sent === "failed") return false;
        continue;
      }
      this.audio.consumeMarker(event);
      if (!this.applyQueuedMarker(event)) return false;
    }
    return true;
  }

  private hasOwedReplays(): boolean {
    return this.owedReplays().length > 0;
  }

  private flushToLive(): void {
    const live = this.liveConnection;
    if (!live || this.audioPaused) return;
    const replays = this.hasOwedReplays();
    if (!replays && !this.audio.hasQueued()) return;
    const savedUnsent = () => this.audio.queued().filter((chunk) => chunk.savedUnsent).length;
    const savedBefore = savedUnsent();
    const forwarded = this.forwardHeldAudio(live);
    if (forwarded) {
      if (replays) this.settleReplayedLines(live);
      if (savedUnsent() < savedBefore) this.persistInBackground();
      return;
    }
    void this.handleTranscriptionFailure("Transcript audio stream failed.");
  }

  private installConnection(connection: ProviderConnection): boolean {
    this.useLiveConnection(connection);
    if (this.forwardHeldAudio(connection)) {
      this.settleReplayedLines(connection);
      return true;
    }
    this.detachConnection(connection, false);
    return false;
  }

  private detachConnection(connection: ProviderConnection, ackTimedOut: boolean): void {
    connection.session.settle?.();
    if (this.liveConnection === connection) {
      this.liveConnection = null;
      this.transcriptionSession = null;
    }
    this.transcriptionConnectionEpoch += 1;
    this.handOffLiveLines(connection, ackTimedOut);
    connection.commitQueue.length = 0;
    connection.providerToLine.clear();
    try {
      connection.session.close();
    } catch {}
    this.resetTranscriptionAudioState();
  }

  private settleReplayedLines(connection: ProviderConnection): void {
    const deadline = Date.now() + TRANSCRIPTION_LINE_DEADLINE_MS;
    for (const line of this.ledger.active()) {
      if (line.epoch !== connection.epoch || line.state === "pending_ack") continue;
      if (line.deadlineAt > deadline) line.deadlineAt = deadline;
    }
    this.armTranscriptionCommitWatchdog();
    this.armLineTimer();
  }

  private async handleTranscriptionFailure(
    message: string,
    ackTimedOut = false,
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
      this.pendingTranscriptionRecoveryFailure = redactedMessage;
      return;
    }
    if (this.switchingProvider) {
      const failed = this.liveConnection;
      if (failed) this.detachConnection(failed, ackTimedOut);
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
    if (failed) this.detachConnection(failed, ackTimedOut);

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
    if (generation !== this.transcriptionRecoveryGeneration) return;
    const pendingFailure = this.pendingTranscriptionRecoveryFailure;
    this.pendingTranscriptionRecoveryFailure = null;
    if (pendingFailure) {
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
      try {
        replacement = await this.openTranscriptionProvider(options);
        if (generation !== this.transcriptionRecoveryGeneration) {
          replacement.session.close();
          return;
        }
        if (!this.installConnection(replacement)) {
          this.pendingTranscriptionRecoveryFailure = null;
          throw new Error("Held caption audio replay connection failed.");
        }
      } catch (error) {
        if (generation !== this.transcriptionRecoveryGeneration) return;
        if (replacement && this.liveConnection === replacement) {
          this.pendingTranscriptionRecoveryFailure = null;
          this.detachConnection(replacement, false);
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
          await this.failTranscriptionPermanently(lastMessage);
          return;
        }
        continue;
      }

      const droppedEvents = this.droppedAudioChunks;
      this.droppedAudioChunks = 0;
      console.info("[TranscriptWorker] transcription provider recovered", {
        roomId: this.session?.roomId,
        transportMode: this.session?.transportMode,
        provider: replacement.session.provider,
        attempt: attempt + 1,
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

  private async failTranscriptionPermanently(message: string): Promise<void> {
    const redactedMessage = redactSensitiveText(message);
    this.broadcast({ type: "error", message: redactedMessage });
    this.markTakeoverNeeded(redactedMessage);
    this.broadcastSession();
    this.persistInBackground();
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

  private forgetAllLines(): void {
    this.switchingProvider = false;
    this.speakerTurns.clear();
    this.ledger.clear();
    this.closeTranscriptionProvider(false);
    this.closeDrains();
    this.voiceChecks.clear();
    if (this.lineTimer !== null) clearTimeout(this.lineTimer);
    this.lineTimer = null;
  }

  private endEveryOwedLine(context: string): void {
    for (const connection of [this.liveConnection, ...this.providerDrains.values(), null]) {
      if (connection?.role === "draining") connection.session.settle?.();
      const owed = this.ledger.active().filter(({ epoch }) => epoch === (connection?.epoch ?? null));
      this.endUnfinishedLines(owed, context, connection);
    }
    this.closeDrains();
    this.armLineTimer();
  }

  private segmentsForSnapshot(): TranscriptSegment[] {
    const owed = new Map<string, TranscriptSegment>();
    for (const line of this.ledger.active()) {
      if (!isPlaced(line)) continue;
      const words = line.text.trim();
      if (!words && !line.heard) continue;
      const segment = this.lineSegment(line);
      owed.set(line.id, {
        ...segment,
        text: words ? line.text : TRANSCRIPTION_GAP_MARKER,
        isFinal: true,
        endMs: segment.updatedAt,
      });
    }
    const unsent = [
      ...this.unownedRuns(this.transcriptionSession?.provider === "sarvam"),
      ...runsOf(this.audio.queued(), true),
    ].filter(runHeard);
    for (const run of unsent) {
      for (const chunk of run.chunks) chunk.savedUnsent = true;
      const [first] = run.chunks;
      const itemId = `unsent-${speakerKey(run.speaker)}-${first.order}`;
      owed.set(itemId, {
        ...this.createSegment(itemId, run.speaker, { sequence: first.order, startMs: first.createdAt }),
        text: TRANSCRIPTION_GAP_MARKER,
        isFinal: true,
        endMs: Date.now(),
      });
    }
    if (owed.size === 0) return this.segments;
    const saved = this.segments.map((segment) => owed.get(segment.itemId) ?? segment);
    const shown = new Set(this.segments.map(({ itemId }) => itemId));
    return [...saved, ...Array.from(owed.values()).filter(({ itemId }) => !shown.has(itemId))].sort(
      (left, right) => left.sequence - right.sequence,
    );
  }

  private snapshotMessage(viewer: Viewer) {
    return {
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
    };
  }

  private visiblePartials(): TranscriptSegment[] {
    return this.ledger.active().flatMap((line) => (line.text && isPlaced(line) ? [this.lineSegment(line)] : []));
  }

  private lineSegment(line: ShownLine, now = Date.now()): TranscriptSegment {
    return {
      ...this.createSegment(line.id, line.speaker, line.place),
      text: line.text,
      updatedAt: now,
    };
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
    if (existing?.text === text) return false;

    const now = Date.now();
    const finalSegment: TranscriptSegment = {
      ...segment,
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

  private maxSegments(): number {
    return parsePositiveInt(this.env.TRANSCRIPT_MAX_SEGMENTS, DEFAULT_MAX_SEGMENTS);
  }

  private trimSegments(): void {
    const maxSegments = this.maxSegments();
    if (this.segments.length <= maxSegments) return;
    this.segments.splice(0, this.segments.length - maxSegments);
    const kept = new Set(this.segments.map(({ itemId }) => itemId));
    this.ledger.forgetShownExcept(kept);
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
    this.voiceChecks.clear();
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

  private persistInBackground(): void {
    const revision = this.sessionRevision;
    this.persist().then(
      () => {
        this.persistFailures = 0;
      },
      (error: unknown) => {
        console.warn("[TranscriptWorker] snapshot write failed", {
          roomId: this.session?.roomId,
          message: redactSensitiveText(error instanceof Error ? error.message : "Snapshot write failed."),
        });
        if (this.persistRetryTimer !== null || revision !== this.sessionRevision) return;
        const delay = Math.min(TRANSCRIPT_PERSIST_RETRY_MS * 2 ** this.persistFailures, TRANSCRIPT_PERSIST_RETRY_MAX_MS);
        this.persistFailures += 1;
        this.persistRetryTimer = setTimeout(() => {
          this.persistRetryTimer = null;
          this.persistInBackground();
        }, delay);
      },
    );
  }

  private cancelPersistRetry(): void {
    if (this.persistRetryTimer !== null) clearTimeout(this.persistRetryTimer);
    this.persistRetryTimer = null;
    this.persistFailures = 0;
  }

  private waitBeforeRetry(attempt: number): Promise<void> {
    const delay = Math.min(TRANSCRIPT_PERSIST_RETRY_MS * 2 ** attempt, TRANSCRIPT_PERSIST_RETRY_MAX_MS);
    return new Promise((resolve) => setTimeout(resolve, delay));
  }

  private async persistForRevision(revision: number): Promise<boolean> {
    for (let attempt = 0; ; attempt += 1) {
      if (revision !== this.sessionRevision) return false;
      try {
        await this.persist();
        return revision === this.sessionRevision;
      } catch (error) {
        console.warn("[TranscriptWorker] session snapshot write failed", {
          roomId: this.session?.roomId,
          attempt: attempt + 1,
          message: redactSensitiveText(error instanceof Error ? error.message : "Snapshot write failed."),
        });
      }
      await this.waitBeforeRetry(attempt);
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
    this.cancelPersistRetry();
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
