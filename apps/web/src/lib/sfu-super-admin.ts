const firstNonEmpty = (...values: Array<string | undefined>): string =>
  values.find((value) => value?.trim()) ?? "";

export const isSfuSuperAdminEmail = (
  sessionEmail: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): boolean => {
  const email = sessionEmail?.trim().toLowerCase();
  if (!email) return false;

  const lists = [
    firstNonEmpty(env.SFU_ADMIN_ALLOWLIST_EMAILS, env.SFU_ADMIN_ALLOWED_EMAILS),
    firstNonEmpty(
      env.SFU_ALWAYS_HOST_EMAILS,
      env.SFU_ALWAYS_HOST_EMAIL,
      env.ALWAYS_HOST_EMAILS,
      env.ALWAYS_HOST_EMAIL,
    ),
  ];
  return lists.some((list) =>
    list.split(",").some((entry) => entry.trim().toLowerCase() === email),
  );
};
