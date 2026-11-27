import type { Consumer } from "mediasoup/types";
import type { Client } from "../config/classes/Client.js";
import type { Room } from "../config/classes/Room.js";
import { Logger } from "../utilities/loggers.js";
import type { SfuState } from "./state.js";

export const AUDIO_CONSUMER_HEAL_INTERVAL_MS = 10_000;
export const AUDIO_CONSUMER_HEAL_MIN_AGE_MS = 10_000;

type ConsumerHealAppData = {
  createdAtMs?: number;
  clientPausedIntent?: boolean;
};

const healAppData = (consumer: Consumer): ConsumerHealAppData =>
  consumer.appData;

export const initConsumerHealState = (
  consumer: Consumer,
  nowMs: number = Date.now(),
): void => {
  healAppData(consumer).createdAtMs = nowMs;
};

export const markConsumerClientPausedIntent = (
  consumer: Consumer,
  paused: boolean,
): void => {
  healAppData(consumer).clientPausedIntent = paused;
};

const isConsumerClientPaused = (consumer: Consumer): boolean =>
  healAppData(consumer).clientPausedIntent === true;

export type StuckAudioConsumer = {
  client: Client;
  consumer: Consumer;
  ageMs: number;
};

export const collectStuckAudioConsumers = (
  room: Room,
  nowMs: number = Date.now(),
  minAgeMs: number = AUDIO_CONSUMER_HEAL_MIN_AGE_MS,
): StuckAudioConsumer[] => {
  const stuck: StuckAudioConsumer[] = [];
  for (const client of room.clients.values()) {
    for (const consumer of client.consumers.values()) {
      if (consumer.closed || consumer.kind !== "audio") continue;
      if (!consumer.paused) continue;
      if (isConsumerClientPaused(consumer)) continue;
      const createdAtMs = healAppData(consumer).createdAtMs;
      const ageMs =
        typeof createdAtMs === "number" ? nowMs - createdAtMs : minAgeMs;
      if (ageMs < minAgeMs) continue;
      stuck.push({ client, consumer, ageMs });
    }
  }
  return stuck;
};

export const healStuckAudioConsumers = async (
  room: Room,
  nowMs: number = Date.now(),
): Promise<number> => {
  const stuck = collectStuckAudioConsumers(room, nowMs);
  let healed = 0;
  for (const { client, consumer, ageMs } of stuck) {
    if (
      client.getConsumer(consumer.producerId) !== consumer ||
      consumer.closed ||
      !consumer.paused ||
      isConsumerClientPaused(consumer)
    ) {
      continue;
    }
    try {
      await consumer.resume();
      if (client.getConsumer(consumer.producerId) !== consumer) {
        continue;
      }
      healed += 1;
      Logger.warn(
        `[audio-heal] Auto-resumed stuck audio consumer ${consumer.id} ` +
          `(producer ${consumer.producerId}) for user ${client.id} in room ` +
          `${room.id} after ${Math.round(ageMs / 1000)}s`,
      );
      client.socket.emit("consumerAutoResumed", {
        roomId: room.id,
        consumerId: consumer.id,
        producerId: consumer.producerId,
        pausedForMs: ageMs,
      });
    } catch (error) {
      Logger.debug(
        `[audio-heal] Failed to auto-resume consumer ${consumer.id}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }
  return healed;
};

export const healAllRooms = async (state: SfuState): Promise<void> => {
  for (const room of state.rooms.values()) {
    try {
      await healStuckAudioConsumers(room);
    } catch (error) {
      Logger.warn(
        `[audio-heal] Sweep failed for room ${room.id}`,
        error,
      );
    }
  }
};
