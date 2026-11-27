import type { Request } from "express";

export const defaultAppOrigin = (): string =>
  (
    process.env.NEXT_PUBLIC_APP_URL ||
    process.env.NEXT_PUBLIC_SITE_URL ||
    process.env.BETTER_AUTH_BASE_URL ||
    "https://conclave.acmvit.in"
  ).replace(/\/$/, "");

export const resolveAppOrigin = (req: Request): string => {
  const fromHeader = req.header("x-app-origin")?.trim();
  return fromHeader ? fromHeader.replace(/\/$/, "") : defaultAppOrigin();
};
