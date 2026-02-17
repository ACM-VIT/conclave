import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { ASSET_ID_PATTERN, readAppAsset } from "../_assets";

export const runtime = "nodejs";

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  if (!ASSET_ID_PATTERN.test(id)) {
    return NextResponse.json({ error: "Invalid asset id" }, { status: 400 });
  }

  const asset = await readAppAsset(id);
  if (!asset) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  return new NextResponse(new Uint8Array(asset.data), {
    headers: {
      "Content-Type": asset.meta?.contentType || "application/octet-stream",
      "Cache-Control": "no-store",
    },
  });
}
