import { getCloudflareContext } from "@opennextjs/cloudflare";
import { NextResponse } from "next/server";
import {
  type ConclaveSiteVersionResponse,
  normalizeConclaveSiteVersion,
} from "@/app/lib/site-version";

export const dynamic = "force-dynamic";
export const revalidate = 0;

type VersionedCloudflareEnv = {
  CF_VERSION_METADATA?: unknown;
};

const readCloudflareVersionMetadata = async (): Promise<unknown> => {
  try {
    const { env } = await getCloudflareContext({ async: true });
    return (env as VersionedCloudflareEnv).CF_VERSION_METADATA;
  } catch {
    return null;
  }
};

export async function GET() {
  const metadata = await readCloudflareVersionMetadata();
  const fallbackId =
    process.env.NEXT_PUBLIC_CONCLAVE_WEB_VERSION ??
    process.env.CONCLAVE_WEB_VERSION ??
    "local";
  const body: ConclaveSiteVersionResponse = {
    serviceVersion: normalizeConclaveSiteVersion(metadata, fallbackId),
  };

  return NextResponse.json(body, {
    headers: {
      "Cache-Control": "no-store, max-age=0",
    },
  });
}
