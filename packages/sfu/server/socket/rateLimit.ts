import type { Socket } from "socket.io";

/**
 * A small, dependency-free token-bucket rate limiter applied per-socket.
 *
 * Each named bucket refills continuously at `refillPerSec` tokens/second up to a
 * `capacity` ceiling, and each accepted event consumes one token. When the
 * bucket is empty, `take()` returns false and the caller is expected to DROP /
 * IGNORE the event (optionally acking an error); never throw or crash.
 *
 * Buckets are lazily created and stored on the socket itself, so they are
 * garbage-collected together with the socket on disconnect (no global registry,
 * no leak across reconnects).
 */

export type TokenBucketOptions = {
  /** Maximum number of tokens the bucket can hold (burst allowance). */
  capacity: number;
  /** Sustained refill rate in tokens per second. */
  refillPerSec: number;
};

type BucketState = {
  capacity: number;
  refillPerSec: number;
  tokens: number;
  lastRefillMs: number;
};

type RateLimitedSocket = Socket & {
  __rateLimitBuckets?: Map<string, BucketState>;
};

const getBucketStore = (socket: Socket): Map<string, BucketState> => {
  const limited = socket as RateLimitedSocket;
  if (!limited.__rateLimitBuckets) {
    limited.__rateLimitBuckets = new Map<string, BucketState>();
  }
  return limited.__rateLimitBuckets;
};

const refill = (bucket: BucketState, nowMs: number): void => {
  if (nowMs <= bucket.lastRefillMs) {
    return;
  }
  const elapsedSec = (nowMs - bucket.lastRefillMs) / 1000;
  bucket.tokens = Math.min(
    bucket.capacity,
    bucket.tokens + elapsedSec * bucket.refillPerSec,
  );
  bucket.lastRefillMs = nowMs;
};

/**
 * Attempt to consume a single token from the named per-socket bucket.
 *
 * @returns true when the event is within budget (proceed), false when the
 * bucket is exhausted (the caller must drop/ignore the event).
 */
export const takeToken = (
  socket: Socket,
  key: string,
  options: TokenBucketOptions,
): boolean => {
  const store = getBucketStore(socket);
  const nowMs = Date.now();

  let bucket = store.get(key);
  if (!bucket) {
    bucket = {
      capacity: options.capacity,
      refillPerSec: options.refillPerSec,
      // Start full so a legitimate burst on first use is not penalized.
      tokens: options.capacity,
      lastRefillMs: nowMs,
    };
    store.set(key, bucket);
  } else {
    // Keep the live config in sync if limits are ever changed at runtime.
    bucket.capacity = options.capacity;
    bucket.refillPerSec = options.refillPerSec;
    refill(bucket, nowMs);
  }

  if (bucket.tokens >= 1) {
    bucket.tokens -= 1;
    return true;
  }

  return false;
};

/**
 * Centralized, named rate-limit profiles for the high-frequency socket events.
 * Capacity = burst allowance; refillPerSec = sustained rate.
 */
export const RATE_LIMITS = {
  // Awareness updates are the chattiest (cursor moves, presence). ~20/s sustained.
  appsAwareness: { capacity: 40, refillPerSec: 20 },
  // Full Yjs sync can encode a large document; keep request bursts modest.
  appsYjsSync: { capacity: 10, refillPerSec: 2 },
  // Yjs document updates: bursty while typing, so allow a generous burst.
  appsYjsUpdate: { capacity: 60, refillPerSec: 30 },
  // Chat messages: ~5/s sustained, small burst.
  chat: { capacity: 10, refillPerSec: 5 },
  // Assistant answer authorization is user-triggered and should stay sparse.
  conclaveAuthorize: { capacity: 4, refillPerSec: 0.2 },
  // Conclave AI answer relay: streamed in throttled chunks, so allow a higher
  // sustained rate and burst than normal chat.
  conclave: { capacity: 30, refillPerSec: 10 },
  // Transcript token minting is user-triggered but should tolerate reconnects.
  transcriptToken: { capacity: 8, refillPerSec: 1 },
  // SFU transcript relay start/stop is heavier because it opens mediasoup consumers.
  transcriptRelay: { capacity: 4, refillPerSec: 0.5 },
  // Reactions: ~5/s sustained, small burst.
  reaction: { capacity: 10, refillPerSec: 5 },
  // Hand raise toggles: low frequency.
  hand: { capacity: 5, refillPerSec: 2 },
  // Display-name changes broadcast room-wide and should be rare.
  displayName: { capacity: 5, refillPerSec: 1 },
  // Admin socket actions can snapshot or mutate many room members.
  adminAction: { capacity: 40, refillPerSec: 8 },
  adminBulkAction: { capacity: 8, refillPerSec: 1 },
  // Transport creation: roughly once per kind, allow a small retry burst.
  transportCreate: { capacity: 3, refillPerSec: 1 },
  // Producer allocation is expensive enough to reject rapid churn.
  mediaProduce: { capacity: 12, refillPerSec: 2 },
  // ICE restarts are useful for recovery but allocate new ICE credentials.
  iceRestart: { capacity: 6, refillPerSec: 0.5 },
  // Consumer resume/preference/keyframe controls: recovery can be bursty.
  consumerControl: { capacity: 30, refillPerSec: 10 },
  // Shared browser controls proxy to a separate service; keep them coalesced.
  sharedBrowserControl: { capacity: 10, refillPerSec: 2 },
  // Game moves (answers, votes): tapping should feel instant, abuse should not.
  gameMove: { capacity: 20, refillPerSec: 8 },
  // Game lifecycle (start/end/state): low frequency, admin-driven.
  gameControl: { capacity: 10, refillPerSec: 2 },
} as const satisfies Record<string, TokenBucketOptions>;
