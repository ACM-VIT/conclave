const LOCAL_DEV_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

export const isLocalDevAuthRuntimeEnabled = (): boolean =>
  process.env.NODE_ENV === "development";

export const isLocalDevAuthRequest = (request: Request): boolean => {
  if (!isLocalDevAuthRuntimeEnabled()) return false;
  const hostname = new URL(request.url).hostname;
  return LOCAL_DEV_HOSTS.has(hostname);
};

export const isDevEmailPasswordAuthPath = (request: Request): boolean => {
  const pathname = new URL(request.url).pathname;
  return (
    pathname.endsWith("/api/auth/sign-in/email") ||
    pathname.endsWith("/api/auth/sign-up/email")
  );
};
