import { existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parentPort, workerData } from "node:worker_threads";
import {
  createAppDocumentEngine,
  type EngineOptions,
  type FromWorker,
  type Snapshot,
  type ToWorker,
} from "#app-documents/engine";

const crashedOnceFlag = join(tmpdir(), `conclave-app-document-crash-${process.pid}`);

const port = parentPort!;
const engine = createAppDocumentEngine(workerData as EngineOptions);
const forever = new Int32Array(new SharedArrayBuffer(4));

const holds = (bytes: Uint8Array | null, marker: string): boolean =>
  bytes !== null && Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).includes(marker);

const loads = (snapshot: Snapshot | null, marker: string): boolean =>
  snapshot !== null && [snapshot.base, ...snapshot.tail].some((bytes) => holds(bytes, marker));

const post = (reply: FromWorker, transfer: ArrayBuffer[]): void => port.postMessage(reply, transfer);

port.postMessage({ type: "ready" } satisfies FromWorker);

port.on("message", (message: ToWorker) => {
  if (message.type !== "run") {
    engine.handle(message, post);
    return;
  }
  if (loads(message.load, "SLOW-LOAD")) Atomics.wait(forever, 0, 0);
  if (loads(message.load, "CRASH-LOAD") && !existsSync(crashedOnceFlag)) {
    writeFileSync(crashedOnceFlag, "");
    process.exit(1);
  }
  let load = message.load;
  for (const [index, operation] of message.operations.entries()) {
    const update = operation.kind === "apply" ? operation.update : null;
    if (holds(update, "STALL")) Atomics.wait(forever, 0, 0);
    if (holds(update, "CRASH") && !holds(update, "CRASH-LOAD")) process.exit(1);
    if (holds(update, "PAUSE")) Atomics.wait(forever, 0, 0, 300);
    let stopped = false;
    engine.handle({ ...message, load, operations: [operation] }, (reply, transfer) => {
      if ((reply.type === "refused" && reply.evicted) || reply.type === "yielded") stopped = true;
      const late = holds(update, "LATE") && reply.type !== "loaded" && "elapsedMs" in reply;
      post(late ? { ...reply, elapsedMs: Number.MAX_SAFE_INTEGER } : reply, transfer);
    });
    load = null;
    if (stopped) return;
    if (holds(update, "YIELD") && index < message.operations.length - 1) {
      post({ type: "yielded" }, []);
      return;
    }
  }
});
