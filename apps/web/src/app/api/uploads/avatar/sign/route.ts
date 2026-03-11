import { createHash } from "node:crypto";
import { NextResponse } from "next/server";

export const runtime = "nodejs";

type SignRequestBody = {
  filename?: string;
  contentType?: string;
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

const buildCloudinarySignature = (
  params: Record<string, string>,
  apiSecret: string,
): string => {
  const canonical = Object.entries(params)
    .filter(([, value]) => value)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}=${value}`)
    .join("&");

  return createHash("sha1")
    .update(`${canonical}${apiSecret}`)
    .digest("hex");
};

export async function POST(request: Request) {
  const cloudName = process.env.CLOUDINARY_CLOUD_NAME?.trim();
  const apiKey = process.env.CLOUDINARY_API_KEY?.trim();
  const apiSecret = process.env.CLOUDINARY_API_SECRET?.trim();
  const folder =
    process.env.CLOUDINARY_AVATAR_FOLDER?.trim() || "conclave/avatars";

  if (!cloudName || !apiKey || !apiSecret) {
    return NextResponse.json(
      { error: "Avatar upload is not configured." },
      { status: 500 },
    );
  }

  let body: SignRequestBody;
  try {
    body = (await request.json()) as SignRequestBody;
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }

  const contentType = body.contentType?.trim().toLowerCase() || "";
  if (!ALLOWED_CONTENT_TYPES.has(contentType)) {
    return NextResponse.json({ error: "Unsupported image format" }, { status: 400 });
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

  const signature = buildCloudinarySignature(signableParams, apiSecret);

  return NextResponse.json({
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
