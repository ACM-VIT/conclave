import { afterEach, describe, expect, it, vi } from "vitest";
import { guardRedisPublisher } from "../server/socket/redisPublisher.js";

const fixture = (options: { maxPending?: number; maxPendingBytes?: number } = {}) => {
  const client = {
    isOpen: true,
    isReady: true,
    publish: vi.fn<(channel: string, message: string | Buffer) => Promise<number>>().mockResolvedValue(2),
    connect: vi.fn(async () => { client.isOpen = true; client.isReady = true; }),
    destroy: vi.fn(() => { client.isOpen = false; client.isReady = false; }),
  };
  const onFailure = vi.fn();
  const guard = guardRedisPublisher(client, { ...options, onFailure, timeoutMs: 100 });
  return { client, guard, onFailure };
};

afterEach(() => vi.useRealTimers());

describe("Socket.IO Redis publisher", () => {
  it("bounds a synchronous burst while commands are stalled, without unhandled rejections", async () => {
    vi.useFakeTimers();
    const { client, guard, onFailure } = fixture({ maxPending: 4 });
    client.publish.mockImplementation(() => new Promise(() => {}));
    const sends = Array.from({ length: 1000 }, () => guard.client.publish("room", "packet"));
    expect(client.publish).toHaveBeenCalledTimes(4);
    expect(guard.health()).toMatchObject({ pending: 4, dropped: 996, healthy: false });
    expect(onFailure).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(100);
    expect(await Promise.all(sends)).toEqual(Array(1000).fill(0));
    expect(guard.health()).toMatchObject({ pending: 0, pendingBytes: 0, recovering: true });
    expect(client.destroy).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(250);
    expect(client.connect).toHaveBeenCalledTimes(1);
    client.publish.mockResolvedValue(2);
    expect(await guard.client.publish("room", "fresh")).toBe(2);
    expect(guard.health().healthy).toBe(true);
    guard.close();
  });

  it("also bounds retained bytes, including multibyte strings and binary packets", async () => {
    vi.useFakeTimers();
    const { client, guard } = fixture({ maxPendingBytes: 12 });
    client.publish.mockImplementation(() => new Promise(() => {}));
    const first = guard.client.publish("r", "☃☃☃");
    expect(await guard.client.publish("r", Buffer.alloc(3))).toBe(0);
    expect(client.publish).toHaveBeenCalledTimes(1);
    expect(guard.health().pendingBytes).toBe(10);
    await vi.advanceTimersByTimeAsync(100);
    await first;
    guard.close();
  });

  it("contains asynchronous and synchronous publish failures and reconnects once", async () => {
    vi.useFakeTimers();
    const { client, guard, onFailure } = fixture();
    client.publish.mockRejectedValueOnce(new Error("The queue is full"));
    expect(await guard.client.publish("room", "packet")).toBe(0);
    expect(await guard.client.publish("room", "while reconnecting")).toBe(0);
    expect(onFailure).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(250);
    client.publish.mockImplementationOnce(() => { throw new Error("socket closed"); });
    expect(await guard.client.publish("room", "next")).toBe(0);
    expect(guard.health().pending).toBe(0);
    guard.close();
  });

  it("does not queue packets while Redis is offline", async () => {
    const { client, guard } = fixture();
    client.isReady = false;
    expect(await guard.client.publish("room", "packet")).toBe(0);
    expect(client.publish).not.toHaveBeenCalled();
    guard.close();
  });

  it("cancels reconnects when the SFU stops", async () => {
    vi.useFakeTimers();
    const { client, guard } = fixture();
    client.publish.mockRejectedValueOnce(new Error("closed"));
    await guard.client.publish("room", "packet");
    guard.close();
    await vi.advanceTimersByTimeAsync(1000);
    expect(client.connect).not.toHaveBeenCalled();
    expect(await guard.client.publish("room", "after shutdown")).toBe(0);
  });

  it("keeps retrying after a failed reconnect without replaying discarded packets", async () => {
    vi.useFakeTimers();
    const { client, guard } = fixture();
    client.publish.mockRejectedValueOnce(new Error("closed"));
    client.connect.mockRejectedValueOnce(new Error("offline"));
    await guard.client.publish("room", "old");
    await vi.advanceTimersByTimeAsync(500);
    expect(client.connect).toHaveBeenCalledTimes(2);
    expect(guard.health().healthy).toBe(true);
    expect(client.publish).toHaveBeenCalledTimes(1);
    guard.close();
  });
});
