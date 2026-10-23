"use client";

import { useState } from "react";
import {
  CheckCircle2,
  AudioLines,
  Image as ImageIcon,
  MessageSquare,
  ChevronDown,
  ExternalLink,
  Loader2,
  X,
} from "lucide-react";
import {
  AI_RESPONSE_MODELS,
  AI_PROVIDERS,
} from "@conclave/ai/models";
import { ROOM_AI_PROVIDERS, type RoomAiProvider } from "@conclave/ai/room";
import type { RoomAiController } from "../hooks/useRoomAi";
import RoomAiFeatureSettings from "./RoomAiFeatureSettings";

const uses = {
  openai: [
    { Icon: ImageIcon, label: "Image safety" },
    { Icon: AudioLines, label: "Transcription" },
    { Icon: MessageSquare, label: "Assistant & games" },
  ],
  anthropic: [
    { Icon: MessageSquare, label: "Assistant, questions, minutes & games" },
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
  const [tab, setTab] = useState<"features" | "keys">("features");
  const [expanded, setExpanded] = useState<RoomAiProvider | null>(null);
  const [apiKey, setApiKey] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<{
    provider?: RoomAiProvider;
    message: string;
  } | null>(null);
  const [notice, setNotice] = useState<{
    provider: RoomAiProvider;
    message: string;
  } | null>(null);
  const save = async (provider: RoomAiProvider, remove: boolean) => {
    setPending(true);
    setError(null);
    setNotice(null);
    let initialModel: string | null | undefined;
    if (
      !remove &&
      provider !== "sarvam" &&
      !controller.state.assistantModel &&
      controller.requestModels
    ) {
      try {
        const catalogs = await controller.requestModels({
          provider,
          apiKey: apiKey.trim(),
        });
        const discovered = catalogs.find(
          (entry) => entry.provider === provider,
        );
        if (discovered?.source === "live") {
          if (!discovered.models.length) {
            // Audio and image-only keys can still be shared without selecting text.
            initialModel = null;
          } else {
            const preferred = AI_RESPONSE_MODELS.find(
              (entry) => entry.provider === provider,
            )?.id;
            initialModel = (
              discovered.models.find((entry) => entry.id === preferred) ??
              discovered.models[0]
            ).id;
          }
        }
      } catch {
        /* Listing permissions do not determine inference permissions. */
      }
    }
    const failure = await controller.configure(
      provider,
      remove ? null : apiKey.trim(),
      ...(initialModel !== undefined ? [initialModel] : []),
    );
    setPending(false);
    if (failure) {
      setError({ provider, message: failure });
      return;
    }
    setApiKey("");
    setExpanded(null);
    setNotice({
      provider,
      message: `Key ${remove ? "removed" : "shared with room"}`,
    });
  };
  return (
    <section
      aria-label="Room AI settings"
      className="max-h-[65vh] shrink-0 overflow-y-auto border-b border-white/10 bg-[#1e1e21] px-4 py-4"
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
      <div className="mt-3 flex items-center gap-1 rounded-lg bg-black/20 p-1" role="tablist" aria-label="AI settings sections">
        {(["features", "keys"] as const).map(value => <button key={value} type="button" role="tab" aria-selected={tab === value} onClick={() => setTab(value)} className={`flex-1 rounded-md py-1.5 text-[12px] font-medium transition-colors ${tab === value ? "bg-white/10 text-white" : "text-[#a1a1aa] hover:text-white"}`}>{value === "features" ? "Features" : "Keys"}</button>)}
      </div>
      <div className="mt-3 flex flex-wrap gap-2" aria-label="Connected providers">
        {ROOM_AI_PROVIDERS.map(provider => <button key={provider} type="button" onClick={() => {setTab("keys");setExpanded(provider);setApiKey("");}} title={`${AI_PROVIDERS[provider].label}: ${!controller.ready ? "Loading" : controller.state[provider].source === "room" ? "Room key" : controller.state[provider].source === "deployment" ? "Conclave key" : "Not set"}`} className="inline-flex items-center gap-1.5 rounded-md bg-white/[0.04] px-2 py-1 text-[10.5px] text-[#a1a1aa]"><span className={`h-1.5 w-1.5 rounded-full ${controller.state[provider].source ? "bg-[#91cbb0]" : "bg-[#71717a]"}`} />{AI_PROVIDERS[provider].label}</button>)}
      </div>
      {tab === "features" ? <div className="mt-2"><RoomAiFeatureSettings controller={controller} /></div> : (
      <div className="mt-4 divide-y divide-white/10">
        {ROOM_AI_PROVIDERS.map((provider) => {
          const status = controller.state[provider];
          const canEdit =
            status.source !== "deployment" &&
            (status.source !== "room" ||
              controller.isAdmin ||
              status.ownerId === controller.currentUserId);
          const open = expanded === provider;
          return (
            <div
              key={provider}
              role="group"
              aria-label={`${AI_PROVIDERS[provider].label} settings`}
              className="py-3 first:pt-0 last:pb-0"
            >
              <div className="flex items-center gap-3">
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
                  className="flex min-w-0 flex-1 items-center gap-2 rounded-md text-left outline-none focus-visible:ring-2 focus-visible:ring-[#F95F4A]/60 disabled:cursor-default"
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
                  {canEdit ? (
                    <span className="flex shrink-0 items-center gap-1 text-[11px] text-[#d4d4d8]">
                      {status.source === "room" ? "Manage" : "Add key"}
                      <ChevronDown
                        size={13}
                        className={open ? "rotate-180" : ""}
                      />
                    </span>
                  ) : status.source ? (
                    <CheckCircle2
                      size={15}
                      className="shrink-0 text-[#91cbb0]"
                    />
                  ) : null}
                </button>
                <span className="flex shrink-0 gap-2 text-[#71717a]">
                  {uses[provider].map(({ Icon, label }) => (
                    <span
                      key={label}
                      tabIndex={0}
                      role="img"
                      aria-label={label}
                      className="group/feature relative rounded-sm outline-none hover:text-[#d4d4d8] focus-visible:text-[#d4d4d8] focus-visible:ring-2 focus-visible:ring-[#F95F4A]/60"
                    >
                      <Icon size={14} aria-hidden="true" />
                      <span
                        role="tooltip"
                        className="pointer-events-none absolute right-0 top-full z-10 mt-2 w-max max-w-52 rounded-md border border-white/10 bg-[#101012] px-2 py-1.5 text-[10px] leading-relaxed text-[#fafafa] opacity-0 shadow-lg transition-opacity group-hover/feature:opacity-100 group-focus-visible/feature:opacity-100"
                      >
                        {label}
                      </span>
                    </span>
                  ))}
                </span>
              </div>
              {notice?.provider === provider ? (
                <p role="status" className="mt-2 text-[11px] text-[#91cbb0]">
                  {notice.message}
                </p>
              ) : null}
              {error?.provider === provider ? (
                <p role="alert" className="mt-2 text-[11px] text-red-300">
                  {error.message}
                </p>
              ) : null}
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
      )}
    </section>
  );
}
