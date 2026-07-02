import { NextResponse } from "next/server";
import {
  KLIPY_ATTACHMENT_KIND,
  type KlipyMediaKind,
  type KlipyMediaResult,
  type KlipyMediaSearchResponse,
} from "../../../lib/klipy-gifs";


const KLIPY_API_BASE_URL = "https://api.klipy.com/api/v1";
const KLIPY_MEDIA_HOST = "static.klipy.com";
const DEFAULT_PER_PAGE = 16;
const MAX_PER_PAGE = 32;
const MAX_QUERY_LENGTH = 80;
const RATING = "pg";

const MEDIA_KINDS: readonly KlipyMediaKind[] = ["gifs", "stickers", "clips"];

// Size/format preferences for the catalogs that return nested renditions
// (gifs + stickers). Clips return a flat file object handled separately.
const NESTED_SIZE_PREFERENCE = ["md", "sm", "hd", "xs"] as const;
const PREVIEW_SIZE_PREFERENCE = ["sm", "xs", "md", "hd"] as const;

interface NestedMediaConfig {
  // Animated formats for the sent media. GIF is preferred so transparency and
  // animation survive on every client (including native ones that can't render
  // animated WebP).
  urlFormats: readonly string[];
  previewFormats: readonly string[];
  pagePath: string;
}

const NESTED_MEDIA_CONFIG: Record<"gifs" | "stickers", NestedMediaConfig> = {
  gifs: {
    urlFormats: ["gif"],
    previewFormats: ["webp", "gif", "jpg"],
    pagePath: "gifs",
  },
  stickers: {
    urlFormats: ["gif", "webp"],
    previewFormats: ["webp", "gif"],
    pagePath: "stickers",
  },
};

interface KlipyRendition {
  url: string;
  width?: number;
  height?: number;
}

const clampInteger = (
  value: string | null,
  fallback: number,
  min: number,
  max: number,
): number => {
  const parsed = Number.parseInt(value ?? "", 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
};

const asRecord = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === "object" ? (value as Record<string, unknown>) : null;

const asString = (value: unknown): string | null =>
  typeof value === "string" && value.trim() ? value.trim() : null;

const asDimension = (value: unknown): number | undefined => {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  const rounded = Math.round(value);
  return rounded > 0 && rounded <= 4096 ? rounded : undefined;
};

const parseMediaKind = (value: string | null): KlipyMediaKind =>
  MEDIA_KINDS.includes(value as KlipyMediaKind)
    ? (value as KlipyMediaKind)
    : "gifs";

const normalizeKlipyMediaUrl = (value: unknown): string | null => {
  const raw = asString(value);
  if (!raw) return null;

  try {
    const url = new URL(raw);
    if (url.protocol !== "https:" || url.hostname !== KLIPY_MEDIA_HOST) {
      return null;
    }
    return url.href;
  } catch {
    return null;
  }
};

const findRendition = (
  file: unknown,
  sizes: readonly string[],
  formats: readonly string[],
): KlipyRendition | null => {
  const fileRecord = asRecord(file);
  if (!fileRecord) return null;

  for (const size of sizes) {
    const sizeRecord = asRecord(fileRecord[size]);
    if (!sizeRecord) continue;

    for (const format of formats) {
      const renditionRecord = asRecord(sizeRecord[format]);
      if (!renditionRecord) continue;

      const url = normalizeKlipyMediaUrl(renditionRecord.url);
      if (!url) continue;

      return {
        url,
        width: asDimension(renditionRecord.width),
        height: asDimension(renditionRecord.height),
      };
    }
  }

  return null;
};

const buildPageUrl = (path: string, slug: string | null): string | undefined =>
  slug ? `https://klipy.com/${path}/${encodeURIComponent(slug)}` : undefined;

// gifs + stickers: `file` is `{ [size]: { [format]: { url, width, height } } }`.
const normalizeNestedItem = (
  value: unknown,
  media: "gifs" | "stickers",
): KlipyMediaResult | null => {
  const item = asRecord(value);
  if (!item) return null;

  const config = NESTED_MEDIA_CONFIG[media];
  const main = findRendition(
    item.file,
    NESTED_SIZE_PREFERENCE,
    config.urlFormats,
  );
  if (!main) return null;
  const preview = findRendition(
    item.file,
    PREVIEW_SIZE_PREFERENCE,
    config.previewFormats,
  );

  const slug = asString(item.slug);
  const rawId = slug ?? asString(item.id) ?? main.url;
  const title = (asString(item.title) ?? "GIF").slice(0, 140);
  const width = main.width ?? preview?.width;
  const height = main.height ?? preview?.height;
  const pageUrl = buildPageUrl(config.pagePath, slug);

  return {
    id: rawId.slice(0, 120),
    title,
    url: main.url,
    previewUrl: preview?.url ?? main.url,
    ...(pageUrl ? { pageUrl } : {}),
    ...(width ? { width } : {}),
    ...(height ? { height } : {}),
    kind: KLIPY_ATTACHMENT_KIND[media],
    source: "klipy",
  };
};

// clips: `file` is a flat `{ mp4, gif, webp }` map of URLs, with dimensions in
// a sibling `file_meta` map keyed by the same format names.
const normalizeClipItem = (value: unknown): KlipyMediaResult | null => {
  const item = asRecord(value);
  if (!item) return null;

  const file = asRecord(item.file);
  if (!file) return null;
  const fileMeta = asRecord(item.file_meta);

  const videoUrl = normalizeKlipyMediaUrl(file.mp4);
  if (!videoUrl) return null;

  // The GIF (preferred) or WebP rendition is the image fallback that ships in
  // `url`, so clients that don't play the MP4 still show the animation.
  const imageUrl =
    normalizeKlipyMediaUrl(file.gif) ?? normalizeKlipyMediaUrl(file.webp);
  if (!imageUrl) return null;

  const imageMeta = asRecord(fileMeta?.gif) ?? asRecord(fileMeta?.webp);
  const width = asDimension(imageMeta?.width);
  const height = asDimension(imageMeta?.height);

  const slug = asString(item.slug);
  const rawId = slug ?? asString(item.id) ?? videoUrl;
  const title = (asString(item.title) ?? "Clip").slice(0, 140);
  const pageUrl = buildPageUrl("clips", slug);

  return {
    id: rawId.slice(0, 120),
    title,
    url: imageUrl,
    previewUrl: imageUrl,
    videoUrl,
    ...(pageUrl ? { pageUrl } : {}),
    ...(width ? { width } : {}),
    ...(height ? { height } : {}),
    kind: "clip",
    source: "klipy",
  };
};

const normalizeItem = (
  value: unknown,
  media: KlipyMediaKind,
): KlipyMediaResult | null =>
  media === "clips"
    ? normalizeClipItem(value)
    : normalizeNestedItem(value, media);

export async function GET(request: Request) {
  const apiKey = process.env.KLIPY_API_KEY?.trim();
  if (!apiKey) {
    return NextResponse.json(
      { error: "Klipy API key is not configured" },
      { status: 503 },
    );
  }

  const { searchParams } = new URL(request.url);
  const media = parseMediaKind(
    searchParams.get("media") ?? searchParams.get("type"),
  );
  const query = (searchParams.get("q") ?? searchParams.get("query") ?? "")
    .trim()
    .slice(0, MAX_QUERY_LENGTH);
  const page = clampInteger(searchParams.get("page"), 1, 1, 50);
  const perPage = clampInteger(
    searchParams.get("per_page") ?? searchParams.get("limit"),
    DEFAULT_PER_PAGE,
    8,
    MAX_PER_PAGE,
  );

  const endpoint = query ? "search" : "trending";
  const url = new URL(
    `${KLIPY_API_BASE_URL}/${encodeURIComponent(apiKey)}/${media}/${endpoint}`,
  );
  url.searchParams.set("page", String(page));
  url.searchParams.set("per_page", String(perPage));
  url.searchParams.set("rating", RATING);
  if (query) {
    url.searchParams.set("q", query);
  }

  const response = await fetch(url, {
    headers: { accept: "application/json" },
    cache: "no-store",
  });
  if (!response.ok) {
    return NextResponse.json(
      { error: "Klipy request failed" },
      { status: 502 },
    );
  }

  const body: unknown = await response.json();
  const data = asRecord(asRecord(body)?.data);
  const rawItems = Array.isArray(data?.data) ? data.data : [];
  const items = rawItems
    .map((item) => normalizeItem(item, media))
    .filter((item): item is KlipyMediaResult => Boolean(item));

  const payload: KlipyMediaSearchResponse = {
    items,
    page: typeof data?.current_page === "number" ? data.current_page : page,
    hasNext: data?.has_next === true,
  };

  return NextResponse.json(payload, {
    headers: {
      "Cache-Control": "no-store",
    },
  });
}
