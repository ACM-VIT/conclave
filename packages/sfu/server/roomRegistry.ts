import { createClient, type RedisClientType } from "redis";
import { config as defaultConfig } from "../config/config.js";
import { Logger } from "../utilities/loggers.js";
import { isRedisTransientError } from "./redisErrors.js";

export type RoomOwnerRecord = {
  kind?: "owner";
  channelId: string;
  clientId: string;
  roomId: string;
  instanceId: string;
  instanceUrl?: string;
  region?: string;
  updatedAt: number;
  expiresAt: number;
};

export type RoomPlacementRecord = {
  kind: "placement";
  channelId: string;
  clientId: string;
  roomId: string;
  instanceId: string;
  instanceUrl?: string;
  region?: string;
  updatedAt: number;
  expiresAt: number;
};

export type RoomAssignmentRecord = RoomOwnerRecord | RoomPlacementRecord;

type RoomOwnershipClaim =
  | { ok: true; owner: RoomOwnerRecord }
  | { ok: false; owner: RoomAssignmentRecord };

export type RoomPlacementClaim =
  | { ok: true; placement: RoomPlacementRecord }
  | { ok: false; assignment: RoomAssignmentRecord };

export class RoomRegistryUnavailableError extends Error {
  constructor(operation: string, options?: { cause?: unknown }) {
    super(`Shared room registry unavailable during ${operation}`, options);
    this.name = "RoomRegistryUnavailableError";
  }
}

export class RoomLeaseExpiredError extends RoomRegistryUnavailableError {
  constructor(channelId: string, options?: { cause?: unknown }) {
    super(`confirmed lease expiry for ${channelId}`, options);
    this.name = "RoomLeaseExpiredError";
  }
}

export class RoomOwnershipError extends Error {
  owner: RoomAssignmentRecord;

  constructor(owner: RoomAssignmentRecord) {
    super(
      `Room ${owner.roomId} (${owner.clientId}) is owned by SFU instance ${owner.instanceId}`,
    );
    this.name = "RoomOwnershipError";
    this.owner = owner;
  }
}

export type RoomRegistry = {
  mode: "local" | "redis";
  instanceId: string;
  instanceUrl?: string;
  start: () => Promise<void>;
  close: () => Promise<void>;
  getOwner: (channelId: string) => Promise<RoomOwnerRecord | null>;
  getPlacement: (channelId: string) => Promise<RoomPlacementRecord | null>;
  getAssignment: (channelId: string) => Promise<RoomAssignmentRecord | null>;
  reservePlacement: (input: {
    channelId: string;
    clientId: string;
    roomId: string;
  }) => Promise<RoomPlacementClaim>;
  claimRoom: (input: {
    channelId: string;
    clientId: string;
    roomId: string;
  }) => Promise<RoomOwnershipClaim>;
  renewRoom: (input: {
    channelId: string;
    clientId: string;
    roomId: string;
  }) => Promise<RoomOwnershipClaim>;
  releaseRoom: (channelId: string) => Promise<void>;
  isLocalOwner: (owner: RoomAssignmentRecord | null | undefined) => boolean;
};

export const DEFAULT_ROOM_PLACEMENT_TTL_MS = 20_000;

export const hasUsableConfirmedLease = (
  owner: RoomOwnerRecord | null | undefined,
  now: number,
  safetyMarginMs: number,
): owner is RoomOwnerRecord =>
  Boolean(owner && owner.expiresAt - safetyMarginMs > now);

export const hasUsableLeaseDeadline = (
  serveUntilMonotonicMs: number | undefined,
  monotonicNowMs: number,
): boolean =>
  typeof serveUntilMonotonicMs === "number" &&
  Number.isFinite(serveUntilMonotonicMs) &&
  serveUntilMonotonicMs > monotonicNowMs;

export const roomLeaseSafetyMarginMs = (
  ttlMs: number,
  renewIntervalMs: number,
): number =>
  Math.min(
    Math.max(0, ttlMs - 1_000),
    Math.max(1_000, renewIntervalMs * 2),
  );

const CLAIM_OR_RENEW_SCRIPT = `
local key = KEYS[1]
local value = ARGV[1]
local instanceId = ARGV[2]
local instanceUrl = ARGV[3]
local ttlMs = tonumber(ARGV[4])
local current = redis.call("GET", key)
if current then
  local ok, decoded = pcall(cjson.decode, current)
  if not ok or not decoded or not decoded.instanceId then
    return {2, current}
  end
  local decodedUrl = tostring(decoded.instanceUrl or "")
  if decoded.instanceId ~= instanceId or decodedUrl ~= instanceUrl then
    return {0, current}
  end
end
redis.call("PSETEX", key, ttlMs, value)
return {1, value}
`;

const RESERVE_PLACEMENT_SCRIPT = `
local key = KEYS[1]
local value = ARGV[1]
local instanceId = ARGV[2]
local instanceUrl = ARGV[3]
local ttlMs = tonumber(ARGV[4])
local current = redis.call("GET", key)
if current then
  local ok, decoded = pcall(cjson.decode, current)
  if not ok or not decoded or not decoded.instanceId then
    return {2, current}
  end
  local decodedUrl = tostring(decoded.instanceUrl or "")
  if decoded.kind == "placement" and decoded.instanceId == instanceId and decodedUrl == instanceUrl then
    return {1, current}
  else
    return {0, current}
  end
end
redis.call("PSETEX", key, ttlMs, value)
return {1, value}
`;

const RELEASE_SCRIPT = `
local key = KEYS[1]
local instanceId = ARGV[1]
local instanceUrl = ARGV[2]
local current = redis.call("GET", key)
if not current then
  return 0
end
local ok, decoded = pcall(cjson.decode, current)
local decodedUrl = ok and decoded and tostring(decoded.instanceUrl or "") or nil
if ok and decoded and decoded.kind ~= "placement" and decoded.instanceId == instanceId and decodedUrl == instanceUrl then
  redis.call("DEL", key)
  return 1
end
return 0
`;

const isFiniteTimestamp = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);

const parseAssignmentRecord = (value: unknown): RoomAssignmentRecord | null => {
  if (typeof value !== "string" || !value) {
    return null;
  }

  try {
    const parsed = JSON.parse(value) as Partial<RoomAssignmentRecord>;
    if (
      (parsed.kind !== undefined &&
        parsed.kind !== "owner" &&
        parsed.kind !== "placement") ||
      typeof parsed.channelId !== "string" ||
      typeof parsed.clientId !== "string" ||
      typeof parsed.roomId !== "string" ||
      typeof parsed.instanceId !== "string" ||
      !isFiniteTimestamp(parsed.updatedAt) ||
      !isFiniteTimestamp(parsed.expiresAt)
    ) {
      return null;
    }

    return {
      ...(parsed.kind === "placement" ? { kind: "placement" as const } : {}),
      channelId: parsed.channelId,
      clientId: parsed.clientId,
      roomId: parsed.roomId,
      instanceId: parsed.instanceId,
      ...(typeof parsed.instanceUrl === "string" && parsed.instanceUrl.trim()
        ? { instanceUrl: parsed.instanceUrl.trim() }
        : {}),
      ...(typeof parsed.region === "string" && parsed.region.trim()
        ? { region: parsed.region.trim() }
        : {}),
      updatedAt: parsed.updatedAt,
      expiresAt: parsed.expiresAt,
    };
  } catch {
    return null;
  }
};

const serializeAssignmentRecord = (record: RoomAssignmentRecord): string =>
  JSON.stringify(record);

const parseClaimResult = (value: unknown): RoomOwnershipClaim => {
  if (!Array.isArray(value) || value.length < 2) {
    throw new Error("Invalid room registry response");
  }

  const entries: readonly unknown[] = value;
  const okValue = entries[0];
  const owner = parseAssignmentRecord(entries[1]);
  if (!owner) {
    throw new Error("Invalid room owner record");
  }

  if (okValue === 1 || okValue === "1") {
    if (owner.kind === "placement") {
      throw new Error("Invalid room owner claim response");
    }
    return { ok: true, owner };
  }
  return { ok: false, owner };
};

const parsePlacementClaimResult = (value: unknown): RoomPlacementClaim => {
  if (!Array.isArray(value) || value.length < 2) {
    throw new Error("Invalid room placement response");
  }
  const entries: readonly unknown[] = value;
  const assignment = parseAssignmentRecord(entries[1]);
  if (!assignment) {
    throw new Error("Invalid room assignment record");
  }
  if (entries[0] === 1 || entries[0] === "1") {
    if (assignment.kind !== "placement") {
      throw new Error("Invalid successful room placement response");
    }
    return { ok: true, placement: assignment };
  }
  return { ok: false, assignment };
};

export class LocalRoomRegistry implements RoomRegistry {
  mode = "local" as const;
  instanceId: string;
  instanceUrl?: string;
  private region?: string;
  private owners = new Map<string, RoomOwnerRecord>();
  private placements = new Map<string, RoomPlacementRecord>();
  private ttlMs: number;
  private placementTtlMs: number;
  private now: () => number;

  constructor(options: {
    instanceId: string;
    instanceUrl?: string;
    region?: string;
    ttlMs: number;
    placementTtlMs?: number;
    now?: () => number;
  }) {
    this.instanceId = options.instanceId;
    this.instanceUrl = options.instanceUrl || undefined;
    this.region = options.region || undefined;
    this.ttlMs = options.ttlMs;
    this.placementTtlMs = Math.min(
      options.placementTtlMs ?? DEFAULT_ROOM_PLACEMENT_TTL_MS,
      options.ttlMs,
    );
    this.now = options.now ?? Date.now;
  }

  async start(): Promise<void> {}

  async close(): Promise<void> {
    this.owners.clear();
    this.placements.clear();
  }

  async getOwner(channelId: string): Promise<RoomOwnerRecord | null> {
    return this.currentOwner(channelId);
  }

  private currentOwner(channelId: string): RoomOwnerRecord | null {
    const owner = this.owners.get(channelId);
    if (!owner) {
      return null;
    }
    if (owner.expiresAt <= this.now()) {
      this.owners.delete(channelId);
      return null;
    }
    return owner;
  }

  async getPlacement(channelId: string): Promise<RoomPlacementRecord | null> {
    return this.currentPlacement(channelId);
  }

  private currentPlacement(channelId: string): RoomPlacementRecord | null {
    const placement = this.placements.get(channelId);
    if (!placement) {
      return null;
    }
    if (placement.expiresAt <= this.now()) {
      this.placements.delete(channelId);
      return null;
    }
    return placement;
  }

  async getAssignment(channelId: string): Promise<RoomAssignmentRecord | null> {
    return this.currentOwner(channelId) ?? this.currentPlacement(channelId);
  }

  async reservePlacement(input: {
    channelId: string;
    clientId: string;
    roomId: string;
  }): Promise<RoomPlacementClaim> {
    const owner = this.currentOwner(input.channelId);
    if (owner) {
      return { ok: false, assignment: owner };
    }

    const existing = this.currentPlacement(input.channelId);
    if (existing) {
      return this.isLocalOwner(existing)
        ? { ok: true, placement: existing }
        : { ok: false, assignment: existing };
    }

    const placement = this.createPlacement(input);
    this.placements.set(input.channelId, placement);
    return { ok: true, placement };
  }

  rememberOwner(owner: RoomOwnerRecord): void {
    this.owners.set(owner.channelId, owner);
    this.placements.delete(owner.channelId);
  }

  rememberPlacement(placement: RoomPlacementRecord): void {
    this.placements.set(placement.channelId, placement);
  }

  async claimRoom(input: {
    channelId: string;
    clientId: string;
    roomId: string;
  }): Promise<RoomOwnershipClaim> {
    const currentOwner = this.currentOwner(input.channelId);
    if (currentOwner && !this.isLocalOwner(currentOwner)) {
      return { ok: false, owner: currentOwner };
    }
    const placement = this.currentPlacement(input.channelId);
    if (placement && !this.isLocalOwner(placement)) {
      return { ok: false, owner: placement };
    }

    const owner = this.createOwner(input);
    this.owners.set(input.channelId, owner);
    this.placements.delete(input.channelId);
    return { ok: true, owner };
  }

  async renewRoom(input: {
    channelId: string;
    clientId: string;
    roomId: string;
  }): Promise<RoomOwnershipClaim> {
    return this.claimRoom(input);
  }

  async releaseRoom(channelId: string): Promise<void> {
    this.owners.delete(channelId);
  }

  isLocalOwner(owner: RoomAssignmentRecord | null | undefined): boolean {
    return Boolean(
      owner &&
        owner.instanceId === this.instanceId &&
        (owner.instanceUrl ?? "") === (this.instanceUrl ?? ""),
    );
  }

  private createOwner(input: {
    channelId: string;
    clientId: string;
    roomId: string;
  }): RoomOwnerRecord {
    const now = this.now();
    return {
      kind: "owner",
      channelId: input.channelId,
      clientId: input.clientId,
      roomId: input.roomId,
      instanceId: this.instanceId,
      ...(this.instanceUrl ? { instanceUrl: this.instanceUrl } : {}),
      ...(this.region ? { region: this.region } : {}),
      updatedAt: now,
      expiresAt: now + this.ttlMs,
    };
  }

  private createPlacement(input: {
    channelId: string;
    clientId: string;
    roomId: string;
  }): RoomPlacementRecord {
    const now = this.now();
    return {
      kind: "placement",
      channelId: input.channelId,
      clientId: input.clientId,
      roomId: input.roomId,
      instanceId: this.instanceId,
      ...(this.instanceUrl ? { instanceUrl: this.instanceUrl } : {}),
      ...(this.region ? { region: this.region } : {}),
      updatedAt: now,
      expiresAt: now + this.placementTtlMs,
    };
  }
}

class RedisRoomRegistry implements RoomRegistry {
  mode = "redis" as const;
  instanceId: string;
  instanceUrl?: string;
  private client: RedisClientType;
  private localFallback: LocalRoomRegistry;
  private region?: string;
  private keyPrefix: string;
  private ttlMs: number;
  private placementTtlMs: number;
  private leaseSafetyMarginMs: number;
  private commandTimeoutMs: number;
  private confirmedLeaseServeUntil = new Map<string, number>();
  private startPromise: Promise<void> | null = null;
  private started = false;

  constructor(options: {
    redisUrl: string;
    connectTimeoutMs: number;
    instanceId: string;
    instanceUrl?: string;
    region?: string;
    keyPrefix: string;
    ttlMs: number;
    placementTtlMs?: number;
    renewIntervalMs: number;
  }) {
    this.instanceId = options.instanceId;
    this.instanceUrl = options.instanceUrl || undefined;
    this.region = options.region || undefined;
    this.keyPrefix = options.keyPrefix.replace(/:+$/, "");
    this.ttlMs = options.ttlMs;
    this.placementTtlMs = Math.min(
      options.placementTtlMs ?? DEFAULT_ROOM_PLACEMENT_TTL_MS,
      options.ttlMs,
    );
    this.commandTimeoutMs = Math.min(
      3_000,
      Math.max(500, options.connectTimeoutMs),
    );
    const minimumSafeTtlMs =
      options.renewIntervalMs * 2 + this.commandTimeoutMs;
    if (options.ttlMs <= minimumSafeTtlMs) {
      throw new Error(
        `SFU room registry TTL must exceed ${minimumSafeTtlMs}ms for the configured renewal and Redis command deadlines`,
      );
    }
    this.leaseSafetyMarginMs = roomLeaseSafetyMarginMs(
      options.ttlMs,
      options.renewIntervalMs,
    );
    this.localFallback = new LocalRoomRegistry({
      instanceId: options.instanceId,
      instanceUrl: options.instanceUrl,
      region: options.region,
      ttlMs: options.ttlMs,
      placementTtlMs: this.placementTtlMs,
    });
    this.client = createClient({
      url: options.redisUrl,
      socket: {
        connectTimeout: options.connectTimeoutMs,
        reconnectStrategy: (retries) => Math.min(100 + retries * 200, 5000),
      },
      disableOfflineQueue: true,
      commandsQueueMaxLength: 1000,
    });
    this.client.on("error", (error) => {
      const log = isRedisTransientError(error) ? Logger.warn : Logger.error;
      log("[RoomRegistry] Redis client error", error);
    });
  }

  async start(): Promise<void> {
    if (this.started) {
      return;
    }
    if (this.startPromise) {
      await this.startPromise;
      return;
    }

    this.startPromise = (async () => {
      try {
        await this.client.connect();
        this.started = true;
        Logger.success("[RoomRegistry] Redis registry connected");
      } catch (error) {
        this.startPromise = null;
        throw error;
      }
    })();

    await this.startPromise;
  }

  async close(): Promise<void> {
    this.startPromise = null;
    this.confirmedLeaseServeUntil.clear();
    if (!this.started) {
      await this.localFallback.close();
      return;
    }
    this.started = false;
    await Promise.allSettled([this.client.quit(), this.localFallback.close()]);
  }

  async getOwner(channelId: string): Promise<RoomOwnerRecord | null> {
    try {
      await this.start();
      const value = await this.getWithTimeout(this.keyFor(channelId));
      const assignment = parseAssignmentRecord(value);
      if (value !== null && !assignment) {
        throw new RoomRegistryUnavailableError("owner record validation");
      }
      const owner = assignment?.kind === "placement" ? null : assignment;
      if (!owner) {
        return value === null ? this.localFallback.getOwner(channelId) : null;
      }
      if (this.isLocalOwner(owner)) {
        this.localFallback.rememberOwner(owner);
      }
      return owner;
    } catch (error) {
      this.logTransientRedisFailure("get owner", channelId, error);
      if (error instanceof RoomRegistryUnavailableError) {
        throw error;
      }
      return this.localFallback.getOwner(channelId);
    }
  }

  async getPlacement(channelId: string): Promise<RoomPlacementRecord | null> {
    try {
      await this.start();
      const value = await this.getWithTimeout(this.keyFor(channelId));
      const assignment = parseAssignmentRecord(value);
      if (value !== null && !assignment) {
        throw new RoomRegistryUnavailableError("placement record validation");
      }
      const placement = assignment?.kind === "placement" ? assignment : null;
      if (!placement) {
        return value === null ? this.localFallback.getPlacement(channelId) : null;
      }
      return placement;
    } catch (error) {
      this.logTransientRedisFailure("get placement", channelId, error);
      if (error instanceof RoomRegistryUnavailableError) {
        throw error;
      }
      return this.localFallback.getPlacement(channelId);
    }
  }

  async getAssignment(channelId: string): Promise<RoomAssignmentRecord | null> {
    try {
      await this.start();
      const value = await this.getWithTimeout(this.keyFor(channelId));
      const assignment = parseAssignmentRecord(value);
      if (value !== null && !assignment) {
        throw new RoomRegistryUnavailableError("assignment record validation");
      }
      if (assignment) {
        return assignment;
      }
      return this.localFallback.getAssignment(channelId);
    } catch (error) {
      this.logTransientRedisFailure("get assignment", channelId, error);
      if (error instanceof RoomRegistryUnavailableError) {
        throw error;
      }
      const cachedAssignment = await this.localFallback.getAssignment(channelId);
      if (cachedAssignment?.kind === "placement") {
        throw new RoomRegistryUnavailableError("placement lookup", {
          cause: error,
        });
      }
      return cachedAssignment;
    }
  }

  async reservePlacement(input: {
    channelId: string;
    clientId: string;
    roomId: string;
  }): Promise<RoomPlacementClaim> {
    try {
      await this.start();
      const now = Date.now();
      const placement = this.createPlacement(input, now);
      const result = await this.evalWithTimeout(RESERVE_PLACEMENT_SCRIPT, {
        keys: [this.keyFor(input.channelId)],
        arguments: [
          serializeAssignmentRecord(placement),
          this.instanceId,
          this.instanceUrl ?? "",
          String(this.placementTtlMs),
        ],
      });
      const reservation = parsePlacementClaimResult(result);
      if (reservation.ok) {
        this.localFallback.rememberPlacement(reservation.placement);
      }
      return reservation;
    } catch (error) {
      this.logTransientRedisFailure("reserve placement", input.channelId, error);
      throw new RoomRegistryUnavailableError("placement reservation", {
        cause: error,
      });
    }
  }

  async claimRoom(input: {
    channelId: string;
    clientId: string;
    roomId: string;
  }): Promise<RoomOwnershipClaim> {
    try {
      return await this.claimOrRenew(input);
    } catch (error) {
      this.logTransientRedisFailure("claim room", input.channelId, error);
      throw new RoomRegistryUnavailableError("room claim", { cause: error });
    }
  }

  async renewRoom(input: {
    channelId: string;
    clientId: string;
    roomId: string;
  }): Promise<RoomOwnershipClaim> {
    try {
      return await this.claimOrRenew(input);
    } catch (error) {
      this.logTransientRedisFailure("renew room", input.channelId, error);
      const confirmedOwner = await this.localFallback.getOwner(input.channelId);
      if (
        confirmedOwner &&
        hasUsableLeaseDeadline(
          this.confirmedLeaseServeUntil.get(input.channelId),
          performance.now(),
        )
      ) {
        return { ok: true, owner: confirmedOwner };
      }
      throw new RoomLeaseExpiredError(input.channelId, { cause: error });
    }
  }

  async releaseRoom(channelId: string): Promise<void> {
    this.confirmedLeaseServeUntil.delete(channelId);
    await this.localFallback.releaseRoom(channelId);
    try {
      await this.start();
      await this.evalWithTimeout(RELEASE_SCRIPT, {
        keys: [this.keyFor(channelId)],
        arguments: [this.instanceId, this.instanceUrl ?? ""],
      });
    } catch (error) {
      this.logTransientRedisFailure("release room", channelId, error);
    }
  }

  isLocalOwner(owner: RoomAssignmentRecord | null | undefined): boolean {
    return Boolean(
      owner &&
        owner.instanceId === this.instanceId &&
        (owner.instanceUrl ?? "") === (this.instanceUrl ?? ""),
    );
  }

  private async claimOrRenew(input: {
    channelId: string;
    clientId: string;
    roomId: string;
  }): Promise<RoomOwnershipClaim> {
    await this.start();
    const now = Date.now();
    const owner = this.createOwner(input, now);
    const attemptStartedAt = performance.now();
    const result = await this.evalWithTimeout(CLAIM_OR_RENEW_SCRIPT, {
      keys: [this.keyFor(input.channelId)],
      arguments: [
        serializeAssignmentRecord(owner),
        this.instanceId,
        this.instanceUrl ?? "",
        String(this.ttlMs),
      ],
    });
    const ownership = parseClaimResult(result);
    if (ownership.ok) {
      this.localFallback.rememberOwner(ownership.owner);
      this.confirmedLeaseServeUntil.set(
        input.channelId,
        attemptStartedAt + this.ttlMs - this.leaseSafetyMarginMs,
      );
    }
    return ownership;
  }

  private logTransientRedisFailure(
    operation: string,
    channelId: string,
    error: unknown,
  ): void {
    if (isRedisTransientError(error)) {
      Logger.warn(`[RoomRegistry] Redis ${operation} failed for ${channelId}.`, error);
      return;
    }

    Logger.error(`[RoomRegistry] Redis ${operation} failed for ${channelId}`, error);
  }

  private async evalWithTimeout(
    script: string,
    options: { keys: string[]; arguments: string[] },
  ): Promise<unknown> {
    return this.runWithCommandTimeout((signal) =>
      this.client.withAbortSignal(signal).eval(script, options),
    );
  }

  private async getWithTimeout(key: string): Promise<string | null> {
    return this.runWithCommandTimeout((signal) =>
      this.client.withAbortSignal(signal).get(key),
    );
  }

  private async runWithCommandTimeout<T>(
    operation: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.commandTimeoutMs);
    try {
      return await operation(controller.signal);
    } finally {
      clearTimeout(timeout);
    }
  }

  private createOwner(
    input: {
      channelId: string;
      clientId: string;
      roomId: string;
    },
    now: number,
  ): RoomOwnerRecord {
    return {
      kind: "owner",
      channelId: input.channelId,
      clientId: input.clientId,
      roomId: input.roomId,
      instanceId: this.instanceId,
      ...(this.instanceUrl ? { instanceUrl: this.instanceUrl } : {}),
      ...(this.region ? { region: this.region } : {}),
      updatedAt: now,
      expiresAt: now + this.ttlMs,
    };
  }

  private keyFor(channelId: string): string {
    return `${this.keyPrefix}:${channelId}`;
  }

  private createPlacement(
    input: {
      channelId: string;
      clientId: string;
      roomId: string;
    },
    now: number,
  ): RoomPlacementRecord {
    return {
      kind: "placement",
      channelId: input.channelId,
      clientId: input.clientId,
      roomId: input.roomId,
      instanceId: this.instanceId,
      ...(this.instanceUrl ? { instanceUrl: this.instanceUrl } : {}),
      ...(this.region ? { region: this.region } : {}),
      updatedAt: now,
      expiresAt: now + this.placementTtlMs,
    };
  }
}

export const createRoomRegistry = (
  registryConfig: typeof defaultConfig = defaultConfig,
): RoomRegistry => {
  const instanceUrl = registryConfig.instancePublicUrl || undefined;
  if (!registryConfig.socket.redisUrl) {
    Logger.info("[RoomRegistry] Using local room ownership registry");
    return new LocalRoomRegistry({
      instanceId: registryConfig.instanceId,
      instanceUrl,
      region: registryConfig.region || undefined,
      ttlMs: registryConfig.roomRegistry.ttlMs,
    });
  }

  return new RedisRoomRegistry({
    redisUrl: registryConfig.socket.redisUrl,
    connectTimeoutMs: registryConfig.socket.redisConnectTimeoutMs,
    instanceId: registryConfig.instanceId,
    instanceUrl,
    region: registryConfig.region || undefined,
    keyPrefix: registryConfig.roomRegistry.keyPrefix,
    ttlMs: registryConfig.roomRegistry.ttlMs,
    renewIntervalMs: registryConfig.roomRegistry.renewIntervalMs,
  });
};
