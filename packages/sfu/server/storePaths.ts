import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

export const STORES = ["scheduling", "scheduled-meetings", "scheduled-webinars"] as const;
export type StoreName = (typeof STORES)[number];

const VARIABLE_PREFIX: Record<StoreName, string> = {
  scheduling: "SCHEDULING",
  "scheduled-meetings": "SCHEDULED_MEETINGS",
  "scheduled-webinars": "SCHEDULED_WEBINARS",
};

type Environment = Record<string, string | undefined>;

const setting = (env: Environment, name: string): string | undefined => env[name]?.trim() || undefined;

export const storeJsonPath = (store: StoreName, env: Environment = process.env, cwd: string = process.cwd()): string =>
  resolve(cwd, setting(env, `${VARIABLE_PREFIX[store]}_PATH`) ?? `data/${store}.json`);

export const storeSqlitePath = (store: StoreName, env: Environment = process.env, cwd: string = process.cwd()): string => {
  const configured = setting(env, `${VARIABLE_PREFIX[store]}_SQLITE_PATH`) ?? setting(env, "CONCLAVE_SQLITE_PATH");
  if (configured) return resolve(cwd, configured);
  const recordings = setting(env, "RECORDING_STORAGE_PATH");
  return recordings ? resolve(cwd, recordings, "conclave.sqlite") : resolve(cwd, "data", "conclave.sqlite");
};

export const storeFileLines = (env: Environment = process.env, cwd: string = process.cwd()): string[] =>
  STORES.flatMap((store) => [`json ${store}.json ${storeJsonPath(store, env, cwd)}`, `sqlite ${store} ${storeSqlitePath(store, env, cwd)}`]);

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.stdout.write(`${storeFileLines().join("\n")}\n`);
}
