import { getCloudflareContext } from "@opennextjs/cloudflare";
import {
  type ConclaveSiteVersion,
  type ConclaveSiteVersionResponse,
  normalizeConclaveSiteVersion,
} from "./site-version";

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

export const getConclaveClientVersion = (): ConclaveSiteVersion =>
  normalizeConclaveSiteVersion({
    id:
      process.env.NEXT_PUBLIC_CONCLAVE_CLIENT_VERSION ??
      process.env.NEXT_PUBLIC_CONCLAVE_WEB_VERSION ??
      process.env.CONCLAVE_WEB_VERSION ??
      process.env.NEXT_BUILD_ID ??
      process.env.OPEN_NEXT_BUILD_ID ??
      "local",
    tag:
      process.env.NEXT_PUBLIC_CONCLAVE_CLIENT_VERSION_TAG ??
      process.env.NEXT_PUBLIC_CONCLAVE_WEB_VERSION_TAG ??
      null,
    timestamp:
      process.env.NEXT_PUBLIC_CONCLAVE_CLIENT_VERSION_TIMESTAMP ??
      process.env.NEXT_PUBLIC_CONCLAVE_WEB_VERSION_TIMESTAMP ??
      null,
  });

export const getConclaveVersionResponse =
  async (): Promise<ConclaveSiteVersionResponse> => {
    const clientVersion = getConclaveClientVersion();
    const metadata = await readCloudflareVersionMetadata();
    return {
      serviceVersion: normalizeConclaveSiteVersion(metadata, clientVersion.id),
      clientVersion,
    };
  };
