import type { Producer } from "mediasoup/types";

export const PRODUCER_PACKET_COUNT_MAX_AGE_MS = 750;

type PacketCountRead = {
  count: Promise<number | null>;
  settledAt: number | null;
};

const reads = new WeakMap<Producer, PacketCountRead>();

const isFresh = (read: PacketCountRead, now: number) =>
  read.settledAt === null || now - read.settledAt < PRODUCER_PACKET_COUNT_MAX_AGE_MS;

export const readProducerPacketCount = (producer: Producer): Promise<number | null> => {
  if (producer.closed) return Promise.resolve(null);
  const cached = reads.get(producer);
  if (cached && isFresh(cached, Date.now())) return cached.count;
  const read: PacketCountRead = { count: Promise.resolve(null), settledAt: null };
  read.count = producer.getStats().then(
    (stats) => stats.reduce((total, entry) => total + entry.packetCount, 0),
    () => null,
  ).then((count) => {
    read.settledAt = Date.now();
    return count;
  });
  reads.set(producer, read);
  return read.count;
};

export const readProducerPacketCounts = async (
  producers: Iterable<Producer>,
): Promise<Map<Producer, number>> => {
  const unique = [...new Set(producers)];
  const counts = await Promise.all(unique.map(readProducerPacketCount));
  const read = new Map<Producer, number>();
  unique.forEach((producer, index) => {
    const count = counts[index];
    if (count !== null) read.set(producer, count);
  });
  return read;
};
