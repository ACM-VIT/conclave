import { isLoopbackViewerHost, LOOPBACK_PAGE_HOSTS, resolveViewerUrl } from "./novnc-viewer";

export type HeaderEntry = { key: string; value: string };

export const CSP_REPORT_PATH = "/api/csp-report";

// These routes serve a generated SVG and proxied images under their own
// sandbox policy. Next.js drops a route's header when config already set the
// same key, so config has to send the sandbox policy for them.
export const SANDBOXED_ROUTE_SOURCES = ["/api/avatar", "/api/unfurl/asset"];
export const SANDBOXED_ROUTE_HEADERS: HeaderEntry[] = [
  { key: "Content-Security-Policy", value: "default-src 'none'; sandbox; frame-ancestors 'none'" },
];

// The production SFU pool (sfu, sfu-a, sfu-b) and the transcription worker
// live under this domain. Their URLs reach the browser at runtime from the
// join API and the SFU, so they cannot be listed at build time.
const PRODUCTION_REALTIME_HOSTS = ["*.acmvit.in"];

const SFU_ENV_KEYS = [
  "SFU_URL",
  "SFU_URLS",
  "SFU_POOL",
  "SFU_POOL_URLS",
  "NEXT_PUBLIC_SFU_URL",
  "NEXT_PUBLIC_SFU_URLS",
] as const;
const REALTIME_ENV_KEYS = [
  ...SFU_ENV_KEYS,
  "TRANSCRIPT_WORKER_URL",
  "NEXT_PUBLIC_TRANSCRIPT_WORKER_URL",
  "NEXT_PUBLIC_POSTHOG_HOST",
] as const;

const POSTHOG_ORIGINS = [
  "https://eu.posthog.com",
  "https://eu.i.posthog.com",
  "https://eu-assets.i.posthog.com",
];
const POSTHOG_SCRIPT_ORIGIN = "https://eu-assets.i.posthog.com";

// Video effects try same-origin MediaPipe assets first and fall back to these.
const MEDIAPIPE_SCRIPT_ORIGIN = "https://cdn.jsdelivr.net";
const MEDIAPIPE_MODEL_ORIGIN = "https://storage.googleapis.com";

const YOUTUBE_FRAME_ORIGINS = ["https://www.youtube-nocookie.com", "https://www.youtube.com"];
// The Watch app loads the iframe API script and reads oEmbed titles here.
const YOUTUBE_ORIGIN = "https://www.youtube.com";
const YOUTUBE_IMAGE_ORIGIN = "https://i.ytimg.com";
const KLIPY_MEDIA_ORIGIN = "https://static.klipy.com";
// The AI voice agent negotiates its realtime call with OpenAI from the browser.
const OPENAI_API_ORIGIN = "https://api.openai.com";
const SHARED_BROWSER_FRAME_ORIGIN = "https://live.browser.run";

type EnvSource = Partial<Record<string, string | undefined>>;

/** http(s) origins from comma lists that may use `id=url` pool entries. */
const originsFromEnv = (env: EnvSource, keys: readonly string[]): string[] => {
  const origins = new Set<string>();
  for (const key of keys) {
    for (const rawEntry of (env[key] ?? "").split(",")) {
      const entry = rawEntry.slice(rawEntry.indexOf("=") + 1).trim();
      if (!entry) continue;
      try {
        const url = new URL(entry);
        if (url.protocol === "https:" || url.protocol === "http:") origins.add(url.origin);
      } catch {
        // Not a URL; the app's own config validation reports it.
      }
    }
  }
  return [...origins];
};

/**
 * A self-hosted Chromium viewer is framed from the URL the browser service
 * builds: BROWSER_PUBLIC_BASE_URL when set, otherwise each noVNC port on
 * BROWSER_HOST_ADDRESS. A loopback address is framed on the page's own host
 * (resolveViewerUrl), so it is allowed on each loopback page host.
 */
const chromiumViewers = (env: EnvSource): { urls: URL[]; anyPort: boolean } => {
  const host = env.BROWSER_HOST_ADDRESS?.trim();
  const configured = originsFromEnv(env, ["BROWSER_PUBLIC_BASE_URL"]);
  const viewers = configured.length > 0 ? configured : host ? [`http://${host.includes(":") ? `[${host}]` : host}:6080`] : [];
  const urls = viewers.flatMap((viewer) => {
    try {
      return [new URL(viewer)];
    } catch {
      return [];
    }
  });
  return { urls, anyPort: configured.length === 0 };
};

const chromiumViewerSources = (env: EnvSource, extraPageHosts: string[]): string[] => {
  const { urls, anyPort } = chromiumViewers(env);
  const sources = new Set<string>();
  for (const parsed of urls) {
    const pageHosts = isLoopbackViewerHost(parsed.hostname) ? [...LOOPBACK_PAGE_HOSTS, ...extraPageHosts] : [parsed.hostname];
    for (const pageHost of pageHosts) {
      const framed = new URL(resolveViewerUrl(parsed.toString(), pageHost));
      sources.add(anyPort ? `${framed.protocol}//${framed.hostname}:*` : framed.origin);
    }
  }
  return [...sources];
};

const withSocketScheme = (origin: string): string[] => [
  origin,
  origin.replace(/^http/, "ws"),
];

// The development server frames itself for the dev bots panel's inline participants.
const frameAncestors = (isDevelopment: boolean): string =>
  isDevelopment ? "'self'" : "'none'";

const serializePolicy = (directives: Record<string, string[]>): string =>
  Object.entries(directives)
    .map(([name, sources]) => [name, ...sources].join(" "))
    .join("; ");

export const buildContentSecurityPolicy = ({
  env,
  isDevelopment,
  pageHost,
}: {
  env: EnvSource;
  isDevelopment: boolean;
  pageHost?: string;
}): string => {
  const productionOrigins = PRODUCTION_REALTIME_HOSTS.map((host) => `https://${host}`);
  // Chat images are served by the SFU that stored them.
  const sfuOrigins = [...productionOrigins, ...originsFromEnv(env, SFU_ENV_KEYS)];
  const realtimeOrigins = [
    ...productionOrigins,
    ...originsFromEnv(env, REALTIME_ENV_KEYS),
  ].flatMap(withSocketScheme);
  return serializePolicy({
    "default-src": ["'self'"],
    // Next.js streams the RSC payload in inline scripts. Dropping
    // 'unsafe-inline' needs per-request nonces (see the README).
    "script-src": [
      "'self'",
      "'unsafe-inline'",
      "'wasm-unsafe-eval'",
      ...(isDevelopment ? ["'unsafe-eval'"] : []),
      "blob:",
      MEDIAPIPE_SCRIPT_ORIGIN,
      YOUTUBE_ORIGIN,
      POSTHOG_SCRIPT_ORIGIN,
    ],
    "style-src": ["'self'", "'unsafe-inline'"],
    "img-src": ["'self'", "data:", "blob:", ...sfuOrigins, YOUTUBE_IMAGE_ORIGIN, KLIPY_MEDIA_ORIGIN],
    "media-src": ["'self'", "data:", "blob:", KLIPY_MEDIA_ORIGIN],
    "font-src": ["'self'", "data:"],
    "connect-src": [
      "'self'",
      "data:",
      "blob:",
      ...new Set([
        ...realtimeOrigins,
        ...POSTHOG_ORIGINS,
        MEDIAPIPE_SCRIPT_ORIGIN,
        MEDIAPIPE_MODEL_ORIGIN,
        YOUTUBE_ORIGIN,
        OPENAI_API_ORIGIN,
      ]),
    ],
    "frame-src": [
      "'self'",
      ...YOUTUBE_FRAME_ORIGINS,
      SHARED_BROWSER_FRAME_ORIGIN,
      ...chromiumViewerSources(env, pageHost ? [pageHost] : []),
    ],
    "worker-src": ["'self'", "blob:"],
    "manifest-src": ["'self'"],
    "object-src": ["'none'"],
    "base-uri": ["'self'"],
    "form-action": ["'self'"],
    "frame-ancestors": [frameAncestors(isDevelopment)],
    // report-uri, not report-to: Chrome drops report-uri when report-to is
    // present, Firefox and Safari only send report-uri, and Reporting API
    // batches were not delivered at all in local runs.
    "report-uri": [CSP_REPORT_PATH],
  });
};

const PAGE_HOST_PARAM = "pageHost";
const PAGE_HOST_PLACEHOLDER = "page-host.invalid";

/**
 * The client frames a loopback viewer on whatever host the page was opened on,
 * including a name mapped to loopback. Next fills :pageHost from the request's
 * host; the capture admits only plain hostnames, and other hosts keep the
 * static policy.
 */
export const buildViewerPageHostRules = (options: {
  env: EnvSource;
  isDevelopment: boolean;
}): { has: { type: "host"; value: string }[]; headers: HeaderEntry[] }[] => {
  if (!chromiumViewers(options.env).urls.some((url) => isLoopbackViewerHost(url.hostname))) return [];
  const policy = buildContentSecurityPolicy({ ...options, pageHost: PAGE_HOST_PLACEHOLDER })
    .replaceAll(PAGE_HOST_PLACEHOLDER, `:${PAGE_HOST_PARAM}`);
  return [{
    has: [{ type: "host", value: `(?<${PAGE_HOST_PARAM}>[a-z0-9-]+(?:\\.[a-z0-9-]+)*)` }],
    headers: [{ key: "Content-Security-Policy-Report-Only", value: policy }],
  }];
};

/** Headers for every response the Next.js server or the OpenNext worker renders. */
export const buildSecurityHeaders = (options: {
  env: EnvSource;
  isDevelopment: boolean;
}): HeaderEntry[] => [
  { key: "X-Frame-Options", value: options.isDevelopment ? "SAMEORIGIN" : "DENY" },
  { key: "Content-Security-Policy", value: `frame-ancestors ${frameAncestors(options.isDevelopment)}` },
  {
    key: "Content-Security-Policy-Report-Only",
    value: buildContentSecurityPolicy(options),
  },
  { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  {
    key: "Permissions-Policy",
    value: [
      "camera=(self)",
      "microphone=(self)",
      "display-capture=(self)",
      `fullscreen=(self ${YOUTUBE_FRAME_ORIGINS.map((origin) => `"${origin}"`).join(" ")})`,
      "geolocation=()",
      "payment=()",
      "usb=()",
    ].join(", "),
  },
];
