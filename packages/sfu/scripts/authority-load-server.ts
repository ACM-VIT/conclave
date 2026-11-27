/**
 * A real SFU for the authority load measurement. It runs the same server as
 * `server.ts` with authority apps on, and reports its own event-loop delay
 * and CPU over IPC. Started by measure-authority-load.ts.
 */
import { monitorEventLoopDelay, performance } from "node:perf_hooks";
import { createAppsAuthorityRuntime } from "../server/apps/authority/index.js";
import { createSfuServer } from "../server/createSfuServer.js";

// The registry's own modules: Polls and Q&A, as a deployed SFU runs them.
const server = createSfuServer();
server.state.appsAuthority = createAppsAuthorityRuntime();

const delay = monitorEventLoopDelay({ resolution: 5 });
let cpu = process.cpuUsage();
let utilization = performance.eventLoopUtilization();
let startedAt = performance.now();

const toMs = (nanoseconds: number): number =>
  Math.round(nanoseconds / 10_000) / 100;

process.on("message", (message) => {
  if (message === "reset") {
    delay.reset();
    delay.enable();
    cpu = process.cpuUsage();
    utilization = performance.eventLoopUtilization();
    startedAt = performance.now();
    process.send?.({ type: "reset" });
    return;
  }
  if (message === "report") {
    const used = process.cpuUsage(cpu);
    const seconds = (performance.now() - startedAt) / 1000;
    process.send?.({
      type: "report",
      seconds,
      // The histogram's floor is its own 5 ms sampling interval.
      eventLoopDelayMs: {
        min: toMs(delay.min),
        mean: toMs(delay.mean),
        p50: toMs(delay.percentile(50)),
        p99: toMs(delay.percentile(99)),
        max: toMs(delay.max),
      },
      eventLoopUtilization:
        Math.round(performance.eventLoopUtilization(utilization).utilization * 1000) /
        1000,
      cpuPercentOfOneCore:
        Math.round(((used.user + used.system) / 1000 / (seconds * 1000)) * 1000) / 10,
      rooms: [...server.state.rooms.values()].map((room) => ({
        id: room.id,
        clients: room.clients.size,
      })),
    });
    return;
  }
  if (message === "stop") {
    void server.stop().finally(() => process.exit(0));
  }
});

server
  .start()
  .then(() => process.send?.({ type: "ready" }))
  .catch((error: unknown) => {
    console.error("[load] SFU failed to start", error);
    process.exit(1);
  });
