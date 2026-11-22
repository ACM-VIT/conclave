import { describe, expect, it } from "vitest";
import {
  createProducerSlotOrder,
  type AnnouncedProducer,
  type ProducerSlotOrder,
} from "../src/app/lib/producer-slot-order";

const camera = (producerId: string, producerSeq?: number): AnnouncedProducer => ({
  producerId,
  producerUserId: "alice",
  kind: "video",
  type: "webcam",
  ...(producerSeq === undefined ? {} : { producerSeq }),
});

const permutations = <T,>(items: readonly T[]): T[][] =>
  items.length <= 1
    ? [[...items]]
    : items.flatMap((item, index) =>
        permutations([
          ...items.slice(0, index),
          ...items.slice(index + 1),
        ]).map((rest) => [item, ...rest]),
      );

// Alice's camera is rebuilt while Bob joins. Bob hears about it three ways:
// the join snapshot that still lists the old producer, the live announcement
// of the replacement, and the close of the old one.
type ReplacementEvent = "snapshot" | "announce" | "close";

const replay = (
  order: ProducerSlotOrder,
  events: readonly ReplacementEvent[],
  oldCamera: AnnouncedProducer,
  newCamera: AnnouncedProducer,
  onStep?: (seen: readonly ReplacementEvent[]) => void,
) => {
  const joinRequestedAt = order.markListRequested();
  const seen: ReplacementEvent[] = [];
  for (const event of events) {
    if (event === "snapshot") {
      order.noteServerList([oldCamera], joinRequestedAt);
    } else if (event === "announce") {
      order.noteAnnounced(newCamera);
    } else {
      order.noteClosed(oldCamera.producerId);
    }
    seen.push(event);
    onStep?.(seen);
  }
};

describe("producer slot order during a camera replacement", () => {
  const arrivalOrders = permutations<ReplacementEvent>([
    "snapshot",
    "announce",
    "close",
  ]);

  it.each(arrivalOrders)(
    "follows the replacement with a server sequence: %s, %s, %s",
    (...events) => {
      const order = createProducerSlotOrder();
      const oldCamera = camera("old", 1);
      const newCamera = camera("new", 2);

      replay(order, events, oldCamera, newCamera, (seen) => {
        if (!seen.includes("announce")) return;
        expect(order.isSuperseded(newCamera)).toBe(false);
        expect(order.isSuperseded(oldCamera)).toBe(true);
      });
    },
  );

  it.each(arrivalOrders)(
    "follows the replacement from an older server: %s, %s, %s",
    (...events) => {
      const order = createProducerSlotOrder();
      const oldCamera = camera("old");
      const newCamera = camera("new");

      replay(order, events, oldCamera, newCamera, (seen) => {
        if (!seen.includes("announce")) return;
        expect(order.isSuperseded(newCamera)).toBe(false);
        expect(order.isSuperseded(oldCamera)).toBe(true);
      });
    },
  );

  it("keeps the replacement when the stale snapshot is handled last and the close never arrives", () => {
    const order = createProducerSlotOrder();
    const oldCamera = camera("old", 1);
    const newCamera = camera("new", 2);
    const joinRequestedAt = order.markListRequested();

    order.noteAnnounced(newCamera);
    order.noteServerList([oldCamera], joinRequestedAt);

    expect(order.isSuperseded(newCamera)).toBe(false);
    expect(order.isSuperseded(oldCamera)).toBe(true);
  });
});

describe("producer slot order", () => {
  it("lets a later producer list repair a slot stuck on a dead producer", () => {
    const order = createProducerSlotOrder();
    const dead = camera("dead");
    const live = camera("live");
    order.noteAnnounced(live);
    order.noteAnnounced(dead);
    expect(order.isSuperseded(live)).toBe(true);

    const requestedAt = order.markListRequested();
    order.noteServerList([live], requestedAt);

    expect(order.isSuperseded(live)).toBe(false);
  });

  it("keeps a producer announced while a producer list was in flight", () => {
    const order = createProducerSlotOrder();
    const requestedAt = order.markListRequested();
    const announced = camera("announced", 5);
    order.noteAnnounced(announced);

    order.noteServerList([], requestedAt);
    order.noteAnnounced(camera("older", 4));

    expect(order.isSuperseded(announced)).toBe(false);
  });

  it("reports only producers announced after a list was requested", () => {
    const order = createProducerSlotOrder();
    order.noteAnnounced(camera("before"));
    const requestedAt = order.markListRequested();
    order.noteAnnounced(camera("during"));

    expect(order.wasAnnouncedAfter("before", requestedAt)).toBe(false);
    expect(order.wasAnnouncedAfter("during", requestedAt)).toBe(true);
    expect(order.wasAnnouncedAfter("never-announced", requestedAt)).toBe(false);
  });

  it("uses one rule for a slot that mixes producers with and without a sequence", () => {
    const order = createProducerSlotOrder();
    const sequencedFirst = camera("sequence-3", 3);
    const unsequenced = camera("no-sequence");
    const sequencedLast = camera("sequence-2", 2);
    order.noteAnnounced(sequencedFirst);
    order.noteAnnounced(unsequenced);
    order.noteAnnounced(sequencedLast);

    expect(order.isSuperseded(sequencedLast)).toBe(false);
    expect(order.isSuperseded(sequencedFirst)).toBe(true);

    order.noteClosed(unsequenced.producerId);

    expect(order.isSuperseded(sequencedFirst)).toBe(false);
    expect(order.isSuperseded(sequencedLast)).toBe(true);
  });

  it("never brings a closed producer back", () => {
    const order = createProducerSlotOrder();
    const closed = camera("closed", 1);
    order.noteAnnounced(closed);
    order.noteClosed(closed.producerId);

    order.noteAnnounced(closed);
    order.noteServerList([closed], order.markListRequested());

    expect(order.isSuperseded(closed)).toBe(true);
  });

  it("falls back to the previous producer when the newest one closes", () => {
    const order = createProducerSlotOrder();
    const first = camera("first", 1);
    const second = camera("second", 2);
    order.noteAnnounced(first);
    order.noteAnnounced(second);

    order.noteClosed(second.producerId);

    expect(order.isSuperseded(first)).toBe(false);
  });

  it("orders each user's camera, microphone and screen separately", () => {
    const order = createProducerSlotOrder();
    const aliceCamera = camera("alice-camera", 1);
    const aliceMicrophone: AnnouncedProducer = {
      ...camera("alice-microphone", 2),
      kind: "audio",
    };
    const aliceScreen: AnnouncedProducer = {
      ...camera("alice-screen", 3),
      type: "screen",
    };
    const bobCamera: AnnouncedProducer = {
      ...camera("bob-camera", 4),
      producerUserId: "bob",
    };

    for (const producer of [aliceCamera, aliceMicrophone, aliceScreen, bobCamera]) {
      order.noteAnnounced(producer);
    }

    for (const producer of [aliceCamera, aliceMicrophone, aliceScreen, bobCamera]) {
      expect(order.isSuperseded(producer)).toBe(false);
    }
  });

  it("accepts a producer it has not heard about when the slot is empty", () => {
    const order = createProducerSlotOrder();

    expect(order.isSuperseded(camera("unannounced"))).toBe(false);
  });

  it("keeps a producer announced after a reset when a list requested before it arrives late", () => {
    const order = createProducerSlotOrder();
    order.noteAnnounced(camera("before-reset", 1));
    const requestedBeforeReset = order.markListRequested();
    order.reset();
    const afterReset = camera("after-reset", 3);
    order.noteAnnounced(afterReset);

    order.noteServerList([], requestedBeforeReset);
    order.noteAnnounced(camera("older", 2));

    expect(order.isSuperseded(afterReset)).toBe(false);
  });

  it("forgets everything on reset", () => {
    const order = createProducerSlotOrder();
    const closed = camera("closed", 1);
    order.noteAnnounced(camera("newer", 2));
    order.noteClosed(closed.producerId);

    order.reset();

    expect(order.isSuperseded(closed)).toBe(false);
  });
});
