import { parentPort, workerData } from "node:worker_threads";
import {
  createAppDocumentEngine,
  type EngineOptions,
  type FromWorker,
  type Snapshot,
  type ToWorker,
} from "#app-documents/engine";

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
  let load = message.load;
  for (const operation of message.operations) {
    if (operation.kind === "apply" && holds(operation.update, "STALL")) Atomics.wait(forever, 0, 0);
    if (operation.kind === "apply" && holds(operation.update, "CRASH")) process.exit(1);
    if (operation.kind === "apply" && holds(operation.update, "PAUSE")) Atomics.wait(forever, 0, 0, 300);
    let evicted = false;
    engine.handle({ ...message, load, operations: [operation] }, (reply, transfer) => {
      if (reply.type === "refused" && reply.evicted) evicted = true;
      post(reply, transfer);
    });
    load = null;
    if (evicted) return;
  }
});
