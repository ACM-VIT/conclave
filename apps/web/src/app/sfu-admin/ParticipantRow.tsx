"use client";

import { memo } from "react";
import { color } from "@conclave/ui-tokens";
import type { AdminActionInput, ParticipantSnapshot } from "./types";
import { ConfirmButton, Dot, Tag, btnTiny } from "./ui";

const roleTone = (role: ParticipantSnapshot["role"]) => {
  if (role === "host") return "accent" as const;
  if (role === "admin") return "warn" as const;
  return "neutral" as const;
};

/**
 * Receive-side media health from consumer telemetry: the worst active
 * consumer score is what the participant is actually experiencing.
 * Mediasoup scores run 0 to 10.
 */
const mediaHealth = (
  participant: ParticipantSnapshot,
): { tone: "ok" | "warn" | "danger"; worst: number } | null => {
  const scores = (participant.consumers ?? [])
    .filter((consumer) => !consumer.paused && !consumer.producerPaused)
    .map((consumer) =>
      typeof consumer.score?.score === "number" ? consumer.score.score : null,
    )
    .filter((value): value is number => value != null);
  if (scores.length === 0) return null;
  const worst = Math.min(...scores);
  if (worst >= 7) return { tone: "ok", worst };
  if (worst >= 4) return { tone: "warn", worst };
  return { tone: "danger", worst };
};

const HEALTH_COLOR = { ok: "#22c55e", warn: "#fbbf24", danger: "#ea4335" } as const;

/**
 * One participant with inline moderation. Memoized so a room push only
 * re-renders the rows whose snapshot actually changed.
 */
export const ParticipantRow = memo(function ParticipantRow({
  participant,
  roomPath,
  isBusy,
  moderationReason,
  act,
}: {
  participant: ParticipantSnapshot;
  roomPath: string;
  /** Destructive confirms disable while a command is in flight. */
  isBusy: boolean;
  moderationReason: string;
  act: (input: AdminActionInput) => void;
}) {
  const health = mediaHealth(participant);
  const userPath = `${roomPath}/users/${encodeURIComponent(participant.userId)}`;

  return (
    <div
      className="rounded-lg border px-3 py-2.5"
      style={{ borderColor: color.border, backgroundColor: color.surface }}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            {health ? (
              <span title={`Worst consumer score ${health.worst} of 10`}>
                <Dot tone={HEALTH_COLOR[health.tone]} />
              </span>
            ) : null}
            <p className="truncate text-[13.5px] font-medium" style={{ color: color.text }}>
              {participant.displayName}
            </p>
            <Tag tone={roleTone(participant.role)}>{participant.role}</Tag>
            <Tag tone={participant.muted ? "neutral" : "ok"}>
              {participant.muted ? "muted" : "mic on"}
            </Tag>
            <Tag tone={participant.cameraOff ? "neutral" : "ok"}>
              {participant.cameraOff ? "cam off" : "cam on"}
            </Tag>
            {participant.pendingDisconnect ? <Tag tone="warn">reconnecting</Tag> : null}
          </div>
          <p className="mt-0.5 truncate text-[11px]" style={{ color: color.textFaint }}>
            {participant.userKey || participant.userId}
            {participant.consumerCount > 0
              ? ` · ${participant.consumerCount} consumers`
              : ""}
          </p>
        </div>
        <div className="flex flex-wrap gap-1.5">
          {!participant.muted ? (
            <button
              type="button"
              className={btnTiny}
              onClick={() =>
                act({ label: `Muted ${participant.displayName}`, path: `${userPath}/mute` })
              }
            >
              Mute
            </button>
          ) : null}
          {!participant.cameraOff ? (
            <button
              type="button"
              className={btnTiny}
              onClick={() =>
                act({
                  label: `Turned camera off for ${participant.displayName}`,
                  path: `${userPath}/video-off`,
                })
              }
            >
              Camera off
            </button>
          ) : null}
          {participant.producers.some((producer) => producer.type === "screen") ? (
            <button
              type="button"
              className={btnTiny}
              onClick={() =>
                act({
                  label: `Stopped screen share for ${participant.displayName}`,
                  path: `${userPath}/stop-screen`,
                })
              }
            >
              Stop screen
            </button>
          ) : null}
          <ConfirmButton
            size="tiny"
            label="Kick"
            confirmLabel="Confirm kick"
            disabled={isBusy}
            onConfirm={() =>
              act({
                label: `Kicked ${participant.displayName}`,
                path: `${userPath}/kick`,
                body: { reason: moderationReason.trim() || "Removed by operator" },
              })
            }
          />
          <ConfirmButton
            size="tiny"
            label="Block"
            confirmLabel="Confirm block"
            disabled={isBusy}
            onConfirm={() =>
              act({
                label: `Blocked ${participant.displayName}`,
                path: `${userPath}/block`,
                body: { reason: moderationReason.trim() || "Blocked by operator" },
              })
            }
          />
        </div>
      </div>
      {(participant.consumers?.length ?? 0) > 0 || participant.producers.length > 0 ? (
        <details className="mt-1.5">
          <summary
            className="cursor-pointer select-none text-[11px] transition-colors hover:text-white"
            style={{ color: color.textFaint }}
          >
            Media detail
          </summary>
          {participant.producers.length > 0 ? (
            <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
              <span className="text-[11px]" style={{ color: color.textFaint }}>
                Producers
              </span>
              {participant.producers.map((producer) => (
                <button
                  key={producer.producerId}
                  type="button"
                  className={btnTiny}
                  title={`Close ${producer.producerId}`}
                  onClick={() =>
                    act({
                      label: `Closed ${producer.kind} ${producer.type} producer of ${participant.displayName}`,
                      path: `${roomPath}/producers/${encodeURIComponent(producer.producerId)}/close`,
                    })
                  }
                >
                  {producer.kind}:{producer.type}
                  {producer.paused ? " (paused)" : ""} ×
                </button>
              ))}
            </div>
          ) : null}
          <div className="mt-1.5 space-y-1">
            {(participant.consumers ?? []).map((consumer) => {
              const score =
                typeof consumer.score?.score === "number" ? consumer.score.score : null;
              const scoreTone =
                score == null
                  ? color.textFaint
                  : score >= 7
                    ? HEALTH_COLOR.ok
                    : score >= 4
                      ? HEALTH_COLOR.warn
                      : HEALTH_COLOR.danger;
              return (
                <p
                  key={consumer.consumerId}
                  className="text-[11px]"
                  style={{ color: color.textFaint, fontVariantNumeric: "tabular-nums" }}
                >
                  {consumer.kind}
                  {consumer.type ? `:${consumer.type}` : ""}
                  {consumer.producerUserId ? ` from ${consumer.producerUserId}` : ""}
                  {" · "}
                  <span style={{ color: scoreTone }}>
                    {score == null ? "no score" : `score ${score}/10`}
                  </span>
                  {consumer.paused || consumer.producerPaused ? " · paused" : ""}
                  {consumer.currentLayers?.spatialLayer != null
                    ? ` · layer ${consumer.currentLayers.spatialLayer}`
                    : ""}
                </p>
              );
            })}
          </div>
        </details>
      ) : null}
    </div>
  );
});
