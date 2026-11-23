import * as Y from "yjs";

type Struct = ReturnType<typeof Y.decodeUpdate>["structs"][number];
type Run = { client: number; clock: number; parts: Uint8Array[] };

const SKIP_INFO = 10;
const CHUNK_HEADER_BYTES = 6;
const RUN_HEADER_BYTES = 18;
const CUT_SLACK_BYTES = 48;

const varUint = (value: number): Uint8Array => {
  const bytes: number[] = [];
  let rest = value;
  while (rest > 0x7f) {
    bytes.push(0x80 | (rest & 0x7f));
    rest = Math.floor(rest / 128);
  }
  bytes.push(rest);
  return Uint8Array.from(bytes);
};

const concat = (parts: Uint8Array[]): Uint8Array => {
  const out = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
};

const encodeFrom = (struct: Struct, offset: number): Uint8Array => {
  const encoder = new Y.UpdateEncoderV1();
  struct.write(encoder, offset);
  return encoder.toUint8Array();
};

const sliceItem = (item: Y.Item, at: number): Y.Item => {
  const { client, clock } = item.id;
  const right = item.content.splice(at);
  return new Y.Item(Y.createID(client, clock + at), null, Y.createID(client, clock + at - 1), null, item.rightOrigin, item.parent, item.parentSub, right);
};

const splitsAt = (item: Y.Item, at: number): boolean => {
  const text = (item.content as { str?: unknown }).str;
  if (typeof text !== "string") return true;
  const before = text.charCodeAt(at - 1);
  return before < 0xd800 || before > 0xdbff;
};

const cutPoint = (struct: Struct, bytes: number, room: number): number => {
  if (!(struct instanceof Y.Item) || struct.length < 2) return 0;
  let low = 0;
  let high = struct.length - 1;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (bytes - encodeFrom(struct, mid).length + CUT_SLACK_BYTES <= room) low = mid;
    else high = mid - 1;
  }
  while (low > 0 && !splitsAt(struct, low)) low -= 1;
  return low;
};

const encodeChunk = (runs: Run[]): Uint8Array => {
  const parts: Uint8Array[] = [varUint(runs.length)];
  for (const run of runs) parts.push(varUint(run.parts.length), varUint(run.client), varUint(run.clock), ...run.parts);
  parts.push(varUint(0));
  return concat(parts);
};

export const splitUpdate = (update: Uint8Array, maxBytes: number): Uint8Array[] => {
  if (update.length <= maxBytes) return [update];
  try {
    const chunks: Uint8Array[] = [];
    let runs: Run[] = [];
    let size = CHUNK_HEADER_BYTES;
    const finish = () => {
      if (runs.length > 0) chunks.push(encodeChunk(runs));
      runs = [];
      size = CHUNK_HEADER_BYTES;
    };
    const add = (client: number, clock: number, bytes: Uint8Array) => {
      const run = runs.at(-1);
      if (run && run.client === client) {
        run.parts.push(bytes);
      } else {
        runs.push({ client, clock, parts: [bytes] });
        size += RUN_HEADER_BYTES;
      }
      size += bytes.length;
    };
    for (const decoded of Y.decodeUpdate(update).structs) {
      let struct: Struct | null = decoded;
      while (struct) {
        const { client, clock } = struct.id;
        const bytes = encodeFrom(struct, 0);
        const joins = runs.at(-1)?.client === client;
        if (bytes[0] === SKIP_INFO && !joins) break;
        const room = maxBytes - size - (joins ? 0 : RUN_HEADER_BYTES);
        if (bytes.length <= room) {
          add(client, clock, bytes);
          break;
        }
        const cut = cutPoint(struct, bytes.length, room);
        if (cut === 0 && runs.length > 0) {
          finish();
          continue;
        }
        const rest: Y.Item | null = cut === 0 ? null : sliceItem(struct as Y.Item, cut);
        add(client, clock, cut === 0 ? bytes : encodeFrom(struct, 0));
        finish();
        struct = rest;
      }
    }
    finish();
    const deletions = Y.diffUpdate(update, Y.encodeStateVectorFromUpdate(update));
    if (deletions.length > 2) chunks.push(deletions);
    return chunks.length > 1 ? chunks : [update];
  } catch {
    return [update];
  }
};
