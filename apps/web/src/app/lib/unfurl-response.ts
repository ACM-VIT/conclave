// Reads at most `maxBytes` of the body, stopping early once the document head
// has closed — everything the parser wants lives there on real pages.
export const readHtmlPrefix = async (
  response: Response,
  maxBytes: number,
): Promise<string> => {
  const body = response.body;
  if (!body) return "";
  const reader = body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: false });
  let html = "";
  let receivedBytes = 0;
  try {
    while (receivedBytes < maxBytes) {
      const { done, value } = await reader.read();
      if (done) break;
      const remainingBytes = maxBytes - receivedBytes;
      const chunk = value.subarray(0, remainingBytes);
      receivedBytes += chunk.byteLength;
      html += decoder.decode(chunk, { stream: true });
      if (html.includes("</head")) break;
    }
  } finally {
    reader.cancel().catch(() => {});
  }
  return html + decoder.decode();
};

/**
 * Passes a body through unchanged, erroring the stream once `maxBytes` have
 * flowed. Used for media too large to buffer — backpressure means only what
 * the client actually consumes is transferred.
 */
export const boundedResponseStream = (
  body: ReadableStream<Uint8Array>,
  maxBytes: number,
): ReadableStream<Uint8Array> => {
  let receivedBytes = 0;
  return body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        receivedBytes += chunk.byteLength;
        if (receivedBytes > maxBytes) {
          controller.error(new Error("unfurl asset exceeded byte limit"));
          return;
        }
        controller.enqueue(chunk);
      },
    }),
  );
};

/** Buffers a response only when its complete body fits within `maxBytes`. */
export const readBoundedResponseBytes = async (
  response: Response,
  maxBytes: number,
): Promise<Uint8Array | null> => {
  const body = response.body;
  if (!body) return new Uint8Array();
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let receivedBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value.byteLength > maxBytes - receivedBytes) return null;
      chunks.push(value);
      receivedBytes += value.byteLength;
    }
  } finally {
    reader.cancel().catch(() => {});
  }

  const result = new Uint8Array(receivedBytes);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
};
