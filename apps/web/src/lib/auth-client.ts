import { createAuthClient } from "better-auth/react";

const authClient = createAuthClient({
  basePath: "/api/auth",
  sessionOptions: {
    refetchOnWindowFocus: true,
    refetchInterval: 5 * 60,
  },
});

export const { signIn, signOut, useSession } = authClient;
