import { randomUUID } from "node:crypto";
import { parseArgs } from "node:util";
import jwt from "jsonwebtoken";
import type { Device as DeviceType } from "mediasoup-client";
import type {
  Consumer,
  Producer,
  ProducerOptions,
  RtpCapabilities,
  Transport,
  TransportOptions,
} from "mediasoup-client/types";
import { io, type Socket } from "socket.io-client";
import { MediaStreamTrack, RtpHeader, RtpPacket } from "werift";
import { createDummyRegister, installPolyfill } from "werift/polyfill";
import { asArray, asRecord, readBoolean, readString } from "../utilities/untrusted.js";

// A real two-person call against one SFU instance, with no browser: two
// clients join one room, each publishes Opus audio and consumes the other's,
// and the call passes only when RTP arrives in both directions through the
// SFU. werift supplies RTCPeerConnection, so this runs the same
// mediasoup-client signaling the web app uses. The deploy script runs it from
// the freshly built image before any traffic moves to it.
//
//   SFU_SECRET=... node --import tsx scripts/canary-call.ts --url http://127.0.0.1:3032
//
// --hold-ms keeps the call up afterwards and fails on any second without
// audio in either direction, which makes it a stand-in live call for deploy
// tests.

const { values: args } = parseArgs({
  options: {
    url: { type: "string" },
    "client-id": { type: "string", default: "default" },
    "candidate-ip": { type: "string", default: "127.0.0.1" },
    "media-ms": { type: "string", default: "4000" },
    "min-packets": { type: "string", default: "50" },
    "hold-ms": { type: "string", default: "0" },
    "timeout-ms": { type: "string", default: "45000" },
  },
});

const sfuUrl = args.url?.replace(/\/+$/, "");
const secret = process.env.SFU_SECRET?.trim();
if (!sfuUrl || !secret) {
  console.error("Usage: SFU_SECRET=... canary-call.ts --url <sfu origin>");
  process.exit(2);
}
const clientId = args["client-id"];
const candidateIp = args["candidate-ip"];
const mediaMs = Number(args["media-ms"]);
const minPackets = Number(args["min-packets"]);
const holdMs = Number(args["hold-ms"]);
const timeoutMs = Number(args["timeout-ms"]) + holdMs;
const roomId = `canary-${randomUUID().slice(0, 12)}`;

setTimeout(() => {
  console.error(`FAIL canary did not finish within ${timeoutMs} ms`);
  process.exit(1);
}, timeoutMs).unref();

installPolyfill({
  mediaRegister: [createDummyRegister()],
  userAgent:
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
});
// mediasoup-client reads the RTCPeerConnection globals when it loads, so it
// is imported after the werift polyfill is installed.
const { Device } = await import("mediasoup-client");

const failures: string[] = [];
const check = (name: string, ok: boolean, detail = ""): boolean => {
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` (${detail})` : ""}`);
  if (!ok) failures.push(name);
  return ok;
};

const admin = async (method: "GET" | "POST", path: string, body?: object) => {
  const response = await fetch(`${sfuUrl}${path}`, {
    method,
    headers: { "x-sfu-secret": secret, "content-type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(5000),
  });
  if (!response.ok) throw new Error(`${method} ${path} answered HTTP ${response.status}`);
  return asRecord(await response.json());
};

const request = (socket: Socket, event: string, payload?: object): Promise<Record<string, unknown>> =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${event} was not acknowledged`)), 10_000);
    const callback = (response: unknown) => {
      clearTimeout(timer);
      const record = asRecord(response);
      const error = readString(record, "error");
      if (error) reject(new Error(`${event}: ${error}`));
      else resolve(record);
    };
    if (payload) socket.emit(event, payload, callback);
    else socket.emit(event, callback);
  });

// The SFU announces its public address. The canary runs on the same host, so
// it reaches the transport on loopback (the SFU listens on 0.0.0.0).
const transportOptions = (response: Record<string, unknown>): TransportOptions => {
  const candidates = (asArray(response.iceCandidates) ?? [])
    .map(asRecord)
    .filter((candidate) => readString(candidate, "protocol") === "udp")
    .map((candidate) => ({ ...candidate, address: candidateIp, ip: candidateIp }));
  return { ...response, iceCandidates: candidates } as unknown as TransportOptions;
};

type CanaryClient = {
  name: string;
  socket: Socket;
  device: DeviceType;
  sendTransport?: Transport;
  recvTransport?: Transport;
  producer?: Producer;
  announcedProducers: Set<string>;
  stopAudio?: () => void;
};

const connectClient = async (name: string): Promise<CanaryClient> => {
  const sessionId = randomUUID();
  const token = jwt.sign(
    {
      userId: `conclave-canary-${name.toLowerCase()}`,
      name: `Canary ${name}`,
      isHost: true,
      isAdmin: true,
      allowRoomCreation: true,
      clientId,
      sessionId,
      joinMode: "meeting",
    },
    secret,
    { expiresIn: "5m" },
  );
  const socket = io(sfuUrl, { transports: ["websocket"], auth: { token }, reconnection: false });
  const client: CanaryClient = { name, socket, device: new Device({ handlerName: "Chrome111" }), announcedProducers: new Set() };
  socket.on("newProducer", (info: unknown) => {
    const producerId = readString(asRecord(info), "producerId");
    if (producerId) client.announcedProducers.add(producerId);
  });
  await new Promise<void>((resolve, reject) => {
    socket.once("connect", () => resolve());
    socket.once("connect_error", (error) => reject(error));
  });
  const joined = await request(socket, "joinRoom", { roomId, sessionId, displayName: `Canary ${name}` });
  check(`${name} joined ${roomId}`, readString(joined, "status") === "joined", readString(joined, "status") ?? "no status");
  await client.device.load({ routerRtpCapabilities: joined.rtpCapabilities as RtpCapabilities });
  return client;
};

const waitForConnected = (transport: Transport, label: string) =>
  new Promise<void>((resolve, reject) => {
    if (transport.connectionState === "connected") return resolve();
    transport.on("connectionstatechange", (state) => {
      if (state === "connected") resolve();
      if (state === "failed" || state === "closed") reject(new Error(`${label} transport ${state}`));
    });
  });

const publishAudio = async (client: CanaryClient) => {
  const sendTransport = client.device.createSendTransport(
    transportOptions(await request(client.socket, "createProducerTransport")),
  );
  sendTransport.on("connect", ({ dtlsParameters }, callback, errback) => {
    request(client.socket, "connectProducerTransport", { transportId: sendTransport.id, dtlsParameters })
      .then(() => callback(), errback);
  });
  sendTransport.on("produce", ({ kind, rtpParameters, appData }, callback, errback) => {
    request(client.socket, "produce", { transportId: sendTransport.id, kind, rtpParameters, appData })
      .then((response) => callback({ id: readString(response, "producerId") ?? "" }), errback);
  });
  const track = new MediaStreamTrack({ kind: "audio" });
  // mediasoup-client types the track as the DOM MediaStreamTrack; werift's
  // track is what the polyfilled RTCPeerConnection actually sends.
  const producer = await sendTransport.produce({
    track: track as unknown as ProducerOptions["track"],
    appData: { type: "webcam" },
  });
  const codec = producer.rtpParameters.codecs[0];
  const ssrc = producer.rtpParameters.encodings?.[0]?.ssrc;
  let sequenceNumber = 0;
  let timestamp = 0;
  // A 20 ms Opus packet that decodes to silence, sent at the real cadence.
  const timer = setInterval(() => {
    sequenceNumber = (sequenceNumber + 1) & 0xffff;
    timestamp = (timestamp + 960) >>> 0;
    const header = new RtpHeader({ payloadType: codec.payloadType, sequenceNumber, timestamp, ssrc, marker: false });
    track.writeRtp(new RtpPacket(header, Buffer.from([0xf8, 0xff, 0xfe])));
  }, 20);
  client.sendTransport = sendTransport;
  client.producer = producer;
  client.stopAudio = () => clearInterval(timer);
  await waitForConnected(sendTransport, `${client.name} send`);
};

const consumeFrom = async (client: CanaryClient, producerId: string): Promise<Consumer> => {
  if (!client.recvTransport) {
    const recvTransport = client.device.createRecvTransport(
      transportOptions(await request(client.socket, "createConsumerTransport")),
    );
    recvTransport.on("connect", ({ dtlsParameters }, callback, errback) => {
      request(client.socket, "connectConsumerTransport", { transportId: recvTransport.id, dtlsParameters })
        .then(() => callback(), errback);
    });
    client.recvTransport = recvTransport;
  }
  const response = await request(client.socket, "consume", {
    transportId: client.recvTransport.id,
    producerId,
    rtpCapabilities: client.device.recvRtpCapabilities,
  });
  const consumer = await client.recvTransport.consume({
    id: readString(response, "id") ?? "",
    producerId,
    kind: readString(response, "kind") === "video" ? "video" : "audio",
    rtpParameters: response.rtpParameters as Consumer["rtpParameters"],
  });
  if (readBoolean(response, "paused") !== false) {
    await request(client.socket, "resumeConsumer", { consumerId: consumer.id });
  }
  return consumer;
};

// werift's polyfill is a separate bundle from its main entry, so a received
// track fails `instanceof MediaStreamTrack`; check for the RTP event instead.
const receivesRtp = (track: unknown): track is Pick<MediaStreamTrack, "onReceiveRtp"> =>
  typeof (track as Partial<MediaStreamTrack> | null)?.onReceiveRtp?.subscribe === "function";

const countRtp = (consumer: Consumer): (() => number) => {
  let packets = 0;
  const track: unknown = consumer.track;
  if (receivesRtp(track)) track.onReceiveRtp.subscribe(() => void packets++);
  return () => packets;
};

// Samples both directions once a second for the hold and returns the longest
// run of seconds in which either side received nothing.
const holdCall = async (counters: Array<() => number>, sockets: Socket[]) => {
  let longestSilence = 0;
  let silence = 0;
  let last = counters.map((count) => count());
  for (let elapsed = 0; elapsed < holdMs; elapsed += 1000) {
    await new Promise((resolve) => setTimeout(resolve, 1000));
    const now = counters.map((count) => count());
    silence = now.some((value, index) => value === last[index]) ? silence + 1 : 0;
    longestSilence = Math.max(longestSilence, silence);
    last = now;
    if (sockets.some((socket) => !socket.connected)) return { longestSilence, disconnected: true };
  }
  return { longestSilence, disconnected: false };
};

const clients: CanaryClient[] = [];
try {
  const status = await admin("GET", "/status");
  console.log(`Canary against ${readString(status, "instanceId")} at ${sfuUrl}, room ${roomId}`);
  // The deploy keeps a fresh build drained until this call passes. A
  // draining instance hosts a new room only with a placement, which it grants
  // to this authenticated request alone.
  await admin("POST", `/routing/placements/${encodeURIComponent(clientId)}/${roomId}`, {
    allowDraining: true,
  });

  const alice = await connectClient("Alice");
  clients.push(alice);
  const bob = await connectClient("Bob");
  clients.push(bob);
  await publishAudio(alice);
  await publishAudio(bob);
  check("Alice and Bob send transports connected", true);

  const aliceProducer = alice.producer?.id ?? "";
  const bobProducer = bob.producer?.id ?? "";
  const bobHears = await consumeFrom(bob, aliceProducer);
  const aliceHears = await consumeFrom(alice, bobProducer);
  await Promise.all([
    waitForConnected(bob.recvTransport!, "Bob receive"),
    waitForConnected(alice.recvTransport!, "Alice receive"),
  ]);
  check("Alice and Bob receive transports connected", true);
  check("Alice was told about Bob's producer", alice.announcedProducers.has(bobProducer));

  const bobPackets = countRtp(bobHears);
  const alicePackets = countRtp(aliceHears);
  await new Promise((resolve) => setTimeout(resolve, mediaMs));
  check("Bob received Alice's audio", bobPackets() >= minPackets, `${bobPackets()} RTP packets in ${mediaMs} ms`);
  check("Alice received Bob's audio", alicePackets() >= minPackets, `${alicePackets()} RTP packets in ${mediaMs} ms`);
  if (holdMs > 0) {
    const held = await holdCall([bobPackets, alicePackets], [alice.socket, bob.socket]);
    check(`call stayed up for ${holdMs} ms`, !held.disconnected, held.disconnected ? "a client was disconnected" : "");
    check("audio never stopped for more than 2 s", held.longestSilence <= 2, `longest silence ${held.longestSilence} s`);
  }

  for (const client of clients) {
    client.stopAudio?.();
    client.socket.close();
  }
  // A lingering canary room would hold the next drain open forever.
  const roomPath = `/rooms/${roomId}?clientId=${encodeURIComponent(clientId)}`;
  let roomOpen = true;
  for (let attempt = 0; attempt < 20 && roomOpen; attempt += 1) {
    roomOpen = asRecord(await admin("GET", roomPath)).room != null;
    if (roomOpen) await new Promise((resolve) => setTimeout(resolve, 500));
  }
  check("canary room closed after both left", !roomOpen);
} catch (error) {
  check("canary call", false, error instanceof Error ? error.message : String(error));
} finally {
  for (const client of clients) {
    client.stopAudio?.();
    client.socket.close();
  }
}

console.log(failures.length === 0 ? "Canary passed." : `Canary failed: ${failures.join("; ")}`);
process.exit(failures.length === 0 ? 0 : 1);
