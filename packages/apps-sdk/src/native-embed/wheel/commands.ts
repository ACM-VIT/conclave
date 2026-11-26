import type * as Y from "yjs";
import {
  addEntries,
  addEntriesOnce,
  clearEntries,
  clearHistory,
  getAddedTokens,
  getEntries,
  normalizeLabel,
  removeEntryById,
  replaceEntries,
  setRemoveWinnerOnDone,
  type WheelEntry,
  type WheelResult,
} from "../../apps/wheel/core/doc/index";
import { cutText } from "../../sdk/text";
import { APP_EDIT_COMMANDS, DOC_ANSWERED_COMMANDS, WHEEL_LIMITS, isValidIdentifier, type NativeToEmbedType } from "../protocol";
import { payloadBoolean, payloadString, type CommandResult, type WheelAppStatus } from "../session";

export type SentName = { index: number; label: string };

export const labelsFrom = (payload: Record<string, unknown>): SentName[] | null => {
  const raw = payload.labels;
  if (!Array.isArray(raw)) return [];
  if (raw.length > WHEEL_LIMITS.pasteLines) return null;
  const names: SentName[] = [];
  (raw as unknown[]).forEach((value, index) => {
    if (names.length >= WHEEL_LIMITS.entries || typeof value !== "string") return;
    const label = normalizeLabel(value);
    if (label.length > 0) names.push({ index, label });
  });
  return names;
};

const refusal = (error: string): CommandResult => ({ ok: false, error, added: [] });

const readTokens = (value: unknown): string[] | null => {
  if (!Array.isArray(value) || value.length === 0 || value.length > WHEEL_LIMITS.pasteLines) return null;
  const tokens: unknown[] = value;
  return tokens.every(isValidIdentifier) && new Set(tokens).size === tokens.length ? tokens : null;
};

const slotsOf = (tokens: readonly string[], added: ReadonlySet<string>): number[] =>
  tokens.flatMap((token, index) => (added.has(token) ? [index] : []));

const slotsOnRecord = (doc: Y.Doc, tokens: readonly string[]): number[] => slotsOf(tokens, getAddedTokens(doc));

export type AddContext = { synced: boolean; canEdit: boolean; repeat: boolean };

export const addNames = (doc: Y.Doc, payload: Record<string, unknown>, context: AddContext): CommandResult => {
  const names = labelsFrom(payload);
  if (names === null) return refusal("tooManyLines");
  const tracked = payload.tokens !== undefined;
  const tokens = tracked ? readTokens(payload.tokens) : null;
  if (tracked && (tokens === null || !Array.isArray(payload.labels) || payload.labels.length !== tokens.length)) {
    return refusal("badRequest");
  }
  if (tokens !== null) {
    const recorded = slotsOnRecord(doc, tokens);
    if (recorded.length > 0) return { ok: true, added: recorded };
  }
  if (context.repeat) return tokens === null ? { ok: false, error: "duplicateRequest" } : refusal("notApplied");
  if (!context.synced) return refusal("notSynced");
  if (!context.canEdit) return refusal("readOnly");
  if (names.length === 0) return refusal("noNames");
  if (tokens === null) {
    const count = addEntries(doc, names.map((name) => name.label));
    return count === 0 ? refusal("full") : { ok: true, added: names.slice(0, count).map((name) => name.index) };
  }
  const recorded = addEntriesOnce(doc, names.map((name) => ({ token: tokens[name.index], label: name.label })));
  const added = slotsOf(tokens, new Set(recorded));
  return added.length === 0 ? refusal("full") : { ok: true, added };
};

const addOutcome = (doc: Y.Doc, payload: Record<string, unknown>, context: AddContext): CommandResult => {
  const tokens = readTokens(payload.tokens);
  if (tokens === null) return { ok: false, error: "badRequest" };
  const added = slotsOnRecord(doc, tokens);
  if (added.length > 0) return { ok: true, added };
  return context.synced ? refusal("notApplied") : { ok: false, error: "notSynced" };
};

export type WheelCommandContext = AddContext & {
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
const EDITING: ReadonlySet<string> = new Set<string>(APP_EDIT_COMMANDS);
const DOC_ANSWERED: ReadonlySet<string> = new Set<string>(DOC_ANSWERED_COMMANDS);

export const runWheelCommand = (
  doc: Y.Doc,
  type: NativeToEmbedType,
  payload: Record<string, unknown>,
  context: WheelCommandContext
): CommandResult => {
  if (!DOC_ANSWERED.has(type)) {
    if (!context.synced && type !== "setSounds") return { ok: false, error: "notSynced" };
    if (EDITING.has(type) && !context.canEdit) return { ok: false, error: "readOnly" };
    if (REORDERING.has(type) && context.spinning) return { ok: false, error: "spinning" };
  }
  switch (type) {
    case "addEntries":
      return addNames(doc, payload, context);
    case "addOutcome":
      return addOutcome(doc, payload, context);
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
    case "snapshot":
    case "update":
    case "awareness":
    case "status":
    case "resync":
    case "close":
    case "setTool":
    case "setColor":
    case "setStrokeWidth":
    case "setFill":
    case "undo":
    case "redo":
    case "setPage":
    case "addPage":
    case "renamePage":
    case "deletePage":
    case "zoomToFit":
    case "export":
    case "playNow":
    case "enqueue":
    case "request":
    case "approve":
    case "decline":
    case "cancelRequest":
    case "move":
    case "remove":
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
