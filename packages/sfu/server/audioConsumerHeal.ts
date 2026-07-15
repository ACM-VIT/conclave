import type { Consumer } from "mediasoup/types";
import type { Client } from "../config/classes/Client.js";
import type { Room } from "../config/classes/Room.js";
import { Logger } from "../utilities/loggers.js";
import type { SfuState } from "./state.js";

/**
 * Server-side backstop for issue #177 (a speaker audible to only a subset of
 * attendees).
 *
 * Audio consumers are created unpaused (see mediaHandlers `consume`), so in
 * the steady state a paused audio consumer can only mean one of two things:
 *  - the owning client explicitly asked for it via setConsumerPreferences
 *    (tracked with `clientPausedIntent` below), or
 *  - a `resumeConsumer` request was lost (rate limit, disconnect blip, an old
 *    client build) and the attendee is silently missing that speaker.
 *
 * The sweep resumes the second class. It runs cheaply over in-memory maps and
 * heals every connected client type (web, mobile, native) without requiring a
 * client update.
 */

export const AUDIO_CONSUMER_HEAL_INTERVAL_MS = 10_000;
export const AUDIO_CONSUMER_HEAL_MIN_AGE_MS = 10_000;

type ConsumerHealAppData = {
  createdAtMs?: number;
  clientPausedIntent?: boolean;
};

const healAppData = (consumer: Consumer): ConsumerHealAppData =>
  consumer.appData;

/** Stamp consume-time metadata used by the heal sweep. */
export const initConsumerHealState = (
  consumer: Consumer,
  nowMs: number = Date.now(),
): void => {
  healAppData(consumer).createdAtMs = nowMs;
};

/**
 * Record whether the owning client explicitly asked for this consumer to be
 * paused. Explicitly paused consumers are the client's business; the sweep
 * never touches them.
 */
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

/**
 * A paused audio consumer with no client pause intent that has existed long
 * enough for any legitimate consume/resume round-trip to have finished is
 * stuck: its attendee cannot hear that speaker and nothing client-side is
 * guaranteed to repair it.
 */
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
      // Consumers created before this feature shipped have no stamp; treat
      // them as old enough — they have certainly outlived the round-trip.
      const ageMs =
        typeof createdAtMs === "number" ? nowMs - createdAtMs : minAgeMs;
      if (ageMs < minAgeMs) continue;
      stuck.push({ client, consumer, ageMs });
    }
  }
  return stuck;
};

/**
 * Resume every stuck audio consumer in the room and tell the owning client,
 * so its UI state converges and the event is visible in client telemetry.
 * Returns the number of consumers healed.
 */
export const healStuckAudioConsumers = async (
  room: Room,
  nowMs: number = Date.now(),
): Promise<number> => {
  const stuck = collectStuckAudioConsumers(room, nowMs);
  let healed = 0;
  for (const { client, consumer, ageMs } of stuck) {
    // The awaited resumes above can interleave with socket handlers; re-check
    // that the consumer is still the current generation and was not closed or
    // intentionally paused meanwhile.
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
      // A successor may have displaced this consumer while resume awaited.
      // Do not report a stale generation as healed; only current generations
      // are allowed to produce health-success notifications.
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

/** Run the heal sweep across every active room. */
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
