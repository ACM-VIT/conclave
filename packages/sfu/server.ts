import { createSfuServer } from "./server/createSfuServer.js";
import { installRedisCrashGuards } from "./server/redisErrors.js";

installRedisCrashGuards();

const server = createSfuServer();

server.start().catch((error) => {
  console.error("[SFU] Failed to start", error);
  process.exit(1);
});
