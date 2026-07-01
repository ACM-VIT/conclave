import { NextResponse } from "next/server";
import { getConclaveVersionResponse } from "@/app/lib/site-version.server";

export async function GET() {
  const body = await getConclaveVersionResponse();

  return NextResponse.json(body, {
    headers: {
      "Cache-Control": "no-store, max-age=0",
    },
  });
}
