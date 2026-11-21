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

export type AppsUpdatePayload = {
  appId: string;
  update: Uint8Array;
};

export type AppsAwarenessPayload = {
  appId: string;
  awarenessUpdate: Uint8Array;
  clientId?: number;
};

export type AppsOpenPayload = {
  appId: string;
  expectedRevision?: number;
};

export type AppsOpenResponse = {
  success: boolean;
  activeAppId?: string;
  error?: string;
};

export type AppsClosePayload = {
  expectedRevision: number;
};

export type AppsCloseResponse = {
  success: boolean;
  error?: string;
};

export type AppsDiscardPayload = {
  appId: string;
  expectedRevision: number;
};

export type AppsDiscardResponse = {
  success: boolean;
  error?: string;
};

export type AppsLockPayload = {
  locked: boolean;
  expectedRevision?: number;
};

export type AppsLockResponse = {
  success: boolean;
  locked?: boolean;
  error?: string;
};

export type AppsContextValue = {
  state: AppsState;
  apps: ConclaveApp[];
  /** Presents an app on the room's stage. Hosts only. */
  presentApp: (appId: string) => Promise<boolean>;
  /** Takes the presented app off the stage. The room keeps its document unless `revision` is null. */
  closeApp: () => Promise<boolean>;
  /** Erases an app's document for everyone. False on an older SFU. */
  clearApp: (appId: string) => Promise<boolean>;
  setLocked: (locked: boolean) => Promise<boolean>;
  refreshState: () => void;
  getDoc: (appId: string) => Y.Doc;
  getAwareness: (appId: string) => Awareness;
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
