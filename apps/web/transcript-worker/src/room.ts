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
  TRANSCRIPTION_LINE_DEADLINE_MS,
  TRANSCRIPTION_GAP_MARKER,
  TRANSCRIPTION_PROVIDER_DRAIN_MS,
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
import { TranscriptLines, type LinePlace, type LineRecord } from "./transcript-lines";
import {
  recoverPersistedTranscriptSession,
  shouldAutomaticallyRecoverPersistedTranscriptSession,
  shouldRetainRecoverableTranscriptSnapshot,
} from "./session-recovery";
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
import {
  TranscriptAudioReplayJournal,
  type ReplayBatch,
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
  
/** A commit sent to OpenAI and not yet acknowledged, with the line its audio belongs to once known. */
type PendingCommit = {
  at: number;
  speaker: TranscriptSpeaker;
  owner: string | null;
  batch: ReplayBatch | null;
};

type ProviderDrain = {
  session: LiveTranscriptionSession;
  epoch: number;
  lines: TranscriptLines;
  // Sarvam may still report speech it heard until 10 s after its last audio.
  quietAt: number;
  pendingCommits: PendingCommit[];
  startedAt: number;
  nextSequence: number;
  endSequence: number;
  timer: ReturnType<typeof setTimeout> | null;
};

/** One provider connection's lines, live or being replaced, behind one set of handlers. */
type LineSource = {
  lines: TranscriptLines;
  drain: ProviderDrain | null;
  takeCommit: () => PendingCommit | null;
  nextCommit: () => PendingCommit | null;
  nextPlace: () => LinePlace;
  changed: () => void;
};

export class TranscriptRoom {
  private readonly state: DurableObjectState;
  private readonly env: Env;
  private readonly loaded: Promise<void>;
  private readonly viewers = new Map<WebSocket, Viewer>();
  // The current provider's lines, each placed when the provider accepted it,
  // before any of its text: lines keep speaking order whatever order their
  // text arrives in, across a provider switch too.
  private liveLines = new TranscriptLines();
  private liveLineTimer: ReturnType<typeof setTimeout> | null = null;
  // Lines that ended while waiting for an ack, so a late ack fills their gap.
  private readonly endedAwaitingLines = new Map<string, string>();
  // Set while a replacement is sent the audio of a failed connection's lines.
  private replayingLines = false;
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
  private readonly providerDrains = new Map<number, ProviderDrain>();
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
  private pendingCommits: PendingCommit[] = [];
  private transcriptionCommitWatchdogTimer: ReturnType<typeof setTimeout> | null =
    null;
  private readonly transcriptionRecoveryAudio =
    new TranscriptRecoveryAudioBuffer();
  private readonly transcriptionReplayJournal =
    new TranscriptAudioReplayJournal();
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
    if (!wasIdle) this.drainTranscriptionProvider();
    this.resetTranscriptionAudioState();
    this.audioPaused = false;
    this.resetMinutesScheduler(!wasIdle);
    if (wasIdle) {
      this.segments = [];
      this.sequence = 0;
      this.minutes = createEmptyMinutes(qaModel);
      this.lastMinutesRefreshAt = 0;
      this.lastMinutesCompactionAt = now;
    }
    this.broadcastSession();
    await this.persist();

    if (acceptedRevision !== this.sessionRevision) return;
    try {
      const delay = normalizeDelay(message.delay);
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
    this.closeTranscriptionProvider();
    this.discardProviderDrains();
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
      this.transcriptionSession.appendAudio(audio, speaker);
      this.transcriptionReplayJournal.append(audio, speaker, sampleCount);
      this.latestSpeaker = speaker;
      this.lastAudioAt = Date.now();
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
    owner: string | null = null,
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
      const provider = this.transcriptionSession.provider;
      const batch = this.transcriptionReplayJournal.commit(
        speaker,
        Date.now(),
        owner ?? (provider === "sarvam" ? this.liveLines.audioOwner : null),
      );
      const record = batch?.owner ? this.liveLines.byId(batch.owner) : undefined;
      if (batch && record) record.audio.push(batch);
      else if (batch) batch.owner = null;
      if (provider === "openai") {
        this.pendingCommits.push({ at: Date.now(), speaker, owner, batch });
        this.armTranscriptionCommitWatchdog();
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
    this.liveLines.audioOwner = null;
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
    languageChosen?: boolean;
    providerLanguage?: string;
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
    languageChosen?: boolean;
    providerLanguage?: string;
    delay: string;
    locale: string;
    localizationPrompt?: string;
  }): Promise<LiveTranscriptionSession> {
    const epoch = this.transcriptionConnectionEpoch + 1;
    this.transcriptionConnectionEpoch = epoch;
    const controller = new AbortController();
    const timeout = setTimeout(() => {
      controller.abort("Transcript provider connection timed out.");
    }, resolveAiFeatureSettings(this.responseEnvironment ?? this.env, "transcription").timeoutMs);
    try {
      return await connectLiveTranscriptionProvider({
        env: { ...this.env, ...(this.responseEnvironment ?? {}) },
        ...options,
        signal: controller.signal,
        callbacks: {
          onAccepted: (itemId, utterance) => {
            const source = this.sourceOf(epoch);
            if (source) this.acceptLine(source, itemId, utterance);
          },
          onHeard: (itemId) => {
            const source = this.sourceOf(epoch);
            if (source) this.markLineHeard(source, itemId);
          },
          onCommitted: (itemId) => {
            const source = this.sourceOf(epoch);
            if (source) this.acknowledgeLine(source, itemId);
          },
          onDelta: (itemId, delta) => {
            const source = this.sourceOf(epoch);
            if (source) this.applyLineDelta(source, itemId, delta);
          },
          onFinal: (itemId, transcript) => {
            const source = this.sourceOf(epoch);
            if (source) return this.applyLineFinal(source, itemId, transcript);
          },
          onItemFailed: (itemId, message) => {
            if (epoch === this.transcriptionConnectionEpoch) {
              return this.handleTranscriptionFailure(message);
            }
            const source = this.sourceOf(epoch);
            if (source) return this.applyLineFailure(source, itemId);
          },
          onFailure: (message) => {
            if (epoch === this.transcriptionConnectionEpoch) {
              return this.handleTranscriptionFailure(message);
            }
            const drain = this.providerDrains.get(epoch);
            if (drain) return this.endProviderDrainLines(drain, "failed");
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

  private sourceOf(epoch: number): LineSource | null {
    if (epoch === this.transcriptionConnectionEpoch) return this.liveSource();
    return this.drainSource(this.providerDrains.get(epoch));
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
    this.liveLines = new TranscriptLines();
    this.clearLiveLineTimer();
    this.resetTranscriptionAudioState();
    try {
      session?.close();
    } catch {}
  }

  /**
   * Keeps a provider that is being replaced open until every line it owes
   * ends: lines it accepted, audio it was sent but has not acknowledged, and
   * for Sarvam, speech it may still report from its last 10 seconds of
   * audio. Each replaced provider drains on its own; a later switch never
   * cuts an earlier drain short.
   */
  private drainTranscriptionProvider(): void {
    const session = this.transcriptionSession;
    if (!session) {
      this.endUnfinishedLines(
        this.liveLines.takeAll(),
        "A switch replaced a reconnecting provider",
        "none",
      );
      return;
    }
    if (this.hasPendingAudio && this.latestSpeaker) {
      this.commitTranscriptionBuffer(
        this.latestSpeaker,
        "Transcript audio commit failed.",
        false,
      );
    }
    const now = Date.now();
    const quietAt =
      session.provider === "sarvam" ? this.lastAudioAt + TRANSCRIPTION_PROVIDER_DRAIN_MS : 0;
    const owesWork =
      this.liveLines.size > 0 || this.pendingCommits.length > 0 || now < quietAt;
    if (!owesWork) return;
    try {
      session.finishAudio();
    } catch {}
    const epoch = this.transcriptionConnectionEpoch;
    const firstSequence = this.sequence;
    this.sequence += TRANSCRIPTION_DRAIN_SEQUENCE_BLOCK;
    const drain: ProviderDrain = {
      session,
      epoch,
      lines: this.liveLines,
      quietAt,
      pendingCommits: this.pendingCommits,
      startedAt: now,
      nextSequence: firstSequence,
      endSequence: this.sequence,
      timer: null,
    };
    for (const commit of drain.pendingCommits) {
      if (commit.owner) continue;
      const held = drain.lines.hold({
        place: this.drainPlace(drain),
        speaker: commit.speaker,
        heard: true,
        deadlineAt: now + TRANSCRIPTION_LINE_DEADLINE_MS,
      });
      commit.owner = held.id;
      this.giveLineCommit(held, commit);
    }
    drain.lines.limitAwaiting(now + TRANSCRIPTION_LINE_DEADLINE_MS);
    this.providerDrains.set(epoch, drain);
    this.transcriptionSession = null;
    this.pendingCommits = [];
    this.liveLines = new TranscriptLines();
    this.clearLiveLineTimer();
    this.settleProviderDrain(drain);
  }

  private discardProviderDrain(drain: ProviderDrain): void {
    if (this.providerDrains.get(drain.epoch) !== drain) return;
    this.providerDrains.delete(drain.epoch);
    if (drain.timer !== null) clearTimeout(drain.timer);
    try {
      drain.session.close();
    } catch {}
  }

  private discardProviderDrains(): void {
    for (const drain of Array.from(this.providerDrains.values())) {
      this.discardProviderDrain(drain);
    }
  }

  /** Lets a drain go once it owes nothing, else wakes it at its next deadline. */
  private settleProviderDrain(drain: ProviderDrain): void {
    if (this.providerDrains.get(drain.epoch) !== drain) return;
    if (drain.timer !== null) clearTimeout(drain.timer);
    drain.timer = null;
    const now = Date.now();
    const wakeAt = Math.min(
      drain.lines.nextDeadline() ?? Infinity,
      now < drain.quietAt ? drain.quietAt : Infinity,
    );
    if (wakeAt === Infinity) {
      this.discardProviderDrain(drain);
      return;
    }
    drain.timer = setTimeout(
      () => void this.endProviderDrainLines(drain, "timed out"),
      Math.max(0, wakeAt - now),
    );
  }

  /**
   * Ends a replaced provider's lines that are past their deadline, or all of
   * them when its connection failed, in one snapshot write, and only then
   * lets the drain go or waits for the rest.
   */
  private async endProviderDrainLines(
    drain: ProviderDrain,
    reason: "timed out" | "failed",
  ): Promise<void> {
    if (this.providerDrains.get(drain.epoch) !== drain) return;
    drain.timer = null;
    const lines = reason === "failed" ? drain.lines.takeAll() : drain.lines.takeDue(Date.now());
    if (this.endUnfinishedLines(lines, `A replaced provider ${reason}`, drain.session.provider)) {
      await this.persist();
      this.scheduleMinutes();
    }
    if (reason === "failed") {
      this.discardProviderDrain(drain);
      return;
    }
    this.settleProviderDrain(drain);
  }

  /**
   * Ends lines their provider will not finish, already taken out of their
   * book: words on screen stay as the line, a line our side heard speech in
   * becomes a gap, and one it never heard ends with nothing shown. Each drops
   * only its own replay audio. True when the transcript changed.
   */
  private endUnfinishedLines(
    lines: LineRecord[],
    context: string,
    provider: string,
  ): boolean {
    let changed = false;
    let gaps = 0;
    for (const record of lines) {
      this.forgetLine(record);
      if (this.hasFinalSegment(record.itemId)) continue;
      const segment = this.lineSegment(record);
      const hasWords = Boolean(segment.text.trim());
      if (!hasWords && !record.heard) continue;
      if (!this.recordFinalSegment(segment, hasWords ? "" : TRANSCRIPTION_GAP_MARKER)) continue;
      changed = true;
      if (!hasWords) gaps += 1;
    }
    if (gaps > 0) {
      console.warn(
        `[Transcript] ${context} with ${gaps} accepted line(s) not captioned; recorded a gap.`,
        JSON.stringify({ provider }),
      );
    }
    return changed;
  }

  /** What a line leaves behind once it ends: its audio goes, and a late ack can still find its place. */
  private forgetLine(record: LineRecord): void {
    this.transcriptionReplayJournal.release(record.audio);
    if (record.state === "awaiting") this.endedAwaitingLines.set(record.id, record.itemId);
  }

  /**
   * Finals plus every line still owed, saved as finals: its words so far, or
   * a gap while it has none. A restarted or rolled-back worker cannot resume
   * a provider connection, so this is how those lines end there, in a form
   * older workers read too.
   */
  private segmentsForSnapshot(): TranscriptSegment[] {
    const owed = [
      ...this.liveLines.all(),
      ...Array.from(this.providerDrains.values()).flatMap((drain) => drain.lines.all()),
    ]
      .filter((record) => !this.hasFinalSegment(record.itemId))
      .flatMap((record) => {
        const segment = this.lineSegment(record);
        const hasWords = Boolean(segment.text.trim());
        if (!hasWords && !record.heard) return [];
        return [{
          ...segment,
          text: hasWords ? segment.text : TRANSCRIPTION_GAP_MARKER,
          isFinal: true,
          endMs: segment.updatedAt,
        }];
      });
    if (owed.length === 0) return this.segments;
    return [...this.segments, ...owed].sort(
      (left, right) => left.sequence - right.sequence,
    );
  }

  private hasFinalSegment(itemId: string): boolean {
    return this.segments.some((segment) => segment.itemId === itemId);
  }

  private visiblePartials(): TranscriptSegment[] {
    return [
      ...this.liveLines.shown(),
      ...Array.from(this.providerDrains.values()).flatMap((drain) => drain.lines.shown()),
    ];
  }

  private lineSegment(record: LineRecord): TranscriptSegment {
    return record.shown ?? this.createSegment(record.itemId, record.speaker, record.place);
  }

  private liveSource(): LineSource {
    return {
      lines: this.liveLines,
      drain: null,
      takeCommit: () => this.acknowledgeTranscriptionCommit(),
      nextCommit: () => this.pendingCommits[0] ?? null,
      nextPlace: () => ({ sequence: this.sequence++, startMs: Date.now() }),
      changed: () => this.armLiveLineTimer(),
    };
  }

  private drainSource(drain: ProviderDrain | undefined): LineSource | null {
    if (!drain) return null;
    return {
      lines: drain.lines,
      drain,
      takeCommit: () => drain.pendingCommits.shift() ?? null,
      nextCommit: () => drain.pendingCommits[0] ?? null,
      nextPlace: () => this.drainPlace(drain),
      changed: () => this.settleProviderDrain(drain),
    };
  }

  /**
   * The next place in a replaced provider's block, which sits ahead of the
   * new provider's lines, for audio it acknowledges only after the switch.
   */
  private drainPlace(drain: ProviderDrain): LinePlace {
    return {
      sequence:
        drain.nextSequence < drain.endSequence
          ? drain.nextSequence++
          : this.sequence++,
      startMs: drain.startedAt,
    };
  }

  private lineDeadline(): number {
    return Date.now() + TRANSCRIPTION_LINE_DEADLINE_MS;
  }

  /**
   * Sarvam accepted an utterance: it continues the oldest line whose audio
   * was replayed to this connection, or takes a new place, with the speaker
   * of the audio that started it. Saved at once, so a restart still shows it.
   */
  private acceptLine(
    source: LineSource,
    itemId: string,
    utterance: { heard: boolean; speaker: TranscriptSpeaker | null },
  ): void {
    if (source.lines.get(itemId) || this.hasFinalSegment(itemId)) return;
    const record =
      (this.replayingLines ? source.lines.claimReplayed(itemId, this.lineDeadline()) : null) ??
      source.lines.accept(itemId, {
        place: source.nextPlace(),
        speaker: utterance.speaker ?? this.controllerSpeaker(),
        heard: utterance.heard,
        deadlineAt: this.lineDeadline(),
      });
    source.lines.audioOwner = record.id;
    void this.persist();
    source.changed();
  }

  private markLineHeard(source: LineSource, itemId: string): void {
    const record = source.lines.get(itemId);
    if (!record || record.heard) return;
    record.heard = true;
    void this.persist();
  }

  /**
   * A provider acknowledged a commit: the line of exactly that commit's
   * audio, whether it is waiting for this ack after a handoff or new.
   */
  private acknowledgeLine(source: LineSource, itemId: string): void {
    const commit = source.takeCommit();
    const open = source.lines.get(itemId);
    if (open) {
      this.giveLineCommit(open, commit);
      return;
    }
    if (this.hasFinalSegment(itemId)) {
      if (commit?.batch) this.transcriptionReplayJournal.release([commit.batch]);
      return;
    }
    if (commit?.owner && this.reviveEndedLine(commit.owner, itemId)) {
      if (commit.batch) this.transcriptionReplayJournal.release([commit.batch]);
      return;
    }
    const record =
      (commit?.owner ? source.lines.claim(commit.owner, itemId, this.lineDeadline()) : null) ??
      source.lines.accept(itemId, {
        place: source.nextPlace(),
        speaker: commit?.speaker ?? this.controllerSpeaker(),
        heard: true,
        deadlineAt: this.lineDeadline(),
      });
    this.giveLineCommit(record, commit);
    void this.persist();
    source.changed();
  }

  /** A late ack for a line that already ended as a gap names that gap, so its final fills the same place. */
  private reviveEndedLine(recordId: string, itemId: string): boolean {
    const endedItemId = this.endedAwaitingLines.get(recordId);
    if (endedItemId === undefined) return false;
    this.endedAwaitingLines.delete(recordId);
    const index = this.segments.findIndex((segment) => segment.itemId === endedItemId);
    if (index < 0) return false;
    this.segments[index] = { ...this.segments[index]!, id: itemId, itemId };
    return true;
  }

  private giveLineCommit(record: LineRecord, commit: PendingCommit | null): void {
    if (!commit) return;
    if (commit.batch && !record.audio.includes(commit.batch)) {
      commit.batch.owner = record.id;
      record.audio.push(commit.batch);
    }
    this.setLineSpeaker(record, commit.speaker);
  }

  /** Words from a provider that has not acknowledged their commit yet take that commit's speaker. */
  private openUnacknowledgedLine(source: LineSource, itemId: string): LineRecord | null {
    if (this.hasFinalSegment(itemId)) return null;
    const record = source.lines.accept(itemId, {
      place: source.nextPlace(),
      speaker: source.nextCommit()?.speaker ?? this.controllerSpeaker(),
      heard: true,
      deadlineAt: this.lineDeadline(),
    });
    void this.persist();
    source.changed();
    return record;
  }

  private applyLineDelta(source: LineSource, itemId: string, delta: string): void {
    if (this.hasFinalSegment(itemId)) return;
    const record = source.lines.get(itemId) ?? this.openUnacknowledgedLine(source, itemId);
    if (!record || record.state !== "open") return;
    const segment = this.lineSegment(record);
    const now = Date.now();
    const next: TranscriptSegment = {
      ...segment,
      text: `${segment.text}${delta}`,
      updatedAt: now,
    };
    record.shown = next;
    // A replaced provider's words are saved as they arrive, and the output
    // gate holds this delta until a restarted worker would still have them.
    if (source.drain) void this.persist();
    this.broadcast({
      type: "segment.delta",
      delta: this.toSegmentDelta(next, delta, now),
    });
  }

  /** A line's segment as it ends: its own, an earlier final of it, or a new place. */
  private endLineFor(source: LineSource, itemId: string): {
    segment: TranscriptSegment;
    endedLine: boolean;
  } {
    const record = source.lines.get(itemId);
    if (record) {
      source.lines.end(record);
      this.forgetLine(record);
      return { segment: this.lineSegment(record), endedLine: true };
    }
    return {
      segment:
        this.segments.find((segment) => segment.itemId === itemId) ??
        this.createSegment(
          itemId,
          source.nextCommit()?.speaker ?? this.controllerSpeaker(),
          source.nextPlace(),
        ),
      endedLine: false,
    };
  }

  private async applyLineFinal(
    source: LineSource,
    itemId: string,
    transcript: string,
  ): Promise<void> {
    const { segment, endedLine } = this.endLineFor(source, itemId);
    source.changed();
    await this.saveFinalSegment(segment, transcript, endedLine);
  }

  /**
   * One acknowledged item a replaced provider could not transcribe: only
   * that item becomes a gap, words already on screen are kept, and the drain
   * goes on until every other line is final, failed or late.
   */
  private async applyLineFailure(source: LineSource, itemId: string): Promise<void> {
    const { segment, endedLine } = this.endLineFor(source, itemId);
    console.warn(
      "[Transcript] A replaced provider failed one acknowledged line; it was not captioned.",
      JSON.stringify({ epoch: source.drain?.epoch, provider: source.drain?.session.provider }),
    );
    source.changed();
    await this.saveFinalSegment(
      segment,
      segment.text.trim() ? "" : TRANSCRIPTION_GAP_MARKER,
      endedLine,
    );
  }

  private armLiveLineTimer(): void {
    if (this.liveLineTimer !== null) clearTimeout(this.liveLineTimer);
    this.liveLineTimer = null;
    const next = this.liveLines.nextDeadline();
    if (next === null) return;
    this.liveLineTimer = setTimeout(() => {
      this.liveLineTimer = null;
      void this.endOverdueLiveLines();
    }, Math.max(0, next - Date.now()));
  }

  private clearLiveLineTimer(): void {
    if (this.liveLineTimer !== null) clearTimeout(this.liveLineTimer);
    this.liveLineTimer = null;
  }

  /** A line the provider never finished ends at its deadline; a later final still fills its place. */
  private async endOverdueLiveLines(): Promise<void> {
    const changed = this.endUnfinishedLines(
      this.liveLines.takeDue(Date.now()),
      "The provider did not finish in time",
      this.transcriptionSession?.provider ?? "none",
    );
    this.armLiveLineTimer();
    if (changed) {
      await this.persist();
      this.scheduleMinutes();
    }
  }

  private resetTranscriptionAudioState(): void {
    const hadPartials = this.liveLines.shown().length > 0;
    this.liveLines.audioOwner = null;
    this.lastAudioAt = 0;
    this.transcriptionReplayJournal.reset();
    this.latestSpeaker = null;
    this.hasPendingAudio = false;
    this.pendingAudioSamples = 0;
    this.pendingCommits = [];
    if (this.transcriptionCommitWatchdogTimer !== null) {
      clearTimeout(this.transcriptionCommitWatchdogTimer);
      this.transcriptionCommitWatchdogTimer = null;
    }
    if (hadPartials) {
      this.broadcast({ type: "partials.reset" });
    }
  }

  private acknowledgeTranscriptionCommit(): PendingCommit | null {
    const commit = this.pendingCommits.shift() ?? null;
    this.armTranscriptionCommitWatchdog();
    return commit;
  }

  private armTranscriptionCommitWatchdog(): void {
    if (this.transcriptionCommitWatchdogTimer !== null) {
      clearTimeout(this.transcriptionCommitWatchdogTimer);
      this.transcriptionCommitWatchdogTimer = null;
    }
    const oldestCommitAt = this.pendingCommits[0]?.at;
    if (oldestCommitAt === undefined) return;
    const delay = Math.max(
      0,
      oldestCommitAt + TRANSCRIPTION_COMMIT_ACK_TIMEOUT_MS - Date.now(),
    );
    this.transcriptionCommitWatchdogTimer = setTimeout(() => {
      this.transcriptionCommitWatchdogTimer = null;
      const currentOldestCommitAt = this.pendingCommits[0]?.at;
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

    // Every line stays owed and saved through the handoff, until the
    // replacement's ack of its own replayed audio claims it.
    const replayEvents = this.transcriptionReplayJournal.takeRecoveryEvents(
      Date.now(),
      this.liveLines.audioOwner,
    );
    const hadPartials = this.liveLines.shown().length > 0;
    this.liveLines.awaitReplacement(
      new Set(replayEvents.flatMap((event) => (event.type === "commit" && event.owner ? [event.owner] : []))),
    );
    this.clearLiveLineTimer();
    if (hadPartials) this.broadcast({ type: "partials.reset" });
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
      this.liveLines.limitAwaiting(this.lineDeadline());
      this.armLiveLineTimer();
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
    this.replayingLines = true;
    try {
      return this.replayEvents(events, reportFailure);
    } finally {
      this.replayingLines = false;
    }
  }

  private replayEvents(
    events: BufferedTranscriptAudioEvent[],
    reportFailure: boolean,
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
              event.owner ?? null,
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
          this.liveLines.audioOwner = null;
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

  /** A line's speaker is the speaker of its own audio; its words and any final follow it. */
  private setLineSpeaker(record: LineRecord, speaker: TranscriptSpeaker): void {
    record.speaker = speaker;
    const partial = record.shown;
    if (partial && !this.hasSegmentSpeaker(partial, speaker)) {
      const now = Date.now();
      const next: TranscriptSegment = {
        ...partial,
        speakerUserId: speaker.userId,
        speakerDisplayName: speaker.displayName,
        source: speaker.source,
        updatedAt: now,
      };
      record.shown = next;
      this.broadcast({
        type: "segment.delta",
        delta: this.toSegmentDelta(next, "", now),
      });
    }

    const finalIndex = this.segments.findIndex(
      (candidate) => candidate.itemId === record.itemId,
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

  /** Shows a final in its place; a line that ends with no words still drops its saved place. */
  private async saveFinalSegment(
    segment: TranscriptSegment,
    transcript: string,
    endedLine = false,
  ): Promise<void> {
    if (!this.recordFinalSegment(segment, transcript)) {
      if (endedLine) await this.persist();
      return;
    }
    await this.persist();
    this.scheduleMinutes();
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
  }

  private markTakeoverNeeded(error: string): void {
    this.sessionRevision += 1;
    this.cancelControllerReconnect();
    this.cancelSfuRelayRecovery();
    this.endUnfinishedLines(
      this.liveLines.takeAll(),
      "Transcription stopped for a takeover",
      this.transcriptionSession?.provider ?? "none",
    );
    this.closeTranscriptionProvider();
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
    this.closeTranscriptionProvider();
    this.discardProviderDrains();
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
