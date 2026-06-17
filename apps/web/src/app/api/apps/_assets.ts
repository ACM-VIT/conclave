import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";

export const ASSET_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const ASSET_DIR = path.join(process.cwd(), ".tmp", "apps-assets");

// Total on-disk cap for the (unauthenticated) asset store. Bounds the disk-fill
// DoS from repeated anonymous uploads without breaking guest app-asset uploads.
// This local filesystem store expects a persistent host volume; serverless
// deployments should route this API to object storage instead.
const MAX_STORE_BYTES = 1024 * 1024 * 1024; // 1 GB

/** Thrown by saveAppAsset when accepting the upload would exceed MAX_STORE_BYTES. */
export class AssetStoreFullError extends Error {
  constructor() {
    super("Asset store is full");
    this.name = "AssetStoreFullError";
  }
}

type AssetMeta = {
  name: string;
  size: number;
  contentType: string;
};

const ensureDir = async () => {
  await fs.mkdir(ASSET_DIR, { recursive: true });
};

const currentStoreBytes = async (): Promise<number> => {
  let total = 0;
  let entries: string[];
  try {
    entries = await fs.readdir(ASSET_DIR);
  } catch {
    return 0;
  }
  for (const entry of entries) {
    try {
      const stat = await fs.stat(path.join(ASSET_DIR, entry));
      if (stat.isFile()) total += stat.size;
    } catch {
      // entry vanished between readdir and stat — ignore.
    }
  }
  return total;
};

// Serializes saves so the store-cap check-then-write is atomic — without this,
// concurrent uploads could all pass currentStoreBytes() and collectively blow
// past MAX_STORE_BYTES. Uploads are infrequent, so the serialization cost is
// negligible.
let saveLock: Promise<unknown> = Promise.resolve();

export const saveAppAsset = async (
  file: File,
): Promise<{ id: string; meta: AssetMeta }> => {
  const run = saveLock.then(async () => {
    await ensureDir();

    // Reject once the store is full so a flood of uploads cannot exhaust disk.
    if ((await currentStoreBytes()) + file.size > MAX_STORE_BYTES) {
      throw new AssetStoreFullError();
    }

    const buffer = Buffer.from(await file.arrayBuffer());
    const id = crypto.randomUUID();
    const filePath = path.join(ASSET_DIR, id);
    const metaPath = `${filePath}.json`;
    const meta: AssetMeta = {
      name: file.name,
      size: file.size,
      contentType: file.type || "application/octet-stream",
    };

    await fs.writeFile(filePath, buffer);
    await fs.writeFile(metaPath, JSON.stringify(meta));

    return { id, meta };
  });
  // Keep the lock chain alive regardless of this save's success/failure.
  saveLock = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
};

export const readAppAsset = async (
  id: string,
): Promise<{ data: Buffer; meta: AssetMeta | null } | null> => {
  if (!ASSET_ID_PATTERN.test(id)) {
    return null;
  }

  const filePath = path.join(ASSET_DIR, id);
  const metaPath = `${filePath}.json`;

  try {
    const [data, metaRaw] = await Promise.all([
      fs.readFile(filePath),
      fs.readFile(metaPath).catch(() => null),
    ]);

    let meta: AssetMeta | null = null;
    if (metaRaw) {
      const parsed = JSON.parse(metaRaw.toString()) as {
        name?: unknown;
        size?: unknown;
        contentType?: unknown;
      };
      if (
        typeof parsed.name === "string" &&
        typeof parsed.size === "number" &&
        typeof parsed.contentType === "string"
      ) {
        meta = {
          name: parsed.name,
          size: parsed.size,
          contentType: parsed.contentType,
        };
      }
    }

    return { data, meta };
  } catch {
    return null;
  }
};
