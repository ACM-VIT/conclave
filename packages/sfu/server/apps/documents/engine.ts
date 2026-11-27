import { performance } from "node:perf_hooks";
import * as Y from "yjs";

import { readUpdate, updateChangesNothing, type UpdateFacts } from "#app-documents/updateFacts";

export type WorkerProposal = { facts: UpdateFacts; bytes: number; seen: Map<number, number> };

export type Snapshot = { base: Uint8Array | null; tail: Uint8Array[] };

export type Operation =
  | { kind: "apply"; update: Uint8Array; assembled?: true; validate?: true; rest?: Uint8Array[] }
  | { kind: "sync"; stateVector: Uint8Array }
  | { kind: "check"; update: Uint8Array };

export type ToWorker =
  | { type: "run"; document: number; load: Snapshot | null; operations: Operation[] }
  | { type: "drop"; document: number };

type Answer =
  | { type: "applied"; compacted: Uint8Array | null; unchanged?: true }
  | { type: "proposed"; proposal: WorkerProposal; update: Uint8Array; compacted: Uint8Array | null; unchanged?: true }
  | { type: "checked"; unchanged: boolean }
  | { type: "synced"; update: Uint8Array; stateVector: Uint8Array }
  | { type: "refused"; reason: "too-large" | "invalid" | "missing-dependency" | "malformed" | "unresolved"; evicted: boolean };

export type FromWorker =
  | { type: "ready" }
  | { type: "yielded" }
  | { type: "loaded"; elapsedMs: number }
  | (Answer & { elapsedMs: number });

export type EngineOptions = { maxDocumentBytes: number; maxUpdateBytes: number };

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

export const createAppDocumentEngine = ({ maxDocumentBytes, maxUpdateBytes }: EngineOptions) => {
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

  const apply = (id: number, loaded: Loaded, update: Uint8Array, assembled: boolean, exact = false): [Answer, ArrayBuffer[]] => {
    if (update.length > (assembled ? maxDocumentBytes : maxUpdateBytes)) {
      return [{ type: "refused", reason: "too-large", evicted: false }, []];
    }
    const started = performance.now();
    let changed = false;
    const noteChange = () => {
      changed = true;
    };
    loaded.doc.on("update", noteChange);
    try {
      Y.applyUpdate(loaded.doc, update);
    } catch {
      evict(id);
      return [{ type: "refused", reason: "invalid", evicted: true }, []];
    } finally {
      loaded.doc.off("update", noteChange);
    }
    if (hasPending(loaded.doc)) {
      evict(id);
      return [{ type: "refused", reason: "missing-dependency", evicted: true }, []];
    }
    if (!changed) return [{ type: "applied", compacted: null, unchanged: true }, []];
    loaded.uncompactedMs += performance.now() - started;
    loaded.uncompactedBytes += update.length;
    const growth = update.length * GROWTH_MARGIN;
    if (
      !exact && loaded.measuredBytes + loaded.estimatedGrowth + growth <= maxDocumentBytes &&
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

  const propose = (id: number, loaded: Loaded, operation: Extract<Operation, { kind: "apply" }>): [Answer, ArrayBuffer[]] => {
    let update: Uint8Array;
    let facts: UpdateFacts;
    try {
      update = operation.rest?.length ? Y.mergeUpdates([operation.update, ...operation.rest]) : operation.update;
      facts = readUpdate(loaded.doc, update);
    } catch {
      return [{ type: "refused", reason: "malformed", evicted: false }, []];
    }
    if (!facts.resolvable) return [{ type: "refused", reason: "unresolved", evicted: false }, []];
    const [answer, transfer] = apply(id, loaded, update, operation.assembled === true, true);
    if (answer.type !== "applied") return [answer, transfer];
    const seen = new Map<number, number>();
    for (const [client] of loaded.doc.store.clients) seen.set(client, Y.getState(loaded.doc.store, client));
    return [{
      type: "proposed", update, compacted: answer.compacted, unchanged: answer.unchanged,
      proposal: { facts, bytes: loaded.measuredBytes || 2, seen },
    }, transfer];
  };

  const check = (loaded: Loaded, update: Uint8Array): [Answer, ArrayBuffer[]] => {
    try {
      return [{ type: "checked", unchanged: updateChangesNothing(loaded.doc, update) }, []];
    } catch {
      return [{ type: "refused", reason: "invalid", evicted: false }, []];
    }
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
          : operation.kind === "check"
            ? check(loaded, operation.update)
            : operation.validate
              ? propose(message.document, loaded, operation)
              : apply(message.document, loaded, operation.update, operation.assembled === true);
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
