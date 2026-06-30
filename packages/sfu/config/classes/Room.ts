import type {
  AudioLevelObserver,
  MediaKind,
  PlainTransport,
  Producer,
  Router,
  RtpCapabilities,
  WebRtcTransport,
} from "mediasoup/types";
import type { Socket } from "socket.io";
import { createHmac, timingSafeEqual } from "node:crypto";
import {
  Awareness,
  applyAwarenessUpdate,
  encodeAwarenessUpdate,
  removeAwarenessStates,
} from "y-protocols/awareness";
import * as Y from "yjs";
import type { ChatMessage, ProducerInfo, VideoQuality } from "../../types.js";
import { Logger } from "../../utilities/loggers.js";
import { config } from "../config.js";
import { Admin } from "./Admin.js";
import type { Client } from "./Client.js";
import type { ProducerType } from "./Client.js";
import type { GameSession } from "../../server/games/engine.js";

export interface RoomOptions {
  id: string;
  router: Router;
  clientId: string;
  workerPid: number | null;
}

type AppAwarenessRemoval = {
  appId: string;
  awarenessUpdate: Uint8Array;
};

type ProducerIndexEntry = {
  producer: Producer;
  userId: string;
  type: ProducerType;
  system: boolean;
};

export type TranscriptAudioProducerEntry = {
  producer: Producer;
  producerId: string;
  userId: string;
  displayName: string;
  type: ProducerType;
  paused: boolean;
};

const WEBINAR_AUDIO_LEVEL_THRESHOLD = -70;
const WEBINAR_AUDIO_LEVEL_INTERVAL_MS = 350;
const CHAT_HISTORY_LIMIT = 100;
const MAX_INVITE_CODE_LENGTH = 256;
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f]/;

const normalizeInviteCode = (value: unknown): string => {
  if (typeof value !== "string") {
    return "";
  }
  const normalized = value.trim();
  if (
    !normalized ||
    normalized.length > MAX_INVITE_CODE_LENGTH ||
    CONTROL_CHARACTER_PATTERN.test(normalized)
  ) {
    return "";
  }
  return normalized;
};

const getAwarenessStateUserId = (state: unknown): string | null => {
  if (!state || typeof state !== "object" || Array.isArray(state)) {
    return null;
  }
  const record = state as { user?: unknown };
  if (
    !record.user ||
    typeof record.user !== "object" ||
    Array.isArray(record.user)
  ) {
    return null;
  }
  const user = record.user as { id?: unknown };
  return typeof user.id === "string" ? user.id : null;
};

const hashInviteCode = (inviteCode: string): string =>
  createHmac("sha256", config.sfuSecret).update(inviteCode).digest("hex");

const verifyInviteCodeHash = (
  inviteCode: string,
  expectedHash: string,
): boolean => {
  const candidateHash = hashInviteCode(inviteCode);
  const expected = Buffer.from(expectedHash, "hex");
  const candidate = Buffer.from(candidateHash, "hex");

  if (expected.length !== candidate.length) {
    return false;
  }

  return timingSafeEqual(expected, candidate);
};

export class Room {
  public readonly id: string;
  public readonly router: Router;
  public readonly clientId: string;
  public readonly workerPid: number | null;
  public readonly channelId: string;
  public clients: Map<string, Client> = new Map();
  public pendingClients: Map<
    string,
    { userKey: string; userId: string; socket: Socket; displayName?: string }
  > = new Map();
  public pendingDisconnects: Map<
    string,
    {
      timeout: NodeJS.Timeout;
      socketId: string;
      startedAt: number;
      notificationTimeout?: NodeJS.Timeout;
      notificationEmittedAt?: number;
    }
  > = new Map();
  public allowedUsers: Set<string> = new Set();
  public currentScreenShareProducerId: string | null = null;
  public currentQuality: VideoQuality = "standard";
  public userKeysById: Map<string, string> = new Map();
  public adminUserKeys: Set<string> = new Set();
  public displayNamesByKey: Map<string, string> = new Map();
  public handRaisedByUserId: Set<string> = new Set();
  private recentChatMessages: ChatMessage[] = [];
  public lockedAllowedUsers: Set<string> = new Set();
  public blockedUsers: Set<string> = new Set();
  public cleanupTimer: NodeJS.Timeout | null = null;
  public hostUserKey: string | null = null;
  private _isLocked: boolean = false;
  private _isChatLocked: boolean = false;
  private _noGuests: boolean = false;
  private _isTtsDisabled: boolean = false;
  private _isDmEnabled: boolean = true;
  private _reactionsDisabled: boolean = false;
  private _meetingInviteCodeHash: string | null = null;
  public appsState: { activeAppId: string | null; locked: boolean } = {
    activeAppId: null,
    locked: false,
  };
  private appsDocs: Map<string, Y.Doc> = new Map();
  private appsAwareness: Map<string, Awareness> = new Map();
  private appAwarenessClientIdsByUser: Map<string, Map<string, Set<number>>> =
    new Map();
  // Server-authoritative game runtime (parallel to the collaborative apps
  // relay above). At most one game runs per room. The tick timer is owned here
  // so it is torn down with the room; the handler layer drives broadcasts.
  public gameSession: GameSession | null = null;
  public gameTickTimer: NodeJS.Timeout | null = null;
  // Pre-game vote: the host can let the room vote on which game to play.
  public gameVote: { candidates: string[]; votes: Record<string, string> } | null = null;
  private systemProducers: Map<
    string,
    { producer: Producer; userId: string; type: ProducerType }
  > = new Map();
  private producerIndex: Map<string, ProducerIndexEntry> = new Map();
  private webinarActiveSpeakerUserId: string | null = null;
  private webinarDominantSpeakerUserId: string | null = null;
  private webinarFeedProducerIds: string[] = [];
  private webinarAudioLevelObserver: AudioLevelObserver | null = null;
  private webinarAudioLevelObserverInit: Promise<void> | null = null;
  private webinarWebcamAudioProducerOwners: Map<string, string> = new Map();
  private webinarFeedRefreshNotifier: ((room: Room) => void) | null = null;
  private webinarAttendeeCount = 0;
  private meetingParticipantCount = 0;

  constructor(options: RoomOptions) {
    this.id = options.id;
    this.router = options.router;
    this.clientId = options.clientId;
    this.workerPid = options.workerPid;
    this.channelId = `${options.clientId}:${options.id}`;
  }

  get rtpCapabilities(): RtpCapabilities {
    return this.router.rtpCapabilities;
  }

  private updateClientModeCounts(client: Client, delta: 1 | -1): void {
    if (client.isWebinarAttendee) {
      this.webinarAttendeeCount += delta;
      return;
    }
    if (!client.isObserver) {
      this.meetingParticipantCount += delta;
    }
  }

  addClient(client: Client): void {
    const existing = this.clients.get(client.id);
    if (existing) {
      this.updateClientModeCounts(existing, -1);
    }
    this.clients.set(client.id, client);
    this.updateClientModeCounts(client, 1);
  }

  setUserIdentity(
    userId: string,
    userKey: string,
    displayName: string,
    options?: { forceDisplayName?: boolean },
  ): void {
    this.userKeysById.set(userId, userKey);
    if (options?.forceDisplayName || !this.displayNamesByKey.has(userKey)) {
      this.displayNamesByKey.set(userKey, displayName);
    }
  }

  getDisplayNameForUser(userId: string): string | undefined {
    const userKey = this.userKeysById.get(userId);
    if (!userKey) return undefined;
    return this.displayNamesByKey.get(userKey);
  }

  getDisplayNameSnapshot(options?: {
    includeWebinarAttendees?: boolean;
  }): { userId: string; displayName: string }[] {
    const snapshot: { userId: string; displayName: string }[] = [];
    for (const [userId, client] of this.clients.entries()) {
      if (client.isGhost) continue;
      if (client.isWebinarAttendee && !options?.includeWebinarAttendees) {
        continue;
      }
      const displayName = this.getDisplayNameForUser(userId) || userId;
      snapshot.push({ userId, displayName });
    }
    return snapshot;
  }

  updateDisplayName(userKey: string, displayName: string): string[] {
    this.displayNamesByKey.set(userKey, displayName);
    const userIds: string[] = [];
    for (const [userId, key] of this.userKeysById.entries()) {
      if (key === userKey) {
        userIds.push(userId);
      }
    }
    return userIds;
  }

  removeClient(clientId: string): Client | undefined {
    const client = this.clients.get(clientId);
    const pending = this.pendingDisconnects.get(clientId);
    if (pending) {
      clearTimeout(pending.timeout);
      if (pending.notificationTimeout) {
        clearTimeout(pending.notificationTimeout);
      }
      this.pendingDisconnects.delete(clientId);
    }
    if (client) {
      this.updateClientModeCounts(client, -1);
      this.clearWebinarAudioProducersForUser(clientId);
      this.removeClientProducerIndexes(clientId);
      client.close();
      this.clients.delete(clientId);
    }
    const departingUserKey = this.userKeysById.get(clientId);
    this.userKeysById.delete(clientId);
    this.handRaisedByUserId.delete(clientId);
    // Drop the cached display name once NO live client still shares this userKey
    // (a user may be joined from two tabs under one key). Without this,
    // displayNamesByKey is only cleared on full room teardown, so a long-lived
    // room accumulates an entry for every rotating client-minted guest identity
    // that ever joined, causing unbounded heap growth and eventual OOM.
    if (departingUserKey !== undefined) {
      let stillPresent = false;
      for (const key of this.userKeysById.values()) {
        if (key === departingUserKey) {
          stillPresent = true;
          break;
        }
      }
      if (!stillPresent) {
        this.displayNamesByKey.delete(departingUserKey);
      }
    }
    if (this.webinarActiveSpeakerUserId === clientId) {
      this.webinarActiveSpeakerUserId = null;
    }
    if (this.webinarDominantSpeakerUserId === clientId) {
      this.webinarDominantSpeakerUserId = null;
    }
    return client;
  }

  setHandRaised(userId: string, raised: boolean): void {
    if (raised) {
      this.handRaisedByUserId.add(userId);
    } else {
      this.handRaisedByUserId.delete(userId);
    }
  }

  getHandRaisedSnapshot(): { userId: string; raised: boolean }[] {
    const snapshot: { userId: string; raised: boolean }[] = [];
    for (const userId of this.handRaisedByUserId) {
      const client = this.clients.get(userId);
      if (!client || client.isObserver) continue;
      snapshot.push({ userId, raised: true });
    }
    return snapshot;
  }

  // Retain the most recent broadcast (non-DM) chat messages so a late-joining
  // or refreshing client can be seeded with prior conversation. Direct messages
  // are intentionally excluded: they are only ever delivered to the sender and
  // target, so they must not be replayed to other participants on join.
  recordChatMessage(message: ChatMessage): void {
    if (message.isDirect) {
      return;
    }
    this.recentChatMessages.push(message);
    if (this.recentChatMessages.length > CHAT_HISTORY_LIMIT) {
      this.recentChatMessages.splice(
        0,
        this.recentChatMessages.length - CHAT_HISTORY_LIMIT,
      );
    }
  }

  getChatHistorySnapshot(): ChatMessage[] {
    return this.recentChatMessages.slice();
  }

  getClient(clientId: string): Client | undefined {
    return this.clients.get(clientId);
  }

  getOtherClients(excludeClientId: string): Client[] {
    const others: Client[] = [];
    for (const [id, client] of this.clients) {
      if (id !== excludeClientId) {
        others.push(client);
      }
    }
    return others;
  }

  getWebinarAttendeeCount(): number {
    return this.webinarAttendeeCount;
  }

  getMeetingParticipantCount(): number {
    return this.meetingParticipantCount;
  }

  async createWebRtcTransport(): Promise<WebRtcTransport> {
    const transport = await this.router.createWebRtcTransport({
      listenIps: config.webRtcTransport.listenIps,
      enableUdp: true,
      enableTcp: true,
      preferUdp: true,
      initialAvailableOutgoingBitrate:
        config.webRtcTransport.initialAvailableOutgoingBitrate,
    });

    if (config.webRtcTransport.maxIncomingBitrate) {
      await transport.setMaxIncomingBitrate(
        config.webRtcTransport.maxIncomingBitrate,
      );
    }

    return transport;
  }

  setWebinarFeedRefreshNotifier(
    notifier: ((room: Room) => void) | null,
  ): void {
    this.webinarFeedRefreshNotifier = notifier;
  }

  private requestWebinarFeedRefresh(): void {
    try {
      this.webinarFeedRefreshNotifier?.(this);
    } catch (error) {
      Logger.error(
        `Room ${this.id}: Failed to notify webinar feed refresh`,
        error,
      );
    }
  }

  private async ensureWebinarAudioLevelObserver(): Promise<void> {
    if (this.webinarAudioLevelObserver) {
      return;
    }

    if (!this.webinarAudioLevelObserverInit) {
      this.webinarAudioLevelObserverInit = (async () => {
        try {
          const observer = await this.router.createAudioLevelObserver({
            maxEntries: 1,
            threshold: WEBINAR_AUDIO_LEVEL_THRESHOLD,
            interval: WEBINAR_AUDIO_LEVEL_INTERVAL_MS,
          });

          observer.on("volumes", (volumes) => {
            const loudestProducer = volumes[0]?.producer;
            if (!loudestProducer) {
              return;
            }

            const ownerUserId = this.webinarWebcamAudioProducerOwners.get(
              loudestProducer.id,
            );
            if (!ownerUserId) {
              return;
            }

            const ownerClient = this.clients.get(ownerUserId);
            if (
              !ownerClient ||
              ownerClient.isGhost ||
              ownerClient.isWebinarAttendee ||
              !this.clientHasUnpausedWebcamAudio(ownerClient)
            ) {
              return;
            }

            if (this.webinarDominantSpeakerUserId === ownerUserId) {
              return;
            }

            this.webinarDominantSpeakerUserId = ownerUserId;
            this.requestWebinarFeedRefresh();
          });

          observer.on("silence", () => {
            if (!this.webinarDominantSpeakerUserId) {
              return;
            }

            const dominantClient = this.clients.get(
              this.webinarDominantSpeakerUserId,
            );
            if (
              dominantClient &&
              !dominantClient.isGhost &&
              !dominantClient.isWebinarAttendee &&
              this.clientHasUnpausedWebcamAudio(dominantClient)
            ) {
              return;
            }

            this.webinarDominantSpeakerUserId = null;
            this.requestWebinarFeedRefresh();
          });

          this.webinarAudioLevelObserver = observer;
        } catch (error) {
          Logger.warn(
            `Room ${this.id}: Failed to initialize audio level observer`,
            error,
          );
        } finally {
          this.webinarAudioLevelObserverInit = null;
        }
      })();
    }

    await this.webinarAudioLevelObserverInit;
  }

  async registerWebinarAudioProducer(
    userId: string,
    producer: Producer,
    type: ProducerType,
  ): Promise<void> {
    if (type !== "webcam" || producer.kind !== "audio") {
      return;
    }

    await this.ensureWebinarAudioLevelObserver();
    if (!this.webinarAudioLevelObserver) {
      return;
    }

    this.webinarWebcamAudioProducerOwners.set(producer.id, userId);

    try {
      await this.webinarAudioLevelObserver.addProducer({
        producerId: producer.id,
      });
    } catch (error) {
      this.webinarWebcamAudioProducerOwners.delete(producer.id);
      Logger.warn(
        `Room ${this.id}: Failed to observe webinar audio producer ${producer.id}`,
        error,
      );
      return;
    }

    let cleaned = false;
    const cleanup = () => {
      if (cleaned) return;
      cleaned = true;
      void this.unregisterWebinarAudioProducer(producer.id);
    };

    producer.on("transportclose", cleanup);
    producer.observer.on("close", cleanup);
  }

  private async unregisterWebinarAudioProducer(
    producerId: string,
  ): Promise<void> {
    const ownerUserId = this.webinarWebcamAudioProducerOwners.get(producerId);
    this.webinarWebcamAudioProducerOwners.delete(producerId);

    if (this.webinarAudioLevelObserver) {
      try {
        await this.webinarAudioLevelObserver.removeProducer({ producerId });
      } catch {
        // Ignore remove races when producer already disappeared.
      }
    }

    if (
      ownerUserId &&
      this.webinarDominantSpeakerUserId === ownerUserId &&
      !Array.from(this.webinarWebcamAudioProducerOwners.values()).some(
        (value) => value === ownerUserId,
      )
    ) {
      this.webinarDominantSpeakerUserId = null;
      this.requestWebinarFeedRefresh();
    }
  }

  private clearWebinarAudioProducersForUser(userId: string): void {
    const producerIds = Array.from(
      this.webinarWebcamAudioProducerOwners.entries(),
    )
      .filter(([, ownerUserId]) => ownerUserId === userId)
      .map(([producerId]) => producerId);

    for (const producerId of producerIds) {
      void this.unregisterWebinarAudioProducer(producerId);
    }

    if (this.webinarDominantSpeakerUserId === userId) {
      this.webinarDominantSpeakerUserId = null;
    }
  }

  async createPlainTransport(): Promise<PlainTransport> {
    const transport = await this.router.createPlainTransport({
      listenIp: {
        ip: config.plainTransport.listenIp,
        announcedIp: config.plainTransport.announcedIp || undefined,
      },
      rtcpMux: false,
      comedia: true,
    });

    return transport;
  }

  get screenShareProducerId(): string | null {
    return this.currentScreenShareProducerId;
  }

  setScreenShareProducer(producerId: string) {
    this.currentScreenShareProducerId = producerId;
  }

  clearScreenShareProducer(producerId: string) {
    if (this.currentScreenShareProducerId === producerId) {
      this.currentScreenShareProducerId = null;
    }
  }

  replaceScreenShareProducerForUser(
    producerId: string,
    userId: string,
  ): boolean {
    const entry = this.producerIndex.get(producerId);
    if (
      !entry ||
      entry.system ||
      entry.userId !== userId ||
      entry.type !== "screen" ||
      entry.producer.kind !== "video"
    ) {
      this.clearScreenShareProducer(producerId);
      return false;
    }

    this.clearScreenShareProducer(producerId);
    this.removeProducerIndexById(producerId, entry.producer);
    const owner = this.clients.get(userId);
    const screenAudioProducer = owner?.getProducer("audio", "screen");
    if (screenAudioProducer && screenAudioProducer.id !== producerId) {
      this.removeProducerIndexById(screenAudioProducer.id, screenAudioProducer);
      try {
        screenAudioProducer.close();
      } catch {}
    }
    try {
      entry.producer.close();
    } catch {}
    return true;
  }

  private producerInfoFromIndexEntry(entry: ProducerIndexEntry): ProducerInfo {
    return {
      producerId: entry.producer.id,
      producerUserId: entry.userId,
      kind: entry.producer.kind,
      type: entry.type,
      paused: entry.producer.paused,
    };
  }

  private isProducerIndexEntryActive(
    producerId: string,
    entry: ProducerIndexEntry,
  ): boolean {
    if (entry.producer.id !== producerId || entry.producer.closed) {
      return false;
    }
    if (entry.system) {
      return this.systemProducers.get(producerId)?.producer.id === producerId;
    }
    const owner = this.clients.get(entry.userId);
    return Boolean(owner && !owner.isObserver);
  }

  private indexProducer(entry: ProducerIndexEntry): void {
    this.producerIndex.set(entry.producer.id, entry);

    const cleanup = () => {
      this.removeProducerIndexById(entry.producer.id, entry.producer);
    };

    entry.producer.on("transportclose", cleanup);
    entry.producer.observer.on("close", cleanup);
  }

  removeProducerIndexById(producerId: string, producer?: Producer): void {
    const activeEntry = this.producerIndex.get(producerId);
    if (!activeEntry) {
      return;
    }
    if (producer && activeEntry.producer.id !== producer.id) {
      return;
    }
    this.producerIndex.delete(producerId);
  }

  private removeClientProducerIndexes(userId: string): void {
    for (const [producerId, entry] of this.producerIndex) {
      if (!entry.system && entry.userId === userId) {
        this.producerIndex.delete(producerId);
      }
    }
  }

  getAllProducers(excludeClientId?: string): ProducerInfo[] {
    const producers: ProducerInfo[] = [];

    for (const [producerId, entry] of this.producerIndex) {
      if (!this.isProducerIndexEntryActive(producerId, entry)) {
        this.producerIndex.delete(producerId);
        continue;
      }
      if (excludeClientId && entry.userId === excludeClientId) {
        continue;
      }
      const producerClient = this.clients.get(entry.userId);
      if (producerClient?.isGhost) {
        continue;
      }
      producers.push(this.producerInfoFromIndexEntry(entry));
    }

    return producers;
  }

  getProducerInfoById(producerId: string): ProducerInfo | null {
    const entry = this.producerIndex.get(producerId);
    if (!entry) {
      return null;
    }
    if (!this.isProducerIndexEntryActive(producerId, entry)) {
      this.producerIndex.delete(producerId);
      return null;
    }
    return this.producerInfoFromIndexEntry(entry);
  }

  getTranscriptAudioProducerEntries(): TranscriptAudioProducerEntry[] {
    const entries: TranscriptAudioProducerEntry[] = [];
    for (const [producerId, entry] of this.producerIndex) {
      if (!this.isProducerIndexEntryActive(producerId, entry)) {
        this.producerIndex.delete(producerId);
        continue;
      }
      if (entry.producer.kind !== "audio") {
        continue;
      }
      const owner = this.clients.get(entry.userId);
      if (!owner || owner.isGhost || owner.isWebinarAttendee) {
        continue;
      }
      entries.push({
        producer: entry.producer,
        producerId,
        userId: entry.userId,
        displayName: this.getDisplayNameForUser(entry.userId) || entry.userId,
        type: entry.type,
        paused: entry.producer.paused,
      });
    }
    return entries;
  }

  indexClientProducer(
    userId: string,
    producer: Producer,
    type: ProducerType,
  ): void {
    for (const [producerId, entry] of this.producerIndex) {
      if (
        !entry.system &&
        entry.userId === userId &&
        entry.type === type &&
        entry.producer.kind === producer.kind &&
        producerId !== producer.id
      ) {
        this.producerIndex.delete(producerId);
      }
    }
    this.indexProducer({ producer, userId, type, system: false });
  }

  addSystemProducer(
    producer: Producer,
    userId: string,
    type: ProducerType,
  ): void {
    this.systemProducers.set(producer.id, { producer, userId, type });
    this.indexProducer({ producer, userId, type, system: true });

    const cleanup = () => {
      this.systemProducers.delete(producer.id);
      this.removeProducerIndexById(producer.id, producer);
    };

    producer.on("transportclose", cleanup);
    producer.observer.on("close", cleanup);
  }

  removeSystemProducerById(producerId: string): void {
    this.systemProducers.delete(producerId);
    this.removeProducerIndexById(producerId);
  }

  canConsume(producerId: string, rtpCapabilities: RtpCapabilities): boolean {
    return this.router.canConsume({ producerId, rtpCapabilities });
  }

  isEmpty(): boolean {
    return this.clients.size === 0 && this.pendingClients.size === 0;
  }

  get isLocked(): boolean {
    return this._isLocked;
  }

  setLocked(locked: boolean): void {
    this._isLocked = locked;
    if (locked) {
      this.lockedAllowedUsers.clear();
    }
  }

  get isChatLocked(): boolean {
    return this._isChatLocked;
  }

  setChatLocked(locked: boolean): void {
    this._isChatLocked = locked;
  }

  get noGuests(): boolean {
    return this._noGuests;
  }

  setNoGuests(noGuests: boolean): void {
    this._noGuests = noGuests;
  }

  get isTtsDisabled(): boolean {
    return this._isTtsDisabled;
  }

  setTtsDisabled(disabled: boolean): void {
    this._isTtsDisabled = disabled;
  }

  get isDmEnabled(): boolean {
    return this._isDmEnabled;
  }

  setDmEnabled(enabled: boolean): void {
    this._isDmEnabled = enabled;
  }

  get isReactionsDisabled(): boolean {
    return this._reactionsDisabled;
  }

  setReactionsDisabled(disabled: boolean): void {
    this._reactionsDisabled = disabled;
  }

  get requiresMeetingInviteCode(): boolean {
    return Boolean(this._meetingInviteCodeHash);
  }

  setMeetingInviteCode(inviteCode: string | null): boolean {
    const normalizedInviteCode = normalizeInviteCode(inviteCode);
    const nextHash = normalizedInviteCode
      ? hashInviteCode(normalizedInviteCode)
      : null;
    if (this._meetingInviteCodeHash === nextHash) {
      return false;
    }
    this._meetingInviteCodeHash = nextHash;
    return true;
  }

  verifyMeetingInviteCode(inviteCode: string): boolean {
    if (!this._meetingInviteCodeHash) {
      return true;
    }
    const normalizedInviteCode = inviteCode.trim();
    if (!normalizedInviteCode) {
      return false;
    }
    if (
      normalizedInviteCode.length > MAX_INVITE_CODE_LENGTH ||
      CONTROL_CHARACTER_PATTERN.test(normalizedInviteCode)
    ) {
      return false;
    }
    return verifyInviteCodeHash(
      normalizedInviteCode,
      this._meetingInviteCodeHash,
    );
  }

  getAdmins(): Admin[] {
    const admins: Admin[] = [];
    for (const client of this.clients.values()) {
      if (client instanceof Admin && !client.isGhost) {
        admins.push(client);
      }
    }
    return admins;
  }

  getAdminUserIds(): string[] {
    const userIds: string[] = [];
    for (const client of this.clients.values()) {
      if (client instanceof Admin && !client.isGhost) {
        userIds.push(client.id);
      }
    }
    return userIds;
  }

  registerAdminUserKey(userKey: string): void {
    this.adminUserKeys.add(userKey);
  }

  isAdminUserKey(userKey: string): boolean {
    return this.adminUserKeys.has(userKey);
  }

  promoteClientToAdmin(userId: string): Admin | null {
    const client = this.clients.get(userId);
    if (!client || client.isGhost || client.isWebinarAttendee) {
      return null;
    }
    if (!(client instanceof Admin)) {
      Object.setPrototypeOf(client, Admin.prototype);
    }
    const userKey = this.userKeysById.get(userId);
    if (userKey) {
      this.adminUserKeys.add(userKey);
    }
    return client as Admin;
  }

  getHostUserId(): string | null {
    if (this.hostUserKey) {
      for (const [userId, userKey] of this.userKeysById.entries()) {
        if (userKey !== this.hostUserKey) continue;
        const client = this.clients.get(userId);
        if (client instanceof Admin && !client.isGhost) {
          return userId;
        }
      }
    }

    const fallbackAdmin = this.getAdmins()[0];
    return fallbackAdmin?.id ?? null;
  }

  hasActiveAdmin(): boolean {
    for (const client of this.clients.values()) {
      if (client instanceof Admin && !client.isGhost) {
        return true;
      }
    }
    return false;
  }

  private clientHasUnpausedWebcamAudio(client: Client): boolean {
    for (const info of client.getProducerInfos()) {
      if (info.kind === "audio" && info.type === "webcam" && !info.paused) {
        return true;
      }
    }
    return false;
  }

  private clientHasUnpausedWebcamVideo(client: Client): boolean {
    for (const info of client.getProducerInfos()) {
      if (info.kind === "video" && info.type === "webcam" && !info.paused) {
        return true;
      }
    }
    return false;
  }

  private getClientFeedProducers(userId: string | null): ProducerInfo[] {
    if (!userId) return [];
    const client = this.clients.get(userId);
    if (!client || client.isGhost || client.isWebinarAttendee) {
      return [];
    }

    const producers: ProducerInfo[] = client.getProducerInfos().map((info) => ({
      producerId: info.producerId,
      producerUserId: userId,
      kind: info.kind,
      type: info.type,
      paused: info.paused,
    }));

    producers.sort((a, b) => {
      const aKind = a.kind === "audio" ? 0 : 1;
      const bKind = b.kind === "audio" ? 0 : 1;
      if (aKind !== bKind) return aKind - bKind;
      const aType = a.type === "webcam" ? 0 : 1;
      const bType = b.type === "webcam" ? 0 : 1;
      return aType - bType;
    });

    return producers;
  }

  private getScreenShareOwnerUserId(): string | null {
    const screenShareProducerId = this.currentScreenShareProducerId;
    if (!screenShareProducerId) {
      return null;
    }

    const entry = this.producerIndex.get(screenShareProducerId);
    if (!entry || entry.system || entry.type !== "screen") {
      return null;
    }

    const owner = this.clients.get(entry.userId);
    if (!owner || owner.isObserver) {
      return null;
    }
    return entry.userId;
  }

  private selectWebinarActiveSpeakerUserId(): string | null {
    const candidates = Array.from(this.clients.entries()).filter(
      ([, client]) => !client.isObserver,
    );

    if (!candidates.length) {
      return null;
    }

    if (this.webinarDominantSpeakerUserId) {
      const dominant = this.clients.get(this.webinarDominantSpeakerUserId);
      if (
        dominant &&
        !dominant.isObserver &&
        this.clientHasUnpausedWebcamAudio(dominant)
      ) {
        return this.webinarDominantSpeakerUserId;
      }
      this.webinarDominantSpeakerUserId = null;
    }

    if (this.webinarActiveSpeakerUserId) {
      const current = this.clients.get(this.webinarActiveSpeakerUserId);
      if (
        current &&
        !current.isObserver &&
        this.clientHasUnpausedWebcamAudio(current)
      ) {
        return this.webinarActiveSpeakerUserId;
      }
    }

    for (const [userId, client] of candidates) {
      if (this.clientHasUnpausedWebcamAudio(client)) {
        return userId;
      }
    }

    if (this.webinarActiveSpeakerUserId) {
      const current = this.clients.get(this.webinarActiveSpeakerUserId);
      if (
        current &&
        !current.isObserver &&
        this.clientHasUnpausedWebcamVideo(current)
      ) {
        return this.webinarActiveSpeakerUserId;
      }
    }

    for (const [userId, client] of candidates) {
      if (this.clientHasUnpausedWebcamVideo(client)) {
        return userId;
      }
    }

    if (this.webinarActiveSpeakerUserId) {
      const current = this.clients.get(this.webinarActiveSpeakerUserId);
      if (
        current &&
        !current.isObserver &&
        current.getProducerInfos().length > 0
      ) {
        return this.webinarActiveSpeakerUserId;
      }
    }

    for (const [userId, client] of candidates) {
      if (client.getProducerInfos().length > 0) {
        return userId;
      }
    }

    return null;
  }

  getWebinarFeedSnapshot(): {
    speakerUserId: string | null;
    producers: ProducerInfo[];
  } {
    const screenShareOwnerUserId = this.getScreenShareOwnerUserId();
    if (screenShareOwnerUserId) {
      const screenShareFeedProducers =
        this.getClientFeedProducers(screenShareOwnerUserId);
      if (screenShareFeedProducers.length > 0) {
        return {
          speakerUserId: screenShareOwnerUserId,
          producers: screenShareFeedProducers,
        };
      }
    }

    const speakerUserId = this.selectWebinarActiveSpeakerUserId();
    const producers = this.getClientFeedProducers(speakerUserId);
    return { speakerUserId, producers };
  }

  refreshWebinarFeedSnapshot(): {
    changed: boolean;
    speakerUserId: string | null;
    producers: ProducerInfo[];
  } {
    const snapshot = this.getWebinarFeedSnapshot();
    const producerIds = snapshot.producers
      .map((producer) => producer.producerId)
      .sort();
    const changed =
      this.webinarActiveSpeakerUserId !== snapshot.speakerUserId ||
      this.webinarFeedProducerIds.length !== producerIds.length ||
      this.webinarFeedProducerIds.some((producerId, index) => {
        return producerId !== producerIds[index];
      });

    this.webinarActiveSpeakerUserId = snapshot.speakerUserId;
    this.webinarFeedProducerIds = producerIds;

    return { changed, ...snapshot };
  }

  getTargetVideoQuality(): VideoQuality {
    const { lowThreshold, standardThreshold } = config.videoQuality;
    const participantCount = this.getMeetingParticipantCount();

    if (this.currentQuality === "standard") {
      if (participantCount >= lowThreshold) {
        return "low";
      }
    } else {
      if (participantCount <= standardThreshold) {
        return "standard";
      }
    }
    return this.currentQuality;
  }

  updateVideoQuality(): VideoQuality | null {
    const target = this.getTargetVideoQuality();
    if (target !== this.currentQuality) {
      this.currentQuality = target;
      return target;
    }
    return null;
  }

  private getOrCreateAwarenessUserMap(appId: string): Map<string, Set<number>> {
    const existing = this.appAwarenessClientIdsByUser.get(appId);
    if (existing) return existing;
    const map = new Map<string, Set<number>>();
    this.appAwarenessClientIdsByUser.set(appId, map);
    return map;
  }

  private trackAwarenessClientForUser(
    appId: string,
    userId: string,
    clientId: number,
  ): void {
    const users = this.getOrCreateAwarenessUserMap(appId);
    const existing = users.get(userId);
    if (existing) {
      existing.add(clientId);
      return;
    }
    users.set(userId, new Set([clientId]));
  }

  private untrackAwarenessClientForUser(
    appId: string,
    userId: string,
    clientId: number,
  ): void {
    const users = this.appAwarenessClientIdsByUser.get(appId);
    if (!users) return;
    const clientIds = users.get(userId);
    if (!clientIds) return;
    clientIds.delete(clientId);
    if (clientIds.size === 0) {
      users.delete(userId);
    }
    if (users.size === 0) {
      this.appAwarenessClientIdsByUser.delete(appId);
    }
  }

  getOrCreateAppDoc(appId: string): Y.Doc {
    const existing = this.appsDocs.get(appId);
    if (existing) return existing;
    const doc = new Y.Doc();
    this.appsDocs.set(appId, doc);
    return doc;
  }

  getOrCreateAppAwareness(appId: string): Awareness {
    const existing = this.appsAwareness.get(appId);
    if (existing) return existing;
    const awareness = new Awareness(this.getOrCreateAppDoc(appId));
    this.appsAwareness.set(appId, awareness);
    return awareness;
  }

  applyAppAwarenessUpdate(
    appId: string,
    awarenessUpdate: Uint8Array,
    userId?: string,
    clientId?: number,
  ): void {
    const awareness = this.getOrCreateAppAwareness(appId);
    applyAwarenessUpdate(awareness, awarenessUpdate, userId ?? "socket");
    if (!userId || typeof clientId !== "number" || !Number.isFinite(clientId)) {
      return;
    }
    if (awareness.getStates().has(clientId)) {
      this.trackAwarenessClientForUser(appId, userId, clientId);
      return;
    }
    this.untrackAwarenessClientForUser(appId, userId, clientId);
  }

  encodeAppAwarenessSnapshot(appId: string): Uint8Array | null {
    const awareness = this.appsAwareness.get(appId);
    if (!awareness) return null;
    const clientIds = Array.from(awareness.getStates().keys());
    if (clientIds.length === 0) return null;
    return encodeAwarenessUpdate(awareness, clientIds);
  }

  clearAppAwareness(appId: string): Uint8Array | null {
    const awareness = this.appsAwareness.get(appId);
    this.appAwarenessClientIdsByUser.delete(appId);
    if (!awareness) return null;

    const clientIds = Array.from(awareness.getStates().keys());
    let removalUpdate: Uint8Array | null = null;
    if (clientIds.length > 0) {
      removeAwarenessStates(awareness, clientIds, "app-close");
      removalUpdate = encodeAwarenessUpdate(awareness, clientIds);
    }

    try {
      awareness.destroy();
    } catch {}
    this.appsAwareness.delete(appId);
    return removalUpdate;
  }

  clearAppState(appId: string): Uint8Array | null {
    const awarenessUpdate = this.clearAppAwareness(appId);
    const doc = this.appsDocs.get(appId);
    if (doc) {
      try {
        doc.destroy();
      } catch {}
      this.appsDocs.delete(appId);
    }
    if (this.appsState.activeAppId === appId) {
      this.appsState.activeAppId = null;
      this.appsState.locked = false;
    }
    return awarenessUpdate;
  }

  clearUserAwareness(userId: string): AppAwarenessRemoval[] {
    const removals: AppAwarenessRemoval[] = [];

    const appIds = new Set<string>([
      ...this.appsAwareness.keys(),
      ...this.appAwarenessClientIdsByUser.keys(),
    ]);

    for (const appId of appIds) {
      const awareness = this.appsAwareness.get(appId);
      if (!awareness) {
        continue;
      }

      const users = this.appAwarenessClientIdsByUser.get(appId);
      const trackedClientIds = users?.get(userId);
      if (users) {
        users.delete(userId);
        if (users.size === 0) {
          this.appAwarenessClientIdsByUser.delete(appId);
        }
      }

      const clientIds = new Set<number>(trackedClientIds ?? []);
      if (clientIds.size === 0) {
        for (const [clientId, state] of awareness.getStates().entries()) {
          if (getAwarenessStateUserId(state) === userId) {
            clientIds.add(clientId);
          }
        }
      }

      const removableClientIds = Array.from(clientIds).filter((id) =>
        awareness.meta.has(id),
      );
      if (removableClientIds.length === 0) {
        continue;
      }

      removeAwarenessStates(awareness, removableClientIds, userId);
      removals.push({
        appId,
        awarenessUpdate: encodeAwarenessUpdate(awareness, removableClientIds),
      });
    }

    return removals;
  }

  clearApps(): void {
    for (const awareness of this.appsAwareness.values()) {
      try {
        awareness.destroy();
      } catch {}
    }
    this.appsAwareness.clear();
    this.appAwarenessClientIdsByUser.clear();

    for (const doc of this.appsDocs.values()) {
      try {
        doc.destroy();
      } catch {}
    }
    this.appsDocs.clear();
    this.appsState.activeAppId = null;
    this.appsState.locked = false;
  }

  clearGame(): void {
    if (this.gameTickTimer) {
      clearInterval(this.gameTickTimer);
      this.gameTickTimer = null;
    }
    this.gameSession = null;
    this.gameVote = null;
  }

  close(): void {
    this.stopCleanupTimer();
    for (const pending of this.pendingDisconnects.values()) {
      clearTimeout(pending.timeout);
      if (pending.notificationTimeout) {
        clearTimeout(pending.notificationTimeout);
      }
    }
    this.pendingDisconnects.clear();
    for (const client of this.clients.values()) {
      client.close();
    }
    this.clients.clear();
    this.producerIndex.clear();
    this.webinarAttendeeCount = 0;
    this.meetingParticipantCount = 0;
    this.clearApps();
    this.clearGame();
    if (this.webinarAudioLevelObserver) {
      try {
        this.webinarAudioLevelObserver.close();
      } catch {}
      this.webinarAudioLevelObserver = null;
    }
    this.webinarAudioLevelObserverInit = null;
    this.webinarWebcamAudioProducerOwners.clear();
    this.webinarFeedRefreshNotifier = null;
    if (!this.router.closed) {
      this.router.close();
    }
    this.userKeysById.clear();
    this.adminUserKeys.clear();
    this.displayNamesByKey.clear();
    this.blockedUsers.clear();
    this.webinarActiveSpeakerUserId = null;
    this.webinarDominantSpeakerUserId = null;
    this.webinarFeedProducerIds = [];
    this._meetingInviteCodeHash = null;
  }

  scheduleDisconnect(
    userId: string,
    socketId: string,
    delayMs: number,
    onExpire: () => void,
  ): void {
    this.clearPendingDisconnect(userId);
    const timeout = setTimeout(() => {
      const pending = this.pendingDisconnects.get(userId);
      if (!pending || pending.socketId !== socketId) return;
      this.pendingDisconnects.delete(userId);
      onExpire();
    }, delayMs);
    this.pendingDisconnects.set(userId, {
      timeout,
      socketId,
      startedAt: Date.now(),
    });
  }

  schedulePendingDisconnectNotification(
    userId: string,
    socketId: string,
    delayMs: number,
    onNotify: () => void,
  ): void {
    const pending = this.pendingDisconnects.get(userId);
    if (!pending || pending.socketId !== socketId) return;
    if (pending.notificationTimeout) {
      clearTimeout(pending.notificationTimeout);
    }
    pending.notificationTimeout = setTimeout(() => {
      const current = this.pendingDisconnects.get(userId);
      if (!current || current.socketId !== socketId) return;
      current.notificationTimeout = undefined;
      current.notificationEmittedAt = Date.now();
      onNotify();
    }, delayMs);
  }

  clearPendingDisconnect(userId: string, socketId?: string): boolean {
    const pending = this.pendingDisconnects.get(userId);
    if (!pending) return false;
    if (socketId && pending.socketId !== socketId) return false;
    clearTimeout(pending.timeout);
    if (pending.notificationTimeout) {
      clearTimeout(pending.notificationTimeout);
    }
    this.pendingDisconnects.delete(userId);
    return true;
  }

  hasPendingDisconnect(userId: string, socketId?: string): boolean {
    const pending = this.pendingDisconnects.get(userId);
    if (!pending) return false;
    if (socketId && pending.socketId !== socketId) return false;
    return true;
  }

  getPendingDisconnectStartedAt(userId: string): number | null {
    return this.pendingDisconnects.get(userId)?.startedAt ?? null;
  }

  wasPendingDisconnectNotified(userId: string): boolean {
    return this.pendingDisconnects.get(userId)?.notificationEmittedAt != null;
  }

  startCleanupTimer(callback: () => void) {
    if (this.cleanupTimer) return;

    Logger.debug(
      `Room ${this.id}: Cleanup timer started (${config.adminCleanupTimeout}ms)`,
    );
    this.cleanupTimer = setTimeout(() => {
      Logger.debug(`Room ${this.id}: Cleanup timer expired. Dissolving room.`);
      this.cleanupTimer = null;
      callback();
    }, config.adminCleanupTimeout);
  }

  stopCleanupTimer() {
    if (this.cleanupTimer) {
      Logger.debug(`Room ${this.id}: Cleanup timer stopped.`);
      clearTimeout(this.cleanupTimer);
      this.cleanupTimer = null;
    }
  }

  addPendingClient(
    userKey: string,
    userId: string,
    socket: Socket,
    displayName?: string,
  ) {
    this.pendingClients.set(userKey, { userKey, userId, socket, displayName });
  }

  removePendingClient(userKey: string) {
    this.pendingClients.delete(userKey);
  }

  allowUser(userKey: string) {
    this.blockedUsers.delete(userKey);
    this.allowedUsers.add(userKey);
    this.pendingClients.delete(userKey);
  }

  isAllowed(userKey: string): boolean {
    return this.allowedUsers.has(userKey);
  }

  revokeAllowedUser(userKey: string) {
    this.allowedUsers.delete(userKey);
  }

  allowLockedUser(userKey: string) {
    this.blockedUsers.delete(userKey);
    this.lockedAllowedUsers.add(userKey);
    this.pendingClients.delete(userKey);
  }

  isLockedAllowed(userKey: string): boolean {
    return this.lockedAllowedUsers.has(userKey);
  }

  revokeLockedAllowedUser(userKey: string) {
    this.lockedAllowedUsers.delete(userKey);
  }

  blockUser(userKey: string) {
    this.blockedUsers.add(userKey);
    this.allowedUsers.delete(userKey);
    this.lockedAllowedUsers.delete(userKey);
    this.pendingClients.delete(userKey);
  }

  unblockUser(userKey: string) {
    this.blockedUsers.delete(userKey);
  }

  isBlocked(userKey: string): boolean {
    return this.blockedUsers.has(userKey);
  }
}

export default Room;
