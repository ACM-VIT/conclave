import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import type { Producer, WebRtcTransport } from "mediasoup/types";
import type { Server as SocketIOServer, Socket } from "socket.io";
import { Admin } from "../config/classes/Admin.js";
import { Client } from "../config/classes/Client.js";
import type { Room } from "../config/classes/Room.js";
import { applyRoomPolicyUpdate } from "../server/admin/controlPlane.js";
import type { ConnectionContext } from "../server/socket/context.js";
import { registerMediaHandlers } from "../server/socket/handlers/mediaHandlers.js";
import type { SfuState } from "../server/state.js";

type SocketHandler = (...args: never[]) => unknown;

const makeHarness = ({
  admin = false,
  unmuteAllowed = true,
  videoAllowed = true,
}: {
  admin?: boolean;
  unmuteAllowed?: boolean;
  videoAllowed?: boolean;
} = {}) => {
  const handlers = new Map<string, SocketHandler>();
  const roomBroadcast = { emit: vi.fn() };
  const socket = {
    on: vi.fn((event: string, handler: SocketHandler) => {
      handlers.set(event, handler);
      return socket;
    }),
    to: vi.fn().mockReturnValue(roomBroadcast),
  } as unknown as Socket;
  const client = admin
    ? new Admin({ id: "host", socket })
    : new Client({ id: "participant", socket });
  const transportProduce = vi.fn();
  client.producerTransport = {
    id: "producer-transport",
    produce: transportProduce,
  } as unknown as WebRtcTransport;
  const refreshWebcamReceiverCapacityProof = vi.fn();
  const roomState = {
    id: "room",
    channelId: "instance:room",
    isParticipantUnmuteAllowed: unmuteAllowed,
    isParticipantVideoAllowed: videoAllowed,
    refreshWebcamReceiverCapacityProof,
  };
  const room = roomState as unknown as Room;
  const state = {
    rooms: new Map(),
    webinarConfigs: new Map(),
    transcriptRelays: { syncRoom: vi.fn() },
  } as unknown as SfuState;

  registerMediaHandlers({
    socket,
    io: {} as ConnectionContext["io"],
    state,
    currentRoom: room,
    currentClient: client,
    pendingRoomId: null,
    pendingRoomChannelId: null,
    pendingUserKey: null,
    currentUserKey: null,
    activeConclaveAnswers: new Map(),
    adminHandlersRegistered: false,
  });

  return {
    client,
    handlers,
    refreshWebcamReceiverCapacityProof,
    setParticipantMediaPermissions: (permissions: {
      unmuteAllowed?: boolean;
      videoAllowed?: boolean;
    }) => {
      if (permissions.unmuteAllowed !== undefined) {
        roomState.isParticipantUnmuteAllowed = permissions.unmuteAllowed;
      }
      if (permissions.videoAllowed !== undefined) {
        roomState.isParticipantVideoAllowed = permissions.videoAllowed;
      }
    },
    transportProduce,
  };
};

const addProducer = (
  client: Client,
  kind: "audio" | "video",
  initialPaused = true,
): {
  producer: Producer;
  close: ReturnType<typeof vi.fn>;
  pause: ReturnType<typeof vi.fn<Producer["pause"]>>;
  resume: ReturnType<typeof vi.fn<Producer["resume"]>>;
  setPaused: (paused: boolean) => void;
} => {
  const events = new EventEmitter();
  const observer = new EventEmitter();
  const producerState = {
    id: `${kind}-producer`,
    kind,
    appData: { type: "webcam" },
    paused: initialPaused,
    on: events.on.bind(events),
    observer,
  };
  const pause = vi.fn(async () => {
    producerState.paused = true;
  });
  const resume = vi.fn(async () => {
    producerState.paused = false;
  });
  const close = vi.fn(() => {
    observer.emit("close");
  });
  const producer = {
    ...producerState,
    close,
    pause,
    resume,
  } as unknown as Producer;
  Object.defineProperty(producer, "paused", {
    get: () => producerState.paused,
  });
  client.addProducer(producer);
  return {
    producer,
    close,
    pause,
    resume,
    setPaused: (paused) => {
      producerState.paused = paused;
    },
  };
};

describe("participant media permissions", () => {
  it("stops active participant media when the host revokes permissions", () => {
    const roomBroadcast = { emit: vi.fn() };
    const io = {
      to: vi.fn().mockReturnValue(roomBroadcast),
    } as unknown as SocketIOServer;
    const participantEmit = vi.fn();
    const participantSocket = { emit: participantEmit } as unknown as Socket;
    const pausedParticipantSocket = { emit: vi.fn() } as unknown as Socket;
    const hostSocket = { emit: vi.fn() } as unknown as Socket;
    const participant = new Client({
      id: "participant",
      socket: participantSocket,
    });
    const pausedParticipant = new Client({
      id: "paused-participant",
      socket: pausedParticipantSocket,
    });
    const host = new Admin({ id: "host", socket: hostSocket });
    const participantAudio = addProducer(participant, "audio", false);
    const participantVideo = addProducer(participant, "video", false);
    const pausedAudio = addProducer(pausedParticipant, "audio", true);
    const hostAudio = addProducer(host, "audio", false);
    const hostVideo = addProducer(host, "video", false);
    const clients = new Map<string, Client>([
      [participant.id, participant],
      [pausedParticipant.id, pausedParticipant],
      [host.id, host],
    ]);
    const roomState = {
      id: "room",
      channelId: "instance:room",
      clients,
      isParticipantUnmuteAllowed: true,
      isParticipantVideoAllowed: true,
      setParticipantUnmuteAllowed: (allowed: boolean) => {
        roomState.isParticipantUnmuteAllowed = allowed;
      },
      setParticipantVideoAllowed: (allowed: boolean) => {
        roomState.isParticipantVideoAllowed = allowed;
      },
      getClient: (userId: string) => clients.get(userId),
      removeProducerIndexById: vi.fn(),
      clearScreenShareProducer: vi.fn(),
    };
    const room = roomState as unknown as Room;
    const state = {
      rooms: new Map([[room.channelId, room]]),
      webinarConfigs: new Map(),
      transcriptRelays: { syncRoom: vi.fn() },
    } as unknown as SfuState;

    const result = applyRoomPolicyUpdate(io, state, room, {
      participantUnmuteAllowed: false,
      participantVideoAllowed: false,
    });

    expect(result.changed).toEqual({
      participantUnmuteAllowed: false,
      participantVideoAllowed: false,
    });
    expect(participantAudio.close).toHaveBeenCalledOnce();
    expect(participantVideo.close).toHaveBeenCalledOnce();
    expect(participant.isMuted).toBe(true);
    expect(participant.isCameraOff).toBe(true);
    expect(pausedAudio.close).not.toHaveBeenCalled();
    expect(hostAudio.close).not.toHaveBeenCalled();
    expect(hostVideo.close).not.toHaveBeenCalled();
    expect(participantEmit).toHaveBeenCalledWith(
      "admin:mediaEnforced",
      {
        roomId: room.id,
        userId: participant.id,
        action: "closed",
        reason: "Participant media permission revoked by host",
        producers: [
          {
            producerId: "audio-producer",
            kind: "audio",
            type: "webcam",
          },
          {
            producerId: "video-producer",
            kind: "video",
            type: "webcam",
          },
        ],
      },
    );
    expect(roomBroadcast.emit).toHaveBeenCalledWith("participantMuted", {
      userId: participant.id,
      muted: true,
      roomId: room.id,
    });
    expect(roomBroadcast.emit).toHaveBeenCalledWith("participantCameraOff", {
      userId: participant.id,
      cameraOff: true,
      roomId: room.id,
    });
    expect(roomBroadcast.emit).toHaveBeenCalledWith(
      "participantMediaPermissionsChanged",
      {
        unmuteAllowed: false,
        videoAllowed: false,
        roomId: room.id,
      },
    );
    expect(state.transcriptRelays.syncRoom).toHaveBeenCalledWith(room);
  });

  it("blocks a participant from resuming microphone and camera", async () => {
    const { client, handlers } = makeHarness({
      unmuteAllowed: false,
      videoAllowed: false,
    });
    const audio = addProducer(client, "audio");
    const video = addProducer(client, "video");
    const toggleMute = handlers.get("toggleMute") as unknown as (
      data: { paused: boolean },
      callback: (response: { success?: boolean; error?: string }) => void,
    ) => Promise<void>;
    const toggleCamera = handlers.get("toggleCamera") as unknown as (
      data: { paused: boolean },
      callback: (response: { success?: boolean; error?: string }) => void,
    ) => Promise<void>;
    const muteCallback = vi.fn();
    const cameraCallback = vi.fn();

    await toggleMute({ paused: false }, muteCallback);
    await toggleCamera({ paused: false }, cameraCallback);

    expect(muteCallback).toHaveBeenCalledWith({
      error: "The host has blocked participants from unmuting",
    });
    expect(cameraCallback).toHaveBeenCalledWith({
      error: "The host has blocked participants from turning on video",
    });
    expect(audio.resume).not.toHaveBeenCalled();
    expect(video.resume).not.toHaveBeenCalled();
  });

  it("keeps hosts exempt from participant camera restrictions", async () => {
    const { client, handlers, refreshWebcamReceiverCapacityProof } =
      makeHarness({ admin: true, videoAllowed: false });
    const video = addProducer(client, "video");
    const toggleCamera = handlers.get("toggleCamera") as unknown as (
      data: { paused: boolean },
      callback: (response: { success?: boolean; error?: string }) => void,
    ) => Promise<void>;
    const callback = vi.fn();

    await toggleCamera({ paused: false }, callback);

    expect(video.resume).toHaveBeenCalledOnce();
    expect(refreshWebcamReceiverCapacityProof).toHaveBeenCalledWith(
      video.producer.id,
    );
    expect(callback).toHaveBeenCalledWith({ success: true });
  });

  it("rejects fresh unpaused webcam publications for participants", async () => {
    const { handlers, transportProduce } = makeHarness({
      unmuteAllowed: false,
      videoAllowed: false,
    });
    const produce = handlers.get("produce") as unknown as (
      data: {
        transportId: string;
        kind: "audio" | "video";
        rtpParameters: object;
        appData: { type: "webcam"; paused: boolean };
      },
      callback: (response: { producerId?: string; error?: string }) => void,
    ) => Promise<void>;
    const audioCallback = vi.fn();
    const videoCallback = vi.fn();
    const rtpParameters = {
      codecs: [],
      encodings: [],
      headerExtensions: [],
      rtcp: {},
    };

    await produce(
      {
        transportId: "producer-transport",
        kind: "audio",
        rtpParameters,
        appData: { type: "webcam", paused: false },
      },
      audioCallback,
    );
    await produce(
      {
        transportId: "producer-transport",
        kind: "video",
        rtpParameters,
        appData: { type: "webcam", paused: false },
      },
      videoCallback,
    );

    expect(audioCallback).toHaveBeenCalledWith({
      error: "The host has blocked participants from unmuting",
    });
    expect(videoCallback).toHaveBeenCalledWith({
      error: "The host has blocked participants from turning on video",
    });
    expect(transportProduce).not.toHaveBeenCalled();
  });

  it("rejects a webcam publication when the host disables it in flight", async () => {
    const { handlers, setParticipantMediaPermissions, transportProduce } =
      makeHarness();
    const produce = handlers.get("produce") as unknown as (
      data: {
        transportId: string;
        kind: "audio";
        rtpParameters: object;
        appData: { type: "webcam"; paused: boolean };
      },
      callback: (response: { producerId?: string; error?: string }) => void,
    ) => Promise<void>;
    let finishProduce!: (producer: Producer) => void;
    transportProduce.mockImplementation(
      () =>
        new Promise<Producer>((resolve) => {
          finishProduce = resolve;
        }),
    );
    const close = vi.fn();
    const producer = {
      id: "late-audio-producer",
      kind: "audio",
      rtpParameters: {},
      close,
    } as unknown as Producer;
    const callback = vi.fn();

    const publication = produce(
      {
        transportId: "producer-transport",
        kind: "audio",
        rtpParameters: {},
        appData: { type: "webcam", paused: false },
      },
      callback,
    );
    await vi.waitFor(() => expect(transportProduce).toHaveBeenCalledOnce());
    setParticipantMediaPermissions({ unmuteAllowed: false });
    finishProduce(producer);
    await publication;

    expect(close).toHaveBeenCalledOnce();
    expect(callback).toHaveBeenCalledWith({
      error: "The host has blocked participants from unmuting",
    });
  });

  it("re-pauses media when the host disables it during resume", async () => {
    const { client, handlers, setParticipantMediaPermissions } = makeHarness();
    const audio = addProducer(client, "audio");
    const video = addProducer(client, "video");
    const toggleMute = handlers.get("toggleMute") as unknown as (
      data: { paused: boolean },
      callback: (response: { success?: boolean; error?: string }) => void,
    ) => Promise<void>;
    const toggleCamera = handlers.get("toggleCamera") as unknown as (
      data: { paused: boolean },
      callback: (response: { success?: boolean; error?: string }) => void,
    ) => Promise<void>;
    let finishAudioResume!: () => void;
    let finishVideoResume!: () => void;
    audio.resume.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          finishAudioResume = () => {
            audio.setPaused(false);
            resolve();
          };
        }),
    );
    video.resume.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          finishVideoResume = () => {
            video.setPaused(false);
            resolve();
          };
        }),
    );
    const muteCallback = vi.fn();
    const cameraCallback = vi.fn();

    const muteResume = toggleMute({ paused: false }, muteCallback);
    await vi.waitFor(() => expect(audio.resume).toHaveBeenCalledOnce());
    setParticipantMediaPermissions({ unmuteAllowed: false });
    finishAudioResume();
    await muteResume;

    const cameraResume = toggleCamera({ paused: false }, cameraCallback);
    await vi.waitFor(() => expect(video.resume).toHaveBeenCalledOnce());
    setParticipantMediaPermissions({ videoAllowed: false });
    finishVideoResume();
    await cameraResume;

    expect(audio.pause).toHaveBeenCalledOnce();
    expect(video.pause).toHaveBeenCalledOnce();
    expect(audio.producer.paused).toBe(true);
    expect(video.producer.paused).toBe(true);
    expect(muteCallback).toHaveBeenCalledWith({
      error: "The host has blocked participants from unmuting",
    });
    expect(cameraCallback).toHaveBeenCalledWith({
      error: "The host has blocked participants from turning on video",
    });
  });
});
