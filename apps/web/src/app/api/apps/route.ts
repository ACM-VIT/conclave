import { NextResponse } from "next/server";
import { saveAppAsset, AssetStoreFullError } from "./_assets";

export const runtime = "nodejs";

const MAX_ASSET_BYTES = 5 * 1024 * 1024; // 5 MB per file

export async function POST(request: Request) {
  // NOTE: this is intentionally NOT gated behind a better-auth session — guests
  // (who have no session) legitimately run apps in meetings and the apps SDK
  // exposes uploadAsset to every participant. The stored-XSS vector is closed on
  // the READ side (GET coerces non-image types to a nosniff attachment), and
  // disk-fill is bounded by the per-file size cap + the total-store cap below.
  // Reject an oversized body BEFORE buffering it into memory via formData().
  // The multipart envelope adds a little overhead around the file, so allow a
  // 1 MB cushion over the per-file cap; the exact file.size check is below.
  const contentLengthHeader = request.headers.get("content-length");
  if (!contentLengthHeader) {
    return NextResponse.json(
      { error: "Content-Length required" },
      { status: 411 },
    );
  }

  const declaredLength = Number(contentLengthHeader);
  if (
    !Number.isFinite(declaredLength) ||
    declaredLength <= 0 ||
    declaredLength > MAX_ASSET_BYTES + 1024 * 1024
  ) {
    return NextResponse.json(
      { error: "File too large (max 5 MB)" },
      { status: 413 },
    );
  }

  const form = await request.formData();
  const file = form.get("file");

  if (!file || typeof file === "string") {
    return NextResponse.json({ error: "Missing file" }, { status: 400 });
  }

  if (file.size > MAX_ASSET_BYTES) {
    return NextResponse.json(
      { error: "File too large (max 5 MB)" },
      { status: 413 },
    );
  }

  try {
    const { id, meta } = await saveAppAsset(file);
    return NextResponse.json({
      url: `/api/apps/${id}`,
      name: meta.name,
      size: meta.size,
      contentType: meta.contentType,
    });
  } catch (error) {
    if (error instanceof AssetStoreFullError) {
      return NextResponse.json(
        { error: "Asset storage is full, try again later" },
        { status: 507 },
      );
    }
    throw error;
  }
}
