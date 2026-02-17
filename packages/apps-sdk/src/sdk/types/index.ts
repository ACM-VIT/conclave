import type React from "react";
import type { Awareness } from "y-protocols/awareness";
import type * as Y from "yjs";

export type AppPlatform = "web" | "native";

export type AppUser = {
  id: string;
  name?: string | null;
  email?: string | null;
};

export type AppsState = {
  activeAppId: string | null;
  locked: boolean;
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
  options?: Record<string, unknown>;
};

export type AppsOpenResponse = {
  success: boolean;
  activeAppId?: string;
  error?: string;
};

export type AppsCloseResponse = {
  success: boolean;
  error?: string;
};

export type AppsLockPayload = {
  locked: boolean;
};

export type AppsLockResponse = {
  success: boolean;
  locked?: boolean;
  error?: string;
};

export type AppsContextValue = {
  state: AppsState;
  apps: ConclaveApp[];
  openApp: (appId: string, options?: Record<string, unknown>) => Promise<boolean>;
  closeApp: () => Promise<boolean>;
  setLocked: (locked: boolean) => Promise<boolean>;
  refreshState: () => void;
  getDoc: (appId: string) => Y.Doc;
  getAwareness: (appId: string) => Awareness;
  user?: AppUser;
  isAdmin?: boolean;
  uploadAsset?: AssetUploadHandler;
};

export type AppComponentProps = {
  doc: Y.Doc;
  awareness: Awareness;
  locked: boolean;
  user?: AppUser;
};

export type ConclaveApp = {
  id: string;
  name: string;
  description?: string;
  icon?: React.ReactNode;
  createDoc?: () => Y.Doc;
  web?: React.ComponentType<AppComponentProps>;
  native?: React.ComponentType<AppComponentProps>;
};

export type AssetUploadResult = {
  url: string;
  name?: string;
  size?: number;
  contentType?: string;
};

export type AssetUploadInput =
  | File
  | Blob
  | {
      uri: string;
      name: string;
      type?: string;
    };

export type AssetUploadHandler = (input: AssetUploadInput) => Promise<AssetUploadResult>;
