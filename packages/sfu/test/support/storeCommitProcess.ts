import { createRedisBackend } from "../../server/controlPlane/backends/redis.js";
import { createMeeting } from "../../server/controlPlane/meetingCommands.js";
import { StoreUnavailableError } from "../../server/controlPlane/model.js";
import { controlPlaneStore } from "../../server/controlPlane/store.js";

const [redisUrl, keyPrefix, requestDeadlineMs, title] = process.argv.slice(2);
const store = controlPlaneStore(
  await createRedisBackend({ redisUrl, keyPrefix, requestDeadlineMs: Number(requestDeadlineMs) }),
);
let outcome: string;
try {
  const result = await store.commit(
    createMeeting(
      { title, scheduledStartAt: 1_900_000_000_000 },
      { clientId: "conclave", createdBy: "host@example.test", defaultHostEmail: "host@example.test", defaultHostUserId: null },
    ),
  );
  outcome = result.ok ? "committed" : result.reason;
} catch (error) {
  outcome = error instanceof StoreUnavailableError ? "unavailable" : `failed ${String(error)}`;
}
process.stdout.write(`${outcome}\n`);
await store.close().catch(() => undefined);
process.exit(0);
