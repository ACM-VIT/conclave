import { randomUUID } from "node:crypto";
import { Logger } from "../../../utilities/loggers.js";
import { asRecord } from "../../../utilities/untrusted.js";
import {
  createRedisPersistenceClient,
  type RedisPersistenceClient,
} from "../../redisPersistence.js";
import { specOf } from "../entities.js";
import {
  KINDS,
  StoreCorruptionError,
  StoreUnavailableError,
  fail,
  type CommitResult,
  type Kind,
  type RawStored,
  uniqueField,
} from "../model.js";
import {
  ReplayEntropy,
  emptyWriteSet,
  execute,
  query,
  type Command,
  type Query,
  type Source,
  type WriteSet,
} from "../tx.js";
import type { Backend } from "./backend.js";

const MAX_ATTEMPTS = 12;
const MAX_MISSES = 100_000;

type Need =
  | { type: "record"; kind: Kind; id: string }
  | { type: "owner"; field: string }
  | { type: "tag"; kind: Kind; tag: string }
  | { type: "all"; kind: Kind }
  | { type: "tomb"; kind: Kind; id: string };

class Miss extends Error {
  readonly need: Need;

  constructor(need: Need) {
    super("control-plane cache miss");
    this.name = "Miss";
    this.need = need;
  }
}

export type RedisKeys = {
  rev: string;
  ver: string;
  unique: string;
  tomb: string;
  records: Record<Kind, string>;
  tag: (kind: Kind, tag: string) => string;
  commit: (id: string) => string;
};

export const controlPlaneRedisKeys = (prefix: string): RedisKeys => {
  const base = `${prefix}:{control-plane}`;
  return {
    rev: `${base}:rev`,
    ver: `${base}:ver`,
    unique: `${base}:unique`,
    tomb: `${base}:tomb`,
    records: Object.fromEntries(KINDS.map((kind) => [kind, `${base}:records:${kind}`])) as Record<
      Kind,
      string
    >,
    tag: (kind, tag) => `${base}:tag:${kind}:${tag}`,
    commit: (id) => `${base}:commit:${id}`,
  };
};

const kindVersion = (kind: Kind): string => `k:${kind}`;
const tagVersion = (kind: Kind, tag: string): string => `t:${kind}:${tag}`;
const tombField = (kind: Kind, id: string): string => `${kind}:${id}`;
const slot = (kind: Kind, id: string): string => `${kind}\u0000${id}`;

const FIXED_KEYS = 5;

export const COMMIT_MARK_TTL_MS = 3_600_000;

const COMMIT_SCRIPT = `
local p = cjson.decode(ARGV[1])
local kinds = { ${KINDS.map((kind, index) => `${kind} = ${index + FIXED_KEYS + 1}`).join(", ")} }
for _, f in ipairs(p.f) do
  if not redis.call("GET", KEYS[f]) then redis.call("SET", KEYS[f], "cancelled", "PX", p.ttl) end
end
local mark = redis.call("GET", KEYS[5])
if mark then
  if mark == "cancelled" then return { 2, "cancelled" } end
  return { 1, tonumber(string.sub(mark, 9)) }
end
local function recordRev(kind, id)
  local raw = redis.call("HGET", KEYS[kinds[kind]], id)
  if not raw then return 0 end
  local ok, decoded = pcall(cjson.decode, raw)
  if not ok or type(decoded) ~= "table" then return -2 end
  return tonumber(decoded.rev) or -2
end
for _, c in ipairs(p.c.r) do
  if recordRev(c[1], c[2]) ~= c[3] then return { 0, "record " .. c[1] .. " " .. c[2] } end
end
for _, c in ipairs(p.c.o) do
  if (redis.call("HGET", KEYS[3], c[1]) or "") ~= c[2] then return { 0, "owner " .. c[1] } end
end
for _, c in ipairs(p.c.v) do
  if tonumber(redis.call("HGET", KEYS[2], c[1]) or "0") ~= c[2] then return { 0, "version " .. c[1] } end
end
for _, c in ipairs(p.c.t) do
  if tonumber(redis.call("HGET", KEYS[4], c[1]) or "0") ~= c[2] then return { 0, "tombstone " .. c[1] } end
end
if #p.w.r == 0 then
  return { 1, tonumber(redis.call("GET", KEYS[1]) or "0") }
end
local rev = redis.call("INCR", KEYS[1])
for _, w in ipairs(p.w.r) do
  local key = KEYS[kinds[w[1]]]
  if w[3] == false then
    redis.call("HDEL", key, w[2])
  else
    redis.call("HSET", key, w[2], '{"rev":' .. rev .. ',"legacy":' .. w[4] .. ',"value":' .. w[3] .. '}')
  end
  redis.call("HSET", KEYS[2], "k:" .. w[1], rev)
end
for _, u in ipairs(p.w.u) do
  if u[2] == false then
    redis.call("HDEL", KEYS[3], u[1])
  else
    redis.call("HSET", KEYS[3], u[1], u[2])
  end
end
for _, g in ipairs(p.w.g) do
  if g[5] == 1 then
    redis.call("SADD", KEYS[g[1]], g[4])
  else
    redis.call("SREM", KEYS[g[1]], g[4])
  end
  redis.call("HSET", KEYS[2], "t:" .. g[2] .. ":" .. g[3], rev)
end
for _, d in ipairs(p.w.d) do
  redis.call("HSET", KEYS[4], d, rev)
end
redis.call("SET", KEYS[5], "applied:" .. rev, "PX", p.ttl)
return { 1, rev }
`;

const RESOLVE_SCRIPT = `
local mark = redis.call("GET", KEYS[1])
if mark then return mark end
redis.call("SET", KEYS[1], "cancelled", "PX", ARGV[1])
return "cancelled"
`;

type ScriptReply = { ok: boolean; rev: number; detail: string };

const parseEnvelope = (raw: string, where: string): RawStored => {
  const parsed: unknown = JSON.parse(raw);
  const envelope = asRecord(parsed);
  const rev = Number(envelope.rev);
  if (!Number.isFinite(rev)) throw new StoreCorruptionError(`${where} has no revision.`);
  return {
    rev,
    legacy: typeof envelope.legacy === "number" ? envelope.legacy : null,
    value: envelope.value,
  };
};

class Snapshot {
  readonly records = new Map<string, { kind: Kind; id: string; raw: RawStored | null }>();
  readonly owners = new Map<string, string | null>();
  readonly tags = new Map<string, { kind: Kind; tag: string; ids: string[]; ver: number }>();
  readonly alls = new Map<Kind, { ids: string[]; ver: number }>();
  readonly tombs = new Map<string, number | null>();

  source(): Source {
    return {
      record: (kind, id) => {
        const hit = this.records.get(slot(kind, id));
        if (!hit) throw new Miss({ type: "record", kind, id });
        return hit.raw;
      },
      owner: (field) => {
        if (!this.owners.has(field)) throw new Miss({ type: "owner", field });
        return this.owners.get(field) ?? null;
      },
      tagMembers: (kind, tag) => {
        const hit = this.tags.get(tagVersion(kind, tag));
        if (!hit) throw new Miss({ type: "tag", kind, tag });
        return hit.ids;
      },
      allIds: (kind) => {
        const hit = this.alls.get(kind);
        if (!hit) throw new Miss({ type: "all", kind });
        return hit.ids;
      },
      tombstone: (kind, id) => {
        const field = tombField(kind, id);
        if (!this.tombs.has(field)) throw new Miss({ type: "tomb", kind, id });
        return this.tombs.get(field) ?? null;
      },
    };
  }

  checks(): { r: Array<[Kind, string, number]>; o: Array<[string, string]>; v: Array<[string, number]>; t: Array<[string, number]> } {
    return {
      r: [...this.records.values()].map(({ kind, id, raw }) => [kind, id, raw?.rev ?? 0]),
      o: [...this.owners].map(([field, owner]) => [field, owner ?? ""]),
      v: [
        ...[...this.tags].map(([field, hit]): [string, number] => [field, hit.ver]),
        ...[...this.alls].map(([kind, hit]): [string, number] => [kindVersion(kind), hit.ver]),
      ],
      t: [...this.tombs].map(([field, rev]) => [field, rev ?? 0]),
    };
  }
}

const toError = (error: unknown): Error => (error instanceof Error ? error : new Error(String(error)));

const isStoreError = (error: unknown): boolean =>
  error instanceof StoreCorruptionError || error instanceof Miss;

export type RedisBackend = Backend & { readonly client: RedisPersistenceClient; keys: RedisKeys };

export const REDIS_REQUEST_DEADLINE_MS = 2_000;

class RedisStalled extends Error {
  constructor(ms: number) {
    super(`Redis did not answer within ${ms} ms.`);
    this.name = "RedisStalled";
  }
}

export const createRedisBackend = async (options: {
  redisUrl: string;
  keyPrefix: string;
  name?: string;
  requestDeadlineMs?: number;
}): Promise<RedisBackend> => {
  const name = options.name ?? "ControlPlane";
  const deadlineMs = options.requestDeadlineMs ?? REDIS_REQUEST_DEADLINE_MS;
  let client = createRedisPersistenceClient(name, options.redisUrl);
  await client.connect();
  let reconnecting: Promise<RedisPersistenceClient> | null = null;
  const keys = controlPlaneRedisKeys(options.keyPrefix);
  let closed = false;
  const unresolved = new Set<string>();

  const replace = (stalled: RedisPersistenceClient): void => {
    if (client !== stalled || closed) return;
    try {
      stalled.destroy();
    } catch {
      return;
    }
    const fresh = createRedisPersistenceClient(name, options.redisUrl);
    const connecting = fresh.connect().then(() => fresh);
    client = fresh;
    reconnecting = connecting;
    const settled = () => {
      if (reconnecting === connecting) reconnecting = null;
    };
    connecting.then(settled, settled);
  };

  const bounded = async <T>(request: (redis: RedisPersistenceClient) => Promise<T>): Promise<T> => {
    let used: RedisPersistenceClient | null = null;
    let expired = false;
    let timer: NodeJS.Timeout | undefined;
    const stalled = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        expired = true;
        if (used) replace(used);
        reject(new RedisStalled(deadlineMs));
      }, deadlineMs);
    });
    const work = (async () => {
      if (reconnecting) await reconnecting;
      if (expired || closed) throw new RedisStalled(deadlineMs);
      used = client;
      return request(client);
    })();
    work.catch(() => undefined);
    try {
      return await Promise.race([work, stalled]);
    } finally {
      clearTimeout(timer);
    }
  };

  const prefetchOwners = async (snapshot: Snapshot, kind: Kind, raws: Array<RawStored | null>): Promise<void> => {
    const spec = specOf(kind);
    const fields = new Set<string>();
    for (const raw of raws) {
      const value = raw ? spec.decode(raw.value) : null;
      if (!value) continue;
      for (const [index, key] of spec.unique(value)) {
        const field = uniqueField(index, key);
        if (!snapshot.owners.has(field)) fields.add(field);
      }
    }
    if (fields.size === 0) return;
    const list = [...fields];
    const owners = await bounded((redis) => redis.hmGet(keys.unique, list));
    list.forEach((field, index) => snapshot.owners.set(field, owners[index] ?? null));
  };

  const fetchNeed = async (snapshot: Snapshot, need: Need): Promise<void> => {
    switch (need.type) {
      case "record": {
        const raw = await bounded((redis) => redis.hGet(keys.records[need.kind], need.id));
        const parsed = raw ? parseEnvelope(raw, `${need.kind} ${need.id}`) : null;
        snapshot.records.set(slot(need.kind, need.id), { kind: need.kind, id: need.id, raw: parsed });
        await prefetchOwners(snapshot, need.kind, [parsed]);
        return;
      }
      case "owner": {
        const owner = await bounded((redis) => redis.hGet(keys.unique, need.field));
        snapshot.owners.set(need.field, owner ?? null);
        return;
      }
      case "tomb": {
        const field = tombField(need.kind, need.id);
        const rev = await bounded((redis) => redis.hGet(keys.tomb, field));
        snapshot.tombs.set(field, rev ? Number(rev) : null);
        return;
      }
      case "tag": {
        const field = tagVersion(need.kind, need.tag);
        const [ver, members] = (await bounded((redis) =>
          redis.multi().hGet(keys.ver, field).sMembers(keys.tag(need.kind, need.tag)).exec(),
        )) as unknown as [string | null, string[]];
        const ids = [...members].sort();
        snapshot.tags.set(field, { kind: need.kind, tag: need.tag, ids, ver: Number(ver ?? 0) });
        const missing = ids.filter((id) => !snapshot.records.has(slot(need.kind, id)));
        if (missing.length === 0) return;
        const raws = await bounded((redis) => redis.hmGet(keys.records[need.kind], missing));
        const parsed = missing.map((id, index) => {
          const raw = raws[index];
          const stored = raw ? parseEnvelope(raw, `${need.kind} ${id}`) : null;
          snapshot.records.set(slot(need.kind, id), { kind: need.kind, id, raw: stored });
          return stored;
        });
        await prefetchOwners(snapshot, need.kind, parsed);
        return;
      }
      case "all": {
        const [ver, entries] = (await bounded((redis) =>
          redis.multi().hGet(keys.ver, kindVersion(need.kind)).hGetAll(keys.records[need.kind]).exec(),
        )) as unknown as [string | null, Record<string, string>];
        const ids = Object.keys(entries).sort();
        snapshot.alls.set(need.kind, { ids, ver: Number(ver ?? 0) });
        const parsed = ids.map((id) => {
          const stored = parseEnvelope(entries[id], `${need.kind} ${id}`);
          snapshot.records.set(slot(need.kind, id), { kind: need.kind, id, raw: stored });
          return stored;
        });
        await prefetchOwners(snapshot, need.kind, parsed);
        return;
      }
      default: {
        const unreachable: never = need;
        throw new Error(`Unknown need ${String(unreachable)}`);
      }
    }
  };

  const resolveUnheard = async (commitKey: string, cause: Error): Promise<ScriptReply> => {
    let mark: string;
    try {
      mark = String(
        await bounded((redis) => redis.sendCommand(["EVAL", RESOLVE_SCRIPT, "1", commitKey, String(COMMIT_MARK_TTL_MS)])),
      );
    } catch {
      unresolved.add(commitKey);
      Logger.warn(`[${name}] a commit's outcome is unknown; it is fenced before the next commit (${cause.message})`);
      throw new StoreUnavailableError("Redis control-plane store is unavailable.", { cause });
    }
    if (mark.startsWith("applied:")) {
      Logger.warn(`[${name}] a commit whose reply was lost had applied at revision ${mark.slice(8)}`);
      return { ok: true, rev: Number(mark.slice(8)), detail: "" };
    }
    Logger.warn(`[${name}] a commit whose reply was lost did not apply, and now never will (${cause.message})`);
    throw new StoreUnavailableError("Redis control-plane store is unavailable.", { cause });
  };

  const runScript = async (snapshot: Snapshot, writes: WriteSet): Promise<ScriptReply> => {
    const tagKeys: string[] = [];
    const tagIndex = new Map<string, number>();
    const keyFor = (kind: Kind, tag: string): number => {
      const key = keys.tag(kind, tag);
      const known = tagIndex.get(key);
      if (known) return known;
      tagKeys.push(key);
      const index = FIXED_KEYS + KINDS.length + tagKeys.length;
      tagIndex.set(key, index);
      return index;
    };
    const payload = {
      c: snapshot.checks(),
      w: {
        r: writes.records.map((write) => [
          write.kind,
          write.id,
          write.encoded === null ? false : JSON.stringify(write.encoded),
          JSON.stringify(write.legacy),
        ]),
        u: writes.unique.map((change) => [change.field, change.owner ?? false]),
        g: writes.tags.map((change) => [
          keyFor(change.kind, change.tag),
          change.kind,
          change.tag,
          change.id,
          change.present ? 1 : 0,
        ]),
        d: writes.tombstones.map((removal) => tombField(removal.kind, removal.id)),
      },
      f: [] as number[],
      ttl: COMMIT_MARK_TTL_MS,
    };
    const commitKey = keys.commit(randomUUID());
    const fences = [...unresolved];
    const scriptKeys = [
      keys.rev,
      keys.ver,
      keys.unique,
      keys.tomb,
      commitKey,
      ...KINDS.map((kind) => keys.records[kind]),
      ...tagKeys,
      ...fences,
    ];
    payload.f = fences.map((_, index) => scriptKeys.length - fences.length + index + 1);
    let reply: unknown;
    try {
      reply = await bounded((redis) =>
        redis.sendCommand(["EVAL", COMMIT_SCRIPT, String(scriptKeys.length), ...scriptKeys, JSON.stringify(payload)]),
      );
    } catch (error) {
      if (writes.records.length === 0 && writes.tombstones.length === 0) throw error;
      const resolved = await resolveUnheard(commitKey, toError(error));
      for (const fence of fences) unresolved.delete(fence);
      return resolved;
    }
    for (const fence of fences) unresolved.delete(fence);
    const [status, detail] = Array.isArray(reply) ? (reply as unknown[]) : [];
    if (Number(status) === 1) return { ok: true, rev: Number(detail), detail: "" };
    return { ok: false, rev: 0, detail: String(detail) };
  };

  const transact = async <T>(
    run: (source: Source, entropy: ReplayEntropy) => { result: T; writes: WriteSet },
  ): Promise<{ result: T; rev: number } | null> => {
    if (closed) throw new Error("The control-plane store is closed.");
    const entropy = new ReplayEntropy();
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
      const snapshot = new Snapshot();
      let misses = 0;
      for (;;) {
        let ran: { result: T; writes: WriteSet };
        try {
          ran = run(snapshot.source(), entropy);
        } catch (error) {
          if (!(error instanceof Miss)) throw error;
          misses += 1;
          if (misses > MAX_MISSES) throw new Error("A control-plane command read too many keys.");
          try {
            await fetchNeed(snapshot, error.need);
          } catch (fetchError) {
            if (isStoreError(fetchError)) throw fetchError;
            throw new StoreUnavailableError("Redis control-plane store is unavailable.", {
              cause: fetchError,
            });
          }
          continue;
        }
        let reply: ScriptReply;
        try {
          reply = await runScript(snapshot, ran.writes);
        } catch (error) {
          if (error instanceof StoreUnavailableError) throw error;
          throw new StoreUnavailableError("Redis control-plane store is unavailable.", {
            cause: toError(error),
          });
        }
        if (reply.ok) return { result: ran.result, rev: reply.rev };
        Logger.debug(`[ControlPlane] retrying after a concurrent change (${reply.detail})`);
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, Math.floor(Math.random() * 4 * attempt)));
    }
    return null;
  };

  return {
    mode: "redis",
    get client() {
      return client;
    },
    keys,
    commit: async <T>(command: Command<T>, now: number): Promise<CommitResult<T>> => {
      const done = await transact((source, entropy) => {
        const { outcome, writes } = execute(source, command, { now, entropy });
        return { result: outcome, writes };
      });
      if (!done) return fail("conflict", "This changed elsewhere at the same moment. Try again.");
      if (!done.result.ok) return done.result;
      return { ok: true, value: done.result.value, rev: done.rev };
    },
    read: async <T>(read: Query<T>, now: number): Promise<T> => {
      const done = await transact((source, entropy) => ({
        result: query(source, read, { now, entropy }),
        writes: emptyWriteSet(),
      }));
      if (!done) throw new StoreUnavailableError("Could not read a consistent snapshot.");
      return done.result;
    },
    close: async () => {
      if (closed) return;
      closed = true;
      if (client.isReady) {
        await client.close().catch(() => undefined);
        return;
      }
      try {
        client.destroy();
      } catch {
        return;
      }
    },
  };
};
