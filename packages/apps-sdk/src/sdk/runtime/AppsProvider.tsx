import React, { createContext, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Socket } from "socket.io-client";
import * as Y from "yjs";
import { Awareness, applyAwarenessUpdate, encodeAwarenessUpdate } from "y-protocols/awareness";
import type {
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
  AppsState,
  AppsSyncError,
  AppSyncStatus,
  AppsSyncPayload,
  AppsSyncResponse,
  AppsUpdatePayload,
  AppUser,
} from "../types/index";
import { classifySyncReply } from "./syncReply";

export const AppsContext = createContext<AppsContextValue | null>(null);

// Names a local copy of an app's document by how many copies of that app the
// provider has dropped before it, so every new copy gets a new name.
const localCopyKey = (appId: string, dropped: Readonly<Record<string, number>>): string =>
  `${appId}:${dropped[appId] ?? 0}`;

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

// A refused or unanswered sync is retried after these delays, the last one
// repeating, until about 30 s have passed; then the app shows a retry.
const SYNC_RETRY_DELAYS_MS = [250, 500, 1_000, 2_000, 4_000];
const SYNC_GIVE_UP_MS = 30_000;

// One sync of one app's local document. A reply acts only on its own run, so
// a reply that arrives after the stage moved on does nothing.
type SyncRun = {
  appId: string;
  doc: Y.Doc;
  startedAt: number;
  attempt: number;
  timer?: ReturnType<typeof setTimeout>;
};

const createAwareness = (doc: Y.Doc) => new Awareness(doc);

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

  useEffect(() => {
    const next = participants ?? [];
    setRoster((previous) =>
      rosterSignature(previous) === rosterSignature(next) ? previous : next
    );
  }, [participants]);

  const docsRef = useRef<Map<string, Y.Doc>>(new Map());
  const awarenessRef = useRef<Map<string, Awareness>>(new Map());
  const pendingInitialUpdatesRef = useRef<Map<string, Uint8Array>>(new Map());
  const initialUpdateSentRef = useRef<Set<string>>(new Set());
  const docHandlersRef = useRef<Map<string, (update: Uint8Array, origin: unknown) => void>>(
    new Map()
  );
  const awarenessHandlersRef = useRef<
    Map<string, (event: AwarenessUpdateEvent, origin: unknown) => void>
  >(new Map());
  const socketRef = useRef<Socket | null>(null);
  const isReadOnlyRef = useRef(isReadOnly);

  useEffect(() => {
    isReadOnlyRef.current = isReadOnly;
  }, [isReadOnly]);

  const serverStateRef = useRef<AppsState>(EMPTY_APPS_STATE);

  const [droppedCopies, setDroppedCopies] = useState<Readonly<Record<string, number>>>({});
  const droppedCopiesRef = useRef<Readonly<Record<string, number>>>({});
  const [syncStatus, setSyncStatus] = useState<AppSyncStatus>("idle");
  const syncRunRef = useRef<SyncRun | null>(null);
  const disposedRef = useRef(false);

  const stopSync = useCallback(() => {
    clearTimeout(syncRunRef.current?.timer);
    syncRunRef.current = null;
  }, []);

  const noteDropped = useCallback((appIds: string[]) => {
    if (appIds.length === 0) return;
    const next = { ...droppedCopiesRef.current };
    for (const appId of appIds) next[appId] = (next[appId] ?? 0) + 1;
    droppedCopiesRef.current = next;
    setDroppedCopies(next);
  }, []);

  const resetLocalData = useCallback(() => {
    stopSync();
    setSyncStatus("idle");
    noteDropped(Array.from(docsRef.current.keys()));
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
    pendingInitialUpdatesRef.current.clear();
    initialUpdateSentRef.current.clear();
    serverStateRef.current = EMPTY_APPS_STATE;
    setState(EMPTY_APPS_STATE);
  }, [noteDropped, stopSync]);

  useEffect(() => {
    if (socketRef.current !== socket) {
      resetLocalData();
    }
    socketRef.current = socket;
  }, [socket, resetLocalData]);

  const discardLocalApp = useCallback((appId: string) => {
    const doc = docsRef.current.get(appId);
    if (doc) {
      noteDropped([appId]);
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
    pendingInitialUpdatesRef.current.delete(appId);
    initialUpdateSentRef.current.delete(appId);
  }, [noteDropped]);

  const registerDocHandlers = useCallback((appId: string, doc: Y.Doc) => {
    if (docHandlersRef.current.has(appId)) return;

    const handler = (update: Uint8Array, origin: unknown) => {
      if (origin === "remote") return;
      if (isReadOnlyRef.current) return;
      const currentSocket = socketRef.current;
      if (!currentSocket) return;
      const payload: AppsUpdatePayload = { appId, update };
      currentSocket.emit("apps:yjs:update", payload);
    };

    doc.on("update", handler);
    docHandlersRef.current.set(appId, handler);
  }, []);

  const queueInitialUpdate = useCallback((appId: string, doc: Y.Doc) => {
    if (initialUpdateSentRef.current.has(appId)) return;
    if (isReadOnlyRef.current) return;
    if (doc.store.clients.size === 0) return;

    const update = Y.encodeStateAsUpdate(doc);

    const currentSocket = socketRef.current;
    if (currentSocket && currentSocket.connected) {
      currentSocket.emit("apps:yjs:update", { appId, update });
      initialUpdateSentRef.current.add(appId);
      pendingInitialUpdatesRef.current.delete(appId);
      return;
    }

    pendingInitialUpdatesRef.current.set(appId, update);
  }, []);

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
    (run: SyncRun, response: AppsSyncResponse, currentSocket: Socket): boolean => {
      const update = toUint8Array(response.syncMessage);
      if (!update) return false;
      try {
        Y.applyUpdate(run.doc, update, "remote");
      } catch (err) {
        console.warn("[Apps] Failed to apply sync update", err);
        return false;
      }

      if (response.awarenessUpdate) {
        const awarenessUpdate = toUint8Array(response.awarenessUpdate);
        if (awarenessUpdate && awarenessUpdate.length > 0) {
          try {
            applyAwarenessUpdate(getAwareness(run.appId), awarenessUpdate, "remote");
          } catch (err) {
            console.warn("[Apps] Failed to apply awareness update", err);
          }
        }
      }

      const serverVector = response.stateVector ? toUint8Array(response.stateVector) : null;
      if (serverVector && !isReadOnlyRef.current) {
        try {
          const updateForServer = Y.encodeStateAsUpdate(run.doc, serverVector);
          if (updateForServer.length > 0) {
            currentSocket.emit("apps:yjs:update", { appId: run.appId, update: updateForServer });
          }
        } catch (err) {
          console.warn("[Apps] Failed to read the server state vector", err);
        }
      }
      return true;
    },
    [getAwareness]
  );

  const attemptSync = useCallback(
    (run: SyncRun) => {
      if (syncRunRef.current !== run) return;

      const fail = () => {
        syncRunRef.current = null;
        setSyncStatus("failed");
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

      const payload: AppsSyncPayload = { appId: run.appId, syncMessage: Y.encodeStateVector(run.doc) };
      let answered = false;
      const answer = (response?: AppsSyncResponse | AppsSyncError) => {
        if (answered) return;
        answered = true;
        clearTimeout(run.timer);
        if (syncRunRef.current !== run) return;

        const reply = classifySyncReply(response);
        if (reply.kind === "synced") {
          syncRunRef.current = null;
          setSyncStatus(applySync(run, reply.response, currentSocket) ? "synced" : "failed");
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
    [applySync]
  );

  const startSync = useCallback(
    (appId: string) => {
      if (disposedRef.current) return;
      stopSync();
      const doc = getDoc(appId);
      getAwareness(appId);
      const run: SyncRun = { appId, doc, startedAt: Date.now(), attempt: 0 };
      syncRunRef.current = run;
      setSyncStatus("syncing");
      attemptSync(run);
    },
    [stopSync, getDoc, getAwareness, attemptSync]
  );

  const retrySync = useCallback(() => {
    const appId = serverStateRef.current.activeAppId;
    if (appId) startSync(appId);
  }, [startSync]);

  // Only the presented app is live, and only from the moment it was
  // presented. Every other local copy is dropped, and an app entering the
  // stage, or starting over on a new document, starts from the room's copy,
  // so a document a host cleared never comes back from a client's memory.
  // Its sync starts in the same update, so the app never sees a new copy
  // marked as synced.
  const applyServerAppsState = useCallback(
    (next: AppsState) => {
      const previous = serverStateRef.current;
      const stageChanged =
        previous.activeAppId !== next.activeAppId ||
        previous.docGeneration !== next.docGeneration;
      serverStateRef.current = next;
      if (stageChanged) stopSync();
      for (const appId of Array.from(docsRef.current.keys())) {
        if (stageChanged || appId !== next.activeAppId) discardLocalApp(appId);
      }
      if (stageChanged) {
        if (next.activeAppId) startSync(next.activeAppId);
        else setSyncStatus("idle");
      }
      setState(next);
    },
    [discardLocalApp, startSync, stopSync],
  );

  const refreshState = useCallback(() => {
    const currentSocket = socketRef.current;
    if (!currentSocket) return;

    currentSocket.emit("apps:getState", (response?: unknown) => {
      if (socketRef.current !== currentSocket) return;
      const next = parseAppsState(response);
      if (next) {
        applyServerAppsState(next);
      }
    });
  }, [applyServerAppsState]);

  useEffect(() => {
    disposedRef.current = false;
    return () => {
      disposedRef.current = true;
      stopSync();
    };
  }, [stopSync]);

  useEffect(() => {
    if (!socket) return;

    const handleState = (payload: unknown) => {
      const next = parseAppsState(payload);
      if (next) applyServerAppsState(next);
    };

    const handleUpdate = (payload: AppsUpdatePayload) => {
      const doc = getDoc(payload.appId);
      const update = toUint8Array(payload.update);
      if (!update || update.length === 0) return;

      try {
        Y.applyUpdate(doc, update, "remote");
      } catch (err) {
        console.warn("[Apps] Failed to apply update", err);
      }
    };

    const handleAwareness = (payload: AppsAwarenessPayload) => {
      const awareness = getAwareness(payload.appId);
      const awarenessUpdate = toUint8Array(payload.awarenessUpdate);
      if (!awarenessUpdate || awarenessUpdate.length === 0) return;

      try {
        applyAwarenessUpdate(awareness, awarenessUpdate, "remote");
      } catch (err) {
        console.warn("[Apps] Failed to apply awareness update", err);
      }
    };

    socket.on("apps:state", handleState);
    socket.on("apps:yjs:update", handleUpdate);
    socket.on("apps:awareness", handleAwareness);

    refreshState();

    return () => {
      socket.off("apps:state", handleState);
      socket.off("apps:yjs:update", handleUpdate);
      socket.off("apps:awareness", handleAwareness);
    };
  }, [socket, getDoc, getAwareness, refreshState, applyServerAppsState]);

  useEffect(() => {
    if (!socket) return;

    const flushPending = () => {
      if (isReadOnlyRef.current) return;
      const pending = pendingInitialUpdatesRef.current;
      if (pending.size === 0) return;

      for (const [appId, update] of pending.entries()) {
        socket.emit("apps:yjs:update", { appId, update });
        initialUpdateSentRef.current.add(appId);
        pending.delete(appId);
      }
    };

    flushPending();
    socket.on("connect", flushPending);
    return () => {
      socket.off("connect", flushPending);
    };
  }, [socket]);

  const presentedDocKey =
    state.activeAppId === null ? null : localCopyKey(state.activeAppId, droppedCopies);

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

  const presentApp = useCallback(
    (appId: string) => {
      if (!apps.some((app) => app.id === appId)) {
        console.warn(`[Apps] Attempted to present unregistered app: ${appId}`);
        return Promise.resolve(COMMAND_FAILED);
      }
      const { revision } = serverStateRef.current;
      const payload: AppsOpenPayload =
        revision === null ? { appId } : { appId, expectedRevision: revision };
      return sendStageCommand("apps:open", payload);
    },
    [apps, sendStageCommand],
  );

  // An older SFU's apps:close takes only the ack.
  const closeApp = useCallback(() => {
    const { revision } = serverStateRef.current;
    const payload: AppsClosePayload | null =
      revision === null ? null : { expectedRevision: revision };
    return sendStageCommand("apps:close", payload);
  }, [sendStageCommand]);

  const clearApp = useCallback(
    (appId: string) => {
      const { revision } = serverStateRef.current;
      if (revision === null) return Promise.resolve(COMMAND_FAILED);
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
      presentedDocKey,
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
      presentedDocKey,
      user,
      roster,
      isAdmin,
      isReadOnly,
    ]
  );

  return <AppsContext.Provider value={contextValue}>{children}</AppsContext.Provider>;
}
