import { EventEmitter } from "node:events";
import { createServer } from "node:http";
import type { Producer, Router } from "mediasoup/types";
import { Server } from "socket.io";
import { io as connect } from "socket.io-client";
import { expect, it, vi } from "vitest";
import { Client } from "../config/classes/Client.js";
import { Room } from "../config/classes/Room.js";
import type { ActiveSpeakerChangedNotification } from "../types.js";

it("delivers each meeting active speaker change once to meeting sockets only", async () => {
  const http = createServer();
  const io = new Server(http);
  await new Promise<void>((resolve, reject) => {
    http.once("error", reject);
    http.listen(0, "127.0.0.1", resolve);
  });
  const address = http.address();
  if (!address || typeof address === "string") throw new Error("Missing test server address");
  const peers = ["alice", "bob", "attendee", "other-room"].map((id) => {
    const socket = connect(`http://127.0.0.1:${address.port}`, {
      autoConnect: false,
      reconnection: false,
      transports: ["websocket"],
    });
    const notifications: ActiveSpeakerChangedNotification[] = [];
    socket.on("activeSpeakerChanged", (event: ActiveSpeakerChangedNotification) => {
      notifications.push(event);
    });
    socket.on("barrier", (ack: () => void) => ack());
    return { id, socket, notifications };
  });

  try {
    const observer = Object.assign(new EventEmitter(), {
      addProducer: vi.fn().mockResolvedValue(undefined),
    });
    const router = {
      createAudioLevelObserver: vi.fn().mockResolvedValue(observer),
    } as unknown as Router;
    const room = new Room({ id: "room", clientId: "conclave", workerPid: null, router });
    const serverSockets = await Promise.all(peers.map(async ({ id, socket }) => {
      await new Promise<void>((resolve, reject) => {
        socket.once("connect", resolve);
        socket.once("connect_error", reject);
        socket.connect();
      });
      const serverSocket = io.sockets.sockets.get(socket.id!);
      if (!serverSocket) throw new Error(`Missing server socket for ${id}`);
      if (id !== "other-room") {
        room.addClient(new Client({
          id,
          socket: serverSocket,
          ...(id === "attendee" ? { mode: "webinar_attendee" } : {}),
        }));
      }
      return serverSocket;
    }));

    const producer = Object.assign(new EventEmitter(), {
      id: "mic",
      kind: "audio",
      paused: false,
      appData: { type: "webcam" },
      observer: new EventEmitter(),
    }) as unknown as Producer;
    room.getClient("alice")!.addProducer(producer);
    await room.registerWebinarAudioProducer("alice", producer, "webcam");
    observer.emit("volumes", [{ producer, volume: -20 }]);
    observer.emit("volumes", [{ producer, volume: -20 }]);
    await Promise.all(serverSockets.map((socket) => socket.timeout(1000).emitWithAck("barrier")));

    const expected = [{ roomId: "room", userId: null }, { roomId: "room", userId: "alice" }];
    expect(peers.map(({ notifications }) => notifications)).toEqual([expected, expected, [], []]);
  } finally {
    for (const { socket } of peers) socket.close();
    await io.close();
  }
});
