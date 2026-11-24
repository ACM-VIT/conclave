import type { Producer } from "mediasoup-client/types";

export const installProducer = (
  slot: { current: Producer | null },
  replacing: Producer | null,
  next: Producer,
  discard: (producer: Producer) => void,
): boolean => {
  const holder = slot.current;
  if (holder && holder !== replacing && holder !== next && !holder.closed) {
    discard(next);
    return false;
  }
  slot.current = next;
  return true;
};
