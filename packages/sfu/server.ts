import { createSfuServer } from "./server/createSfuServer.js";
import { installRedisCrashGuards } from "./server/redisErrors.js";

installRedisCrashGuards();

const server = createSfuServer();

server.start().catch((error) => {
  console.error("[SFU] Failed to start", error);
  process.exit(1);
});

// Graceful shutdown: on a termination signal, run the server's teardown
// (which closes sockets/workers AND flushes buffered product analytics) before
// the process exits, so no game events are lost on container stop / Ctrl-C.
let shuttingDown = false;
const shutdown = (signal: NodeJS.Signals): void => {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[SFU] Received ${signal}, shutting down gracefully...`);

  // Hard safety valve: never let a hung close wedge the process indefinitely.
  const forceExitTimer = setTimeout(() => {
    console.error("[SFU] Graceful shutdown timed out; forcing exit.");
    process.exit(1);
  }, 15000);
  if (forceExitTimer.unref) forceExitTimer.unref();

  server
    .stop()
    .then(() => {
      clearTimeout(forceExitTimer);
      process.exit(0);
    })
    .catch((error) => {
      clearTimeout(forceExitTimer);
      console.error("[SFU] Error during graceful shutdown", error);
      process.exit(1);
    });
};

process.once("SIGTERM", () => shutdown("SIGTERM"));
process.once("SIGINT", () => shutdown("SIGINT"));
