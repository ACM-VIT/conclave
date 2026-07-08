/**
 * Identity of the AI voice agent participant. The agent joins the SFU as a
 * synthetic user from the host's tab; everything that needs to treat it
 * specially (its meeting tile, audio mixing, participant filtering) detects
 * it through these helpers.
 */

export const VOICE_AGENT_DISPLAY_NAME = "Voice Agent";

export const isVoiceAgentUserId = (userId: string): boolean => {
  const normalized = userId.toLowerCase();
  return (
    normalized.includes("@agent.conclave") ||
    normalized.startsWith("voice-agent-")
  );
};
