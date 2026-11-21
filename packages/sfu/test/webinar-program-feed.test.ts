import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Producer, Router } from "mediasoup/types";
import type { Server as SocketIOServer } from "socket.io";
import { Admin } from "../config/classes/Admin.js";
import { Client } from "../config/classes/Client.js";
import { Room } from "../config/classes/Room.js";
import type { ProducerType } from "../config/classes/Client.js";
import type { MediaKind } from "mediasoup/types";
import { emitWebinarAttendeeCountChanged } from "../server/webinarNotifications.js";
import type { SfuState } from "../server/state.js";
import type { WebinarRoomConfig } from "../server/webinar.js";

const fakeSocket = () => ({ emit: vi.fn(), connected: true });

const fakeRouter = (): Router => {
  const state = { closed: false };
  return {
    get closed() {
      return state.closed;
    },
    rtpCapabilities: { codecs: [], headerExtensions: [] },
    close() {
      state.closed = true;
    },
  } as unknown as Router;
};

const fakeProducer = (
  id: string,
  kind: MediaKind,
  type: ProducerType,
  options?: { paused?: boolean },
): Producer => {
  const events = new EventEmitter();
  const observer = new EventEmitter();
  const producer = {
    id,
    kind,
    appData: { type },
    paused: options?.paused ?? false,
    closed: false,
    rtpParameters: {
      codecs: [
        kind === "video"
          ? {
              mimeType: "video/VP8",
              payloadType: 102,
              clockRate: 90_000,
              parameters: {},
              rtcpFeedback: [],
            }
          : {
              mimeType: "audio/opus",
              payloadType: 100,
              clockRate: 48_000,
              parameters: {},
              rtcpFeedback: [],
            },
      ],
      encodings: [{ rid: "f" }],
      headerExtensions: [],
      rtcp: {},
    },
    on: events.on.bind(events),
    observer,
    close: vi.fn(),
  };
  return producer as unknown as Producer;
};

const makeRoom = () =>
  new Room({
    id: "webinar-room",
    clientId: "default",
    router: fakeRouter(),
    workerPid: null,
  });

const addProducer = (
  room: Room,
  client: Client,
  producer: Producer,
): void => {
  client.addProducer(producer);
  room.indexClientProducer(
    client.id,
    producer,
    (producer.appData.type as ProducerType) ?? "webcam",
  );
};

const feedProducerIds = (room: Room): string[] =>
  room
    .getWebinarFeedSnapshot()
    .producers.map((producer) => producer.producerId)
    .sort();

describe("webinar program feed", () => {
  it("always carries every panelist's audio, not just the on-stage speaker", () => {
    const room = makeRoom();
    const host = new Admin({ id: "host", socket: fakeSocket() as never });
    const panelist = new Client({ id: "panelist", socket: fakeSocket() as never });
    const attendee = new Client({
      id: "attendee",
      socket: fakeSocket() as never,
      mode: "webinar_attendee",
    });
    room.addClient(host);
    room.addClient(panelist);
    room.addClient(attendee);

    addProducer(room, host, fakeProducer("host-audio", "audio", "webcam"));
    addProducer(room, host, fakeProducer("host-video", "video", "webcam"));
    addProducer(
      room,
      panelist,
      fakeProducer("panelist-audio", "audio", "webcam"),
    );
    addProducer(
      room,
      panelist,
      fakeProducer("panelist-video", "video", "webcam"),
    );

    const snapshot = room.getWebinarFeedSnapshot();
    const audioIds = snapshot.producers
      .filter((producer) => producer.kind === "audio")
      .map((producer) => producer.producerId)
      .sort();
    // Both panelists stay audible regardless of who holds the video stage.
    expect(audioIds).toEqual(["host-audio", "panelist-audio"]);

    const videoIds = snapshot.producers
      .filter((producer) => producer.kind === "video")
      .map((producer) => producer.producerId);
    expect(videoIds).toHaveLength(1);
    expect(snapshot.speakerUserId).not.toBeNull();
    room.close();
  });

  it("keeps muted panelist audio in the feed so unmutes never rebuild consumers", () => {
    const room = makeRoom();
    const host = new Admin({ id: "host", socket: fakeSocket() as never });
    room.addClient(host);
    addProducer(
      room,
      host,
      fakeProducer("host-audio", "audio", "webcam", { paused: true }),
    );
    addProducer(room, host, fakeProducer("host-video", "video", "webcam"));

    const snapshot = room.getWebinarFeedSnapshot();
    const audio = snapshot.producers.find(
      (producer) => producer.kind === "audio",
    );
    expect(audio?.producerId).toBe("host-audio");
    expect(audio?.paused).toBe(true);
    room.close();
  });

  it("stages the screen share plus the presenter camera during a share", () => {
    const room = makeRoom();
    const host = new Admin({ id: "host", socket: fakeSocket() as never });
    const presenter = new Client({
      id: "presenter",
      socket: fakeSocket() as never,
    });
    room.addClient(host);
    room.addClient(presenter);

    addProducer(room, host, fakeProducer("host-audio", "audio", "webcam"));
    addProducer(room, host, fakeProducer("host-video", "video", "webcam"));
    addProducer(
      room,
      presenter,
      fakeProducer("presenter-audio", "audio", "webcam"),
    );
    addProducer(
      room,
      presenter,
      fakeProducer("presenter-video", "video", "webcam"),
    );
    addProducer(
      room,
      presenter,
      fakeProducer("presenter-screen", "video", "screen"),
    );
    room.setScreenShareProducer("presenter-screen");

    const snapshot = room.getWebinarFeedSnapshot();
    expect(snapshot.speakerUserId).toBe("presenter");
    const videoIds = snapshot.producers
      .filter((producer) => producer.kind === "video")
      .map((producer) => producer.producerId)
      .sort();
    // Screen share is the main stage; the presenter camera rides along for PiP.
    expect(videoIds).toEqual(["presenter-screen", "presenter-video"]);
    const audioIds = snapshot.producers
      .filter((producer) => producer.kind === "audio")
      .map((producer) => producer.producerId)
      .sort();
    expect(audioIds).toEqual(["host-audio", "presenter-audio"]);
    room.close();
  });

  it("never leaks attendee producers into the feed", () => {
    const room = makeRoom();
    const host = new Admin({ id: "host", socket: fakeSocket() as never });
    const attendee = new Client({
      id: "attendee",
      socket: fakeSocket() as never,
      mode: "webinar_attendee",
    });
    room.addClient(host);
    room.addClient(attendee);
    addProducer(room, host, fakeProducer("host-audio", "audio", "webcam"));
    // Defense in depth: even if an attendee producer somehow existed, the
    // feed must not include it.
    addProducer(
      room,
      attendee,
      fakeProducer("attendee-audio", "audio", "webcam"),
    );

    expect(feedProducerIds(room)).toEqual(["host-audio"]);
    room.close();
  });
});

describe("webinar attendee interaction state", () => {
  it("keeps the raised-hand queue attendee-only and arrival-ordered", () => {
    const room = makeRoom();
    const attendeeA = new Client({
      id: "attendee-a",
      socket: fakeSocket() as never,
      mode: "webinar_attendee",
    });
    const attendeeB = new Client({
      id: "attendee-b",
      socket: fakeSocket() as never,
      mode: "webinar_attendee",
    });
    const panelist = new Client({
      id: "panelist",
      socket: fakeSocket() as never,
    });
    room.addClient(attendeeA);
    room.addClient(attendeeB);
    room.addClient(panelist);
    room.setUserIdentity("attendee-a", "key-a", "Asha");
    room.setUserIdentity("attendee-b", "key-b", "Bilal");

    expect(room.setWebinarHandRaised("attendee-b", true)).toBe(true);
    expect(room.setWebinarHandRaised("attendee-a", true)).toBe(true);
    // Duplicate raise is a no-op so re-sends do not reorder the queue.
    expect(room.setWebinarHandRaised("attendee-b", true)).toBe(false);
    room.setWebinarHandRaised("panelist", true);

    const queue = room.getWebinarHandQueue();
    expect(queue.map((entry) => entry.userId)).toEqual([
      "attendee-b",
      "attendee-a",
    ]);
    expect(queue[0]?.displayName).toBe("Bilal");

    room.removeClient("attendee-b");
    expect(
      room.getWebinarHandQueue().map((entry) => entry.userId),
    ).toEqual(["attendee-a"]);
    room.close();
  });

  it("enforces Q&A visibility: attendees see their own plus published entries", () => {
    const room = makeRoom();
    room.setUserIdentity("attendee-a", "key-a", "Asha");
    room.setUserIdentity("attendee-b", "key-b", "Bilal");

    const submitted = room.submitWebinarQuestion(
      "attendee-a",
      "Asha",
      "How does pricing work?",
    );
    expect("entry" in submitted && submitted.entry.status).toBe("pending");
    const otherSubmitted = room.submitWebinarQuestion(
      "attendee-b",
      "Bilal",
      "Will there be a recording?",
    );
    if (!("entry" in otherSubmitted)) throw new Error("submit failed");

    // Pending questions are private to the asker (and moderators).
    expect(
      room.getWebinarQaSnapshotFor("attendee-a", false, "webinar").map((entry) => entry.id),
    ).toHaveLength(1);
    expect(room.getWebinarQaSnapshotFor("attendee-a", true, "webinar")).toHaveLength(2);

    room.moderateWebinarQuestion(otherSubmitted.entry.id, "answered", {
      answerText: "Yes, shared afterwards.",
      moderatorName: "Host",
    });
    const visible = room.getWebinarQaSnapshotFor("attendee-a", false, "webinar");
    expect(visible).toHaveLength(2);
    const answered = visible.find(
      (entry) => entry.id === otherSubmitted.entry.id,
    );
    expect(answered?.status).toBe("answered");
    expect(answered?.answerText).toBe("Yes, shared afterwards.");
    expect(answered?.answeredByName).toBe("Host");
    room.close();
  });

  it("caps open questions per attendee and supports reopen", () => {
    const room = makeRoom();
    for (let index = 0; index < 3; index += 1) {
      const result = room.submitWebinarQuestion(
        "attendee-a",
        "Asha",
        `Question ${index}`,
      );
      expect("entry" in result).toBe(true);
    }
    const overflow = room.submitWebinarQuestion("attendee-a", "Asha", "One more");
    expect("error" in overflow).toBe(true);

    const [first] = room.getWebinarQaSnapshotFor("attendee-a", true, "webinar");
    room.moderateWebinarQuestion(first.id, "dismissed");
    const afterDismiss = room.submitWebinarQuestion(
      "attendee-a",
      "Asha",
      "Now there is space",
    );
    expect("entry" in afterDismiss).toBe(true);

    room.moderateWebinarQuestion(first.id, "reopen");
    const reopened = room.getWebinarQaEntryState(first.id);
    expect(reopened?.status).toBe("pending");
    room.close();
  });

  it("toggles upvotes and counts distinct voters", () => {
    const room = makeRoom();
    const submitted = room.submitWebinarQuestion(
      "attendee-a",
      "Asha",
      "Can we get the slides?",
    );
    if (!("entry" in submitted)) throw new Error("submit failed");
    const id = submitted.entry.id;

    room.toggleWebinarQuestionUpvote("attendee-b", id);
    room.toggleWebinarQuestionUpvote("attendee-c", id);
    room.toggleWebinarQuestionUpvote("attendee-b", id);

    const state = room.getWebinarQaEntryState(id);
    expect(state).not.toBeNull();
    expect(room.projectWebinarQaEntry(state!, "attendee-c")).toMatchObject({
      upvotes: 1,
      hasUpvoted: true,
    });
    room.close();
  });

  it("tracks stage invites by identity and forgets them on revoke", () => {
    const room = makeRoom();
    room.promoteWebinarUserKey("guest:abc");
    expect(room.isWebinarPromotedUserKey("guest:abc")).toBe(true);
    expect(room.isWebinarPromotedUserKey("guest:other")).toBe(false);
    expect(room.revokeWebinarPromotion("guest:abc")).toBe(true);
    expect(room.isWebinarPromotedUserKey("guest:abc")).toBe(false);
    room.close();
  });

  it("expires stage invites instead of granting a permanent gate bypass", () => {
    vi.useFakeTimers();
    try {
      const room = makeRoom();
      room.promoteWebinarUserKey("guest:abc");
      expect(room.isWebinarPromotedUserKey("guest:abc")).toBe(true);
      vi.advanceTimersByTime(4 * 60 * 60 * 1000 + 1000);
      expect(room.isWebinarPromotedUserKey("guest:abc")).toBe(false);
      room.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps demoted identities out of the panel until re-invited", () => {
    const room = makeRoom();
    room.markWebinarDemotedUserKey("guest:abc");
    expect(room.isWebinarDemotedUserKey("guest:abc")).toBe(true);
    // A fresh stage invite is the way back in.
    room.promoteWebinarUserKey("guest:abc");
    expect(room.isWebinarDemotedUserKey("guest:abc")).toBe(false);
    room.close();
  });

  it("treats mute toggles as feed changes so viewers hear state flips", () => {
    const room = makeRoom();
    const host = new Admin({ id: "host", socket: fakeSocket() as never });
    room.addClient(host);
    const audio = fakeProducer("host-audio", "audio", "webcam");
    addProducer(room, host, audio);

    expect(room.refreshWebinarFeedSnapshot().changed).toBe(true);
    expect(room.refreshWebinarFeedSnapshot().changed).toBe(false);
    (audio as unknown as { paused: boolean }).paused = true;
    expect(room.refreshWebinarFeedSnapshot().changed).toBe(true);
    room.close();
  });

  it("reports which questions capacity eviction dropped", () => {
    const room = makeRoom();
    for (let index = 0; index < 300; index += 1) {
      const result = room.submitWebinarQuestion(
        `attendee-${index}`,
        `Viewer ${index}`,
        `Question number ${index}`,
      );
      expect("entry" in result && result.evictedIds).toEqual([]);
    }
    const overflow = room.submitWebinarQuestion(
      "attendee-final",
      "Final Viewer",
      "One past the cap",
    );
    if (!("entry" in overflow)) throw new Error("submit failed");
    expect(overflow.evictedIds).toHaveLength(1);
    expect(room.getWebinarQaEntryState(overflow.evictedIds[0])).toBeNull();
    room.close();
  });
});

describe("attendee count fanout debounce", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  const makeCountFixture = (channelId: string) => {
    const emitted: Array<{ event: string; payload: unknown }> = [];
    const io = {
      to: () => ({
        emit: (event: string, payload: unknown) => {
          emitted.push({ event, payload });
        },
      }),
    } as unknown as SocketIOServer;
    let attendeeCount = 0;
    const room = {
      id: "room-1",
      channelId,
      getWebinarAttendeeCount: () => attendeeCount,
      getWebinarHandQueue: () => [],
      getAdmins: () => [],
    } as unknown as Room;
    const webinarConfig = { maxAttendees: 500 } as WebinarRoomConfig;
    const state = {
      rooms: new Map([[channelId, room]]),
      webinarConfigs: new Map([[channelId, webinarConfig]]),
    } as unknown as SfuState;
    return {
      io,
      state,
      room,
      emitted,
      setCount: (value: number) => {
        attendeeCount = value;
      },
    };
  };

  it("collapses a join burst into an immediate emit plus one trailing emit", () => {
    vi.useFakeTimers();
    const fixture = makeCountFixture(`debounce-${Math.random()}`);

    fixture.setCount(1);
    emitWebinarAttendeeCountChanged(fixture.io, fixture.state, fixture.room);
    fixture.setCount(2);
    emitWebinarAttendeeCountChanged(fixture.io, fixture.state, fixture.room);
    fixture.setCount(3);
    emitWebinarAttendeeCountChanged(fixture.io, fixture.state, fixture.room);

    expect(fixture.emitted).toHaveLength(1);
    expect(fixture.emitted[0]?.payload).toMatchObject({ attendeeCount: 1 });

    vi.advanceTimersByTime(1_100);
    expect(fixture.emitted).toHaveLength(2);
    // The trailing emit reads the live count, so the final value always lands.
    expect(fixture.emitted[1]?.payload).toMatchObject({ attendeeCount: 3 });
  });

  it("drops the throttle state after a trailing empty-room emit", () => {
    vi.useFakeTimers();
    const fixture = makeCountFixture(`debounce-empty-${Math.random()}`);

    fixture.setCount(1);
    emitWebinarAttendeeCountChanged(fixture.io, fixture.state, fixture.room);
    fixture.setCount(0);
    emitWebinarAttendeeCountChanged(fixture.io, fixture.state, fixture.room);

    vi.advanceTimersByTime(1_100);
    expect(fixture.emitted.at(-1)?.payload).toMatchObject({ attendeeCount: 0 });

    fixture.setCount(1);
    emitWebinarAttendeeCountChanged(fixture.io, fixture.state, fixture.room);
    expect(fixture.emitted.at(-1)?.payload).toMatchObject({ attendeeCount: 1 });
    expect(fixture.emitted).toHaveLength(3);
  });
});
