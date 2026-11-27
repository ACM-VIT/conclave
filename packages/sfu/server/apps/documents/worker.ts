import { parentPort, workerData } from "node:worker_threads";
import {
  createAppDocumentEngine,
  type EngineOptions,
  type FromWorker,
  type ToWorker,
} from "#app-documents/engine";

const port = parentPort!;
const engine = createAppDocumentEngine(workerData as EngineOptions);

port.postMessage({ type: "ready" } satisfies FromWorker);

port.on("message", (message: ToWorker) => {
  engine.handle(message, (reply, transfer) => port.postMessage(reply, transfer));
});
