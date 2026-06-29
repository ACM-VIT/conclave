import type { Worker } from "mediasoup/types";
import { config } from "../config/config.js";
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
  isDraining: boolean;
};

export const createSfuState = (options?: {
  isDraining?: boolean;
  roomRegistry?: RoomRegistry;
}): SfuState => {
  return {
    workers: [],
    rooms: new Map(),
    roomCreations: new Map(),
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
    isDraining: options?.isDraining ?? config.draining,
  };
};
