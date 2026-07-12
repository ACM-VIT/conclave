import { parseUnfurlableUrl } from "./unfurl-html";

export const toUnfurlAssetUrl = (
  candidate: string | undefined,
): string | undefined => {
  const target = parseUnfurlableUrl(candidate ?? "");
  return target
    ? `/api/unfurl/asset?url=${encodeURIComponent(target.href)}`
    : undefined;
};
