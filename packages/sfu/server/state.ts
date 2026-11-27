import type { Worker } from "mediasoup/types";
import { config } from "../config/config.js";
import { Room } from "../config/classes/Room.js";
import type { NextMeetingLobby } from "./nextMeetingLobby.js";
import type { WebinarLinkTarget, WebinarRoomConfig } from "./webinar.js";
import {
  createScheduledWebinarStore,
  type ScheduledWebinarPersistence,
  type ScheduledWebinarStore,
} from "./scheduledWebinars.js";
import {
  createScheduledMeetingStore,
  type ScheduledMeetingPersistence,
  type ScheduledMeetingStore,
} from "./scheduledMeetings.js";
import {
  createSchedulingStore,
  type SchedulingPersistence,
  type SchedulingStore,
} from "./scheduling.js";
import type { LeasedRoom } from "./roomLease.js";
import { createRoomRegistry, type RoomRegistry } from "./roomRegistry.js";
import {
  createMemoryRoomRecoveryStore,
  createRoomRecoveryLedger,
  type RoomRecoveryLedger,
  type RoomRecoveryStore,
} from "./roomRecoveryLedger.js";
import {
  createTranscriptRelayRegistry,
  type TranscriptRelayRegistry,
} from "./transcript/relayRegistry.js";
import {
  createAppsAuthorityRuntime,
  type AppsAuthorityRuntime,
} from "./apps/authority/index.js";

export type EndedRoom = {
  roomId: string;
  clientId: string;
  message: string;
  endedAt: number;
  endedBy: string;
};

export type DeferredRoomWrites = {
  room: LeasedRoom;
  writes: Array<{ label: string; commit: () => Promise<boolean>; settle: (landed: boolean) => void }>;
  releaseAfter: boolean;
};

export type SfuState = {
  workers: Worker[];
  rooms: Map<string, Room>;
  roomCreations: Map<string, Promise<Room>>;
  // By channel: who was still knocking when the meeting there ended. The
  // next meeting at the code shows them to its hosts.
  nextMeetingLobbies: Map<string, NextMeetingLobby>;
  workerRoomReservations: Map<number, number>;
  endedRooms: Map<string, EndedRoom>;
  webinarConfigs: Map<string, WebinarRoomConfig>;
  webinarLinks: Map<string, WebinarLinkTarget>;
  scheduledWebinars: ScheduledWebinarStore;
  scheduledWebinarPersistence: ScheduledWebinarPersistence | null;
  scheduledWebinarTimer: NodeJS.Timeout | null;
  scheduledMeetings: ScheduledMeetingStore;
  scheduledMeetingPersistence: ScheduledMeetingPersistence | null;
  scheduling: SchedulingStore;
  schedulingPersistence: SchedulingPersistence | null;
  roomRegistry: RoomRegistry;
  deferredRoomWrites: Map<string, DeferredRoomWrites>;
  roomCommitsInFlight: Map<string, Set<Promise<boolean>>>;
  roomRecovery: RoomRecoveryLedger;
  transcriptRelays: TranscriptRelayRegistry;
  /** Null when this SFU does not run authority apps. */
  appsAuthority: AppsAuthorityRuntime | null;
  isDraining: boolean;
};

export const createSfuState = (options?: {
  isDraining?: boolean;
  roomRegistry?: RoomRegistry;
  roomRecoveryStore?: RoomRecoveryStore;
  appsAuthority?: AppsAuthorityRuntime | null;
}): SfuState => {
  return {
    workers: [],
    rooms: new Map(),
    roomCreations: new Map(),
    nextMeetingLobbies: new Map(),
    workerRoomReservations: new Map(),
    endedRooms: new Map(),
    webinarConfigs: new Map(),
    webinarLinks: new Map(),
    scheduledWebinars: createScheduledWebinarStore(),
    scheduledWebinarPersistence: null,
    scheduledWebinarTimer: null,
    scheduledMeetings: createScheduledMeetingStore(),
    scheduledMeetingPersistence: null,
    scheduling: createSchedulingStore(),
    schedulingPersistence: null,
    roomRegistry: options?.roomRegistry ?? createRoomRegistry(config),
    deferredRoomWrites: new Map(),
    roomCommitsInFlight: new Map(),
    roomRecovery: createRoomRecoveryLedger(
      options?.roomRecoveryStore ?? createMemoryRoomRecoveryStore(),
    ),
    transcriptRelays: createTranscriptRelayRegistry(config.transcriptRelay),
    appsAuthority:
      options?.appsAuthority !== undefined
        ? options.appsAuthority
        : config.appsAuthority.enabled
          ? createAppsAuthorityRuntime()
          : null,
    isDraining: options?.isDraining ?? config.draining,
  };
};
