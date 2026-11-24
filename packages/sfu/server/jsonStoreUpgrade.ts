import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { Logger } from "../utilities/loggers.js";

type RecordCount = (data: unknown) => number;

export const countArrayRecords: RecordCount = (data) => (Array.isArray(data) ? data.length : 0);

export const countSnapshotRecords: RecordCount = (data) => {
  if (!data || typeof data !== "object") return 0;
  return ["profiles", "availability", "eventTypes", "calendars"].reduce((total, key) => {
    const entries = (data as Record<string, unknown>)[key];
    return total + (Array.isArray(entries) ? entries.length : 0);
  }, 0);
};

const recoveredCopies = (fileName: string): string[] => {
  const importDir = process.env.CONCLAVE_FALLBACK_IMPORT_DIR?.trim();
  if (!importDir || !existsSync(importDir)) return [];
  return readdirSync(importDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(importDir, entry.name, fileName))
    .filter((path) => existsSync(path))
    .sort();
};

const readRecords = (path: string, count: RecordCount): number => {
  try {
    return count(JSON.parse(readFileSync(path, "utf8")));
  } catch {
    return 0;
  }
};

export const adoptRecoveredJsonStore = (activePath: string, fileName: string, count: RecordCount): void => {
  const copies = recoveredCopies(fileName);
  if (copies.length === 0) return;
  const holding = copies.filter((path) => readRecords(path, count) > 0);
  if (existsSync(activePath)) {
    if (holding.length === 0 || readRecords(activePath, count) > 0) return;
    throw new Error(
      `${activePath} holds no records, but ${holding.join(" and ")} holds the store an older SFU kept in its container. Copy the right file over ${activePath}, or rename it with a .adopted suffix to start empty.`,
    );
  }
  const contents = copies.map((path) => readFileSync(path, "utf8"));
  if (new Set(contents).size > 1) {
    throw new Error(
      `${copies.join(" and ")} are different copies of the store older SFUs kept in their containers. Copy the right one to ${activePath} and rename the others with a .adopted suffix.`,
    );
  }
  try {
    JSON.parse(contents[0]);
  } catch (error) {
    throw new Error(`${copies[0]}, the store an older SFU kept in its container, is not readable JSON (${(error as Error).message}). Repair it or copy a good store to ${activePath}.`);
  }
  mkdirSync(dirname(activePath), { recursive: true });
  const staged = `${activePath}.${process.pid}.adopting`;
  writeFileSync(staged, contents[0], { mode: 0o600 });
  renameSync(staged, activePath);
  for (const path of copies) renameSync(path, `${path}.adopted`);
  Logger.warn(`Adopted ${copies[0]} as ${activePath}, the store an older SFU kept in its container`);
};
