export type BoundedBody =
  | { ok: true; bytes: Uint8Array<ArrayBuffer> }
  | { ok: false; reason: "too-large" | "unreadable" };

/**
 * Reads a request body but stops at `maxBytes`: the stream is cancelled as soon
 * as it grows past the limit, so an oversized or chunked upload is never
 * buffered in full.
 */
export const readBoundedBody = async (
  request: Request,
  maxBytes: number,
): Promise<BoundedBody> => {
  if (!request.body) return { ok: true, bytes: new Uint8Array(0) };
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        return { ok: false, reason: "too-large" };
      }
      chunks.push(value);
    }
  } catch {
    return { ok: false, reason: "unreadable" };
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { ok: true, bytes };
};

/** The declared Content-Length, or null when it is absent or not a plain integer. */
export const declaredContentLength = (request: Request): number | null => {
  const value = request.headers.get("content-length")?.trim();
  return value && /^\d+$/.test(value) ? Number(value) : null;
};
