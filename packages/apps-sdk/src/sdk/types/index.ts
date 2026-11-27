import type React from "react";
import type { Awareness } from "y-protocols/awareness";
import type * as Y from "yjs";

export type AppUser = {
  id: string;
  name?: string | null;
  email?: string | null;
};

export type AppsState = {
  /** The app presented on the room's stage. Only hosts change it. */
  activeAppId: string | null;
  locked: boolean;
  /**
   * Bumped by every change to this state. Null on an older SFU, which
   * erases an app's document when it leaves the stage and cannot clear one.
   */
  revision: number | null;
  /** Apps off the stage whose document the room keeps. */
  savedAppIds: string[];
  /**
   * The presented app's document. A new number means the room started it
   * over, so a local copy of the earlier one is stale. Null when nothing is
   * presented, or on an older SFU.
   */
  docGeneration: number | null;
};

export type AppsSyncPayload = {
  appId: string;
  syncMessage: Uint8Array;
};

export type AppsSyncResponse = {
  syncMessage: Uint8Array;
  stateVector?: Uint8Array;
  awarenessUpdate?: Uint8Array;
};

export type AppsSyncError = {
  error: string;
  retryable?: true;
  retryAfterMs?: number;
};

export type AppSyncStatus = "idle" | "syncing" | "synced" | "failed";

export type AppsUpdatePayload = {
  appId: string;
  update: Uint8Array;
  replicaId?: string;
};

export type AppsRefusedPayload = {
  appId: string;
  replicaId: string;
  reason: string;
};

export type AppsAwarenessPayload = {
  appId: string;
  awarenessUpdate: Uint8Array;
  clientId?: number;
};

/** Why the SFU refused a stage command. */
export type AppsStageErrorCode = "stale_revision" | "room_full";

export type AppsOpenPayload = {
  appId: string;
  expectedRevision?: number;
};

export type AppsOpenResponse = {
  success: boolean;
  activeAppId?: string;
  error?: string;
  code?: AppsStageErrorCode;
};

export type AppsClosePayload = {
  expectedRevision: number;
};

export type AppsCloseResponse = {
  success: boolean;
  error?: string;
  code?: AppsStageErrorCode;
};

export type AppsDiscardPayload = {
  appId: string;
  expectedRevision: number;
};

export type AppsDiscardResponse = {
  success: boolean;
  error?: string;
  code?: AppsStageErrorCode;
};

export type AppsLockPayload = {
  locked: boolean;
  expectedRevision?: number;
};

export type AppsLockResponse = {
  success: boolean;
  locked?: boolean;
  error?: string;
  code?: AppsStageErrorCode;
};

/**
 * How a stage command went. `roomFull`: the room keeps as many app documents
 * as it can, so a host clears one before presenting another. `staleStage`:
 * the stage changed first. `failed`: anything else, such as no permission,
 * a rate limit, a timeout or an older SFU.
 */
export type AppsCommandResult =
  | { ok: true }
  | { ok: false; reason: "roomFull" | "staleStage" | "failed" };

export type AppsContextValue = {
  state: AppsState;
  apps: ConclaveApp[];
  /** Presents an app on the room's stage. Hosts only. */
  presentApp: (appId: string) => Promise<AppsCommandResult>;
  /** Takes the presented app off the stage. The room keeps its document unless `revision` is null. */
  closeApp: () => Promise<AppsCommandResult>;
  /** Erases an app's document for everyone. Fails on an older SFU. */
  clearApp: (appId: string) => Promise<AppsCommandResult>;
  setLocked: (locked: boolean) => Promise<AppsCommandResult>;
  refreshState: () => void;
  getDoc: (appId: string) => Y.Doc;
  getAwareness: (appId: string) => Awareness;
  /**
   * Where the presented app's sync stands: `synced` once the room's reply has
   * filled its local document, `failed` after the retries ran out.
   */
  syncStatus: AppSyncStatus;
  /** Starts the presented app's sync over, as after `failed`. */
  retrySync: () => void;
  /**
   * Changes with every new local copy of the presented app's document. Hosts
   * mount the app only when `syncStatus` is `synced`, keyed by this, so an app
   * never edits a copy the room has not filled yet or one the provider dropped.
   */
  presentedDocKey: string | null;
  rejectedChange: { at: number; reason: string } | null;
  user?: AppUser;
  participants?: AppUser[];
  isAdmin?: boolean;
  isReadOnly?: boolean;
};

export type ConclaveApp = {
  id: string;
  name: string;
  description?: string;
  icon?: React.ReactNode;
  createDoc?: () => Y.Doc;
  web: React.ComponentType;
};
