import { runDetached } from "./runDetached.js";
import { createServer as createHttpServer } from "http";
import type { Server as HttpServer } from "http";
import type { Express } from "express";
import type { Server as SocketIOServer } from "socket.io";
import { config as defaultConfig } from "../config/config.js";
import { Logger } from "../utilities/loggers.js";
import {
  initMediaSoup,
  initScheduling,
  initScheduledMeetings,
  initScheduledWebinars,
} from "./init.js";
import {
  advanceScheduledMeetings,
  persistScheduledMeetingChanges,
} from "./scheduledMeetings.js";
import { sendDueSchedulingEmailReminders } from "./schedulingEmailReminders.js";
import { createSfuApp } from "./http/createApp.js";
import { registerAdminGateway, type AdminGateway } from "./admin/adminGateway.js";
import {
  startScheduledWebinarTimer,
  stopScheduledWebinarTimer,
} from "./scheduledWebinarScheduler.js";
import {
  connectSocketAdapter,
  createSfuSocketServer,
  type SocketAdapterLifecycle,
} from "./socket/createSocketServer.js";
import { createRoomRegistry } from "./roomRegistry.js";
import { createFileRoomRecoveryStore } from "./roomRecoveryLedger.js";
import { startRoomRecoveryPassRefresh } from "./roomRecoveryPass.js";
import {
  AUDIO_CONSUMER_HEAL_INTERVAL_MS,
  healAllRooms,
} from "./audioConsumerHeal.js";
import {
  hasUnconfirmedRoomLeases,
  releaseAllRoomOwnerships,
  renewRoomOwnerships,
} from "./rooms.js";
import { handOffRooms } from "./serverShutdown.js";
import { shutdownAnalytics } from "./analytics/posthog.js";
import { createSfuState } from "./state.js";
import type { SfuState } from "./state.js";
import { shutdownBrowserBackend } from "./browserServiceClient.js";
import { retryWhileSqliteLocked } from "./sqliteWriteCheck.js";

const ROOM_LEASE_RECOVERY_INTERVAL_MS = 2_000;

export type SfuServer = {
  app: Express;
  httpServer: HttpServer;
  io: SocketIOServer;
  state: SfuState;
  start: () => Promise<void>;
  stop: () => Promise<void>;
};

export type CreateSfuServerOptions = {
  config?: typeof defaultConfig;
};

export const createSfuServer = (
  options: CreateSfuServerOptions = {},
): SfuServer => {
  const config = options.config ?? defaultConfig;
  const roomRegistry = createRoomRegistry(config);
  const state = createSfuState({
    isDraining: config.draining,
    roomRegistry,
    config,
    roomRecoveryStore: createFileRoomRecoveryStore(),
  });
  let io: SocketIOServer | null = null;
  let socketAdapterLifecycle: SocketAdapterLifecycle | null = null;

  const app = createSfuApp({
    state,
    config,
    getIo: () => io,
    getSocketAdapterHealth: () => socketAdapterLifecycle?.health() ?? null,
  });
  const httpServer = createHttpServer(app);
  io = createSfuSocketServer(httpServer, { state, config });
  const adminGateway: AdminGateway = registerAdminGateway({
    io,
    state,
    secret: config.sfuSecret,
    instanceId: config.instanceId,
    version: config.version,
  });

  let scheduledMeetingTickTimer: NodeJS.Timeout | null = null;
  let roomOwnershipRenewTimer: NodeJS.Timeout | null = null;
  let roomLeaseRecoveryTimer: NodeJS.Timeout | null = null;
  let audioConsumerHealTimer: NodeJS.Timeout | null = null;
  let stopRoomRecoveryPassRefresh: (() => void) | null = null;
  const workerShutdown = new AbortController();

  const start = async (): Promise<void> => {
    await state.roomRegistry.start();
    socketAdapterLifecycle = await connectSocketAdapter(io, { config });
    await initMediaSoup(state, config, () => io, workerShutdown.signal);
    await retryWhileSqliteLocked(() => initScheduledWebinars(state));
    await retryWhileSqliteLocked(() => initScheduledMeetings(state));
    await retryWhileSqliteLocked(() => initScheduling(state));
    startScheduledWebinarTimer(state, () => io, undefined);
    roomOwnershipRenewTimer = setInterval(() => {
      renewRoomOwnerships(state).catch((error) => {
        Logger.error("Failed to renew room ownerships", error);
      });
    }, config.roomRegistry.renewIntervalMs);
    if (roomOwnershipRenewTimer.unref) {
      roomOwnershipRenewTimer.unref();
    }
    // A room kept open through a registry outage is not registered anywhere,
    // so claim its lease again promptly instead of on the next renewal.
    let roomLeaseRecoveryInFlight = false;
    roomLeaseRecoveryTimer = setInterval(() => {
      if (roomLeaseRecoveryInFlight || !hasUnconfirmedRoomLeases(state)) return;
      roomLeaseRecoveryInFlight = true;
      renewRoomOwnerships(state)
        .catch((error) => {
          Logger.error("Failed to recover room ownerships", error);
        })
        .finally(() => {
          roomLeaseRecoveryInFlight = false;
        });
    }, ROOM_LEASE_RECOVERY_INTERVAL_MS);
    if (roomLeaseRecoveryTimer.unref) {
      roomLeaseRecoveryTimer.unref();
    }
    scheduledMeetingTickTimer = setInterval(() => {
      const changedMeetings = advanceScheduledMeetings(state.scheduledMeetings);
      if (changedMeetings.length > 0 && state.scheduledMeetingPersistence) {
        persistScheduledMeetingChanges(
          state.scheduledMeetings,
          state.scheduledMeetingPersistence,
          changedMeetings,
        ).catch((error) => {
          Logger.warn("Failed to persist scheduled-meeting tick", error);
        });
      }
      sendDueSchedulingEmailReminders(state).catch((error) => {
        Logger.warn("Failed to send scheduling reminders", error);
      });
    }, 5000);

    if (scheduledMeetingTickTimer.unref) {
      scheduledMeetingTickTimer.unref();
    }

    audioConsumerHealTimer = setInterval(() => {
      healAllRooms(state).catch((error) => {
        Logger.warn("Audio consumer heal sweep failed", error);
      });
    }, AUDIO_CONSUMER_HEAL_INTERVAL_MS);
    if (audioConsumerHealTimer.unref) {
      audioConsumerHealTimer.unref();
    }
    stopRoomRecoveryPassRefresh = startRoomRecoveryPassRefresh(
      state,
      config.sfuSecret,
    );

    await new Promise<void>((resolve) => {
      httpServer.listen(config.port, () => {
        Logger.success(`Server running on port ${config.port}`);
        resolve();
      });
    });
  };

  const stop = async (): Promise<void> => {
    handOffRooms(state);
    workerShutdown.abort();
    adminGateway.dispose();
    stopScheduledWebinarTimer(state);
    if (scheduledMeetingTickTimer) {
      clearInterval(scheduledMeetingTickTimer);
      scheduledMeetingTickTimer = null;
    }
    if (roomLeaseRecoveryTimer) {
      clearInterval(roomLeaseRecoveryTimer);
      roomLeaseRecoveryTimer = null;
    }
    if (roomOwnershipRenewTimer) {
      clearInterval(roomOwnershipRenewTimer);
      roomOwnershipRenewTimer = null;
    }
    if (audioConsumerHealTimer) {
      clearInterval(audioConsumerHealTimer);
      audioConsumerHealTimer = null;
    }
    stopRoomRecoveryPassRefresh?.();
    stopRoomRecoveryPassRefresh = null;
    await state.scheduledWebinarPersistence?.close?.();
    state.scheduledWebinarPersistence = null;
    await state.scheduledMeetingPersistence?.close?.();
    state.scheduledMeetingPersistence = null;
    await state.schedulingPersistence?.close?.();
    state.schedulingPersistence = null;
    await releaseAllRoomOwnerships(state);
    await socketAdapterLifecycle?.close();
    socketAdapterLifecycle = null;
    await state.roomRegistry.close();
    state.transcriptRelays.closeAll();
    // Fire-and-forget: io.close() also initiates closing the attached HTTP
    // server; the explicit httpServer.close below is what we await on.
    runDetached("Closing the socket server", () => io.close());

    await new Promise<void>((resolve, reject) => {
      httpServer.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });

    for (const room of state.rooms.values()) {
      room.close();
    }
    state.rooms.clear();
    state.roomCreations.clear();
    await state.appDocuments.close();

    for (const worker of state.workers) {
      try {
        worker.close();
      } catch (error) {
        Logger.warn("Error closing mediasoup worker", error);
      }
    }
    state.workers = [];

    await shutdownBrowserBackend();

    // Flush and close product analytics last so any buffered game events are
    // delivered before the process exits. No-op when analytics is disabled.
    await shutdownAnalytics();
  };

  return {
    app,
    httpServer,
    io,
    state,
    start,
    stop,
  };
};
