import type * as Y from "yjs";
import { addEntries, normalizeLabel, type WheelEntry, type WheelResult } from "../../apps/wheel/core/doc/index";
import { cutText } from "../../sdk/text";
import { WHEEL_LIMITS, isValidIdentifier } from "../protocol";
import type { CommandResult, WheelAppStatus } from "../session";

export const labelsFrom = (payload: Record<string, unknown>): string[] => {
  const raw = payload.labels;
  if (!Array.isArray(raw)) return [];
  const labels: string[] = [];
  for (const value of raw as unknown[]) {
    if (typeof value !== "string") continue;
    const label = normalizeLabel(value);
    if (label.length > 0) labels.push(label);
    if (labels.length >= WHEEL_LIMITS.entries) break;
  }
  return labels;
};

export const addNames = (doc: Y.Doc, payload: Record<string, unknown>): CommandResult => {
  const labels = labelsFrom(payload);
  if (labels.length === 0) return { ok: false, error: "noNames" };
  return addEntries(doc, labels) > 0 ? { ok: true } : { ok: false, error: "full" };
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
