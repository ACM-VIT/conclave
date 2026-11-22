import { workerData } from "node:worker_threads";

const { gate } = workerData as { gate: Int32Array };
Atomics.wait(gate, 0, 0);
await import(new URL("../../server/apps/documents/worker.ts", import.meta.url).href);
