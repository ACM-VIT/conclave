import { describe, expect, it } from "vitest";
import {
  LocalRoomRegistry,
  hasUsableConfirmedLease,
  hasUsableLeaseDeadline,
  roomLeaseSafetyMarginMs,
  type RoomOwnerRecord,
} from "../server/roomRegistry.js";

const ROOM = {
  channelId: "conclave:room-1",
  clientId: "conclave",
  roomId: "room-1",
};

describe("room placement registry", () => {
  it("returns one immutable reservation to concurrent first joins", async () => {
    let now = 1_000;
    const registry = new LocalRoomRegistry({
      instanceId: "sfu-a",
      instanceUrl: "https://sfu-a.example",
      region: "me-central",
      ttlMs: 45_000,
      placementTtlMs: 20_000,
      now: () => now++,
    });

    const results = await Promise.all(
      Array.from({ length: 32 }, () => registry.reservePlacement(ROOM)),
    );

    expect(results.every((result) => result.ok)).toBe(true);
    expect(
      new Set(
        results.map((result) =>
          result.ok
            ? `${result.placement.instanceId}:${result.placement.updatedAt}`
            : "lost",
        ),
      ),
    ).toEqual(new Set(["sfu-a:1000"]));
    await expect(registry.getPlacement(ROOM.channelId)).resolves.toMatchObject({
      kind: "placement",
      instanceId: "sfu-a",
      region: "me-central",
      expiresAt: 21_000,
    });
  });

  it("lets an abandoned reservation expire without claiming room ownership", async () => {
    let now = 1_000;
    const registry = new LocalRoomRegistry({
      instanceId: "sfu-a",
      instanceUrl: "https://sfu-a.example",
      ttlMs: 45_000,
      placementTtlMs: 5_000,
      now: () => now,
    });

    const first = await registry.reservePlacement(ROOM);
    expect(first.ok).toBe(true);
    now = 6_001;
    await expect(registry.getPlacement(ROOM.channelId)).resolves.toBeNull();

    const second = await registry.reservePlacement(ROOM);
    expect(second).toMatchObject({
      ok: true,
      placement: { updatedAt: 6_001, expiresAt: 11_001 },
    });
    await expect(registry.getOwner(ROOM.channelId)).resolves.toBeNull();
  });

  it("prevents a non-selected instance from converting placement into ownership", async () => {
    const registry = new LocalRoomRegistry({
      instanceId: "sfu-b",
      instanceUrl: "https://sfu-b.example",
      ttlMs: 45_000,
      now: () => 1_000,
    });
    registry.rememberPlacement({
      kind: "placement",
      ...ROOM,
      instanceId: "sfu-a",
      instanceUrl: "https://sfu-a.example",
      region: "me-central",
      updatedAt: 1_000,
      expiresAt: 21_000,
    });

    await expect(registry.claimRoom(ROOM)).resolves.toMatchObject({
      ok: false,
      owner: { kind: "placement", instanceId: "sfu-a" },
    });
  });

  it("uses the direct instance URL to fence duplicate instance IDs", async () => {
    const registry = new LocalRoomRegistry({
      instanceId: "duplicate-id",
      instanceUrl: "https://sfu-b.example",
      ttlMs: 45_000,
      now: () => 1_000,
    });
    registry.rememberPlacement({
      kind: "placement",
      ...ROOM,
      instanceId: "duplicate-id",
      instanceUrl: "https://sfu-a.example",
      updatedAt: 1_000,
      expiresAt: 21_000,
    });

    await expect(registry.claimRoom(ROOM)).resolves.toMatchObject({
      ok: false,
      owner: { instanceUrl: "https://sfu-a.example" },
    });
  });
});

describe("confirmed room lease fencing", () => {
  const owner: RoomOwnerRecord = {
    kind: "owner",
    ...ROOM,
    instanceId: "sfu-a",
    instanceUrl: "https://sfu-a.example",
    updatedAt: 1_000,
    expiresAt: 46_000,
  };

  it("keeps an existing room only inside its last confirmed Redis lease", () => {
    expect(hasUsableConfirmedLease(owner, 20_000, 15_000)).toBe(true);
    expect(hasUsableConfirmedLease(owner, 31_000, 15_000)).toBe(false);
  });

  it("fences the old room before an outage can outlive the Redis TTL", () => {
    expect(hasUsableConfirmedLease(owner, 45_999, 0)).toBe(true);
    expect(hasUsableConfirmedLease(owner, 46_000, 0)).toBe(false);
  });

  it("leaves at least one renewal cadence between local fencing and Redis expiry", () => {
    const safetyMarginMs = roomLeaseSafetyMarginMs(45_000, 15_000);
    expect(safetyMarginMs).toBe(30_000);
    expect(hasUsableConfirmedLease(owner, 15_999, safetyMarginMs)).toBe(true);
    expect(hasUsableConfirmedLease(owner, 16_000, safetyMarginMs)).toBe(false);
  });

  it("uses a monotonic deadline so wall-clock adjustments cannot extend a lease", () => {
    expect(hasUsableLeaseDeadline(30_000, 29_999)).toBe(true);
    expect(hasUsableLeaseDeadline(30_000, 30_000)).toBe(false);
    expect(hasUsableLeaseDeadline(undefined, 1)).toBe(false);
  });
});
