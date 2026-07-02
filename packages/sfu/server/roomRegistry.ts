import { createClient, type RedisClientType } from "redis";
import { config as defaultConfig } from "../config/config.js";
import { Logger } from "../utilities/loggers.js";
import { isRedisTransientError } from "./redisErrors.js";

export type RoomOwnerRecord = {
  channelId: string;
  clientId: string;
  roomId: string;
  instanceId: string;
  instanceUrl?: string;
  updatedAt: number;
  expiresAt: number;
};

export type RoomOwnershipClaim =
  | { ok: true; owner: RoomOwnerRecord }
  | { ok: false; owner: RoomOwnerRecord };

export class RoomOwnershipError extends Error {
  owner: RoomOwnerRecord;

  constructor(owner: RoomOwnerRecord) {
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
  isLocalOwner: (owner: RoomOwnerRecord | null | undefined) => boolean;
};

const CLAIM_OR_RENEW_SCRIPT = `
local key = KEYS[1]
local value = ARGV[1]
local instanceId = ARGV[2]
local nowMs = tonumber(ARGV[3])
local ttlMs = tonumber(ARGV[4])
local current = redis.call("GET", key)
if current then
  local ok, decoded = pcall(cjson.decode, current)
  if ok and decoded and decoded.instanceId and decoded.instanceId ~= instanceId then
    local expiresAt = tonumber(decoded.expiresAt or 0) or 0
    if expiresAt > nowMs then
      return {0, current}
    end
  end
end
redis.call("PSETEX", key, ttlMs, value)
return {1, value}
`;

const RELEASE_SCRIPT = `
local key = KEYS[1]
local instanceId = ARGV[1]
local current = redis.call("GET", key)
if not current then
  return 0
end
local ok, decoded = pcall(cjson.decode, current)
if ok and decoded and decoded.instanceId == instanceId then
  redis.call("DEL", key)
  return 1
end
return 0
`;

const isFiniteTimestamp = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);

const parseOwnerRecord = (value: unknown): RoomOwnerRecord | null => {
  if (typeof value !== "string" || !value) {
    return null;
  }

  try {
    const parsed = JSON.parse(value) as Partial<RoomOwnerRecord>;
    if (
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
      channelId: parsed.channelId,
      clientId: parsed.clientId,
      roomId: parsed.roomId,
      instanceId: parsed.instanceId,
      ...(typeof parsed.instanceUrl === "string" && parsed.instanceUrl.trim()
        ? { instanceUrl: parsed.instanceUrl.trim() }
        : {}),
      updatedAt: parsed.updatedAt,
      expiresAt: parsed.expiresAt,
    };
  } catch {
    return null;
  }
};

const serializeOwnerRecord = (record: RoomOwnerRecord): string =>
  JSON.stringify(record);

const parseClaimResult = (value: unknown): RoomOwnershipClaim => {
  if (!Array.isArray(value) || value.length < 2) {
    throw new Error("Invalid room registry response");
  }

  const entries: readonly unknown[] = value;
  const okValue = entries[0];
  const owner = parseOwnerRecord(entries[1]);
  if (!owner) {
    throw new Error("Invalid room owner record");
  }

  return okValue === 1 || okValue === "1"
    ? { ok: true, owner }
    : { ok: false, owner };
};

class LocalRoomRegistry implements RoomRegistry {
  mode = "local" as const;
  instanceId: string;
  instanceUrl?: string;
  private owners = new Map<string, RoomOwnerRecord>();
  private ttlMs: number;

  constructor(options: {
    instanceId: string;
    instanceUrl?: string;
    ttlMs: number;
  }) {
    this.instanceId = options.instanceId;
    this.instanceUrl = options.instanceUrl || undefined;
    this.ttlMs = options.ttlMs;
  }

  async start(): Promise<void> {}

  async close(): Promise<void> {
    this.owners.clear();
  }

  async getOwner(channelId: string): Promise<RoomOwnerRecord | null> {
    const owner = this.owners.get(channelId);
    if (!owner) {
      return null;
    }
    if (owner.expiresAt <= Date.now()) {
      this.owners.delete(channelId);
      return null;
    }
    return owner;
  }

  async claimRoom(input: {
    channelId: string;
    clientId: string;
    roomId: string;
  }): Promise<RoomOwnershipClaim> {
    const owner = this.createOwner(input);
    this.owners.set(input.channelId, owner);
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

  isLocalOwner(owner: RoomOwnerRecord | null | undefined): boolean {
    return owner?.instanceId === this.instanceId;
  }

  private createOwner(input: {
    channelId: string;
    clientId: string;
    roomId: string;
  }): RoomOwnerRecord {
    const now = Date.now();
    return {
      channelId: input.channelId,
      clientId: input.clientId,
      roomId: input.roomId,
      instanceId: this.instanceId,
      ...(this.instanceUrl ? { instanceUrl: this.instanceUrl } : {}),
      updatedAt: now,
      expiresAt: now + this.ttlMs,
    };
  }
}

class RedisRoomRegistry implements RoomRegistry {
  mode = "redis" as const;
  instanceId: string;
  instanceUrl?: string;
  private client: RedisClientType;
  private localFallback: LocalRoomRegistry;
  private keyPrefix: string;
  private ttlMs: number;
  private startPromise: Promise<void> | null = null;
  private started = false;

  constructor(options: {
    redisUrl: string;
    connectTimeoutMs: number;
    instanceId: string;
    instanceUrl?: string;
    keyPrefix: string;
    ttlMs: number;
  }) {
    this.instanceId = options.instanceId;
    this.instanceUrl = options.instanceUrl || undefined;
    this.keyPrefix = options.keyPrefix.replace(/:+$/, "");
    this.ttlMs = options.ttlMs;
    this.localFallback = new LocalRoomRegistry({
      instanceId: options.instanceId,
      instanceUrl: options.instanceUrl,
      ttlMs: options.ttlMs,
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
      const value = await this.client.get(this.keyFor(channelId));
      const owner = parseOwnerRecord(value);
      if (!owner) {
        return this.localFallback.getOwner(channelId);
      }
      if (owner.expiresAt <= Date.now()) {
        return this.localFallback.getOwner(channelId);
      }
      return owner;
    } catch (error) {
      this.logTransientRedisFailure("get owner", channelId, error);
      return this.localFallback.getOwner(channelId);
    }
  }

  async claimRoom(input: {
    channelId: string;
    clientId: string;
    roomId: string;
  }): Promise<RoomOwnershipClaim> {
    return this.claimOrRenew(input);
  }

  async renewRoom(input: {
    channelId: string;
    clientId: string;
    roomId: string;
  }): Promise<RoomOwnershipClaim> {
    return this.claimOrRenew(input);
  }

  async releaseRoom(channelId: string): Promise<void> {
    await this.localFallback.releaseRoom(channelId);
    try {
      await this.start();
      await this.client.eval(RELEASE_SCRIPT, {
        keys: [this.keyFor(channelId)],
        arguments: [this.instanceId],
      });
    } catch (error) {
      this.logTransientRedisFailure("release room", channelId, error);
    }
  }

  isLocalOwner(owner: RoomOwnerRecord | null | undefined): boolean {
    return owner?.instanceId === this.instanceId;
  }

  private async claimOrRenew(input: {
    channelId: string;
    clientId: string;
    roomId: string;
  }): Promise<RoomOwnershipClaim> {
    try {
      await this.start();
      const now = Date.now();
      const owner = this.createOwner(input, now);
      const result = await this.client.eval(CLAIM_OR_RENEW_SCRIPT, {
        keys: [this.keyFor(input.channelId)],
        arguments: [
          serializeOwnerRecord(owner),
          this.instanceId,
          String(now),
          String(this.ttlMs),
        ],
      });
      const ownership = parseClaimResult(result);
      if (ownership.ok) {
        await this.localFallback.renewRoom(input);
      }
      return ownership;
    } catch (error) {
      this.logTransientRedisFailure("claim/renew room", input.channelId, error);
      return this.localFallback.claimRoom(input);
    }
  }

  private logTransientRedisFailure(
    operation: string,
    channelId: string,
    error: unknown,
  ): void {
    if (isRedisTransientError(error)) {
      Logger.warn(
        `[RoomRegistry] Redis ${operation} failed for ${channelId}; using local fallback.`,
        error,
      );
      return;
    }

    Logger.error(`[RoomRegistry] Redis ${operation} failed for ${channelId}`, error);
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
      channelId: input.channelId,
      clientId: input.clientId,
      roomId: input.roomId,
      instanceId: this.instanceId,
      ...(this.instanceUrl ? { instanceUrl: this.instanceUrl } : {}),
      updatedAt: now,
      expiresAt: now + this.ttlMs,
    };
  }

  private keyFor(channelId: string): string {
    return `${this.keyPrefix}:${channelId}`;
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
      ttlMs: registryConfig.roomRegistry.ttlMs,
    });
  }

  return new RedisRoomRegistry({
    redisUrl: registryConfig.socket.redisUrl,
    connectTimeoutMs: registryConfig.socket.redisConnectTimeoutMs,
    instanceId: registryConfig.instanceId,
    instanceUrl,
    keyPrefix: registryConfig.roomRegistry.keyPrefix,
    ttlMs: registryConfig.roomRegistry.ttlMs,
  });
};
