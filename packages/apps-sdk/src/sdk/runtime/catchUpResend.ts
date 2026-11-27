import * as Y from "yjs";

const reachedWith = (server: Y.Snapshot, changes: Uint8Array[]): Map<number, number> => {
  const reached = new Map(server.sv);
  const ranges = changes
    .flatMap((change) => {
      const { from, to } = Y.parseUpdateMeta(change);
      return [...to].map(([client, end]) => ({ client, start: from.get(client) ?? 0, end }));
    })
    .sort((left, right) => left.start - right.start);
  for (const { client, start, end } of ranges) {
    const clock = reached.get(client) ?? 0;
    if (start <= clock && end > clock) reached.set(client, end);
  }
  return reached;
};

export const changesToResend = (server: Y.Snapshot, pending: Uint8Array[], lacking: Uint8Array): Uint8Array[] => {
  const missing = pending.filter((change) => !Y.snapshotContainsUpdate(server, change));
  const reached = reachedWith(server, missing);
  if (!Y.snapshotContainsUpdate(Y.createSnapshot(Y.decodeUpdate(lacking).ds, reached), lacking)) return [lacking];
  const deletes = Y.mergeDeleteSets([server.ds, ...missing.map((change) => Y.decodeUpdate(change).ds)]);
  if (Y.snapshotContainsUpdate(Y.createSnapshot(deletes, reached), lacking)) return missing;
  return [...missing, Y.diffUpdate(lacking, Y.encodeStateVector(reached))];
};
