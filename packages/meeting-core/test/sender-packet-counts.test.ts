import { describe, expect, it } from "vitest";
import {
  joinAnswerReportsSenderPacketCounts,
  SENDER_PACKET_COUNTS_MAX_CONSUMERS,
  senderPacketCountsAnswerSchema,
  senderPacketCountsRequestSchema,
} from "../src/sender-packet-counts";

const ids = (count: number) => Array.from({ length: count }, (_, index) => `consumer-${index}`);

describe("asking the SFU how many packets the sharers behind a viewer's consumers sent", () => {
  it.each<[string, unknown, boolean]>([
    ["a list of consumer ids", { consumerIds: ["a", "b"] }, true],
    ["an empty list", { consumerIds: [] }, true],
    ["the most ids one request may name", { consumerIds: ids(SENDER_PACKET_COUNTS_MAX_CONSUMERS) }, true],
    ["one id too many", { consumerIds: ids(SENDER_PACKET_COUNTS_MAX_CONSUMERS + 1) }, false],
    ["an id that is not a string", { consumerIds: ["a", 7] }, false],
    ["an empty id", { consumerIds: [""] }, false],
    ["an id longer than any consumer id", { consumerIds: ["x".repeat(129)] }, false],
    ["a field the request does not have", { consumerIds: ["a"], producerIds: ["b"] }, false],
    ["no request at all", undefined, false],
  ])("reads %s as %s", (_name, request, valid) => {
    expect(senderPacketCountsRequestSchema.safeParse(request).success).toBe(valid);
  });

  it.each<[string, unknown, boolean]>([
    ["counts by consumer id", { counts: { a: 0, b: 1200 } }, true],
    ["no counts", { counts: {} }, true],
    ["an error answer", { error: "Too many requests" }, false],
    ["a negative count", { counts: { a: -1 } }, false],
    ["a fractional count", { counts: { a: 1.5 } }, false],
    ["a count sent as text", { counts: { a: "12" } }, false],
    ["a field the answer does not have", { counts: {}, extra: true }, false],
  ])("reads the answer %s as %s", (_name, answer, valid) => {
    expect(senderPacketCountsAnswerSchema.safeParse(answer).success).toBe(valid);
  });
});

describe("knowing from the join answer whether the SFU reports the sharer's packets", () => {
  it.each<[string, unknown, boolean]>([
    ["an answer that offers it", { status: "joined", reportsSenderPacketCounts: true }, true],
    ["an answer from an SFU that does not", { status: "joined" }, false],
    ["an answer that turns it off", { reportsSenderPacketCounts: false }, false],
    ["an answer that says it as text", { reportsSenderPacketCounts: "true" }, false],
    ["no answer at all", undefined, false],
  ])("reads %s as %s", (_name, answer, offered) => {
    expect(joinAnswerReportsSenderPacketCounts(answer)).toBe(offered);
  });
});
