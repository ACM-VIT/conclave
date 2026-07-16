import { describe, expect, it, vi } from "vitest";
import type { Consumer } from "mediasoup/types";
import type { Room } from "../config/classes/Room.js";
import {
  AUDIO_CONSUMER_HEAL_MIN_AGE_MS,
  collectStuckAudioConsumers,
  healStuckAudioConsumers,
  initConsumerHealState,
  markConsumerClientPausedIntent,
} from "../server/audioConsumerHeal.js";

const NOW = 1_000_000;

class FakeConsumer {
  id: string;
  producerId: string;
  kind: "audio" | "video";
  paused: boolean;
  closed = false;
  appData: Record<string, unknown> = {};
  resumeCalls = 0;
  resumeImplementation: () => Promise<void> = async () => {
    this.paused = false;
  };

  constructor(options: {
    id: string;
    producerId?: string;
    kind?: "audio" | "video";
    paused?: boolean;
    createdAtMs?: number | null;
  }) {
    this.id = options.id;
    this.producerId = options.producerId ?? `producer-${options.id}`;
    this.kind = options.kind ?? "audio";
    this.paused = options.paused ?? true;
    if (options.createdAtMs !== null) {
      initConsumerHealState(
        this.asConsumer(),
        options.createdAtMs ?? NOW - AUDIO_CONSUMER_HEAL_MIN_AGE_MS,
      );
    }
  }

  async resume(): Promise<void> {
    this.resumeCalls += 1;
    await this.resumeImplementation();
  }

  asConsumer(): Consumer {
    return this as unknown as Consumer;
  }
}

class FakeClient {
  id: string;
  consumers = new Map<string, Consumer>();
  emitted: Array<{ event: string; payload: unknown }> = [];
  socket = {
    emit: (event: string, payload: unknown) => {
      this.emitted.push({ event, payload });
    },
  };

  constructor(id: string, consumers: FakeConsumer[] = []) {
    this.id = id;
    for (const consumer of consumers) {
      this.consumers.set(consumer.producerId, consumer.asConsumer());
    }
  }

  getConsumer(producerId: string): Consumer | undefined {
    return this.consumers.get(producerId);
  }
}

const makeRoom = (clients: FakeClient[]): Room =>
  ({
    id: "room-1",
    clients: new Map(clients.map((client) => [client.id, client])),
  }) as unknown as Room;

describe("collectStuckAudioConsumers", () => {
  it("collects paused audio consumers older than the minimum age", () => {
    const stuck = new FakeConsumer({ id: "c1" });
    const room = makeRoom([new FakeClient("user-1", [stuck])]);

    const collected = collectStuckAudioConsumers(room, NOW);
    expect(collected).toHaveLength(1);
    expect(collected[0].consumer.id).toBe("c1");
  });

  it("skips consumers still within the consume/resume round-trip window", () => {
    const fresh = new FakeConsumer({ id: "c1", createdAtMs: NOW - 2_000 });
    const room = makeRoom([new FakeClient("user-1", [fresh])]);

    expect(collectStuckAudioConsumers(room, NOW)).toHaveLength(0);
  });

  it("treats consumers without a heal stamp as old enough", () => {
    const legacy = new FakeConsumer({ id: "c1", createdAtMs: null });
    const room = makeRoom([new FakeClient("user-1", [legacy])]);

    expect(collectStuckAudioConsumers(room, NOW)).toHaveLength(1);
  });

  it("never touches consumers the client intentionally paused", () => {
    const intentional = new FakeConsumer({ id: "c1" });
    markConsumerClientPausedIntent(intentional.asConsumer(), true);
    const room = makeRoom([new FakeClient("user-1", [intentional])]);

    expect(collectStuckAudioConsumers(room, NOW)).toHaveLength(0);

    // A later resume request clears the intent, making it healable again.
    markConsumerClientPausedIntent(intentional.asConsumer(), false);
    expect(collectStuckAudioConsumers(room, NOW)).toHaveLength(1);
  });

  it("ignores unpaused, closed, and video consumers", () => {
    const flowing = new FakeConsumer({ id: "c1", paused: false });
    const closed = new FakeConsumer({ id: "c2" });
    closed.closed = true;
    const video = new FakeConsumer({ id: "c3", kind: "video" });
    const room = makeRoom([new FakeClient("user-1", [flowing, closed, video])]);

    expect(collectStuckAudioConsumers(room, NOW)).toHaveLength(0);
  });
});

describe("healStuckAudioConsumers", () => {
  it("delivers a published audio stream to every attendee (multi-attendee)", async () => {
    // One speaker, three attendees. One attendee's resumeConsumer was lost
    // (rate limit / disconnect blip), leaving their consumer paused while the
    // other two hear the speaker fine — the exact #177 report.
    const producerId = "speaker-audio";
    const hearing1 = new FakeConsumer({ id: "a1", producerId, paused: false });
    const hearing2 = new FakeConsumer({ id: "a2", producerId, paused: false });
    const silent = new FakeConsumer({ id: "a3", producerId, paused: true });

    const attendee1 = new FakeClient("attendee-1", [hearing1]);
    const attendee2 = new FakeClient("attendee-2", [hearing2]);
    const attendee3 = new FakeClient("attendee-3", [silent]);
    const room = makeRoom([attendee1, attendee2, attendee3]);

    const healed = await healStuckAudioConsumers(room, NOW);

    expect(healed).toBe(1);
    // Every attendee's consumer for the speaker is now delivering audio.
    for (const consumer of [hearing1, hearing2, silent]) {
      expect(consumer.paused).toBe(false);
    }
    // Only the previously-silent attendee was touched and notified.
    expect(silent.resumeCalls).toBe(1);
    expect(hearing1.resumeCalls).toBe(0);
    expect(attendee3.emitted).toHaveLength(1);
    expect(attendee3.emitted[0].event).toBe("consumerAutoResumed");
    expect(attendee3.emitted[0].payload).toMatchObject({
      roomId: "room-1",
      consumerId: "a3",
      producerId,
    });
    expect(attendee1.emitted).toHaveLength(0);
  });

  it("keeps sweeping when one resume fails", async () => {
    const failing = new FakeConsumer({ id: "c1" });
    failing.resumeImplementation = vi
      .fn()
      .mockRejectedValue(new Error("consumer closed"));
    const stuck = new FakeConsumer({ id: "c2" });
    const clientA = new FakeClient("user-a", [failing]);
    const clientB = new FakeClient("user-b", [stuck]);
    const room = makeRoom([clientA, clientB]);

    const healed = await healStuckAudioConsumers(room, NOW);

    expect(healed).toBe(1);
    expect(stuck.paused).toBe(false);
    expect(clientA.emitted).toHaveLength(0);
    expect(clientB.emitted).toHaveLength(1);
  });

  it("does not report a generation displaced while resume is awaiting", async () => {
    let releaseResume!: () => void;
    const resumePending = new Promise<void>((resolve) => {
      releaseResume = resolve;
    });
    const displaced = new FakeConsumer({ id: "c1", producerId: "speaker" });
    displaced.resumeImplementation = async () => {
      await resumePending;
      displaced.paused = false;
    };
    const replacement = new FakeConsumer({
      id: "c2",
      producerId: "speaker",
      paused: false,
    });
    const client = new FakeClient("user-a", [displaced]);
    const room = makeRoom([client]);

    const healing = healStuckAudioConsumers(room, NOW);
    await vi.waitFor(() => expect(displaced.resumeCalls).toBe(1));
    client.consumers.set("speaker", replacement.asConsumer());
    releaseResume();

    await expect(healing).resolves.toBe(0);
    expect(client.emitted).toHaveLength(0);
  });
});
