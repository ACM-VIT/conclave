"use client";

import { useEffect, useRef } from "react";
import { color } from "@conclave/ui-tokens";
import type { AdminChatMessage } from "./types";
import { Section } from "./ui";

const formatClock = (at: number): string =>
  new Date(at).toLocaleTimeString([], {
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
  });

/**
 * Read-only live chat for the watched room, streamed by the gateway from the
 * room's broadcast history (direct messages never enter that buffer, so they
 * can never appear here).
 */
export function ChatSpectator({ messages }: { messages: AdminChatMessage[] | null }) {
  const scrollRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const container = scrollRef.current;
    if (container) container.scrollTop = container.scrollHeight;
  }, [messages]);

  return (
    <Section title={messages && messages.length > 0 ? `Chat · ${messages.length}` : "Chat"}>
      {!messages || messages.length === 0 ? (
        <p className="text-[12px]" style={{ color: color.textFaint }}>
          No messages yet.
        </p>
      ) : (
        <div
          ref={scrollRef}
          className="max-h-72 space-y-1.5 overflow-y-auto rounded-lg border p-3"
          style={{ borderColor: color.border, backgroundColor: color.surface }}
        >
          {messages.map((message) => (
            <p key={message.id} className="text-[12.5px] leading-relaxed [overflow-wrap:anywhere]">
              <span style={{ color: color.textFaint, fontVariantNumeric: "tabular-nums" }}>
                {formatClock(message.timestamp)}
              </span>{" "}
              <span className="font-medium" style={{ color: color.text }}>
                {message.displayName}
              </span>{" "}
              <span style={{ color: color.textMuted }}>
                {message.content ||
                  (message.gif ? "(gif)" : message.image ? "(image)" : "")}
              </span>
            </p>
          ))}
        </div>
      )}
    </Section>
  );
}
