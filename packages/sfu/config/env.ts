import { z } from "zod";

const DEVELOPMENT_SECRET = "development-secret";
const MAX_RETRY_DELAY_MS = 24 * 60 * 60 * 1000;

/** Unset and blank both mean "use the default". */
const blankAsUnset = (value: unknown): unknown =>
  typeof value === "string" && value.trim() === "" ? undefined : value;

/** A comma-separated list with blank entries dropped; an empty list means unset. */
const commaListOrUnset = (value: unknown): unknown => {
  if (typeof value !== "string") return value;
  const entries = value.split(",").map((entry) => entry.trim()).filter((entry) => entry !== "");
  return entries.length > 0 ? entries : undefined;
};

const delayMs = z.coerce
  .number({ error: "must be a whole number of milliseconds" })
  .int({ error: "must be a whole number of milliseconds" })
  .min(0, { error: "must not be negative" })
  .max(MAX_RETRY_DELAY_MS, { error: "must be at most one day" });

/**
 * The SFU settings that are read while the server runs, one schema each.
 * Each is read when it is used, so a test can set it, and all of them are
 * checked together at startup by parseSfuEnv.
 */
const sfuEnvFields = {
  CONCLAVE_FALLBACK_IMPORT_DIR: z.preprocess(blankAsUnset, z.string().trim().optional()),
  SFU_FOLLOW_UP_RETRY_DELAYS_MS: z.preprocess(
    commaListOrUnset,
    z.array(delayMs).default([5_000, 30_000, 120_000]),
  ),
};

type SfuEnvField = keyof typeof sfuEnvFields;
type SfuEnvValue<K extends SfuEnvField> = z.output<(typeof sfuEnvFields)[K]>;

// Calendar tokens are encrypted with a key hashed from the raw secret, padding
// included, unless SCHEDULING_TOKEN_SECRET is set. Keep in step with
// scripts/deploy-sfu-preflight.mjs.
const paddedSfuSecretMessage = (schedulingTokenSecret: string | undefined): string =>
  schedulingTokenSecret
    ? "SFU_SECRET has leading or trailing whitespace. Remove it; SCHEDULING_TOKEN_SECRET keeps saved calendar tokens readable."
    : "SFU_SECRET has leading or trailing whitespace. Saved calendar tokens are encrypted with the padded value, so first set SCHEDULING_TOKEN_SECRET to the exact current SFU_SECRET, padding included, before you trim SFU_SECRET.";

const sfuEnvSchema = z
  .object({
    ...sfuEnvFields,
    NODE_ENV: z.preprocess(blankAsUnset, z.string().optional()),
    SFU_SECRET: z.string().optional(),
    SCHEDULING_TOKEN_SECRET: z.string().optional(),
  })
  .superRefine((env, context) => {
    const raw = env.SFU_SECRET;
    const trimmed = raw?.trim();
    if (raw && raw !== trimmed) {
      context.addIssue({ code: "custom", path: ["SFU_SECRET"], message: paddedSfuSecretMessage(env.SCHEDULING_TOKEN_SECRET) });
    } else if (env.NODE_ENV === "production" && (!trimmed || trimmed === DEVELOPMENT_SECRET)) {
      context.addIssue({
        code: "custom",
        path: ["SFU_SECRET"],
        message: "SFU_SECRET must be set to a non-default value when NODE_ENV=production.",
      });
    }
  })
  .transform((env) => ({ ...env, SFU_SECRET: env.SFU_SECRET?.trim() || DEVELOPMENT_SECRET }));

export type SfuEnv = z.output<typeof sfuEnvSchema>;

const describePath = (path: readonly PropertyKey[]): string =>
  path.map((part) => (typeof part === "number" ? `entry ${part + 1}` : String(part))).join(" ");

const invalidEnv = (issues: z.ZodError["issues"], under: PropertyKey[] = []): Error =>
  new Error(
    `Invalid SFU environment:\n${issues
      .map((issue) => `  ${describePath([...under, ...issue.path])}: ${issue.message}`)
      .join("\n")}`,
  );

/** Checks every SFU setting at once and fails with one message naming each bad one. */
export const parseSfuEnv = (env: NodeJS.ProcessEnv = process.env): SfuEnv => {
  const result = sfuEnvSchema.safeParse(env);
  if (!result.success) throw invalidEnv(result.error.issues);
  return result.data;
};

/** Reads one SFU setting through its schema, with its default when it is unset. */
export const readSfuEnv = <K extends SfuEnvField>(key: K, env: NodeJS.ProcessEnv = process.env): SfuEnvValue<K> => {
  const result = sfuEnvFields[key].safeParse(env[key]);
  if (!result.success) throw invalidEnv(result.error.issues, [key]);
  return result.data as SfuEnvValue<K>;
};
