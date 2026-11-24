import { done, type EntityMap, type Kind } from "../../server/controlPlane/model.js";
import type { ControlPlaneStore } from "../../server/controlPlane/store.js";

export const seed = async <K extends Kind>(
  store: ControlPlaneStore,
  kind: K,
  ...records: Array<EntityMap[K]>
): Promise<void> => {
  const result = await store.commit((tx) => {
    for (const record of records) tx.put(kind, record);
    return done(records.length);
  });
  if (!result.ok) throw new Error(`seeding ${kind} failed: ${result.reason} ${result.message ?? ""}`);
};
