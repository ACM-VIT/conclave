import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, realpathSync, rmdirSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
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

const isInside = (path: string, root: string): boolean => {
  const rest = relative(resolve(root), resolve(path));
  return rest !== "" && rest !== ".." && !rest.startsWith(`..${sep}`) && !isAbsolute(rest);
};

const isWithin = (path: string, root: string): boolean => resolve(path) === resolve(root) || isInside(path, root);

const present = (path: string): boolean => {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
};

const isSymlink = (path: string): boolean => {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
};

const realOrNull = (path: string): string | null => {
  try {
    return realpathSync(path);
  } catch {
    return null;
  }
};

const nearestPresent = (path: string): string => {
  let current = resolve(path);
  while (!present(current) && dirname(current) !== current) current = dirname(current);
  return current;
};

const OWNER_SEARCH = 0o100;
const OWNER_WRITE = 0o200;

const ownerBlocked = (root: string, folder: string): string | null => {
  const steps = relative(root, folder).split(sep).filter(Boolean);
  const chain = [root, ...steps.map((_, at) => join(root, ...steps.slice(0, at + 1)))];
  for (const [at, path] of chain.entries()) {
    const mode = statSync(path).mode & 0o777;
    const needed = at === chain.length - 1 ? OWNER_SEARCH | OWNER_WRITE : OWNER_SEARCH;
    if ((mode & needed) !== needed) {
      return `${path} has mode ${mode.toString(8).padStart(4, "0")}, and the SFU user, which owns everything on the volume once the deploy hands it over, needs ${needed === OWNER_SEARCH ? "to search it" : "to search and write it"}`;
    }
  }
  return null;
};

type Placement = { ok: true } | { ok: false; state: "outside" | "unwritable"; reason: string };

const placeOf = (target: string, volumeRoot: string): Placement => {
  const root = realOrNull(volumeRoot);
  if (!root || !isInside(target, volumeRoot)) return { ok: false, state: "outside", reason: `${target} is not under the recordings volume ${volumeRoot}` };
  if (isSymlink(target)) return { ok: false, state: "outside", reason: `${target} is a symbolic link` };
  const folder = nearestPresent(dirname(target));
  const real = realOrNull(folder);
  if (!real || !isWithin(real, root)) return { ok: false, state: "outside", reason: `${folder} resolves to ${real ?? "nothing"}, which is not on the recordings volume ${root}` };
  if (statSync(real).dev !== statSync(root).dev) return { ok: false, state: "outside", reason: `${folder} resolves to ${real}, which is on another mount than the recordings volume ${root}` };
  if (!statSync(real).isDirectory() || !canCreateIn(real)) return { ok: false, state: "unwritable", reason: `${real} cannot take new files` };
  const blocked = ownerBlocked(root, real);
  if (blocked) return { ok: false, state: "unwritable", reason: blocked };
  return { ok: true };
};

export type TargetState = { state: "free" | "taken" | "unwritable" | "outside" } | { state: "carried"; mark: CarryMark };

export const targetState = (path: string, volumeRoot: string): TargetState => {
  const place = placeOf(path, volumeRoot);
  if (!place.ok && place.state === "outside") return { state: "outside" };
  if (present(path)) {
    const mark = readCarryMark(path);
    return mark ? { state: "carried", mark } : { state: "taken" };
  }
  if (PUBLISHED_COMPANIONS.some((suffix) => present(`${path}${suffix}`))) return { state: "taken" };
  return place.ok ? { state: "free" } : { state: place.state };
};

export const checkPlace = (target: string, volumeRoot: string): void => {
  const place = placeOf(target, volumeRoot);
  if (!place.ok) throw new Error(`Refusing to publish the database: ${place.reason}.`);
};

export const checkCarryMark = (target: string, expected: CarryMark): void => {
  if (isSymlink(target)) throw new Error(`${target} is a symbolic link, so it is not a copy this deploy made.`);
  const mark = readCarryMark(target);
  if (!mark || mark.container !== expected.container || mark.startedAt !== expected.startedAt) {
    throw new Error(`${target} is not the copy this deploy made from container ${expected.container} started at ${expected.startedAt}, so it is never replaced.`);
  }
};

export const prepareFolder = (dir: string, volumeRoot: string, owner: string): void => {
  const target = resolve(dir);
  const root = realOrNull(volumeRoot);
  const nearest = nearestPresent(target);
  const real = realOrNull(nearest);
  if (!root || !isWithin(target, volumeRoot) || !real || !isWithin(real, root) || statSync(real).dev !== statSync(root).dev) {
    throw new Error(`${target} is not on the recordings volume ${volumeRoot}.`);
  }
  const missing: string[] = [];
  for (let current = target; !present(current); current = dirname(current)) missing.unshift(current);
  for (const folder of missing) {
    mkdirSync(folder, { mode: 0o700 });
    chmodSync(folder, 0o700);
    execFileSync("chown", [owner, folder], { stdio: ["ignore", "ignore", "inherit"] });
  }
  const resolved = realOrNull(target);
  if (!resolved || !isWithin(resolved, root) || !statSync(resolved).isDirectory()) throw new Error(`${target} is not a folder on the recordings volume ${volumeRoot}.`);
};

export const probeLines = (volumeRoot: string, env: Record<string, string | undefined> = process.env, cwd: string = process.cwd()): string[] =>
  STORES.map((store) => {
    const target = storeSqlitePath(store, env, cwd);
    const found = targetState(target, volumeRoot);
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
    if (command === "probe" && args.length === 1 && args[0]) {
      process.stdout.write(`${probeLines(args[0]).join("\n")}\n`);
    } else if (command === "prepare-folder" && args.length === 3 && args.every(Boolean)) {
      prepareFolder(args[0], args[1], args[2]);
    } else if (command === "check-place" && args.length === 2 && args.every(Boolean)) {
      checkPlace(args[0], args[1]);
    } else if (command === "check-mark" && args.length === 3 && args.every(Boolean)) {
      checkCarryMark(args[0], { container: args[1], startedAt: args[2] });
    } else if (command === "consolidate" && args.length === 3 && args.every(Boolean)) {
      consolidateForCarry(args[0], { container: args[1], startedAt: args[2] });
    } else {
      process.stderr.write("Usage: layerDatabase.ts probe <volume> | prepare-folder <folder> <volume> <owner> | check-place <target> <volume> | check-mark <target> <container> <started-at> | consolidate <database> <container> <started-at>\n");
      process.exit(2);
    }
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  }
}
