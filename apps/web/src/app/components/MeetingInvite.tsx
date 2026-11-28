"use client";

import { useId, useState } from "react";
import { Check, Copy, Share, X } from "lucide-react";
import { useClipboardCopy } from "../hooks/useClipboardCopy";
import { meetingLinkFor } from "../lib/meeting-link";
import type {
  SoloInviteArrangement,
  SoloInviteForm,
} from "../lib/solo-invite-placement";

type InviteLifecycle = "awaiting-company" | "had-company" | "dismissed";

export type MeetingInvitePhase = "empty" | "emptied";

interface InviteRecord {
  roomId: string;
  lifecycle: InviteLifecycle;
}

const advanceInvite = (
  record: InviteRecord,
  roomId: string,
  hasCompany: boolean,
): InviteRecord => {
  const current = record.roomId === roomId
    ? record
    : { roomId, lifecycle: "awaiting-company" as const };
  return hasCompany && current.lifecycle === "awaiting-company"
    ? { roomId, lifecycle: "had-company" }
    : current;
};

export function useMeetingInvite(roomId: string, hasCompany: boolean) {
  const [record, setRecord] = useState<InviteRecord>(() =>
    advanceInvite({ roomId, lifecycle: "awaiting-company" }, roomId, hasCompany),
  );
  const next = advanceInvite(record, roomId, hasCompany);
  if (next !== record) setRecord(next);

  const phase: MeetingInvitePhase | null =
    hasCompany || next.lifecycle === "dismissed"
      ? null
      : next.lifecycle === "awaiting-company"
        ? "empty"
        : "emptied";
  const dismiss = () => setRecord({ roomId, lifecycle: "dismissed" });
  return { phase, dismiss };
}

export const inviteFormFor = (phase: MeetingInvitePhase): SoloInviteForm =>
  phase === "empty" ? "panel" : "notice";

const SHARE_TITLE = "Join my Conclave meeting";

const describeLink = (link: string) => {
  const url = new URL(link);
  return { host: url.host, path: decodeURIComponent(url.pathname) };
};

const canUseShareSheet = (isMobile: boolean) =>
  isMobile &&
  typeof navigator !== "undefined" &&
  typeof navigator.share === "function";

interface MeetingInviteProps {
  phase: MeetingInvitePhase;
  form: SoloInviteForm;
  arrangement: SoloInviteArrangement;
  roomId: string;
  clientId?: string;
  isMobile: boolean;
  onDismiss: () => void;
}

const focusRing =
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#fafafa]/40 focus-visible:ring-offset-2 focus-visible:ring-offset-[#0a0a0b]";

export default function MeetingInvite({
  phase,
  form,
  arrangement,
  roomId,
  clientId,
  isMobile,
  onDismiss,
}: MeetingInviteProps) {
  const titleId = useId();
  const link = meetingLinkFor(roomId, clientId);
  const { status, copy } = useClipboardCopy(link ?? "");
  const canShare = link !== null && canUseShareSheet(isMobile);

  const share = async () => {
    if (!link) return;
    try {
      await navigator.share({ title: SHARE_TITLE, url: link });
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") return;
      await copy();
    }
  };

  const announcement =
    status === "copied"
      ? "Meeting link copied"
      : status === "failed"
        ? "Couldn't copy the meeting link"
        : "";
  const title = phase === "emptied" ? "Everyone else left" : "No one else is here yet";
  const dismissButton = (size: "sm" | "md") => (
    <button
      type="button"
      onClick={onDismiss}
      aria-label="Dismiss invite"
      className={`inline-flex shrink-0 items-center justify-center rounded-lg text-[#fafafa]/60 transition-colors hover:bg-white/[0.06] hover:text-[#fafafa] ${focusRing} ${
        size === "sm" ? "h-8 w-8" : "-mt-1 h-9 w-9"
      }`}
    >
      <X size={size === "sm" ? 16 : 18} strokeWidth={1.8} />
    </button>
  );
  const statusRegion = (
    <span role="status" className="sr-only">
      {announcement}
    </span>
  );

  if (form === "notice") {
    return (
      <section
        aria-labelledby={titleId}
        className="flex h-full w-full items-center justify-center text-[#fafafa]"
        data-meeting-invite={phase}
      >
        <div className="inline-flex h-11 max-w-full items-center gap-1 rounded-xl border border-[#fafafa]/10 bg-[#18181b] pl-4 pr-1.5">
          <p id={titleId} className="mr-2 min-w-0 truncate text-[14px] font-medium">
            {title}
          </p>
          {link ? (
            <button
              type="button"
              onClick={() => void (canShare ? share() : copy())}
              className={`inline-flex h-8 shrink-0 items-center justify-center gap-1.5 rounded-lg bg-white/[0.06] px-2.5 text-[13px] font-medium transition-colors hover:bg-white/[0.1] ${focusRing} ${
                status === "failed" ? "text-[#fafafa]/70" : "text-[#fafafa]"
              }`}
            >
              {status === "copied" ? (
                <Check size={15} strokeWidth={2} />
              ) : canShare ? (
                <Share size={15} strokeWidth={1.8} />
              ) : (
                <Copy size={15} strokeWidth={1.8} />
              )}
              {status === "copied"
                ? "Copied"
                : status === "failed"
                  ? "Couldn't copy"
                  : canShare
                    ? "Share invite"
                    : "Copy link"}
            </button>
          ) : null}
          {dismissButton("sm")}
        </div>
        {statusRegion}
      </section>
    );
  }

  const shown = link ? describeLink(link) : null;
  const stacked = arrangement === "below";

  return (
    <section
      aria-labelledby={titleId}
      className={`flex h-full w-full flex-col text-[#fafafa] ${
        stacked ? "justify-start px-1 pt-1" : "justify-center pl-5"
      }`}
      data-meeting-invite={phase}
    >
      <div className="flex items-start justify-between gap-3">
        <h2
          id={titleId}
          className={`font-semibold leading-tight tracking-[-0.01em] ${
            stacked ? "pt-1 text-[17px]" : "text-[20px]"
          }`}
        >
          {title}
        </h2>
        {dismissButton("md")}
      </div>
      {shown ? (
        <>
          {stacked ? null : (
            <p className="mt-1.5 text-[14px] leading-snug text-[#fafafa]/70">
              Share this link to invite people.
            </p>
          )}
          <p
            className={`flex h-11 min-w-0 items-center rounded-lg border border-[#fafafa]/12 bg-[#18181b] px-3.5 text-[14px] ${
              stacked ? "mt-3" : "mt-4"
            }`}
            title={link ?? undefined}
          >
            <span className="min-w-0 truncate">
              <span className="text-[#fafafa]/56">{shown.host}/</span>
              {shown.path.replace(/^\//, "")}
            </span>
          </p>
          <div className="mt-3 flex items-center gap-2">
            {canShare ? (
              <>
                <button
                  type="button"
                  onClick={() => void share()}
                  className={`inline-flex h-11 min-w-0 flex-1 items-center justify-center gap-2 rounded-lg bg-[#F95F4A] px-4 text-[14px] font-medium text-white transition-[filter] hover:brightness-105 ${focusRing}`}
                >
                  <Share size={17} strokeWidth={1.8} />
                  Share invite
                </button>
                <button
                  type="button"
                  onClick={() => void copy()}
                  aria-label={status === "copied" ? "Meeting link copied" : "Copy meeting link"}
                  className={`inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-lg border border-[#fafafa]/12 bg-[#18181b] text-[#fafafa]/85 transition-colors hover:bg-white/[0.08] ${focusRing}`}
                >
                  {status === "copied" ? (
                    <Check size={17} strokeWidth={2} />
                  ) : (
                    <Copy size={17} strokeWidth={1.8} />
                  )}
                </button>
              </>
            ) : (
              <button
                type="button"
                onClick={() => void copy()}
                className={`inline-flex h-10 w-[8.75rem] items-center justify-center gap-2 rounded-lg text-[14px] font-medium transition-[filter,background-color] ${focusRing} ${
                  status === "failed"
                    ? "bg-white/[0.08] text-[#fafafa]"
                    : "bg-[#F95F4A] text-white hover:brightness-105"
                }`}
              >
                {status === "copied" ? (
                  <Check size={16} strokeWidth={2} />
                ) : status === "failed" ? null : (
                  <Copy size={16} strokeWidth={1.8} />
                )}
                {status === "copied"
                  ? "Copied"
                  : status === "failed"
                    ? "Couldn't copy"
                    : "Copy link"}
              </button>
            )}
          </div>
        </>
      ) : (
        <p className="mt-1.5 text-[14px] leading-snug text-[#fafafa]/70">
          This room has no shareable link.
        </p>
      )}
      {statusRegion}
    </section>
  );
}
