export const sourceMapUploadRequested = (env) =>
  env.CI === "true" &&
  env.POSTHOG_SOURCEMAPS_UPLOAD === "1" &&
  Boolean(env.POSTHOG_CLI_API_KEY && env.POSTHOG_CLI_PROJECT_ID);
