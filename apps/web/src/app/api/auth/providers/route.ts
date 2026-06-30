import { NextResponse } from "next/server";
import { isLocalDevAuthRequest } from "@/lib/dev-auth";

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

export async function GET(request: Request) {
  return NextResponse.json(
    {
      providers: enabledProviders(),
      devAuth: isLocalDevAuthRequest(request),
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
