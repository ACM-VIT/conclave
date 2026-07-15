import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { config } from "../config/config.js";
import { createSfuApp } from "../server/http/createApp.js";
import {
  LocalRoomRegistry,
  type RoomAssignmentRecord,
  type RoomOwnerRecord,
  type RoomPlacementRecord,
  type RoomRegistry,
} from "../server/roomRegistry.js";
import { createSfuState } from "../server/state.js";

const servers: Server[] = [];

class SharedTestRoomRegistry implements RoomRegistry {
  mode = "redis" as const;

  constructor(
    readonly instanceId: string,
    readonly instanceUrl: string,
    private readonly assignments: Map<string, RoomAssignmentRecord>,
  ) {}

  async start(): Promise<void> {}
  async close(): Promise<void> {}

  async getOwner(channelId: string): Promise<RoomOwnerRecord | null> {
    const assignment = this.assignments.get(channelId);
    return assignment?.kind === "placement" ? null : assignment ?? null;
  }

  async getPlacement(channelId: string): Promise<RoomPlacementRecord | null> {
    const assignment = this.assignments.get(channelId);
    return assignment?.kind === "placement" ? assignment : null;
  }

  async getAssignment(channelId: string): Promise<RoomAssignmentRecord | null> {
    return this.assignments.get(channelId) ?? null;
  }

  async reservePlacement(input: {
    channelId: string;
    clientId: string;
    roomId: string;
  }) {
    const existing = this.assignments.get(input.channelId);
    if (existing) {
      return existing.kind === "placement" && this.isLocalOwner(existing)
        ? { ok: true as const, placement: existing }
        : { ok: false as const, assignment: existing };
    }
    const now = Date.now();
    const placement: RoomPlacementRecord = {
      kind: "placement",
      ...input,
      instanceId: this.instanceId,
      instanceUrl: this.instanceUrl,
      updatedAt: now,
      expiresAt: now + 20_000,
    };
    // There is no await between the shared read and write. This models the
    // single Redis Lua critical section used by production reservations.
    this.assignments.set(input.channelId, placement);
    return { ok: true as const, placement };
  }

  async claimRoom(): Promise<never> {
    throw new Error("not used in placement HTTP tests");
  }

  async renewRoom(): Promise<never> {
    throw new Error("not used in placement HTTP tests");
  }

  async releaseRoom(channelId: string): Promise<void> {
    const assignment = this.assignments.get(channelId);
    if (this.isLocalOwner(assignment)) {
      this.assignments.delete(channelId);
    }
  }

  isLocalOwner(owner: RoomAssignmentRecord | null | undefined): boolean {
    return Boolean(
      owner &&
        owner.instanceId === this.instanceId &&
        owner.instanceUrl === this.instanceUrl,
    );
  }
}

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()));
        }),
    ),
  );
});

const startPlacementApp = async (options?: {
  draining?: boolean;
  registry?: RoomRegistry;
}) => {
  const registry =
    options?.registry ??
    new LocalRoomRegistry({
      instanceId: "sfu-a",
      instanceUrl: "https://sfu-a.example",
      region: "me-central",
      ttlMs: 45_000,
    });
  const state = createSfuState({
    isDraining: options?.draining,
    roomRegistry: registry,
  });
  const app = createSfuApp({ state, config });
  const server = createServer(app);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Placement test server did not bind a TCP port");
  }
  return {
    state,
    registry,
    url: `http://127.0.0.1:${address.port}`,
  };
};

const reserve = (url: string, roomId = "room-1") =>
  fetch(`${url}/routing/placements/conclave/${roomId}`, {
    method: "POST",
    headers: { "x-sfu-secret": config.sfuSecret },
  });

describe("room placement HTTP API", () => {
  it("advertises atomic placement support before web clients call the endpoint", async () => {
    const { url } = await startPlacementApp();
    const response = await fetch(`${url}/status`, {
      headers: { "x-sfu-secret": config.sfuSecret },
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      capabilities: { roomPlacement: 1 },
    });
  });

  it("returns the same bounded assignment to concurrent first joins", async () => {
    const { url } = await startPlacementApp();
    const responses = await Promise.all(
      Array.from({ length: 16 }, () => reserve(url)),
    );
    expect(responses.every((response) => response.status === 200)).toBe(true);
    const payloads = (await Promise.all(
      responses.map((response) => response.json()),
    )) as Array<{
      registryMode: string;
      assignment: { instanceId: string; expiresAt: number };
    }>;

    expect(new Set(payloads.map((payload) => payload.registryMode))).toEqual(
      new Set(["local"]),
    );
    expect(
      new Set(
        payloads.map(
          (payload) =>
            `${payload.assignment.instanceId}:${payload.assignment.expiresAt}`,
        ),
      ),
    ).toHaveLength(1);
  });

  it("converges concurrent first joins from different regional candidates", async () => {
    const assignments = new Map<string, RoomAssignmentRecord>();
    const a = await startPlacementApp({
      registry: new SharedTestRoomRegistry(
        "sfu-a",
        "https://sfu-a.example",
        assignments,
      ),
    });
    const b = await startPlacementApp({
      registry: new SharedTestRoomRegistry(
        "sfu-b",
        "https://sfu-b.example",
        assignments,
      ),
    });

    const responses = await Promise.all([
      ...Array.from({ length: 8 }, () => reserve(a.url)),
      ...Array.from({ length: 8 }, () => reserve(b.url)),
    ]);
    const payloads = (await Promise.all(
      responses.map((response) => response.json()),
    )) as Array<{ assignment: { instanceId: string; instanceUrl: string } }>;

    expect(responses.every((response) => response.status === 200)).toBe(true);
    expect(
      new Set(
        payloads.map(
          ({ assignment }) =>
            `${assignment.instanceId}:${assignment.instanceUrl}`,
        ),
      ).size,
    ).toBe(1);
  });

  it("refuses to place a new room on a draining instance", async () => {
    const { url, registry } = await startPlacementApp({ draining: true });
    const response = await reserve(url);

    expect(response.status).toBe(409);
    await expect(registry.getAssignment("conclave:room-1")).resolves.toBeNull();
  });

  it("fails closed when the shared reservation operation is degraded", async () => {
    const registry = new LocalRoomRegistry({
      instanceId: "sfu-a",
      instanceUrl: "https://sfu-a.example",
      ttlMs: 45_000,
    });
    registry.reservePlacement = async () => {
      throw new Error("simulated registry outage");
    };
    const { url } = await startPlacementApp({ registry });
    const response = await reserve(url);

    expect(response.status).toBe(503);
    expect(response.headers.get("retry-after")).toBe("2");
  });

  it("reserves a webinar link slug against its canonical room channel", async () => {
    const { url, state, registry } = await startPlacementApp();
    state.webinarLinks.set("public-room", {
      roomChannelId: "conclave:canonical-room",
      roomId: "canonical-room",
      clientId: "conclave",
    });

    const response = await reserve(url, "public-room");
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      requestedRoomId: "public-room",
      roomId: "canonical-room",
      channelId: "conclave:canonical-room",
      assignment: { kind: "placement", roomId: "canonical-room" },
    });
    await expect(
      registry.getPlacement("conclave:canonical-room"),
    ).resolves.toMatchObject({ roomId: "canonical-room" });
    await expect(
      registry.getPlacement("conclave:public-room"),
    ).resolves.toBeNull();
  });
});
