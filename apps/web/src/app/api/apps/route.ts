import { NextResponse } from "next/server";
import { saveAppAsset } from "./_assets";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const form = await request.formData();
  const file = form.get("file");

  if (!file || typeof file === "string") {
    return NextResponse.json({ error: "Missing file" }, { status: 400 });
  }

  const { id, meta } = await saveAppAsset(file);

  return NextResponse.json({
    url: `/api/apps/${id}`,
    name: meta.name,
    size: meta.size,
    contentType: meta.contentType,
  });
}
