import { useEffect, useMemo, useState } from "react";
import type { Awareness } from "y-protocols/awareness";
import { useAppDoc } from "./useAppDoc";

export type PresenceState = {
  clientId: number;
  user?: { id?: string; name?: string; color?: string };
  cursor?: { x: number; y: number };
  selection?: { ids: string[] };
};

type UnknownRecord = Record<string, unknown>;

const asRecord = (value: unknown): UnknownRecord | null => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as UnknownRecord;
};

const parseUser = (value: unknown): PresenceState["user"] => {
  const record = asRecord(value);
  if (!record) return undefined;
  const id = typeof record.id === "string" ? record.id : undefined;
  const name = typeof record.name === "string" ? record.name : undefined;
  const color = typeof record.color === "string" ? record.color : undefined;
  if (!id && !name && !color) return undefined;
  return { id, name, color };
};

const parseCursor = (value: unknown): PresenceState["cursor"] => {
  const record = asRecord(value);
  if (!record) return undefined;
  if (typeof record.x !== "number" || typeof record.y !== "number") return undefined;
  return { x: record.x, y: record.y };
};

const parseSelection = (value: unknown): PresenceState["selection"] => {
  const record = asRecord(value);
  if (!record || !Array.isArray(record.ids)) return undefined;
  const ids = record.ids.filter((id): id is string => typeof id === "string");
  return { ids };
};

const snapshotAwareness = (awareness: Awareness): PresenceState[] => {
  const states = Array.from(awareness.getStates().entries());
  return states.map(([clientId, state]) => {
    const record = asRecord(state);
    return {
      clientId,
      user: parseUser(record?.user),
      cursor: parseCursor(record?.cursor),
      selection: parseSelection(record?.selection),
    };
  });
};

export const useAppPresence = (appId: string) => {
  const { awareness } = useAppDoc(appId);
  const [states, setStates] = useState<PresenceState[]>(() => snapshotAwareness(awareness));

  useEffect(() => {
    const update = () => {
      setStates(snapshotAwareness(awareness));
    };
    awareness.on("update", update);
    return () => {
      awareness.off("update", update);
    };
  }, [awareness]);

  const setLocalState = useMemo(
    () => awareness.setLocalState.bind(awareness) as (state: unknown) => void,
    [awareness]
  );

  return { awareness, states, setLocalState };
};
