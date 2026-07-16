/* eslint-disable @typescript-eslint/unbound-method -- mediasoup methods are Vitest mocks in this unit harness. */
import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import type { Consumer } from "mediasoup/types";
import { Client } from "../config/classes/Client.js";

const makeConsumer = (id: string, producerId = "producer") => {
  const events = new EventEmitter();
  const observer = new EventEmitter();
  const consumer = {
    id,
    producerId,
    kind: "video",
    closed: false,
    paused: false,
    producerPaused: false,
    priority: 100,
    score: { score: 10, producerScore: 10, producerScores: [10] },
    preferredLayers: undefined,
    currentLayers: undefined,
    on: events.on.bind(events),
    observer,
    close: vi.fn(),
  } as unknown as Consumer;
  const close = vi.mocked(consumer.close);
  close.mockImplementation(() => {
    Object.assign(consumer, { closed: true });
    observer.emit("close");
  });
  return { consumer, observer, close };
};

describe("Client overlapping consumer generations", () => {
  it("keeps a displaced generation addressable until it actually closes", () => {
    const client = new Client({ id: "receiver", socket: {} as never });
    const first = makeConsumer("consumer-1");
    const replacement = makeConsumer("consumer-2");

    expect(client.addConsumer(first.consumer)).toBeNull();
    expect(client.addConsumer(replacement.consumer)).toMatchObject({
      consumer: first.consumer,
      retirementRevision: 1,
    });
    expect(client.getConsumer("producer")).toBe(replacement.consumer);
    expect(client.getConsumerById(first.consumer.id)).toBe(first.consumer);
    expect(client.getConsumerById(replacement.consumer.id)).toBe(
      replacement.consumer,
    );

    first.observer.emit("close");
    expect(client.getConsumerById(first.consumer.id)).toBeUndefined();
    expect(client.getConsumer("producer")).toBe(replacement.consumer);
  });

  it("closes both live generations during client teardown", () => {
    const client = new Client({ id: "receiver", socket: {} as never });
    const first = makeConsumer("consumer-1");
    const replacement = makeConsumer("consumer-2");
    client.addConsumer(first.consumer);
    client.addConsumer(replacement.consumer);

    client.closeConsumers();

    expect(first.close).toHaveBeenCalledOnce();
    expect(replacement.close).toHaveBeenCalledOnce();
    expect(client.getConsumer("producer")).toBeUndefined();
    expect(client.getConsumerById(first.consumer.id)).toBeUndefined();
    expect(client.getConsumerById(replacement.consumer.id)).toBeUndefined();
  });

  it("restores the newest live predecessor when a successor closes", () => {
    const client = new Client({ id: "receiver", socket: {} as never });
    const oldest = makeConsumer("consumer-1");
    const predecessor = makeConsumer("consumer-2");
    const successor = makeConsumer("consumer-3");
    client.addConsumer(oldest.consumer, {
      producerUserId: "owner",
      type: "webcam",
    });
    client.addConsumer(predecessor.consumer, {
      producerUserId: "owner",
      type: "webcam",
    });
    client.addConsumer(successor.consumer, {
      producerUserId: "owner",
      type: "webcam",
    });

    successor.close();

    expect(client.getConsumer("producer")).toBe(predecessor.consumer);
    expect(client.getConsumerById(oldest.consumer.id)).toBe(oldest.consumer);
    expect(client.updateConsumerTelemetry(predecessor.consumer)).toMatchObject({
      consumerId: predecessor.consumer.id,
      producerId: "producer",
      producerUserId: "owner",
      type: "webcam",
    });
  });

  it("does not restore a predecessor after targeted retirement commits", () => {
    const client = new Client({ id: "receiver", socket: {} as never });
    const predecessor = makeConsumer("consumer-1");
    const successor = makeConsumer("consumer-2");
    client.addConsumer(predecessor.consumer);
    const displacement = client.addConsumer(successor.consumer);
    expect(displacement).not.toBeNull();

    expect(client.retireDisplacedConsumer(displacement!)).toBe(true);
    successor.close();

    expect(client.getConsumer("producer")).toBeUndefined();
    expect(predecessor.close).toHaveBeenCalledOnce();
  });

  it("invalidates an old retirement timer across restore and re-displace", () => {
    const client = new Client({ id: "receiver", socket: {} as never });
    const predecessor = makeConsumer("consumer-1");
    const failedSuccessor = makeConsumer("consumer-2");
    const nextSuccessor = makeConsumer("consumer-3");
    client.addConsumer(predecessor.consumer);
    const staleDisplacement = client.addConsumer(failedSuccessor.consumer);
    expect(staleDisplacement).not.toBeNull();

    failedSuccessor.close();
    expect(client.getConsumer("producer")).toBe(predecessor.consumer);

    const currentDisplacement = client.addConsumer(nextSuccessor.consumer);
    expect(currentDisplacement).not.toBeNull();
    expect(client.retireDisplacedConsumer(staleDisplacement!)).toBe(false);
    expect(predecessor.close).not.toHaveBeenCalled();
    expect(client.retireDisplacedConsumer(currentDisplacement!)).toBe(true);
    expect(predecessor.close).toHaveBeenCalledOnce();
    expect(client.getConsumer("producer")).toBe(nextSuccessor.consumer);
  });

  it("captures every live predecessor for the current grace window", () => {
    const client = new Client({ id: "receiver", socket: {} as never });
    const oldest = makeConsumer("consumer-1");
    const predecessor = makeConsumer("consumer-2");
    const successor = makeConsumer("consumer-3");
    client.addConsumer(oldest.consumer);
    const staleOldestRetirement = client.addConsumer(predecessor.consumer);
    client.addConsumer(successor.consumer);

    const retirements =
      client.captureDisplacedConsumerRetirements(successor.consumer);
    expect(retirements.map(({ consumer }) => consumer.id)).toEqual([
      oldest.consumer.id,
      predecessor.consumer.id,
    ]);
    expect(client.retireDisplacedConsumer(staleOldestRetirement!)).toBe(false);
    for (const retirement of retirements) {
      expect(client.retireDisplacedConsumer(retirement)).toBe(true);
    }

    expect(oldest.close).toHaveBeenCalledOnce();
    expect(predecessor.close).toHaveBeenCalledOnce();
    expect(client.getConsumer("producer")).toBe(successor.consumer);
  });
});
