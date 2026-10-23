export const AI_GENERATION_LIMITS = {
  outputTokens: 32_768,
  researchTokens: 16_384,
  maxOutputTokens: 128_000,
  timeoutMs: 600_000,
  maxTimeoutMs: 1_800_000,
  gameAckTimeoutMs: 1_815_000,
  relayContentChars: 512_000,
  relayReasoningChars: 128_000,
} as const;
