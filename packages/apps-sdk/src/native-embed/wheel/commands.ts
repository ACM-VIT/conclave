import type * as Y from "yjs";
import {
  addEntries,
  clearEntries,
  clearHistory,
  getEntries,
  normalizeLabel,
  removeEntryById,
  replaceEntries,
  setRemoveWinnerOnDone,
  type WheelEntry,
  type WheelResult,
} from "../../apps/wheel/core/doc/index";
import { cutText } from "../../sdk/text";
import { WHEEL_LIMITS, isValidIdentifier, type NativeToEmbedType } from "../protocol";
import { payloadBoolean, payloadString, type CommandResult, type WheelAppStatus } from "../session";

export type SentName = { index: number; label: string };

export const labelsFrom = (payload: Record<string, unknown>): SentName[] => {
  const raw = payload.labels;
  if (!Array.isArray(raw)) return [];
  const names: SentName[] = [];
  (raw as unknown[]).forEach((value, index) => {
    if (names.length >= WHEEL_LIMITS.entries || typeof value !== "string") return;
    const label = normalizeLabel(value);
    if (label.length > 0) names.push({ index, label });
  });
  return names;
};

export const addNames = (doc: Y.Doc, payload: Record<string, unknown>): CommandResult => {
  const names = labelsFrom(payload);
  if (names.length === 0) return { ok: false, error: "noNames", added: [] };
  const count = addEntries(doc, names.map((name) => name.label));
  if (count === 0) return { ok: false, error: "full", added: [] };
  return { ok: true, added: names.slice(0, count).map((name) => name.index) };
};

export type WheelCommandContext = {
  spinning: boolean;
  requestSpin: () => CommandResult;
  setSounds: (value: boolean) => CommandResult;
};

const shuffled = (entries: WheelEntry[]): WheelEntry[] => {
  const next = [...entries];
  for (let index = next.length - 1; index > 0; index -= 1) {
    const other = Math.floor(Math.random() * (index + 1));
    [next[index], next[other]] = [next[other], next[index]];
  }
  return next;
};

const REORDERING: ReadonlySet<string> = new Set(["removeEntry", "shuffle", "sort", "clearEntries"]);

export const runWheelCommand = (
  doc: Y.Doc,
  type: NativeToEmbedType,
  payload: Record<string, unknown>,
  context: WheelCommandContext
): CommandResult => {
  if (REORDERING.has(type) && context.spinning) return { ok: false, error: "spinning" };
  switch (type) {
    case "addEntries":
      return addNames(doc, payload);
    case "removeEntry": {
      const entryId = payloadString(payload, "entryId");
      if (!isValidIdentifier(entryId)) return { ok: false, error: "badEntry" };
      removeEntryById(doc, entryId);
      return { ok: true };
    }
    case "shuffle": {
      const current = getEntries(doc);
      if (current.length >= 2) replaceEntries(doc, shuffled(current));
      return { ok: true };
    }
    case "sort": {
      const current = getEntries(doc);
      if (current.length >= 2) {
        replaceEntries(doc, [...current].sort((a, b) => a.label.localeCompare(b.label, undefined, { sensitivity: "base" })));
      }
      return { ok: true };
    }
    case "clearEntries":
      clearEntries(doc);
      return { ok: true };
    case "spin":
      return context.requestSpin();
    case "setRemoveWinner": {
      const value = payloadBoolean(payload, "value");
      if (value === null) return { ok: false, error: "badValue" };
      setRemoveWinnerOnDone(doc, value);
      return { ok: true };
    }
    case "setSounds": {
      const value = payloadBoolean(payload, "value");
      if (value === null) return { ok: false, error: "badValue" };
      return context.setSounds(value);
    }
    case "clearResults":
      clearHistory(doc);
      return { ok: true };
    default:
      return { ok: false, error: "unknownCommand" };
  }
};

export type WheelStatusInput = {
  entries: WheelEntry[];
  history: WheelResult[];
  removeWinner: boolean;
  sounds: boolean;
  spinning: boolean;
  winner: { spinId: string; label: string } | null;
};

export const wheelStatus = (input: WheelStatusInput): WheelAppStatus => ({
  kind: "wheel",
  entries: input.entries.map((entry) => ({ id: entry.id, label: entry.label })),
  results: input.history.map((result) => ({
    id: result.spinId,
    label: result.label,
    byName: cutText(result.byName, WHEEL_LIMITS.name),
  })),
  removeWinner: input.removeWinner,
  sounds: input.sounds,
  spinning: input.spinning,
  winnerSpinId: input.winner && isValidIdentifier(input.winner.spinId) ? input.winner.spinId : "",
  winnerLabel: input.winner ? input.winner.label : "",
});
