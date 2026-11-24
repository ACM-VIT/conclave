import { z } from "zod";

export const SENDER_PACKET_COUNTS_MAX_CONSUMERS = 16;

export const senderPacketCountsRequestSchema = z.strictObject({
  consumerIds: z
    .array(z.string().min(1).max(128))
    .max(SENDER_PACKET_COUNTS_MAX_CONSUMERS),
});
export type SenderPacketCountsRequest = z.infer<
  typeof senderPacketCountsRequestSchema
>;

export const senderPacketCountsAnswerSchema = z.strictObject({
  counts: z.record(z.string(), z.number().int().nonnegative()),
});
export type SenderPacketCountsAnswer = z.infer<
  typeof senderPacketCountsAnswerSchema
>;

const joinAnswerOfferingSenderPacketCountsSchema = z.object({
  reportsSenderPacketCounts: z.literal(true),
});

export const joinAnswerReportsSenderPacketCounts = (answer: unknown): boolean =>
  joinAnswerOfferingSenderPacketCountsSchema.safeParse(answer).success;
