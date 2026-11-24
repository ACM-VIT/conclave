import { BroadcastChannel, parentPort, workerData } from "node:worker_threads";
import {
  createAppDocumentEngine,
  type EngineOptions,
  type FromWorker,
  type Snapshot,
  type ToWorker,
} from "#app-documents/engine";

type FixtureData = EngineOptions & { gate?: Int32Array; channel?: string };

const RELEASED = 0;
const TICKETS = 1;
const LOAD_CRASHES = 2;

const port = parentPort!;
const { gate, channel: channelName, ...options } = workerData as FixtureData;
const engine = createAppDocumentEngine(options);
const forever = new Int32Array(new SharedArrayBuffer(4));
const channel = channelName ? new BroadcastChannel(channelName) : null;
channel?.unref();

const tell = (event: string, detail: Record<string, unknown> = {}): void => {
  channel?.postMessage({ event, ...detail });
};

const holdUntilReleased = (marker: string): void => {
  if (!gate) throw new Error(`${marker} needs a gate`);
  const ticket = Atomics.add(gate, TICKETS, 1);
  tell("held", { ticket });
  for (let released = Atomics.load(gate, RELEASED); released <= ticket; released = Atomics.load(gate, RELEASED)) {
    Atomics.wait(gate, RELEASED, released);
  }
};

const stallForever = (event: string): void => {
  tell(event);
  Atomics.wait(forever, 0, 0);
};

const exhaustHeap = (): void => {
  const hoard: number[][] = [];
  for (;;) hoard.push(new Array<number>(1_000_000).fill(hoard.length));
};

const holds = (bytes: Uint8Array | null, marker: string): boolean =>
  bytes !== null && Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).includes(marker);

const loads = (snapshot: Snapshot | null, marker: string): boolean =>
  snapshot !== null && [snapshot.base, ...snapshot.tail].some((bytes) => holds(bytes, marker));

const post = (reply: FromWorker, transfer: ArrayBuffer[]): void => port.postMessage(reply, transfer);

const timedByTheTest = (reply: FromWorker, late: boolean): FromWorker =>
  "elapsedMs" in reply ? { ...reply, elapsedMs: late ? Number.MAX_SAFE_INTEGER : 0 } : reply;

port.postMessage({ type: "ready" } satisfies FromWorker);

port.on("message", (message: ToWorker) => {
  if (message.type !== "run") {
    tell("dropped", { document: message.document });
    engine.handle(message, post);
    return;
  }
  if (message.load) {
    if (loads(message.load, "SLOW-LOAD")) stallForever("stalled-load");
    if (loads(message.load, "CRASH-LOAD") && gate && Atomics.add(gate, LOAD_CRASHES, 1) === 0) process.exit(1);
    tell("loaded", { document: message.document });
    engine.handle({ ...message, operations: [] }, (reply, transfer) => post(timedByTheTest(reply, false), transfer));
  }
  for (const [index, operation] of message.operations.entries()) {
    const update = operation.kind === "apply" ? operation.update : null;
    if (holds(update, "STALL")) stallForever("stalled");
    if (holds(update, "HOLD")) holdUntilReleased("HOLD");
    if (holds(update, "OOM")) exhaustHeap();
    if (holds(update, "CRASH") && !holds(update, "CRASH-LOAD")) process.exit(1);
    let stopped = false;
    engine.handle({ ...message, load: null, operations: [operation] }, (reply, transfer) => {
      if ((reply.type === "refused" && reply.evicted) || reply.type === "yielded") stopped = true;
      post(timedByTheTest(reply, holds(update, "LATE") && reply.type !== "loaded"), transfer);
    });
    tell("done", { document: message.document });
    if (stopped) return;
    if (holds(update, "YIELD") && index < message.operations.length - 1) {
      post({ type: "yielded" }, []);
      return;
    }
  }
});
