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
  AppsCloseResponse,
  AppsContextValue,
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

type SyncRun = {
  appId: string;
  doc: Y.Doc;
  replaces: boolean;
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

const isAppsState = (value: unknown): value is AppsState => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as { activeAppId?: unknown; locked?: unknown };
  const activeAppIdValid =
    typeof record.activeAppId === "string" || record.activeAppId === null;
  return activeAppIdValid && typeof record.locked === "boolean";
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
  const [state, setState] = useState<AppsState>({ activeAppId: null, locked: false });
  const [roster, setRoster] = useState<AppUser[]>(() => participants ?? []);
  const [syncStatus, setSyncStatus] = useState<AppSyncStatus>("idle");
  const [docsVersion, setDocsVersion] = useState(0);
  const [rejectedChangeAt, setRejectedChangeAt] = useState<number | null>(null);
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
  const pendingInitialUpdatesRef = useRef<Map<string, Uint8Array>>(new Map());
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
  const socketRef = useRef<Socket | null>(null);
  const isReadOnlyRef = useRef(isReadOnly);
  const isAdminRef = useRef(Boolean(isAdmin));
  const lockedRef = useRef(false);

  useEffect(() => {
    isReadOnlyRef.current = isReadOnly;
  }, [isReadOnly]);

  useEffect(() => {
    isAdminRef.current = Boolean(isAdmin);
  }, [isAdmin]);

  const serverActiveAppIdRef = useRef<string | null>(null);

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
    pendingInitialUpdatesRef.current.clear();
    initialUpdateSentRef.current.clear();
    replicaIdsRef.current.clear();
    staleAppsRef.current.clear();
    unsentAppsRef.current.clear();
    serverActiveAppIdRef.current = null;
    lockedRef.current = false;
    setState({ activeAppId: null, locked: false });
    setRejectedChangeAt(null);
    setIsRebuilding(false);
    setDocsVersion((version) => version + 1);
  }, [stopSync]);

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
    pendingInitialUpdatesRef.current.delete(appId);
    initialUpdateSentRef.current.delete(appId);
    replicaIdsRef.current.delete(appId);
    staleAppsRef.current.delete(appId);
    unsentAppsRef.current.delete(appId);
    setDocsVersion((version) => version + 1);
  }, []);

  const registerDocHandlers = useCallback((appId: string, doc: Y.Doc) => {
    if (docHandlersRef.current.has(appId)) return;

    const replicaId = newReplicaId();
    const handler = (update: Uint8Array, origin: unknown) => {
      if (origin === "remote") return;
      if (!canWrite()) {
        unsentAppsRef.current.add(appId);
        return;
      }
      const currentSocket = socketRef.current;
      if (!currentSocket) return;
      const payload: AppsUpdatePayload = { appId, update, replicaId };
      currentSocket.emit("apps:yjs:update", payload);
    };

    doc.on("update", handler);
    docHandlersRef.current.set(appId, handler);
    replicaIdsRef.current.set(appId, replicaId);
  }, [canWrite]);

  const detachDoc = useCallback((appId: string) => {
    const handler = docHandlersRef.current.get(appId);
    if (handler) docsRef.current.get(appId)?.off("update", handler);
    docHandlersRef.current.delete(appId);
    replicaIdsRef.current.delete(appId);
    pendingInitialUpdatesRef.current.delete(appId);
  }, []);

  const queueInitialUpdate = useCallback((appId: string, doc: Y.Doc) => {
    if (initialUpdateSentRef.current.has(appId)) return;

    const update = Y.encodeStateAsUpdate(doc);
    if (isEmptyUpdate(update)) return;
    if (!canWrite()) {
      unsentAppsRef.current.add(appId);
      return;
    }

    const currentSocket = socketRef.current;
    if (currentSocket && currentSocket.connected) {
      const payload: AppsUpdatePayload = { appId, update, replicaId: replicaIdsRef.current.get(appId) };
      currentSocket.emit("apps:yjs:update", payload);
      initialUpdateSentRef.current.add(appId);
      pendingInitialUpdatesRef.current.delete(appId);
      return;
    }

    pendingInitialUpdatesRef.current.set(appId, update);
  }, [canWrite]);

  const registerAwarenessHandlers = useCallback((appId: string, awareness: Awareness) => {
    if (awarenessHandlersRef.current.has(appId)) return;

    const handler = ({ added, updated, removed }: AwarenessUpdateEvent, origin: unknown) => {
      if (origin === "remote") return;
      if (isReadOnlyRef.current) return;

      const currentSocket = socketRef.current;
      if (!currentSocket || !currentSocket.connected) return;

      const changed = added.concat(updated, removed);
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
    (run: SyncRun, response: AppsSyncResponse, currentSocket: Socket): boolean => {
      const update = toUint8Array(response.syncMessage);
      if (!update) return false;
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

      if (run.replaces) return true;
      const serverVector = response.stateVector ? toUint8Array(response.stateVector) : null;
      if (serverVector) {
        try {
          const updateForServer = Y.encodeStateAsUpdate(run.doc, serverVector);
          const serverState = Y.createSnapshot(Y.decodeUpdate(update).ds, Y.decodeStateVector(serverVector));
          if (Y.snapshotContainsUpdate(serverState, updateForServer)) return true;
          if (!canWrite()) {
            unsentAppsRef.current.add(run.appId);
          } else {
            const payload: AppsUpdatePayload = {
              appId: run.appId,
              update: updateForServer,
              replicaId: replicaIdsRef.current.get(run.appId),
            };
            currentSocket.emit("apps:yjs:update", payload);
          }
        } catch (err) {
          console.warn("[Apps] Failed to read the server state vector", err);
        }
      }
      return true;
    },
    [adoptReplacement, getAwareness, canWrite]
  );

  const attemptSync = useCallback(
    (run: SyncRun) => {
      if (syncRunRef.current !== run) return;

      const fail = () => {
        stopSync();
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

      const payload: AppsSyncPayload = { appId: run.appId, syncMessage: Y.encodeStateVector(run.doc), canRetry: true };
      let answered = false;
      const answer = (response?: AppsSyncResponse | AppsSyncError) => {
        if (answered || disposedRef.current) return;
        answered = true;
        clearTimeout(run.timer);
        if (syncRunRef.current !== run) return;

        const reply = classifySyncReply(response);
        if (reply.kind === "synced") {
          syncRunRef.current = null;
          const synced = applySync(run, reply.response, currentSocket);
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
    (appId: string) => {
      if (disposedRef.current) return;
      stopSync();
      const replaces = staleAppsRef.current.has(appId);
      const doc = replaces ? new Y.Doc() : getDoc(appId);
      if (!replaces) getAwareness(appId);
      const run: SyncRun = { appId, doc, replaces, startedAt: Date.now(), attempt: 0 };
      syncRunRef.current = run;
      setSyncStatus("syncing");
      attemptSync(run);
    },
    [stopSync, getDoc, getAwareness, attemptSync]
  );

  const rebuildApp = useCallback(
    (appId: string, { quietly = false }: { quietly?: boolean } = {}) => {
      detachDoc(appId);
      staleAppsRef.current.add(appId);
      unsentAppsRef.current.delete(appId);
      setIsRebuilding(true);
      if (!quietly) setRejectedChangeAt(Date.now());
      startSync(appId);
    },
    [detachDoc, startSync]
  );

  const resumeWrites = useCallback(() => {
    if (!canWrite()) return;
    const appId = serverActiveAppIdRef.current;
    const changedWhileBlocked = appId !== null && unsentAppsRef.current.has(appId);
    unsentAppsRef.current.clear();
    if (changedWhileBlocked) rebuildApp(appId, { quietly: true });
  }, [canWrite, rebuildApp]);

  const retrySync = useCallback(() => {
    const appId = serverActiveAppIdRef.current;
    if (appId) startSync(appId);
  }, [startSync]);

  const applyServerAppsState = useCallback(
    (next: AppsState) => {
      const previous = serverActiveAppIdRef.current;
      serverActiveAppIdRef.current = next.activeAppId;
      lockedRef.current = next.locked;
      if (previous !== next.activeAppId) {
        stopSync();
        setRejectedChangeAt(null);
        setIsRebuilding(false);
        if (previous) discardLocalApp(previous);
        if (next.activeAppId) startSync(next.activeAppId);
        else setSyncStatus("idle");
      } else {
        resumeWrites();
      }
      setState(next);
    },
    [discardLocalApp, startSync, stopSync, resumeWrites],
  );

  const refreshState = useCallback(() => {
    const currentSocket = socketRef.current;
    if (!currentSocket) return;

    currentSocket.emit("apps:getState", (response?: unknown) => {
      if (socketRef.current !== currentSocket) return;
      if (isAppsState(response)) {
        applyServerAppsState(response);
      }
    });
  }, [applyServerAppsState]);

  useEffect(() => {
    if (!socket) return;

    const handleState = (next: unknown) => {
      if (!isAppsState(next)) return;
      applyServerAppsState(next);
    };

    const handleUpdate = (payload: AppsUpdatePayload) => {
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
      if (!appId || appId !== serverActiveAppIdRef.current) return;
      const replicaId = replicaIdsRef.current.get(appId);
      if (!replicaId || replicaId !== payload.replicaId) return;
      rebuildApp(appId);
    };

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
    };
  }, [socket, getDoc, getAwareness, refreshState, applyServerAppsState, rebuildApp]);

  useEffect(() => {
    if (!socket) return;

    const flushPending = () => {
      if (!canWrite()) return;
      const pending = pendingInitialUpdatesRef.current;
      if (pending.size === 0) return;

      for (const [appId, update] of pending.entries()) {
        const payload: AppsUpdatePayload = { appId, update, replicaId: replicaIdsRef.current.get(appId) };
        socket.emit("apps:yjs:update", payload);
        initialUpdateSentRef.current.add(appId);
        pending.delete(appId);
      }
    };

    flushPending();
    socket.on("connect", flushPending);
    return () => {
      socket.off("connect", flushPending);
    };
  }, [socket, canWrite]);

  useEffect(() => {
    resumeWrites();
  }, [isAdmin, isReadOnly, resumeWrites]);


  const openApp = useCallback(async (appId: string, options?: Record<string, unknown>) => {
    const currentSocket = socketRef.current;
    if (!currentSocket) return false;
    if (isReadOnlyRef.current) return false;
    if (!apps.some((app) => app.id === appId)) {
      console.warn(`[Apps] Attempted to open unregistered app: ${appId}`);
      return false;
    }

    return new Promise<boolean>((resolve) => {
      let completed = false;
      const timer = setTimeout(() => {
        if (completed) return;
        completed = true;
        resolve(false);
      }, ACK_TIMEOUT_MS);

      const payload: AppsOpenPayload = { appId, options };
      currentSocket.emit("apps:open", payload, (response?: AppsOpenResponse) => {
        if (completed) return;
        completed = true;
        clearTimeout(timer);
        resolve(Boolean(response?.success));
      });
    });
  }, [apps]);

  const closeApp = useCallback(async () => {
    const currentSocket = socketRef.current;
    if (!currentSocket) return false;
    if (isReadOnlyRef.current) return false;

    return new Promise<boolean>((resolve) => {
      let completed = false;
      const timer = setTimeout(() => {
        if (completed) return;
        completed = true;
        resolve(false);
      }, ACK_TIMEOUT_MS);

      currentSocket.emit("apps:close", (response?: AppsCloseResponse) => {
        if (completed) return;
        completed = true;
        clearTimeout(timer);
        resolve(Boolean(response?.success));
      });
    });
  }, []);

  const setLocked = useCallback(async (locked: boolean) => {
    const currentSocket = socketRef.current;
    if (!currentSocket) return false;
    if (isReadOnlyRef.current) return false;

    return new Promise<boolean>((resolve) => {
      let completed = false;
      const timer = setTimeout(() => {
        if (completed) return;
        completed = true;
        resolve(false);
      }, ACK_TIMEOUT_MS);

      const payload: AppsLockPayload = { locked };
      currentSocket.emit("apps:lock", payload, (response?: AppsLockResponse) => {
        if (completed) return;
        completed = true;
        clearTimeout(timer);
        resolve(Boolean(response?.success));
      });
    });
  }, []);

  const currentDoc = useCallback(
    (appId: string): Y.Doc | null =>
      staleAppsRef.current.has(appId) ? null : (docsRef.current.get(appId) ?? null),
    []
  );

  const documents = useMemo<AppDocuments>(
    () => ({ version: docsVersion, doc: getDoc, awareness: getAwareness, current: currentDoc }),
    [docsVersion, getDoc, getAwareness, currentDoc]
  );

  const contextValue = useMemo<AppsContextValue>(
    () => ({
      state,
      apps,
      openApp,
      closeApp,
      setLocked,
      refreshState,
      getDoc,
      getAwareness,
      syncStatus,
      retrySync,
      documents,
      rejectedChangeAt,
      isRebuilding,
      user,
      participants: roster,
      isAdmin,
      isReadOnly,
    }),
    [
      state,
      apps,
      openApp,
      closeApp,
      setLocked,
      refreshState,
      getDoc,
      getAwareness,
      syncStatus,
      retrySync,
      documents,
      rejectedChangeAt,
      isRebuilding,
      user,
      roster,
      isAdmin,
      isReadOnly,
    ]
  );

  return <AppsContext.Provider value={contextValue}>{children}</AppsContext.Provider>;
}
