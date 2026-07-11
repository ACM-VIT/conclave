"use client";

import {
  Check,
  Copy,
  Globe,
  Image as ImageIcon,
  Link2,
  Lock,
  MessageSquare,
  MessageSquareLock,
  RotateCw,
  ShieldBan,
  Smile,
  Users,
  Volume2,
  X,
  type LucideIcon,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { color } from "@conclave/ui-tokens";
import type {
  MeetingConfigSnapshot,
  MeetingUpdateRequest,
  WebinarConfigSnapshot,
  WebinarLinkResponse,
  WebinarUpdateRequest,
} from "../lib/types";

const DEFAULT_WEBINAR_CAP = 500;
const MIN_WEBINAR_CAP = 1;
const MAX_WEBINAR_CAP = 5000;
const WEBINAR_LINK_CODE_PATTERN = /^[a-z0-9-]{3,32}$/;
const normalizeWebinarLinkCodeInput = (value: string): string =>
  value.toLowerCase().replace(/[^a-z0-9-]+/g, "").slice(0, 32);

const SANS = '"PolySans Trial", system-ui, -apple-system, sans-serif';

const ICON_SIZE = 18;
const ICON_STROKE = 1.75;

const ICON_OFF = "rgba(250,250,250,0.55)";
const SECTION_LABEL = "rgba(250,250,250,0.38)";
const TONE_ACCENT: Record<ToggleTone, string> = {
  success: color.success,
  warning: color.warning,
  accent: color.accent,
};

const inputClass =
  "w-full rounded-[10px] border border-white/[0.14] bg-[#131316] px-3 py-2.5 text-[14px] text-[#fafafa] outline-none transition-colors duration-[120ms] placeholder:text-[rgba(250,250,250,0.35)] focus:border-[rgba(250,250,250,0.28)]";

interface MeetSettingsPanelProps {
  isRoomLocked: boolean;
  onToggleLock?: () => void;
  isNoGuests: boolean;
  onToggleNoGuests?: () => void;
  isChatLocked: boolean;
  onToggleChatLock?: () => void;
  isTtsDisabled: boolean;
  onToggleTtsDisabled?: () => void;
  isDmEnabled: boolean;
  onToggleDmEnabled?: () => void;
  areImageAttachmentsEnabled: boolean;
  onToggleImageAttachments?: () => void;
  isReactionsDisabled: boolean;
  onToggleReactionsDisabled?: () => void;
  meetingRequiresInviteCode: boolean;
  onGetMeetingConfig?: () => Promise<MeetingConfigSnapshot | null>;
  onUpdateMeetingConfig?: (
    update: MeetingUpdateRequest,
  ) => Promise<MeetingConfigSnapshot | null>;
  webinarConfig?: WebinarConfigSnapshot | null;
  webinarRole?: "attendee" | "participant" | "host" | null;
  webinarLink?: string | null;
  onSetWebinarLink?: (link: string | null) => void;
  onGetWebinarConfig?: () => Promise<WebinarConfigSnapshot | null>;
  onUpdateWebinarConfig?: (
    update: WebinarUpdateRequest,
  ) => Promise<WebinarConfigSnapshot | null>;
  onGenerateWebinarLink?: () => Promise<WebinarLinkResponse | null>;
  onRotateWebinarLink?: () => Promise<WebinarLinkResponse | null>;
  onClose: () => void;
}

type ToggleTone = "warning" | "success" | "accent";

const parseAttendeeCap = (value: string): number | null => {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return null;
  return Math.max(MIN_WEBINAR_CAP, Math.min(MAX_WEBINAR_CAP, parsed));
};

const copyToClipboard = async (value: string): Promise<boolean> => {
  if (!value.trim()) return false;
  if (
    typeof navigator !== "undefined" &&
    navigator.clipboard &&
    typeof navigator.clipboard.writeText === "function"
  ) {
    try {
      await navigator.clipboard.writeText(value);
      return true;
    } catch {
      return false;
    }
  }
  return false;
};

// Keep panel-only keyframes and scrollbar styles out of globals.css.
const PANEL_STYLES = `
@keyframes hostpanel-spin { to { transform: rotate(360deg); } }
@keyframes hostpanel-pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.55; }
}
.hostpanel-scroll { scrollbar-width: thin; scrollbar-color: rgba(250,250,250,0.18) transparent; }
.hostpanel-scroll::-webkit-scrollbar { width: 4px; height: 0; }
.hostpanel-scroll::-webkit-scrollbar-track { background: transparent; }
.hostpanel-scroll::-webkit-scrollbar-thumb { background: rgba(250,250,250,0.18); border-radius: 2px; }
.hostpanel-skeleton {
  background: rgba(250,250,250,0.08);
  animation: hostpanel-pulse 1200ms ease-in-out infinite;
}
@media (prefers-reduced-motion: reduce) {
  .hostpanel-spin, .hostpanel-skeleton { animation: none; }
}
`;

function Spinner({ size = 14 }: { size?: number }) {
  return (
    <span
      aria-hidden
      className="hostpanel-spin inline-block shrink-0 rounded-full"
      style={{
        width: size,
        height: size,
        border: "1.75px solid rgba(250,250,250,0.25)",
        borderTopColor: "#fafafa",
        animation: "hostpanel-spin 600ms linear infinite",
      }}
    />
  );
}

function SectionHeader({
  label,
  accessory,
  first = false,
}: {
  label: string;
  accessory?: ReactNode;
  first?: boolean;
}) {
  return (
    <div
      className={`flex items-center justify-between px-4 pb-1.5 ${first ? "pt-3" : "pt-2"}`}
    >
      <span
        className="text-[11px] font-medium uppercase"
        style={{ letterSpacing: "0.06em", color: SECTION_LABEL }}
      >
        {label}
      </span>
      {accessory}
    </div>
  );
}

function Separator() {
  return <div className="h-px w-full" style={{ backgroundColor: color.border }} />;
}

function ToggleSwitch({ isOn, tone }: { isOn: boolean; tone: ToggleTone }) {
  return (
    <span
      aria-hidden
      className="relative inline-flex h-[22px] w-[38px] shrink-0 items-center rounded-full transition-colors duration-[120ms]"
      style={{ backgroundColor: isOn ? TONE_ACCENT[tone] : "rgba(250,250,250,0.14)" }}
    >
      <span
        className="absolute h-[16px] w-[16px] rounded-full bg-white transition-transform duration-[120ms]"
        style={{ transform: isOn ? "translateX(19px)" : "translateX(3px)" }}
      />
    </span>
  );
}

function SwitchRow({
  icon: Icon,
  label,
  isOn,
  tone,
  onClick,
  disabled = false,
}: {
  icon: LucideIcon;
  label: string;
  isOn: boolean;
  tone: ToggleTone;
  onClick?: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-pressed={isOn}
      className="flex min-h-[44px] w-full items-center gap-3 px-4 py-2 text-left transition-colors duration-[120ms] hover:bg-[rgba(250,250,250,0.04)] active:bg-[rgba(250,250,250,0.07)] disabled:cursor-not-allowed"
    >
      <Icon
        size={ICON_SIZE}
        strokeWidth={ICON_STROKE}
        className="shrink-0"
        style={{ color: isOn ? TONE_ACCENT[tone] : ICON_OFF }}
      />
      <span className="min-w-0 flex-1 truncate text-[14px] font-normal text-[#fafafa]">
        {label}
      </span>
      <ToggleSwitch isOn={isOn} tone={tone} />
    </button>
  );
}

function LockedRow({
  icon: Icon,
  label,
}: {
  icon: LucideIcon;
  label: string;
}) {
  return (
    <div className="flex min-h-[44px] w-full items-center gap-3 px-4 py-2 text-left">
      <Icon
        size={ICON_SIZE}
        strokeWidth={ICON_STROKE}
        className="shrink-0"
        style={{ color: ICON_OFF }}
      />
      <span className="min-w-0 flex-1 truncate text-[14px] font-normal text-[#fafafa]">
        {label}
      </span>
      <Lock size={14} strokeWidth={ICON_STROKE} style={{ color: "rgba(250,250,250,0.28)" }} />
    </div>
  );
}

function StatusPill({
  label,
  tone,
}: {
  label: string;
  tone: "success" | "warning" | "off";
}) {
  const styles =
    tone === "success"
      ? {
          color: color.success,
          borderColor: "rgba(34,197,94,0.35)",
          backgroundColor: "rgba(34,197,94,0.10)",
        }
      : tone === "warning"
        ? {
            color: color.warning,
            borderColor: "rgba(251,191,36,0.35)",
            backgroundColor: "rgba(251,191,36,0.10)",
          }
        : {
            color: "rgba(250,250,250,0.5)",
            borderColor: "rgba(250,250,250,0.12)",
            backgroundColor: "transparent",
          };
  return (
    <span
      className="rounded-full border px-2 py-0.5 text-[11.5px] font-medium"
      style={styles}
    >
      {label}
    </span>
  );
}

function TextButton({
  children,
  onClick,
  disabled,
  tone = "faint",
}: {
  children: ReactNode;
  onClick?: () => void;
  disabled?: boolean;
  tone?: "faint" | "danger";
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="inline-flex items-center rounded-md px-1.5 py-1 text-[13px] font-normal transition-colors duration-[120ms] hover:bg-[rgba(250,250,250,0.05)] disabled:cursor-not-allowed disabled:opacity-40"
      style={{ color: tone === "danger" ? color.danger : "rgba(250,250,250,0.55)" }}
    >
      {children}
    </button>
  );
}

function ActionBtn({
  children,
  onClick,
  disabled,
  variant = "secondary",
  working = false,
  className = "",
}: {
  children: ReactNode;
  onClick?: () => void;
  disabled?: boolean;
  variant?: "secondary" | "primary";
  working?: boolean;
  className?: string;
}) {
  const base =
    "inline-flex h-8 items-center justify-center gap-1.5 rounded-lg px-3 py-1.5 text-[13px] font-medium transition-[background-color,border-color] duration-[120ms] disabled:cursor-not-allowed disabled:opacity-40";
  if (variant === "primary") {
    return (
      <button
        type="button"
        onClick={onClick}
        disabled={disabled}
        className={`${base} bg-[#F95F4A] text-white hover:bg-[#e8553f] active:bg-[#d34933] ${className}`}
      >
        {working ? <Spinner /> : children}
      </button>
    );
  }
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={`${base} border border-[rgba(250,250,250,0.14)] text-white/85 hover:border-[rgba(250,250,250,0.25)] hover:bg-[rgba(250,250,250,0.05)] ${className}`}
    >
      {working ? <Spinner /> : children}
    </button>
  );
}

function InviteCodeForm({
  label,
  value,
  onChange,
  onSave,
  onRemove,
  hasCode,
  working,
  saveDisabled,
  removeDisabled,
  placeholder,
  pillTone,
  pillLabel,
  roleBadge,
  loading = false,
}: {
  label: string;
  value: string;
  onChange: (next: string) => void;
  onSave: () => void;
  onRemove: () => void;
  hasCode: boolean;
  working: boolean;
  saveDisabled: boolean;
  removeDisabled: boolean;
  placeholder: string;
  pillTone: "warning" | "off";
  pillLabel: string;
  roleBadge?: ReactNode;
  loading?: boolean;
}) {
  const [confirming, setConfirming] = useState(false);

  return (
    <div className="px-4 pb-3 pt-1">
      <div className="mb-2 flex items-center justify-between">
        <span className="text-[14px] text-[#fafafa]">{label}</span>
        <div className="flex items-center gap-2">
          {roleBadge}
          <StatusPill label={pillLabel} tone={pillTone} />
        </div>
      </div>

      {loading ? (
        <div className="space-y-2 py-1">
          <div className="hostpanel-skeleton h-3 w-3/5 rounded" />
          <div className="hostpanel-skeleton h-2.5 w-2/5 rounded" />
        </div>
      ) : (
        <>
          <input
            type="text"
            value={value}
            onChange={(event) => onChange(event.target.value)}
            className={inputClass}
            placeholder={placeholder}
          />
          <div className="mt-2 flex items-center gap-2">
            <ActionBtn
              variant="primary"
              working={working}
              disabled={saveDisabled}
              onClick={onSave}
              className="min-w-[72px]"
            >
              Save
            </ActionBtn>
            {confirming ? (
              <span className="flex items-center gap-1 text-[13px] text-white/55">
                Confirm remove?
                <TextButton
                  tone="danger"
                  disabled={removeDisabled}
                  onClick={() => {
                    setConfirming(false);
                    onRemove();
                  }}
                >
                  Yes
                </TextButton>
                <TextButton onClick={() => setConfirming(false)}>Cancel</TextButton>
              </span>
            ) : hasCode ? (
              <TextButton disabled={removeDisabled} onClick={() => setConfirming(true)}>
                Remove
              </TextButton>
            ) : null}
          </div>
        </>
      )}
    </div>
  );
}

export default function MeetSettingsPanel({
  isRoomLocked,
  onToggleLock,
  isNoGuests,
  onToggleNoGuests,
  isChatLocked,
  onToggleChatLock,
  isTtsDisabled,
  onToggleTtsDisabled,
  isDmEnabled,
  onToggleDmEnabled,
  areImageAttachmentsEnabled,
  onToggleImageAttachments,
  isReactionsDisabled,
  onToggleReactionsDisabled,
  meetingRequiresInviteCode,
  onGetMeetingConfig,
  onUpdateMeetingConfig,
  webinarConfig,
  webinarRole,
  webinarLink,
  onSetWebinarLink,
  onGetWebinarConfig,
  onUpdateWebinarConfig,
  onGenerateWebinarLink,
  onRotateWebinarLink,
  onClose,
}: MeetSettingsPanelProps) {
  const [meetingInviteCodeInput, setMeetingInviteCodeInput] = useState("");
  const [isMeetingWorking, setIsMeetingWorking] = useState(false);
  const [isMeetingLoading, setIsMeetingLoading] = useState(Boolean(onGetMeetingConfig));
  const [inviteCodeInput, setInviteCodeInput] = useState("");
  const [maxAttendeesInput, setMaxAttendeesInput] = useState(
    String(webinarConfig?.maxAttendees ?? DEFAULT_WEBINAR_CAP),
  );
  const [editingCap, setEditingCap] = useState(false);
  const [customLinkCodeInput, setCustomLinkCodeInput] = useState("");
  const [isWebinarWorking, setIsWebinarWorking] = useState(false);
  const [linkCopied, setLinkCopied] = useState(false);
  const [rotateConfirming, setRotateConfirming] = useState(false);
  const linkCopiedTimerRef = useRef<number | null>(null);

  useEffect(() => {
    setMaxAttendeesInput(String(webinarConfig?.maxAttendees ?? DEFAULT_WEBINAR_CAP));
  }, [webinarConfig?.maxAttendees]);

  useEffect(() => {
    setCustomLinkCodeInput(webinarConfig?.linkSlug ?? "");
  }, [webinarConfig?.linkSlug]);

  const refreshWebinarConfig = useCallback(async () => {
    if (!onGetWebinarConfig) return;
    await onGetWebinarConfig();
  }, [onGetWebinarConfig]);

  const refreshMeetingConfig = useCallback(async () => {
    if (!onGetMeetingConfig) {
      setIsMeetingLoading(false);
      return;
    }
    setIsMeetingLoading(true);
    try {
      await onGetMeetingConfig();
    } finally {
      setIsMeetingLoading(false);
    }
  }, [onGetMeetingConfig]);

  useEffect(() => {
    void refreshWebinarConfig();
  }, [refreshWebinarConfig]);

  useEffect(() => {
    void refreshMeetingConfig();
  }, [refreshMeetingConfig]);

  useEffect(() => {
    return () => {
      if (linkCopiedTimerRef.current !== null) {
        window.clearTimeout(linkCopiedTimerRef.current);
        linkCopiedTimerRef.current = null;
      }
    };
  }, []);

  const showLinkCopied = useCallback(() => {
    setLinkCopied(true);
    if (linkCopiedTimerRef.current !== null) {
      window.clearTimeout(linkCopiedTimerRef.current);
    }
    linkCopiedTimerRef.current = window.setTimeout(() => {
      setLinkCopied(false);
      linkCopiedTimerRef.current = null;
    }, 1600);
  }, []);

  const withMeetingTask = useCallback(
    async (task: () => Promise<void>, options?: { clearInviteInput?: boolean }) => {
      setIsMeetingWorking(true);
      try {
        await task();
        if (options?.clearInviteInput) {
          setMeetingInviteCodeInput("");
        }
      } catch (error) {
        console.error("Meeting action failed:", error);
      } finally {
        setIsMeetingWorking(false);
      }
    },
    [],
  );

  const withWebinarTask = useCallback(
    async (task: () => Promise<void>, options?: { clearInviteInput?: boolean }) => {
      setIsWebinarWorking(true);
      try {
        await task();
        if (options?.clearInviteInput) {
          setInviteCodeInput("");
        }
      } catch (error) {
        console.error("Webinar action failed:", error);
      } finally {
        setIsWebinarWorking(false);
      }
    },
    [],
  );

  const updateMeetingConfig = useCallback(
    async (update: MeetingUpdateRequest) => {
      if (!onUpdateMeetingConfig) {
        throw new Error("Meeting invite code controls are unavailable.");
      }
      const next = await onUpdateMeetingConfig(update);
      if (!next) {
        throw new Error("Meeting invite code update was rejected.");
      }
    },
    [onUpdateMeetingConfig],
  );

  const updateWebinarConfig = useCallback(
    async (update: WebinarUpdateRequest) => {
      if (!onUpdateWebinarConfig) {
        throw new Error("Webinar controls are unavailable.");
      }
      const next = await onUpdateWebinarConfig(update);
      if (!next) {
        throw new Error("Webinar update was rejected.");
      }
    },
    [onUpdateWebinarConfig],
  );

  const applyWebinarLink = useCallback(
    async (response: WebinarLinkResponse | null) => {
      if (!response?.link || !response.slug) {
        throw new Error("Webinar link unavailable.");
      }
      onSetWebinarLink?.(response.link);
      setCustomLinkCodeInput(response.slug);
      await copyToClipboard(response.link);
    },
    [onSetWebinarLink],
  );

  const currentLink = webinarLink?.trim() || "";
  const attendeeCapCandidate = parseAttendeeCap(maxAttendeesInput);
  const attendeeCount = webinarConfig?.attendeeCount ?? 0;
  const attendeeCap = webinarConfig?.maxAttendees ?? DEFAULT_WEBINAR_CAP;
  const isWebinarEnabled = Boolean(webinarConfig?.enabled);
  const hasWebinar = webinarConfig != null;
  const normalizedCustomLinkCode = customLinkCodeInput.trim().toLowerCase();
  const isCustomLinkCodeValid =
    normalizedCustomLinkCode.length === 0 ||
    WEBINAR_LINK_CODE_PATTERN.test(normalizedCustomLinkCode);

  // Room access summary line for the section header context.
  const accessSummary = isRoomLocked
    ? "Locked"
    : isNoGuests
      ? "Signed-in only"
      : "Open to all";
  const accessTone: "success" | "warning" | "off" = isRoomLocked
    ? "warning"
    : isNoGuests
      ? "warning"
      : "off";

  return (
    <>
      <style>{PANEL_STYLES}</style>
      {/* Right-docked, content-shrinking side panel — the same sibling pattern
          as Chat / Participants (fixed rail, the stage reserves room for it via
          MeetsMainContent's paddingRight). Flat surface, 1px left border, no
          floating popover, no shadow-glow. */}
      <div
        className="safe-area-pt safe-area-pb fixed right-0 top-0 bottom-0 z-40 flex w-full sm:w-[360px] flex-col overflow-hidden border-l border-white/10 bg-[#18181b] animate-[meet-panel-in_280ms_cubic-bezier(0.22,1,0.36,1)]"
        style={{ fontFamily: SANS }}
      >
        <div className="flex shrink-0 items-center justify-between border-b border-white/10 px-4 py-3">
          <h2 className="text-[15px] font-semibold text-[#fafafa]">Host controls</h2>
          <button
            type="button"
            onClick={onClose}
            className="inline-flex h-8 w-8 items-center justify-center rounded-lg text-[#a1a1aa] transition-colors duration-[120ms] hover:bg-white/[0.06] hover:text-[#fafafa]"
            aria-label="Close host controls"
          >
            <X size={18} strokeWidth={ICON_STROKE} />
          </button>
        </div>

        <div className="hostpanel-scroll min-h-0 flex-1 overflow-y-auto overflow-x-hidden pb-2">
          <SectionHeader
            label="Room access"
            first
            accessory={<StatusPill label={accessSummary} tone={accessTone} />}
          />
          <SwitchRow
            icon={Lock}
            label="Lock meeting"
            isOn={isRoomLocked}
            tone="warning"
            onClick={onToggleLock}
            disabled={!onToggleLock}
          />
          <SwitchRow
            icon={ShieldBan}
            label="Block guests"
            isOn={isNoGuests}
            tone="warning"
            onClick={onToggleNoGuests}
            disabled={!onToggleNoGuests}
          />

          <Separator />

          <SectionHeader label="Chat & messaging" />
          <SwitchRow
            icon={MessageSquareLock}
            label="Allow chat"
            isOn={!isChatLocked}
            tone="success"
            onClick={onToggleChatLock}
            disabled={!onToggleChatLock}
          />
          <SwitchRow
            icon={MessageSquare}
            label="Direct messages"
            isOn={isDmEnabled}
            tone="success"
            onClick={onToggleDmEnabled}
            disabled={!onToggleDmEnabled}
          />
          <SwitchRow
            icon={ImageIcon}
            label="Image attachments"
            isOn={areImageAttachmentsEnabled}
            tone="success"
            onClick={onToggleImageAttachments}
            disabled={!onToggleImageAttachments}
          />
          <SwitchRow
            icon={Volume2}
            label="Read messages aloud"
            isOn={!isTtsDisabled}
            tone="success"
            onClick={onToggleTtsDisabled}
            disabled={!onToggleTtsDisabled}
          />
          <SwitchRow
            icon={Smile}
            label="Reactions"
            isOn={!isReactionsDisabled}
            tone="success"
            onClick={onToggleReactionsDisabled}
            disabled={!onToggleReactionsDisabled}
          />

          <Separator />

          <SectionHeader label="Meeting invite code" />
          <InviteCodeForm
            label="Invite code"
            value={meetingInviteCodeInput}
            onChange={setMeetingInviteCodeInput}
            placeholder="Set a meeting invite code"
            hasCode={meetingRequiresInviteCode}
            working={isMeetingWorking}
            loading={isMeetingLoading}
            saveDisabled={isMeetingWorking || !meetingInviteCodeInput.trim()}
            removeDisabled={isMeetingWorking || !meetingRequiresInviteCode}
            pillTone={meetingRequiresInviteCode ? "warning" : "off"}
            pillLabel={meetingRequiresInviteCode ? "Protected" : "Open"}
            onSave={() =>
              void withMeetingTask(
                async () => {
                  await updateMeetingConfig({
                    inviteCode: meetingInviteCodeInput.trim(),
                  });
                },
                { clearInviteInput: true },
              )
            }
            onRemove={() =>
              void withMeetingTask(async () => {
                await updateMeetingConfig({ inviteCode: null });
              })
            }
          />

          {hasWebinar ? (
            <>
              <Separator />
              <SectionHeader
                label="Webinar"
                accessory={
                  <StatusPill
                    label={isWebinarEnabled ? "Active" : "Off"}
                    tone={isWebinarEnabled ? "success" : "off"}
                  />
                }
              />
              <SwitchRow
                icon={Users}
                label="Webinar mode"
                isOn={isWebinarEnabled}
                tone="success"
                onClick={() =>
                  void withWebinarTask(async () => {
                    await updateWebinarConfig({
                      enabled: !Boolean(webinarConfig?.enabled),
                    });
                  })
                }
                disabled={isWebinarWorking}
              />

              {/* Subordinate rows: a single dimmed region when disabled, so the
                  dependency boundary reads as one unit. */}
              {isWebinarEnabled ? (
                <div>
                  <SwitchRow
                    icon={Globe}
                    label="Public access"
                    isOn={Boolean(webinarConfig?.publicAccess)}
                    tone="success"
                    onClick={() =>
                      void withWebinarTask(async () => {
                        await updateWebinarConfig({
                          publicAccess: !Boolean(webinarConfig?.publicAccess),
                        });
                      })
                    }
                    disabled={isWebinarWorking}
                  />
                  <SwitchRow
                    icon={Lock}
                    label="Lock attendees"
                    isOn={Boolean(webinarConfig?.locked)}
                    tone="warning"
                    onClick={() =>
                      void withWebinarTask(async () => {
                        await updateWebinarConfig({
                          locked: !Boolean(webinarConfig?.locked),
                        });
                      })
                    }
                    disabled={isWebinarWorking}
                  />

                  {/* Capacity row — counter badge flips to an inline editor. */}
                  <div className="flex min-h-[44px] w-full items-center gap-3 px-4 py-2">
                    <Users
                      size={ICON_SIZE}
                      strokeWidth={ICON_STROKE}
                      className="shrink-0"
                      style={{ color: ICON_OFF }}
                    />
                    <span className="min-w-0 flex-1 truncate text-[14px] text-[#fafafa]">
                      Max attendees
                    </span>
                    {editingCap ? (
                      <span className="flex items-center gap-1.5">
                        <input
                          type="number"
                          min={MIN_WEBINAR_CAP}
                          max={MAX_WEBINAR_CAP}
                          autoFocus
                          value={maxAttendeesInput}
                          onChange={(event) => setMaxAttendeesInput(event.target.value)}
                          className="w-[72px] rounded-[10px] border border-white/[0.14] bg-[#131316] px-2 py-1 text-right text-[13px] text-[#fafafa] outline-none transition-colors duration-[120ms] focus:border-[rgba(250,250,250,0.28)]"
                        />
                        <ActionBtn
                          variant="primary"
                          working={isWebinarWorking}
                          disabled={isWebinarWorking || attendeeCapCandidate == null}
                          onClick={() =>
                            void withWebinarTask(async () => {
                              if (attendeeCapCandidate == null) {
                                throw new Error("Enter a valid attendee cap.");
                              }
                              await updateWebinarConfig({
                                maxAttendees: attendeeCapCandidate,
                              });
                              setEditingCap(false);
                            })
                          }
                        >
                          Save
                        </ActionBtn>
                      </span>
                    ) : (
                      <button
                        type="button"
                        onClick={() => setEditingCap(true)}
                        className="rounded-md px-1.5 py-1 text-[13px] tabular-nums transition-colors duration-[120ms] hover:bg-[rgba(250,250,250,0.05)]"
                      >
                        <span className="text-[#fafafa]">{attendeeCount}</span>
                        <span className="text-white/40"> / </span>
                        <span className="text-[#fafafa]">{attendeeCap}</span>
                      </button>
                    )}
                  </div>

                  <Separator />

                  {/* Attendee invite code */}
                  <InviteCodeForm
                    label="Attendee code"
                    value={inviteCodeInput}
                    onChange={setInviteCodeInput}
                    placeholder="Set an attendee invite code"
                    hasCode={Boolean(webinarConfig?.requiresInviteCode)}
                    working={isWebinarWorking}
                    saveDisabled={isWebinarWorking || !inviteCodeInput.trim()}
                    removeDisabled={
                      isWebinarWorking || !webinarConfig?.requiresInviteCode
                    }
                    pillTone={
                      webinarConfig?.requiresInviteCode ? "warning" : "off"
                    }
                    pillLabel={
                      webinarConfig?.requiresInviteCode ? "Protected" : "Open"
                    }
                    roleBadge={
                      webinarRole ? (
                        <span className="rounded-full border border-white/12 px-2 py-0.5 text-[11.5px] capitalize text-white/55">
                          {webinarRole}
                        </span>
                      ) : null
                    }
                    onSave={() =>
                      void withWebinarTask(
                        async () => {
                          await updateWebinarConfig({
                            inviteCode: inviteCodeInput.trim(),
                          });
                        },
                        { clearInviteInput: true },
                      )
                    }
                    onRemove={() =>
                      void withWebinarTask(async () => {
                        await updateWebinarConfig({ inviteCode: null });
                      })
                    }
                  />

                  <Separator />

                  {/* Webinar link */}
                  <div className="px-4 pb-3 pt-1">
                    <div className="mb-2 flex items-center justify-between">
                      <span className="text-[14px] text-[#fafafa]">Webinar link</span>
                    </div>

                    {currentLink ? (
                      <>
                        <div className="mb-2 flex items-center gap-2 rounded-[10px] border border-white/[0.14] bg-[#131316] px-3 py-2.5">
                          <Link2
                            size={ICON_SIZE}
                            strokeWidth={ICON_STROKE}
                            className="shrink-0 text-[rgba(250,250,250,0.56)]"
                          />
                          <span className="min-w-0 flex-1 truncate text-[14px] text-[rgba(250,250,250,0.56)]">
                            {currentLink}
                          </span>
                        </div>

                        {/* Custom slug editor (kept; validated inline). */}
                        <input
                          type="text"
                          value={customLinkCodeInput}
                          onChange={(event) =>
                            setCustomLinkCodeInput(
                              normalizeWebinarLinkCodeInput(event.target.value),
                            )
                          }
                          className={inputClass}
                          placeholder="custom-slug"
                          style={
                            isCustomLinkCodeValid
                              ? undefined
                              : { borderColor: color.danger }
                          }
                        />
                        {!isCustomLinkCodeValid ? (
                          <p
                            className="mt-1 text-[11.5px]"
                            style={{ color: color.danger }}
                          >
                            Use 3-32 lowercase letters, numbers or hyphens.
                          </p>
                        ) : null}

                        <div className="mt-2 flex items-center gap-2">
                          <ActionBtn
                            variant="secondary"
                            working={isWebinarWorking}
                            disabled={isWebinarWorking || !isCustomLinkCodeValid}
                            onClick={() =>
                              void withWebinarTask(async () => {
                                if (!onGenerateWebinarLink) {
                                  throw new Error("Link generation is unavailable.");
                                }
                                if (normalizedCustomLinkCode) {
                                  await updateWebinarConfig({
                                    linkSlug: normalizedCustomLinkCode,
                                  });
                                }
                                const response = await onGenerateWebinarLink();
                                await applyWebinarLink(response);
                              })
                            }
                          >
                            <Link2 size={15} strokeWidth={ICON_STROKE} />
                            Generate
                          </ActionBtn>

                          {rotateConfirming ? (
                            <span className="flex items-center gap-1 text-[13px] text-white/55">
                              Rotate?
                              <ActionBtn
                                variant="primary"
                                working={isWebinarWorking}
                                disabled={isWebinarWorking}
                                onClick={() =>
                                  void withWebinarTask(async () => {
                                    if (!onRotateWebinarLink) {
                                      throw new Error("Link rotation is unavailable.");
                                    }
                                    const response = await onRotateWebinarLink();
                                    await applyWebinarLink(response);
                                    setRotateConfirming(false);
                                  })
                                }
                              >
                                Confirm
                              </ActionBtn>
                              <TextButton onClick={() => setRotateConfirming(false)}>
                                Cancel
                              </TextButton>
                            </span>
                          ) : (
                            <ActionBtn
                              variant="secondary"
                              disabled={isWebinarWorking}
                              onClick={() => setRotateConfirming(true)}
                            >
                              <RotateCw size={15} strokeWidth={ICON_STROKE} />
                              Rotate
                            </ActionBtn>
                          )}

                          <ActionBtn
                            variant="secondary"
                            disabled={isWebinarWorking || !currentLink}
                            onClick={() =>
                              void withWebinarTask(async () => {
                                const copied = await copyToClipboard(currentLink);
                                if (!copied) {
                                  throw new Error("Clipboard access failed.");
                                }
                                showLinkCopied();
                              })
                            }
                          >
                            {linkCopied ? (
                              <Check
                                size={15}
                                strokeWidth={ICON_STROKE}
                                style={{ color: color.success }}
                              />
                            ) : (
                              <Copy size={15} strokeWidth={ICON_STROKE} />
                            )}
                            {linkCopied ? "Copied" : "Copy"}
                          </ActionBtn>
                        </div>
                      </>
                    ) : (
                      // Empty state: no link generated yet.
                      <div className="flex items-center justify-center gap-2 rounded-[10px] border border-white/[0.14] bg-[#131316] px-3 py-3">
                        <Link2
                          size={ICON_SIZE}
                          strokeWidth={ICON_STROKE}
                          className="shrink-0 text-[rgba(250,250,250,0.56)]"
                        />
                        <span className="flex-1 text-[13px] text-[rgba(250,250,250,0.56)]">
                          No link generated yet
                        </span>
                        <ActionBtn
                          variant="primary"
                          working={isWebinarWorking}
                          disabled={isWebinarWorking}
                          className="min-w-[80px]"
                          onClick={() =>
                            void withWebinarTask(async () => {
                              if (!onGenerateWebinarLink) {
                                throw new Error("Link generation is unavailable.");
                              }
                              const response = await onGenerateWebinarLink();
                              await applyWebinarLink(response);
                            })
                          }
                        >
                          Generate
                        </ActionBtn>
                      </div>
                    )}
                  </div>
                </div>
              ) : (
                // Disabled subordinate region: one dimmed, non-interactive unit.
                <div className="pointer-events-none opacity-40">
                  <LockedRow icon={Globe} label="Public access" />
                  <LockedRow icon={Lock} label="Lock attendees" />
                  <LockedRow icon={Users} label="Max attendees" />
                  <LockedRow icon={MessageSquareLock} label="Attendee code" />
                  <LockedRow icon={Link2} label="Webinar link" />
                </div>
              )}
            </>
          ) : null}
        </div>
      </div>
    </>
  );
}
