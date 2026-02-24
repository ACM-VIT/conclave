"use client";

import {
  ChevronLeft,
  ChevronRight,
  Globe,
  Link2,
  Lock,
  MessageSquareLock,
  RotateCw,
  ShieldBan,
  Users,
  VolumeX,
  X,
} from "lucide-react";
import { useCallback, useEffect, useState, type ReactNode } from "react";
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

const monoFontStyle = { fontFamily: "'PolySans Mono', monospace" };
const rowButtonClass =
  "flex w-full items-center justify-between gap-3 rounded-md bg-transparent px-3 py-2 text-left text-sm text-[#FEFCD9]/90 transition hover:bg-[#FEFCD9]/5 disabled:cursor-not-allowed disabled:opacity-45";
const inputClass =
  "w-full rounded-md border border-[#FEFCD9]/10 bg-black/40 px-3 py-1.5 text-xs text-[#FEFCD9] outline-none placeholder:text-[#FEFCD9]/30 focus:border-[#FEFCD9]/25";
const actionButtonClass =
  "inline-flex items-center justify-center rounded-md border border-[#FEFCD9]/10 px-3 py-1.5 text-[11px] text-[#FEFCD9]/85 transition hover:border-[#FEFCD9]/25 hover:bg-[#FEFCD9]/10 disabled:cursor-not-allowed disabled:opacity-40";

interface MeetSettingsPanelProps {
  isRoomLocked: boolean;
  onToggleLock?: () => void;
  isNoGuests: boolean;
  onToggleNoGuests?: () => void;
  isChatLocked: boolean;
  onToggleChatLock?: () => void;
  isTtsDisabled: boolean;
  onToggleTtsDisabled?: () => void;
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

type ToggleTone = "warning" | "success";

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

function StatusBadge({
  isOn,
  tone,
}: {
  isOn: boolean;
  tone: ToggleTone;
}) {
  const activeClass =
    tone === "success"
      ? "border-emerald-300/40 bg-emerald-300/10 text-emerald-200"
      : "border-amber-300/40 bg-amber-300/10 text-amber-200";

  return (
    <span
      className={`rounded-full border px-2 py-0.5 text-[10px] uppercase tracking-wide ${
        isOn ? activeClass : "border-[#FEFCD9]/10 text-[#FEFCD9]/40"
      }`}
    >
      {isOn ? "On" : "Off"}
    </span>
  );
}

function ToggleRow({
  label,
  icon,
  isOn,
  tone,
  onClick,
  disabled = false,
}: {
  label: string;
  icon: ReactNode;
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
      className={rowButtonClass}
    >
      <span className="inline-flex items-center gap-2 text-[#FEFCD9]">
        {icon}
        <span>{label}</span>
      </span>
      <StatusBadge isOn={isOn} tone={tone} />
    </button>
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
  const [activeView, setActiveView] = useState<"main" | "webinar">("main");
  const [meetingInviteCodeInput, setMeetingInviteCodeInput] = useState("");
  const [isMeetingWorking, setIsMeetingWorking] = useState(false);
  const [inviteCodeInput, setInviteCodeInput] = useState("");
  const [maxAttendeesInput, setMaxAttendeesInput] = useState(
    String(webinarConfig?.maxAttendees ?? DEFAULT_WEBINAR_CAP),
  );
  const [customLinkCodeInput, setCustomLinkCodeInput] = useState("");
  const [isWebinarWorking, setIsWebinarWorking] = useState(false);

  useEffect(() => {
    setMaxAttendeesInput(
      String(webinarConfig?.maxAttendees ?? DEFAULT_WEBINAR_CAP),
    );
  }, [webinarConfig?.maxAttendees]);

  useEffect(() => {
    setCustomLinkCodeInput(webinarConfig?.linkSlug ?? "");
  }, [webinarConfig?.linkSlug]);

  const refreshWebinarConfig = useCallback(async () => {
    if (!onGetWebinarConfig) return;
    await onGetWebinarConfig();
  }, [onGetWebinarConfig]);

  const refreshMeetingConfig = useCallback(async () => {
    if (!onGetMeetingConfig) return;
    await onGetMeetingConfig();
  }, [onGetMeetingConfig]);

  useEffect(() => {
    void refreshWebinarConfig();
  }, [refreshWebinarConfig]);

  useEffect(() => {
    void refreshMeetingConfig();
  }, [refreshMeetingConfig]);

  const withMeetingTask = useCallback(
    async (
      task: () => Promise<void>,
      options?: { clearInviteInput?: boolean },
    ) => {
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
    async (
      task: () => Promise<void>,
      options?: { clearInviteInput?: boolean },
    ) => {
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
  const normalizedCustomLinkCode = customLinkCodeInput.trim().toLowerCase();
  const isCustomLinkCodeValid = WEBINAR_LINK_CODE_PATTERN.test(
    normalizedCustomLinkCode,
  );

  return (
    <div
      className="absolute bottom-14 left-1/2 z-50 max-h-[70vh] w-[320px] max-w-[calc(100vw-1.5rem)] -translate-x-1/2 overflow-y-auto rounded-xl border border-[#FEFCD9]/10 bg-[#0d0e0d]/95 p-2.5 shadow-2xl backdrop-blur-md"
      style={{ fontFamily: "'PolySans Trial', sans-serif" }}
    >
      <div className="mb-2 flex items-center justify-between border-b border-[#FEFCD9]/10 px-1 pb-2">
        <p
          className="text-[10px] uppercase tracking-[0.16em] text-[#FEFCD9]/45"
          style={monoFontStyle}
        >
          {activeView === "webinar" ? "Webinar settings" : "Meeting settings"}
        </p>
        <button
          onClick={onClose}
          className="flex h-6 w-6 items-center justify-center rounded-md text-[#FEFCD9]/45 transition hover:bg-[#FEFCD9]/10 hover:text-[#FEFCD9]"
          aria-label="Close meeting settings"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      {activeView === "main" ? (
        <div className="space-y-2">
          <div className="rounded-lg border border-[#FEFCD9]/10 bg-black/25">
            <div className="divide-y divide-[#FEFCD9]/10">
              <ToggleRow
                label="Lock meeting"
                icon={
                  <Lock
                    className={`h-4 w-4 ${isRoomLocked ? "text-amber-300" : "text-[#FEFCD9]/65"}`}
                  />
                }
                isOn={isRoomLocked}
                tone="warning"
                onClick={onToggleLock}
                disabled={!onToggleLock}
              />
              <ToggleRow
                label="Block guests"
                icon={
                  <ShieldBan
                    className={`h-4 w-4 ${isNoGuests ? "text-amber-300" : "text-[#FEFCD9]/65"}`}
                  />
                }
                isOn={isNoGuests}
                tone="warning"
                onClick={onToggleNoGuests}
                disabled={!onToggleNoGuests}
              />
              <ToggleRow
                label="Lock chat"
                icon={
                  <MessageSquareLock
                    className={`h-4 w-4 ${isChatLocked ? "text-amber-300" : "text-[#FEFCD9]/65"}`}
                  />
                }
                isOn={isChatLocked}
                tone="warning"
                onClick={onToggleChatLock}
                disabled={!onToggleChatLock}
              />
              <ToggleRow
                label="Disable TTS"
                icon={
                  <VolumeX
                    className={`h-4 w-4 ${isTtsDisabled ? "text-amber-300" : "text-[#FEFCD9]/65"}`}
                  />
                }
                isOn={isTtsDisabled}
                tone="warning"
                onClick={onToggleTtsDisabled}
                disabled={!onToggleTtsDisabled}
              />
              <button
                type="button"
                onClick={() => setActiveView("webinar")}
                className={rowButtonClass}
              >
                <span className="inline-flex items-center gap-2 text-[#FEFCD9]">
                  <Users className={`h-4 w-4 ${isWebinarEnabled ? "text-emerald-300" : "text-[#FEFCD9]/65"}`} />
                  <span>Webinar settings</span>
                </span>
                <span className="inline-flex items-center gap-2">
                  <StatusBadge isOn={isWebinarEnabled} tone="success" />
                  <ChevronRight className="h-4 w-4 text-[#FEFCD9]/45" />
                </span>
              </button>
            </div>
          </div>

          <div className="rounded-lg border border-[#FEFCD9]/10 bg-black/25 p-2.5">
            <div className="mb-2 flex items-center justify-between text-[11px] text-[#FEFCD9]/60">
              <span>Meeting invite code</span>
              <span
                className={`rounded-full border px-2 py-0.5 text-[10px] uppercase tracking-wide ${
                  meetingRequiresInviteCode
                    ? "border-amber-300/40 bg-amber-300/10 text-amber-200"
                    : "border-[#FEFCD9]/10 text-[#FEFCD9]/40"
                }`}
              >
                {meetingRequiresInviteCode ? "Protected" : "Open"}
              </span>
            </div>
            <div className="flex items-center gap-2">
              <input
                type="text"
                value={meetingInviteCodeInput}
                onChange={(event) =>
                  setMeetingInviteCodeInput(event.target.value)
                }
                className={inputClass}
                placeholder="Set meeting invite code"
              />
              <button
                type="button"
                disabled={isMeetingWorking || !meetingInviteCodeInput.trim()}
                onClick={() =>
                  void withMeetingTask(
                    async () => {
                      await updateMeetingConfig({
                        inviteCode: meetingInviteCodeInput.trim(),
                      });
                    },
                    { clearInviteInput: true },
                  )
                }
                className={actionButtonClass}
              >
                Save
              </button>
              <button
                type="button"
                disabled={isMeetingWorking || !meetingRequiresInviteCode}
                onClick={() =>
                  void withMeetingTask(async () => {
                    await updateMeetingConfig({ inviteCode: null });
                  })
                }
                className={actionButtonClass}
              >
                Clear
              </button>
            </div>
          </div>
        </div>
      ) : (
        <div className="space-y-2">
          <button
            type="button"
            onClick={() => setActiveView("main")}
            className="inline-flex items-center gap-1 rounded-md px-1.5 py-1 text-[11px] text-[#FEFCD9]/55 transition hover:bg-[#FEFCD9]/10 hover:text-[#FEFCD9]"
          >
            <ChevronLeft className="h-3.5 w-3.5" />
            Back
          </button>

          <div className="rounded-lg border border-[#FEFCD9]/10 bg-black/25">
            <div className="divide-y divide-[#FEFCD9]/10">
              <ToggleRow
                label="Enable webinar"
                icon={
                  <Users
                    className={`h-4 w-4 ${isWebinarEnabled ? "text-emerald-300" : "text-[#FEFCD9]/65"}`}
                  />
                }
                isOn={isWebinarEnabled}
                tone="success"
              onClick={() =>
                void withWebinarTask(
                  async () => {
                    await updateWebinarConfig({
                      enabled: !Boolean(webinarConfig?.enabled),
                    });
                  },
                )
              }
              disabled={isWebinarWorking}
              />
              <ToggleRow
                label="Public access"
                icon={
                  <Globe
                    className={`h-4 w-4 ${
                      webinarConfig?.publicAccess
                        ? "text-emerald-300"
                        : "text-[#FEFCD9]/65"
                    }`}
                  />
                }
                isOn={Boolean(webinarConfig?.publicAccess)}
                tone="success"
              onClick={() =>
                void withWebinarTask(
                  async () => {
                    await updateWebinarConfig({
                      publicAccess: !Boolean(webinarConfig?.publicAccess),
                    });
                  },
                )
              }
              disabled={isWebinarWorking || !isWebinarEnabled}
              />
              <ToggleRow
                label="Lock attendees"
                icon={
                  <Lock
                    className={`h-4 w-4 ${
                      webinarConfig?.locked ? "text-amber-300" : "text-[#FEFCD9]/65"
                    }`}
                  />
                }
                isOn={Boolean(webinarConfig?.locked)}
                tone="warning"
              onClick={() =>
                void withWebinarTask(
                  async () => {
                    await updateWebinarConfig({
                      locked: !Boolean(webinarConfig?.locked),
                    });
                  },
                )
              }
              disabled={isWebinarWorking || !isWebinarEnabled}
              />
            </div>
          </div>

          <div className="rounded-lg border border-[#FEFCD9]/10 bg-black/25 p-2.5">
            <div className="mb-2 flex items-center justify-between text-[11px] text-[#FEFCD9]/60">
              <span>Attendees</span>
              <span>
                <span className="text-[#FEFCD9]">{attendeeCount}</span> /{" "}
                <span className="text-[#FEFCD9]">{attendeeCap}</span>
              </span>
            </div>
            <div className="flex items-center gap-2">
              <input
                type="number"
                min={MIN_WEBINAR_CAP}
                max={MAX_WEBINAR_CAP}
                value={maxAttendeesInput}
                onChange={(event) => setMaxAttendeesInput(event.target.value)}
                className={inputClass}
                placeholder="Max attendees"
              />
              <button
                type="button"
                disabled={
                  isWebinarWorking || !isWebinarEnabled || attendeeCapCandidate == null
                }
                onClick={() =>
                  void withWebinarTask(
                    async () => {
                      if (attendeeCapCandidate == null) {
                        throw new Error("Enter a valid attendee cap.");
                      }
                      await updateWebinarConfig({
                        maxAttendees: attendeeCapCandidate,
                      });
                    },
                  )
                }
                className={actionButtonClass}
              >
                Save
              </button>
            </div>
          </div>

          <div className="rounded-lg border border-[#FEFCD9]/10 bg-black/25 p-2.5">
            <div className="mb-2 flex items-center justify-between text-[11px] text-[#FEFCD9]/60">
              <span>Invite code</span>
              {webinarRole ? (
                <span className="rounded-full border border-[#FEFCD9]/10 px-2 py-0.5 text-[10px] uppercase tracking-wide text-[#FEFCD9]/50">
                  {webinarRole}
                </span>
              ) : null}
            </div>
            <div className="flex items-center gap-2">
              <input
                type="text"
                value={inviteCodeInput}
                onChange={(event) => setInviteCodeInput(event.target.value)}
                className={inputClass}
                placeholder="Set invite code"
              />
              <button
                type="button"
                disabled={isWebinarWorking || !isWebinarEnabled || !inviteCodeInput.trim()}
                onClick={() =>
                  void withWebinarTask(
                    async () => {
                      await updateWebinarConfig({
                        inviteCode: inviteCodeInput.trim(),
                      });
                    },
                    { clearInviteInput: true },
                  )
                }
                className={actionButtonClass}
              >
                Save
              </button>
              <button
                type="button"
                disabled={
                  isWebinarWorking || !isWebinarEnabled || !webinarConfig?.requiresInviteCode
                }
                onClick={() =>
                  void withWebinarTask(
                    async () => {
                      await updateWebinarConfig({ inviteCode: null });
                    },
                  )
                }
                className={actionButtonClass}
              >
                Clear
              </button>
            </div>
          </div>

          <div className="rounded-lg border border-[#FEFCD9]/10 bg-black/25 p-2.5">
            <div className="mb-2 flex items-center gap-2">
              <input
                type="text"
                value={customLinkCodeInput}
                onChange={(event) =>
                  setCustomLinkCodeInput(
                    normalizeWebinarLinkCodeInput(event.target.value),
                  )
                }
                className={inputClass}
                placeholder="Custom link code"
              />
              <button
                type="button"
                disabled={
                  isWebinarWorking || !isWebinarEnabled || !isCustomLinkCodeValid
                }
                onClick={() =>
                  void withWebinarTask(async () => {
                    if (!onGenerateWebinarLink) {
                      throw new Error("Link generation is unavailable.");
                    }

                    await updateWebinarConfig({
                      linkSlug: normalizedCustomLinkCode,
                    });
                    const response = await onGenerateWebinarLink();
                    await applyWebinarLink(response);
                  })
                }
                className={actionButtonClass}
              >
                Save
              </button>
            </div>
            <div className="mb-2 flex items-center gap-2">
              <Link2 className="h-4 w-4 text-[#FEFCD9]/55" />
              <input
                type="text"
                readOnly
                value={currentLink}
                placeholder="Generate webinar link"
                className={inputClass}
              />
            </div>
            <div className="grid grid-cols-3 gap-2">
              <button
                type="button"
                disabled={isWebinarWorking || !isWebinarEnabled}
                onClick={() =>
                  void withWebinarTask(async () => {
                    if (!onGenerateWebinarLink) {
                      throw new Error("Link generation is unavailable.");
                    }
                    const response = await onGenerateWebinarLink();
                    await applyWebinarLink(response);
                  })
                }
                className={`${actionButtonClass} w-full`}
              >
                Generate
              </button>
              <button
                type="button"
                disabled={isWebinarWorking || !isWebinarEnabled}
                onClick={() =>
                  void withWebinarTask(async () => {
                    if (!onRotateWebinarLink) {
                      throw new Error("Link rotation is unavailable.");
                    }
                    const response = await onRotateWebinarLink();
                    await applyWebinarLink(response);
                  })
                }
                className={`${actionButtonClass} w-full`}
              >
                <span className="inline-flex items-center gap-1">
                  <RotateCw className="h-3 w-3" />
                  Rotate
                </span>
              </button>
              <button
                type="button"
                disabled={isWebinarWorking || !currentLink}
                onClick={() =>
                  void withWebinarTask(
                    async () => {
                      const copied = await copyToClipboard(currentLink);
                      if (!copied) {
                        throw new Error("Clipboard access failed.");
                      }
                    },
                  )
                }
                className={`${actionButtonClass} w-full`}
              >
                Copy
              </button>
            </div>
          </div>

        </div>
      )}
    </div>
  );
}
