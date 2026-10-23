"use client";

import { useState } from "react";
import {
  CheckCircle2,
  AudioLines,
  Image as ImageIcon,
  Sparkles,
  ChevronDown,
  ExternalLink,
  Loader2,
  X,
} from "lucide-react";
import { AI_PROVIDERS } from "@conclave/ai/models";
import { ROOM_AI_PROVIDERS, type RoomAiProvider } from "@conclave/ai/room";
import type { RoomAiController } from "../hooks/useRoomAi";

const uses = {
  openai: [
    { Icon: ImageIcon, label: "Image safety" },
    { Icon: AudioLines, label: "Transcription" },
    { Icon: Sparkles, label: "Assistant & games" },
  ],
  anthropic: [
    { Icon: Sparkles, label: "Assistant, questions, minutes & games" },
  ],
  sarvam: [{ Icon: AudioLines, label: "Transcription" }],
};

export default function RoomAiSettings({
  controller,
  onClose,
}: {
  controller: RoomAiController;
  onClose: () => void;
}) {
  const [expanded, setExpanded] = useState<RoomAiProvider | null>(
    () =>
      ROOM_AI_PROVIDERS.find(
        (provider) => !controller.state[provider].source,
      ) ?? null,
  );
  const [apiKey, setApiKey] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const save = async (provider: RoomAiProvider, remove: boolean) => {
    setPending(true);
    setError(null);
    setNotice(null);
    const failure = await controller.configure(
      provider,
      remove ? null : apiKey.trim(),
    );
    setPending(false);
    if (failure) {
      setError(failure);
      return;
    }
    setApiKey("");
    setExpanded(null);
    setNotice(
      `${AI_PROVIDERS[provider].label} key ${remove ? "removed" : "shared"}`,
    );
  };
  return (
    <section
      aria-label="Room AI settings"
      className="border-b border-white/10 bg-[#1e1e21] px-4 py-4"
    >
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-[13px] font-semibold text-[#fafafa]">
          Room AI settings
        </h3>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close AI settings"
          className="rounded-lg p-1.5 text-[#a1a1aa] hover:bg-white/[0.06] hover:text-white"
        >
          <X size={16} />
        </button>
      </div>
      <div className="mt-3 divide-y divide-white/10">
        {ROOM_AI_PROVIDERS.map((provider) => {
          const status = controller.state[provider];
          const canEdit =
            status.source !== "deployment" &&
            (status.source !== "room" ||
              controller.isAdmin ||
              status.ownerId === controller.currentUserId);
          const open = expanded === provider;
          return (
            <div key={provider} className="py-3 first:pt-0 last:pb-0">
              <button
                type="button"
                disabled={
                  pending ||
                  !canEdit ||
                  !controller.connected ||
                  !controller.ready
                }
                onClick={() => {
                  setExpanded(open ? null : provider);
                  setApiKey("");
                  setError(null);
                  setNotice(null);
                }}
                title={
                  !canEdit && status.source === "room"
                    ? "Managed by the contributor or a host"
                    : undefined
                }
                aria-expanded={open}
                className="flex w-full items-center gap-2 text-left disabled:cursor-default"
              >
                <span className="min-w-0 flex-1">
                  <span className="block text-[12px] font-medium text-[#fafafa]">
                    {AI_PROVIDERS[provider].label}
                  </span>

                  <span
                    className={`mt-1 block text-[10.5px] ${status.source ? "text-[#91cbb0]" : "text-[#a1a1aa]"}`}
                  >
                    {!controller.connected
                      ? "Reconnecting…"
                      : !controller.ready
                        ? "Loading…"
                        : status.source === "deployment"
                          ? "Conclave key"
                          : status.source === "room"
                            ? "Room key"
                            : "Not set"}
                  </span>
                </span>
                <span className="flex shrink-0 gap-1.5 text-[#71717a]">
                  {uses[provider].map(({ Icon, label }) => (
                    <span
                      key={label}
                      title={label}
                      role="img"
                      aria-label={label}
                    >
                      <Icon size={13} />
                    </span>
                  ))}
                </span>
                {canEdit ? (
                  <span className="flex shrink-0 items-center gap-1 text-[11px] text-[#d4d4d8]">
                    {status.source === "room" ? "Manage" : "Add key"}
                    <ChevronDown
                      size={13}
                      className={open ? "rotate-180" : ""}
                    />
                  </span>
                ) : status.source ? (
                  <CheckCircle2 size={15} className="shrink-0 text-[#91cbb0]" />
                ) : null}
              </button>
              {open && canEdit && controller.ready && controller.connected ? (
                <form
                  className="mt-3 space-y-2.5"
                  onSubmit={(event) => {
                    event.preventDefault();
                    void save(provider, false);
                  }}
                >
                  <label className="block text-[11px] text-[#d4d4d8]">
                    {AI_PROVIDERS[provider].label} API key
                    <input
                      autoFocus
                      maxLength={512}
                      type="password"
                      value={apiKey}
                      onChange={(event) => setApiKey(event.target.value)}
                      autoComplete="off"
                      spellCheck={false}
                      disabled={pending}
                      placeholder={
                        provider === "anthropic"
                          ? "sk-ant-…"
                          : provider === "openai"
                            ? "sk-…"
                            : "Enter API key"
                      }
                      className="mt-1.5 h-10 w-full rounded-lg border border-white/10 bg-black/20 px-3 text-[12px] text-white outline-none focus:border-[#F95F4A]/60"
                    />
                  </label>
                  <p className="text-[11px] leading-relaxed text-[#a1a1aa]">
                    Your account is billed. Cleared when the room ends.
                  </p>
                  <div className="flex items-center gap-2">
                    <button
                      type="submit"
                      disabled={
                        pending || !apiKey.trim() || !controller.connected
                      }
                      className="inline-flex h-9 flex-1 items-center justify-center gap-1.5 rounded-lg bg-[#F95F4A] px-3 text-[12px] font-semibold text-white hover:bg-[#ff735f] disabled:opacity-40"
                    >
                      {pending ? (
                        <Loader2 size={13} className="animate-spin" />
                      ) : null}
                      {status.source === "room"
                        ? "Replace room key"
                        : "Share with room"}
                    </button>
                    {status.source === "room" ? (
                      <button
                        type="button"
                        disabled={pending || !controller.connected}
                        onClick={() => void save(provider, true)}
                        title="Remove for new requests. Stop active notes to revoke their current key."
                        className="h-9 rounded-lg border border-white/10 px-3 text-[11px] text-[#d4d4d8] disabled:opacity-40"
                      >
                        Remove
                      </button>
                    ) : null}
                  </div>
                  <a
                    href={AI_PROVIDERS[provider].keysUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1 text-[11px] text-[#a1a1aa] hover:text-white"
                  >
                    Get key
                    <ExternalLink size={11} />
                  </a>
                </form>
              ) : null}
            </div>
          );
        })}
      </div>
      {error ? (
        <p
          role="alert"
          className="mt-3 text-[11.5px] leading-relaxed text-red-300"
        >
          {error}
        </p>
      ) : null}
      {notice ? (
        <p
          role="status"
          className="mt-3 text-[11.5px] leading-relaxed text-[#91cbb0]"
        >
          {notice}
        </p>
      ) : null}
    </section>
  );
}
