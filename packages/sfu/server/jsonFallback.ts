/**
 * Runs when a store's SQLite file will not open. Production SFUs share one
 * volume and one SQLite file, so a JSON copy would be private to this process:
 * other instances overwrite it, and SQLite never imports it back once it holds
 * records. Production fails startup instead, and the container restart retries
 * SQLite, which also clears a "database is locked" race between instances at
 * boot. An explicit `<store>_PERSISTENCE=json` still selects JSON.
 */
export const ensureJsonFallbackAllowed = (
  modeVariable: string,
  mode: string | undefined,
  error: unknown,
): void => {
  if (mode === "sqlite") throw error;
  if (process.env.NODE_ENV !== "production") return;
  const reason = error instanceof Error ? error.message : String(error);
  throw new Error(
    `SQLite persistence did not open (${reason}). Production refuses the JSON fallback because SFU instances share one volume. Fix SQLite, or set ${modeVariable}=json for a single instance.`,
    { cause: error },
  );
};
