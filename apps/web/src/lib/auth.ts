import { betterAuth } from "better-auth";
import { createRemoteJWKSet, jwtVerify } from "jose";

const appleProvider =
  process.env.APPLE_CLIENT_ID && process.env.APPLE_CLIENT_SECRET
    ? {
        apple: {
          clientId: process.env.APPLE_CLIENT_ID,
          clientSecret: process.env.APPLE_CLIENT_SECRET,
          appBundleIdentifier:
            process.env.APPLE_APP_BUNDLE_IDENTIFIER ||
            process.env.APPLE_APP_BUNDLE_ID,
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

export const auth = betterAuth({
  session: {
    expiresIn: 60 * 60 * 24 * 7, 
    cookieCache: {
      enabled: true,
      maxAge: 60 * 5,
    },
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
  
  trustedOrigins: [
    process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000",
    "https://appleid.apple.com",
  ],
  
  advanced: {
    useSecureCookies: process.env.NODE_ENV === "production",
  },
});

export type Session = typeof auth.$Infer.Session;
