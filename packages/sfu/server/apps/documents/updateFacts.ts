import * as Y from "yjs";

export type WheelFormat = 1 | 2;

const RELEASED_WHEEL_LIMIT = 64;

export const watchWheelWrite = (doc: Y.Doc, format: WheelFormat) => {
  const wheel = doc.getMap("wheel");
  const nested = wheel.get("entries");
  const topLevel = doc.getArray("wheel.entries");
  const receipts = doc.getArray("wheel.addReceipts");
  const hasTopLevelNames = topLevel.length > 0;
  let compatible = true;
  const watchRoot = ({ keysChanged }: Y.YMapEvent<unknown>) => {
    if (format === 1) {
      compatible &&= !keysChanged.has("order") &&
        (!keysChanged.has("entries") || (nested === undefined && !hasTopLevelNames && wheel.get("entries") instanceof Y.Array));
    } else {
      compatible &&= !keysChanged.has("entries");
    }
  };
  const watch = ({ changedParentTypes }: Y.Transaction) => {
    const changesTopLevel = changedParentTypes.has(topLevel);
    if (format === 1) {
      compatible &&= !changesTopLevel && !changedParentTypes.has(receipts);
    } else {
      compatible &&= !(nested instanceof Y.Array) || !changesTopLevel;
    }
  };
  const watchOverflow = (event: Y.YArrayEvent<unknown>) => {
    const delta = event.changes.delta;
    if (delta.some(({ insert }) => insert !== undefined) && delta.some(({ delete: count }) => count !== undefined)) {
      compatible = false;
    }
  };
  const overflowing = format === 1 && nested instanceof Y.Array && nested.length > RELEASED_WHEEL_LIMIT ? nested : null;
  overflowing?.observe(watchOverflow);
  wheel.observe(watchRoot);
  doc.on("afterTransaction", watch);
  return () => {
    doc.off("afterTransaction", watch);
    wheel.unobserve(watchRoot);
    overflowing?.unobserve(watchOverflow);
    return compatible;
  };
};

// The live value under `key` of the map `parent` names in `doc`: a root type
// by name, or a nested type by the id of the item holding it.
const liveMapValue = (doc: Y.Doc, parent: unknown, key: string): Y.Item | null => {
  let entries: Map<string, Y.Item> | undefined;
  if (typeof parent === "string") {
    entries = doc.share.get(parent)?._map;
  } else if (parent instanceof Y.ID) {
    if (parent.clock >= Y.getState(doc.store, parent.client)) return null;
    const holder = Y.getItem(doc.store, parent);
    if (holder instanceof Y.Item && holder.content instanceof Y.ContentType) {
      entries = holder.content.type._map;
    }
  }
  const value = entries?.get(key);
  return value && !value.deleted ? value : null;
};

export type UpdateFacts = {
  // The Yjs clients the update writes as.
  writers: Set<number>;
  // Every client it writes as, builds on or deletes from.
  touched: Set<number>;
  // Whether the document and the update itself hold everything it refers
  // to. An update that builds on content the room refused does not.
  resolvable: boolean;
  // Live map values it replaces without having seen any value of their key,
  // as a client writing on a copy that never held the room's state does.
  blindlyReplaced: Y.ID[];
};

export const readUpdate = (doc: Y.Doc, update: Uint8Array): UpdateFacts => {
  const { structs, ds } = Y.decodeUpdate(update);
  const ends = new Map<number, number>();
  const end = (client: number): number => ends.get(client) ?? Y.getState(doc.store, client);
  const writers = new Set<number>();
  const touched = new Set<number>(ds.clients.keys());
  let resolvable = true;
  for (const struct of structs) {
    const client = struct.id.client;
    writers.add(client);
    touched.add(client);
    if (struct instanceof Y.Skip || struct.id.clock > end(client)) resolvable = false;
    ends.set(client, Math.max(end(client), struct.id.clock + struct.length));
  }
  const blindlyReplaced: Y.ID[] = [];
  for (const struct of structs) {
    if (!(struct instanceof Y.Item)) continue;
    const parent: unknown = struct.parent;
    for (const ref of [struct.origin, struct.rightOrigin, parent instanceof Y.ID ? parent : null]) {
      if (!ref) continue;
      touched.add(ref.client);
      const integrated =
        ref.client === struct.id.client
          ? ref.clock < struct.id.clock
          : ref.clock < Y.getState(doc.store, ref.client);
      if (!integrated) resolvable = false;
    }
    if (struct.origin === null && struct.rightOrigin === null && struct.parentSub !== null) {
      const replaced = liveMapValue(doc, parent, struct.parentSub);
      if (replaced) blindlyReplaced.push(replaced.id);
    }
  }
  for (const [client, deletes] of ds.clients) {
    for (const { clock, len } of deletes) {
      if (clock + len > end(client)) resolvable = false;
    }
  }
  return { writers, touched, resolvable, blindlyReplaced };
};

export const updateChangesNothing = (doc: Y.Doc, update: Uint8Array): boolean => {
  const decoded = Y.decodeUpdate(update);
  for (const struct of decoded.structs) {
    if (struct instanceof Y.Skip) continue;
    if (struct.id.clock + struct.length > Y.getState(doc.store, struct.id.client)) return false;
  }
  for (const [client, deletes] of decoded.ds.clients) {
    const structs = doc.store.clients.get(client);
    for (const { clock, len } of deletes) {
      if (len === 0) continue;
      if (!structs || clock + len > Y.getState(doc.store, client)) return false;
      for (let index = Y.findIndexSS(structs, clock); index < structs.length; index += 1) {
        if (structs[index].id.clock >= clock + len) break;
        if (!structs[index].deleted) return false;
      }
    }
  }
  return true;
};
