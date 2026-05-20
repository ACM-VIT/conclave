import { resolve } from "node:path";
import { existsSync, mkdirSync } from "node:fs";

const DEFAULT_STORAGE_RELATIVE = "data/recordings";

export const getRecordingsRoot = (): string => {
  const configured = process.env.RECORDING_STORAGE_PATH?.trim();
  const base = configured
    ? resolve(configured)
    : resolve(process.cwd(), DEFAULT_STORAGE_RELATIVE);
  if (!existsSync(base)) {
    mkdirSync(base, { recursive: true });
  }
  return base;
};

export const getRecordingDirectory = (
  webinarOrRoomId: string,
  sessionId: string,
): { absolute: string; relative: string } => {
  const root = getRecordingsRoot();
  const relative = `${webinarOrRoomId}/${sessionId}`;
  const absolute = resolve(root, relative);
  if (!existsSync(absolute)) {
    mkdirSync(absolute, { recursive: true });
  }
  return { absolute, relative };
};

export const getRecordingPublicUrl = (relativePath: string): string => {
  const base = process.env.RECORDING_PUBLIC_BASE_URL?.replace(/\/$/, "") || "";
  if (!base) return `/recordings/${relativePath}`;
  return `${base}/${relativePath}`;
};
