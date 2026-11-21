import type { ProducerInfo } from "./types";

export type AnnouncedProducer = Pick<
  ProducerInfo,
  "producerId" | "producerUserId" | "kind" | "type" | "producerSeq"
>;

type KnownProducer = {
  slotKey: string;
  seq: number | null;
  arrival: number;
};

const MAX_REMEMBERED_CLOSED_PRODUCERS = 1024;

const getProducerSlotKey = (
  info: Pick<ProducerInfo, "producerUserId" | "kind" | "type">,
): string => `${info.producerUserId}:${info.kind}:${info.type}`;

const readProducerSeq = (info: AnnouncedProducer): number | null =>
  typeof info.producerSeq === "number" && Number.isFinite(info.producerSeq)
    ? info.producerSeq
    : null;

/**
 * Tracks which producer currently owns each slot (one user's camera, mic or
 * screen), so a viewer follows the newest live producer whatever order its
 * announcements are handled in.
 */
export function createProducerSlotOrder() {
  const known = new Map<string, KnownProducer>();
  const closed = new Set<string>();
  let arrivals = 0;

  const noteAnnounced = (info: AnnouncedProducer): void => {
    if (closed.has(info.producerId) || known.has(info.producerId)) return;
    arrivals += 1;
    known.set(info.producerId, {
      slotKey: getProducerSlotKey(info),
      seq: readProducerSeq(info),
      arrival: arrivals,
    });
  };

  // The server's creation sequence decides which producer is newest. A server
  // that predates it sends none, so arrival order decides instead. One rule
  // covers the whole slot, which keeps the order consistent if the two mix.
  const getLatestInSlot = (slotKey: string): string | null => {
    const inSlot = [...known].filter(
      ([, producer]) => producer.slotKey === slotKey,
    );
    const rank = inSlot.every(([, producer]) => producer.seq !== null)
      ? (producer: KnownProducer) => producer.seq ?? producer.arrival
      : (producer: KnownProducer) => producer.arrival;
    let latest: [string, KnownProducer] | null = null;
    for (const entry of inSlot) {
      if (!latest || rank(entry[1]) > rank(latest[1])) latest = entry;
    }
    return latest?.[0] ?? null;
  };

  /** Call when asking the server for its producer list. */
  const markListRequested = (): number => arrivals;

  /**
   * The server's full list of live producers. A producer this viewer knew
   * before asking that the list leaves out is gone. One announced while the
   * request was in flight is kept, because the list may predate it.
   */
  const noteServerList = (
    producers: readonly AnnouncedProducer[],
    requestedAt: number,
  ): void => {
    const listed = new Set(producers.map((producer) => producer.producerId));
    for (const [producerId, producer] of known) {
      if (producer.arrival <= requestedAt && !listed.has(producerId)) {
        known.delete(producerId);
      }
    }
    for (const producer of producers) noteAnnounced(producer);
  };

  /** True for a producer first announced after that request was sent. */
  const wasAnnouncedAfter = (producerId: string, requestedAt: number): boolean =>
    (known.get(producerId)?.arrival ?? 0) > requestedAt;

  /** This viewer dropped the producer. The server may still list it. */
  const forget = (producerId: string): void => {
    known.delete(producerId);
  };

  /** The server closed this producer. Its id never comes back. */
  const noteClosed = (producerId: string): void => {
    known.delete(producerId);
    closed.add(producerId);
    if (closed.size > MAX_REMEMBERED_CLOSED_PRODUCERS) {
      for (const oldestId of closed) {
        closed.delete(oldestId);
        break;
      }
    }
  };

  /** True when the producer is closed or a newer one owns its slot. */
  const isSuperseded = (info: AnnouncedProducer): boolean => {
    if (closed.has(info.producerId)) return true;
    const slotKey =
      known.get(info.producerId)?.slotKey ?? getProducerSlotKey(info);
    const latestId = getLatestInSlot(slotKey);
    return latestId !== null && latestId !== info.producerId;
  };

  // The arrival count keeps running, so a list requested before a reset can
  // never drop a producer announced after it.
  const reset = (): void => {
    known.clear();
    closed.clear();
  };

  return {
    noteAnnounced,
    markListRequested,
    noteServerList,
    wasAnnouncedAfter,
    forget,
    noteClosed,
    isSuperseded,
    reset,
  };
}

export type ProducerSlotOrder = ReturnType<typeof createProducerSlotOrder>;
