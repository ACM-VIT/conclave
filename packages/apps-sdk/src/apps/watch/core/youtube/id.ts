const VIDEO_ID_PATTERN = /^[A-Za-z0-9_-]{11}$/;

export const isValidVideoId = (value: string): boolean =>
  VIDEO_ID_PATTERN.test(value);

export const parseVideoId = (raw: string): string | null => {
  const input = raw.trim();
  if (!input) return null;

  if (isValidVideoId(input)) {
    return input;
  }

  const url = safeParseUrl(input);
  if (!url) {
    const looseMatch = input.match(/[?&]v=([A-Za-z0-9_-]{11})/);
    return looseMatch ? looseMatch[1] : null;
  }

  const host = url.hostname.replace(/^www\./, "").toLowerCase();

  if (host === "youtu.be") {
    const id = url.pathname.split("/").filter(Boolean)[0] ?? "";
    return isValidVideoId(id) ? id : null;
  }

  const isYouTubeHost =
    host === "youtube.com" ||
    host === "m.youtube.com" ||
    host === "music.youtube.com" ||
    host.endsWith(".youtube.com");
  if (!isYouTubeHost) {
    return null;
  }

  const vParam = url.searchParams.get("v");
  if (vParam && isValidVideoId(vParam)) {
    return vParam;
  }

  const segments = url.pathname.split("/").filter(Boolean);
  if (segments.length >= 2) {
    const [prefix, candidate] = segments;
    if (
      (prefix === "shorts" ||
        prefix === "embed" ||
        prefix === "live" ||
        prefix === "v") &&
      isValidVideoId(candidate)
    ) {
      return candidate;
    }
  }

  return null;
};

const safeParseUrl = (value: string): URL | null => {
  const withScheme = /^[a-z]+:\/\//i.test(value) ? value : `https://${value}`;
  try {
    return new URL(withScheme);
  } catch {
    return null;
  }
};
