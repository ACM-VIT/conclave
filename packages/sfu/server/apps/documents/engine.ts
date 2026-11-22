import { performance } from "node:perf_hooks";
import * as Y from "yjs";

export type Snapshot = { base: Uint8Array | null; tail: Uint8Array[] };

export type Operation =
  | { kind: "apply"; update: Uint8Array }
  | { kind: "sync"; stateVector: Uint8Array };

export type ToWorker =
  | { type: "run"; document: number; load: Snapshot | null; operations: Operation[] }
  | { type: "drop"; document: number };

type Answer =
  | { type: "applied"; compacted: Uint8Array | null }
  | { type: "synced"; update: Uint8Array; stateVector: Uint8Array }
  | { type: "refused"; reason: "too-large" | "invalid"; evicted: boolean };

export type FromWorker =
  | { type: "ready" }
  | { type: "yielded" }
  | { type: "loaded"; elapsedMs: number }
  | (Answer & { elapsedMs: number });

export type EngineOptions = { maxDocumentBytes: number };

type Post = (reply: FromWorker, transfer: ArrayBuffer[]) => void;

type Loaded = {
  doc: Y.Doc;
  measuredBytes: number;
  estimatedGrowth: number;
  uncompactedBytes: number;
  uncompactedMs: number;
};

const GROWTH_MARGIN = 16;
const COMPACT_AFTER_BYTES = 256 * 1024;
const COMPACT_AFTER_MS = 50;
const RUN_SLICE_MS = 20;

const transferable = (bytes: Uint8Array): ArrayBuffer => bytes.buffer as ArrayBuffer;

const hasPending = (doc: Y.Doc): boolean =>
  doc.store.pendingStructs !== null || doc.store.pendingDs !== null;

export const createAppDocumentEngine = ({ maxDocumentBytes }: EngineOptions) => {
  const documents = new Map<number, Loaded>();

  const evict = (id: number): void => {
    documents.get(id)?.doc.destroy();
    documents.delete(id);
  };

  const load = (id: number, { base, tail }: Snapshot): Loaded => {
    evict(id);
    const doc = new Y.Doc();
    if (base) Y.applyUpdate(doc, base);
    const started = performance.now();
    let tailBytes = 0;
    for (const update of tail) {
      Y.applyUpdate(doc, update);
      tailBytes += update.length;
    }
    const loaded = {
      doc,
      measuredBytes: base?.length ?? 0,
      estimatedGrowth: tailBytes * GROWTH_MARGIN,
      uncompactedBytes: tailBytes,
      uncompactedMs: performance.now() - started,
    };
    documents.set(id, loaded);
    return loaded;
  };

  const apply = (id: number, loaded: Loaded, update: Uint8Array): [Answer, ArrayBuffer[]] => {
    const unlocksPending = hasPending(loaded.doc);
    const started = performance.now();
    try {
      Y.applyUpdate(loaded.doc, update);
    } catch {
      evict(id);
      return [{ type: "refused", reason: "invalid", evicted: true }, []];
    }
    loaded.uncompactedMs += performance.now() - started;
    loaded.uncompactedBytes += update.length;
    const growth = update.length * GROWTH_MARGIN;
    if (
      !unlocksPending &&
      loaded.measuredBytes + loaded.estimatedGrowth + growth <= maxDocumentBytes &&
      loaded.uncompactedBytes < COMPACT_AFTER_BYTES &&
      loaded.uncompactedMs < COMPACT_AFTER_MS
    ) {
      loaded.estimatedGrowth += growth;
      return [{ type: "applied", compacted: null }, []];
    }
    const state = Y.encodeStateAsUpdate(loaded.doc);
    if (state.length > maxDocumentBytes) {
      evict(id);
      return [{ type: "refused", reason: "too-large", evicted: true }, []];
    }
    loaded.measuredBytes = state.length;
    loaded.estimatedGrowth = 0;
    loaded.uncompactedBytes = 0;
    loaded.uncompactedMs = 0;
    return [{ type: "applied", compacted: state }, [transferable(state)]];
  };

  const sync = (loaded: Loaded, stateVector: Uint8Array): [Answer, ArrayBuffer[]] => {
    let update: Uint8Array;
    try {
      update = Y.encodeStateAsUpdate(loaded.doc, stateVector);
    } catch {
      return [{ type: "refused", reason: "invalid", evicted: false }, []];
    }
    if (update.length > maxDocumentBytes) {
      return [{ type: "refused", reason: "too-large", evicted: false }, []];
    }
    const vector = Y.encodeStateVector(loaded.doc);
    return [{ type: "synced", update, stateVector: vector }, [transferable(update), transferable(vector)]];
  };

  const handle = (message: ToWorker, post: Post): void => {
    if (message.type === "drop") {
      evict(message.document);
      return;
    }
    const runStarted = performance.now();
    let loaded = documents.get(message.document);
    if (message.load) {
      loaded = load(message.document, message.load);
      post({ type: "loaded", elapsedMs: performance.now() - runStarted }, []);
    }
    if (!loaded) throw new Error(`App document ${message.document} is not loaded`);
    const { operations } = message;
    for (let index = 0; index < operations.length; index += 1) {
      const operation = operations[index];
      const started = performance.now();
      const [answer, transfer] =
        operation.kind === "sync"
          ? sync(loaded, operation.stateVector)
          : apply(message.document, loaded, operation.update);
      post({ ...answer, elapsedMs: performance.now() - started }, transfer);
      if (answer.type === "refused" && answer.evicted) return;
      if (index < operations.length - 1 && performance.now() - runStarted >= RUN_SLICE_MS) {
        post({ type: "yielded" }, []);
        return;
      }
    }
  };

  return { handle };
};
