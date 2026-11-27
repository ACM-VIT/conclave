import { AsyncLocalStorage } from "node:async_hooks";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { config } from "../../config/config.js";
import { specOf } from "../../server/controlPlane/entities.js";
import type { EntityMap, Kind } from "../../server/controlPlane/model.js";
import { openControlPlane, resolveControlPlaneConfig, type ControlPlaneConfig } from "../../server/controlPlane/open.js";
import type { ControlPlaneStore } from "../../server/controlPlane/store.js";
import type { Command, Tx } from "../../server/controlPlane/tx.js";
import { createSfuApp } from "../../server/http/createApp.js";
import { initControlPlane } from "../../server/init.js";
import { LocalRoomRegistry } from "../../server/roomRegistry.js";
import { createSfuState, type SfuState } from "../../server/state.js";
import { createMemoryData, type MemoryData } from "../../server/controlPlane/backends/memory.js";
import type { StoreMode } from "../../server/controlPlane/backends/backend.js";
import type { Gates } from "./fakeServices.js";

export type SfuName = "A" | "B";
export { EMAIL_WORKER_URL, FakeEmail, FakeGoogle, Gates, installFakeFetch, type GateKind } from "./fakeServices.js";

export type Op = { id: string; label: string; sfu: SfuName; method: string };

export type LoggedWrite = { kind: Kind; id: string; value: EntityMap[Kind] | null };

export type CommitEntry = {
  rev: number;
  sfu: SfuName;
  op: Op | null;
  writes: LoggedWrite[];
  value: unknown;
};

export type Reply = { status: number; body: Record<string, unknown> };

const ops = new AsyncLocalStorage<Op>();

export const currentOp = (): Op | null => ops.getStore() ?? null;

export const runAsOp = <T>(op: Op, run: () => Promise<T>): Promise<T> => ops.run(op, run);

const recordingTx = (tx: Tx, staged: LoggedWrite[]): Tx => ({
  now: tx.now,
  entropy: tx.entropy,
  get: (kind, id) => tx.get(kind, id),
  owner: (index, key) => tx.owner(index, key),
  lookup: (kind, index, key) => tx.lookup(kind, index, key),
  tagged: (kind, tag) => tx.tagged(kind, tag),
  all: (kind) => tx.all(kind),
  tombstone: (kind, id) => tx.tombstone(kind, id),
  put: (kind, value) => {
    tx.put(kind, value);
    staged.push({ kind, id: specOf(kind).id(value as never), value: structuredClone(value) });
  },
  remove: (kind, id) => {
    const existed = tx.get(kind, id) !== null;
    tx.remove(kind, id);
    if (existed) staged.push({ kind, id, value: null });
  },
  importLegacy: (kind, value, stamp) => {
    const skipped = tx.importLegacy(kind, value, stamp);
    staged.push({ kind, id: specOf(kind).id(value as never), value: structuredClone(value) });
    return skipped;
  },
});

export const recordingStore = (
  store: ControlPlaneStore,
  sfu: SfuName,
  log: CommitEntry[],
  gates: Gates,
): ControlPlaneStore => ({
  mode: store.mode,
  commit: async <T>(command: Command<T>) => {
    const op = currentOp();
    await gates.admit("commit", `${sfu} ${op?.label ?? "background"}`);
    let staged: LoggedWrite[] = [];
    const result = await store.commit<T>((tx) => {
      staged = [];
      return command(recordingTx(tx, staged));
    });
    if (result.ok && staged.length > 0) {
      log.push({ rev: result.rev, sfu, op, writes: staged, value: structuredClone(result.value) });
    }
    return result;
  },
  read: (query) => store.read(query),
  close: () => store.close(),
});

export type Sfu = {
  name: SfuName;
  state: SfuState;
  server: Server;
  port: number;
  call: (op: Op, path: string, body?: unknown, headers?: Record<string, string>) => Promise<Reply>;
};

export type WorldOptions = {
  mode: StoreMode;
  dir: string;
  redisUrl?: string;
  redisUrlFor?: (sfu: SfuName | "observer") => string;
  prefix: string;
  clock: (sfu: SfuName) => number;
  memory?: MemoryData;
};

const storeConfig = (options: WorldOptions, sfu: SfuName | "observer"): ControlPlaneConfig => ({
  ...resolveControlPlaneConfig({ CONTROL_PLANE_PERSISTENCE: "memory" }),
  mode: options.mode,
  sqlitePath: join(options.dir, "conclave.sqlite"),
  jsonPath: join(options.dir, "control-plane.json"),
  redisUrl: options.redisUrlFor?.(sfu) ?? options.redisUrl ?? "",
  keyPrefix: options.prefix,
});

export const openWorldStore = (options: WorldOptions, sfu: SfuName | "observer"): Promise<ControlPlaneStore> =>
  openControlPlane(storeConfig(options, sfu), {
    clock: () => options.clock(sfu === "observer" ? "A" : sfu),
    memory: options.memory ?? createMemoryData(),
    importLegacy: false,
  });

export const startSfu = async (
  name: SfuName,
  options: WorldOptions,
  log: CommitEntry[],
  gates: Gates,
): Promise<Sfu> => {
  const state = createSfuState({
    roomRegistry: new LocalRoomRegistry({ instanceId: `model-${name}`, instanceUrl: "http://localhost", ttlMs: 45000 }),
  });
  await initControlPlane(state, recordingStore(await openWorldStore(options, name), name, log, gates));
  const app = createSfuApp({ state, config, getIo: () => null });
  const server = createServer((req, res) => {
    const id = String(req.headers["x-model-op"] ?? "");
    const op: Op = { id, label: String(req.headers["x-model-label"] ?? ""), sfu: name, method: req.method ?? "" };
    void ops.run(op, async () => {
      app(req, res);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no port");
  const call = async (op: Op, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<Reply> => {
    const response = await fetch(`http://127.0.0.1:${address.port}${path}`, {
      method: op.method,
      headers: {
        "x-sfu-secret": config.sfuSecret,
        "x-sfu-client": "conclave",
        "content-type": "application/json",
        "x-model-op": op.id,
        "x-model-label": op.label,
        ...headers,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    try {
      return { status: response.status, body: JSON.parse(text) as Record<string, unknown> };
    } catch {
      return { status: response.status, body: {} };
    }
  };
  return { name, state, server, port: address.port, call };
};

export const stopSfu = async (sfu: Sfu): Promise<void> => {
  await new Promise<void>((resolve) => sfu.server.close(() => resolve()));
  sfu.server.closeAllConnections?.();
  await sfu.state.controlPlane.close();
};
