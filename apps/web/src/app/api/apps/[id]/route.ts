import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { ASSET_ID_PATTERN, readAppAsset } from "../_assets";

export const runtime = "nodejs";

// Content types we serve INLINE with their declared type. Everything else —
// notably text/html and image/svg+xml, which can execute script on our OWN
// origin (where the session cookie lives) — is forced to a non-rendering
// download. SVG is deliberately excluded because it can carry <script>.
const SAFE_INLINE_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/jpg",
  "image/gif",
  "image/webp",
  "image/avif",
  "image/x-icon",
  "image/vnd.microsoft.icon",
]);

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

  const declared = (asset.meta?.contentType || "").toLowerCase().split(";")[0].trim();
  const inlineSafe = SAFE_INLINE_TYPES.has(declared);

  const headers: Record<string, string> = {
    // Never let the browser sniff a script-executing type out of the bytes.
    "X-Content-Type-Options": "nosniff",
    // Defense in depth: even if something renders, this blocks script + network.
    "Content-Security-Policy": "default-src 'none'; sandbox",
    "Cache-Control": "no-store",
  };

  if (inlineSafe) {
    headers["Content-Type"] = declared;
    headers["Content-Disposition"] = "inline";
  } else {
    // Untrusted / dangerous declared type (html, svg, …) — serve as an opaque
    // download so it can never render or run script on this origin.
    headers["Content-Type"] = "application/octet-stream";
    headers["Content-Disposition"] = "attachment";
  }

  return new NextResponse(new Uint8Array(asset.data), { headers });
}
