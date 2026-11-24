import { GUEST_SEAT_KEY_PREFIX } from "@conclave/meeting-core/guest-join-claims";
import { isGuestUserKey } from "../../server/identity.js";
import { AdmissionLedger, type AdmissionScope } from "./AdmissionLedger.js";
import { RoomAiCredentials } from "../../server/roomAiCredentials.js";
import { newInviteCodeVersion } from "../../server/inviteCodeVersion.js";
import type {
  AudioLevelObserver,
  PlainTransport,
  Producer,
  Router,
  RtpCapabilities,
  WebRtcServer,
  WebRtcTransport,
} from "mediasoup/types";
import type { Socket } from "socket.io";
import { createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import type { LostRoom } from "../../server/roomRecoveryLedger.js";
import {
  Awareness,
  applyAwarenessUpdate,
  encodeAwarenessUpdate,
  removeAwarenessStates,
} from "y-protocols/awareness";
import * as Y from "yjs";
import type {
  ActiveSpeakerChangedNotification,
  ChatMessage,
  ChatMessageReaction,
  ProducerInfo,
  VideoQuality,
  WebinarHandQueueEntry,
  WebinarQaEntry,
  WebinarQaStatus,
  WebRtcTransportRole,
} from "../../types.js";
import { MAX_REACTIONS_PER_CHAT_MESSAGE } from "../../types.js";
import { Logger } from "../../utilities/loggers.js";
import { config } from "../config.js";
import { Admin } from "./Admin.js";
import { Client } from "./Client.js";
import type { ProducerType } from "./Client.js";
import type { GameSession } from "../../server/games/engine.js";
import {
  buildWebcamCodecPolicy,
  participantsSupportWebcamCodec,
  producerMatchesWebcamCodecPolicy,
  selectRoomWebcamCodec,
  type ClientMediaCapabilities,
  type WebcamCodecPolicy,
} from "../../server/webcamCodecPolicy.js";
import {
  evaluateWebcamReceiverCapacity,
  isVp8SingleLayerProducer,
  WebcamReceiverCapacityProofCoordinator,
  type WebcamReceiverCapacityEvaluation,
  type WebcamReceiverCapacityTransitionReservation,
} from "../../server/webcamReceiverCapacityProof.js";

export interface RoomOptions {
  id: string;
  router: Router;
  webRtcServer?: WebRtcServer;
  clientId: string;
  workerPid: number | null;
  webcamVp9Enabled?: boolean;
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
  seq: number;
};

let lastProducerSeq = 0;

// Clients order producer announcements by this. It only ever increases, and
// it follows the clock so a producer created after a restart still sorts
// after one created before it.
const nextProducerSeq = (): number => {
  lastProducerSeq = Math.max(lastProducerSeq + 1, Date.now());
  return lastProducerSeq;
};

export type TranscriptAudioProducerEntry = {
  producer: Producer;
  producerId: string;
  userId: string;
  displayName: string;
  type: ProducerType;
  paused: boolean;
};

export type RoomChatImageAsset = {
  id: string;
  url: string;
  fileName: string;
  mimeType:
    | "image/jpeg"
    | "image/png"
    | "image/gif"
    | "image/webp"
    | "image/avif";
  size: number;
  data: Buffer;
  uploadedBy: string;
  createdAt: number;
  attached: boolean;
};

const WEBINAR_AUDIO_LEVEL_THRESHOLD = -70;
const WEBINAR_AUDIO_LEVEL_INTERVAL_MS = 350;
const MAX_WEBINAR_QA_ENTRIES = 300;
// The most passes a room records as one guest: a join token names the pass
// a tab joins under and up to 15 others.
export const GUEST_PASS_GROUP_LIMIT = 16;

/** What a host's admission did (see `Room.admitUserKeys`). */
export type AdmitResult =
  | { status: "admitted"; admitted: string[]; refused: string[] }
  | { status: "full"; refused: string[] };

/**
 * What a join shows the room of its guest through the browser's other
 * passes, before anything is recorded (see `Room.planGuestLink`).
 */
export type GuestLinkPlan = {
  readonly guestProof: string;
  // The guest's passes as this join shows them: the ones the room already
  // links to `guestProof`, and the known ones among the browser's others.
  readonly passes: ReadonlySet<string>;
  // A block on any of them refuses the join. Nothing is recorded.
  readonly blocked: boolean;
  // Whether the room may record the passes as one guest. It does not
  // record a guest of more than `GUEST_PASS_GROUP_LIMIT` passes.
  readonly recordable: boolean;
};

// The passes a join may lean on for a right: the plan's, when the room
// would record them, else what the room already links.
const rightsPassesOf = (link: GuestLinkPlan | undefined) =>
  link?.recordable ? link.passes : undefined;

export type Person = {
  readonly userKey: string;
  readonly passes: ReadonlySet<string>;
};
const NO_PASSES: ReadonlySet<string> = new Set();
const MAX_WEBINAR_OPEN_QUESTIONS_PER_USER = 3;
export const MAX_WEBINAR_QA_QUESTION_LENGTH = 500;
export const MAX_WEBINAR_QA_ANSWER_LENGTH = 1000;
const MAX_OPEN_ADMISSIONS = 50;
const ADMISSION_TTL_MS = 2 * 60 * 1000;
// A stage invite should cover one webinar (plus reconnects), not become a
// permanent skeleton key for this identity.
const WEBINAR_PROMOTION_TTL_MS = 4 * 60 * 60 * 1000;

type WebinarQaEntryState = {
  id: string;
  userId: string;
  displayName: string;
  question: string;
  status: WebinarQaStatus;
  askedAt: number;
  updatedAt: number;
  upvoterUserIds: Set<string>;
  answerText?: string;
  answeredByName?: string;
};
const CHAT_HISTORY_LIMIT = 100;

export type ToggleChatReactionResult =
  | { ok: true; reactions: ChatMessageReaction[] }
  | { ok: false; reason: "not-found" | "too-many-reactions" };

export const MAX_CHAT_IMAGE_BYTES = 6 * 1024 * 1024;
export const CHAT_IMAGE_ORPHAN_TTL_MS = 2 * 60 * 1000;
const MAX_CHAT_IMAGE_ROOM_BYTES = 64 * 1024 * 1024;
const MAX_CHAT_IMAGE_USER_BYTES = 24 * 1024 * 1024;
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

export type HostReason = "owner" | "cohost" | "temporary" | "opener";
export type HostBasis = "owner" | "promoted" | "fallback";

const LIFECYCLE_TIMERS = [
  "cleanupTimer",
  "restorerLapseTimer",
  "lostCallTimer",
  "openingDeadlineTimer",
] as const;
type LifecycleTimer = (typeof LIFECYCLE_TIMERS)[number];

const HOST_REASON_RANK: Record<HostReason, number> = {
  opener: 0,
  temporary: 0,
  cohost: 1,
  owner: 2,
};

/** One tab's request to be let into a room. */
export type WaitingRequest = {
  userKey: string;
  userId: string;
  socket: Socket;
  displayName?: string;
};

/**
 * `membership`: a seat was added, removed, replaced or promoted.
 * `closed`: the room is being torn down.
 */
export type RoomLifecycleEvent = "membership" | "closed";

type GuestRecord = {
  identity: string;
  since: number;
  heldAt: number | null;
  passes: Set<string>;
};

export class Room {
  public readonly id: string;
  public readonly router: Router;
  private readonly webRtcServer: RoomOptions["webRtcServer"];
  public readonly clientId: string;
  public readonly workerPid: number | null;
  public readonly channelId: string;
  // Tells this room apart from an earlier or later one at the same code.
  public readonly incarnationId: string = randomUUID();
  // The room whose recovery record this one took over when it was created,
  // the writer of the newest record then. It may write over that room's
  // records, and over no one else's but its own.
  public takesOverRecordOf: string | null = null;
  // The signed-in account this room's code belongs to (who booked it, or who
  // made it), which hosts whenever it is here. Null for a code a guest made.
  public ownerEmail: string | null = null;
  // Set when this code was ended for everyone a moment ago: recovery passes
  // signed up to then are from the ended meeting, not from this one.
  public recoveryPassesVoidUntil: number | null = null;
  public clients: Map<string, Client> = new Map();
  public pendingClients: Map<string, WaitingRequest> = new Map();
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
  public currentScreenShareProducerId: string | null = null;
  public currentQuality: VideoQuality = "standard";
  public userKeysById: Map<string, string> = new Map();
  private readonly hostReasonsByKey = new Map<string, HostReason>();
  public displayNamesByKey: Map<string, string> = new Map();
  public handRaisedByUserId: Set<string> = new Set();
  private recentChatMessages: ChatMessage[] = [];
  readonly aiCredentials = new RoomAiCredentials();
  private chatImageAssets: Map<string, RoomChatImageAsset> = new Map();
  private chatImageExpiryTimers: Map<string, NodeJS.Timeout> = new Map();
  private chatImageBytes = 0;
  public blockedUsers: Set<string> = new Set();
  private cleanupTimer: NodeJS.Timeout | null = null;
  private cleanupTimerDeadline = 0;
  private primaryHostUserKey: string | null = null;
  /**
   * Guest identities bound to the proof of the guest pass they entered this
   * room with. The proof is a keyed hash the web join route signs into the
   * token; the pass itself never reaches the SFU. A binding only counts while
   * the identity holds something here (see `claimGuestIdentity`).
   */
  private guestProofsByUserKey: Map<string, string> = new Map();
  // The same bindings by proof: the keys a pass has in this room.
  private userKeysByGuestProof: Map<string, Set<string>> = new Map();
  private guestIdentitiesToRelease: Set<string> = new Set();
  private guestRecords: Map<string, GuestRecord> = new Map();
  private guestPassClock = 0;
  // Who waits, by guest: the keys of each guest's waiting tabs, oldest
  // first, and for each waiting key the guest it was filed under. With it
  // the lobby shows one row per guest, and a join finds its guest's
  // requests, without going through every pass the room knows.
  private waitingKeysByGuest: Map<string, string[]> = new Map();
  private waitingGuestByKey: Map<string, { guest: string; arrival: number }> =
    new Map();
  // One clock for requests to be let in and for every decision about who
  // may come in, so a decision can be told apart from a request that came
  // after it.
  private lobbyClock = 0;
  // Who may come in is decided from this alone (see `AdmissionLedger`).
  private admissions = new AdmissionLedger(config.lobbyDecisionRecordLimit, {
    onEvicted: (userKeys) => {
      for (const userKey of userKeys) this.releaseGuestIdentity(userKey);
    },
    onFull: () =>
      Logger.warn(
        `Room ${this.id}: the lobby decision record is full of refusals; an admission was not kept and the guest has to knock again.`,
      ),
  });
  // The request each waiting guest's row shows on the hosts' screens, as
  // they were last told, and the guests whose rows may have changed since.
  private shownRowByGuest: Map<string, string> = new Map();
  private lobbyGuestsToRefresh: Set<string> = new Set();
  // How requests that left the lobby since the hosts were last told left it.
  private lobbyOutcomes: Map<string, "admitted" | "rejected"> = new Map();
  /** Admissions a host created and no join has used yet (code → expiry). */
  private openAdmissions: Map<string, number> = new Map();
  private _isLocked: boolean = false;
  private _isChatLocked: boolean = false;
  private _noGuests: boolean = false;
  private _isTtsDisabled: boolean = false;
  private _isDmEnabled: boolean = true;
  private _areImageAttachmentsEnabled: boolean = true;
  private _reactionsDisabled: boolean = false;
  private _participantUnmuteAllowed: boolean = true;
  private _participantVideoAllowed: boolean = true;
  private _meetingInviteCodeHash: string | null = null;
  private _meetingInviteCodeVersion = "";
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
  public gameGeneration: { controller: AbortController; requestedBy: string } | null = null;
  public gameTickTimer: NodeJS.Timeout | null = null;
  // Pre-game vote: the host can let the room vote on which game to play.
  public gameVote: { candidates: string[]; votes: Record<string, string> } | null = null;
  private systemProducers: Map<
    string,
    { producer: Producer; userId: string; type: ProducerType }
  > = new Map();
  private producerIndex: Map<string, ProducerIndexEntry> = new Map();
  private meetingActiveSpeakerUserId: string | null = null;
  private meetingActiveSpeakerSignalAnnounced = false;
  private webinarActiveSpeakerUserId: string | null = null;
  private webinarDominantSpeakerUserId: string | null = null;
  private webinarFeedProducerIds: string[] = [];
  private webinarAudioLevelObserver: AudioLevelObserver | null = null;
  private webinarAudioLevelObserverInit: Promise<void> | null = null;
  private webinarWebcamAudioProducerOwners: Map<string, string> = new Map();
  private webinarFeedRefreshNotifier: ((room: Room) => void) | null = null;
  private webinarAttendeeCount = 0;
  /** Attendee raised hands (webinar stage requests), userId → raisedAt. */
  private webinarRaisedHandAt: Map<string, number> = new Map();
  /** Q&A entries in insertion order, id → entry. */
  private webinarQaEntries: Map<string, WebinarQaEntryState> = new Map();
  private webinarQaSequence = 0;
  /**
   * Identities the host invited on stage (userKey → invite expiry). Checked
   * during rejoin so a promoted attendee can pass the participant-side join
   * gates (webinar room guard, lock, waiting room, invite code, guest policy)
   * without host re-approval.
   */
  /**
   * Identities the host moved back to the audience. While webinar mode is on,
   * these may not re-enter as participants — a demoted client that ignores
   * the demote signal cannot simply rejoin the panel.
   */
  private webinarDemotedUserKeys: Set<string> = new Set();
  // People a host removed, or whose admission a host took back. Nothing but
  // a host letting them in again gets them past the lock: not an invite, not
  // proof they were here before.
  private readmissionRequiredUserKeys: Set<string> = new Set();
  // Told when someone starts or stops needing readmission, so what must
  // outlive the room (a scheduled meeting's invitations) can keep up.
  public onReadmissionChange: ((userKey: string, required: boolean) => void) | null =
    null;
  // Told when what a recreated room would need changes: who hosts, and who
  // has to be let in again.
  public onRecoverableChange: (() => void) | null = null;
  // Told once, when the lost call this room stood in for is over for good.
  public onLostCallEnded: (() => void) | null = null;
  public awaitingOpener: { lost: LostRoom | null } | null = null;
  private lostCallEnded = false;
  private handingOff = false;
  // A host ended the meeting for everyone. It may stay open a little longer
  // to say so, but it is over: it hands out no more recovery passes.
  private endedForEveryone = false;
  // Set while this room stands in for a call the SFU lost and nobody from
  // that call has come back yet. Until one does, or until no pass from the
  // lost call can still be good, the room has no host and whoever recreated
  // it waits like anyone else.
  private restorer: { until: number; rosterKnown: boolean } | null = null;
  private restorerLapseTimer: NodeJS.Timeout | null = null;
  private lostCallTimer: NodeJS.Timeout | null = null;
  private openingDeadlineTimer: NodeJS.Timeout | null = null;
  private openingDeadlineAt = 0;
  private meetingParticipantCount = 0;
  private currentWebcamCodecPolicy: WebcamCodecPolicy =
    buildWebcamCodecPolicy("vp8", 0);
  private webcamCodecPolicyUpgradeTimer: NodeJS.Timeout | null = null;
  private readonly webcamReceiverCapacityProofCoordinator:
    WebcamReceiverCapacityProofCoordinator;

  private readonly webcamVp9Enabled: boolean;
  private readonly guestIdentityMergeListeners = new Set<
    (from: string, into: string) => void
  >();
  private readonly lifecycleListeners = new Set<
    (event: RoomLifecycleEvent) => void
  >();

  constructor(options: RoomOptions) {
    this.id = options.id;
    this.router = options.router;
    this.webRtcServer = options.webRtcServer;
    this.clientId = options.clientId;
    this.workerPid = options.workerPid;
    this.webcamVp9Enabled = options.webcamVp9Enabled ?? config.webcamVp9Enabled;
    this.channelId = `${options.clientId}:${options.id}`;
    this.webcamReceiverCapacityProofCoordinator =
      new WebcamReceiverCapacityProofCoordinator({
        roomId: this.id,
        evaluate: (producerId) =>
          this.evaluateWebcamReceiverCapacityProof(producerId),
        getTransitionBinding: (producerId) =>
          this.getWebcamReceiverCapacityTransitionBinding(producerId),
        emit: (ownerClientId, proof) => {
          this.clients
            .get(ownerClientId)
            ?.socket.emit("webcamReceiverCapacityProof", proof);
        },
        onError: (error) => {
          Logger.warn(
            `Room ${this.id}: webcam receiver capacity proof failed closed`,
            error,
          );
        },
      });
  }

  get rtpCapabilities(): RtpCapabilities {
    return this.router.rtpCapabilities;
  }

  /**
   * Lets room-scoped state that lives outside this class, such as the apps
   * authority runtime, follow who is in the room and when it closes.
   */
  onGuestIdentityMerged(listener: (from: string, into: string) => void): () => void {
    this.guestIdentityMergeListeners.add(listener);
    return () => this.guestIdentityMergeListeners.delete(listener);
  }

  onLifecycle(listener: (event: RoomLifecycleEvent) => void): () => void {
    this.lifecycleListeners.add(listener);
    return () => this.lifecycleListeners.delete(listener);
  }

  private notifyLifecycle(event: RoomLifecycleEvent): void {
    for (const listener of this.lifecycleListeners) {
      try {
        listener(event);
      } catch (error) {
        Logger.warn(`Room ${this.id}: a lifecycle listener failed`, error);
      }
    }
  }

  get activeSpeakerUserId(): string | null {
    return this.meetingActiveSpeakerUserId;
  }

  get isMeetingActiveSpeakerSignalAvailable(): boolean {
    return this.meetingActiveSpeakerSignalAnnounced;
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
    // A newly connected third client invalidates one-to-one topology before it
    // can create a consumer, so revoke synchronously with room membership.
    this.refreshWebcamReceiverCapacityProofs();
    this.cancelWebcamCodecPolicyUpgrade();
    this.reconcileWebcamCodecPolicy();
    this.notifyLifecycle("membership");
  }

  get webcamCodecPolicy(): WebcamCodecPolicy {
    return { ...this.currentWebcamCodecPolicy };
  }

  updateClientMediaCapabilities(
    clientId: string,
    capabilities: ClientMediaCapabilities | undefined,
  ): WebcamCodecPolicy | null {
    const client = this.clients.get(clientId);
    if (!client) return null;
    if (!client.updateMediaCapabilities(capabilities)) return null;
    this.cancelWebcamCodecPolicyUpgrade();
    this.reconcileWebcamCodecPolicy();
    return this.webcamCodecPolicy;
  }

  reportClientWebcamCodecFailure(
    clientId: string,
    codec: "vp9",
    epoch: number,
  ): WebcamCodecPolicy | null {
    const client = this.clients.get(clientId);
    if (
      !client ||
      codec !== "vp9" ||
      this.currentWebcamCodecPolicy.codec !== codec ||
      this.currentWebcamCodecPolicy.epoch !== epoch ||
      !client.markWebcamCodecFailed(codec)
    ) {
      return null;
    }
    this.cancelWebcamCodecPolicyUpgrade();
    this.reconcileWebcamCodecPolicy();
    return this.webcamCodecPolicy;
  }

  private selectWebcamCodecPolicyCodec(): WebcamCodecPolicy["codec"] {
    return selectRoomWebcamCodec(this.webcamCodecPolicyParticipants(), {
      vp9Enabled: this.webcamVp9Enabled,
    });
  }

  private webcamCodecPolicyParticipants() {
    return Array.from(this.clients.values()).map((client) => ({
      id: client.id,
      isObserver: client.isObserver,
      capabilities: client.mediaCapabilities,
    }));
  }

  private reconcileWebcamCodecPolicy(): boolean {
    const codec = this.selectWebcamCodecPolicyCodec();
    if (codec === this.currentWebcamCodecPolicy.codec) return false;
    const currentCodecRemainsCompatible = participantsSupportWebcamCodec(
      this.webcamCodecPolicyParticipants(),
      this.currentWebcamCodecPolicy.codec,
    );
    if (currentCodecRemainsCompatible && this.hasWebcamVideoProducer()) {
      return false;
    }
    this.currentWebcamCodecPolicy = buildWebcamCodecPolicy(
      codec,
      this.currentWebcamCodecPolicy.epoch + 1,
    );
    for (const client of this.clients.values()) {
      client.socket.emit("webcamCodecPolicyChanged", {
        ...this.currentWebcamCodecPolicy,
        roomId: this.id,
      });
    }
    this.closeWebcamVideoProducersOutsidePolicy();
    return true;
  }

  private hasWebcamVideoProducer(): boolean {
    for (const client of this.clients.values()) {
      const producer = client.getProducer("video", "webcam");
      if (producer && !producer.closed) return true;
    }
    return false;
  }

  private closeWebcamVideoProducersOutsidePolicy(): void {
    for (const client of this.clients.values()) {
      const producer = client.getProducer("video", "webcam");
      if (
        !producer ||
        producer.closed ||
        this.rtpParametersMatchCurrentWebcamCodecPolicy(producer.rtpParameters)
      ) {
        continue;
      }
      try {
        producer.close();
      } catch (error) {
        Logger.warn(
          `Room ${this.id}: Failed to close webcam producer ${producer.id} after codec policy change`,
          error,
        );
      }
    }
  }

  private cancelWebcamCodecPolicyUpgrade(): void {
    if (!this.webcamCodecPolicyUpgradeTimer) return;
    clearTimeout(this.webcamCodecPolicyUpgradeTimer);
    this.webcamCodecPolicyUpgradeTimer = null;
  }

  private scheduleWebcamCodecPolicyUpgrade(): void {
    this.cancelWebcamCodecPolicyUpgrade();
    const nextCodec = this.selectWebcamCodecPolicyCodec();
    if (nextCodec === this.currentWebcamCodecPolicy.codec) return;
    // Departures can only make a more efficient codec newly eligible. Do not
    // interrupt active cameras merely to upgrade; a compatibility downgrade
    // on add/update still happens immediately in reconcileWebcamCodecPolicy().
    if (this.hasWebcamVideoProducer()) return;
    // A departure can only make a stronger codec newly eligible. Debounce the
    // upgrade so a socket reconnect does not churn every active camera from
    // VP8 -> VP9 -> VP8 while the same participant reclaims its seat.
    this.webcamCodecPolicyUpgradeTimer = setTimeout(() => {
      this.webcamCodecPolicyUpgradeTimer = null;
      if (this.hasWebcamVideoProducer()) return;
      this.reconcileWebcamCodecPolicy();
    }, 3000);
    this.webcamCodecPolicyUpgradeTimer.unref?.();
  }

  private evaluateWebcamReceiverCapacityProof(
    producerId: string,
  ): WebcamReceiverCapacityEvaluation {
    const entry = this.producerIndex.get(producerId);
    const ownerClientId = entry?.userId ?? null;
    const owner = ownerClientId ? this.clients.get(ownerClientId) : undefined;
    const currentProducer = owner?.getProducer("video", "webcam") ?? null;
    return evaluateWebcamReceiverCapacity({
      producerId,
      ownerClientId,
      producer: entry?.producer ?? null,
      producerIsCurrent: Boolean(
        entry &&
          !entry.system &&
          entry.type === "webcam" &&
          entry.producer.kind === "video" &&
          currentProducer === entry.producer &&
          currentProducer.id === producerId,
      ),
      clients: Array.from(this.clients.values()).map((client) => ({
        id: client.id,
        isObserver: client.isObserver,
        connected:
          client.socket.connected !== false &&
          !this.hasPendingDisconnect(client.id),
        transportConnected: this.isWebcamProofTransportConnected(
          client.id === ownerClientId
            ? client.producerTransport
            : client.consumerTransport,
        ),
        consumer: client.getConsumer(producerId) ?? null,
      })),
      screenShareActive: this.currentScreenShareProducerId !== null,
      roomQuality: this.currentQuality,
    });
  }

  private isWebcamProofTransportConnected(
    transport: WebRtcTransport | null,
  ): boolean {
    // A live current producer/consumer necessarily owns its corresponding
    // transport. Missing or not-yet-connected transport state fails closed.
    if (!transport) return false;
    return (
      !transport.closed &&
      (transport.iceState === "connected" ||
        transport.iceState === "completed") &&
      transport.dtlsState === "connected"
    );
  }

  private getWebcamReceiverCapacityTransitionBinding(producerId: string) {
    const entry = this.producerIndex.get(producerId);
    if (
      !entry ||
      entry.system ||
      entry.type !== "webcam" ||
      entry.producer.kind !== "video"
    ) {
      return null;
    }
    const owner = this.clients.get(entry.userId);
    const transport = owner?.producerTransport;
    if (
      !owner ||
      owner.isObserver ||
      owner.getProducer("video", "webcam") !== entry.producer ||
      !transport ||
      transport.closed
    ) {
      return null;
    }
    return {
      ownerClientId: owner.id,
      ownerSocketId: owner.socket.id,
      producerTransportId: transport.id,
    };
  }

  reserveWebcamReceiverCapacityTransition(
    ownerClientId: string,
    fromProducerId: string,
    nonce: string,
  ): WebcamReceiverCapacityTransitionReservation | null {
    const owner = this.clients.get(ownerClientId);
    const transport = owner?.producerTransport;
    const currentProducer = owner?.getProducer("video", "webcam");
    if (
      !owner ||
      owner.isObserver ||
      !transport ||
      transport.closed ||
      currentProducer?.id !== fromProducerId
    ) {
      return null;
    }
    return this.webcamReceiverCapacityProofCoordinator.reserveTransition({
      predecessorProducerId: fromProducerId,
      nonce,
      ownerClientId,
      ownerSocketId: owner.socket.id,
      producerTransportId: transport.id,
    });
  }

  cancelWebcamReceiverCapacityTransition(
    reservation: WebcamReceiverCapacityTransitionReservation,
  ): void {
    this.webcamReceiverCapacityProofCoordinator.cancelTransition(reservation);
  }

  commitWebcamReceiverCapacityTransition(
    ownerClientId: string,
    producer: Producer,
    reservation: WebcamReceiverCapacityTransitionReservation,
  ): Producer | null {
    const owner = this.clients.get(ownerClientId);
    const predecessor = owner?.getProducer("video", "webcam");
    const predecessorEntry = this.producerIndex.get(
      reservation.predecessorProducerId,
    );
    if (
      !owner ||
      owner.isObserver ||
      owner.socket.id !== reservation.ownerSocketId ||
      owner.producerTransport?.id !== reservation.producerTransportId ||
      predecessor?.id !== reservation.predecessorProducerId ||
      !predecessorEntry ||
      predecessorEntry.producer !== predecessor ||
      predecessorEntry.userId !== ownerClientId ||
      predecessorEntry.system ||
      predecessorEntry.type !== "webcam" ||
      !isVp8SingleLayerProducer(producer) ||
      producer.paused ||
      !this.webcamReceiverCapacityProofCoordinator.validateTransition(
        reservation,
      )
    ) {
      this.webcamReceiverCapacityProofCoordinator.cancelTransition(
        reservation,
      );
      return null;
    }

    // No await is allowed between the final validation and transfer. This is
    // the atomic point that binds the one-use predecessor lease to the exact
    // mediasoup-assigned successor id.
    const displacedProducer = owner.addProducer(producer);
    this.indexProducer(
      {
        producer,
        userId: ownerClientId,
        type: "webcam",
        system: false,
      },
      { skipWebcamReceiverCapacityRefresh: true },
    );
    const transferred =
      this.webcamReceiverCapacityProofCoordinator.transferTransition(
        reservation,
        producer.id,
      );
    if (!transferred) {
      this.removeProducerIndexById(producer.id, producer);
      owner.addProducer(predecessor);
      this.webcamReceiverCapacityProofCoordinator.cancelTransition(
        reservation,
      );
      return null;
    }
    this.removeProducerIndexById(
      reservation.predecessorProducerId,
      predecessor,
    );
    return displacedProducer;
  }

  refreshWebcamReceiverCapacityProof(producerId: string): void {
    const entry = this.producerIndex.get(producerId);
    if (
      !entry ||
      entry.system ||
      entry.type !== "webcam" ||
      entry.producer.kind !== "video"
    ) {
      this.webcamReceiverCapacityProofCoordinator.remove(producerId);
      return;
    }
    this.webcamReceiverCapacityProofCoordinator.refresh(producerId);
  }

  refreshWebcamReceiverCapacityProofs(): void {
    const producerIds: string[] = [];
    for (const [producerId, entry] of this.producerIndex) {
      if (
        !entry.system &&
        entry.type === "webcam" &&
        entry.producer.kind === "video" &&
        this.isProducerIndexEntryActive(producerId, entry)
      ) {
        producerIds.push(producerId);
      }
    }
    this.webcamReceiverCapacityProofCoordinator.refreshAll(producerIds);
  }

  // Whether `userKey` still has a seat, a waiting-room entry, or anything a
  // later join under that key would inherit.
  private holdsUserKey(userKey: string): boolean {
    if (
      this.hostUserKey === userKey ||
      this.adminUserKeys.has(userKey) ||
      this.readmissionRequiredUserKeys.has(userKey) ||
      this.admissions.names(this.principalOf(userKey), userKey) ||
      this.admissions.holdsRefusalFor(`key:${userKey}`) ||
      this.blockedUsers.has(userKey) ||
      this.pendingClients.has(userKey)
    ) {
      return true;
    }
    for (const key of this.userKeysById.values()) {
      if (key === userKey) return true;
    }
    return false;
  }

  /**
   * Decides whether a join may enter as the guest `userKey`, and which pass
   * proof to bind the identity to once the join gets a seat or a waiting-room
   * entry (pass `bindTo` on to `setUserIdentity` or `addPendingClient`).
   *
   * An identity that holds something here under a proof needs that proof. One
   * that holds something with no proof entered through a client without a
   * pass. It stays open, as before guest passes: binding it to a later caller
   * would lock the original client out.
   */
  claimGuestIdentity(
    userKey: string,
    guestProof: string | undefined,
  ): { ok: false } | { ok: true; bindTo: string | undefined } {
    if (!this.holdsUserKey(userKey)) {
      this.unbindGuestProof(userKey);
      return { ok: true, bindTo: guestProof };
    }
    const bound = this.guestProofsByUserKey.get(userKey);
    if (bound !== undefined && bound !== guestProof) {
      return { ok: false };
    }
    return { ok: true, bindTo: bound };
  }

  /** How many guest identities this room holds a pass proof for. */
  get boundGuestIdentityCount(): number {
    return this.guestProofsByUserKey.size;
  }

  /** How many passes and keys the room's decision record holds. */
  get decisionRecordCount(): number {
    return this.admissions.size;
  }

  /**
   * Keeps the map from growing with every guest that ever passed through a
   * long-lived room. Every method that removes something `holdsUserKey`
   * counts calls this.
   *
   * The proof is dropped at the end of the current turn, and only if the key
   * holds nothing by then. One host action often swaps a right for another,
   * such as an unblock followed by an admission. Dropping the proof between
   * the two would leave the new right open to anyone who names the key.
   */
  private releaseGuestIdentity(userKey: string): void {
    if (!this.guestProofsByUserKey.has(userKey)) return;
    if (this.guestIdentitiesToRelease.size === 0) {
      queueMicrotask(() => this.releaseUnheldGuestIdentities());
    }
    this.guestIdentitiesToRelease.add(userKey);
  }

  /**
   * Whether a host action may give `userKey` a right that lets a later join
   * in. A guest key is public, so on its own it says nothing about who will
   * use the right. The room has to know who the guest is: its proof is on
   * record, it is seated or waiting right now, or it is already admitted. A
   * key that only stands in a list, such as a block set while the guest was
   * away, is not enough. A guest the room does not know has to knock, and is
   * admitted from its waiting entry.
   */
  private canGrantTo(userKey: string): boolean {
    if (!isGuestUserKey(userKey)) return true;
    if (
      this.guestProofsByUserKey.has(userKey) ||
      this.pendingClients.has(userKey) ||
      this.admissions.names(this.principalOf(userKey), userKey)
    ) {
      return true;
    }
    for (const seatedKey of this.userKeysById.values()) {
      if (seatedKey === userKey) return true;
    }
    return false;
  }

  personOf(
    userKey: string,
    guestProof: string | undefined = this.guestProofsByUserKey.get(userKey),
    passes?: ReadonlySet<string>,
  ): Person {
    if (guestProof === undefined) return { userKey, passes: NO_PASSES };
    return {
      userKey,
      passes: passes ?? this.passesOfGuest(guestProof),
    };
  }

  private isKeyOf(person: Person, userKey: string): boolean {
    if (userKey === person.userKey) return true;
    const bound = this.guestProofsByUserKey.get(userKey);
    return bound !== undefined && person.passes.has(bound);
  }

  /**
   * Whether one of `userKeys` is `userKey` or another key of the same guest.
   *
   * A guest has one public key per tab, so that its tabs cannot be linked.
   * What a guest may do does not depend on the tab: a right a host gave to
   * one key, and a block on one key, hold for every key of that guest, the
   * way they hold for every tab of a signed-in account. `guestProof` is what
   * tells that two keys are one guest.
   */
  private guestHolds(
    userKeys: Iterable<string>,
    userKey: string,
    guestProof: string | undefined,
    passes?: ReadonlySet<string>,
  ): boolean {
    const person = this.personOf(userKey, guestProof, passes);
    for (const key of userKeys) {
      if (this.isKeyOf(person, key)) return true;
    }
    return false;
  }

  private bindGuestProof(userKey: string, guestProof: string): void {
    const previous = this.guestProofsByUserKey.get(userKey);
    if (previous === guestProof) return;
    if (previous !== undefined) this.dropKeyOfPass(userKey, previous);
    this.guestProofsByUserKey.set(userKey, guestProof);
    const userKeys = this.userKeysByGuestProof.get(guestProof);
    if (userKeys) userKeys.add(userKey);
    else this.userKeysByGuestProof.set(guestProof, new Set([userKey]));
    if (!this.guestRecords.has(guestProof)) {
      this.guestRecords.set(guestProof, {
        identity: guestProof,
        since: (this.guestPassClock += 1),
        heldAt: null,
        passes: new Set([guestProof]),
      });
    }
    this.reportPassesOfRecordedGuests([guestProof]);
  }

  private reportPassesOfRecordedGuests(passes: Iterable<string>): void {
    for (const pass of passes) {
      for (const userKey of this.userKeysByGuestProof.get(pass) ?? []) {
        if (this.hostReasonsByKey.has(userKey) || this.readmissionRequiredUserKeys.has(userKey)) {
          this.onRecoverableChange?.();
          return;
        }
      }
    }
  }

  private unbindGuestProof(userKey: string): void {
    const guestProof = this.guestProofsByUserKey.get(userKey);
    if (guestProof === undefined) return;
    this.guestProofsByUserKey.delete(userKey);
    this.dropKeyOfPass(userKey, guestProof);
  }

  private dropKeyOfPass(userKey: string, guestProof: string): void {
    const userKeys = this.userKeysByGuestProof.get(guestProof);
    userKeys?.delete(userKey);
    if (userKeys?.size === 0) this.userKeysByGuestProof.delete(guestProof);
  }

  guestProofOf(userKey: string): string | undefined {
    return this.guestProofsByUserKey.get(userKey);
  }

  guestIdentityOf(userKey: string): string | undefined {
    const guestProof = this.guestProofsByUserKey.get(userKey);
    if (guestProof === undefined) return undefined;
    return this.guestRecords.get(guestProof)?.identity ?? guestProof;
  }

  holdGuestIdentityOf(userKey: string): void {
    const guestProof = this.guestProofsByUserKey.get(userKey);
    const record = guestProof === undefined ? undefined : this.guestRecords.get(guestProof);
    if (!record) return;
    record.heldAt = this.guestPassClock += 1;
    this.trimGuestRecords();
  }

  get guestRecordCount(): number {
    return this.guestRecords.size;
  }

  private isGuestPassInUse(guestProof: string): boolean {
    return (
      this.userKeysByGuestProof.has(guestProof) ||
      this.admissions.has(`pass:${guestProof}`)
    );
  }

  private trimGuestRecords(): void {
    const heldOnly: GuestRecord[] = [];
    for (const record of new Set(this.guestRecords.values())) {
      if ([...record.passes].some((proof) => this.isGuestPassInUse(proof))) continue;
      if (record.heldAt === null) this.dropGuestRecord(record);
      else heldOnly.push(record);
    }
    const excess = heldOnly.length - config.guestAppIdentityLimit;
    if (excess <= 0) return;
    heldOnly.sort((a, b) => (a.heldAt ?? 0) - (b.heldAt ?? 0));
    for (const record of heldOnly.slice(0, excess)) this.dropGuestRecord(record);
  }

  private dropGuestRecord(record: GuestRecord): void {
    for (const proof of record.passes) {
      if (this.guestRecords.get(proof) === record) this.guestRecords.delete(proof);
    }
  }

  private passesOfGuest(guestProof: string): ReadonlySet<string> {
    return this.guestRecords.get(guestProof)?.passes ?? new Set([guestProof]);
  }

  private tick(): number {
    return (this.lobbyClock += 1);
  }

  /**
   * Where a decision about `userKey` is kept. A seat key the join route
   * issued from a pass speaks for the pass: a decision about it holds for
   * every tab of that pass. Any other key, an account's or one a client
   * chose itself, speaks only for itself.
   */
  private principalOf(userKey: string): string {
    const guestProof = this.guestProofsByUserKey.get(userKey);
    return guestProof !== undefined && userKey.startsWith(GUEST_SEAT_KEY_PREFIX)
      ? `pass:${guestProof}`
      : `key:${userKey}`;
  }

  /**
   * Where a refusal of `userKey` is kept: where its decisions are, and
   * against the pass whenever a proof ties the key to one, so the refusal
   * reaches the pass's other tabs after this key is gone.
   */
  private refusalPrincipalsOf(userKey: string): string[] {
    const principal = this.principalOf(userKey);
    const guestProof = this.guestProofsByUserKey.get(userKey);
    return guestProof === undefined || principal === `pass:${guestProof}`
      ? [principal]
      : [principal, `pass:${guestProof}`];
  }

  /**
   * The principals whose decisions a join as `userKey` may lean on. A token
   * issued for this room (`roomGuestProof`) speaks for the whole guest:
   * every linked pass, and the keys bound to them. Any other token speaks
   * only for its own key.
   */
  private principalsOfJoin(
    userKey: string,
    roomGuestProof: string | undefined,
    passes?: ReadonlySet<string>,
  ): string[] {
    if (roomGuestProof === undefined) return [this.principalOf(userKey)];
    const principals = new Set([`key:${userKey}`]);
    for (const guestProof of this.personOf(userKey, roomGuestProof, passes).passes) {
      principals.add(`pass:${guestProof}`);
      for (const boundKey of this.userKeysByGuestProof.get(guestProof) ?? []) {
        if (!boundKey.startsWith(GUEST_SEAT_KEY_PREFIX)) {
          principals.add(`key:${boundKey}`);
        }
      }
    }
    return [...principals];
  }

  // The principals a waiting request of `userKey` speaks for.
  private principalsOfRequest(userKey: string): string[] {
    const guestProof = userKey.startsWith(GUEST_SEAT_KEY_PREFIX)
      ? this.guestProofsByUserKey.get(userKey)
      : undefined;
    return this.principalsOfJoin(userKey, guestProof);
  }

  private admitsRequest(principals: string[]): boolean {
    return this.admissions.admits(
      principals,
      this.isLocked ? "lock" : "waitingRoom",
    );
  }

  private isKnownGuestPass(guestProof: string): boolean {
    const record = this.guestRecords.get(guestProof);
    if (!record) return false;
    return (
      record.heldAt !== null ||
      [...record.passes].some((proof) => this.isGuestPassInUse(proof))
    );
  }

  /**
   * What a join learns from the seats its token names under the browser's
   * other passes (`guestWas`): the join route found their cookies in the
   * same browser. The room records nothing yet. A join decides with the
   * plan (a block or a demotion under any of the passes refuses it, and a
   * right under any of them counts when the room would record the link),
   * and only a join that is let in or waits records it (`commitGuestLink`).
   * A refused join records nothing: no pass, no link, no binding.
   *
   * A pass the room has never seen is left out. Returns undefined when the
   * join shows no pass the room does not already link to `guestProof`.
   */
  planGuestLink(
    otherSeats: ReadonlyArray<{ guestProof: string }>,
    guestProof: string,
  ): GuestLinkPlan | undefined {
    const passes = new Set(this.passesOfGuest(guestProof));
    let grows = false;
    for (const seat of otherSeats) {
      if (!this.isKnownGuestPass(seat.guestProof) || passes.has(seat.guestProof)) {
        continue;
      }
      for (const proof of this.passesOfGuest(seat.guestProof)) passes.add(proof);
      grows = true;
    }
    if (!grows) return undefined;
    return {
      guestProof,
      passes,
      blocked: this.guestHolds(this.blockedUsers, "", guestProof, passes),
      recordable: passes.size <= GUEST_PASS_GROUP_LIMIT,
    };
  }

  /**
   * A block on any of a plan's passes wins over every right the guest holds
   * under any other: the guest loses what a rejoin would honour, host rights
   * included. Only what the room already records is changed. Returns all of
   * the guest's keys, so that the caller removes its seats and requests.
   */
  refuseBlockedLink(link: GuestLinkPlan): { userKeys: string[] } {
    const userKeys = [...link.passes].flatMap((proof) => [
      ...(this.userKeysByGuestProof.get(proof) ?? []),
    ]);
    this.dropRejoinGrantsOf(userKeys, { recordedOnly: true });
    return { userKeys };
  }

  /**
   * Records a plan's passes as one guest, for a join that is let in or
   * waits: from then on decisions and blocks under any of them hold under
   * all. A plan of more than `GUEST_PASS_GROUP_LIMIT` passes is not
   * recorded: the room never drops a pass it links to make room.
   *
   * The guest's waiting requests are then judged again, now that the room
   * knows more of the guest (returned). A request is answered only by a
   * decision made after it arrived: a denial turns it away, and an
   * admission lets it in while the guest still holds it. Any other request
   * stays in the lobby. Nothing is recorded: an earlier decision keeps the
   * time it was made.
   */
  commitGuestLink(
    link: GuestLinkPlan,
  ): Array<{ request: WaitingRequest; admitted: boolean }> {
    if (link.blocked) return [];
    if (!link.recordable) {
      Logger.warn(
        `Room ${this.id}: a guest showed ${link.passes.size} passes; the room links at most ${GUEST_PASS_GROUP_LIMIT}, so this link is not recorded.`,
      );
      return [];
    }
    const guestsBefore = [...new Set([...link.passes].map((proof) => this.guestOfPass(proof)))];
    const passes = new Set(link.passes);
    const known = new Set<GuestRecord>();
    for (const proof of link.passes) {
      const record = this.guestRecords.get(proof);
      if (!record) continue;
      known.add(record);
      for (const pass of record.passes) passes.add(pass);
    }
    const held = [...known].filter((record) => record.heldAt !== null);
    const kept = (held.length > 0 ? held : [...known]).reduce<GuestRecord | undefined>(
      (earliest, record) => (!earliest || record.since < earliest.since ? record : earliest),
      undefined,
    );
    const merged: GuestRecord = {
      identity: kept?.identity ?? link.guestProof,
      since: kept?.since ?? (this.guestPassClock += 1),
      heldAt: held.reduce<number | null>(
        (latest, record) => Math.max(latest ?? 0, record.heldAt ?? 0),
        null,
      ),
      passes,
    };
    let seatedIdentityChanged = false;
    for (const proof of passes) {
      const before = this.guestRecords.get(proof)?.identity ?? proof;
      if (before !== merged.identity && this.userKeysByGuestProof.has(proof)) {
        seatedIdentityChanged = true;
      }
      this.guestRecords.set(proof, merged);
    }
    for (const record of held) {
      if (record.identity === merged.identity) continue;
      for (const listener of this.guestIdentityMergeListeners) {
        try {
          listener(record.identity, merged.identity);
        } catch (error) {
          Logger.warn(`Room ${this.id}: an identity merge listener failed`, error);
        }
      }
    }
    if (seatedIdentityChanged) this.notifyLifecycle("membership");
    this.reportPassesOfRecordedGuests(passes);
    this.mergeWaitingGuests(guestsBefore, this.guestOfPass(link.guestProof));
    const settled: Array<{ request: WaitingRequest; admitted: boolean }> = [];
    for (const userKey of [
      ...(this.waitingKeysByGuest.get(this.guestOfPass(link.guestProof)) ?? []),
    ]) {
      const request = this.pendingClients.get(userKey);
      const arrival = this.waitingGuestByKey.get(userKey)?.arrival;
      if (!request || arrival === undefined) continue;
      const principals = this.principalsOfRequest(userKey);
      const answer = this.admissions.latestAnswer(principals);
      if (!answer || answer.at < arrival) continue;
      if (!answer.admitted) {
        this.lobbyOutcomes.set(userKey, "rejected");
        this.removePendingClient(userKey);
        settled.push({ request, admitted: false });
      } else if (this.admitsRequest(principals)) {
        this.lobbyOutcomes.set(userKey, "admitted");
        this.removePendingClient(userKey);
        settled.push({ request, admitted: true });
      }
    }
    return settled;
  }

  /**
   * A join's link in one step, as `planGuestLink` and then either
   * `refuseBlockedLink` or `commitGuestLink`.
   */
  linkGuestPasses(
    otherSeats: ReadonlyArray<{ guestProof: string }>,
    guestProof: string,
  ): {
    blocked: string[];
    settled: Array<{ request: WaitingRequest; admitted: boolean }>;
  } {
    const link = this.planGuestLink(otherSeats, guestProof);
    if (!link) return { blocked: [], settled: [] };
    if (link.blocked) return { blocked: this.refuseBlockedLink(link).userKeys, settled: [] };
    return { blocked: [], settled: this.commitGuestLink(link) };
  }

  /** How many passes the room links to another, for its memory bound. */
  get linkedGuestPassCount(): number {
    let linked = 0;
    for (const record of this.guestRecords.values()) {
      if (record.passes.size > 1) linked += 1;
    }
    return linked;
  }

  /** A host turned away the request `userKey` made to be let in. */
  denyWaitingRequest(userKey: string): void {
    const at = this.tick();
    for (const principal of this.refusalPrincipalsOf(userKey)) {
      this.admissions.deny(principal, at);
    }
    if (this.pendingClients.has(userKey)) {
      this.lobbyOutcomes.set(userKey, "rejected");
    }
    this.removePendingClient(userKey);
  }

  /**
   * A host lets in the guests behind `grants`, past the waiting room or the
   * lock as each grant says. A key the room cannot grant to (see
   * `canGrantTo`) is left out and returned as refused. The rest are recorded
   * together or not at all: when the decision record has no room left (it
   * holds only refusals), nothing changes, every request stays in the
   * lobby and every block stays, and this says "full".
   */
  admitUserKeys(
    grants: ReadonlyArray<{ userKey: string; scopes: readonly AdmissionScope[] }>,
  ): AdmitResult {
    const grantable = grants.filter((grant) => this.canGrantTo(grant.userKey));
    const refused = [
      ...new Set(
        grants
          .filter((grant) => !grantable.includes(grant))
          .map((grant) => grant.userKey),
      ),
    ];
    const result = this.recordAdmissions(grantable);
    return result.status === "admitted" ? { ...result, refused } : { status: "full", refused };
  }

  // Records the admissions of one host action, together or not at all, and
  // lets the requests they answer out of the lobby.
  private recordAdmissions(
    grants: ReadonlyArray<{ userKey: string; scopes: readonly AdmissionScope[] }>,
  ): AdmitResult {
    if (grants.length === 0) return { status: "admitted", admitted: [], refused: [] };
    const kept = this.admissions.admitAll(
      grants.map((grant) => ({
        principal: this.principalOf(grant.userKey),
        userKey: grant.userKey,
        scopes: grant.scopes,
      })),
      this.tick(),
    );
    if (!kept) return { status: "full", refused: [] };
    const admitted = [...new Set(grants.map((grant) => grant.userKey))];
    for (const userKey of admitted) {
      for (const key of this.identitiesOfSameGuest(userKey)) {
        this.setReadmissionRequired(key, false);
        this.blockedUsers.delete(key);
      }
      if (this.pendingClients.has(userKey)) {
        this.lobbyOutcomes.set(userKey, "admitted");
      }
      this.removePendingClient(userKey);
    }
    return { status: "admitted", admitted, refused: [] };
  }

  private recordRevocation(userKeys: string[], scopes: AdmissionScope[]): void {
    this.admissions.revoke(
      userKeys.flatMap((userKey) => this.refusalPrincipalsOf(userKey)),
      scopes,
      this.tick(),
    );
    for (const userKey of userKeys) this.releaseGuestIdentity(userKey);
  }

  // What a guest's waiting requests are filed under: its passes, by the
  // lowest proof of those the room has linked, or its key when it showed
  // no pass.
  private guestOfPass(guestProof: string): string {
    const passes = this.guestRecords.get(guestProof)?.passes;
    return `pass:${passes ? [...passes].sort()[0] : guestProof}`;
  }

  private guestOfKey(userKey: string): string {
    const guestProof = this.guestProofsByUserKey.get(userKey);
    return guestProof === undefined
      ? `key:${userKey}`
      : this.guestOfPass(guestProof);
  }

  /**
   * Files the waiting requests of guests the room just linked under the one
   * guest they are now.
   */
  private mergeWaitingGuests(guestsBefore: string[], guestNow: string): void {
    for (const guest of [...guestsBefore, guestNow]) {
      this.lobbyGuestsToRefresh.add(guest);
    }
    const merged = [...new Set(guestsBefore)]
      .flatMap((guest) => this.waitingKeysByGuest.get(guest) ?? [])
      .sort(
        (a, b) =>
          this.waitingGuestByKey.get(a)!.arrival -
          this.waitingGuestByKey.get(b)!.arrival,
      );
    for (const guest of guestsBefore) this.waitingKeysByGuest.delete(guest);
    if (merged.length === 0) return;
    this.waitingKeysByGuest.set(guestNow, merged);
    for (const userKey of merged) {
      this.waitingGuestByKey.get(userKey)!.guest = guestNow;
    }
  }

  /**
   * What changed in the hosts' lobby since they were last told: the rows to
   * take off their screens, with how each request left if it did, and the
   * rows to add. Each waiting guest is one row, its oldest request. Only the
   * guests whose requests changed are looked at.
   */
  takeLobbyChanges(): {
    removed: Array<{ userKey: string; outcome?: "admitted" | "rejected" }>;
    added: WaitingRequest[];
  } {
    const before = new Set<string>();
    const after = new Set<string>();
    for (const guest of this.lobbyGuestsToRefresh) {
      const shown = this.shownRowByGuest.get(guest);
      if (shown !== undefined) before.add(shown);
      const first = this.waitingKeysByGuest.get(guest)?.[0];
      if (first === undefined) {
        this.shownRowByGuest.delete(guest);
      } else {
        this.shownRowByGuest.set(guest, first);
        after.add(first);
      }
    }
    this.lobbyGuestsToRefresh.clear();
    const removed = [...before]
      .filter((userKey) => !after.has(userKey))
      .map((userKey) => ({ userKey, outcome: this.lobbyOutcomes.get(userKey) }));
    const added = [...after]
      .filter((userKey) => !before.has(userKey))
      .flatMap((userKey) => this.pendingClients.get(userKey) ?? []);
    this.lobbyOutcomes.clear();
    return { removed, added };
  }

  private startWaiting(request: WaitingRequest): void {
    this.pendingClients.set(request.userKey, request);
    if (this.waitingGuestByKey.has(request.userKey)) return;
    const guest = this.guestOfKey(request.userKey);
    this.lobbyGuestsToRefresh.add(guest);
    this.waitingGuestByKey.set(request.userKey, {
      guest,
      arrival: (this.lobbyClock += 1),
    });
    const userKeys = this.waitingKeysByGuest.get(guest);
    if (userKeys) userKeys.push(request.userKey);
    else this.waitingKeysByGuest.set(guest, [request.userKey]);
  }

  private stopWaiting(userKey: string): void {
    this.pendingClients.delete(userKey);
    const filed = this.waitingGuestByKey.get(userKey);
    if (!filed) return;
    this.lobbyGuestsToRefresh.add(filed.guest);
    this.waitingGuestByKey.delete(userKey);
    const others = (this.waitingKeysByGuest.get(filed.guest) ?? []).filter(
      (key) => key !== userKey,
    );
    if (others.length > 0) this.waitingKeysByGuest.set(filed.guest, others);
    else this.waitingKeysByGuest.delete(filed.guest);
  }

  /** Whether the room knows `userKey` as a key of the pass behind `guestProof`. */
  isGuestKeyOfPass(userKey: string, guestProof: string): boolean {
    return this.guestProofsByUserKey.get(userKey) === guestProof;
  }

  /**
   * Admits `userKey` on behalf of a join that is being decided right now and
   * that the caller vouches for: one that redeems a host's admission, or one
   * that presents a recovery pass after a restart. The admission is bound to
   * the proof the join carries. Returns false for a blocked guest and for a
   * key that is bound to another proof.
   */
  restoreAdmission(
    userKey: string,
    guestProof: string | undefined,
    options: { pastLock?: boolean } = {},
  ): boolean {
    const bound = this.guestProofsByUserKey.get(userKey);
    if (bound !== undefined && bound !== guestProof) return false;
    if (this.isBlocked(userKey, guestProof)) return false;
    const newlyBound =
      guestProof !== undefined && isGuestUserKey(userKey) && bound === undefined;
    const newGuest = guestProof !== undefined && !this.guestRecords.has(guestProof);
    if (guestProof !== undefined && isGuestUserKey(userKey)) {
      this.bindGuestProof(userKey, guestProof);
    }
    const kept =
      this.recordAdmissions([
        {
          userKey,
          scopes: options.pastLock ? ["waitingRoom", "lock"] : ["waitingRoom"],
        },
      ]).status === "admitted";
    if (!kept && newlyBound) this.unbindGuestProof(userKey);
    if (!kept && newGuest && guestProof !== undefined) this.guestRecords.delete(guestProof);
    return kept;
  }

  /**
   * An admission for one join that the host cannot name by key yet, such as
   * a voice agent that has not joined. The join presents the code and is let
   * in past the waiting room and the lock. A code admits one join and
   * expires after two minutes.
   */
  createAdmission(): { admissionCode: string; expiresAt: number } {
    const now = Date.now();
    for (const [code, expiresAt] of this.openAdmissions) {
      if (expiresAt <= now) this.openAdmissions.delete(code);
    }
    if (this.openAdmissions.size >= MAX_OPEN_ADMISSIONS) {
      const oldest = this.openAdmissions.keys().next().value;
      if (oldest !== undefined) this.openAdmissions.delete(oldest);
    }
    const admissionCode = randomBytes(24).toString("base64url");
    const expiresAt = now + ADMISSION_TTL_MS;
    this.openAdmissions.set(admissionCode, expiresAt);
    return { admissionCode, expiresAt };
  }

  redeemAdmission(
    admissionCode: string,
    userKey: string,
    guestProof: string | undefined,
  ): boolean {
    const expiresAt = this.openAdmissions.get(admissionCode);
    if (expiresAt === undefined || expiresAt <= Date.now()) return false;
    if (!this.restoreAdmission(userKey, guestProof, { pastLock: true })) {
      return false;
    }
    this.openAdmissions.delete(admissionCode);
    return true;
  }

  private releaseUnheldGuestIdentities(): void {
    for (const userKey of this.guestIdentitiesToRelease) {
      if (!this.holdsUserKey(userKey)) {
        this.unbindGuestProof(userKey);
      }
    }
    this.guestIdentitiesToRelease.clear();
    this.trimGuestRecords();
  }

  setUserIdentity(
    userId: string,
    userKey: string,
    displayName: string,
    options?: { forceDisplayName?: boolean; guestProof?: string },
  ): void {
    this.userKeysById.set(userId, userKey);
    if (options?.guestProof) {
      this.bindGuestProof(userKey, options.guestProof);
    }
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
      if (this.gameGeneration?.requestedBy === clientId) {
        this.gameGeneration.controller.abort();
        this.gameGeneration = null;
      }
      this.updateClientModeCounts(client, -1);
      this.clearWebinarAudioProducersForUser(clientId);
      this.removeClientProducerIndexes(clientId);
      client.close();
      this.clients.delete(clientId);
      this.refreshWebcamReceiverCapacityProofs();
      this.scheduleWebcamCodecPolicyUpgrade();
    }
    const departingUserKey = this.userKeysById.get(clientId);
    this.userKeysById.delete(clientId);
    this.handRaisedByUserId.delete(clientId);
    this.webinarRaisedHandAt.delete(clientId);
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
        this.releaseGuestIdentity(departingUserKey);
      }
    }
    if (this.webinarActiveSpeakerUserId === clientId) {
      this.webinarActiveSpeakerUserId = null;
    }
    if (this.webinarDominantSpeakerUserId === clientId) {
      this.webinarDominantSpeakerUserId = null;
    }
    this.notifyLifecycle("membership");
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

  // ── Webinar attendee interaction (hands, Q&A, stage invites) ──────────

  setWebinarHandRaised(userId: string, raised: boolean): boolean {
    if (raised) {
      if (this.webinarRaisedHandAt.has(userId)) return false;
      this.webinarRaisedHandAt.set(userId, Date.now());
      return true;
    }
    return this.webinarRaisedHandAt.delete(userId);
  }

  getWebinarHandQueue(): WebinarHandQueueEntry[] {
    const queue: WebinarHandQueueEntry[] = [];
    for (const [userId, raisedAt] of this.webinarRaisedHandAt) {
      const client = this.clients.get(userId);
      if (!client || !client.isWebinarAttendee) continue;
      queue.push({
        userId,
        displayName: this.getDisplayNameForUser(userId) || userId,
        raisedAt,
      });
    }
    queue.sort((a, b) => a.raisedAt - b.raisedAt);
    return queue;
  }

  submitWebinarQuestion(
    userId: string,
    displayName: string,
    question: string,
  ): { entry: WebinarQaEntry; evictedIds: string[] } | { error: string } {
    let openForUser = 0;
    for (const state of this.webinarQaEntries.values()) {
      if (
        state.userId === userId &&
        (state.status === "pending" || state.status === "answering")
      ) {
        openForUser += 1;
      }
    }
    if (openForUser >= MAX_WEBINAR_OPEN_QUESTIONS_PER_USER) {
      return {
        error: "You already have questions waiting. Give the host a moment.",
      };
    }

    this.webinarQaSequence += 1;
    const now = Date.now();
    const state: WebinarQaEntryState = {
      id: `q${this.webinarQaSequence}-${now.toString(36)}`,
      userId,
      displayName,
      question,
      status: "pending",
      askedAt: now,
      updatedAt: now,
      upvoterUserIds: new Set<string>(),
    };
    this.webinarQaEntries.set(state.id, state);
    const evictedIds = this.evictWebinarQaOverflow();
    return { entry: this.projectWebinarQaEntry(state, userId), evictedIds };
  }

  toggleWebinarQuestionUpvote(
    userId: string,
    questionId: string,
  ): WebinarQaEntryState | null {
    const state = this.webinarQaEntries.get(questionId);
    if (!state || state.status === "dismissed") return null;
    if (!state.upvoterUserIds.delete(userId)) {
      state.upvoterUserIds.add(userId);
    }
    state.updatedAt = Date.now();
    return state;
  }

  moderateWebinarQuestion(
    questionId: string,
    action: "answering" | "answered" | "dismissed" | "reopen",
    options?: { answerText?: string; moderatorName?: string },
  ): WebinarQaEntryState | null {
    const state = this.webinarQaEntries.get(questionId);
    if (!state) return null;

    switch (action) {
      case "answering":
        state.status = "answering";
        state.answeredByName = options?.moderatorName ?? state.answeredByName;
        break;
      case "answered":
        state.status = "answered";
        state.answeredByName = options?.moderatorName ?? state.answeredByName;
        if (options?.answerText !== undefined) {
          state.answerText = options.answerText || undefined;
        }
        break;
      case "dismissed":
        state.status = "dismissed";
        break;
      case "reopen":
        state.status = "pending";
        break;
    }
    state.updatedAt = Date.now();
    return state;
  }

  getWebinarQaEntryState(questionId: string): WebinarQaEntryState | null {
    return this.webinarQaEntries.get(questionId) ?? null;
  }

  projectWebinarQaEntry(
    state: WebinarQaEntryState,
    viewerUserId?: string,
  ): WebinarQaEntry {
    return {
      id: state.id,
      userId: state.userId,
      displayName: state.displayName,
      question: state.question,
      status: state.status,
      askedAt: state.askedAt,
      updatedAt: state.updatedAt,
      upvotes: state.upvoterUserIds.size,
      ...(viewerUserId
        ? { hasUpvoted: state.upvoterUserIds.has(viewerUserId) }
        : {}),
      ...(state.answerText ? { answerText: state.answerText } : {}),
      ...(state.answeredByName ? { answeredByName: state.answeredByName } : {}),
    };
  }

  /** Attendees see their own questions plus everything the host surfaced. */
  isWebinarQaEntryVisibleTo(
    state: WebinarQaEntryState,
    viewerUserId: string,
    isModerator: boolean,
  ): boolean {
    if (isModerator) return true;
    if (state.userId === viewerUserId) return true;
    return state.status === "answering" || state.status === "answered";
  }

  getWebinarQaSnapshotFor(
    viewerUserId: string,
    isModerator: boolean,
  ): WebinarQaEntry[] {
    const entries: WebinarQaEntry[] = [];
    for (const state of this.webinarQaEntries.values()) {
      if (!this.isWebinarQaEntryVisibleTo(state, viewerUserId, isModerator)) {
        continue;
      }
      entries.push(this.projectWebinarQaEntry(state, viewerUserId));
    }
    return entries;
  }

  /** Trims the store to its cap; returns the ids removed so callers can
   * broadcast the removals (silent eviction leaves ghost rows on clients). */
  private evictWebinarQaOverflow(): string[] {
    const evictedIds: string[] = [];
    if (this.webinarQaEntries.size <= MAX_WEBINAR_QA_ENTRIES) return evictedIds;
    const byPriority: WebinarQaStatus[] = ["dismissed", "answered", "pending"];
    for (const status of byPriority) {
      for (const [id, state] of this.webinarQaEntries) {
        if (this.webinarQaEntries.size <= MAX_WEBINAR_QA_ENTRIES) {
          return evictedIds;
        }
        if (state.status === status) {
          this.webinarQaEntries.delete(id);
          evictedIds.push(id);
        }
      }
    }
    for (const id of this.webinarQaEntries.keys()) {
      if (this.webinarQaEntries.size <= MAX_WEBINAR_QA_ENTRIES) {
        return evictedIds;
      }
      this.webinarQaEntries.delete(id);
      evictedIds.push(id);
    }
    return evictedIds;
  }

  /**
   * A host invites the guest behind `userKey` onto the stage. The invite is
   * the guest's, under every linked pass, so the guest's stage tab is let in
   * whatever key it comes back under. It also ends an earlier move back to
   * the audience; nothing else does. Returns false when the decision record
   * could not keep the invite, and nothing changed.
   */
  promoteWebinarUserKey(userKey: string): boolean {
    const principal = this.principalOf(userKey);
    return this.admissions.admitAll(
      [
        {
          principal,
          userKey,
          scopes: ["stage"],
          expiresAt: Date.now() + WEBINAR_PROMOTION_TTL_MS,
        },
        { principal, userKey, scopes: ["stageDemotion"] },
      ],
      this.tick(),
      { answersRequest: false },
    );
  }

  /** A host takes back the stage invite of the guest behind `userKey`. */
  revokeWebinarPromotion(userKey: string): boolean {
    const hadInvite = this.isWebinarPromotedUserKey(userKey);
    this.admissions.revoke(
      this.refusalPrincipalsOf(userKey),
      ["stage"],
      this.tick(),
    );
    this.releaseGuestIdentity(userKey);
    return hadInvite;
  }

  /**
   * The guest behind `userKey` declines its stage invite. The invite is
   * used up and nothing is recorded, so a decline never adds to the
   * decision record. A guest with no invite declines nothing.
   */
  declineStageInvite(userKey: string): boolean {
    if (!this.isWebinarPromotedUserKey(userKey)) return false;
    const named = this.admissions.consume(
      this.principalsOfRequest(userKey),
      "stage",
    );
    for (const key of new Set([userKey, ...named])) {
      this.releaseGuestIdentity(key);
    }
    return true;
  }

  /**
   * Whether a join as `userKey` may go on stage: the latest stage decision
   * across what the join speaks for is an invite that has not expired.
   */
  hasStageInvite(
    userKey: string,
    roomGuestProof: string | undefined,
    link?: GuestLinkPlan,
  ): boolean {
    return this.admissions.admits(
      this.principalsOfJoin(userKey, roomGuestProof, rightsPassesOf(link)),
      "stage",
    );
  }

  stageInviteKeys(
    userKey: string,
    roomGuestProof: string | undefined,
    link?: GuestLinkPlan,
  ): string[] {
    return this.admissions.namedKeys(
      this.principalsOfJoin(userKey, roomGuestProof, rightsPassesOf(link)),
      "stage",
    );
  }

  isWebinarPromotedUserKey(userKey: string): boolean {
    const invited = this.admissions.admits(
      this.principalsOfRequest(userKey),
      "stage",
    );
    // An invite that ran out no longer holds the key's binding.
    if (!invited) this.releaseGuestIdentity(userKey);
    return invited;
  }

  /**
   * A host moves the guest behind `userKey` back to the audience. Every stage
   * invite the guest holds ends, under every linked pass, and the guest may
   * not come back as a participant until a newer invite.
   */
  markWebinarDemotedUserKey(userKey: string): void {
    this.admissions.revoke(
      this.refusalPrincipalsOf(userKey),
      ["stage", "stageDemotion"],
      this.tick(),
    );
    this.releaseGuestIdentity(userKey);
  }

  /**
   * Whether the guest behind `userKey` was moved back to the audience and
   * not invited since. A refusal follows any proof the join carries.
   */
  isWebinarDemotedUserKey(
    userKey: string,
    guestProof?: string,
    link?: GuestLinkPlan,
  ): boolean {
    return this.admissions.refuses(
      this.principalsOfJoin(userKey, guestProof, link?.passes),
      "stageDemotion",
    );
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

  /**
   * Toggle `userId`'s `emoji` reaction on a retained chat message.
   *
   * Reactions are stored on the retained message itself, so they replay to late
   * joiners via getChatHistorySnapshot() and are evicted with the message. Only
   * broadcast messages are retained (see recordChatMessage), so direct messages
   * cannot be reacted to — the handler surfaces that as "Message not found".
   */
  toggleChatMessageReaction(
    messageId: string,
    userId: string,
    emoji: string,
  ): ToggleChatReactionResult {
    const message = this.recentChatMessages.find((m) => m.id === messageId);
    if (!message) {
      return { ok: false, reason: "not-found" };
    }

    const reactions = message.reactions ?? [];
    const existing = reactions.find((r) => r.emoji === emoji);

    if (existing) {
      const index = existing.userIds.indexOf(userId);
      if (index === -1) {
        existing.userIds.push(userId);
      } else {
        existing.userIds.splice(index, 1);
      }
    } else {
      // Only adding a *new* emoji can grow the set, so this is the only place
      // the cap needs enforcing. Removals below can shrink it again.
      if (reactions.length >= MAX_REACTIONS_PER_CHAT_MESSAGE) {
        return { ok: false, reason: "too-many-reactions" };
      }
      reactions.push({ emoji, userIds: [userId] });
    }

    // Drop emoji nobody is reacting with so counts never render as zero.
    const remaining = reactions.filter((r) => r.userIds.length > 0);
    message.reactions = remaining.length > 0 ? remaining : undefined;

    return { ok: true, reactions: remaining };
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

  async createWebRtcTransport(
    role: WebRtcTransportRole,
  ): Promise<WebRtcTransport> {
    if (!this.webRtcServer) throw new Error("Room has no WebRTC server");
    const transport = await this.router.createWebRtcTransport({
      webRtcServer: this.webRtcServer,
      enableUdp: config.webRtcTransport.enableUdp,
      enableTcp: config.webRtcTransport.enableTcp,
      preferUdp: config.webRtcTransport.preferUdp,
      appData: { role },
      ...(role === "consumer"
        ? {
            initialAvailableOutgoingBitrate:
              config.webRtcTransport.initialAvailableOutgoingBitrate,
          }
        : {}),
    });

    if (role === "producer") {
      await transport.setMaxIncomingBitrate(
        config.webRtcTransport.producerMaxIncomingBitrate,
      );
    }

    return transport;
  }

  setWebinarFeedRefreshNotifier(
    notifier: ((room: Room) => void) | null,
  ): void {
    this.webinarFeedRefreshNotifier = notifier;
  }

  private emitMeetingActiveSpeakerChanged(userId: string | null): void {
    const notification: ActiveSpeakerChangedNotification = {
      roomId: this.id,
      userId,
    };

    const recipients: string[] = [];
    let namespace: Socket["nsp"] | undefined;
    for (const client of this.clients.values()) {
      if (client.isWebinarAttendee) continue;
      recipients.push(client.socket.id);
      namespace ??= client.socket.nsp;
    }
    // Encode once for the local meeting sockets. Webinar attendees have a
    // separate active-speaker signal and must stay out of this audience.
    namespace?.local.to(recipients).emit("activeSpeakerChanged", notification);
  }

  private setMeetingActiveSpeakerUserId(
    userId: string | null,
    options?: { force?: boolean },
  ): void {
    if (!options?.force && this.meetingActiveSpeakerUserId === userId) {
      return;
    }

    this.meetingActiveSpeakerUserId = userId;
    this.emitMeetingActiveSpeakerChanged(userId);
  }

  private announceMeetingActiveSpeakerSignal(): void {
    if (this.meetingActiveSpeakerSignalAnnounced) {
      return;
    }

    this.meetingActiveSpeakerSignalAnnounced = true;
    this.setMeetingActiveSpeakerUserId(this.meetingActiveSpeakerUserId, {
      force: true,
    });
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
              ownerClient.isWebinarAttendee ||
              !this.clientHasUnpausedWebcamAudio(ownerClient)
            ) {
              return;
            }

            this.setMeetingActiveSpeakerUserId(ownerUserId);

            if (this.webinarDominantSpeakerUserId === ownerUserId) {
              return;
            }

            this.webinarDominantSpeakerUserId = ownerUserId;
            this.requestWebinarFeedRefresh();
          });

          observer.on("silence", () => {
            this.setMeetingActiveSpeakerUserId(null);

            if (!this.webinarDominantSpeakerUserId) {
              return;
            }

            const dominantClient = this.clients.get(
              this.webinarDominantSpeakerUserId,
            );
            if (
              dominantClient &&
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
      this.announceMeetingActiveSpeakerSignal();
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
    const clearActiveSpeakerIfPaused = () => {
      const ownerUserId = this.webinarWebcamAudioProducerOwners.get(producer.id);
      if (!ownerUserId || this.meetingActiveSpeakerUserId !== ownerUserId) {
        return;
      }

      const ownerClient = this.clients.get(ownerUserId);
      if (!ownerClient || !this.clientHasUnpausedWebcamAudio(ownerClient)) {
        this.setMeetingActiveSpeakerUserId(null);
      }
    };

    producer.on("transportclose", cleanup);
    producer.observer.on("pause", clearActiveSpeakerIfPaused);
    producer.observer.on("close", cleanup);
  }

  private async unregisterWebinarAudioProducer(
    producerId: string,
  ): Promise<void> {
    const ownerUserId = this.webinarWebcamAudioProducerOwners.get(producerId);
    this.webinarWebcamAudioProducerOwners.delete(producerId);
    const ownerHasRemainingProducer =
      !!ownerUserId &&
      Array.from(this.webinarWebcamAudioProducerOwners.values()).some(
        (value) => value === ownerUserId,
      );

    if (this.webinarAudioLevelObserver) {
      try {
        await this.webinarAudioLevelObserver.removeProducer({ producerId });
      } catch {
        // Ignore remove races when producer already disappeared.
      }
    }

    if (
      ownerUserId &&
      this.meetingActiveSpeakerUserId === ownerUserId &&
      !ownerHasRemainingProducer
    ) {
      this.setMeetingActiveSpeakerUserId(null);
    }

    if (
      ownerUserId &&
      this.webinarDominantSpeakerUserId === ownerUserId &&
      !ownerHasRemainingProducer
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
    if (this.meetingActiveSpeakerUserId === userId) {
      this.setMeetingActiveSpeakerUserId(null);
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
    this.refreshWebcamReceiverCapacityProofs();
  }

  clearScreenShareProducer(producerId: string) {
    if (this.currentScreenShareProducerId === producerId) {
      this.currentScreenShareProducerId = null;
      this.refreshWebcamReceiverCapacityProofs();
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
      producerSeq: entry.seq,
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

  private indexProducer(
    entry: Omit<ProducerIndexEntry, "seq">,
    options?: { skipWebcamReceiverCapacityRefresh?: boolean },
  ): void {
    this.producerIndex.set(entry.producer.id, {
      ...entry,
      seq: nextProducerSeq(),
    });

    const cleanup = () => {
      this.removeProducerIndexById(entry.producer.id, entry.producer);
      if (
        !entry.system &&
        entry.type === "webcam" &&
        entry.producer.kind === "video"
      ) {
        queueMicrotask(() => {
          if (!this.router.closed) this.scheduleWebcamCodecPolicyUpgrade();
        });
      }
    };

    entry.producer.on("transportclose", cleanup);
    entry.producer.observer.on("close", cleanup);
    if (
      !options?.skipWebcamReceiverCapacityRefresh &&
      !entry.system &&
      entry.type === "webcam" &&
      entry.producer.kind === "video"
    ) {
      this.refreshWebcamReceiverCapacityProof(entry.producer.id);
    }
  }

  removeProducerIndexById(producerId: string, producer?: Producer): void {
    const activeEntry = this.producerIndex.get(producerId);
    if (!activeEntry) {
      return;
    }
    if (producer && activeEntry.producer.id !== producer.id) {
      return;
    }
    if (
      !activeEntry.system &&
      activeEntry.type === "webcam" &&
      activeEntry.producer.kind === "video"
    ) {
      this.webcamReceiverCapacityProofCoordinator.remove(producerId);
    }
    this.producerIndex.delete(producerId);
  }

  private removeClientProducerIndexes(userId: string): void {
    for (const [producerId, entry] of this.producerIndex) {
      if (!entry.system && entry.userId === userId) {
        this.removeProducerIndexById(producerId, entry.producer);
      }
    }
  }

  getAllProducers(excludeClientId?: string): ProducerInfo[] {
    const producers: ProducerInfo[] = [];

    for (const [producerId, entry] of this.producerIndex) {
      if (!this.isProducerIndexEntryActive(producerId, entry)) {
        this.removeProducerIndexById(producerId, entry.producer);
        continue;
      }
      if (excludeClientId && entry.userId === excludeClientId) {
        continue;
      }
      if (!this.producerMatchesCurrentWebcamCodecPolicy(entry.producer, entry.type)) {
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
      this.removeProducerIndexById(producerId, entry.producer);
      return null;
    }
    return this.producerInfoFromIndexEntry(entry);
  }

  producerMatchesCurrentWebcamCodecPolicy(
    producer: Producer,
    type: ProducerType,
  ): boolean {
    if (type !== "webcam" || producer.kind !== "video") return true;
    return this.rtpParametersMatchCurrentWebcamCodecPolicy(
      producer.rtpParameters,
    );
  }

  rtpParametersMatchCurrentWebcamCodecPolicy(rtpParameters: unknown): boolean {
    return producerMatchesWebcamCodecPolicy(
      rtpParameters,
      this.currentWebcamCodecPolicy,
    );
  }

  producerIdMatchesCurrentWebcamCodecPolicy(producerId: string): boolean {
    const entry = this.producerIndex.get(producerId);
    if (!entry || !this.isProducerIndexEntryActive(producerId, entry)) {
      return false;
    }
    return this.producerMatchesCurrentWebcamCodecPolicy(
      entry.producer,
      entry.type,
    );
  }

  getTranscriptAudioProducerEntries(): TranscriptAudioProducerEntry[] {
    const entries: TranscriptAudioProducerEntry[] = [];
    for (const [producerId, entry] of this.producerIndex) {
      if (!this.isProducerIndexEntryActive(producerId, entry)) {
        this.removeProducerIndexById(producerId, entry.producer);
        continue;
      }
      if (entry.producer.kind !== "audio") {
        continue;
      }
      const owner = this.clients.get(entry.userId);
      if (!owner || owner.isWebinarAttendee) {
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
        this.removeProducerIndexById(producerId, entry.producer);
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

  // No one is in the meeting. Those waiting to be let in are not in it, so
  // they keep no meeting going; they wait for the next one at the code.
  isEmpty(): boolean {
    return this.clients.size === 0;
  }

  get isLocked(): boolean {
    return this._isLocked;
  }

  setLocked(locked: boolean): void {
    this._isLocked = locked;
    // A lock starts afresh: an admission past an earlier lock does not
    // carry over.
    if (locked) {
      for (const userKey of this.admissions.lockStarted(this.tick())) {
        this.releaseGuestIdentity(userKey);
      }
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

  get areImageAttachmentsEnabled(): boolean {
    return this._areImageAttachmentsEnabled;
  }

  setImageAttachmentsEnabled(enabled: boolean): void {
    this._areImageAttachmentsEnabled = enabled;
  }

  addChatImageAsset(
    asset: RoomChatImageAsset,
  ): { ok: true } | { ok: false; error: string } {
    if (this.chatImageAssets.has(asset.id)) {
      return { ok: false, error: "Image attachment already exists." };
    }
    if (asset.size <= 0 || asset.size > MAX_CHAT_IMAGE_BYTES) {
      return { ok: false, error: "Images must be 6 MB or smaller." };
    }
    if (this.chatImageBytes + asset.size > MAX_CHAT_IMAGE_ROOM_BYTES) {
      return {
        ok: false,
        error: "This room has reached its temporary image limit.",
      };
    }

    let userBytes = 0;
    for (const existing of this.chatImageAssets.values()) {
      if (existing.uploadedBy === asset.uploadedBy) {
        userBytes += existing.size;
      }
    }
    if (userBytes + asset.size > MAX_CHAT_IMAGE_USER_BYTES) {
      return {
        ok: false,
        error: "You have reached the temporary image limit for this room.",
      };
    }

    this.chatImageAssets.set(asset.id, asset);
    this.chatImageBytes += asset.size;
    if (!asset.attached) {
      const expiryTimer = setTimeout(() => {
        this.removeUnattachedChatImageAsset(asset.id, asset.uploadedBy);
      }, CHAT_IMAGE_ORPHAN_TTL_MS);
      expiryTimer.unref();
      this.chatImageExpiryTimers.set(asset.id, expiryTimer);
    }
    return { ok: true };
  }

  getChatImageAsset(assetId: string): RoomChatImageAsset | undefined {
    return this.chatImageAssets.get(assetId);
  }

  markChatImageAssetAttached(assetId: string, userId: string): boolean {
    const asset = this.chatImageAssets.get(assetId);
    if (!asset || asset.uploadedBy !== userId) return false;
    asset.attached = true;
    const expiryTimer = this.chatImageExpiryTimers.get(assetId);
    if (expiryTimer) {
      clearTimeout(expiryTimer);
      this.chatImageExpiryTimers.delete(assetId);
    }
    return true;
  }

  removeUnattachedChatImageAsset(assetId: string, userId: string): boolean {
    const asset = this.chatImageAssets.get(assetId);
    if (!asset || asset.uploadedBy !== userId || asset.attached) return false;
    this.chatImageAssets.delete(assetId);
    this.chatImageBytes = Math.max(0, this.chatImageBytes - asset.size);
    const expiryTimer = this.chatImageExpiryTimers.get(assetId);
    if (expiryTimer) {
      clearTimeout(expiryTimer);
      this.chatImageExpiryTimers.delete(assetId);
    }
    return true;
  }

  get isReactionsDisabled(): boolean {
    return this._reactionsDisabled;
  }

  setReactionsDisabled(disabled: boolean): void {
    this._reactionsDisabled = disabled;
  }

  get isParticipantUnmuteAllowed(): boolean {
    return this._participantUnmuteAllowed;
  }

  setParticipantUnmuteAllowed(allowed: boolean): void {
    this._participantUnmuteAllowed = allowed;
  }

  get isParticipantVideoAllowed(): boolean {
    return this._participantVideoAllowed;
  }

  setParticipantVideoAllowed(allowed: boolean): void {
    this._participantVideoAllowed = allowed;
  }

  get requiresMeetingInviteCode(): boolean {
    return Boolean(this._meetingInviteCodeHash);
  }

  get meetingInviteCodeVersion(): string {
    return this._meetingInviteCodeVersion;
  }

  private assignMeetingInviteCodeHash(hash: string | null): void {
    this._meetingInviteCodeHash = hash;
    this._meetingInviteCodeVersion = newInviteCodeVersion(hash);
  }

  setMeetingInviteCode(inviteCode: string | null): boolean {
    const normalizedInviteCode = normalizeInviteCode(inviteCode);
    const nextHash = normalizedInviteCode
      ? hashInviteCode(normalizedInviteCode)
      : null;
    if (this._meetingInviteCodeHash === nextHash) {
      return false;
    }
    this.assignMeetingInviteCodeHash(nextHash);
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
      if (client instanceof Admin) {
        admins.push(client);
      }
    }
    return admins;
  }

  isAdminClient(client: Client): boolean {
    return client instanceof Admin && !client.isObserver;
  }

  getAdminUserIds(): string[] {
    const userIds: string[] = [];
    for (const client of this.clients.values()) {
      if (client instanceof Admin) {
        userIds.push(client.id);
      }
    }
    return userIds;
  }

  get adminUserKeys(): ReadonlySet<string> {
    return new Set(this.hostReasonsByKey.keys());
  }

  get hostReasons(): ReadonlyMap<string, HostReason> {
    return new Map(this.hostReasonsByKey);
  }

  hostReasonOf(userKey: string, guestProof?: string): HostReason | null {
    let strongest: HostReason | null = null;
    for (const key of this.identitiesOfSameGuest(userKey, guestProof)) {
      const reason = this.hostReasonsByKey.get(key);
      if (reason && (!strongest || HOST_REASON_RANK[reason] > HOST_REASON_RANK[strongest])) {
        strongest = reason;
      }
    }
    return strongest;
  }

  private hostReasonFor(userKey: string, basis: HostBasis): HostReason {
    if (basis === "owner" || (this.ownerEmail !== null && userKey === this.ownerEmail)) {
      return "owner";
    }
    if (basis === "promoted") return "cohost";
    return this.ownerEmail ? "temporary" : "opener";
  }

  grantHost(userKey: string, basis: HostBasis, guestProof?: string): Admin[] {
    const reason = this.hostReasonFor(userKey, basis);
    const held = this.hostReasonOf(userKey, guestProof);
    const kept = held && HOST_REASON_RANK[held] >= HOST_REASON_RANK[reason] ? held : reason;
    let changed = false;
    for (const key of this.identitiesOfSameGuest(userKey, guestProof)) {
      if (key !== userKey && !this.hostReasonsByKey.has(key)) continue;
      if (this.hostReasonsByKey.get(key) === kept) continue;
      this.hostReasonsByKey.set(key, kept);
      changed = true;
    }
    if (changed) this.onRecoverableChange?.();
    return this.promoteSeatsOf(userKey);
  }

  seatsOf(userKey: string): Client[] {
    return this.seatsOfSameGuest(userKey).flatMap((seatId) => this.clients.get(seatId) ?? []);
  }

  private promoteSeatsOf(userKey: string): Admin[] {
    const promoted: Admin[] = [];
    for (const client of this.seatsOf(userKey)) {
      if (client instanceof Admin || client.isWebinarAttendee || client.isObserver) continue;
      const key = this.userKeysById.get(client.id);
      if (key === undefined || !this.isAdminUserKey(key, this.guestProofsByUserKey.get(key))) {
        continue;
      }
      Object.setPrototypeOf(client, Admin.prototype);
      promoted.push(client as Admin);
    }
    if (promoted.length > 0) this.publishRoles({ promoted });
    return promoted;
  }

  makePrimaryHost(userKey: string): void {
    if (!this.hostReasonsByKey.has(userKey) || this.primaryHostUserKey === userKey) return;
    this.primaryHostUserKey = userKey;
    this.onRecoverableChange?.();
    this.publishRoles({});
  }

  private publishRoles(change: { promoted?: readonly Client[]; demoted?: readonly Client[] }): void {
    this.notifyLifecycle("membership");
    const roomId = this.id;
    const hostUserId = this.getHostUserId();
    const hostUserIds = this.getAdminUserIds();
    for (const seat of change.promoted ?? []) {
      seat.socket.emit("hostAssigned", { roomId, hostUserId: hostUserId ?? seat.id });
    }
    for (const seat of change.demoted ?? []) {
      seat.socket.emit("hostRemoved", { roomId, hostUserId });
    }
    for (const client of this.clients.values()) {
      client.socket.emit("hostChanged", { roomId, hostUserId });
      client.socket.emit("adminUsersChanged", { roomId, hostUserIds });
    }
  }

  private revokeHostOf(userKeys: readonly string[]): Client[] {
    let changed = false;
    for (const userKey of userKeys) {
      if (this.hostReasonsByKey.delete(userKey)) changed = true;
      if (this.primaryHostUserKey === userKey) {
        this.primaryHostUserKey = null;
        changed = true;
      }
    }
    if (changed) this.onRecoverableChange?.();
    const demoted = this.demoteSeatsWithoutRights();
    if (changed && demoted.length === 0) this.publishRoles({});
    return demoted;
  }

  private demoteSeatsWithoutRights(): Client[] {
    const demoted: Client[] = [];
    for (const [userId, client] of this.clients) {
      if (!(client instanceof Admin) || client.isObserver) continue;
      const userKey = this.userKeysById.get(userId);
      if (userKey === undefined) continue;
      if (this.isAdminUserKey(userKey, this.guestProofsByUserKey.get(userKey))) continue;
      Object.setPrototypeOf(client, Client.prototype);
      demoted.push(client);
    }
    if (demoted.length > 0) this.publishRoles({ demoted });
    return demoted;
  }

  welcomeOwner(ownerKey: string): Client[] {
    const demoted: Client[] = [];
    for (const [userKey, reason] of [...this.hostReasonsByKey]) {
      if (reason !== "temporary" || this.hostReasonOf(userKey) !== "temporary") continue;
      demoted.push(...this.demoteToParticipant(userKey));
    }
    this.makePrimaryHost(ownerKey);
    return demoted;
  }

  tellOwnerTookOver(demoted: Client[]): void {
    for (const client of demoted) {
      client.socket.emit("adminNotice", {
        roomId: this.id,
        message: "The meeting's owner joined and is hosting now. You're a participant.",
        level: "info",
        timestamp: Date.now(),
      });
    }
  }

  // Someone who is in this meeting, hosts it, or was let in. Only they may
  // see how many people are in it.
  isMemberUserKey(userKey: string, guestProof?: string): boolean {
    if (this.isBlocked(userKey, guestProof)) return false;
    if (
      this.isAdminUserKey(userKey, guestProof) ||
      this.isAllowed(userKey, guestProof) ||
      this.isLockedAllowed(userKey, guestProof)
    ) {
      return true;
    }
    for (const key of this.userKeysById.values()) {
      if (this.isSamePerson(userKey, key, guestProof)) return true;
    }
    return false;
  }

  /** Whether the guest behind `userKey` is a co-host. A blocked guest never is. */
  isAdminUserKey(
    userKey: string,
    guestProof?: string,
    link?: GuestLinkPlan,
  ): boolean {
    return (
      !this.isBlocked(userKey, guestProof, link) &&
      this.guestHolds(
        this.adminUserKeys,
        userKey,
        guestProof,
        rightsPassesOf(link),
      )
    );
  }

  hasLiveHostSeat(userKey: string, guestProof?: string, link?: GuestLinkPlan): boolean {
    for (const [seatId, client] of this.clients) {
      if (!(client instanceof Admin) || client.isObserver || !client.socket.connected) continue;
      const key = this.userKeysById.get(seatId);
      if (key !== undefined && this.guestHolds([key], userKey, guestProof, rightsPassesOf(link))) {
        return true;
      }
    }
    return false;
  }

  /** Whether the guest behind `userKey` is the host. A blocked guest never is. */
  isHostUserKey(
    userKey: string,
    guestProof?: string,
    link?: GuestLinkPlan,
  ): boolean {
    return (
      this.hostUserKey !== null &&
      !this.isBlocked(userKey, guestProof, link) &&
      this.guestHolds(
        [this.hostUserKey],
        userKey,
        guestProof,
        rightsPassesOf(link),
      )
    );
  }

  private dropRejoinGrantsOf(
    userKeys: Iterable<string>,
    options: { recordedOnly?: boolean } = {},
  ): Client[] {
    const keys = [...userKeys];
    this.admissions.revoke(
      keys.flatMap((key) => this.refusalPrincipalsOf(key)),
      ["waitingRoom", "lock", "stage"],
      this.tick(),
      options,
    );
    const demoted = this.revokeHostOf(keys);
    for (const key of keys) this.releaseGuestIdentity(key);
    return demoted;
  }

  promoteClientToAdmin(userId: string, basis: Exclude<HostBasis, "owner">): Admin[] | null {
    const client = this.clients.get(userId);
    const userKey = this.userKeysById.get(userId);
    if (!client || !userKey || client.isWebinarAttendee) {
      return null;
    }
    const guestProof = this.guestProofsByUserKey.get(userKey);
    if (this.isBlocked(userKey, guestProof)) return null;
    if (
      basis === "fallback" &&
      (this.handingOff || this.needsReadmission(userKey, guestProof))
    ) {
      return null;
    }
    const promoted = this.grantHost(userKey, basis);
    if (this.hostReasonOf(userKey) === "owner") {
      this.tellOwnerTookOver(this.welcomeOwner(userKey));
    }
    this.notifyLifecycle("membership");
    return promoted;
  }

  getHostUserId(): string | null {
    if (this.hostUserKey) {
      // The host's own seat, else another tab of the same guest.
      const host = this.personOf(this.hostUserKey);
      let otherTab: string | null = null;
      for (const [userId, userKey] of this.userKeysById.entries()) {
        if (!(this.clients.get(userId) instanceof Admin)) continue;
        if (userKey === this.hostUserKey) return userId;
        if (otherTab === null && this.isKeyOf(host, userKey)) {
          otherTab = userId;
        }
      }
      if (otherTab !== null) return otherTab;
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
    if (!client || client.isWebinarAttendee) {
      return [];
    }

    const producers: ProducerInfo[] = client.getProducerInfos().map((info) => ({
      producerId: info.producerId,
      producerUserId: userId,
      kind: info.kind,
      type: info.type,
      paused: info.paused,
      producerSeq: this.producerIndex.get(info.producerId)?.seq,
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

  /**
   * The webinar "program feed": what every attendee consumes.
   *
   * Audio is NOT curated — attendees always hear every panelist (all
   * non-attendee audio producers, muted ones included so mute toggles flip
   * the paused flag instead of churning consumers). Video is curated: the
   * active screen share plus the presenter's camera (for a picture-in-picture
   * of the presenter), otherwise the dominant speaker's camera.
   */
  getWebinarFeedSnapshot(): {
    speakerUserId: string | null;
    producers: ProducerInfo[];
  } {
    const producers: ProducerInfo[] = [];
    const seenProducerIds = new Set<string>();
    const push = (info: ProducerInfo | null | undefined): void => {
      if (!info || seenProducerIds.has(info.producerId)) return;
      seenProducerIds.add(info.producerId);
      producers.push(info);
    };

    for (const [userId, client] of this.clients.entries()) {
      if (client.isObserver) continue;
      for (const info of this.getClientFeedProducers(userId)) {
        if (info.kind === "audio") push(info);
      }
    }

    const screenShareOwnerUserId = this.getScreenShareOwnerUserId();
    let speakerUserId: string | null = null;
    if (screenShareOwnerUserId) {
      speakerUserId = screenShareOwnerUserId;
      for (const info of this.getClientFeedProducers(screenShareOwnerUserId)) {
        if (info.kind === "video") push(info);
      }
    } else {
      speakerUserId = this.selectWebinarActiveSpeakerUserId();
      if (speakerUserId) {
        for (const info of this.getClientFeedProducers(speakerUserId)) {
          if (info.kind === "video" && info.type === "webcam") push(info);
        }
      }
    }

    return { speakerUserId, producers };
  }

  refreshWebinarFeedSnapshot(): {
    changed: boolean;
    speakerUserId: string | null;
    producers: ProducerInfo[];
  } {
    const snapshot = this.getWebinarFeedSnapshot();
    // Paused state is part of the fingerprint: a mute/camera toggle must
    // reach feed-only viewers even when the producer set is unchanged.
    const producerFingerprints = snapshot.producers
      .map((producer) => `${producer.producerId}:${producer.paused ? 1 : 0}`)
      .sort();
    const changed =
      this.webinarActiveSpeakerUserId !== snapshot.speakerUserId ||
      this.webinarFeedProducerIds.length !== producerFingerprints.length ||
      this.webinarFeedProducerIds.some((fingerprint, index) => {
        return fingerprint !== producerFingerprints[index];
      });

    this.webinarActiveSpeakerUserId = snapshot.speakerUserId;
    this.webinarFeedProducerIds = producerFingerprints;

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
      this.refreshWebcamReceiverCapacityProofs();
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
    this.gameGeneration?.controller.abort();
    this.gameGeneration = null;
    if (this.gameTickTimer) {
      clearInterval(this.gameTickTimer);
      this.gameTickTimer = null;
    }
    this.gameSession = null;
    this.gameVote = null;
  }

  close(): void {
    this.onRecoverableChange = null;
    this.onReadmissionChange = null;
    this.cancelLifecycleTimers();
    this.notifyLifecycle("closed");
    this.lifecycleListeners.clear();
    this.guestIdentityMergeListeners.clear();
    this.aiCredentials.clear();
    this.cancelWebcamCodecPolicyUpgrade();
    this.webcamReceiverCapacityProofCoordinator.close();
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
    for (const expiryTimer of this.chatImageExpiryTimers.values()) {
      clearTimeout(expiryTimer);
    }
    this.chatImageExpiryTimers.clear();
    this.chatImageAssets.clear();
    this.chatImageBytes = 0;
    if (this.webinarAudioLevelObserver) {
      try {
        this.webinarAudioLevelObserver.close();
      } catch {}
      this.webinarAudioLevelObserver = null;
    }
    this.webinarAudioLevelObserverInit = null;
    this.webinarWebcamAudioProducerOwners.clear();
    this.webinarFeedRefreshNotifier = null;
    this.meetingActiveSpeakerUserId = null;
    this.meetingActiveSpeakerSignalAnnounced = false;
    if (!this.router.closed) {
      this.router.close();
    }
    this.userKeysById.clear();
    this.hostReasonsByKey.clear();
    this.primaryHostUserKey = null;
    this.displayNamesByKey.clear();
    this.blockedUsers.clear();
    this.guestProofsByUserKey.clear();
    this.userKeysByGuestProof.clear();
    this.guestRecords.clear();
    this.guestIdentitiesToRelease.clear();
    this.admissions.clear();
    this.shownRowByGuest.clear();
    this.lobbyGuestsToRefresh.clear();
    this.lobbyOutcomes.clear();
    this.openAdmissions.clear();
    this.webinarActiveSpeakerUserId = null;
    this.webinarDominantSpeakerUserId = null;
    this.webinarFeedProducerIds = [];
    this.webinarRaisedHandAt.clear();
    this.webinarQaEntries.clear();
    this.assignMeetingInviteCodeHash(null);
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

  get cleanupDeadline(): number | null {
    return this.cleanupTimer ? this.cleanupTimerDeadline : null;
  }

  startCleanupTimer(callback: () => void) {
    if (this.cleanupTimer || this.handingOff) return;
    this.cleanupTimerDeadline = Date.now() + config.adminCleanupTimeout;

    Logger.debug(
      `Room ${this.id}: Cleanup timer started (${config.adminCleanupTimeout}ms)`,
    );
    this.armLifecycleTimer("cleanupTimer", config.adminCleanupTimeout, () => {
      Logger.debug(`Room ${this.id}: Cleanup timer expired. Dissolving room.`);
      callback();
    });
  }

  stopCleanupTimer() {
    if (this.cleanupTimer) {
      Logger.debug(`Room ${this.id}: Cleanup timer stopped.`);
      this.clearLifecycleTimer("cleanupTimer");
    }
  }

  armOpeningDeadline(delayMs: number, onDeadline: () => void): void {
    this.openingDeadlineAt = Date.now() + delayMs;
    this.armLifecycleTimer("openingDeadlineTimer", delayMs, onDeadline);
  }

  get openingDeadline(): number | null {
    return this.openingDeadlineTimer ? this.openingDeadlineAt : null;
  }

  private armLifecycleTimer(slot: LifecycleTimer, delayMs: number, fire: () => void): void {
    this.clearLifecycleTimer(slot);
    if (this.handingOff) return;
    const timer = setTimeout(() => {
      this[slot] = null;
      if (this.handingOff) return;
      fire();
    }, delayMs);
    timer.unref?.();
    this[slot] = timer;
  }

  private clearLifecycleTimer(slot: LifecycleTimer): void {
    const timer = this[slot];
    if (timer) clearTimeout(timer);
    this[slot] = null;
  }

  private cancelLifecycleTimers(): void {
    for (const slot of LIFECYCLE_TIMERS) this.clearLifecycleTimer(slot);
  }

  addPendingClient(
    userKey: string,
    userId: string,
    socket: Socket,
    displayName?: string,
    guestProof?: string,
  ) {
    if (guestProof) {
      this.bindGuestProof(userKey, guestProof);
    }
    this.startWaiting({ userKey, userId, socket, displayName });
  }

  removePendingClient(userKey: string) {
    this.stopWaiting(userKey);
    this.releaseGuestIdentity(userKey);
  }

  needsReadmission(userKey: string, guestProof?: string, link?: GuestLinkPlan): boolean {
    return (
      this.guestHolds(this.readmissionRequiredUserKeys, userKey, guestProof, link?.passes) ||
      this.admissions.refuses(
        this.principalsOfJoin(userKey, guestProof, link?.passes),
        "waitingRoom",
      )
    );
  }

  // For a mark that was made before this room existed, such as a scheduled
  // meeting's removed invitee. It tells nobody: nothing changed.
  requireReadmission(userKey: string) {
    this.readmissionRequiredUserKeys.add(userKey);
  }

  get usersNeedingReadmission(): string[] {
    return [...this.readmissionRequiredUserKeys];
  }

  private setReadmissionRequired(userKey: string, required: boolean) {
    const marked = this.readmissionRequiredUserKeys.has(userKey);
    if (marked === required) return;
    if (required) this.readmissionRequiredUserKeys.add(userKey);
    else this.readmissionRequiredUserKeys.delete(userKey);
    this.onReadmissionChange?.(userKey, required);
    this.onRecoverableChange?.();
  }

  get hostUserKey(): string | null {
    return this.primaryHostUserKey;
  }

  markEnded() {
    this.endedForEveryone = true;
  }

  get hasEnded(): boolean {
    return this.endedForEveryone;
  }

  // Whether this room is a call of its own that the ledger should describe:
  // not one standing in for a lost call, and not one a host has ended.
  get recordsItsCall(): boolean {
    return this.awaitingOpener === null && this.restorer === null && !this.endedForEveryone;
  }

  beginHandOff(): void {
    this.handingOff = true;
    this.cancelLifecycleTimers();
  }

  get isHandingOff(): boolean {
    return this.handingOff;
  }

  get endsWhenEmpty(): boolean {
    return this.recordsItsCall && !this.handingOff;
  }

  // `rosterKnown` is false when this SFU has no record of the lost call and
  // only knows of it from a pass. It then cannot tell that call's hosts, or
  // whether it was ended, so a pass lets its holder in but never hosts.
  // `onLapse` runs once if the deadline passes with the room still unclaimed.
  awaitRestorer(options: {
    until: number;
    rosterKnown: boolean;
    onLapse: () => void;
  }) {
    this.restorer = { until: options.until, rosterKnown: options.rosterKnown };
    this.armLifecycleTimer(
      "restorerLapseTimer",
      Math.max(0, options.until - Date.now()) + 1,
      () => {
        if (this.restorer === null) return;
        this.endLostCall();
        options.onLapse();
      },
    );
  }

  // "awaited": only someone from the lost call may take the host's seat.
  // "lapsed": that call is not coming back, so the room is open to claim.
  restorerState(now: number): "none" | "awaited" | "lapsed" {
    if (this.restorer === null) return "none";
    return now <= this.restorer.until ? "awaited" : "lapsed";
  }

  get restorerDeadline(): number | null {
    return this.restorer?.until ?? null;
  }

  get knowsLostRoster(): boolean {
    return this.restorer?.rosterKnown !== false;
  }

  // The lost call's time is up, so a meeting opened here is a new one.
  // Everything the lost call left goes with it, all at once: its hosts and
  // co-hosts, a temporary host, and the people its hosts had removed or
  // blocked. Admissions stay: whoever is here is in the new meeting.
  endLostCall() {
    if (this.lostCallEnded) return;
    this.lostCallEnded = true;
    const report = this.onRecoverableChange;
    this.onRecoverableChange = null;
    this.primaryHostUserKey = null;
    this.hostReasonsByKey.clear();
    this.demoteSeatsWithoutRights();
    this.readmissionRequiredUserKeys.clear();
    this.blockedUsers.clear();
    this.onRecoverableChange = report;
    this.onLostCallEnded?.();
  }

  markRestored() {
    this.restorer = null;
    this.clearLifecycleTimer("restorerLapseTimer");
  }

  // Puts back what the ledger held of the call this room recreates: who has
  // to be let in again, then its hosts, less anyone among those. It reports
  // nothing: none of this is news to the ledger.
  restoreLostCall(lost: LostRoom) {
    const report = this.onRecoverableChange;
    this.onRecoverableChange = null;
    this.restoreGuestPasses(lost.guestPasses);
    for (const userKey of lost.readmissionRequiredUserKeys) {
      this.readmissionRequiredUserKeys.add(userKey);
    }
    const coHosts = new Set(lost.coHostUserKeys);
    for (const userKey of lost.adminUserKeys) {
      this.grantHost(userKey, coHosts.has(userKey) ? "promoted" : "fallback");
    }
    if (lost.hostUserKey) this.makePrimaryHost(lost.hostUserKey);
    this.onRecoverableChange = report;
    const endIfUnclaimed = () => {
      if (this.awaitingOpener) this.endLostCall();
    };
    const wait = lost.claimableUntil - Date.now();
    if (wait < 0) {
      endIfUnclaimed();
      return;
    }
    this.armLifecycleTimer("lostCallTimer", wait + 1, endIfUnclaimed);
  }

  /**
   * Turns away the request of `userKey` without a decision of its own: the
   * guest turned out to be blocked, and the block is the answer.
   */
  turnAwayBlockedRequest(userKey: string): void {
    if (!this.pendingClients.has(userKey)) return;
    this.lobbyOutcomes.set(userKey, "rejected");
    this.removePendingClient(userKey);
  }

  /**
   * Returns false when the room cannot admit `userKey` (see `canGrantTo`)
   * or could not keep the admission (see `admitUserKeys`).
   */
  allowUser(userKey: string): boolean {
    const result = this.admitUserKeys([{ userKey, scopes: ["waitingRoom"] }]);
    return result.status === "admitted" && result.admitted.length > 0;
  }

  /**
   * Whether a join as `userKey` may pass the waiting room: the latest
   * decision across what the join speaks for admits it (see
   * `principalsOfJoin`).
   */
  isAllowed(
    userKey: string,
    roomGuestProof?: string,
    link?: GuestLinkPlan,
  ): boolean {
    return this.admissions.admits(
      this.principalsOfJoin(userKey, roomGuestProof, rightsPassesOf(link)),
      "waitingRoom",
    );
  }

  revokeAllowedUser(userKey: string) {
    this.recordRevocation(this.identitiesOfSameGuest(userKey), ["waitingRoom"]);
  }

  /**
   * Returns false when the room cannot admit `userKey` (see `canGrantTo`)
   * or could not keep the admission (see `admitUserKeys`).
   */
  allowLockedUser(userKey: string): boolean {
    const result = this.admitUserKeys([{ userKey, scopes: ["lock"] }]);
    return result.status === "admitted" && result.admitted.length > 0;
  }

  /** Whether a join as `userKey` may pass the lock (see `isAllowed`). */
  isLockedAllowed(
    userKey: string,
    roomGuestProof?: string,
    link?: GuestLinkPlan,
  ): boolean {
    return this.admissions.admits(
      this.principalsOfJoin(userKey, roomGuestProof, rightsPassesOf(link)),
      "lock",
    );
  }

  revokeLockedAllowedUser(userKey: string) {
    const userKeys = this.identitiesOfSameGuest(userKey);
    for (const key of userKeys) this.setReadmissionRequired(key, true);
    this.recordRevocation(userKeys, ["lock"]);
  }

  /**
   * The keys hosts admitted that still let someone in, for the room's
   * access lists. A guest whose later decision took the admission back is
   * not listed.
   */
  admittedUserKeys(scope: AdmissionScope): string[] {
    return this.admissions
      .admittedKeys(scope, (principal) =>
        principal.startsWith("pass:")
          ? this.admissions.admits(
              this.principalsOfJoin("", principal.slice("pass:".length)),
              scope,
            )
          : true,
      )
      .sort();
  }

  removeUser(userKey: string): Client[] {
    const userKeys = this.identitiesOfSameGuest(userKey);
    for (const key of userKeys) this.setReadmissionRequired(key, true);
    return this.dropRejoinGrantsOf(userKeys);
  }

  keepAdmitted(userKeys: readonly string[]): AdmitResult {
    return this.admitUserKeys(
      userKeys
        .filter((key) => {
          const proof = this.guestProofsByUserKey.get(key);
          return !this.needsReadmission(key, proof) && !this.isBlocked(key, proof);
        })
        .map((userKey) => ({ userKey, scopes: ["lock"] satisfies AdmissionScope[] })),
    );
  }


  /**
   * A block also ends what a rejoin would honour for the guest: admissions,
   * a stage invite, and host rights. A join that still held host rights
   * would be let past the block.
   */
  blockUser(userKey: string): Client[] {
    const demoted = this.removeUser(userKey);
    this.blockedUsers.add(userKey);
    if (this.pendingClients.has(userKey)) {
      this.lobbyOutcomes.set(userKey, "rejected");
    }
    this.stopWaiting(userKey);
    return demoted;
  }

  /**
   * Lifts the block that was set on `userKey`. A guest stays out for as long
   * as any of its keys is still on the list.
   */
  unblockUser(userKey: string) {
    this.blockedUsers.delete(userKey);
    this.releaseGuestIdentity(userKey);
  }

  // Takes host rights away from everyone in the room with this user key, who
  // stay in it as admitted participants. Returns those who had them.
  demoteToParticipant(userKey: string): Client[] {
    const userKeys = this.identitiesOfSameGuest(userKey);
    this.keepAdmitted(userKeys);
    return this.revokeHostOf(userKeys);
  }

  /**
   * The requests to be let in of one guest, oldest first: that of `userKey`
   * and those of the guest's other tabs.
   */
  waitingRequestsOfGuest(userKey: string): WaitingRequest[] {
    const guest =
      this.waitingGuestByKey.get(userKey)?.guest ?? this.guestOfKey(userKey);
    return (this.waitingKeysByGuest.get(guest) ?? []).flatMap(
      (key) => this.pendingClients.get(key) ?? [],
    );
  }

  /**
   * What hosts see in the lobby: one request per guest, the oldest one of
   * each. A guest who waits in two tabs is one person to let in or turn
   * away, the way an account in two tabs is.
   */
  /** How many people wait to be let in: one per guest, as the lobby shows. */
  get waitingGuestCount(): number {
    return this.waitingGuests().length;
  }

  waitingGuests(): WaitingRequest[] {
    const shown: WaitingRequest[] = [];
    for (const request of this.pendingClients.values()) {
      const guest = this.waitingGuestByKey.get(request.userKey)?.guest;
      if (
        guest === undefined ||
        this.waitingKeysByGuest.get(guest)?.[0] === request.userKey
      ) {
        shown.push(request);
      }
    }
    return shown;
  }

  /**
   * `userKey` and every other key of the same guest: the guest's other
   * tabs, under the same pass or one the room linked to it. A key with no
   * proof has no other tabs to find.
   */
  identitiesOfSameGuest(
    userKey: string,
    guestProof: string | undefined = this.guestProofsByUserKey.get(userKey),
    link?: GuestLinkPlan,
  ): string[] {
    const userKeys = [userKey];
    for (const pass of this.personOf(userKey, guestProof, link?.passes).passes) {
      for (const otherKey of this.userKeysByGuestProof.get(pass) ?? []) {
        if (!userKeys.includes(otherKey)) userKeys.push(otherKey);
      }
    }
    return userKeys;
  }

  isSamePerson(
    userKey: string,
    otherKey: string,
    guestProof: string | undefined = this.guestProofsByUserKey.get(userKey),
    link?: GuestLinkPlan,
  ): boolean {
    return this.isKeyOf(this.personOf(userKey, guestProof, link?.passes), otherKey);
  }

  guestPassesFor(userKeys: Iterable<string>): Record<string, string[]> {
    const passes: Record<string, string[]> = {};
    for (const userKey of userKeys) {
      const guestProof = this.guestProofsByUserKey.get(userKey);
      if (guestProof === undefined) continue;
      const linked = [...this.passesOfGuest(guestProof)].filter((pass) => pass !== guestProof);
      passes[userKey] = [guestProof, ...linked];
    }
    return passes;
  }

  private restoreGuestPasses(passesByKey: Readonly<Record<string, readonly string[]>>): void {
    for (const [userKey, passes] of Object.entries(passesByKey)) {
      const [first] = passes;
      if (first === undefined) continue;
      this.bindGuestProof(userKey, first);
      const record = this.guestRecords.get(first);
      if (!record) continue;
      for (const pass of passes) {
        record.passes.add(pass);
        this.guestRecords.set(pass, record);
      }
    }
  }

  /** The seats held under `userKey` and every other key of the same guest. */
  seatsOfSameGuest(userKey: string): string[] {
    const userKeys = new Set(this.identitiesOfSameGuest(userKey));
    return Array.from(this.userKeysById)
      .filter(([, key]) => userKeys.has(key))
      .map(([userId]) => userId);
  }

  /**
   * A block on one key keeps out every key of the same guest, for as long
   * as the blocked key is on the list.
   */
  isBlocked(
    userKey: string,
    guestProof?: string,
    link?: GuestLinkPlan,
  ): boolean {
    return this.guestHolds(this.blockedUsers, userKey, guestProof, link?.passes);
  }
}
