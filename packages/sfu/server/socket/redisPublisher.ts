import { Buffer } from "node:buffer";

type RedisPublisherClient = {
  isOpen: boolean;
  isReady: boolean;
  publish: (channel: string, message: string | Buffer) => Promise<number>;
  connect: () => Promise<unknown>;
  destroy: () => void;
};

export type RedisPublisherHealth = {
  healthy: boolean;
  pending: number;
  pendingBytes: number;
  dropped: number;
  recovering: boolean;
};

type PublisherOptions = {
  timeoutMs?: number;
  maxPending?: number;
  maxPendingBytes?: number;
  reconnectDelayMs?: number;
  onFailure: (reason: string, health: RedisPublisherHealth) => void;
};

// redis-adapter intentionally does not await PUBLISH. Contain its rejections
// here, and discard stale broadcasts rather than replaying them after recovery.
export const guardRedisPublisher = <T extends RedisPublisherClient>(
  client: T,
  options: PublisherOptions,
) => {
  const timeoutMs = options.timeoutMs ?? 2500;
  const maxPending = options.maxPending ?? 64;
  const maxPendingBytes = options.maxPendingBytes ?? 8 * 1024 * 1024;
  let pending = 0;
  let pendingBytes = 0;
  let dropped = 0;
  let recovering = false;
  let closed = false;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let lastWarningAt = -Infinity;

  const health = (): RedisPublisherHealth => ({
    healthy: !closed && !recovering && client.isReady && pending < maxPending && pendingBytes < maxPendingBytes,
    pending,
    pendingBytes,
    dropped,
    recovering,
  });
  const warn = (reason: string) => {
    if (closed || Date.now() - lastWarningAt < 30_000) return;
    lastWarningAt = Date.now();
    options.onFailure(reason, health());
  };
  const scheduleRecovery = () => {
    if (closed || reconnectTimer) return;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      if (closed) return;
      void client.connect().then(() => {
        if (closed) {
          if (client.isOpen) client.destroy();
          return;
        }
        recovering = false;
      }).catch(() => {
        warn("reconnect failed");
        scheduleRecovery();
      });
    }, options.reconnectDelayMs ?? 250);
    reconnectTimer.unref?.();
  };
  const recover = () => {
    if (closed || recovering) return;
    recovering = true;
    // A command deadline alone leaves sent commands in Redis' reply queue.
    // Reset this dedicated publisher to release that queue and its buffers.
    if (client.isOpen) client.destroy();
    scheduleRecovery();
  };
  const publish = async (channel: string, message: string | Buffer): Promise<number> => {
    if (closed) return 0;
    const bytes = Buffer.byteLength(channel) + Buffer.byteLength(message);
    if (recovering || !client.isReady || pending >= maxPending || pendingBytes + bytes > maxPendingBytes) {
      dropped += 1;
      warn("publish capacity unavailable");
      return 0;
    }
    pending += 1;
    pendingBytes += bytes;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        client.publish(channel, message),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new Error("publish deadline exceeded")), timeoutMs);
          timer.unref?.();
        }),
      ]);
    } catch {
      dropped += 1;
      recover();
      warn("publish failed; resetting connection");
      return 0;
    } finally {
      clearTimeout(timer);
      pending -= 1;
      pendingBytes -= bytes;
    }
  };

  const guardedClient = new Proxy(client, {
    get(target, property) {
      if (property === "publish") return publish;
      const value: unknown = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) as unknown : value;
    },
  });
  return {
    client: guardedClient,
    health,
    close: () => {
      closed = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      reconnectTimer = null;
      if (client.isOpen) client.destroy();
    },
  };
};
