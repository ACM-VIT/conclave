import { Logger } from "../utilities/loggers.js";

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
