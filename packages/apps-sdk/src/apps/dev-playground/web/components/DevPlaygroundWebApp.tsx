import { useEffect, useMemo, useState } from "react";
import { useAppDoc } from "../../../../sdk/hooks/useAppDoc";
import { useAppPresence } from "../../../../sdk/hooks/useAppPresence";
import { useApps } from "../../../../sdk/hooks/useApps";
import {
  addItem,
  clearItems,
  getCounter,
  getItems,
  getMeta,
  getNotes,
  incrementCounter,
  removeItemAt,
  setCounter,
  setNotes,
} from "../../core/doc/index";

const APP_ID = "dev-playground";
const SAMPLE_IDEAS = ["Retro prep", "Risk audit", "Demo checklist", "Question bank"];

type Snapshot = {
  counter: number;
  notes: string;
  items: string[];
  updatedAt: number | null;
};

const readSnapshot = (doc: Parameters<typeof getCounter>[0]): Snapshot => {
  const meta = getMeta(doc);
  return {
    counter: getCounter(doc),
    notes: getNotes(doc),
    items: getItems(doc),
    updatedAt: meta.updatedAt,
  };
};

const stringToColor = (value: string): string => {
  let hash = 0;
  for (let i = 0; i < value.length; i += 1) {
    hash = (hash << 5) - hash + value.charCodeAt(i);
    hash |= 0;
  }
  const hue = Math.abs(hash % 360);
  return `hsl(${hue} 70% 60%)`;
};

const formatTime = (value: number | null): string => {
  if (!value) return "never";
  return new Date(value).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
};

export function DevPlaygroundWebApp() {
  const { doc, locked } = useAppDoc(APP_ID);
  const { user, isAdmin } = useApps();
  const { states, setLocalState } = useAppPresence(APP_ID);

  const [snapshot, setSnapshot] = useState<Snapshot>(() => readSnapshot(doc));
  const [draftItem, setDraftItem] = useState("");

  const canEdit = !locked || Boolean(isAdmin);
  const userId = user?.id ?? "guest";
  const userName = user?.name ?? user?.email ?? userId;
  const presenceColor = useMemo(() => stringToColor(userId), [userId]);

  useEffect(() => {
    const handleUpdate = () => {
      setSnapshot(readSnapshot(doc));
    };
    handleUpdate();
    doc.on("update", handleUpdate);
    return () => {
      doc.off("update", handleUpdate);
    };
  }, [doc]);

  useEffect(() => {
    setLocalState({
      user: {
        id: userId,
        name: userName,
        color: presenceColor,
      },
    });
    return () => {
      setLocalState(null);
    };
  }, [presenceColor, setLocalState, userId, userName]);

  const participants = useMemo(
    () =>
      states
        .map((state, index) => {
          const id = state.user?.id ?? `anon-${index + 1}`;
          const name = state.user?.name ?? id;
          const color = state.user?.color ?? stringToColor(id);
          return { id, name, color };
        })
        .sort((a, b) => a.name.localeCompare(b.name)),
    [states]
  );

  return (
    <div className="flex h-full min-h-0 w-full flex-col gap-4 overflow-hidden rounded-2xl border border-[#FEFCD9]/10 bg-[#0d0e0d] p-4 text-[#FEFCD9]">
      <div className="flex items-start justify-between gap-4 border-b border-[#FEFCD9]/10 pb-3">
        <div>
          <h2 className="text-base font-semibold uppercase tracking-wide">
            Dev Playground
          </h2>
          <p className="text-xs text-[#FEFCD9]/60">
            Development-only sample app for learning SDK patterns.
          </p>
        </div>
        <div className="text-right">
          <p className="text-[11px] uppercase tracking-wide text-[#FEFCD9]/40">
            Last update
          </p>
          <p className="text-xs text-[#FEFCD9]/70">{formatTime(snapshot.updatedAt)}</p>
        </div>
      </div>

      {locked && !isAdmin && (
        <div className="rounded-lg border border-amber-400/30 bg-amber-400/10 px-3 py-2 text-xs text-amber-200">
          This app is locked by an admin. You can inspect shared state but cannot edit.
        </div>
      )}

      <div className="grid flex-1 min-h-0 grid-cols-1 gap-4 lg:grid-cols-[1fr_300px]">
        <div className="flex min-h-0 flex-col gap-4 overflow-hidden">
          <section className="rounded-xl border border-[#FEFCD9]/10 bg-black/20 p-3">
            <div className="mb-3 flex items-center justify-between">
              <p className="text-sm font-medium">Shared Counter</p>
              <span className="rounded-full bg-[#FEFCD9]/10 px-2 py-0.5 text-xs">
                {snapshot.counter}
              </span>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={() => incrementCounter(doc, -1, userId)}
                disabled={!canEdit}
                className="rounded-lg border border-[#FEFCD9]/15 px-3 py-1.5 text-xs hover:bg-[#FEFCD9]/10 disabled:opacity-40"
              >
                -1
              </button>
              <button
                type="button"
                onClick={() => incrementCounter(doc, 1, userId)}
                disabled={!canEdit}
                className="rounded-lg border border-[#FEFCD9]/15 px-3 py-1.5 text-xs hover:bg-[#FEFCD9]/10 disabled:opacity-40"
              >
                +1
              </button>
              <button
                type="button"
                onClick={() => setCounter(doc, 0, userId)}
                disabled={!canEdit}
                className="rounded-lg border border-[#FEFCD9]/15 px-3 py-1.5 text-xs hover:bg-[#FEFCD9]/10 disabled:opacity-40"
              >
                Reset
              </button>
            </div>
          </section>

          <section className="flex min-h-0 flex-col rounded-xl border border-[#FEFCD9]/10 bg-black/20 p-3">
            <p className="mb-2 text-sm font-medium">Shared Notes</p>
            <textarea
              value={snapshot.notes}
              onChange={(event) => setNotes(doc, event.target.value, userId)}
              disabled={!canEdit}
              placeholder="Type notes and watch them sync live..."
              className="min-h-[120px] w-full flex-1 resize-none rounded-lg border border-[#FEFCD9]/10 bg-black/40 px-3 py-2 text-sm text-[#FEFCD9] outline-none placeholder:text-[#FEFCD9]/30 disabled:opacity-50"
            />
          </section>

          <section className="flex min-h-0 flex-col rounded-xl border border-[#FEFCD9]/10 bg-black/20 p-3">
            <div className="mb-2 flex items-center justify-between gap-2">
              <p className="text-sm font-medium">Shared Ideas</p>
              <div className="flex gap-2">
                <button
                  type="button"
                  disabled={!canEdit}
                  onClick={() => {
                    const value =
                      draftItem.trim() ||
                      SAMPLE_IDEAS[Math.floor(Math.random() * SAMPLE_IDEAS.length)];
                    addItem(doc, value, userId);
                    setDraftItem("");
                  }}
                  className="rounded-lg border border-[#FEFCD9]/15 px-2.5 py-1 text-xs hover:bg-[#FEFCD9]/10 disabled:opacity-40"
                >
                  Add
                </button>
                <button
                  type="button"
                  disabled={!canEdit || snapshot.items.length === 0}
                  onClick={() => clearItems(doc, userId)}
                  className="rounded-lg border border-[#FEFCD9]/15 px-2.5 py-1 text-xs hover:bg-[#FEFCD9]/10 disabled:opacity-40"
                >
                  Clear
                </button>
              </div>
            </div>
            <input
              value={draftItem}
              onChange={(event) => setDraftItem(event.target.value)}
              disabled={!canEdit}
              placeholder="Enter an idea or click Add for a random sample"
              className="mb-2 rounded-lg border border-[#FEFCD9]/10 bg-black/40 px-3 py-2 text-sm outline-none placeholder:text-[#FEFCD9]/30 disabled:opacity-50"
            />
            <div className="min-h-0 flex-1 overflow-auto rounded-lg border border-[#FEFCD9]/10 bg-black/30 p-2">
              {snapshot.items.length === 0 ? (
                <p className="text-xs text-[#FEFCD9]/40">No ideas yet.</p>
              ) : (
                <ul className="space-y-2">
                  {snapshot.items.map((item, index) => (
                    <li
                      key={`${item}-${index}`}
                      className="flex items-center justify-between gap-3 rounded-md border border-[#FEFCD9]/10 bg-black/40 px-2.5 py-2"
                    >
                      <span className="text-sm text-[#FEFCD9]/85">{item}</span>
                      <button
                        type="button"
                        disabled={!canEdit}
                        onClick={() => removeItemAt(doc, index, userId)}
                        className="rounded border border-[#FEFCD9]/15 px-2 py-1 text-[11px] hover:bg-[#FEFCD9]/10 disabled:opacity-40"
                      >
                        Remove
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </section>
        </div>

        <aside className="flex min-h-0 flex-col rounded-xl border border-[#FEFCD9]/10 bg-black/20 p-3">
          <p className="mb-2 text-sm font-medium">Presence</p>
          <p className="mb-3 text-xs text-[#FEFCD9]/50">
            Uses `useAppPresence` awareness state.
          </p>
          <div className="min-h-0 flex-1 overflow-auto rounded-lg border border-[#FEFCD9]/10 bg-black/30 p-2">
            {participants.length === 0 ? (
              <p className="text-xs text-[#FEFCD9]/40">No active app users yet.</p>
            ) : (
              <ul className="space-y-2">
                {participants.map((participant) => (
                  <li
                    key={participant.id}
                    className="flex items-center gap-2 rounded-md border border-[#FEFCD9]/10 bg-black/40 px-2.5 py-2"
                  >
                    <span
                      className="h-2.5 w-2.5 rounded-full"
                      style={{ backgroundColor: participant.color }}
                    />
                    <span className="text-sm text-[#FEFCD9]/85">{participant.name}</span>
                    {participant.id === userId && (
                      <span className="ml-auto text-[10px] uppercase tracking-wide text-[#FEFCD9]/40">
                        You
                      </span>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </div>
        </aside>
      </div>
    </div>
  );
}
