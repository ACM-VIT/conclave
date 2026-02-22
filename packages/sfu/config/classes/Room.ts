import type {
  MediaKind,
  PlainTransport,
  Producer,
  Router,
  RtpCapabilities,
  WebRtcTransport,
} from "mediasoup/types";
import {
  Awareness,
  applyAwarenessUpdate,
  encodeAwarenessUpdate,
  removeAwarenessStates,
} from "y-protocols/awareness";
import * as Y from "yjs";
import type { ProducerInfo, VideoQuality } from "../../types.js";
import { Logger } from "../../utilities/loggers.js";
import { config } from "../config.js";
import { Admin } from "./Admin.js";
import type { Client } from "./Client.js";
import type { ProducerType } from "./Client.js";

export interface RoomOptions {
  id: string;
  router: Router;
  clientId: string;
}

type AppAwarenessRemoval = {
  appId: string;
  awarenessUpdate: Uint8Array;
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

export class Room {
  public readonly id: string;
  public readonly router: Router;
  public readonly clientId: string;
  public readonly channelId: string;
  public clients: Map<string, Client> = new Map();
  public pendingClients: Map<
    string,
    { userKey: string; userId: string; socket: any; displayName?: string }
  > = new Map();
  public pendingDisconnects: Map<
    string,
    { timeout: NodeJS.Timeout; socketId: string }
  > = new Map();
  public allowedUsers: Set<string> = new Set();
  public currentScreenShareProducerId: string | null = null;
  public currentQuality: VideoQuality = "standard";
  public userKeysById: Map<string, string> = new Map();
  public displayNamesByKey: Map<string, string> = new Map();
  public handRaisedByUserId: Set<string> = new Set();
  public lockedAllowedUsers: Set<string> = new Set();
  public cleanupTimer: NodeJS.Timeout | null = null;
  public hostUserKey: string | null = null;
  private _isLocked: boolean = false;
  private _isChatLocked: boolean = false;
  private _noGuests: boolean = false;
  private _isTtsDisabled: boolean = false;
  public appsState: { activeAppId: string | null; locked: boolean } = {
    activeAppId: null,
    locked: false,
  };
  private appsDocs: Map<string, Y.Doc> = new Map();
  private appsAwareness: Map<string, Awareness> = new Map();
  private appAwarenessClientIdsByUser: Map<string, Map<string, Set<number>>> =
    new Map();
  private systemProducers: Map<
    string,
    { producer: Producer; userId: string; type: ProducerType }
  > = new Map();
  private webinarActiveSpeakerUserId: string | null = null;
  private webinarFeedProducerIds: string[] = [];

  constructor(options: RoomOptions) {
    this.id = options.id;
    this.router = options.router;
    this.clientId = options.clientId;
    this.channelId = `${options.clientId}:${options.id}`;
  }

  get rtpCapabilities(): RtpCapabilities {
    return this.router.rtpCapabilities;
  }

  addClient(client: Client): void {
    this.clients.set(client.id, client);
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
    includeGhosts?: boolean;
    includeWebinarAttendees?: boolean;
  }): { userId: string; displayName: string }[] {
    const snapshot: { userId: string; displayName: string }[] = [];
    for (const [userId, client] of this.clients.entries()) {
      if (client.isGhost && !options?.includeGhosts) continue;
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
      this.pendingDisconnects.delete(clientId);
    }
    if (client) {
      client.close();
      this.clients.delete(clientId);
    }
    this.userKeysById.delete(clientId);
    this.handRaisedByUserId.delete(clientId);
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
      snapshot.push({ userId, raised: true });
    }
    return snapshot;
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

  get clientCount(): number {
    return this.clients.size;
  }

  getWebinarAttendeeCount(): number {
    let count = 0;
    for (const client of this.clients.values()) {
      if (client.isWebinarAttendee) {
        count += 1;
      }
    }
    return count;
  }

  getMeetingParticipantCount(): number {
    let count = 0;
    for (const client of this.clients.values()) {
      if (client.isWebinarAttendee) {
        continue;
      }
      count += 1;
    }
    return count;
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

  getAllProducers(excludeClientId?: string): ProducerInfo[] {
    const producers: ProducerInfo[] = [];

    for (const [clientId, client] of this.clients) {
      if (excludeClientId && clientId === excludeClientId) {
        continue;
      }
      if (client.isGhost || client.isWebinarAttendee) {
        continue;
      }
      for (const info of client.getProducerInfos()) {
        producers.push({
          producerId: info.producerId,
          producerUserId: clientId,
          kind: info.kind,
          type: info.type,
          paused: info.paused,
        });
      }
    }

    for (const { producer, userId, type } of this.systemProducers.values()) {
      producers.push({
        producerId: producer.id,
        producerUserId: userId,
        kind: producer.kind,
        type,
        paused: producer.paused,
      });
    }

    return producers;
  }

  addSystemProducer(
    producer: Producer,
    userId: string,
    type: ProducerType,
  ): void {
    this.systemProducers.set(producer.id, { producer, userId, type });

    const cleanup = () => {
      this.systemProducers.delete(producer.id);
    };

    producer.on("transportclose", cleanup);
    producer.observer.on("close", cleanup);
  }

  removeSystemProducerById(producerId: string): void {
    this.systemProducers.delete(producerId);
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

  getAdmins(): Admin[] {
    const admins: Admin[] = [];
    for (const client of this.clients.values()) {
      if (client instanceof Admin) {
        admins.push(client);
      }
    }
    return admins;
  }

  getHostUserId(): string | null {
    if (this.hostUserKey) {
      for (const [userId, userKey] of this.userKeysById.entries()) {
        if (userKey !== this.hostUserKey) continue;
        const client = this.clients.get(userId);
        if (client instanceof Admin) {
          return userId;
        }
      }
    }

    const fallbackAdmin = this.getAdmins()[0];
    return fallbackAdmin?.id ?? null;
  }

  hasActiveAdmin(): boolean {
    for (const client of this.clients.values()) {
      if (client instanceof Admin) {
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

    for (const [userId, client] of this.clients.entries()) {
      if (client.isGhost || client.isWebinarAttendee) {
        continue;
      }

      const ownsScreenShare = client
        .getProducerInfos()
        .some(
          (info) => info.producerId === screenShareProducerId && info.type === "screen",
        );

      if (ownsScreenShare) {
        return userId;
      }
    }

    return null;
  }

  private selectWebinarActiveSpeakerUserId(): string | null {
    const candidates = Array.from(this.clients.entries()).filter(
      ([, client]) => !client.isGhost && !client.isWebinarAttendee,
    );

    if (!candidates.length) {
      return null;
    }

    if (this.webinarActiveSpeakerUserId) {
      const current = this.clients.get(this.webinarActiveSpeakerUserId);
      if (
        current &&
        !current.isGhost &&
        !current.isWebinarAttendee &&
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
        !current.isGhost &&
        !current.isWebinarAttendee &&
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
        !current.isGhost &&
        !current.isWebinarAttendee &&
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
    } catch {
      // ignore
    }
    this.appsAwareness.delete(appId);
    return removalUpdate;
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
      } catch {
        // ignore
      }
    }
    this.appsAwareness.clear();
    this.appAwarenessClientIdsByUser.clear();

    for (const doc of this.appsDocs.values()) {
      try {
        doc.destroy();
      } catch {
        // ignore
      }
    }
    this.appsDocs.clear();
    this.appsState.activeAppId = null;
    this.appsState.locked = false;
  }

  close(): void {
    this.stopCleanupTimer();
    for (const pending of this.pendingDisconnects.values()) {
      clearTimeout(pending.timeout);
    }
    this.pendingDisconnects.clear();
    for (const client of this.clients.values()) {
      client.close();
    }
    this.clients.clear();
    this.clearApps();
    this.router.close();
    this.userKeysById.clear();
    this.displayNamesByKey.clear();
    this.webinarActiveSpeakerUserId = null;
    this.webinarFeedProducerIds = [];
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
    this.pendingDisconnects.set(userId, { timeout, socketId });
  }

  clearPendingDisconnect(userId: string, socketId?: string): boolean {
    const pending = this.pendingDisconnects.get(userId);
    if (!pending) return false;
    if (socketId && pending.socketId !== socketId) return false;
    clearTimeout(pending.timeout);
    this.pendingDisconnects.delete(userId);
    return true;
  }

  hasPendingDisconnect(userId: string, socketId?: string): boolean {
    const pending = this.pendingDisconnects.get(userId);
    if (!pending) return false;
    if (socketId && pending.socketId !== socketId) return false;
    return true;
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
    socket: any,
    displayName?: string,
  ) {
    this.pendingClients.set(userKey, { userKey, userId, socket, displayName });
  }

  removePendingClient(userKey: string) {
    this.pendingClients.delete(userKey);
  }

  allowUser(userKey: string) {
    this.allowedUsers.add(userKey);
    this.pendingClients.delete(userKey);
  }

  isAllowed(userKey: string): boolean {
    return this.allowedUsers.has(userKey);
  }

  allowLockedUser(userKey: string) {
    this.lockedAllowedUsers.add(userKey);
    this.pendingClients.delete(userKey);
  }

  isLockedAllowed(userKey: string): boolean {
    return this.lockedAllowedUsers.has(userKey);
  }
}

export default Room;
