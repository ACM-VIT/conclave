import { createClient } from "redis";
import { describe, expect, it } from "vitest";
import { createRedisBackend } from "../server/controlPlane/backends/redis.js";
import { createMeeting, meetingByRoomCode } from "../server/controlPlane/meetingCommands.js";
import { StoreUnavailableError, tags } from "../server/controlPlane/model.js";
import { openControlPlane, resolveControlPlaneConfig } from "../server/controlPlane/open.js";
import { controlPlaneStore } from "../server/controlPlane/store.js";
import { hasRedis, startRedis } from "./support/redisServer.js";

describe.skipIf(!hasRedis)("Redis rejects control-plane writes atomically", () => {
  it("refuses to open with incomplete write permissions without initializing the store", async () => {
    const redis = await startRedis(7340);
    const admin = createClient({ url: redis.url });
    try {
      await admin.connect();
      await admin.sendCommand(["ACL", "SETUSER", "default", "-sadd"]);
      const config = resolveControlPlaneConfig({
        CONTROL_PLANE_PERSISTENCE: "redis",
        SFU_PERSISTENCE_REDIS_URL: redis.url,
        SFU_PERSISTENCE_REDIS_KEY_PREFIX: "refusal-startup",
      });
      await expect(openControlPlane(config)).rejects.toThrow("Redis control-plane write permissions could not be verified");
      expect(await admin.dbSize()).toBe(0);
      await admin.sendCommand(["ACL", "SETUSER", "default", "+sadd"]);
      const store = await openControlPlane(config);
      try {
        expect(await store.read((view) => view.all("legacyImport"))).toHaveLength(1);
      } finally {
        await store.close();
      }
    } finally {
      if (admin.isOpen) await admin.close();
      redis.stop();
    }
  });

  it.each(["denied tag command", "wrong tag key type"])("does not persist a rejected meeting with a %s", async (refusal) => {
    const redis = await startRedis(7340);
    const admin = createClient({ url: redis.url });
    try {
      await admin.connect();
      const backend = await createRedisBackend({ redisUrl: redis.url, keyPrefix: "refusal" });
      const { keys } = backend;
      const store = controlPlaneStore(backend);
      try {
        const create = (roomCode: string) => createMeeting(
          { title: roomCode, roomCode, scheduledStartAt: Date.now() + 60_000 },
          { clientId: "conclave", createdBy: "host", defaultHostEmail: "host@example.test", defaultHostUserId: null },
        );
        expect((await store.commit(create("existing"))).ok).toBe(true);
        const tag = keys.tag("meeting", tags.meetingCode("conclave", "rejected"));
        if (refusal === "denied tag command") {
          await admin.sendCommand(["ACL", "SETUSER", "default", "-sadd"]);
        } else {
          await admin.set(tag, "unexpected type");
        }
        const snapshot = async () => Promise.all([
          admin.get(keys.rev),
          admin.hGetAll(keys.records.meeting),
          admin.hGetAll(keys.unique),
          admin.hGetAll(keys.ver),
          admin.hGetAll(keys.tomb),
          admin.sMembers(keys.tag("meeting", tags.activeMeetings)),
        ]);
        const before = await snapshot();
        await expect(store.commit(create("rejected"))).rejects.toBeInstanceOf(StoreUnavailableError);
        expect(await snapshot()).toEqual(before);

        if (refusal === "denied tag command") {
          await admin.sendCommand(["ACL", "SETUSER", "default", "+sadd"]);
        } else {
          expect(await admin.get(tag)).toBe("unexpected type");
          await admin.del(tag);
        }
        const accepted = await store.commit(create("rejected"));
        expect(accepted.ok).toBe(true);
        if (!accepted.ok) return;
        expect(await store.read(meetingByRoomCode("conclave", "rejected"))).toEqual(accepted.value);
        expect(await admin.sMembers(keys.tag("meeting", tags.activeMeetings))).toContain(accepted.value.id);
      } finally {
        await store.close();
      }
    } finally {
      if (admin.isOpen) await admin.close();
      redis.stop();
    }
  });
});
