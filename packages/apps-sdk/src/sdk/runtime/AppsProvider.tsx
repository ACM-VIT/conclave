import React, { createContext, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Socket } from "socket.io-client";
import * as Y from "yjs";
import {
  Awareness,
  applyAwarenessUpdate,
  encodeAwarenessUpdate,
  removeAwarenessStates,
} from "y-protocols/awareness";
import type {
  AppDocuments,
  ConclaveApp,
  AppsAwarenessPayload,
  AppsClosePayload,
  AppsCommandResult,
  AppsCloseResponse,
  AppsContextValue,
  AppsDiscardPayload,
  AppsDiscardResponse,
  AppsLockPayload,
  AppsLockResponse,
  AppsOpenPayload,
  AppsOpenResponse,
  AppsRefusedPayload,
  AppsState,
  AppsSyncError,
  AppsSyncPayload,
  AppsSyncResponse,
  AppsUpdatePayload,
  AppSyncStatus,
  AppUser,
} from "../types/index";
import { classifySyncReply } from "./syncReply";
import { createUploadQueue } from "./uploadQueue";
import { changesToResend } from "./catchUpResend";

export const AppsContext = createContext<AppsContextValue | null>(null);

export type AppsProviderProps = {
  socket: Socket | null;
  apps: ConclaveApp[];
  user?: AppUser;
  participants?: AppUser[];
  isAdmin?: boolean;
  isReadOnly?: boolean;
  children: React.ReactNode;
};

const ACK_TIMEOUT_MS = 8_000;
const SYNC_RETRY_DELAYS_MS = [250, 500, 1_000, 2_000, 4_000];
const SYNC_GIVE_UP_MS = 30_000;
const MAX_AUTOMATIC_WRITE_ATTEMPTS = 3;
const FINAL_REFUSALS = new Set(["too-large", "locked", "invalid", "malformed", "unseen-value", "cleared", "foreign-id", "id-limit"]);
const MAX_CATCH_UPS = 3;
const CATCH_UP_WINDOW_MS = 30_000;

type AutomaticWrite = {
  write: (doc: Y.Doc) => void;
  state: "waiting" | "written" | "unconfirmed" | "done";
  writtenOn: string | null;
  update: Uint8Array | null;
  attempts: number;
  finalIfLost: boolean;
};

const writeAtomically = (doc: Y.Doc, write: (doc: Y.Doc) => void): Uint8Array | null => {
  const origin = {};
  let written: Uint8Array | null = null;
  const capture = (update: Uint8Array, updateOrigin: unknown) => {
    if (updateOrigin === origin) written = update;
  };
  doc.on("update", capture);
  try {
    doc.transact(() => write(doc), origin);
  } finally {
    doc.off("update", capture);
  }
  return written;
};

type SyncRun = {
  appId: string;
  doc: Y.Doc;
  replaces: boolean;
  catchesUp: boolean;
  startedAt: number;
  attempt: number;
  timer?: ReturnType<typeof setTimeout>;
};

const createAwareness = (doc: Y.Doc) => new Awareness(doc);

const newReplicaId = (): string => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;

const isEmptyUpdate = (update: Uint8Array): boolean => Y.snapshotContainsUpdate(Y.emptySnapshot, update);

type AwarenessUpdateEvent = {
  added: number[];
  updated: number[];
  removed: number[];
};

const rosterSignature = (roster: AppUser[]): string =>
  roster
    .map((member) => `${member.id}\u0001${member.name ?? ""}\u0001${member.email ?? ""}`)
    .join("\u0000");

type StageCommandResponse =
  | AppsOpenResponse
  | AppsCloseResponse
  | AppsDiscardResponse
  | AppsLockResponse;

type PendingStageCommand = { advance: () => void; cancel: () => void };

const EMPTY_APPS_STATE: AppsState = {
  activeAppId: null,
  locked: false,
  revision: null,
  savedAppIds: [],
  docGeneration: null,
};

const safeIntegerOrNull = (value: unknown): number | null =>
  typeof value === "number" && Number.isSafeInteger(value) ? value : null;

const commandResult = (response?: StageCommandResponse): AppsCommandResult => {
  if (response?.success) return { ok: true };
  if (response?.code === "room_full") return { ok: false, reason: "roomFull" };
  if (response?.code === "stale_revision") return { ok: false, reason: "staleStage" };
  return { ok: false, reason: "failed" };
};

const COMMAND_FAILED: AppsCommandResult = { ok: false, reason: "failed" };

const parseAppsState = (value: unknown): AppsState | null => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as {
    activeAppId?: unknown;
    locked?: unknown;
    revision?: unknown;
    savedAppIds?: unknown;
    docGeneration?: unknown;
    roomId?: unknown;
    notInRoom?: unknown;
  };
  const activeAppIdValid =
    typeof record.activeAppId === "string" || record.activeAppId === null;
  if (!activeAppIdValid || typeof record.locked !== "boolean") return null;
  return {
    activeAppId: record.activeAppId as string | null,
    locked: record.locked,
    revision: safeIntegerOrNull(record.revision),
    savedAppIds: Array.isArray(record.savedAppIds)
      ? record.savedAppIds.filter((appId): appId is string => typeof appId === "string")
      : [],
    docGeneration: safeIntegerOrNull(record.docGeneration),
    ...(typeof record.roomId === "string" ? { roomId: record.roomId } : {}),
    ...(record.notInRoom === true ? { notInRoom: true } : {}),
  };
};

const decodeBase64 = (value: string): Uint8Array | null => {
  const maybeBuffer = (globalThis as { Buffer?: { from: (input: string, encoding: string) => Uint8Array } }).Buffer;
  if (maybeBuffer) {
    try {
      return Uint8Array.from(maybeBuffer.from(value, "base64"));
    } catch {
    }
  }

  if (typeof atob === "function") {
    try {
      const binary = atob(value);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i += 1) {
        bytes[i] = binary.charCodeAt(i);
      }
      return bytes;
    } catch {
      return null;
    }
  }

  return null;
};

const toUint8Array = (value: unknown): Uint8Array | null => {
  if (!value) return null;
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);

  if (typeof value === "object" && "buffer" in (value as ArrayBufferView)) {
    const view = value as ArrayBufferView;
    if (view.buffer instanceof ArrayBuffer) {
      return new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
    }
  }

  if (Array.isArray(value)) {
    const allNumbers = value.every((item) => typeof item === "number");
    if (!allNumbers) return null;
    return Uint8Array.from(value);
  }

  if (typeof value === "object") {
    const maybeBuffer = value as { type?: unknown; data?: unknown };
    if (maybeBuffer.type === "Buffer" && Array.isArray(maybeBuffer.data)) {
      const allNumbers = maybeBuffer.data.every((item) => typeof item === "number");
      if (!allNumbers) return null;
      return Uint8Array.from(maybeBuffer.data);
    }
  }

  if (typeof value === "string") {
    const base64Pattern = /^[A-Za-z0-9+/]+={0,2}$/;
    if (value.length % 4 === 0 && base64Pattern.test(value)) {
      return decodeBase64(value);
    }
  }

  return null;
};

export function AppsProvider({
  socket,
  apps,
  user,
  participants,
  isAdmin,
  isReadOnly = false,
  children,
}: AppsProviderProps) {
  const [state, setState] = useState<AppsState>(EMPTY_APPS_STATE);
  const [roster, setRoster] = useState<AppUser[]>(() => participants ?? []);
  const [syncStatus, setSyncStatus] = useState<AppSyncStatus>("idle");
  const [docsVersion, setDocsVersion] = useState(0);
  const [rejectedChange, setRejectedChange] = useState<{ at: number; reason: string } | null>(null);
  const [isRebuilding, setIsRebuilding] = useState(false);
  const syncRunRef = useRef<SyncRun | null>(null);
  const disposedRef = useRef(false);

  useEffect(() => {
    const next = participants ?? [];
    setRoster((previous) =>
      rosterSignature(previous) === rosterSignature(next) ? previous : next
    );
  }, [participants]);

  const docsRef = useRef<Map<string, Y.Doc>>(new Map());
  const awarenessRef = useRef<Map<string, Awareness>>(new Map());
  const initialUpdateSentRef = useRef<Set<string>>(new Set());
  const docHandlersRef = useRef<Map<string, (update: Uint8Array, origin: unknown) => void>>(
    new Map()
  );
  const awarenessHandlersRef = useRef<
    Map<string, (event: AwarenessUpdateEvent, origin: unknown) => void>
  >(new Map());
  const replicaIdsRef = useRef<Map<string, string>>(new Map());
  const staleAppsRef = useRef<Set<string>>(new Set());
  const unsentAppsRef = useRef<Set<string>>(new Set());
  const syncedAppsRef = useRef<Set<string>>(new Set());
  const catchUpsRef = useRef<Map<string, number[]>>(new Map());
  const resendRef = useRef<Map<string, Uint8Array[]>>(new Map());
  const reconnectedRef = useRef(false);
  const stagesPartsRef = useRef<boolean | null>(null);
  const takesListsRef = useRef(false);
  const unverifiedUploadsRef = useRef(new Set<string>());
  const pendingStageRef = useRef<PendingStageCommand | null>(null);
  const [uploads] = useState(() =>
    createUploadQueue(
      (appId, replicaId, upload, settled) => {
        const currentSocket = socketRef.current;
        if (!currentSocket?.connected || reconnectedRef.current) return false;
        const payload: AppsUpdatePayload = { appId, replicaId, ...upload };
        const noteUnverified = () => {
          if (socketRef.current === currentSocket && replicaIdsRef.current.get(appId) === replicaId &&
              serverStateRef.current.revision !== null) {
            unverifiedUploadsRef.current.add(appId);
          }
        };
        if (settled) {
          currentSocket.emit("apps:yjs:update", payload, (receipt?: { committed: true }) => {
            queueMicrotask(() => {
              if (receipt?.committed !== true) noteUnverified();
              settled();
            });
          });
        } else {
          if (!("part" in upload) || !upload.part || upload.part.index === upload.part.count - 1) noteUnverified();
          currentSocket.emit("apps:yjs:update", payload);
        }
        return true;
      },
      {
        stagesParts: () => stagesPartsRef.current,
        takesLists: () => takesListsRef.current,
        onProgress: () => pendingStageRef.current?.advance(),
      },
    )
  );
  const automaticWritesRef = useRef<Map<string, Map<string, AutomaticWrite>>>(new Map());
  const socketRef = useRef<Socket | null>(null);
  const isReadOnlyRef = useRef(isReadOnly);
  const isAdminRef = useRef(Boolean(isAdmin));
  const lockedRef = useRef(false);

  useEffect(() => {
    isReadOnlyRef.current = isReadOnly;
    if (isReadOnly) pendingStageRef.current?.cancel();
  }, [isReadOnly]);

  useEffect(() => {
    isAdminRef.current = Boolean(isAdmin);
  }, [isAdmin]);

  const serverStateRef = useRef<AppsState>(EMPTY_APPS_STATE);

  const canWrite = useCallback(
    () => !isReadOnlyRef.current && (!lockedRef.current || isAdminRef.current),
    []
  );

  const stopSync = useCallback(() => {
    const run = syncRunRef.current;
    syncRunRef.current = null;
    if (!run) return;
    clearTimeout(run.timer);
    if (run.replaces) run.doc.destroy();
  }, []);

  const resetLocalData = useCallback(() => {
    pendingStageRef.current?.cancel();
    stopSync();
    setSyncStatus("idle");
    for (const [appId, doc] of docsRef.current.entries()) {
      const handler = docHandlersRef.current.get(appId);
      if (handler) {
        doc.off("update", handler);
      }
      try {
        doc.destroy();
      } catch {}
    }

    for (const [appId, awareness] of awarenessRef.current.entries()) {
      const handler = awarenessHandlersRef.current.get(appId);
      if (handler) {
        awareness.off("update", handler);
      }
      try {
        awareness.destroy();
      } catch {}
    }

    docsRef.current.clear();
    awarenessRef.current.clear();
    docHandlersRef.current.clear();
    awarenessHandlersRef.current.clear();
    uploads.clear();
    resendRef.current.clear();
    unverifiedUploadsRef.current.clear();
    stagesPartsRef.current = null;
    takesListsRef.current = false;
    reconnectedRef.current = false;
    catchUpsRef.current.clear();
    initialUpdateSentRef.current.clear();
    replicaIdsRef.current.clear();
    staleAppsRef.current.clear();
    unsentAppsRef.current.clear();
    syncedAppsRef.current.clear();
    automaticWritesRef.current.clear();
    serverStateRef.current = EMPTY_APPS_STATE;
    lockedRef.current = false;
    setState(EMPTY_APPS_STATE);
    setRejectedChange(null);
    setIsRebuilding(false);
    setDocsVersion((version) => version + 1);
  }, [stopSync, uploads]);

  useEffect(() => {
    if (socketRef.current !== socket) {
      resetLocalData();
    }
    socketRef.current = socket;
  }, [socket, resetLocalData]);

  useEffect(() => {
    disposedRef.current = false;
    return () => {
      disposedRef.current = true;
      pendingStageRef.current?.cancel();
      queueMicrotask(() => {
        if (disposedRef.current) resetLocalData();
      });
    };
  }, [resetLocalData]);

  const discardLocalApp = useCallback((appId: string) => {
    const doc = docsRef.current.get(appId);
    if (doc) {
      const handler = docHandlersRef.current.get(appId);
      if (handler) doc.off("update", handler);
      try {
        doc.destroy();
      } catch {}
    }
    const awareness = awarenessRef.current.get(appId);
    if (awareness) {
      const handler = awarenessHandlersRef.current.get(appId);
      if (handler) awareness.off("update", handler);
      try {
        awareness.destroy();
      } catch {}
    }
    docsRef.current.delete(appId);
    awarenessRef.current.delete(appId);
    docHandlersRef.current.delete(appId);
    awarenessHandlersRef.current.delete(appId);
    uploads.drop(appId);
    resendRef.current.delete(appId);
    unverifiedUploadsRef.current.delete(appId);
    initialUpdateSentRef.current.delete(appId);
    replicaIdsRef.current.delete(appId);
    staleAppsRef.current.delete(appId);
    unsentAppsRef.current.delete(appId);
    syncedAppsRef.current.delete(appId);
    setDocsVersion((version) => version + 1);
  }, [uploads]);

  const registerDocHandlers = useCallback((appId: string, doc: Y.Doc) => {
    if (docHandlersRef.current.has(appId)) return;

    const handler = (update: Uint8Array, origin: unknown) => {
      if (origin === "remote") return;
      const state = serverStateRef.current;
      if (state.revision !== null && state.activeAppId !== appId) return;
      if (!canWrite()) {
        unsentAppsRef.current.add(appId);
        return;
      }
      const run = syncRunRef.current;
      if (run?.catchesUp && run.appId === appId) {
        resendRef.current.set(appId, [...(resendRef.current.get(appId) ?? []), update]);
        return;
      }
      uploads.add(appId, replicaIdsRef.current.get(appId), update);
    };

    doc.on("update", handler);
    docHandlersRef.current.set(appId, handler);
    replicaIdsRef.current.set(appId, newReplicaId());
  }, [canWrite, uploads]);

  const detachDoc = useCallback((appId: string) => {
    const handler = docHandlersRef.current.get(appId);
    if (handler) docsRef.current.get(appId)?.off("update", handler);
    docHandlersRef.current.delete(appId);
    replicaIdsRef.current.delete(appId);
    uploads.drop(appId);
    resendRef.current.delete(appId);
  }, [uploads]);

  const queueInitialUpdate = useCallback((appId: string, doc: Y.Doc) => {
    if (initialUpdateSentRef.current.has(appId)) return;
    const state = serverStateRef.current;
    if (state.revision !== null && state.activeAppId !== appId) return;

    const update = Y.encodeStateAsUpdate(doc);
    if (isEmptyUpdate(update)) return;
    if (!canWrite()) {
      unsentAppsRef.current.add(appId);
      return;
    }

    uploads.add(appId, replicaIdsRef.current.get(appId), update);
    initialUpdateSentRef.current.add(appId);
  }, [canWrite, uploads]);

  const registerAwarenessHandlers = useCallback((appId: string, awareness: Awareness) => {
    if (awarenessHandlersRef.current.has(appId)) return;

    const handler = ({ added, updated, removed }: AwarenessUpdateEvent, origin: unknown) => {
      if (origin === "remote") return;
      if (isReadOnlyRef.current) return;

      const currentSocket = socketRef.current;
      if (!currentSocket || !currentSocket.connected) return;

      // Only this client's own entry: a peer's cursor that times out here is
      // timed out by every client on its own.
      const changed = added
        .concat(updated, removed)
        .filter((clientId) => clientId === awareness.clientID);
      if (changed.length === 0) return;

      const update = encodeAwarenessUpdate(awareness, changed);
      const payload: AppsAwarenessPayload = {
        appId,
        awarenessUpdate: update,
        clientId: awareness.clientID,
      };
      currentSocket.emit("apps:awareness", payload);
    };

    awareness.on("update", handler);
    awarenessHandlersRef.current.set(appId, handler);
  }, []);

  const getDoc = useCallback(
    (appId: string): Y.Doc => {
      const existing = docsRef.current.get(appId);
      if (existing) return existing;

      const app = apps.find((candidate) => candidate.id === appId);
      const doc = app?.createDoc ? app.createDoc() : new Y.Doc();
      docsRef.current.set(appId, doc);
      registerDocHandlers(appId, doc);
      queueInitialUpdate(appId, doc);
      return doc;
    },
    [apps, registerDocHandlers, queueInitialUpdate]
  );

  const runAutomaticWrites = useCallback(
    (appId: string) => {
      const writes = automaticWritesRef.current.get(appId);
      if (!writes || !canWrite()) return;
      if (!syncedAppsRef.current.has(appId)) return;
      const doc = docsRef.current.get(appId);
      const replicaId = replicaIdsRef.current.get(appId);
      if (!doc || !replicaId) return;
      const committed = Y.snapshot(doc);
      for (const entry of writes.values()) {
        if (entry.state === "unconfirmed") {
          const saved = entry.update !== null && Y.snapshotContainsUpdate(committed, entry.update);
          const exhausted = entry.finalIfLost || entry.attempts >= MAX_AUTOMATIC_WRITE_ATTEMPTS;
          entry.state = saved || exhausted ? "done" : "waiting";
        }
        if (entry.state !== "waiting") continue;
        entry.attempts += 1;
        entry.writtenOn = replicaId;
        entry.update = writeAtomically(doc, entry.write);
        entry.state = entry.update ? "written" : "done";
      }
    },
    [canWrite]
  );

  const settleAutomaticWrites = useCallback(
    (appId: string, replicaId: string | undefined, refusal: { reason: string } | null) => {
      const writes = automaticWritesRef.current.get(appId);
      if (!writes || !replicaId) return;
      for (const entry of writes.values()) {
        if (entry.state !== "written" || entry.writtenOn !== replicaId) continue;
        entry.state = "unconfirmed";
        entry.finalIfLost = refusal !== null && FINAL_REFUSALS.has(refusal.reason);
      }
    },
    []
  );

  const writeOnce = useCallback(
    (appId: string, key: string, write: (doc: Y.Doc) => void) => {
      const writes = automaticWritesRef.current.get(appId) ?? new Map<string, AutomaticWrite>();
      automaticWritesRef.current.set(appId, writes);
      if (writes.has(key)) return;
      writes.set(key, { write, state: "waiting", writtenOn: null, update: null, attempts: 0, finalIfLost: false });
      runAutomaticWrites(appId);
    },
    [runAutomaticWrites]
  );

  const adoptReplacement = useCallback(
    (appId: string, doc: Y.Doc): number | null => {
      const replacedClient = docsRef.current.get(appId)?.clientID ?? null;
      discardLocalApp(appId);
      docsRef.current.set(appId, doc);
      initialUpdateSentRef.current.add(appId);
      registerDocHandlers(appId, doc);
      setIsRebuilding(false);
      return replacedClient;
    },
    [discardLocalApp, registerDocHandlers]
  );

  const getAwareness = useCallback(
    (appId: string): Awareness => {
      const existing = awarenessRef.current.get(appId);
      if (existing) return existing;

      const doc = getDoc(appId);
      const awareness = createAwareness(doc);
      awarenessRef.current.set(appId, awareness);
      registerAwarenessHandlers(appId, awareness);
      return awareness;
    },
    [getDoc, registerAwarenessHandlers]
  );

  const applySync = useCallback(
    (run: SyncRun, response: AppsSyncResponse): boolean => {
      const update = toUint8Array(response.syncMessage);
      if (!update) return false;
      stagesPartsRef.current = response.stagesParts === true;
      takesListsRef.current = response.takesUpdateLists === true;
      try {
        Y.applyUpdate(run.doc, update, "remote");
      } catch (err) {
        console.warn("[Apps] Failed to apply sync update", err);
        return false;
      }
      const replacedClient = run.replaces ? adoptReplacement(run.appId, run.doc) : null;

      if (response.awarenessUpdate) {
        const awarenessUpdate = toUint8Array(response.awarenessUpdate);
        if (awarenessUpdate && awarenessUpdate.length > 0) {
          try {
            const awareness = getAwareness(run.appId);
            applyAwarenessUpdate(awareness, awarenessUpdate, "remote");
            if (replacedClient !== null && replacedClient !== awareness.clientID) {
              removeAwarenessStates(awareness, [replacedClient], "remote");
            }
          } catch (err) {
            console.warn("[Apps] Failed to apply awareness update", err);
          }
        }
      }

      const serverVector = response.stateVector ? toUint8Array(response.stateVector) : null;
      if (!run.replaces && serverVector) {
        try {
          const lacking = Y.encodeStateAsUpdate(run.doc, serverVector);
          const serverState = Y.createSnapshot(Y.decodeUpdate(update).ds, Y.decodeStateVector(serverVector));
          const serverLacksSome = !Y.snapshotContainsUpdate(serverState, lacking);
          const pending = [...(resendRef.current.get(run.appId) ?? []), ...uploads.take(run.appId)];
          resendRef.current.delete(run.appId);
          if (serverLacksSome && !canWrite()) {
            unsentAppsRef.current.add(run.appId);
          } else if (serverLacksSome) {
            const replicaId = replicaIdsRef.current.get(run.appId);
            for (const change of changesToResend(serverState, pending, lacking)) uploads.add(run.appId, replicaId, change);
          }
          unverifiedUploadsRef.current.delete(run.appId);
        } catch (err) {
          console.warn("[Apps] Failed to read the server state vector", err);
        }
      }
      syncedAppsRef.current.add(run.appId);
      setIsRebuilding(false);
      uploads.wake();
      runAutomaticWrites(run.appId);
      pendingStageRef.current?.advance();
      return true;
    },
    [adoptReplacement, getAwareness, canWrite, runAutomaticWrites, uploads]
  );

  const attemptSync = useCallback(
    (run: SyncRun) => {
      if (syncRunRef.current !== run) return;

      const fail = () => {
        stopSync();
        setSyncStatus("failed");
        pendingStageRef.current?.cancel();
      };
      const retryLater = (afterMs: number) => {
        const backoff = SYNC_RETRY_DELAYS_MS[Math.min(run.attempt, SYNC_RETRY_DELAYS_MS.length - 1)];
        const delay = Math.max(backoff, afterMs);
        if (Date.now() - run.startedAt + delay > SYNC_GIVE_UP_MS) {
          fail();
          return;
        }
        run.attempt += 1;
        run.timer = setTimeout(() => attemptSync(run), delay);
      };

      const currentSocket = socketRef.current;
      if (!currentSocket?.connected) {
        retryLater(0);
        return;
      }

      const payload: AppsSyncPayload = {
        appId: run.appId,
        syncMessage: Y.encodeStateVector(run.doc),
        canRetry: true,
        wholeChanges: true,
        ...(run.appId === "wheel" ? { wheelFormat: 2 } : {}),
      };
      let answered = false;
      const answer = (response?: AppsSyncResponse | AppsSyncError) => {
        if (answered || disposedRef.current) return;
        answered = true;
        clearTimeout(run.timer);
        if (syncRunRef.current !== run) return;

        const reply = classifySyncReply(response);
        if (reply.kind === "synced") {
          if (run.appId === "wheel" && reply.response.wheelFormat !== 2) {
            fail();
            return;
          }
          syncRunRef.current = null;
          const synced = applySync(run, reply.response);
          if (!synced) pendingStageRef.current?.cancel();
          if (!synced && run.replaces) run.doc.destroy();
          setSyncStatus(synced ? "synced" : "failed");
        } else if (reply.kind === "retry") {
          retryLater(reply.afterMs);
        } else {
          fail();
        }
      };

      const remaining = SYNC_GIVE_UP_MS - (Date.now() - run.startedAt);
      run.timer = setTimeout(() => answer(), Math.max(0, Math.min(ACK_TIMEOUT_MS, remaining)));
      currentSocket.emit("apps:yjs:sync", payload, answer);
    },
    [applySync, stopSync]
  );

  const startSync = useCallback(
    (appId: string, catchesUp = false) => {
      if (disposedRef.current) return;
      stopSync();
      const replaces = staleAppsRef.current.has(appId);
      const doc = replaces ? new Y.Doc() : getDoc(appId);
      if (!replaces) getAwareness(appId);
      const run: SyncRun = { appId, doc, replaces, catchesUp: catchesUp && !replaces, startedAt: Date.now(), attempt: 0 };
      if (!syncedAppsRef.current.has(appId)) setIsRebuilding(true);
      syncRunRef.current = run;
      setSyncStatus("syncing");
      attemptSync(run);
    },
    [stopSync, getDoc, getAwareness, attemptSync]
  );

  const rebuildApp = useCallback(
    (appId: string, refusal: { reason: string } | null) => {
      pendingStageRef.current?.cancel();
      settleAutomaticWrites(appId, replicaIdsRef.current.get(appId), refusal);
      detachDoc(appId);
      staleAppsRef.current.add(appId);
      unsentAppsRef.current.delete(appId);
      setIsRebuilding(true);
      if (refusal) setRejectedChange({ at: Date.now(), reason: refusal.reason });
      startSync(appId);
    },
    [settleAutomaticWrites, detachDoc, startSync]
  );

  const catchUp = useCallback(
    (appId: string, refusedReplica: string) => {
      const replicaId = newReplicaId();
      replicaIdsRef.current.set(appId, replicaId);
      for (const entry of automaticWritesRef.current.get(appId)?.values() ?? []) {
        if (entry.state === "written" && entry.writtenOn === refusedReplica) entry.writtenOn = replicaId;
      }
      resendRef.current.set(appId, [...(resendRef.current.get(appId) ?? []), ...uploads.take(appId)]);
      startSync(appId, true);
    },
    [startSync, uploads]
  );

  const recoverFromRefusal = useCallback(
    (appId: string, replicaId: string, reason: string) => {
      const now = Date.now();
      const recent = (catchUpsRef.current.get(appId) ?? []).filter((at) => now - at < CATCH_UP_WINDOW_MS);
      if (FINAL_REFUSALS.has(reason) || recent.length >= MAX_CATCH_UPS) {
        catchUpsRef.current.set(appId, recent);
        rebuildApp(appId, { reason });
        return;
      }
      catchUpsRef.current.set(appId, [...recent, now]);
      catchUp(appId, replicaId);
    },
    [rebuildApp, catchUp]
  );

  const resumeWrites = useCallback(() => {
    if (!canWrite()) return;
    const appId = serverStateRef.current.activeAppId;
    const changedWhileBlocked = appId !== null && unsentAppsRef.current.has(appId);
    unsentAppsRef.current.clear();
    if (changedWhileBlocked) rebuildApp(appId, null);
    else if (appId !== null) runAutomaticWrites(appId);
  }, [canWrite, rebuildApp, runAutomaticWrites]);

  const retrySync = useCallback(() => {
    const appId = serverStateRef.current.activeAppId;
    if (appId) startSync(appId);
  }, [startSync]);

  const applyServerAppsState = useCallback(
    (next: AppsState) => {
      if (next.notInRoom) {
        pendingStageRef.current?.cancel();
        return;
      }
      const reconnected = reconnectedRef.current;
      reconnectedRef.current = false;
      const previous = serverStateRef.current;
      const roomChanged = previous.roomId !== next.roomId;
      if (!reconnected && !roomChanged && previous.revision !== null && next.revision !== null && next.revision < previous.revision) return;
      serverStateRef.current = next;
      const changed = roomChanged || previous.activeAppId !== next.activeAppId || previous.docGeneration !== next.docGeneration;
      if (changed || previous.revision !== next.revision) pendingStageRef.current?.cancel();
      lockedRef.current = next.locked;
      if (changed) {
        stopSync();
        setRejectedChange(null);
        setIsRebuilding(false);
        for (const appId of docsRef.current.keys()) discardLocalApp(appId);
        automaticWritesRef.current.clear();
        catchUpsRef.current.clear();
        stagesPartsRef.current = null;
        takesListsRef.current = false;
        if (next.activeAppId) startSync(next.activeAppId);
        else setSyncStatus("idle");
      } else {
        resumeWrites();
        const appId = previous.activeAppId;
        const replicaId = appId ? replicaIdsRef.current.get(appId) : undefined;
        if (reconnected && appId && replicaId && syncedAppsRef.current.has(appId)) catchUp(appId, replicaId);
      }
      setState(next);
    },
    [discardLocalApp, startSync, stopSync, resumeWrites, catchUp],
  );

  const refreshState = useCallback(() => {
    const currentSocket = socketRef.current;
    if (!currentSocket) return;

    const requestedFrom = serverStateRef.current;
    currentSocket.emit("apps:getState", (response?: unknown) => {
      if (socketRef.current !== currentSocket || serverStateRef.current !== requestedFrom) return;
      const next = parseAppsState(response);
      if (next) {
        applyServerAppsState(next);
      }
    });
  }, [applyServerAppsState]);

  useEffect(() => {
    if (!socket) return;

    const handleState = (payload: unknown) => {
      const next = parseAppsState(payload);
      if (next) applyServerAppsState(next);
    };

    const handleUpdate = (payload: { appId: string; update: Uint8Array }) => {
      if (payload.appId !== serverStateRef.current.activeAppId) return;
      const doc = getDoc(payload.appId);
      const update = toUint8Array(payload.update);
      if (!update || update.length === 0) return;

      const run = syncRunRef.current;
      const hydrating = run?.replaces && run.appId === payload.appId ? run.doc : null;
      for (const target of hydrating ? [doc, hydrating] : [doc]) {
        try {
          Y.applyUpdate(target, update, "remote");
        } catch (err) {
          console.warn("[Apps] Failed to apply update", err);
        }
      }
    };

    const handleAwareness = (payload: AppsAwarenessPayload) => {
      if (payload.appId !== serverStateRef.current.activeAppId) return;
      const awareness = getAwareness(payload.appId);
      const awarenessUpdate = toUint8Array(payload.awarenessUpdate);
      if (!awarenessUpdate || awarenessUpdate.length === 0) return;

      try {
        applyAwarenessUpdate(awareness, awarenessUpdate, "remote");
      } catch (err) {
        console.warn("[Apps] Failed to apply awareness update", err);
      }
    };

    const handleRefused = (payload: AppsRefusedPayload) => {
      const appId = payload?.appId;
      if (!appId || appId !== serverStateRef.current.activeAppId) return;
      const replicaId = replicaIdsRef.current.get(appId);
      if (!replicaId || replicaId !== payload.replicaId) return;
      recoverFromRefusal(appId, replicaId, typeof payload.reason === "string" ? payload.reason : "refused");
    };

    let interrupted = false;
    const handleDisconnect = () => {
      pendingStageRef.current?.cancel();
      interrupted = true;
    };
    const handleConnect = () => {
      if (interrupted) {
        interrupted = false;
        reconnectedRef.current = true;
      }
      uploads.wake();
    };

    socket.on("disconnect", handleDisconnect);
    socket.on("connect", handleConnect);
    socket.on("apps:state", handleState);
    socket.on("apps:yjs:update", handleUpdate);
    socket.on("apps:awareness", handleAwareness);
    socket.on("apps:yjs:refused", handleRefused);

    refreshState();

    return () => {
      socket.off("apps:state", handleState);
      socket.off("apps:yjs:update", handleUpdate);
      socket.off("apps:awareness", handleAwareness);
      socket.off("apps:yjs:refused", handleRefused);
      socket.off("disconnect", handleDisconnect);
      socket.off("connect", handleConnect);
    };
  }, [socket, getDoc, getAwareness, refreshState, applyServerAppsState, recoverFromRefusal, uploads]);

  useEffect(() => {
    resumeWrites();
  }, [isAdmin, isReadOnly, resumeWrites]);


  const sendStageCommand = useCallback(
    (event: string, payload: object | null): Promise<AppsCommandResult> => {
      const currentSocket = socketRef.current;
      if (!currentSocket || isReadOnlyRef.current) return Promise.resolve(COMMAND_FAILED);

      return new Promise<AppsCommandResult>((resolve) => {
        let completed = false;
        const timer = setTimeout(() => {
          if (completed) return;
          completed = true;
          resolve(COMMAND_FAILED);
        }, ACK_TIMEOUT_MS);
        const ack = (response?: StageCommandResponse) => {
          if (completed) return;
          completed = true;
          clearTimeout(timer);
          resolve(commandResult(response));
        };
        if (payload) {
          currentSocket.emit(event, payload, ack);
        } else {
          currentSocket.emit(event, ack);
        }
      });
    },
    [],
  );

  const leaveStage = useCallback(
    (event: "apps:open" | "apps:close", payload: AppsOpenPayload | AppsClosePayload | null) => {
      const socket = socketRef.current;
      if (!socket?.connected || isReadOnlyRef.current || reconnectedRef.current || pendingStageRef.current) {
        return Promise.resolve(COMMAND_FAILED);
      }
      const stage = serverStateRef.current;
      const appId = stage.activeAppId;
      if (stage.revision === null || !appId || (payload && "appId" in payload && payload.appId === appId)) {
        return sendStageCommand(event, payload);
      }

      const waitingForEdits = () =>
        uploads.hasPending(appId) || Boolean(resendRef.current.get(appId)?.length) || unsentAppsRef.current.has(appId);
      if (!waitingForEdits() && !unverifiedUploadsRef.current.has(appId)) return sendStageCommand(event, payload);

      return new Promise<AppsCommandResult>((resolve) => {
        let verificationStarted = false;
        const finish = (send?: () => Promise<AppsCommandResult>) => {
          if (pendingStageRef.current !== command) return;
          clearTimeout(timer);
          pendingStageRef.current = null;
          resolve(send ? send() : COMMAND_FAILED);
        };
        const command: PendingStageCommand = {
          cancel: () => finish(),
          advance: () => {
            const current = serverStateRef.current;
            if (disposedRef.current || socketRef.current !== socket || !socket.connected ||
                current.roomId !== stage.roomId || current.revision !== stage.revision ||
                current.activeAppId !== appId || current.docGeneration !== stage.docGeneration) {
              command.cancel();
              return;
            }
            if (waitingForEdits()) return;
            if (unverifiedUploadsRef.current.has(appId)) {
              if (syncRunRef.current) return;
              // An empty upload ack only ends the transport request. Check the room copy.
              if (verificationStarted) command.cancel();
              else {
                verificationStarted = true;
                startSync(appId, true);
              }
              return;
            }
            finish(() => sendStageCommand(event, payload));
          },
        };
        const timer = setTimeout(command.cancel, ACK_TIMEOUT_MS);
        pendingStageRef.current = command;
        command.advance();
      });
    },
    [sendStageCommand, startSync, uploads],
  );

  const presentApp = useCallback(
    (appId: string) => {
      if (!apps.some((app) => app.id === appId)) {
        console.warn(`[Apps] Attempted to present unregistered app: ${appId}`);
        return Promise.resolve(COMMAND_FAILED);
      }
      const { revision, roomId } = serverStateRef.current;
      const payload: AppsOpenPayload =
        revision === null ? { appId } : { appId, expectedRevision: revision, expectedRoomId: roomId };
      return leaveStage("apps:open", payload);
    },
    [apps, leaveStage],
  );

  // An older SFU's apps:close takes only the ack.
  const closeApp = useCallback(() => {
    const { revision, roomId } = serverStateRef.current;
    const payload: AppsClosePayload | null =
      revision === null ? null : { expectedRevision: revision, expectedRoomId: roomId };
    return leaveStage("apps:close", payload);
  }, [leaveStage]);

  const clearApp = useCallback(
    (appId: string) => {
      const { revision } = serverStateRef.current;
      if (revision === null) return Promise.resolve(COMMAND_FAILED);
      pendingStageRef.current?.cancel();
      const payload: AppsDiscardPayload = { appId, expectedRevision: revision };
      return sendStageCommand("apps:discard", payload);
    },
    [sendStageCommand],
  );

  const setLocked = useCallback(
    (locked: boolean) => {
      const { revision } = serverStateRef.current;
      const payload: AppsLockPayload =
        revision === null ? { locked } : { locked, expectedRevision: revision };
      return sendStageCommand("apps:lock", payload);
    },
    [sendStageCommand],
  );

  const documents = useMemo<AppDocuments>(
    () => ({ version: docsVersion, doc: getDoc, awareness: getAwareness, writeOnce }),
    [docsVersion, getDoc, getAwareness, writeOnce]
  );

  const presentedDocKey = state.activeAppId === null ? null : `${state.activeAppId}:${docsVersion}`;

  const contextValue = useMemo<AppsContextValue>(
    () => ({
      state,
      apps,
      presentApp,
      closeApp,
      clearApp,
      setLocked,
      refreshState,
      getDoc,
      getAwareness,
      syncStatus,
      retrySync,
      documents,
      presentedDocKey,
      rejectedChange,
      rejectedChangeAt: rejectedChange?.at ?? null,
      rejectedChangeReason: rejectedChange?.reason ?? null,
      isRebuilding,
      user,
      participants: roster,
      isAdmin,
      isReadOnly,
    }),
    [
      state,
      apps,
      presentApp,
      closeApp,
      clearApp,
      setLocked,
      refreshState,
      getDoc,
      getAwareness,
      syncStatus,
      retrySync,
      documents,
      presentedDocKey,
      rejectedChange,
      isRebuilding,
      user,
      roster,
      isAdmin,
      isReadOnly,
    ]
  );

  return <AppsContext.Provider value={contextValue}>{children}</AppsContext.Provider>;
}
