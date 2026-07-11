import { betterAuth } from "better-auth";
import { createRemoteJWKSet, jwtVerify } from "jose";
import { isLocalDevAuthRuntimeEnabled } from "@/lib/dev-auth";
import {
  getAuthBaseUrl,
  getPublicSiteUrl,
  normalizeOrigin,
} from "@/lib/site-url";

const appleAppBundleIdentifier =
  process.env.APPLE_APP_BUNDLE_IDENTIFIER ||
  process.env.APPLE_APP_BUNDLE_ID ||
  "com.acmvit.conclave";

const appleProvider =
  process.env.APPLE_CLIENT_ID && process.env.APPLE_CLIENT_SECRET
    ? {
        apple: {
          clientId: process.env.APPLE_CLIENT_ID,
          clientSecret: process.env.APPLE_CLIENT_SECRET,
          appBundleIdentifier: appleAppBundleIdentifier,
          audience: [process.env.APPLE_CLIENT_ID, appleAppBundleIdentifier],
        },
      }
    : {};

const robloxProvider =
  process.env.ROBLOX_CLIENT_ID && process.env.ROBLOX_CLIENT_SECRET
    ? {
        roblox: {
          clientId: process.env.ROBLOX_CLIENT_ID,
          clientSecret: process.env.ROBLOX_CLIENT_SECRET,
        },
      }
    : {};

const vercelProvider =
  process.env.VERCEL_CLIENT_ID && process.env.VERCEL_CLIENT_SECRET
    ? {
        vercel: {
          clientId: process.env.VERCEL_CLIENT_ID,
          clientSecret: process.env.VERCEL_CLIENT_SECRET,
        },
      }
    : {};

const googleJwks = createRemoteJWKSet(
  new URL("https://www.googleapis.com/oauth2/v3/certs")
);

const parseCsv = (value: string | undefined): string[] =>
  (value || "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);

const authBaseURL = getAuthBaseUrl();

const configuredAppOrigins = [
  authBaseURL,
  getPublicSiteUrl(),
  process.env.VERCEL_URL,
  ...parseCsv(process.env.BETTER_AUTH_TRUSTED_ORIGINS),
]
  .map(normalizeOrigin)
  .filter((origin): origin is string => Boolean(origin));

const resolveTrustedOrigins = (): string[] => {
  const origins = new Set<string>([
    "http://localhost:3000",
    "http://localhost:3001",
    "http://127.0.0.1:3000",
    "http://127.0.0.1:3001",
    "https://appleid.apple.com",
    ...configuredAppOrigins,
  ]);

  return Array.from(origins);
};

const AUTH_SESSION_MAX_AGE_SECONDS = 60 * 60 * 24 * 365;
const isDevAuthEnabled = isLocalDevAuthRuntimeEnabled();

export const auth = betterAuth({
  baseURL: authBaseURL,
  session: {
    expiresIn: AUTH_SESSION_MAX_AGE_SECONDS,
    cookieCache: {
      enabled: true,
      strategy: "jwe",
      refreshCache: true,
      maxAge: AUTH_SESSION_MAX_AGE_SECONDS,
    },
  },
  user: {
    deleteUser: {
      enabled: true,
    },
  },
  emailAndPassword: {
    enabled: isDevAuthEnabled,
    disableSignUp: !isDevAuthEnabled,
    minPasswordLength: 8,
  },

  socialProviders: {
    google: {
      clientId: process.env.GOOGLE_CLIENT_ID!,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET!,
      verifyIdToken: async (token, nonce) => {
        try {
          const audiences = [
            process.env.GOOGLE_CLIENT_ID,
            process.env.GOOGLE_ANDROID_CLIENT_ID,
            process.env.GOOGLE_IOS_CLIENT_ID,
            process.env.GOOGLE_EXPO_CLIENT_ID,
            process.env.EXPO_PUBLIC_GOOGLE_ANDROID_CLIENT_ID,
            process.env.EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID,
            process.env.EXPO_PUBLIC_GOOGLE_EXPO_CLIENT_ID,
          ].filter((value): value is string => Boolean(value));
          const { payload } = await jwtVerify(token, googleJwks, {
            algorithms: ["RS256"],
            issuer: ["https://accounts.google.com", "accounts.google.com"],
            audience: audiences.length ? audiences : process.env.GOOGLE_CLIENT_ID,
            maxTokenAge: "1h",
          });
          if (nonce && payload.nonce !== nonce) return false;
          return true;
        } catch {
          return false;
        }
      },
    },
    ...appleProvider,
    ...robloxProvider,
    ...vercelProvider,
  },
  trustedOrigins: resolveTrustedOrigins,

  advanced: {
    useSecureCookies: process.env.NODE_ENV === "production",
  },
});
