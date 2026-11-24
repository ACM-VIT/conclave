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
  type AppAwarenessRemoval,
  type AppSyncMark,
  type RoomApps,
  type StageCommandResult,
} from "../../roomApps.js";
import { Logger } from "../../../utilities/loggers.js";
import type { ConnectionContext } from "../context.js";
import { RATE_LIMITS, takeToken } from "../rateLimit.js";
import { respond } from "./ack.js";

const MAX_APPS_SYNC_BYTES = 64 * 1024;
const MAX_APPS_UPDATE_BYTES = 256 * 1024;
const MAX_APPS_AWARENESS_BYTES = 64 * 1024;
const MAX_REPLICA_ID_LENGTH = 64;
const REMEMBERED_REFUSED_REPLICAS = 16;
const MAX_HELD_UPDATE_BYTES = MAX_APPS_UPDATE_BYTES;
const HELD_UPDATE_FLUSH_MS = Math.ceil(1000 / RATE_LIMITS.appsYjsUpdate.refillPerSec);
const COPY_RESTART_DELAY_MS = 500;

type HeldUpdate = {
  apps: RoomApps;
  appId: string;
  update: Uint8Array;
  replicaId: string | undefined;
};

const runsOf = (held: HeldUpdate[]): HeldUpdate[][] => {
  const runs: HeldUpdate[][] = [];
  for (const item of held) {
    const run = runs.at(-1);
    const first = run?.[0];
    if (run && first && first.apps === item.apps && first.appId === item.appId && first.replicaId === item.replicaId) {
      run.push(item);
    } else {
      runs.push([item]);
    }
  }
  return runs;
};

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

const emitAppAwarenessRemoval = (
  context: ConnectionContext,
  removal: AppAwarenessRemoval | null,
): void => {
  if (!removal) {
    return;
  }
  context.io.to(context.currentRoom!.channelId).emit("apps:awareness", {
    appId: removal.appId,
    awarenessUpdate: removal.awarenessUpdate,
  } satisfies AppsAwarenessData);
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
  let copyRestartPending = false;
  let copyRestartTimer: ReturnType<typeof setTimeout> | null = null;
  const markSynced = (apps: RoomApps, mark: AppSyncMark): void => {
    synced = { apps, mark };
    copyRestartPending = false;
  };
  const restartCopy = (): void => {
    if (copyRestartPending || !context.currentRoom) return;
    copyRestartPending = true;
    socket.emit("apps:state", {
      ...getRoomAppsState(context),
      activeAppId: null,
      docGeneration: null,
    } satisfies AppsState);
    if (copyRestartTimer) clearTimeout(copyRestartTimer);
    copyRestartTimer = setTimeout(() => {
      copyRestartTimer = null;
      if (context.currentRoom) socket.emit("apps:state", getRoomAppsState(context));
    }, COPY_RESTART_DELAY_MS);
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

  const applyUpdate = (held: HeldUpdate): void => {
    const { apps, appId, update, replicaId } = held;
    if (!context.currentRoom || !context.currentClient || context.currentRoom.apps !== apps) return;
    const doc = apps.liveDoc(appId);
    if (!doc) {
      signalRefused(appId, replicaId, "not-live");
      return;
    }
    const mark = syncMarkHere();
    if (!apps.isCurrentSync(mark)) {
      if (!changesNothingIn(doc, update)) {
        refuseUpdate(appId, replicaId, "not-synced");
        return;
      }
      const resync = apps.syncMark(appId);
      if (resync) {
        markSynced(apps, resync);
        socket.emit("apps:yjs:update", {
          appId,
          update: Y.encodeStateAsUpdate(doc),
        } satisfies AppsUpdateData);
      }
      return;
    }
    if (apps.locked && !canControlStage(context)) {
      if (!changesNothingIn(doc, update)) refuseUpdate(appId, replicaId, "locked");
      return;
    }
    const refusal = apps.write(appId, context.currentClient.id, update, mark, socket.id);
    if (refusal) {
      refuseUpdate(appId, replicaId, refusal);
      return;
    }
    socket.to(context.currentRoom.channelId).emit("apps:yjs:update", {
      appId,
      update,
    } satisfies AppsUpdateData);
  };

  let held: HeldUpdate[] = [];
  let heldBytes = 0;
  let flushTimer: ReturnType<typeof setTimeout> | null = null;
  const flushHeld = (): void => {
    if (flushTimer) {
      clearTimeout(flushTimer);
      flushTimer = null;
    }
    const batch = held;
    held = [];
    heldBytes = 0;
    for (const run of runsOf(batch)) {
      const [first] = run;
      let update: Uint8Array;
      try {
        update = run.length === 1 ? first.update : Y.mergeUpdates(run.map((item) => item.update));
      } catch {
        refuseUpdate(first.appId, first.replicaId, "malformed");
        continue;
      }
      applyUpdate({ ...first, update });
    }
  };
  const scheduleFlush = (): void => {
    if (flushTimer) return;
    flushTimer = setTimeout(() => {
      flushTimer = null;
      try {
        if (takeToken(socket, "apps:yjs:update", RATE_LIMITS.appsYjsUpdate)) flushHeld();
        else scheduleFlush();
      } catch (error) {
        Logger.warn("[Apps] Could not apply held app updates", error);
      }
    }, HELD_UPDATE_FLUSH_MS);
  };
  socket.on("disconnecting", () => {
    try {
      flushHeld();
    } catch (error) {
      Logger.warn("[Apps] Could not apply held app updates", error);
    }
    if (copyRestartTimer) clearTimeout(copyRestartTimer);
    copyRestartTimer = null;
  });

  const emitAppsState = (): AppsState => {
    const state = getRoomAppsState(context);
    io.to(context.currentRoom!.channelId).emit("apps:state", state);
    return state;
  };

  // Shared by present, close, discard and lock: rate limit, permission and
  // revision checks, then the room command, the presence removal and the
  // state broadcast.
  const runStageCommand = (
    expectedRevision: unknown,
    deniedError: string,
    command: (expectedRevision: number | undefined) => StageCommandResult,
  ):
    | { success: true; state: AppsState }
    | { success: false; error: string; code?: AppsStageErrorCode } => {
    if (!context.currentRoom || !context.currentClient) {
      return { success: false, error: "Not in a room" };
    }
    if (!canControlStage(context)) {
      return { success: false, error: deniedError };
    }
    flushHeld();
    if (!takeToken(socket, "apps:stage", RATE_LIMITS.appsStage)) {
      return { success: false, error: "Too many app changes" };
    }
    const revision = parseExpectedRevision(expectedRevision);
    if (revision === INVALID_REVISION) {
      return { success: false, error: "Invalid stage revision" };
    }
    const result = command(revision);
    if (!result.ok) {
      return { success: false, ...STAGE_COMMAND_ERRORS[result.reason] };
    }
    emitAppAwarenessRemoval(context, result.awarenessRemoval);
    return {
      success: true,
      state: result.changed ? emitAppsState() : getRoomAppsState(context),
    };
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
      const outcome = runStageCommand(
        data?.expectedRevision,
        "Only admins can open apps",
        (revision) => context.currentRoom!.apps.present(appId, revision),
      );
      respond(
        callback,
        outcome.success
          ? {
              success: true,
              activeAppId: outcome.state.activeAppId ?? undefined,
              revision: outcome.state.revision,
            }
          : outcome,
      );
    }
  );

  // Older clients send only the ack; newer ones send their revision first.
  socket.on("apps:close", (first: unknown, second: unknown) => {
    const callback = typeof first === "function" ? first : second;
    const data = (typeof first === "function" ? undefined : first) as
      | AppsCloseData
      | undefined;
    const outcome = runStageCommand(
      data?.expectedRevision,
      "Only admins can close apps",
      (revision) => context.currentRoom!.apps.close(revision),
    );
    respond<AppsCloseResponse>(
      callback,
      outcome.success
        ? { success: true, revision: outcome.state.revision }
        : outcome,
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
      const outcome = runStageCommand(
        data?.expectedRevision,
        "Only admins can clear apps",
        (revision) => context.currentRoom!.apps.discard(appId, revision),
      );
      respond(
        callback,
        outcome.success
          ? { success: true, revision: outcome.state.revision }
          : outcome,
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
      const outcome = runStageCommand(
        data.expectedRevision,
        "Only admins can lock apps",
        (revision) => context.currentRoom!.apps.setLocked(locked, revision),
      );
      respond(
        callback,
        outcome.success
          ? { success: true, locked: outcome.state.locked }
          : outcome,
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
      flushHeld();

      // Every stage change makes each client sync the presented app once.
      // That first sync is free, so hosts switching apps cannot use up a
      // viewer's budget; repeated syncs of the same stage still spend it.
      const appId = normalizeAppId(data?.appId);
      const doc = appId ? context.currentRoom.apps.liveDoc(appId) : null;
      const stage = `${context.currentRoom.id}:${context.currentRoom.apps.stageRevision}`;
      const freeSync = doc !== null && stage !== lastFreeSyncStage;
      if (!freeSync && !takeToken(socket, "apps:yjs:sync", RATE_LIMITS.appsYjsSync)) {
        respond(callback, retryLater("Too many app sync requests", 500));
        return;
      }
      if (freeSync) lastFreeSyncStage = stage;

      if (!appId) {
        respond(callback, { error: "Invalid app id" });
        return;
      }
      if (!doc) {
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

      const update = Y.encodeStateAsUpdate(doc, stateVector);
      if (update.length > MAX_APP_DOC_BYTES) {
        respond(callback, { error: "App document too large to sync" });
        return;
      }
      const mark = context.currentRoom.apps.syncMark(appId);
      if (mark) markSynced(context.currentRoom.apps, mark);
      const awarenessSnapshot =
        context.currentRoom.apps.encodeAwarenessSnapshot(appId) ?? undefined;
      const awarenessUpdate =
        awarenessSnapshot && awarenessSnapshot.length <= MAX_APPS_AWARENESS_BYTES
          ? awarenessSnapshot
          : undefined;
      respond(callback, {
        syncMessage: update,
        stateVector: Y.encodeStateVector(doc),
        awarenessUpdate,
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
    const item = { apps: context.currentRoom.apps, appId, update, replicaId };
    if (held.length === 0 && takeToken(socket, "apps:yjs:update", RATE_LIMITS.appsYjsUpdate)) {
      applyUpdate(item);
      return;
    }
    if (heldBytes + update.length > MAX_HELD_UPDATE_BYTES) {
      refuseUpdate(appId, replicaId, "rate-limited");
      return;
    }
    held.push(item);
    heldBytes += update.length;
    scheduleFlush();
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
