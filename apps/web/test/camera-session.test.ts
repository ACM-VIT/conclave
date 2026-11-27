import { describe, expect, it } from "vitest";
import { createCameraSession, type CameraCaptureHolder } from "../src/app/lib/camera-session";

type Track = MediaStreamTrack & { name: string };

const camera = (name: string) => ({ name, kind: "video", readyState: "live" }) as unknown as Track;

const createWorld = () => {
  const world = {
    chosen: true,
    shown: null as Track | null,
    sent: null as Track | null,
    stopped: [] as string[],
  };
  const session = createCameraSession({
    isChosen: () => world.chosen,
    committed: () => (world.shown?.readyState === "live" ? world.shown : null),
    sent: () => world.sent,
    stop: (track) => {
      (track as { readyState: string }).readyState = "ended";
      world.stopped.push((track as Track).name);
    },
    reconcile: async () => session.release(),
  });
  return { world, session };
};

const HOLDERS: CameraCaptureHolder[] = ["queue", "requester"];

describe("the camera session stops a capture only when nothing holds it", () => {
  it("keeps a capture its requester is still preparing through every release and every queued request", async () => {
    const { world, session } = createWorld();
    const preparing = camera("preparing");
    session.admit([preparing], "requester");

    session.release();
    await session.run(async () => {});
    await session.run(async () => {
      throw new Error("a queued request failed");
    }).catch(() => {});

    expect(world.stopped).toEqual([]);
  });

  it("stops a capture a queued request opened and never showed", async () => {
    const { world, session } = createWorld();
    await session.run(async () => {
      session.admit([camera("abandoned")], "queue");
    });

    expect(world.stopped).toEqual(["abandoned"]);
  });

  it.each(HOLDERS)("keeps a %s capture once the stream shows it, and stops it when another camera replaces it", async (holder) => {
    const { world, session } = createWorld();
    const first = camera("first");
    const second = camera("second");
    session.admit([first], holder);
    world.shown = first;
    session.release();
    expect(world.stopped).toEqual([]);

    await session.run(async () => {
      session.admit([second], "queue");
      world.shown = second;
    });

    expect(world.stopped).toEqual(["first"]);
  });

  it("stops a handed-over capture that a later request replaced before any release saw the handover", async () => {
    const { world, session } = createWorld();
    const handedOver = camera("handed over");
    const next = camera("next");
    session.admit([handedOver], "requester");
    world.shown = handedOver;

    await session.run(async () => {
      session.admit([next], "queue");
      world.shown = next;
    });

    expect(world.stopped).toEqual(["handed over"]);
  });

  it.each(HOLDERS)("stops a %s capture at once when the camera is turned off", (holder) => {
    const { world, session } = createWorld();
    session.admit([camera("open")], holder);
    world.chosen = false;
    session.drain();

    expect(world.stopped).toEqual(["open"]);
  });

  it.each(HOLDERS)("stops a %s capture that lands after the camera was turned off", (holder) => {
    const { world, session } = createWorld();
    world.chosen = false;
    session.admit([camera("late")], holder);

    expect(world.stopped).toEqual(["late"]);
  });

  it("never stops again a capture its requester cancelled", () => {
    const { world, session } = createWorld();
    const cancelled = camera("cancelled");
    session.admit([cancelled], "requester");
    (cancelled as { readyState: string }).readyState = "ended";
    session.release();
    session.drain();

    expect(world.stopped).toEqual([]);
  });

  it("keeps the copy the producer sends and stops it once the producer sends something else", () => {
    const { world, session } = createWorld();
    const shown = camera("shown");
    const copy = camera("copy");
    session.admit([shown], "queue");
    world.shown = shown;
    session.own(copy, shown);
    world.sent = copy;
    session.release();
    expect(world.stopped).toEqual([]);
    expect(session.originOf(copy)).toBe(shown);

    world.sent = shown;
    session.release();

    expect(world.stopped).toEqual(["copy"]);
  });

  it("runs queued requests one at a time and settles ownership after each", async () => {
    const { world, session } = createWorld();
    const order: string[] = [];
    const first = session.run(async () => {
      order.push("first starts");
      session.admit([camera("first capture")], "queue");
      await Promise.resolve();
      order.push("first ends");
    });
    const second = session.run(async () => {
      order.push(`second starts with ${world.stopped.join(",")} stopped`);
    });
    await Promise.all([first, second]);

    expect(order).toEqual(["first starts", "first ends", "second starts with first capture stopped"]);
  });
});
