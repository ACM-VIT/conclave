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

// The server's creation sequence decides which producer is newer. A server
// that predates it sends none, so the order the announcements arrived in
// decides instead.
const isNewer = (candidate: KnownProducer, current: KnownProducer): boolean =>
  candidate.seq !== null && current.seq !== null && candidate.seq !== current.seq
    ? candidate.seq > current.seq
    : candidate.arrival > current.arrival;

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

  const getLatestInSlot = (slotKey: string): string | null => {
    let latestId: string | null = null;
    let latest: KnownProducer | null = null;
    for (const [producerId, producer] of known) {
      if (producer.slotKey !== slotKey) continue;
      if (!latest || isNewer(producer, latest)) {
        latestId = producerId;
        latest = producer;
      }
    }
    return latestId;
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
    forget,
    noteClosed,
    isSuperseded,
    reset,
  };
}

export type ProducerSlotOrder = ReturnType<typeof createProducerSlotOrder>;
