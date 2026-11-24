export type WireBytes = {
  readonly length: number;
  readonly read: () => Uint8Array | null;
};

const BASE64_PATTERN = /^[A-Za-z0-9+/]+={0,2}$/;
const PAD = 61;
const WHITESPACE = /\s/;

const isNumberList = (items: unknown[]): boolean => items.every((item) => typeof item === "number");

const fromNumbers = (items: unknown[]): WireBytes => ({
  length: items.length,
  read: () => (isNumberList(items) ? Uint8Array.from(items as number[]) : null),
});

const fromBase64 = (value: string): WireBytes | null => {
  let start = 0;
  let end = value.length;
  while (start < end && WHITESPACE.test(value[start])) start += 1;
  while (end > start && WHITESPACE.test(value[end - 1])) end -= 1;
  const characters = end - start;
  if (characters === 0 || characters % 4 !== 0) return null;
  let padding = 0;
  while (padding < 3 && value.charCodeAt(end - 1 - padding) === PAD) padding += 1;
  if (padding > 2) return null;
  return {
    length: (characters / 4) * 3 - padding,
    read: () => {
      const text = value.slice(start, end);
      if (!BASE64_PATTERN.test(text)) return null;
      return Uint8Array.from(Buffer.from(text, "base64"));
    },
  };
};

export const wireBytes = (value: unknown): WireBytes | null => {
  if (value instanceof Uint8Array) return { length: value.length, read: () => value };
  if (value instanceof ArrayBuffer) return { length: value.byteLength, read: () => new Uint8Array(value) };
  if (ArrayBuffer.isView(value)) {
    return { length: value.byteLength, read: () => new Uint8Array(value.buffer, value.byteOffset, value.byteLength) };
  }
  if (Array.isArray(value)) return fromNumbers(value);
  if (typeof value === "string") return fromBase64(value);
  if (value && typeof value === "object") {
    const maybeBuffer = value as { type?: unknown; data?: unknown };
    if (maybeBuffer.type === "Buffer" && Array.isArray(maybeBuffer.data)) return fromNumbers(maybeBuffer.data);
  }
  return null;
};
