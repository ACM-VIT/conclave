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
import type { Room } from "../../../config/classes/Room.js";
import {
  MAX_APP_DOC_BYTES,
  type AppAwarenessRemoval,
  type AppSyncMark,
  type DocumentExecutor,
  type RoomApps,
  type StageCommand,
  type WriteRefusal,
} from "../../roomApps.js";
import type { WriteOutcome } from "../../roomAppsScheduler.js";
import { Logger } from "../../../utilities/loggers.js";
import type { ConnectionContext } from "../context.js";
import { RATE_LIMITS, takeToken } from "../rateLimit.js";
import { respond } from "./ack.js";

const MAX_APPS_SYNC_BYTES = 64 * 1024;
const MAX_APPS_UPDATE_BYTES = 256 * 1024;
const MAX_APPS_AWARENESS_BYTES = 64 * 1024;
const MAX_REPLICA_ID_LENGTH = 64;
const REMEMBERED_REFUSED_REPLICAS = 16;
const COPY_RESTART_DELAY_MS = 500;
const COPY_RESTART_CHECK_MS = 4000;
const COPY_RESTART_ATTEMPTS = 3;

type Admission = {
  readonly apps: RoomApps;
  readonly channelId: string;
  readonly socketId: string;
  readonly userId: string;
  readonly participant: string;
  readonly host: boolean;
  readonly appId: string;
  readonly replicaId: string | undefined;
  readonly arrivedAt: number;
};

type ActiveRestart = {
  state: "blank-sent" | "awaiting-sync";
  apps: RoomApps;
  appId: string;
  revision: number;
  attempt: number;
  timer: ReturnType<typeof setTimeout>;
};

type CopyRestart = { state: "idle" } | ActiveRestart;

type RoomScope = {
  apps: RoomApps;
  synced: AppSyncMark | null;
  refusedReplicas: string[];
  restart: CopyRestart;
  freeSyncRevision: number | null;
};

type StageOutcome =
  | { success: true; state: AppsState }
  | { success: false; error: string; code?: AppsStageErrorCode };

const stageFollowers = new WeakMap<RoomApps, Set<() => void>>();

const followersOf = (apps: RoomApps): Set<() => void> => {
  const known = stageFollowers.get(apps);
  if (known) return known;
  const created = new Set<() => void>();
  stageFollowers.set(apps, created);
  return created;
};

const isEmptyUpdate = (update: Uint8Array): boolean =>
  update.length === 2 && update[0] === 0 && update[1] === 0;

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

type SyncRequest =
  | { ok: true; appId: string; live: Y.Doc; stateVector: Uint8Array }
  | { ok: false; error: string };

const readSyncRequest = (apps: RoomApps, data: AppsSyncData | undefined): SyncRequest => {
  const appId = normalizeAppId(data?.appId);
  if (!appId) return { ok: false, error: "Invalid app id" };
  const live = apps.liveDoc(appId);
  if (!live) return { ok: false, error: "App not active" };
  const stateVector = toUint8Array(data?.syncMessage);
  if (!stateVector) return { ok: false, error: "Invalid sync payload" };
  if (stateVector.length > MAX_APPS_SYNC_BYTES) return { ok: false, error: "Sync payload too large" };
  try {
    Y.decodeStateVector(stateVector);
  } catch {
    return { ok: false, error: "Invalid sync payload" };
  }
  return { ok: true, appId, live, stateVector };
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
  let scope: RoomScope | null = null;

  const endRestart = (): void => {
    const restart = scope?.restart;
    if (!scope || !restart || restart.state === "idle") return;
    clearTimeout(restart.timer);
    followersOf(restart.apps).delete(followStage);
    scope.restart = { state: "idle" };
  };
  const scopeFor = (apps: RoomApps): RoomScope => {
    if (scope?.apps === apps) return scope;
    endRestart();
    scope = { apps, synced: null, refusedReplicas: [], restart: { state: "idle" }, freeSyncRevision: null };
    return scope;
  };
  const inScope = (apps: RoomApps): boolean =>
    socket.connected && context.currentRoom?.apps === apps && scope?.apps === apps;
  const showsRestartedApp = (restart: ActiveRestart): boolean => {
    const stage = restart.apps.snapshot();
    return inScope(restart.apps) && stage.activeAppId === restart.appId && stage.docGeneration !== null;
  };

  const sendBlankStage = (current: RoomScope, appId: string, attempt: number): void => {
    const { apps } = current;
    current.synced = null;
    apps.scheduler.purge((write) => write.sender === socket, "not-synced");
    socket.emit("apps:state", {
      ...getRoomAppsState(context),
      activeAppId: null,
      docGeneration: null,
    } satisfies AppsState);
    const timer = setTimeout(() => sendRealStage(current), COPY_RESTART_DELAY_MS);
    current.restart = { state: "blank-sent", apps, appId, revision: apps.stageRevision, attempt, timer };
    followersOf(apps).add(followStage);
  };
  const followStage = (): void => {
    const current = scope;
    const restart = current?.restart;
    if (!current || !restart || restart.state === "idle" || restart.apps.stageRevision === restart.revision) return;
    if (!showsRestartedApp(restart)) {
      if (restart.state === "awaiting-sync") endRestart();
      return;
    }
    if (restart.state === "awaiting-sync") {
      current.restart = { ...restart, revision: restart.apps.stageRevision };
      return;
    }
    clearTimeout(restart.timer);
    sendBlankStage(current, restart.appId, restart.attempt);
  };
  const sendRealStage = (current: RoomScope): void => {
    const restart = current.restart;
    if (scope !== current || restart.state !== "blank-sent") return;
    if (restart.apps.stageRevision !== restart.revision || !showsRestartedApp(restart)) {
      endRestart();
      return;
    }
    socket.emit("apps:state", getRoomAppsState(context));
    const timer = setTimeout(() => retryRestart(current), COPY_RESTART_CHECK_MS);
    current.restart = { ...restart, state: "awaiting-sync", timer };
  };
  const retryRestart = (current: RoomScope): void => {
    const restart = current.restart;
    if (scope !== current || restart.state !== "awaiting-sync") return;
    if (!showsRestartedApp(restart) || restart.attempt >= COPY_RESTART_ATTEMPTS) {
      endRestart();
      return;
    }
    sendBlankStage(current, restart.appId, restart.attempt + 1);
  };
  const restartCopy = (admission: Admission): void => {
    const current = scope;
    if (!current || current.restart.state !== "idle" || !inScope(admission.apps)) return;
    const stage = admission.apps.snapshot();
    if (stage.docGeneration === null || stage.activeAppId !== admission.appId) return;
    sendBlankStage(current, admission.appId, 1);
  };

  const signalRefused = (current: RoomScope, appId: string, replicaId: string, reason: string): void => {
    if (current.refusedReplicas.includes(replicaId)) return;
    current.refusedReplicas.push(replicaId);
    if (current.refusedReplicas.length > REMEMBERED_REFUSED_REPLICAS) current.refusedReplicas.shift();
    socket.emit("apps:yjs:refused", { appId, replicaId, reason } satisfies AppsRefusedData);
  };
  const refuse = (admission: Admission, reason: WriteRefusal): void => {
    if (!inScope(admission.apps) || !scope) return;
    Logger.warn(`[Apps] Dropping update for ${admission.appId} from ${admission.userId}: ${reason}`);
    if (admission.replicaId) signalRefused(scope, admission.appId, admission.replicaId, reason);
    else if (reason !== "not-live") restartCopy(admission);
  };
  const finishWrite = (admission: Admission, outcome: WriteOutcome, update: Uint8Array | null): void => {
    if (outcome === null && update) {
      socket.to(admission.channelId).emit("apps:yjs:update", {
        appId: admission.appId,
        update,
      } satisfies AppsUpdateData);
      return;
    }
    if (outcome !== null) refuse(admission, outcome);
  };

  const sendRoomCopy = (current: RoomScope, appId: string): void => {
    const { apps } = current;
    const mark = apps.syncMark(appId);
    const copy = apps.roomCopy(appId);
    if (!mark || !copy) return;
    current.synced = mark;
    socket.emit("apps:yjs:update", { appId, update: copy } satisfies AppsUpdateData);
  };

  const runStageCommand = (
    expectedRevision: unknown,
    deniedError: string,
    command: StageCommand,
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
    const { apps } = room;
    const plan = apps.plan(command, revision);
    if (!plan.ok) {
      reply({ success: false, ...STAGE_COMMAND_ERRORS[plan.reason] });
      return;
    }
    if (!plan.changed) {
      reply({ success: true, state: { ...apps.snapshot(), roomId: room.id } });
      return;
    }
    const execute = (): void => {
      const result = apps.apply(command, revision);
      if (!result.ok) {
        reply({ success: false, ...STAGE_COMMAND_ERRORS[result.reason] });
        return;
      }
      const state: AppsState = { ...apps.snapshot(), roomId: room.id };
      if (result.changed) announceStageChange(room, command, result.awarenessRemoval, state);
      reply({ success: true, state });
    };
    if (command.kind === "present" || command.kind === "close") {
      apps.scheduler.afterHeld(apps.activeAppId, {
        changes: () => {
          const next = apps.plan(command, revision);
          return next.ok && next.changed;
        },
        run: execute,
        cancel: () => reply({ success: false, error: "Room closed" }),
      });
    } else {
      execute();
    }
  };
  const announceStageChange = (
    room: Room,
    command: StageCommand,
    awarenessRemoval: AppAwarenessRemoval | null,
    state: AppsState,
  ): void => {
    const { apps } = room;
    if (awarenessRemoval) {
      io.to(room.channelId).emit("apps:awareness", {
        appId: awarenessRemoval.appId,
        awarenessUpdate: awarenessRemoval.awarenessUpdate,
      } satisfies AppsAwarenessData);
    }
    io.to(room.channelId).emit("apps:state", state);
    for (const follow of [...followersOf(apps)]) {
      try {
        follow();
      } catch (error) {
        Logger.warn("[Apps] Following a stage change failed", error);
      }
    }
    if (command.kind === "discard") apps.scheduler.purge((write) => write.appId === command.appId, "not-live");
    if (command.kind === "lock" && command.locked) apps.scheduler.purge((write) => !write.host, "locked");
    apps.scheduler.wake();
  };

  socket.on("disconnecting", endRestart);

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
        { kind: "present", appId },
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

  socket.on("apps:close", (first: unknown, second: unknown) => {
    const callback = typeof first === "function" ? first : second;
    const data = (typeof first === "function" ? undefined : first) as
      | AppsCloseData
      | undefined;
    runStageCommand(
      data?.expectedRevision,
      "Only admins can close apps",
      { kind: "close" },
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
        { kind: "discard", appId },
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
        { kind: "lock", locked },
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
      const { apps } = context.currentRoom;
      const current = scopeFor(apps);
      const request = readSyncRequest(apps, data);
      const freeSync = request.ok && current.freeSyncRevision !== apps.stageRevision;
      if (!freeSync && !takeToken(socket, "apps:yjs:sync", RATE_LIMITS.appsYjsSync)) {
        respond(callback, retryLater("Too many app sync requests", 500));
        return;
      }
      if (!request.ok) {
        respond(callback, { error: request.error });
        return;
      }
      if (freeSync) current.freeSyncRevision = apps.stageRevision;
      const { appId, live, stateVector } = request;
      const update = Y.encodeStateAsUpdate(live, stateVector);
      if (update.length > MAX_APP_DOC_BYTES) {
        respond(callback, { error: "App document too large to sync" });
        return;
      }
      const mark = apps.syncMark(appId);
      if (mark && current.restart.state !== "blank-sent") {
        current.synced = mark;
        endRestart();
      }
      const awarenessSnapshot = apps.encodeAwarenessSnapshot(appId) ?? undefined;
      const awarenessUpdate =
        awarenessSnapshot && awarenessSnapshot.length <= MAX_APPS_AWARENESS_BYTES
          ? awarenessSnapshot
          : undefined;
      respond(callback, {
        syncMessage: update,
        stateVector: Y.encodeStateVector(live),
        awarenessUpdate,
      });
    }
  );

  socket.on("apps:yjs:update", (data: AppsUpdateData) => {
    const room = context.currentRoom;
    const client = context.currentClient;
    if (!room || !client || client.isObserver) return;
    const appId = normalizeAppId(data?.appId);
    if (!appId) return;
    const { apps } = room;
    const current = scopeFor(apps);
    const executor: DocumentExecutor = apps;
    const admission: Admission = {
      apps,
      channelId: room.channelId,
      socketId: socket.id,
      userId: client.id,
      participant: apps.participantFor(client.id),
      host: canControlStage(context),
      appId,
      replicaId: normalizeReplicaId(data?.replicaId),
      arrivedAt: Date.now(),
    };
    const update = toUint8Array(data.update);
    if (!update || update.length === 0) {
      refuse(admission, "invalid");
      return;
    }
    if (update.length > MAX_APPS_UPDATE_BYTES) {
      refuse(admission, "too-large");
      return;
    }
    let checked: boolean | null | undefined;
    const changesNothing = (): boolean | null => {
      if (checked === undefined) {
        checked = isEmptyUpdate(update)
          ? true
          : takeToken(socket, "apps:noop-check", RATE_LIMITS.appsNoopCheck)
            ? executor.changesNothing(appId, update)
            : null;
      }
      return checked;
    };
    if (current.restart.state === "blank-sent") return;
    if (current.restart.state === "awaiting-sync") {
      if (current.restart.apps === apps && current.restart.appId === appId && changesNothing() === true) {
        sendRoomCopy(current, appId);
        endRestart();
      }
      return;
    }
    const stage = apps.snapshot();
    if (stage.activeAppId !== appId || stage.docGeneration === null) {
      refuse(admission, "not-live");
      return;
    }
    if (stage.locked && !admission.host) {
      if (changesNothing() !== true) refuse(admission, "locked");
      else if (!apps.isCurrentSync(current.synced)) sendRoomCopy(current, appId);
      return;
    }
    const mark = current.synced;
    if (!apps.isCurrentSync(mark)) {
      if (changesNothing() === true) sendRoomCopy(current, appId);
      else refuse(admission, "not-synced");
      return;
    }
    const generation = stage.docGeneration;
    apps.scheduler.submit({
      sender: socket,
      appId,
      key: `${appId}\u0000${generation}\u0000${admission.replicaId ?? ""}\u0000${admission.host}`,
      host: admission.host,
      update,
      run: (merged) => {
        const latest = scope?.apps === apps && apps.isCurrentSync(scope.synced) ? scope.synced : mark;
        return executor.write(appId, admission.participant, merged, latest, {
          origin: admission.socketId,
          host: admission.host,
        });
      },
      finish: (outcome, merged) => finishWrite(admission, outcome, merged),
    });
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
