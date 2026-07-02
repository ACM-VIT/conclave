"use client";

import { useMemo, useState } from "react";
import { color } from "@conclave/ui-tokens";
import { adminRequest } from "./adminApi";
import type { RequestMethod } from "./types";
import { Section, btnAccent, btnGhost, inputClass } from "./ui";

const pretty = (value: unknown): string => JSON.stringify(value, null, 2);

type CommandDef = {
  id: string;
  group: string;
  label: string;
  method: RequestMethod;
  /** Path template; {roomId} is prefilled from the selected room, other
   * placeholders become inputs. */
  path: string;
  body?: unknown;
  hint?: string;
};

/**
 * Every admin endpoint, named and prefilled, so nobody has to remember route
 * shapes. The selected room flows into {roomId}; remaining placeholders
 * become inputs; bodies start from a working template.
 */
const COMMANDS: CommandDef[] = [
  { id: "overview", group: "Inspect", label: "Cluster overview", method: "GET", path: "overview" },
  { id: "workers", group: "Inspect", label: "Worker usage", method: "GET", path: "workers" },
  { id: "rooms", group: "Inspect", label: "List rooms", method: "GET", path: "rooms" },
  { id: "room", group: "Inspect", label: "Room snapshot", method: "GET", path: "rooms/{roomId}" },
  { id: "access", group: "Inspect", label: "Room access lists", method: "GET", path: "rooms/{roomId}/access" },

  {
    id: "policies", group: "Room", label: "Update policies", method: "POST",
    path: "rooms/{roomId}/policies",
    body: { locked: false, chatLocked: false, noGuests: false, ttsDisabled: false, dmEnabled: true },
    hint: "Only fields kept in the body change",
  },
  {
    id: "notice", group: "Room", label: "Send notice", method: "POST",
    path: "rooms/{roomId}/notice",
    body: { message: "Please wrap up in 5 minutes", level: "info" },
  },
  { id: "hands", group: "Room", label: "Clear raised hands", method: "POST", path: "rooms/{roomId}/hands/clear" },
  {
    id: "end", group: "Room", label: "End room", method: "POST",
    path: "rooms/{roomId}/end",
    body: { message: "This meeting has been ended by the host.", delayMs: 0 },
  },

  { id: "mute", group: "Users", label: "Mute user", method: "POST", path: "rooms/{roomId}/users/{userId}/mute" },
  { id: "video-off", group: "Users", label: "Camera off", method: "POST", path: "rooms/{roomId}/users/{userId}/video-off" },
  { id: "stop-screen", group: "Users", label: "Stop screen share", method: "POST", path: "rooms/{roomId}/users/{userId}/stop-screen" },
  {
    id: "kick", group: "Users", label: "Kick user", method: "POST",
    path: "rooms/{roomId}/users/{userId}/kick", body: { reason: "Removed by operator" },
  },
  {
    id: "block", group: "Users", label: "Block user", method: "POST",
    path: "rooms/{roomId}/users/{userId}/block", body: { reason: "Blocked by operator" },
  },
  {
    id: "unblock-user", group: "Users", label: "Unblock user", method: "POST",
    path: "rooms/{roomId}/users/{userId}/unblock",
    body: { userKey: "" },
    hint: "If they already left, set userKey in the body",
  },
  {
    id: "close-producer", group: "Users", label: "Close a producer", method: "POST",
    path: "rooms/{roomId}/producers/{producerId}/close",
    hint: "Producer ids are in the room snapshot",
  },
  {
    id: "remove-non-admins", group: "Users", label: "Remove non-admins", method: "POST",
    path: "rooms/{roomId}/users/remove-non-admins",
    body: { includeAttendees: false, reason: "Stage reset by operator" },
    hint: "Kicks everyone except hosts",
  },

  {
    id: "access-allow", group: "Access", label: "Allow user keys", method: "POST",
    path: "rooms/{roomId}/access/allow",
    body: { userKeys: ["alice@example.com"], allowWhenLocked: true },
  },
  {
    id: "access-revoke", group: "Access", label: "Revoke user keys", method: "POST",
    path: "rooms/{roomId}/access/revoke",
    body: { userKeys: ["alice@example.com"], revokeLocked: true },
  },
  {
    id: "access-block", group: "Access", label: "Block user keys", method: "POST",
    path: "rooms/{roomId}/access/block",
    body: { userKeys: ["alice@example.com"], kickPresent: true, reason: "Blocked by operator" },
  },
  {
    id: "access-unblock", group: "Access", label: "Unblock user keys", method: "POST",
    path: "rooms/{roomId}/access/unblock", body: { userKeys: ["alice@example.com"] },
  },

  { id: "admit", group: "Waiting room", label: "Admit one", method: "POST", path: "rooms/{roomId}/pending/{userKey}/admit" },
  { id: "reject", group: "Waiting room", label: "Reject one", method: "POST", path: "rooms/{roomId}/pending/{userKey}/reject" },
  { id: "admit-all", group: "Waiting room", label: "Admit all", method: "POST", path: "rooms/{roomId}/pending/admit-all" },
  { id: "reject-all", group: "Waiting room", label: "Reject all", method: "POST", path: "rooms/{roomId}/pending/reject-all" },

  {
    id: "drain", group: "Instance", label: "Set drain state", method: "POST", path: "drain",
    body: { draining: true, force: false, notice: "Meeting server is restarting.", noticeMs: 4000 },
  },
];

const GROUPS = ["Inspect", "Room", "Users", "Access", "Waiting room", "Instance"];

const placeholdersOf = (path: string): string[] =>
  Array.from(path.matchAll(/\{(\w+)\}/g)).map((match) => match[1]);

export function ConsolePanel({
  room,
  instanceUrl,
}: {
  /** Selected room, used to prefill {roomId} and scope the request. */
  room: { id: string; clientId: string } | null;
  instanceUrl?: string;
}) {
  const [commandId, setCommandId] = useState("room");
  const [params, setParams] = useState<Record<string, string>>({});
  const [body, setBody] = useState("");
  const [bodyForCommand, setBodyForCommand] = useState("room");
  const [output, setOutput] = useState("");
  const [running, setRunning] = useState(false);

  const command = useMemo(
    () => COMMANDS.find((entry) => entry.id === commandId) ?? COMMANDS[0],
    [commandId],
  );

  // The body editor follows the selected command's template until the
  // operator edits it for that command.
  const effectiveBody =
    bodyForCommand === command.id
      ? body
      : command.body
        ? pretty(command.body)
        : "";

  const placeholders = placeholdersOf(command.path).filter(
    (name) => name !== "roomId",
  );
  const needsRoom = command.path.includes("{roomId}");

  const resolvedPath = useMemo(() => {
    let path = command.path;
    if (needsRoom) {
      path = path.replace("{roomId}", encodeURIComponent(room?.id ?? ""));
    }
    for (const name of placeholders) {
      const value = params[name]?.trim();
      if (value) path = path.replace(`{${name}}`, encodeURIComponent(value));
    }
    return path;
  }, [command.path, needsRoom, params, placeholders, room?.id]);

  const unresolved =
    (needsRoom && !room) ||
    placeholders.some((name) => !params[name]?.trim());

  const run = async () => {
    if (running || unresolved) return;
    setRunning(true);
    try {
      let parsedBody: unknown = undefined;
      if (command.method !== "GET" && command.method !== "DELETE" && effectiveBody.trim()) {
        parsedBody = JSON.parse(effectiveBody.trim()) as unknown;
      }
      const data = await adminRequest<unknown>(resolvedPath, {
        method: command.method,
        body: parsedBody,
        clientId: needsRoom ? room?.clientId : undefined,
        instanceUrl,
      });
      setOutput(pretty(data));
    } catch (error) {
      setOutput(String((error as Error).message));
    } finally {
      setRunning(false);
    }
  };

  return (
    <Section title="Console">
      <details>
        <summary
          className="cursor-pointer select-none text-[12.5px] transition-colors hover:text-white"
          style={{ color: color.textMuted }}
        >
          Run any admin command
        </summary>
        <div className="mt-3 space-y-2">
          <div className="grid gap-2 sm:grid-cols-2">
            <select
              className={inputClass}
              value={command.id}
              onChange={(event) => {
                setCommandId(event.target.value);
                setParams({});
              }}
            >
              {GROUPS.map((group) => (
                <optgroup key={group} label={group}>
                  {COMMANDS.filter((entry) => entry.group === group).map((entry) => (
                    <option key={entry.id} value={entry.id}>
                      {entry.label}
                    </option>
                  ))}
                </optgroup>
              ))}
            </select>
            <div
              className="flex items-center truncate rounded-lg border px-3 text-[12px]"
              style={{
                borderColor: color.border,
                color: color.textFaint,
                fontVariantNumeric: "tabular-nums",
              }}
              title={resolvedPath}
            >
              {command.method} /{resolvedPath}
            </div>
          </div>

          {command.hint ? (
            <p className="text-[11.5px]" style={{ color: color.textFaint }}>
              {command.hint}
            </p>
          ) : null}
          {needsRoom && !room ? (
            <p className="text-[11.5px]" style={{ color: color.warning }}>
              Select a room first.
            </p>
          ) : null}

          {placeholders.length > 0 ? (
            <div className="grid gap-2 sm:grid-cols-2">
              {placeholders.map((name) => (
                <input
                  key={name}
                  className={inputClass}
                  value={params[name] ?? ""}
                  onChange={(event) =>
                    setParams((prev) => ({ ...prev, [name]: event.target.value }))
                  }
                  placeholder={name}
                />
              ))}
            </div>
          ) : null}

          {command.method !== "GET" && command.body !== undefined ? (
            <textarea
              className={`${inputClass} min-h-20`}
              value={effectiveBody}
              onChange={(event) => {
                setBody(event.target.value);
                setBodyForCommand(command.id);
              }}
            />
          ) : null}

          <div className="flex gap-1.5">
            <button
              type="button"
              className={btnAccent}
              disabled={running || unresolved}
              onClick={() => void run()}
            >
              {running ? "Running" : "Run"}
            </button>
            <button
              type="button"
              className={btnGhost}
              onClick={() => setOutput("")}
            >
              Clear output
            </button>
          </div>

          {output ? (
            <pre
              className="max-h-72 overflow-auto whitespace-pre-wrap break-words rounded-lg border p-3 text-[11.5px] leading-relaxed"
              style={{
                borderColor: color.border,
                backgroundColor: color.surface,
                color: color.textMuted,
              }}
            >
              {output}
            </pre>
          ) : null}
        </div>
      </details>
    </Section>
  );
}
