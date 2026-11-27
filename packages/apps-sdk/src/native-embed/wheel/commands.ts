import type * as Y from "yjs";
import {
  addEntries,
  addEntriesOnce,
  clearEntries,
  clearHistory,
  getEntries,
  normalizeLabel,
  readAddRecord,
  removeEntryById,
  reorderEntries,
  setRemoveWinnerOnDone,
  type WheelEntry,
  type WheelResult,
} from "../../apps/wheel/core/doc/index";
import { cutText } from "../../sdk/text";
import {
  APP_EDIT_COMMANDS,
  DOC_ANSWERED_COMMANDS,
  WHEEL_ADD_RECOVERY,
  WHEEL_LIMITS,
  isValidIdentifier,
  type NativeToEmbedType,
} from "../protocol";
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

const readSentAt = (value: unknown): number | null =>
  typeof value === "number" && Number.isSafeInteger(Math.trunc(value)) && value > 0 ? value : null;

const slotsOf = (tokens: readonly string[], added: ReadonlySet<string>): number[] =>
  tokens.flatMap((token, index) => (added.has(token) ? [index] : []));

type Recorded = { added: number[]; reachesBack: boolean };

const onRecord = (doc: Y.Doc, tokens: readonly string[], sentAt: number): Recorded => {
  const record = readAddRecord(doc, sentAt);
  return { added: slotsOf(tokens, record.added), reachesBack: record.reachesBack };
};

const unrecorded = (recorded: Recorded): CommandResult =>
  recorded.reachesBack ? refusal("notApplied") : { ok: false, error: WHEEL_ADD_RECOVERY.unknown };

export type AddContext = { synced: boolean; canEdit: boolean; repeat: boolean };

type TrackedAdd = { tokens: string[]; sentAt: number };

const readTrackedAdd = (payload: Record<string, unknown>): TrackedAdd | null => {
  const tokens = readTokens(payload.tokens);
  const sentAt = readSentAt(payload.sentAt);
  return tokens === null || sentAt === null ? null : { tokens, sentAt };
};

export const addNames = (doc: Y.Doc, payload: Record<string, unknown>, context: AddContext): CommandResult => {
  const names = labelsFrom(payload);
  if (names === null) return refusal("tooManyLines");
  const tracked = payload.tokens !== undefined ? readTrackedAdd(payload) : null;
  if (payload.tokens !== undefined) {
    if (tracked === null || !Array.isArray(payload.labels) || payload.labels.length !== tracked.tokens.length) {
      return refusal("badRequest");
    }
    const recorded = onRecord(doc, tracked.tokens, tracked.sentAt);
    if (recorded.added.length > 0) return { ok: true, added: recorded.added };
    if (context.repeat) return unrecorded(recorded);
  } else if (context.repeat) {
    return { ok: false, error: "duplicateRequest" };
  }
  if (!context.synced) return refusal("notSynced");
  if (!context.canEdit) return refusal("readOnly");
  if (names.length === 0) return refusal("noNames");
  if (tracked === null) {
    const count = addEntries(doc, names.map((name) => name.label));
    return count === 0 ? refusal("full") : { ok: true, added: names.slice(0, count).map((name) => name.index) };
  }
  const written = addEntriesOnce(
    doc,
    names.map((name) => ({ token: tracked.tokens[name.index], label: name.label })),
    tracked.sentAt
  );
  const added = slotsOf(tracked.tokens, new Set(written));
  return added.length === 0 ? refusal("full") : { ok: true, added };
};

const addOutcome = (doc: Y.Doc, payload: Record<string, unknown>, context: AddContext): CommandResult => {
  const asked = readTrackedAdd(payload);
  if (asked === null) return { ok: false, error: "badRequest" };
  const recorded = onRecord(doc, asked.tokens, asked.sentAt);
  if (recorded.added.length > 0) return { ok: true, added: recorded.added };
  return context.synced ? unrecorded(recorded) : { ok: false, error: "notSynced" };
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
      if (current.length >= 2) reorderEntries(doc, shuffled(current));
      return { ok: true };
    }
    case "sort": {
      const current = getEntries(doc);
      if (current.length >= 2) {
        reorderEntries(doc, [...current].sort((a, b) => a.label.localeCompare(b.label, undefined, { sensitivity: "base" })));
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
  waitingCount: number;
  history: WheelResult[];
  removeWinner: boolean;
  sounds: boolean;
  spinning: boolean;
  winner: { spinId: string; label: string } | null;
};

export const wheelStatus = (input: WheelStatusInput): WheelAppStatus => ({
  kind: "wheel",
  entries: input.entries.map((entry) => ({ id: entry.id, label: entry.label })),
  waiting: Math.min(input.waitingCount, WHEEL_LIMITS.waiting),
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
