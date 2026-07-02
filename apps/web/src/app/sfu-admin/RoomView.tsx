"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { color } from "@conclave/ui-tokens";
import { ChatSpectator } from "./ChatSpectator";
import { ParticipantRow } from "./ParticipantRow";
import { TranscriptSpectator } from "./TranscriptSpectator";
import { WaitingSection } from "./WaitingSection";
import type {
  AdminActionInput,
  AdminChatMessage,
  RoomPolicies,
  RoomSnapshot,
} from "./types";
import {
  ConfirmButton,
  Section,
  Tag,
  Toggle,
  btnAccent,
  btnSecondary,
  btnTiny,
  btnTinyDanger,
  inputClass,
} from "./ui";

const parseUserKeysInput = (value: string): string[] =>
  Array.from(
    new Set(
      value
        .split(/[\n,]+/)
        .map((entry) => entry.trim())
        .filter(Boolean),
    ),
  );

type PolicyKey = keyof Omit<RoomPolicies, "requiresMeetingInviteCode">;

const POLICY_ROWS: Array<{ key: PolicyKey; label: string }> = [
  { key: "locked", label: "Room locked" },
  { key: "chatLocked", label: "Chat locked" },
  { key: "noGuests", label: "No guests" },
  { key: "ttsDisabled", label: "TTS disabled" },
  { key: "dmEnabled", label: "Direct messages" },
  { key: "reactionsDisabled", label: "Reactions disabled" },
];

const POLICY_CONFIRM_MS = 5000;

/**
 * Everything about one room on a single calm page: live participants with
 * inline moderation on the left, controls in a sticky rail on the right, and
 * the destructive stuff fenced at the bottom of that rail.
 */
export function RoomView({
  room,
  chat,
  instanceUrl,
  isBusy,
  runAction,
  runBatch,
  onActionSettled,
}: {
  room: RoomSnapshot;
  /** Live broadcast chat for this room, or null before the first push. */
  chat: AdminChatMessage[] | null;
  /** Pool url of the SFU this room lives on; commands target it. */
  instanceUrl: string;
  /** Disables destructive confirms while a command is in flight. */
  isBusy: boolean;
  runAction: (input: AdminActionInput) => Promise<boolean>;
  /** Several commands under one label and one toast, e.g. mute all. */
  runBatch: (
    label: string,
    inputs: Array<Omit<AdminActionInput, "label">>,
  ) => Promise<boolean>;
  /** Called after any action, so the caller can force a fresh room push. */
  onActionSettled: () => void;
}) {
  const roomPath = `rooms/${encodeURIComponent(room.id)}`;
  const [moderationReason, setModerationReason] = useState("Removed by operator");
  const [noticeMessage, setNoticeMessage] = useState("");
  const [noticeLevel, setNoticeLevel] = useState<"info" | "warning" | "error">("info");
  const [accessKeysInput, setAccessKeysInput] = useState("");
  const [accessReason, setAccessReason] = useState("Policy enforcement");
  const [allowWhenLocked, setAllowWhenLocked] = useState(true);
  const [revokeLocked, setRevokeLocked] = useState(true);
  const [kickPresent, setKickPresent] = useState(true);
  const [includeAttendees, setIncludeAttendees] = useState(false);
  const [endRoomMessage, setEndRoomMessage] = useState(
    "This meeting has been ended by the host.",
  );
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(timer);
  }, [copied]);

  // Policies apply the moment a switch flips. Each override clears only when
  // the server echoes that value back (or it expires); clearing on ANY push
  // made unrelated updates in a busy room snap the switch back and forth.
  const [policyOverride, setPolicyOverride] = useState<Partial<RoomPolicies>>({});
  const policyOverrideAtRef = useRef<Partial<Record<PolicyKey, number>>>({});
  useEffect(() => {
    setPolicyOverride((prev) => {
      const keys = Object.keys(prev) as PolicyKey[];
      if (keys.length === 0) return prev;
      const now = Date.now();
      const next = { ...prev };
      let changed = false;
      for (const key of keys) {
        const confirmed = room.policies[key] === prev[key];
        const expired =
          now - (policyOverrideAtRef.current[key] ?? 0) > POLICY_CONFIRM_MS;
        if (confirmed || expired) {
          delete next[key];
          delete policyOverrideAtRef.current[key];
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, [room.policies]);
  const policies = { ...room.policies, ...policyOverride };

  const act = (input: AdminActionInput) => {
    void runAction({ ...input, clientId: room.clientId, instanceUrl }).finally(
      onActionSettled,
    );
  };

  const setPolicy = (key: PolicyKey, next: boolean) => {
    policyOverrideAtRef.current[key] = Date.now();
    setPolicyOverride((prev) => ({ ...prev, [key]: next }));
    act({
      label: "Updated room policy",
      path: `${roomPath}/policies`,
      body: { [key]: next },
    });
  };

  const unmutedParticipants = room.participants.filter(
    (participant) => !participant.muted,
  );

  const countsLine = useMemo(() => {
    const hostName = room.hostUserId
      ? (room.participants.find(
          (participant) => participant.userId === room.hostUserId,
        )?.displayName ?? room.hostUserId)
      : null;
    const parts = [
      hostName ? `host ${hostName}` : "no host",
      `${room.counts.participants} in room`,
      room.counts.pendingUsers > 0 ? `${room.counts.pendingUsers} waiting` : null,
      `${room.counts.admins} admin${room.counts.admins === 1 ? "" : "s"}`,
      room.counts.webinarAttendees > 0
        ? `${room.counts.webinarAttendees} attendees`
        : null,
      `${room.counts.producers} producers`,
      `${room.counts.consumers} consumers`,
    ].filter(Boolean);
    return parts.join(" · ");
  }, [room.counts, room.hostUserId, room.participants]);

  return (
    <div className="mx-auto w-full max-w-6xl pb-10">
      {/* Header */}
      <div className="flex flex-wrap items-start justify-between gap-3 pt-1">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-[18px] font-semibold" style={{ color: color.text }}>
              {room.id}
            </h2>
            <Tag>{room.clientId}</Tag>
            {policies.locked ? <Tag tone="accent">locked</Tag> : null}
            {policies.chatLocked ? <Tag tone="warn">chat locked</Tag> : null}
            {room.screenShareProducerId ? <Tag tone="ok">screen live</Tag> : null}
            {room.appsState.activeAppId ? (
              <Tag tone="accent">
                {room.appsState.activeAppId}
                {room.appsState.locked ? " · app locked" : ""}
              </Tag>
            ) : null}
            {room.quality === "low" ? <Tag tone="warn">low quality</Tag> : null}
          </div>
          <p
            className="mt-1 text-[12.5px]"
            style={{ color: color.textFaint, fontVariantNumeric: "tabular-nums" }}
          >
            {countsLine}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          <button
            type="button"
            className={btnSecondary}
            onClick={() => {
              void navigator.clipboard
                ?.writeText(`${window.location.origin}/${encodeURIComponent(room.id)}`)
                .then(() => setCopied(true))
                .catch(() => {});
            }}
            title="Copy the meeting link"
          >
            {copied ? "Copied" : "Copy link"}
          </button>
          <ConfirmButton
            label="End room"
            confirmLabel="Confirm end"
            disabled={isBusy}
            onConfirm={() =>
              act({
                label: "Ended room",
                path: `${roomPath}/end`,
                body: { message: endRoomMessage.trim() || undefined, delayMs: 0 },
              })
            }
          />
        </div>
      </div>

      <div className="mt-2 grid items-start gap-x-10 lg:grid-cols-[minmax(0,1fr)_320px]">
        {/* People */}
        <div className="min-w-0 space-y-4">
          <WaitingSection pendingUsers={room.pendingUsers} roomPath={roomPath} act={act} />

          <Section
            title={`Participants · ${room.participants.length}`}
            action={
              <div className="flex gap-1.5">
                {unmutedParticipants.length > 1 ? (
                  <ConfirmButton
                    size="tiny"
                    label="Mute all"
                    confirmLabel={`Mute ${unmutedParticipants.length}`}
                    disabled={isBusy}
                    onConfirm={() =>
                      void runBatch(
                        `Muted ${unmutedParticipants.length} people`,
                        unmutedParticipants.map((participant) => ({
                          path: `${roomPath}/users/${encodeURIComponent(participant.userId)}/mute`,
                          clientId: room.clientId,
                          instanceUrl,
                        })),
                      ).finally(onActionSettled)
                    }
                  />
                ) : null}
                <button
                  type="button"
                  className={btnTiny}
                  onClick={() =>
                    act({ label: "Cleared raised hands", path: `${roomPath}/hands/clear` })
                  }
                >
                  Clear hands
                </button>
              </div>
            }
          >
            <div className="space-y-1.5">
              {room.participants.map((participant) => (
                <ParticipantRow
                  key={participant.userId}
                  participant={participant}
                  roomPath={roomPath}
                  isBusy={isBusy}
                  moderationReason={moderationReason}
                  act={act}
                />
              ))}
              {room.participants.length === 0 ? (
                <p className="py-3 text-center text-[12.5px]" style={{ color: color.textFaint }}>
                  Nobody in the room
                </p>
              ) : null}
            </div>
            <div className="mt-2 flex items-center gap-2">
              <span className="shrink-0 text-[11.5px]" style={{ color: color.textFaint }}>
                Reason
              </span>
              <input
                className={inputClass}
                value={moderationReason}
                onChange={(event) => setModerationReason(event.target.value)}
                placeholder="Attached to kicks and blocks"
              />
            </div>
          </Section>

          <ChatSpectator messages={chat} />

          <TranscriptSpectator
            roomId={room.id}
            clientId={room.clientId}
            instanceUrl={instanceUrl}
          />
        </div>

        {/* Controls rail */}
        <div className="min-w-0 space-y-4 lg:sticky lg:top-3">
          <Section title="Room settings">
            <div className="grid grid-cols-1">
              {POLICY_ROWS.map((row) => (
                <Toggle
                  key={row.key}
                  label={row.label}
                  checked={policies[row.key]}
                  onChange={(next) => setPolicy(row.key, next)}
                />
              ))}
            </div>
          </Section>

          <Section title="Send a notice">
            <div className="flex flex-col gap-2">
              <input
                className={inputClass}
                value={noticeMessage}
                onChange={(event) => setNoticeMessage(event.target.value)}
                placeholder="Message shown to everyone in the room"
                onKeyDown={(event) => {
                  if (event.key === "Enter" && noticeMessage.trim()) {
                    act({
                      label: "Sent notice",
                      path: `${roomPath}/notice`,
                      body: { message: noticeMessage.trim(), level: noticeLevel },
                    });
                    setNoticeMessage("");
                  }
                }}
              />
              <div className="flex flex-wrap gap-1.5">
                {(["info", "warning", "error"] as const).map((level) => {
                  const active = noticeLevel === level;
                  return (
                    <button
                      key={level}
                      type="button"
                      onClick={() => setNoticeLevel(level)}
                      className="inline-flex h-8 items-center rounded-lg border px-2.5 text-[12px] font-medium transition-colors"
                      style={{
                        borderColor: active ? "rgba(249,95,74,0.5)" : color.border,
                        color: active ? color.accent : color.textMuted,
                        backgroundColor: active ? "rgba(249,95,74,0.08)" : "transparent",
                      }}
                    >
                      {level}
                    </button>
                  );
                })}
                <button
                  type="button"
                  className={btnAccent}
                  disabled={!noticeMessage.trim()}
                  onClick={() => {
                    act({
                      label: "Sent notice",
                      path: `${roomPath}/notice`,
                      body: { message: noticeMessage.trim(), level: noticeLevel },
                    });
                    setNoticeMessage("");
                  }}
                >
                  Send
                </button>
              </div>
            </div>
          </Section>

          <Section title="Access">
            <details>
              <summary
                className="cursor-pointer select-none text-[12.5px] transition-colors hover:text-white"
                style={{ color: color.textMuted }}
              >
                {room.access.blockedUserKeys.length > 0
                  ? `Manage allow and block lists · ${room.access.blockedUserKeys.length} blocked`
                  : "Manage allow and block lists"}
              </summary>
              <div className="mt-3 space-y-3">
                <textarea
                  className={`${inputClass} min-h-20`}
                  value={accessKeysInput}
                  onChange={(event) => setAccessKeysInput(event.target.value)}
                  placeholder={"One user key per line\nalice@example.com"}
                />
                <input
                  className={inputClass}
                  value={accessReason}
                  onChange={(event) => setAccessReason(event.target.value)}
                  placeholder="Reason used by block"
                />
                <div className="grid grid-cols-1">
                  <Toggle
                    label="Allow entries bypass the lock"
                    checked={allowWhenLocked}
                    onChange={setAllowWhenLocked}
                  />
                  <Toggle
                    label="Revoke clears lock allowances"
                    checked={revokeLocked}
                    onChange={setRevokeLocked}
                  />
                  <Toggle
                    label="Block kicks connected users"
                    checked={kickPresent}
                    onChange={setKickPresent}
                  />
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {(
                    [
                      ["allow", "Allow"],
                      ["revoke", "Revoke"],
                      ["block", "Block"],
                      ["unblock", "Unblock"],
                    ] as const
                  ).map(([action, label]) => (
                    <button
                      key={action}
                      type="button"
                      className={action === "block" ? btnTinyDanger : btnTiny}
                      onClick={() => {
                        const userKeys = parseUserKeysInput(accessKeysInput);
                        if (userKeys.length === 0) return;
                        const body: Record<string, unknown> = { userKeys };
                        if (action === "allow") body.allowWhenLocked = allowWhenLocked;
                        if (action === "revoke") body.revokeLocked = revokeLocked;
                        if (action === "block") {
                          body.kickPresent = kickPresent;
                          body.reason = accessReason.trim() || "Blocked by operator";
                        }
                        act({
                          label: `Applied ${label.toLowerCase()} to user keys`,
                          path: `${roomPath}/access/${action}`,
                          body,
                        });
                      }}
                    >
                      {label}
                    </button>
                  ))}
                </div>
                {(
                  [
                    ["Allowed", room.access.allowedUserKeys, "ok"],
                    ["Allowed while locked", room.access.lockedAllowedUserKeys, "warn"],
                    ["Blocked", room.access.blockedUserKeys, "danger"],
                  ] as const
                ).map(([listTitle, keys, tone]) =>
                  keys.length > 0 ? (
                    <div key={listTitle}>
                      <p className="mb-1.5 text-[11.5px]" style={{ color: color.textFaint }}>
                        {listTitle}
                      </p>
                      <div className="flex flex-wrap gap-1.5">
                        {keys.map((key) => (
                          <Tag key={key} tone={tone}>
                            {key}
                          </Tag>
                        ))}
                      </div>
                    </div>
                  ) : null,
                )}
              </div>
            </details>
          </Section>

          <Section title="Danger">
            <div className="space-y-2">
              <p className="text-[11.5px] leading-relaxed" style={{ color: color.textFaint }}>
                Remove non-admins kicks everyone except hosts. End room closes
                the meeting with the message below.
              </p>
              <input
                className={inputClass}
                value={endRoomMessage}
                onChange={(event) => setEndRoomMessage(event.target.value)}
                placeholder="Message shown when the room ends"
              />
              <Toggle
                label="Also remove webinar attendees"
                checked={includeAttendees}
                onChange={setIncludeAttendees}
              />
              <ConfirmButton
                label="Remove non-admins"
                confirmLabel="Confirm remove"
                disabled={isBusy}
                onConfirm={() =>
                  act({
                    label: "Removed non-admins",
                    path: `${roomPath}/users/remove-non-admins`,
                    body: {
                      includeAttendees,
                      reason: moderationReason.trim() || undefined,
                    },
                  })
                }
              />
            </div>
          </Section>
        </div>
      </div>
    </div>
  );
}
