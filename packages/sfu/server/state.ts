import type { Worker } from "mediasoup/types";
import { config as defaultConfig } from "../config/config.js";
import { Room } from "../config/classes/Room.js";
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
import { createRoomRegistry, type RoomRegistry } from "./roomRegistry.js";
import {
  createTranscriptRelayRegistry,
  type TranscriptRelayRegistry,
} from "./transcript/relayRegistry.js";
import {
  createAppDocumentPool,
  MAX_APP_DOCUMENT_BYTES,
  type AppDocumentPool,
} from "./apps/documents/pool.js";
import { createStagingBudget, type StagingBudget } from "./apps/documents/staging.js";
import {
  createAppsAuthorityRuntime,
  type AppsAuthorityRuntime,
} from "./apps/authority/index.js";
import { planWorkers, type WorkerPlan } from "../utilities/workerPlan.js";

export type EndedRoom = {
  roomId: string;
  clientId: string;
  message: string;
  endedAt: number;
  endedBy: string;
};

export type SfuState = {
  workers: Worker[];
  rooms: Map<string, Room>;
  roomCreations: Map<string, Promise<Room>>;
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
  transcriptRelays: TranscriptRelayRegistry;
  workerPlan: WorkerPlan;
  appDocuments: AppDocumentPool;
  appChangeStaging: StagingBudget;
  /** Null when this SFU does not run authority apps. */
  appsAuthority: AppsAuthorityRuntime | null;
  isDraining: boolean;
};

export const createSfuState = (options?: {
  isDraining?: boolean;
  roomRegistry?: RoomRegistry;
  appDocuments?: AppDocumentPool;
  appChangeStaging?: StagingBudget;
  appsAuthority?: AppsAuthorityRuntime | null;
  config?: typeof defaultConfig;
}): SfuState => {
  const config = options?.config ?? defaultConfig;
  const workerPlan = planWorkers(config.workerSettings);
  return {
    workers: [],
    rooms: new Map(),
    roomCreations: new Map(),
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
    transcriptRelays: createTranscriptRelayRegistry(config.transcriptRelay),
    workerPlan,
    appDocuments:
      options?.appDocuments ??
      createAppDocumentPool({
        workers: workerPlan.appDocumentWorkers,
        heap: workerPlan.appDocumentHeap,
        deadlineMs: config.appDocuments.deadlineMs,
        maxDocumentBytes: MAX_APP_DOCUMENT_BYTES,
      }),
    appChangeStaging: options?.appChangeStaging ?? createStagingBudget(),
    appsAuthority:
      options?.appsAuthority !== undefined
        ? options.appsAuthority
        : config.appsAuthority.enabled
          ? createAppsAuthorityRuntime()
          : null,
    isDraining: options?.isDraining ?? config.draining,
  };
};
