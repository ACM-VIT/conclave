import { Logger } from "../utilities/loggers.js";

/**
 * Resolve the allowed CORS origins from the SFU_CORS_ORIGINS env var.
 *
 * SFU_CORS_ORIGINS is a comma-separated allow-list, e.g.
 *   SFU_CORS_ORIGINS="https://app.example.com,https://admin.example.com"
 *
 * When unset in development, we fall back to "*" so local dev is unchanged.
 * In production, wildcard CORS must be an explicit operator choice via
 * SFU_ALLOW_OPEN_CORS=1; otherwise startup fails fast.
 *
 * Returns either the literal "*" (allow any origin) or an explicit list of
 * origins. The shape is compatible with both the `cors` express middleware and
 * socket.io's `cors.origin` option.
 */
export const resolveCorsOrigins = (): "*" | string[] => {
  const raw = process.env.SFU_CORS_ORIGINS?.trim();
  const isProduction = process.env.NODE_ENV === "production";
  const allowOpenCors = process.env.SFU_ALLOW_OPEN_CORS === "1";

  if (!raw) {
    if (isProduction && !allowOpenCors) {
      throw new Error(
        "SFU_CORS_ORIGINS must be set in production, or set SFU_ALLOW_OPEN_CORS=1 to explicitly allow wildcard CORS.",
      );
    }
    if (isProduction) {
      Logger.warn("[SFU] SFU_ALLOW_OPEN_CORS=1; allowing wildcard CORS.");
    }
    return "*";
  }

  const origins = raw
    .split(",")
    .map((origin) => origin.trim())
    .filter((origin) => origin.length > 0);

  // A list that explicitly contains "*" (or collapses to empty) is treated as
  // allow-any so an operator can intentionally opt back into the open policy.
  if (origins.length === 0 || origins.includes("*")) {
    if (isProduction && !allowOpenCors) {
      throw new Error(
        "Wildcard SFU_CORS_ORIGINS is not allowed in production unless SFU_ALLOW_OPEN_CORS=1.",
      );
    }
    if (isProduction) {
      Logger.warn("[SFU] SFU_ALLOW_OPEN_CORS=1; allowing wildcard CORS.");
    }
    return "*";
  }

  const normalizedOrigins: string[] = [];
  for (const origin of origins) {
    try {
      const parsed = new URL(origin);
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        throw new Error("unsupported protocol");
      }
      parsed.pathname = "";
      parsed.search = "";
      parsed.hash = "";
      normalizedOrigins.push(parsed.toString().replace(/\/$/, ""));
    } catch {
      throw new Error(`Invalid SFU_CORS_ORIGINS entry: ${origin}`);
    }
  }

  return Array.from(new Set(normalizedOrigins));
};
