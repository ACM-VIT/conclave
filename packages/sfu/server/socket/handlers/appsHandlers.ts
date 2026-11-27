import { APP_DOCUMENT_MAX_BYTES, APP_DOCUMENT_UPDATE_MAX_BYTES, APP_DOCUMENT_UPLOAD_LIST_MAX } from "@conclave/apps-sdk/limits";
import { readChangePart, STAGED_CHANGE_IDLE_MS } from "../../apps/documents/staging.js";
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
  type AppAwarenessRemoval,
  type AppSyncMark,
  type RoomApps,
  type StageCommand,
  type SyncAnswer,
  type WriteRefusal,
} from "../../roomApps.js";
import { afterSettled, whenSettled, type SlotWrite, type StageTransition, type WireBatch } from "../../roomAppsScheduler.js";
import { Logger } from "../../../utilities/loggers.js";
import type { ConnectionContext } from "../context.js";
import { RATE_LIMITS, refundToken, takeToken } from "../rateLimit.js";
import { respond } from "./ack.js";
import { wireBytes, type WireBytes } from "../wireBytes.js";

const MAX_APPS_SYNC_BYTES = 64 * 1024;
const LEGACY_SYNC_HOLD_MS = 25_000;
const MAX_OPEN_LEGACY_SYNCS = 4;
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
  readonly room: Room;
};

type ActiveRestart = {
  state: "blank-sent" | "awaiting-sync";
  apps: RoomApps;
  epoch: number;
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
  canUploadWhole: boolean;
};

type StageOutcome =
  | { success: true; state: AppsState }
  | { success: false; error: string; code?: AppsStageErrorCode };

const heldUpdatesRefusedBy = (command: StageCommand): StageTransition["refuse"] =>
  command.kind === "discard"
    ? { matches: (write) => write.appId === command.appId, outcome: "not-live" }
    : command.kind === "present"
      ? { matches: (write) => write.appId !== command.appId, outcome: "not-live" }
      : command.kind === "close"
        ? { matches: () => true, outcome: "not-live" }
        : command.locked
          ? { matches: (write) => !write.host, outcome: "locked" }
          : undefined;

const EMPTY_STATE_VECTOR = new Uint8Array([0]);

const SYNC_ERRORS: Record<Extract<SyncAnswer, { ok: false }>["reason"], AppsSyncError> = {
  "not-live": { error: "App not active" },
  invalid: { error: "Invalid sync payload" },
  "too-large": { error: "App document too large to sync" },
  "timed-out": retryLater("App document sync timed out", 250),
  crashed: retryLater("App document sync failed", 250),
  "queue-full": retryLater("App document is busy", 250),
  unavailable: { error: "App document unavailable" },
};

const later = (ms: number, task: () => void): ReturnType<typeof setTimeout> =>
  setTimeout(() => {
    try {
      task();
    } catch (error) {
      Logger.error("[Apps] A copy restart step failed", error);
    }
  }, ms);

const EMPTY_UPDATE_BYTES = 2;

const isEmptyUpdate = (update: Uint8Array): boolean =>
  update.length === EMPTY_UPDATE_BYTES && update[0] === 0 && update[1] === 0;

const normalizeReplicaId = (value: unknown): string | undefined =>
  typeof value === "string" && value.length > 0 && value.length <= MAX_REPLICA_ID_LENGTH
    ? value
    : undefined;

const MAX_APP_ID_LENGTH = 128;
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f]/;

const normalizeAppId = (value: unknown): string | null => {
  if (typeof value !== "string" || value.length > MAX_APP_ID_LENGTH) {
    return null;
  }
  const appId = value.trim();
  if (!appId || CONTROL_CHARACTER_PATTERN.test(appId)) {
    return null;
  }
  return appId;
};

const getRoomAppsState = (context: ConnectionContext): AppsState => {
  if (!context.currentRoom) {
    return {
      activeAppId: null,
      locked: false,
      revision: 0,
      savedAppIds: [],
      docGeneration: null,
      notInRoom: true,
    };
  }
  return { ...context.currentRoom.apps.snapshot(), roomId: context.currentRoom.id };
};

type SyncRequest = { ok: true; appId: string; stateVector: Uint8Array } | { ok: false; error: string };

const readSyncRequest = (apps: RoomApps, data: AppsSyncData | undefined): SyncRequest => {
  const appId = normalizeAppId(data?.appId);
  if (!appId) return { ok: false, error: "Invalid app id" };
  if (apps.activeAppId !== appId) return { ok: false, error: "App not active" };
  const wire = wireBytes(data?.syncMessage);
  if (!wire || wire.length === 0) return { ok: false, error: "Invalid sync payload" };
  if (wire.length > MAX_APPS_SYNC_BYTES) return { ok: false, error: "Sync payload too large" };
  const stateVector = wire.read();
  if (!stateVector || stateVector.length !== wire.length) return { ok: false, error: "Invalid sync payload" };
  return { ok: true, appId, stateVector };
};

function retryLater(error: string, retryAfterMs: number): AppsSyncError {
  return { error, retryable: true, retryAfterMs };
}

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
    restart.apps.unfollow(followStage);
    scope.restart = { state: "idle" };
  };
  const scopeFor = (apps: RoomApps): RoomScope => {
    if (scope?.apps === apps) return scope;
    endRestart();
    dropStaged();
    scope = { apps, synced: null, refusedReplicas: [], restart: { state: "idle" }, freeSyncRevision: null, canUploadWhole: false };
    return scope;
  };
  const stillIn = (apps: RoomApps): boolean => context.currentRoom?.apps === apps && scope?.apps === apps;
  const inScope = (apps: RoomApps): boolean => socket.connected && stillIn(apps);
  const showsRestartedApp = (restart: ActiveRestart): boolean => {
    const stage = restart.apps.snapshot();
    return inScope(restart.apps) && stage.activeAppId === restart.appId && stage.docGeneration !== null;
  };

  const sendBlankStage = (current: RoomScope, appId: string, attempt: number): void => {
    const { apps } = current;
    apps.scheduler.hold(() => {
      current.synced = null;
      const timer = later(COPY_RESTART_DELAY_MS, () => sendRealStage(current));
      current.restart = {
        state: "blank-sent",
        apps,
        epoch: apps.epoch,
        appId,
        revision: apps.stageRevision,
        attempt,
        timer,
      };
      apps.follow(followStage);
      socket.emit("apps:state", {
        ...getRoomAppsState(context),
        activeAppId: null,
        docGeneration: null,
      } satisfies AppsState);
      apps.scheduler.purge((write) => write.sender === socket, "not-synced");
    });
  };
  const followStage = (): void => {
    const current = scope;
    const restart = current?.restart;
    if (!current || !restart || restart.state === "idle") return;
    if (restart.apps.epoch !== restart.epoch) {
      endRestart();
      return;
    }
    if (restart.apps.stageRevision === restart.revision) return;
    if (showsRestartedApp(restart)) {
      if (restart.state === "awaiting-sync") {
        current.restart = { ...restart, revision: restart.apps.stageRevision };
        return;
      }
      clearTimeout(restart.timer);
      sendBlankStage(current, restart.appId, restart.attempt);
      return;
    }
    if (restart.state === "awaiting-sync" || !inScope(restart.apps) || restart.apps.activeAppId !== null) endRestart();
  };
  const sendRealStage = (current: RoomScope): void => {
    const restart = current.restart;
    if (scope !== current || restart.state !== "blank-sent") return;
    if (restart.apps.stageRevision !== restart.revision || !showsRestartedApp(restart)) {
      endRestart();
      return;
    }
    socket.emit("apps:state", getRoomAppsState(context));
    const timer = later(COPY_RESTART_CHECK_MS, () => retryRestart(current));
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
  let unloggedRefusals = 0;
  const logRefusal = (admission: Admission, reason: WriteRefusal): void => {
    if (!takeToken(socket, "apps:refusal-log", RATE_LIMITS.appsRefusalLog)) {
      unloggedRefusals += 1;
      return;
    }
    const unlogged = unloggedRefusals > 0 ? ` (${unloggedRefusals} more not logged)` : "";
    unloggedRefusals = 0;
    Logger.warn(`[Apps] Dropping update for ${admission.appId} from ${admission.userId}: ${reason}${unlogged}`);
  };
  const refuse = (admission: Admission, reason: WriteRefusal): void => {
    if (!inScope(admission.apps) || !scope) return;
    logRefusal(admission, reason);
    if (admission.replicaId) signalRefused(scope, admission.appId, admission.replicaId, reason);
    else if (reason !== "not-live") restartCopy(admission);
  };
  const relay = (admission: Admission, mark: AppSyncMark, landed: Uint8Array[]): void => {
    if (!admission.apps.isCurrentSync(mark)) return;
    const includeWriter =
      (admission.replicaId !== undefined || admission.appId === "wheel") && inScope(admission.apps);
    for (const update of landed) {
      const message: AppsUpdateData = { appId: admission.appId, update };
      if (update.length <= APP_DOCUMENT_UPDATE_MAX_BYTES) {
        socket.to(admission.channelId).emit("apps:yjs:update", message);
      } else {
        const state = { ...admission.apps.snapshot(), roomId: admission.room.id };
        for (const receiver of admission.room.clients.values()) {
          if (receiver.socket.id === socket.id) continue;
          if (receiver.takesLargeAppUpdates === false) {
            receiver.socket.emit("apps:state", { ...state, activeAppId: null, docGeneration: null });
            receiver.socket.emit("apps:state", state);
          } else {
            receiver.socket.emit("apps:yjs:update", message);
          }
        }
      }
      if (includeWriter) socket.emit("apps:yjs:update", message);
    }
  };

  const writeFor = (
    admission: Admission, mark: AppSyncMark, done: (committed?: boolean) => void, mode: "single" | "list" | "assembled",
    direct: boolean,
  ): SlotWrite => {
    const { apps, appId, host, participant, replicaId, socketId } = admission;
    return {
      sender: socket,
      appId,
      key: JSON.stringify([appId, mark.generation, replicaId, host]),
      host,
      direct,
      run: (updates) => {
        const latest = scope?.apps === apps && apps.isCurrentSync(scope.synced) ? scope.synced : mark;
        const identity = {
          participant, host, origin: socketId, mark: latest, separate: mode === "list",
          assembled: mode === "assembled" ? true as const : undefined,
        };
        return whenSettled(apps.executor.write(appId, identity, updates), (result) => {
          relay(admission, mark, result.landed);
          return mode === "list" ? [result.outcomes.find((outcome) => outcome !== null) ?? null] : result.outcomes;
        });
      },
      finish: (outcome) => {
        try {
          if (outcome !== null) refuse(admission, outcome);
        } finally {
          done(outcome === null);
        }
      },
    };
  };

  const sendRoomCopy = (current: RoomScope, appId: string): void => {
    const { apps } = current;
    const revision = apps.stageRevision;
    afterSettled("Sending the room's copy", apps.executor.sync(appId, EMPTY_STATE_VECTOR), (answer) => {
      if (!answer.ok || scope !== current || !stillIn(apps) || apps.stageRevision !== revision) return;
      current.synced = answer.mark;
      socket.emit("apps:yjs:update", { appId, update: answer.update } satisfies AppsUpdateData);
    });
  };

  const runStageCommand = (
    expectedRevision: unknown,
    deniedError: string,
    command: StageCommand,
    reply: (outcome: StageOutcome) => void,
    expectedRoomId?: unknown,
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
    const client = context.currentClient;
    if (expectedRoomId !== undefined && expectedRoomId !== room.id) {
      reply({ success: false, ...STAGE_COMMAND_ERRORS.stale });
      return;
    }
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
      if (!socket.connected || context.currentRoom !== room || context.currentClient !== client) {
        reply({ success: false, ...STAGE_COMMAND_ERRORS.stale });
        return;
      }
      const next = apps.plan(command, revision);
      if (!next.ok) {
        reply({ success: false, ...STAGE_COMMAND_ERRORS[next.reason] });
        return;
      }
      let state: AppsState = { ...apps.snapshot(), roomId: room.id };
      if (next.changed) {
        apps.scheduler.transition({
          refuse: heldUpdatesRefusedBy(command),
          apply: () => {
            const result = apps.apply(command, revision);
            state = { ...apps.snapshot(), roomId: room.id };
            if (result.ok && result.changed) announceStage(room, result.awarenessRemoval, state);
          },
          notify: () => apps.notifyFollowers(),
        });
      }
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
  const announceStage = (room: Room, awarenessRemoval: AppAwarenessRemoval | null, state: AppsState): void => {
    if (awarenessRemoval) {
      io.to(room.channelId).emit("apps:awareness", {
        appId: awarenessRemoval.appId,
        awarenessUpdate: awarenessRemoval.awarenessUpdate,
      } satisfies AppsAwarenessData);
    }
    io.to(room.channelId).emit("apps:state", state);
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
        data?.expectedRoomId,
      );
    }
  );

  type CloseAck = (response: AppsCloseResponse) => void;
  socket.on("apps:close", (first: AppsCloseData | CloseAck | undefined, second?: CloseAck) => {
    const legacy = typeof first === "function";
    const callback = legacy ? first : second;
    const data = legacy ? undefined : first;
    runStageCommand(
      data?.expectedRevision,
      "Only admins can close apps",
      { kind: "close" },
      (outcome) =>
        respond<AppsCloseResponse>(
          callback,
          outcome.success ? { success: true, revision: outcome.state.revision } : outcome,
        ),
      data?.expectedRoomId,
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

  const legacySyncs = new Set<() => void>();
  const endUploads = (): void => {
    endRestart();
    for (const stop of legacySyncs) stop();
    dropStaged();
  };
  socket.on("disconnecting", endUploads);
  socket.on("disconnect", endUploads);

  socket.on(
    "apps:yjs:sync",
    (data: AppsSyncData, callback: (response: AppsSyncResponse | AppsSyncError) => void) => {
      const room = context.currentRoom;
      if (!room) {
        respond(callback, data?.canRetry ? retryLater("Not in a room", 500) : { error: "Not in a room" });
        return;
      }
      const { apps } = room;
      const current = scopeFor(apps);
      const revision = apps.stageRevision;
      const stay = apps.stayToken;
      const client = context.currentClient;
      const pay = () => takeToken(socket, "apps:yjs:sync", RATE_LIMITS.appsYjsSync);
      const limited = () => retryLater("Too many app sync requests", 500);
      const serve = (reply: (response: AppsSyncResponse | AppsSyncError) => void): void => {
        if (scope !== current || !stillIn(apps) || apps.stayToken !== stay) {
          reply(SYNC_ERRORS["not-live"]);
          return;
        }
        const request = readSyncRequest(apps, data);
        if (!request.ok) {
          reply({ error: request.error });
          return;
        }
        const { appId, stateVector } = request;
        afterSettled("App sync", apps.executor.sync(appId, stateVector), (answer) => {
          if (scope !== current || !stillIn(apps) || apps.stayToken !== stay) {
            reply(SYNC_ERRORS["not-live"]);
            return;
          }
          const valid = answer.ok || answer.reason === "too-large";
          if (valid && apps.stageRevision === revision && current.freeSyncRevision !== revision) {
            current.freeSyncRevision = revision;
            refundToken(socket, "apps:yjs:sync", RATE_LIMITS.appsYjsSync);
          }
          if (!answer.ok) {
            reply(SYNC_ERRORS[answer.reason]);
            return;
          }
          if (current.restart.state !== "blank-sent") {
            current.synced = answer.mark;
            endRestart();
          }
          if (data.wholeChanges === true) current.canUploadWhole = true;
          if (client) client.takesLargeAppUpdates = data.wholeChanges === true || typeof data.syncMessage !== "string";
          const awareness = apps.encodeAwarenessSnapshot(appId);
          reply({
            syncMessage: answer.update,
            stateVector: answer.stateVector,
            stagesParts: true,
            takesUpdateLists: true,
            awarenessUpdate: awareness && awareness.length <= MAX_APPS_AWARENESS_BYTES ? awareness : undefined,
          });
        });
      };
      if (data?.canRetry === true) {
        if (pay()) serve((answer) => respond(callback, answer));
        else respond(callback, limited());
        return;
      }
      if (legacySyncs.size >= MAX_OPEN_LEGACY_SYNCS) {
        respond(callback, { error: limited().error });
        return;
      }
      let paid = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      let lastError = "App document is busy";
      const stop = (): void => {
        clearTimeout(timer);
        clearTimeout(deadline);
        legacySyncs.delete(stop);
      };
      const finish = (response: AppsSyncResponse | AppsSyncError): void => {
        if (!legacySyncs.has(stop)) return;
        stop();
        respond(callback, response);
      };
      const deadline = later(LEGACY_SYNC_HOLD_MS, () => finish({ error: lastError }));
      const attempt = (): void => {
        const receive = (answer: AppsSyncResponse | AppsSyncError): void => {
          if (!legacySyncs.has(stop)) return;
          if (!("error" in answer) || !answer.retryable) finish(answer);
          else {
            lastError = answer.error;
            timer = later(answer.retryAfterMs ?? 250, attempt);
          }
        };
        if (apps.stayToken !== stay || scope !== current || !stillIn(apps)) {
          finish(SYNC_ERRORS["not-live"]);
          return;
        }
        paid ||= pay();
        if (paid) serve(receive);
        else receive(limited());
      };
      legacySyncs.add(stop);
      attempt();
    }
  );

  type StagedChange = {
    admission: Admission;
    revision: number;
    id: string;
    count: number;
    parts: Uint8Array[];
    bytes: number;
    idle?: ReturnType<typeof setTimeout>;
  };
  let staged: StagedChange | null = null;
  const staging = context.state.appChangeStaging;
  const dropStaged = (): void => {
    if (!staged) return;
    clearTimeout(staged.idle);
    staged.admission.apps.unfollow(followStaged);
    staging.give(staged.bytes);
    staged = null;
  };
  const followStaged = (): void => {
    if (staged && staged.revision !== staged.admission.apps.stageRevision) dropStaged();
  };

  const readList = (value: unknown): WireBatch | null => {
    if (!Array.isArray(value) || value.length === 0 || value.length > APP_DOCUMENT_UPLOAD_LIST_MAX) return null;
    const wires: WireBytes[] = [];
    let length = 0;
    for (const item of value) {
      const wire = wireBytes(item);
      if (!wire || wire.length === 0) return null;
      wires.push(wire);
      length += wire.length;
    }
    return {
      length,
      readBatch: () => {
        const updates: Uint8Array[] = [];
        for (const wire of wires) {
          const update = wire.read();
          if (!update || update.length !== wire.length) return null;
          updates.push(update);
        }
        return updates;
      },
    };
  };

  const receiveUpdate = (data: AppsUpdateData, done: (committed?: boolean) => void): void => {
    const room = context.currentRoom;
    const client = context.currentClient;
    if (!room || !client || client.isObserver) return done();
    const wire = wireBytes(data?.update);
    const size = wire?.length ?? 0;
    const appId = normalizeAppId(data?.appId);
    if (!appId) return done();
    const { apps } = room;
    const changedScope = scope !== null && scope.apps !== apps;
    const current = scopeFor(apps);
    const admission: Admission = {
      apps,
      channelId: room.channelId,
      socketId: socket.id,
      userId: client.id,
      participant: apps.participantFor(client.id),
      host: canControlStage(context),
      appId,
      replicaId: normalizeReplicaId(data?.replicaId),
      room,
    };
    const reject = (reason: WriteRefusal): void => {
      dropStaged();
      refuse(admission, reason);
      done();
    };
    const part = readChangePart(data?.part);
    const hasList = data.updates !== undefined;
    const list = hasList ? readList(data.updates) : null;
    if (part === "invalid" || (part && (hasList || (changedScope && part.index !== 0)))) return reject("interrupted");
    if (hasList ? !list || data.update !== undefined : !wire || size === 0) return reject("invalid");
    if ((list?.length ?? size) > APP_DOCUMENT_UPDATE_MAX_BYTES) return reject("too-large");
    if (current.restart.state === "blank-sent") return done();
    const revision = apps.stageRevision;
    const checkNoop = (decide: (changesNothing: boolean | null) => void): void => {
      if (!wire || part) {
        decide(null);
        return;
      }
      if (size === EMPTY_UPDATE_BYTES) {
        const empty = wire.read();
        if (empty && isEmptyUpdate(empty)) {
          decide(true);
          return;
        }
      }
      if (!takeToken(socket, "apps:noop-check", RATE_LIMITS.appsNoopCheck)) {
        decide(null);
        return;
      }
      const update = wire.read();
      if (!update || update.length !== size) {
        decide(null);
        return;
      }
      afterSettled("Checking an app update", apps.executor.changesNothing(appId, update), (changesNothing) => {
        if (scope === current && stillIn(apps) && apps.stageRevision === revision) decide(changesNothing);
        else done();
      });
    };
    if (current.restart.state === "awaiting-sync") {
      const restart = current.restart;
      if (restart.apps !== apps || restart.appId !== appId) return done();
      checkNoop((changesNothing) => {
        done();
        if (changesNothing !== true || current.restart !== restart) return;
        sendRoomCopy(current, appId);
        endRestart();
      });
      return;
    }
    const stage = apps.snapshot();
    if (stage.activeAppId !== appId || stage.docGeneration === null) {
      return reject("not-live");
    }
    if (stage.locked && !admission.host) {
      checkNoop((changesNothing) => {
        if (changesNothing !== true) reject("locked");
        else {
          if (!apps.isCurrentSync(current.synced)) sendRoomCopy(current, appId);
          done();
        }
      });
      return;
    }
    const mark = current.synced;
    if (!apps.isCurrentSync(mark)) {
      checkNoop((changesNothing) => {
        if (changesNothing === true) {
          sendRoomCopy(current, appId);
          done();
        } else reject("not-synced");
      });
      return;
    }
    if (list) {
      dropStaged();
      apps.scheduler.submit(writeFor(admission, mark, done, "list", true), list);
      return;
    }
    if (!wire) return reject("invalid");
    if (!part) {
      dropStaged();
      apps.scheduler.submit(writeFor(admission, mark, done, "single", current.canUploadWhole), wire);
      return;
    }
    if (!takeToken(socket, "apps:change-part", RATE_LIMITS.appsYjsUpdate)) return reject("rate-limited");
    if (part.index === 0) {
      dropStaged();
      staged = { admission, revision, id: part.id, count: part.count, parts: [], bytes: 0 };
      apps.follow(followStaged);
    }
    const change = staged;
    if (
      !change || change.admission.apps !== apps || change.admission.appId !== appId ||
      change.admission.replicaId !== admission.replicaId || change.revision !== revision ||
      change.id !== part.id || change.count !== part.count || change.parts.length !== part.index
    ) return reject("interrupted");
    if (change.bytes + size > APP_DOCUMENT_MAX_BYTES) return reject("too-large");
    const update = wire.read();
    if (!update || update.length !== size) return reject("invalid");
    if (!staging.take(size)) return reject("queue-full");
    change.parts.push(new Uint8Array(update));
    change.bytes += size;
    clearTimeout(change.idle);
    if (change.parts.length < change.count) {
      change.idle = later(STAGED_CHANGE_IDLE_MS, () => {
        if (staged !== change) return;
        dropStaged();
        refuse(change.admission, "timed-out");
      });
      done();
      return;
    }

    apps.unfollow(followStaged);
    staged = null;
    const whole = new Uint8Array(change.bytes);
    let offset = 0;
    for (const bytes of change.parts) {
      whole.set(bytes, offset);
      offset += bytes.length;
    }
    apps.scheduler.submit(writeFor(admission, mark, (committed) => {
      staging.give(change.bytes);
      done(committed);
    }, "assembled", true), wireBytes(whole)!);
  };

  socket.on("apps:yjs:update", (data: AppsUpdateData, ack?: (receipt?: { committed: true }) => void) => {
    const done = (committed = false) => respond(ack, committed ? { committed: true } : undefined);
    try {
      receiveUpdate(data, done);
    } catch (error) {
      Logger.warn("[Apps] Reading an app update failed", error);
      dropStaged();
      done();
    }
  });

  socket.on("apps:awareness", (data: AppsAwarenessData) => {
    if (!context.currentRoom || !context.currentClient) return;
    if (context.currentClient.isObserver) return;
    // High-frequency event: drop (ignore) when over budget rather than process.
    if (!takeToken(socket, "apps:awareness", RATE_LIMITS.appsAwareness)) return;

    const appId = normalizeAppId(data?.appId);
    if (!appId) return;
    const wire = wireBytes(data?.awarenessUpdate);
    if (!wire || wire.length === 0 || wire.length > MAX_APPS_AWARENESS_BYTES) return;
    if (context.currentRoom.apps.activeAppId !== appId) return;
    const awarenessUpdate = wire.read();
    if (!awarenessUpdate || awarenessUpdate.length === 0) return;
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
