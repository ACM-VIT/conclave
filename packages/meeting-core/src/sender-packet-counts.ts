import { z } from "zod";

export const SENDER_PACKET_COUNTS_MAX_CONSUMERS = 16;

export const senderPacketCountsRequestSchema = z.strictObject({
  consumerIds: z
    .array(z.string().min(1).max(128))
    .max(SENDER_PACKET_COUNTS_MAX_CONSUMERS)
    .refine((ids) => new Set(ids).size === ids.length, "Each consumer id once"),
});
export type SenderPacketCountsRequest = z.infer<
  typeof senderPacketCountsRequestSchema
>;

export const OWN_PACKET_COUNTS_MAX_PRODUCERS = 4;

export const ownPacketCountsRequestSchema = z.strictObject({
  producerIds: z
    .array(z.string().min(1).max(128))
    .max(OWN_PACKET_COUNTS_MAX_PRODUCERS)
    .refine((ids) => new Set(ids).size === ids.length, "Each producer id once"),
});
export type OwnPacketCountsRequest = z.infer<typeof ownPacketCountsRequestSchema>;

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
