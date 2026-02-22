import type { Worker } from "mediasoup/types";
import { config } from "../config/config.js";
import { Room } from "../config/classes/Room.js";
import type { WebinarLinkTarget, WebinarRoomConfig } from "./webinar.js";

export type SfuState = {
  workers: Worker[];
  rooms: Map<string, Room>;
  webinarConfigs: Map<string, WebinarRoomConfig>;
  webinarLinks: Map<string, WebinarLinkTarget>;
  isDraining: boolean;
};

export const createSfuState = (options?: { isDraining?: boolean }): SfuState => {
  return {
    workers: [],
    rooms: new Map(),
    webinarConfigs: new Map(),
    webinarLinks: new Map(),
    isDraining: options?.isDraining ?? config.draining,
  };
};
