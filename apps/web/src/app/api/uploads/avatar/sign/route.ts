export const runtime = "nodejs";

declare const process:
  | {
      env?: Record<string, string | undefined>;
    }
  | undefined;

type SignRequestBody = {
  filename?: string;
  contentType?: string;
};

type CloudinaryConfig = {
  cloudName?: string;
  apiKey?: string;
  apiSecret?: string;
  folder: string;
};

const ALLOWED_CONTENT_TYPES = new Set([
  "image/jpeg",
  "image/jpg",
  "image/png",
  "image/webp",
]);

const MAX_FILENAME_LENGTH = 120;

const sanitizeFileBaseName = (filename: string): string => {
  const baseName = filename.replace(/\.[^/.]+$/, "").trim().toLowerCase();
  const cleaned = baseName
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  const trimmed = cleaned.slice(0, MAX_FILENAME_LENGTH);
  return trimmed || "avatar";
};

const buildCloudinaryCanonicalString = (
  params: Record<string, string>,
): string => {
  return Object.entries(params)
    .filter(([, value]) => value)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}=${value}`)
    .join("&");
};

const buildCloudinarySignature = async (
  params: Record<string, string>,
  apiSecret: string,
): Promise<string> => {
  const canonical = buildCloudinaryCanonicalString(params);
  const payload = `${canonical}${apiSecret}`;
  const bytes = new TextEncoder().encode(payload);
  const digest = await crypto.subtle.digest("SHA-1", bytes);
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
};

const normalizeEnvValue = (value?: string): string | undefined => {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
};

const parseCloudinaryUrl = (
  cloudinaryUrl?: string,
): { cloudName?: string; apiKey?: string; apiSecret?: string } => {
  const normalized = normalizeEnvValue(cloudinaryUrl);
  if (!normalized) {
    return {};
  }

  try {
    const parsed = new URL(normalized);
    const cloudName = normalizeEnvValue(parsed.hostname);
    const apiKey = normalizeEnvValue(parsed.username);
    const apiSecret = normalizeEnvValue(parsed.password);
    return { cloudName, apiKey, apiSecret };
  } catch {
    return {};
  }
};

const resolveCloudinaryConfig = (): CloudinaryConfig => {
  const env = process?.env ?? {};
  const fromUrl = parseCloudinaryUrl(env.CLOUDINARY_URL);

  const cloudName =
    normalizeEnvValue(env.CLOUDINARY_CLOUD_NAME) ||
    normalizeEnvValue(env.NEXT_PUBLIC_CLOUDINARY_CLOUD_NAME) ||
    normalizeEnvValue(env.CLOUDINARY_NAME) ||
    fromUrl.cloudName;

  const apiKey =
    normalizeEnvValue(env.CLOUDINARY_API_KEY) ||
    normalizeEnvValue(env.NEXT_PUBLIC_CLOUDINARY_API_KEY) ||
    fromUrl.apiKey;

  const apiSecret =
    normalizeEnvValue(env.CLOUDINARY_API_SECRET) || fromUrl.apiSecret;

  const folder =
    normalizeEnvValue(env.CLOUDINARY_AVATAR_FOLDER) ||
    normalizeEnvValue(env.NEXT_PUBLIC_CLOUDINARY_AVATAR_FOLDER) ||
    "conclave/avatars";

  return {
    cloudName,
    apiKey,
    apiSecret,
    folder,
  };
};

export async function POST(request: Request) {
  const { cloudName, apiKey, apiSecret, folder } = resolveCloudinaryConfig();

  if (!cloudName || !apiKey || !apiSecret) {
    return Response.json(
      { error: "Avatar upload is not configured." },
      { status: 500 },
    );
  }

  let body: SignRequestBody;
  try {
    body = (await request.json()) as SignRequestBody;
  } catch {
    return Response.json({ error: "Invalid request body" }, { status: 400 });
  }

  const contentType = body.contentType?.trim().toLowerCase() || "";
  if (!ALLOWED_CONTENT_TYPES.has(contentType)) {
    return Response.json({ error: "Unsupported image format" }, { status: 400 });
  }

  const filename = body.filename?.trim() || "avatar";
  const fileBaseName = sanitizeFileBaseName(filename);
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const publicId = `${fileBaseName}-${Date.now()}`;

  const signableParams = {
    folder,
    public_id: publicId,
    timestamp,
  };

  const signature = await buildCloudinarySignature(signableParams, apiSecret);

  return Response.json({
    uploadUrl: `https://api.cloudinary.com/v1_1/${cloudName}/image/upload`,
    params: {
      api_key: apiKey,
      timestamp,
      signature,
      folder,
      public_id: publicId,
    },
  });
}
