import { betterAuth } from "better-auth";

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
    },
    ...appleProvider,
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
