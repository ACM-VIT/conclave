import { NextResponse } from "next/server";

export const runtime = "nodejs";

type AuthProviderId = "google" | "apple" | "roblox" | "vercel";

const enabledProviders = (): AuthProviderId[] => {
  const providers: AuthProviderId[] = [];
  if (process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET) {
    providers.push("google");
  }
  if (process.env.APPLE_CLIENT_ID && process.env.APPLE_CLIENT_SECRET) {
    providers.push("apple");
  }
  if (process.env.ROBLOX_CLIENT_ID && process.env.ROBLOX_CLIENT_SECRET) {
    providers.push("roblox");
  }
  if (process.env.VERCEL_CLIENT_ID && process.env.VERCEL_CLIENT_SECRET) {
    providers.push("vercel");
  }
  return providers;
};

export async function GET() {
  return NextResponse.json(
    { providers: enabledProviders() },
    { headers: { "Cache-Control": "no-store" } },
  );
}
