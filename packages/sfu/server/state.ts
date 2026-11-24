import type { Worker } from "mediasoup/types";
import { config } from "../config/config.js";
import { Room } from "../config/classes/Room.js";
import type { WebinarLinkTarget, WebinarRoomConfig } from "./webinar.js";
import { createMemoryBackend } from "./controlPlane/backends/memory.js";
import { controlPlaneStore, type ControlPlaneStore } from "./controlPlane/store.js";
import { createRoomRegistry, type RoomRegistry } from "./roomRegistry.js";
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

export type SfuState = {
  workers: Worker[];
  rooms: Map<string, Room>;
  roomCreations: Map<string, Promise<Room>>;
  workerRoomReservations: Map<number, number>;
  endedRooms: Map<string, EndedRoom>;
  webinarConfigs: Map<string, WebinarRoomConfig>;
  webinarLinks: Map<string, WebinarLinkTarget>;
  controlPlane: ControlPlaneStore;
  googleAccessTokens: Map<string, { token: string; expiresAt: number }>;
  scheduledWebinarTimer: NodeJS.Timeout | null;
  reminderScanRunning: boolean;
  roomRegistry: RoomRegistry;
  transcriptRelays: TranscriptRelayRegistry;
  /** Null when this SFU does not run authority apps. */
  appsAuthority: AppsAuthorityRuntime | null;
  isDraining: boolean;
};

export const createSfuState = (options?: {
  isDraining?: boolean;
  roomRegistry?: RoomRegistry;
  appsAuthority?: AppsAuthorityRuntime | null;
  controlPlane?: ControlPlaneStore;
}): SfuState => {
  return {
    workers: [],
    rooms: new Map(),
    roomCreations: new Map(),
    workerRoomReservations: new Map(),
    endedRooms: new Map(),
    webinarConfigs: new Map(),
    webinarLinks: new Map(),
    controlPlane: options?.controlPlane ?? controlPlaneStore(createMemoryBackend()),
    googleAccessTokens: new Map(),
    scheduledWebinarTimer: null,
    reminderScanRunning: false,
    roomRegistry: options?.roomRegistry ?? createRoomRegistry(config),
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
