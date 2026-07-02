"use client";

import { useState } from "react";
import { color } from "@conclave/ui-tokens";
import { adminRequest } from "./adminApi";
import { Dot } from "./ui";

type WorkerSnapshot = {
  index: number;
  pid: number | null;
  closed: boolean;
  usage: Record<string, number> | null;
  error?: string;
};

const formatRss = (usage: Record<string, number> | null): string | null => {
  const rss = usage?.ru_maxrss;
  if (typeof rss !== "number" || rss <= 0) return null;
  // ru_maxrss is KB on Linux; production runs there.
  const mb = rss / 1024;
  return mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${Math.round(mb)} MB`;
};

/** Per-instance mediasoup workers, fetched when the operator opens the fold. */
export function WorkersList({ instanceUrl }: { instanceUrl: string }) {
  const [workers, setWorkers] = useState<WorkerSnapshot[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const load = () => {
    if (loading) return;
    setLoading(true);
    setError(null);
    adminRequest<{ workers?: WorkerSnapshot[] }>("workers", {
      method: "GET",
      instanceUrl,
    })
      .then((data) => setWorkers(Array.isArray(data.workers) ? data.workers : []))
      .catch((err) => setError((err as Error).message))
      .finally(() => setLoading(false));
  };

  return (
    <details
      onToggle={(event) => {
        if ((event.target as HTMLDetailsElement).open && workers === null) load();
      }}
    >
      <summary
        className="cursor-pointer select-none text-[11px] transition-colors hover:text-white"
        style={{ color: color.textFaint }}
      >
        Workers
      </summary>
      <div className="mt-1.5 space-y-1">
        {loading ? (
          <p className="text-[11px]" style={{ color: color.textFaint }}>
            Loading
          </p>
        ) : error ? (
          <p className="text-[11px]" style={{ color: color.danger }}>
            {error}
          </p>
        ) : (
          (workers ?? []).map((worker) => {
            const rss = formatRss(worker.usage);
            return (
              <p
                key={worker.index}
                className="flex items-center gap-1.5 text-[11px]"
                style={{ color: color.textFaint, fontVariantNumeric: "tabular-nums" }}
              >
                <Dot tone={worker.closed ? color.danger : color.success} />
                worker {worker.index}
                {worker.pid ? ` · pid ${worker.pid}` : ""}
                {worker.closed ? " · closed" : ""}
                {rss ? ` · ${rss}` : ""}
                {worker.error ? ` · ${worker.error}` : ""}
              </p>
            );
          })
        )}
      </div>
    </details>
  );
}
