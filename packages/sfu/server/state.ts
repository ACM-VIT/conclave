import type { Worker } from "mediasoup/types";
import { config } from "../config/config.js";
import { Room } from "../config/classes/Room.js";
import type { WebinarLinkTarget, WebinarRoomConfig } from "./webinar.js";
import {
  createScheduledWebinarStore,
  type ScheduledWebinarPersistence,
  type ScheduledWebinarStore,
} from "./scheduledWebinars.js";
import type { RecordingSession } from "./recording/recordingSession.js";

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
  endedRooms: Map<string, EndedRoom>;
  webinarConfigs: Map<string, WebinarRoomConfig>;
  webinarLinks: Map<string, WebinarLinkTarget>;
  scheduledWebinars: ScheduledWebinarStore;
  scheduledWebinarPersistence: ScheduledWebinarPersistence | null;
  scheduledWebinarTimer: NodeJS.Timeout | null;
  recordingSessions: Map<string, RecordingSession>;
  isDraining: boolean;
};

export const createSfuState = (options?: { isDraining?: boolean }): SfuState => {
  return {
    workers: [],
    rooms: new Map(),
    endedRooms: new Map(),
    webinarConfigs: new Map(),
    webinarLinks: new Map(),
    scheduledWebinars: createScheduledWebinarStore(),
    scheduledWebinarPersistence: null,
    scheduledWebinarTimer: null,
    recordingSessions: new Map(),
    isDraining: options?.isDraining ?? config.draining,
  };
};
