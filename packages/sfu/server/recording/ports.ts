const DEFAULT_MIN_PORT = 40_000;
const DEFAULT_MAX_PORT = 49_999;

export type RecordingPortAllocator = {
  acquire: () => number;
  release: (port: number) => void;
  inUse: () => number;
};

const parsePortRange = (
  raw: string | undefined,
  fallbackMin: number,
  fallbackMax: number,
): [number, number] => {
  if (!raw) return [fallbackMin, fallbackMax];
  const [minStr, maxStr] = raw.split("-").map((entry) => entry.trim());
  const min = Number(minStr);
  const max = Number(maxStr);
  if (
    !Number.isFinite(min) ||
    !Number.isFinite(max) ||
    min <= 0 ||
    max <= 0 ||
    max <= min ||
    max > 65_535
  ) {
    return [fallbackMin, fallbackMax];
  }
  return [Math.floor(min), Math.floor(max)];
};

export const createRecordingPortAllocator = (
  options: { min?: number; max?: number } = {},
): RecordingPortAllocator => {
  const [defaultMin, defaultMax] = parsePortRange(
    process.env.RECORDING_RTP_PORT_RANGE,
    DEFAULT_MIN_PORT,
    DEFAULT_MAX_PORT,
  );
  const min = options.min ?? defaultMin;
  const max = options.max ?? defaultMax;

  const allocated = new Set<number>();
  let cursor = min;

  const advance = (): void => {
    cursor += 2;
    if (cursor > max) cursor = min;
  };

  const acquire = (): number => {
    const start = cursor;
    while (true) {
      if (!allocated.has(cursor)) {
        const port = cursor;
        allocated.add(port);
        advance();
        return port;
      }
      advance();
      if (cursor === start) {
        throw new Error("Recording: no UDP ports available for ffmpeg ingest");
      }
    }
  };

  const release = (port: number): void => {
    allocated.delete(port);
  };

  return {
    acquire,
    release,
    inUse: () => allocated.size,
  };
};
