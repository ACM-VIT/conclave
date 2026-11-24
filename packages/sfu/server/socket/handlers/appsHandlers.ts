import * as Y from "yjs";
import type {
  AppsAwarenessData,
  AppsCloseData,
  AppsCloseResponse,
  AppsDiscardData,
  AppsDiscardResponse,
  AppsLockData,
  AppsLockResponse,
  AppsOpenData,
  AppsOpenResponse,
  AppsStageErrorCode,
  AppsState,
  AppsSyncData,
  AppsSyncError,
  AppsSyncResponse,
  AppsRefusedData,
  AppsUpdateData,
} from "../../../types.js";
import { Admin } from "../../../config/classes/Admin.js";
import {
  MAX_APP_DOC_BYTES,
  type AppSyncMark,
  type RoomApps,
  type StageCommandResult,
} from "../../roomApps.js";
import { Logger } from "../../../utilities/loggers.js";
import type { ConnectionContext } from "../context.js";
import { RATE_LIMITS, takeToken } from "../rateLimit.js";
import { RoomAppsWork } from "../../roomAppsWork.js";
import { respond } from "./ack.js";

const MAX_APPS_SYNC_BYTES = 64 * 1024;
const MAX_APPS_UPDATE_BYTES = 256 * 1024;
const MAX_APPS_AWARENESS_BYTES = 64 * 1024;
const MAX_REPLICA_ID_LENGTH = 64;
const REMEMBERED_REFUSED_REPLICAS = 16;
const COPY_RESTART_DELAY_MS = 500;
const COPY_RESTART_CHECK_MS = 4000;
const COPY_RESTART_ATTEMPTS = 3;

const roomWork = new WeakMap<RoomApps, RoomAppsWork>();
const workFor = (apps: RoomApps): RoomAppsWork => {
  let work = roomWork.get(apps);
  if (!work) {
    work = new RoomAppsWork();
    roomWork.set(apps, work);
  }
  return work;
};

type PendingWrite = {
  apps: RoomApps;
  appId: string;
  replicaId: string | undefined;
  writer: string;
  host: boolean;
  mark: AppSyncMark | null;
  channel: string;
};

type StageOutcome =
  | { success: true; state: AppsState }
  | { success: false; error: string; code?: AppsStageErrorCode };

const changesNothingIn = (doc: Y.Doc, update: Uint8Array): boolean => {
  try {
    return Y.snapshotContainsUpdate(Y.snapshot(doc), update);
  } catch {
    return false;
  }
};

const normalizeReplicaId = (value: unknown): string | undefined =>
  typeof value === "string" && value.length > 0 && value.length <= MAX_REPLICA_ID_LENGTH
    ? value
    : undefined;

const MAX_APP_ID_LENGTH = 128;
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f]/;

const normalizeAppId = (value: unknown): string | null => {
  if (typeof value !== "string") {
    return null;
  }
  const appId = value.trim();
  if (
    !appId ||
    appId.length > MAX_APP_ID_LENGTH ||
    CONTROL_CHARACTER_PATTERN.test(appId)
  ) {
    return null;
  }
  return appId;
};

const decodeBase64 = (value: string): Uint8Array | null => {
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (trimmed.length % 4 !== 0) return null;
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(trimmed)) return null;
  try {
    return Uint8Array.from(Buffer.from(trimmed, "base64"));
  } catch {
    return null;
  }
};

const toUint8Array = (value: unknown): Uint8Array | null => {
  if (!value) return null;
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }
  if (Array.isArray(value)) {
    if (!value.every((item) => typeof item === "number")) return null;
    return Uint8Array.from(value);
  }
  if (typeof value === "object") {
    const maybeBuffer = value as { type?: unknown; data?: unknown };
    if (maybeBuffer.type === "Buffer" && Array.isArray(maybeBuffer.data)) {
      if (!maybeBuffer.data.every((item) => typeof item === "number")) {
        return null;
      }
      return Uint8Array.from(maybeBuffer.data);
    }
  }
  if (typeof value === "string") {
    return decodeBase64(value);
  }
  return null;
};

const getRoomAppsState = (context: ConnectionContext): AppsState => {
  if (!context.currentRoom) {
    return {
      activeAppId: null,
      locked: false,
      revision: 0,
      savedAppIds: [],
      docGeneration: null,
    };
  }
  return { ...context.currentRoom.apps.snapshot(), roomId: context.currentRoom.id };
};

const retryLater = (error: string, retryAfterMs: number): AppsSyncError => ({
  error,
  retryable: true,
  retryAfterMs,
});

const INVALID_REVISION = Symbol("invalid revision");

// Older clients send no revision; their stage commands apply to whatever is
// presented now.
const parseExpectedRevision = (
  value: unknown,
): number | undefined | typeof INVALID_REVISION => {
  if (value === undefined || value === null) return undefined;
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : INVALID_REVISION;
};

const STAGE_COMMAND_ERRORS = {
  stale: { error: "The stage changed. Try again.", code: "stale_revision" },
  full: { error: "Clear an app to present another.", code: "room_full" },
} as const satisfies Record<string, { error: string; code: AppsStageErrorCode }>;

const canControlStage = (context: ConnectionContext): boolean =>
  context.currentClient instanceof Admin && !context.currentClient.isObserver;

export const registerAppsHandlers = (context: ConnectionContext): void => {
  const { socket, io } = context;
  // The stage this socket last synced without spending its sync budget.
  let lastFreeSyncStage: string | null = null;
  // What the room had sent this socket when it last synced the presented
  // app, and which room's apps that was.
  let synced: { apps: RoomApps; mark: AppSyncMark } | null = null;
  const syncMarkHere = (): AppSyncMark | null =>
    synced && synced.apps === context.currentRoom?.apps ? synced.mark : null;
  const markSynced = (apps: RoomApps, mark: AppSyncMark): void => {
    synced = { apps, mark };
  };
  type CopyRestart = {
    phase: "blank" | "real-sent";
    attempt: number;
    timer: ReturnType<typeof setTimeout>;
  };
  let copyRestart: CopyRestart | null = null;
  const sendBlankStage = (attempt: number): void => {
    synced = null;
    socket.emit("apps:state", {
      ...getRoomAppsState(context),
      activeAppId: null,
      docGeneration: null,
    } satisfies AppsState);
    const restart: CopyRestart = {
      phase: "blank",
      attempt,
      timer: setTimeout(() => sendRealStage(restart), COPY_RESTART_DELAY_MS),
    };
    copyRestart = restart;
  };
  const sendRealStage = (restart: CopyRestart): void => {
    if (copyRestart !== restart) return;
    socket.emit("apps:state", getRoomAppsState(context));
    restart.phase = "real-sent";
    restart.timer = setTimeout(() => {
      if (copyRestart !== restart) return;
      if (restart.attempt < COPY_RESTART_ATTEMPTS && getRoomAppsState(context).activeAppId) {
        sendBlankStage(restart.attempt + 1);
      } else {
        copyRestart = null;
      }
    }, COPY_RESTART_CHECK_MS);
  };
  const restartCopy = (): void => {
    if (copyRestart || !context.currentRoom) return;
    sendBlankStage(1);
  };
  const finishCopyRestart = (): void => {
    if (copyRestart?.phase !== "real-sent") return;
    clearTimeout(copyRestart.timer);
    copyRestart = null;
  };
  const refusedReplicas: string[] = [];
  const signalRefused = (appId: string, replicaId: string | undefined, reason: string): void => {
    if (!replicaId || refusedReplicas.includes(replicaId)) return;
    refusedReplicas.push(replicaId);
    if (refusedReplicas.length > REMEMBERED_REFUSED_REPLICAS) refusedReplicas.shift();
    socket.emit("apps:yjs:refused", { appId, replicaId, reason } satisfies AppsRefusedData);
  };
  const refuseUpdate = (appId: string, replicaId: string | undefined, reason: string): void => {
    Logger.warn(`[Apps] Dropping update for ${appId} from ${context.currentClient?.id}: ${reason}`);
    if (replicaId) signalRefused(appId, replicaId, reason);
    else restartCopy();
  };

  const applyWrite = (write: PendingWrite, update: Uint8Array): void => {
    const { apps, appId, replicaId } = write;
    const refusal = apps.write(appId, write.writer, update, write.mark, {
      origin: socket.id,
      host: write.host,
    });
    if (refusal === null) {
      socket.to(write.channel).emit("apps:yjs:update", { appId, update } satisfies AppsUpdateData);
      return;
    }
    if (refusal === "not-live") {
      signalRefused(appId, replicaId, refusal);
      return;
    }
    const doc = apps.liveDoc(appId);
    if ((refusal === "not-synced" || refusal === "locked") && doc && changesNothingIn(doc, update)) {
      const resync = refusal === "not-synced" ? apps.syncMark(appId) : null;
      if (resync && context.currentRoom?.apps === apps) {
        markSynced(apps, resync);
        socket.emit("apps:yjs:update", {
          appId,
          update: Y.encodeStateAsUpdate(doc),
        } satisfies AppsUpdateData);
      }
      return;
    }
    refuseUpdate(appId, replicaId, refusal);
  };

  socket.on("disconnecting", () => {
    if (copyRestart) clearTimeout(copyRestart.timer);
    copyRestart = null;
  });

  const runStageCommand = (
    expectedRevision: unknown,
    deniedError: string,
    command: (apps: RoomApps, expectedRevision: number | undefined) => StageCommandResult,
    reply: (outcome: StageOutcome) => void,
  ): void => {
    if (!context.currentRoom || !context.currentClient) {
      reply({ success: false, error: "Not in a room" });
      return;
    }
    if (!canControlStage(context)) {
      reply({ success: false, error: deniedError });
      return;
    }
    if (!takeToken(socket, "apps:stage", RATE_LIMITS.appsStage)) {
      reply({ success: false, error: "Too many app changes" });
      return;
    }
    const revision = parseExpectedRevision(expectedRevision);
    if (revision === INVALID_REVISION) {
      reply({ success: false, error: "Invalid stage revision" });
      return;
    }
    const room = context.currentRoom;
    workFor(room.apps).after(() => {
      const result = command(room.apps, revision);
      if (!result.ok) {
        reply({ success: false, ...STAGE_COMMAND_ERRORS[result.reason] });
        return;
      }
      if (result.awarenessRemoval) {
        io.to(room.channelId).emit("apps:awareness", {
          appId: result.awarenessRemoval.appId,
          awarenessUpdate: result.awarenessRemoval.awarenessUpdate,
        } satisfies AppsAwarenessData);
      }
      const state: AppsState = { ...room.apps.snapshot(), roomId: room.id };
      if (result.changed) io.to(room.channelId).emit("apps:state", state);
      reply({ success: true, state });
    });
  };

  socket.on("apps:getState", (callback: (state: AppsState) => void) => {
    respond(callback, getRoomAppsState(context));
  });

  socket.on(
    "apps:open",
    (data: AppsOpenData, callback: (response: AppsOpenResponse) => void) => {
      const appId = normalizeAppId(data?.appId);
      if (!appId) {
        respond(callback, { success: false, error: "Invalid app id" });
        return;
      }
      runStageCommand(
        data?.expectedRevision,
        "Only admins can open apps",
        (apps, revision) => apps.present(appId, revision),
        (outcome) =>
          respond(
            callback,
            outcome.success
              ? {
                  success: true,
                  activeAppId: outcome.state.activeAppId ?? undefined,
                  revision: outcome.state.revision,
                }
              : outcome,
          ),
      );
    }
  );

  // Older clients send only the ack; newer ones send their revision first.
  socket.on("apps:close", (first: unknown, second: unknown) => {
    const callback = typeof first === "function" ? first : second;
    const data = (typeof first === "function" ? undefined : first) as
      | AppsCloseData
      | undefined;
    runStageCommand(
      data?.expectedRevision,
      "Only admins can close apps",
      (apps, revision) => apps.close(revision),
      (outcome) =>
        respond<AppsCloseResponse>(
          callback,
          outcome.success ? { success: true, revision: outcome.state.revision } : outcome,
        ),
    );
  });

  socket.on(
    "apps:discard",
    (data: AppsDiscardData, callback: (response: AppsDiscardResponse) => void) => {
      const appId = normalizeAppId(data?.appId);
      if (!appId) {
        respond(callback, { success: false, error: "Invalid app id" });
        return;
      }
      runStageCommand(
        data?.expectedRevision,
        "Only admins can clear apps",
        (apps, revision) => apps.discard(appId, revision),
        (outcome) =>
          respond(
            callback,
            outcome.success ? { success: true, revision: outcome.state.revision } : outcome,
          ),
      );
    }
  );

  socket.on(
    "apps:lock",
    (data: AppsLockData, callback: (response: AppsLockResponse) => void) => {
      const locked = data?.locked;
      if (typeof locked !== "boolean") {
        respond(callback, { success: false, error: "Invalid app lock state" });
        return;
      }
      runStageCommand(
        data.expectedRevision,
        "Only admins can lock apps",
        (apps, revision) => apps.setLocked(locked, revision),
        (outcome) =>
          respond(
            callback,
            outcome.success ? { success: true, locked: outcome.state.locked } : outcome,
          ),
      );
    }
  );

  socket.on(
    "apps:yjs:sync",
    (data: AppsSyncData, callback: (response: AppsSyncResponse | AppsSyncError) => void) => {
      if (!context.currentRoom) {
        respond(callback, { error: "Not in a room" });
        return;
      }
      const room = context.currentRoom;
      const appId = normalizeAppId(data?.appId);
      const live = appId ? room.apps.liveDoc(appId) : null;
      const stage = `${room.id}:${room.apps.stageRevision}`;
      const freeSync = live !== null && stage !== lastFreeSyncStage;
      if (!freeSync && !takeToken(socket, "apps:yjs:sync", RATE_LIMITS.appsYjsSync)) {
        respond(callback, retryLater("Too many app sync requests", 500));
        return;
      }
      if (freeSync) lastFreeSyncStage = stage;
      if (!appId) {
        respond(callback, { error: "Invalid app id" });
        return;
      }
      if (!live) {
        respond(callback, { error: "App not active" });
        return;
      }
      const stateVector = toUint8Array(data.syncMessage);
      if (!stateVector) {
        respond(callback, { error: "Invalid sync payload" });
        return;
      }
      if (stateVector.length > MAX_APPS_SYNC_BYTES) {
        respond(callback, { error: "Sync payload too large" });
        return;
      }
      try {
        Y.decodeStateVector(stateVector);
      } catch {
        respond(callback, { error: "Invalid sync payload" });
        return;
      }

      const apps = room.apps;
      workFor(apps).after(() => {
        const doc = apps.liveDoc(appId);
        if (!doc) {
          respond(callback, { error: "App not active" });
          return;
        }
        const update = Y.encodeStateAsUpdate(doc, stateVector);
        if (update.length > MAX_APP_DOC_BYTES) {
          respond(callback, { error: "App document too large to sync" });
          return;
        }
        const mark = apps.syncMark(appId);
        if (mark) {
          markSynced(apps, mark);
          finishCopyRestart();
        }
        const awarenessSnapshot = apps.encodeAwarenessSnapshot(appId) ?? undefined;
        const awarenessUpdate =
          awarenessSnapshot && awarenessSnapshot.length <= MAX_APPS_AWARENESS_BYTES
            ? awarenessSnapshot
            : undefined;
        respond(callback, {
          syncMessage: update,
          stateVector: Y.encodeStateVector(doc),
          awarenessUpdate,
        });
      });
    }
  );

  socket.on("apps:yjs:update", (data: AppsUpdateData) => {
    if (!context.currentRoom || !context.currentClient) return;
    if (context.currentClient.isObserver) return;
    const appId = normalizeAppId(data?.appId);
    if (!appId) return;
    const replicaId = normalizeReplicaId(data?.replicaId);
    const update = toUint8Array(data.update);
    if (!update || update.length === 0) {
      refuseUpdate(appId, replicaId, "invalid");
      return;
    }
    if (update.length > MAX_APPS_UPDATE_BYTES) {
      refuseUpdate(appId, replicaId, "too-large");
      return;
    }
    const room = context.currentRoom;
    const write: PendingWrite = {
      apps: room.apps,
      appId,
      replicaId,
      writer: context.currentClient.id,
      host: canControlStage(context),
      mark: syncMarkHere(),
      channel: room.channelId,
    };
    const held = workFor(room.apps).hold({
      sender: socket,
      batch: [appId, replicaId, write.mark, write.host],
      update,
      apply: (merged) => applyWrite(write, merged),
    });
    if (!held) refuseUpdate(appId, replicaId, "rate-limited");
  });

  socket.on("apps:awareness", (data: AppsAwarenessData) => {
    if (!context.currentRoom || !context.currentClient) return;
    if (context.currentClient.isObserver) return;
    // High-frequency event: drop (ignore) when over budget rather than process.
    if (!takeToken(socket, "apps:awareness", RATE_LIMITS.appsAwareness)) return;

    const appId = normalizeAppId(data?.appId);
    if (!appId) return;
    const awarenessUpdate = toUint8Array(data.awarenessUpdate);
    if (!awarenessUpdate || awarenessUpdate.length === 0) return;
    if (awarenessUpdate.length > MAX_APPS_AWARENESS_BYTES) return;
    let forwarded: Uint8Array | null;
    try {
      forwarded = context.currentRoom.apps.applyAwarenessUpdate(
        appId,
        awarenessUpdate,
        context.currentClient.id,
      );
    } catch (error) {
      Logger.warn("[Apps] Dropping invalid awareness update", error);
      return;
    }
    if (!forwarded) return;

    socket.to(context.currentRoom.channelId).emit("apps:awareness", {
      appId,
      awarenessUpdate: forwarded,
      clientId: data.clientId,
    } satisfies AppsAwarenessData);
  });
};
