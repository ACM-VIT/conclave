/**
 * Boundary decoders for untrusted network input — express `req.body` /
 * `req.query`, socket.io handshake auth, and socket event payloads. Express
 * and socket.io type all of these as `any`; routing them through this module
 * narrows them to `unknown`-based records exactly once, at the boundary, so
 * downstream code validates instead of trusting.
 *
 * These are deliberately lenient decoders (absent/malformed → undefined or
 * {}): route handlers own their own required-field policy and error replies.
 * The games runtime has its own throwing decoders in games/validation.ts.
 */

/** A network payload after the only permitted assertion: "a JSON object". */
export type UntrustedRecord = Readonly<Record<string, unknown>>;

const EMPTY_RECORD: UntrustedRecord = Object.freeze({});

/** Narrow an untrusted value to a plain record; anything else becomes {}. */
export const asRecord = (value: unknown): UntrustedRecord =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as UntrustedRecord)
    : EMPTY_RECORD;

/** The request body as an untrusted record (express types `body` as `any`). */
export const requestBody = (req: { body?: unknown }): UntrustedRecord =>
  asRecord(req.body);

/**
 * An element-wise `unknown` view of an untrusted array, or null. Also the
 * antidote to `Array.isArray` widening `unknown` to `any[]`.
 */
export const asArray = (value: unknown): readonly unknown[] | null =>
  Array.isArray(value) ? (value as readonly unknown[]) : null;

/** A strictly-boolean field, or undefined. */
export const readBoolean = (
  record: UntrustedRecord,
  key: string,
): boolean | undefined => {
  const value = record[key];
  return typeof value === "boolean" ? value : undefined;
};

/** A string field (possibly empty), or undefined. */
export const readString = (
  record: UntrustedRecord,
  key: string,
): string | undefined => {
  const value = record[key];
  return typeof value === "string" ? value : undefined;
};

/** A finite-number field, or undefined. */
export const readNumber = (
  record: UntrustedRecord,
  key: string,
): number | undefined => {
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
};
