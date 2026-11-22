import { AUTHORITY_LIMITS } from "@conclave/apps-sdk/authority";

/**
 * Every bound the host enforces. The first six are part of the wire contract
 * and shared with clients. The rest are server policy. All are starting
 * budgets from the design's load test and can be tuned per deployment.
 */
export type AuthorityLimits = {
  commandBytes: number;
  snapshotBytes: number;
  chunkBytes: number;
  operationMaxAgeMs: number;
  operationMaxSkewMs: number;
  flushIntervalMs: number;
  /** A patch larger than this is sent as a full replacement instead. */
  patchBytes: number;
  /** Unexpired receipts kept per app instance, and per subject within it. */
  receiptsPerInstance: number;
  receiptsPerSubject: number;
  /** Accepted mutations per app instance: sustained rate and burst. */
  mutationsPerSecond: number;
  mutationBurst: number;
  timersPerInstance: number;
  /** Due timers run per wake, so a backlog cannot starve signalling. */
  timersPerWake: number;
  /** Reads and writes one transaction may make before it is cut off. */
  transactionOps: number;
  /**
   * Rows removed by a `clear` that one audience is told of in one flush.
   * The views drop a cleared row before anything is read from them again.
   * Telling everyone who held it is the costly part, so a larger clear is
   * told over the flushes that follow. People's own rows share one such allowance between them, as
   * each person told is a frame of their own.
   */
  clearedRowsPerFlush: number;
  subscriptionsPerSocket: number;
  /** Patches held for a subscription while its snapshot is still in flight. */
  backlogFrames: number;
  /** Unsent packets or bytes on a socket before it is treated as behind. */
  socketSoftPackets: number;
  socketSoftBytes: number;
  /** Unsent packets or bytes before the socket is disconnected. */
  socketHardPackets: number;
  socketHardBytes: number;
  /** How often a socket that fell behind is checked for having caught up. */
  lagRecheckMs: number;
  /** How long a streamed result waits for such a socket before it is cut off. */
  queryStallMs: number;
  /** Idle rate-limit buckets are dropped once this many exist. */
  rateBuckets: number;
};

export const DEFAULT_AUTHORITY_LIMITS: AuthorityLimits = {
  ...AUTHORITY_LIMITS,
  patchBytes: 256 * 1024,
  receiptsPerInstance: 20_000,
  receiptsPerSubject: 256,
  mutationsPerSecond: 120,
  mutationBurst: 240,
  timersPerInstance: 1_024,
  timersPerWake: 64,
  transactionOps: 50_000,
  clearedRowsPerFlush: 1_000,
  subscriptionsPerSocket: 16,
  backlogFrames: 32,
  socketSoftPackets: 256,
  socketSoftBytes: 1024 * 1024,
  socketHardPackets: 4_096,
  socketHardBytes: 8 * 1024 * 1024,
  lagRecheckMs: 250,
  queryStallMs: 5_000,
  rateBuckets: 10_000,
};
