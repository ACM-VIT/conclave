import type { AuthoritySurface } from "#authority/contract";
import type { Json } from "#authority/schema";

/**
 * The authority transport. Old servers and old clients do not know these
 * events and ignore them, so support is only ever learned from the
 * capabilities exchange, never from a legacy event.
 */
export const AUTHORITY_PROTOCOL = 1;

export const AUTHORITY_EVENTS = {
  capabilities: "apps:authority:capabilities",
  capabilitiesChanged: "apps:authority:capabilitiesChanged",
  subscribe: "apps:authority:subscribe",
  unsubscribe: "apps:authority:unsubscribe",
  act: "apps:authority:act",
  query: "apps:authority:query",
  frame: "apps:authority:frame",
} as const;

export const AUTHORITY_LIMITS = {
  /** Largest action or query input, as JSON. */
  commandBytes: 16 * 1024,
  /** Largest snapshot or query result, as JSON. */
  snapshotBytes: 1024 * 1024,
  /** A larger snapshot or result is sent in parts of at most this size. */
  chunkBytes: 64 * 1024,
  /** An operation id is honoured for this long after its issue time. */
  operationMaxAgeMs: 120_000,
  /** How far ahead of the server clock an issue time may be. */
  operationMaxSkewMs: 5_000,
  /** View changes are coalesced and sent at most this often. */
  flushIntervalMs: 50,
} as const;

export type AuthorityFailureCode =
  | "unsupported"
  | "not-in-room"
  | "stale-epoch"
  | "unknown-app"
  | "not-subscribed"
  | "stale-generation"
  | "forbidden"
  | "identity-required"
  | "invalid-input"
  | "too-large"
  | "rate-limited"
  | "busy"
  /** A table, timer or receipt bound the host enforces is full. */
  | "capacity"
  | "invalid-operation"
  | "operation-expired"
  | "operation-conflict"
  /** The app's own rule refused. `reason` carries the app's code. */
  | "rejected"
  | "app-fault"
  /** Client side only: the outcome of a request could not be learned. */
  | "unknown-outcome";

export type AuthorityFailure = {
  ok: false;
  code: AuthorityFailureCode;
  reason?: string;
  retryAfterMs?: number;
};

export type AuthorityResult<T> = { ok: true; value: T } | AuthorityFailure;

export type AuthorityAppEntry = {
  /** Opaque, one per app per room. Pinned to `app` and `major`. */
  instance: string;
  app: string;
  major: number;
  surface: AuthoritySurface;
};

export type AuthorityCapability = {
  protocol: number;
  /** Changes when the room is recreated; old views and requests are void. */
  roomEpoch: string;
  serverNowMs: number;
  /** Only the apps this connection may open. */
  apps: AuthorityAppEntry[];
};

export type CapabilitiesRequest = { protocols: number[] };

export type SubscribeRequest = {
  roomEpoch: string;
  instance: string;
  app: string;
  major: number;
  /** Chosen by the client, unique per attempt. */
  subscription: string;
};

export type UnsubscribeRequest = { subscription: string };

/**
 * Names one user intent. A retry carries the same id and gets the first
 * answer. The issue time bounds how long the server must remember it.
 */
export type OperationId = { issuedAtMs: number; nonce: string };

export type ActRequest = {
  roomEpoch: string;
  subscription: string;
  generation: number;
  operation: OperationId;
  action: string;
  input: unknown;
};

export type QueryRequest = {
  roomEpoch: string;
  subscription: string;
  generation: number;
  /** Chosen by the client. Names the parts of a streamed result. */
  request: string;
  query: string;
  input: unknown;
};

export type QueryReply =
  | AuthorityFailure
  | { ok: true; value: Json }
  /** The result follows as `query` frames and is complete at `last`. */
  | { ok: true; streamed: true };

export type ProjectedRow = { bucket: string; key: string; value: Json };
export type RowRef = { bucket: string; key: string };

/** What this connection may call right now. Advisory: the server rechecks. */
export type AuthorityGrants = {
  actions: string[];
  /** Actions refused only because this connection has no verified identity. */
  needsIdentity: string[];
  queries: string[];
};

export type AuthorityRevokeReason =
  | "forbidden"
  | "unknown-app"
  | "stale-epoch"
  | "too-large"
  | "too-many"
  | "closed";

type FrameBase = {
  subscription: string;
  /** Rises on every full replacement. Frames of an older one are dropped. */
  generation: number;
  serverNowMs: number;
};

/**
 * A whole view. A large one arrives in parts and is installed only when the
 * `last` part is in, so a reader never sees half of it.
 */
export type ReplaceFrame = FrameBase & {
  kind: "replace";
  part: number;
  last: boolean;
  rows: ProjectedRow[];
  /** Sent with part 0. */
  grants?: AuthorityGrants;
};

/** Whole-row changes since the previous frame of this generation. */
export type PatchFrame = FrameBase & {
  kind: "patch";
  /** Starts at 1 after a replacement and counts only frames actually sent. */
  seq: number;
  put: ProjectedRow[];
  remove: RowRef[];
};

/** The view is withdrawn. The client forgets everything it held. */
export type RevokeFrame = FrameBase & {
  kind: "revoke";
  reason: AuthorityRevokeReason;
};

export type QueryPartFrame = FrameBase & {
  kind: "query";
  request: string;
  part: number;
  last: boolean;
  /** A slice of the result's JSON text. */
  data: string;
};

/** A streamed result was cut short. The client discards its parts. */
export type QueryAbortFrame = FrameBase & {
  kind: "queryAbort";
  request: string;
};

export type AuthorityFrame =
  | ReplaceFrame
  | PatchFrame
  | RevokeFrame
  | QueryPartFrame
  | QueryAbortFrame;
