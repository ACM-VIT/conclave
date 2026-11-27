import { randomBytes } from "node:crypto";
import { closeSync, fchmodSync, fsyncSync, mkdirSync, openSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

const syncDirectory = (dir: string): void => {
  let fd: number | null = null;
  try {
    fd = openSync(dir, "r");
    fsyncSync(fd);
  } catch {
    return;
  } finally {
    if (fd !== null) closeSync(fd);
  }
};

export const writePrivateFileAtomic = (path: string, data: string, beforeRename?: () => void): void => {
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true });
  const staged = `${path}.${randomBytes(4).toString("hex")}.tmp`;
  const fd = openSync(staged, "wx", 0o600);
  try {
    fchmodSync(fd, 0o600);
    writeFileSync(fd, data, "utf8");
    fsyncSync(fd);
  } catch (error) {
    closeSync(fd);
    rmSync(staged, { force: true });
    throw error;
  }
  closeSync(fd);
  try {
    beforeRename?.();
    renameSync(staged, path);
  } catch (error) {
    rmSync(staged, { force: true });
    throw error;
  }
  syncDirectory(dir);
};
