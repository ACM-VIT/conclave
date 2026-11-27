import {
  captureFatalServerException,
  captureServerException,
} from "./server/analytics/posthog.js";
import { installRedisCrashGuards } from "./server/redisErrors.js";

const FATAL_REPORT_TIMEOUT_MS = 2000;
const crashSource = (event: "unhandledRejection" | "uncaughtException") =>
  event === "unhandledRejection" ? "unhandled_rejection" : "uncaught_exception";

installRedisCrashGuards({
  onSuppressed: (error, event) =>
    captureServerException(error, {
      source: "redis_transient",
      level: "warning",
      properties: { process_event: event },
    }),
  onFatal: (error, event) =>
    captureFatalServerException(
      error,
      { source: crashSource(event) },
      FATAL_REPORT_TIMEOUT_MS,
    ),
});

// Everything that reads the SFU's configuration loads only now, after the
// crash guards, so a configuration that fails as it loads is reported too.
const { createSfuServer } = await import("./server/createSfuServer.js").catch(
  async (error: unknown) => {
    console.error("[SFU] Failed to start", error);
    await captureFatalServerException(
      error,
      { source: "startup_failed" },
      FATAL_REPORT_TIMEOUT_MS,
    );
    process.exit(1);
  },
);

const server = createSfuServer();
let shuttingDown = false;

server.start().catch((error) => {
  if (shuttingDown) return;
  console.error("[SFU] Failed to start", error);
  void captureFatalServerException(
    error,
    { source: "startup_failed" },
    FATAL_REPORT_TIMEOUT_MS,
  ).finally(() => process.exit(1));
});

// Graceful shutdown: on a termination signal, run the server's teardown
// (which closes sockets/workers AND flushes buffered product analytics) before
// the process exits, so no game events are lost on container stop / Ctrl-C.
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
