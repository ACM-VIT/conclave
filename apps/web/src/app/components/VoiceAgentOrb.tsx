"use client";

type VoiceAgentOrbState = "idle" | "thinking" | "speaking";

interface VoiceAgentOrbProps {
  state?: VoiceAgentOrbState;
  compact?: boolean;
  className?: string;
}

export default function VoiceAgentOrb({
  state = "idle",
  compact = false,
  className,
}: VoiceAgentOrbProps) {
  const classes = [
    "voice-agent-orb",
    compact ? "voice-agent-orb--compact" : "voice-agent-orb--regular",
    className,
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <div className={classes} data-state={state} aria-hidden="true">
      <div className="voice-agent-orb-core">
        <div className="voice-agent-orb-inner" />
        <div className="voice-agent-orb-inner" />
      </div>
    </div>
  );
}
