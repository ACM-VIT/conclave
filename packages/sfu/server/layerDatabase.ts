import { existsSync, mkdtempSync, rmdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { STORES, storeSqlitePath } from "./storePaths.js";

type Statement = { all(...values: string[]): unknown[]; get(...values: string[]): unknown; run(...values: string[]): unknown };
type Database = { exec(sql: string): void; prepare(sql: string): Statement; close(): void };

const openDatabase = (path: string, readOnly: boolean): Database => {
  const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as {
    DatabaseSync: new (path: string, options: { readOnly: boolean }) => Database;
  };
  return new DatabaseSync(path, { readOnly });
};

export const CARRY_TABLE = "conclave_deploy_carry";
const PUBLISHED_COMPANIONS = ["-wal", "-journal"];
const EVERY_COMPANION = ["-wal", "-shm", "-journal"];

export type CarryMark = { container: string; startedAt: string };

const firstValue = (row: unknown): unknown => (row !== null && typeof row === "object" ? Object.values(row)[0] : undefined);

const decodeCarryMark = (row: unknown): CarryMark | null => {
  if (row === null || typeof row !== "object") return null;
  const { container, started_at: startedAt } = row as Record<string, unknown>;
  return typeof container === "string" && container !== "" && typeof startedAt === "string" && startedAt !== "" ? { container, startedAt } : null;
};

export const readCarryMark = (path: string): CarryMark | null => {
  if (EVERY_COMPANION.some((suffix) => existsSync(`${path}${suffix}`))) return null;
  let db: Database | undefined;
  try {
    db = openDatabase(path, true);
    if (!db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(CARRY_TABLE)) return null;
    return decodeCarryMark(db.prepare(`SELECT container, started_at FROM ${CARRY_TABLE} ORDER BY rowid DESC LIMIT 1`).get());
  } catch {
    return null;
  } finally {
    db?.close();
  }
};

const canCreateIn = (dir: string): boolean => {
  try {
    rmdirSync(mkdtempSync(join(dir, ".conclave-write-check-")));
    return true;
  } catch {
    return false;
  }
};

export type TargetState = { state: "free" | "taken" | "unwritable" } | { state: "carried"; mark: CarryMark };

export const targetState = (path: string): TargetState => {
  if (existsSync(path)) {
    const mark = readCarryMark(path);
    return mark ? { state: "carried", mark } : { state: "taken" };
  }
  if (PUBLISHED_COMPANIONS.some((suffix) => existsSync(`${path}${suffix}`))) return { state: "taken" };
  return canCreateIn(dirname(path)) ? { state: "free" } : { state: "unwritable" };
};

export const probeLines = (env: Record<string, string | undefined> = process.env, cwd: string = process.cwd()): string[] =>
  STORES.map((store) => {
    const target = storeSqlitePath(store, env, cwd);
    const found = targetState(target);
    const mark = found.state === "carried" ? [found.mark.container, found.mark.startedAt] : ["", ""];
    return [store, found.state, target, ...mark].join("\t");
  });

export const consolidateForCarry = (path: string, mark: CarryMark): void => {
  const db = openDatabase(path, false);
  try {
    const integrity = db.prepare("PRAGMA integrity_check").all();
    if (integrity.length !== 1 || firstValue(integrity[0]) !== "ok") {
      throw new Error(`${path} failed SQLite's integrity check: ${JSON.stringify(integrity)}`);
    }
    db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    const mode = firstValue(db.prepare("PRAGMA journal_mode = DELETE").get());
    if (mode !== "delete") throw new Error(`${path} stayed in journal mode ${String(mode)}, so its write-ahead log could not be folded in.`);
    db.exec(`CREATE TABLE IF NOT EXISTS ${CARRY_TABLE} (container TEXT NOT NULL, started_at TEXT NOT NULL, carried_at TEXT NOT NULL)`);
    db.prepare(`INSERT INTO ${CARRY_TABLE} (container, started_at, carried_at) VALUES (?, ?, ?)`).run(mark.container, mark.startedAt, new Date().toISOString());
  } finally {
    db.close();
  }
  const left = EVERY_COMPANION.filter((suffix) => existsSync(`${path}${suffix}`));
  if (left.length > 0) throw new Error(`${path} still has ${left.join(", ")} beside it after folding them in.`);
};

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [command, ...args] = process.argv.slice(2);
  try {
    if (command === "probe" && args.length === 0) {
      process.stdout.write(`${probeLines().join("\n")}\n`);
    } else if (command === "consolidate" && args.length === 3 && args.every(Boolean)) {
      consolidateForCarry(args[0], { container: args[1], startedAt: args[2] });
    } else {
      process.stderr.write("Usage: layerDatabase.ts probe | consolidate <database> <container> <started-at>\n");
      process.exit(2);
    }
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  }
}
