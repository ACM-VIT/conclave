import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";

export const ASSET_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const ASSET_DIR = path.join(process.cwd(), ".tmp", "apps-assets");
// TODO(s3): Replace local fs storage with S3-compatible object storage for serverless durability.

type AssetMeta = {
  name: string;
  size: number;
  contentType: string;
};

const ensureDir = async () => {
  await fs.mkdir(ASSET_DIR, { recursive: true });
};

export const saveAppAsset = async (
  file: File,
): Promise<{ id: string; meta: AssetMeta }> => {
  await ensureDir();

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
