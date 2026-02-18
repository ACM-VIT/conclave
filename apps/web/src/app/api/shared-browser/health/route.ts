import { NextResponse } from "next/server";

export const runtime = "nodejs";

const resolveBrowserServiceUrl = () =>
  process.env.BROWSER_SERVICE_URL ||
  process.env.NEXT_PUBLIC_BROWSER_SERVICE_URL ||
  "http://localhost:3040";

const resolveBrowserServiceToken = () =>
  process.env.BROWSER_SERVICE_TOKEN ||
  process.env.NEXT_PUBLIC_BROWSER_SERVICE_TOKEN ||
  "";

export async function GET() {
  const baseUrl = resolveBrowserServiceUrl();
  const token = resolveBrowserServiceToken();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 2000);

  try {
    const headers: Record<string, string> = {};
    if (token) {
      headers["x-browser-service-token"] = token;
    }

    const response = await fetch(`${baseUrl}/health`, {
      headers,
      signal: controller.signal,
      cache: "no-store",
    });
    if (!response.ok) {
      return NextResponse.json({ ok: false }, { status: 200 });
    }
    const data = (await response.json().catch(() => null)) as
      | { status?: string }
      | null;
    return NextResponse.json({
      ok: true,
      status: data?.status ?? "ok",
    });
  } catch (_error) {
    return NextResponse.json({ ok: false }, { status: 200 });
  } finally {
    clearTimeout(timeout);
  }
}
