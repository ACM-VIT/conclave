import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const [roomFile, eventsFile, senderName, viewerName] = process.argv.slice(2);
assert(
  roomFile && eventsFile && senderName && viewerName,
  "Usage: node check-webcam.mjs <SFU room snapshot> <bot events.jsonl> <sender name> <viewer name>",
);

const { room } = JSON.parse(readFileSync(roomFile, "utf8"));
const sender = room.participants.find((participant) => participant.displayName === senderName);
const viewer = room.participants.find((participant) => participant.displayName === viewerName);
assert(sender && viewer, "Both the sender and viewer must be in the SFU room");
assert.equal(sender.cameraOff, false, `${senderName} must have their camera on`);
assert.equal(sender.producerTransportConnected, true, `${senderName} must have a connected send transport`);

const producer = sender.producers.find((entry) => entry.kind === "video" && entry.type === "webcam");
assert(producer && !producer.paused, `${senderName} must have an unpaused webcam producer`);
const consumer = viewer.consumers.find((entry) => entry.producerId === producer.producerId);
assert(consumer && !consumer.paused && !consumer.producerPaused, `${viewerName} must have an unpaused webcam consumer`);

const samples = readFileSync(eventsFile, "utf8")
  .trim()
  .split("\n")
  .map((line) => JSON.parse(line))
  .filter((event) => event.kind === "stats" && event.name === viewerName)
  .flatMap((event) => event.stats)
  .filter((stat) =>
    stat.type === "inbound-rtp" && stat.kind === "video" && stat.trackIdentifier === consumer.consumerId
  );
const firstFrameCount = samples[0]?.framesDecoded ?? 0;
const lastFrameCount = samples.at(-1)?.framesDecoded ?? 0;

assert(
  lastFrameCount > firstFrameCount,
  `${viewerName} decoded no new ${senderName} webcam frames (${firstFrameCount} -> ${lastFrameCount})`,
);
assert(consumer.score?.producerScore > 0, `${senderName} must have a positive SFU producer score`);

console.log(`${viewerName} decoded ${senderName} webcam frames (${firstFrameCount} -> ${lastFrameCount}), SFU producer score ${consumer.score.producerScore}`);
