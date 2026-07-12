// Pure helpers for the /api/unfurl route: hostname safety checks and a
// tolerant Open Graph / Twitter-card scraper. Everything here is plain string
// work so it runs identically in Node (next dev), workerd (production), and
// vitest.

export interface UnfurlPageMetadata {
  title?: string;
  description?: string;
  siteName?: string;
  imageUrl?: string;
  faviconUrl?: string;
  /** How the embed card should present the image: hero or side thumbnail. */
  imageLayout?: "large" | "thumb";
}

const MAX_TITLE_LENGTH = 200;
const MAX_DESCRIPTION_LENGTH = 400;
const MAX_SITE_NAME_LENGTH = 80;
const MAX_URL_LENGTH = 2048;

// Hosts that must never be fetched server-side. Production additionally runs
// with Cloudflare's `global_fetch_strictly_public` flag, which blocks private
// address resolution outright; this list keeps `next dev` (plain Node fetch)
// from being used as a LAN probe and gives both runtimes fast, uniform errors.
const BLOCKED_HOST_SUFFIXES = [
  ".localhost",
  ".local",
  ".internal",
  ".intranet",
  ".home.arpa",
  ".onion",
];

const isPrivateIpv4 = (hostname: string): boolean => {
  const match = hostname.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!match) return false;
  const octets = match.slice(1).map((part) => Number.parseInt(part, 10));
  if (octets.some((octet) => !Number.isFinite(octet) || octet > 255)) {
    // Not a real IPv4 literal; treat it as a hostname instead.
    return false;
  }
  const [a, b] = octets;
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT 100.64/10
  if (a === 169 && b === 254) return true; // link-local + cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 192 && b === 0) return true; // 192.0.0/24 + 192.0.2/24 test range
  if (a === 198 && (b === 18 || b === 19)) return true; // benchmarking
  if (a >= 224) return true; // multicast + reserved + broadcast
  return false;
};

/**
 * Returns true when a hostname must not be unfurled: loopback, private and
 * special-use IPv4 ranges, every IPv6 literal (shared links are never raw
 * IPv6, and the ranges are fiddly to classify), single-label intranet names,
 * and reserved DNS suffixes. Expects a hostname as produced by `new URL()`,
 * which canonicalizes integer/octal/hex IPv4 forms to dotted quads.
 */
export function isForbiddenUnfurlHost(rawHostname: string): boolean {
  const hostname = rawHostname.toLowerCase().replace(/\.+$/, "");
  if (!hostname) return true;
  if (hostname.startsWith("[") || hostname.includes(":")) return true;
  if (hostname === "localhost") return true;
  if (!hostname.includes(".")) return true;
  if (BLOCKED_HOST_SUFFIXES.some((suffix) => hostname.endsWith(suffix))) {
    return true;
  }
  return isPrivateIpv4(hostname);
}

/**
 * Parses and validates a URL that the unfurler is allowed to touch — http(s)
 * only, no embedded credentials, sane length, public-looking host. Returns
 * null when the candidate fails any check.
 */
export function parseUnfurlableUrl(candidate: string): URL | null {
  if (!candidate || candidate.length > MAX_URL_LENGTH) return null;
  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  if (url.username || url.password) return null;
  if (isForbiddenUnfurlHost(url.hostname)) return null;
  return url;
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  mdash: "—",
  ndash: "–",
  hellip: "…",
  rsquo: "’",
  lsquo: "‘",
  rdquo: "”",
  ldquo: "“",
};

export function decodeHtmlEntities(value: string): string {
  return value.replace(
    /&(?:#x([0-9a-f]+)|#(\d+)|([a-z]+));/gi,
    (whole, hex: string | undefined, dec: string | undefined, named: string | undefined) => {
      const codePoint = hex
        ? Number.parseInt(hex, 16)
        : dec
          ? Number.parseInt(dec, 10)
          : null;
      if (codePoint !== null) {
        if (!Number.isFinite(codePoint) || codePoint <= 0 || codePoint > 0x10ffff) {
          return whole;
        }
        try {
          return String.fromCodePoint(codePoint);
        } catch {
          return whole;
        }
      }
      const replacement = named ? NAMED_ENTITIES[named.toLowerCase()] : undefined;
      return replacement ?? whole;
    },
  );
}

const cleanText = (value: string, maxLength: number): string | undefined => {
  const text = decodeHtmlEntities(value).replace(/\s+/g, " ").trim();
  if (!text) return undefined;
  return text.length > maxLength ? `${text.slice(0, maxLength - 1)}…` : text;
};

// Resolves a scraped URL (possibly relative or protocol-relative) against the
// page URL and re-applies the public-host rules, so a page can't point the
// viewer's browser at file:, javascript:, or LAN addresses.
const resolveSafeUrl = (candidate: string, base: URL): string | undefined => {
  const raw = decodeHtmlEntities(candidate).trim();
  if (!raw) return undefined;
  let resolved: URL;
  try {
    resolved = new URL(raw, base);
  } catch {
    return undefined;
  }
  if (resolved.protocol !== "http:" && resolved.protocol !== "https:") {
    return undefined;
  }
  if (resolved.username || resolved.password) return undefined;
  if (isForbiddenUnfurlHost(resolved.hostname)) return undefined;
  return resolved.href.length > MAX_URL_LENGTH ? undefined : resolved.href;
};

// Pulls attributes out of a single tag's source. Handles double-quoted,
// single-quoted, and bare values, any attribute order, and uppercase names.
const parseTagAttributes = (tagSource: string): Map<string, string> => {
  const attributes = new Map<string, string>();
  const pattern = /([a-zA-Z][a-zA-Z0-9:_-]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'<>`]+))/g;
  for (const match of tagSource.matchAll(pattern)) {
    const name = match[1].toLowerCase();
    if (!attributes.has(name)) {
      attributes.set(name, match[2] ?? match[3] ?? match[4] ?? "");
    }
  }
  return attributes;
};

/**
 * Extracts embed metadata from an HTML document (or its truncated prefix).
 * Tolerates attribute-order and quoting variance rather than parsing a full
 * DOM — meta/link/title tags are effectively line-oriented in real pages.
 */
export function parseUnfurlHtml(html: string, pageUrl: URL): UnfurlPageMetadata {
  const meta = new Map<string, string>();
  for (const match of html.matchAll(/<meta\b[^>]*>/gi)) {
    const attributes = parseTagAttributes(match[0]);
    const key = (attributes.get("property") ?? attributes.get("name"))?.toLowerCase();
    const content = attributes.get("content");
    if (!key || content === undefined || meta.has(key)) continue;
    meta.set(key, content);
  }

  const pick = (...keys: string[]): string | undefined => {
    for (const key of keys) {
      const value = meta.get(key);
      if (value !== undefined && value.trim()) return value;
    }
    return undefined;
  };

  const titleTag = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1];
  const title = cleanText(
    pick("og:title", "twitter:title") ?? titleTag ?? "",
    MAX_TITLE_LENGTH,
  );
  const description = cleanText(
    pick("og:description", "twitter:description", "description") ?? "",
    MAX_DESCRIPTION_LENGTH,
  );
  const siteName = cleanText(
    pick("og:site_name", "application-name") ?? "",
    MAX_SITE_NAME_LENGTH,
  );

  const imageCandidate = pick(
    "og:image:secure_url",
    "og:image",
    "og:image:url",
    "twitter:image",
    "twitter:image:src",
  );
  const imageUrl = imageCandidate
    ? resolveSafeUrl(imageCandidate, pageUrl)
    : undefined;

  let faviconUrl: string | undefined;
  for (const match of html.matchAll(/<link\b[^>]*>/gi)) {
    const attributes = parseTagAttributes(match[0]);
    const rel = attributes.get("rel")?.toLowerCase() ?? "";
    if (!/(^|\s)(icon|shortcut icon|apple-touch-icon)(\s|$)/.test(rel)) continue;
    const href = attributes.get("href");
    if (!href) continue;
    const resolved = resolveSafeUrl(href, pageUrl);
    if (resolved) {
      faviconUrl = resolved;
      break;
    }
  }
  if (!faviconUrl) {
    faviconUrl = `${pageUrl.origin}/favicon.ico`;
  }

  let imageLayout: UnfurlPageMetadata["imageLayout"];
  if (imageUrl) {
    const twitterCard = pick("twitter:card")?.trim().toLowerCase();
    const imageWidth = Number.parseInt(pick("og:image:width") ?? "", 10);
    const isLarge =
      twitterCard === "summary_large_image" ||
      Boolean(pick("og:video", "og:video:url", "og:video:secure_url")) ||
      (Number.isFinite(imageWidth) && imageWidth >= 600);
    imageLayout = isLarge ? "large" : "thumb";
  }

  return { title, description, siteName, imageUrl, faviconUrl, imageLayout };
}
